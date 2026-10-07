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
  return { periodo, ini, fim, hoje: hojeBrasilia(), resumo: somar(lista), dias };
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
  res.json({ hoje, data, editavel: data >= somaDias(hoje, -DIAS_EDITAVEIS), leads, resumo: somar(leads), vendedores });
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
  const todas = lojas.map((l) => ({ ...l, ...somar(leadsDoPeriodo(l.id, ini, fim)) }));
  res.json({ periodo, ini, fim, hoje: hojeBrasilia(), lojas: todas, resumo: somar(todas.flatMap((l) => leadsDoPeriodo(l.id, ini, fim))) });
});

// Detalhe de uma loja: totais por vendedor, por dia e a lista de leads
admin.get('/loja/:id', (req, res) => {
  const u = db.prepare('SELECT id, nome, negocio_nome FROM usuarios WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ erro: 'Loja não encontrada.' });
  const { periodo, data } = lerPeriodo(req.query);
  const rel = relatorioDe(u.id, periodo, data);
  res.json({ loja: u, ...rel, leads: leadsDoPeriodo(u.id, rel.ini, rel.fim) });
});

module.exports = { lojista, admin, somar };
