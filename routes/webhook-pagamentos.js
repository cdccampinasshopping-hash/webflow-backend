const express = require('express');
const { MercadoPagoConfig, Payment, PreApproval } = require('mercadopago');
const db = require('../db');
const { estenderPremium, registrarAssinatura } = require('../jobs/assinaturas');
const { enviarReciboVenda, enviarReciboPlano } = require('../recibo');
const { enviarEmail } = require('../email');

async function avisarAdmin(assunto, html) {
  if (!process.env.ADMIN_EMAIL) return;
  try { await enviarEmail({ para: process.env.ADMIN_EMAIL, assunto, html }); }
  catch (e) { console.error('Não foi possível avisar o admin', e.message); }
}

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

  if (referencia.startsWith('teste|')) {
    // Pix de teste do admin: só marca que o aviso do Mercado Pago chegou
    const testeId = referencia.split('|')[1];
    db.prepare(`UPDATE pix_testes SET status = 'aprovado', confirmado_por_webhook = 1, pago_em = ? WHERE id = ?`)
      .run(new Date().toISOString(), testeId);
    console.log(`Pix de teste ${testeId} aprovado (webhook recebido)`);
    return;
  }

  if (referencia.startsWith('placa|')) {
    // Placas extras pedidas pelo lojista no painel
    const pedidoId = referencia.split('|')[1];
    const r = db.prepare(`UPDATE pedidos_placas SET status = 'pago', pago_em = ? WHERE id = ? AND status = 'aguardando_pagamento'`)
      .run(new Date().toISOString(), pedidoId);
    if (r.changes) {
      const p = db.prepare(`SELECT p.quantidade, u.negocio_nome, u.nome, u.email, u.telefone FROM pedidos_placas p JOIN usuarios u ON u.id = p.usuario_id WHERE p.id = ?`).get(pedidoId);
      console.log(`Pedido de placa ${pedidoId} pago`);
      avisarAdmin(`Pedido de ${p.quantidade} placa(s) extra(s) — ${p.negocio_nome || p.nome}`, `
        <p><b>${p.negocio_nome || p.nome}</b> pagou <b>${p.quantidade} placa(s) extra(s)</b>.</p>
        <p>Contato: ${p.email}${p.telefone ? ` · WhatsApp ${p.telefone}` : ''}</p>
        <p>Entregue e ative as placas pelo painel admin, na aba Placas.</p>`);
    }
    return;
  }

  if (referencia.startsWith('venda|')) {
    // Pagamento de uma venda feita pelo time comercial (placa NFC via Pix)
    const vendaId = referencia.split('|')[1];
    db.prepare(`UPDATE vendas SET status = 'confirmado', confirmado_em = ? WHERE id = ?`)
      .run(new Date().toISOString(), vendaId);
    console.log(`Pagamento Pix aprovado — venda ${vendaId} confirmada`);
    enviarReciboVenda(vendaId);
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
  // Ativação pelo site: recibo pro cliente e aviso pra você (uma vez por pagamento)
  const jaTinha = db.prepare('SELECT plano, nome, negocio_nome, email FROM usuarios WHERE id = ?').get(usuarioId);
  if (jaTinha && jaTinha.plano !== plano) {
    enviarReciboPlano(parseInt(usuarioId, 10), plano, info.transaction_amount, dataPagamento);
    avisarAdmin(`Nova contratação pelo site: ${jaTinha.negocio_nome || jaTinha.nome} (${plano})`, `
      <p><b>${jaTinha.negocio_nome || jaTinha.nome}</b> (${jaTinha.email}) pagou o plano <b>${plano}</b> pelo site.</p>
      ${plano === 'pro' ? '' : '<p>Esse plano inclui a placa de avaliação: combine a entrega e ative a placa pelo painel admin.</p>'}`);
  }
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
