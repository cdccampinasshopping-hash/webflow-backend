const db = require('./db');
const { enviarEmail } = require('./email');

const SITE_URL = process.env.SITE_URL || 'https://flowsolution.pages.dev';
const NOME_PLANO = { basico: 'Básico', pro: 'Pró', premium: 'Premium' };
const FORMA = { pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão', mercadopago: 'Mercado Pago' };

const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reais = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBr = (d) => new Date(d || Date.now()).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

function htmlRecibo({ nome, negocio, plano, valor, forma, data, vendedor, email, numero }) {
  const linha = (rotulo, valorTxt) => `<tr><td style="padding:8px 0;color:#5B6478;font-size:14px">${rotulo}</td><td style="padding:8px 0;text-align:right;font-weight:600;font-size:14px;color:#13213C">${valorTxt}</td></tr>`;
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;background:#F6F8FB;padding:24px">
    <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:28px">
      <p style="margin:0 0 4px;font-weight:700;color:#1D5BF0;font-size:14px">Flow Solution</p>
      <h1 style="margin:0 0 6px;font-size:24px;color:#13213C">Recibo${numero ? ` nº ${esc(numero)}` : ''}</h1>
      <p style="margin:0 0 20px;color:#5B6478;font-size:15px">Oi, ${esc(nome)}! Obrigado por escolher a Flow Solution. Aqui estão os dados da sua contratação.</p>
      <table style="width:100%;border-collapse:collapse;border-top:1px solid #D9E1EC;border-bottom:1px solid #D9E1EC;margin-bottom:20px">
        ${linha('Negócio', esc(negocio || nome))}
        ${linha('Plano', esc(NOME_PLANO[plano] || plano))}
        ${linha('Valor', reais(valor))}
        ${linha('Forma de pagamento', esc(FORMA[forma] || forma))}
        ${linha('Data', dataBr(data))}
        ${vendedor ? linha('Atendido por', esc(vendedor)) : ''}
      </table>
      <p style="margin:0 0 6px;font-weight:700;color:#13213C;font-size:15px">Seu acesso ao painel</p>
      <p style="margin:0 0 16px;color:#5B6478;font-size:14px">Entre com o e-mail <b style="color:#13213C">${esc(email)}</b> e a senha que você recebeu no cadastro. Se esquecer, use "Esqueci minha senha".</p>
      <a href="${SITE_URL}/webflow.html" style="display:inline-block;background:#1D5BF0;color:#fff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:700;font-size:15px">Abrir o painel</a>
      <p style="margin:24px 0 0;color:#8A93A6;font-size:12px">Guarde este e-mail como comprovante. Dúvidas? Responda este e-mail ou fale com a gente pelo WhatsApp.</p>
    </div>
  </div>`;
}

// Recibo de uma venda do time comercial. Envia uma vez só por venda (confirmada).
async function enviarReciboVenda(vendaId) {
  try {
    const v = db.prepare(`
      SELECT v.id, v.valor, v.forma_pagamento, v.status, v.confirmado_em, v.recibo_enviado_em,
             u.nome, u.negocio_nome, u.email, u.plano, vend.nome AS vendedor
      FROM vendas v JOIN usuarios u ON u.id = v.usuario_id
      LEFT JOIN usuarios vend ON vend.id = v.vendedor_id
      WHERE v.id = ?`).get(vendaId);
    if (!v || v.status !== 'confirmado' || v.recibo_enviado_em || !v.email) return false;
    db.prepare('UPDATE vendas SET recibo_enviado_em = ? WHERE id = ?').run(new Date().toISOString(), v.id);
    await enviarEmail({
      para: v.email,
      assunto: `Seu recibo — Flow Solution (${NOME_PLANO[v.plano] || v.plano})`,
      html: htmlRecibo({ nome: v.nome, negocio: v.negocio_nome, plano: v.plano, valor: v.valor, forma: v.forma_pagamento, data: v.confirmado_em, vendedor: v.vendedor, email: v.email, numero: v.id }),
    });
    return true;
  } catch (e) {
    console.error('Não foi possível enviar o recibo da venda', vendaId, e.message);
    return false;
  }
}

// Recibo de um plano contratado pelo próprio cliente no site (pagamento aprovado no Mercado Pago)
async function enviarReciboPlano(usuarioId, plano, valor, data) {
  try {
    const u = db.prepare('SELECT nome, negocio_nome, email FROM usuarios WHERE id = ?').get(usuarioId);
    if (!u || !u.email) return false;
    await enviarEmail({
      para: u.email,
      assunto: `Pagamento confirmado — Flow Solution (${NOME_PLANO[plano] || plano})`,
      html: htmlRecibo({ nome: u.nome, negocio: u.negocio_nome, plano, valor, forma: 'mercadopago', data, email: u.email }),
    });
    return true;
  } catch (e) {
    console.error('Não foi possível enviar o recibo do plano', usuarioId, e.message);
    return false;
  }
}

module.exports = { enviarReciboVenda, enviarReciboPlano };
