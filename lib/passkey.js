// Login com Face ID / digital (WebAuthn / passkeys), sem dependências externas.
// O rosto/digital nunca chega aqui: o celular confere a pessoa e assina um desafio
// com uma chave privada que fica só no aparelho. Aqui guardamos a chave PÚBLICA e conferimos a assinatura.
const crypto = require('crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const deB64url = (s) => Buffer.from(String(s || ''), 'base64url');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

// ---------- leitor de CBOR (só o necessário pro WebAuthn) ----------
function lerCbor(buf) {
  let pos = 0;
  function tamanho(info) {
    if (info < 24) return info;
    if (info === 24) return buf[pos++];
    if (info === 25) { const v = buf.readUInt16BE(pos); pos += 2; return v; }
    if (info === 26) { const v = buf.readUInt32BE(pos); pos += 4; return v; }
    if (info === 27) { const v = Number(buf.readBigUInt64BE(pos)); pos += 8; return v; }
    throw new Error('CBOR: tamanho não suportado');
  }
  function item() {
    const b = buf[pos++];
    const tipo = b >> 5, info = b & 31;
    if (tipo === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22 || info === 23) return null;
      throw new Error('CBOR: tipo simples não suportado');
    }
    const n = tamanho(info);
    switch (tipo) {
      case 0: return n;
      case 1: return -1 - n;
      case 2: { const v = buf.subarray(pos, pos + n); pos += n; return Buffer.from(v); }
      case 3: { const v = buf.toString('utf8', pos, pos + n); pos += n; return v; }
      case 4: { const a = []; for (let i = 0; i < n; i++) a.push(item()); return a; }
      case 5: { const m = new Map(); for (let i = 0; i < n; i++) { const k = item(); m.set(k, item()); } return m; }
      case 6: return item(); // tag: ignora e devolve o conteúdo
      default: throw new Error('CBOR: tipo não suportado');
    }
  }
  const valor = item();
  return { valor, lidos: pos };
}

// ---------- authenticatorData ----------
function lerAuthData(ad) {
  if (ad.length < 37) throw new Error('authData curto demais');
  const r = { rpIdHash: ad.subarray(0, 32), flags: ad[32], contador: ad.readUInt32BE(33) };
  r.up = !!(r.flags & 0x01); // pessoa presente
  r.uv = !!(r.flags & 0x04); // pessoa verificada (rosto/digital/PIN do aparelho)
  if (r.flags & 0x40) {      // tem a credencial nova (só no cadastro)
    let p = 37 + 16;          // pula o AAGUID
    const len = ad.readUInt16BE(p); p += 2;
    r.credId = ad.subarray(p, p + len); p += len;
    const { valor } = lerCbor(ad.subarray(p));
    r.coseKey = valor;
  }
  return r;
}

// Chave pública COSE -> JWK (o Node entende JWK direto)
function coseParaJwk(cose) {
  const kty = cose.get(1), alg = cose.get(3);
  if (kty === 2 && cose.get(-1) === 1) return { alg, jwk: { kty: 'EC', crv: 'P-256', x: b64url(cose.get(-2)), y: b64url(cose.get(-3)) } };
  if (kty === 3) return { alg, jwk: { kty: 'RSA', n: b64url(cose.get(-1)), e: b64url(cose.get(-2)) } };
  if (kty === 1 && cose.get(-1) === 6) return { alg, jwk: { kty: 'OKP', crv: 'Ed25519', x: b64url(cose.get(-2)) } };
  throw new Error('Tipo de chave do aparelho não suportado');
}

function conferirAssinatura(alg, jwk, dados, assinatura) {
  const chave = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  if (alg === -7) return crypto.verify('sha256', dados, { key: chave, dsaEncoding: 'der' }, assinatura);
  if (alg === -257) return crypto.verify('sha256', dados, chave, assinatura);
  if (alg === -8) return crypto.verify(null, dados, chave, assinatura);
  throw new Error('Algoritmo não suportado');
}

// rpId = domínio do site (ex.: flowsolution.netlify.app). Só aceita https (ou localhost pra testes).
function rpIdValido(rpId) {
  return typeof rpId === 'string' && /^[a-z0-9.-]{1,253}$/i.test(rpId);
}
function origemConfere(origem, rpId) {
  let u; try { u = new URL(origem); } catch (e) { return false; }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !local) return false;
  if (u.hostname !== rpId && !u.hostname.endsWith('.' + rpId)) return false;
  const lista = String(process.env.PASSKEY_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return !lista.length || local || lista.includes(u.origin);
}

function lerClientData(b64, tipoEsperado, desafio) {
  const raw = deB64url(b64);
  let cd; try { cd = JSON.parse(raw.toString('utf8')); } catch (e) { throw new Error('Resposta do aparelho inválida'); }
  if (cd.type !== tipoEsperado) throw new Error('Resposta do aparelho inválida');
  if (cd.challenge !== desafio) throw new Error('O desafio não confere. Tente de novo.');
  return { cd, raw };
}

// Cadastro: devolve { credId, alg, jwk, contador }
function verificarCadastro({ credencial, desafio, rpId }) {
  const resp = (credencial && credencial.response) || {};
  const { cd } = lerClientData(resp.clientDataJSON, 'webauthn.create', desafio);
  if (!origemConfere(cd.origin, rpId)) throw new Error('Site de origem não autorizado');
  const { valor: att } = lerCbor(deB64url(resp.attestationObject));
  const ad = lerAuthData(att.get('authData'));
  if (!ad.rpIdHash.equals(sha256(Buffer.from(rpId)))) throw new Error('Domínio não confere');
  if (!ad.up || !ad.uv) throw new Error('O aparelho não confirmou o rosto/digital.');
  if (!ad.credId || !ad.coseKey) throw new Error('O aparelho não mandou a chave.');
  const { alg, jwk } = coseParaJwk(ad.coseKey);
  if (![-7, -257, -8].includes(alg)) throw new Error('Algoritmo não suportado');
  return { credId: b64url(ad.credId), alg, jwk, contador: ad.contador };
}

// Login: confere a assinatura com a chave guardada. Devolve o contador novo.
function verificarLogin({ credencial, desafio, chave }) {
  const resp = (credencial && credencial.response) || {};
  const { cd, raw } = lerClientData(resp.clientDataJSON, 'webauthn.get', desafio);
  if (!origemConfere(cd.origin, chave.rp_id)) throw new Error('Site de origem não autorizado');
  const adBuf = deB64url(resp.authenticatorData);
  const ad = lerAuthData(adBuf);
  if (!ad.rpIdHash.equals(sha256(Buffer.from(chave.rp_id)))) throw new Error('Domínio não confere');
  if (!ad.up || !ad.uv) throw new Error('O aparelho não confirmou o rosto/digital.');
  const ok = conferirAssinatura(chave.alg, JSON.parse(chave.chave_publica), Buffer.concat([adBuf, sha256(raw)]), deB64url(resp.signature));
  if (!ok) throw new Error('Assinatura inválida');
  if (ad.contador && chave.contador && ad.contador <= chave.contador) throw new Error('Chave possivelmente clonada. Cadastre o rosto de novo.');
  return { contador: ad.contador };
}

function novoDesafio() { return b64url(crypto.randomBytes(32)); }

module.exports = { verificarCadastro, verificarLogin, novoDesafio, rpIdValido, b64url, lerCbor, lerAuthData };
