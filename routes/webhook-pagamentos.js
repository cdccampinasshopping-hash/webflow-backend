const express = require('express');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const db = require('../db');

const router = express.Router();
const client = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });

router.post('/', async (req, res) => {
  try {
    const tipo = req.body?.type || req.query.type;
    const id = req.body?.data?.id || req.query['data.id'];

    if (tipo === 'payment' && id) {
      const payment = new Payment(client);
      const info = await payment.get({ id });

      if (info.status === 'approved' && info.external_reference) {
        const [usuarioId, plano] = String(info.external_reference).split('|');
        if (usuarioId && plano) {
          db.prepare('UPDATE usuarios SET plano = ? WHERE id = ?').run(plano, usuarioId);
          console.log(`Pagamento aprovado — usuário ${usuarioId} agora é plano ${plano}`);
        }
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('Erro no webhook de pagamento', e);
    res.sendStatus(200);
  }
});

module.exports = router;
