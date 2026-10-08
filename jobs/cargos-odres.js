// Cria uma vez os cargos da Odres 12 (pedido do Mateus em 08/10/2026), com as mesmas lojas da Rede 12:
//  Odres 12             → quem trabalha nas lojas da Odres 12: checklist diário e leads da própria loja
//  Odres 12 Regional A  → quem gerencia a Odres 12: vê as lojas dela (Leads de cada loja, Rede de lojas)
//                         e recebe os avisos no celular. Sem "relatórios", que mostraria o checklist de todas as lojas.
// Roda só uma vez: depois disso o admin edita os cargos pelo painel e nada aqui sobrescreve.
const db = require('../db');
const permissoes = require('../lib/permissoes');

db.exec(`CREATE TABLE IF NOT EXISTS seeds_feitos (id TEXT PRIMARY KEY, feito_em TEXT DEFAULT (datetime('now')))`);

const normal = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function lojasDaRede12() {
  // Usa as lojas marcadas hoje no cargo Rede 12; se ele não tiver, procura pelo nome
  const r12 = db.prepare(`SELECT lojas FROM cargos_tag WHERE lower(trim(nome)) = 'rede 12'`).get();
  const ids = r12 ? permissoes.lerIds(r12.lojas) : [];
  if (ids.length) return ids;
  return permissoes.todasLojas().filter((l) => ['bandeira', 'valinhos', 'campinas', 'rio claro'].some((p) => normal(l.nome).includes(p))).map((l) => l.id);
}

function criarCargosOdres() {
  const ID = 'cargos-odres-12-2026-10-08';
  if (db.prepare('SELECT 1 FROM seeds_feitos WHERE id = ?').get(ID)) return;
  const lojas = lojasDaRede12();
  if (!lojas.length) { console.log('Odres 12: nenhuma loja da Rede 12 encontrada ainda, tento de novo no próximo início.'); return; }
  const cargos = [
    { nome: 'Odres 12', cor: '#7C3AED', perms: ['checklist', 'leads'] },
    { nome: 'Odres 12 Regional A', cor: '#DB2777', perms: ['leads', 'lojas', 'alertas', 'rede'] },
  ];
  let ordem = (db.prepare('SELECT MAX(ordem) AS m FROM cargos_tag').get().m || 0);
  db.transaction(() => {
    for (const c of cargos) {
      if (db.prepare('SELECT 1 FROM cargos_tag WHERE lower(trim(nome)) = lower(?)').get(c.nome)) { console.log(`Cargo ${c.nome} já existe, não mexi.`); continue; }
      db.prepare('INSERT INTO cargos_tag (nome, cor, permissoes, lojas, ordem) VALUES (?, ?, ?, ?, ?)')
        .run(c.nome, c.cor, JSON.stringify(c.perms), JSON.stringify(lojas), ++ordem);
      console.log(`Cargo ${c.nome} criado com as lojas: ${permissoes.todasLojas().filter((l) => lojas.includes(l.id)).map((l) => l.nome).join(', ')}`);
    }
    db.prepare('INSERT INTO seeds_feitos (id) VALUES (?)').run(ID);
  })();
}

// 08/10/2026: a Regional A também avalia o checklist (só das lojas da Odres 12: a permissão respeita as lojas do cargo)
function liberarAvaliacaoRegionalA() {
  const ID = 'odres-12-regional-a-relatorios-2026-10-08';
  if (db.prepare('SELECT 1 FROM seeds_feitos WHERE id = ?').get(ID)) return;
  const c = db.prepare(`SELECT id, permissoes, lojas FROM cargos_tag WHERE lower(trim(nome)) = 'odres 12 regional a'`).get();
  if (!c) return; // o cargo ainda não foi criado: tenta no próximo início
  if (!permissoes.lerIds(c.lojas).length) { console.log('Odres 12 Regional A sem lojas marcadas: não liberei relatórios (veria todas as lojas).'); return; }
  const p = [...new Set([...permissoes.lerLista(c.permissoes), 'relatorios'])];
  db.prepare('UPDATE cargos_tag SET permissoes = ? WHERE id = ?').run(JSON.stringify(p), c.id);
  db.prepare('INSERT INTO seeds_feitos (id) VALUES (?)').run(ID);
  console.log('Odres 12 Regional A agora avalia o checklist das lojas dela.');
}

/* ---------- Odres 1, 5, 9 e 14 (pedido do Mateus em 08/10/2026), igual à Odres 12 ---------- */
// Lojas: as do cargo "Rede N" quando existir com lojas (Rede 9 = Limeira). Sem lojas definidas, a Regional A
// nasce SEM permissões (cargo sem lojas enxergaria todas) e fica "pendente": quando o admin marcar as lojas
// no cargo, as permissões da regional ligam sozinhas (ver ativarRegionalPendente).
const PERMS_LOJA = ['checklist', 'leads'];
const PERMS_REGIONAL = ['leads', 'lojas', 'alertas', 'rede', 'relatorios'];
db.exec(`CREATE TABLE IF NOT EXISTS cargos_pendentes (cargo_id INTEGER PRIMARY KEY, permissoes TEXT NOT NULL)`);

function lojasDoCargo(nome) {
  const c = db.prepare('SELECT lojas FROM cargos_tag WHERE lower(trim(nome)) = lower(?)').get(nome);
  return c ? permissoes.lerIds(c.lojas) : [];
}
function criarCargosOdresDemais() {
  const ID = 'cargos-odres-1-5-9-14-2026-10-08';
  if (db.prepare('SELECT 1 FROM seeds_feitos WHERE id = ?').get(ID)) return;
  const grupos = [
    { n: 1, cor: '#0EA5E9', corReg: '#0369A1' },
    { n: 5, cor: '#F59E0B', corReg: '#B45309' },
    { n: 9, cor: '#10B981', corReg: '#047857' },
    { n: 14, cor: '#EF4444', corReg: '#B91C1C' },
  ];
  let ordem = (db.prepare('SELECT MAX(ordem) AS m FROM cargos_tag').get().m || 0);
  const nomes = new Map(permissoes.todasLojas().map((l) => [l.id, l.nome]));
  db.transaction(() => {
    for (const g of grupos) {
      const lojas = lojasDoCargo(`Rede ${g.n}`).filter((id) => nomes.has(id));
      const cargos = [
        { nome: `Odres ${g.n}`, cor: g.cor, perms: PERMS_LOJA },
        { nome: `Odres ${g.n} Regional A`, cor: g.corReg, perms: lojas.length ? PERMS_REGIONAL : [], pendente: !lojas.length },
      ];
      for (const c of cargos) {
        if (db.prepare('SELECT 1 FROM cargos_tag WHERE lower(trim(nome)) = lower(?)').get(c.nome)) { console.log(`Cargo ${c.nome} já existe, não mexi.`); continue; }
        const r = db.prepare('INSERT INTO cargos_tag (nome, cor, permissoes, lojas, ordem) VALUES (?, ?, ?, ?, ?)')
          .run(c.nome, c.cor, JSON.stringify(c.perms), JSON.stringify(lojas), ++ordem);
        if (c.pendente) db.prepare('INSERT OR REPLACE INTO cargos_pendentes (cargo_id, permissoes) VALUES (?, ?)').run(r.lastInsertRowid, JSON.stringify(PERMS_REGIONAL));
        console.log(`Cargo ${c.nome} criado ${lojas.length ? 'com as lojas: ' + lojas.map((id) => nomes.get(id)).join(', ') : 'sem lojas' + (c.pendente ? ' (permissões ligam quando marcar as lojas)' : '')}`);
      }
    }
    db.prepare('INSERT INTO seeds_feitos (id) VALUES (?)').run(ID);
  })();
}
// Chamado ao salvar um cargo: regional pendente que ganhou lojas (e continua sem permissões) recebe as permissões da regional
function ativarRegionalPendente(cargoId) {
  const p = db.prepare('SELECT permissoes FROM cargos_pendentes WHERE cargo_id = ?').get(cargoId);
  if (!p) return false;
  const c = db.prepare('SELECT permissoes, lojas FROM cargos_tag WHERE id = ?').get(cargoId);
  if (!c) { db.prepare('DELETE FROM cargos_pendentes WHERE cargo_id = ?').run(cargoId); return false; }
  const atuais = permissoes.lerLista(c.permissoes);
  if (atuais.length) { db.prepare('DELETE FROM cargos_pendentes WHERE cargo_id = ?').run(cargoId); return false; } // o admin já escolheu à mão
  const nome = (db.prepare('SELECT nome FROM cargos_tag WHERE id = ?').get(cargoId) || {}).nome;
  const n = permissoes.numeroOdres(nome);
  if (!permissoes.lerIds(c.lojas).length && !(n != null && permissoes.lojasDoGrupo(n).length)) return false;
  db.prepare('UPDATE cargos_tag SET permissoes = ? WHERE id = ?').run(p.permissoes, cargoId);
  db.prepare('DELETE FROM cargos_pendentes WHERE cargo_id = ?').run(cargoId);
  return true;
}

// Alguma loja ganhou a tag da rede: liga as regionais pendentes que agora têm loja
function ativarPendentesComLojas() {
  let ligou = false;
  try { for (const r of db.prepare('SELECT cargo_id FROM cargos_pendentes').all()) if (ativarRegionalPendente(r.cargo_id)) ligou = true; } catch (e) { /* sem tabela */ }
  return ligou;
}

// 08/10/2026 (pedido do Mateus): a loja "Orvalho 1" entra na rede Odres 1, pra o André (Odres 1 Regional A)
// controlar ela e os relatórios dela junto com as outras. Roda uma vez; se a conta ou o cargo não existirem, tenta no próximo início.
function ligarOrvalho1NaOdres1() {
  const ID = 'orvalho-1-na-odres-1-2026-10-08';
  if (db.prepare('SELECT 1 FROM seeds_feitos WHERE id = ?').get(ID)) return;
  const contas = db.prepare(`SELECT id, nome, negocio_nome, checklist_ativo, checklist_por_tag FROM usuarios
    WHERE is_admin = 0 AND (lower(trim(nome)) = 'orvalho 1' OR lower(trim(COALESCE(negocio_nome, ''))) = 'orvalho 1')`).all();
  const cargo = db.prepare("SELECT id FROM cargos_tag WHERE lower(trim(nome)) = 'odres 1'").get();
  if (contas.length !== 1 || !cargo) { console.log(`Orvalho 1 → Odres 1: ${contas.length} conta(s) "Orvalho 1" e cargo ${cargo ? 'ok' : 'não encontrado'}; não mexi.`); return; }
  const u = contas[0];
  const hoje = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO usuario_cargos_tag (usuario_id, cargo_id) VALUES (?, ?)').run(u.id, cargo.id);
    // Conta como loja de verdade da rede (não como quem só ganhou o checklist por causa de um cargo)
    if (!u.checklist_ativo) db.prepare('UPDATE usuarios SET checklist_ativo = 1, checklist_desde = ?, checklist_por_tag = 0 WHERE id = ?').run(hoje, u.id);
    else if (u.checklist_por_tag) db.prepare('UPDATE usuarios SET checklist_por_tag = 0 WHERE id = ?').run(u.id);
    db.prepare('INSERT INTO seeds_feitos (id) VALUES (?)').run(ID);
  })();
  try { ativarPendentesComLojas(); } catch (e) { /* segue */ }
  console.log(`Orvalho 1 (conta ${u.id}) entrou na Odres 1.`);
}

module.exports = { criarCargosOdres, liberarAvaliacaoRegionalA, criarCargosOdresDemais, ativarRegionalPendente, ativarPendentesComLojas, ligarOrvalho1NaOdres1 };
