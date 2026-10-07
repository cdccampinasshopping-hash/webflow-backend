// Recursos em cima dos dados do Orbitta:
//  1) Alerta de lead esquecido: cliente mandou a última mensagem e ninguém respondeu há mais de X minutos
//  2) Resumo do dia às 22h por e-mail (gerente da loja + admin)
//  3) Painel da rede: todas as lojas lado a lado
//  4) Visitas pra confirmar (agendamentos de hoje e amanhã) com WhatsApp
//  5) Evolução dos últimos 30 dias
const express = require('express');
const db = require('../db');
const orbitta = require('../lib/orbitta');
const { enviarEmail, emailInterno } = require('../email');
const push = require('../push');
const whatsapp = require('../whatsapp');
const ob = require('./orbitta');
const ck = require('./checklist');
const { hojeBrasilia, somaDias, intervalo, dataValida } = ck;

const SITE_URL = process.env.SITE_URL || 'https://flowsolution.pages.dev';
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const horaBrasilia = () => new Date(Date.now() - 3 * 3600000).getUTCHours();
const dataBr = (iso) => String(iso || '').split('-').reverse().join('/');

// Última mensagem de cada conversa (quem mandou e quando)
for (const col of ['ultimo_de TEXT', 'ultimo_em TEXT', 'checada_msg TEXT', 'alerta_em TEXT']) {
  try { db.exec(`ALTER TABLE orbitta_conversas ADD COLUMN ${col}`); } catch (e) { /* já existe */ }
}
// Configuração por loja: minutos pro alerta, e-mails do gerente, alerta e resumo ligados
try { db.exec(`ALTER TABLE usuarios ADD COLUMN orbitta_alerta TEXT`); } catch (e) { /* já existe */ }
db.exec(`CREATE TABLE IF NOT EXISTS orbitta_resumos (usuario_id INTEGER NOT NULL, data TEXT NOT NULL, enviado_em TEXT DEFAULT (datetime('now')), PRIMARY KEY (usuario_id, data))`);

const PADRAO = { minutos: 5, emails: '', whatsapp: '', alerta: true, resumo: true, inicio: 8, fim: 22, lembrete: true, lembrete_hora: 18 };
function configDe(u) {
  let c = {};
  try { c = JSON.parse(u.orbitta_alerta || '{}') || {}; } catch (e) { c = {}; }
  return { ...PADRAO, ...c };
}
// Alerta passou de 30 para 5 minutos em todas as lojas que já tinham configuração salva
if (!db.prepare('SELECT 1 FROM migracoes WHERE nome = ?').get('2026-10-07-alerta-5-min')) {
  db.transaction(() => {
    const atualizar = db.prepare('UPDATE usuarios SET orbitta_alerta = ? WHERE id = ?');
    for (const u of db.prepare(`SELECT id, orbitta_alerta FROM usuarios WHERE orbitta_alerta IS NOT NULL AND orbitta_alerta <> ''`).all()) {
      atualizar.run(JSON.stringify({ ...configDe(u), minutos: 5 }), u.id);
    }
    db.prepare('INSERT INTO migracoes (nome) VALUES (?)').run('2026-10-07-alerta-5-min');
  })();
}
function whatsDe(c) {
  return [...new Set(String(c.whatsapp || '').split(/[,;\n]+/).map((t) => whatsapp.normalizarTelefone(t)).filter(Boolean))].slice(0, 5);
}
// Quem recebe aviso no celular: a própria conta da loja + quem tem um cargo com a permissão "alertas"
// (o cargo escolhe quais lojas; cada pessoa ainda pode silenciar lojas no próprio celular)
const permissoes = require('../lib/permissoes');
function destinosPush(u) {
  let tags = [];
  try { tags = permissoes.destinosAlerta(u.id); } catch (e) { /* sem cargos ainda */ }
  return [u.id, ...tags];
}
// Texto curto agrupado por vendedor: "João: 2 clientes esperando há 8 min · Sem vendedor: 1 há 12 min"
function textoPorVendedor(lista) {
  const g = new Map();
  for (const x of lista) {
    const k = x.vendedor || 'Sem vendedor';
    const a = g.get(k) || { n: 0, max: 0 };
    a.n++; a.max = Math.max(a.max, x.esperando_min || 0); g.set(k, a);
  }
  return [...g.entries()].sort((a, b) => b[1].n - a[1].n || b[1].max - a[1].max)
    .map(([k, a]) => `${k}: ${a.n} cliente${a.n > 1 ? 's' : ''} esperando há ${a.max} min`).join(' · ');
}
function emailsDe(c) {
  return String(c.emails || '').split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)).slice(0, 5);
}
function lojasVinculadas() {
  return db.prepare(`SELECT id, nome, negocio_nome, email, checklist_ativo, checklist_desde, orbitta_vinculo, orbitta_alerta, meta_dia FROM usuarios
    WHERE orbitta_vinculo IS NOT NULL AND orbitta_vinculo <> '' AND is_admin = 0`).all().filter((u) => ob.vinculoDe(u));
}
const nomeMembro = db.prepare('SELECT nome FROM orbitta_membros WHERE id = ?');

// ---------------- 1) Alerta de lead esquecido ----------------
// Lê todas as conversas do dia que mudaram (até 60 por minuto por loja), pra medir o tempo de resposta de todas
const LER_POR_RODADA = 60;
function verificarRespostas(u) { return ob.comLoja(u, () => _verificarRespostas(u)); }
async function _verificarRespostas(u) {
  const v = ob.vinculoDe(u); if (!v) return;
  const hoje = hojeBrasilia();
  const origens = [];
  if ((v.agent_ids || []).length) origens.push(['agente', { agent_ids: v.agent_ids }]);
  if ((v.store_ids || []).length) origens.push(['unidade', { store_ids: v.store_ids }]);
  const salvar = db.prepare(`INSERT INTO orbitta_conversas (usuario_id, data, conversa_id, origem, contato, telefone, etapa, status, ultima_mensagem)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (usuario_id, data, conversa_id) DO UPDATE SET contato = excluded.contato, telefone = excluded.telefone,
      etapa = excluded.etapa, status = excluded.status, ultima_mensagem = excluded.ultima_mensagem`);
  // Todas as páginas do dia (não só as 100 mais recentes): assim uma conversa resolvida no Orbitta
  // sai do "sem resposta" no minuto seguinte, mesmo que seja antiga
  for (const [origem, fo] of origens) {
    let antes = null;
    for (let pag = 0; pag < 10; pag++) {
      const r = await orbitta.chamar('listar_conversas', { start_date: hoje, end_date: hoje, origem, limit: 100, ...fo, ...(antes ? { antes_de: antes } : {}) });
      (r.conversas || []).forEach((c) => salvar.run(u.id, hoje, c.id, origem, c.contato || null, c.telefone || null, c.etapa || null, c.status || null, c.ultima_mensagem || null));
      antes = r.proxima_pagina_antes_de;
      if (!antes || !(r.conversas || []).length) break;
    }
  }
  // Lê as conversas do dia que mudaram desde a última olhada (todas, não só as últimas horas)
  const mudaram = db.prepare(`SELECT conversa_id, origem, ultima_mensagem FROM orbitta_conversas WHERE usuario_id = ? AND data = ?
    AND (checada_msg IS NULL OR checada_msg <> ultima_mensagem) ORDER BY ultima_mensagem DESC LIMIT ?`).all(u.id, hoje, LER_POR_RODADA);
  const marcar = db.prepare('UPDATE orbitta_conversas SET ultimo_de = ?, ultimo_em = ?, checada_msg = ? WHERE usuario_id = ? AND data = ? AND conversa_id = ?');
  for (const c of mudaram) {
    try {
      // 40 mensagens: pega as idas e vindas do dia inteiro, não só o fim da conversa
      const r = await orbitta.chamar('ler_conversa', { id: c.conversa_id, origem: c.origem || 'agente', limit: 40 });
      const msgs = r.mensagens || [];
      try { ob.registrarRespostas(u.id, c.conversa_id, msgs); } catch (e) { /* não trava o alerta */ }
      const ult = msgs[msgs.length - 1];
      const quando = new Date(ult ? (ult.data || c.ultima_mensagem) : 0);
      if (ult) marcar.run(ult.de === 'cliente' ? 'cliente' : 'loja', isNaN(quando) ? null : quando.toISOString(), c.ultima_mensagem, u.id, hoje, c.conversa_id);
      else marcar.run(null, null, c.ultima_mensagem, u.id, hoje, c.conversa_id);
    } catch (e) { /* tenta na próxima rodada */ }
    await espera(100);
  }
}

// Quem está esperando resposta agora (cliente mandou a última e já passou do tempo)
function semResposta(u, minutos) {
  const c = configDe(u);
  const min = minutos || c.minutos;
  const limite = new Date(Date.now() - min * 60000).toISOString();
  const desde = new Date(Date.now() - 12 * 3600000).toISOString();
  return db.prepare(`SELECT conversa_id, contato, telefone, etapa, vendedor_id, ultimo_em, alerta_em FROM orbitta_conversas
    WHERE usuario_id = ? AND data = ? AND ultimo_de = 'cliente' AND ultimo_em <= ? AND ultimo_em >= ?
      AND COALESCE(status, '') NOT IN ('resolved', 'closed', 'archived', 'finished') AND COALESCE(etapa, '') NOT IN ('Convertido')
    ORDER BY ultimo_em ASC LIMIT 200`).all(u.id, hojeBrasilia(), limite, desde)
    .map((x) => ({ ...x, vendedor: x.vendedor_id ? ((nomeMembro.get(x.vendedor_id) || {}).nome || null) : null,
      esperando_min: Math.round((Date.now() - new Date(x.ultimo_em).getTime()) / 60000) }));
}

function htmlAlerta(u, lista, c) {
  const linhas = lista.map((x) => `<tr><td style="padding:8px 6px;border-bottom:1px solid #E3E6EC"><b>${esc(x.contato || x.telefone)}</b><div style="color:#6B7690;font-size:12px">${esc(x.telefone || '')}${x.vendedor ? ' · ' + esc(x.vendedor) : ' · sem vendedor'}</div></td>
    <td style="padding:8px 6px;border-bottom:1px solid #E3E6EC;color:#B42318;font-weight:700;white-space:nowrap">${x.esperando_min} min</td></tr>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#F4F5F8;font-family:Arial,sans-serif;color:#151B26">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px">
    <h2 style="margin:0 0 4px">${lista.length} cliente(s) sem resposta</h2>
    <p style="margin:0 0 8px;color:#4A5873">${esc(u.negocio_nome || u.nome)} · cliente mandou mensagem há mais de ${c.minutos} minutos e ninguém respondeu.</p>
    <p style="margin:0 0 16px;font-weight:700">${esc(textoPorVendedor(lista))}</p>
    <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:10px">${linhas}</table>
    <p style="margin:18px 0 0"><a href="${SITE_URL}/webflow.html" style="background:#151B26;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:700">Abrir o painel</a></p>
  </div></body></html>`;
}

async function rodadaAlertas() {
  if (!orbitta.configurado()) return;
  const h = horaBrasilia();
  for (const u of lojasVinculadas()) {
    const c = configDe(u);
    try { await verificarRespostas(u); } catch (e) { console.error('Orbitta alerta:', e.message); continue; }
    if (!c.alerta || h < c.inicio || h >= c.fim) continue;
    // Avisa só uma vez por mensagem do cliente
    const novos = semResposta(u).filter((x) => !x.alerta_em || x.alerta_em < x.ultimo_em);
    if (!novos.length) continue;
    const loja = u.negocio_nome || u.nome;
    const porVend = textoPorVendedor(novos);
    let canais = 0;
    // 1) Notificação no celular
    try { if (await push.enviarPara(destinosPush(u), { titulo: `⚠️ ${novos.length} sem resposta · ${loja}`, texto: porVend, url: '/webflow.html', tag: 'sem-resposta-' + u.id })) canais++; }
    catch (e) { console.error('Orbitta alerta push:', e.message); }
    // 2) WhatsApp do gerente (modelo aprovado na Meta: {{1}} loja, {{2}} texto)
    const modeloAlerta = process.env.WHATSAPP_TEMPLATE_ALERTA;
    if (modeloAlerta) {
      for (const tel of whatsDe(c)) {
        const r = await whatsapp.enviarModelo(tel, modeloAlerta, [loja, `${novos.length} cliente(s) sem resposta há mais de ${c.minutos} min. ${porVend}`]);
        if (r.status === 'enviado') canais++;
      }
    }
    // 3) E-mail
    const para = [...new Set([...emailsDe(c)])];
    if (para.length) {
      try {
        await enviarEmail({ para, assunto: `⚠️ ${novos.length} cliente(s) sem resposta há mais de ${c.minutos} min · ${loja}`, html: htmlAlerta(u, novos, c) });
        canais++;
      } catch (e) { console.error('Orbitta alerta e-mail:', e.message); }
    }
    // Avisa só uma vez por mensagem do cliente
    if (canais) {
      const marcar = db.prepare('UPDATE orbitta_conversas SET alerta_em = ? WHERE usuario_id = ? AND data = ? AND conversa_id = ?');
      novos.forEach((x) => marcar.run(new Date().toISOString(), u.id, hojeBrasilia(), x.conversa_id));
    }
  }
}

// ---------------- 2) Resumo do dia às 22h ----------------
function checklistDoDia(u, data) {
  if (!u.checklist_ativo) return null;
  try { const r = ck.resumo([{ id: u.id, nome: u.nome, negocio_nome: u.negocio_nome, checklist_desde: u.checklist_desde }], data, data)[0]; return r && r.dias[0] ? r.dias[0] : null; }
  catch (e) { return null; }
}
function enviosDoDia(usuarioId, data) {
  try { return db.prepare('SELECT COUNT(*) AS n FROM lead_envios WHERE usuario_id = ? AND data = ?').get(usuarioId, data).n; } catch (e) { return 0; }
}
function pct(a, b) { return b ? (Math.round(a / b * 1000) / 10).toString().replace('.', ',') + '%' : '—'; }
function variacao(a, b) {
  if (b == null) return '';
  if (!b) return a ? ' <span style="color:#0F8F6B">↑ novo</span>' : '';
  const d = Math.round((a - b) / b * 1000) / 10;
  return d === 0 ? ' <span style="color:#6B7690">=</span>' : ` <span style="color:${d > 0 ? '#0F8F6B' : '#B42318'}">${d > 0 ? '↑' : '↓'} ${Math.abs(d).toString().replace('.', ',')}%</span>`;
}
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

async function dadosDoDia(u, data) {
  const m = ob.montar(u.id, data, data);
  let comp = null; try { comp = await ob.painelComparado(u, data, data); } catch (e) { /* sem comparação */ }
  return { m, comp, ck: checklistDoDia(u, data), whatsapp: enviosDoDia(u.id, data), sem: data === hojeBrasilia() ? semResposta(u) : [] };
}

function htmlResumo(u, data, d) {
  const c = d.comp, l = d.m.loja;
  const kpi = (t, a, b, fmt) => `<td style="padding:10px;border:1px solid #E3E6EC;background:#fff;width:33%"><div style="color:#4A5873;font-size:12px">${t}</div><div style="font-size:22px;font-weight:700;margin-top:2px">${fmt ? fmt(a) : a}</div><div style="font-size:12px">${variacao(a, b)}</div></td>`;
  const cards = c ? `<table style="width:100%;border-collapse:collapse;margin:0 0 14px">
      <tr>${kpi('Leads atendidos', c.leads_atendidos.atual, c.leads_atendidos.anterior)}${kpi('Leads novos', c.leads_novos.atual, c.leads_novos.anterior)}${kpi('Reativações', c.leads_recorrentes.atual, c.leads_recorrentes.anterior)}</tr>
      <tr>${kpi('Agendamentos', c.agend_periodo.atual, c.agend_periodo.anterior)}${kpi('Comparecimentos', c.comparecimentos.atual, c.comparecimentos.anterior)}${kpi('Vendas', c.vendas.atual, c.vendas.anterior)}</tr>
    </table>
    <p style="margin:0 0 14px;color:#4A5873;font-size:13px">Valor vendido: <b>${brl(c.valor_vendido.atual)}</b> · Conversão (vendas ÷ leads): <b>${pct(c.vendas.atual, c.leads_atendidos.atual)}</b> · Comparecimento: <b>${pct(c.comparecimentos.atual, c.agend_periodo.atual)}</b></p>`
    : `<p>Conversas: ${l.conversas} · Novos: ${l.novos} · Reativações: ${l.reativacoes} · Agendamentos: ${l.agendamentos} · Vendas: ${l.vendas}</p>`;
  const vend = d.m.vendedores.map((v) => `<tr>
      <td style="padding:7px 6px;border-bottom:1px solid #E3E6EC"><b>${esc(v.nome)}</b></td>
      <td style="padding:7px 6px;border-bottom:1px solid #E3E6EC;text-align:right">${v.pegos}</td>
      <td style="padding:7px 6px;border-bottom:1px solid #E3E6EC;text-align:right">${v.reativacoes}</td>
      <td style="padding:7px 6px;border-bottom:1px solid #E3E6EC;text-align:right">${v.agendamentos}</td>
      <td style="padding:7px 6px;border-bottom:1px solid #E3E6EC;text-align:right">${v.vendas}</td>
      <td style="padding:7px 6px;border-bottom:1px solid #E3E6EC;text-align:right">${pct(v.vendas, v.conversas)}</td></tr>`).join('');
  const sem = d.sem.length ? `<h3 style="margin:18px 0 6px;color:#B42318">${d.sem.length} cliente(s) ainda sem resposta</h3>
    <ul style="margin:0;padding-left:18px;font-size:13px">${d.sem.slice(0, 15).map((x) => `<li>${esc(x.contato || x.telefone)} — esperando ${x.esperando_min} min${x.vendedor ? ' (' + esc(x.vendedor) + ')' : ''}</li>`).join('')}</ul>` : '<p style="color:#0F8F6B;margin:18px 0 0">Nenhum cliente ficou sem resposta. 👏</p>';
  const ckTxt = d.ck ? `<p style="margin:10px 0 0;font-size:13px">Checklist do dia: <b>${d.ck.feitas}/${d.ck.total}</b> perguntas com comprovante.</p>` : '';
  return `<!doctype html><html><body style="margin:0;background:#F4F5F8;font-family:Arial,sans-serif;color:#151B26">
  <div style="max-width:640px;margin:0 auto;padding:24px 16px">
    <h2 style="margin:0 0 2px">Fechamento do dia · ${esc(u.negocio_nome || u.nome)}</h2>
    <p style="margin:0 0 16px;color:#4A5873">${dataBr(data)} · comparado com o dia anterior</p>
    ${cards}
    ${vend ? `<h3 style="margin:6px 0 6px">Por vendedor</h3><table style="width:100%;border-collapse:collapse;background:#fff;font-size:13px">
      <tr style="color:#6B7690;text-align:right"><th style="text-align:left;padding:6px">Vendedor</th><th style="padding:6px">Leads</th><th style="padding:6px">Reativ.</th><th style="padding:6px">Agend.</th><th style="padding:6px">Vendas</th><th style="padding:6px">Conversão</th></tr>${vend}</table>` : ''}
    ${sem}
    ${d.m.resposta && d.m.resposta.media_seg != null ? `<p style="margin:10px 0 0;font-size:13px">Tempo médio de resposta dos vendedores: <b>${Math.max(1, Math.round(d.m.resposta.media_seg / 60))} min</b> (${d.m.resposta.respostas} respostas medidas)</p>` : ''}
    <p style="margin:10px 0 0;font-size:13px">WhatsApp de reativação enviados pelo painel: <b>${d.whatsapp}</b></p>
    ${ckTxt}
    <p style="margin:18px 0 0"><a href="${SITE_URL}/webflow.html" style="background:#151B26;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:700">Ver no painel</a></p>
  </div></body></html>`;
}

// Resumo em uma linha (WhatsApp não aceita quebra de linha nos campos do modelo)
function textoResumo(u, d) {
  const c = d.comp, l = d.m.loja, partes = [];
  const leads = c ? c.leads_atendidos.atual : l.conversas, vendas = c ? c.vendas.atual : l.vendas;
  partes.push(`Leads atendidos: ${leads}${c && c.leads_atendidos.anterior != null ? ` (ontem ${c.leads_atendidos.anterior})` : ''}`);
  partes.push(`Vendas: ${vendas}${c && c.valor_vendido.atual ? ` (${brl(c.valor_vendido.atual)})` : ''}`);
  const meta = ob.metaDe(u);
  if (meta) partes.push(`Meta: ${[meta.leads ? `${leads}/${meta.leads} leads` : '', meta.vendas ? `${vendas}/${meta.vendas} vendas` : ''].filter(Boolean).join(', ')}`);
  if (d.m.resposta && d.m.resposta.media_seg != null) partes.push(`Resposta média do vendedor: ${Math.max(1, Math.round(d.m.resposta.media_seg / 60))} min`);
  const top = d.m.vendedores.slice().sort((a, b) => b.vendas - a.vendas || b.pegos - a.pegos)[0];
  if (top && (top.vendas || top.pegos)) partes.push(`Destaque: ${top.nome} (${top.vendas} venda${top.vendas === 1 ? '' : 's'}, ${top.pegos} leads)`);
  if (d.ck) partes.push(`Checklist: ${d.ck.feitas}/${d.ck.total}${d.ck.feitas < d.ck.total ? ` (faltaram ${d.ck.total - d.ck.feitas})` : ' completo'}`);
  partes.push(d.sem.length ? `Sem resposta agora: ${d.sem.length} (${textoPorVendedor(d.sem)})` : 'Ninguém ficou sem resposta');
  return partes.join(' · ');
}

async function rodadaResumo(forcar) {
  if (!orbitta.configurado()) return;
  if (!forcar && horaBrasilia() < 22) return;
  const hoje = hojeBrasilia();
  for (const u of lojasVinculadas()) {
    const c = configDe(u);
    if (!c.resumo) continue;
    const jaFoi = !forcar && db.prepare('SELECT 1 FROM orbitta_resumos WHERE usuario_id = ? AND data = ?').get(u.id, hoje);
    if (!jaFoi) try {
      try { await ob.sincronizarDia(u, hoje); } catch (e) { /* manda com o que tiver */ }
      const d = await dadosDoDia(u, hoje);
      const loja = u.negocio_nome || u.nome;
      const texto = textoResumo(u, d);
      const para = [...new Set([...emailsDe(c), emailInterno()].filter(Boolean))];
      if (para.length) {
        try { await enviarEmail({ para, assunto: `Fechamento do dia ${dataBr(hoje)} · ${loja}`, html: htmlResumo(u, hoje, d) }); }
        catch (e) { console.error('Orbitta resumo e-mail:', e.message); }
      }
      // WhatsApp do gerente (modelo aprovado na Meta: {{1}} loja, {{2}} data, {{3}} resumo)
      const modelo = process.env.WHATSAPP_TEMPLATE_RESUMO;
      if (modelo) for (const tel of whatsDe(c)) await whatsapp.enviarModelo(tel, modelo, [loja, dataBr(hoje), texto]);
      try { await push.enviarPara(destinosPush(u), { titulo: `Fechamento ${dataBr(hoje).slice(0, 5)} · ${loja}`, texto, tag: 'resumo-' + u.id }); }
      catch (e) { console.error('Orbitta resumo push:', e.message); }
      db.prepare('INSERT OR IGNORE INTO orbitta_resumos (usuario_id, data) VALUES (?, ?)').run(u.id, hoje);
    } catch (e) { console.error('Orbitta resumo:', e.message); }
    // Fechamento de cada vendedor (uma vez por dia)
    try {
      if (forcar || !db.prepare('SELECT 1 FROM vendedor_fechamentos WHERE usuario_id = ? AND data = ?').get(u.id, hoje)) {
        await enviarFechamentoVendedores(u, hoje);
        db.prepare('INSERT OR IGNORE INTO vendedor_fechamentos (usuario_id, data) VALUES (?, ?)').run(u.id, hoje);
      }
    } catch (e) { console.error('Fechamento vendedor:', e.message); }
  }
}

// ---------------- 6) Fechamento do vendedor ----------------
// Contato de cada vendedor (membro do Orbitta) por loja, pra mandar o resumo do dia dele
db.exec(`CREATE TABLE IF NOT EXISTS vendedor_contatos (
  usuario_id INTEGER NOT NULL,
  membro_id TEXT NOT NULL,
  whatsapp TEXT,
  email TEXT,
  atualizado_em TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (usuario_id, membro_id)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS vendedor_fechamentos (usuario_id INTEGER NOT NULL, data TEXT NOT NULL, enviado_em TEXT DEFAULT (datetime('now')), PRIMARY KEY (usuario_id, data))`);
const DEMORA_SEG = 5 * 60;
const tempoTxt = (seg) => (seg == null ? '—' : seg < 60 ? seg + 's' : seg < 3600 ? Math.round(seg / 60) + ' min' : Math.floor(seg / 3600) + 'h' + String(Math.round((seg % 3600) / 60)).padStart(2, '0'));

// Placar e números de cada vendedor no dia (mesma ordem do placar do painel)
function fechamentoVendedores(u, data) {
  const m = ob.montar(u.id, data, data);
  const pendentes = new Map();
  if (data === hojeBrasilia()) {
    try { for (const x of semResposta(u)) if (x.vendedor_id) pendentes.set(x.vendedor_id, (pendentes.get(x.vendedor_id) || 0) + 1); } catch (e) { /* sem Orbitta */ }
  }
  // Quantas vezes cada vendedor deixou o cliente esperando mais de 5 min hoje
  const demoras = new Map();
  try {
    db.prepare(`SELECT r.segundos, (SELECT c.vendedor_id FROM orbitta_conversas c WHERE c.usuario_id = r.usuario_id AND c.conversa_id = r.conversa_id
        AND c.vendedor_id IS NOT NULL ORDER BY c.data DESC LIMIT 1) AS vendedor_id
      FROM orbitta_respostas r WHERE r.usuario_id = ? AND r.data = ? AND r.segundos > ?`).all(u.id, data, DEMORA_SEG)
      .forEach((r) => { if (r.vendedor_id) demoras.set(r.vendedor_id, (demoras.get(r.vendedor_id) || 0) + 1); });
  } catch (e) { /* sem tabela */ }
  const contatos = new Map(db.prepare('SELECT membro_id, whatsapp, email FROM vendedor_contatos WHERE usuario_id = ?').all(u.id).map((c) => [c.membro_id, c]));
  const vs = m.vendedores.filter((v) => v.id && (v.pegos || v.vendas || v.conversas || pendentes.get(v.id)))
    .sort((a, b) => b.vendas - a.vendas || b.pegos - a.pegos || (a.resposta_seg ?? 1e9) - (b.resposta_seg ?? 1e9));
  const loja = u.negocio_nome || u.nome;
  return vs.map((v, i) => {
    const f = { membro_id: v.id, nome: v.nome, posicao: i + 1, total: vs.length, pegos: v.pegos, novos: v.novos, reativacoes: v.reativacoes,
      vendas: v.vendas, valor_vendido: v.valor_vendido, resposta_seg: v.resposta_seg, sem_resposta: pendentes.get(v.id) || 0, demoras: demoras.get(v.id) || 0,
      contato: contatos.get(v.id) ? { whatsapp: contatos.get(v.id).whatsapp || '', email: contatos.get(v.id).email || '' } : { whatsapp: '', email: '' } };
    f.texto = textoVendedor(f, loja, data);
    return f;
  });
}
function textoVendedor(f, loja, data) {
  const primeiro = String(f.nome || '').trim().split(/\s+/)[0] || 'vendedor';
  const medalha = ['🥇', '🥈', '🥉'][f.posicao - 1] || '';
  const partes = [
    `Fechamento ${dataBr(data).slice(0, 5)} · ${loja}`,
    `${primeiro}, você ficou em ${f.posicao}º de ${f.total} no placar ${medalha}`.trim(),
    `Leads que pegou: ${f.pegos} (${f.novos} novos, ${f.reativacoes} reativações)`,
    `Vendas: ${f.vendas}${f.valor_vendido ? ` (${brl(f.valor_vendido)})` : ''}`,
    `Tempo médio de resposta: ${tempoTxt(f.resposta_seg)}`,
    f.demoras ? `Cliente esperou mais de 5 min: ${f.demoras} vez${f.demoras > 1 ? 'es' : ''}` : 'Nenhum cliente esperou mais de 5 min 👏',
    f.sem_resposta ? `Ficaram sem resposta agora: ${f.sem_resposta}` : 'Ninguém ficou sem resposta',
  ];
  return partes.join(' · ');
}
function htmlVendedor(f, loja, data) {
  const linha = (t, v, cor) => `<tr><td style="padding:8px 6px;border-bottom:1px solid #E3E6EC;color:#4A5873">${t}</td><td style="padding:8px 6px;border-bottom:1px solid #E3E6EC;text-align:right;font-weight:700;${cor ? 'color:' + cor : ''}">${v}</td></tr>`;
  return `<!doctype html><html><body style="margin:0;background:#F4F5F8;font-family:Arial,sans-serif;color:#151B26">
  <div style="max-width:520px;margin:0 auto;padding:24px 16px">
    <h2 style="margin:0 0 2px">Seu fechamento do dia</h2>
    <p style="margin:0 0 16px;color:#4A5873">${esc(f.nome)} · ${esc(loja)} · ${dataBr(data)}</p>
    <div style="background:#151B26;color:#fff;border-radius:12px;padding:16px;margin:0 0 14px;font-size:18px;font-weight:700">${['🥇', '🥈', '🥉'][f.posicao - 1] || ''} ${f.posicao}º de ${f.total} no placar</div>
    <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:10px">
      ${linha('Leads que pegou', `${f.pegos} <span style="font-weight:400;color:#6B7690">(${f.novos} novos · ${f.reativacoes} reativ.)</span>`)}
      ${linha('Vendas', `${f.vendas}${f.valor_vendido ? ' · ' + brl(f.valor_vendido) : ''}`, f.vendas ? '#0F8F6B' : '')}
      ${linha('Tempo médio de resposta', tempoTxt(f.resposta_seg), f.resposta_seg == null ? '' : f.resposta_seg <= 300 ? '#0F8F6B' : f.resposta_seg <= 900 ? '#B54708' : '#B42318')}
      ${linha('Cliente esperou mais de 5 min', f.demoras, f.demoras ? '#B42318' : '#0F8F6B')}
      ${linha('Sem resposta no fechamento', f.sem_resposta, f.sem_resposta ? '#B42318' : '#0F8F6B')}
    </table>
  </div></body></html>`;
}
// Manda pra cada vendedor que tem e-mail e/ou WhatsApp cadastrado
async function enviarFechamentoVendedores(u, data, teste) {
  const loja = u.negocio_nome || u.nome;
  const modelo = process.env.WHATSAPP_TEMPLATE_VENDEDOR;
  const out = [];
  for (const f of fechamentoVendedores(u, data)) {
    const r = { nome: f.nome, email: null, whatsapp: null };
    if (f.contato.email) {
      try { await enviarEmail({ para: [f.contato.email], assunto: `Seu fechamento ${dataBr(data)} · ${loja}${teste ? ' (teste)' : ''}`, html: htmlVendedor(f, loja, data) }); r.email = 'enviado'; }
      catch (e) { r.email = 'erro'; }
    }
    // Modelo aprovado na Meta: {{1}} vendedor, {{2}} loja, {{3}} resumo
    if (f.contato.whatsapp && modelo) {
      const z = await whatsapp.enviarModelo(f.contato.whatsapp, modelo, [String(f.nome).split(/\s+/)[0], loja, f.texto]);
      r.whatsapp = z.status;
    }
    if (r.email || r.whatsapp) out.push(r);
  }
  return out;
}

// ---------------- 7) Lembrete de visitas na véspera ----------------
// Às 18h (configurável), cada vendedor recebe a lista de quem tem visita amanhã pra confirmar.
db.exec(`CREATE TABLE IF NOT EXISTS visitas_lembretes (usuario_id INTEGER NOT NULL, data TEXT NOT NULL, enviado_em TEXT DEFAULT (datetime('now')), PRIMARY KEY (usuario_id, data))`);
const vendedorDaConversa = db.prepare(`SELECT vendedor_id FROM orbitta_conversas WHERE usuario_id = ? AND conversa_id = ? AND vendedor_id IS NOT NULL ORDER BY data DESC LIMIT 1`);
function primeiroNome(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
function textoConfirmar(a, vendedor, loja) {
  return `Oi${primeiroNome(a.cliente) ? ', ' + primeiroNome(a.cliente) : ''}! Aqui é ${primeiroNome(vendedor) || 'a equipe'}, da ${loja}. Passando pra confirmar sua visita amanhã às ${a.hora}. Posso contar com você?`;
}
// Visitas de amanhã agrupadas por vendedor (quem não tem vendedor fica em "Sem vendedor")
async function visitasDeAmanha(u) {
  const amanha = somaDias(hojeBrasilia(), 1);
  const lista = await agendamentosDe(u, amanha);
  const grupos = new Map();
  for (const a of lista) {
    if (['cancelled', 'canceled', 'cancelado'].includes(String(a.situacao || a.status || '').toLowerCase())) continue;
    let vid = null; try { vid = a.conversa_id ? ((vendedorDaConversa.get(u.id, a.conversa_id) || {}).vendedor_id || null) : null; } catch (e) { /* sem conversa */ }
    const k = vid || '';
    if (!grupos.has(k)) grupos.set(k, { membro_id: vid, nome: vid ? ((nomeMembro.get(vid) || {}).nome || 'Vendedor') : 'Sem vendedor', visitas: [] });
    grupos.get(k).visitas.push(a);
  }
  return { data: amanha, total: lista.length, grupos: [...grupos.values()].sort((a, b) => b.visitas.length - a.visitas.length) };
}
function htmlVisitas(titulo, sub, visitas, vendedor, loja) {
  const linhas = visitas.map((a) => {
    const tel = whatsapp.normalizarTelefone(a.telefone);
    const link = tel ? `https://wa.me/${tel}?text=${encodeURIComponent(textoConfirmar(a, vendedor, loja))}` : null;
    return `<tr><td style="padding:9px 6px;border-bottom:1px solid #E3E6EC;font-weight:700;white-space:nowrap">${esc(a.hora || '')}</td>
      <td style="padding:9px 6px;border-bottom:1px solid #E3E6EC"><b>${esc(a.cliente || a.telefone || '')}</b><div style="color:#6B7690;font-size:12px">${esc(a.telefone || '')}${a.situacao === 'pending' ? ' · a confirmar' : ''}</div></td>
      <td style="padding:9px 6px;border-bottom:1px solid #E3E6EC;text-align:right">${link ? `<a href="${link}" style="background:#128C4B;color:#fff;padding:7px 11px;border-radius:7px;text-decoration:none;font-weight:700;font-size:13px">Confirmar</a>` : ''}</td></tr>`;
  }).join('');
  return `<!doctype html><html><body style="margin:0;background:#F4F5F8;font-family:Arial,sans-serif;color:#151B26">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <h2 style="margin:0 0 2px">${esc(titulo)}</h2><p style="margin:0 0 16px;color:#4A5873">${esc(sub)}</p>
    <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:10px">${linhas}</table>
    <p style="margin:14px 0 0;color:#4A5873;font-size:13px">Toque em <b>Confirmar</b> pra abrir o WhatsApp com a mensagem pronta. Confirmar na véspera derruba as faltas.</p>
  </div></body></html>`;
}
async function enviarLembreteVisitas(u, teste) {
  const loja = u.negocio_nome || u.nome;
  const v = await visitasDeAmanha(u);
  const out = { data: v.data, total: v.total, vendedores: [], celulares: 0, gerente: [] };
  if (!v.total) return out;
  const contatos = new Map(db.prepare('SELECT membro_id, whatsapp, email FROM vendedor_contatos WHERE usuario_id = ?').all(u.id).map((c) => [c.membro_id, c]));
  const modelo = process.env.WHATSAPP_TEMPLATE_VISITAS;
  const dia = dataBr(v.data).slice(0, 5);
  for (const g of v.grupos) {
    const ct = g.membro_id ? contatos.get(g.membro_id) : null;
    if (!ct) continue;
    const r = { nome: g.nome, visitas: g.visitas.length, email: null, whatsapp: null };
    if (ct.email) {
      try { await enviarEmail({ para: [ct.email], assunto: `📅 ${g.visitas.length} visita(s) amanhã pra confirmar · ${loja}${teste ? ' (teste)' : ''}`, html: htmlVisitas(`${primeiroNome(g.nome)}, suas visitas de amanhã`, `${loja} · ${dataBr(v.data)}`, g.visitas, g.nome, loja) }); r.email = 'enviado'; }
      catch (e) { r.email = 'erro'; }
    }
    // Modelo aprovado na Meta: {{1}} vendedor, {{2}} loja, {{3}} lista
    if (ct.whatsapp && modelo) {
      const lista = g.visitas.map((a) => `${a.hora} ${primeiroNome(a.cliente) || a.telefone}`).join(', ');
      r.whatsapp = (await whatsapp.enviarModelo(ct.whatsapp, modelo, [primeiroNome(g.nome), loja, `Amanhã (${dia}): ${lista}`])).status;
    }
    out.vendedores.push(r);
  }
  // Gerente recebe a lista inteira, e quem tem avisos ligados recebe no celular
  const c = configDe(u);
  const para = emailsDe(c);
  if (para.length) {
    try { await enviarEmail({ para, assunto: `📅 ${v.total} visita(s) amanhã · ${loja}${teste ? ' (teste)' : ''}`, html: htmlVisitas(`Visitas de amanhã · ${loja}`, `${dataBr(v.data)} · ${v.grupos.map((g) => `${primeiroNome(g.nome)} ${g.visitas.length}`).join(' · ')}`, v.grupos.flatMap((g) => g.visitas).sort((a, b) => String(a.hora).localeCompare(String(b.hora))), null, loja) }); out.gerente = para; }
    catch (e) { /* segue */ }
  }
  try {
    out.celulares = await push.enviarPara(destinosPush(u), { titulo: `📅 ${v.total} visita${v.total > 1 ? 's' : ''} amanhã · ${loja}`,
      texto: v.grupos.map((g) => `${g.nome}: ${g.visitas.length}`).join(' · ') + ' — confirme hoje pelo painel', url: '/webflow.html', tag: 'visitas-' + u.id });
  } catch (e) { /* segue */ }
  return out;
}
async function rodadaLembretes() {
  if (!orbitta.configurado()) return;
  const h = horaBrasilia(), hoje = hojeBrasilia();
  for (const u of lojasVinculadas()) {
    const c = configDe(u);
    if (!c.lembrete || h < c.lembrete_hora || h >= 23) continue;
    if (db.prepare('SELECT 1 FROM visitas_lembretes WHERE usuario_id = ? AND data = ?').get(u.id, hoje)) continue;
    try { await enviarLembreteVisitas(u); db.prepare('INSERT OR IGNORE INTO visitas_lembretes (usuario_id, data) VALUES (?, ?)').run(u.id, hoje); }
    catch (e) { console.error('Lembrete visitas:', e.message); }
  }
}

// ---------------- 8) Nota da loja (0 a 10) ----------------
// Junta checklist feito, tempo da 1ª resposta e conversão (comparada com a melhor loja da rede).
// Pesos: conversão 40%, resposta 35%, checklist 25%. Se faltar alguma parte, as outras dividem o peso.
function notasDaRede(linhas) {
  const conv = (l) => (l.leads.atual ? l.vendas.atual / l.leads.atual : null);
  const ref = Math.max(0.10, ...linhas.map(conv).filter((x) => x != null));
  for (const l of linhas) {
    const partes = {};
    const cv = conv(l); if (cv != null) partes.conversao = Math.min(1, cv / ref);
    const r = l.primeira_resposta_seg; if (r != null) partes.resposta = r <= 300 ? 1 : r >= 1800 ? 0 : 1 - (r - 300) / 1500;
    const ckl = l.checklist; const ckTx = ckl && ckl.esperadas ? ckl.feitas / ckl.esperadas : ckl && ckl.hoje && ckl.hoje.total ? ckl.hoje.feitas / ckl.hoje.total : null;
    if (ckTx != null) partes.checklist = Math.min(1, ckTx);
    const pesos = { conversao: 0.40, resposta: 0.35, checklist: 0.25 };
    const usados = Object.keys(partes);
    const somaPeso = usados.reduce((t, k) => t + pesos[k], 0);
    l.nota = usados.length ? Math.round(usados.reduce((t, k) => t + partes[k] * pesos[k], 0) / somaPeso * 100) / 10 : null;
    l.nota_partes = Object.fromEntries(usados.map((k) => [k, Math.round(partes[k] * 100) / 10]));
  }
  return linhas;
}

function iniciarExtrasOrbitta() {
  if (!orbitta.configurado()) return;
  let rodando = false;
  const alertas = async () => { if (rodando) return; rodando = true; try { await rodadaAlertas(); } catch (e) { console.error(e.message); } rodando = false; };
  // Confere a cada 1 min pra o aviso de 5 min sair na hora certa (só lê as conversas que mudaram)
  setTimeout(alertas, 90 * 1000);
  setInterval(alertas, 60 * 1000);
  setInterval(() => rodadaResumo().catch((e) => console.error('Orbitta resumo:', e.message)), 10 * 60 * 1000);
  setInterval(() => rodadaLembretes().catch((e) => console.error('Lembrete visitas:', e.message)), 10 * 60 * 1000);
}

// ---------------- 4) Visitas pra confirmar ----------------
const cacheAg = new Map();
function agendamentosDe(u, dia) { return ob.comLoja(u, () => _agendamentosDe(u, dia)); }
async function _agendamentosDe(u, dia) {
  const v = ob.vinculoDe(u); if (!v) return [];
  const chave = `${u.id}|${dia}`;
  const c = cacheAg.get(chave);
  if (c && Date.now() - c.em < 5 * 60 * 1000) return c.lista;
  const lista = [];
  for (let off = 0, i = 0; i < 5; i++) {
    const r = await orbitta.chamar('listar_agendamentos', { start_date: dia, end_date: dia, limit: 100, offset: off, ...ob.filtros(v) });
    lista.push(...(r.agendamentos || []));
    if (!r.proximo_offset || !(r.agendamentos || []).length) break;
    off = r.proximo_offset;
  }
  const ultimo = db.prepare("SELECT MAX(criado_em) AS em, vendedor FROM lead_envios WHERE usuario_id = ? AND telefone = ? AND data >= ?");
  const desde = somaDias(hojeBrasilia(), -2);
  const out = lista.map((a) => {
    const tel = String(a.telefone || '').replace(/\D/g, '');
    let env = null; try { const e = ultimo.get(u.id, tel, desde); if (e && e.em) env = { em: e.em, vendedor: e.vendedor }; } catch (e) { /* sem tabela */ }
    return { id: a.id, data: a.data, hora: a.hora, cliente: a.cliente, telefone: a.telefone, situacao: a.situacao, status: a.status, conversa_id: a.conversa_id, valor_venda: a.valor_venda, ultimo_envio: env };
  }).sort((a, b) => String(a.hora).localeCompare(String(b.hora)));
  cacheAg.set(chave, { em: Date.now(), lista: out });
  if (cacheAg.size > 300) cacheAg.delete(cacheAg.keys().next().value);
  return out;
}

// ---------------- 5) Evolução 30 dias ----------------
const cacheEvo = new Map();
function evolucao(u, dias) { return ob.comLoja(u, () => _evolucao(u, dias)); }
async function _evolucao(u, dias) {
  const v = ob.vinculoDe(u); if (!v) return null;
  const fim = hojeBrasilia(), ini = somaDias(fim, -(dias - 1));
  const chave = `${u.id}|${ini}`;
  const c = cacheEvo.get(chave);
  if (c && Date.now() - c.em < 30 * 60 * 1000) return c.dados;
  const p = await orbitta.chamar('metricas_painel', { start_date: ini, end_date: fim, ...ob.filtros(v) });
  const mapa = new Map();
  for (let d = ini; d <= fim; d = somaDias(d, 1)) mapa.set(d, { dia: d, novos: 0, recorrentes: 0, conversas: 0, agendamentos: 0, vendas: 0, valor: 0 });
  for (const chaveSerie of ['agentes_serie_diaria', 'unidades_serie_diaria']) {
    for (const x of (p && p[chaveSerie]) || []) {
      const r = mapa.get(x.day); if (!r) continue;
      r.novos += x.new_leads || 0; r.recorrentes += x.returning_leads || 0; r.conversas += x.conv_count || 0;
      r.agendamentos += x.bookings_count || 0; r.vendas += x.confirmed_count || 0; r.valor += Number(x.confirmed_total_brl) || 0;
    }
  }
  const dados = { ini, fim, serie: [...mapa.values()] };
  cacheEvo.set(chave, { em: Date.now(), dados });
  return dados;
}

// ---------------- 3) Painel da rede ----------------
async function linhaRede(u, periodo, ini, fim) {
  const m = ob.montar(u.id, ini, fim);
  let comp = null; try { comp = await ob.painelComparado(u, ini, fim); } catch (e) { /* sem comparação */ }
  let resp = 0, respN = 0;
  m.vendedores.forEach((v) => { if (v.primeira_resposta_seg != null && v.conversas) { resp += v.primeira_resposta_seg * v.conversas; respN += v.conversas; } });
  let checklist = null;
  if (u.checklist_ativo) { try { const r = ck.resumo([{ id: u.id, nome: u.nome, negocio_nome: u.negocio_nome, checklist_desde: u.checklist_desde }], ini, fim)[0]; checklist = { esperadas: r.esperadas, feitas: r.feitas, hoje: (r.dias.find((d) => d.em_andamento) || null) }; } catch (e) { /* sem checklist */ } }
  let whatsapp = 0; try { whatsapp = db.prepare('SELECT COUNT(*) AS n FROM lead_envios WHERE usuario_id = ? AND data >= ? AND data <= ?').get(u.id, ini, fim).n; } catch (e) { /* sem tabela */ }
  const g = (k) => (comp ? comp[k] : null);
  return {
    id: u.id, nome: u.negocio_nome || u.nome,
    leads: g('leads_atendidos') || { atual: m.loja.conversas, anterior: null },
    novos: g('leads_novos') || { atual: m.loja.novos, anterior: null },
    reativacoes: g('leads_recorrentes') || { atual: m.loja.reativacoes, anterior: null },
    agendamentos: g('agend_periodo') || { atual: m.loja.agendamentos, anterior: null },
    comparecimentos: g('comparecimentos') || { atual: 0, anterior: null },
    vendas: g('vendas') || { atual: m.loja.vendas, anterior: null },
    valor: g('valor_vendido') || { atual: m.loja.vendas_valor, anterior: null },
    primeira_resposta_seg: respN ? Math.round(resp / respN) : null,
    sem_resposta: fim >= hojeBrasilia() ? semResposta(u).length : null,
    checklist, whatsapp, atualizado_em: m.atualizado_em,
  };
}

// ---------------- rotas ----------------
const lojista = express.Router();
function lojaDoUsuario(req, res) {
  const u = db.prepare('SELECT id, nome, negocio_nome, email, checklist_ativo, checklist_desde, orbitta_vinculo, orbitta_alerta FROM usuarios WHERE id = ?').get(req.usuarioId);
  if (!u || (!u.checklist_ativo && !req.vendoOutraLoja)) { res.status(403).json({ erro: 'Não ativado pra sua conta.' }); return null; }
  if (!ob.vinculoDe(u)) { res.json({ vinculado: false }); return null; }
  return u;
}
lojista.get('/sem-resposta', (req, res) => {
  const u = lojaDoUsuario(req, res); if (!u) return;
  const c = configDe(u);
  res.json({ vinculado: true, minutos: c.minutos, lista: semResposta(u) });
});
lojista.get('/agendamentos', async (req, res) => {
  const u = lojaDoUsuario(req, res); if (!u) return;
  const hoje = hojeBrasilia();
  const dia = req.query.dia === 'hoje' ? hoje : dataValida(req.query.dia) ? req.query.dia : somaDias(hoje, 1);
  try { res.json({ vinculado: true, dia, hoje, lista: await agendamentosDe(u, dia) }); }
  catch (e) { res.status(502).json({ erro: e.message }); }
});
lojista.get('/fechamento', (req, res) => {
  const u = lojaDoUsuario(req, res); if (!u) return;
  const data = dataValida(req.query.data) ? req.query.data : hojeBrasilia();
  res.json({ vinculado: true, data, hoje: hojeBrasilia(), whatsapp_auto: !!process.env.WHATSAPP_TEMPLATE_VENDEDOR && whatsapp.configurado(),
    loja: u.negocio_nome || u.nome, vendedores: fechamentoVendedores(u, data) });
});
lojista.put('/vendedores/:membro/contato', (req, res) => {
  const u = lojaDoUsuario(req, res); if (!u) return;
  const membro = String(req.params.membro || '').slice(0, 64);
  if (!/^[\w-]{4,64}$/.test(membro)) return res.status(400).json({ erro: 'Vendedor inválido.' });
  const b = req.body || {};
  const zap = b.whatsapp ? whatsapp.normalizarTelefone(b.whatsapp) : '';
  if (b.whatsapp && !zap) return res.status(400).json({ erro: 'WhatsApp inválido. Use DDD + número.' });
  const email = String(b.email || '').trim().toLowerCase().slice(0, 120);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ erro: 'E-mail inválido.' });
  db.prepare(`INSERT INTO vendedor_contatos (usuario_id, membro_id, whatsapp, email, atualizado_em) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT (usuario_id, membro_id) DO UPDATE SET whatsapp = excluded.whatsapp, email = excluded.email, atualizado_em = excluded.atualizado_em`)
    .run(u.id, membro, zap || null, email || null);
  res.json({ contato: { whatsapp: zap || '', email } });
});
// Manda o fechamento de hoje agora (pra testar)
lojista.post('/fechamento/enviar', async (req, res) => {
  const u = lojaDoUsuario(req, res); if (!u) return;
  try { const enviados = await enviarFechamentoVendedores(u, hojeBrasilia(), true); res.json({ ok: true, enviados }); }
  catch (e) { res.status(502).json({ erro: e.message }); }
});
lojista.post('/visitas/lembrete', async (req, res) => {
  const u = lojaDoUsuario(req, res); if (!u) return;
  try { res.json({ ok: true, ...(await enviarLembreteVisitas(u, true)) }); }
  catch (e) { res.status(502).json({ erro: e.message }); }
});
lojista.get('/evolucao', async (req, res) => {
  const u = lojaDoUsuario(req, res); if (!u) return;
  try { res.json({ vinculado: true, ...(await evolucao(u, 30)) }); }
  catch (e) { res.status(502).json({ erro: e.message }); }
});

const admin = express.Router();
function lojaPorId(id) {
  return db.prepare('SELECT id, nome, negocio_nome, email, checklist_ativo, checklist_desde, orbitta_vinculo, orbitta_alerta, meta_dia FROM usuarios WHERE id = ? AND is_admin = 0').get(id);
}
admin.get('/rede', async (req, res) => {
  const periodo = ['dia', 'semana', 'mes', 'livre'].includes(req.query.periodo) ? req.query.periodo : 'dia';
  const data = dataValida(req.query.data) ? req.query.data : hojeBrasilia();
  const { ini, fim } = intervalo(periodo, data, req.query.ate);
  const lojas = lojasVinculadas();
  const linhas = [];
  for (const u of lojas) { try { linhas.push(await linhaRede(u, periodo, ini, fim)); } catch (e) { /* pula a loja com erro */ } }
  // Lojas com checklist mas sem Orbitta também entram (só com o checklist)
  const semOrb = db.prepare(`SELECT id, nome, negocio_nome, checklist_ativo, checklist_desde FROM usuarios WHERE checklist_ativo = 1 AND is_admin = 0
    AND cargo IN ('lojista', 'checklist') AND (orbitta_vinculo IS NULL OR orbitta_vinculo = '')`).all();
  const soChecklist = semOrb.map((u) => {
    let checklist = null; try { const r = ck.resumo([u], ini, fim)[0]; checklist = { esperadas: r.esperadas, feitas: r.feitas, hoje: (r.dias.find((d) => d.em_andamento) || null) }; } catch (e) { /* nada */ }
    return { id: u.id, nome: u.negocio_nome || u.nome, sem_orbitta: true, checklist };
  });
  notasDaRede(linhas);
  res.json({ periodo, ini, fim, hoje: hojeBrasilia(), lojas: linhas, so_checklist: soChecklist, configurado: orbitta.configurado() });
});
admin.get('/loja/:id/sem-resposta', (req, res) => {
  const u = lojaPorId(req.params.id); if (!u || !ob.vinculoDe(u)) return res.json({ vinculado: false, lista: [] });
  res.json({ vinculado: true, minutos: configDe(u).minutos, lista: semResposta(u) });
});
admin.get('/loja/:id/evolucao', async (req, res) => {
  const u = lojaPorId(req.params.id); if (!u || !ob.vinculoDe(u)) return res.json({ vinculado: false });
  try { res.json({ vinculado: true, ...(await evolucao(u, 30)) }); } catch (e) { res.status(502).json({ erro: e.message }); }
});
admin.get('/alerta/:id', (req, res) => {
  const u = lojaPorId(req.params.id); if (!u) return res.status(404).json({ erro: 'Conta não encontrada.' });
  res.json({ alerta: configDe(u), email_conta: u.email });
});
admin.patch('/alerta/:id', (req, res) => {
  if (!req.ehAdmin) return res.status(403).json({ erro: 'Só o admin pode mudar os alertas.' });
  const u = lojaPorId(req.params.id); if (!u) return res.status(404).json({ erro: 'Conta não encontrada.' });
  const b = req.body || {};
  const c = configDe(u);
  if (b.minutos !== undefined) c.minutos = Math.min(720, Math.max(5, Math.round(Number(b.minutos) || 5)));
  if (b.emails !== undefined) c.emails = emailsDe({ emails: b.emails }).join(', ');
  if (b.whatsapp !== undefined) c.whatsapp = whatsDe({ whatsapp: b.whatsapp }).join(', ');
  if (b.alerta !== undefined) c.alerta = !!b.alerta;
  if (b.resumo !== undefined) c.resumo = !!b.resumo;
  if (b.inicio !== undefined) c.inicio = Math.min(23, Math.max(0, Math.round(Number(b.inicio) || 8)));
  if (b.fim !== undefined) c.fim = Math.min(24, Math.max(1, Math.round(Number(b.fim) || 22)));
  if (b.lembrete !== undefined) c.lembrete = !!b.lembrete;
  if (b.lembrete_hora !== undefined) c.lembrete_hora = Math.min(22, Math.max(8, Math.round(Number(b.lembrete_hora) || 18)));
  db.prepare('UPDATE usuarios SET orbitta_alerta = ? WHERE id = ?').run(JSON.stringify(c), u.id);
  res.json({ alerta: c });
});
// Manda o resumo de hoje agora (pra testar)
admin.post('/resumo/:id', async (req, res) => {
  if (!req.ehAdmin) return res.status(403).json({ erro: 'Só o admin.' });
  const u = lojaPorId(req.params.id); if (!u || !ob.vinculoDe(u)) return res.status(400).json({ erro: 'Loja não vinculada ao Orbitta.' });
  const c = configDe(u);
  const para = [...new Set([...emailsDe(c), emailInterno()].filter(Boolean))];
  try {
    const hoje = hojeBrasilia();
    const d = await dadosDoDia(u, hoje);
    const loja = u.negocio_nome || u.nome, texto = textoResumo(u, d);
    if (para.length) await enviarEmail({ para, assunto: `Fechamento do dia ${dataBr(hoje)} · ${loja} (teste)`, html: htmlResumo(u, hoje, d) });
    const zap = [];
    if (process.env.WHATSAPP_TEMPLATE_RESUMO) for (const tel of whatsDe(c)) zap.push({ tel, ...(await whatsapp.enviarModelo(tel, process.env.WHATSAPP_TEMPLATE_RESUMO, [loja, dataBr(hoje), texto])) });
    const celulares = await push.enviarPara(destinosPush(u), { titulo: `Fechamento ${dataBr(hoje).slice(0, 5)} · ${loja} (teste)`, texto, tag: 'resumo-' + u.id }).catch(() => 0);
    res.json({ ok: true, para, whatsapp: zap, celulares, texto, whatsapp_configurado: !!process.env.WHATSAPP_TEMPLATE_RESUMO && whatsapp.configurado() });
  } catch (e) { res.status(502).json({ erro: e.message }); }
});

// ---------------- Outras lojas (cargo com "Ver outras lojas" / "Receber alertas") ----------------
const lojas = express.Router();
// Lojas que a pessoa pode olhar, com quantos clientes estão sem resposta agora em cada uma
lojas.get('/', (req, res) => {
  const visiveis = permissoes.lojasVisiveis(req.usuarioId);
  const lista = visiveis.map((l) => {
    const u = lojaPorId(l.id);
    let sem = null;
    try { if (u && ob.vinculoDe(u)) sem = semResposta(u).length; } catch (e) { /* sem Orbitta */ }
    return { ...l, sem_resposta: sem };
  });
  const me = db.prepare('SELECT alerta_lojas_off FROM usuarios WHERE id = ?').get(req.usuarioId) || {};
  res.json({ lojas: lista, alertas: permissoes.lojasPor(req.usuarioId, 'alertas'), silenciadas: permissoes.lerIds(me.alerta_lojas_off) });
});
// Sem resposta de todas as lojas que a pessoa enxerga (e da própria, se for loja), numa lista só
lojas.get('/sem-resposta', (req, res) => {
  const ids = permissoes.lojasVisiveis(req.usuarioId).map((l) => l.id);
  ids.unshift(Number(req.usuarioId));
  const lista = [];
  let minutos = PADRAO.minutos;
  for (const id of ids) {
    const u = lojaPorId(id);
    if (!u || !ob.vinculoDe(u)) continue;
    minutos = configDe(u).minutos;
    try { semResposta(u).forEach((x) => lista.push({ ...x, loja_id: u.id, loja: u.negocio_nome || u.nome })); } catch (e) { /* pula a loja */ }
  }
  lista.sort((a, b) => b.esperando_min - a.esperando_min);
  res.json({ vinculado: true, minutos, lista });
});
// Liga/desliga os avisos de uma loja só pra esta pessoa
lojas.put('/alertas', (req, res) => {
  const alcance = new Set(permissoes.lojasPor(req.usuarioId, 'alertas').map((l) => l.id));
  const off = permissoes.lerIds(JSON.stringify((req.body || {}).silenciadas || [])).filter((id) => alcance.has(id));
  db.prepare('UPDATE usuarios SET alerta_lojas_off = ? WHERE id = ?').run(off.length ? JSON.stringify(off) : null, req.usuarioId);
  res.json({ silenciadas: off });
});

module.exports = { notasDaRede, visitasDeAmanha, enviarLembreteVisitas, fechamentoVendedores, enviarFechamentoVendedores, lojas, lojista, admin, iniciarExtrasOrbitta, verificarRespostas, semResposta, rodadaAlertas, rodadaResumo, htmlResumo, dadosDoDia, evolucao, agendamentosDe, linhaRede, configDe };
