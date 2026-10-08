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
// Lojas que o cargo enxerga (lista de ids de contas). Vazio = todas as lojas.
try { db.exec(`ALTER TABLE cargos_tag ADD COLUMN lojas TEXT NOT NULL DEFAULT '[]'`); } catch (e) { /* já existe */ }
// Lojas que a própria pessoa silenciou nos avisos do celular
try { db.exec(`ALTER TABLE usuarios ADD COLUMN alerta_lojas_off TEXT`); } catch (e) { /* já existe */ }
// Marca quem teve o checklist ligado só por causa de um cargo (pra desligar se o cargo sair)
try { db.exec(`ALTER TABLE usuarios ADD COLUMN checklist_por_tag INTEGER NOT NULL DEFAULT 0`); } catch (e) { /* já existe */ }

const PERMISSOES = [
  { id: 'checklist', nome: 'Preencher o checklist diário', dica: 'Responde as perguntas do dia com comprovante' },
  { id: 'leads', nome: 'Ver a aba Leads', dica: 'Leads do dia, Orbitta, placar e reativação' },
  { id: 'relatorios', nome: 'Ver e avaliar relatórios', dica: 'Relatórios do checklist e rede de lojas' },
  { id: 'alertas', nome: 'Receber alertas no celular', dica: 'Cliente sem resposta e fechamento das 22h das lojas escolhidas no cargo' },
  { id: 'rede', nome: 'Ver Rede de lojas', dica: 'Ranking das lojas lado a lado (conversão, tempo de resposta, sem resposta e checklist). Só as lojas marcadas no cargo' },
  { id: 'lojas', nome: 'Ver outras lojas', dica: 'Escolhe no topo da aba Leads qual loja olhar: leads, não respondidos, sem resposta e Orbitta' },
];
const IDS = PERMISSOES.map((p) => p.id);

function lerLista(t) { try { const a = JSON.parse(t || '[]'); return Array.isArray(a) ? a.filter((x) => IDS.includes(x)) : []; } catch (e) { return []; } }

function lerIds(t) { try { const a = JSON.parse(t || '[]'); return Array.isArray(a) ? [...new Set(a.map(Number).filter((x) => Number.isInteger(x) && x > 0))] : []; } catch (e) { return []; } }

// Redes "Rede N" / "Odres N" / "Odres N Regional A": são a mesma rede. As lojas da rede são as marcadas em qualquer
// um desses cargos MAIS as contas de loja que receberam uma dessas tags (ex.: a loja com a tag "Odres 1").
function numeroOdres(nome) { const m = String(nome || '').trim().match(/^(?:rede|odres)\s*(\d+)\b/i); return m ? Number(m[1]) : null; }
function lojasDoGrupo(n) {
  const cargos = db.prepare('SELECT id, nome, lojas FROM cargos_tag').all().filter((c) => numeroOdres(c.nome) === n);
  const ids = new Set(cargos.flatMap((c) => lerIds(c.lojas)));
  if (cargos.length) {
    const lojas = new Set(todasLojas().map((l) => l.id));
    db.prepare(`SELECT usuario_id FROM usuario_cargos_tag WHERE cargo_id IN (${cargos.map(() => '?').join(',')})`).all(...cargos.map((c) => c.id))
      .forEach((r) => { if (lojas.has(r.usuario_id)) ids.add(r.usuario_id); });
  }
  return [...ids];
}
function cargosDe(usuarioId) {
  return db.prepare(`SELECT c.id, c.nome, c.cor, c.permissoes, c.lojas FROM cargos_tag c JOIN usuario_cargos_tag uc ON uc.cargo_id = c.id
    WHERE uc.usuario_id = ? ORDER BY c.ordem, c.id`).all(usuarioId).map((c) => {
    const n = numeroOdres(c.nome);
    return { ...c, permissoes: lerLista(c.permissoes), lojas: n != null ? lojasDoGrupo(n) : lerIds(c.lojas) };
  });
}

// Todas as lojas da rede: contas de loja com checklist ligado ou ligadas ao Orbitta
// (quem só ganhou o checklist por causa de um cargo não é loja)
function todasLojas() {
  return db.prepare(`SELECT id, nome, negocio_nome FROM usuarios WHERE is_admin = 0 AND cargo IN ('lojista', 'checklist')
      AND ((checklist_ativo = 1 AND checklist_por_tag = 0) OR (orbitta_vinculo IS NOT NULL AND orbitta_vinculo <> ''))
    ORDER BY COALESCE(negocio_nome, nome)`).all().map((u) => ({ id: u.id, nome: u.negocio_nome || u.nome }));
}

// Lojas que a pessoa alcança por uma permissão (somando os cargos). Cargo sem lojas marcadas = todas.
function lojasPor(usuarioId, permissao) {
  const cargos = cargosDe(usuarioId).filter((c) => c.permissoes.includes(permissao));
  if (!cargos.length) return [];
  const todas = todasLojas().filter((l) => l.id !== Number(usuarioId));
  if (cargos.some((c) => !c.lojas.length)) return todas;
  const ids = new Set(cargos.flatMap((c) => c.lojas));
  return todas.filter((l) => ids.has(l.id));
}
function lojasVisiveis(usuarioId) { return lojasPor(usuarioId, 'lojas'); }
// Conta "controle" com tags de rede: as tags limitam o que ela vê (ex.: André com "Odres 1 Regional A" vê só a Odres 1).
// null = sem limite (nenhuma tag com lojas, ou alguma tag que libera todas as lojas).
const PERMS_COM_LOJAS = ['lojas', 'rede', 'relatorios', 'alertas'];
function escopoTags(usuarioId) {
  const cs = cargosDe(usuarioId);
  let pendentes = new Set();
  try { pendentes = new Set(db.prepare('SELECT cargo_id FROM cargos_pendentes').all().map((r) => r.cargo_id)); } catch (e) { /* tabela ainda não existe */ }
  const comLojas = cs.filter((c) => c.lojas.length);
  if (!comLojas.length && !cs.some((c) => pendentes.has(c.id))) return null;
  if (cs.some((c) => !c.lojas.length && c.permissoes.some((p) => PERMS_COM_LOJAS.includes(p)))) return null;
  return new Set(comLojas.flatMap((c) => c.lojas));
}
// Lojas a que a permissão se limita: null = sem limite (algum cargo com a permissão não marcou lojas)
function lojasRestritas(usuarioId, permissao) {
  const cargos = cargosDe(usuarioId).filter((c) => c.permissoes.includes(permissao));
  if (!cargos.length || cargos.some((c) => !c.lojas.length)) return null;
  return new Set(cargos.flatMap((c) => c.lojas));
}

// Quem recebe o aviso de uma loja: quem tem um cargo com "alertas" que cobre essa loja
// e não silenciou a loja no próprio celular
function destinosAlerta(lojaId) {
  const lojaNum = Number(lojaId);
  const linhas = db.prepare(`SELECT uc.usuario_id, c.permissoes, c.lojas, u.alerta_lojas_off FROM usuario_cargos_tag uc
    JOIN cargos_tag c ON c.id = uc.cargo_id JOIN usuarios u ON u.id = uc.usuario_id`).all();
  const ids = new Set();
  for (const r of linhas) {
    if (!lerLista(r.permissoes).includes('alertas')) continue;
    const lojas = lerIds(r.lojas);
    if (lojas.length && !lojas.includes(lojaNum)) continue;
    if (lerIds(r.alerta_lojas_off).includes(lojaNum)) continue;
    ids.add(r.usuario_id);
  }
  return [...ids];
}

// O cargo "ADM" criado pelo dono passa a ver todas as lojas e receber os avisos delas
if (!db.prepare('SELECT 1 FROM migracoes WHERE nome = ?').get('2026-10-07-adm-ver-lojas')) {
  db.transaction(() => {
    for (const c of db.prepare(`SELECT id, permissoes FROM cargos_tag WHERE LOWER(TRIM(nome)) IN ('adm', 'admin', 'administrador')`).all()) {
      const p = [...new Set([...lerLista(c.permissoes), 'leads', 'lojas', 'alertas'])];
      db.prepare('UPDATE cargos_tag SET permissoes = ? WHERE id = ?').run(JSON.stringify(p), c.id);
      const hoje = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
      for (const r of db.prepare('SELECT usuario_id FROM usuario_cargos_tag WHERE cargo_id = ?').all(c.id)) sincronizarChecklist(r.usuario_id, hoje);
    }
    db.prepare('INSERT INTO migracoes (nome) VALUES (?)').run('2026-10-07-adm-ver-lojas');
  })();
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
  const precisa = p.includes('checklist') || p.includes('leads') || p.includes('lojas');
  if (precisa && !u.checklist_ativo) {
    db.prepare('UPDATE usuarios SET checklist_ativo = 1, checklist_desde = ?, checklist_por_tag = 1 WHERE id = ?').run(hoje, u.id);
  } else if (!precisa && u.checklist_ativo && u.checklist_por_tag) {
    db.prepare('UPDATE usuarios SET checklist_ativo = 0, checklist_por_tag = 0 WHERE id = ?').run(u.id);
  }
}

module.exports = { PERMISSOES, IDS, lerLista, lerIds, numeroOdres, lojasDoGrupo, cargosDe, todasLojas, lojasPor, lojasVisiveis, lojasRestritas, escopoTags, destinosAlerta, permissoesDeTags, tem, sincronizarChecklist };
