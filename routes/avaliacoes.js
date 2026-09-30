const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { exigirLogin } = require('../middleware/auth');
const { buscarGoogle } = require('../google');
const { lojaPorCodigo } = require('../placas');

// Pra onde mandar o cliente no Google depois da tela rápida da placa
function destinoGoogle(loja) {
  if (loja.google_place_id) return `https://search.google.com/local/writereview?placeid=${loja.google_place_id}`;
  if (loja.link_google) return loja.link_google;
  return null;
}

// Placa indo direto pro Google (sem a tela rápida da loja)
// Padrão: placa vai direto pro Google. PLACA_DIRETO_GOOGLE=0 volta a mostrar a tela da loja antes.
const modoDireto = () => process.env.PLACA_DIRETO_GOOGLE !== '0';

function resumo(usuarioId) {
  const r = db.prepare(`
    SELECT COUNT(*) AS total, ROUND(AVG(nota), 1) AS media,
           SUM(CASE WHEN criado_em >= datetime('now', 'start of month') THEN 1 ELSE 0 END) AS este_mes
    FROM avaliacoes WHERE usuario_id = ?
  `).get(usuarioId);
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  db.prepare('SELECT nota, COUNT(*) AS n FROM avaliacoes WHERE usuario_id = ? GROUP BY nota').all(usuarioId)
    .forEach((l) => { dist[l.nota] = l.n; });
  return { total: r.total || 0, media: r.media || null, esteMes: r.este_mes || 0, distribuicao: dist };
}

/* ------------------------- ROTAS PÚBLICAS ------------------------- */
const publico = express.Router();

// Dados mínimos pra tela de avaliação da placa
publico.get('/loja/:codigo', (req, res) => {
  const loja = lojaPorCodigo(req.params.codigo, 'negocio_nome, nome, google_place_id, link_google');
  if (!loja) return res.status(404).json({ erro: 'Loja não encontrada.' });
  res.json({ negocio: loja.negocio_nome || loja.nome, destinoGoogle: destinoGoogle(loja), direto: modoDireto() });
});

// Cliente final registra a avaliação (antes de seguir pro Google)
publico.post('/loja/:codigo/avaliacoes', (req, res) => {
  const loja = lojaPorCodigo(req.params.codigo, 'id, google_place_id, link_google');
  if (!loja) return res.status(404).json({ erro: 'Loja não encontrada.' });

  const { nota, comentario, nome } = req.body || {};
  const n = parseInt(nota, 10);
  if (!(n >= 1 && n <= 5)) return res.status(400).json({ erro: 'Escolha de 1 a 5 estrelas.' });
  const texto = String(comentario || '').trim().slice(0, 600);
  const quem = String(nome || '').trim().slice(0, 60);

  // Evita o mesmo aparelho mandar várias seguidas pra mesma loja (10 minutos).
  // Usa um identificador do aparelho (gerado no navegador) junto com o IP: assim clientes
  // diferentes no mesmo Wi-Fi da loja não se bloqueiam.
  const aparelho = String((req.body || {}).dispositivo || '').slice(0, 64);
  const ipHash = crypto.createHash('sha256').update(`${req.ip}|${aparelho}|${loja.id}|${process.env.JWT_SECRET}`).digest('hex').slice(0, 32);
  const recente = db.prepare(`SELECT id FROM avaliacoes WHERE usuario_id = ? AND ip_hash = ? AND criado_em >= datetime('now', '-10 minutes')`).get(loja.id, ipHash);
  if (recente) {
    return res.json({ ok: true, repetida: true, destinoGoogle: destinoGoogle(loja) });
  }

  // Por padrão entram no portfólio público as de 4 e 5 estrelas; o lojista pode mudar uma a uma
  db.prepare('INSERT INTO avaliacoes (usuario_id, nota, comentario, nome, visivel, ip_hash) VALUES (?, ?, ?, ?, ?, ?)')
    .run(loja.id, n, texto || null, quem || null, n >= 4 ? 1 : 0, ipHash);

  res.status(201).json({ ok: true, destinoGoogle: destinoGoogle(loja) });
});

// Portfólio público da loja
publico.get('/portfolio/:codigo', async (req, res) => {
  const loja = lojaPorCodigo(req.params.codigo, 'id, negocio_nome, nome, segmento, google_place_id, link_google');
  if (!loja) return res.status(404).json({ erro: 'Loja não encontrada.' });

  const avaliacoes = db.prepare(`
    SELECT nota, comentario, nome, criado_em FROM avaliacoes
    WHERE usuario_id = ? AND visivel = 1
    ORDER BY criado_em DESC LIMIT 60
  `).all(loja.id);

  res.json({
    negocio: loja.negocio_nome || loja.nome,
    segmento: loja.segmento,
    resumo: resumo(loja.id),
    avaliacoes,
    google: await buscarGoogle(loja.google_place_id),
    destinoGoogle: destinoGoogle(loja),
    direto: modoDireto(),
  });
});

/* ------------------------- ROTAS DO LOJISTA ------------------------- */
const lojista = express.Router();
lojista.use(exigirLogin);

// Mural completo de avaliações do lojista logado
lojista.get('/', async (req, res) => {
  const u = db.prepare('SELECT id, codigo_nfc, nfc_scans, google_place_id, link_google FROM usuarios WHERE id = ?').get(req.usuarioId);
  if (!u) return res.status(404).json({ erro: 'Conta não encontrada.' });

  const avaliacoes = db.prepare(`
    SELECT id, nota, comentario, nome, visivel, criado_em FROM avaliacoes
    WHERE usuario_id = ? ORDER BY criado_em DESC LIMIT 500
  `).all(u.id);

  res.json({
    codigo: u.codigo_nfc,
    scans: u.nfc_scans || 0,
    googleLigado: !!(u.google_place_id || u.link_google),
    direto: modoDireto(),
    resumo: resumo(u.id),
    avaliacoes,
    google: await buscarGoogle(u.google_place_id),
  });
});

// Mostrar/esconder uma avaliação no portfólio público
lojista.patch('/:id', (req, res) => {
  const visivel = (req.body || {}).visivel ? 1 : 0;
  const r = db.prepare('UPDATE avaliacoes SET visivel = ? WHERE id = ? AND usuario_id = ?').run(visivel, req.params.id, req.usuarioId);
  if (!r.changes) return res.status(404).json({ erro: 'Avaliação não encontrada.' });
  res.json({ ok: true, visivel });
});

module.exports = { publico, lojista };
