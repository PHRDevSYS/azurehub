'use strict';
// TikTok Shop Partner API (versão 202309).
// Assinatura: HMAC-SHA256(app_secret, app_secret + path + params ordenados
// (sem sign/access_token) + corpo JSON + app_secret). Token no header
// x-tts-access-token. Toda chamada de loja leva shop_cipher.
const { requestJson, download, PlatformError } = require('../lib/media');
const { hmacHex } = require('../lib/crypto');

const API = 'https://open-api.tiktokglobalshop.com';
const AUTH = 'https://auth.tiktok-shops.com';

function sign(appSecret, path, params, body = '') {
  const keys = Object.keys(params).filter((k) => k !== 'sign' && k !== 'access_token').sort();
  const base = path + keys.map((k) => `${k}${params[k]}`).join('') + body;
  return hmacHex(appSecret, `${appSecret}${base}${appSecret}`);
}

async function call(ctx, method, path, { body, query = {}, form, noShop = false } = {}) {
  const params = { app_key: ctx.creds.app_key, timestamp: String(Math.floor(Date.now() / 1000)), ...query };
  if (!noShop) params.shop_cipher = ctx.tokens.shop_cipher;
  const json = body !== undefined ? JSON.stringify(body) : '';
  params.sign = sign(ctx.creds.app_secret, path, params, form ? '' : json);
  const url = `${API}${path}?${new URLSearchParams(params)}`;
  const data = await requestJson(url, {
    method, form, body: form ? undefined : (json || undefined),
    headers: { 'x-tts-access-token': ctx.tokens.access_token },
    timeoutMs: form ? 300000 : 60000,
  });
  if (data.code !== 0) {
    const retryable = [36009004, 36009005].includes(data.code) || /limit|busy|timeout/i.test(data.message || '');
    throw new PlatformError(`TikTok ${path}: [${data.code}] ${data.message}`, { body: data, retryable });
  }
  return data.data || {};
}

module.exports = {
  id: 'tiktok',
  name: 'TikTok Shop',
  color: '#000000',
  textColor: '#FFFFFF',
  docsUrl: 'https://partner.tiktokshop.com/docv2',
  credentialFields: [
    { key: 'app_key', label: 'App Key', type: 'text', required: true },
    { key: 'app_secret', label: 'App Secret', type: 'password', required: true },
    { key: 'service_id', label: 'Service ID', type: 'text', required: true, help: 'Partner Center › App › Authorization (usado no link de autorização)' },
    { key: 'auth_host', label: 'Host de autorização', type: 'select', options: ['https://services.tiktokshop.com', 'https://services.us.tiktokshop.com'], default: 'https://services.tiktokshop.com' },
    { key: 'default_category_id', label: 'Categoria padrão (opcional)', type: 'text', help: 'Vazio = o hub pede a recomendação de categoria pelo título.' },
    { key: 'warehouse_id', label: 'Armazém (opcional)', type: 'text', help: 'Vazio = usa o armazém de vendas padrão da loja.' },
    { key: 'currency', label: 'Moeda', type: 'select', options: ['BRL', 'USD', 'MXN'], default: 'BRL' },
  ],

  authorizeUrl({ creds, state }) {
    // O redirect_uri é o cadastrado no Partner Center (não vai na URL).
    const q = new URLSearchParams({ service_id: creds.service_id, state });
    return `${(creds.auth_host || 'https://services.tiktokshop.com').replace(/\/+$/, '')}/open/authorize?${q}`;
  },

  async handleCallback({ creds, query }) {
    if (!query.code) throw new PlatformError('Autorização TikTok sem code');
    const q = new URLSearchParams({ app_key: creds.app_key, app_secret: creds.app_secret, auth_code: query.code, grant_type: 'authorized_code' });
    const tokens = toTokens(await requestJson(`${AUTH}/api/v2/token/get?${q}`));
    // Descobre a loja (shop_cipher) autorizada.
    const shops = await call({ creds, tokens }, 'GET', '/authorization/202309/shops', { noShop: true });
    const shop = (shops.shops || [])[0];
    if (!shop) throw new PlatformError('Nenhuma loja autorizada nesta conta TikTok Shop');
    return { ...tokens, shop_cipher: shop.cipher, shop_id: shop.id, shop_name: shop.name, region: shop.region };
  },

  async refreshTokens({ creds, tokens }) {
    const q = new URLSearchParams({ app_key: creds.app_key, app_secret: creds.app_secret, refresh_token: tokens.refresh_token, grant_type: 'refresh_token' });
    return { ...tokens, ...toTokens(await requestJson(`${AUTH}/api/v2/token/refresh?${q}`)) };
  },

  async test(ctx) {
    const shops = await call(ctx, 'GET', '/authorization/202309/shops', { noShop: true });
    const s = (shops.shops || [])[0] || {};
    return { account: `${s.name || ctx.tokens.shop_name} (${s.region || ctx.tokens.region || '?'})` };
  },

  async publish(ctx, p, listing) {
    const warnings = [];
    const prevMeta = (listing && listing.meta) || {};
    const meta = {};
    const currency = ctx.creds.currency || p.currency || 'BRL';

    const imageCache = { ...(prevMeta.images || {}) };
    const mainImages = [];
    for (const url of p.images.slice(0, 9)) {
      if (!imageCache[url]) imageCache[url] = await uploadImage(ctx, url);
      mainImages.push({ uri: imageCache[url] });
    }
    if (p.images.length > 9) warnings.push('TikTok Shop aceita até 9 fotos principais; as excedentes foram ignoradas');
    meta.images = imageCache;

    let video = prevMeta.video && prevMeta.video.url === p.videos[0] ? prevMeta.video : null;
    if (p.videos[0] && !video) {
      try {
        video = { url: p.videos[0], id: await uploadVideo(ctx, p.videos[0]) };
        meta.video = video;
      } catch (e) {
        warnings.push(`Vídeo não enviado: ${e.message}`);
      }
    }

    const warehouseId = ctx.creds.warehouse_id || prevMeta.warehouse_id || await defaultWarehouse(ctx);
    meta.warehouse_id = warehouseId;

    const sku = {
      seller_sku: p.sku,
      price: { amount: p.price.toFixed(2), currency },
      inventory: [{ warehouse_id: warehouseId, quantity: p.active ? p.stock : 0 }],
    };
    if (p.gtin) sku.identifier_code = { code: String(p.gtin), type: String(p.gtin).length === 13 ? 'EAN' : 'GTIN' };
    if (prevMeta.sku_id) sku.id = prevMeta.sku_id;

    const body = {
      title: p.title.slice(0, 255),
      description: html(p.description || p.title),
      main_images: mainImages,
      skus: [sku],
      package_weight: { value: String(p.weightKg || 0.5), unit: 'KILOGRAM' },
      is_cod_allowed: false,
    };
    if (p.lengthCm && p.widthCm && p.heightCm) {
      body.package_dimensions = { length: String(Math.ceil(p.lengthCm)), width: String(Math.ceil(p.widthCm)), height: String(Math.ceil(p.heightCm)), unit: 'CENTIMETER' };
    }
    if (video) body.video = { id: video.id };

    let productId = listing && listing.external_id;
    const categoryId = prevMeta.category_id || p.categories.tiktok || ctx.creds.default_category_id || await recommendCategory(ctx, p);
    body.category_id = String(categoryId);
    meta.category_id = body.category_id;

    if (!productId) {
      const res = await call(ctx, 'POST', '/product/202309/products', { body });
      productId = String(res.product_id);
      meta.sku_id = res.skus && res.skus[0] && res.skus[0].id;
    } else {
      const res = await call(ctx, 'PUT', `/product/202309/products/${productId}`, { body });
      if (res.skus && res.skus[0]) meta.sku_id = res.skus[0].id;
    }
    if (!p.active) warnings.push('Produto inativo na origem: estoque zerado no TikTok Shop');

    if (p.promoPrice) {
      try {
        meta.promo = await applyPromotion(ctx, productId, meta.sku_id || prevMeta.sku_id, p, prevMeta.promo);
      } catch (e) {
        warnings.push(`Promoção não aplicada: ${e.message}`);
      }
    }
    return { externalId: productId, meta, warnings };
  },
};

function toTokens(res) {
  if (res.code !== 0 || !res.data) throw new PlatformError(`TikTok token: [${res.code}] ${res.message}`);
  const d = res.data;
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    // A TikTok devolve o instante (epoch s) de expiração, não a duração.
    expires_at: d.access_token_expire_in * 1000,
    refresh_expires_at: d.refresh_token_expire_in * 1000,
  };
}

async function uploadImage(ctx, url) {
  const file = await download(url, { kind: 'image' });
  const form = new FormData();
  form.append('data', new Blob([file.buffer], { type: file.contentType }), file.name);
  form.append('use_case', 'MAIN_IMAGE');
  const res = await call(ctx, 'POST', '/product/202309/images/upload', { form, noShop: true });
  if (!res.uri) throw new PlatformError(`TikTok não devolveu uri para ${url}`);
  return res.uri;
}

// VALIDAR NO SANDBOX: vídeo de produto via "Upload Product File".
async function uploadVideo(ctx, url) {
  const file = await download(url, { kind: 'video' });
  const name = /\.(mp4|mov)$/i.test(file.name) ? file.name : `${file.name || 'video'}.mp4`;
  const form = new FormData();
  form.append('data', new Blob([file.buffer], { type: file.contentType }), name);
  form.append('name', name);
  const res = await call(ctx, 'POST', '/product/202309/files/upload', { form, noShop: true });
  if (!res.id) throw new PlatformError('TikTok não devolveu id do vídeo');
  return res.id;
}

async function defaultWarehouse(ctx) {
  const res = await call(ctx, 'GET', '/logistics/202309/warehouses');
  const list = (res.warehouses || []).filter((w) => w.type === 'SALES_WAREHOUSE' && w.effect_status !== 'DISABLED');
  const w = list.find((x) => x.is_default) || list[0];
  if (!w) throw new PlatformError('TikTok: nenhum armazém de vendas ativo');
  return w.id;
}

async function recommendCategory(ctx, p) {
  const res = await call(ctx, 'POST', '/product/202309/categories/recommend', { body: { product_title: p.title } });
  if (!res.leaf_category_id) throw new PlatformError('TikTok: categoria não recomendada; informe category_tiktok no produto');
  return res.leaf_category_id;
}

// VALIDAR NO SANDBOX: campanha "Fixed price" por SKU.
async function applyPromotion(ctx, productId, skuId, p, prev) {
  const now = Math.floor(Date.now() / 1000);
  const begin = Math.max(p.promoStart ? Math.floor(new Date(p.promoStart) / 1000) : 0, now + 600);
  const end = p.promoEnd ? Math.floor(new Date(p.promoEnd) / 1000) : begin + 30 * 86400;
  let activityId = prev && prev.activity_id && prev.end > now ? prev.activity_id : null;
  if (!activityId) {
    const a = await call(ctx, 'POST', '/promotion/202309/activities', {
      body: { title: `AzureHub ${p.sku}`.slice(0, 50), activity_type: 'FIXED_PRICE', begin_time: begin, end_time: end, product_level: 'VARIATION' },
    });
    activityId = a.activity_id;
  }
  await call(ctx, 'PUT', `/promotion/202309/activities/${activityId}/products`, {
    body: { activity_id: activityId, products: [{ id: productId, skus: [{ id: skuId, activity_price_amount: p.promoPrice.toFixed(2) }] }] },
  });
  return { activity_id: activityId, price: p.promoPrice, start: begin, end };
}

function html(text) {
  const s = String(text);
  if (/<[a-z][\s\S]*>/i.test(s)) return s;
  return s.split(/\n{2,}/).map((para) => `<p>${para.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`).join('');
}

module.exports._internal = { sign };
