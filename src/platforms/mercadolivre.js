'use strict';
// Mercado Livre — https://developers.mercadolivre.com.br/pt_br/api-docs-pt-br
// OAuth 2.0 (authorization code). Access token dura 6 h; refresh token é de
// uso único (cada refresh devolve um novo — por isso sempre regravamos).
const { requestJson, PlatformError, youtubeId } = require('../lib/media');

const API = 'https://api.mercadolibre.com';
const AUTH_HOSTS = {
  MLB: 'https://auth.mercadolivre.com.br',
  MLA: 'https://auth.mercadolibre.com.ar',
  MLM: 'https://auth.mercadolibre.com.mx',
};

module.exports = {
  id: 'mercadolivre',
  name: 'Mercado Livre',
  color: '#FFE600',
  textColor: '#2D3277',
  docsUrl: 'https://developers.mercadolivre.com.br/pt_br/api-docs-pt-br',
  credentialFields: [
    { key: 'client_id', label: 'App ID (client_id)', type: 'text', required: true },
    { key: 'client_secret', label: 'Chave secreta (client_secret)', type: 'password', required: true },
    { key: 'site_id', label: 'Site', type: 'select', options: ['MLB', 'MLA', 'MLM'], default: 'MLB' },
    { key: 'listing_type_id', label: 'Tipo de anúncio', type: 'select', options: ['gold_special', 'gold_pro', 'free'], default: 'gold_special', help: 'gold_special = Clássico, gold_pro = Premium' },
    { key: 'default_category_id', label: 'Categoria padrão (opcional)', type: 'text', help: 'Ex.: MLB1055. Vazio = o hub prevê a categoria pelo título.' },
    { key: 'shipping_mode', label: 'Modo de envio', type: 'select', options: ['me2', 'not_specified'], default: 'me2', help: 'me2 = Mercado Envios' },
  ],

  authorizeUrl({ creds, redirectUri, state }) {
    const host = AUTH_HOSTS[creds.site_id || 'MLB'] || AUTH_HOSTS.MLB;
    const q = new URLSearchParams({ response_type: 'code', client_id: creds.client_id, redirect_uri: redirectUri, state });
    return `${host}/authorization?${q}`;
  },

  async handleCallback({ creds, query, redirectUri }) {
    if (!query.code) throw new PlatformError(`Autorização negada: ${query.error || 'sem code'}`);
    return tokenRequest({
      grant_type: 'authorization_code', client_id: creds.client_id, client_secret: creds.client_secret,
      code: query.code, redirect_uri: redirectUri,
    });
  },

  async refreshTokens({ creds, tokens }) {
    return tokenRequest({
      grant_type: 'refresh_token', client_id: creds.client_id, client_secret: creds.client_secret,
      refresh_token: tokens.refresh_token,
    });
  },

  async test(ctx) {
    const me = await api(ctx, 'GET', '/users/me');
    return { account: `${me.nickname} (id ${me.id})` };
  },

  async publish(ctx, p, listing) {
    const warnings = [];
    const meta = {};
    const pictures = p.images.slice(0, 10).map((source) => ({ source }));
    if (p.images.length > 10) warnings.push('Mercado Livre aceita até 10 fotos; as excedentes foram ignoradas');

    // Vídeo: o anúncio aceita vídeo do YouTube (video_id). Arquivos de vídeo
    // (clips) passam por outro fluxo do ML que ainda não está no beta.
    let videoId = null;
    for (const v of p.videos) {
      videoId = youtubeId(v);
      if (videoId) break;
    }
    if (p.videos.length && !videoId) warnings.push('Mercado Livre: só vídeos do YouTube são enviados no beta (clips ficam para a próxima versão)');

    const attributes = [{ id: 'SELLER_SKU', value_name: p.sku }];
    if (p.brand) attributes.push({ id: 'BRAND', value_name: String(p.brand) });
    if (p.model) attributes.push({ id: 'MODEL', value_name: String(p.model) });
    if (p.gtin) attributes.push({ id: 'GTIN', value_name: String(p.gtin) });
    else attributes.push({ id: 'EMPTY_GTIN_REASON', value_id: '17055160' }); // "O produto não tem código cadastrado"
    for (const [k, v] of Object.entries(p.attributes || {})) {
      if (/^[A-Z0-9_]+$/.test(k)) attributes.push({ id: k, value_name: String(v) });
    }
    const dims = p.lengthCm && p.widthCm && p.heightCm && p.weightKg
      ? `${Math.ceil(p.heightCm)}x${Math.ceil(p.widthCm)}x${Math.ceil(p.lengthCm)},${Math.ceil(p.weightKg * 1000)}`
      : null;
    const stock = p.active ? p.stock : 0;

    let itemId = listing && listing.external_id;
    if (!itemId) {
      const categoryId = p.categories.mercadolivre || ctx.creds.default_category_id || await predictCategory(ctx, p.title);
      const body = {
        title: p.title.slice(0, 60),
        category_id: categoryId,
        price: p.price,
        currency_id: p.currency || 'BRL',
        available_quantity: stock,
        buying_mode: 'buy_it_now',
        condition: p.condition,
        listing_type_id: ctx.creds.listing_type_id || 'gold_special',
        pictures,
        attributes,
        shipping: { mode: ctx.creds.shipping_mode || 'me2', local_pick_up: false, free_shipping: false, ...(dims ? { dimensions: dims } : {}) },
      };
      if (videoId) body.video_id = videoId;
      let item;
      try {
        item = await api(ctx, 'POST', '/items', body);
      } catch (e) {
        // Categorias do modelo "User Products" exigem family_name no lugar de title.
        if (/family_name/i.test(e.message)) {
          const { title, ...rest } = body;
          item = await api(ctx, 'POST', '/items', { ...rest, family_name: title });
        } else {
          throw e;
        }
      }
      itemId = item.id;
      meta.permalink = item.permalink;
      meta.category_id = categoryId;
      if (p.description) {
        await api(ctx, 'POST', `/items/${itemId}/description`, { plain_text: plainText(p.description) });
      }
    } else {
      // Título não pode mudar depois da primeira venda — por isso não reenviamos.
      const body = { price: p.price, available_quantity: stock, pictures, attributes };
      if (videoId) body.video_id = videoId;
      await api(ctx, 'PUT', `/items/${itemId}`, body);
      if (p.description) {
        await api(ctx, 'PUT', `/items/${itemId}/description`, { plain_text: plainText(p.description) });
      }
      if (!p.active) await api(ctx, 'PUT', `/items/${itemId}`, { status: 'paused' }).catch(() => {});
    }

    // Preço promocional: campanha própria do vendedor (PRICE_DISCOUNT).
    if (p.promoPrice) {
      try {
        const start = p.promoStart && new Date(p.promoStart) > new Date() ? new Date(p.promoStart) : new Date(Date.now() + 5 * 60e3);
        const end = p.promoEnd ? new Date(p.promoEnd) : new Date(start.getTime() + 30 * 86400e3);
        await api(ctx, 'POST', `/seller-promotions/items/${itemId}?app_version=v2`, {
          promotion_type: 'PRICE_DISCOUNT',
          deal_price: p.promoPrice,
          start_date: start.toISOString().replace(/\.\d+Z$/, ''),
          finish_date: end.toISOString().replace(/\.\d+Z$/, ''),
        });
        meta.promo = { price: p.promoPrice, start: start.toISOString(), end: end.toISOString() };
      } catch (e) {
        warnings.push(`Promoção não aplicada: ${e.message}`);
      }
    }
    return { externalId: itemId, meta, warnings };
  },
};

async function tokenRequest(params) {
  const data = await requestJson(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    user_id: data.user_id,
    expires_at: Date.now() + (data.expires_in || 21600) * 1000,
  };
}

function api(ctx, method, path, body) {
  return requestJson(`${API}${path}`, {
    method, body, headers: { Authorization: `Bearer ${ctx.tokens.access_token}` },
  });
}

async function predictCategory(ctx, title) {
  const site = ctx.creds.site_id || 'MLB';
  const res = await api(ctx, 'GET', `/sites/${site}/domain_discovery/search?limit=1&q=${encodeURIComponent(title)}`);
  if (!Array.isArray(res) || !res.length) {
    throw new PlatformError('Não foi possível prever a categoria. Informe category_ml no produto ou uma categoria padrão.');
  }
  return res[0].category_id;
}

// O ML só aceita texto puro na descrição.
function plainText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, 50000);
}

module.exports._internal = { plainText };
