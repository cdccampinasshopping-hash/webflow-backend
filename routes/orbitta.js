// Integração automática com o Orbitta (só leitura).
// O admin diz quais agentes/Unidades do Orbitta são de cada loja. A cada 5 minutos o servidor puxa:
//  - métricas de cada vendedor no dia (conversas atendidas, agendamentos, vendas, transferências, 1ª resposta)
//  - leads novos x reativações do dia (painel do Orbitta)
//  - as conversas do dia, com a ficha de cada cliente: quando falou pela 1ª vez (novo ou reativação) e qual vendedor ficou com ele
const express = require('express');
const db = require('../db');
const orbitta = require('../lib/orbitta');
const { hojeBrasilia, somaDias, intervalo, dataValida, diasEntre } = require('./checklist');

try { db.exec(`ALTER TABLE usuarios ADD COLUMN orbitta_vinculo TEXT`); } catch (e) { /* já existe */ }
db.exec(`
  CREATE TABLE IF NOT EXISTS orbitta_dia (
    usuario_id INTEGER NOT NULL,
    data TEXT NOT NULL,
    equipe TEXT,
    painel TEXT,
    erro TEXT,
    atualizado_em TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (usuario_id, data)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS orbitta_conversas (
    usuario_id INTEGER NOT NULL,
    data TEXT NOT NULL,
    conversa_id TEXT NOT NULL,
    origem TEXT,
    contato TEXT,
    telefone TEXT,
    etapa TEXT,
    status TEXT,
    ultima_mensagem TEXT,
    primeira_mensagem TEXT,
    vendedor_id TEXT,
    ficha_em TEXT,
    PRIMARY KEY (usuario_id, data, conversa_id)
  )
`);

// Tempo de resposta medido pelo próprio servidor: cliente mandou mensagem → vendedor (atendente) respondeu
db.exec(`CREATE TABLE IF NOT EXISTS orbitta_respostas (
  usuario_id INTEGER NOT NULL,
  data TEXT NOT NULL,
  conversa_id TEXT NOT NULL,
  cliente_em TEXT NOT NULL,
  resposta_em TEXT NOT NULL,
  segundos INTEGER NOT NULL,
  PRIMARY KEY (usuario_id, conversa_id, cliente_em)
)`);
// Meta do dia da loja: { leads, vendas }
try { db.exec(`ALTER TABLE usuarios ADD COLUMN meta_dia TEXT`); } catch (e) { /* já existe */ }

// Nome de cada vendedor do Orbitta (as métricas do dia só trazem quem teve movimento naquele dia)
db.exec(`CREATE TABLE IF NOT EXISTS orbitta_membros (id TEXT PRIMARY KEY, nome TEXT NOT NULL, atualizado_em TEXT DEFAULT (datetime('now')))`);
const salvarMembro = db.prepare(`INSERT INTO orbitta_membros (id, nome, atualizado_em) VALUES (?, ?, datetime('now'))
  ON CONFLICT (id) DO UPDATE SET nome = excluded.nome, atualizado_em = excluded.atualizado_em`);
function guardarNomes(lista) { (lista || []).forEach((m) => { if (m && m.membro_id && m.nome) salvarMembro.run(m.membro_id, m.nome); }); }

const FICHAS_POR_RODADA = 120;
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const inicioDoDiaUtc = (d) => d + 'T03:00:00Z'; // 00:00 em Brasília

function vinculoDe(u) {
  try { const v = JSON.parse(u.orbitta_vinculo || 'null'); if (v && ((v.agent_ids || []).length || (v.store_ids || []).length)) return v; } catch (e) { /* inválido */ }
  return null;
}
function filtros(v) {
  const f = {};
  if ((v.agent_ids || []).length) f.agent_ids = v.agent_ids;
  if ((v.store_ids || []).length) f.store_ids = v.store_ids;
  return f;
}

// ---------------- tempo de resposta ----------------
// msgs: mensagens da conversa em ordem (de: cliente | ia | atendente). Grava cada vez que um vendedor
// respondeu um cliente: do 1º recado do cliente (depois da última fala do vendedor) até a resposta do vendedor.
const salvarResposta = db.prepare(`INSERT OR IGNORE INTO orbitta_respostas (usuario_id, data, conversa_id, cliente_em, resposta_em, segundos) VALUES (?, ?, ?, ?, ?, ?)`);
function registrarRespostas(usuarioId, conversaId, msgs) {
  let inicio = null;
  for (const m of msgs || []) {
    const t = new Date(m.data);
    if (isNaN(t)) continue;
    if (m.de === 'cliente') { if (!inicio) inicio = t; continue; }
    if (m.de === 'atendente') {
      if (inicio) {
        const seg = Math.round((t - inicio) / 1000);
        const dia = new Date(inicio.getTime() - 3 * 3600000).toISOString().slice(0, 10);
        if (seg >= 0 && seg < 12 * 3600) salvarResposta.run(usuarioId, dia, conversaId, inicio.toISOString(), t.toISOString(), seg);
      }
      inicio = null;
    }
  }
}
// Média de tempo de resposta no período: da loja e de cada vendedor
function temposResposta(usuarioId, ini, fim) {
  const linhas = db.prepare(`SELECT r.segundos, (SELECT c.vendedor_id FROM orbitta_conversas c WHERE c.usuario_id = r.usuario_id AND c.conversa_id = r.conversa_id
      AND c.vendedor_id IS NOT NULL ORDER BY c.data DESC LIMIT 1) AS vendedor_id
    FROM orbitta_respostas r WHERE r.usuario_id = ? AND r.data >= ? AND r.data <= ?`).all(usuarioId, ini, fim);
  const porVend = {};
  let tot = 0;
  for (const l of linhas) {
    tot += l.segundos;
    if (!l.vendedor_id) continue;
    const v = porVend[l.vendedor_id] || (porVend[l.vendedor_id] = { soma: 0, n: 0 });
    v.soma += l.segundos; v.n++;
  }
  const vendedores = {};
  for (const [id, v] of Object.entries(porVend)) vendedores[id] = { media_seg: Math.round(v.soma / v.n), respostas: v.n };
  return { media_seg: linhas.length ? Math.round(tot / linhas.length) : null, respostas: linhas.length, vendedores };
}
function metaDe(u) {
  try { const m = JSON.parse(u.meta_dia || 'null'); if (m && (m.leads || m.vendas)) return { leads: Number(m.leads) || 0, vendas: Number(m.vendas) || 0 }; } catch (e) { /* inválida */ }
  return null;
}

// ---------------- sincronização ----------------
async function sincronizarDia(u, data) {
  const v = vinculoDe(u); if (!v) return;
  const f = filtros(v);
  try {
    const [equipe, painel] = await Promise.all([
      orbitta.chamar('metricas_equipe', { start_date: data, end_date: data, ...f }),
      orbitta.chamar('metricas_painel', { start_date: data, end_date: data, ...f }),
    ]);
    db.prepare(`INSERT INTO orbitta_dia (usuario_id, data, equipe, painel, erro, atualizado_em) VALUES (?, ?, ?, ?, NULL, datetime('now'))
      ON CONFLICT (usuario_id, data) DO UPDATE SET equipe = excluded.equipe, painel = excluded.painel, erro = NULL, atualizado_em = excluded.atualizado_em`)
      .run(u.id, data, JSON.stringify(equipe.membros || []), JSON.stringify(resumirPainel(painel, data)));
    guardarNomes(equipe.membros); guardarNomes(equipe.membros_periodo_anterior);

    // Conversas do dia (Unidades e/ou agentes), página por página
    const origens = [];
    if ((v.agent_ids || []).length) origens.push(['agente', { agent_ids: v.agent_ids }]);
    if ((v.store_ids || []).length) origens.push(['unidade', { store_ids: v.store_ids }]);
    const salvar = db.prepare(`INSERT INTO orbitta_conversas (usuario_id, data, conversa_id, origem, contato, telefone, etapa, status, ultima_mensagem)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (usuario_id, data, conversa_id) DO UPDATE SET contato = excluded.contato, telefone = excluded.telefone,
        etapa = excluded.etapa, status = excluded.status, ultima_mensagem = excluded.ultima_mensagem`);
    for (const [origem, fo] of origens) {
      let antes = null;
      for (let pag = 0; pag < 20; pag++) {
        const r = await orbitta.chamar('listar_conversas', { start_date: data, end_date: data, origem, limit: 100, ...fo, ...(antes ? { antes_de: antes } : {}) });
        (r.conversas || []).forEach((c) => salvar.run(u.id, data, c.id, origem, c.contato || null, c.telefone || null, c.etapa || null, c.status || null, c.ultima_mensagem || null));
        antes = r.proxima_pagina_antes_de;
        if (!antes || !(r.conversas || []).length) break;
      }
    }

    // Ficha de cada cliente (1ª mensagem e vendedor). Só busca de novo depois de 30 min.
    const pendentes = db.prepare(`SELECT conversa_id, origem FROM orbitta_conversas WHERE usuario_id = ? AND data = ?
      AND (ficha_em IS NULL OR (vendedor_id IS NULL AND ficha_em < datetime('now', '-30 minutes')))
      ORDER BY ficha_em IS NOT NULL, ultima_mensagem DESC LIMIT ?`).all(u.id, data, FICHAS_POR_RODADA);
    const atualizar = db.prepare(`UPDATE orbitta_conversas SET primeira_mensagem = ?, vendedor_id = ?, ficha_em = datetime('now') WHERE usuario_id = ? AND data = ? AND conversa_id = ?`);
    for (const p of pendentes) {
      try {
        const fi = await orbitta.chamar('ficha_do_lead', { id: p.conversa_id, origem: p.origem || 'agente' });
        const ags = (fi.agendamentos || []).filter((a) => a.attendant_user_id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        atualizar.run(fi.primeira_mensagem || null, ags.length ? ags[0].attendant_user_id : null, u.id, data, p.conversa_id);
      } catch (e) {
        atualizar.run(null, null, u.id, data, p.conversa_id);
      }
      await espera(120);
    }
    const semNome = db.prepare(`SELECT 1 FROM orbitta_conversas c WHERE c.usuario_id = ? AND c.data = ? AND c.vendedor_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM orbitta_membros m WHERE m.id = c.vendedor_id) LIMIT 1`).get(u.id, data);
    if (semNome) {
      try { const r = await orbitta.chamar('metricas_equipe', { start_date: somaDias(data, -90), end_date: data, ...f }); guardarNomes(r.membros); guardarNomes(r.membros_periodo_anterior); }
      catch (e) { /* fica sem nome por enquanto */ }
    }
  } catch (e) {
    db.prepare(`INSERT INTO orbitta_dia (usuario_id, data, erro, atualizado_em) VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT (usuario_id, data) DO UPDATE SET erro = excluded.erro, atualizado_em = excluded.atualizado_em`).run(u.id, data, String(e.message).slice(0, 300));
    throw e;
  }
}

// Só o que interessa do painel, somando agentes e Unidades
function resumirPainel(p, data) {
  const out = { conversas: 0, novos: 0, reativacoes: 0, agendamentos: 0, vendas_valor: 0 };
  for (const lado of ['agentes', 'unidades']) {
    const x = p && p[lado]; if (!x) continue;
    const dia = (x.per_day || []).find((d) => d.date === data);
    if (dia) { out.conversas += dia.count || 0; out.novos += dia.new_count || 0; out.reativacoes += dia.returning_count || 0; }
    const b = (x.per_day_bookings || []).find((d) => d.date === data); if (b) out.agendamentos += b.count || 0;
    const s = (x.per_day_sales || []).find((d) => d.date === data); if (s) out.vendas_valor += Number(s.total) || 0;
  }
  return out;
}

let rodando = false;
async function sincronizarTudo(dias) {
  if (rodando || !orbitta.configurado()) return { ok: false };
  rodando = true;
  const lojas = db.prepare(`SELECT id, orbitta_vinculo FROM usuarios WHERE orbitta_vinculo IS NOT NULL AND orbitta_vinculo <> ''`).all();
  const erros = [];
  try {
    for (const u of lojas) {
      for (const d of dias) {
        try { await sincronizarDia(u, d); } catch (e) { erros.push(e.message); }
      }
    }
  } finally { rodando = false; }
  return { ok: !erros.length, lojas: lojas.length, erros: [...new Set(erros)].slice(0, 3) };
}

function iniciarSincronizacaoOrbitta() {
  if (!orbitta.configurado()) { console.log('Orbitta: ORBITTA_TOKEN não configurado, sincronização desligada.'); return; }
  let ontemFeito = null;
  const rodar = async () => {
    const hoje = hojeBrasilia();
    const dias = [hoje];
    // Fecha o dia anterior uma vez (pega o que chegou até meia-noite)
    if (ontemFeito !== hoje) dias.push(somaDias(hoje, -1));
    const r = await sincronizarTudo(dias).catch((e) => ({ erros: [e.message] }));
    if (r && r.ok) ontemFeito = hoje;
    if (r && r.erros && r.erros.length) console.error('Orbitta:', r.erros.join(' | '));
  };
  setTimeout(rodar, 60 * 1000);
  setInterval(rodar, 5 * 60 * 1000);
}

// ---------------- leitura (o que o painel mostra) ----------------
function montar(usuarioId, ini, fim) {
  const dias = db.prepare('SELECT * FROM orbitta_dia WHERE usuario_id = ? AND data >= ? AND data <= ?').all(usuarioId, ini, fim);
  const conv = db.prepare('SELECT data, etapa, primeira_mensagem, vendedor_id, ficha_em FROM orbitta_conversas WHERE usuario_id = ? AND data >= ? AND data <= ?').all(usuarioId, ini, fim);
  const loja = { conversas: 0, novos: 0, reativacoes: 0, agendamentos: 0, vendas: 0, vendas_valor: 0 };
  const vend = new Map();
  const nomeDe = db.prepare('SELECT nome FROM orbitta_membros WHERE id = ?');
  const pegaV = (id, nome) => {
    if (!vend.has(id)) { const g = !nome && id ? nomeDe.get(id) : null; nome = nome || (g && g.nome) || null; }
    if (!vend.has(id)) vend.set(id, { id, nome: nome || 'Vendedor ' + String(id || '').slice(0, 4), conversas: 0, agendamentos: 0, vendas: 0, valor_vendido: 0, transferencias: 0, mensagens: 0, _resp: 0, _respN: 0, pegos: 0, novos: 0, reativacoes: 0 });
    const v = vend.get(id); if (nome) v.nome = nome; return v;
  };
  let atualizado = null, erro = null;
  for (const d of dias) {
    if (!atualizado || d.atualizado_em > atualizado) { atualizado = d.atualizado_em; erro = d.erro; }
    let p = {}; try { p = JSON.parse(d.painel || '{}') || {}; } catch (e) { /* vazio */ }
    loja.conversas += p.conversas || 0; loja.novos += p.novos || 0; loja.reativacoes += p.reativacoes || 0;
    loja.agendamentos += p.agendamentos || 0; loja.vendas_valor += p.vendas_valor || 0;
    let eq = []; try { eq = JSON.parse(d.equipe || '[]') || []; } catch (e) { /* vazio */ }
    for (const m of eq) {
      const v = pegaV(m.membro_id, m.nome);
      const conversas = (m.conversas_atendidas_agentes || 0) + (m.conversas_atendidas_unidades || 0);
      v.conversas += conversas;
      v.mensagens += (m.mensagens_enviadas_agentes || 0) + (m.mensagens_enviadas_unidades || 0);
      v.agendamentos += m.agendamentos || 0; v.vendas += m.vendas || 0; v.valor_vendido += Number(m.valor_vendido) || 0;
      v.transferencias += m.transferencias || 0;
      const resp = m.primeira_resposta_media_seg_agentes ?? m.primeira_resposta_media_seg_unidades;
      if (resp != null && conversas) { v._resp += resp * conversas; v._respN += conversas; }
      loja.vendas += m.vendas || 0;
    }
  }
  const etapas = {};
  let semVendedor = 0, semFicha = 0;
  for (const c of conv) {
    if (c.etapa) etapas[c.etapa] = (etapas[c.etapa] || 0) + 1;
    if (!c.ficha_em) { semFicha++; continue; }
    // Reativação = cliente que já tinha falado com a loja antes desse dia
    const ehReativ = c.primeira_mensagem ? new Date(c.primeira_mensagem) < new Date(inicioDoDiaUtc(c.data)) : false;
    if (!c.vendedor_id) { semVendedor++; continue; }
    const v = pegaV(c.vendedor_id, null);
    v.pegos++; if (ehReativ) v.reativacoes++; else v.novos++;
  }
  const vendedores = [...vend.values()].map((v) => {
    const { _resp, _respN, ...resto } = v;
    return { ...resto, valor_vendido: Math.round(v.valor_vendido * 100) / 100, primeira_resposta_seg: _respN ? Math.round(_resp / _respN) : null };
  }).filter((v) => v.conversas || v.agendamentos || v.vendas || v.pegos || v.transferencias)
    .sort((a, b) => b.pegos - a.pegos || b.conversas - a.conversas);
  loja.vendas_valor = Math.round(loja.vendas_valor * 100) / 100;
  const tr = temposResposta(usuarioId, ini, fim);
  for (const v of vendedores) { const t = tr.vendedores[v.id]; v.resposta_seg = t ? t.media_seg : null; v.respostas = t ? t.respostas : 0; }
  return { loja, vendedores, etapas, resposta: { media_seg: tr.media_seg, respostas: tr.respostas }, sem_vendedor: semVendedor, fichas_pendentes: semFicha, atualizado_em: atualizado, erro, tem_dados: dias.length > 0 };
}

// Cartões com comparação (período atual x anterior). O Orbitta já devolve os dois. Guarda 5 min.
const cacheComparado = new Map();
async function painelComparado(u, ini, fim) {
  const v = vinculoDe(u); if (!v || !orbitta.configurado()) return null;
  const chave = `${u.id}|${ini}|${fim}`;
  const c = cacheComparado.get(chave);
  if (c && Date.now() - c.em < 5 * 60 * 1000) return c.dados;
  const p = await orbitta.chamar('metricas_painel', { start_date: ini, end_date: fim, ...filtros(v) });
  const soma = (fn) => ['agentes', 'unidades'].reduce((t, lado) => t + (p && p[lado] ? Number(fn(p[lado]) || 0) : 0), 0);
  const par = (fa, fb) => ({ atual: soma(fa), anterior: soma(fb) });
  const dados = {
    leads_atendidos: par((x) => x.current_conv && x.current_conv.leads_total, (x) => x.prev_conv && x.prev_conv.leads_total),
    leads_novos: par((x) => x.current_conv && x.current_conv.leads_new, (x) => x.prev_conv && x.prev_conv.leads_new),
    leads_recorrentes: par((x) => x.current_conv && x.current_conv.leads_returning, (x) => x.prev_conv && x.prev_conv.leads_returning),
    atendidos_ia: par((x) => x.current_conv && x.current_conv.leads_ai_only, (x) => x.prev_conv && x.prev_conv.leads_ai_only),
    atendidos_ia_humano: par((x) => x.current_conv && x.current_conv.leads_ai_human, (x) => x.prev_conv && x.prev_conv.leads_ai_human),
    agend_detectados: par((x) => x.current_bookings && x.current_bookings.total, (x) => x.prev_bookings && x.prev_bookings.total),
    agend_periodo: par((x) => x.current_scheduled && x.current_scheduled.scheduled_total, (x) => x.prev_scheduled && x.prev_scheduled.scheduled_total),
    comparecimentos: par((x) => x.current_scheduled && x.current_scheduled.scheduled_attended, (x) => x.prev_scheduled && x.prev_scheduled.scheduled_attended),
    vendas: par((x) => x.current_bookings && x.current_bookings.confirmed_count, (x) => x.prev_bookings && x.prev_bookings.confirmed_count),
    valor_vendido: par((x) => x.current_bookings && x.current_bookings.confirmed_total, (x) => x.prev_bookings && x.prev_bookings.confirmed_total),
  };
  cacheComparado.set(chave, { em: Date.now(), dados });
  if (cacheComparado.size > 500) cacheComparado.delete(cacheComparado.keys().next().value);
  return dados;
}
async function comComparado(u, ini, fim) {
  try { return await painelComparado(u, ini, fim); } catch (e) { return null; }
}

// Período anterior de mesmo tipo (dia anterior, semana anterior, mês anterior)
function periodoAnterior(periodo, ini) {
  if (periodo === 'mes') { const d = new Date(ini + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); return intervalo('mes', d.toISOString().slice(0, 10)); }
  if (periodo === 'semana') return intervalo('semana', somaDias(ini, -7));
  return intervalo('dia', somaDias(ini, -1));
}

// Cada vendedor no período anterior: métricas do Orbitta (vêm prontas) + leads que pegou (do que já foi sincronizado)
const cacheEquipe = new Map();
async function vendedoresAnterior(u, periodo, ini, fim) {
  const v = vinculoDe(u); if (!v || !orbitta.configurado()) return null;
  const ant = periodoAnterior(periodo, ini);
  const out = {};
  try {
    const chave = `${u.id}|${ini}|${fim}`;
    let eq = cacheEquipe.get(chave);
    if (!eq || Date.now() - eq.em > 10 * 60 * 1000) {
      const r = await orbitta.chamar('metricas_equipe', { start_date: ini, end_date: fim, ...filtros(v) });
      eq = { em: Date.now(), membros: r.membros_periodo_anterior || [] };
      guardarNomes(r.membros); guardarNomes(r.membros_periodo_anterior);
      cacheEquipe.set(chave, eq);
      if (cacheEquipe.size > 500) cacheEquipe.delete(cacheEquipe.keys().next().value);
    }
    for (const m of eq.membros) {
      out[m.membro_id] = {
        conversas: (m.conversas_atendidas_agentes || 0) + (m.conversas_atendidas_unidades || 0),
        agendamentos: m.agendamentos || 0, vendas: m.vendas || 0, valor_vendido: Number(m.valor_vendido) || 0, transferencias: m.transferencias || 0,
      };
    }
  } catch (e) { /* sem comparação de métricas */ }
  const m = montar(u.id, ant.ini, ant.fim);
  const temConversas = db.prepare('SELECT 1 FROM orbitta_conversas WHERE usuario_id = ? AND data >= ? AND data <= ? LIMIT 1').get(u.id, ant.ini, ant.fim);
  for (const x of m.vendedores) {
    out[x.id] = { ...(out[x.id] || {}), ...(temConversas ? { pegos: x.pegos, novos: x.novos, reativacoes: x.reativacoes } : {}) };
  }
  return { ini: ant.ini, fim: ant.fim, tem_leads: !!temConversas, vendedores: out };
}

function lerPeriodo(q, padrao) {
  return {
    periodo: ['dia', 'semana', 'mes'].includes(q.periodo) ? q.periodo : padrao,
    data: dataValida(q.data) ? q.data : hojeBrasilia(),
  };
}

// ---------------- rotas de quem preenche ----------------
const lojista = express.Router();
lojista.get('/', async (req, res) => {
  const u = db.prepare('SELECT id, checklist_ativo, orbitta_vinculo, meta_dia FROM usuarios WHERE id = ?').get(req.usuarioId);
  if (!u || (!u.checklist_ativo && !req.vendoOutraLoja)) return res.status(403).json({ erro: 'Não ativado pra sua conta.' });
  if (!vinculoDe(u)) return res.json({ vinculado: false, meta: metaDe(u) });
  const { periodo, data } = lerPeriodo(req.query, 'dia');
  const { ini, fim } = intervalo(periodo, data);
  const ant = periodoAnterior(periodo, ini);
  const montado = montar(u.id, ini, fim);
  const respAnt = temposResposta(u.id, ant.ini, ant.fim);
  res.json({ vinculado: true, configurado: orbitta.configurado(), periodo, ini, fim, hoje: hojeBrasilia(), ...montado,
    resposta: { ...montado.resposta, anterior_seg: respAnt.media_seg }, meta: metaDe(u),
    comparado: await comComparado(u, ini, fim), anterior: await vendedoresAnterior(u, periodo, ini, fim).catch(() => null) });
});
// Meta do dia (leads atendidos e vendas). 0 nos dois apaga a meta.
lojista.put('/meta', (req, res) => {
  const u = db.prepare('SELECT id, checklist_ativo FROM usuarios WHERE id = ?').get(req.usuarioId);
  if (!u || !u.checklist_ativo) return res.status(403).json({ erro: 'Não ativado pra sua conta.' });
  const n = (x) => Math.min(100000, Math.max(0, Math.round(Number(x) || 0)));
  const m = { leads: n((req.body || {}).leads), vendas: n((req.body || {}).vendas) };
  db.prepare('UPDATE usuarios SET meta_dia = ? WHERE id = ?').run(m.leads || m.vendas ? JSON.stringify(m) : null, u.id);
  res.json({ meta: m.leads || m.vendas ? m : null });
});
// "Atualizar agora" (no máximo 1x a cada 2 minutos por loja)
const ultimaManual = new Map();
lojista.post('/atualizar', async (req, res) => {
  const u = db.prepare('SELECT id, checklist_ativo, orbitta_vinculo FROM usuarios WHERE id = ?').get(req.usuarioId);
  if (!u || (!u.checklist_ativo && !req.vendoOutraLoja) || !vinculoDe(u)) return res.status(403).json({ erro: 'Loja não vinculada ao Orbitta.' });
  if (Date.now() - (ultimaManual.get(u.id) || 0) < 120000) return res.status(429).json({ erro: 'Acabou de atualizar. Tente de novo em 2 minutos.' });
  ultimaManual.set(u.id, Date.now());
  for (const c of [cacheComparado, cacheEquipe]) for (const k of [...c.keys()]) if (k.startsWith(u.id + '|')) c.delete(k);
  try { await sincronizarDia(u, hojeBrasilia()); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ erro: e.message }); }
});

// ---------------- rotas do admin / controle ----------------
const admin = express.Router();

// Agentes e Unidades que a chave do Orbitta enxerga (pra vincular às lojas)
admin.get('/escopo', async (req, res) => {
  if (!orbitta.configurado()) return res.json({ configurado: false });
  try { res.json({ configurado: true, ...(await orbitta.chamar('listar_escopo', {})) }); }
  catch (e) { res.status(502).json({ erro: e.message }); }
});

// Vincula uma conta (quem preenche ou lojista) a agentes/Unidades do Orbitta. Só o admin.
admin.patch('/vinculo/:id', (req, res) => {
  if (!req.ehAdmin) return res.status(403).json({ erro: 'Só o admin pode vincular ao Orbitta.' });
  const u = db.prepare('SELECT id FROM usuarios WHERE id = ? AND is_admin = 0').get(req.params.id);
  if (!u) return res.status(404).json({ erro: 'Conta não encontrada.' });
  const limpa = (a) => (Array.isArray(a) ? a : []).map((x) => String(x).trim()).filter((x) => /^[0-9a-f-]{8,64}$/i.test(x)).slice(0, 30);
  const b = req.body || {};
  const v = { agent_ids: limpa(b.agent_ids), store_ids: limpa(b.store_ids) };
  const valor = v.agent_ids.length || v.store_ids.length ? JSON.stringify(v) : null;
  db.prepare('UPDATE usuarios SET orbitta_vinculo = ? WHERE id = ?').run(valor, u.id);
  if (valor) sincronizarDia({ id: u.id, orbitta_vinculo: valor }, hojeBrasilia()).catch((e) => console.error('Orbitta:', e.message));
  res.json({ ok: true, vinculo: v });
});

admin.get('/vinculos', (req, res) => {
  const lista = db.prepare(`SELECT id, orbitta_vinculo FROM usuarios WHERE orbitta_vinculo IS NOT NULL AND orbitta_vinculo <> ''`).all();
  res.json({ vinculos: Object.fromEntries(lista.map((l) => [l.id, vinculoDe(l)])) });
});

// Puxa de novo os últimos N dias (até 31) de todas as lojas vinculadas
admin.post('/sincronizar', async (req, res) => {
  if (!orbitta.configurado()) return res.status(400).json({ erro: 'Falta a variável ORBITTA_TOKEN no Railway.' });
  const n = Math.min(31, Math.max(1, Number((req.body || {}).dias) || 1));
  const hoje = hojeBrasilia();
  const dias = diasEntre(somaDias(hoje, -(n - 1)), hoje).reverse();
  const r = await sincronizarTudo(dias);
  if (r.ok === false && !r.lojas) return res.status(409).json({ erro: 'Já tem uma sincronização rodando. Tente em alguns minutos.' });
  res.json(r);
});

// Uma loja específica (o controle e o admin veem no relatório de leads)
admin.get('/loja/:id', async (req, res) => {
  const u = db.prepare('SELECT id, nome, negocio_nome, orbitta_vinculo FROM usuarios WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ erro: 'Loja não encontrada.' });
  if (!vinculoDe(u)) return res.json({ vinculado: false, loja: { id: u.id, nome: u.nome, negocio_nome: u.negocio_nome } });
  const { periodo, data } = lerPeriodo(req.query, 'dia');
  const { ini, fim } = intervalo(periodo, data);
  res.json({ vinculado: true, loja: { id: u.id, nome: u.nome, negocio_nome: u.negocio_nome }, periodo, ini, fim, hoje: hojeBrasilia(), ...montar(u.id, ini, fim), comparado: await comComparado(u, ini, fim), anterior: await vendedoresAnterior(u, periodo, ini, fim).catch(() => null) });
});

function apagarDoCliente(usuarioId) {
  db.prepare('DELETE FROM orbitta_dia WHERE usuario_id = ?').run(usuarioId);
  db.prepare('DELETE FROM orbitta_conversas WHERE usuario_id = ?').run(usuarioId);
  db.prepare('DELETE FROM orbitta_respostas WHERE usuario_id = ?').run(usuarioId);
}

module.exports = { registrarRespostas, temposResposta, metaDe, lojista, admin, iniciarSincronizacaoOrbitta, sincronizarDia, montar, resumirPainel, apagarDoCliente, painelComparado, vendedoresAnterior, vinculoDe, filtros, periodoAnterior };
