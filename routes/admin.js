const express = require('express');
const db = require('../db');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const { gerarCodigoUnico, buscarPlaca, vincularPlaca, normalizarCodigo } = require('../placas');
const { exigirLogin, exigirAdmin } = require('../middleware/auth');
const { enviarRelatorio, mesAnterior, mesAtualBrasilia } = require('../jobs/relatorio-mensal');

const router = express.Router();

// A partir daqui, toda rota deste arquivo exige estar logado E ser admin
router.use(exigirLogin, exigirAdmin);

const COMISSAO_PERCENTUAL = Number(process.env.COMISSAO_PERCENTUAL || 30);

router.get('/clientes', (req, res) => {
  const clientes = db.prepare(`
    SELECT id, nome, email, negocio_nome, segmento, plano, is_comercial, codigo_nfc, google_place_id, link_google, nfc_scans, checklist_ativo, criado_em
    FROM usuarios
    WHERE is_admin = 0
    ORDER BY criado_em DESC
  `).all();
  res.json({ clientes });
});

router.get('/suporte', (req, res) => {
  const tickets = db.prepare(`
    SELECT s.id, s.assunto, s.mensagem, s.status, s.criado_em,
           u.nome AS cliente_nome, u.email AS cliente_email, u.negocio_nome
    FROM suporte s
    JOIN usuarios u ON u.id = s.usuario_id
    ORDER BY s.criado_em DESC
  `).all();
  res.json({ tickets });
});

router.patch('/suporte/:id', (req, res) => {
  const { status } = req.body || {};
  const validos = ['aberto', 'respondido', 'fechado'];
  if (!validos.includes(status)) {
    return res.status(400).json({ erro: `Status inválido. Use um de: ${validos.join(', ')}.` });
  }
  db.prepare('UPDATE suporte SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ id: Number(req.params.id), status });
});

// Marca ou desmarca um usuário como parte do time comercial
router.patch('/clientes/:id/comercial', (req, res) => {
  const { id } = req.params;
  const { is_comercial } = req.body || {};

  const usuario = db.prepare('SELECT id FROM usuarios WHERE id = ?').get(id);
  if (!usuario) {
    return res.status(404).json({ erro: 'Usuário não encontrado.' });
  }

  db.prepare('UPDATE usuarios SET is_comercial = ? WHERE id = ?').run(is_comercial ? 1 : 0, id);

  const atualizado = db.prepare('SELECT id, nome, email, is_comercial FROM usuarios WHERE id = ?').get(id);
  res.json({ usuario: atualizado });
});

// Corrige o tipo de negócio do cliente (muda o que aparece no painel dele)
router.patch('/clientes/:id/segmento', (req, res) => {
  const segmento = String((req.body || {}).segmento || '');
  if (!['restaurante', 'bar', 'comercio', 'barbearia', 'salao', 'clinica', 'servicos'].includes(segmento)) return res.status(400).json({ erro: 'Tipo de negócio inválido.' });
  const info = db.prepare('UPDATE usuarios SET segmento = ? WHERE id = ?').run(segmento, req.params.id);
  if (!info.changes) return res.status(404).json({ erro: 'Usuário não encontrado.' });
  res.json({ ok: true, segmento });
});

// Define/corrige o link do Google de qualquer cliente (Place ID, link de avaliação ou link do Maps)
router.patch('/clientes/:id/google', (req, res) => {
  const usuario = db.prepare('SELECT id FROM usuarios WHERE id = ?').get(req.params.id);
  if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado.' });

  const texto = String((req.body || {}).linkGoogle || '').trim();
  let placeId = null, link = null;
  const m = texto.match(/^[A-Za-z0-9_-]{20,}$/) ? [null, texto]
    : (texto.match(/place_?id[:=]([A-Za-z0-9_-]{20,})/i) || texto.match(/(ChIJ[A-Za-z0-9_-]{15,})/));
  if (m) placeId = m[1];
  else if (/^https?:\/\//i.test(texto)) link = texto;
  if (!placeId && !link) return res.status(400).json({ erro: 'Cole o Place ID ou o link de avaliação do Google.' });

  db.prepare('UPDATE usuarios SET google_place_id = ?, link_google = ? WHERE id = ?').run(placeId, link, req.params.id);
  res.json({ ok: true, placeIdReconhecido: !!placeId });
});

// Apaga um cliente e todos os dados ligados a ele
router.delete('/clientes/:id', (req, res) => {
  const { id } = req.params;

  const usuario = db.prepare('SELECT id, is_admin FROM usuarios WHERE id = ?').get(id);
  if (!usuario) {
    return res.status(404).json({ erro: 'Usuário não encontrado.' });
  }
  if (usuario.is_admin) {
    return res.status(403).json({ erro: 'Não é possível excluir uma conta administrativa.' });
  }

  const apagar = db.transaction((usuarioId) => {
    require('./checklist').apagarDoCliente(usuarioId);
    db.prepare('DELETE FROM dados WHERE usuario_id = ?').run(usuarioId);
    db.prepare('DELETE FROM suporte WHERE usuario_id = ?').run(usuarioId);
    db.prepare('DELETE FROM vendas WHERE usuario_id = ? OR vendedor_id = ?').run(usuarioId, usuarioId);
    db.prepare('UPDATE placas SET usuario_id = NULL, ativada_em = NULL WHERE usuario_id = ?').run(usuarioId);
    db.prepare('DELETE FROM usuarios WHERE id = ?').run(usuarioId);
  });
  apagar(id);

  res.json({ ok: true, id: Number(id) });
});

// Relatório consolidado: vendas por vendedor + ranking de clientes por scans
// Envia o relatório mensal (do mês passado) de um cliente: pra você testar ou pro próprio cliente
router.post('/clientes/:id/relatorio', async (req, res) => {
  const { destino, mes } = req.body || {};
  const mesEscolhido = /^\d{4}-\d{2}$/.test(mes || '') ? mes : mesAnterior(mesAtualBrasilia());
  let paraOutro = null;
  if (destino !== 'cliente') {
    const admin = db.prepare('SELECT email FROM usuarios WHERE id = ?').get(req.usuarioId);
    paraOutro = admin.email;
  }
  try {
    const r = await enviarRelatorio(req.params.id, mesEscolhido, paraOutro);
    res.json({ ok: true, para: paraOutro || r.usuario.email, mes: mesEscolhido });
  } catch (e) {
    console.error('Erro ao enviar relatório', e);
    res.status(e.message === 'Cliente não encontrado.' ? 404 : 500).json({ erro: e.message || 'Não foi possível enviar o relatório.' });
  }
});

router.get('/relatorios', (req, res) => {
  const vendedores = db.prepare(`
    SELECT
      v.vendedor_id,
      u.nome AS vendedor_nome,
      u.email AS vendedor_email,
      COUNT(*) AS totalVendas,
      SUM(CASE WHEN v.status = 'confirmado' THEN 1 ELSE 0 END) AS totalConfirmado,
      SUM(CASE WHEN v.status = 'pendente' THEN 1 ELSE 0 END) AS totalPendente,
      SUM(CASE WHEN v.status = 'confirmado' THEN v.valor ELSE 0 END) AS valorConfirmado
    FROM vendas v
    JOIN usuarios u ON u.id = v.vendedor_id
    GROUP BY v.vendedor_id
    ORDER BY valorConfirmado DESC
  `).all().map(v => ({
    ...v,
    comissao: (v.valorConfirmado || 0) * (COMISSAO_PERCENTUAL / 100),
  }));

  const rankingScans = db.prepare(`
    SELECT id, nome, negocio_nome, nfc_scans
    FROM usuarios
    WHERE is_admin = 0 AND nfc_scans > 0
    ORDER BY nfc_scans DESC
    LIMIT 10
  `).all();

  const resumoGeralBruto = db.prepare(`
    SELECT
      COUNT(*) AS totalVendas,
      SUM(CASE WHEN status = 'confirmado' THEN 1 ELSE 0 END) AS totalConfirmado,
      SUM(CASE WHEN status = 'pendente' THEN 1 ELSE 0 END) AS totalPendente,
      SUM(CASE WHEN status = 'confirmado' THEN valor ELSE 0 END) AS valorTotalConfirmado
    FROM vendas
  `).get();

  const resumoGeral = {
    ...resumoGeralBruto,
    comissaoTotal: (resumoGeralBruto.valorTotalConfirmado || 0) * (COMISSAO_PERCENTUAL / 100),
    comissaoPercentual: COMISSAO_PERCENTUAL,
  };

  // Scans da placa NFC agrupados por dia (últimos 30 dias), semana (últimas 12) e mês (últimos 12)
  const scansPorDia = db.prepare(`
    SELECT strftime('%Y-%m-%d', criado_em) AS periodo, COUNT(*) AS total
    FROM scans_log
    WHERE criado_em >= datetime('now', '-30 days')
    GROUP BY periodo
    ORDER BY periodo ASC
  `).all();

  const scansPorSemana = db.prepare(`
    SELECT strftime('%Y-%W', criado_em) AS periodo, COUNT(*) AS total
    FROM scans_log
    WHERE criado_em >= datetime('now', '-84 days')
    GROUP BY periodo
    ORDER BY periodo ASC
  `).all();

  const scansPorMes = db.prepare(`
    SELECT strftime('%Y-%m', criado_em) AS periodo, COUNT(*) AS total
    FROM scans_log
    WHERE criado_em >= datetime('now', '-365 days')
    GROUP BY periodo
    ORDER BY periodo ASC
  `).all();

  res.json({ vendedores, rankingScans, resumoGeral, scansPorDia, scansPorSemana, scansPorMes });
});


/* ------------------------- PLACAS EM LOTE ------------------------- */
function baseUrl(req) {
  return process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
}

// Gera um lote de placas "em branco" (códigos únicos, ainda sem loja)
router.post('/placas/lote', (req, res) => {
  const quantidade = parseInt((req.body || {}).quantidade, 10);
  if (!(quantidade >= 1 && quantidade <= 500)) {
    return res.status(400).json({ erro: 'Escolha uma quantidade entre 1 e 500 placas.' });
  }
  const hoje = new Date().toISOString().slice(0, 10);
  const doDia = db.prepare('SELECT COUNT(DISTINCT lote) AS n FROM placas WHERE lote LIKE ?').get(`${hoje}%`).n;
  const lote = `${hoje}-${String(doDia + 1).padStart(2, '0')}`;

  const inserir = db.prepare('INSERT INTO placas (codigo, lote) VALUES (?, ?)');
  const codigos = [];
  const criar = db.transaction(() => {
    for (let i = 0; i < quantidade; i++) {
      const c = gerarCodigoUnico();
      inserir.run(c, lote);
      codigos.push(c);
    }
  });
  criar();
  res.status(201).json({ lote, quantidade: codigos.length, codigos });
});

// Resumo dos lotes
router.get('/placas/lotes', (req, res) => {
  const lotes = db.prepare(`
    SELECT lote, MIN(criado_em) AS criado_em, COUNT(*) AS total,
           SUM(CASE WHEN usuario_id IS NOT NULL THEN 1 ELSE 0 END) AS ativadas
    FROM placas GROUP BY lote ORDER BY lote DESC
  `).all();
  res.json({ lotes });
});

// Placas de um lote (ou todas), com a loja vinculada
router.get('/placas', (req, res) => {
  const base = baseUrl(req);
  const filtro = req.query.lote ? 'WHERE p.lote = ?' : '';
  const params = req.query.lote ? [req.query.lote] : [];
  const placas = db.prepare(`
    SELECT p.codigo, p.lote, p.usuario_id, p.criado_em, p.ativada_em,
           u.negocio_nome, u.nome AS cliente_nome, u.nfc_scans
    FROM placas p LEFT JOIN usuarios u ON u.id = p.usuario_id
    ${filtro}
    ORDER BY p.criado_em, p.codigo
  `).all(...params).map((p) => ({
    ...p,
    link: `${base}/r/${p.codigo}`,
    qr: `${base}/qr/${p.codigo}.png`,
  }));
  res.json({ placas, base });
});

// Vincula (ou desvincula, com usuario_id null) uma placa a uma loja
router.patch('/placas/:codigo', (req, res) => {
  const placa = buscarPlaca(req.params.codigo);
  if (!placa) return res.status(404).json({ erro: 'Placa não encontrada.' });
  const usuarioId = (req.body || {}).usuario_id;

  if (usuarioId === null || usuarioId === '' || usuarioId === undefined) {
    db.prepare('UPDATE placas SET usuario_id = NULL, ativada_em = NULL WHERE codigo = ?').run(placa.codigo);
    return res.json({ ok: true, codigo: placa.codigo, usuario_id: null });
  }
  const loja = db.prepare('SELECT id FROM usuarios WHERE id = ? AND is_admin = 0').get(usuarioId);
  if (!loja) return res.status(404).json({ erro: 'Loja não encontrada.' });

  // O admin pode mover uma placa de uma loja pra outra
  db.prepare(`UPDATE placas SET usuario_id = ?, ativada_em = datetime('now') WHERE codigo = ?`).run(loja.id, placa.codigo);
  res.json({ ok: true, codigo: placa.codigo, usuario_id: loja.id });
});

// Apaga placas livres de um lote (ex.: gerou a mais por engano). Placas ativadas nunca são apagadas.
router.delete('/placas/lote/:lote', (req, res) => {
  const r = db.prepare('DELETE FROM placas WHERE lote = ? AND usuario_id IS NULL').run(req.params.lote);
  res.json({ ok: true, apagadas: r.changes });
});


/* ------------------------- PIX DE TESTE (R$ 1) ------------------------- */
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });
const VALOR_PIX_TESTE = 1;

// Gera um Pix real de R$ 1 pra testar o Mercado Pago e o aviso automático (webhook)
router.post('/pix-teste', async (req, res) => {
  if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
    return res.status(400).json({ erro: 'MERCADOPAGO_ACCESS_TOKEN não está configurado no servidor.' });
  }
  const teste = db.prepare('INSERT INTO pix_testes (valor) VALUES (?)').run(VALOR_PIX_TESTE);
  const testeId = teste.lastInsertRowid;
  const base = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
  try {
    const pagamento = await new Payment(mpClient).create({
      body: {
        transaction_amount: VALOR_PIX_TESTE,
        description: 'Flow Solution — teste de Pix (R$ 1)',
        payment_method_id: 'pix',
        payer: { email: 'pix-teste@flowsolution.com.br' },
        external_reference: `teste|${testeId}`,
        notification_url: `${base}/api/pagamentos/webhook`,
      },
    });
    const dados = pagamento.point_of_interaction?.transaction_data;
    db.prepare('UPDATE pix_testes SET mp_payment_id = ? WHERE id = ?').run(String(pagamento.id), testeId);
    res.status(201).json({
      id: testeId,
      valor: VALOR_PIX_TESTE,
      qrCodeBase64: dados?.qr_code_base64 || null,
      copiaECola: dados?.qr_code || null,
    });
  } catch (e) {
    console.error('Erro ao gerar Pix de teste', e);
    db.prepare(`UPDATE pix_testes SET status = 'erro' WHERE id = ?`).run(testeId);
    const detalhe = e?.message || (e?.cause && JSON.stringify(e.cause)) || '';
    res.status(502).json({ erro: `O Mercado Pago recusou gerar o Pix. ${detalhe}`.trim() });
  }
});

// Situação do Pix de teste: o que o Mercado Pago diz e se o webhook chegou
router.get('/pix-teste/:id', async (req, res) => {
  const t = db.prepare('SELECT * FROM pix_testes WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ erro: 'Teste não encontrado.' });
  let statusMercadoPago = null;
  if (t.mp_payment_id) {
    try { statusMercadoPago = (await new Payment(mpClient).get({ id: t.mp_payment_id })).status; }
    catch (e) { statusMercadoPago = 'indisponivel'; }
  }
  res.json({ id: t.id, statusMercadoPago, webhookRecebido: !!t.confirmado_por_webhook, pagoEm: t.pago_em });
});


/* ------------------------- FECHAMENTO DE COMISSÃO ------------------------- */
// Vendas confirmadas no mês (horário de Brasília), por vendedor, com a comissão a pagar
router.get('/comissoes', (req, res) => {
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : null;
  if (!mes) return res.status(400).json({ erro: 'Informe o mês no formato AAAA-MM.' });
  const vendas = db.prepare(`
    SELECT v.id, v.valor, v.forma_pagamento, v.confirmado_em, v.vendedor_id,
           vend.nome AS vendedor_nome, vend.email AS vendedor_email,
           u.negocio_nome, u.nome AS cliente_nome, u.plano
    FROM vendas v
    JOIN usuarios vend ON vend.id = v.vendedor_id
    JOIN usuarios u ON u.id = v.usuario_id
    WHERE v.status = 'confirmado' AND strftime('%Y-%m', v.confirmado_em, '-3 hours') = ?
    ORDER BY vend.nome, v.confirmado_em
  `).all(mes);
  const porVendedor = {};
  vendas.forEach((v) => {
    const k = v.vendedor_id;
    porVendedor[k] = porVendedor[k] || { vendedor: v.vendedor_nome, email: v.vendedor_email, vendas: 0, valor: 0, comissao: 0 };
    porVendedor[k].vendas += 1;
    porVendedor[k].valor += v.valor || 0;
  });
  const vendedores = Object.values(porVendedor).map((x) => ({ ...x, comissao: Math.round(x.valor * COMISSAO_PERCENTUAL) / 100 }));
  res.json({ mes, comissaoPercentual: COMISSAO_PERCENTUAL, vendedores, vendas });
});

/* ------------------------- PEDIDOS DE PLACAS EXTRAS ------------------------- */
router.get('/pedidos-placas', (req, res) => {
  const pedidos = db.prepare(`
    SELECT p.id, p.quantidade, p.valor, p.status, p.pago_em, p.entregue_em, p.usuario_id,
           u.negocio_nome, u.nome, u.email, u.telefone
    FROM pedidos_placas p JOIN usuarios u ON u.id = p.usuario_id
    WHERE p.status IN ('pago', 'entregue')
    ORDER BY CASE p.status WHEN 'pago' THEN 0 ELSE 1 END, p.pago_em DESC
    LIMIT 100
  `).all();
  res.json({ pedidos });
});

router.patch('/pedidos-placas/:id', (req, res) => {
  const r = db.prepare(`UPDATE pedidos_placas SET status = 'entregue', entregue_em = ? WHERE id = ? AND status = 'pago'`)
    .run(new Date().toISOString(), req.params.id);
  if (!r.changes) return res.status(404).json({ erro: 'Pedido não encontrado ou já entregue.' });
  res.json({ ok: true });
});


/* ------------------------- DEPOIMENTOS DO SITE ------------------------- */
router.get('/depoimentos', (req, res) => {
  res.json({ depoimentos: db.prepare('SELECT * FROM depoimentos ORDER BY criado_em DESC').all() });
});

router.post('/depoimentos', (req, res) => {
  const b = req.body || {};
  const nome = String(b.nome || '').trim().slice(0, 80);
  const texto = String(b.texto || '').trim().slice(0, 600);
  if (!nome || !texto) return res.status(400).json({ erro: 'Preencha o nome e o depoimento.' });
  const nota = Math.min(5, Math.max(1, parseInt(b.nota, 10) || 5));
  const r = db.prepare('INSERT INTO depoimentos (nome, negocio, cidade, texto, nota) VALUES (?, ?, ?, ?, ?)')
    .run(nome, String(b.negocio || '').trim().slice(0, 80) || null, String(b.cidade || '').trim().slice(0, 60) || null, texto, nota);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.patch('/depoimentos/:id', (req, res) => {
  const r = db.prepare('UPDATE depoimentos SET visivel = ? WHERE id = ?').run((req.body || {}).visivel ? 1 : 0, req.params.id);
  if (!r.changes) return res.status(404).json({ erro: 'Depoimento não encontrado.' });
  res.json({ ok: true });
});

router.delete('/depoimentos/:id', (req, res) => {
  const r = db.prepare('DELETE FROM depoimentos WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ erro: 'Depoimento não encontrado.' });
  res.json({ ok: true });
});

/* ------------------------- METAS DO COMERCIAL ------------------------- */
function mesBrasilia() { return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 7); }

router.get('/metas', (req, res) => {
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : mesBrasilia();
  const vendedores = db.prepare(`
    SELECT u.id, u.nome, u.email, u.meta_mensal,
      (SELECT COUNT(*) FROM vendas v WHERE v.vendedor_id = u.id AND v.status = 'confirmado'
         AND strftime('%Y-%m', v.confirmado_em, '-3 hours') = ?) AS vendas_mes
    FROM usuarios u WHERE u.is_comercial = 1 ORDER BY u.nome
  `).all(mes);
  res.json({ mes, vendedores });
});

router.patch('/vendedores/:id/meta', (req, res) => {
  const meta = parseInt((req.body || {}).meta, 10);
  if (!(meta >= 0 && meta <= 1000)) return res.status(400).json({ erro: 'A meta precisa ser um número de 0 a 1000.' });
  const r = db.prepare('UPDATE usuarios SET meta_mensal = ? WHERE id = ? AND is_comercial = 1').run(meta, req.params.id);
  if (!r.changes) return res.status(404).json({ erro: 'Vendedor não encontrado.' });
  res.json({ ok: true, meta });
});

module.exports = router;
