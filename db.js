const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'webflow.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

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

try { db.exec(`ALTER TABLE usuarios ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`); }
catch (e) { /* coluna já existe, tudo bem */ }

try { db.exec(`ALTER TABLE usuarios ADD COLUMN reset_token_hash TEXT`); }
catch (e) { /* coluna já existe, tudo bem */ }
try { db.exec(`ALTER TABLE usuarios ADD COLUMN reset_token_expira TEXT`); }
catch (e) { /* coluna já existe, tudo bem */ }

// Colunas da funcionalidade de placa NFC de avaliação Google
try { db.exec(`ALTER TABLE usuarios ADD COLUMN codigo_nfc TEXT`); }
catch (e) { /* coluna já existe, tudo bem */ }
try { db.exec(`ALTER TABLE usuarios ADD COLUMN google_place_id TEXT`); }
catch (e) { /* coluna já existe, tudo bem */ }
try { db.exec(`ALTER TABLE usuarios ADD COLUMN nfc_scans INTEGER NOT NULL DEFAULT 0`); }
catch (e) { /* coluna já existe, tudo bem */ }

// Marca quem é do time comercial (etiquetado manualmente pelo admin)
try { db.exec(`ALTER TABLE usuarios ADD COLUMN is_comercial INTEGER NOT NULL DEFAULT 0`); }
catch (e) { /* coluna já existe, tudo bem */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS suporte (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    assunto TEXT NOT NULL,
    mensagem TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'aberto',
    criado_em TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
  )
`);

// Tabela de vendas feitas pelo time comercial (cada venda gera/ativa um cliente)
db.exec(`
  CREATE TABLE IF NOT EXISTS vendas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    vendedor_id INTEGER NOT NULL,
    forma_pagamento TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendente',
    valor REAL NOT NULL,
    criado_em TEXT DEFAULT (datetime('now')),
    confirmado_em TEXT,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id),
    FOREIGN KEY (vendedor_id) REFERENCES usuarios(id)
  )
`);

// Guarda o ID do pagamento Pix no Mercado Pago, pra reconhecer no webhook
try { db.exec(`ALTER TABLE vendas ADD COLUMN mp_payment_id TEXT`); }
catch (e) { /* coluna já existe, tudo bem */ }

module.exports = db;
