// Envio automático de WhatsApp pela API oficial da Meta (WhatsApp Cloud API).
//
// Funciona com UM número da Flow Solution que manda as mensagens em nome das lojas.
// Precisa de:
//   WHATSAPP_TOKEN     → token permanente do usuário do sistema (Meta Business)
//   WHATSAPP_PHONE_ID  → ID do número de telefone no WhatsApp Manager
//   WHATSAPP_TEMPLATE  → nome do modelo de confirmação aprovado (padrão: confirmacao_agendamento)
//   WHATSAPP_TEMPLATE_CANCELAMENTO → (opcional) modelo de aviso de cancelamento
//   WHATSAPP_IDIOMA    → idioma do modelo (padrão: pt_BR)
//
// Sem essas variáveis o robô não quebra: marca a mensagem como "manual" e o painel
// mostra um botão que abre o WhatsApp com o texto pronto pro lojista só apertar enviar.

const VERSAO = 'v21.0';

function configurado() {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);
}

// "(19) 98920-0541" → "5519989200541"
function normalizarTelefone(tel) {
  let d = String(tel || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = d.replace(/^0+/, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d.length >= 12 && d.length <= 13 ? d : null;
}

// parametros: textos que preenchem {{1}}, {{2}}... do modelo, na ordem
async function enviarModelo(telefone, modelo, parametros) {
  const para = normalizarTelefone(telefone);
  if (!para) return { status: 'erro', erro: 'Telefone inválido.' };
  if (!configurado() || !modelo) return { status: 'manual' };

  try {
    const r = await fetch(`https://graph.facebook.com/${VERSAO}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: para,
        type: 'template',
        template: {
          name: modelo,
          language: { code: process.env.WHATSAPP_IDIOMA || 'pt_BR' },
          components: [{ type: 'body', parameters: parametros.map((t) => ({ type: 'text', text: String(t || '-').slice(0, 300) })) }],
        },
      }),
    });
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) {
      const erro = dados.error ? `${dados.error.code || r.status}: ${dados.error.message}` : `HTTP ${r.status}`;
      console.warn('WhatsApp não enviou', erro);
      return { status: 'erro', erro: erro.slice(0, 300) };
    }
    return { status: 'enviado', id: dados.messages && dados.messages[0] && dados.messages[0].id };
  } catch (e) {
    console.error('Erro ao chamar a API do WhatsApp', e.message);
    return { status: 'erro', erro: e.message.slice(0, 300) };
  }
}

module.exports = { configurado, normalizarTelefone, enviarModelo };
