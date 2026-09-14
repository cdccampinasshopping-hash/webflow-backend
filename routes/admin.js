const express = require('express');
const db = require('../db');
const { exigirLogin, exigirAdmin } = require('../middleware/auth');

const router = express.Router();

// A partir daqui, toda rota deste arquivo exige estar logado E ser admin
router.use(exigirLogin, exigirAdmin);

router.get('/clientes', (req, res) => {
  const clientes = db.prepare(`
    SELECT id, nome, email, negocio_nome, segmento, plano, is_comercial, criado_em
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

// Marca ou desmarca um usuário como parte do time comercial
router.patch('/clientes/:id/comercial', (req, res) => {
  const { id } = req.params;
  const { is_comercial } = req.body || {};

  const usuario = db.prepare('SELECT id FROM usuarios WHERE id = ?').get(id);
  if (!usuario) {
    return res.status(404).json({ erro: 'Usuário não encontrado.' });
  }

  db.prepare('UPDATE usuarios SET is_comercial = ? WHERE id = ?').run(is_comercial ? 1 : 0, id);

  const atualizado = db.prepare('SELECT id, nome, email, is_comercial FROM usuarios WHERE id = ?').get(id);
  res.json({ usuario: atualizado });
});

// Apaga um cliente e todos os dados ligados a ele
router.delete('/clientes/:id', (req, res) => {
  const { id } = req.params;

  const usuario = db.prepare('SELECT id, is_admin FROM usuarios WHERE id = ?').get(id);
  if (!usuario) {
    return res.status(404).json({ erro: 'Usuário não encontrado.' });
  }
  if (usuario.is_admin) {
    return res.status(403).json({ erro: 'Não é possível excluir uma conta administrativa.' });
  }

  const apagar = db.transaction((usuarioId) => {
    db.prepare('DELETE FROM dados WHERE usuario_id = ?').run(usuarioId);
    db.prepare('DELETE FROM suporte WHERE usuario_id = ?').run(usuarioId);
    db.prepare('DELETE FROM vendas WHERE usuario_id = ? OR vendedor_id = ?').run(usuarioId, usuarioId);
    db.prepare('DELETE FROM usuarios WHERE id = ?').run(usuarioId);
  });
  apagar(id);

  res.json({ ok: true, id: Number(id) });
});

module.exports = router;
