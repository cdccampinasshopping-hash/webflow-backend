const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { exigirLogin, exigirComercial } = require('../middleware/auth');

const router = express.Router();

// A partir daqui, toda rota exige estar logado E ser do time comercial
router.use(exigirLogin, exigirComercial);

const PLANOS_VALIDOS = ['basico', 'pro', 'premium'];
const PRECOS = { basico: 80, pro: 200, premium: 300 };

function gerarCodigoNfc() {
  return crypto.randomBytes(4).toString('hex');
}

// Extrai o Place ID de um link do Google Maps colado pelo comercial
function extrairPlaceId(input) {
  if (!input) return null;
  const matchDireto = input.match(/place_id[:=]([A-Za-z0-9_-]+)/);
  if (matchDireto) return matchDireto[1];
  if (/^[A-Za-z0-9_-]{20,}$/.test(input.trim())) return input.trim();
  return null;
}

// Cadastra um cliente novo + registra a venda (pendente se Pix, confirmada se dinheiro/cartão)
router.post('/cadastrar', (req, res) => {
  const {
    nome, email, senha, negocio_nome, segmento, plano,
    linkGoogle, formaPagamento
  } = req.body || {};

  if (!nome || !email || !senha) {
    return res.status(400).json({ erro: 'Nome, e-mail e senha são obrigatórios.' });
  }
  if (senha.length < 6) {
    return res.status(400).json({ erro: 'A senha precisa ter pelo menos 6 caracteres.' });
  }
  if (!['pix', 'dinheiro', 'cartao'].includes(formaPagamento)) {
    return res.status(400).json({ erro: 'Forma de pagamento inválida. Use pix, dinheiro ou cartao.' });
  }

  const planoEscolhido = PLANOS_VALIDOS.includes(plano) ? plano : 'basico';
  const senha_hash = bcrypt.hashSync(senha, 10);
  const placeId = extrairPlaceId(linkGoogle);
  const valor = PRECOS[planoEscolhido];

  try {
    const resultado = db.prepare(`
      INSERT INTO usuarios (nome, email, senha_hash, negocio_nome, segmento, plano, google_place_id, codigo_nfc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nome, email.toLowerCase().trim(), senha_hash, negocio_nome || null,
      segmento || 'restaurante', planoEscolhido, placeId, gerarCodigoNfc()
    );

    const clienteId = resultado.lastInsertRowid;

    // Pix fica pendente até o webhook confirmar; dinheiro/cartão já libera na hora
    const statusVenda = formaPagamento === 'pix' ? 'pendente' : 'confirmado';
    const confirmadoEm = formaPagamento === 'pix' ? null : new Date().toISOString();

    const venda = db.prepare(`
      INSERT INTO vendas (usuario_id, vendedor_id, forma_pagamento, status, valor, confirmado_em)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(clienteId, req.usuarioId, formaPagamento, statusVenda, valor, confirmadoEm);

    res.status(201).json({
      cliente: { id: clienteId, nome, email, plano: planoEscolhido },
      venda: { id: venda.lastInsertRowid, status: statusVenda, formaPagamento, valor },
      placeIdReconhecido: !!placeId,
    });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ erro: 'Já existe uma conta com esse e-mail.' });
    }
    console.error(e);
    res.status(500).json({ erro: 'Erro ao cadastrar o cliente. Tente novamente.' });
  }
});

// Lista as vendas feitas pelo vendedor logado
router.get('/vendas', (req, res) => {
  const vendas = db.prepare(`
    SELECT v.id, v.forma_pagamento, v.status, v.valor, v.criado_em, v.confirmado_em,
           u.nome AS cliente_nome, u.negocio_nome, u.email AS cliente_email
    FROM vendas v
    JOIN usuarios u ON u.id = v.usuario_id
    WHERE v.vendedor_id = ?
    ORDER BY v.criado_em DESC
  `).all(req.usuarioId);

  const totalConfirmado = vendas.filter(v => v.status === 'confirmado').length;
  const totalPendente = vendas.filter(v => v.status === 'pendente').length;

  res.json({ vendas, resumo: { totalConfirmado, totalPendente, total: vendas.length } });
});

// Confirma o recebimento de uma venda em dinheiro/cartão (Pix confirma sozinho via webhook)
router.patch('/vendas/:id/confirmar', (req, res) => {
  const venda = db.prepare('SELECT * FROM vendas WHERE id = ? AND vendedor_id = ?').get(req.params.id, req.usuarioId);

  if (!venda) {
    return res.status(404).json({ erro: 'Venda não encontrada.' });
  }
  if (venda.forma_pagamento === 'pix') {
    return res.status(400).json({ erro: 'Vendas no Pix são confirmadas automaticamente pelo Mercado Pago.' });
  }
  if (venda.status === 'confirmado') {
    return res.status(400).json({ erro: 'Essa venda já está confirmada.' });
  }

  db.prepare(`UPDATE vendas SET status = 'confirmado', confirmado_em = ? WHERE id = ?`)
    .run(new Date().toISOString(), venda.id);

  res.json({ id: venda.id, status: 'confirmado' });
});

module.exports = router;
