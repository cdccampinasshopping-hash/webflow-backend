// Notas de compra que entram sozinhas no estoque (plano Premium)
// 1) Por e-mail: cada loja tem um endereço notas-XXXX@<domínio de recebimento do Resend>.
//    O fornecedor manda o XML pra lá e a nota aparece em "Notas para conferir".
// 2) Pela SEFAZ: com o certificado A1 da loja, o servidor consulta de hora em hora as notas
//    emitidas contra o CNPJ e faz a "Ciência da Operação" pra liberar o XML completo.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { lerPfx } = require('../lib/pkcs12');
const sefaz = require('../lib/sefaz');

const RESEND_API = process.env.RESEND_API_URL || 'https://api.resend.com';
const DOMINIO_NOTAS = () => process.env.RESEND_INBOUND_DOMAIN || '';

/* ---------------- cofre: certificado e senha guardados cifrados ---------------- */
function chaveCofre() {
  return crypto.createHash('sha256').update('cofre-notas:' + (process.env.NOTAS_CHAVE || process.env.JWT_SECRET)).digest();
}
function cifrar(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chaveCofre(), iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
function decifrar(txt) {
  const [iv, tagAuth, enc] = String(txt).split('.').map((b) => Buffer.from(b, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', chaveCofre(), iv);
  d.setAuthTag(tagAuth);
  return Buffer.concat([d.update(enc), d.final()]);
}

/* ---------------- guardar uma nota ---------------- */
function salvarNota(usuarioId, xml, origem, resumoPronto) {
  const r = resumoPronto || sefaz.resumoDaNota(xml);
  if (!r.chave || !/^\d{44}$/.test(r.chave)) return null;
  const atual = db.prepare('SELECT * FROM notas_entrada WHERE usuario_id = ? AND chave = ?').get(usuarioId, r.chave);
  const completa = !!(xml && r.completa);
  if (!atual) {
    const status = r.cancelada ? 'cancelada' : completa ? 'pendente' : 'aguardando';
    const info = db.prepare(`INSERT INTO notas_entrada (usuario_id, chave, origem, emitente, cnpj_emitente, numero, valor, emitida_em, xml, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(usuarioId, r.chave, origem, r.emitente, r.cnpjEmitente, r.numero, r.valor, r.emitidaEm, completa ? xml : null, status);
    return { id: info.lastInsertRowid, nova: true };
  }
  // já existia: completa o que faltava, sem mexer no que o lojista já decidiu
  if (completa && !atual.xml) {
    db.prepare(`UPDATE notas_entrada SET xml = ?, status = CASE WHEN status = 'aguardando' THEN 'pendente' ELSE status END,
      emitente = COALESCE(emitente, ?), numero = COALESCE(numero, ?), valor = COALESCE(valor, ?), atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(xml, r.emitente, r.numero, r.valor, atual.id);
  }
  if (r.cancelada && ['aguardando', 'pendente'].includes(atual.status)) {
    db.prepare(`UPDATE notas_entrada SET status = 'cancelada', atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).run(atual.id);
  }
  return { id: atual.id, nova: false };
}

function enderecoEmail(usuarioId) {
  if (!DOMINIO_NOTAS()) return null;
  let u = db.prepare('SELECT notas_email_token FROM usuarios WHERE id = ?').get(usuarioId);
  if (!u) return null;
  if (!u.notas_email_token) {
    const token = crypto.randomBytes(6).toString('hex');
    db.prepare('UPDATE usuarios SET notas_email_token = ? WHERE id = ?').run(token, usuarioId);
    u = { notas_email_token: token };
  }
  return `notas-${u.notas_email_token}@${DOMINIO_NOTAS()}`;
}

/* ---------------- SEFAZ ---------------- */
const HORA = 3600000;
const emAndamento = new Set();

function abrirCertificado(cfg) {
  return lerPfx(decifrar(cfg.certificado), decifrar(cfg.senha).toString('utf8'));
}

async function buscarNaSefaz(usuarioId) {
  if (emAndamento.has(usuarioId)) return { pulou: true };
  emAndamento.add(usuarioId);
  try {
    const cfg = db.prepare('SELECT * FROM sefaz_config WHERE usuario_id = ?').get(usuarioId);
    if (!cfg) return { pulou: true };
    const marcar = (status, esperar, erro) => db.prepare(`UPDATE sefaz_config SET ultimo_status = ?, proxima_consulta = ?, ultima_consulta = CURRENT_TIMESTAMP,
      erros_seguidos = ${erro ? 'erros_seguidos + 1' : '0'} WHERE usuario_id = ?`).run(status, Date.now() + esperar, usuarioId);
    let cert;
    try { cert = abrirCertificado(cfg); } catch (e) { marcar('Não deu pra abrir o certificado. Envie de novo.', 6 * HORA, true); return { erro: true }; }
    if (new Date(cert.validade) < new Date()) { marcar('O certificado venceu. Envie o certificado novo.', 12 * HORA, true); return { erro: true }; }

    let ult = cfg.ult_nsu || '0';
    let novas = 0;
    try {
      // 1) documentos novos pelo NSU (no máximo 10 lotes por vez)
      for (let volta = 0; volta < 10; volta++) {
        const r = await sefaz.distribuicao(cfg, cert, { ultNSU: ult });
        if (r.cStat === '656') { marcar('A SEFAZ pediu pra esperar 1 hora antes de consultar de novo.', HORA + 5 * 60000, false); return { novas }; }
        if (r.cStat !== '137' && r.cStat !== '138') { marcar(`SEFAZ: ${r.cStat} - ${r.xMotivo || 'erro'}`, 3 * HORA, true); return { erro: true }; }
        for (const d of r.docs) {
          if (/^resNFe/.test(d.schema) || /^procNFe/.test(d.schema)) {
            const r = salvarNota(usuarioId, d.xml, 'sefaz');
            if (r && r.nova) novas++;
          } else if (/^resEvento|^procEventoNFe/.test(d.schema) && /<tpEvento>110111<\/tpEvento>/.test(d.xml)) {
            const ch = sefaz.tag(d.xml, 'chNFe');
            if (ch) db.prepare(`UPDATE notas_entrada SET status = 'cancelada' WHERE usuario_id = ? AND chave = ? AND status IN ('aguardando','pendente')`).run(usuarioId, ch);
          }
        }
        if (r.ultNSU) { ult = r.ultNSU; db.prepare('UPDATE sefaz_config SET ult_nsu = ? WHERE usuario_id = ?').run(ult, usuarioId); }
        if (r.cStat === '137' || !r.maxNSU || Number(ult) >= Number(r.maxNSU)) break;
      }
      // 2) ciência da operação nas notas que só vieram em resumo (libera o XML completo)
      const semCiencia = db.prepare(`SELECT id, chave FROM notas_entrada WHERE usuario_id = ? AND status = 'aguardando' AND ciencia = 0 LIMIT 20`).all(usuarioId);
      for (const n of semCiencia) {
        const c = await sefaz.cienciaDaOperacao(cfg, cert, n.chave);
        if (c.ok) db.prepare('UPDATE notas_entrada SET ciencia = 1, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').run(n.id);
      }
      // 3) as que já têm ciência há mais de 2 horas e ainda não chegaram: pede pela chave (até 3 por vez)
      const atrasadas = db.prepare(`SELECT chave FROM notas_entrada WHERE usuario_id = ? AND status = 'aguardando' AND ciencia = 1
        AND atualizado_em <= datetime('now', '-2 hours') LIMIT 3`).all(usuarioId);
      for (const n of atrasadas) {
        const r = await sefaz.distribuicao(cfg, cert, { chave: n.chave });
        r.docs.filter((d) => /^procNFe/.test(d.schema)).forEach((d) => salvarNota(usuarioId, d.xml, 'sefaz'));
        db.prepare(`UPDATE notas_entrada SET atualizado_em = CURRENT_TIMESTAMP WHERE usuario_id = ? AND chave = ?`).run(usuarioId, n.chave);
      }
      marcar(novas ? `${novas} ${novas === 1 ? 'documento novo' : 'documentos novos'} na última consulta.` : 'Consultado. Nenhuma nota nova.', HORA + 5 * 60000, false);
      return { novas };
    } catch (e) {
      marcar('Não deu pra falar com a SEFAZ: ' + e.message, 30 * 60000, true);
      return { erro: true };
    }
  } finally {
    emAndamento.delete(usuarioId);
  }
}

function iniciarBuscaSefaz() {
  const rodar = async () => {
    const lista = db.prepare(`SELECT s.usuario_id FROM sefaz_config s JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.proxima_consulta <= ? AND u.plano = 'premium' ORDER BY s.proxima_consulta LIMIT 20`).all(Date.now());
    for (const l of lista) { try { await buscarNaSefaz(l.usuario_id); } catch (e) { console.error('Busca SEFAZ', e.message); } }
  };
  setTimeout(rodar, 60000);
  setInterval(rodar, 10 * 60000);
}

/* ---------------- rotas do lojista ---------------- */
const lojista = express.Router();
lojista.use((req, res, next) => {
  const u = db.prepare('SELECT plano, is_admin FROM usuarios WHERE id = ?').get(req.usuarioId);
  if (!u || (u.plano !== 'premium' && !u.is_admin)) return res.status(403).json({ erro: 'Entrada automática de notas faz parte do plano Premium.' });
  next();
});

function estadoSefaz(usuarioId) {
  const c = db.prepare('SELECT cnpj, cpf, uf, titular, validade, ultima_consulta, ultimo_status, proxima_consulta FROM sefaz_config WHERE usuario_id = ?').get(usuarioId);
  if (!c) return { configurado: false };
  return { configurado: true, documento: c.cnpj || c.cpf, uf: c.uf, titular: c.titular, validade: c.validade, ultimaConsulta: c.ultima_consulta, status: c.ultimo_status, proxima: c.proxima_consulta };
}

lojista.get('/', (req, res) => {
  const notas = db.prepare(`SELECT id, chave, origem, emitente, cnpj_emitente, numero, valor, emitida_em, status, criado_em, (xml IS NOT NULL) AS tem_xml
    FROM notas_entrada WHERE usuario_id = ? AND (status IN ('aguardando','pendente') OR atualizado_em >= datetime('now','-30 days'))
    ORDER BY CASE status WHEN 'pendente' THEN 0 WHEN 'aguardando' THEN 1 ELSE 2 END, id DESC LIMIT 100`).all(req.usuarioId);
  res.json({ email: enderecoEmail(req.usuarioId), sefaz: estadoSefaz(req.usuarioId), notas });
});

lojista.get('/:id/xml', (req, res) => {
  const n = db.prepare('SELECT xml FROM notas_entrada WHERE id = ? AND usuario_id = ?').get(req.params.id, req.usuarioId);
  if (!n || !n.xml) return res.status(404).json({ erro: 'O XML dessa nota ainda não chegou.' });
  res.json({ xml: n.xml });
});

lojista.patch('/:id', (req, res) => {
  const status = String((req.body || {}).status || '');
  if (!['importada', 'ignorada', 'pendente'].includes(status)) return res.status(400).json({ erro: 'Status inválido.' });
  const info = db.prepare(`UPDATE notas_entrada SET status = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND usuario_id = ? AND (xml IS NOT NULL OR ? = 'ignorada')`)
    .run(status, req.params.id, req.usuarioId, status);
  if (!info.changes) return res.status(404).json({ erro: 'Nota não encontrada.' });
  res.json({ ok: true });
});

// Envio do certificado A1: { arquivo: base64 do .pfx, senha, uf, documento? }
lojista.post('/sefaz', (req, res) => {
  const b = req.body || {};
  const uf = String(b.uf || '').toUpperCase();
  if (!sefaz.UF_CODIGO[uf]) return res.status(400).json({ erro: 'Escolha o estado (UF) da empresa.' });
  let buf;
  try { buf = Buffer.from(String(b.arquivo || ''), 'base64'); } catch (e) { buf = null; }
  if (!buf || buf.length < 200 || buf.length > 200000) return res.status(400).json({ erro: 'Envie o arquivo do certificado A1 (.pfx ou .p12).' });
  const senha = String(b.senha || '');
  let cert;
  try { cert = lerPfx(buf, senha); } catch (e) {
    return res.status(400).json({ erro: e.message === 'SENHA' ? 'Senha do certificado errada.' : e.message });
  }
  if (new Date(cert.validade) < new Date()) return res.status(400).json({ erro: `Esse certificado venceu em ${new Date(cert.validade).toLocaleDateString('pt-BR')}.` });
  const informado = String(b.documento || '').replace(/\D/g, '');
  const cnpj = cert.cnpj || (informado.length === 14 ? informado : null);
  const cpf = !cnpj ? (cert.cpf || (informado.length === 11 ? informado : null)) : null;
  if (!cnpj && !cpf) return res.status(400).json({ erro: 'Não achamos o CNPJ dentro do certificado. Digite o CNPJ da empresa.' });
  if (cert.cnpj && informado.length === 14 && informado.slice(0, 8) !== cert.cnpj.slice(0, 8)) {
    return res.status(400).json({ erro: `Esse certificado é do CNPJ ${cert.cnpj}. Use o certificado da mesma empresa (pode ser matriz ou filial).` });
  }
  const doc = cnpj && informado.length === 14 ? informado : cnpj;
  db.prepare(`INSERT INTO sefaz_config (usuario_id, cnpj, cpf, uf, certificado, senha, titular, validade, ult_nsu, proxima_consulta, ultimo_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0', 0, 'Certificado recebido. A primeira consulta sai em alguns minutos.')
    ON CONFLICT(usuario_id) DO UPDATE SET cnpj = excluded.cnpj, cpf = excluded.cpf, uf = excluded.uf, certificado = excluded.certificado,
      senha = excluded.senha, titular = excluded.titular, validade = excluded.validade, ultimo_status = excluded.ultimo_status, erros_seguidos = 0,
      ult_nsu = CASE WHEN sefaz_config.cnpj IS excluded.cnpj THEN sefaz_config.ult_nsu ELSE '0' END,
      proxima_consulta = MIN(sefaz_config.proxima_consulta, ?)`)
    .run(req.usuarioId, doc, cpf, uf, cifrar(buf), cifrar(Buffer.from(senha, 'utf8')), cert.titular, cert.validade, Date.now() + HORA);
  res.json({ sefaz: estadoSefaz(req.usuarioId) });
});

lojista.delete('/sefaz', (req, res) => {
  db.prepare('DELETE FROM sefaz_config WHERE usuario_id = ?').run(req.usuarioId);
  res.json({ sefaz: { configurado: false } });
});

lojista.post('/sefaz/buscar', async (req, res) => {
  const c = db.prepare('SELECT proxima_consulta FROM sefaz_config WHERE usuario_id = ?').get(req.usuarioId);
  if (!c) return res.status(400).json({ erro: 'Envie o certificado A1 primeiro.' });
  if (c.proxima_consulta > Date.now()) {
    const hora = new Date(c.proxima_consulta).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    return res.status(429).json({ erro: `A SEFAZ só deixa consultar de hora em hora. A próxima busca sai sozinha às ${hora}.` });
  }
  const r = await buscarNaSefaz(req.usuarioId);
  res.json({ ...r, sefaz: estadoSefaz(req.usuarioId) });
});

/* ---------------- e-mail recebido (webhook do Resend) ---------------- */
const publico = express.Router();
let chamadas = [];
async function apiResend(caminho) {
  const r = await fetch(RESEND_API + caminho, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
  if (!r.ok) throw new Error(`Resend ${r.status}`);
  return r.json();
}
async function processarEmail(emailId) {
  if (db.prepare('SELECT 1 FROM emails_recebidos WHERE email_id = ?').get(emailId)) return;
  // busca o e-mail direto no Resend: o que vale é o que está lá, não o que veio no webhook
  const email = await apiResend(`/emails/receiving/${encodeURIComponent(emailId)}`);
  db.prepare('INSERT OR IGNORE INTO emails_recebidos (email_id) VALUES (?)').run(emailId);
  const destinos = [].concat(email.to || [], email.cc || [], email.received_for || []).join(' ');
  const tokens = [...new Set((destinos.match(/notas-([a-f0-9]{12})@/gi) || []).map((m) => m.slice(6, 18).toLowerCase()))];
  const lojas = tokens.map((t) => db.prepare(`SELECT id FROM usuarios WHERE notas_email_token = ? AND plano = 'premium'`).get(t)).filter(Boolean);
  if (!lojas.length) return;
  const anexos = (await apiResend(`/emails/receiving/${encodeURIComponent(emailId)}/attachments`)).data || [];
  for (const a of anexos) {
    if (!/\.xml$/i.test(a.filename || '') && !/xml/i.test(a.content_type || '')) continue;
    if (a.size && a.size > 3 * 1024 * 1024) continue;
    const r = await fetch(a.download_url);
    if (!r.ok) continue;
    const xml = await r.text();
    if (!/<infNFe/.test(xml)) continue;
    lojas.forEach((l) => salvarNota(l.id, xml, 'email'));
  }
}
publico.post('/email', (req, res) => {
  const agora = Date.now();
  chamadas = chamadas.filter((t) => agora - t < 60000);
  if (chamadas.length > 120) return res.status(429).end();
  chamadas.push(agora);
  const b = req.body || {};
  const emailId = b.data && b.data.email_id;
  res.status(200).json({ ok: true });
  if (b.type !== 'email.received' || !emailId || !/^[\w-]{8,80}$/.test(emailId) || !process.env.RESEND_API_KEY) return;
  processarEmail(emailId).catch((e) => console.error('Nota por e-mail', e.message));
});

module.exports = { lojista, publico, iniciarBuscaSefaz, buscarNaSefaz, salvarNota, _teste: { cifrar, decifrar, processarEmail } };
