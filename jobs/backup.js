const fs = require('fs');
const path = require('path');
const db = require('../db');
const { enviarEmail } = require('../email');

// Cria uma cópia consistente do banco de dados (segura mesmo com o servidor em uso)
async function criarArquivoBackup() {
  const nomeArquivo = `webflow-backup-${new Date().toISOString().slice(0, 10)}.db`;
  const destino = path.join('/tmp', nomeArquivo);
  await db.backup(destino);
  return { destino, nomeArquivo };
}

// Gera o backup e envia por e-mail pro admin, como anexo
async function enviarBackupPorEmail() {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    console.warn('ADMIN_EMAIL não configurado — não foi possível enviar o backup automático.');
    return;
  }

  try {
    const { destino, nomeArquivo } = await criarArquivoBackup();
    const conteudoBase64 = fs.readFileSync(destino).toString('base64');
    fs.unlinkSync(destino); // limpa o arquivo temporário depois de ler

    await enviarEmail({
      para: adminEmail,
      assunto: `Backup diário do Webflow — ${new Date().toLocaleDateString('pt-BR')}`,
      html: `<p>Segue em anexo o backup automático do banco de dados de hoje (${new Date().toLocaleString('pt-BR')}).</p>
             <p>Guarde este e-mail — em caso de perda de dados, esse arquivo .db pode ser usado pra restaurar o sistema.</p>`,
      anexos: [{ filename: nomeArquivo, content: conteudoBase64 }],
    });

    console.log(`Backup diário enviado com sucesso pra ${adminEmail}`);
  } catch (e) {
    console.error('Erro ao gerar/enviar o backup diário', e);
  }
}

// Roda um backup ao ligar o servidor, e depois repete a cada 24 horas
function iniciarAgendamentoBackup() {
  enviarBackupPorEmail();
  setInterval(enviarBackupPorEmail, 24 * 60 * 60 * 1000);
}

module.exports = { iniciarAgendamentoBackup, enviarBackupPorEmail };
