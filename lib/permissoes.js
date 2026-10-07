// Cargos tipo Discord: o admin cria cargos (nome + cor), marca o que cada um libera
// e coloca quantos cargos quiser em cada pessoa. As permissões se somam ao cargo base da conta.
const db = require('../db');

db.exec(`CREATE TABLE IF NOT EXISTS cargos_tag (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  cor TEXT NOT NULL DEFAULT '#5865F2',
  permissoes TEXT NOT NULL DEFAULT '[]',
  ordem INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT DEFAULT (datetime('now'))
)`);
db.exec(`CREATE TABLE IF NOT EXISTS usuario_cargos_tag (
  usuario_id INTEGER NOT NULL,
  cargo_id INTEGER NOT NULL,
  PRIMARY KEY (usuario_id, cargo_id)
)`);
// Marca quem teve o checklist ligado só por causa de um cargo (pra desligar se o cargo sair)
try { db.exec(`ALTER TABLE usuarios ADD COLUMN checklist_por_tag INTEGER NOT NULL DEFAULT 0`); } catch (e) { /* já existe */ }

const PERMISSOES = [
  { id: 'checklist', nome: 'Preencher o checklist diário', dica: 'Responde as perguntas do dia com comprovante' },
  { id: 'leads', nome: 'Ver a aba Leads', dica: 'Leads do dia, Orbitta, placar e reativação' },
  { id: 'relatorios', nome: 'Ver e avaliar relatórios', dica: 'Relatórios do checklist e rede de lojas' },
  { id: 'alertas', nome: 'Receber alertas no celular', dica: 'Cliente sem resposta e fechamento das 22h de todas as lojas' },
];
const IDS = PERMISSOES.map((p) => p.id);

function lerLista(t) { try { const a = JSON.parse(t || '[]'); return Array.isArray(a) ? a.filter((x) => IDS.includes(x)) : []; } catch (e) { return []; } }

function cargosDe(usuarioId) {
  return db.prepare(`SELECT c.id, c.nome, c.cor, c.permissoes FROM cargos_tag c JOIN usuario_cargos_tag uc ON uc.cargo_id = c.id
    WHERE uc.usuario_id = ? ORDER BY c.ordem, c.id`).all(usuarioId).map((c) => ({ ...c, permissoes: lerLista(c.permissoes) }));
}

// Permissões vindas só dos cargos (tags)
function permissoesDeTags(usuarioId) {
  return [...new Set(cargosDe(usuarioId).flatMap((c) => c.permissoes))];
}

function tem(usuarioId, permissao) {
  return permissoesDeTags(usuarioId).includes(permissao);
}

// Liga/desliga o checklist conforme os cargos (checklist ou leads precisam dele ligado)
function sincronizarChecklist(usuarioId, hoje) {
  const u = db.prepare('SELECT id, cargo, checklist_ativo, checklist_por_tag FROM usuarios WHERE id = ?').get(usuarioId);
  if (!u) return;
  const p = permissoesDeTags(usuarioId);
  const precisa = p.includes('checklist') || p.includes('leads');
  if (precisa && !u.checklist_ativo) {
    db.prepare('UPDATE usuarios SET checklist_ativo = 1, checklist_desde = ?, checklist_por_tag = 1 WHERE id = ?').run(hoje, u.id);
  } else if (!precisa && u.checklist_ativo && u.checklist_por_tag) {
    db.prepare('UPDATE usuarios SET checklist_ativo = 0, checklist_por_tag = 0 WHERE id = ?').run(u.id);
  }
}

module.exports = { PERMISSOES, IDS, lerLista, cargosDe, permissoesDeTags, tem, sincronizarChecklist };
