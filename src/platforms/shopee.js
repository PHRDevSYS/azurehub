'use strict';
// Shopee Open Platform v2 — assinatura HMAC-SHA256 com a partner_key.
//   pública: partner_id + path + timestamp
//   loja:    partner_id + path + timestamp + access_token + shop_id
// Access token dura 4 h; refresh token, 30 dias.
const { requestJson, download, PlatformError } = require('../lib/media');
const { hmacHex, md5 } = require('../lib/crypto');

const HOSTS = {
  production: 'https://partner.shopeemobile.com',
  sandbox: 'https://partner.test-stable.shopeemobile.com',
};
const VIDEO_PART = 4 * 1024 * 1024;

function host(creds) {
  return (creds.api_host || HOSTS[creds.environment || 'production']).replace(/\/+$/, '');
}

function sign(creds, path, timestamp, accessToken = '', shopId = '') {
  return hmacHex(creds.partner_key, `${creds.partner_id}${path}${timestamp}${accessToken}${shopId}`);
}

function publicUrl(creds, path, extra = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const q = new URLSearchParams({ partner_id: String(creds.partner_id), timestamp: String(ts), sign: sign(creds, path, ts), ...extra });
  return `${host(creds)}${path}?${q}`;
}

function shopUrl(ctx, path, extra = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const { access_token: at, shop_id: shopId } = ctx.tokens;
  const q = new URLSearchParams({
    partner_id: String(ctx.creds.partner_id), timestamp: String(ts), access_token: at,
    shop_id: String(shopId), sign: sign(ctx.creds, path, ts, at, shopId), ...extra,
  });
  return `${host(ctx.creds)}${path}?${q}`;
}

// A Shopee responde HTTP 200 mesmo em erro: o erro vem em body.error.
function check(data, path) {
  if (data && data.error) {
    const retryable = /rate|limit|busy|timeout|system/i.test(data.error);
    throw new PlatformError(`Shopee ${path}: ${data.error} — ${data.message || ''}`.trim(), { body: data, retryable });
  }
  return data.response || data;
}

async function call(ctx, method, path, body, query) {
  const data = await requestJson(shopUrl(ctx, path, query), { method, body });
  return check(data, path);
}

async function upload(ctx, path, form) {
  const data = await requestJson(shopUrl(ctx, path), { method: 'POST', form, timeoutMs: 300000 });
  return check(data, path);
}

module.exports = {
  id: 'shopee',
  name: 'Shopee',
  color: '#EE4D2D',
  textColor: '#FFFFFF',
  docsUrl: 'https://open.shopee.com/documents/v2/v2.product.add_item',
  credentialFields: [
    { key: 'partner_id', label: 'Partner ID', type: 'text', required: true },
    { key: 'partner_key', label: 'Partner Key', type: 'password', required: true },
    { key: 'environment', label: 'Ambiente', type: 'select', options: ['production', 'sandbox'], default: 'sandbox' },
    { key: 'api_host', label: 'Host da API (opcional)', type: 'text', help: 'Só se a Shopee indicar um host regional diferente.' },
    { key: 'default_category_id', label: 'Categoria padrão', type: 'text', help: 'category_id da Shopee usado quando o produto não informa category_shopee.' },
    { key: 'logistic_ids', label: 'Canais logísticos', type: 'text', help: 'IDs separados por vírgula. Vazio = todos os canais ativos da loja.' },
    { key: 'default_weight_kg', label: 'Peso padrão (kg)', type: 'text', default: '0.5' },
  ],

  authorizeUrl({ creds, redirectUri, state }) {
    // A Shopee não devolve "state": ele vai embutido no redirect.
    const redirect = `${redirectUri}?state=${encodeURIComponent(state)}`;
    return publicUrl(creds, '/api/v2/shop/auth_partner', { redirect });
  },

  async handleCallback({ creds, query }) {
    if (!query.code || !query.shop_id) throw new PlatformError('Autorização Shopee sem code/shop_id');
    const path = '/api/v2/auth/token/get';
    const data = await requestJson(publicUrl(creds, path), {
      method: 'POST',
      body: { code: query.code, shop_id: Number(query.shop_id), partner_id: Number(creds.partner_id) },
    });
    check(data, path);
    return toTokens(data, query.shop_id);
  },

  async refreshTokens({ creds, tokens }) {
    const path = '/api/v2/auth/access_token/get';
    const data = await requestJson(publicUrl(creds, path), {
      method: 'POST',
      body: { refresh_token: tokens.refresh_token, shop_id: Number(tokens.shop_id), partner_id: Number(creds.partner_id) },
    });
    check(data, path);
    return toTokens(data, tokens.shop_id);
  },

  async test(ctx) {
    const info = await call(ctx, 'GET', '/api/v2/shop/get_shop_info');
    return { account: `${info.shop_name || 'Loja'} (shop_id ${ctx.tokens.shop_id}, região ${info.region || '?'})` };
  },

  async publish(ctx, p, listing) {
    const warnings = [];
    const prevMeta = (listing && listing.meta) || {};
    const meta = {};

    // 1) Fotos — reaproveita image_id se a URL já foi enviada antes.
    const imageCache = { ...(prevMeta.images || {}) };
    const imageIds = [];
    for (const url of p.images.slice(0, 9)) {
      if (!imageCache[url]) imageCache[url] = await uploadImage(ctx, url);
      imageIds.push(imageCache[url]);
    }
    if (p.images.length > 9) warnings.push('Shopee aceita até 9 fotos; as excedentes foram ignoradas');
    meta.images = imageCache;

    // 2) Vídeo — upload em partes; só o primeiro vídeo (limite da Shopee).
    let videoUploadId = prevMeta.video && prevMeta.video.url === p.videos[0] ? prevMeta.video.id : null;
    if (p.videos[0] && !videoUploadId) {
      try {
        videoUploadId = await uploadVideo(ctx, p.videos[0]);
        meta.video = { url: p.videos[0], id: videoUploadId };
      } catch (e) {
        warnings.push(`Vídeo não enviado: ${e.message}`);
      }
    }

    const weight = p.weightKg || Number(ctx.creds.default_weight_kg || 0.5);
    const stock = p.active ? p.stock : 0;
    const body = {
      item_name: p.title.slice(0, 120),
      description: plain(p.description || p.title),
      item_sku: p.sku,
      original_price: p.price,
      weight,
      image: { image_id_list: imageIds },
      condition: p.condition === 'used' ? 'USED' : 'NEW',
      item_status: p.active ? 'NORMAL' : 'UNLIST',
      brand: { brand_id: 0, original_brand_name: p.brand ? String(p.brand) : 'NoBrand' },
    };
    if (p.lengthCm && p.widthCm && p.heightCm) {
      body.dimension = { package_length: Math.ceil(p.lengthCm), package_width: Math.ceil(p.widthCm), package_height: Math.ceil(p.heightCm) };
    }
    if (videoUploadId) body.video_upload_id = [videoUploadId];

    let itemId = listing && listing.external_id;
    if (!itemId) {
      const categoryId = Number(p.categories.shopee || ctx.creds.default_category_id);
      if (!categoryId) throw new PlatformError('Shopee: informe category_shopee no produto ou uma categoria padrão no card');
      body.category_id = categoryId;
      body.seller_stock = [{ stock }];
      body.logistic_info = await logistics(ctx);
      const res = await call(ctx, 'POST', '/api/v2/product/add_item', body);
      itemId = String(res.item_id);
    } else {
      await call(ctx, 'POST', '/api/v2/product/update_item', { item_id: Number(itemId), ...body });
      await call(ctx, 'POST', '/api/v2/product/update_price', { item_id: Number(itemId), price_list: [{ original_price: p.price }] });
      await call(ctx, 'POST', '/api/v2/product/update_stock', { item_id: Number(itemId), stock_list: [{ seller_stock: [{ stock }] }] });
    }

    // 3) Preço promocional — cria (ou reaproveita) uma campanha de desconto.
    if (p.promoPrice) {
      try {
        meta.promo = await applyDiscount(ctx, Number(itemId), p, prevMeta.promo);
      } catch (e) {
        warnings.push(`Promoção não aplicada: ${e.message}`);
      }
    }
    return { externalId: itemId, meta, warnings };
  },
};

function toTokens(data, shopId) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    shop_id: String(shopId),
    expires_at: Date.now() + (data.expire_in || 14400) * 1000,
  };
}

async function uploadImage(ctx, url) {
  const file = await download(url, { kind: 'image' });
  const form = new FormData();
  form.append('image', new Blob([file.buffer], { type: file.contentType }), file.name);
  const res = await upload(ctx, '/api/v2/media_space/upload_image', form);
  const id = (res.image_info && res.image_info.image_id) ||
    (res.image_info_list && res.image_info_list[0] && res.image_info_list[0].image_info.image_id);
  if (!id) throw new PlatformError(`Shopee não devolveu image_id para ${url}`);
  return id;
}

async function uploadVideo(ctx, url) {
  const file = await download(url, { kind: 'video' });
  const started = Date.now();
  const init = await call(ctx, 'POST', '/api/v2/media_space/init_video_upload', {
    file_md5: md5(file.buffer), file_size: file.buffer.length,
  });
  const id = init.video_upload_id;
  const parts = [];
  for (let seq = 0, off = 0; off < file.buffer.length; seq++, off += VIDEO_PART) {
    const chunk = file.buffer.subarray(off, off + VIDEO_PART);
    const form = new FormData();
    form.append('video_upload_id', id);
    form.append('part_seq', String(seq));
    form.append('content_md5', md5(chunk));
    form.append('part_content', new Blob([chunk], { type: 'application/octet-stream' }), 'part');
    await upload(ctx, '/api/v2/media_space/upload_video_part', form);
    parts.push(seq);
  }
  await call(ctx, 'POST', '/api/v2/media_space/complete_video_upload', {
    video_upload_id: id, part_seq_list: parts, report_data: { upload_cost: Date.now() - started },
  });
  // A transcodificação é assíncrona: espera até ~2 min.
  for (let i = 0; i < 24; i++) {
    const r = await call(ctx, 'GET', '/api/v2/media_space/get_video_upload_result', undefined, { video_upload_id: id });
    if (r.status === 'SUCCEEDED') return id;
    if (r.status === 'FAILED' || r.status === 'CANCELLED') throw new PlatformError(`Transcodificação do vídeo falhou: ${r.message || r.status}`);
    await new Promise((ok) => setTimeout(ok, 5000));
  }
  throw new PlatformError('Vídeo ainda em processamento na Shopee; será tentado de novo', { retryable: true });
}

async function logistics(ctx) {
  const configured = String(ctx.creds.logistic_ids || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
  if (configured.length) return configured.map((logistic_id) => ({ logistic_id, enabled: true }));
  const res = await call(ctx, 'GET', '/api/v2/logistics/get_channel_list');
  const list = (res.logistics_channel_list || []).filter((c) => c.enabled);
  if (!list.length) throw new PlatformError('Shopee: nenhum canal logístico ativo na loja');
  return list.map((c) => ({ logistic_id: c.logistics_channel_id, enabled: true }));
}

async function applyDiscount(ctx, itemId, p, prev) {
  const now = Math.floor(Date.now() / 1000);
  // A Shopee exige início no futuro.
  const start = Math.max(p.promoStart ? Math.floor(new Date(p.promoStart) / 1000) : 0, now + 600);
  const end = p.promoEnd ? Math.floor(new Date(p.promoEnd) / 1000) : start + 30 * 86400;
  let discountId = prev && prev.discount_id && prev.end > now ? prev.discount_id : null;
  if (!discountId) {
    const d = await call(ctx, 'POST', '/api/v2/discount/add_discount', {
      discount_name: `AzureHub ${p.sku}`.slice(0, 50), start_time: start, end_time: end,
    });
    discountId = d.discount_id;
    await call(ctx, 'POST', '/api/v2/discount/add_discount_item', {
      discount_id: discountId,
      item_list: [{ item_id: itemId, purchase_limit: 0, item_promotion_price: p.promoPrice }],
    });
  } else {
    await call(ctx, 'POST', '/api/v2/discount/update_discount_item', {
      discount_id: discountId,
      item_list: [{ item_id: itemId, purchase_limit: 0, item_promotion_price: p.promoPrice }],
    });
  }
  return { discount_id: discountId, price: p.promoPrice, start, end };
}

function plain(html) {
  return String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim().slice(0, 3000);
}

module.exports._internal = { sign };
