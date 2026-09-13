const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/:chave', (req, res) => {
  const linha = db.prepare(
    'SELECT chave, valor, atualizado_em FROM dados WHERE usuario_id = ? AND chave = ?'
  ).get(req.usuarioId, req.params.chave);

  if (!linha) return res.status(404).json({ erro: 'Nada salvo com essa chave ainda.' });
  res.json(linha);
});

router.put('/:chave', (req, res) => {
  const { valor } = req.body || {};
  if (typeof valor !== 'string') {
    return res.status(400).json({ erro: 'Envie o campo "valor" como string (use JSON.stringify no front-end).' });
  }

  db.prepare(`
    INSERT INTO dados (usuario_id, chave, valor, atualizado_em)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(usuario_id, chave) DO UPDATE SET valor = excluded.valor, atualizado_em = datetime('now')
  `).run(req.usuarioId, req.params.chave, valor);

  res.json({ chave: req.params.chave, valor });
});

router.delete('/:chave', (req, res) => {
  db.prepare('DELETE FROM dados WHERE usuario_id = ? AND chave = ?').run(req.usuarioId, req.params.chave);
  res.json({ chave: req.params.chave, apagado: true });
});

router.get('/', (req, res) => {
  const linhas = db.prepare('SELECT chave, atualizado_em FROM dados WHERE usuario_id = ?').all(req.usuarioId);
  res.json({ chaves: linhas });
});

module.exports = router;
