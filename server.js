require('dotenv').config();
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');

const db = require('./db');
const authRoutes = require('./routes/auth');
const dadosRoutes = require('./routes/dados');
const suporteRoutes = require('./routes/suporte');
const adminRoutes = require('./routes/admin');
const comercialRoutes = require('./routes/comercial');
const pagamentosRoutes = require('./routes/pagamentos');
const webhookPagamentosRoutes = require('./routes/webhook-pagamentos');
const avaliacoesRoutes = require('./routes/avaliacoes');
const { exigirLogin, exigirAdmin } = require('./middleware/auth');
const { iniciarAgendamentoBackup } = require('./jobs/backup');
const { iniciarVerificacaoAssinaturas } = require('./jobs/assinaturas');
const { iniciarRelatoriosMensais } = require('./jobs/relatorio-mensal');

if (!process.env.JWT_SECRET) {
  console.error('ERRO: defina JWT_SECRET no arquivo .env antes de rodar o servidor (veja .env.example).');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // Railway fica atrás de proxy: garante https nos links gerados
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }));
app.use(express.json());

const SITE_URL = process.env.SITE_URL || 'https://webflowservices.com';

app.get('/', (req, res) => {
  res.json({ status: 'ok', servico: 'Webflow API' });
});

// Rota pública da placa NFC — sem login, é chamada pelo celular do cliente final.
// Conta o scan e manda direto pra tela de avaliação do Google do negócio.
app.get('/r/:codigo', (req, res) => {
  const cliente = db.prepare('SELECT id, google_place_id, link_google FROM usuarios WHERE codigo_nfc = ?').get(req.params.codigo);

  if (!cliente) {
    return res.redirect(`${SITE_URL}/link-invalido.html`);
  }

  db.prepare('UPDATE usuarios SET nfc_scans = nfc_scans + 1 WHERE id = ?').run(cliente.id);
  db.prepare('INSERT INTO scans_log (usuario_id) VALUES (?)').run(cliente.id);

  // Primeiro abre a tela rápida da loja (nota + comentário, que vão pro mural do lojista);
  // de lá o cliente segue pro Google, qualquer que seja a nota.
  if (process.env.PLACA_DIRETO_GOOGLE !== '1') {
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
  const cliente = db.prepare('SELECT id FROM usuarios WHERE codigo_nfc = ?').get(req.params.codigo);
  if (!cliente) return res.status(404).json({ erro: 'Código não encontrado.' });

  const base = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
  try {
    const png = await QRCode.toBuffer(`${base}/r/${req.params.codigo}`, { width: 600, margin: 2 });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    if (req.query.download) res.set('Content-Disposition', `attachment; filename="placa-${req.params.codigo}.png"`);
    res.send(png);
  } catch (e) {
    console.error('Erro ao gerar QR', e);
    res.status(500).json({ erro: 'Não foi possível gerar o QR Code.' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/dados', exigirLogin, dadosRoutes);
app.use('/api/suporte', exigirLogin, suporteRoutes);
app.use('/api/admin', exigirLogin, exigirAdmin, adminRoutes);
app.use('/api/comercial', comercialRoutes);
app.use('/api/pagamentos/webhook', webhookPagamentosRoutes);
app.use('/api/pagamentos', exigirLogin, pagamentosRoutes);
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
});
