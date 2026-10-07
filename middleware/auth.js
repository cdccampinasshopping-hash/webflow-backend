const jwt = require('jsonwebtoken');
const db = require('../db');
const permissoes = require('../lib/permissoes');

// Marca a pessoa como online agora (grava no máximo 1x por minuto pra não pesar o banco)
function registrarAcesso(usuarioId) {
  try {
    db.prepare(`UPDATE usuarios SET ultimo_acesso = datetime('now')
      WHERE id = ? AND (ultimo_acesso IS NULL OR ultimo_acesso < datetime('now', '-60 seconds'))`).run(usuarioId);
  } catch (e) { /* não trava a requisição por causa disso */ }
}

function exigirLogin(req, res, next) {
  const cabecalho = req.headers.authorization || '';
  const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;

  if (!token) {
    return res.status(401).json({ erro: 'Você precisa estar logado.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.usuarioId = payload.usuarioId;
    registrarAcesso(req.usuarioId);
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
  const usuario = db.prepare('SELECT is_comercial FROM usuarios WHERE id = ?').get(req.usuarioId);
  if (!usuario || !usuario.is_comercial) {
    return res.status(403).json({ erro: 'Essa conta não tem acesso à área comercial.' });
  }
  next();
}

// Relatórios do checklist: admin, quem tem o cargo "controle" ou um cargo (tag) com a permissão "relatorios"
function exigirControle(req, res, next) {
  const usuario = db.prepare('SELECT is_admin, cargo FROM usuarios WHERE id = ?').get(req.usuarioId);
  if (!usuario || (!usuario.is_admin && usuario.cargo !== 'controle' && !permissoes.tem(req.usuarioId, 'relatorios'))) {
    return res.status(403).json({ erro: 'Essa conta não tem acesso aos relatórios do checklist.' });
  }
  req.ehAdmin = !!usuario.is_admin;
  next();
}

module.exports = { exigirLogin, exigirAdmin, exigirComercial, exigirControle, registrarAcesso };
