const crypto = require('crypto');
const db = require('./db');

// Letras e números fáceis de ler e digitar (sem 0/O, 1/I/L)
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function normalizarCodigo(codigo) {
  return String(codigo || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function codigoAleatorio(tamanho = 6) {
  const bytes = crypto.randomBytes(tamanho);
  let s = '';
  for (let i = 0; i < tamanho; i++) s += ALFABETO[bytes[i] % ALFABETO.length];
  return s;
}

function codigoEmUso(codigo) {
  return !!(db.prepare('SELECT 1 FROM placas WHERE codigo = ?').get(codigo)
    || db.prepare('SELECT 1 FROM usuarios WHERE codigo_nfc = ?').get(codigo));
}

function gerarCodigoUnico() {
  for (let i = 0; i < 50; i++) {
    const c = codigoAleatorio();
    if (!codigoEmUso(c)) return c;
  }
  throw new Error('Não foi possível gerar um código único.');
}

// Acha a loja de um código: o código "próprio" do cliente (codigo_nfc) ou uma placa do lote vinculada a ele.
function lojaPorCodigo(codigo, colunas = 'id') {
  const bruto = String(codigo || '').trim();
  if (!bruto) return null;
  const direto = db.prepare(`SELECT ${colunas} FROM usuarios WHERE codigo_nfc = ?`).get(bruto);
  if (direto) return direto;
  const cols = colunas.split(',').map((c) => `u.${c.trim()}`).join(', ');
  return db.prepare(`SELECT ${cols} FROM placas p JOIN usuarios u ON u.id = p.usuario_id WHERE p.codigo = ?`)
    .get(normalizarCodigo(bruto)) || null;
}

function buscarPlaca(codigo) {
  const c = normalizarCodigo(codigo);
  if (!c) return null;
  return db.prepare('SELECT * FROM placas WHERE codigo = ?').get(c) || null;
}

// Vincula uma placa livre a uma loja. Devolve { ok, codigo } ou { erro }.
function vincularPlaca(codigo, usuarioId) {
  const placa = buscarPlaca(codigo);
  if (!placa) return { erro: 'Esse código de placa não existe. Confira as letras e números impressos na placa.' };
  if (placa.usuario_id && placa.usuario_id !== Number(usuarioId)) {
    return { erro: 'Essa placa já está ativada em outra loja.' };
  }
  db.prepare(`UPDATE placas SET usuario_id = ?, ativada_em = COALESCE(ativada_em, datetime('now')) WHERE codigo = ?`)
    .run(usuarioId, placa.codigo);
  return { ok: true, codigo: placa.codigo };
}

function codigosDaLoja(usuarioId) {
  return db.prepare('SELECT codigo FROM placas WHERE usuario_id = ? ORDER BY ativada_em').all(usuarioId).map((p) => p.codigo);
}

module.exports = { normalizarCodigo, gerarCodigoUnico, lojaPorCodigo, buscarPlaca, vincularPlaca, codigosDaLoja };
