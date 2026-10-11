'use strict';
// TikTok Shop Partner API — conferido com a referência oficial
// (partner.tiktokshop.com/docv2, out/2026).
//
// Assinatura: HMAC-SHA256(app_secret, app_secret + path + params ordenados
// (sem sign/access_token) + corpo JSON + app_secret); em multipart o corpo
// não entra. Token no header x-tts-access-token. Chamadas de loja levam shop_cipher.
//
// Regras da documentação que moldam este conector:
// - Fotos e vídeo precisam ser enviados à TikTok (URL externa não vale).
// - Estoque por SKU aceita só [1, 99.999]: produto sem estoque/inativo é
//   DESATIVADO (products/deactivate), não zerado.
// - Editar conteúdo (título, descrição, fotos...) manda o produto para nova
//   auditoria; preço e estoque não. Por isso o update separa os dois caminhos
//   e só faz edição parcial quando o conteúdo mudou de fato.
// - identifier_code (GTIN/EAN) só pode mudar enquanto o produto é rascunho.
// - "Get Authorized Category Assets" é da autorização de PARCEIRO (Affiliate
//   Partner / TAP) e não se aplica à publicação de produtos do vendedor.
const { requestJson, download, PlatformError } = require('../lib/media');
const { hmacHex, sha256 } = require('../lib/crypto');

const API = 'https://open-api.tiktokglobalshop.com';
const AUTH = 'https://auth.tiktok-shops.com';
const IMAGE_MAX = 10 * 1024 * 1024;
const VIDEO_MAX = 100 * 1024 * 1024;
// Mercados que exigem a árvore de categorias v2 (US, UE e Sudeste Asiático).
const V2_REGIONS = new Set(['US', 'ID', 'MY', 'PH', 'SG', 'TH', 'VN',
  'DE', 'ES', 'FR', 'IT', 'IE', 'PL', 'NL', 'BE', 'CZ', 'AT', 'GR', 'PT', 'HU']);
const LOCALES = { BR: 'pt-BR', MX: 'es-MX', US: 'en-US', GB: 'en-GB', ES: 'es-ES' };

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

const region = (ctx) => String(ctx.tokens.region || 'BR').toUpperCase();
const categoryVersion = (ctx) => (V2_REGIONS.has(region(ctx)) ? 'v2' : 'v1');
const locale = (ctx) => LOCALES[region(ctx)];

module.exports = {
  id: 'tiktok',
  name: 'TikTok Shop',
  color: '#000000',
  textColor: '#FFFFFF',
  docsUrl: 'https://partner.tiktokshop.com/docv2/page/create-product-202309',
  credentialFields: [
    { key: 'app_key', label: 'App Key', type: 'text', required: true },
    { key: 'app_secret', label: 'App Secret', type: 'password', required: true },
    { key: 'service_id', label: 'Service ID', type: 'text', required: true, help: 'Partner Center › App & Service › Basic Information › Service ID' },
    { key: 'auth_host', label: 'Host de autorização', type: 'select', options: ['https://services.tiktokshop.com', 'https://services.us.tiktokshop.com'], default: 'https://services.tiktokshop.com', help: 'Lojas dos EUA usam o host .us; Brasil e demais países, o padrão.' },
    { key: 'default_category_id', label: 'Categoria padrão (opcional)', type: 'text', help: 'Vazio = o hub pede a recomendação de categoria pelo título, descrição e fotos.' },
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
    return {
      ...tokens, shop_cipher: shop.cipher, shop_id: shop.id, shop_name: shop.name,
      region: shop.region, seller_type: shop.seller_type,
    };
  },

  async refreshTokens({ creds, tokens }) {
    const q = new URLSearchParams({ app_key: creds.app_key, app_secret: creds.app_secret, refresh_token: tokens.refresh_token, grant_type: 'refresh_token' });
    return { ...tokens, ...toTokens(await requestJson(`${AUTH}/api/v2/token/refresh?${q}`)) };
  },

  async test(ctx) {
    const shops = await call(ctx, 'GET', '/authorization/202309/shops', { noShop: true });
    const s = (shops.shops || [])[0] || {};
    const crossBorder = (s.seller_type || ctx.tokens.seller_type) === 'CROSS_BORDER'
      ? ' — vendedor CROSS_BORDER: confirme que a loja usa a listagem local (local replication)' : '';
    return { account: `${s.name || ctx.tokens.shop_name} (${s.region || ctx.tokens.region || '?'})${crossBorder}` };
  },

  async publish(ctx, p, listing) {
    const productId = listing && listing.external_id;
    return productId ? update(ctx, p, listing) : create(ctx, p);
  },
};

// ---------------------------------------------------------------- criação
async function create(ctx, p) {
  const warnings = [];
  const qty = stockQty(p);
  if (!qty) {
    // A TikTok não aceita SKU com estoque 0: espera haver estoque para criar.
    return { externalId: null, meta: { skipped: true }, warnings: ['TikTok Shop: produto sem estoque ou inativo — será criado quando houver estoque'] };
  }
  const media = await uploadMedia(ctx, p, {}, warnings);
  const warehouseId = ctx.creds.warehouse_id || await defaultWarehouse(ctx);
  const categoryId = p.categories.tiktok || ctx.creds.default_category_id || await recommendCategory(ctx, p, media.mainImages);
  const attributes = await productAttributes(ctx, String(categoryId), p);

  const sku = {
    seller_sku: sellerSku(p.sku),
    external_sku_id: p.sku,
    price: price(ctx, p.price),
    inventory: [{ warehouse_id: warehouseId, quantity: qty }],
  };
  const identifier = identifierCode(p.gtin);
  if (identifier) sku.identifier_code = identifier;
  else if (p.gtin) warnings.push(`GTIN/EAN "${p.gtin}" com formato inválido para a TikTok (8, 12, 13 ou 14 dígitos); não enviado`);

  const content = contentFields(ctx, p, media, attributes);
  const body = {
    ...content,
    category_id: String(categoryId),
    skus: [sku],
    external_product_id: p.sku,
    // Mesma requisição repetida (ex.: queda de rede) não duplica o produto.
    idempotency_key: `azh-${sha256(`${p.sku}|${JSON.stringify(content)}|${sku.price.amount}`)}`.slice(0, 128),
  };
  if (categoryVersion(ctx) === 'v2') body.category_version = 'v2';

  const res = await call(ctx, 'POST', '/product/202309/products', { body });
  const productId = String(res.product_id);
  const meta = {
    ...media.meta, warehouse_id: warehouseId, category_id: String(categoryId),
    sku_id: res.skus && res.skus[0] && String(res.skus[0].id),
    content_hash: contentHash(content), price: p.price, quantity: qty, deactivated: false, skipped: false,
  };
  await syncPromotion(ctx, productId, p, {}, meta, warnings);
  return { externalId: productId, meta, warnings };
}

// ------------------------------------------------------------ atualização
async function update(ctx, p, listing) {
  const warnings = [];
  const prev = listing.meta || {};
  const productId = String(listing.external_id);
  const meta = {};
  const qty = stockQty(p);

  // 1) Sem estoque ou inativo → desativa (o estoque não pode ser 0).
  if (!qty) {
    if (!prev.deactivated) {
      await deactivate(ctx, productId);
      meta.deactivated = true;
      warnings.push('Produto sem estoque ou inativo: desativado no TikTok Shop');
    }
    return { externalId: productId, meta, warnings };
  }

  const skuId = prev.sku_id || await fetchSkuId(ctx, productId);
  meta.sku_id = skuId;
  const warehouseId = prev.warehouse_id || ctx.creds.warehouse_id || await defaultWarehouse(ctx);
  meta.warehouse_id = warehouseId;

  // 2) Conteúdo: edição parcial só se algo mudou (ela dispara nova auditoria).
  const media = await uploadMedia(ctx, p, prev, warnings);
  Object.assign(meta, media.meta);
  const categoryId = prev.category_id || p.categories.tiktok || ctx.creds.default_category_id;
  const attributes = categoryId ? await productAttributes(ctx, String(categoryId), p) : null;
  const content = contentFields(ctx, p, media, attributes);
  const hash = contentHash(content);
  if (hash !== prev.content_hash) {
    await call(ctx, 'POST', `/product/202509/products/${productId}/partial_edit`, { body: content });
    meta.content_hash = hash;
    warnings.push('Conteúdo alterado: o TikTok Shop reenvia o produto para auditoria');
  }

  // 3) Preço e estoque: publicação imediata, sem auditoria.
  if (p.price !== prev.price) {
    try {
      await call(ctx, 'POST', `/product/202309/products/${productId}/prices/update`, {
        body: { skus: [{ id: skuId, price: price(ctx, p.price) }] },
      });
      meta.price = p.price;
    } catch (e) {
      // A TikTok recusa mudança de preço com promoção em andamento.
      warnings.push(`Preço não atualizado (há promoção ativa?): ${e.message}`);
    }
  }
  if (qty !== prev.quantity || prev.deactivated) {
    await call(ctx, 'POST', `/product/202309/products/${productId}/inventory/update`, {
      body: { skus: [{ id: skuId, inventory: [{ warehouse_id: warehouseId, quantity: qty }] }] },
    });
    meta.quantity = qty;
  }
  if (prev.deactivated) {
    await activate(ctx, productId);
    meta.deactivated = false;
    warnings.push('Produto reativado: o TikTok Shop reenvia para auditoria');
  }

  await syncPromotion(ctx, productId, p, prev, meta, warnings);
  return { externalId: productId, meta, warnings };
}

// --------------------------------------------------------------- conteúdo
// Campos de nível superior que, alterados, exigem nova auditoria.
function contentFields(ctx, p, media, attributes) {
  const maxTitle = ['BR', 'MX'].includes(region(ctx)) ? 300 : 255;
  const out = {
    title: p.title.slice(0, maxTitle),
    description: html(p.description || p.title).slice(0, 10000),
    main_images: media.mainImages,
    package_weight: { value: weight(p.weightKg || 0.5), unit: 'KILOGRAM' },
  };
  if (p.lengthCm && p.widthCm && p.heightCm) {
    out.package_dimensions = {
      length: String(Math.max(1, Math.round(p.lengthCm))), width: String(Math.max(1, Math.round(p.widthCm))),
      height: String(Math.max(1, Math.round(p.heightCm))), unit: 'CENTIMETER',
    };
  }
  if (media.videoId) out.video = { id: media.videoId };
  if (attributes && attributes.length) out.product_attributes = attributes;
  return out;
}

const contentHash = (content) => sha256(JSON.stringify(content));

async function uploadMedia(ctx, p, prev, warnings) {
  const imageCache = { ...(prev.images || {}) };
  const mainImages = [];
  for (const url of p.images.slice(0, 9)) {
    if (!imageCache[url]) imageCache[url] = await uploadImage(ctx, url);
    mainImages.push({ uri: imageCache[url] });
  }
  if (p.images.length > 9) warnings.push('TikTok Shop aceita até 9 fotos principais; as excedentes foram ignoradas');

  let video = prev.video && prev.video.url === p.videos[0] ? prev.video : null;
  if (p.videos[0] && !video) {
    try {
      video = { url: p.videos[0], id: await uploadVideo(ctx, p.videos[0], p.sku) };
    } catch (e) {
      warnings.push(`Vídeo não enviado: ${e.message}`);
    }
  }
  const meta = { images: imageCache };
  if (video) meta.video = video;
  return { mainImages, videoId: video && video.id, meta };
}

async function uploadImage(ctx, url) {
  const file = await download(url, { kind: 'image', maxBytes: IMAGE_MAX });
  const form = new FormData();
  form.append('data', new Blob([file.buffer], { type: file.contentType }), file.name);
  form.append('use_case', 'MAIN_IMAGE');
  const res = await call(ctx, 'POST', '/product/202309/images/upload', { form, noShop: true });
  if (!res.uri) throw new PlatformError(`TikTok não devolveu uri para ${url}`);
  return res.uri;
}

// Upload Product File: aceita MP4, MOV, MKV, WMV, WEBM, AVI, 3GP, FLV, MPEG
// até 100 MB, proporção entre 9:16 e 16:9.
async function uploadVideo(ctx, url, sku) {
  const file = await download(url, { kind: 'video', maxBytes: VIDEO_MAX });
  const name = videoName(file.name, sku);
  const form = new FormData();
  form.append('data', new Blob([file.buffer], { type: file.contentType }), name);
  form.append('name', name);
  const res = await call(ctx, 'POST', '/product/202309/files/upload', { form, noShop: true });
  if (!res.id) throw new PlatformError('TikTok não devolveu id do vídeo');
  return res.id;
}

// O nome não pode ter espaço, ponto extra nem começar com símbolo.
function videoName(original, sku) {
  const m = String(original || '').match(/\.(mp4|mov|mkv|wmv|webm|avi|3gp|flv|mpeg)$/i);
  const ext = m ? m[1].toLowerCase() : 'mp4';
  const base = `video_${sku}`.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80);
  return `${base}.${ext}`;
}

// ---------------------------------------------------- categoria/atributos
async function recommendCategory(ctx, p, mainImages) {
  const body = {
    product_title: p.title,
    description: html(p.description || p.title).slice(0, 10000),
    images: mainImages,
  };
  if (categoryVersion(ctx) === 'v2') body.category_version = 'v2';
  if (locale(ctx)) body.locale = locale(ctx);
  if (['BR', 'MX'].includes(region(ctx))) body.include_prohibited_categories = true;
  const res = await call(ctx, 'POST', '/product/202309/categories/recommend', { body });
  if (!res.leaf_category_id) throw new PlatformError('TikTok: categoria não recomendada; informe category_tiktok no produto');
  const leaf = (res.categories || []).find((c) => String(c.id) === String(res.leaf_category_id)) || {};
  const perms = leaf.permission_statuses || [];
  if (perms.length && !perms.includes('AVAILABLE')) {
    throw new PlatformError(`TikTok: a categoria recomendada "${leaf.name || res.leaf_category_id}" (${res.leaf_category_id}) ` +
      `não está liberada para a loja (${perms.join(', ')}). Informe category_tiktok no produto ou peça liberação no Seller Center.`);
  }
  return res.leaf_category_id;
}

// Atributos por categoria ficam em cache por 6 h (mudam pouco).
const attrCache = new Map();

async function categoryAttributes(ctx, categoryId) {
  const key = `${ctx.tokens.shop_cipher}:${categoryId}`;
  const hit = attrCache.get(key);
  if (hit && hit.at > Date.now() - 6 * 3600e3) return hit.list;
  const query = {};
  if (categoryVersion(ctx) === 'v2') query.category_version = 'v2';
  if (locale(ctx)) query.locale = locale(ctx);
  const res = await call(ctx, 'GET', `/product/202309/categories/${categoryId}/attributes`, { query });
  const list = (res.attributes || []).filter((a) => a.type === 'PRODUCT_PROPERTY');
  attrCache.set(key, { at: Date.now(), list });
  return list;
}

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

// Casa os "attributes" do produto (chave = id ou nome do atributo na TikTok)
// com os atributos da categoria. Obrigatório ausente = erro explicando o que falta.
async function productAttributes(ctx, categoryId, p) {
  const defs = await categoryAttributes(ctx, categoryId);
  const given = Object.entries(p.attributes || {});
  const out = [];
  const missing = [];
  for (const def of defs) {
    const entry = given.find(([k]) => k === String(def.id) || norm(k) === norm(def.name));
    const required = def.is_requried === true || def.is_required === true;
    if (!entry) {
      if (required) missing.push(def);
      continue;
    }
    const values = [];
    for (const raw of [].concat(entry[1]).map(String)) {
      const known = (def.values || []).find((v) => String(v.id) === raw || norm(v.name) === norm(raw));
      if (known) values.push({ id: String(known.id) });
      else if (def.is_customizable || !(def.values || []).length) values.push({ name: raw });
      else {
        const opts = def.values.slice(0, 12).map((v) => v.name).join(', ');
        throw new PlatformError(`TikTok: valor "${raw}" inválido para o atributo "${def.name}". Opções: ${opts}${def.values.length > 12 ? '…' : ''}`);
      }
    }
    if (values.length) out.push({ id: String(def.id), values });
  }
  if (missing.length) {
    const list = missing.map((d) => {
      const opts = (d.values || []).slice(0, 6).map((v) => v.name).join(' / ');
      return `"${d.name}" (id ${d.id}${opts ? `: ${opts}${d.values.length > 6 ? '…' : ''}` : ''})`;
    }).join('; ');
    throw new PlatformError(`TikTok: a categoria ${categoryId} exige os atributos ${list}. Envie-os em "attributes" do produto (chave = nome ou id).`);
  }
  return out;
}

// --------------------------------------------------------------- promoção
// Campanha FIXED_PRICE por produto (1 SKU). A atividade é reaproveitada
// enquanto as datas pedidas forem as mesmas e ela não tiver expirado.
async function syncPromotion(ctx, productId, p, prev, meta, warnings) {
  const now = Math.floor(Date.now() / 1000);
  const old = prev.promo && prev.promo.end > now ? prev.promo : null;
  try {
    if (!p.promoPrice) {
      if (old) {
        await call(ctx, 'DELETE', `/promotion/202309/activities/${old.activity_id}/products`, { body: { product_ids: [productId] } });
        meta.promo = null;
      }
      return;
    }
    const sameWindow = old && old.requestedStart === (p.promoStart || null) && old.requestedEnd === (p.promoEnd || null);
    if (sameWindow && old.price === p.promoPrice) return;

    let activityId = sameWindow ? old.activity_id : null;
    let begin = sameWindow ? old.start : null;
    let end = sameWindow ? old.end : null;
    if (!activityId) {
      if (old) {
        await call(ctx, 'DELETE', `/promotion/202309/activities/${old.activity_id}/products`, { body: { product_ids: [productId] } })
          .catch((e) => warnings.push(`Promoção anterior não removida: ${e.message}`));
      }
      // Início precisa ser no futuro; fim, ao menos 10 min depois do início.
      begin = Math.max(p.promoStart ? Math.floor(new Date(p.promoStart) / 1000) : 0, now + 120);
      end = p.promoEnd ? Math.floor(new Date(p.promoEnd) / 1000) : begin + 30 * 86400;
      if (end < begin + 600) throw new PlatformError('fim da promoção precisa ser ao menos 10 minutos depois do início');
      const a = await call(ctx, 'POST', '/promotion/202309/activities', {
        body: {
          // O título precisa ser único entre todas as atividades da loja.
          title: `AzureHub ${p.sku} ${begin}`.slice(0, 100),
          activity_type: 'FIXED_PRICE', product_level: 'PRODUCT', begin_time: begin, end_time: end,
        },
      });
      activityId = a.activity_id;
    }
    await call(ctx, 'PUT', `/promotion/202309/activities/${activityId}/products`, {
      body: {
        activity_id: activityId,
        products: [{ id: productId, activity_price_amount: money(p.promoPrice), quantity_limit: -1, quantity_per_user: -1, skus: [] }],
      },
    });
    meta.promo = {
      activity_id: activityId, price: p.promoPrice, start: begin, end,
      requestedStart: p.promoStart || null, requestedEnd: p.promoEnd || null,
    };
  } catch (e) {
    warnings.push(`Promoção não aplicada: ${e.message}`);
  }
}

// ---------------------------------------------------------------- apoio
async function deactivate(ctx, productId) {
  await call(ctx, 'POST', '/product/202309/products/deactivate', { body: { product_ids: [productId] } });
}

async function activate(ctx, productId) {
  const res = await call(ctx, 'POST', '/product/202309/products/activate', { body: { product_ids: [productId] } });
  // A resposta pode ter code 0 e ainda assim trazer erro por produto.
  const err = (res.errors || [])[0];
  if (err) throw new PlatformError(`TikTok: não foi possível reativar: ${err.message}`);
}

async function fetchSkuId(ctx, productId) {
  const res = await call(ctx, 'GET', `/product/202309/products/${productId}`);
  const id = res.skus && res.skus[0] && res.skus[0].id;
  if (!id) throw new PlatformError(`TikTok: produto ${productId} sem SKU`);
  return String(id);
}

async function defaultWarehouse(ctx) {
  const res = await call(ctx, 'GET', '/logistics/202309/warehouses');
  const list = (res.warehouses || []).filter((w) => w.type === 'SALES_WAREHOUSE' && w.effect_status === 'ENABLED');
  const w = list.find((x) => x.is_default) || list[0];
  if (!w) throw new PlatformError('TikTok: nenhum armazém de vendas ativo (ENABLED) na loja');
  return w.id;
}

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

const stockQty = (p) => (p.active ? Math.min(99999, Math.max(0, p.stock)) : 0);
const money = (v) => Number(v).toFixed(2);
const price = (ctx, v) => ({ amount: money(v), currency: ctx.creds.currency || 'BRL' });
// KILOGRAM aceita até 3 casas decimais.
const weight = (kg) => String(Math.max(0.001, Math.round(kg * 1000) / 1000));
// seller_sku: texto sem espaços, até 50 caracteres.
const sellerSku = (sku) => String(sku).replace(/\s+/g, '-').slice(0, 50);

function identifierCode(gtin) {
  const code = String(gtin || '').replace(/\D/g, '');
  const type = { 8: 'EAN', 12: 'UPC', 13: 'EAN', 14: 'GTIN' }[code.length];
  return type ? { code, type } : null;
}

function html(text) {
  const s = String(text);
  if (/<[a-z][\s\S]*>/i.test(s)) return s;
  return s.split(/\n{2,}/).map((para) => `<p>${para.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`).join('');
}

module.exports._internal = { sign, videoName, identifierCode, weight, attrCache };
