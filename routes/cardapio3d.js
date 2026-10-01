// Cardápio 3D (plano Premium)
// Cada prato tem nome, preço, foto e um modelo 3D (.glb). O cliente final abre o cardápio pelo
// link/QR da loja e vê o prato em 3D, ou na mesa pela câmera (realidade aumentada).
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { lojaPorCodigo } = require('../placas');

const PASTA = db.PASTA_ARQUIVOS;
fs.mkdirSync(PASTA, { recursive: true });

const LIMITE_MODELO = 25 * 1024 * 1024; // 25 MB
const LIMITE_FOTO = 4 * 1024 * 1024;    // 4 MB
const MAX_PRATOS = 80;
const TIPOS_FOTO = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// Lê o corpo da requisição como arquivo (Buffer), com limite de tamanho
function lerArquivo(limite, msgGrande) {
  return (req, res, next) => {
    const declarado = parseInt(req.get('content-length'), 10);
    if (declarado > limite) return res.status(413).json({ erro: msgGrande });
    const partes = []; let total = 0; let estourou = false;
    req.on('data', (c) => {
      total += c.length;
      if (total > limite) { estourou = true; partes.length = 0; return; }
      partes.push(c);
    });
    req.on('end', () => {
      if (estourou) return res.status(413).json({ erro: msgGrande });
      req.body = Buffer.concat(partes);
      next();
    });
    req.on('error', () => res.status(400).json({ erro: 'Falha ao receber o arquivo.' }));
  };
}

function baseUrl(req) {
  return process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
}

function urlArquivo(req, nome) {
  return nome ? `${baseUrl(req)}/arquivos/${nome}` : null;
}

function apagarArquivo(nome) {
  if (!nome || nome.includes('/') || nome.includes('..')) return;
  fs.unlink(path.join(PASTA, nome), () => {});
}

function salvarArquivo(prefixo, ext, buffer) {
  const nome = `${prefixo}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(PASTA, nome), buffer);
  return nome;
}

function limparTexto(v, max) {
  const t = String(v == null ? '' : v).trim().slice(0, max);
  return t || null;
}

function lerPreco(v) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 && n < 100000 ? Math.round(n * 100) / 100 : undefined;
}

/* ---------- configurações de pedido da loja ---------- */
const CONFIG_PADRAO = {
  aceitaPedidos: false, mesa: true, retirada: false, entrega: false, taxaEntrega: 0, whatsapp: '',
  // dados da loja (rota de entregas e robô de atendimento)
  endereco: '', cidade: '',
  roboAtivo: false, horario: '', pagamentosTxt: '', tempoEntrega: '', faq: [],
  garcons: [], // [{ id, nome, pinHash }] — app do garçom
};

/* ---------- app do garçom: PIN e sessão ---------- */
function hashPin(donoId, pin) {
  return crypto.createHash('sha256').update(`${process.env.JWT_SECRET}:${donoId}:${pin}`).digest('hex');
}
function tokenGarcom(donoId, g) {
  const corpo = Buffer.from(JSON.stringify({ u: donoId, g: g.id, n: g.nome, exp: Date.now() + 14 * 3600000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(corpo).digest('base64url');
  return `${corpo}.${sig}`;
}
// O app do garçom manda "Authorization: Garcom <token>"
function tokenDoPedido(req) {
  const h = String(req.get('authorization') || '');
  return h.startsWith('Garcom ') ? h.slice(7) : '';
}
function lerTokenGarcom(token, donoId) {
  const [corpo, sig] = String(token || '').split('.');
  if (!corpo || !sig) return null;
  const esperado = crypto.createHmac('sha256', process.env.JWT_SECRET).update(corpo).digest('base64url');
  if (sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
  try {
    const d = JSON.parse(Buffer.from(corpo, 'base64url').toString());
    if (d.u !== donoId || d.exp < Date.now()) return null;
    return d;
  } catch (e) { return null; }
}
function lerConfig(texto) {
  let c = {};
  try { c = JSON.parse(texto || '{}') || {}; } catch (e) { c = {}; }
  return { ...CONFIG_PADRAO, ...c };
}
// Só mexe nos campos que vieram no pedido; o resto da configuração continua como estava
function limparConfig(b, atual, donoId) {
  const c = { ...atual };
  const tem = (k) => Object.prototype.hasOwnProperty.call(b, k);
  ['aceitaPedidos', 'mesa', 'retirada', 'entrega', 'roboAtivo'].forEach((k) => { if (tem(k)) c[k] = !!b[k]; });
  if (tem('taxaEntrega')) { const t = lerPreco(b.taxaEntrega); c.taxaEntrega = t === undefined || t === null ? 0 : t; }
  if (tem('whatsapp')) {
    const tel = String(b.whatsapp || '').replace(/\D/g, '').slice(0, 13);
    c.whatsapp = tel.length >= 10 ? (tel.length <= 11 ? '55' + tel : tel) : '';
  }
  const textos = { endereco: 160, cidade: 60, horario: 300, pagamentosTxt: 200, tempoEntrega: 80 };
  Object.keys(textos).forEach((k) => { if (tem(k)) c[k] = String(b[k] || '').trim().slice(0, textos[k]); });
  if (tem('garcons')) {
    const antigos = new Map((atual.garcons || []).map((g) => [String(g.id), g]));
    c.garcons = (Array.isArray(b.garcons) ? b.garcons : []).slice(0, 50).map((g) => {
      const id = String((g && g.id) || '').slice(0, 20);
      const nome = String((g && g.nome) || '').trim().slice(0, 40);
      const pin = String((g && g.pin) || '').replace(/\D/g, '');
      const velho = antigos.get(id);
      const pinHash = pin.length >= 4 && pin.length <= 6 ? hashPin(donoId, pin) : (velho && velho.pinHash) || null;
      return { id, nome, pinHash };
    }).filter((g) => g.id && g.nome && g.pinHash);
  }
  if (tem('faq')) {
    c.faq = (Array.isArray(b.faq) ? b.faq : []).slice(0, 12)
      .map((f) => ({ p: String((f && f.p) || '').trim().slice(0, 120), r: String((f && f.r) || '').trim().slice(0, 500) }))
      .filter((f) => f.p && f.r);
  }
  return c;
}
// Nunca manda o hash do PIN pro navegador
function configSegura(c) {
  return { ...c, garcons: (c.garcons || []).map((g) => ({ id: g.id, nome: g.nome, temPin: !!g.pinHash })) };
}
const STATUS = ['novo', 'preparo', 'pronto', 'entregue', 'cancelado'];

function pedidoParaJson(p) {
  return {
    id: p.id, itens: JSON.parse(p.itens), subtotal: p.subtotal, taxa: p.taxa, total: p.total,
    modo: p.modo, mesa: p.mesa, nome: p.nome, telefone: p.telefone, endereco: p.endereco,
    pagamento: p.pagamento, troco: p.troco, obs: p.obs, status: p.status, criado_em: p.criado_em, garcom: p.garcom || null,
  };
}

function pratoParaJson(req, p) {
  return {
    id: p.id, nome: p.nome, descricao: p.descricao, categoria: p.categoria, preco: p.preco,
    ordem: p.ordem, ativo: !!p.ativo, visualizacoes: p.visualizacoes,
    modelo: urlArquivo(req, p.modelo), foto: urlArquivo(req, p.foto),
  };
}

/* -------- rotas de gestão: o próprio lojista (Premium) ou o admin em nome de um cliente -------- */
// donoDe(req) devolve o id do lojista dono do cardápio
function rotasGestao(donoDe) {
  const r = express.Router();

  r.use((req, res, next) => {
    if (!db.prepare('SELECT 1 FROM usuarios WHERE id = ?').get(donoDe(req))) return res.status(404).json({ erro: 'Conta não encontrada.' });
    next();
  });

  const pratoDoDono = (req, res) => {
    const p = db.prepare('SELECT * FROM pratos_3d WHERE id = ? AND usuario_id = ?').get(req.params.id, donoDe(req));
    if (!p) res.status(404).json({ erro: 'Prato não encontrado.' });
    return p;
  };

  r.get('/', (req, res) => {
    const dono = db.prepare('SELECT id, nome, negocio_nome, codigo_nfc, plano, cardapio_config FROM usuarios WHERE id = ?').get(donoDe(req));
    if (!dono) return res.status(404).json({ erro: 'Conta não encontrada.' });
    const pratos = db.prepare('SELECT * FROM pratos_3d WHERE usuario_id = ? ORDER BY ordem, id').all(dono.id);
    res.json({
      loja: { nome: dono.negocio_nome || dono.nome, codigo: dono.codigo_nfc, plano: dono.plano },
      qr: dono.codigo_nfc ? `${baseUrl(req)}/qr-cardapio/${dono.codigo_nfc}.png` : null,
      config: configSegura(lerConfig(dono.cardapio_config)),
      pratos: pratos.map((p) => pratoParaJson(req, p)),
    });
  });

  r.put('/config', (req, res) => {
    const atual = lerConfig((db.prepare('SELECT cardapio_config FROM usuarios WHERE id = ?').get(donoDe(req)) || {}).cardapio_config);
    const c = limparConfig(req.body || {}, atual, donoDe(req));
    const repetido = (c.garcons || []).find((g, i, l) => l.some((h, j) => j !== i && h.pinHash === g.pinHash));
    if (repetido) return res.status(400).json({ erro: 'Dois garçons estão com o mesmo PIN. Cada um precisa de um PIN diferente.' });
    if (c.aceitaPedidos && !c.mesa && !c.retirada && !c.entrega) {
      return res.status(400).json({ erro: 'Escolha pelo menos um jeito de receber pedido: na mesa, retirada ou entrega.' });
    }
    db.prepare('UPDATE usuarios SET cardapio_config = ? WHERE id = ?').run(JSON.stringify(c), donoDe(req));
    res.json({ config: configSegura(c) });
  });

  // Pedidos feitos pelo cardápio digital. ?pendentes=1 traz só os que o painel ainda não puxou.
  r.get('/pedidos', (req, res) => {
    const pend = req.query.pendentes === '1';
    const lista = db.prepare(`SELECT * FROM pedidos_online WHERE usuario_id = ? ${pend ? 'AND importado = 0' : ''} ORDER BY id DESC LIMIT 100`).all(donoDe(req));
    res.json({ pedidos: lista.map(pedidoParaJson) });
  });

  // CRM: clientes que já pediram pelo cardápio, agrupados pelo telefone
  r.get('/clientes', (req, res) => {
    const linhas = db.prepare(`SELECT nome, telefone, endereco, total, criado_em, novidades, modo, status
      FROM pedidos_online WHERE usuario_id = ? AND telefone IS NOT NULL AND status != 'cancelado' ORDER BY id`).all(donoDe(req));
    const mapa = new Map();
    linhas.forEach((p) => {
      const chave = String(p.telefone).replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
      if (chave.length < 10) return;
      const c = mapa.get(chave) || { telefone: chave, nome: null, endereco: null, pedidos: 0, gasto: 0, primeiro: p.criado_em, ultimo: null, novidades: false };
      c.nome = p.nome || c.nome;
      if (p.endereco) c.endereco = p.endereco;
      c.pedidos += 1;
      c.gasto = Math.round((c.gasto + (p.total || 0)) * 100) / 100;
      c.ultimo = p.criado_em;
      c.novidades = !!p.novidades; // vale a escolha mais recente do cliente
      mapa.set(chave, c);
    });
    res.json({ clientes: [...mapa.values()].sort((a, b) => b.gasto - a.gasto) });
  });

  r.post('/pedidos/confirmar', (req, res) => {
    const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 200) : [];
    const upd = db.prepare('UPDATE pedidos_online SET importado = 1 WHERE id = ? AND usuario_id = ?');
    ids.forEach((id) => upd.run(id, donoDe(req)));
    res.json({ ok: true });
  });

  r.patch('/pedidos/:id', (req, res) => {
    const status = String((req.body || {}).status || '');
    if (!STATUS.includes(status)) return res.status(400).json({ erro: 'Status inválido.' });
    const info = db.prepare('UPDATE pedidos_online SET status = ? WHERE id = ? AND usuario_id = ?').run(status, req.params.id, donoDe(req));
    if (!info.changes) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    res.json({ ok: true });
  });

  r.post('/', (req, res) => {
    const dono = donoDe(req);
    const b = req.body || {};
    const nome = limparTexto(b.nome, 80);
    if (!nome) return res.status(400).json({ erro: 'Dê um nome pro prato.' });
    const preco = lerPreco(b.preco);
    if (preco === undefined) return res.status(400).json({ erro: 'Preço inválido.' });
    const total = db.prepare('SELECT COUNT(*) AS n FROM pratos_3d WHERE usuario_id = ?').get(dono).n;
    if (total >= MAX_PRATOS) return res.status(400).json({ erro: `O cardápio 3D aceita até ${MAX_PRATOS} pratos.` });
    const ordem = (db.prepare('SELECT MAX(ordem) AS m FROM pratos_3d WHERE usuario_id = ?').get(dono).m || 0) + 1;
    const info = db.prepare('INSERT INTO pratos_3d (usuario_id, nome, descricao, categoria, preco, ordem) VALUES (?, ?, ?, ?, ?, ?)')
      .run(dono, nome, limparTexto(b.descricao, 300), limparTexto(b.categoria, 40), preco, ordem);
    const p = db.prepare('SELECT * FROM pratos_3d WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ prato: pratoParaJson(req, p) });
  });

  r.patch('/:id', (req, res) => {
    const p = pratoDoDono(req, res); if (!p) return;
    const b = req.body || {};
    const novo = { ...p };
    if ('nome' in b) { novo.nome = limparTexto(b.nome, 80); if (!novo.nome) return res.status(400).json({ erro: 'Dê um nome pro prato.' }); }
    if ('descricao' in b) novo.descricao = limparTexto(b.descricao, 300);
    if ('categoria' in b) novo.categoria = limparTexto(b.categoria, 40);
    if ('preco' in b) { novo.preco = lerPreco(b.preco); if (novo.preco === undefined) return res.status(400).json({ erro: 'Preço inválido.' }); }
    if ('ativo' in b) novo.ativo = b.ativo ? 1 : 0;
    if ('ordem' in b && Number.isInteger(b.ordem)) novo.ordem = b.ordem;
    db.prepare('UPDATE pratos_3d SET nome = ?, descricao = ?, categoria = ?, preco = ?, ativo = ?, ordem = ? WHERE id = ?')
      .run(novo.nome, novo.descricao, novo.categoria, novo.preco, novo.ativo, novo.ordem, p.id);
    res.json({ prato: pratoParaJson(req, db.prepare('SELECT * FROM pratos_3d WHERE id = ?').get(p.id)) });
  });

  r.delete('/:id', (req, res) => {
    const p = pratoDoDono(req, res); if (!p) return;
    db.prepare('DELETE FROM pratos_3d WHERE id = ?').run(p.id);
    apagarArquivo(p.modelo); apagarArquivo(p.foto);
    res.json({ ok: true });
  });

  // Envio do arquivo 3D: o corpo da requisição é o próprio .glb
  r.put('/:id/modelo', lerArquivo(LIMITE_MODELO, 'O modelo 3D passa de 25 MB. Exporte com menos detalhes (ou comprima) e tente de novo.'), (req, res) => {
    const p = pratoDoDono(req, res); if (!p) return;
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 20 || buf.toString('ascii', 0, 4) !== 'glTF') {
      return res.status(400).json({ erro: 'Esse arquivo não é um modelo 3D .glb. Exporte do app de escaneamento no formato GLB.' });
    }
    const nome = salvarArquivo(`p${p.id}`, 'glb', buf);
    db.prepare('UPDATE pratos_3d SET modelo = ? WHERE id = ?').run(nome, p.id);
    apagarArquivo(p.modelo);
    res.json({ prato: pratoParaJson(req, db.prepare('SELECT * FROM pratos_3d WHERE id = ?').get(p.id)) });
  });

  r.delete('/:id/modelo', (req, res) => {
    const p = pratoDoDono(req, res); if (!p) return;
    db.prepare('UPDATE pratos_3d SET modelo = NULL WHERE id = ?').run(p.id);
    apagarArquivo(p.modelo);
    res.json({ ok: true });
  });

  r.put('/:id/foto', lerArquivo(LIMITE_FOTO, 'A foto passa de 4 MB. Diminua e tente de novo.'), (req, res) => {
    const p = pratoDoDono(req, res); if (!p) return;
    const tipo = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = TIPOS_FOTO[tipo];
    if (!ext || !Buffer.isBuffer(req.body) || req.body.length < 100) {
      return res.status(400).json({ erro: 'Envie uma foto em JPG, PNG ou WEBP.' });
    }
    const nome = salvarArquivo(`f${p.id}`, ext, req.body);
    db.prepare('UPDATE pratos_3d SET foto = ? WHERE id = ?').run(nome, p.id);
    apagarArquivo(p.foto);
    res.json({ prato: pratoParaJson(req, db.prepare('SELECT * FROM pratos_3d WHERE id = ?').get(p.id)) });
  });

  return r;
}

// Só Premium (ou admin) usa o cardápio 3D pelo próprio painel
function exigirPremium(req, res, next) {
  const u = db.prepare('SELECT plano, is_admin FROM usuarios WHERE id = ?').get(req.usuarioId);
  if (!u || (u.plano !== 'premium' && !u.is_admin)) {
    return res.status(403).json({ erro: 'O cardápio 3D faz parte do plano Premium.' });
  }
  next();
}

/* -------- rotas públicas (cliente final) -------- */
const publico = express.Router();

publico.get('/:codigo', (req, res) => {
  const loja = lojaPorCodigo(req.params.codigo, 'id, nome, negocio_nome, segmento, plano, cardapio_config');
  if (!loja || loja.plano !== 'premium') return res.status(404).json({ erro: 'Cardápio não encontrado.' });
  const c = lerConfig(loja.cardapio_config);
  const pratos = db.prepare('SELECT * FROM pratos_3d WHERE usuario_id = ? AND ativo = 1 ORDER BY ordem, id').all(loja.id);
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    loja: { nome: loja.negocio_nome || loja.nome, segmento: loja.segmento },
    pedidos: {
      aceita: c.aceitaPedidos && (c.mesa || c.retirada || c.entrega),
      mesa: c.mesa, retirada: c.retirada, entrega: c.entrega, taxaEntrega: c.taxaEntrega,
      whatsapp: c.whatsapp || null,
    },
    robo: c.roboAtivo ? {
      horario: c.horario || null, endereco: [c.endereco, c.cidade].filter(Boolean).join(' · ') || null,
      pagamentos: c.pagamentosTxt || null, tempoEntrega: c.tempoEntrega || null, faq: c.faq || [],
    } : null,
    pratos: pratos.map((p) => {
      const j = pratoParaJson(req, p);
      delete j.visualizacoes; delete j.ativo; delete j.ordem;
      return j;
    }),
  });
});

// Conta quando alguém abre um prato em 3D (pro lojista ver os mais olhados)
publico.post('/:codigo/ver/:id', (req, res) => {
  const loja = lojaPorCodigo(req.params.codigo, 'id');
  if (loja) db.prepare('UPDATE pratos_3d SET visualizacoes = visualizacoes + 1 WHERE id = ? AND usuario_id = ?').run(req.params.id, loja.id);
  res.status(204).end();
});

// Limite simples contra abuso: até 8 pedidos a cada 10 minutos por IP
const tentativas = new Map();
function podePedir(ip) {
  const agora = Date.now();
  const lista = (tentativas.get(ip) || []).filter((t) => agora - t < 10 * 60000);
  if (lista.length >= 8) { tentativas.set(ip, lista); return false; }
  lista.push(agora); tentativas.set(ip, lista);
  if (tentativas.size > 5000) tentativas.clear();
  return true;
}

const PAGAMENTOS = ['Pix', 'Cartão', 'Dinheiro'];

publico.post('/:codigo/pedido', (req, res) => {
  const loja = lojaPorCodigo(req.params.codigo, 'id, plano, cardapio_config');
  if (!loja || loja.plano !== 'premium') return res.status(404).json({ erro: 'Cardápio não encontrado.' });
  const c = lerConfig(loja.cardapio_config);
  const garcom = tokenDoPedido(req) ? lerTokenGarcom(tokenDoPedido(req), loja.id) : null;
  if (tokenDoPedido(req) && !garcom) return res.status(401).json({ erro: 'Sua sessão de garçom expirou. Entre de novo com o PIN.' });
  if (!garcom && !c.aceitaPedidos) return res.status(400).json({ erro: 'Essa loja não está recebendo pedidos pelo cardápio agora.' });
  if (!garcom && !podePedir(req.ip || 'x')) return res.status(429).json({ erro: 'Muitos pedidos seguidos. Espere alguns minutos ou chame um atendente.' });

  const b = req.body || {};
  const modo = garcom ? 'mesa' : String(b.modo || '');
  if (!['mesa', 'retirada', 'entrega'].includes(modo) || (!garcom && !c[modo])) return res.status(400).json({ erro: 'Escolha como quer receber o pedido.' });
  const nome = limparTexto(b.nome, 60);
  const mesa = limparTexto(b.mesa, 12);
  const novidades = b.novidades ? 1 : 0;
  const telefone = limparTexto(String(b.telefone || '').replace(/[^\d()+ -]/g, ''), 20);
  const endereco = limparTexto(b.endereco, 200);
  const obs = limparTexto(b.obs, 200);
  if (modo === 'mesa' && !mesa) return res.status(400).json({ erro: 'Diga o número da sua mesa.' });
  if (modo !== 'mesa' && !nome) return res.status(400).json({ erro: 'Diga seu nome.' });
  if (modo === 'entrega' && (!endereco || !telefone)) return res.status(400).json({ erro: 'Pra entrega, preencha o endereço e o telefone.' });
  const pagamento = modo === 'mesa' ? null : (PAGAMENTOS.includes(b.pagamento) ? b.pagamento : null);
  if (modo !== 'mesa' && !pagamento) return res.status(400).json({ erro: 'Escolha a forma de pagamento.' });
  const troco = pagamento === 'Dinheiro' ? limparTexto(b.troco, 20) : null;

  const pedidos = Array.isArray(b.itens) ? b.itens.slice(0, 40) : [];
  const buscar = db.prepare('SELECT id, nome, preco FROM pratos_3d WHERE id = ? AND usuario_id = ? AND ativo = 1');
  const itens = [];
  for (const it of pedidos) {
    const qtd = parseInt(it && it.qtd, 10);
    const prato = buscar.get(Number(it && it.id), loja.id);
    if (!prato || !(qtd >= 1 && qtd <= 50)) continue;
    itens.push({ id: prato.id, nome: prato.nome, qtd, preco: prato.preco || 0, obs: limparTexto(it.obs, 120) });
  }
  if (!itens.length) return res.status(400).json({ erro: 'Seu pedido está vazio. Escolha algum item do cardápio.' });

  const subtotal = Math.round(itens.reduce((s, i) => s + i.preco * i.qtd, 0) * 100) / 100;
  const taxa = modo === 'entrega' ? (c.taxaEntrega || 0) : 0;
  const total = Math.round((subtotal + taxa) * 100) / 100;
  const token = crypto.randomBytes(12).toString('hex');
  const info = db.prepare(`INSERT INTO pedidos_online (usuario_id, token, itens, subtotal, taxa, total, modo, mesa, nome, telefone, endereco, pagamento, troco, obs, novidades, garcom)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(loja.id, token, JSON.stringify(itens), subtotal, taxa, total, modo, mesa, nome, telefone, endereco, pagamento, troco, obs, telefone ? novidades : 0, garcom ? garcom.n : null);
  res.status(201).json({ id: info.lastInsertRowid, token, itens, subtotal, taxa, total });
});

// App do garçom: entra com o PIN
const tentativasPin = new Map();
publico.post('/:codigo/garcom/entrar', (req, res) => {
  const loja = lojaPorCodigo(req.params.codigo, 'id, nome, negocio_nome, plano, cardapio_config');
  if (!loja || loja.plano !== 'premium') return res.status(404).json({ erro: 'Loja não encontrada.' });
  const ip = req.ip || 'x', agora = Date.now();
  const lista = (tentativasPin.get(ip) || []).filter((t) => agora - t < 10 * 60000);
  if (lista.length >= 8) return res.status(429).json({ erro: 'Muitas tentativas. Espere 10 minutos.' });
  const pin = String((req.body || {}).pin || '').replace(/\D/g, '');
  const h = hashPin(loja.id, pin);
  const g = (lerConfig(loja.cardapio_config).garcons || []).find((x) => x.pinHash === h);
  if (!g) { lista.push(agora); tentativasPin.set(ip, lista); return res.status(401).json({ erro: 'PIN errado.' }); }
  res.json({ token: tokenGarcom(loja.id, g), nome: g.nome, loja: loja.negocio_nome || loja.nome });
});

// Pedidos do garçom no dia (pra ele acompanhar o que mandou)
publico.get('/:codigo/garcom/pedidos', (req, res) => {
  const loja = lojaPorCodigo(req.params.codigo, 'id');
  const g = loja && lerTokenGarcom(tokenDoPedido(req), loja.id);
  if (!g) return res.status(401).json({ erro: 'Entre de novo com o PIN.' });
  const lista = db.prepare(`SELECT id, mesa, itens, total, status, criado_em FROM pedidos_online
    WHERE usuario_id = ? AND garcom = ? AND criado_em >= datetime('now', '-14 hours') ORDER BY id DESC LIMIT 40`).all(loja.id, g.n);
  res.set('Cache-Control', 'no-store');
  res.json({ pedidos: lista.map((p) => ({ ...p, itens: JSON.parse(p.itens) })) });
});

// O cliente acompanha o pedido pelo token que recebeu ao enviar
publico.get('/pedido/:token', (req, res) => {
  const p = db.prepare('SELECT id, status, total, criado_em FROM pedidos_online WHERE token = ?').get(String(req.params.token));
  if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  res.set('Cache-Control', 'no-store');
  res.json(p);
});

module.exports = { rotasGestao, exigirPremium, publico, PASTA };
