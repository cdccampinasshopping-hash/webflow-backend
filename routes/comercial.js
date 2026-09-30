const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const db = require('../db');
const { buscarPlaca, vincularPlaca, codigosDaLoja } = require('../placas');
const { enviarReciboVenda } = require('../recibo');

// Guarda só os dígitos do WhatsApp; aceita com ou sem 55 na frente
function limparTelefone(t) {
  const d = String(t || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return d;
  return undefined; // inválido
}
const { exigirLogin, exigirComercial } = require('../middleware/auth');

const router = express.Router();
const client = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });

// A partir daqui, toda rota exige estar logado E ser do time comercial
router.use(exigirLogin, exigirComercial);

const COMISSAO_PERCENTUAL = Number(process.env.COMISSAO_PERCENTUAL || 30);

const PLANOS_VALIDOS = ['basico', 'pro', 'premium'];
const PRECOS = { basico: 80, pro: 200, premium: 300 };

function gerarCodigoNfc() {
  return crypto.randomBytes(4).toString('hex');
}

// Lê o que o comercial colou (Place ID, link de avaliação ou link do Maps)
// e devolve { placeId, link }: placeId quando dá pra extrair, senão guarda o link inteiro.
function interpretarLinkGoogle(input) {
  const texto = String(input || '').trim();
  if (!texto) return { placeId: null, link: null };

  // Place ID puro (ex.: ChIJAQAAbxrIyJQRgTH76gTMV6I)
  if (/^[A-Za-z0-9_-]{20,}$/.test(texto)) return { placeId: texto, link: null };

  // placeid=... ou place_id=... / place_id:...
  const matchParam = texto.match(/place_?id[:=]([A-Za-z0-9_-]{20,})/i);
  if (matchParam) return { placeId: matchParam[1], link: null };

  // Place ID solto dentro de qualquer link
  const matchChij = texto.match(/(ChIJ[A-Za-z0-9_-]{15,})/);
  if (matchChij) return { placeId: matchChij[1], link: null };

  // Qualquer outro link (g.page/r/.../review, maps.app.goo.gl, google.com/maps...) é guardado como está
  if (/^https?:\/\//i.test(texto)) return { placeId: null, link: texto };

  return { placeId: null, link: null };
}

function baseUrl(req) {
  return process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
}

// Cadastra um cliente novo + registra a venda (pendente se Pix, confirmada se dinheiro/cartão)
router.post('/cadastrar', async (req, res) => {
  const {
    nome, email, senha, negocio_nome, segmento, plano,
    linkGoogle, formaPagamento, codigoPlaca, telefone
  } = req.body || {};
  const telefoneLimpo = limparTelefone(telefone);
  if (telefoneLimpo === undefined) {
    return res.status(400).json({ erro: 'WhatsApp inválido. Use DDD + número, ex.: (19) 99999-9999.' });
  }

  if (!nome || !email || !senha) {
    return res.status(400).json({ erro: 'Nome, e-mail e senha são obrigatórios.' });
  }
  if (senha.length < 6) {
    return res.status(400).json({ erro: 'A senha precisa ter pelo menos 6 caracteres.' });
  }
  if (!['pix', 'dinheiro', 'cartao'].includes(formaPagamento)) {
    return res.status(400).json({ erro: 'Forma de pagamento inválida. Use pix, dinheiro ou cartao.' });
  }

  // Placa impressa em lote (opcional): confere antes de criar o cliente
  if (codigoPlaca) {
    const placa = buscarPlaca(codigoPlaca);
    if (!placa) return res.status(400).json({ erro: 'Código de placa não encontrado. Confira as letras e números impressos na placa.' });
    if (placa.usuario_id) return res.status(400).json({ erro: 'Essa placa já está ativada em outra loja.' });
  }

  const planoEscolhido = PLANOS_VALIDOS.includes(plano) ? plano : 'basico';
  const senha_hash = bcrypt.hashSync(senha, 10);
  const { placeId, link: linkBruto } = interpretarLinkGoogle(linkGoogle);
  const valor = PRECOS[planoEscolhido];

  try {
    const resultado = db.prepare(`
      INSERT INTO usuarios (nome, email, senha_hash, negocio_nome, segmento, plano, google_place_id, link_google, codigo_nfc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nome, email.toLowerCase().trim(), senha_hash, negocio_nome || null,
      segmento || 'restaurante', planoEscolhido, placeId, linkBruto, gerarCodigoNfc()
    );

    const clienteId = resultado.lastInsertRowid;
    if (telefoneLimpo) db.prepare('UPDATE usuarios SET telefone = ? WHERE id = ?').run(telefoneLimpo, clienteId);
    const placaVinculada = codigoPlaca ? vincularPlaca(codigoPlaca, clienteId) : null;

    // Pix fica pendente até o webhook confirmar; dinheiro/cartão já libera na hora
    const statusVenda = formaPagamento === 'pix' ? 'pendente' : 'confirmado';
    const confirmadoEm = formaPagamento === 'pix' ? null : new Date().toISOString();

    const venda = db.prepare(`
      INSERT INTO vendas (usuario_id, vendedor_id, forma_pagamento, status, valor, confirmado_em)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(clienteId, req.usuarioId, formaPagamento, statusVenda, valor, confirmadoEm);

    const vendaId = venda.lastInsertRowid;
    if (statusVenda === 'confirmado') enviarReciboVenda(vendaId); // sem esperar: o e-mail não segura a tela

    // Se for Pix, gera o pagamento de verdade no Mercado Pago e devolve o QR code
    let pix = null;
    if (formaPagamento === 'pix') {
      try {
        const payment = new Payment(client);
        const notificationUrl = `${process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`}/api/pagamentos/webhook`;

        const resultadoPix = await payment.create({
          body: {
            transaction_amount: valor,
            description: `Webflow — placa NFC (${planoEscolhido})`,
            payment_method_id: 'pix',
            payer: { email: email.toLowerCase().trim() },
            external_reference: `venda|${vendaId}`,
            notification_url: notificationUrl,
          },
        });

        const dadosPix = resultadoPix.point_of_interaction?.transaction_data;
        db.prepare('UPDATE vendas SET mp_payment_id = ? WHERE id = ?').run(String(resultadoPix.id), vendaId);

        pix = {
          qrCodeBase64: dadosPix?.qr_code_base64 || null,
          copiaECola: dadosPix?.qr_code || null,
        };
      } catch (erroPix) {
        console.error('Erro ao gerar Pix', erroPix);
        // O cliente e a venda já foram criados; o Pix pode ser gerado de novo depois se falhar aqui.
      }
    }

    const { codigo_nfc } = db.prepare('SELECT codigo_nfc FROM usuarios WHERE id = ?').get(clienteId);
    const base = baseUrl(req);

    res.status(201).json({
      cliente: { id: clienteId, nome, email, plano: planoEscolhido },
      venda: { id: vendaId, status: statusVenda, formaPagamento, valor },
      placeIdReconhecido: !!placeId,
      linkGoogleSalvo: !!(placeId || linkBruto),
      placa: {
        codigo: codigo_nfc,
        link: `${base}/r/${codigo_nfc}`,
        qrCodeUrl: `${base}/qr/${codigo_nfc}.png`,
      },
      placaLote: placaVinculada && placaVinculada.ok ? placaVinculada.codigo : null,
      pix,
    });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ erro: 'Já existe uma conta com esse e-mail.' });
    }
    console.error(e);
    res.status(500).json({ erro: 'Erro ao cadastrar o cliente. Tente novamente.' });
  }
});

// Lista as vendas feitas pelo vendedor logado, já com o link dinâmico, QR e scans de cada placa
router.get('/vendas', (req, res) => {
  // Clientes antigos que ficaram sem código de placa ganham um agora
  const semCodigo = db.prepare(`
    SELECT DISTINCT u.id FROM vendas v JOIN usuarios u ON u.id = v.usuario_id
    WHERE v.vendedor_id = ? AND (u.codigo_nfc IS NULL OR u.codigo_nfc = '')
  `).all(req.usuarioId);
  const setCodigo = db.prepare('UPDATE usuarios SET codigo_nfc = ? WHERE id = ?');
  semCodigo.forEach(({ id }) => setCodigo.run(gerarCodigoNfc(), id));

  const base = baseUrl(req);
  const vendas = db.prepare(`
    SELECT v.id, v.usuario_id AS cliente_id, v.forma_pagamento, v.status, v.valor, v.criado_em, v.confirmado_em,
           u.nome AS cliente_nome, u.negocio_nome, u.email AS cliente_email,
           u.codigo_nfc, u.google_place_id, u.link_google, u.nfc_scans, u.telefone
    FROM vendas v
    JOIN usuarios u ON u.id = v.usuario_id
    WHERE v.vendedor_id = ?
    ORDER BY v.criado_em DESC
  `).all(req.usuarioId).map(v => ({
    ...v,
    link_google_configurado: !!(v.google_place_id || v.link_google),
    link_placa: `${base}/r/${v.codigo_nfc}`,
    qr_code_url: `${base}/qr/${v.codigo_nfc}.png`,
    placas_lote: codigosDaLoja(v.cliente_id),
  }));

  const totalConfirmado = vendas.filter(v => v.status === 'confirmado').length;
  const totalPendente = vendas.filter(v => v.status === 'pendente').length;
  const totalScans = vendas.reduce((soma, v) => soma + (v.nfc_scans || 0), 0);

  const valorConfirmado = vendas.filter(v => v.status === 'confirmado').reduce((soma, v) => soma + (v.valor || 0), 0);
  const comissao = Math.round(valorConfirmado * COMISSAO_PERCENTUAL) / 100;

  res.json({ vendas, resumo: {
    totalConfirmado, totalPendente, total: vendas.length, totalScans,
    comissao, comissaoPercentual: COMISSAO_PERCENTUAL,
  } });
});

// Corrige/define o link do Google de um cliente que o próprio vendedor cadastrou
router.patch('/clientes/:id/google', (req, res) => {
  const venda = db.prepare('SELECT id FROM vendas WHERE usuario_id = ? AND vendedor_id = ?').get(req.params.id, req.usuarioId);
  if (!venda) return res.status(404).json({ erro: 'Cliente não encontrado entre as suas vendas.' });

  const { placeId, link } = interpretarLinkGoogle((req.body || {}).linkGoogle);
  if (!placeId && !link) {
    return res.status(400).json({ erro: 'Cole o Place ID ou o link de avaliação do Google (começando com https://).' });
  }

  db.prepare('UPDATE usuarios SET google_place_id = ?, link_google = ? WHERE id = ?').run(placeId, link, req.params.id);
  res.json({ ok: true, placeIdReconhecido: !!placeId });
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
  enviarReciboVenda(venda.id);

  res.json({ id: venda.id, status: 'confirmado' });
});

// Gera um novo Pix pra uma venda pendente (caso o QR original tenha falhado ou expirado)
router.post('/vendas/:id/gerar-pix', async (req, res) => {
  const venda = db.prepare(`
    SELECT v.id, v.status, v.forma_pagamento, v.valor, u.email AS cliente_email
    FROM vendas v
    JOIN usuarios u ON u.id = v.usuario_id
    WHERE v.id = ? AND v.vendedor_id = ?
  `).get(req.params.id, req.usuarioId);

  if (!venda) {
    return res.status(404).json({ erro: 'Venda não encontrada.' });
  }
  if (venda.forma_pagamento !== 'pix') {
    return res.status(400).json({ erro: 'Essa venda não é por Pix.' });
  }
  if (venda.status === 'confirmado') {
    return res.status(400).json({ erro: 'Essa venda já está confirmada.' });
  }

  try {
    const payment = new Payment(client);
    const notificationUrl = `${process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`}/api/pagamentos/webhook`;

    const resultadoPix = await payment.create({
      body: {
        transaction_amount: venda.valor,
        description: 'Webflow — placa NFC',
        payment_method_id: 'pix',
        payer: { email: venda.cliente_email },
        external_reference: `venda|${venda.id}`,
        notification_url: notificationUrl,
      },
    });

    const dadosPix = resultadoPix.point_of_interaction?.transaction_data;
    db.prepare('UPDATE vendas SET mp_payment_id = ? WHERE id = ?').run(String(resultadoPix.id), venda.id);

    res.json({
      pix: {
        qrCodeBase64: dadosPix?.qr_code_base64 || null,
        copiaECola: dadosPix?.qr_code || null,
      },
    });
  } catch (erroPix) {
    console.error('Erro ao gerar novo Pix', erroPix);
    res.status(500).json({ erro: 'Não foi possível gerar o Pix agora. Tente novamente em instantes.' });
  }
});


// Ativa uma placa impressa em lote num cliente que o próprio vendedor cadastrou
router.patch('/clientes/:id/placa', (req, res) => {
  const venda = db.prepare('SELECT id FROM vendas WHERE usuario_id = ? AND vendedor_id = ?').get(req.params.id, req.usuarioId);
  if (!venda) return res.status(404).json({ erro: 'Cliente não encontrado entre as suas vendas.' });
  const r = vincularPlaca((req.body || {}).codigoPlaca, Number(req.params.id));
  if (r.erro) return res.status(400).json({ erro: r.erro });
  res.json({ ok: true, codigo: r.codigo, placas: codigosDaLoja(Number(req.params.id)) });
});


// Salva/corrige o WhatsApp de um cliente que o próprio vendedor cadastrou
router.patch('/clientes/:id/telefone', (req, res) => {
  const venda = db.prepare('SELECT id FROM vendas WHERE usuario_id = ? AND vendedor_id = ?').get(req.params.id, req.usuarioId);
  if (!venda) return res.status(404).json({ erro: 'Cliente não encontrado entre as suas vendas.' });
  const tel = limparTelefone((req.body || {}).telefone);
  if (!tel) return res.status(400).json({ erro: 'WhatsApp inválido. Use DDD + número, ex.: (19) 99999-9999.' });
  db.prepare('UPDATE usuarios SET telefone = ? WHERE id = ?').run(tel, req.params.id);
  res.json({ ok: true, telefone: tel });
});

module.exports = router;
