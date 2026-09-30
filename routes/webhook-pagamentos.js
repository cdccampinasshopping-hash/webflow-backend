const express = require('express');
const { MercadoPagoConfig, Payment, PreApproval } = require('mercadopago');
const db = require('../db');
const { estenderPremium, registrarAssinatura } = require('../jobs/assinaturas');

const router = express.Router();
const client = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });

// Descobre de qual cliente é uma assinatura (pelo external_reference = id do usuário)
async function usuarioDaAssinatura(preapprovalId) {
  const jaSalvo = db.prepare('SELECT id FROM usuarios WHERE assinatura_id = ?').get(String(preapprovalId));
  if (jaSalvo) return { usuarioId: jaSalvo.id, assinatura: null };

  const assinatura = await new PreApproval(client).get({ id: preapprovalId });
  const usuarioId = parseInt(assinatura.external_reference, 10);
  return { usuarioId: Number.isFinite(usuarioId) ? usuarioId : null, assinatura };
}

async function tratarPagamento(id) {
  const info = await new Payment(client).get({ id });
  if (info.status !== 'approved' || !info.external_reference) return;

  const referencia = String(info.external_reference);
  const dataPagamento = info.date_approved || info.date_created;

  if (referencia.startsWith('venda|')) {
    // Pagamento de uma venda feita pelo time comercial (placa NFC via Pix)
    const vendaId = referencia.split('|')[1];
    db.prepare(`UPDATE vendas SET status = 'confirmado', confirmado_em = ? WHERE id = ?`)
      .run(new Date().toISOString(), vendaId);
    console.log(`Pagamento Pix aprovado — venda ${vendaId} confirmada`);
    return;
  }

  if (/^\d+$/.test(referencia)) {
    // Cobrança mensal da assinatura Premium (external_reference = id do usuário)
    estenderPremium(parseInt(referencia, 10), dataPagamento);
    return;
  }

  // Pagamento de ativação/upgrade feito pelo próprio cliente ("usuarioId|plano")
  const [usuarioId, plano] = referencia.split('|');
  if (!usuarioId || !plano) return;
  if (plano === 'premium') {
    // A ativação já cobre o primeiro mês; depois disso vale a mensalidade
    estenderPremium(parseInt(usuarioId, 10), dataPagamento);
  } else {
    db.prepare('UPDATE usuarios SET plano = ? WHERE id = ?').run(plano, usuarioId);
  }
  console.log(`Pagamento aprovado — usuário ${usuarioId} agora é plano ${plano}`);
}

// Assinatura criada, autorizada, pausada ou cancelada
async function tratarAssinatura(id) {
  const assinatura = await new PreApproval(client).get({ id });
  const usuarioId = parseInt(assinatura.external_reference, 10);
  if (!Number.isFinite(usuarioId)) return;

  registrarAssinatura(usuarioId, assinatura.id, assinatura.status);
  console.log(`Assinatura ${assinatura.id} do usuário ${usuarioId}: ${assinatura.status}`);
  // Cancelar não derruba o Premium na hora: ele fica ativo até o fim do período já pago.
}

// Cobrança mensal processada dentro de uma assinatura
async function tratarCobrancaAssinatura(id) {
  const r = await fetch(`https://api.mercadopago.com/authorized_payments/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}` },
  });
  if (!r.ok) {
    console.warn('Não foi possível consultar a cobrança da assinatura', id, r.status);
    return;
  }
  const cobranca = await r.json();
  const aprovada = cobranca.payment?.status === 'approved' || cobranca.status === 'approved';
  if (!aprovada || !cobranca.preapproval_id) return;

  const { usuarioId } = await usuarioDaAssinatura(cobranca.preapproval_id);
  if (usuarioId) estenderPremium(usuarioId, cobranca.date_created || cobranca.last_modified);
}

router.post('/', async (req, res) => {
  try {
    const tipo = req.body?.type || req.query.type || req.query.topic;
    const id = req.body?.data?.id || req.query['data.id'] || req.query.id;

    if (id) {
      if (tipo === 'payment') await tratarPagamento(id);
      else if (tipo === 'subscription_preapproval' || tipo === 'preapproval') await tratarAssinatura(id);
      else if (tipo === 'subscription_authorized_payment') await tratarCobrancaAssinatura(id);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('Erro no webhook de pagamento', e);
    res.sendStatus(200);
  }
});

module.exports = router;
