const express = require('express');
const { MercadoPagoConfig, Preference, PreApproval } = require('mercadopago');
const db = require('../db');

const router = express.Router();

const client = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });

const PLANOS_VALIDOS = ['basico', 'pro', 'premium'];
const PRECOS = {
  basico: { titulo: 'Webflow — Plano Básico', valor: 80 },
  pro: { titulo: 'Webflow — Plano Pró', valor: 200 },
  premium: { titulo: 'Webflow — Plano Premium (ativação)', valor: 300 },
};

const SITE_URL = process.env.SITE_URL || 'https://webflowservices.com';

function urlBackend(req) {
  return process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
}

router.post('/checkout', async (req, res) => {
  const { plano } = req.body || {};
  const item = PRECOS[plano];
  if (!item) {
    return res.status(400).json({ erro: `Plano inválido. Use um de: ${PLANOS_VALIDOS.join(', ')}.` });
  }

  try {
    const preference = new Preference(client);
    const resultado = await preference.create({
      body: {
        items: [{ title: item.titulo, quantity: 1, unit_price: item.valor, currency_id: 'BRL' }],
        external_reference: `${req.usuarioId}|${plano}`,
        back_urls: {
          success: `${SITE_URL}/webflow.html?pagamento=sucesso`,
          failure: `${SITE_URL}/webflow.html?pagamento=falha`,
          pending: `${SITE_URL}/webflow.html?pagamento=pendente`,
        },
        auto_return: 'approved',
        notification_url: `${urlBackend(req)}/api/pagamentos/webhook`,
      },
    });
    res.json({ init_point: resultado.init_point });
  } catch (e) {
    console.error('Erro ao criar preferência de pagamento', e);
    res.status(500).json({ erro: 'Não foi possível iniciar o pagamento.' });
  }
});

router.post('/assinatura', async (req, res) => {
  try {
    const usuario = db.prepare('SELECT email FROM usuarios WHERE id = ?').get(req.usuarioId);
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado.' });

    const preapproval = new PreApproval(client);
    const resultado = await preapproval.create({
      body: {
        reason: 'Webflow Premium — mensalidade',
        external_reference: `${req.usuarioId}`,
        payer_email: usuario.email,
        back_url: `${SITE_URL}/webflow.html?assinatura=sucesso`,
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: 150,
          currency_id: 'BRL',
        },
        status: 'pending',
      },
    });
    res.json({ init_point: resultado.init_point });
  } catch (e) {
    console.error('Erro ao criar assinatura', e);
    res.status(500).json({ erro: 'Não foi possível iniciar a assinatura.' });
  }
});

module.exports = router;
