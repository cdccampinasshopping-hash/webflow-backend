// Leitura do certificado digital A1 (.pfx / .p12) sem bibliotecas de fora.
// Os certificados A1 do Brasil costumam vir num formato antigo (RC2 40 bits + 3DES) que o
// OpenSSL 3 não abre mais sem o "legacy provider". Aqui a gente lê o arquivo na mão:
// ASN.1 (DER/BER) → bolsas do PKCS#12 → decifra com a senha → chave privada + certificado.
const crypto = require('crypto');

/* ---------------- ASN.1 ---------------- */
function lerNo(buf, pos) {
  const tag = buf[pos];
  let p = pos + 1;
  let len = buf[p++];
  let indefinido = false;
  if (len === 0x80) { indefinido = true; len = -1; } else if (len & 0x80) {
    const n = len & 0x7f; len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++];
  }
  const ini = p;
  let fim;
  if (indefinido) {
    // BER: os filhos vão até o marcador 00 00
    let q = ini;
    while (!(buf[q] === 0 && buf[q + 1] === 0)) q = lerNo(buf, q).proximo;
    fim = q; return { tag, ini, fim, proximo: q + 2, buf, construido: !!(tag & 0x20) };
  }
  fim = ini + len;
  if (fim > buf.length) throw new Error('Arquivo de certificado corrompido.');
  return { tag, ini, fim, proximo: fim, buf, construido: !!(tag & 0x20) };
}
function filhos(no) {
  const lista = []; let p = no.ini;
  while (p < no.fim) { const f = lerNo(no.buf, p); lista.push(f); p = f.proximo; }
  return lista;
}
function bytes(no) {
  // OCTET STRING pode vir "construída" (pedaços) em BER
  if (no.construido) return Buffer.concat(filhos(no).map(bytes));
  return no.buf.subarray(no.ini, no.fim);
}
function inteiro(no) { let v = 0; for (const b of bytes(no)) v = v * 256 + b; return v; }
function oid(no) {
  const b = bytes(no); const partes = [Math.floor(b[0] / 40), b[0] % 40]; let v = 0;
  for (let i = 1; i < b.length; i++) { v = v * 128 + (b[i] & 0x7f); if (!(b[i] & 0x80)) { partes.push(v); v = 0; } }
  return partes.join('.');
}
function derCompleto(no) {
  // devolve o DER do nó inteiro (cabeçalho + conteúdo)
  const ini = lerCabecalhoInicio(no);
  return no.buf.subarray(ini, no.proximo);
}
function lerCabecalhoInicio(no) {
  // volta do início do conteúdo até a tag
  let p = no.ini - 1;
  while (p >= 0) {
    try { const t = lerNo(no.buf, p); if (t.ini === no.ini && t.tag === no.tag) return p; } catch (e) { /* segue */ }
    p--;
  }
  throw new Error('ASN.1 inválido');
}

/* ---------------- PKCS#12: derivação de chave (RFC 7292, apêndice B) ---------------- */
function senhaBmp(senha) {
  const b = Buffer.alloc((senha.length + 1) * 2);
  for (let i = 0; i < senha.length; i++) b.writeUInt16BE(senha.charCodeAt(i), i * 2);
  return b; // termina com 00 00
}
function kdf12(senha, salt, id, iter, n) {
  const u = 20, v = 64;
  const D = Buffer.alloc(v, id);
  const repetir = (x) => { if (!x.length) return Buffer.alloc(0); const t = Math.ceil(x.length / v) * v; const r = Buffer.alloc(t); for (let i = 0; i < t; i++) r[i] = x[i % x.length]; return r; };
  const S = repetir(salt), P = repetir(senhaBmp(senha));
  let I = Buffer.concat([S, P]);
  const saida = [];
  for (let c = 0; c < Math.ceil(n / u); c++) {
    let A = crypto.createHash('sha1').update(Buffer.concat([D, I])).digest();
    for (let k = 1; k < iter; k++) A = crypto.createHash('sha1').update(A).digest();
    saida.push(A);
    const B = Buffer.alloc(v); for (let i = 0; i < v; i++) B[i] = A[i % u];
    for (let j = 0; j < I.length; j += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) { const s = I[j + k] + B[k] + carry; I[j + k] = s & 0xff; carry = s >> 8; }
    }
  }
  return Buffer.concat(saida).subarray(0, n);
}

/* ---------------- RC2 (RFC 2268) — só pra decifrar o formato antigo ---------------- */
const PI = [
  0xd9, 0x78, 0xf9, 0xc4, 0x19, 0xdd, 0xb5, 0xed, 0x28, 0xe9, 0xfd, 0x79, 0x4a, 0xa0, 0xd8, 0x9d,
  0xc6, 0x7e, 0x37, 0x83, 0x2b, 0x76, 0x53, 0x8e, 0x62, 0x4c, 0x64, 0x88, 0x44, 0x8b, 0xfb, 0xa2,
  0x17, 0x9a, 0x59, 0xf5, 0x87, 0xb3, 0x4f, 0x13, 0x61, 0x45, 0x6d, 0x8d, 0x09, 0x81, 0x7d, 0x32,
  0xbd, 0x8f, 0x40, 0xeb, 0x86, 0xb7, 0x7b, 0x0b, 0xf0, 0x95, 0x21, 0x22, 0x5c, 0x6b, 0x4e, 0x82,
  0x54, 0xd6, 0x65, 0x93, 0xce, 0x60, 0xb2, 0x1c, 0x73, 0x56, 0xc0, 0x14, 0xa7, 0x8c, 0xf1, 0xdc,
  0x12, 0x75, 0xca, 0x1f, 0x3b, 0xbe, 0xe4, 0xd1, 0x42, 0x3d, 0xd4, 0x30, 0xa3, 0x3c, 0xb6, 0x26,
  0x6f, 0xbf, 0x0e, 0xda, 0x46, 0x69, 0x07, 0x57, 0x27, 0xf2, 0x1d, 0x9b, 0xbc, 0x94, 0x43, 0x03,
  0xf8, 0x11, 0xc7, 0xf6, 0x90, 0xef, 0x3e, 0xe7, 0x06, 0xc3, 0xd5, 0x2f, 0xc8, 0x66, 0x1e, 0xd7,
  0x08, 0xe8, 0xea, 0xde, 0x80, 0x52, 0xee, 0xf7, 0x84, 0xaa, 0x72, 0xac, 0x35, 0x4d, 0x6a, 0x2a,
  0x96, 0x1a, 0xd2, 0x71, 0x5a, 0x15, 0x49, 0x74, 0x4b, 0x9f, 0xd0, 0x5e, 0x04, 0x18, 0xa4, 0xec,
  0xc2, 0xe0, 0x41, 0x6e, 0x0f, 0x51, 0xcb, 0xcc, 0x24, 0x91, 0xaf, 0x50, 0xa1, 0xf4, 0x70, 0x39,
  0x99, 0x7c, 0x3a, 0x85, 0x23, 0xb8, 0xb4, 0x7a, 0xfc, 0x02, 0x36, 0x5b, 0x25, 0x55, 0x97, 0x31,
  0x2d, 0x5d, 0xfa, 0x98, 0xe3, 0x8a, 0x92, 0xae, 0x05, 0xdf, 0x29, 0x10, 0x67, 0x6c, 0xba, 0xc9,
  0xd3, 0x00, 0xe6, 0xcf, 0xe1, 0x9e, 0xa8, 0x2c, 0x63, 0x16, 0x01, 0x3f, 0x58, 0xe2, 0x89, 0xa9,
  0x0d, 0x38, 0x34, 0x1b, 0xab, 0x33, 0xff, 0xb0, 0xbb, 0x48, 0x0c, 0x5f, 0xb9, 0xb1, 0xcd, 0x2e,
  0xc5, 0xf3, 0xdb, 0x47, 0xe5, 0xa5, 0x9c, 0x77, 0x0a, 0xa6, 0x20, 0x68, 0xfe, 0x7f, 0xc1, 0xad,
];
function rc2Chaves(chave, bitsEfetivos) {
  const L = Buffer.alloc(128); chave.copy(L);
  const T = chave.length, T8 = Math.ceil(bitsEfetivos / 8), TM = 0xff % Math.pow(2, 8 + bitsEfetivos - 8 * T8);
  for (let i = T; i < 128; i++) L[i] = PI[(L[i - 1] + L[i - T]) & 0xff];
  L[128 - T8] = PI[L[128 - T8] & TM];
  for (let i = 127 - T8; i >= 0; i--) L[i] = PI[L[i + 1] ^ L[i + T8]];
  const K = []; for (let i = 0; i < 64; i++) K.push(L[2 * i] + 256 * L[2 * i + 1]);
  return K;
}
function rc2DecifrarBloco(K, bloco) {
  const R = [bloco.readUInt16LE(0), bloco.readUInt16LE(2), bloco.readUInt16LE(4), bloco.readUInt16LE(6)];
  const s = [1, 2, 3, 5];
  const rmix = (j, i) => {
    R[i] = ((R[i] << (16 - s[i])) | (R[i] >> s[i])) & 0xffff;
    R[i] = (R[i] - K[j] - (R[(i + 3) & 3] & R[(i + 2) & 3]) - ((~R[(i + 3) & 3]) & R[(i + 1) & 3])) & 0xffff;
  };
  const rmash = (i) => { R[i] = (R[i] - K[R[(i + 3) & 3] & 63]) & 0xffff; };
  let j = 63;
  const rodada = () => { for (let i = 3; i >= 0; i--) rmix(j--, i); };
  for (let r = 0; r < 5; r++) rodada();
  for (let i = 3; i >= 0; i--) rmash(i);
  for (let r = 0; r < 6; r++) rodada();
  for (let i = 3; i >= 0; i--) rmash(i);
  for (let r = 0; r < 5; r++) rodada();
  const out = Buffer.alloc(8);
  R.forEach((v, i) => out.writeUInt16LE(v, i * 2));
  return out;
}
function rc2Cbc(chave, iv, dados, bits) {
  const K = rc2Chaves(chave, bits);
  const out = Buffer.alloc(dados.length); let ant = iv;
  for (let i = 0; i < dados.length; i += 8) {
    const bloco = dados.subarray(i, i + 8);
    const d = rc2DecifrarBloco(K, bloco);
    for (let k = 0; k < 8; k++) out[i + k] = d[k] ^ ant[k];
    ant = bloco;
  }
  const pad = out[out.length - 1];
  if (pad < 1 || pad > 8) throw new Error('senha');
  return out.subarray(0, out.length - pad);
}

/* ---------------- decifrar conforme o algoritmo ---------------- */
const CIFRAS_AES = { '2.16.840.1.101.3.4.1.2': 'aes-128-cbc', '2.16.840.1.101.3.4.1.22': 'aes-192-cbc', '2.16.840.1.101.3.4.1.42': 'aes-256-cbc', '1.2.840.113549.3.7': 'des-ede3-cbc' };
const PRFS = { '1.2.840.113549.2.7': 'sha1', '1.2.840.113549.2.9': 'sha256', '1.2.840.113549.2.10': 'sha384', '1.2.840.113549.2.11': 'sha512' };
function decifrar(algNo, dados, senha) {
  const [algOid, params] = filhos(algNo);
  const tipo = oid(algOid);
  const decipher = (nome, chave, iv) => { const d = crypto.createDecipheriv(nome, chave, iv); return Buffer.concat([d.update(dados), d.final()]); };
  if (tipo.startsWith('1.2.840.113549.1.12.1.')) {
    const [salt, it] = filhos(params); const s = bytes(salt), iter = inteiro(it);
    switch (tipo) {
      case '1.2.840.113549.1.12.1.3': return decipher('des-ede3-cbc', kdf12(senha, s, 1, iter, 24), kdf12(senha, s, 2, iter, 8));
      case '1.2.840.113549.1.12.1.4': { const k = kdf12(senha, s, 1, iter, 16); return decipher('des-ede3-cbc', Buffer.concat([k, k.subarray(0, 8)]), kdf12(senha, s, 2, iter, 8)); }
      case '1.2.840.113549.1.12.1.5': return rc2Cbc(kdf12(senha, s, 1, iter, 16), kdf12(senha, s, 2, iter, 8), dados, 128);
      case '1.2.840.113549.1.12.1.6': return rc2Cbc(kdf12(senha, s, 1, iter, 5), kdf12(senha, s, 2, iter, 8), dados, 40);
      default: throw new Error('Esse certificado usa uma criptografia que ainda não conseguimos ler.');
    }
  }
  if (tipo === '1.2.840.113549.1.5.13') { // PBES2
    const [kdfAlg, encAlg] = filhos(params);
    const [kdfOid, kdfParams] = filhos(kdfAlg);
    if (oid(kdfOid) !== '1.2.840.113549.1.5.12') throw new Error('Esse certificado usa uma criptografia que ainda não conseguimos ler.');
    const kp = filhos(kdfParams);
    const salt = bytes(kp[0]), iter = inteiro(kp[1]);
    let prf = 'sha1';
    kp.slice(2).forEach((n) => { if (n.tag === 0x30) prf = PRFS[oid(filhos(n)[0])] || prf; });
    const [encOid, ivNo] = filhos(encAlg);
    const nome = CIFRAS_AES[oid(encOid)];
    if (!nome) throw new Error('Esse certificado usa uma criptografia que ainda não conseguimos ler.');
    const tam = { 'aes-128-cbc': 16, 'aes-192-cbc': 24, 'aes-256-cbc': 32, 'des-ede3-cbc': 24 }[nome];
    const chave = crypto.pbkdf2Sync(Buffer.from(senha, 'utf8'), salt, iter, tam, prf);
    return decipher(nome, chave, bytes(ivNo));
  }
  throw new Error('Esse certificado usa uma criptografia que ainda não conseguimos ler.');
}

/* ---------------- abrir o .pfx ---------------- */
const OID = { data: '1.2.840.113549.1.7.1', encrypted: '1.2.840.113549.1.7.6', keyBag: '1.2.840.113549.1.12.10.1.1', shrouded: '1.2.840.113549.1.12.10.1.2', certBag: '1.2.840.113549.1.12.10.1.3', x509: '1.2.840.113549.1.9.22.1' };

function lerBolsas(safeContentsDer, senha, achados) {
  const raiz = lerNo(safeContentsDer, 0);
  for (const bag of filhos(raiz)) {
    const [idNo, valorExp] = filhos(bag);
    const id = oid(idNo);
    const valor = filhos(valorExp)[0];
    if (id === OID.certBag) {
      const [certTipo, certExp] = filhos(valor);
      if (oid(certTipo) === OID.x509) achados.certs.push(Buffer.from(bytes(filhos(certExp)[0])));
    } else if (id === OID.shrouded) {
      const [alg, enc] = filhos(valor);
      let pkcs8;
      try { pkcs8 = decifrar(alg, bytes(enc), senha); } catch (e) { if (/criptografia/.test(e.message)) throw e; throw new Error('SENHA'); }
      achados.chaves.push(pkcs8);
    } else if (id === OID.keyBag) {
      achados.chaves.push(Buffer.from(derCompleto(valor)));
    }
  }
}

function lerPfx(buffer, senha) {
  const achados = { certs: [], chaves: [] };
  let raiz;
  try { raiz = lerNo(buffer, 0); } catch (e) { throw new Error('Esse arquivo não parece ser um certificado A1 (.pfx ou .p12).'); }
  if (raiz.tag !== 0x30) throw new Error('Esse arquivo não parece ser um certificado A1 (.pfx ou .p12).');
  const [, authSafe] = filhos(raiz);
  const [tipoNo, conteudoExp] = filhos(authSafe);
  if (oid(tipoNo) !== OID.data) throw new Error('Esse certificado é protegido de um jeito que ainda não conseguimos ler.');
  const authDer = Buffer.from(bytes(filhos(conteudoExp)[0]));
  const lista = filhos(lerNo(authDer, 0));
  for (const ci of lista) {
    const [t, exp] = filhos(ci);
    const tipo = oid(t);
    if (tipo === OID.data) {
      lerBolsas(Buffer.from(bytes(filhos(exp)[0])), senha, achados);
    } else if (tipo === OID.encrypted) {
      const encData = filhos(exp)[0];
      const eci = filhos(encData)[1];
      const [, alg, conteudo] = filhos(eci);
      let claro;
      try { claro = decifrar(alg, bytes(conteudo), senha); } catch (e) { if (/criptografia/.test(e.message)) throw e; throw new Error('SENHA'); }
      try { lerBolsas(claro, senha, achados); } catch (e) { if (e.message === 'SENHA' || /criptografia/.test(e.message)) throw e; throw new Error('SENHA'); }
    }
  }
  if (!achados.chaves.length) throw new Error('Não achamos a chave privada dentro do certificado. Exporte de novo marcando "incluir chave privada".');
  let chave;
  try { chave = crypto.createPrivateKey({ key: achados.chaves[0], format: 'der', type: 'pkcs8' }); } catch (e) { throw new Error('SENHA'); }
  const certs = achados.certs.map((d) => new crypto.X509Certificate(d));
  const meu = certs.find((c) => { try { return c.checkPrivateKey(chave); } catch (e) { return false; } });
  if (!meu) throw new Error('O certificado e a chave dentro do arquivo não combinam.');
  const cn = (meu.subject.split('\n').find((l) => l.startsWith('CN=')) || '').slice(3);
  const doc = (cn.match(/:(\d{14}|\d{11})\s*$/) || [])[1] || null;
  return {
    chave,
    chavePem: chave.export({ type: 'pkcs8', format: 'pem' }),
    certPem: meu.toString(),
    certBase64: meu.raw.toString('base64'),
    cadeiaPem: certs.filter((c) => c !== meu).map((c) => c.toString()),
    titular: cn.replace(/:\d+\s*$/, '').trim() || cn,
    cnpj: doc && doc.length === 14 ? doc : null,
    cpf: doc && doc.length === 11 ? doc : null,
    validade: new Date(meu.validTo).toISOString(),
  };
}

module.exports = { lerPfx, _teste: { kdf12, rc2Cbc } };
