// Integração com o Google Agenda do gestor (OAuth do Google + Calendar API).
// A Calendar API é gratuita (não precisa de faturamento no Google Cloud).
//
// Precisa de:
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET → credencial "ID do cliente OAuth" (tipo Aplicativo da Web)
//   BACKEND_URL → endereço deste servidor; o URI de redirecionamento autorizado no Google é
//                 BACKEND_URL + /api/google/callback
//
// O refresh token de cada lojista fica criptografado no banco (AES-256-GCM, chave derivada do JWT_SECRET).

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');

const ESCOPOS = 'openid email https://www.googleapis.com/auth/calendar.events';
const FUSO_NOME = 'America/Sao_Paulo';
const acessos = new Map(); // usuarioId -> { token, expira }

function configurado() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function urlCallback(req) {
  const base = process.env.BACKEND_URL || (req ? `${req.protocol}://${req.get('host')}` : '');
  return `${base}/api/google/callback`;
}

/* ---- criptografia do refresh token ---- */
function chave() {
  return crypto.createHash('sha256').update('gcal:' + process.env.JWT_SECRET).digest();
}
function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chave(), iv);
  const corpo = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), corpo].map((b) => b.toString('base64')).join('.');
}
function decifrar(guardado) {
  try {
    const [iv, tag, corpo] = String(guardado).split('.').map((p) => Buffer.from(p, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', chave(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(corpo), d.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

/* ---- conexão (OAuth) ---- */
function urlConectar(req, usuarioId) {
  const estado = jwt.sign({ g: usuarioId }, process.env.JWT_SECRET, { expiresIn: '15m' });
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: urlCallback(req),
    response_type: 'code',
    scope: ESCOPOS,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: estado,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

// Troca o "code" do callback pelo refresh token e guarda na conta do lojista
async function concluirConexao(req, code, estado) {
  let usuarioId;
  try { usuarioId = jwt.verify(estado, process.env.JWT_SECRET).g; } catch (e) { throw new Error('O link de conexão expirou. Tente de novo pelo painel.'); }

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: urlCallback(req), grant_type: 'authorization_code',
    }),
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok || !dados.refresh_token) {
    console.warn('Google OAuth falhou', dados);
    throw new Error('O Google não autorizou a conexão. Tente de novo e marque a permissão da agenda.');
  }
  let email = null;
  try { email = JSON.parse(Buffer.from(String(dados.id_token).split('.')[1], 'base64url').toString()).email || null; } catch (e) { /* sem e-mail */ }

  db.prepare('UPDATE usuarios SET gcal_token = ?, gcal_email = ? WHERE id = ?').run(cifrar(dados.refresh_token), email, usuarioId);
  acessos.set(usuarioId, { token: dados.access_token, expira: Date.now() + (dados.expires_in - 60) * 1000 });
  return { usuarioId, email };
}

function desconectar(usuarioId) {
  const u = db.prepare('SELECT gcal_token FROM usuarios WHERE id = ?').get(usuarioId);
  const rt = u && u.gcal_token && decifrar(u.gcal_token);
  if (rt) fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(rt)}`, { method: 'POST' }).catch(() => {});
  db.prepare('UPDATE usuarios SET gcal_token = NULL, gcal_email = NULL WHERE id = ?').run(usuarioId);
  acessos.delete(usuarioId);
}

function conectado(usuarioId) {
  const u = db.prepare('SELECT gcal_token, gcal_email FROM usuarios WHERE id = ?').get(usuarioId);
  return u && u.gcal_token ? { email: u.gcal_email } : null;
}

async function tokenDeAcesso(usuarioId) {
  const emCache = acessos.get(usuarioId);
  if (emCache && emCache.expira > Date.now()) return emCache.token;
  const u = db.prepare('SELECT gcal_token FROM usuarios WHERE id = ?').get(usuarioId);
  const rt = u && u.gcal_token && decifrar(u.gcal_token);
  if (!rt || !configurado()) return null;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: rt, grant_type: 'refresh_token' }),
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Acesso revogado pelo gestor (ou app em modo teste com token vencido): desconecta pra ele ligar de novo
    if (dados.error === 'invalid_grant') db.prepare('UPDATE usuarios SET gcal_token = NULL WHERE id = ?').run(usuarioId);
    throw new Error(dados.error === 'invalid_grant' ? 'A conexão com o Google Agenda caiu. Conecte de novo no painel.' : `Google: ${dados.error || r.status}`);
  }
  acessos.set(usuarioId, { token: dados.access_token, expira: Date.now() + (dados.expires_in - 60) * 1000 });
  return dados.access_token;
}

/* ---- eventos ---- */
function somarMinutos(data, hora, min) {
  const [a, m, d] = data.split('-').map(Number);
  const [h, mi] = hora.split(':').map(Number);
  const t = new Date(Date.UTC(a, m - 1, d, h, mi + min));
  return t.toISOString().slice(0, 16);
}

// prof: { nome, email } do barbeiro — entra como convidado e o evento aparece no Google Agenda dele
function corpoEvento(ag, loja, prof) {
  const linhas = [
    `Cliente: ${ag.nome}`,
    `WhatsApp: ${ag.telefone}`,
    ag.profissional ? `Profissional: ${ag.profissional}` : null,
    ag.preco ? `Valor: R$ ${Number(ag.preco).toFixed(2).replace('.', ',')}` : null,
    ag.obs ? `Obs.: ${ag.obs}` : null,
    '',
    `Marcado ${ag.origem === 'painel' ? 'pelo painel' : 'pelo link de agendamento'} da Flow Solution.`,
  ].filter((l) => l !== null);
  return {
    summary: `${ag.servico} · ${ag.nome}${ag.profissional ? ` (${ag.profissional})` : ''}`,
    description: linhas.join('\n'),
    location: loja && loja.endereco ? loja.endereco : undefined,
    start: { dateTime: `${ag.data}T${ag.hora}:00`, timeZone: FUSO_NOME },
    end: { dateTime: `${somarMinutos(ag.data, ag.hora, ag.duracao)}:00`, timeZone: FUSO_NOME },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
    attendees: prof && prof.email ? [{ email: prof.email, displayName: prof.nome }] : [],
    guestsCanModify: false,
    extendedProperties: { private: { flowAgendamento: String(ag.id) } },
  };
}

async function chamar(usuarioId, metodo, caminho, corpo) {
  const token = await tokenDeAcesso(usuarioId);
  if (!token) return null;
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  if (metodo === 'DELETE' && (r.status === 204 || r.status === 404 || r.status === 410)) return {};
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google Agenda: ${(dados.error && dados.error.message) || r.status}`);
  return dados;
}

// Devolve o id do evento criado, ou null se o lojista não conectou o Google
// sendUpdates=all: o Google manda o convite/atualização/cancelamento pro barbeiro convidado
async function criarEvento(ag, loja, prof) {
  const e = await chamar(ag.usuario_id, 'POST', '?sendUpdates=all', corpoEvento(ag, loja, prof));
  return e ? e.id : null;
}
async function atualizarEvento(ag, loja, prof) {
  if (!ag.gcal_event_id) return criarEvento(ag, loja, prof);
  const e = await chamar(ag.usuario_id, 'PATCH', `/${encodeURIComponent(ag.gcal_event_id)}?sendUpdates=all`, corpoEvento(ag, loja, prof));
  return e ? e.id : null;
}
async function apagarEvento(ag) {
  if (!ag.gcal_event_id) return;
  await chamar(ag.usuario_id, 'DELETE', `/${encodeURIComponent(ag.gcal_event_id)}?sendUpdates=all`);
}

module.exports = {
  configurado, urlConectar, concluirConexao, desconectar, conectado,
  criarEvento, atualizarEvento, apagarEvento, somarMinutos,
};
