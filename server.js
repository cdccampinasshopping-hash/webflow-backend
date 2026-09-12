// server.js
// Ponto de entrada do backend. Roda o servidor Express com as rotas de
// autenticação (/api/auth) e de dados do painel (/api/dados).

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const dadosRoutes = require('./routes/dados');
const { exigirLogin } = require('./middleware/auth');

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

// Tratamento simples de rota não encontrada
app.use((req, res) => {
  res.status(404).json({ erro: 'Rota não encontrada.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webflow API rodando em http://localhost:${PORT}`);
});
