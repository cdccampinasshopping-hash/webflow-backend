// Cria uma vez os cargos das redes (pedido do Mateus em 08/10/2026), já com as lojas de cada rede.
//  Rede 12: Bandeiras, Valinhos, Campinas, Rio Claro
//  Rede 9:  Limeira
//  Rede 14: ainda sem lojas — criado SEM permissão (cargo sem lojas enxergaria a rede inteira).
//           Marque as lojas e a permissão "Ver Rede de lojas" no painel quando definir.
// Roda só uma vez: depois disso o admin edita os cargos pelo painel e nada aqui sobrescreve.
const db = require('../db');
const permissoes = require('../lib/permissoes');

db.exec(`CREATE TABLE IF NOT EXISTS seeds_feitos (id TEXT PRIMARY KEY, feito_em TEXT DEFAULT (datetime('now')))`);

const REDES = [
  { nome: 'Rede 12', cor: '#2563EB', lojas: ['bandeira', 'valinhos', 'campinas', 'rio claro'] },
  { nome: 'Rede 9', cor: '#16A34A', lojas: ['limeira'] },
  { nome: 'Rede 14', cor: '#D97706', lojas: [] },
];
const normal = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function criarCargosRedes() {
  const ID = 'cargos-redes-2026-10-08';
  if (db.prepare('SELECT 1 FROM seeds_feitos WHERE id = ?').get(ID)) return;
  const todas = permissoes.todasLojas();
  let ordem = (db.prepare('SELECT MAX(ordem) AS m FROM cargos_tag').get().m || 0);
  for (const r of REDES) {
    if (db.prepare('SELECT 1 FROM cargos_tag WHERE lower(nome) = lower(?)').get(r.nome)) { console.log(`Cargo ${r.nome} já existe, não mexi.`); continue; }
    const ids = todas.filter((l) => r.lojas.some((p) => normal(l.nome).includes(p))).map((l) => l.id);
    // Sem nenhuma loja encontrada o cargo fica sem permissão (senão veria todas as lojas)
    const perms = ids.length ? ['rede'] : [];
    db.prepare('INSERT INTO cargos_tag (nome, cor, permissoes, lojas, ordem) VALUES (?, ?, ?, ?, ?)')
      .run(r.nome, r.cor, JSON.stringify(perms), JSON.stringify(ids), ++ordem);
    console.log(`Cargo ${r.nome} criado com as lojas: ${todas.filter((l) => ids.includes(l.id)).map((l) => l.nome).join(', ') || '(nenhuma)'}`);
  }
  db.prepare('INSERT INTO seeds_feitos (id) VALUES (?)').run(ID);
}

module.exports = { criarCargosRedes };
