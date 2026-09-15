const { Resend } = require('resend');

let cliente = null;

function getCliente() {
  if (cliente) return cliente;
  if (!process.env.RESEND_API_KEY) {
    console.warn('AVISO: RESEND_API_KEY não configurada — e-mails não serão enviados de verdade (só aparecem no log).');
    return null;
  }
  cliente = new Resend(process.env.RESEND_API_KEY);
  return cliente;
}

async function enviarEmail({ para, assunto, html, anexos }) {
  const c = getCliente();
  if (!c) {
    console.log(`[e-mail simulado] Para: ${para} | Assunto: ${assunto}\n${html}`);
    if (anexos?.length) console.log(`[e-mail simulado] Anexos: ${anexos.map(a => a.filename).join(', ')}`);
    return;
  }

  const { error } = await c.emails.send({
    from: process.env.EMAIL_FROM || 'Webflow <onboarding@resend.dev>',
    to: para,
    subject: assunto,
    html,
    ...(anexos?.length ? { attachments: anexos } : {}),
  });

  if (error) {
    console.error('Erro ao enviar e-mail via Resend', error);
    throw new Error('Não foi possível enviar o e-mail.');
  }
}

module.exports = { enviarEmail };
