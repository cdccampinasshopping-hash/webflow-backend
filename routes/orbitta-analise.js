// "Análise do Orbitta (início do dia)": relatório simples, no formato que a gestão manda no grupo.
// Por loja: leads novos e recorrentes de ONTEM e quantos agendamentos tem pra HOJE.
// Por vendedor: leads novos e reativações que pegou ontem, agendamentos que marcou ontem
// e, desses, quantos são pra hoje e quantos pra outros dias.
//
// O Orbitta não diz na lista de agendamentos quem marcou nem quando foi marcado; isso vem na ficha
// do lead. Por isso guardamos cada agendamento já lido (id, quando foi criado, vendedor, data marcada)
// e só buscamos a ficha dos agendamentos que ainda não conhecemos.
const express = require('express');
const db = require('../db');
const orbitta = require('../lib/orbitta');
const ob = require('./orbitta');
const permissoes = require('../lib/permissoes');
const { hojeBrasilia, somaDias, dataValida } = require('./checklist');

db.exec(`CREATE TABLE IF NOT EXISTS orbitta_agendamentos (
  id TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL,
  conversa_id TEXT,
  criado_em TEXT,
  criado_dia TEXT,
  vendedor_id TEXT,
  data_agendada TEXT,
  status TEXT,
  lido_em TEXT DEFAULT (datetime('now'))
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_orb_ag_criado ON orbitta_agendamentos (usuario_id, criado_dia)`);
// Quando o cliente falou com a loja pela primeira vez (pra saber se o agendamento é de cliente novo ou reativado)
try { db.exec('ALTER TABLE orbitta_agendamentos ADD COLUMN primeira_msg TEXT'); } catch (e) { /* já existe */ }

const JANELA_DIAS = 45;        // agendamentos marcados ontem costumam ser pra até ~1 mês e meio
const FICHAS_POR_PEDIDO = 200; // limite de fichas lidas por vez (o resto entra na próxima)
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const diaBrasilia = (iso) => { const t = new Date(iso); return isNaN(t) ? null : new Date(t.getTime() - 3 * 3600000).toISOString().slice(0, 10); };
const cancelado = (a) => /cancel/i.test(String(a.status || '')) || /cancel/i.test(String(a.situacao || ''));

const salvar = db.prepare(`INSERT INTO orbitta_agendamentos (id, usuario_id, conversa_id, criado_em, criado_dia, vendedor_id, data_agendada, status, lido_em)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT (id) DO UPDATE SET usuario_id = excluded.usuario_id, vendedor_id = excluded.vendedor_id, data_agendada = excluded.data_agendada,
    status = excluded.status, lido_em = excluded.lido_em`);
const conhecido = db.prepare('SELECT 1 FROM orbitta_agendamentos WHERE id = ?');
const nomeDe = db.prepare('SELECT nome FROM orbitta_membros WHERE id = ?');
const guardarPrimeira = db.prepare('UPDATE orbitta_agendamentos SET primeira_msg = ? WHERE conversa_id = ?');
const primeiraDaConversa = db.prepare('SELECT MIN(primeira_mensagem) AS p FROM orbitta_conversas WHERE usuario_id = ? AND conversa_id = ?');

// Todos os agendamentos com data marcada no intervalo (página por página)
async function listarAgendamentos(f, ini, fim) {
  const lista = [];
  for (let offset = 0, pag = 0; pag < 30; pag++) {
    const r = await orbitta.chamar('listar_agendamentos', { start_date: ini, end_date: fim, limit: 100, offset, ...f });
    lista.push(...(r.agendamentos || []));
    if (r.proximo_offset == null || !(r.agendamentos || []).length) break;
    offset = r.proximo_offset;
  }
  return lista;
}

async function _analiseLoja(u, hoje) {
  const v = ob.vinculoDe(u);
  if (!v) return { vinculado: false };
  const f = ob.filtros(v);
  const ontem = somaDias(hoje, -1);

  // Leads de ontem (painel do Orbitta) e agendamentos marcados de ontem em diante
  const [comparado, lista] = await Promise.all([
    ob.painelComparado(u, ontem, ontem).catch(() => null),
    listarAgendamentos(f, ontem, somaDias(hoje, JANELA_DIAS)),
  ]);

  // Lê a ficha só dos agendamentos ainda desconhecidos (uma ficha traz todos os agendamentos daquele cliente)
  let lidas = 0, faltaram = 0;
  for (const a of lista) {
    if (!a.id || !a.conversa_id || conhecido.get(a.id)) continue;
    if (lidas >= FICHAS_POR_PEDIDO) { faltaram++; continue; }
    lidas++;
    try {
      const fi = await orbitta.chamar('ficha_do_lead', { id: a.conversa_id, origem: a.origem === 'unidade' ? 'unidade' : 'agente' });
      for (const x of fi.agendamentos || []) {
        if (!x.id) continue;
        salvar.run(x.id, u.id, x.conversation_id || a.conversa_id, x.created_at || null, diaBrasilia(x.created_at),
          x.attendant_user_id || x.created_by_user_id || null, x.booking_date || null, x.confirmation_status || x.status || null);
      }
      if (!conhecido.get(a.id)) salvar.run(a.id, u.id, a.conversa_id, null, null, null, a.data || null, a.status || null);
      if (fi.primeira_mensagem) guardarPrimeira.run(fi.primeira_mensagem, a.conversa_id);
    } catch (e) { /* tenta de novo na próxima */ }
    await espera(80);
  }
  // Atualiza data/situação do que já conhecemos com o que a lista trouxe agora (pode ter remarcado/cancelado)
  const atualizar = db.prepare('UPDATE orbitta_agendamentos SET data_agendada = ?, status = ? WHERE id = ?');
  for (const a of lista) if (a.id) atualizar.run(a.data || null, a.status || null, a.id);

  // Agendamentos do dia já conhecidos mas sem a data da 1ª mensagem do cliente: busca a ficha (poucas por vez)
  const semPrimeira = db.prepare(`SELECT DISTINCT conversa_id FROM orbitta_agendamentos WHERE usuario_id = ? AND criado_dia = ? AND primeira_msg IS NULL AND conversa_id IS NOT NULL LIMIT 40`).all(u.id, ontem);
  for (const { conversa_id } of semPrimeira) {
    const ja = primeiraDaConversa.get(u.id, conversa_id);
    if (ja && ja.p) { guardarPrimeira.run(ja.p, conversa_id); continue; }
    const origem = (lista.find((a) => a.conversa_id === conversa_id) || {}).origem === 'unidade' ? 'unidade' : 'agente';
    try { const fi = await orbitta.chamar('ficha_do_lead', { id: conversa_id, origem }); guardarPrimeira.run(fi.primeira_mensagem || '-', conversa_id); } catch (e) { /* próxima */ }
    await espera(80);
  }

  const paraHoje = lista.filter((a) => a.data === hoje && !cancelado(a)).length;

  // Agendamentos marcados ontem, por vendedor
  const ags = db.prepare(`SELECT vendedor_id, data_agendada, status, conversa_id, primeira_msg FROM orbitta_agendamentos WHERE usuario_id = ? AND criado_dia = ?`).all(u.id, ontem)
    .filter((a) => !/cancel/i.test(a.status || ''));
  const porVend = new Map();
  const pega = (id) => {
    if (!porVend.has(id)) {
      const n = id ? nomeDe.get(id) : null;
      porVend.set(id, { id, nome: (n && n.nome) || (id ? 'Vendedor ' + String(id).slice(0, 4) : 'Sem vendedor'), conversas: 0, novos: 0, reativacoes: 0, agendamentos: 0, ag_hoje: 0, ag_outros: 0, reativados_ag: 0 });
    }
    return porVend.get(id);
  };
  for (const a of ags) {
    const x = pega(a.vendedor_id);
    x.agendamentos++;
    if (a.data_agendada === hoje) x.ag_hoje++; else x.ag_outros++;
    // Reativado = o cliente já tinha falado com a loja antes desse dia
    let p = a.primeira_msg;
    if (!p && a.conversa_id) { const r = primeiraDaConversa.get(u.id, a.conversa_id); p = r && r.p; }
    if (p && new Date(p) < new Date(ontem + 'T03:00:00Z')) x.reativados_ag++;
  }
  // Leads que cada vendedor pegou ontem (do que já foi sincronizado do Orbitta)
  const m = ob.montar(u.id, ontem, ontem);
  for (const vd of m.vendedores || []) {
    if (!vd.pegos) continue;
    const x = pega(vd.id); x.novos = vd.novos || 0; x.reativacoes = vd.reativacoes || 0;
    if (vd.nome && /^Vendedor /.test(x.nome)) x.nome = vd.nome;
  }
  // Só entra quem está na equipe do Orbitta naquele dia. O Orbitta não diz quem atendeu cada conversa;
  // o painel usa o vendedor do último agendamento do cliente, então um cliente antigo que voltou
  // aparecia no nome de quem já saiu da loja (ex.: vendedor desligado). Esses ficam de fora da lista por vendedor
  // (continuam contando nos totais da loja).
  // "Conversas atendidas" vem pronta do Orbitta por vendedor (é o número exato de quem atendeu no dia)
  let equipe = null;
  try {
    const eq = await ob.equipeAoVivo(u, ontem, ontem);
    if (eq && eq.atual) {
      equipe = new Set(Object.keys(eq.atual.membros || {}));
      for (const [id, mb] of Object.entries(eq.atual.membros || {})) {
        if (!mb.conversas && !mb.agendamentos && !mb.vendas && !porVend.has(id)) continue;
        const x = pega(id); x.conversas = mb.conversas || 0;
        // Números do próprio Orbitta (iguais ao painel dele): agendamentos marcados, vendas e valor vendido no dia
        x.agendamentos_orbitta = mb.agendamentos || 0; x.vendas = mb.vendas || 0; x.valor_vendido = mb.valor_vendido || 0;
        if (mb.nome && /^Vendedor /.test(x.nome)) x.nome = mb.nome;
      }
    }
  } catch (e) { /* sem filtro */ }
  const semVendedor = porVend.has(null) ? porVend.get(null).agendamentos : 0;
  const vendedores = [...porVend.values()].filter((x) => x.id && (!equipe || equipe.has(x.id)))
    .sort((a, b) => b.conversas - a.conversas || (b.agendamentos_orbitta ?? b.agendamentos) - (a.agendamentos_orbitta ?? a.agendamentos));

  const g = (k) => (comparado && comparado[k] ? comparado[k].atual : null);
  return {
    vinculado: true, hoje, ontem,
    leads_novos: g('leads_novos') ?? m.loja.novos,
    leads_recorrentes: g('leads_recorrentes') ?? m.loja.reativacoes,
    agendamentos_hoje: paraHoje,
    vendedores,
    sem_vendedor: semVendedor,
    incompleto: faltaram > 0,
    gerado_em: new Date().toISOString(),
  };
}

// Guarda o resultado 5 minutos por loja/dia
const cache = new Map();
async function analiseLoja(u, hoje) {
  const chave = `${u.id}|${hoje}`;
  const c = cache.get(chave);
  // Dia em andamento (hoje/ontem): guarda só 1 minuto, pra ficar praticamente em tempo real. Dias passados: 30 min.
  const ttl = somaDias(hoje, -1) >= somaDias(hojeBrasilia(), -1) ? 60 * 1000 : 30 * 60 * 1000;
  if (c && Date.now() - c.em < ttl && !c.dados.incompleto) return c.dados;
  const dados = await ob.comLoja(u, () => _analiseLoja(u, hoje));
  cache.set(chave, { em: Date.now(), dados });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return dados;
}

const lojaPorId = (id) => db.prepare('SELECT id, nome, negocio_nome, orbitta_vinculo FROM usuarios WHERE id = ?').get(id);
// "Data de hoje" escolhida no filtro. Pode ir até amanhã (= análise de hoje até agora).
const dataPedida = (q) => {
  const h = hojeBrasilia(), max = somaDias(h, 1);
  if (!dataValida(q.data)) return h;
  return q.data > max ? max : q.data;
};

// /api/orbitta/analise — a própria loja (ou a loja que a pessoa está olhando, pelo X-Loja)
const lojista = express.Router();
lojista.get('/analise', async (req, res) => {
  const u = lojaPorId(req.usuarioId);
  if (!u) return res.status(404).json({ erro: 'Loja não encontrada.' });
  if (!orbitta.configurado()) return res.json({ vinculado: false });
  try { res.json({ loja: { id: u.id, nome: u.negocio_nome || u.nome }, ...(await analiseLoja(u, dataPedida(req.query))) }); }
  catch (e) { res.status(502).json({ erro: 'Não deu pra falar com o Orbitta: ' + e.message }); }
});

// /api/lojas/analise — todas as lojas que a pessoa enxerga (e a própria), uma embaixo da outra
const lojas = express.Router();
lojas.get('/analise', async (req, res) => {
  if (!orbitta.configurado()) return res.json({ lojas: [] });
  const hoje = dataPedida(req.query);
  const ids = [Number(req.usuarioId), ...permissoes.lojasVisiveis(req.usuarioId).map((l) => l.id)];
  const out = [];
  for (const id of [...new Set(ids)]) {
    const u = lojaPorId(id);
    if (!u || !ob.vinculoDe(u)) continue;
    try { out.push({ loja: { id: u.id, nome: u.negocio_nome || u.nome }, ...(await analiseLoja(u, hoje)) }); }
    catch (e) { out.push({ loja: { id: u.id, nome: u.negocio_nome || u.nome }, erro: e.message }); }
  }
  res.json({ hoje, ontem: somaDias(hoje, -1), lojas: out });
});

// Deixa a análise pronta logo cedo (e a cada 30 min) pra não demorar quando alguém abrir
function iniciarAnalise() {
  if (!orbitta.configurado()) return;
  const rodar = async () => {
    const hoje = hojeBrasilia();
    const lista = db.prepare(`SELECT id, nome, negocio_nome, orbitta_vinculo FROM usuarios WHERE orbitta_vinculo IS NOT NULL AND orbitta_vinculo <> ''`).all();
    for (const u of lista) { if (ob.vinculoDe(u)) await analiseLoja(u, hoje).catch((e) => console.error('Análise Orbitta:', e.message)); }
  };
  setTimeout(rodar, 3 * 60 * 1000);
  setInterval(rodar, 30 * 60 * 1000);
}

module.exports = { lojista, lojas, iniciarAnalise };
