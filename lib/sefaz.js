// Conversa com a SEFAZ (Ambiente Nacional) usando o certificado A1 da loja:
// - NFeDistribuicaoDFe: lista as notas emitidas contra o CNPJ (por NSU ou por chave)
// - NFeRecepcaoEvento4: "Ciência da Operação" (210210), que libera o XML completo da nota
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');

const URL_DIST = process.env.SEFAZ_URL_DIST || 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx';
const URL_EVENTO = process.env.SEFAZ_URL_EVENTO || 'https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx';
const TP_AMB = process.env.SEFAZ_AMBIENTE === 'homologacao' ? '2' : '1';
// Hosts oficiais: só neles aceitamos a cadeia ICP-Brasil quando ela não está no Node
const HOSTS_SEFAZ = ['www1.nfe.fazenda.gov.br', 'www.nfe.fazenda.gov.br', 'hom1.nfe.fazenda.gov.br', 'hom.nfe.fazenda.gov.br'];

const UF_CODIGO = { RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17, MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27, SE: 28, BA: 29, MG: 31, ES: 32, RJ: 33, SP: 35, PR: 41, SC: 42, RS: 43, MS: 50, MT: 51, GO: 52, DF: 53 };

function tag(xml, nome) {
  const m = String(xml).match(new RegExp(`<(?:\\w+:)?${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${nome}>`));
  return m ? m[1] : null;
}
function todas(xml, nome) {
  const re = new RegExp(`<(?:\\w+:)?${nome}(\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${nome}>`, 'g');
  const lista = []; let m;
  while ((m = re.exec(xml))) lista.push({ attrs: m[1] || '', corpo: m[2] });
  return lista;
}
function atributo(attrs, nome) { const m = String(attrs).match(new RegExp(`${nome}="([^"]*)"`)); return m ? m[1] : null; }
function semEspacos(xml) { return xml.replace(/>\s+</g, '><').trim(); }

function postar(url, acao, envelope, cert) {
  const u = new URL(url);
  const tentar = (verificar) => new Promise((ok, falhou) => {
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST',
      key: cert.chavePem, cert: cert.certPem, ca: process.env.SEFAZ_CA ? process.env.SEFAZ_CA : undefined,
      rejectUnauthorized: verificar, timeout: 40000,
      headers: { 'Content-Type': `application/soap+xml; charset=utf-8; action="${acao}"`, 'Content-Length': Buffer.byteLength(envelope) },
    }, (res) => {
      const partes = []; res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const corpo = Buffer.concat(partes).toString('utf8');
        if (res.statusCode >= 500 && !/<(\w+:)?Envelope/.test(corpo)) return falhou(new Error(`A SEFAZ respondeu com erro ${res.statusCode}.`));
        if (res.statusCode === 403) return falhou(new Error('A SEFAZ recusou o certificado (403). Confira se ele é o A1 da empresa e se está dentro da validade.'));
        ok(corpo);
      });
    });
    req.on('timeout', () => req.destroy(new Error('A SEFAZ demorou demais pra responder.')));
    req.on('error', falhou);
    req.end(envelope);
  });
  return tentar(true).catch((e) => {
    // A cadeia ICP-Brasil não vem no Node: nos hosts oficiais seguimos sem conferir a cadeia
    const deCadeia = /certificate|self[- ]signed|issuer|CERT_|UNABLE_TO/i.test(e.code || e.message || '');
    if (deCadeia && HOSTS_SEFAZ.includes(u.hostname)) return tentar(false);
    throw e;
  });
}

function envelope(corpo) {
  return '<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>' + corpo + '</soap12:Body></soap12:Envelope>';
}

/* ---------------- distribuição de documentos ---------------- */
// opcoes: { ultNSU } ou { chave }
async function distribuicao(cfg, cert, opcoes) {
  const cUF = UF_CODIGO[cfg.uf] || 35;
  const doc = cfg.cnpj ? `<CNPJ>${cfg.cnpj}</CNPJ>` : `<CPF>${cfg.cpf}</CPF>`;
  const pedido = opcoes.chave
    ? `<consChNFe><chNFe>${opcoes.chave}</chNFe></consChNFe>`
    : `<distNSU><ultNSU>${String(opcoes.ultNSU || '0').padStart(15, '0')}</ultNSU></distNSU>`;
  const xml = envelope(`<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDadosMsg><distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>${TP_AMB}</tpAmb><cUFAutor>${cUF}</cUFAutor>${doc}${pedido}</distDFeInt></nfeDadosMsg></nfeDistDFeInteresse>`);
  const resp = await postar(URL_DIST, 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse', xml, cert);
  const ret = tag(resp, 'retDistDFeInt');
  if (!ret) throw new Error('Resposta da SEFAZ fora do padrão.');
  const docs = todas(ret, 'docZip').map((d) => {
    let conteudo = '';
    try { conteudo = zlib.gunzipSync(Buffer.from(d.corpo.trim(), 'base64')).toString('utf8'); } catch (e) { conteudo = ''; }
    return { nsu: atributo(d.attrs, 'NSU'), schema: atributo(d.attrs, 'schema') || '', xml: conteudo };
  });
  return { cStat: tag(ret, 'cStat'), xMotivo: tag(ret, 'xMotivo'), ultNSU: tag(ret, 'ultNSU'), maxNSU: tag(ret, 'maxNSU'), docs };
}

/* ---------------- assinatura XML (XMLDSig, RSA-SHA1, C14N) ---------------- */
function assinar(xmlInfo, id, cert) {
  // xmlInfo já está na forma canônica (sem espaços, atributos em ordem, namespace herdado escrito)
  const digest = crypto.createHash('sha1').update(xmlInfo, 'utf8').digest('base64');
  const signedInfo = '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></CanonicalizationMethod><SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod>'
    + `<Reference URI="#${id}"><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform><Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></Transform></Transforms><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod><DigestValue>${digest}</DigestValue></Reference></SignedInfo>`;
  const assinatura = crypto.createSign('RSA-SHA1').update(signedInfo, 'utf8').sign(cert.chave || cert.chavePem, 'base64');
  return `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">${signedInfo.replace(' xmlns="http://www.w3.org/2000/09/xmldsig#"', '')}<SignatureValue>${assinatura}</SignatureValue><KeyInfo><X509Data><X509Certificate>${cert.certBase64}</X509Certificate></X509Data></KeyInfo></Signature>`;
}

function agoraBrasilia() {
  const d = new Date(Date.now() - 3 * 3600000 - 60000); // 1 minuto antes evita "data no futuro"
  return d.toISOString().slice(0, 19) + '-03:00';
}

function montarEventoCiencia(cfg, cert, chave) {
  const id = `ID210210${chave}01`;
  const doc = cfg.cnpj ? `<CNPJ>${cfg.cnpj}</CNPJ>` : `<CPF>${cfg.cpf}</CPF>`;
  const corpo = `<cOrgao>91</cOrgao><tpAmb>${TP_AMB}</tpAmb>${doc}<chNFe>${chave}</chNFe><dhEvento>${agoraBrasilia()}</dhEvento><tpEvento>210210</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>Ciencia da Operacao</descEvento></detEvento>`;
  // forma canônica de infEvento: herda o namespace da NF-e
  const canonico = `<infEvento xmlns="http://www.portalfiscal.inf.br/nfe" Id="${id}">${corpo}</infEvento>`;
  const assinatura = assinar(canonico, id, cert);
  return `<envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><idLote>${Date.now().toString().slice(-15)}</idLote><evento versao="1.00"><infEvento Id="${id}">${corpo}</infEvento>${assinatura}</evento></envEvento>`;
}

async function cienciaDaOperacao(cfg, cert, chave) {
  const xml = envelope(`<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">${montarEventoCiencia(cfg, cert, chave)}</nfeDadosMsg>`);
  const resp = await postar(URL_EVENTO, 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4/nfeRecepcaoEvento', xml, cert);
  const ret = tag(resp, 'retEvento') || resp;
  const cStat = tag(ret, 'cStat'), xMotivo = tag(ret, 'xMotivo');
  // 135 registrado · 136 registrado sem vínculo · 573 já tinha sido feito
  return { ok: ['135', '136', '573'].includes(cStat), cStat, xMotivo, loteStat: tag(resp, 'cStat') };
}

/* ---------------- ler NF-e (completa ou resumo) ---------------- */
function resumoDaNota(xml) {
  const inf = String(xml);
  const idInf = (inf.match(/<infNFe[^>]*Id="NFe(\d{44})"/) || [])[1];
  const emit = tag(inf, 'emit') || '';
  const ide = tag(inf, 'ide') || '';
  const dest = tag(inf, 'dest') || '';
  const chave = idInf || tag(inf, 'chNFe');
  return {
    chave,
    emitente: tag(emit, 'xNome') || tag(inf, 'xNome'),
    cnpjEmitente: tag(emit, 'CNPJ') || tag(emit, 'CPF') || tag(inf, 'CNPJ'),
    cnpjDestinatario: tag(dest, 'CNPJ') || tag(dest, 'CPF'),
    numero: tag(ide, 'nNF') || (chave && chave.length === 44 ? String(Number(chave.slice(25, 34))) : null),
    valor: Number(tag(tag(inf, 'ICMSTot') || inf, 'vNF')) || null,
    emitidaEm: tag(ide, 'dhEmi') || tag(ide, 'dEmi') || tag(inf, 'dhEmi'),
    completa: /<infNFe/.test(inf) && /<det\s/.test(inf),
    cancelada: tag(inf, 'cSitNFe') === '3',
  };
}

module.exports = { distribuicao, cienciaDaOperacao, montarEventoCiencia, resumoDaNota, tag, todas, UF_CODIGO, semEspacos };
