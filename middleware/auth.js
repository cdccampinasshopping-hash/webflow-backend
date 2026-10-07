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

// Olhar outra loja: o painel manda o cabeçalho X-Loja com o id da loja.
// Só vale pra quem tem um cargo com "Ver outras lojas" que cubra essa loja, e é só leitura
// (dá pra registrar um WhatsApp enviado e pedir "atualizar agora", mais nada).
const ESCRITAS_LIBERADAS = [/^\/envios\/?$/, /^\/atualizar\/?$/];
function verOutraLoja(req, res, next) {
  const pedido = Number(req.headers['x-loja'] || 0);
  if (!pedido || pedido === Number(req.usuarioId)) return next();
  if (!permissoes.lojasVisiveis(req.usuarioId).some((l) => l.id === pedido)) {
    return res.status(403).json({ erro: 'Seu cargo não dá acesso a essa loja.' });
  }
  if (req.method !== 'GET' && !ESCRITAS_LIBERADAS.some((r) => r.test(req.path))) {
    return res.status(403).json({ erro: 'Você está olhando outra loja: aqui é só pra ver. Volte pra sua loja pra lançar ou mudar.' });
  }
  req.quemVe = req.usuarioId;
  req.usuarioId = pedido;
  req.vendoOutraLoja = true;
  next();
}

module.exports = { verOutraLoja, exigirLogin, exigirAdmin, exigirComercial, exigirControle, registrarAcesso };
