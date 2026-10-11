'use strict';
// Shopee Open Platform v2 — conferido com a documentação oficial
// (open.shopee.com/developer-guide e referência das APIs, out/2026).
//
// Regras da documentação que moldam este conector:
// - Domínios: produção BR = openplatform.shopee.com.br (global =
//   partner.shopeemobile.com); sandbox = openplatform.sandbox.test-stable.shopee.sg.
//   Link de autorização: URL fixa por região + partner_id/auth_type/redirect_uri/
//   response_type/state (sem assinatura). A autorização vale no máximo 365 dias.
// - Assinatura por TIPO de API: Shop = partner_id+path+timestamp+access_token+shop_id;
//   Public = partner_id+path+timestamp. upload_image, upload_video_part e
//   complete_video_upload são Public; init_video_upload/get_video_upload_result são Shop.
// - Erro vem no corpo com HTTP 200 (campo "error"); operações em lote trazem
//   failure_list/error_list mesmo com sucesso — tudo é verificado.
// - Antes de criar: categoria folha, atributos obrigatórios (get_attribute_tree),
//   marca (get_brand_list; 0 = "No Brand"), limites da categoria (get_item_limit:
//   nome, descrição, preço, estoque, GTIN, peso/dimensão, tabela de medidas, DTS)
//   e canais logísticos ativos (enabled e mask_channel_id = 0).
// - Variações: até 2 níveis e 50 modelos; tier_variation foi DESCONTINUADO
//   (set/2025) em favor de standardise_tier_variation (get_variation_tree).
//   Preço da variação mais cara ≤ 4× a mais barata no BR. Imagem de variação só
//   no 1º nível e, se usada, em todas as opções. Esperar ~5 s entre add_item e
//   init_tier_variation.
// - Vídeo: MP4 até 30 MB, 10–60 s, ≤ 1280×1280, enviado em partes de 4 MB.
// - Desconto: início ≥ 1 h no futuro, fim ≥ 1 h após o início, duração < 180 dias.
//   Com promoção ativa, o preço original não pode ser alterado.
const { requestJson, download, PlatformError } = require('../lib/media');
const { hmacHex, md5, sha256 } = require('../lib/crypto');
const H_ = require('./preview-helpers');

const ENVS = {
  production: {
    BR: { api: 'https://openplatform.shopee.com.br', auth: 'https://open.shopee.com.br/auth' },
    GLOBAL: { api: 'https://partner.shopeemobile.com', auth: 'https://open.shopee.com/auth' },
  },
  sandbox: {
    BR: { api: 'https://openplatform.sandbox.test-stable.shopee.sg', auth: 'https://open.sandbox.test-stable.shopee.com.br/auth' },
    GLOBAL: { api: 'https://openplatform.sandbox.test-stable.shopee.sg', auth: 'https://open.sandbox.test-stable.shopee.com/auth' },
  },
};
const IMAGE_MAX = 10 * 1024 * 1024;
const VIDEO_MAX = 30 * 1024 * 1024;
const VIDEO_PART = 4 * 1024 * 1024;
const MAX_MODELS = 50;
const MAX_TIERS = 2;
// Razão máxima entre o preço da variação mais cara e o da mais barata.
const PRICE_RATIO = { BR: 4, SG: 5, VN: 5, TW: 5, TH: 5, PH: 5, MX: 5, ID: 7, MY: 7, CL: 9, CO: 9 };
const LANG = { BR: 'pt-BR', MX: 'es-MX', CO: 'es-CO', CL: 'es-CL' };

// Sobrescrevível nos testes (a doc pede ~5 s entre add_item e init_tier_variation).
const timing = { sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)), afterAddItemMs: 5000, videoPollMs: 5000, videoPolls: 12 };

const env = (creds) => {
  const e = ENVS[creds.environment === 'production' ? 'production' : 'sandbox'];
  return e[creds.region === 'GLOBAL' ? 'GLOBAL' : 'BR'];
};
const apiHost = (creds) => (creds.api_host || env(creds).api).replace(/\/+$/, '');
const region = (ctx) => String(ctx.tokens.region || ctx.creds.region || 'BR').toUpperCase();

function sign(creds, path, timestamp, accessToken = '', shopId = '') {
  return hmacHex(creds.partner_key, `${creds.partner_id}${path}${timestamp}${accessToken}${shopId}`);
}

function url(creds, path, { tokens, type = 'shop', query = {} } = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const params = { partner_id: String(creds.partner_id), timestamp: String(ts) };
  if (type === 'shop') {
    params.access_token = tokens.access_token;
    params.shop_id = String(tokens.shop_id);
    params.sign = sign(creds, path, ts, tokens.access_token, tokens.shop_id);
  } else {
    params.sign = sign(creds, path, ts);
  }
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) params[k] = Array.isArray(v) ? v.join(',') : String(v);
  return `${apiHost(creds)}${path}?${new URLSearchParams(params)}`;
}

// A Shopee responde HTTP 200 mesmo em erro: o erro vem em body.error.
function check(data, path) {
  if (data && data.error) {
    const retryable = /error_inner|error_server|error_network|busy|rate|limit|timeout|system/i.test(`${data.error} ${data.message || ''}`);
    throw new PlatformError(`Shopee ${path}: ${data.error} — ${data.message || ''}`.trim(), { body: data, retryable });
  }
  return data;
}

async function call(ctx, method, path, { body, query, form, type = 'shop', raw = false } = {}) {
  const data = check(await requestJson(url(ctx.creds, path, { tokens: ctx.tokens, type, query }), {
    method, body, form, timeoutMs: form ? 300000 : 60000,
  }), path);
  return raw ? data : (data.response ?? data);
}

// Lotes: sucesso HTTP pode esconder falha por modelo/item.
function batchFailures(res) {
  return [...(res.failure_list || []), ...(res.error_list || [])]
    .map((f) => `${f.model_id ? `modelo ${f.model_id}: ` : f.item_id ? `item ${f.item_id}: ` : ''}${f.failed_reason || f.fail_message || f.fail_error || 'falha'}`);
}

// Cache em memória para dados de categoria (mudam pouco).
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}
const H = 3600e3;

module.exports = {
  id: 'shopee',
  name: 'Shopee',
  color: '#EE4D2D',
  textColor: '#FFFFFF',
  docsUrl: 'https://open.shopee.com/developer-guide/211',
  credentialFields: [
    { key: 'partner_id', label: 'Partner ID', type: 'text', required: true, help: 'O Partner ID de teste só funciona no sandbox; o Live, só em produção.' },
    { key: 'partner_key', label: 'Partner Key', type: 'password', required: true },
    { key: 'environment', label: 'Ambiente', type: 'select', options: ['sandbox', 'production'], default: 'sandbox' },
    { key: 'region', label: 'Região da loja', type: 'select', options: ['BR', 'GLOBAL'], default: 'BR', help: 'BR usa os domínios brasileiros (open.shopee.com.br / openplatform.shopee.com.br).' },
    { key: 'api_host', label: 'Host da API (opcional)', type: 'text', help: 'Só para forçar outro domínio indicado pela Shopee.' },
    { key: 'default_category_id', label: 'Categoria padrão (opcional)', type: 'text', help: 'Vazio = recomendação da Shopee pelo título e pela foto de capa.' },
    { key: 'logistic_ids', label: 'Canais logísticos (opcional)', type: 'text', help: 'IDs separados por vírgula. Vazio = todos os canais ativos compatíveis com peso/medidas.' },
    { key: 'default_weight_kg', label: 'Peso padrão (kg)', type: 'text', default: '0.5', help: 'Usado só quando o produto não informa peso.' },
  ],

  authorizeUrl({ creds, redirectUri, state }) {
    const q = new URLSearchParams({
      partner_id: String(creds.partner_id), auth_type: 'seller', redirect_uri: redirectUri, response_type: 'code', state,
    });
    return `${env(creds).auth}?${q}`;
  },

  async handleCallback({ creds, query }) {
    if (!query.code || !(query.shop_id || query.main_account_id)) throw new PlatformError('Autorização Shopee sem code/shop_id');
    const path = '/api/v2/auth/token/get';
    const body = { code: query.code, partner_id: Number(creds.partner_id) };
    if (query.shop_id) body.shop_id = Number(query.shop_id);
    else body.main_account_id = Number(query.main_account_id);
    const data = check(await requestJson(url(creds, path, { type: 'public' }), { method: 'POST', body }), path);
    // Conta principal: o mesmo token vale para todas as lojas autorizadas.
    const shops = query.shop_id ? [String(query.shop_id)] : (data.shop_id_list || []).map(String);
    if (!shops.length) throw new PlatformError('Nenhuma loja autorizada na conta principal da Shopee');
    return { ...toTokens(data, shops[0]), shop_ids: shops };
  },

  async refreshTokens({ creds, tokens }) {
    const path = '/api/v2/auth/access_token/get';
    const data = check(await requestJson(url(creds, path, { type: 'public' }), {
      method: 'POST',
      body: { refresh_token: tokens.refresh_token, shop_id: Number(tokens.shop_id), partner_id: Number(creds.partner_id) },
    }), path);
    return { ...tokens, ...toTokens(data, tokens.shop_id) };
  },

  async test(ctx) {
    const info = await call(ctx, 'GET', '/api/v2/shop/get_shop_info', { raw: true });
    const parts = [`${info.shop_name || 'Loja'} (shop_id ${ctx.tokens.shop_id}, ${info.region || '?'})`];
    if (info.expire_time) parts.push(`autorização até ${new Date(info.expire_time * 1000).toLocaleDateString('pt-BR')}`);
    if (info.is_cb && info.is_upgraded_cbsc) parts.push('loja cross-border CNSC/KRSC: use a API de produto global');
    if ((ctx.tokens.shop_ids || []).length > 1) parts.push(`${ctx.tokens.shop_ids.length} lojas autorizadas; publicando na primeira`);
    return { account: parts.join(' — ') };
  },

  async publish(ctx, p, listing) {
    return listing && listing.external_id ? update(ctx, p, listing) : create(ctx, p);
  },

  preview: (ctx, p) => preview(ctx, p),
};

function toTokens(data, shopId) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    shop_id: String(shopId),
    expires_at: Date.now() + (data.expire_in || 14400) * 1000,
  };
}

// ================================================================ criação
async function create(ctx, p) {
  const warnings = [];
  const prep = await prepare(ctx, p, {}, warnings);
  const variants = p.variants || [];
  const body = {
    ...prep.content,
    category_id: prep.categoryId,
    logistic_info: prep.logistics,
    original_price: price(variants.length ? Math.min(...variants.map((v) => v.price)) : p.price),
    seller_stock: [{ stock: variants.length ? 0 : prep.stock }],
    // Com variações, nasce oculto e só aparece depois que os modelos existirem.
    item_status: p.active && !variants.length ? 'NORMAL' : 'UNLIST',
  };
  if (!variants.length && prep.gtin) body.gtin_code = prep.gtin;
  const res = await call(ctx, 'POST', '/api/v2/product/add_item', { body });
  const itemId = String(res.item_id);
  const meta = { ...prep.meta, category_id: prep.categoryId, content_hash: prep.contentHash, logistics_hash: prep.logisticsHash, unlisted: body.item_status === 'UNLIST' };

  try {
    if (variants.length) {
      await timing.sleep(timing.afterAddItemMs);
      Object.assign(meta, await initVariations(ctx, itemId, p, prep, warnings));
      if (p.active) {
        await setListed(ctx, itemId, true);
        meta.unlisted = false;
      }
    } else {
      meta.price = p.price;
      meta.stock = prep.stock;
    }
    Object.assign(meta, await syncDiscount(ctx, itemId, p, {}, meta, warnings));
  } catch (e) {
    // O item já existe na Shopee: guarda o id para a próxima tentativa
    // continuar dele, em vez de criar um duplicado.
    e.partial = { externalId: itemId, meta };
    throw e;
  }
  return result(itemId, meta, warnings, prep);
}

// ============================================================ atualização
async function update(ctx, p, listing) {
  const warnings = [];
  const prev = listing.meta || {};
  const itemId = String(listing.external_id);
  const prep = await prepare(ctx, p, prev, warnings);
  const meta = { ...prep.meta };
  const variants = p.variants || [];

  // 1) Conteúdo: update_item revalida o anúncio inteiro, então só quando mudou.
  if (prep.contentHash !== prev.content_hash || prep.logisticsHash !== prev.logistics_hash) {
    const body = { item_id: Number(itemId), ...prep.content };
    if (prep.categoryId !== prev.category_id) body.category_id = prep.categoryId;
    if (prep.logisticsHash !== prev.logistics_hash) body.logistic_info = prep.logistics;
    if (!variants.length && prep.gtin) body.gtin_code = prep.gtin;
    await call(ctx, 'POST', '/api/v2/product/update_item', { body });
    Object.assign(meta, { content_hash: prep.contentHash, logistics_hash: prep.logisticsHash, category_id: prep.categoryId });
  }

  // 2) Estrutura de variações, preço e estoque.
  if (variants.length) {
    if (prep.structureKey !== prev.structure_key || !prev.models) {
      try {
        Object.assign(meta, await initVariations(ctx, itemId, p, prep, warnings));
      } catch (e) {
        if (/promotion/i.test(e.message)) warnings.push(`Variações não alteradas: a Shopee bloqueia mudança de estrutura com promoção ativa (${e.message})`);
        else throw e;
      }
    } else {
      Object.assign(meta, await updateModels(ctx, itemId, p, prev, prep, warnings));
    }
  } else if (prev.models) {
    // Deixou de ter variações: volta a item simples (tier_index vazio).
    await call(ctx, 'POST', '/api/v2/product/init_tier_variation', {
      body: { item_id: Number(itemId), tier_variation: [], standardise_tier_variation: [], model: [{ tier_index: [], original_price: price(p.price), seller_stock: [{ stock: prep.stock }] }] },
    });
    Object.assign(meta, { models: null, structure_key: null, price: p.price, stock: prep.stock });
  } else {
    if (p.price !== prev.price) {
      const res = await call(ctx, 'POST', '/api/v2/product/update_price', { body: { item_id: Number(itemId), price_list: [{ model_id: 0, original_price: price(p.price) }] } });
      const fails = batchFailures(res);
      if (fails.length) warnings.push(`Preço não atualizado (promoção ativa?): ${fails.join('; ')}`);
      else meta.price = p.price;
    }
    if (prep.stock !== prev.stock) {
      const res = await call(ctx, 'POST', '/api/v2/product/update_stock', { body: { item_id: Number(itemId), stock_list: [{ model_id: 0, seller_stock: [{ stock: prep.stock }] }] } });
      const fails = batchFailures(res);
      if (fails.length) throw new PlatformError(`Shopee: estoque não atualizado: ${fails.join('; ')}`);
      meta.stock = prep.stock;
    }
  }

  // 3) Ativo/inativo → listar/deslistar (não apaga o anúncio).
  if (!p.active && !prev.unlisted) {
    await setListed(ctx, itemId, false);
    meta.unlisted = true;
    warnings.push('Produto inativo: deslistado na Shopee');
  } else if (p.active && prev.unlisted) {
    await setListed(ctx, itemId, true);
    meta.unlisted = false;
  }

  Object.assign(meta, await syncDiscount(ctx, itemId, p, prev, { ...prev, ...meta }, warnings));
  return result(itemId, meta, warnings, prep);
}

function result(itemId, meta, warnings, prep) {
  const out = { externalId: itemId, meta, warnings };
  // Vídeo ainda transcodificando: volta à fila para anexá-lo depois.
  if (prep.videoPending) out.followUpMs = 2 * 60e3;
  return out;
}

// ========================================================= preparação
// Resolve tudo o que a Shopee exige antes de criar/editar: mídia, categoria,
// limites, atributos, marca, GTIN, logística, tabela de medidas e prazo.
// ctx.dryRun (prévia): nada é enviado — só endpoints de leitura — e os
// problemas vão para ctx.issues em vez de interromper na primeira falha.
async function prepare(ctx, p, prev, warnings) {
  const variants = p.variants || [];
  const meta = {};
  const dry = !!ctx.dryRun;
  const fail = (msg) => {
    if (!dry) throw new PlatformError(`Shopee: ${msg}`);
    ctx.issues.push(msg);
  };
  const attempt = async (fn, fallback) => {
    if (!dry) return fn();
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof PlatformError) || e.retryable) throw e;
      ctx.issues.push(e.message.replace(/^Shopee:\s*/, ''));
      return fallback;
    }
  };

  // Fotos (máx. 10 MB, JPG/PNG). Cache por URL evita reenvio.
  const imageCache = { ...(prev.images || {}) };
  const up = dry ? async (u) => `(foto) ${u}` : async (u) => (imageCache[u] ||= await uploadImage(ctx, u));
  const imageIds = [];
  for (const u of p.images.slice(0, 9)) imageIds.push(await up(u));
  if (p.images.length > 9) warnings.push('Shopee aceita até 9 fotos; as excedentes foram ignoradas');

  // Categoria: produto → padrão do card → recomendação (título + capa).
  const categoryId = Number(prev.category_id || p.categories.shopee || ctx.creds.default_category_id ||
    await attempt(() => recommendCategory(ctx, p, dry ? undefined : imageIds[0]), 0)) || null;
  const limits = categoryId ? await itemLimit(ctx, categoryId) : {};

  // Limites da categoria.
  const nameLim = limits.item_name_length_limit || {};
  const itemName = p.title.slice(0, nameLim.max_limit || 120);
  if (itemName.length < p.title.length) warnings.push(`Título cortado em ${itemName.length} caracteres (limite da Shopee)`);
  if (nameLim.min_limit && itemName.length < nameLim.min_limit) fail(`título precisa de ao menos ${nameLim.min_limit} caracteres`);
  const descLim = limits.item_description_length_limit || {};
  const description = plain(p.description || p.title).slice(0, descLim.max_limit || 3000);
  if (descLim.min_limit && description.length < descLim.min_limit) fail(`descrição precisa de ao menos ${descLim.min_limit} caracteres (tem ${description.length})`);
  const imgLim = limits.item_image_count_limit || {};
  if (imgLim.min_limit && imageIds.length < imgLim.min_limit) fail(`a categoria exige ao menos ${imgLim.min_limit} fotos`);
  const priceLim = limits.price_limit || {};
  for (const v of variants.length ? variants : [p]) {
    if ((priceLim.min_limit && v.price < priceLim.min_limit) || (priceLim.max_limit && v.price > priceLim.max_limit)) {
      fail(`preço ${v.price} fora da faixa permitida [${priceLim.min_limit}, ${priceLim.max_limit}]${v.sku !== p.sku ? ` (variação ${v.sku})` : ''}`);
    }
  }
  const stockMax = (limits.stock_limit || {}).max_limit || Infinity;
  const clampStock = (n) => {
    if (n > stockMax) { warnings.push(`Estoque ${n} acima do limite da Shopee; enviado ${stockMax}`); return stockMax; }
    return n;
  };
  const stock = clampStock(p.active ? p.stock : 0);

  // Peso e medidas.
  const weight = p.weightKg || Number(ctx.creds.default_weight_kg || 0.5);
  if (!p.weightKg) warnings.push(`Produto sem peso: usado o peso padrão de ${weight} kg (afeta o frete)`);
  const hasDims = !!(p.lengthCm && p.widthCm && p.heightCm);
  if (!hasDims && (limits.dimension_limit || {}).dimension_mandatory) {
    fail('a categoria exige dimensões do pacote (lengthCm, widthCm, heightCm)');
  }

  const content = {
    item_name: itemName,
    description,
    weight: Math.round(weight * 1000) / 1000,
    image: { image_id_list: imageIds },
    condition: p.condition === 'used' ? 'USED' : 'NEW', // obrigatório no BR desde 09/2026
    item_sku: p.sku,
    attribute_list: categoryId ? await attempt(() => mapAttributes(ctx, categoryId, p), []) : [],
    brand: categoryId ? await resolveBrand(ctx, categoryId, p.brand, warnings) : { brand_id: 0, original_brand_name: 'NoBrand' },
  };
  if (hasDims) content.dimension = { package_length: Math.ceil(p.lengthCm), package_width: Math.ceil(p.widthCm), package_height: Math.ceil(p.heightCm) };
  if (p.tax) content.tax_info = p.tax;
  const preOrder = await attempt(() => daysToShip(p, limits, warnings), null);
  if (preOrder) content.pre_order = preOrder;

  // Tabela de medidas (roupas, calçados...).
  const sizeChart = await attempt(() => resolveSizeChart(ctx, p, limits, prev, warnings), {});
  if (sizeChart.info) content.size_chart_info = sizeChart.info;
  if (sizeChart.meta) meta.size_chart = sizeChart.meta;

  // Vídeo (MP4 ≤ 30 MB); a transcodificação pode demorar.
  const video = await resolveVideo(ctx, p, prev, warnings);
  if (video.id && video.ready) content.video_upload_id = [video.id];
  if (video.meta !== undefined) meta.video = video.meta;

  // GTIN conforme a regra da categoria (Mandatory / Flexible / Optional).
  const rule = String(((limits.gtin_limit || {}).gtin_validation_rule) || 'Optional').toLowerCase();
  const gtinFor = (code, label) => attempt(() => gtinValue(code, rule, label), null);
  const gtin = variants.length ? null : await gtinFor(p.gtin, 'produto');

  const logistics = await attempt(() => resolveLogistics(ctx, p, weight, hasDims, warnings), []);

  // Variações (validação + estrutura), com imagens do 1º nível.
  let tiers = null;
  if (variants.length) {
    tiers = await attempt(() => buildTiers(ctx, p, categoryId, limits, up, warnings), null);
    for (const m of tiers ? tiers.models : []) {
      m.stock = clampStock(m.variant.stock);
      m.gtin = await gtinFor(m.variant.gtin, `variação ${m.variant.sku}`);
    }
  }
  meta.images = imageCache;

  return {
    content, categoryId, limits, logistics, stock, gtin, tiers, meta,
    // O id do vídeo entra no hash: quando um vídeo pendente fica pronto, o
    // conteúdo "muda" e o update_item o anexa.
    contentHash: sha256(JSON.stringify({ ...content, categoryId })),
    logisticsHash: sha256(JSON.stringify(logistics)),
    structureKey: tiers ? tiers.structureKey : null,
    videoPending: !!video.pending,
    videoNote: video.note || null,
    rule,
  };
}

async function uploadImage(ctx, imageUrl, scene = 'normal') {
  const file = await download(imageUrl, { kind: 'image', maxBytes: IMAGE_MAX });
  if (!/jpe?g|png/i.test(file.contentType) && !/\.(jpe?g|png)$/i.test(file.name)) {
    throw new PlatformError(`Shopee só aceita fotos JPG/PNG: ${imageUrl}`);
  }
  const form = new FormData();
  form.append('image', new Blob([file.buffer], { type: file.contentType }), file.name);
  form.append('scene', scene);
  const res = await call(ctx, 'POST', '/api/v2/media_space/upload_image', { form, type: 'public' });
  const item = res.image_info_list && res.image_info_list[0];
  if (item && item.error) throw new PlatformError(`Shopee recusou a foto ${imageUrl}: ${item.message || item.error}`);
  const id = (res.image_info && res.image_info.image_id) || (item && item.image_info && item.image_info.image_id);
  if (!id) throw new PlatformError(`Shopee não devolveu image_id para ${imageUrl}`);
  return id;
}

async function recommendCategory(ctx, p, coverImageId) {
  const res = await call(ctx, 'GET', '/api/v2/product/category_recommend', {
    query: { item_name: p.title, product_cover_image: coverImageId },
  });
  const id = (res.category_id || [])[0];
  if (!id) throw new PlatformError('Shopee: sem categoria recomendada; informe category_shopee no produto ou uma categoria padrão no card');
  return id;
}

function itemLimit(ctx, categoryId) {
  return cached(`limit:${ctx.tokens.shop_id}:${categoryId}`, 6 * H, async () => {
    const data = await call(ctx, 'GET', '/api/v2/product/get_item_limit', { query: { category_id: categoryId }, raw: true });
    const lim = { ...(data.response || {}) };
    lim.gtin_limit = lim.gtin_limit || data.gtin_limit || null;
    return lim;
  });
}

// ------------------------------------------------------------- atributos
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const nameMatches = (def, key) => {
  const names = [def.name, def.display_attribute_name, ...((def.multi_lang || []).map((m) => m.value))].filter(Boolean);
  return String(def.attribute_id) === String(key) || names.some((n) => norm(n) === norm(key));
};
const valueMatches = (val, raw) => String(val.value_id) === String(raw) ||
  [val.name, val.display_value_name, ...((val.multi_lang || []).map((m) => m.value))].filter(Boolean).some((n) => norm(n) === norm(raw));

function attributeTree(ctx, categoryId) {
  return cached(`attr:${ctx.tokens.shop_id}:${categoryId}`, 6 * H, async () => {
    const res = await call(ctx, 'GET', '/api/v2/product/get_attribute_tree', {
      query: { category_id_list: [categoryId], language: LANG[region(ctx)] },
    });
    const entry = (res.list || []).find((x) => String(x.category_id) === String(categoryId)) || (res.list || [])[0] || {};
    return entry.attribute_tree || [];
  });
}

// Converte os "attributes" do produto (chave = nome ou id do atributo na
// Shopee) para attribute_list, respeitando input_type, unidade e data.
async function mapAttributes(ctx, categoryId, p) {
  const tree = await attributeTree(ctx, categoryId);
  const given = Object.entries(p.attributes || {});
  const out = [];
  const missing = [];
  const visit = (defs) => {
    for (const def of defs) {
      const entry = given.find(([k]) => nameMatches(def, k));
      if (!entry) {
        if (def.mandatory) missing.push(def);
        continue;
      }
      const info = def.attribute_info || {};
      const multi = info.input_type === 4 || info.input_type === 5;
      let raws = [].concat(entry[1]).flatMap((x) => (multi ? String(x).split(/[,;|]/) : [String(x)])).map((x) => x.trim()).filter(Boolean);
      if (!multi && raws.length > 1) raws = raws.slice(0, 1);
      if (multi && info.max_value_count && raws.length > info.max_value_count) {
        throw new PlatformError(`Shopee: o atributo "${def.name}" aceita no máximo ${info.max_value_count} valores`);
      }
      const values = [];
      const children = [];
      for (const raw of raws) {
        const known = (def.attribute_value_list || []).find((v) => valueMatches(v, raw));
        if (known) {
          values.push({ value_id: known.value_id });
          children.push(...(known.child_attribute_list || []));
        } else if ([2, 3, 5].includes(info.input_type)) {
          values.push(customValue(def, raw));
        } else {
          const opts = (def.attribute_value_list || []).slice(0, 15).map((v) => v.name).join(', ');
          throw new PlatformError(`Shopee: valor "${raw}" inválido para "${def.name}". Opções: ${opts}${(def.attribute_value_list || []).length > 15 ? '…' : ''}`);
        }
      }
      if (values.length) out.push({ attribute_id: def.attribute_id, attribute_value_list: values });
      visit(children); // atributos filhos do valor escolhido
    }
  };
  visit(tree);
  if (missing.length) {
    const list = missing.map((d) => {
      const opts = (d.attribute_value_list || []).slice(0, 6).map((v) => v.name).join(' / ');
      return `"${d.name}" (id ${d.attribute_id}${opts ? `: ${opts}${(d.attribute_value_list || []).length > 6 ? '…' : ''}` : ''})`;
    }).join('; ');
    throw new PlatformError(`Shopee: a categoria ${categoryId} exige os atributos ${list}. Envie-os em "attributes" do produto (chave = nome ou id).`);
  }
  return out;
}

// Valor livre: value_id 0 + original_value_name (sempre string), com unidade
// quando o atributo é quantitativo e timestamp quando é data.
function customValue(def, raw) {
  const info = def.attribute_info || {};
  if (info.input_validation_type === 4) {
    const ts = parseDate(raw);
    if (!ts) throw new PlatformError(`Shopee: "${def.name}" espera data (DD/MM/AAAA ou MM/AAAA), recebeu "${raw}"`);
    return { value_id: 0, original_value_name: String(ts) };
  }
  if (info.format_type === 2) {
    const m = String(raw).match(/^\s*([\d.,]+)\s*([^\d\s].*)?$/);
    const units = info.attribute_unit_list || [];
    if (!m) throw new PlatformError(`Shopee: "${def.name}" espera número com unidade (${units.join(', ')}), recebeu "${raw}"`);
    let unit = m[2] ? units.find((u) => norm(u) === norm(m[2])) : null;
    if (!unit && !m[2] && units.length === 1) unit = units[0];
    if (!unit) throw new PlatformError(`Shopee: unidade inválida em "${def.name}" ("${raw}"). Use: ${units.join(', ')}`);
    return { value_id: 0, original_value_name: numberText(m[1], info), value_unit: unit };
  }
  if (info.input_validation_type === 1 || info.input_validation_type === 3) {
    return { value_id: 0, original_value_name: numberText(raw, info, def.name) };
  }
  return { value_id: 0, original_value_name: String(raw) };
}

function numberText(raw, info, name = '') {
  const n = Number(String(raw).replace(/\./g, (d, i, s) => (s.includes(',') ? '' : d)).replace(',', '.'));
  if (!Number.isFinite(n)) throw new PlatformError(`Shopee: "${name}" espera número, recebeu "${raw}"`);
  if (info.input_validation_type === 1 && !Number.isInteger(n)) throw new PlatformError(`Shopee: "${name}" espera número inteiro, recebeu "${raw}"`);
  return String(n);
}

function parseDate(raw) {
  const s = String(raw).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return Math.floor(Date.UTC(+m[3], +m[2] - 1, +m[1]) / 1000);
  m = s.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return Math.floor(Date.UTC(+m[2], +m[1] - 1, 1) / 1000);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

// ----------------------------------------------------------------- marca
async function resolveBrand(ctx, categoryId, brand, warnings) {
  const noBrand = { brand_id: 0, original_brand_name: 'NoBrand' };
  if (!brand) return noBrand;
  const list = await cached(`brand:${ctx.tokens.shop_id}:${categoryId}`, 24 * H, async () => {
    const all = [];
    for (let offset = 0, page = 0; page < 50; page++) {
      const res = await call(ctx, 'GET', '/api/v2/product/get_brand_list', {
        query: { offset, page_size: 100, category_id: categoryId, status: 1, language: region(ctx) === 'BR' ? 'pt-br' : 'en' },
      });
      all.push(...(res.brand_list || []));
      if (!res.has_next_page) break;
      offset = res.next_offset;
    }
    return all;
  });
  const hit = list.find((b) => norm(b.original_brand_name) === norm(brand) || norm(b.display_brand_name) === norm(brand));
  if (hit) return { brand_id: hit.brand_id, original_brand_name: hit.original_brand_name };
  warnings.push(`Marca "${brand}" não está na lista da Shopee para esta categoria: publicado como "Sem marca" (registre a marca na Shopee para usá-la)`);
  return noBrand;
}

// ------------------------------------------------------------------ GTIN
function validGtin(code) {
  if (!/^\d{8,14}$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  // Dígito verificador GS1.
  const digits = code.split('').map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

function gtinValue(raw, rule, label) {
  const code = String(raw || '').replace(/\D/g, '');
  if (code && validGtin(code)) return code;
  if (rule === 'mandatory') throw new PlatformError(`Shopee: a categoria exige GTIN/EAN válido (${label}${raw ? `: "${raw}" inválido` : ''})`);
  if (rule === 'flexible') return '00'; // "00" = item sem GTIN
  return null;
}

// ------------------------------------------------------------- logística
async function resolveLogistics(ctx, p, weight, hasDims, warnings) {
  const channels = await cached(`chan:${ctx.tokens.shop_id}`, H, async () => {
    const res = await call(ctx, 'GET', '/api/v2/logistics/get_channel_list');
    return res.logistics_channel_list || [];
  });
  const wanted = String(ctx.creds.logistic_ids || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
  let list = channels.filter((c) => c.enabled && !c.mask_channel_id);
  if (wanted.length) list = list.filter((c) => wanted.includes(Number(c.logistics_channel_id)));
  const out = [];
  const skipped = [];
  for (const c of list) {
    const name = c.logistics_channel_name || c.logistics_channel_id;
    const wl = c.weight_limit || {};
    if (wl.item_max_weight && weight > wl.item_max_weight) { skipped.push(`${name}: peso acima de ${wl.item_max_weight} kg`); continue; }
    if (wl.item_min_weight && weight < wl.item_min_weight) { skipped.push(`${name}: peso abaixo de ${wl.item_min_weight} kg`); continue; }
    const dl = c.item_max_dimension || {};
    if (hasDims && ((dl.length && p.lengthCm > dl.length) || (dl.width && p.widthCm > dl.width) || (dl.height && p.heightCm > dl.height) ||
      (dl.dimension_sum && p.lengthCm + p.widthCm + p.heightCm > dl.dimension_sum))) {
      skipped.push(`${name}: medidas acima do limite`);
      continue;
    }
    if (c.fee_type === 'SIZE_INPUT' && !hasDims) { skipped.push(`${name}: exige dimensões do pacote`); continue; }
    if (c.fee_type === 'SIZE_SELECTION' || c.fee_type === 'CUSTOM_PRICE') { skipped.push(`${name}: tipo de frete ${c.fee_type} exige configuração manual`); continue; }
    out.push({ logistic_id: Number(c.logistics_channel_id), enabled: true, is_free: false });
  }
  if (!out.length) {
    throw new PlatformError(`Shopee: nenhum canal logístico ativo serve para este produto${skipped.length ? ` (${skipped.join('; ')})` : ''}`);
  }
  if (skipped.length) warnings.push(`Canais não usados: ${skipped.join('; ')}`);
  return out;
}

// ----------------------------------------------------- prazo de postagem
function daysToShip(p, limits, warnings) {
  if (!p.daysToShip) return null;
  const dts = limits.dts_limit || {};
  const standard = dts.non_pre_order_days_to_ship;
  const range = dts.days_to_ship_limit || {};
  if (standard && p.daysToShip <= standard) return null;
  if (!range.min_limit || range.min_limit < 0) {
    warnings.push(`A categoria não aceita pré-venda: prazo de ${p.daysToShip} dias ignorado (padrão ${standard || '?'} dias)`);
    return null;
  }
  if (p.daysToShip < range.min_limit || p.daysToShip > range.max_limit) {
    throw new PlatformError(`Shopee: prazo de postagem ${p.daysToShip} dias fora da faixa de pré-venda [${range.min_limit}, ${range.max_limit}]`);
  }
  return { is_pre_order: true, days_to_ship: p.daysToShip };
}

// ------------------------------------------------------ tabela de medidas
async function resolveSizeChart(ctx, p, limits, prev, warnings) {
  const lim = limits.size_chart_limit || {};
  if (p.sizeChartId && lim.support_template_size_chart !== false) {
    return { info: { size_chart_id: Number(p.sizeChartId) } };
  }
  if (p.sizeChart && lim.support_image_size_chart !== false) {
    const prevChart = prev.size_chart && prev.size_chart.url === p.sizeChart ? prev.size_chart : null;
    const id = prevChart ? prevChart.id : ctx.dryRun ? `(imagem) ${p.sizeChart}` : await uploadImage(ctx, p.sizeChart, 'desc');
    return { info: { size_chart: id }, meta: { url: p.sizeChart, id } };
  }
  if (lim.size_chart_mandatory) {
    throw new PlatformError('Shopee: a categoria exige tabela de medidas (envie "sizeChart" com a URL da imagem ou "sizeChartId" de um modelo da loja)');
  }
  if (p.sizeChart || p.sizeChartId) warnings.push('A categoria não aceita tabela de medidas; ignorada');
  return {};
}

// ----------------------------------------------------------------- vídeo
async function resolveVideo(ctx, p, prev, warnings) {
  const want = p.videos.find((v) => /\.mp4($|\?)/i.test(v)) || null;
  if (!want) {
    if (p.videos.length) warnings.push('Shopee aceita só vídeo MP4 (até 30 MB, 10 a 60 s); vídeo não enviado');
    return { meta: prev.video ? null : undefined };
  }
  if (ctx.dryRun) return { note: `${want} — enviado em partes (MP4 até 30 MB, 10 a 60 s; a Shopee valida duração e resolução)` };
  const old = prev.video && prev.video.url === want ? prev.video : null;
  if (old && !old.pending) return { id: old.id, ready: true, meta: old };
  try {
    let id = old && old.id;
    if (!id) id = await startVideoUpload(ctx, want);
    const status = await waitVideo(ctx, id);
    if (status === 'SUCCEEDED') return { id, ready: true, meta: { url: want, id, pending: false } };
    warnings.push('Vídeo ainda em processamento na Shopee; será anexado na próxima sincronização');
    return { pending: true, meta: { url: want, id, pending: true } };
  } catch (e) {
    warnings.push(`Vídeo não enviado: ${e.message}`);
    return { meta: null };
  }
}

async function startVideoUpload(ctx, videoUrl) {
  const file = await download(videoUrl, { kind: 'video', maxBytes: VIDEO_MAX });
  const started = Date.now();
  const init = await call(ctx, 'POST', '/api/v2/media_space/init_video_upload', {
    body: { file_md5: md5(file.buffer), file_size: file.buffer.length },
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
    await call(ctx, 'POST', '/api/v2/media_space/upload_video_part', { form, type: 'public' });
    parts.push(seq);
  }
  await call(ctx, 'POST', '/api/v2/media_space/complete_video_upload', {
    type: 'public',
    body: { video_upload_id: id, part_seq_list: parts, report_data: { upload_cost: Date.now() - started } },
  });
  return id;
}

async function waitVideo(ctx, id) {
  for (let i = 0; i < timing.videoPolls; i++) {
    const r = await call(ctx, 'GET', '/api/v2/media_space/get_video_upload_result', { query: { video_upload_id: id } });
    if (r.status === 'SUCCEEDED') return r.status;
    if (r.status === 'FAILED' || r.status === 'CANCELLED') throw new PlatformError(`transcodificação falhou: ${r.message || r.status}`);
    await timing.sleep(timing.videoPollMs);
  }
  return 'TRANSCODING';
}

// ------------------------------------------------------------- variações
const SYNONYMS = [
  ['cor', 'color', 'colour', 'cores'],
  ['tamanho', 'size', 'tam', 'numeracao', 'numero', 'medida'],
];
const sameVariation = (a, b) => norm(a) === norm(b) || SYNONYMS.some((g) => g.includes(norm(a)) && g.includes(norm(b)));

function variationTree(ctx, categoryId) {
  return cached(`var:${ctx.tokens.shop_id}:${categoryId}`, 6 * H, async () => {
    // A referência lista o caminho como get_variation_tree, mas os exemplos
    // usam get_variations: tenta os dois.
    for (const path of ['/api/v2/product/get_variation_tree', '/api/v2/product/get_variations']) {
      try {
        const data = await call(ctx, 'GET', path, { query: { category_id: categoryId }, raw: true });
        return ((data.data || data.response || {}).standardise_variation_list) || [];
      } catch (e) {
        if (!/not.?found|404|error_not_found|path/i.test(e.message)) throw e;
      }
    }
    return [];
  });
}

async function buildTiers(ctx, p, categoryId, limits, upload, warnings) {
  const variants = p.variants;
  const keys = Object.keys(variants[0].options);
  if (keys.length > MAX_TIERS) throw new PlatformError(`Shopee aceita no máximo ${MAX_TIERS} níveis de variação (recebido: ${keys.join(', ')})`);
  if (variants.length > MAX_MODELS) throw new PlatformError(`Shopee aceita no máximo ${MAX_MODELS} variações por anúncio (recebido: ${variants.length})`);
  const prices = variants.map((v) => v.price);
  const ratio = PRICE_RATIO[region(ctx)] || 5;
  if (Math.max(...prices) > Math.min(...prices) * ratio) {
    throw new PlatformError(`Shopee: o preço da variação mais cara não pode passar de ${ratio}× o da mais barata (${Math.min(...prices)} → ${Math.max(...prices)})`);
  }
  const nameLim = (limits.tier_variation_name_length_limit || {}).max_limit || 20;
  const optLim = (limits.tier_variation_option_length_limit || {}).max_limit || 30;

  // Opções na ordem em que aparecem (define o tier_index).
  const tiers = keys.map((k) => ({ name: k, options: [] }));
  for (const v of variants) {
    keys.forEach((k, i) => { if (!tiers[i].options.includes(v.options[k])) tiers[i].options.push(v.options[k]); });
  }
  for (const t of tiers) {
    if (t.name.length > nameLim) throw new PlatformError(`Shopee: nome de variação "${t.name}" passa de ${nameLim} caracteres`);
    for (const o of t.options) if (o.length > optLim) throw new PlatformError(`Shopee: opção "${o}" passa de ${optLim} caracteres`);
  }

  // Imagem por opção do 1º nível (ex.: uma foto por cor). Se alguma variação
  // tiver foto, todas as opções do 1º nível precisam ter.
  let optionImages = null;
  if (variants.some((v) => v.images.length)) {
    optionImages = [];
    for (const opt of tiers[0].options) {
      const v = variants.find((x) => x.options[keys[0]] === opt && x.images.length);
      optionImages.push(await upload(v ? v.images[0] : p.images[0]));
    }
  }

  // Estrutura padronizada da Shopee quando todos os nomes casam; senão a
  // estrutura livre (descontinuada, mas ainda documentada nos guias).
  const tree = await variationTree(ctx, categoryId);
  const std = tiers.map((t) => tree.find((sv) => sameVariation(sv.variation_name, t.name)));
  let structure;
  if (std.every(Boolean)) {
    structure = {
      standardise_tier_variation: tiers.map((t, i) => {
        const sv = std[i];
        const opts = (sv.variation_group_list || []).flatMap((g) => (g.variation_option_list || []).map((o) => ({ ...o, group: g.variation_group_id })));
        const list = t.options.map((name, j) => {
          const hit = opts.find((o) => norm(o.variation_option_name) === norm(name));
          const item = hit ? { variation_option_id: hit.variation_option_id, variation_option_name: hit.variation_option_name } : { variation_option_name: name };
          if (i === 0 && optionImages) item.image_id = optionImages[j];
          return { item, group: hit && hit.group };
        });
        const groups = [...new Set(list.map((x) => x.group).filter(Boolean))];
        const tierOut = { variation_id: sv.variation_id, variation_name: sv.variation_name, variation_option_list: list.map((x) => x.item) };
        if (groups.length === 1) tierOut.variation_group_id = groups[0];
        return tierOut;
      }),
    };
  } else {
    warnings.push(`Variação "${tiers.filter((_, i) => !std[i]).map((t) => t.name).join(', ')}" não existe na lista padronizada da Shopee para a categoria: enviada como variação livre (tier_variation, descontinuada)`);
    structure = {
      tier_variation: tiers.map((t, i) => ({
        name: t.name,
        option_list: t.options.map((o, j) => (i === 0 && optionImages ? { option: o, image: { image_id: optionImages[j] } } : { option: o })),
      })),
    };
  }

  const models = variants.map((v) => ({ variant: v, tier_index: keys.map((k, i) => tiers[i].options.indexOf(v.options[k])) }));
  const structureKey = sha256(JSON.stringify({ structure, skus: models.map((m) => [m.variant.sku, m.tier_index]) }));
  return { structure, models, structureKey };
}

async function initVariations(ctx, itemId, p, prep, warnings) {
  const { structure, models } = prep.tiers;
  const body = {
    item_id: Number(itemId),
    ...structure,
    model: models.map((m) => {
      const out = { tier_index: m.tier_index, original_price: price(m.variant.price), model_sku: m.variant.sku, seller_stock: [{ stock: p.active ? m.stock : 0 }] };
      if (m.gtin) out.gtin_code = m.gtin;
      return out;
    }),
  };
  await call(ctx, 'POST', '/api/v2/product/init_tier_variation', { body });
  const list = await call(ctx, 'GET', '/api/v2/product/get_model_list', { query: { item_id: itemId } });
  const byIndex = new Map((list.model || []).map((m) => [JSON.stringify(m.tier_index), m.model_id]));
  const ids = {};
  const prices = {};
  const stocks = {};
  for (const m of models) {
    const id = byIndex.get(JSON.stringify(m.tier_index));
    if (!id) warnings.push(`Shopee não devolveu o modelo da variação ${m.variant.sku}`);
    ids[m.variant.sku] = id;
    prices[m.variant.sku] = m.variant.price;
    stocks[m.variant.sku] = p.active ? m.stock : 0;
  }
  return { models: ids, model_prices: prices, model_stocks: stocks, structure_key: prep.structureKey };
}

async function updateModels(ctx, itemId, p, prev, prep, warnings) {
  const models = prev.models || {};
  const prices = { ...(prev.model_prices || {}) };
  const stocks = { ...(prev.model_stocks || {}) };
  const priceList = [];
  const stockList = [];
  for (const m of prep.tiers.models) {
    const id = models[m.variant.sku];
    if (!id) continue;
    if (m.variant.price !== prices[m.variant.sku]) priceList.push({ model_id: Number(id), original_price: price(m.variant.price), sku: m.variant.sku });
    const stock = p.active ? m.stock : 0;
    if (stock !== stocks[m.variant.sku]) stockList.push({ model_id: Number(id), seller_stock: [{ stock }], sku: m.variant.sku, stock });
  }
  // Até 50 modelos por chamada (o limite de modelos por item também é 50).
  if (priceList.length) {
    const res = await call(ctx, 'POST', '/api/v2/product/update_price', {
      body: { item_id: Number(itemId), price_list: priceList.map(({ sku, ...x }) => x) },
    });
    const failed = new Set((res.failure_list || []).map((f) => String(f.model_id)));
    for (const x of priceList) if (!failed.has(String(x.model_id))) prices[x.sku] = x.original_price;
    const fails = batchFailures(res);
    if (fails.length) warnings.push(`Preço não atualizado (promoção ativa?): ${fails.join('; ')}`);
  }
  if (stockList.length) {
    const res = await call(ctx, 'POST', '/api/v2/product/update_stock', {
      body: { item_id: Number(itemId), stock_list: stockList.map(({ sku, stock, ...x }) => x) },
    });
    const fails = batchFailures(res);
    if (fails.length) throw new PlatformError(`Shopee: estoque não atualizado: ${fails.join('; ')}`);
    for (const x of stockList) stocks[x.sku] = x.stock;
  }
  return { model_prices: prices, model_stocks: stocks };
}

async function setListed(ctx, itemId, listed) {
  const res = await call(ctx, 'POST', '/api/v2/product/unlist_item', { body: { item_list: [{ item_id: Number(itemId), unlist: !listed }] } });
  const fails = batchFailures(res);
  if (fails.length) throw new PlatformError(`Shopee: não foi possível ${listed ? 'listar' : 'deslistar'} o item: ${fails.join('; ')}`);
}

// ------------------------------------------------------------- desconto
async function syncDiscount(ctx, itemId, p, prev, meta, warnings) {
  const now = Math.floor(Date.now() / 1000);
  const old = prev.promo && prev.promo.end > now ? prev.promo : null;
  const variants = p.variants || [];
  const models = meta.models || {};
  const modelList = variants.filter((v) => v.promoPrice && models[v.sku])
    .map((v) => ({ model_id: Number(models[v.sku]), model_promotion_price: price(v.promoPrice) }));
  const has = variants.length ? modelList.length > 0 : !!p.promoPrice;
  const item = { item_id: Number(itemId), purchase_limit: 0 };
  if (variants.length) item.model_list = modelList;
  else if (p.promoPrice) item.item_promotion_price = price(p.promoPrice);

  const remove = async (promo) => {
    const targets = promo.model_ids && promo.model_ids.length ? promo.model_ids : [0];
    for (const modelId of targets) {
      const body = { discount_id: promo.discount_id, item_id: Number(itemId) };
      if (modelId) body.model_id = modelId;
      const res = await call(ctx, 'POST', '/api/v2/discount/delete_discount_item', { body });
      const fails = batchFailures(res);
      if (fails.length) warnings.push(`Desconto não removido: ${fails.join('; ')}`);
    }
  };

  try {
    if (!has) {
      if (old) { await remove(old); return { promo: null }; }
      return {};
    }
    const key = sha256(JSON.stringify(item));
    const sameWindow = old && old.requestedStart === (p.promoStart || null) && old.requestedEnd === (p.promoEnd || null);
    if (sameWindow && old.key === key) return {};
    if (sameWindow) {
      const res = await call(ctx, 'POST', '/api/v2/discount/update_discount_item', { body: { discount_id: old.discount_id, item_list: [item] } });
      const fails = batchFailures(res);
      if (fails.length) throw new PlatformError(fails.join('; '));
      return { promo: { ...old, key, model_ids: modelList.map((m) => m.model_id) } };
    }
    if (old) await remove(old);
    const win = discountWindow(p);
    warnings.push(...win.warnings);
    if (win.error) throw new PlatformError(win.error);
    const { start, end } = win;
    const d = await call(ctx, 'POST', '/api/v2/discount/add_discount', {
      body: { discount_name: `AzureHub ${p.sku}`.slice(0, 50), start_time: start, end_time: end },
    });
    const res = await call(ctx, 'POST', '/api/v2/discount/add_discount_item', { body: { discount_id: d.discount_id, item_list: [item] } });
    const fails = batchFailures(res);
    if (fails.length) throw new PlatformError(fails.join('; '));
    return {
      promo: {
        discount_id: d.discount_id, start, end, key, model_ids: modelList.map((m) => m.model_id),
        requestedStart: p.promoStart || null, requestedEnd: p.promoEnd || null,
      },
    };
  } catch (e) {
    warnings.push(`Desconto não aplicado: ${e.message}`);
    return {};
  }
}

// Início ≥ 1 h no futuro (margem de 5 min); fim ≥ 1 h depois; < 180 dias.
function discountWindow(p, now = Math.floor(Date.now() / 1000)) {
  const warnings = [];
  const minStart = now + 3600 + 300;
  const wanted = p.promoStart ? Math.floor(new Date(p.promoStart) / 1000) : 0;
  const start = Math.max(wanted, minStart);
  if (wanted && wanted < minStart) warnings.push('A Shopee exige que o desconto comece ao menos 1 hora no futuro: início ajustado');
  let end = p.promoEnd ? Math.floor(new Date(p.promoEnd) / 1000) : start + 30 * 86400;
  if (end < start + 3600) return { start, end, warnings, error: 'o fim do desconto precisa ser ao menos 1 hora depois do início' };
  if (end - start >= 180 * 86400) {
    end = start + 179 * 86400;
    warnings.push('A Shopee limita o desconto a menos de 180 dias: fim ajustado');
  }
  return { start, end, warnings, error: null };
}

// =============================================================== prévia
// Mostra como o produto vai subir. Conectado: roda a mesma preparação do
// envio em modo simulação (só endpoints de leitura). Sem conexão: regras
// fixas da Shopee, sem consultar categoria/atributos.
async function preview(ctx, p) {
  const errors = [];
  const warnings = [];
  const variants = p.variants || [];
  const hasPromo = variants.length ? variants.some((v) => v.promoPrice) : !!p.promoPrice;
  const promoValue = variants.length ? [...new Set(variants.filter((v) => v.promoPrice).map((v) => H_.money(v.promoPrice)))].join(' / ') : H_.money(p.promoPrice);
  let promoText = 'Sem promoção';
  if (hasPromo) {
    const win = discountWindow(p);
    warnings.push(...win.warnings);
    if (win.error) errors.push(`Desconto: ${win.error}`);
    promoText = `${promoValue} · ${H_.when(win.start)} → ${H_.when(win.end)}`;
  }
  const videoMp4 = p.videos.find((v) => /\.mp4($|\?)/i.test(v));

  if (!ctx) {
    errors.push(...structuralChecks(p, 'BR'));
    if (p.title.length > 120) warnings.push('Título será cortado em 120 caracteres');
    if (p.images.length > 9) warnings.push('Shopee aceita até 9 fotos; as excedentes serão ignoradas');
    if (p.videos.length && !videoMp4) warnings.push('Shopee aceita só vídeo MP4');
    if (!p.weightKg) warnings.push('Produto sem peso: será usado o peso padrão do card');
    if (p.gtin && !H_.validGtin(p.gtin)) warnings.push(`GTIN "${p.gtin}" com dígito verificador inválido`);
    warnings.push('Conta Shopee não conectada: categoria, atributos obrigatórios, marca, GTIN e frete serão validados no envio');
    return {
      online: false, errors, warnings,
      fields: [
        H_.field('Título', p.title.slice(0, 120)),
        H_.field('Categoria', p.categories.shopee || 'recomendada pela Shopee no envio'),
        H_.field('Marca', p.brand || 'Sem marca'),
        H_.field('Condição', p.condition === 'used' ? 'Usado' : 'Novo'),
        H_.field('Preço', H_.priceRange(p)),
        H_.field('Promoção', promoText),
        H_.field('Estoque', p.active ? p.stock : '0 — inativo: anúncio deslistado'),
        H_.field('Peso / medidas', `${p.weightKg || '—'} kg · ${p.lengthCm && p.widthCm && p.heightCm ? `${p.lengthCm}×${p.widthCm}×${p.heightCm} cm` : 'sem dimensões'}`),
        H_.field('Fotos', `${Math.min(9, p.images.length)} de ${p.images.length}`),
        H_.field('Vídeo', videoMp4 || 'Sem vídeo'),
        H_.field('Descrição', H_.excerpt(plain(p.description || p.title)), 'enviada como texto, sem HTML'),
      ],
      variants: variants.length ? H_.variantRows(p) : null,
    };
  }

  const dctx = { ...ctx, dryRun: true, issues: errors };
  const prep = await prepare(dctx, p, {}, warnings);
  const c = prep.content;
  const tree = prep.categoryId ? await attributeTree(ctx, prep.categoryId) : [];
  const defs = new Map();
  const walk = (list) => list.forEach((d) => {
    defs.set(d.attribute_id, d);
    (d.attribute_value_list || []).forEach((v) => walk(v.child_attribute_list || []));
  });
  walk(tree);
  const attrText = c.attribute_list.map((a) => {
    const d = defs.get(a.attribute_id) || { name: a.attribute_id, attribute_value_list: [] };
    const isDate = (d.attribute_info || {}).input_validation_type === 4;
    const vals = a.attribute_value_list.map((v) => (v.value_id
      ? ((d.attribute_value_list || []).find((x) => x.value_id === v.value_id) || {}).name || v.value_id
      : isDate ? new Date(Number(v.original_value_name) * 1000).toLocaleDateString('pt-BR', { timeZone: 'UTC' })
        : `${v.original_value_name}${v.value_unit ? ` ${v.value_unit}` : ''}`));
    return `${d.name}: ${vals.join(', ')}`;
  }).join('; ');
  const channels = await cached(`chan:${ctx.tokens.shop_id}`, H, async () => (await call(ctx, 'GET', '/api/v2/logistics/get_channel_list')).logistics_channel_list || []);
  const channelNames = prep.logistics.map((l) => (channels.find((ch) => Number(ch.logistics_channel_id) === l.logistic_id) || {}).logistics_channel_name || l.logistic_id);
  const sc = c.size_chart_info;
  const structure = prep.tiers && prep.tiers.structure;
  return {
    online: true, errors, warnings,
    fields: [
      H_.field('Título', c.item_name),
      H_.field('Categoria', prep.categoryId, p.categories.shopee || ctx.creds.default_category_id ? null : 'recomendada pela Shopee'),
      H_.field('Marca', c.brand.brand_id ? `${c.brand.original_brand_name} (id ${c.brand.brand_id})` : 'Sem marca'),
      H_.field('Condição', c.condition === 'USED' ? 'Usado' : 'Novo'),
      H_.field('Preço', H_.priceRange(p)),
      H_.field('Promoção', promoText),
      H_.field('Estoque', p.active ? (prep.tiers ? prep.tiers.models.reduce((n, m) => n + m.stock, 0) : prep.stock) : '0 — inativo: anúncio deslistado'),
      H_.field('Peso / medidas', `${c.weight} kg · ${c.dimension ? `${c.dimension.package_length}×${c.dimension.package_width}×${c.dimension.package_height} cm` : 'sem dimensões'}`),
      H_.field('Fotos', `${c.image.image_id_list.length} de ${p.images.length}`),
      H_.field('Vídeo', prep.videoNote || 'Sem vídeo'),
      H_.field('Descrição', H_.excerpt(c.description), `${c.description.length} caracteres, texto sem HTML`),
      H_.field('Atributos', attrText || 'nenhum'),
      H_.field('GTIN', variants.length ? 'por variação' : (prep.gtin || 'não enviado'), `regra da categoria: ${prep.rule}`),
      H_.field('Prazo de postagem', c.pre_order ? `${c.pre_order.days_to_ship} dias (pré-venda)` : 'padrão da categoria'),
      H_.field('Tabela de medidas', sc ? (sc.size_chart_id ? `modelo ${sc.size_chart_id}` : 'imagem') : '—'),
      H_.field('Frete', channelNames.join(', ') || 'nenhum canal'),
      H_.field('Fiscal', c.tax_info ? Object.entries(c.tax_info).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(' · ') : '—'),
    ],
    variants: prep.tiers ? prep.tiers.models.map((m) => ({
      sku: m.variant.sku, options: H_.optionsLabel(m.variant.options), price: H_.money(m.variant.price),
      promoPrice: m.variant.promoPrice ? H_.money(m.variant.promoPrice) : '—', stock: p.active ? m.stock : 0, gtin: m.gtin || '—',
    })) : (variants.length ? H_.variantRows(p) : null),
    variantStructure: structure ? (structure.standardise_tier_variation ? 'padronizada da Shopee' : 'livre (tier_variation)') : null,
  };
}

// Regras de variação que não dependem da conta (usadas na prévia offline).
function structuralChecks(p, reg) {
  const out = [];
  const variants = p.variants || [];
  if (!variants.length) return out;
  const keys = Object.keys(variants[0].options);
  if (keys.length > MAX_TIERS) out.push(`Shopee aceita no máximo ${MAX_TIERS} níveis de variação (${keys.join(', ')})`);
  if (variants.length > MAX_MODELS) out.push(`Shopee aceita no máximo ${MAX_MODELS} variações (${variants.length})`);
  const prices = variants.map((v) => v.price);
  const ratio = PRICE_RATIO[reg] || 5;
  if (Math.max(...prices) > Math.min(...prices) * ratio) out.push(`a variação mais cara não pode passar de ${ratio}× a mais barata`);
  return out;
}

// ------------------------------------------------------------------ apoio
// BR/SG/MY/MX/PL aceitam 2 casas decimais.
const price = (v) => Math.round(Number(v) * 100) / 100;

function plain(html) {
  return String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports._internal = { sign, url, timing, cache, validGtin, gtinValue, customValue, parseDate, sameVariation, discountWindow };
