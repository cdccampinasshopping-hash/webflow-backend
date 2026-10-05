const db = require('../db');
const { enviarEmail } = require('../email');

// Relatório mensal do lojista: no dia 1º, cada lojista recebe por e-mail o resumo
// do mês anterior (scans da placa, avaliações, nota média, melhores comentários).

const SITE_URL = process.env.SITE_URL || 'https://flowsolution.pages.dev';
const FUSO = -3; // horário de Brasília (sem horário de verão desde 2019)
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// Guarda qual mês já foi enviado pra cada lojista (evita e-mail repetido se o servidor reiniciar)
try { db.exec(`ALTER TABLE usuarios ADD COLUMN relatorio_enviado_mes TEXT`); }
catch (e) { /* coluna já existe, tudo bem */ }

// "2026-09" -> limites em UTC no formato do SQLite ("YYYY-MM-DD HH:MM:SS")
function limitesDoMes(mes) {
  const [ano, m] = mes.split('-').map(Number);
  const paraSql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  const inicio = new Date(Date.UTC(ano, m - 1, 1, -FUSO));
  const fim = new Date(Date.UTC(ano, m, 1, -FUSO));
  return { inicio: paraSql(inicio), fim: paraSql(fim) };
}

function mesAnterior(mes) {
  const [ano, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(ano, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Mês atual no horário de Brasília, ex: "2026-10"
function mesAtualBrasilia() {
  const agora = new Date(Date.now() + FUSO * 3600000);
  return `${agora.getUTCFullYear()}-${String(agora.getUTCMonth() + 1).padStart(2, '0')}`;
}

function nomeDoMes(mes) {
  const [ano, m] = mes.split('-').map(Number);
  return `${MESES[m - 1]} de ${ano}`;
}

function numerosDoMes(usuarioId, mes) {
  const { inicio, fim } = limitesDoMes(mes);
  const scans = db.prepare('SELECT COUNT(*) AS n FROM scans_log WHERE usuario_id = ? AND criado_em >= ? AND criado_em < ?')
    .get(usuarioId, inicio, fim).n;
  const av = db.prepare(`
    SELECT COUNT(*) AS total, ROUND(AVG(nota), 1) AS media,
           SUM(CASE WHEN nota >= 4 THEN 1 ELSE 0 END) AS positivas
    FROM avaliacoes WHERE usuario_id = ? AND criado_em >= ? AND criado_em < ?
  `).get(usuarioId, inicio, fim);
  return { scans, avaliacoes: av.total || 0, media: av.media || null, positivas: av.positivas || 0 };
}

// Monta os dados do relatório de um lojista para um mês ("YYYY-MM")
function montarRelatorio(usuarioId, mes) {
  const u = db.prepare('SELECT id, nome, email, negocio_nome, codigo_nfc FROM usuarios WHERE id = ?').get(usuarioId);
  if (!u) return null;

  const atual = numerosDoMes(u.id, mes);
  const anterior = numerosDoMes(u.id, mesAnterior(mes));
  const { inicio, fim } = limitesDoMes(mes);
  const destaques = db.prepare(`
    SELECT nota, comentario, nome FROM avaliacoes
    WHERE usuario_id = ? AND criado_em >= ? AND criado_em < ?
      AND comentario IS NOT NULL AND TRIM(comentario) <> '' AND nota >= 4
    ORDER BY nota DESC, LENGTH(comentario) DESC LIMIT 3
  `).all(u.id, inicio, fim);
  const pontosAtencao = db.prepare(`
    SELECT COUNT(*) AS n FROM avaliacoes
    WHERE usuario_id = ? AND criado_em >= ? AND criado_em < ? AND nota <= 2
  `).get(u.id, inicio, fim).n;
  const totalGeral = db.prepare('SELECT COUNT(*) AS n, ROUND(AVG(nota), 1) AS media FROM avaliacoes WHERE usuario_id = ?').get(u.id);
  const scansTotal = db.prepare('SELECT COALESCE(nfc_scans, 0) AS n FROM usuarios WHERE id = ?').get(u.id).n;
  const [ano, m] = mes.split('-').map(Number);
  const diasNoMes = new Date(Date.UTC(ano, m, 0)).getUTCDate();

  return { usuario: u, mes, atual, anterior, destaques, pontosAtencao, totalGeral, scansTotal, diasNoMes };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function variacao(agora, antes) {
  if (!antes && !agora) return '';
  if (!antes) return '<span style="color:#0FA893">novo</span>';
  const pct = Math.round(((agora - antes) / antes) * 100);
  if (pct === 0) return '<span style="color:#4A5873">igual ao mês anterior</span>';
  return pct > 0
    ? `<span style="color:#0FA893">▲ ${pct}% vs. mês anterior</span>`
    : `<span style="color:#C0392B">▼ ${Math.abs(pct)}% vs. mês anterior</span>`;
}

function estrelas(n) {
  const cheia = Math.round(n || 0);
  return '★'.repeat(cheia) + '☆'.repeat(5 - cheia);
}

// Placa indo direto pro Google: o mural não recebe notas novas, então o relatório foca nas leituras
// Padrão: placa vai direto pro Google. PLACA_DIRETO_GOOGLE=0 volta a mostrar a tela da loja antes.
const modoDireto = () => process.env.PLACA_DIRETO_GOOGLE !== '0';

// Uma dica prática conforme o resultado do mês
function dicaDoMes(r) {
  const { atual } = r;
  if (atual.scans === 0) return 'Sua placa não foi usada este mês. Deixe-a bem à vista no caixa ou na mesa e peça pro cliente aproximar o celular na hora de pagar: é o momento em que ele está mais disposto a avaliar.';
  const conversao = atual.scans ? atual.avaliacoes / atual.scans : 0;
  if (modoDireto() && atual.avaliacoes === 0) return 'Cada leitura levou um cliente direto à página de avaliação da sua loja no Google. Peça pra equipe lembrar: "é só escolher as estrelas e tocar em Publicar". E responda as avaliações no Google: quem vê a loja respondendo confia mais.';
  if (atual.avaliacoes === 0) return 'A placa foi lida, mas ninguém deixou nota. Um convite simples da equipe ("se puder, deixa sua avaliação aqui") costuma dobrar o número de avaliações.';
  if (r.pontosAtencao > 0) return `Você recebeu ${r.pontosAtencao === 1 ? '1 avaliação' : `${r.pontosAtencao} avaliações`} de 1 ou 2 estrelas. Vale ler no painel e, se possível, responder no Google: clientes que veem a loja respondendo confiam mais.`;
  if (conversao < 0.4) return 'Menos da metade de quem leu a placa deixou nota. Treine a equipe pra lembrar o cliente de concluir: é só tocar nas estrelas.';
  return 'Ótimo mês! Compartilhe o link do seu portfólio de avaliações no Instagram e no WhatsApp: prova social é o que mais convence cliente novo.';
}

function htmlDoRelatorio(r) {
  const { usuario: u, atual, anterior } = r;
  const direto = modoDireto() && atual.avaliacoes === 0;
  const negocio = esc(u.negocio_nome || u.nome);
  const portfolio = u.codigo_nfc ? `${SITE_URL}/portfolio.html?c=${encodeURIComponent(u.codigo_nfc)}` : null;
  const card = (titulo, valor, detalhe) => `
    <td style="width:33%;padding:6px;vertical-align:top">
      <div style="background:#EEF3F8;border-radius:14px;padding:16px 14px">
        <div style="font-size:13px;color:#4A5873">${titulo}</div>
        <div style="font-size:28px;font-weight:700;color:#13213C;margin:4px 0">${valor}</div>
        <div style="font-size:12px">${detalhe}</div>
      </div>
    </td>`;

  const destaques = r.destaques.length ? `
    <h2 style="font-size:17px;margin:26px 0 10px;color:#13213C">O que seus clientes disseram</h2>
    ${r.destaques.map((d) => `
      <div style="border-left:3px solid #1D5BF0;padding:6px 0 6px 14px;margin-bottom:12px">
        <div style="color:#F2A900;font-size:15px">${estrelas(d.nota)}</div>
        <div style="color:#13213C;font-size:15px;margin:4px 0">"${esc(d.comentario)}"</div>
        <div style="color:#4A5873;font-size:13px">${esc(d.nome || 'Cliente')}</div>
      </div>`).join('')}` : '';

  return `<!DOCTYPE html><html lang="pt-BR"><body style="margin:0;background:#EEF3F8;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:24px 12px">
    <div style="background:#fff;border-radius:20px;padding:28px 22px">
      <div style="font-size:14px;color:#1D5BF0;font-weight:700">Flow Solution</div>
      <h1 style="font-size:24px;color:#13213C;margin:8px 0 4px">Seu mês em ${esc(nomeDoMes(r.mes))}</h1>
      <p style="color:#4A5873;margin:0 0 18px;font-size:15px">Oi, ${esc(u.nome)}! Veja como foi o mês de <b>${negocio}</b> na placa de avaliações.</p>
      <table role="presentation" style="width:100%;border-collapse:collapse"><tr>
        ${direto ? `
        ${card('Clientes levados ao Google', atual.scans, variacao(atual.scans, anterior.scans))}
        ${card('Média por dia', String(Math.round((atual.scans / r.diasNoMes) * 10) / 10).replace('.', ','), '<span style="color:#4A5873">leituras da placa</span>')}
        ${card('Desde o início', r.scansTotal, '<span style="color:#4A5873">leituras no total</span>')}` : `
        ${card('Leituras da placa', atual.scans, variacao(atual.scans, anterior.scans))}
        ${card('Avaliações', atual.avaliacoes, variacao(atual.avaliacoes, anterior.avaliacoes))}
        ${card('Nota média', atual.media ? String(atual.media).replace('.', ',') : '—', atual.media ? `<span style="color:#F2A900">${estrelas(atual.media)}</span>` : '<span style="color:#4A5873">sem notas</span>')}`}
      </tr></table>
      ${destaques}
      <div style="background:#FFF7D6;border-radius:14px;padding:14px 16px;margin-top:22px;color:#13213C;font-size:15px">
        <b>Dica do mês:</b> ${esc(dicaDoMes(r))}
      </div>
      ${direto ? '' : `<p style="color:#4A5873;font-size:14px;margin:22px 0 0">Desde o início, ${negocio} já recebeu <b>${r.totalGeral.n || 0}</b> avaliações pela placa${r.totalGeral.media ? `, com média <b>${String(r.totalGeral.media).replace('.', ',')}</b>` : ''}.</p>`}
      <div style="margin-top:22px">
        <a href="${SITE_URL}/webflow.html" style="display:inline-block;background:#1D5BF0;color:#fff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:700;font-size:15px">Ver todas no painel</a>
        ${portfolio ? `<a href="${portfolio}" style="display:inline-block;color:#1D5BF0;text-decoration:none;padding:12px 8px;font-weight:700;font-size:15px">Ver meu portfólio público</a>` : ''}
      </div>
    </div>
    <p style="text-align:center;color:#4A5873;font-size:12px;margin-top:16px">Você recebe este resumo porque tem a placa de avaliações da Flow Solution. Pra não receber mais, responda "parar" pelo Suporte do painel.</p>
  </div></body></html>`;
}

async function enviarRelatorio(usuarioId, mes, paraOutro) {
  const r = montarRelatorio(usuarioId, mes);
  if (!r) throw new Error('Cliente não encontrado.');
  const para = paraOutro || r.usuario.email;
  await enviarEmail({
    para,
    assunto: `Seu resumo de ${nomeDoMes(mes)} — ${r.usuario.negocio_nome || r.usuario.nome}`,
    html: htmlDoRelatorio(r),
  });
  return r;
}

// Roda todo dia; só envia no começo do mês (dias 1 a 3, caso o servidor esteja fora do ar no dia 1º)
async function verificarRelatoriosMensais() {
  const mesAtual = mesAtualBrasilia();
  const dia = new Date(Date.now() + FUSO * 3600000).getUTCDate();
  if (dia > 3) return;
  const mes = mesAnterior(mesAtual);

  const lojistas = db.prepare(`
    SELECT id FROM usuarios
    WHERE is_admin = 0 AND is_comercial = 0 AND cargo = 'lojista' AND codigo_nfc IS NOT NULL AND plano <> 'pendente'
      AND COALESCE(relatorio_enviado_mes, '') <> ?
      AND criado_em < ?
  `).all(mes, limitesDoMes(mesAtual).inicio);

  let enviados = 0;
  for (const { id } of lojistas) {
    try {
      await enviarRelatorio(id, mes);
      db.prepare('UPDATE usuarios SET relatorio_enviado_mes = ? WHERE id = ?').run(mes, id);
      enviados++;
      await new Promise((ok) => setTimeout(ok, 600)); // respeita o limite de envio do Resend
    } catch (e) {
      console.error(`Erro ao enviar relatório mensal do usuário ${id}`, e.message);
    }
  }
  if (lojistas.length) console.log(`Relatório mensal de ${mes}: ${enviados}/${lojistas.length} enviados`);
}

function iniciarRelatoriosMensais() {
  const rodar = () => verificarRelatoriosMensais().catch((e) => console.error('Erro nos relatórios mensais', e));
  setTimeout(rodar, 2 * 60 * 1000);
  setInterval(rodar, 6 * 60 * 60 * 1000); // confere 4x por dia
}

module.exports = {
  iniciarRelatoriosMensais, verificarRelatoriosMensais, enviarRelatorio, montarRelatorio,
  htmlDoRelatorio, mesAnterior, mesAtualBrasilia,
};
