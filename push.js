// Notificações no celular (Web Push): o painel pede permissão, o celular se inscreve
// e o servidor manda o aviso direto pra tela do aparelho, mesmo com o painel fechado.
//
// Chaves VAPID: use VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY se quiser fixar. Sem elas,
// o servidor gera um par na primeira vez e guarda no banco (precisa do Volume da Railway).
const express = require('express');
const db = require('./db');

let webpush = null;
try { webpush = require('web-push'); } catch (e) { console.log('Push: pacote web-push não instalado, notificações no celular desligadas.'); }

db.exec(`CREATE TABLE IF NOT EXISTS push_inscricoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  chaves TEXT NOT NULL,
  aparelho TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
)`);
db.exec(`CREATE TABLE IF NOT EXISTS config_sistema (chave TEXT PRIMARY KEY, valor TEXT NOT NULL)`);

let chaves = null;
function iniciarChaves() {
  if (chaves || !webpush) return chaves;
  let pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const salvo = db.prepare("SELECT valor FROM config_sistema WHERE chave = 'vapid'").get();
    if (salvo) { try { ({ pub, priv } = JSON.parse(salvo.valor)); } catch (e) { /* gera de novo */ } }
    if (!pub || !priv) {
      const k = webpush.generateVAPIDKeys();
      pub = k.publicKey; priv = k.privateKey;
      db.prepare("INSERT OR REPLACE INTO config_sistema (chave, valor) VALUES ('vapid', ?)").run(JSON.stringify({ pub, priv }));
    }
  }
  webpush.setVapidDetails('mailto:' + (process.env.ADMIN_EMAIL || 'contato@flowsolution.com.br'), pub, priv);
  chaves = { pub, priv };
  return chaves;
}

function disponivel() { return !!(webpush && iniciarChaves()); }

// Manda pra todos os aparelhos das contas indicadas. dados: { titulo, texto, url, tag }
async function enviarPara(usuarioIds, dados) {
  if (!disponivel()) return 0;
  const ids = [...new Set((usuarioIds || []).filter(Boolean))];
  if (!ids.length) return 0;
  const inscricoes = db.prepare(`SELECT id, endpoint, chaves FROM push_inscricoes WHERE usuario_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const corpo = JSON.stringify({ titulo: dados.titulo || 'Flow Solution', texto: dados.texto || '', url: dados.url || '/webflow.html', tag: dados.tag || 'flow' });
  let enviados = 0;
  for (const i of inscricoes) {
    try {
      await webpush.sendNotification({ endpoint: i.endpoint, keys: JSON.parse(i.chaves) }, corpo, { TTL: 3600, urgency: 'high' });
      enviados++;
    } catch (e) {
      // Aparelho desinstalou ou tirou a permissão: apaga a inscrição
      if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_inscricoes WHERE id = ?').run(i.id);
      else console.error('Push não enviou:', e.statusCode || '', e.message);
    }
  }
  return enviados;
}

// ---------------- rotas (logado) ----------------
const rotas = express.Router();
rotas.get('/chave', (req, res) => {
  if (!disponivel()) return res.json({ disponivel: false });
  const n = db.prepare('SELECT COUNT(*) AS n FROM push_inscricoes WHERE usuario_id = ?').get(req.usuarioId).n;
  res.json({ disponivel: true, chave: chaves.pub, aparelhos: n });
});
rotas.post('/inscrever', (req, res) => {
  const s = (req.body || {}).inscricao || {};
  const endpoint = String(s.endpoint || '');
  if (!/^https:\/\//.test(endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth) return res.status(400).json({ erro: 'Inscrição inválida.' });
  db.prepare(`INSERT INTO push_inscricoes (usuario_id, endpoint, chaves, aparelho) VALUES (?, ?, ?, ?)
    ON CONFLICT (endpoint) DO UPDATE SET usuario_id = excluded.usuario_id, chaves = excluded.chaves, aparelho = excluded.aparelho`)
    .run(req.usuarioId, endpoint.slice(0, 1000), JSON.stringify({ p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) }), String((req.body || {}).aparelho || '').slice(0, 120));
  res.status(201).json({ ok: true });
});
rotas.post('/sair', (req, res) => {
  const endpoint = String((req.body || {}).endpoint || '');
  db.prepare('DELETE FROM push_inscricoes WHERE usuario_id = ? AND endpoint = ?').run(req.usuarioId, endpoint);
  res.json({ ok: true });
});
rotas.post('/teste', async (req, res) => {
  const n = await enviarPara([req.usuarioId], { titulo: 'Flow Solution', texto: 'Pronto! Os avisos vão chegar assim no seu celular.', tag: 'teste' });
  if (!n) return res.status(400).json({ erro: 'Nenhum aparelho recebeu. Ative os avisos de novo neste celular.' });
  res.json({ ok: true, aparelhos: n });
});

module.exports = { enviarPara, disponivel, rotas };
