const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const { exigirLogin, registrarAcesso } = require('../middleware/auth');
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

// Gera um código curto e único pra identificar a placa NFC do cliente
// (usado na URL webflowservices.com/r/CODIGO gravada na placa física)
function gerarCodigoNfc() {
  return crypto.randomBytes(4).toString('hex');
}

router.post('/registrar', (req, res) => {
  const { nome, email, senha, negocio_nome, segmento, plano, aceite } = req.body || {};

  if (!nome || !email || !senha) {
    return res.status(400).json({ erro: 'Nome, e-mail e senha são obrigatórios.' });
  }
  if (aceite !== true) {
    return res.status(400).json({ erro: 'Para criar a conta, aceite os Termos de Uso e a Política de Privacidade.' });
  }
  if (senha.length < 6) {
    return res.status(400).json({ erro: 'A senha precisa ter pelo menos 6 caracteres.' });
  }

  // Quem se cadastra pelo site só recebe o plano depois que o pagamento é aprovado no Mercado Pago.
  // Até lá a conta fica "pendente" (vê só a tela de Planos pra pagar).
  const planoDesejado = PLANOS_VALIDOS.includes(plano) ? plano : 'basico';
  const senha_hash = bcrypt.hashSync(senha, 10);
  const isAdmin = ehEmailAdmin(email) ? 1 : 0;
  const planoEscolhido = isAdmin ? 'premium' : 'pendente';

  try {
    const resultado = db.prepare(`
      INSERT INTO usuarios (nome, email, senha_hash, negocio_nome, segmento, plano, plano_desejado, is_admin, aceite_termos_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(nome, email.toLowerCase().trim(), senha_hash, negocio_nome || null, (['restaurante','bar','comercio','barbearia','salao','clinica','servicos'].includes(segmento) ? segmento : 'restaurante'), planoEscolhido, planoDesejado, isAdmin, new Date().toISOString());

    // Gera o código único da placa NFC pro cliente recém-criado
    const codigoNfc = gerarCodigoNfc();
    db.prepare('UPDATE usuarios SET codigo_nfc = ? WHERE id = ?').run(codigoNfc, resultado.lastInsertRowid);

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

  db.prepare("UPDATE usuarios SET ultimo_acesso = datetime('now') WHERE id = ?").run(usuario.id);
  const token = gerarToken(usuario.id);
  res.json({ token, usuario: paraJson(usuario) });
});

// ---------------- Face ID / digital (passkeys) ----------------
const passkey = require('../lib/passkey');
const RP_NOME = 'Flow Solution';

function tokenDesafio(dados) { return jwt.sign({ ...dados, pk: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' }); }
function lerDesafio(token, tipo) {
  try {
    const d = jwt.verify(String(token || ''), process.env.JWT_SECRET);
    if (d.pk === 1 && d.tipo === tipo) return d;
  } catch (e) { /* expirado ou inválido */ }
  return null;
}
function nomeAparelho(ua) {
  ua = String(ua || '');
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) { const m = ua.match(/Android[^;]*;\s*([^;)]+?)(?:\sBuild|\))/); return m ? m[1].trim().slice(0, 40) : 'Android'; }
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Aparelho';
}

// 1) Cadastro: pede as opções pro navegador criar a chave (precisa estar logado)
router.post('/passkey/cadastro/opcoes', exigirLogin, (req, res) => {
  const rpId = String((req.body || {}).rpId || '').toLowerCase();
  if (!passkey.rpIdValido(rpId)) return res.status(400).json({ erro: 'Domínio inválido.' });
  const u = db.prepare('SELECT id, nome, email FROM usuarios WHERE id = ?').get(req.usuarioId);
  if (!u) return res.status(404).json({ erro: 'Usuário não encontrado.' });
  const desafio = passkey.novoDesafio();
  const existentes = db.prepare('SELECT credential_id FROM passkeys WHERE usuario_id = ? AND rp_id = ?').all(u.id, rpId);
  res.json({
    token: tokenDesafio({ tipo: 'cadastro', d: desafio, rp: rpId, uid: u.id }),
    publicKey: {
      challenge: desafio,
      rp: { name: RP_NOME, id: rpId },
      user: { id: passkey.b64url(Buffer.from('fs-' + u.id)), name: u.email, displayName: u.nome || u.email },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'required', requireResidentKey: true },
      excludeCredentials: existentes.map((e) => ({ type: 'public-key', id: e.credential_id })),
      attestation: 'none',
      timeout: 120000,
    },
  });
});

// 2) Cadastro: confere e guarda a chave pública
router.post('/passkey/cadastro', exigirLogin, (req, res) => {
  const b = req.body || {};
  const d = lerDesafio(b.token, 'cadastro');
  if (!d || d.uid !== req.usuarioId) return res.status(400).json({ erro: 'O tempo acabou. Tente de novo.' });
  try {
    const r = passkey.verificarCadastro({ credencial: b.credencial, desafio: d.d, rpId: d.rp });
    db.prepare('INSERT INTO passkeys (usuario_id, credential_id, chave_publica, alg, contador, rp_id, aparelho) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.usuarioId, r.credId, JSON.stringify(r.jwk), r.alg, r.contador, d.rp, nomeAparelho(req.get('user-agent')));
    res.json({ ok: true });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ erro: 'Esse aparelho já está cadastrado.' });
    res.status(400).json({ erro: e.message || 'Não foi possível cadastrar.' });
  }
});

// 3) Login: pede o desafio (não precisa estar logado)
router.post('/passkey/login/opcoes', (req, res) => {
  const rpId = String((req.body || {}).rpId || '').toLowerCase();
  if (!passkey.rpIdValido(rpId)) return res.status(400).json({ erro: 'Domínio inválido.' });
  const desafio = passkey.novoDesafio();
  res.json({
    token: tokenDesafio({ tipo: 'login', d: desafio, rp: rpId }),
    publicKey: { challenge: desafio, rpId, userVerification: 'required', allowCredentials: [], timeout: 120000 },
  });
});

// 4) Login: confere a assinatura do aparelho e devolve a sessão
router.post('/passkey/login', (req, res) => {
  const b = req.body || {};
  const d = lerDesafio(b.token, 'login');
  if (!d) return res.status(400).json({ erro: 'O tempo acabou. Tente de novo.' });
  const credId = String((b.credencial || {}).id || '');
  const chave = db.prepare('SELECT * FROM passkeys WHERE credential_id = ?').get(credId);
  if (!chave || chave.rp_id !== d.rp) return res.status(401).json({ erro: 'Esse rosto/digital não está cadastrado aqui. Entre com e-mail e senha e cadastre de novo.' });
  try {
    const r = passkey.verificarLogin({ credencial: b.credencial, desafio: d.d, chave });
    db.prepare("UPDATE passkeys SET contador = ?, usado_em = datetime('now') WHERE id = ?").run(r.contador, chave.id);
  } catch (e) {
    return res.status(401).json({ erro: e.message || 'Não foi possível confirmar.' });
  }
  const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(chave.usuario_id);
  if (!usuario) return res.status(401).json({ erro: 'Conta não encontrada.' });
  const deveSerAdmin = ehEmailAdmin(usuario.email) ? 1 : 0;
  if (usuario.is_admin !== deveSerAdmin) {
    db.prepare('UPDATE usuarios SET is_admin = ? WHERE id = ?').run(deveSerAdmin, usuario.id);
    usuario.is_admin = deveSerAdmin;
  }
  db.prepare("UPDATE usuarios SET ultimo_acesso = datetime('now') WHERE id = ?").run(usuario.id);
  res.json({ token: gerarToken(usuario.id), usuario: paraJson(usuario) });
});

// Lista e remove os aparelhos cadastrados da própria conta
router.get('/passkeys', exigirLogin, (req, res) => {
  res.json({ passkeys: db.prepare('SELECT id, aparelho, rp_id, criado_em, usado_em FROM passkeys WHERE usuario_id = ? ORDER BY id DESC').all(req.usuarioId) });
});
router.delete('/passkeys/:id', exigirLogin, (req, res) => {
  const r = db.prepare('DELETE FROM passkeys WHERE id = ? AND usuario_id = ?').run(req.params.id, req.usuarioId);
  if (!r.changes) return res.status(404).json({ erro: 'Aparelho não encontrado.' });
  res.json({ ok: true });
});

// Sinal de "estou online" enviado pelo painel de tempos em tempos (o exigirLogin já grava o horário)
router.post('/ping', exigirLogin, (req, res) => res.json({ ok: true }));

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

    const siteUrl = process.env.SITE_URL || 'https://flowsolution.pages.dev';
    const link = `${siteUrl}/webflow.html?redefinir=${tokenBruto}`;

    try {
      await enviarEmail({
        para: usuario.email,
        assunto: 'Redefinir sua senha — Flow Solution',
        html: `
          <p>Oi, ${usuario.nome}!</p>
          <p>Recebemos um pedido pra redefinir a senha da sua conta na Flow Solution.</p>
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
