const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { lojaPorCodigo } = require('../placas');
const gcal = require('../google-agenda');
const whatsapp = require('../whatsapp');
const robo = require('../jobs/robo-agenda');

// Agenda online (barbearia, salão, clínica e serviços).
//  - lojista: configura serviços, profissionais e horários; vê e gerencia os agendamentos
//  - público: o cliente escolhe serviço, dia e horário pelo link da loja e marca sozinho
// Todo agendamento novo passa pelo robô (jobs/robo-agenda.js): WhatsApp + Google Agenda + aviso no painel.

const SITE_URL = process.env.SITE_URL || 'https://flowsolution.pages.dev';
const FUSO = -3; // Brasília
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const STATUS = ['confirmado', 'concluido', 'faltou', 'cancelado'];
const INTERVALOS = [10, 15, 20, 30, 45, 60];

/* ---------------- utilidades ---------------- */
const texto = (v, max) => { const t = String(v == null ? '' : v).trim().slice(0, max); return t || null; };
const paraMin = (h) => { const [a, b] = h.split(':').map(Number); return a * 60 + b; };
const paraHora = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const idCurto = () => crypto.randomBytes(4).toString('hex');

function agoraBrasilia() {
  const d = new Date(Date.now() + FUSO * 3600000);
  return { data: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
function somarDias(data, n) {
  const [a, m, d] = data.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}
function diaDaSemana(data) {
  const [a, m, d] = data.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d)).getUTCDay();
}
function dataValida(data) {
  if (!DATA.test(String(data || ''))) return false;
  const [a, m, d] = data.split('-').map(Number);
  const t = new Date(Date.UTC(a, m - 1, d));
  return t.getUTCFullYear() === a && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
function preco(v) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 && n < 100000 ? Math.round(n * 100) / 100 : null;
}

/* ---------------- configuração ---------------- */
const DIAS_PADRAO = [
  { ativo: false, abre: '09:00', fecha: '13:00' }, // domingo
  ...Array.from({ length: 5 }, () => ({ ativo: true, abre: '09:00', fecha: '19:00' })),
  { ativo: true, abre: '09:00', fecha: '17:00' }, // sábado
];

function lerConfig(json) {
  let c = {};
  try { c = JSON.parse(json || '{}') || {}; } catch (e) { c = {}; }
  return {
    ativo: !!c.ativo,
    servicos: Array.isArray(c.servicos) ? c.servicos : [],
    profissionais: Array.isArray(c.profissionais) ? c.profissionais : [],
    dias: Array.isArray(c.dias) && c.dias.length === 7 ? c.dias : DIAS_PADRAO,
    pausa: c.pausa && HORA.test(c.pausa.ini) && HORA.test(c.pausa.fim) ? c.pausa : null,
    intervalo: INTERVALOS.includes(c.intervalo) ? c.intervalo : 30,
    antecedencia: Number.isInteger(c.antecedencia) ? c.antecedencia : 60,
    diasAFrente: Number.isInteger(c.diasAFrente) ? c.diasAFrente : 30,
    endereco: c.endereco || '',
    whatsapp: c.whatsapp || '',
    aviso: c.aviso || '',
  };
}

function limparConfig(b) {
  const erro = (m) => { const e = new Error(m); e.status = 400; throw e; };
  const servicos = (Array.isArray(b.servicos) ? b.servicos : []).slice(0, 40).map((s) => {
    const nome = texto(s && s.nome, 60);
    const duracao = parseInt(s && s.duracao, 10);
    if (!nome) return null;
    if (!(duracao >= 5 && duracao <= 480)) erro(`Diga quanto tempo leva "${nome}" (entre 5 e 480 minutos).`);
    return { id: texto(s.id, 12) || idCurto(), nome, duracao, preco: preco(s.preco) };
  }).filter(Boolean);
  const profissionais = (Array.isArray(b.profissionais) ? b.profissionais : []).slice(0, 15).map((p) => {
    const nome = texto(p && p.nome, 40);
    if (!nome) return null;
    const zap = texto(String(p.whatsapp || '').replace(/[^\d()+ -]/g, ''), 20);
    if (zap && !whatsapp.normalizarTelefone(zap)) erro(`O WhatsApp de ${nome} está incompleto. Coloque com DDD.`);
    const email = texto(String(p.email || '').toLowerCase(), 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) erro(`O e-mail do Google de ${nome} não parece certo.`);
    return { id: texto(p.id, 12) || idCurto(), nome, whatsapp: zap || '', email: email || '' };
  }).filter(Boolean);
  const dias = Array.isArray(b.dias) && b.dias.length === 7 ? b.dias.map((d, i) => {
    const abre = HORA.test(d && d.abre) ? d.abre : '09:00';
    const fecha = HORA.test(d && d.fecha) ? d.fecha : '18:00';
    if (d && d.ativo && paraMin(fecha) <= paraMin(abre)) erro(`No ${['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][i]}, o horário de fechar precisa ser depois do de abrir.`);
    return { ativo: !!(d && d.ativo), abre, fecha };
  }) : DIAS_PADRAO;
  const pausa = b.pausa && HORA.test(b.pausa.ini) && HORA.test(b.pausa.fim) && paraMin(b.pausa.fim) > paraMin(b.pausa.ini)
    ? { ini: b.pausa.ini, fim: b.pausa.fim } : null;
  const intervalo = INTERVALOS.includes(Number(b.intervalo)) ? Number(b.intervalo) : 30;
  const antecedencia = Math.min(2880, Math.max(0, parseInt(b.antecedencia, 10) || 0));
  const diasAFrente = Math.min(90, Math.max(1, parseInt(b.diasAFrente, 10) || 30));
  if (b.ativo && !servicos.length) erro('Cadastre pelo menos um serviço antes de ligar a agenda online.');
  return {
    ativo: !!b.ativo, servicos, profissionais, dias, pausa, intervalo, antecedencia, diasAFrente,
    endereco: texto(b.endereco, 160) || '', whatsapp: texto(String(b.whatsapp || '').replace(/[^\d()+ -]/g, ''), 20) || '',
    aviso: texto(b.aviso, 300) || '',
  };
}

/* ---------------- horários livres ---------------- */
function ocupados(lojaId, data) {
  return db.prepare(`SELECT id, hora, duracao, profissional_id FROM agendamentos
    WHERE usuario_id = ? AND data = ? AND status IN ('confirmado', 'concluido')`).all(lojaId, data)
    .map((a) => ({ id: a.id, ini: paraMin(a.hora), fim: paraMin(a.hora) + a.duracao, prof: a.profissional_id }));
}

// Quem está livre nesse intervalo? (sem profissionais cadastrados = agenda única)
function livresNoHorario(cfg, ocup, ini, fim, profId, ignorarId) {
  const choca = (o) => o.id !== ignorarId && ini < o.fim && o.ini < fim;
  if (!cfg.profissionais.length) return ocup.some(choca) ? [] : [null];
  const lista = profId ? cfg.profissionais.filter((p) => p.id === profId) : cfg.profissionais;
  // agendamento antigo sem profissional ocupa todo mundo
  if (ocup.some((o) => !o.prof && choca(o))) return [];
  return lista.filter((p) => !ocup.some((o) => o.prof === p.id && choca(o)));
}

function horariosLivres(lojaId, cfg, data, servico, profId) {
  const hoje = agoraBrasilia();
  if (!dataValida(data) || data < hoje.data || data > somarDias(hoje.data, cfg.diasAFrente)) return [];
  const dia = cfg.dias[diaDaSemana(data)];
  if (!dia || !dia.ativo) return [];
  const ocup = ocupados(lojaId, data);
  // minutos entre agora e o começo do dia escolhido (pra respeitar a antecedência mínima, mesmo virando o dia)
  const [a1, m1, d1] = hoje.data.split('-').map(Number);
  const [a2, m2, d2] = data.split('-').map(Number);
  const offset = (Date.UTC(a2, m2 - 1, d2) - Date.UTC(a1, m1 - 1, d1)) / 60000 - hoje.min;
  const lista = [];
  for (let t = paraMin(dia.abre); t + servico.duracao <= paraMin(dia.fecha); t += cfg.intervalo) {
    if (offset + t < Math.max(cfg.antecedencia, 1)) continue;
    if (cfg.pausa && t < paraMin(cfg.pausa.fim) && paraMin(cfg.pausa.ini) < t + servico.duracao) continue;
    const livres = livresNoHorario(cfg, ocup, t, t + servico.duracao, profId);
    if (livres.length) lista.push({ hora: paraHora(t), profissionais: livres.filter(Boolean).map((p) => p.id) });
  }
  return lista;
}

/* ---------------- criação (usada pelo público e pelo painel) ---------------- */
function criarAgendamento(lojaId, cfg, b, { origem, forcar = false }) {
  const erro = (m, status = 400) => { const e = new Error(m); e.status = status; throw e; };
  const servico = cfg.servicos.find((s) => s.id === b.servico);
  if (!servico) erro('Escolha o serviço.');
  const data = String(b.data || '');
  const hora = String(b.hora || '');
  if (!dataValida(data) || !HORA.test(hora)) erro('Escolha o dia e o horário.');
  const nome = texto(b.nome, 60);
  const telefone = texto(String(b.telefone || '').replace(/[^\d()+ -]/g, ''), 20);
  if (!nome) erro('Diga o nome do cliente.');
  if (!whatsapp.normalizarTelefone(telefone)) erro('Coloque um WhatsApp com DDD, ex.: (19) 98888-7777.');
  const obs = texto(b.obs, 200);
  const profPedido = b.profissional ? cfg.profissionais.find((p) => p.id === b.profissional) : null;
  if (b.profissional && !profPedido) erro('Esse profissional não está mais na agenda.');

  return db.transaction(() => {
    let prof = profPedido;
    if (origem === 'online') {
      const slot = horariosLivres(lojaId, cfg, data, servico, profPedido && profPedido.id).find((s) => s.hora === hora);
      if (!slot) erro('Esse horário acabou de ser ocupado. Escolha outro, por favor.', 409);
      if (!prof && cfg.profissionais.length) prof = cfg.profissionais.find((p) => p.id === slot.profissionais[0]);
    } else {
      const ini = paraMin(hora);
      const livres = livresNoHorario(cfg, ocupados(lojaId, data), ini, ini + servico.duracao, prof && prof.id);
      if (!livres.length && !forcar) erro('Já tem cliente nesse horário. Confirme se quer encaixar mesmo assim.', 409);
      if (!prof && cfg.profissionais.length && livres.length) prof = livres[0];
    }
    const token = crypto.randomBytes(12).toString('hex');
    const info = db.prepare(`INSERT INTO agendamentos (usuario_id, token, data, hora, duracao, servico, preco, profissional_id, profissional,
      nome, telefone, obs, origem, visto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(lojaId, token, data, hora, servico.duracao, servico.nome, servico.preco, prof ? prof.id : null, prof ? prof.nome : null,
        nome, telefone, obs, origem, origem === 'painel' ? 1 : 0);
    return info.lastInsertRowid;
  })();
}

function paraPainel(a, loja) {
  const cancelado = a.status === 'cancelado';
  const texto = cancelado ? robo.textoCancelamento(a, loja) : robo.textoConfirmacao(a, loja);
  return {
    id: a.id, data: a.data, hora: a.hora, duracao: a.duracao, fim: paraHora(paraMin(a.hora) + a.duracao),
    servico: a.servico, preco: a.preco, profissional: a.profissional, profissional_id: a.profissional_id,
    nome: a.nome, telefone: a.telefone, obs: a.obs, origem: a.origem, status: a.status, cancelado_por: a.cancelado_por,
    zap_status: a.zap_status, zap_erro: a.zap_erro, gcal_status: a.gcal_status, gcal_erro: a.gcal_erro,
    zap_link: robo.linkWhatsManual(a, loja, texto), criado_em: a.criado_em,
    prof_zap_status: a.prof_zap_status, prof_zap_erro: a.prof_zap_erro, prof_zap_link: robo.linkWhatsProfissional(a, loja),
  };
}

function enviarErro(res, e) {
  if (e.status) return res.status(e.status).json({ erro: e.message });
  console.error('Erro na agenda', e);
  res.status(500).json({ erro: 'Não foi possível concluir agora. Tente de novo.' });
}

/* ================= rotas do lojista ================= */
const lojista = express.Router();

function minhaLoja(req) {
  const u = db.prepare('SELECT id, nome, negocio_nome, codigo_nfc, agenda_config, agenda_ics_token FROM usuarios WHERE id = ?').get(req.usuarioId);
  return u;
}

lojista.get('/', (req, res) => {
  const u = minhaLoja(req);
  if (!u) return res.status(404).json({ erro: 'Conta não encontrada.' });
  let ics = u.agenda_ics_token;
  if (!ics) {
    ics = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE usuarios SET agenda_ics_token = ? WHERE id = ?').run(ics, u.id);
  }
  const base = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    config: lerConfig(u.agenda_config),
    link: u.codigo_nfc ? `${SITE_URL}/agendar.html?c=${encodeURIComponent(u.codigo_nfc)}` : null,
    ics: `${base}/agenda/${ics}.ics`,
    google: { disponivel: gcal.configurado(), conectado: gcal.conectado(u.id) },
    whatsapp: { automatico: whatsapp.configurado() },
  });
});

lojista.put('/config', (req, res) => {
  try {
    const c = limparConfig(req.body || {});
    db.prepare('UPDATE usuarios SET agenda_config = ? WHERE id = ?').run(JSON.stringify(c), req.usuarioId);
    res.json({ config: c });
  } catch (e) { enviarErro(res, e); }
});

lojista.get('/agendamentos', (req, res) => {
  const hoje = agoraBrasilia().data;
  const de = dataValida(req.query.de) ? req.query.de : hoje;
  const ate = dataValida(req.query.ate) ? req.query.ate : somarDias(de, 6);
  const loja = robo.lojaDe(req.usuarioId);
  const lista = db.prepare(`SELECT * FROM agendamentos WHERE usuario_id = ? AND data BETWEEN ? AND ? ORDER BY data, hora LIMIT 1000`)
    .all(req.usuarioId, de, ate);
  res.json({ agendamentos: lista.map((a) => paraPainel(a, loja)), hoje });
});

// Agendamentos (e cancelamentos feitos pelo cliente) que o painel ainda não avisou
lojista.get('/novos', (req, res) => {
  const loja = robo.lojaDe(req.usuarioId);
  const lista = db.prepare('SELECT * FROM agendamentos WHERE usuario_id = ? AND visto = 0 ORDER BY id LIMIT 50').all(req.usuarioId);
  res.set('Cache-Control', 'no-store');
  res.json({ agendamentos: lista.map((a) => paraPainel(a, loja)) });
});

lojista.post('/vistos', (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 200) : [];
  const upd = db.prepare('UPDATE agendamentos SET visto = 1 WHERE id = ? AND usuario_id = ?');
  db.transaction(() => ids.forEach((id) => upd.run(id, req.usuarioId)))();
  res.json({ ok: true });
});

// Clientes da agenda (barbearia/salão/clínica), agrupados pelo WhatsApp — alimenta a tela Clientes
lojista.get('/clientes', (req, res) => {
  const linhas = db.prepare(`SELECT nome, telefone, preco, data, hora, status, servico FROM agendamentos
    WHERE usuario_id = ? AND status != 'cancelado' ORDER BY data, hora`).all(req.usuarioId);
  const mapa = new Map();
  linhas.forEach((a) => {
    const chave = String(a.telefone).replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
    if (chave.length < 10) return;
    const c = mapa.get(chave) || { telefone: chave, nome: null, endereco: null, pedidos: 0, gasto: 0, faltas: 0, primeiro: null, ultimo: null, ultimoServico: null, novidades: false };
    c.nome = a.nome || c.nome;
    if (a.status === 'faltou') c.faltas += 1;
    else {
      c.pedidos += 1;
      c.gasto = Math.round((c.gasto + (a.preco || 0)) * 100) / 100;
    }
    const quando = `${a.data} ${a.hora}:00`;
    c.primeiro = c.primeiro || quando;
    c.ultimo = quando;
    c.ultimoServico = a.servico;
    mapa.set(chave, c);
  });
  res.json({ clientes: [...mapa.values()].sort((a, b) => b.gasto - a.gasto) });
});

lojista.get('/horarios', (req, res) => {
  const cfg = lerConfig(minhaLoja(req).agenda_config);
  const servico = cfg.servicos.find((s) => s.id === req.query.servico);
  if (!servico) return res.json({ horarios: [] });
  res.json({ horarios: horariosLivres(req.usuarioId, { ...cfg, antecedencia: 0 }, String(req.query.data || ''), servico, req.query.profissional || null) });
});

lojista.post('/agendamentos', (req, res) => {
  try {
    const cfg = lerConfig(minhaLoja(req).agenda_config);
    const id = criarAgendamento(req.usuarioId, cfg, req.body || {}, { origem: 'painel', forcar: !!(req.body || {}).forcar });
    robo.disparar(robo.processar, id);
    const a = db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(id);
    res.status(201).json({ agendamento: paraPainel(a, robo.lojaDe(req.usuarioId)) });
  } catch (e) { enviarErro(res, e); }
});

lojista.patch('/agendamentos/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM agendamentos WHERE id = ? AND usuario_id = ?').get(req.params.id, req.usuarioId);
  if (!a) return res.status(404).json({ erro: 'Agendamento não encontrado.' });
  const b = req.body || {};
  try {
    if (b.data || b.hora) {
      // remarcar
      if (a.status === 'cancelado') return res.status(400).json({ erro: 'Esse horário foi cancelado. Marque um novo.' });
      const data = b.data || a.data, hora = b.hora || a.hora;
      if (!dataValida(data) || !HORA.test(hora)) return res.status(400).json({ erro: 'Dia ou horário inválido.' });
      const cfg = lerConfig(minhaLoja(req).agenda_config);
      const ini = paraMin(hora);
      const ocup = ocupados(req.usuarioId, data);
      const livres = livresNoHorario(cfg, ocup, ini, ini + a.duracao, a.profissional_id, a.id);
      if (!livres.length && !b.forcar) return res.status(409).json({ erro: 'Já tem cliente nesse horário. Confirme se quer encaixar mesmo assim.' });
      db.prepare('UPDATE agendamentos SET data = ?, hora = ? WHERE id = ?').run(data, hora, a.id);
      robo.disparar(robo.aoRemarcar, a.id);
    } else if (b.status) {
      if (!STATUS.includes(b.status)) return res.status(400).json({ erro: 'Status inválido.' });
      db.prepare('UPDATE agendamentos SET status = ?, cancelado_por = ? WHERE id = ?')
        .run(b.status, b.status === 'cancelado' ? 'loja' : null, a.id);
      if (b.status === 'cancelado' && a.status !== 'cancelado') robo.disparar(robo.aoCancelar, a.id);
    }
    const atual = db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(a.id);
    res.json({ agendamento: paraPainel(atual, robo.lojaDe(req.usuarioId)) });
  } catch (e) { enviarErro(res, e); }
});

// Botão "tentar de novo" do robô (WhatsApp / Google)
lojista.post('/agendamentos/:id/robo', async (req, res) => {
  const a = db.prepare('SELECT id FROM agendamentos WHERE id = ? AND usuario_id = ?').get(req.params.id, req.usuarioId);
  if (!a) return res.status(404).json({ erro: 'Agendamento não encontrado.' });
  await robo.processar(a.id, { soQueFalhou: true }).catch(() => {});
  const atual = db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(a.id);
  res.json({ agendamento: paraPainel(atual, robo.lojaDe(req.usuarioId)) });
});

lojista.get('/google/conectar', (req, res) => {
  if (!gcal.configurado()) return res.status(503).json({ erro: 'A conexão com o Google Agenda ainda não foi ativada pela Flow Solution.' });
  res.json({ url: gcal.urlConectar(req, req.usuarioId) });
});

lojista.delete('/google', (req, res) => {
  gcal.desconectar(req.usuarioId);
  res.json({ ok: true });
});

// Gera um link .ics novo (o antigo para de funcionar)
lojista.post('/ics/novo', (req, res) => {
  db.prepare('UPDATE usuarios SET agenda_ics_token = ? WHERE id = ?').run(crypto.randomBytes(16).toString('hex'), req.usuarioId);
  res.json({ ok: true });
});

/* ================= rotas públicas (cliente final) ================= */
const publico = express.Router();
const tentativas = new Map();
function podeMarcar(ip) {
  const agora = Date.now();
  const lista = (tentativas.get(ip) || []).filter((t) => agora - t < 10 * 60000);
  if (lista.length >= 6) { tentativas.set(ip, lista); return false; }
  lista.push(agora); tentativas.set(ip, lista);
  if (tentativas.size > 5000) tentativas.clear();
  return true;
}

function lojaPublica(codigo) {
  const loja = lojaPorCodigo(codigo, 'id, nome, negocio_nome, plano, agenda_config');
  if (!loja || loja.plano !== 'premium') return null;
  const cfg = lerConfig(loja.agenda_config);
  return cfg.ativo ? { loja, cfg } : null;
}

publico.get('/reserva/:token', (req, res) => {
  const a = db.prepare('SELECT * FROM agendamentos WHERE token = ?').get(String(req.params.token));
  if (!a) return res.status(404).json({ erro: 'Agendamento não encontrado.' });
  const loja = robo.lojaDe(a.usuario_id);
  const hoje = agoraBrasilia();
  const passou = a.data < hoje.data || (a.data === hoje.data && paraMin(a.hora) <= hoje.min);
  res.set('Cache-Control', 'no-store');
  res.json({
    loja: { nome: loja.nome, endereco: loja.endereco, whatsapp: loja.whatsapp },
    agendamento: { data: a.data, hora: a.hora, duracao: a.duracao, servico: a.servico, preco: a.preco, profissional: a.profissional, nome: a.nome, status: a.status },
    podeCancelar: a.status === 'confirmado' && !passou,
  });
});

publico.post('/reserva/:token/cancelar', (req, res) => {
  const a = db.prepare('SELECT * FROM agendamentos WHERE token = ?').get(String(req.params.token));
  if (!a) return res.status(404).json({ erro: 'Agendamento não encontrado.' });
  if (a.status !== 'confirmado') return res.status(400).json({ erro: 'Esse horário não está mais ativo.' });
  const hoje = agoraBrasilia();
  if (a.data < hoje.data || (a.data === hoje.data && paraMin(a.hora) <= hoje.min)) return res.status(400).json({ erro: 'Esse horário já passou.' });
  // visto = 0 pra o painel avisar o lojista que o cliente desmarcou
  db.prepare(`UPDATE agendamentos SET status = 'cancelado', cancelado_por = 'cliente', visto = 0 WHERE id = ?`).run(a.id);
  robo.disparar(robo.aoCancelar, a.id);
  res.json({ ok: true });
});

publico.get('/:codigo', (req, res) => {
  const achou = lojaPublica(req.params.codigo);
  if (!achou) return res.status(404).json({ erro: 'Essa agenda não está disponível.' });
  const { loja, cfg } = achou;
  const hoje = agoraBrasilia();
  const dias = [];
  for (let i = 0; i <= cfg.diasAFrente; i++) {
    const d = somarDias(hoje.data, i);
    if (cfg.dias[diaDaSemana(d)].ativo) dias.push(d);
  }
  res.set('Cache-Control', 'no-store');
  res.json({
    loja: { nome: loja.negocio_nome || loja.nome, endereco: cfg.endereco, whatsapp: cfg.whatsapp, aviso: cfg.aviso },
    servicos: cfg.servicos.map((s) => ({ id: s.id, nome: s.nome, duracao: s.duracao, preco: s.preco })),
    profissionais: cfg.profissionais.map((p) => ({ id: p.id, nome: p.nome })),
    dias,
    hoje: hoje.data,
  });
});

publico.get('/:codigo/horarios', (req, res) => {
  const achou = lojaPublica(req.params.codigo);
  if (!achou) return res.status(404).json({ erro: 'Essa agenda não está disponível.' });
  const servico = achou.cfg.servicos.find((s) => s.id === req.query.servico);
  if (!servico) return res.status(400).json({ erro: 'Escolha o serviço.' });
  res.set('Cache-Control', 'no-store');
  res.json({ horarios: horariosLivres(achou.loja.id, achou.cfg, String(req.query.data || ''), servico, req.query.profissional || null).map((h) => h.hora) });
});

publico.post('/:codigo', (req, res) => {
  const achou = lojaPublica(req.params.codigo);
  if (!achou) return res.status(404).json({ erro: 'Essa agenda não está disponível.' });
  if (!podeMarcar(req.ip || 'x')) return res.status(429).json({ erro: 'Muitas tentativas seguidas. Espere alguns minutos.' });
  try {
    const id = criarAgendamento(achou.loja.id, achou.cfg, req.body || {}, { origem: 'online' });
    robo.disparar(robo.processar, id);
    const a = db.prepare('SELECT token, data, hora, servico, profissional FROM agendamentos WHERE id = ?').get(id);
    res.status(201).json({ token: a.token, data: a.data, hora: a.hora, servico: a.servico, profissional: a.profissional, whatsappAutomatico: whatsapp.configurado() });
  } catch (e) { enviarErro(res, e); }
});

/* ================= calendário .ics (assinável no Google Agenda, iPhone, Outlook) ================= */
function icsEsc(t) { return String(t || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => '\\' + c); }
function icsData(data, hora, somaMin = 0) {
  // horário de Brasília → UTC
  const [a, m, d] = data.split('-').map(Number);
  const [h, mi] = hora.split(':').map(Number);
  return new Date(Date.UTC(a, m - 1, d, h - FUSO, mi + somaMin)).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
}

function feedIcs(req, res) {
  const u = db.prepare('SELECT id, nome, negocio_nome FROM usuarios WHERE agenda_ics_token = ?').get(String(req.params.token));
  if (!u) return res.status(404).send('Calendário não encontrado.');
  const prof = req.query && req.query.p ? String(req.query.p).slice(0, 12) : null;
  const lista = db.prepare(`SELECT * FROM agendamentos WHERE usuario_id = ? AND status != 'cancelado' AND data >= date('now', '-30 days')
    ${prof ? 'AND (profissional_id = ? OR profissional_id IS NULL)' : ''} ORDER BY data, hora LIMIT 2000`).all(...(prof ? [u.id, prof] : [u.id]));
  const agora = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const linhas = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Flow Solution//Agenda//PT-BR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEsc('Agenda · ' + (u.negocio_nome || u.nome) + (prof && lista[0] && lista.find((a) => a.profissional_id === prof) ? ' · ' + lista.find((a) => a.profissional_id === prof).profissional : ''))}`, 'X-WR-TIMEZONE:America/Sao_Paulo', 'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
  ];
  lista.forEach((a) => {
    linhas.push('BEGIN:VEVENT', `UID:flow-agenda-${a.id}@flowsolution`, `DTSTAMP:${agora}`,
      `DTSTART:${icsData(a.data, a.hora)}`, `DTEND:${icsData(a.data, a.hora, a.duracao)}`,
      `SUMMARY:${icsEsc(`${a.servico} · ${a.nome}${a.profissional ? ` (${a.profissional})` : ''}`)}`,
      `DESCRIPTION:${icsEsc(`WhatsApp: ${a.telefone}${a.obs ? `\nObs.: ${a.obs}` : ''}`)}`,
      'END:VEVENT');
  });
  linhas.push('END:VCALENDAR');
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.send(linhas.join('\r\n'));
}

/* ================= retorno do Google (OAuth) ================= */
async function callbackGoogle(req, res) {
  const volta = (q) => res.redirect(`${SITE_URL}/webflow.html?google=${q}`);
  if (req.query.error) return volta('cancelado');
  try {
    await gcal.concluirConexao(req, String(req.query.code || ''), String(req.query.state || ''));
    volta('ok');
  } catch (e) {
    console.warn('Callback do Google', e.message);
    volta('erro');
  }
}

module.exports = { lojista, publico, feedIcs, callbackGoogle, lerConfig, horariosLivres, agoraBrasilia };
