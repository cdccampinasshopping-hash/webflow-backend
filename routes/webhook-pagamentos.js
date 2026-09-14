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
        const referencia = String(info.external_reference);

        if (referencia.startsWith('venda|')) {
          // Pagamento de uma venda feita pelo time comercial (placa NFC via Pix)
          const vendaId = referencia.split('|')[1];
          db.prepare(`UPDATE vendas SET status = 'confirmado', confirmado_em = ? WHERE id = ?`)
            .run(new Date().toISOString(), vendaId);
          console.log(`Pagamento Pix aprovado — venda ${vendaId} confirmada`);
        } else {
          // Pagamento de upgrade de plano feito pelo próprio cliente
          const [usuarioId, plano] = referencia.split('|');
          if (usuarioId && plano) {
            db.prepare('UPDATE usuarios SET plano = ? WHERE id = ?').run(plano, usuarioId);
            console.log(`Pagamento aprovado — usuário ${usuarioId} agora é plano ${plano}`);
          }
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
