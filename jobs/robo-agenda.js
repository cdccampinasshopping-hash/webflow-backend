const db = require('../db');
const whatsapp = require('../whatsapp');
const gcal = require('../google-agenda');

// Robô da agenda: toda vez que entra um agendamento (pelo link público ou pelo painel) ele
//  1) manda a confirmação pro CLIENTE no WhatsApp,
//  2) avisa o BARBEIRO (profissional) no WhatsApp com cliente, serviço, dia, hora e telefone,
//  3) coloca o horário no Google Agenda do gestor, com o barbeiro como convidado
//     (assim o horário aparece também no Google Agenda do barbeiro),
//  4) deixa o agendamento marcado como "novo" pro painel avisar com bipe.
// Remarcou ou cancelou: atualiza o Google e avisa cliente e barbeiro de novo.
// Se algo falhar (Google fora do ar, WhatsApp recusou), tenta de novo a cada 5 minutos, até 3 vezes.

const SITE_URL = process.env.SITE_URL || 'https://flowsolution.netlify.app';
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const MODELO_CLIENTE = () => process.env.WHATSAPP_TEMPLATE || 'confirmacao_agendamento';
const MODELO_PROF = () => process.env.WHATSAPP_TEMPLATE_PROFISSIONAL || 'novo_agendamento_profissional';

function lojaDe(usuarioId) {
  const u = db.prepare('SELECT id, nome, negocio_nome, agenda_config FROM usuarios WHERE id = ?').get(usuarioId);
  if (!u) return null;
  let cfg = {};
  try { cfg = JSON.parse(u.agenda_config || '{}') || {}; } catch (e) { /* config quebrada */ }
  return {
    id: u.id, nome: u.negocio_nome || u.nome, endereco: cfg.endereco || '', whatsapp: cfg.whatsapp || '',
    profissionais: Array.isArray(cfg.profissionais) ? cfg.profissionais : [],
  };
}

// Quem recebe o aviso de "novo horário": o barbeiro do agendamento. Sem barbeiro (ou sem número dele),
// o aviso vai pro WhatsApp da loja, que é o do gestor.
function profissionalDe(ag, loja) {
  const p = ag.profissional_id ? loja.profissionais.find((x) => x.id === ag.profissional_id) : null;
  if (p && p.whatsapp) return { nome: p.nome, whatsapp: p.whatsapp, email: p.email || '' };
  if (loja.whatsapp) return { nome: p ? p.nome : 'equipe', whatsapp: loja.whatsapp, email: (p && p.email) || '', daLoja: true };
  return p ? { nome: p.nome, whatsapp: '', email: p.email || '' } : null;
}

function dataBonita(data) {
  const [a, m, d] = data.split('-').map(Number);
  const dia = new Date(Date.UTC(a, m - 1, d)).getUTCDay();
  return `${DIAS[dia]}, ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}

function linkCliente(ag) {
  return `${SITE_URL}/agendar.html?r=${ag.token}`;
}

// Mesmo texto dos modelos aprovados na Meta — usado no botão "mandar pelo WhatsApp" quando não há envio automático
function textoConfirmacao(ag, loja) {
  return `Olá, ${ag.nome}! Seu horário na ${loja.nome} está confirmado: ${ag.servico}${ag.profissional ? ` com ${ag.profissional}` : ''}, ${dataBonita(ag.data)} às ${ag.hora}.`
    + `${loja.endereco ? `\nEndereço: ${loja.endereco}` : ''}\nPra ver ou desmarcar: ${linkCliente(ag)}`;
}
function textoCancelamento(ag, loja) {
  return `Olá, ${ag.nome}. Seu horário na ${loja.nome} de ${dataBonita(ag.data)} às ${ag.hora} (${ag.servico}) foi cancelado. Se quiser marcar outro, é só responder aqui.`;
}
function textoProfissional(ag, prof) {
  if (ag.status === 'cancelado') {
    return `Horário cancelado, ${prof.nome}: ${ag.nome} – ${ag.servico}, ${dataBonita(ag.data)} às ${ag.hora}. O horário ficou livre.`;
  }
  return `Novo horário na agenda, ${prof.nome}: ${ag.nome} – ${ag.servico}, ${dataBonita(ag.data)} às ${ag.hora}. WhatsApp do cliente: ${ag.telefone}`
    + `${ag.obs ? `\nObs.: ${ag.obs}` : ''}`;
}

function linkWhatsManual(ag, loja, texto) {
  const tel = whatsapp.normalizarTelefone(ag.telefone);
  return tel ? `https://wa.me/${tel}?text=${encodeURIComponent(texto || textoConfirmacao(ag, loja))}` : null;
}
function linkWhatsProfissional(ag, loja) {
  const prof = loja && profissionalDe(ag, loja);
  const tel = prof && whatsapp.normalizarTelefone(prof.whatsapp);
  return tel ? `https://wa.me/${tel}?text=${encodeURIComponent(textoProfissional(ag, prof))}` : null;
}

function paramsCliente(ag, loja) {
  const servico = ag.profissional ? `${ag.servico} com ${ag.profissional}` : ag.servico;
  return [ag.nome, loja.nome, servico, dataBonita(ag.data), ag.hora, linkCliente(ag)];
}
function paramsProfissional(ag, prof) {
  return [prof.nome, ag.nome, ag.servico, dataBonita(ag.data), ag.hora, ag.telefone];
}

async function avisarProfissional(ag, loja) {
  const prof = profissionalDe(ag, loja);
  if (!prof || !prof.whatsapp) return { status: 'sem_numero', erro: null };
  const cancelado = ag.status === 'cancelado';
  const modelo = cancelado ? process.env.WHATSAPP_TEMPLATE_PROFISSIONAL_CANCELAMENTO : MODELO_PROF();
  const params = cancelado ? [prof.nome, ag.nome, ag.servico, dataBonita(ag.data), ag.hora] : paramsProfissional(ag, prof);
  const r = await whatsapp.enviarModelo(prof.whatsapp, modelo, params);
  return { status: r.status, erro: r.erro || null };
}

async function colocarNoGoogle(ag, loja, atualizar) {
  const p = profissionalDe(ag, loja);
  try {
    const idEvento = atualizar ? await gcal.atualizarEvento(ag, loja, p) : await gcal.criarEvento(ag, loja, p);
    return idEvento ? { status: 'criado', id: idEvento, erro: null } : { status: 'sem_google', id: null, erro: null };
  } catch (e) {
    return { status: 'erro', id: ag.gcal_event_id || null, erro: e.message.slice(0, 300) };
  }
}

const salvar = db.prepare(`UPDATE agendamentos SET zap_status = ?, zap_erro = ?, prof_zap_status = ?, prof_zap_erro = ?,
  gcal_status = ?, gcal_event_id = ?, gcal_erro = ?, tentativas = tentativas + 1 WHERE id = ?`);

async function processar(id, { soQueFalhou = false } = {}) {
  const ag = db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(id);
  if (!ag || ag.status === 'cancelado') return;
  const loja = lojaDe(ag.usuario_id);
  if (!loja) return;
  const refazer = (st) => !soQueFalhou || st === 'erro' || !st;

  // 1) WhatsApp pro cliente
  let zap = { status: ag.zap_status, erro: ag.zap_erro };
  if (refazer(ag.zap_status)) {
    const r = await whatsapp.enviarModelo(ag.telefone, MODELO_CLIENTE(), paramsCliente(ag, loja));
    zap = { status: r.status, erro: r.erro || null };
  }
  // 2) WhatsApp pro barbeiro
  let prof = { status: ag.prof_zap_status, erro: ag.prof_zap_erro };
  if (refazer(ag.prof_zap_status)) prof = await avisarProfissional(ag, loja);
  // 3) Google Agenda (gestor + barbeiro convidado)
  let cal = { status: ag.gcal_status, id: ag.gcal_event_id, erro: ag.gcal_erro };
  if (refazer(ag.gcal_status)) cal = await colocarNoGoogle(ag, loja, false);

  salvar.run(zap.status, zap.erro, prof.status, prof.erro, cal.status, cal.id, cal.erro, id);
}

// Remarcou (mudou dia/hora): atualiza o evento no Google e reenvia a confirmação pro cliente e pro barbeiro
async function aoRemarcar(id) {
  const ag = db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(id);
  if (!ag) return;
  const loja = lojaDe(ag.usuario_id);
  const cal = await colocarNoGoogle(ag, loja, true);
  const r = await whatsapp.enviarModelo(ag.telefone, MODELO_CLIENTE(), paramsCliente(ag, loja));
  const prof = await avisarProfissional(ag, loja);
  salvar.run(r.status, r.erro || null, prof.status, prof.erro, cal.status, cal.id, cal.erro, id);
}

// Cancelou: tira do Google Agenda (o Google avisa o barbeiro convidado), avisa o barbeiro no WhatsApp
// e, se quem cancelou foi a loja, avisa o cliente também
async function aoCancelar(id) {
  const ag = db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(id);
  if (!ag) return;
  const loja = lojaDe(ag.usuario_id);
  try { await gcal.apagarEvento(ag); } catch (e) { console.warn('Não consegui tirar do Google Agenda', e.message); }
  const prof = await avisarProfissional(ag, loja);
  let zap = { status: ag.zap_status, erro: ag.zap_erro };
  if (ag.cancelado_por === 'loja') {
    const r = await whatsapp.enviarModelo(ag.telefone, process.env.WHATSAPP_TEMPLATE_CANCELAMENTO, [ag.nome, loja.nome, dataBonita(ag.data), ag.hora]);
    zap = { status: r.status === 'enviado' ? 'cancel_enviado' : 'cancel_manual', erro: r.erro || null };
  }
  db.prepare('UPDATE agendamentos SET zap_status = ?, zap_erro = ?, prof_zap_status = ?, prof_zap_erro = ? WHERE id = ?')
    .run(zap.status, zap.erro, prof.status === 'enviado' ? 'cancel_enviado' : prof.status === 'manual' ? 'cancel_manual' : prof.status, prof.erro, id);
}

// Dispara sem segurar a resposta da requisição
function disparar(fn, id) {
  setImmediate(() => fn(id).catch((e) => console.error('Robô da agenda falhou', id, e.message)));
}

function iniciarRoboAgenda() {
  setInterval(() => {
    const pendentes = db.prepare(`SELECT id FROM agendamentos
      WHERE status = 'confirmado' AND tentativas < 3 AND (zap_status = 'erro' OR gcal_status = 'erro' OR prof_zap_status = 'erro')
        AND data >= date('now', '-3 hours') LIMIT 20`).all();
    pendentes.forEach((p) => processar(p.id, { soQueFalhou: true }).catch(() => {}));
  }, 5 * 60 * 1000);
}

module.exports = {
  processar, aoRemarcar, aoCancelar, disparar, iniciarRoboAgenda,
  textoConfirmacao, textoCancelamento, textoProfissional, linkWhatsManual, linkWhatsProfissional, linkCliente, dataBonita, lojaDe,
};
