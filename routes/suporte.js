const express = require('express');
const db = require('../db');

const router = express.Router();

router.post('/', (req, res) => {
  const { assunto, mensagem } = req.body || {};
  if (!assunto || !mensagem) {
    return res.status(400).json({ erro: 'Preencha o assunto e a mensagem.' });
  }
  const resultado = db.prepare(`
    INSERT INTO suporte (usuario_id, assunto, mensagem) VALUES (?, ?, ?)
  `).run(req.usuarioId, assunto, mensagem);
  const ticket = db.prepare('SELECT * FROM suporte WHERE id = ?').get(resultado.lastInsertRowid);
  res.status(201).json({ ticket });
});

router.get('/', (req, res) => {
  const tickets = db.prepare(`
    SELECT id, assunto, mensagem, status, criado_em
    FROM suporte WHERE usuario_id = ? ORDER BY criado_em DESC
  `).all(req.usuarioId);
  res.json({ tickets });
});

module.exports = router;
