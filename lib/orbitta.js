// Cliente do MCP do Orbitta (só leitura).
// A chave pessoal do Orbitta fica na variável ORBITTA_TOKEN (nunca no código).
// O endereço pode ser trocado por ORBITTA_MCP_URL.
const URL_PADRAO = 'https://yogsjrinvwrpmmreudla.supabase.co/functions/v1/mcp';

let sessao = null;   // Mcp-Session-Id devolvido no initialize (se o servidor usar)
let iniciado = false;
let proximoId = 1;

function configurado() { return !!String(process.env.ORBITTA_TOKEN || '').trim(); }

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
  if (!configurado()) throw new Error('Integração com o Orbitta não configurada (falta ORBITTA_TOKEN).');
  const id = notificacao ? undefined : proximoId++;
  const corpo = { jsonrpc: '2.0', method: metodo, ...(params ? { params } : {}), ...(notificacao ? {} : { id }) };
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: 'Bearer ' + String(process.env.ORBITTA_TOKEN).trim(),
    'MCP-Protocol-Version': '2025-06-18',
  };
  if (sessao) headers['Mcp-Session-Id'] = sessao;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  let r;
  try {
    r = await fetch(process.env.ORBITTA_MCP_URL || URL_PADRAO, { method: 'POST', headers, body: JSON.stringify(corpo), signal: ctrl.signal });
  } finally { clearTimeout(t); }
  const s = r.headers.get('mcp-session-id'); if (s) sessao = s;
  if (r.status === 401 || r.status === 403) throw new Error('O Orbitta recusou a chave (ORBITTA_TOKEN). Gere uma chave pessoal nova no Orbitta.');
  if (r.status === 404 && sessao) { sessao = null; iniciado = false; throw Object.assign(new Error('Sessão do Orbitta expirou'), { reiniciar: true }); }
  if (notificacao) return null;
  if (!r.ok) throw new Error(`Orbitta respondeu ${r.status}`);
  const j = await lerResposta(r, id);
  if (!j) throw new Error('Orbitta não respondeu.');
  if (j.error) throw new Error('Orbitta: ' + (j.error.message || JSON.stringify(j.error)));
  return j.result;
}

async function iniciar() {
  if (iniciado) return;
  await enviar('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'flow-solution', version: '1.0' } });
  try { await enviar('notifications/initialized', null, true); } catch (e) { /* alguns servidores não precisam */ }
  iniciado = true;
}

// Chama uma ferramenta do Orbitta e devolve o JSON que ela retorna
async function chamar(ferramenta, args = {}, tentativa = 0) {
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
    if (e.reiniciar && tentativa < 1) return chamar(ferramenta, args, tentativa + 1);
    throw e;
  }
}

function reiniciarSessao() { sessao = null; iniciado = false; }

module.exports = { chamar, configurado, reiniciarSessao };
