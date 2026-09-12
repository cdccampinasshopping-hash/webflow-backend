// db.js
// Banco de dados SQLite em arquivo único (webflow.db). Não precisa contratar
// nenhum serviço de banco separado — o arquivo é criado sozinho na primeira vez
// que o servidor roda. Se o negócio crescer muito, dá pra trocar por Postgres
// depois, mas pra começar isso é mais que suficiente.

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'webflow.db'));
db.pragma('journal_mode = WAL');

// Tabela de usuários (os clientes que compraram um plano do Webflow)
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    senha_hash TEXT NOT NULL,
    negocio_nome TEXT,
    segmento TEXT NOT NULL DEFAULT 'restaurante',
    plano TEXT NOT NULL DEFAULT 'basico',
    criado_em TEXT DEFAULT (datetime('now'))
  )
`);

// Tabela genérica de dados por usuário: guarda o "estado" do painel de gestão
// (pedidos, estoque, financeiro etc.) isolado por cliente, no mesmo formato de
// chave/valor que o painel (webflow.html) já usa hoje com window.storage —
// assim a migração do front-end fica simples (ver README).
db.exec(`
  CREATE TABLE IF NOT EXISTS dados (
    usuario_id INTEGER NOT NULL,
    chave TEXT NOT NULL,
    valor TEXT,
    atualizado_em TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (usuario_id, chave),
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
  )
`);

module.exports = db;
