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

module.exports = { criarCargosOdres };
