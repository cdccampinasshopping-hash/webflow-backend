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

const PADRAO = { minutos: 5, emails: '', whatsapp: '', alerta: true, resumo: true, inicio: 8, fim: 22 };
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
const LER_POR_RODADA = 40;
async function verificarRespostas(u) {
  const v = ob.vinculoDe(u); if (!v) return;
  const hoje = hojeBrasilia();
  const origens = [];
  if ((v.agent_ids || []).length) origens.push(['agente', { agent_ids: v.agent_ids }]);
  if ((v.store_ids || []).length) origens.push(['unidade', { store_ids: v.store_ids }]);
  const salvar = db.prepare(`INSERT INTO orbitta_conversas (usuario_id, data, conversa_id, origem, contato, telefone, etapa, status, ultima_mensagem)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (usuario_id, data, conversa_id) DO UPDATE SET contato = excluded.contato, telefone = excluded.telefone,
      etapa = excluded.etapa, status = excluded.status, ultima_mensagem = excluded.ultima_mensagem`);
  for (const [origem, fo] of origens) {
    const r = await orbitta.chamar('listar_conversas', { start_date: hoje, end_date: hoje, origem, limit: 100, ...fo });
    (r.conversas || []).forEach((c) => salvar.run(u.id, hoje, c.id, origem, c.contato || null, c.telefone || null, c.etapa || null, c.status || null, c.ultima_mensagem || null));
  }
  // Lê só as conversas que mudaram desde a última olhada (das últimas 12 horas)
  const desde = new Date(Date.now() - 12 * 3600000).toISOString();
  const mudaram = db.prepare(`SELECT conversa_id, origem, ultima_mensagem FROM orbitta_conversas WHERE usuario_id = ? AND data = ?
    AND ultima_mensagem >= ? AND (checada_msg IS NULL OR checada_msg <> ultima_mensagem) ORDER BY ultima_mensagem DESC LIMIT ?`).all(u.id, hoje, desde, LER_POR_RODADA);
  const marcar = db.prepare('UPDATE orbitta_conversas SET ultimo_de = ?, ultimo_em = ?, checada_msg = ? WHERE usuario_id = ? AND data = ? AND conversa_id = ?');
  for (const c of mudaram) {
    try {
      const r = await orbitta.chamar('ler_conversa', { id: c.conversa_id, origem: c.origem || 'agente', limit: 8 });
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
      AND COALESCE(status, '') NOT IN ('resolved', 'closed') AND COALESCE(etapa, '') NOT IN ('Convertido')
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
    if (!forcar && db.prepare('SELECT 1 FROM orbitta_resumos WHERE usuario_id = ? AND data = ?').get(u.id, hoje)) continue;
    try {
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
  }
}

function iniciarExtrasOrbitta() {
  if (!orbitta.configurado()) return;
  let rodando = false;
  const alertas = async () => { if (rodando) return; rodando = true; try { await rodadaAlertas(); } catch (e) { console.error(e.message); } rodando = false; };
  // Confere a cada 1 min pra o aviso de 5 min sair na hora certa (só lê as conversas que mudaram)
  setTimeout(alertas, 90 * 1000);
  setInterval(alertas, 60 * 1000);
  setInterval(() => rodadaResumo().catch((e) => console.error('Orbitta resumo:', e.message)), 10 * 60 * 1000);
}

// ---------------- 4) Visitas pra confirmar ----------------
const cacheAg = new Map();
async function agendamentosDe(u, dia) {
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
async function evolucao(u, dias) {
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
  const periodo = ['dia', 'semana', 'mes'].includes(req.query.periodo) ? req.query.periodo : 'dia';
  const data = dataValida(req.query.data) ? req.query.data : hojeBrasilia();
  const { ini, fim } = intervalo(periodo, data);
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
// Liga/desliga os avisos de uma loja só pra esta pessoa
lojas.put('/alertas', (req, res) => {
  const alcance = new Set(permissoes.lojasPor(req.usuarioId, 'alertas').map((l) => l.id));
  const off = permissoes.lerIds(JSON.stringify((req.body || {}).silenciadas || [])).filter((id) => alcance.has(id));
  db.prepare('UPDATE usuarios SET alerta_lojas_off = ? WHERE id = ?').run(off.length ? JSON.stringify(off) : null, req.usuarioId);
  res.json({ silenciadas: off });
});

module.exports = { lojas, lojista, admin, iniciarExtrasOrbitta, verificarRespostas, semResposta, rodadaAlertas, rodadaResumo, htmlResumo, dadosDoDia, evolucao, agendamentosDe, linhaRede, configDe };
