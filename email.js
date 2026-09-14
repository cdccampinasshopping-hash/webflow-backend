const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('AVISO: SMTP_USER/SMTP_PASS não configurados — e-mails não serão enviados de verdade (só aparecem no log).');
    return null;
  }

  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return transporter;
}

async function enviarEmail({ para, assunto, html }) {
  const t = getTransporter();
  if (!t) {
    console.log(`[e-mail simulado] Para: ${para} | Assunto: ${assunto}\n${html}`);
    return;
  }
  await t.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: para,
    subject: assunto,
    html,
  });
}

module.exports = { enviarEmail };
