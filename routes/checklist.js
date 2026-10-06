// Checklist diário do gerente/líder da loja.
// Todo dia o gestor responde cada pergunta anexando um comprovante (foto/print ou PDF).
// O admin da Flow Solution acompanha por dia, semana e mês, e vê o que ficou sem fazer.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');

const PASTA = path.join(db.PASTA_ARQUIVOS, 'checklist');
fs.mkdirSync(PASTA, { recursive: true });

const LIMITE_ARQUIVO = 8 * 1024 * 1024; // 8 MB
const TIPOS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const FUSO = -3; // horário de Brasília

// Perguntas do checklist (todas todo dia). Os ids não mudam, pra não perder o histórico.
const TURNOS = [
  { id: 'manha', titulo: 'Manhã', horario: '09:00 às 10:00', itens: [
    ['m1', 'Conferir se foi enviada a foto de abertura da loja no grupo.'],
    ['m2', 'Enviar mensagem no grupo da loja, ativando o time.'],
    ['m3', 'Analisar no Orbitta a quantidade de agendamentos do dia.'],
    ['m4', 'Conferir no Orbitta a quantidade de novas mensagens.'],
    ['m5', 'Conferir se os vendedores estão utilizando seus próprios logins e sinalizando corretamente as vendas realizadas.'],
    ['m6', 'Conferir os registros e vendas do dia anterior.'],
    ['m7', 'Enviar mensagem no grupo de agendamentos, cobrando e alinhando os pontos identificados na análise do Orbitta.'],
    ['m8', 'Conferir se os vendedores estão enviando o acompanhamento individual no grupo da loja.'],
    ['m9', 'Conversar individualmente com os vendedores para ativá-los e apresentar os dados analisados no Orbitta e nos grupos.'],
    ['m10', 'Com base nos dados analisados, definir estratégias e prioridades para o dia.'],
    ['m11', 'Passar a agenda de treinamentos do dia para os vendedores.'],
  ] },
  { id: 'tarde', titulo: 'Tarde', horario: '16:00', itens: [
    ['t1', 'Enviar parcial no grupo da loja com as vendas por vendedor.'],
    ['t2', 'Verificar quais vendedores estão com poucos agendamentos.'],
    ['t3', 'Verificar novamente a quantidade de novos leads que entraram.'],
    ['t4', 'Conferir quantos leads recorrentes foram respondidos.'],
    ['t5', 'Conferir os grupos internos de agendamentos.'],
    ['t6', 'Verificar a quantidade de agendamentos de cada vendedor.'],
    ['t7', 'Ajustar as estratégias do time de acordo com os resultados parciais.'],
  ] },
  { id: 'noite', titulo: 'Noite', horario: '22:30', itens: [
    ['n1', 'No início da noite, verificar os números e resultados do dia.'],
    ['n2', 'Conferir a escala e identificar os melhores horários para atuação da equipe.'],
    ['n3', 'Conferir o controle de atendimentos.'],
    ['n4', 'Conferir o fechamento do caixa.'],
    ['n5', 'Conferir o vídeo e o grupo do PRT.'],
  ] },
].map((t) => ({ ...t, itens: t.itens.map(([id, texto]) => ({ id, texto })) }));
const ITENS = TURNOS.flatMap((t) => t.itens.map((i) => ({ ...i, turno: t.id })));
const ITEM_POR_ID = new Map(ITENS.map((i) => [i.id, i]));
const TOTAL = ITENS.length;

// ---------------- banco ----------------
try { db.exec(`ALTER TABLE usuarios ADD COLUMN checklist_ativo INTEGER NOT NULL DEFAULT 0`); }
catch (e) { /* coluna já existe, tudo bem */ }
try { db.exec(`ALTER TABLE usuarios ADD COLUMN checklist_desde TEXT`); }
catch (e) { /* coluna já existe, tudo bem */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS checklist_respostas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    data TEXT NOT NULL,
    item_id TEXT NOT NULL,
    arquivo TEXT NOT NULL,
    mime TEXT NOT NULL,
    nome_arquivo TEXT,
    obs TEXT,
    criado_em TEXT DEFAULT (datetime('now')),
    UNIQUE (usuario_id, data, item_id)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS checklist_dias (
    usuario_id INTEGER NOT NULL,
    data TEXT NOT NULL,
    gestor TEXT,
    observacoes TEXT,
    avaliacao TEXT,
    avaliacao_obs TEXT,
    avaliado_em TEXT,
    atualizado_em TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (usuario_id, data)
  )
`);
// Todos os comprovantes (uma pergunta pode ter vários). checklist_respostas guarda 1 linha por pergunta respondida.
db.exec(`
  CREATE TABLE IF NOT EXISTS checklist_arquivos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    data TEXT NOT NULL,
    item_id TEXT NOT NULL,
    arquivo TEXT NOT NULL,
    mime TEXT NOT NULL,
    nome_arquivo TEXT,
    criado_em TEXT DEFAULT (datetime('now'))
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_ck_arquivos ON checklist_arquivos(usuario_id, data, item_id)`);
// Comprovantes enviados antes de existir a tabela de vários arquivos
db.exec(`INSERT INTO checklist_arquivos (usuario_id, data, item_id, arquivo, mime, nome_arquivo, criado_em)
  SELECT r.usuario_id, r.data, r.item_id, r.arquivo, r.mime, r.nome_arquivo, r.criado_em FROM checklist_respostas r
  WHERE NOT EXISTS (SELECT 1 FROM checklist_arquivos a WHERE a.usuario_id = r.usuario_id AND a.data = r.data AND a.item_id = r.item_id)`);
const MAX_ARQUIVOS = 10;
db.exec(`CREATE TABLE IF NOT EXISTS checklist_avisos (data TEXT PRIMARY KEY, enviado_em TEXT DEFAULT (datetime('now')))`);

// ---------------- datas (sempre no horário de Brasília) ----------------
function hojeBrasilia() { return new Date(Date.now() + FUSO * 3600000).toISOString().slice(0, 10); }
function somaDias(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function dataValida(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(Date.parse(v + 'T12:00:00Z')); }
function paraHoraBrasilia(sqlUtc) {
  if (!sqlUtc) return null;
  const d = new Date(sqlUtc.replace(' ', 'T') + 'Z');
  return new Date(d.getTime() + FUSO * 3600000).toISOString().slice(11, 16);
}
// Intervalo do período que contém "data": dia, semana (segunda a domingo) ou mês
function intervalo(periodo, data) {
  if (periodo === 'semana') {
    const dow = (new Date(data + 'T12:00:00Z').getUTCDay() + 6) % 7; // 0 = segunda
    const ini = somaDias(data, -dow);
    return { ini, fim: somaDias(ini, 6) };
  }
  if (periodo === 'mes') {
    const ini = data.slice(0, 8) + '01';
    const d = new Date(ini + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0);
    return { ini, fim: d.toISOString().slice(0, 10) };
  }
  return { ini: data, fim: data };
}
function diasEntre(ini, fim) { const out = []; for (let d = ini; d <= fim; d = somaDias(d, 1)) out.push(d); return out; }

// ---------------- arquivos ----------------
function lerArquivo(req, res, next) {
  const declarado = parseInt(req.get('content-length'), 10);
  const msg = 'O comprovante passou de 8 MB. Mande uma foto ou PDF menor.';
  if (declarado > LIMITE_ARQUIVO) return res.status(413).json({ erro: msg });
  const partes = []; let total = 0; let estourou = false;
  req.on('data', (c) => { total += c.length; if (total > LIMITE_ARQUIVO) { estourou = true; partes.length = 0; return; } partes.push(c); });
  req.on('end', () => { if (estourou) return res.status(413).json({ erro: msg }); req.body = Buffer.concat(partes); next(); });
  req.on('error', () => res.status(400).json({ erro: 'Falha ao receber o arquivo.' }));
}
function apagarArquivo(nome) {
  if (!nome || nome.includes('/') || nome.includes('..')) return;
  fs.unlink(path.join(PASTA, nome), () => {});
}
function enviarArquivo(res, r) {
  const arquivo = path.join(PASTA, r.arquivo);
  fs.stat(arquivo, (err, st) => {
    if (err || !st.isFile()) return res.status(404).json({ erro: 'Arquivo não encontrado.' });
    res.set('Content-Type', r.mime);
    res.set('Content-Length', String(st.size));
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('Content-Disposition', `inline; filename="comprovante-${r.data}-${r.item_id}.${TIPOS[r.mime] || 'bin'}"`);
    fs.createReadStream(arquivo).pipe(res);
  });
}

// ---------------- montagem dos dados ----------------
function arquivosDe(usuarioId, data, itemId) {
  const sql = 'SELECT id, item_id, mime, nome_arquivo, criado_em FROM checklist_arquivos WHERE usuario_id = ? AND data = ?' + (itemId ? ' AND item_id = ?' : '') + ' ORDER BY id';
  return db.prepare(sql).all(...[usuarioId, data].concat(itemId ? [itemId] : []))
    .map((a) => ({ id: a.id, item_id: a.item_id, mime: a.mime, nome: a.nome_arquivo, hora: paraHoraBrasilia(a.criado_em) }));
}
function respostaJson(r, arquivos) {
  return { id: r.id, item_id: r.item_id, data: r.data, obs: r.obs, hora: paraHoraBrasilia(r.criado_em), arquivos: (arquivos || []).filter((a) => a.item_id === r.item_id) };
}
function respostaDoItem(usuarioId, data, itemId) {
  const r = db.prepare('SELECT * FROM checklist_respostas WHERE usuario_id = ? AND data = ? AND item_id = ?').get(usuarioId, data, itemId);
  return r ? respostaJson(r, arquivosDe(usuarioId, data, itemId)) : null;
}
function detalheDoDia(usuarioId, data) {
  const arquivos = arquivosDe(usuarioId, data);
  const respostas = db.prepare('SELECT * FROM checklist_respostas WHERE usuario_id = ? AND data = ?').all(usuarioId, data).map((r) => respostaJson(r, arquivos));
  const dia = db.prepare('SELECT gestor, observacoes, avaliacao, avaliacao_obs, avaliado_em FROM checklist_dias WHERE usuario_id = ? AND data = ?').get(usuarioId, data) || {};
  return { data, respostas, dia };
}

// Resumo por loja e por dia num intervalo. Dias que ainda não acabaram não contam como falta.
function resumo(lojas, ini, fim) {
  const hoje = hojeBrasilia();
  const fimReal = fim > hoje ? hoje : fim;
  const ids = lojas.map((l) => l.id);
  if (!ids.length || ini > fimReal) return lojas.map((l) => ({ ...l, dias: [], esperadas: 0, feitas: 0, faltas: 0 }));
  const marc = ids.map(() => '?').join(',');
  const contagens = db.prepare(`SELECT usuario_id, data, COUNT(*) AS n, GROUP_CONCAT(item_id) AS itens FROM checklist_respostas
    WHERE usuario_id IN (${marc}) AND data >= ? AND data <= ? GROUP BY usuario_id, data`).all(...ids, ini, fimReal);
  const avals = db.prepare(`SELECT usuario_id, data, avaliacao, gestor FROM checklist_dias
    WHERE usuario_id IN (${marc}) AND data >= ? AND data <= ?`).all(...ids, ini, fimReal);
  const porChave = new Map(contagens.map((c) => [c.usuario_id + '|' + c.data, c]));
  const avPorChave = new Map(avals.map((a) => [a.usuario_id + '|' + a.data, a]));
  return lojas.map((l) => {
    const desde = l.checklist_desde || ini;
    const dias = diasEntre(ini, fimReal).filter((d) => d >= desde).map((d) => {
      const c = porChave.get(l.id + '|' + d);
      const a = avPorChave.get(l.id + '|' + d) || {};
      const feitosSet = new Set(c ? c.itens.split(',') : []);
      const feitas = ITENS.filter((i) => feitosSet.has(i.id)).length;
      const emAndamento = d === hoje;
      const faltando = ITENS.filter((i) => !feitosSet.has(i.id)).map((i) => i.id);
      return { data: d, feitas, total: TOTAL, em_andamento: emAndamento, faltando: emAndamento ? [] : faltando, pendentes: faltando.length, avaliacao: a.avaliacao || null, gestor: a.gestor || null };
    });
    const fechados = dias.filter((d) => !d.em_andamento);
    const esperadas = fechados.length * TOTAL;
    const feitas = fechados.reduce((s, d) => s + d.feitas, 0);
    return { ...l, dias, esperadas, feitas, faltas: esperadas - feitas };
  });
}

function lojasAtivas() {
  return db.prepare(`SELECT id, nome, email, negocio_nome, checklist_desde FROM usuarios
    WHERE checklist_ativo = 1 AND is_admin = 0 AND cargo IN ('lojista', 'checklist') ORDER BY COALESCE(negocio_nome, nome)`).all();
}

// ---------------- rotas do lojista ----------------
const lojista = express.Router();

lojista.use((req, res, next) => {
  const u = db.prepare('SELECT checklist_ativo, cargo FROM usuarios WHERE id = ?').get(req.usuarioId);
  if (!u || !u.checklist_ativo) return res.status(403).json({ erro: 'O checklist diário não está ativado pra sua conta. Fale com a Flow Solution.' });
  next();
});

lojista.get('/modelo', (req, res) => res.json({ turnos: TURNOS, total: TOTAL, hoje: hojeBrasilia() }));

lojista.get('/hoje', (req, res) => {
  const hoje = hojeBrasilia();
  const det = detalheDoDia(req.usuarioId, hoje);
  if (!det.dia.gestor) {
    const ultimo = db.prepare('SELECT gestor FROM checklist_dias WHERE usuario_id = ? AND gestor IS NOT NULL ORDER BY data DESC LIMIT 1').get(req.usuarioId);
    det.gestorSugerido = ultimo ? ultimo.gestor : null;
  }
  res.json({ turnos: TURNOS, total: TOTAL, hoje, ...det });
});

// Adiciona um comprovante numa pergunta de hoje (pode ter vários). Corpo = o arquivo; ?obs= texto opcional
function adicionarArquivo(req, res) {
  const item = ITEM_POR_ID.get(req.params.item);
  if (!item) return res.status(404).json({ erro: 'Pergunta não encontrada.' });
  const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!TIPOS[mime]) return res.status(400).json({ erro: 'Mande uma foto (JPG, PNG, WEBP) ou um PDF.' });
  if (!req.body || !req.body.length) return res.status(400).json({ erro: 'Arquivo vazio.' });
  const hoje = hojeBrasilia();
  const qtd = db.prepare('SELECT COUNT(*) AS n FROM checklist_arquivos WHERE usuario_id = ? AND data = ? AND item_id = ?').get(req.usuarioId, hoje, item.id).n;
  if (qtd >= MAX_ARQUIVOS) return res.status(400).json({ erro: `Cada pergunta aceita até ${MAX_ARQUIVOS} comprovantes.` });

  const nome = `${req.usuarioId}-${hoje}-${item.id}-${crypto.randomBytes(6).toString('hex')}.${TIPOS[mime]}`;
  fs.writeFileSync(path.join(PASTA, nome), req.body);
  let nomeOriginal = String(req.get('x-nome-arquivo') || '').slice(0, 200);
  try { nomeOriginal = decodeURIComponent(nomeOriginal).slice(0, 120); } catch (e) { nomeOriginal = ''; }
  const temObs = req.query.obs !== undefined;
  const obs = String(req.query.obs || '').trim().slice(0, 600) || null;

  db.prepare('INSERT INTO checklist_arquivos (usuario_id, data, item_id, arquivo, mime, nome_arquivo) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.usuarioId, hoje, item.id, nome, mime, nomeOriginal || null);
  db.prepare(`INSERT INTO checklist_respostas (usuario_id, data, item_id, arquivo, mime, nome_arquivo, obs) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (usuario_id, data, item_id) DO UPDATE SET obs = CASE WHEN ? THEN excluded.obs ELSE checklist_respostas.obs END`)
    .run(req.usuarioId, hoje, item.id, nome, mime, nomeOriginal || null, obs, temObs ? 1 : 0);
  res.json({ resposta: respostaDoItem(req.usuarioId, hoje, item.id) });
}
lojista.post('/hoje/:item', lerArquivo, adicionarArquivo);
lojista.put('/hoje/:item', lerArquivo, adicionarArquivo); // versão antiga do painel

// Muda só a observação da pergunta
lojista.patch('/hoje/:item', (req, res) => {
  const hoje = hojeBrasilia();
  const obs = String((req.body || {}).obs || '').trim().slice(0, 600) || null;
  const r = db.prepare('UPDATE checklist_respostas SET obs = ? WHERE usuario_id = ? AND data = ? AND item_id = ?').run(obs, req.usuarioId, hoje, req.params.item);
  if (!r.changes) return res.status(404).json({ erro: 'Mande pelo menos um comprovante antes.' });
  res.json({ resposta: respostaDoItem(req.usuarioId, hoje, req.params.item) });
});

// Tira um comprovante. Se era o último, a pergunta volta a ficar pendente. Só no próprio dia.
lojista.delete('/hoje/:item/arquivo/:id', (req, res) => {
  const hoje = hojeBrasilia();
  const a = db.prepare('SELECT id, arquivo FROM checklist_arquivos WHERE id = ? AND usuario_id = ? AND data = ? AND item_id = ?').get(req.params.id, req.usuarioId, hoje, req.params.item);
  if (!a) return res.status(404).json({ erro: 'Comprovante não encontrado.' });
  db.prepare('DELETE FROM checklist_arquivos WHERE id = ?').run(a.id);
  apagarArquivo(a.arquivo);
  const resta = db.prepare('SELECT COUNT(*) AS n FROM checklist_arquivos WHERE usuario_id = ? AND data = ? AND item_id = ?').get(req.usuarioId, hoje, req.params.item).n;
  if (!resta) db.prepare('DELETE FROM checklist_respostas WHERE usuario_id = ? AND data = ? AND item_id = ?').run(req.usuarioId, hoje, req.params.item);
  res.json({ resposta: resta ? respostaDoItem(req.usuarioId, hoje, req.params.item) : null });
});

// Apaga a resposta inteira da pergunta (todos os comprovantes). Só no próprio dia.
lojista.delete('/hoje/:item', (req, res) => {
  const hoje = hojeBrasilia();
  const arqs = db.prepare('SELECT id, arquivo FROM checklist_arquivos WHERE usuario_id = ? AND data = ? AND item_id = ?').all(req.usuarioId, hoje, req.params.item);
  const r = db.prepare('DELETE FROM checklist_respostas WHERE usuario_id = ? AND data = ? AND item_id = ?').run(req.usuarioId, hoje, req.params.item);
  if (!r.changes && !arqs.length) return res.status(404).json({ erro: 'Essa pergunta ainda não tem comprovante hoje.' });
  db.prepare('DELETE FROM checklist_arquivos WHERE usuario_id = ? AND data = ? AND item_id = ?').run(req.usuarioId, hoje, req.params.item);
  arqs.forEach((a) => apagarArquivo(a.arquivo));
  res.json({ ok: true });
});

// Nome do gerente/líder e observações/estratégias do dia
lojista.put('/hoje', (req, res) => {
  const hoje = hojeBrasilia();
  const gestor = String((req.body || {}).gestor || '').trim().slice(0, 80) || null;
  const observacoes = String((req.body || {}).observacoes || '').trim().slice(0, 3000) || null;
  db.prepare(`INSERT INTO checklist_dias (usuario_id, data, gestor, observacoes) VALUES (?, ?, ?, ?)
    ON CONFLICT (usuario_id, data) DO UPDATE SET gestor = excluded.gestor, observacoes = excluded.observacoes, atualizado_em = datetime('now')`)
    .run(req.usuarioId, hoje, gestor, observacoes);
  res.json({ ok: true });
});

// Histórico da própria loja: ?periodo=dia|semana|mes&data=YYYY-MM-DD
lojista.get('/relatorio', (req, res) => {
  const periodo = ['dia', 'semana', 'mes'].includes(req.query.periodo) ? req.query.periodo : 'semana';
  const data = dataValida(req.query.data) ? req.query.data : hojeBrasilia();
  const { ini, fim } = intervalo(periodo, data);
  const u = db.prepare('SELECT id, nome, negocio_nome, checklist_desde FROM usuarios WHERE id = ?').get(req.usuarioId);
  res.json({ periodo, ini, fim, hoje: hojeBrasilia(), loja: resumo([u], ini, fim)[0] });
});

lojista.get('/dia/:data', (req, res) => {
  if (!dataValida(req.params.data)) return res.status(400).json({ erro: 'Data inválida.' });
  res.json(detalheDoDia(req.usuarioId, req.params.data));
});

lojista.get('/arquivo/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM checklist_arquivos WHERE id = ? AND usuario_id = ?').get(req.params.id, req.usuarioId);
  if (!r) return res.status(404).json({ erro: 'Arquivo não encontrado.' });
  enviarArquivo(res, r);
});

// ---------------- rotas do admin ----------------
const admin = express.Router();

admin.get('/modelo', (req, res) => res.json({ turnos: TURNOS, total: TOTAL, hoje: hojeBrasilia() }));

// ---------- usuários do checklist (o controle e o admin criam as contas de quem preenche) ----------
const bcrypt = require('bcryptjs');
function usuarioChecklistJson(u) {
  return { id: u.id, nome: u.nome, email: u.email, negocio_nome: u.negocio_nome, checklist_ativo: u.checklist_ativo, checklist_desde: u.checklist_desde, criado_em: u.criado_em };
}

admin.get('/usuarios', (req, res) => {
  const usuarios = db.prepare(`SELECT id, nome, email, negocio_nome, checklist_ativo, checklist_desde, criado_em FROM usuarios
    WHERE cargo = 'checklist' AND is_admin = 0 ORDER BY COALESCE(negocio_nome, nome)`).all();
  res.json({ usuarios: usuarios.map(usuarioChecklistJson) });
});

// Cria a conta de quem vai preencher o checklist (sempre com o cargo "checklist")
admin.post('/usuarios', (req, res) => {
  const b = req.body || {};
  const nome = String(b.nome || '').trim().slice(0, 80);
  const email = String(b.email || '').trim().toLowerCase().slice(0, 120);
  const loja = String(b.negocio_nome || '').trim().slice(0, 80);
  const senha = String(b.senha || '');
  if (!nome || !email || !loja) return res.status(400).json({ erro: 'Preencha nome, loja e e-mail.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ erro: 'E-mail inválido.' });
  if (senha.length < 6) return res.status(400).json({ erro: 'A senha precisa ter pelo menos 6 caracteres.' });
  if (email === String(process.env.ADMIN_EMAIL || '').toLowerCase().trim()) return res.status(400).json({ erro: 'Esse e-mail é da conta administrativa.' });
  try {
    const r = db.prepare(`INSERT INTO usuarios (nome, email, senha_hash, negocio_nome, segmento, plano, cargo, checklist_ativo, checklist_desde)
      VALUES (?, ?, ?, ?, 'comercio', 'basico', 'checklist', 1, ?)`).run(nome, email, bcrypt.hashSync(senha, 10), loja, hojeBrasilia());
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(r.lastInsertRowid);
    res.status(201).json({ usuario: usuarioChecklistJson(u) });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ erro: 'Já existe uma conta com esse e-mail.' });
    console.error(e);
    res.status(500).json({ erro: 'Não foi possível criar o usuário.' });
  }
});

// Nova senha / ativar ou pausar — só pra contas com cargo "checklist"
admin.patch('/usuarios/:id', (req, res) => {
  const u = db.prepare("SELECT id FROM usuarios WHERE id = ? AND cargo = 'checklist' AND is_admin = 0").get(req.params.id);
  if (!u) return res.status(404).json({ erro: 'Usuário do checklist não encontrado.' });
  const b = req.body || {};
  if (b.senha !== undefined) {
    if (String(b.senha).length < 6) return res.status(400).json({ erro: 'A senha precisa ter pelo menos 6 caracteres.' });
    db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(b.senha), 10), u.id);
  }
  if (b.ativo !== undefined) {
    // Ao reativar, as faltas voltam a contar a partir de hoje (o período pausado não conta)
    const atual = db.prepare('SELECT checklist_ativo FROM usuarios WHERE id = ?').get(u.id);
    if (b.ativo && !atual.checklist_ativo) db.prepare('UPDATE usuarios SET checklist_ativo = 1, checklist_desde = ? WHERE id = ?').run(hojeBrasilia(), u.id);
    if (!b.ativo) db.prepare('UPDATE usuarios SET checklist_ativo = 0 WHERE id = ?').run(u.id);
  }
  if (b.negocio_nome !== undefined && String(b.negocio_nome).trim()) db.prepare('UPDATE usuarios SET negocio_nome = ? WHERE id = ?').run(String(b.negocio_nome).trim().slice(0, 80), u.id);
  res.json({ usuario: usuarioChecklistJson(db.prepare('SELECT * FROM usuarios WHERE id = ?').get(u.id)) });
});

// Relatório de todas as lojas com checklist: ?periodo=dia|semana|mes&data=YYYY-MM-DD
admin.get('/relatorio', (req, res) => {
  const periodo = ['dia', 'semana', 'mes'].includes(req.query.periodo) ? req.query.periodo : 'dia';
  const data = dataValida(req.query.data) ? req.query.data : hojeBrasilia();
  const { ini, fim } = intervalo(periodo, data);
  res.json({ periodo, ini, fim, hoje: hojeBrasilia(), total: TOTAL, lojas: resumo(lojasAtivas(), ini, fim) });
});

admin.get('/loja/:id/dia/:data', (req, res) => {
  if (!dataValida(req.params.data)) return res.status(400).json({ erro: 'Data inválida.' });
  const u = db.prepare('SELECT id, nome, negocio_nome FROM usuarios WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ erro: 'Loja não encontrada.' });
  res.json({ loja: u, turnos: TURNOS, hoje: hojeBrasilia(), ...detalheDoDia(u.id, req.params.data) });
});

// Avaliação do admin sobre o dia da loja
admin.patch('/loja/:id/dia/:data', (req, res) => {
  if (!dataValida(req.params.data)) return res.status(400).json({ erro: 'Data inválida.' });
  const validas = ['ok', 'ressalvas', 'reprovado'];
  const avaliacao = validas.includes((req.body || {}).avaliacao) ? req.body.avaliacao : null;
  const obs = String((req.body || {}).obs || '').trim().slice(0, 1000) || null;
  db.prepare(`INSERT INTO checklist_dias (usuario_id, data, avaliacao, avaliacao_obs, avaliado_em) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT (usuario_id, data) DO UPDATE SET avaliacao = excluded.avaliacao, avaliacao_obs = excluded.avaliacao_obs, avaliado_em = excluded.avaliado_em`)
    .run(req.params.id, req.params.data, avaliacao, obs);
  res.json({ ok: true, avaliacao, avaliacao_obs: obs });
});

admin.get('/arquivo/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM checklist_arquivos WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ erro: 'Arquivo não encontrado.' });
  enviarArquivo(res, r);
});

// Liga/desliga o checklist pra um cliente (só o admin, não o controle)
admin.patch('/clientes/:id', (req, res) => {
  if (!req.ehAdmin) return res.status(403).json({ erro: 'Só o admin pode ligar ou desligar o checklist.' });
  const u = db.prepare('SELECT id, checklist_ativo, checklist_desde FROM usuarios WHERE id = ? AND is_admin = 0').get(req.params.id);
  if (!u) return res.status(404).json({ erro: 'Cliente não encontrado.' });
  const ativo = (req.body || {}).ativo ? 1 : 0;
  // Ao ligar, as faltas só contam a partir de hoje
  const desde = ativo && !u.checklist_ativo ? hojeBrasilia() : u.checklist_desde;
  db.prepare('UPDATE usuarios SET checklist_ativo = ?, checklist_desde = ? WHERE id = ?').run(ativo, desde, u.id);
  res.json({ id: u.id, checklist_ativo: ativo, checklist_desde: desde });
});

// Usado ao excluir um cliente
function apagarDoCliente(usuarioId) {
  db.prepare('SELECT arquivo FROM checklist_arquivos WHERE usuario_id = ?').all(usuarioId).forEach((r) => apagarArquivo(r.arquivo));
  db.prepare('DELETE FROM checklist_arquivos WHERE usuario_id = ?').run(usuarioId);
  db.prepare('DELETE FROM checklist_respostas WHERE usuario_id = ?').run(usuarioId);
  db.prepare('DELETE FROM checklist_dias WHERE usuario_id = ?').run(usuarioId);
}

module.exports = { lojista, admin, TURNOS, ITEM_POR_ID, TOTAL, resumo, lojasAtivas, hojeBrasilia, somaDias, apagarDoCliente };
