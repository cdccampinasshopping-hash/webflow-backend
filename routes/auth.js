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
  if (!usuario || !bcrypt.compareSync(senha, usuario.senha_hash)) {
    return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
  }

  const deveSerAdmin = ehEmailAdmin(usuario.email) ? 1 : 0;
  if (usuario.is_admin !== deveSerAdmin) {
    db.prepare('UPDATE usuarios SET is_admin = ? WHERE id = ?').run(deveSerAdmin, usuario.id);
    usuario.is_admin = deveSerAdmin;
  }

  const token = gerarToken(usuario.id);
  res.json({ token, usuario: paraJson(usuario) });
});

router.get('/me', exigirLogin, (req, res) => {
  const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.usuarioId);
  if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado.' });
  res.json({ usuario: paraJson(usuario) });
});

router.patch('/plano', exigirLogin, (req, res) => {
  const { plano } = req.body || {};
  if (!PLANOS_VALIDOS.includes(plano)) {
    return res.status(400).json({ erro: `Plano inválido. Use um de: ${PLANOS_VALIDOS.join(', ')}.` });
  }

  const usuario = db.prepare('SELECT plano FROM usuarios WHERE id = ?').get(req.usuarioId);
  const indiceAtual = ORDEM_PLANOS.indexOf(usuario.plano);
  const indiceNovo = ORDEM_PLANOS.indexOf(plano);

  if (indiceNovo > indiceAtual) {
    return res.status(403).json({ erro: 'Para fazer upgrade de plano, use o pagamento em Planos.' });
  }

  db.prepare('UPDATE usuarios SET plano = ? WHERE id = ?').run(plano, req.usuarioId);
  const usuarioAtualizado = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.usuarioId);
  res.json({ usuario: paraJson(usuarioAtualizado) });
});

router.post('/esqueci-senha', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ erro: 'Informe seu e-mail.' });

  const usuario = db.prepare('SELECT id, email, nome FROM usuarios WHERE email = ?').get(email.toLowerCase().trim());

  if (usuario) {
    const tokenBruto = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(tokenBruto).digest('hex');
    const expira = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    db.prepare('UPDATE usuarios SET reset_token_hash = ?, reset_token_expira = ? WHERE id = ?')
      .run(tokenHash, expira, usuario.id);

    const siteUrl = process.env.SITE_URL || 'https://webflowservices.com';
    const link = `${siteUrl}/webflow.html?redefinir=${tokenBruto}`;

    try {
      await enviarEmail({
        para: usuario.email,
        assunto: 'Redefinir sua senha — Webflow',
        html: `
          <p>Oi, ${usuario.nome}!</p>
          <p>Recebemos um pedido pra redefinir a senha da sua conta no Webflow.</p>
          <p><a href="${link}">Clique aqui pra escolher uma nova senha</a></p>
          <p>Esse link vale por 1 hora. Se você não pediu isso, pode ignorar este e-mail.</p>
        `,
      });
    } catch (e) {
      console.error('Erro ao enviar e-mail de recuperação', e);
    }
  }

  res.json({ ok: true });
});

router.post('/redefinir-senha', (req, res) => {
  const { token, novaSenha } = req.body || {};
  if (!token || !novaSenha) {
    return res.status(400).json({ erro: 'Link inválido.' });
  }
  if (novaSenha.length < 6) {
    return res.status(400).json({ erro: 'A senha precisa ter pelo menos 6 caracteres.' });
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const usuario = db.prepare('SELECT id, reset_token_expira FROM usuarios WHERE reset_token_hash = ?').get(tokenHash);

  if (!usuario || !usuario.reset_token_expira || new Date(usuario.reset_token_expira) < new Date()) {
    return res.status(400).json({ erro: 'Esse link expirou ou já foi usado. Peça um novo.' });
  }

  const senha_hash = bcrypt.hashSync(novaSenha, 10);
  db.prepare('UPDATE usuarios SET senha_hash = ?, reset_token_hash = NULL, reset_token_expira = NULL WHERE id = ?')
    .run(senha_hash, usuario.id);

  res.json({ ok: true });
});

module.exports = router;
