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

// Busca por conversa (última leitura de cada cliente, vendedor da conversa): sem esse índice o banco lia a loja inteira
// pra cada conversa e travava o servidor (09/10/2026)
db.exec('CREATE INDEX IF NOT EXISTS idx_orb_conv_conversa ON orbitta_conversas (usuario_id, conversa_id, data)');

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
// Cada loja pode usar uma chave própria do Orbitta (outra conta/rede); sem chave escolhida usa a principal
function comLoja(u, fn) {
  const v = vinculoDe(u);
  return orbitta.comChave(v && v.chave ? orbitta.tokenDaChave(v.chave) : null, fn, { loja: u.id, chave: v && v.chave ? v.chave : 'principal' });
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
function sincronizarDia(u, data) { return comLoja(u, () => _sincronizarDia(u, data)); }
async function _sincronizarDia(u, data) {
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
  setInterval(rodar, 3 * 60 * 1000);
}

// Quem ficou sem resposta e quem não respondeu, contado direto das conversas do Orbitta
// (substitui o lançamento à mão nas lojas ligadas ao Orbitta).
//  nao_respondidos: o cliente mandou a última mensagem há mais de 5 min e ninguém respondeu
//  nao_responderam: a loja mandou a última mensagem há mais de 2 h e o cliente sumiu (sem venda)
const FECHADAS = ['Convertido', 'Vendido', 'Venda', 'Ganho', 'Fechado'];
function situacaoConversas(usuarioId, ini, fim) {
  const linhas = db.prepare(`SELECT c.conversa_id, c.etapa, c.status, c.ultimo_de, c.ultimo_em FROM orbitta_conversas c
    WHERE c.usuario_id = ? AND c.data >= ? AND c.data <= ?
      AND c.data = (SELECT MAX(x.data) FROM orbitta_conversas x WHERE x.usuario_id = c.usuario_id AND x.conversa_id = c.conversa_id AND x.data <= ?)`).all(usuarioId, ini, fim, fim);
  const agora = Date.now();
  const out = { total: linhas.length, lidas: 0, nao_respondidos: 0, nao_responderam: 0 };
  for (const c of linhas) {
    if (!c.ultimo_de) continue;
    out.lidas++;
    const fechada = FECHADAS.includes(c.etapa || '') || ['resolved', 'closed', 'archived', 'finished'].includes(c.status || '');
    const desde = c.ultimo_em ? (agora - new Date(c.ultimo_em).getTime()) / 60000 : 0;
    if (c.ultimo_de === 'cliente' && !fechada && desde >= 5) out.nao_respondidos++;
    else if (c.ultimo_de === 'loja' && !fechada && desde >= 120) out.nao_responderam++;
  }
  return out;
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
    if (!vend.has(id)) vend.set(id, { id, nome: nome || 'Vendedor ' + String(id || '').slice(0, 4), conversas: 0, agendamentos: 0, vendas: 0, valor_vendido: 0, transferencias: 0, mensagens: 0, _resp: 0, _respN: 0, reativacoes: null });
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
  // Por vendedor só vai número que o Orbitta dá (09/10/2026): conversas, agendamentos, vendas, valor, transferências,
  // 1ª resposta e as reativações do ranking da Missão do dia. Nada de "leads que pegou" calculado aqui.
  for (const c of conv) {
    if (c.etapa) etapas[c.etapa] = (etapas[c.etapa] || 0) + 1;
    if (!c.ficha_em) semFicha++;
  }
  const vendedores = [...vend.values()].map((v) => {
    const { _resp, _respN, ...resto } = v;
    return { ...resto, valor_vendido: Math.round(v.valor_vendido * 100) / 100, primeira_resposta_seg: _respN ? Math.round(_resp / _respN) : null };
  }).filter((v) => v.conversas || v.agendamentos || v.vendas || v.transferencias)
    .sort((a, b) => b.conversas - a.conversas || b.vendas - a.vendas);
  loja.vendas_valor = Math.round(loja.vendas_valor * 100) / 100;
  const tr = temposResposta(usuarioId, ini, fim);
  for (const v of vendedores) { const t = tr.vendedores[v.id]; v.resposta_seg = t ? t.media_seg : null; v.respostas = t ? t.respostas : 0; }
  const m = { loja, vendedores, etapas, resposta: { media_seg: tr.media_seg, respostas: tr.respostas }, sem_vendedor: semVendedor, fichas_pendentes: semFicha,
    situacao: situacaoConversas(usuarioId, ini, fim), atualizado_em: atualizado, erro, tem_dados: dias.length > 0,
    missao: missaoNoPeriodo(usuarioId, ini, fim) };
  aplicarMissao(m);
  return m;
}

// ---------------- reativações por vendedor = ranking da Missão do dia do Orbitta ----------------
// O Orbitta não manda reativação por vendedor nas métricas; o único número dele é o ranking da Missão do dia
// (entra sozinho se a conexão tiver a ferramenta, ou colado na Análise). Sem ranking no período: null ("—").
const normNomeM = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function missaoNoPeriodo(usuarioId, ini, fim) {
  let linhas = [];
  try { linhas = db.prepare('SELECT dia, chave, nome, contatos, origem, atualizado_em FROM orbitta_missao WHERE usuario_id = ? AND dia >= ? AND dia <= ?').all(usuarioId, ini, fim); }
  catch (e) { return { tem: false, dias: 0, linhas: [] }; }
  // Num mesmo dia, se veio direto do Orbitta vale o do Orbitta; senão, o colado
  const auto = new Set(linhas.filter((l) => l.origem === 'orbitta').map((l) => l.dia));
  const validas = linhas.filter((l) => !auto.has(l.dia) || l.origem === 'orbitta');
  const soma = new Map();
  for (const l of validas) { const x = soma.get(l.chave) || { chave: l.chave, nome: l.nome, contatos: 0 }; x.contatos += l.contatos || 0; soma.set(l.chave, x); }
  return { tem: validas.length > 0, dias: new Set(validas.map((l) => l.dia)).size, origem: auto.size ? 'orbitta' : (validas.length ? 'colado' : null),
    atualizado_em: validas.reduce((a, l) => (l.atualizado_em > a ? l.atualizado_em : a), '') || null, linhas: [...soma.values()] };
}
function aplicarMissao(m) {
  const mi = m && m.missao; if (!mi) return m;
  for (const v of m.vendedores) v.reativacoes = mi.tem ? 0 : null;
  if (!mi.tem) return m;
  const porNome = new Map(m.vendedores.map((v) => [normNomeM(v.nome), v]));
  const fora = [];
  for (const l of mi.linhas) {
    let v = porNome.get(l.chave);
    if (!v) { const curto = l.chave.split(' ').slice(0, 2).join(' '); for (const [k, x] of porNome) if (k.startsWith(curto)) { v = x; break; } }
    if (!v) {
      // Vendedor da missão sem conversa no período: entra com zero no resto
      const mb = db.prepare('SELECT id, nome FROM orbitta_membros').all().find((x) => normNomeM(x.nome) === l.chave);
      if (mb) { v = { id: mb.id, nome: mb.nome, conversas: 0, agendamentos: 0, vendas: 0, valor_vendido: 0, transferencias: 0, mensagens: 0, primeira_resposta_seg: null, reativacoes: 0 }; m.vendedores.push(v); porNome.set(l.chave, v); }
    }
    if (v) v.reativacoes += l.contatos; else fora.push({ nome: l.nome, contatos: l.contatos });
  }
  mi.fora_da_loja = fora;
  return m;
}

// Cartões com comparação (período atual x anterior). O Orbitta já devolve os dois. Guarda 5 min.
const cacheComparado = new Map();
// Cache que responde na hora: até 5 min devolve o guardado; até 3 h devolve o guardado e atualiza por trás
// (a próxima abertura já vem com o número novo); mais velho que isso, espera buscar.
const FRESCO = 5 * 60 * 1000, VELHO_OK = 3 * 3600 * 1000;
// Período que inclui hoje: quase ao vivo (1 min). Dias que já fecharam: 5 min.
const FRESCO_HOJE = 60 * 1000;
const frescoDe = (fim) => (String(fim || '') >= hojeBrasilia() ? FRESCO_HOJE : FRESCO);
const buscando = new Map();
function doCache(cache, chave, buscar, fresco = FRESCO) {
  const c = cache.get(chave);
  const atualizar = () => {
    if (!buscando.has(cache) ) buscando.set(cache, new Map());
    const b = buscando.get(cache);
    if (!b.has(chave)) {
      b.set(chave, Promise.resolve().then(buscar).then((dados) => {
        cache.set(chave, { em: Date.now(), dados });
        if (cache.size > 800) cache.delete(cache.keys().next().value);
        return dados;
      }).finally(() => b.delete(chave)));
    }
    return b.get(chave);
  };
  if (c && Date.now() - c.em < fresco) return Promise.resolve(c.dados);
  if (c && Date.now() - c.em < VELHO_OK) { atualizar().catch(() => {}); return Promise.resolve(c.dados); }
  return atualizar();
}
function painelComparado(u, ini, fim) { return comLoja(u, () => _painelComparado(u, ini, fim)); }
async function _painelComparado(u, ini, fim) {
  const v = vinculoDe(u); if (!v || !orbitta.configurado()) return null;
  const chave = `${u.id}|${ini}|${fim}`;
  return doCache(cacheComparado, chave, () => buscarPainel(u, v, ini, fim, chave), frescoDe(fim));
}
async function buscarPainel(u, v, ini, fim, chave) {
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
  return dados;
}
// Equipe direto do Orbitta para o período escolhido (dia, semana, mês ou datas livres), igual à tela de lá.
// Os números de cada vendedor (conversas, agendamentos, vendas, valor, transferências, 1ª resposta)
// e a 1ª resposta da loja passam a vir daqui, em vez de somar os dias guardados. Guarda 5 min.
const cacheEquipeAoVivo = new Map();
function equipeAoVivo(u, ini, fim) { return comLoja(u, () => _equipeAoVivo(u, ini, fim)); }
async function _equipeAoVivo(u, ini, fim) {
  const v = vinculoDe(u); if (!v || !orbitta.configurado()) return null;
  const chave = `${u.id}|${ini}|${fim}`;
  return doCache(cacheEquipeAoVivo, chave, async () => {
    const r = await orbitta.chamar('metricas_equipe', { start_date: ini, end_date: fim, ...filtros(v) });
    return dadosEquipe(r);
  }, frescoDe(fim));
}
function dadosEquipe(r) {
  guardarNomes(r.membros); guardarNomes(r.membros_periodo_anterior);
  return { atual: resumirEquipe(r.membros), anterior: resumirEquipe(r.membros_periodo_anterior), membros_anterior: r.membros_periodo_anterior || [] };
}
// Quem já buscou metricas_equipe (ex.: a foto da equipe de cada minuto) guarda aqui e a tela não precisa buscar de novo
function guardarEquipeAoVivo(u, ini, fim, r) {
  cacheEquipeAoVivo.set(`${u.id}|${ini}|${fim}`, { em: Date.now(), dados: dadosEquipe(r) });
}
// 1ª resposta da loja = média dos vendedores pesada pelas conversas que cada um atendeu (agentes e Unidades separados)
function resumirEquipe(lista) {
  const membros = {};
  let soma = 0, n = 0;
  for (const m of lista || []) {
    const ca = m.conversas_atendidas_agentes || 0, cu = m.conversas_atendidas_unidades || 0;
    const ra = m.primeira_resposta_media_seg_agentes, ru = m.primeira_resposta_media_seg_unidades;
    let s = 0, k = 0;
    if (ra != null && ca) { s += ra * ca; k += ca; }
    if (ru != null && cu) { s += ru * cu; k += cu; }
    if (!k && (ra ?? ru) != null) { s = ra ?? ru; k = 1; }
    soma += s; n += k;
    membros[m.membro_id] = {
      nome: m.nome, conversas: ca + cu, mensagens: (m.mensagens_enviadas_agentes || 0) + (m.mensagens_enviadas_unidades || 0),
      agendamentos: m.agendamentos || 0, vendas: m.vendas || 0, valor_vendido: Math.round((Number(m.valor_vendido) || 0) * 100) / 100,
      transferencias: m.transferencias || 0, primeira_resposta_seg: k ? Math.round(s / k) : null,
    };
  }
  return { membros, primeira_resposta_seg: n ? Math.round(soma / n) : null };
}
// Troca os números de vendedor do que foi guardado pelos do Orbitta no período (reativações = Missão do dia)
function aplicarEquipe(m, eq) {
  if (!m || !eq || !eq.atual) return m;
  const porId = new Map(m.vendedores.map((v) => [v.id, v]));
  for (const [id, x] of Object.entries(eq.atual.membros)) {
    const v = porId.get(id) || { id, nome: x.nome, reativacoes: null };
    Object.assign(v, { nome: x.nome || v.nome, conversas: x.conversas, mensagens: x.mensagens, agendamentos: x.agendamentos, vendas: x.vendas,
      valor_vendido: x.valor_vendido, transferencias: x.transferencias, primeira_resposta_seg: x.primeira_resposta_seg });
    porId.set(id, v);
  }
  for (const [id, v] of porId) if (!eq.atual.membros[id]) Object.assign(v, { conversas: 0, mensagens: 0, agendamentos: 0, vendas: 0, valor_vendido: 0, transferencias: 0, primeira_resposta_seg: null });
  m.vendedores = [...porId.values()].filter((v) => v.conversas || v.agendamentos || v.vendas || v.transferencias || v.reativacoes)
    .sort((a, b) => b.conversas - a.conversas || b.vendas - a.vendas);
  aplicarMissao(m);
  m.loja.vendas = m.vendedores.reduce((t, v) => t + (v.vendas || 0), 0);
  m.primeira_resposta = { atual_seg: eq.atual.primeira_resposta_seg, anterior_seg: eq.anterior.primeira_resposta_seg };
  m.equipe_ao_vivo = true;
  return m;
}
async function montarAoVivo(u, ini, fim) {
  const m = montar(u.id, ini, fim);
  try { aplicarEquipe(m, await equipeAoVivo(u, ini, fim)); } catch (e) { m.equipe_erro = e.message; }
  return m;
}
async function comComparado(u, ini, fim) {
  try { return await painelComparado(u, ini, fim); } catch (e) { return null; }
}

// Período anterior de mesmo tipo (dia anterior, semana anterior, mês anterior)
function periodoAnterior(periodo, ini, fim) {
  if (periodo === 'livre') { const n = diasEntre(ini, fim || ini).length; return { ini: somaDias(ini, -n), fim: somaDias(ini, -1) }; }
  if (periodo === 'mes') { const d = new Date(ini + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); return intervalo('mes', d.toISOString().slice(0, 10)); }
  if (periodo === 'semana') return intervalo('semana', somaDias(ini, -7));
  return intervalo('dia', somaDias(ini, -1));
}

// Cada vendedor no período anterior: métricas do Orbitta (vêm prontas) + reativações da Missão do dia
function vendedoresAnterior(u, periodo, ini, fim) { return comLoja(u, () => _vendedoresAnterior(u, periodo, ini, fim)); }
async function _vendedoresAnterior(u, periodo, ini, fim) {
  const v = vinculoDe(u); if (!v || !orbitta.configurado()) return null;
  const ant = periodoAnterior(periodo, ini, fim);
  const out = {};
  try {
    const eq = { membros: ((await equipeAoVivo(u, ini, fim)) || {}).membros_anterior || [] };
    for (const m of eq.membros) {
      out[m.membro_id] = {
        conversas: (m.conversas_atendidas_agentes || 0) + (m.conversas_atendidas_unidades || 0),
        agendamentos: m.agendamentos || 0, vendas: m.vendas || 0, valor_vendido: Number(m.valor_vendido) || 0, transferencias: m.transferencias || 0,
      };
    }
  } catch (e) { /* sem comparação de métricas */ }
  const m = montar(u.id, ant.ini, ant.fim);
  if (m.missao.tem) for (const x of m.vendedores) out[x.id] = { ...(out[x.id] || {}), reativacoes: x.reativacoes || 0 };
  return { ini: ant.ini, fim: ant.fim, tem_leads: m.missao.tem, tem_missao: m.missao.tem, vendedores: out };
}

function lerPeriodo(q, padrao) {
  return {
    periodo: ['dia', 'semana', 'mes', 'livre'].includes(q.periodo) ? q.periodo : padrao,
    ate: dataValida(q.ate) ? q.ate : null,
    data: dataValida(q.data) ? q.data : hojeBrasilia(),
  };
}

// ---------------- rotas de quem preenche ----------------
const lojista = express.Router();
lojista.get('/', async (req, res) => {
  const u = db.prepare('SELECT id, checklist_ativo, orbitta_vinculo, meta_dia FROM usuarios WHERE id = ?').get(req.usuarioId);
  if (!u || (!u.checklist_ativo && !req.vendoOutraLoja)) return res.status(403).json({ erro: 'Não ativado pra sua conta.' });
  if (!vinculoDe(u)) return res.json({ vinculado: false, meta: metaDe(u) });
  const { periodo, data, ate } = lerPeriodo(req.query, 'dia');
  const { ini, fim } = intervalo(periodo, data, ate);
  const ant = periodoAnterior(periodo, ini, fim);
  const montado = await montarAoVivo(u, ini, fim);
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
  for (const c of [cacheComparado, cacheEquipeAoVivo]) for (const k of [...c.keys()]) if (k.startsWith(u.id + '|')) c.delete(k);
  try { await sincronizarDia(u, hojeBrasilia()); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ erro: e.message }); }
});

// ---------------- rotas do admin / controle ----------------
const admin = express.Router();

// Agentes e Unidades que a chave do Orbitta enxerga (pra vincular às lojas)
admin.get('/escopo', async (req, res) => {
  const chaveId = Number(req.query.chave) || null;
  const token = chaveId ? orbitta.tokenDaChave(chaveId) : orbitta.tokenPrincipal();
  if (!token) return res.json({ configurado: false, chave: chaveId, chaves: listaChaves(), principal: !!orbitta.tokenPrincipal() });
  try { res.json({ configurado: true, chave: chaveId, chaves: listaChaves(), principal: !!orbitta.tokenPrincipal(), ...(await orbitta.comChave(token, () => orbitta.chamar('listar_escopo', {}))) }); }
  catch (e) { res.status(502).json({ erro: e.message }); }
});

// Chaves do Orbitta cadastradas pelo painel (uma por conta/rede). O token nunca volta pro navegador.
function listaChaves() {
  return db.prepare('SELECT id, nome, organizacao, token, criado_em FROM orbitta_chaves ORDER BY id').all()
    .map((c) => ({ id: c.id, nome: c.nome, organizacao: c.organizacao, final: String(c.token).slice(-4), criado_em: c.criado_em,
      lojas: db.prepare(`SELECT COUNT(*) AS n FROM usuarios WHERE json_extract(orbitta_vinculo, '$.chave') = ?`).get(c.id).n }));
}
admin.get('/chaves', (req, res) => res.json({ chaves: listaChaves(), principal: !!orbitta.tokenPrincipal() }));
admin.post('/chaves', async (req, res) => {
  if (!req.ehAdmin) return res.status(403).json({ erro: 'Só o admin pode cadastrar chaves do Orbitta.' });
  const b = req.body || {};
  const token = String(b.token || '').trim();
  const nome = String(b.nome || '').trim().slice(0, 40) || 'Orbitta';
  if (!/^orb_[\w-]{16,200}$/.test(token)) return res.status(400).json({ erro: 'Cole a chave pessoal do Orbitta (começa com orb_).' });
  if (db.prepare('SELECT 1 FROM orbitta_chaves WHERE token = ?').get(token)) return res.status(400).json({ erro: 'Essa chave já está cadastrada.' });
  // Testa a chave antes de guardar
  let escopo;
  try { escopo = await orbitta.comChave(token, () => orbitta.chamar('listar_escopo', {})); }
  catch (e) { return res.status(400).json({ erro: 'O Orbitta não aceitou essa chave: ' + e.message }); }
  const org = (escopo && escopo.organizacao && escopo.organizacao.nome) || null;
  const r = db.prepare('INSERT INTO orbitta_chaves (nome, token, organizacao) VALUES (?, ?, ?)').run(nome, token, org);
  res.status(201).json({ chave: { id: Number(r.lastInsertRowid), nome, organizacao: org, final: token.slice(-4) }, chaves: listaChaves() });
});
admin.delete('/chaves/:id', (req, res) => {
  if (!req.ehAdmin) return res.status(403).json({ erro: 'Só o admin pode apagar chaves do Orbitta.' });
  const c = db.prepare('SELECT id FROM orbitta_chaves WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ erro: 'Chave não encontrada.' });
  const n = db.prepare(`SELECT COUNT(*) AS n FROM usuarios WHERE json_extract(orbitta_vinculo, '$.chave') = ?`).get(c.id).n;
  if (n) return res.status(400).json({ erro: `Essa chave ainda está em ${n} loja(s). Troque a chave delas antes de apagar.` });
  db.prepare('DELETE FROM orbitta_chaves WHERE id = ?').run(c.id);
  res.json({ chaves: listaChaves() });
});

// Vincula uma conta (quem preenche ou lojista) a agentes/Unidades do Orbitta. Só o admin.
admin.patch('/vinculo/:id', (req, res) => {
  if (!req.ehAdmin) return res.status(403).json({ erro: 'Só o admin pode vincular ao Orbitta.' });
  const u = db.prepare('SELECT id FROM usuarios WHERE id = ? AND is_admin = 0').get(req.params.id);
  if (!u) return res.status(404).json({ erro: 'Conta não encontrada.' });
  const limpa = (a) => (Array.isArray(a) ? a : []).map((x) => String(x).trim()).filter((x) => /^[0-9a-f-]{8,64}$/i.test(x)).slice(0, 30);
  const b = req.body || {};
  const v = { agent_ids: limpa(b.agent_ids), store_ids: limpa(b.store_ids) };
  const chaveId = Number(b.chave) || null;
  if (chaveId) {
    if (!db.prepare('SELECT 1 FROM orbitta_chaves WHERE id = ?').get(chaveId)) return res.status(400).json({ erro: 'Chave do Orbitta não encontrada.' });
    v.chave = chaveId;
  }
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
  const { periodo, data, ate } = lerPeriodo(req.query, 'dia');
  const { ini, fim } = intervalo(periodo, data, ate);
  res.json({ vinculado: true, loja: { id: u.id, nome: u.nome, negocio_nome: u.negocio_nome }, periodo, ini, fim, hoje: hojeBrasilia(), ...(await montarAoVivo(u, ini, fim)), comparado: await comComparado(u, ini, fim), anterior: await vendedoresAnterior(u, periodo, ini, fim).catch(() => null) });
});

// ---------------- conferência: Orbitta agora x o que o painel tem guardado ----------------
admin.get('/lojas-vinculadas', (req, res) => {
  const lojas = db.prepare(`SELECT id, nome, negocio_nome, orbitta_vinculo FROM usuarios WHERE is_admin = 0 AND orbitta_vinculo IS NOT NULL AND orbitta_vinculo <> ''
    ORDER BY COALESCE(negocio_nome, nome)`).all().filter((u) => vinculoDe(u) && (!req.relLojas || req.relLojas.has(u.id))).map((u) => ({ id: u.id, nome: u.negocio_nome || u.nome }));
  res.json({ lojas });
});
async function conferencia(lojaId, req, res) {
  const u = db.prepare('SELECT id, nome, negocio_nome, orbitta_vinculo FROM usuarios WHERE id = ?').get(lojaId);
  if (!u) return res.status(404).json({ erro: 'Loja não encontrada.' });
  if (!vinculoDe(u)) return res.json({ vinculado: false, loja: { id: u.id, nome: u.negocio_nome || u.nome } });
  const data = dataValida(req.query.data) ? req.query.data : hojeBrasilia();
  const m = montar(u.id, data, data);
  cacheComparado.delete(`${u.id}|${data}|${data}`);
  let orb = null, erroOrb = null;
  try { orb = await painelComparado(u, data, data); } catch (e) { erroOrb = e.message; }
  const conv = db.prepare(`SELECT COUNT(*) AS total, SUM(vendedor_id IS NOT NULL) AS com_vendedor, SUM(ficha_em IS NULL) AS sem_ficha,
      SUM(ultimo_de IS NOT NULL) AS lidas FROM orbitta_conversas WHERE usuario_id = ? AND data = ?`).get(u.id, data);
  const dia = db.prepare('SELECT atualizado_em, erro FROM orbitta_dia WHERE usuario_id = ? AND data = ?').get(u.id, data) || {};
  const g = (k) => (orb && orb[k] ? orb[k].atual : null);
  res.json({ vinculado: true, loja: { id: u.id, nome: u.negocio_nome || u.nome }, data, hoje: hojeBrasilia(), erro_orbitta: erroOrb,
    sincronizado_em: dia.atualizado_em || null, erro_sincronizacao: dia.erro || null,
    linhas: [
      { id: 'leads', nome: 'Leads atendidos', orbitta: g('leads_atendidos'), painel: m.loja.conversas },
      { id: 'novos', nome: 'Leads novos', orbitta: g('leads_novos'), painel: m.loja.novos },
      { id: 'reativacoes', nome: 'Reativações', orbitta: g('leads_recorrentes'), painel: m.loja.reativacoes },
      { id: 'agend', nome: 'Agendamentos feitos', orbitta: g('agend_detectados'), painel: m.loja.agendamentos },
      { id: 'vendas', nome: 'Vendas', orbitta: g('vendas'), painel: m.loja.vendas },
      { id: 'valor', nome: 'Valor vendido', orbitta: g('valor_vendido'), painel: m.loja.vendas_valor, dinheiro: true },
    ],
    internos: { conversas: conv.total || 0, com_vendedor: conv.com_vendedor || 0, sem_ficha: conv.sem_ficha || 0, lidas: conv.lidas || 0,
      respostas_medidas: m.resposta.respostas, resposta_media_seg: m.resposta.media_seg, situacao: m.situacao } });
}
async function conferenciaSincronizar(lojaId, req, res) {
  const u = db.prepare('SELECT id, orbitta_vinculo FROM usuarios WHERE id = ?').get(lojaId);
  if (!u || !vinculoDe(u)) return res.status(400).json({ erro: 'Loja não vinculada ao Orbitta.' });
  const data = dataValida((req.body || {}).data) ? req.body.data : hojeBrasilia();
  for (const c of [cacheComparado, cacheEquipeAoVivo]) for (const k of [...c.keys()]) if (k.startsWith(u.id + '|')) c.delete(k);
  try { await sincronizarDia(u, data); res.json({ ok: true }); } catch (e) { res.status(502).json({ erro: e.message }); }
}
admin.get('/conferencia/:id', (req, res) => conferencia(req.params.id, req, res));
admin.post('/conferencia/:id/sincronizar', (req, res) => conferenciaSincronizar(req.params.id, req, res));
// Cada loja confere a própria (08/10/2026): Orbitta agora x painel, só da loja de quem está logado
lojista.get('/conferencia', (req, res) => conferencia(req.usuarioId, req, res));
lojista.post('/conferencia/sincronizar', (req, res) => {
  if (req.vendoOutraLoja) return res.status(403).json({ erro: 'Você está olhando outra loja: aqui é só pra ver.' });
  return conferenciaSincronizar(req.usuarioId, req, res);
});

function apagarDoCliente(usuarioId) {
  db.prepare('DELETE FROM orbitta_dia WHERE usuario_id = ?').run(usuarioId);
  db.prepare('DELETE FROM orbitta_conversas WHERE usuario_id = ?').run(usuarioId);
  db.prepare('DELETE FROM orbitta_respostas WHERE usuario_id = ?').run(usuarioId);
}

module.exports = { guardarEquipeAoVivo, equipeAoVivo, aplicarEquipe, montarAoVivo, comLoja, registrarRespostas, temposResposta, metaDe, lojista, admin, iniciarSincronizacaoOrbitta, sincronizarDia, montar, resumirPainel, apagarDoCliente, painelComparado, vendedoresAnterior, vinculoDe, filtros, periodoAnterior };
