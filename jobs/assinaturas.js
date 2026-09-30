const db = require('../db');
const { enviarEmail, emailInterno } = require('../email');

// Cada mensalidade paga libera o Premium por 30 dias + 5 de tolerância
// (dá tempo do Mercado Pago tentar cobrar de novo se o cartão falhar).
const DIAS_POR_PAGAMENTO = 35;
// Plano pro qual o cliente volta quando a mensalidade vence
const PLANO_SEM_MENSALIDADE = 'pro';
const SITE_URL = process.env.SITE_URL || 'https://flowsolution.netlify.app';

// Libera/estende o Premium a partir da data do pagamento. Idempotente: receber o mesmo
// aviso do Mercado Pago duas vezes não soma dias a mais.
function estenderPremium(usuarioId, dataPagamento) {
  const u = db.prepare('SELECT id, premium_ate FROM usuarios WHERE id = ?').get(usuarioId);
  if (!u) return false;

  const base = dataPagamento ? new Date(dataPagamento) : new Date();
  const novoFim = new Date(base.getTime() + DIAS_POR_PAGAMENTO * 86400000);
  const atual = u.premium_ate ? new Date(u.premium_ate) : null;
  const fim = atual && atual > novoFim ? atual : novoFim;

  db.prepare(`UPDATE usuarios SET plano = 'premium', premium_ate = ? WHERE id = ?`).run(fim.toISOString(), u.id);
  console.log(`Premium do usuário ${u.id} liberado até ${fim.toISOString()}`);
  return true;
}

function registrarAssinatura(usuarioId, assinaturaId, status) {
  db.prepare('UPDATE usuarios SET assinatura_id = ?, assinatura_status = ? WHERE id = ?')
    .run(assinaturaId ? String(assinaturaId) : null, status || null, usuarioId);
}

async function avisar(para, assunto, html) {
  if (!para) return;
  try { await enviarEmail({ para, assunto, html }); }
  catch (e) { console.error('Erro ao enviar aviso de assinatura', e.message); }
}

// Roda 1x por dia: lembra quem está pra vencer e rebaixa quem já venceu
async function verificarAssinaturas() {
  const agora = new Date();

  // Lembrete: vence em 2 a 3 dias e não tem assinatura ativa no Mercado Pago
  const perto = db.prepare(`
    SELECT id, nome, email, premium_ate FROM usuarios
    WHERE plano = 'premium' AND premium_ate IS NOT NULL
      AND premium_ate > ? AND premium_ate <= ?
      AND COALESCE(assinatura_status, '') <> 'authorized'
  `).all(new Date(agora.getTime() + 2 * 86400000).toISOString(), new Date(agora.getTime() + 3 * 86400000).toISOString());

  for (const u of perto) {
    await avisar(u.email, 'Sua mensalidade Premium vence em breve — Flow Solution', `
      <p>Oi, ${u.nome}!</p>
      <p>O seu plano Premium está pago até <b>${new Date(u.premium_ate).toLocaleDateString('pt-BR')}</b> e não encontramos uma assinatura ativa.</p>
      <p>Pra não perder o cardápio 3D, o app de gestão e o suporte, entre no painel e ative a mensalidade em <b>Planos</b>:</p>
      <p><a href="${SITE_URL}/webflow.html">Abrir o painel</a></p>`);
  }

  // Vencidos: volta pro plano sem mensalidade
  const vencidos = db.prepare(`
    SELECT id, nome, email, negocio_nome FROM usuarios
    WHERE plano = 'premium' AND premium_ate IS NOT NULL AND premium_ate < ?
  `).all(agora.toISOString());

  for (const u of vencidos) {
    db.prepare('UPDATE usuarios SET plano = ? WHERE id = ?').run(PLANO_SEM_MENSALIDADE, u.id);
    console.log(`Premium do usuário ${u.id} venceu — rebaixado para ${PLANO_SEM_MENSALIDADE}`);

    await avisar(u.email, 'Seu plano Premium foi pausado — Flow Solution', `
      <p>Oi, ${u.nome}!</p>
      <p>Não recebemos a mensalidade do Premium, então sua conta voltou para o plano Pró. Nenhum dado foi apagado.</p>
      <p>Assim que a mensalidade for paga, tudo volta a funcionar na hora: <a href="${SITE_URL}/webflow.html">abrir o painel</a>.</p>`);
    await avisar(emailInterno(), `Premium vencido: ${u.negocio_nome || u.nome}`, `
      <p>O cliente <b>${u.negocio_nome || u.nome}</b> (${u.email}) ficou sem pagar a mensalidade e foi rebaixado para ${PLANO_SEM_MENSALIDADE}.</p>`);
  }
}

function iniciarVerificacaoAssinaturas() {
  const rodar = () => verificarAssinaturas().catch((e) => console.error('Erro na verificação de assinaturas', e));
  setTimeout(rodar, 60 * 1000); // 1 min depois de ligar, pra não pesar a subida
  setInterval(rodar, 24 * 60 * 60 * 1000);
}

module.exports = { estenderPremium, registrarAssinatura, verificarAssinaturas, iniciarVerificacaoAssinaturas };
