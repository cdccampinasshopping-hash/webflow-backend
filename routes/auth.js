const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const { exigirLogin } = require('../middleware/auth');
const { enviarEmail } = require('../email');

const router = express.Router();

const PLANOS_VALIDOS = ['basico', 'pro', 'premium'];
const ORDEM_PLANOS = ['basico', 'pro', 'premium'];

function ehEmailAdmin(email){
  const admin = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  return !!admin && email.toLowerCase().trim() === admin;
}

function paraJson(usuario) {
  const { senha_hash, reset_token_hash, reset_token_expira, ...resto } = usuario;
  return resto;
}

function gerarToken(usuarioId) {
  return jwt.sign({ usuarioId }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

router.post('/registrar', (req, res) => {
  const { nome, email, senha, negocio_nome, segmento, plano } = req.body || {};

  if (!nome || !email || !senha) {
    return res.status(400).json({ erro: 'Nome, e-mail e senha são obrigatórios.' });
  }
  if (senha.length < 6) {
    return res.status(400).json({ erro: 'A senha precisa ter pelo menos 6 caracteres.' });
  }

  const planoEscolhido = PLANOS_VALIDOS.includes(plano) ? plano : 'basico';
  const senha_hash = bcrypt.hashSync(senha, 10);
  const isAdmin = ehEmailAdmin(email) ? 1 : 0;

  try {
    const resultado = db.prepare(`
      INSERT INTO usuarios (nome, email, senha_hash, negocio_nome, segmento, plano, is_admin)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(nome, email.toLowerCase().trim(), senha_hash, negocio_nome || null, segmento || 'restaurante', planoEscolhido, isAdmin);

    const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(resultado.lastInsertRowid);
    const token = gerarToken(usuario.id);

    res.status(201).json({ token, usuario: paraJson(usuario) });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ erro: 'Já existe uma conta com esse e-mail.' });
    }
    console.error(e);
    res.status(500).json({ erro: 'Erro ao criar a conta. Tente novamente.' });
  }
});

router.post('/login', (req, res) => {
  const { email, senha } = req.body || {};
  if (!email || !senha) {
    return res.status(400).json({ erro: 'Informe e-mail e senha.' });
  }

  const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email.toLowerCase().trim());
  if
