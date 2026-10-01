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
// Link do Google colado pelo comercial (usado quando não dá pra extrair o Place ID dele)
try { db.exec(`ALTER TABLE usuarios ADD COLUMN link_google TEXT`); }
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

// Registra cada scan da placa NFC com data/hora, pra montar gráficos por dia/semana/mês
db.exec(`
  CREATE TABLE IF NOT EXISTS scans_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    criado_em TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
  )
`);

// Avaliações feitas pela placa (tela rápida antes de seguir pro Google).
// Formam o mural/portfólio do lojista. "visivel" = aparece no portfólio público.
db.exec(`
  CREATE TABLE IF NOT EXISTS avaliacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    nota INTEGER NOT NULL,
    comentario TEXT,
    nome TEXT,
    visivel INTEGER NOT NULL DEFAULT 1,
    ip_hash TEXT,
    criado_em TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_avaliacoes_usuario ON avaliacoes(usuario_id, criado_em)`);

// LGPD: quando a pessoa aceitou os Termos de Uso e a Política de Privacidade
try { db.exec(`ALTER TABLE usuarios ADD COLUMN aceite_termos_em TEXT`); }
catch (e) { /* coluna já existe, tudo bem */ }

// Premium: até quando a mensalidade está paga (data ISO). NULL = sem controle
// (contas antigas continuam como estão até o primeiro pagamento pelo sistema novo).
try { db.exec(`ALTER TABLE usuarios ADD COLUMN premium_ate TEXT`); }
catch (e) { /* coluna já existe, tudo bem */ }
try { db.exec(`ALTER TABLE usuarios ADD COLUMN assinatura_status TEXT`); }
catch (e) { /* coluna já existe, tudo bem */ }
try { db.exec(`ALTER TABLE usuarios ADD COLUMN assinatura_id TEXT`); }
catch (e) { /* coluna já existe, tudo bem */ }

// Correções pontuais de dados, aplicadas uma única vez (ficam registradas em "migracoes")
db.exec(`CREATE TABLE IF NOT EXISTS migracoes (nome TEXT PRIMARY KEY, aplicada_em TEXT DEFAULT (datetime('now')))`);
function migrarUmaVez(nome, fn) {
  if (db.prepare('SELECT 1 FROM migracoes WHERE nome = ?').get(nome)) return;
  db.transaction(() => { fn(); db.prepare('INSERT INTO migracoes (nome) VALUES (?)').run(nome); })();
}

// Casa do Celular (Av. John Boyd Dunlop, Campinas): link de avaliação do Google informado pelo dono
migrarUmaVez('2026-09-30-google-casa-do-celular', () => {
  db.prepare(`UPDATE usuarios SET google_place_id = ?, link_google = ? WHERE codigo_nfc = ?`)
    .run('ChIJAQAAbxrIyJQRgTH76gTMV6I', 'https://search.google.com/local/writereview?placeid=ChIJAQAAbxrIyJQRgTH76gTMV6I', '4ccc0b2f');
});


// Placas impressas em lote: cada uma tem um código único e fica "livre" até o comercial
// ou o admin vincular a uma loja. Uma loja pode ter várias placas (ex.: uma por mesa).
db.exec(`
  CREATE TABLE IF NOT EXISTS placas (
    codigo TEXT PRIMARY KEY,
    lote TEXT NOT NULL,
    usuario_id INTEGER,
    criado_em TEXT DEFAULT (datetime('now')),
    ativada_em TEXT,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_placas_lote ON placas(lote)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_placas_usuario ON placas(usuario_id)`);


// Pix de teste (R$ 1) gerado pelo admin pra conferir o Mercado Pago + webhook, sem criar venda nem cliente
db.exec(`
  CREATE TABLE IF NOT EXISTS pix_testes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mp_payment_id TEXT,
    valor REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendente',
    confirmado_por_webhook INTEGER NOT NULL DEFAULT 0,
    criado_em TEXT DEFAULT (datetime('now')),
    pago_em TEXT
  )
`);


// WhatsApp do cliente (opcional, informado pelo comercial) e plano escolhido no cadastro pelo site
try { db.exec(`ALTER TABLE usuarios ADD COLUMN telefone TEXT`); } catch (e) { /* já existe */ }
try { db.exec(`ALTER TABLE usuarios ADD COLUMN plano_desejado TEXT`); } catch (e) { /* já existe */ }
// Recibo da venda enviado por e-mail (uma vez só)
try { db.exec(`ALTER TABLE vendas ADD COLUMN recibo_enviado_em TEXT`); } catch (e) { /* já existe */ }

// Pedidos de placas extras feitos pelo próprio lojista no painel
db.exec(`
  CREATE TABLE IF NOT EXISTS pedidos_placas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    quantidade INTEGER NOT NULL,
    valor REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'aguardando_pagamento',
    criado_em TEXT DEFAULT (datetime('now')),
    pago_em TEXT,
    entregue_em TEXT,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
  )
`);


// Depoimentos de clientes (cadastrados pelo admin) que aparecem no site
db.exec(`
  CREATE TABLE IF NOT EXISTS depoimentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    negocio TEXT,
    cidade TEXT,
    texto TEXT NOT NULL,
    nota INTEGER NOT NULL DEFAULT 5,
    visivel INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT DEFAULT (datetime('now'))
  )
`);
// Meta mensal de vendas confirmadas de cada vendedor (0 = sem meta)
try { db.exec(`ALTER TABLE usuarios ADD COLUMN meta_mensal INTEGER NOT NULL DEFAULT 0`); } catch (e) { /* já existe */ }

// Cardápio 3D (Premium): pratos com modelo .glb e foto, guardados na pasta "arquivos" ao lado do banco
db.exec(`
  CREATE TABLE IF NOT EXISTS pratos_3d (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    nome TEXT NOT NULL,
    descricao TEXT,
    categoria TEXT,
    preco REAL,
    modelo TEXT,
    foto TEXT,
    ordem INTEGER NOT NULL DEFAULT 0,
    ativo INTEGER NOT NULL DEFAULT 1,
    visualizacoes INTEGER NOT NULL DEFAULT 0,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pratos_3d_usuario ON pratos_3d(usuario_id);
`);

// Cardápio digital: configurações de pedido da loja e pedidos feitos pelo cliente no celular
try { db.exec(`ALTER TABLE usuarios ADD COLUMN cardapio_config TEXT`); } catch (e) { /* já existe */ }
db.exec(`
  CREATE TABLE IF NOT EXISTS pedidos_online (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    itens TEXT NOT NULL,
    subtotal REAL NOT NULL,
    taxa REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL,
    modo TEXT NOT NULL,
    mesa TEXT,
    nome TEXT,
    telefone TEXT,
    endereco TEXT,
    pagamento TEXT,
    troco TEXT,
    obs TEXT,
    status TEXT NOT NULL DEFAULT 'novo',
    importado INTEGER NOT NULL DEFAULT 0,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pedidos_online_usuario ON pedidos_online(usuario_id, importado);
`);

module.exports = db;
module.exports.PASTA_ARQUIVOS = path.join(path.dirname(dbPath), 'arquivos');
