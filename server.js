require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const dadosRoutes = require('./routes/dados');
const suporteRoutes = require('./routes/suporte');
const adminRoutes = require('./routes/admin');
const { exigirLogin, exigirAdmin } = require('./middleware/auth');

if (!process.env.JWT_SECRET) {
  console.error('ERRO: defina JWT_SECRET no arquivo .env antes de rodar o servidor (veja .env.example).');
  process.exit(1);
}

const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', servico: 'Webflow API' });
});

app.use('/api/auth', authRoutes);
app.use('/api/dados', exigirLogin, dadosRoutes);
app.use('/api/suporte', exigirLogin, suporteRoutes);
app.use('/api/admin', exigirLogin, exigirAdmin, adminRoutes);

app.use((req, res) => {
  res.status(404).json({ erro: 'Rota não encontrada.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Webflow API rodando na porta ${PORT}`);
});
