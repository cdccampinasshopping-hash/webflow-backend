// Controle de leads da loja, preenchido por quem faz o checklist diário.
// Cada lead: dia, vendedor que assumiu, número do cliente, se é novo ou reativação, e a situação.
// Os totais (novos, reativações, não responderam, não foram respondidos) saem da lista.
const express = require('express');
const db = require('../db');
const { hojeBrasilia, somaDias, intervalo, dataValida, diasEntre } = require('./checklist');

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    data TEXT NOT NULL,
    vendedor TEXT NOT NULL,
    telefone TEXT NOT NULL,
    tipo TEXT NOT NULL DEFAULT 'novo',
    status TEXT NOT NULL DEFAULT 'atendimento',
    obs TEXT,
    criado_em TEXT DEFAULT (datetime('now')),
    atualizado_em TEXT
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_usuario_data ON leads(usuario_id, data)`);

// Cada vez que alguém abre o WhatsApp pelo painel pra falar com um lead, fica registrado aqui
db.exec(`
  CREATE TABLE IF NOT EXISTS lead_envios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    data TEXT NOT NULL,
    lead_id INTEGER,
    conversa_id TEXT,
    origem TEXT NOT NULL DEFAULT 'manual',
    telefone TEXT NOT NULL,
    contato TEXT,
    vendedor TEXT NOT NULL,
    modelo TEXT,
    criado_em TEXT DEFAULT (datetime('now'))
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_lead_envios ON lead_envios(usuario_id, data)`);
try { db.exec(`ALTER TABLE usuarios ADD COLUMN leads_modelos TEXT`); } catch (e) { /* já existe */ }

// Modelos de mensagem (a loja pode editar). {cliente}, {vendedor} e {loja} são trocados na hora.
const MODELOS_PADRAO = [
  { id: 'reativacao', titulo: 'Reativação', texto: 'Oi, {cliente}! Aqui é {vendedor}, da {loja}. Tudo bem? Vi que a gente conversou um tempo atrás e queria saber se ainda posso te ajudar. Tenho condições novas essa semana!' },
  { id: 'sem_resposta', titulo: 'Não respondeu', texto: 'Oi, {cliente}! Aqui é {vendedor}, da {loja}. Te mandei uma mensagem e não sei se chegou. Ainda tem interesse? Posso te ajudar por aqui mesmo.' },
  { id: 'desculpa', titulo: 'Demoramos pra responder', texto: 'Oi, {cliente}! Aqui é {vendedor}, da {loja}. Desculpa a demora pra te responder! Ainda posso te ajudar? Me conta o que você procura.' },
  { id: 'agendamento', titulo: 'Confirmar visita', texto: 'Oi, {cliente}! Aqui é {vendedor}, da {loja}. Passando pra confirmar sua visita {dia} às {hora}. Posso contar com você?' },
];
function modelosDe(usuarioId) {
  const u = db.prepare('SELECT leads_modelos FROM usuarios WHERE id = ?').get(usuarioId);
  try { const m = JSON.parse((u && u.leads_modelos) || 'null'); if (Array.isArray(m) && m.length) return m; } catch (e) { /* inválido */ }
  return MODELOS_PADRAO;
}

// Mensagens enviadas no período, por vendedor
function enviosDoPeriodo(usuarioId, ini, fim) {
  return db.prepare('SELECT vendedor, telefone, origem FROM lead_envios WHERE usuario_id = ? AND data >= ? AND data <= ?').all(usuarioId, ini, fim);
}
// Junta as mensagens enviadas no resumo (geral e por vendedor)
function juntarEnvios(resumo, envios) {
  const por = new Map();
  for (const e of envios) {
    const k = e.vendedor.trim().toLowerCase();
    if (!por.has(k)) por.set(k, { nome: e.vendedor.trim(), mensagens: 0, tel: new Set() });
    const x = por.get(k); x.mensagens++; x.tel.add(e.telefone);
  }
  resumo.mensagens = envios.length;
  resumo.clientes_contatados = new Set(envios.map((e) => e.telefone)).size;
  const zero = { total: 0, novos: 0, reativacoes: 0, atendimento: 0, vendidos: 0, nao_responderam: 0, nao_respondidos: 0 };
  for (const v of resumo.vendedores) { const x = por.get(v.vendedor.trim().toLowerCase()); v.mensagens = x ? x.mensagens : 0; v.clientes_contatados = x ? x.tel.size : 0; if (x) por.delete(v.vendedor.trim().toLowerCase()); }
  for (const x of por.values()) resumo.vendedores.push({ vendedor: x.nome, ...zero, mensagens: x.mensagens, clientes_contatados: x.tel.size });
  return resumo;
}

const TIPOS = ['novo', 'reativacao'];
// atendimento = em conversa | vendido | nao_respondeu = o cliente não respondeu | nao_respondido = ninguém respondeu o cliente
const STATUS = ['atendimento', 'vendido', 'nao_respondeu', 'nao_respondido'];
const DIAS_EDITAVEIS = 7; // dá pra corrigir a situação de um lead da última semana

function limparLead(b, parcial) {
  const out = {};
  if (!parcial || b.vendedor !== undefined) {
    out.vendedor = String(b.vendedor || '').trim().slice(0, 60);
    if (!out.vendedor) throw new Error('Diga qual vendedor assumiu.');
  }
  if (!parcial || b.telefone !== undefined) {
    const t = String(b.telefone || '').replace(/[^\d]/g, '').slice(0, 15);
    if (t.length < 4) throw new Error('Digite o número do cliente (pelo menos os 4 últimos dígitos).');
    out.telefone = t;
  }
  if (!parcial || b.tipo !== undefined) {
    if (!TIPOS.includes(b.tipo)) throw new Error('Escolha se é lead novo ou reativação.');
    out.tipo = b.tipo;
  }
  if (!parcial || b.status !== undefined) {
    if (!STATUS.includes(b.status)) throw new Error('Escolha a situação do lead.');
    out.status = b.status;
  }
  if (b.obs !== undefined) out.obs = String(b.obs || '').trim().slice(0, 300) || null;
  return out;
}

const CAMPOS = 'id, data, vendedor, telefone, tipo, status, obs, criado_em';

// Soma tudo de uma lista de leads (geral e por vendedor)
function somar(lista) {
  const zero = () => ({ total: 0, novos: 0, reativacoes: 0, atendimento: 0, vendidos: 0, nao_responderam: 0, nao_respondidos: 0 });
  const geral = zero();
  const porVend = new Map();
  for (const l of lista) {
    const chave = l.vendedor.trim();
    if (!porVend.has(chave.toLowerCase())) porVend.set(chave.toLowerCase(), { vendedor: chave, ...zero() });
    for (const alvo of [geral, porVend.get(chave.toLowerCase())]) {
      alvo.total++;
      if (l.tipo === 'reativacao') alvo.reativacoes++; else alvo.novos++;
      if (l.status === 'vendido') alvo.vendidos++;
      else if (l.status === 'nao_respondeu') alvo.nao_responderam++;
      else if (l.status === 'nao_respondido') alvo.nao_respondidos++;
      else alvo.atendimento++;
    }
  }
  return { ...geral, vendedores: [...porVend.values()].sort((a, b) => b.total - a.total || a.vendedor.localeCompare(b.vendedor)) };
}

function leadsDoPeriodo(usuarioId, ini, fim) {
  return db.prepare(`SELECT ${CAMPOS} FROM leads WHERE usuario_id = ? AND data >= ? AND data <= ? ORDER BY data DESC, id DESC`).all(usuarioId, ini, fim);
}

function relatorioDe(usuarioId, periodo, data) {
  const { ini, fim } = intervalo(periodo, data);
  const lista = leadsDoPeriodo(usuarioId, ini, fim);
  const porDia = new Map(diasEntre(ini, fim).map((d) => [d, []]));
  lista.forEach((l) => { if (porDia.has(l.data)) porDia.get(l.data).push(l); });
  const dias = [...porDia.entries()].map(([d, ls]) => { const t = somar(ls); delete t.vendedores; return { data: d, ...t }; });
  const envios = db.prepare('SELECT data, vendedor, telefone, origem FROM lead_envios WHERE usuario_id = ? AND data >= ? AND data <= ?').all(usuarioId, ini, fim);
  dias.forEach((d) => { d.mensagens = envios.filter((e) => e.data === d.data).length; });
  return { periodo, ini, fim, hoje: hojeBrasilia(), resumo: juntarEnvios(somar(lista), envios), dias };
}

function lerPeriodo(q) {
  return {
    periodo: ['dia', 'semana', 'mes'].includes(q.periodo) ? q.periodo : 'dia',
    data: dataValida(q.data) ? q.data : hojeBrasilia(),
  };
}

// ---------------- quem preenche (cargo checklist ou lojista com checklist ligado) ----------------
const lojista = express.Router();
lojista.use((req, res, next) => {
  const u = db.prepare('SELECT checklist_ativo FROM usuarios WHERE id = ?').get(req.usuarioId);
  if (!u || !u.checklist_ativo) return res.status(403).json({ erro: 'O controle de leads não está ativado pra sua conta. Fale com a Flow Solution.' });
  next();
});

lojista.get('/', (req, res) => {
  const hoje = hojeBrasilia();
  const data = dataValida(req.query.data) ? req.query.data : hoje;
  const leads = leadsDoPeriodo(req.usuarioId, data, data);
  // Vendedores usados nos últimos 60 dias, pra sugerir no campo
  const vendedores = db.prepare(`SELECT vendedor, COUNT(*) AS n FROM leads WHERE usuario_id = ? AND data >= ? GROUP BY LOWER(vendedor) ORDER BY n DESC LIMIT 30`)
    .all(req.usuarioId, somaDias(hoje, -60)).map((v) => v.vendedor);
  const envios = db.prepare('SELECT lead_id, conversa_id, telefone, vendedor, criado_em FROM lead_envios WHERE usuario_id = ? AND data = ? ORDER BY id DESC').all(req.usuarioId, data);
  res.json({ hoje, data, editavel: data >= somaDias(hoje, -DIAS_EDITAVEIS), leads, resumo: juntarEnvios(somar(leads), envios), vendedores, envios, modelos: modelosDe(req.usuarioId) });
});

lojista.post('/', (req, res) => {
  try {
    const l = limparLead(req.body || {}, false);
    const r = db.prepare('INSERT INTO leads (usuario_id, data, vendedor, telefone, tipo, status, obs) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.usuarioId, hojeBrasilia(), l.vendedor, l.telefone, l.tipo, l.status, l.obs || null);
    res.status(201).json({ lead: db.prepare(`SELECT ${CAMPOS} FROM leads WHERE id = ?`).get(r.lastInsertRowid) });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

function leadEditavel(req) {
  return db.prepare('SELECT id FROM leads WHERE id = ? AND usuario_id = ? AND data >= ?').get(req.params.id, req.usuarioId, somaDias(hojeBrasilia(), -DIAS_EDITAVEIS));
}

lojista.patch('/:id', (req, res) => {
  if (!leadEditavel(req)) return res.status(404).json({ erro: 'Lead não encontrado (só dá pra mudar leads dos últimos 7 dias).' });
  try {
    const l = limparLead(req.body || {}, true);
    const campos = Object.keys(l);
    if (campos.length) db.prepare(`UPDATE leads SET ${campos.map((c) => c + ' = ?').join(', ')}, atualizado_em = datetime('now') WHERE id = ?`).run(...campos.map((c) => l[c]), req.params.id);
    res.json({ lead: db.prepare(`SELECT ${CAMPOS} FROM leads WHERE id = ?`).get(req.params.id) });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

lojista.delete('/:id', (req, res) => {
  if (!leadEditavel(req)) return res.status(404).json({ erro: 'Lead não encontrado (só dá pra apagar leads dos últimos 7 dias).' });
  db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- WhatsApp: modelos, registro de envio e fila pra reativar ----------
lojista.get('/modelos', (req, res) => res.json({ modelos: modelosDe(req.usuarioId), padrao: MODELOS_PADRAO }));
lojista.put('/modelos', (req, res) => {
  const lista = Array.isArray((req.body || {}).modelos) ? req.body.modelos : null;
  if (!lista) return res.status(400).json({ erro: 'Mande a lista de modelos.' });
  const limpos = lista.slice(0, 8).map((m, i) => ({
    id: String(m.id || 'm' + i).replace(/[^\w-]/g, '').slice(0, 30) || 'm' + i,
    titulo: String(m.titulo || '').trim().slice(0, 40),
    texto: String(m.texto || '').trim().slice(0, 1000),
  })).filter((m) => m.titulo && m.texto);
  if (!limpos.length) return res.status(400).json({ erro: 'Deixe pelo menos um modelo com título e texto.' });
  db.prepare('UPDATE usuarios SET leads_modelos = ? WHERE id = ?').run(JSON.stringify(limpos), req.usuarioId);
  res.json({ modelos: limpos });
});

// Registra que o vendedor abriu o WhatsApp pra falar com o lead
lojista.post('/envios', (req, res) => {
  const b = req.body || {};
  const telefone = String(b.telefone || '').replace(/\D/g, '').slice(0, 15);
  const vendedor = String(b.vendedor || '').trim().slice(0, 60);
  if (telefone.length < 10) return res.status(400).json({ erro: 'Número do cliente incompleto.' });
  if (!vendedor) return res.status(400).json({ erro: 'Diga qual vendedor está mandando.' });
  let leadId = null;
  if (b.lead_id) { const l = db.prepare('SELECT id FROM leads WHERE id = ? AND usuario_id = ?').get(b.lead_id, req.usuarioId); if (l) leadId = l.id; }
  const r = db.prepare('INSERT INTO lead_envios (usuario_id, data, lead_id, conversa_id, origem, telefone, contato, vendedor, modelo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.usuarioId, hojeBrasilia(), leadId, b.conversa_id ? String(b.conversa_id).slice(0, 64) : null, b.origem === 'orbitta' ? 'orbitta' : 'manual',
      telefone, b.contato ? String(b.contato).slice(0, 80) : null, vendedor, b.modelo ? String(b.modelo).slice(0, 40) : null);
  res.status(201).json({ ok: true, id: r.lastInsertRowid });
});

// Quem precisa de uma mensagem: leads da última semana que não responderam / não foram respondidos,
// e conversas do Orbitta dos últimos 3 dias que ficaram em Follow-Up ou Perdido
lojista.get('/reativar', (req, res) => {
  const hoje = hojeBrasilia();
  const ultimo = db.prepare('SELECT MAX(criado_em) AS em, vendedor FROM lead_envios WHERE usuario_id = ? AND telefone = ?');
  const ultimoEnvio = (tel) => { const r = ultimo.get(req.usuarioId, tel); return r && r.em ? { em: r.em, vendedor: r.vendedor } : null; };
  const manuais = db.prepare(`SELECT ${CAMPOS} FROM leads WHERE usuario_id = ? AND data >= ? AND status IN ('nao_respondeu', 'nao_respondido') ORDER BY data DESC, id DESC LIMIT 100`)
    .all(req.usuarioId, somaDias(hoje, -DIAS_EDITAVEIS)).map((l) => ({ ...l, ultimo_envio: ultimoEnvio(l.telefone) }));
  let orbitta = [];
  try {
    orbitta = db.prepare(`SELECT conversa_id, MAX(data) AS data, contato, telefone, etapa, MAX(ultima_mensagem) AS ultima_mensagem FROM orbitta_conversas
      WHERE usuario_id = ? AND data >= ? AND etapa IN ('Follow-Up', 'Perdido') AND telefone IS NOT NULL GROUP BY conversa_id ORDER BY ultima_mensagem DESC LIMIT 100`)
      .all(req.usuarioId, somaDias(hoje, -2)).map((c) => ({ ...c, ultimo_envio: ultimoEnvio(String(c.telefone).replace(/\D/g, '')) }));
  } catch (e) { /* sem Orbitta */ }
  res.json({ hoje, manuais, orbitta });
});

lojista.get('/relatorio', (req, res) => {
  const { periodo, data } = lerPeriodo({ periodo: req.query.periodo || 'semana', data: req.query.data });
  res.json(relatorioDe(req.usuarioId, periodo, data));
});

// ---------------- admin e controle ----------------
const admin = express.Router();

// Todas as lojas com checklist ligado, com os totais do período
admin.get('/relatorio', (req, res) => {
  const { periodo, data } = lerPeriodo(req.query);
  const { ini, fim } = intervalo(periodo, data);
  const lojas = db.prepare(`SELECT id, nome, negocio_nome FROM usuarios
    WHERE is_admin = 0 AND (checklist_ativo = 1 OR id IN (SELECT DISTINCT usuario_id FROM leads WHERE data >= ? AND data <= ?))
      AND cargo IN ('lojista', 'checklist') ORDER BY COALESCE(negocio_nome, nome)`).all(ini, fim);
  const todas = lojas.map((l) => ({ ...l, ...juntarEnvios(somar(leadsDoPeriodo(l.id, ini, fim)), enviosDoPeriodo(l.id, ini, fim)) }));
  res.json({ periodo, ini, fim, hoje: hojeBrasilia(), lojas: todas,
    resumo: juntarEnvios(somar(lojas.flatMap((l) => leadsDoPeriodo(l.id, ini, fim))), lojas.flatMap((l) => enviosDoPeriodo(l.id, ini, fim))) });
});

// Detalhe de uma loja: totais por vendedor, por dia e a lista de leads
admin.get('/loja/:id', (req, res) => {
  const u = db.prepare('SELECT id, nome, negocio_nome FROM usuarios WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ erro: 'Loja não encontrada.' });
  const { periodo, data } = lerPeriodo(req.query);
  const rel = relatorioDe(u.id, periodo, data);
  const envios = db.prepare('SELECT data, telefone, contato, vendedor, origem, modelo, criado_em FROM lead_envios WHERE usuario_id = ? AND data >= ? AND data <= ? ORDER BY id DESC LIMIT 300').all(u.id, rel.ini, rel.fim);
  res.json({ loja: u, ...rel, leads: leadsDoPeriodo(u.id, rel.ini, rel.fim), envios });
});

module.exports = { lojista, admin, somar, juntarEnvios };
