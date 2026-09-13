const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/clientes', (req, res) => {
  const clientes = db.prepare(`
    SELECT id, nome, email, negocio_nome, segmento, plano, criado_em
    FROM usuarios
    WHERE is_admin = 0
    ORDER BY criado_em DESC
  `).all();
  res.json({ clientes });
});

router.get('/suporte', (req, res) => {
  const tickets = db.prepare(`
    SELECT s.id, s.assunto, s.mensagem, s.status, s.criado_em,
           u.nome AS cliente_nome, u.email AS cliente_email, u.negocio_nome
    FROM suporte s
    JOIN usuarios u ON u.id = s.usuario_id
    ORDER BY s.criado_em DESC
  `).all();
  res.json({ tickets });
});

router.patch('/suporte/:id', (req, res) => {
  const { status } = req.body || {};
  const validos = ['aberto', 'respondido', 'fechado'];
  if (!validos.includes(status)) {
    return res.status(400).json({ erro: `Status inválido. Use um de: ${validos.join(', ')}.` });
  }
  db.prepare('UPDATE suporte SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ id: Number(req.params.id), status });
});

module.exports = router;
