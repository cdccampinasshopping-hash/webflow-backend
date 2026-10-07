require('dotenv').config();
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const db = require('./db');
const { lojaPorCodigo, buscarPlaca } = require('./placas');
const authRoutes = require('./routes/auth');
const dadosRoutes = require('./routes/dados');
const suporteRoutes = require('./routes/suporte');
const adminRoutes = require('./routes/admin');
const comercialRoutes = require('./routes/comercial');
const pagamentosRoutes = require('./routes/pagamentos');
const webhookPagamentosRoutes = require('./routes/webhook-pagamentos');
const avaliacoesRoutes = require('./routes/avaliacoes');
const cardapio3d = require('./routes/cardapio3d');
const agenda = require('./routes/agenda');
const notas = require('./routes/notas');
const checklist = require('./routes/checklist');
const leads = require('./routes/leads');
const orbittaRotas = require('./routes/orbitta');
const orbittaExtra = require('./routes/orbitta-extra');
const { exigirLogin, exigirAdmin, exigirControle } = require('./middleware/auth');
const { iniciarAgendamentoBackup } = require('./jobs/backup');
const { iniciarVerificacaoAssinaturas } = require('./jobs/assinaturas');
const { iniciarRelatoriosMensais } = require('./jobs/relatorio-mensal');
const { iniciarRoboAgenda } = require('./jobs/robo-agenda');
const { iniciarAvisosChecklist } = require('./jobs/checklist-avisos');

if (!process.env.JWT_SECRET) {
  console.error('ERRO: defina JWT_SECRET no arquivo .env antes de rodar o servidor (veja .env.example).');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // Railway fica atrás de proxy: garante https nos links gerados
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }));
app.use(express.json({ limit: '1mb' })); // 1 MB: o certificado A1 vai em base64

const SITE_URL = process.env.SITE_URL || 'https://flowsolution.pages.dev';

// Pra monitor de disponibilidade: confere que o servidor e o banco respondem
app.get('/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok' });
  } catch (e) {
    res.status(500).json({ status: 'erro' });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', servico: 'Webflow API' });
});

// Rota pública da placa NFC — sem login, é chamada pelo celular do cliente final.
// Conta o scan e manda direto pra tela de avaliação do Google do negócio.
app.get('/r/:codigo', (req, res) => {
  const cliente = lojaPorCodigo(req.params.codigo, 'id, google_place_id, link_google');

  if (!cliente) {
    // Placa impressa em lote que ainda não foi vinculada a nenhuma loja
    // (o código aparece nessa tela pro comercial ativar, já que não vai impresso na placa)
    const livre = buscarPlaca(req.params.codigo);
    if (livre) {
      return res.redirect(`${SITE_URL}/placa-nao-ativada.html?c=${encodeURIComponent(livre.codigo)}`);
    }
    return res.redirect(`${SITE_URL}/link-invalido.html`);
  }

  db.prepare('UPDATE usuarios SET nfc_scans = nfc_scans + 1 WHERE id = ?').run(cliente.id);
  db.prepare('INSERT INTO scans_log (usuario_id) VALUES (?)').run(cliente.id);

  // Padrão: direto pro Google. Com PLACA_DIRETO_GOOGLE=0, abre antes a tela rápida da loja
  // (nota + comentário, que vão pro mural do lojista) e de lá o cliente segue pro Google.
  if (process.env.PLACA_DIRETO_GOOGLE === '0') {
    return res.redirect(302, `${SITE_URL}/avaliar.html?c=${encodeURIComponent(req.params.codigo)}`);
  }

  if (cliente.google_place_id) {
    return res.redirect(302, `https://search.google.com/local/writereview?placeid=${cliente.google_place_id}`);
  }
  if (cliente.link_google) {
    return res.redirect(302, cliente.link_google);
  }
  return res.redirect(`${SITE_URL}/avaliacao-pendente.html`);
});

// QR Code público da placa (PNG) — aponta pro link dinâmico /r/:codigo, então cada leitura conta.
// Não conta scan aqui: só gera a imagem pra imprimir.
app.get('/qr/:codigo.png', async (req, res) => {
  const cliente = lojaPorCodigo(req.params.codigo, 'id');
  const placa = cliente ? null : buscarPlaca(req.params.codigo);
  if (!cliente && !placa) return res.status(404).json({ erro: 'Código não encontrado.' });
  const codigo = placa ? placa.codigo : req.params.codigo;

  const base = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
  // ?w=1200 pra impressão em alta resolução (limite 1600px); ?margem=0 tira a borda branca
  const largura = Math.min(1600, Math.max(200, parseInt(req.query.w, 10) || 600));
  try {
    const png = await QRCode.toBuffer(`${base}/r/${codigo}`, { width: largura, margin: req.query.margem === '0' ? 0 : 2, errorCorrectionLevel: 'M' });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    if (req.query.download) res.set('Content-Disposition', `attachment; filename="placa-${codigo}.png"`);
    res.send(png);
  } catch (e) {
    console.error('Erro ao gerar QR', e);
    res.status(500).json({ erro: 'Não foi possível gerar o QR Code.' });
  }
});

// QR Code do cardápio 3D: aponta pra página pública do cardápio da loja (pra colocar nas mesas)
app.get('/qr-cardapio/:codigo.png', async (req, res) => {
  const loja = lojaPorCodigo(req.params.codigo, 'id');
  if (!loja) return res.status(404).json({ erro: 'Código não encontrado.' });
  const largura = Math.min(1600, Math.max(200, parseInt(req.query.w, 10) || 800));
  try {
    // ?mesa=5 → o cardápio já abre sabendo a mesa do cliente
    const mesa = String(req.query.mesa || '').replace(/[^\w-]/g, '').slice(0, 12);
    const destino = `${SITE_URL}/cardapio.html?c=${encodeURIComponent(req.params.codigo)}${mesa ? `&mesa=${encodeURIComponent(mesa)}` : ''}`;
    const png = await QRCode.toBuffer(destino, { width: largura, margin: 2, errorCorrectionLevel: 'M' });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    if (req.query.download) res.set('Content-Disposition', `attachment; filename="cardapio-${mesa ? 'mesa-' + mesa : req.params.codigo}.png"`);
    res.send(png);
  } catch (e) {
    console.error('Erro ao gerar QR do cardápio', e);
    res.status(500).json({ erro: 'Não foi possível gerar o QR Code.' });
  }
});

// Modelos 3D e fotos do cardápio (públicos, nomes aleatórios)
app.get('/arquivos/:nome', (req, res) => {
  const nome = req.params.nome;
  if (!/^[a-z0-9-]+\.(glb|jpg|png|webp)$/.test(nome)) return res.status(404).json({ erro: 'Arquivo não encontrado.' });
  const arquivo = path.join(cardapio3d.PASTA, nome);
  fs.stat(arquivo, (err, st) => {
    if (err || !st.isFile()) return res.status(404).json({ erro: 'Arquivo não encontrado.' });
    const tipos = { glb: 'model/gltf-binary', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
    res.set('Content-Type', tipos[nome.split('.').pop()]);
    res.set('Content-Length', String(st.size));
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    fs.createReadStream(arquivo).pipe(res);
  });
});


app.use('/api/auth', authRoutes);
app.use('/api/dados', exigirLogin, dadosRoutes);
app.use('/api/suporte', exigirLogin, suporteRoutes);
// Admin monta o cardápio 3D em nome do cliente: /api/admin/cardapio3d?cliente=ID
app.use('/api/admin/cardapio3d', exigirLogin, exigirAdmin, cardapio3d.rotasGestao((req) => Number(req.query.cliente)));
// Checklist diário do gerente/líder (comprovantes) e relatórios pro admin
app.use('/api/admin/checklist', exigirLogin, exigirControle, checklist.admin);
app.use('/api/checklist', exigirLogin, checklist.lojista);
// Controle de leads do dia (quem atendeu, reativações, quem ficou sem resposta)
app.use('/api/admin/leads', exigirLogin, exigirControle, leads.admin);
app.use('/api/leads', exigirLogin, leads.lojista);
// Dados automáticos do Orbitta (vendedores, novos x reativações)
app.use('/api/admin/orbitta', exigirLogin, exigirControle, orbittaRotas.admin);
app.use('/api/admin/orbitta', exigirLogin, exigirControle, orbittaExtra.admin);
app.use('/api/orbitta', exigirLogin, orbittaRotas.lojista);
app.use('/api/orbitta', exigirLogin, orbittaExtra.lojista);
app.use('/api/admin', exigirLogin, exigirAdmin, adminRoutes);
app.use('/api/cardapio3d', exigirLogin, cardapio3d.exigirPremium, cardapio3d.rotasGestao((req) => req.usuarioId));
app.use('/api/publico/cardapio3d', cardapio3d.publico);
app.use('/api/comercial', comercialRoutes);
app.use('/api/pagamentos/webhook', webhookPagamentosRoutes);
app.use('/api/pagamentos', exigirLogin, pagamentosRoutes);
// Agenda online: público (cliente marca o horário), lojista (painel), Google Agenda e calendário .ics
app.use('/api/publico/agenda', agenda.publico);
app.use('/api/notas', exigirLogin, notas.lojista);
app.use('/api/publico/notas', notas.publico);
app.use('/api/agenda', exigirLogin, (req, res, next) => {
  const u = db.prepare('SELECT plano, is_admin FROM usuarios WHERE id = ?').get(req.usuarioId);
  if (!u || (u.plano !== 'premium' && !u.is_admin)) return res.status(403).json({ erro: 'A agenda online faz parte do plano Premium.' });
  next();
}, agenda.lojista);
app.get('/api/google/callback', agenda.callbackGoogle);
app.get('/agenda/:token.ics', agenda.feedIcs);
app.use('/api/publico', avaliacoesRoutes.publico);
app.use('/api/avaliacoes', avaliacoesRoutes.lojista);

app.use((req, res) => {
  res.status(404).json({ erro: 'Rota não encontrada.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Webflow API rodando na porta ${PORT}`);
  iniciarAgendamentoBackup();
  iniciarVerificacaoAssinaturas();
  iniciarRelatoriosMensais();
  iniciarRoboAgenda();
  iniciarAvisosChecklist();
  orbittaRotas.iniciarSincronizacaoOrbitta();
  orbittaExtra.iniciarExtrasOrbitta();
  notas.iniciarBuscaSefaz();
});
