// Busca nota, total e avaliações em destaque de um negócio no Google (Places API "New").
// Só funciona se GOOGLE_PLACES_API_KEY estiver configurada e o cliente tiver Place ID.
// O resultado fica só em memória por algumas horas (não gravamos conteúdo do Google no banco).

const CACHE_HORAS = 6;
const cache = new Map(); // placeId -> { quando, dados }

async function buscarGoogle(placeId) {
  const chave = process.env.GOOGLE_PLACES_API_KEY;
  if (!chave || !placeId) return null;

  const emCache = cache.get(placeId);
  if (emCache && Date.now() - emCache.quando < CACHE_HORAS * 3600 * 1000) return emCache.dados;

  try {
    const resposta = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=pt-BR`, {
      headers: {
        'X-Goog-Api-Key': chave,
        'X-Goog-FieldMask': 'rating,userRatingCount,reviews,googleMapsUri',
      },
    });
    if (!resposta.ok) {
      console.warn('Google Places respondeu', resposta.status, await resposta.text().catch(() => ''));
      return emCache ? emCache.dados : null;
    }
    const lugar = await resposta.json();
    const dados = {
      nota: lugar.rating || null,
      total: lugar.userRatingCount || 0,
      url: lugar.googleMapsUri || `https://www.google.com/maps/place/?q=place_id:${placeId}`,
      avaliacoes: (lugar.reviews || []).map((r) => ({
        autor: r.authorAttribution?.displayName || 'Cliente do Google',
        autorUrl: r.authorAttribution?.uri || null,
        foto: r.authorAttribution?.photoUri || null,
        nota: r.rating || null,
        texto: r.text?.text || r.originalText?.text || '',
        quando: r.relativePublishTimeDescription || '',
      })),
    };
    cache.set(placeId, { quando: Date.now(), dados });
    return dados;
  } catch (e) {
    console.error('Erro ao consultar o Google Places', e.message);
    return emCache ? emCache.dados : null;
  }
}

module.exports = { buscarGoogle };
