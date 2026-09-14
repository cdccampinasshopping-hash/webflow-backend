const jwt = require('jsonwebtoken');
const db = require('../db');

function exigirLogin(req, res, next) {
  const cabecalho = req.headers.authorization || '';
  const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;

  if (!token) {
    return res.status(401).json({ erro: 'Você precisa estar logado.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.usuarioId = payload.usuarioId;
    next();
  } catch (e) {
    return res.status(401).json({ erro: 'Sessão inválida ou expirada. Faça login novamente.' });
  }
}

function exigirAdmin(req, res, next) {
  const usuario = db.prepare('SELECT is_admin FROM usuarios WHERE id = ?').get(req.usuarioId);
  if (!usuario || !usuario.is_admin) {
    return res.status(403).json({ erro: 'Essa conta não tem acesso administrativo.' });
  }
  next();
}

function exigirComercial(req, res, next) {
  const usuario = db.prepare('SELECT is_comercial FROM usuarios WHERE id =
