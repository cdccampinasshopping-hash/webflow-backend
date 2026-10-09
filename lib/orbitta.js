// Cliente do MCP do Orbitta (só leitura).
// A chave pessoal do Orbitta fica na variável ORBITTA_TOKEN (nunca no código).
// O endereço pode ser trocado por ORBITTA_MCP_URL.
// Também dá pra cadastrar outras chaves pelo painel (uma por conta/rede do Orbitta) e escolher a chave de cada loja.
const URL_PADRAO = 'https://yogsjrinvwrpmmreudla.supabase.co/functions/v1/mcp';
const { AsyncLocalStorage } = require('async_hooks');
const db = require('../db');

db.exec(`CREATE TABLE IF NOT EXISTS orbitta_chaves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  token TEXT NOT NULL,
  organizacao TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
)`);

const contexto = new AsyncLocalStorage();
const sessoes = new Map(); // token -> { sessao, iniciado }
let proximoId = 1;

function tokenPrincipal() { return String(process.env.ORBITTA_TOKEN || '').trim(); }
function tokenAtual() { const c = contexto.getStore(); return (c && c.token) || tokenPrincipal(); }
function sessaoDe(token) { if (!sessoes.has(token)) sessoes.set(token, { sessao: null, iniciado: false }); return sessoes.get(token); }
function temChavesExtras() { try { return !!db.prepare('SELECT 1 FROM orbitta_chaves LIMIT 1').get(); } catch (e) { return false; } }
function configurado() { return !!tokenPrincipal() || temChavesExtras(); }
// Roda fn usando a chave indicada em todas as chamadas ao Orbitta lá dentro
// extra: { loja, chave } só pra saber de quem é cada pedido no painel "Saúde do Orbitta"
function comChave(token, fn, extra) {
  const atual = contexto.getStore() || {};
  if (!token && !extra) return fn();
  return contexto.run({ ...atual, ...(token ? { token } : {}), ...(extra || {}) }, fn);
}

/* ---------- Saúde da conexão (painel do admin) ----------
   Guarda cada pedido feito ao Orbitta na última hora (só na memória): quando, ferramenta, loja, chave,
   quanto tempo levou e se deu erro. Serve pra ver se o volume está pesando pro Orbitta. */
const pedidos = [];
const UMA_HORA = 60 * 60 * 1000;
function registrarPedido(p) {
  pedidos.push(p);
  const corte = Date.now() - UMA_HORA;
  while (pedidos.length && (pedidos[0].t < corte || pedidos.length > 60000)) pedidos.shift();
}
function tipoErro(msg) {
  const m = String(msg || '');
  if (/\b429\b/.test(m)) return 'limite';          // Orbitta pediu pra ir mais devagar
  if (/\b5\d\d\b/.test(m) || /não respondeu/i.test(m)) return 'servidor';
  if (/abort|timeout|tempo/i.test(m)) return 'demora';
  if (/recusou a chave|\b40[13]\b/.test(m)) return 'chave';
  return 'outro';
}
// Servidor travado (conta pesada no banco segura tudo): mede a cada 1 s quanto o relógio atrasou
const atrasos = [];
let esperado = Date.now() + 1000;
setInterval(() => {
  const agora = Date.now();
  atrasos.push({ t: agora, ms: Math.max(0, agora - esperado) });
  esperado = agora + 1000;
  while (atrasos.length && atrasos[0].t < agora - 5 * 60000) atrasos.shift();
}, 1000).unref();
function servidor() {
  const ms = atrasos.map((a) => a.ms);
  const n = ms.length;
  return { atraso_medio_ms: n ? Math.round(ms.reduce((a, b) => a + b, 0) / n) : 0, atraso_max_ms: n ? Math.max(...ms) : 0,
    travadas: ms.filter((x) => x > 1000).length };
}
function saude() {
  const agora = Date.now();
  const janela = (ms) => pedidos.filter((p) => p.t >= agora - ms);
  const resumo = (lista, minutos) => {
    const n = lista.length, erros = lista.filter((p) => !p.ok);
    const ms = lista.map((p) => p.ms).sort((a, b) => a - b);
    const ult = erros[erros.length - 1];
    return {
      pedidos: n, por_minuto: minutos ? Math.round(n / minutos * 10) / 10 : n,
      erros: erros.length, taxa_erro: n ? Math.round(erros.length / n * 1000) / 10 : 0,
      limite: erros.filter((p) => p.tipo === 'limite').length, demora: erros.filter((p) => p.tipo === 'demora').length,
      servidor: erros.filter((p) => p.tipo === 'servidor').length,
      ms_medio: n ? Math.round(ms.reduce((a, b) => a + b, 0) / n) : null, ms_p95: n ? ms[Math.min(n - 1, Math.floor(n * 0.95))] : null,
      ultimo_erro: ult ? { em: new Date(ult.t).toISOString(), ferramenta: ult.f, loja: ult.loja || null, chave: ult.chave || null, msg: ult.erro, tipo: ult.tipo } : null,
    };
  };
  const agrupar = (lista, campo, minutos) => {
    const g = new Map();
    for (const p of lista) { const k = p[campo] == null ? '' : String(p[campo]); if (!g.has(k)) g.set(k, []); g.get(k).push(p); }
    return [...g.entries()].map(([k, l]) => ({ chave: k, ...resumo(l, minutos) })).sort((a, b) => b.pedidos - a.pedidos);
  };
  const h1 = janela(UMA_HORA), m5 = janela(5 * 60000), m1 = janela(60000);
  // Por minuto na última hora (pro gráfico)
  const serie = [];
  for (let i = 59; i >= 0; i--) {
    const ini = agora - (i + 1) * 60000, fim = agora - i * 60000;
    const l = h1.filter((p) => p.t >= ini && p.t < fim);
    serie.push({ em: new Date(fim).toISOString(), pedidos: l.length, erros: l.filter((p) => !p.ok).length });
  }
  const r5 = resumo(m5, 5);
  // Selo: vermelho = Orbitta pedindo pra ir devagar, muito erro ou muito lento; amarelo = sinais de peso
  let selo = 'verde', motivo = 'Tudo normal';
  if (!m5.length) { selo = 'cinza'; motivo = 'Nenhum pedido nos últimos 5 minutos'; }
  else if (r5.limite > 0) { selo = 'vermelho'; motivo = `O Orbitta pediu pra ir mais devagar (erro 429) ${r5.limite}x nos últimos 5 min`; }
  else if (m5.length >= 10 && r5.taxa_erro >= 20) { selo = 'vermelho'; motivo = `${r5.taxa_erro}% dos pedidos deram erro nos últimos 5 min`; }
  else if (r5.ms_medio > 15000) { selo = 'vermelho'; motivo = `Respostas muito lentas: ${(r5.ms_medio / 1000).toFixed(1)} s em média`; }
  else if (r5.taxa_erro >= 5 && r5.erros >= 2) { selo = 'amarelo'; motivo = `${r5.taxa_erro}% dos pedidos deram erro nos últimos 5 min`; }
  else if (r5.ms_medio > 5000 || r5.ms_p95 > 15000) { selo = 'amarelo'; motivo = `Respostas mais lentas que o normal: ${(r5.ms_medio / 1000).toFixed(1)} s em média`; }
  else if (r5.demora > 0) { selo = 'amarelo'; motivo = `${r5.demora} pedido(s) passaram do tempo nos últimos 5 min`; }
  const sv = servidor();
  if (sv.travadas >= 3 && selo !== 'vermelho') { selo = sv.atraso_max_ms > 5000 ? 'vermelho' : 'amarelo'; motivo = `O próprio servidor da Flow travou ${sv.travadas}x nos últimos 5 min (até ${(sv.atraso_max_ms / 1000).toFixed(1)} s)`; }
  return {
    servidor: sv,
    selo, motivo, gerado_em: new Date().toISOString(),
    ultimo_minuto: resumo(m1, 1), ultimos_5min: r5, ultima_hora: resumo(h1, 60),
    por_loja: agrupar(h1, 'loja', 60), por_chave: agrupar(h1, 'chave', 60), por_ferramenta: agrupar(h1, 'f', 60),
    por_loja_5min: agrupar(m5, 'loja', 5), serie,
  };
}
function tokenDaChave(id) { if (!id) return null; const c = db.prepare('SELECT token FROM orbitta_chaves WHERE id = ?').get(id); return c ? c.token : null; }

// Lê a resposta: JSON puro ou stream SSE ("data: {...}")
async function lerResposta(r, id) {
  const tipo = String(r.headers.get('content-type') || '');
  const texto = await r.text();
  if (!texto.trim()) return null;
  if (tipo.includes('text/event-stream')) {
    const msgs = texto.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
    for (const m of msgs) {
      try { const j = JSON.parse(m); if (j.id === id || (j.result || j.error)) return j; } catch (e) { /* ignora */ }
    }
    return null;
  }
  try { return JSON.parse(texto); } catch (e) { throw new Error('Resposta inválida do Orbitta: ' + texto.slice(0, 160)); }
}

async function enviar(metodo, params, notificacao) {
  const token = tokenAtual();
  if (!token) throw new Error('Integração com o Orbitta não configurada (falta a chave do Orbitta).');
  const ss = sessaoDe(token);
  const id = notificacao ? undefined : proximoId++;
  const corpo = { jsonrpc: '2.0', method: metodo, ...(params ? { params } : {}), ...(notificacao ? {} : { id }) };
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: 'Bearer ' + token,
    'MCP-Protocol-Version': '2025-06-18',
  };
  if (ss.sessao) headers['Mcp-Session-Id'] = ss.sessao;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  let r;
  try {
    r = await fetch(process.env.ORBITTA_MCP_URL || URL_PADRAO, { method: 'POST', headers, body: JSON.stringify(corpo), signal: ctrl.signal });
  } finally { clearTimeout(t); }
  const s = r.headers.get('mcp-session-id'); if (s) ss.sessao = s;
  if (r.status === 401 || r.status === 403) throw new Error('O Orbitta recusou a chave. Gere uma chave pessoal nova no Orbitta.');
  if (r.status === 404 && ss.sessao) { ss.sessao = null; ss.iniciado = false; throw Object.assign(new Error('Sessão do Orbitta expirou'), { reiniciar: true }); }
  if (notificacao) return null;
  if (!r.ok) throw new Error(`Orbitta respondeu ${r.status}`);

  const j = await lerResposta(r, id);
  if (!j) throw new Error('Orbitta não respondeu.');
  if (j.error) throw new Error('Orbitta: ' + (j.error.message || JSON.stringify(j.error)));
  return j.result;
}

// Várias chamadas ao mesmo tempo esperam a mesma abertura de sessão (não abre uma por chamada)
async function iniciar() {
  const ss = sessaoDe(tokenAtual());
  if (ss.iniciado) return;
  if (!ss.abrindo) {
    ss.abrindo = (async () => {
      await enviar('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'flow-solution', version: '1.0' } });
      try { await enviar('notifications/initialized', null, true); } catch (e) { /* alguns servidores não precisam */ }
      ss.iniciado = true;
    })().finally(() => { ss.abrindo = null; });
  }
  await ss.abrindo;
}

// Chama uma ferramenta do Orbitta e devolve o JSON que ela retorna
async function chamar(ferramenta, args = {}, tentativa = 0) {
  if (tentativa > 0) return _chamar(ferramenta, args, tentativa);
  const t0 = Date.now(), ctx = contexto.getStore() || {};
  const base = { t: t0, f: ferramenta, loja: ctx.loja ?? null, chave: ctx.chave ?? (ctx.token && ctx.token !== tokenPrincipal() ? 'outra' : 'principal') };
  try {
    const r = await _chamar(ferramenta, args, 0);
    registrarPedido({ ...base, ms: Date.now() - t0, ok: true });
    return r;
  } catch (e) {
    registrarPedido({ ...base, ms: Date.now() - t0, ok: false, erro: String(e.message || e).slice(0, 240), tipo: tipoErro(e.message) });
    throw e;
  }
}
async function _chamar(ferramenta, args = {}, tentativa = 0) {
  try {
    await iniciar();
    const res = await enviar('tools/call', { name: ferramenta, arguments: args });
    if (res && res.isError) {
      const msg = (res.content || []).map((c) => c.text).join(' ').slice(0, 300);
      throw new Error('Orbitta (' + ferramenta + '): ' + msg);
    }
    if (res && res.structuredContent) return res.structuredContent;
    const txt = ((res && res.content) || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    try { return JSON.parse(txt); } catch (e) { return { texto: txt }; }
  } catch (e) {
    if (e.reiniciar && tentativa < 1) return _chamar(ferramenta, args, tentativa + 1);
    throw e;
  }
}

function reiniciarSessao() { sessoes.clear(); }

// Ferramentas que a chave atual enxerga no Orbitta (guardado 1 hora). Serve pra usar uma ferramenta nova
// assim que o Orbitta liberar (ex.: ranking da Missão do dia), sem precisar mexer no sistema.
const _ferramentas = new Map();
async function ferramentas() {
  const token = tokenAtual();
  const c = _ferramentas.get(token);
  if (c && Date.now() - c.em < 60 * 60 * 1000) return c.lista;
  await iniciar();
  const r = await enviar('tools/list', {});
  const lista = ((r && r.tools) || []).map((t) => ({ nome: t.name, descricao: t.description || '', parametros: Object.keys((t.inputSchema && t.inputSchema.properties) || {}) }));
  _ferramentas.set(token, { em: Date.now(), lista });
  return lista;
}

module.exports = { chamar, configurado, reiniciarSessao, comChave, tokenDaChave, tokenPrincipal, ferramentas, saude };
