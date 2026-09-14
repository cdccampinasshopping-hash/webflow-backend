require('dotenv').config();
const express = require('express');
const cors = require('cors');

const db = require('./db');
const authRoutes = require('./routes/auth');
const dadosRoutes = require('./routes/dados');
const suporteRoutes = require('./routes/suporte');
const adminRoutes = require('./routes/admin');
const comercialRoutes = require('./routes/comercial');
const pagamentosRoutes = require('./routes/pagamentos');
const webhookPagamentosRoutes = require('./routes/webhook-pagamentos');
const { exigirLogin, exigirAdmin } = require('./middleware/auth');

if (!process.env.JWT_SECRET) {
  console.error('ERRO: defina JWT_SECRET no arquivo .env antes de rodar o servidor (veja .env.example).');
  process.exit(1);
}

const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }));
app.use(express.json());

const SITE_URL = process.env.SITE_URL || 'https://webflowservices.com';

app.get('/', (req, res) => {
  res.json({ status: 'ok', servico: 'Webflow API' });
});

// Rota pública da placa NFC — sem login, é chamada pelo celular do cliente final.
// Conta o scan e manda direto pra tela de avaliação do Google do negócio.
app.get('/r/:codigo', (req, res) => {
  const cliente = db.prepare('SELECT id, google_place_id FROM usuarios WHERE codigo_nfc = ?').get(req.params.codigo);

  if (!cliente) {
    return res.redirect(`${SITE_URL}/link-invalido.html`);
  }

  db.prepare('UPDATE usuarios SET nfc_scans = nfc_scans + 1 WHERE id = ?').run(cliente.id);

  if (!cliente.google_place_id) {
    return res.redirect(`${SITE_URL}/avaliacao-pendente.html`);
  }

  const urlGoogle = `https://search.google.com/local/writereview?placeid=${cliente.google_place_id}`;
  res.redirect(302, urlGoogle);
});

app.use('/api/auth', authRoutes);
app.use('/api/dados', exigirLogin, dadosRoutes);
app.use('/api/suporte', exigirLogin, suporteRoutes);
app.use('/api/admin', exigirLogin, exigirAdmin, adminRoutes);
app.use('/api/comercial', comercialRoutes);
app.use('/api/pagamentos/webhook', webhookPagamentosRoutes);
app.use('/api/pagamentos', exigirLogin, pagamentosRoutes);

app.use((req, res) => {
  res.status(404).json({ erro: 'Rota não encontrada.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Webflow API rodando na porta ${PORT}`);
});
