const db = require('../db');
const { enviarEmail, emailInterno } = require('../email');
const { resumo, lojasAtivas, hojeBrasilia, somaDias, ITEM_POR_ID } = require('../routes/checklist');

// Todo dia, a partir das 8h (Brasília), o admin recebe por e-mail o resumo do checklist de ontem:
// quais lojas não fizeram e quais perguntas ficaram sem comprovante.

const SITE_URL = process.env.SITE_URL || 'https://flowsolution.pages.dev';
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dataBr = (iso) => iso.split('-').reverse().join('/');

function htmlAviso(data, lojas) {
  const comFalta = lojas.filter((l) => l.faltas > 0).sort((a, b) => b.faltas - a.faltas);
  const linhas = comFalta.map((l) => {
    const d = l.dias[0];
    const itens = d.faltando.map((id) => `<li style="margin:2px 0">${esc(ITEM_POR_ID.get(id).texto)}</li>`).join('');
    return `<div style="border:1px solid #E3E6EC;border-radius:10px;padding:14px 16px;margin:0 0 12px">
      <b style="font-size:15px">${esc(l.negocio_nome || l.nome)}</b>
      <span style="float:right;color:#B42318;font-weight:700">${d.feitas}/${d.total} feitas</span>
      ${d.feitas === 0 ? '<p style="margin:6px 0 0;color:#B42318">Não fez nenhuma pergunta do checklist.</p>' : `<ul style="margin:8px 0 0;padding-left:18px;color:#3A4558;font-size:13px">${itens}</ul>`}
    </div>`;
  }).join('');
  const ok = lojas.length - comFalta.length;
  return `<!doctype html><html><body style="margin:0;background:#F4F5F8;font-family:Arial,sans-serif;color:#151B26">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px">
    <h2 style="margin:0 0 4px">Checklist de ${dataBr(data)}</h2>
    <p style="margin:0 0 18px;color:#4A5873">${ok} de ${lojas.length} lojas fizeram tudo. ${comFalta.length ? `${comFalta.length} ficaram com pendência:` : 'Nenhuma pendência.'}</p>
    ${linhas}
    <p style="margin:18px 0 0"><a href="${SITE_URL}/webflow.html" style="background:#151B26;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:700">Ver comprovantes no painel</a></p>
  </div></body></html>`;
}

async function verificarAvisoChecklist() {
  const para = emailInterno();
  if (!para) return;
  const horaBrasilia = new Date(Date.now() - 3 * 3600000).getUTCHours();
  if (horaBrasilia < 8) return;
  const ontem = somaDias(hojeBrasilia(), -1);
  if (db.prepare('SELECT 1 FROM checklist_avisos WHERE data = ?').get(ontem)) return;
  const lojas = resumo(lojasAtivas(), ontem, ontem).filter((l) => l.dias.length);
  if (lojas.length) {
    const comFalta = lojas.filter((l) => l.faltas > 0).length;
    await enviarEmail({
      para,
      assunto: comFalta ? `Checklist de ${dataBr(ontem)}: ${comFalta} loja(s) com pendência` : `Checklist de ${dataBr(ontem)}: todas as lojas em dia`,
      html: htmlAviso(ontem, lojas),
    });
  }
  db.prepare('INSERT OR IGNORE INTO checklist_avisos (data) VALUES (?)').run(ontem);
}

function iniciarAvisosChecklist() {
  const rodar = () => verificarAvisoChecklist().catch((e) => console.error('Erro no aviso do checklist', e.message));
  setTimeout(rodar, 3 * 60 * 1000);
  setInterval(rodar, 30 * 60 * 1000);
}

module.exports = { iniciarAvisosChecklist, verificarAvisoChecklist };
