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
// - Variações = várias SKUs com sales_attributes (até 3 tipos; nome até 20 e
//   valor até 50 caracteres; 300 SKUs no BR/EU/JP/MX/UK/US, 100 nos demais).
//   Foto por valor de UM só tipo (aqui, o 1º: ex. uma foto por cor), enviada
//   com use_case ATTRIBUTE_IMAGE. Em Edit/Partial Edit, SKU omitida é APAGADA
//   e SKU sem id é criada; preço e estoque omitidos ficam como estão.
const { requestJson, download, PlatformError } = require('../lib/media');
const { hmacHex, sha256 } = require('../lib/crypto');
const H_ = require('./preview-helpers');

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
    const prev = (listing && listing.meta) || {};
    if ((p.variants || []).length) return productId ? updateVariants(ctx, p, listing) : createVariants(ctx, p);
    if (productId && prev.variant_mode) {
      // A TikTok não deixa apagar todos os atributos de venda de um produto.
      throw new PlatformError('TikTok Shop: o produto foi publicado com variações e agora chegou sem elas; ' +
        'a TikTok não permite remover todas as variações. Pare de sincronizar e envie de novo para criar outro anúncio.');
    }
    return productId ? update(ctx, p, listing) : create(ctx, p);
  },

  preview: (ctx, p) => preview(ctx, p),
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

// ============================================================== variações
// Uma SKU por variação. A doc só aceita estoque por SKU em [1, 99.999]:
// - na criação, variações sem estoque ficam de fora (entram quando houver);
// - variação que zera depois: tenta estoque 0; se a TikTok recusar, a SKU é
//   removida por edição parcial e volta quando houver estoque.
const BIG_SKU_REGIONS = new Set(['BR', 'MX', 'US', 'GB', 'UK', 'JP', 'DE', 'ES', 'FR', 'IT', 'IE', 'PL', 'NL', 'BE', 'CZ', 'AT', 'GR', 'PT', 'HU']);
const maxSkus = (ctx) => (BIG_SKU_REGIONS.has(region(ctx)) ? 300 : 100);
const variantQty = (p, v) => (p.active && v.active !== false ? Math.min(99999, Math.max(0, v.stock)) : 0);

// Nomes equivalentes de atributo de venda (o da origem × o da categoria TikTok).
const SALES_SYNONYMS = [
  ['cor', 'cores', 'color', 'colour', 'colors'], ['tamanho', 'tamanhos', 'tam', 'size', 'sizes', 'numeracao', 'numero'],
  ['voltagem', 'tensao', 'voltage'], ['sabor', 'flavor', 'flavour'], ['estampa', 'pattern', 'print'], ['material', 'materials'],
];
const sameName = (a, b) => norm(a) === norm(b) || SALES_SYNONYMS.some((g) => g.includes(norm(a)) && g.includes(norm(b)));

// Eixos de variação: atributo de venda padrão da categoria quando existe
// (id; valor por value_id ou value_name), senão atributo personalizado (name).
async function salesAxes(ctx, categoryId, p, warnings) {
  const keys = Object.keys(p.variants[0].options);
  if (keys.length > 3) throw new PlatformError(`TikTok aceita no máximo 3 tipos de variação (recebido: ${keys.join(', ')})`);
  const defs = categoryId ? await salesProperties(ctx, String(categoryId)) : [];
  return keys.map((key) => {
    const values = [...new Set(p.variants.map((v) => v.options[key]))];
    for (const val of values) if (val.length > 50) throw new PlatformError(`TikTok: valor de variação "${val}" passa de 50 caracteres`);
    let def = defs.find((d) => sameName(d.name, key)) || null;
    // Atributo padrão que não aceita valor livre e não tem algum dos valores: o eixo todo vira personalizado.
    if (def && def.is_customizable === false && (def.values || []).length
      && values.some((val) => !def.values.some((x) => norm(x.name) === norm(val)))) {
      warnings.push(`TikTok: "${key}" tem valores fora da lista da categoria; enviado como variação personalizada`);
      def = null;
    }
    if (!def && key.length > 20) throw new PlatformError(`TikTok: nome de variação "${key}" passa de 20 caracteres`);
    return { key, def };
  });
}

// Ids já existentes no produto (Get Product): atributos e valores criados antes.
function idLookup(skus) {
  const names = [];
  const values = new Map();
  for (const s of skus || []) {
    for (const a of s.sales_attributes || []) {
      if (!names.some((n) => n.id === String(a.id))) names.push({ id: String(a.id), name: a.name });
      if (a.value_id) values.set(`${a.id}|${norm(a.value_name)}`, String(a.value_id));
    }
  }
  return { names, values };
}

function salesAttr(axis, value, lookup) {
  const attrId = axis.def ? String(axis.def.id) : ((lookup.names.find((n) => sameName(n.name, axis.key)) || {}).id || null);
  if (attrId) {
    const known = lookup.values.get(`${attrId}|${norm(value)}`);
    if (known) return { id: attrId, value_id: known };
    const builtIn = axis.def && (axis.def.values || []).find((x) => norm(x.name) === norm(value));
    return builtIn ? { id: attrId, value_id: String(builtIn.id) } : { id: attrId, value_name: value };
  }
  return { name: axis.key, value_name: value };
}

// Foto por valor do 1º eixo (ex.: uma por cor). A doc exige foto para TODOS
// os valores do eixo escolhido: sem foto própria, usa a 1ª foto do produto.
async function attributeImages(ctx, p, axis, prev) {
  if (!p.variants.some((v) => v.images.length)) return null;
  const out = {};
  for (const value of [...new Set(p.variants.map((v) => v.options[axis.key]))]) {
    const v = p.variants.find((x) => x.options[axis.key] === value && x.images.length);
    const url = v ? v.images[0] : p.images[0];
    const old = (prev || {})[value];
    out[value] = old && old.url === url ? old : { url, uri: await uploadImage(ctx, url, 'ATTRIBUTE_IMAGE') };
  }
  return out;
}

function skuBase(v, axes, images, lookup) {
  return {
    seller_sku: sellerSku(v.sku),
    external_sku_id: v.sku,
    sales_attributes: axes.map((axis, i) => {
      const a = salesAttr(axis, v.options[axis.key], lookup);
      if (i === 0 && images) a.sku_img = { uri: images[v.options[axis.key]].uri };
      return a;
    }),
  };
}

// GTIN por SKU: precisa ser único entre as SKUs do produto.
function identifiersFor(variants, warnings) {
  const seen = new Set();
  const out = {};
  for (const v of variants) {
    const id = identifierCode(v.gtin);
    if (!id) {
      if (v.gtin) warnings.push(`GTIN "${v.gtin}" da variação ${v.sku} com formato inválido; não enviado`);
      continue;
    }
    if (seen.has(id.code)) { warnings.push(`GTIN ${id.code} repetido na variação ${v.sku}; não enviado (a TikTok exige GTIN único por SKU)`); continue; }
    seen.add(id.code);
    out[v.sku] = id;
  }
  return out;
}

const structureKey = (axes, images, skus) => sha256(JSON.stringify({
  axes: axes.map((a) => [a.key, a.def ? String(a.def.id) : null]),
  images: images ? Object.entries(images).map(([k, x]) => [k, x.url]) : null,
  skus: skus.map((s) => [s.external_sku_id, s.sales_attributes.map((a) => [a.id || a.name, a.value_id || a.value_name])]),
}));

// external_sku_id → id da SKU na TikTok, a partir de uma resposta (create/edit/get).
function skuIdMap(skus, variants) {
  const out = {};
  for (const s of skus || []) {
    const v = variants.find((x) => x.sku === s.external_sku_id) || variants.find((x) => sellerSku(x.sku) === s.seller_sku);
    if (v && s.id) out[v.sku] = String(s.id);
  }
  return out;
}

async function createVariants(ctx, p) {
  const warnings = [];
  if (p.variants.length > maxSkus(ctx)) throw new PlatformError(`TikTok aceita no máximo ${maxSkus(ctx)} variações (SKUs) por produto nesta região (recebido: ${p.variants.length})`);
  const sellable = p.variants.filter((v) => variantQty(p, v) > 0);
  if (!sellable.length) {
    return { externalId: null, meta: { skipped: true }, warnings: ['TikTok Shop: nenhuma variação com estoque — o produto será criado quando houver estoque'] };
  }
  const left = p.variants.filter((v) => !sellable.includes(v));
  if (left.length) warnings.push(`Variações sem estoque ficam fora do anúncio até haver estoque: ${left.map((v) => v.sku).join(', ')}`);

  const media = await uploadMedia(ctx, p, {}, warnings);
  const warehouseId = ctx.creds.warehouse_id || await defaultWarehouse(ctx);
  const categoryId = String(p.categories.tiktok || ctx.creds.default_category_id || await recommendCategory(ctx, p, media.mainImages));
  const attributes = await productAttributes(ctx, categoryId, p);
  const axes = await salesAxes(ctx, categoryId, p, warnings);
  const images = await attributeImages(ctx, p, axes[0], {});
  const ids = identifiersFor(sellable, warnings);
  const lookup = idLookup([]);
  const skus = sellable.map((v) => {
    const s = { ...skuBase(v, axes, images, lookup), price: price(ctx, v.price), inventory: [{ warehouse_id: warehouseId, quantity: variantQty(p, v) }] };
    if (ids[v.sku]) s.identifier_code = ids[v.sku];
    return s;
  });

  const content = contentFields(ctx, p, media, attributes);
  const body = {
    ...content,
    category_id: categoryId,
    skus,
    external_product_id: p.sku,
    idempotency_key: `azh-${sha256(`${p.sku}|${JSON.stringify(content)}|${JSON.stringify(skus)}`)}`.slice(0, 128),
  };
  if (categoryVersion(ctx) === 'v2') body.category_version = 'v2';
  const res = await call(ctx, 'POST', '/product/202309/products', { body });
  const productId = String(res.product_id);
  const skuIds = skuIdMap(res.skus, p.variants);
  const meta = {
    ...media.meta, warehouse_id: warehouseId, category_id: categoryId, variant_mode: true,
    skus: skuIds, prices: Object.fromEntries(sellable.map((v) => [v.sku, v.price])),
    quantities: Object.fromEntries(sellable.map((v) => [v.sku, variantQty(p, v)])),
    attr_images: images, structure_hash: structureKey(axes, images, skus), content_hash: contentHash(content),
    deactivated: false, skipped: false,
  };
  await syncVariantPromotion(ctx, productId, p, skuIds, {}, meta, warnings);
  return { externalId: productId, meta, warnings };
}

async function updateVariants(ctx, p, listing) {
  const warnings = [];
  const prev = listing.meta || {};
  const productId = String(listing.external_id);
  const meta = { variant_mode: true };
  if (p.variants.length > maxSkus(ctx)) throw new PlatformError(`TikTok aceita no máximo ${maxSkus(ctx)} variações (SKUs) por produto nesta região (recebido: ${p.variants.length})`);

  // 1) Nenhuma variação com estoque (ou produto inativo) → desativa.
  if (!p.variants.some((v) => variantQty(p, v) > 0)) {
    if (!prev.deactivated) {
      await deactivate(ctx, productId);
      meta.deactivated = true;
      warnings.push('Nenhuma variação com estoque (ou produto inativo): desativado no TikTok Shop');
    }
    return { externalId: productId, meta, warnings };
  }

  const warehouseId = prev.warehouse_id || ctx.creds.warehouse_id || await defaultWarehouse(ctx);
  const categoryId = String(prev.category_id || p.categories.tiktok || ctx.creds.default_category_id || '');
  meta.warehouse_id = warehouseId;
  const media = await uploadMedia(ctx, p, prev, warnings);
  Object.assign(meta, media.meta);
  const attributes = categoryId ? await productAttributes(ctx, categoryId, p) : null;
  const content = contentFields(ctx, p, media, attributes);
  const contentChanged = contentHash(content) !== prev.content_hash;
  const axes = await salesAxes(ctx, categoryId, p, warnings);
  const images = await attributeImages(ctx, p, axes[0], prev.attr_images);
  meta.attr_images = images;

  let skuIds = { ...(prev.skus || {}) };
  const prices = { ...(prev.prices || {}) };
  const quantities = { ...(prev.quantities || {}) };
  let zeroOk = prev.zero_ok;

  // No anúncio ficam as variações com estoque e as SKUs já criadas que podem ficar com 0.
  const wanted = (existing) => p.variants.filter((v) => variantQty(p, v) > 0 || (existing[v.sku] && zeroOk !== false));
  const planKey = () => structureKey(axes, images, wanted(skuIds).map((v) => skuBase(v, axes, images, idLookup([]))));

  // Edição parcial com a lista COMPLETA de SKUs (omitida = apagada; sem id = criada).
  const editStructure = async (withContent) => {
    const current = await call(ctx, 'GET', `/product/202309/products/${productId}`);
    const lookup = idLookup(current.skus);
    const existing = skuIdMap(current.skus, p.variants);
    const byId = new Map((current.skus || []).map((x) => [String(x.id), x]));
    const list = wanted(existing);
    const fresh = list.filter((v) => !existing[v.sku]);
    const gtins = identifiersFor(fresh, warnings);
    const skus = list.map((v) => {
      const out = skuBase(v, axes, images, lookup);
      if (existing[v.sku]) {
        out.id = existing[v.sku];
        // identifier_code só muda em rascunho: devolve o que já está no produto.
        const cur = byId.get(existing[v.sku]);
        if (cur && cur.identifier_code && cur.identifier_code.code) out.identifier_code = { code: cur.identifier_code.code, type: cur.identifier_code.type };
      } else {
        out.price = price(ctx, v.price);
        out.inventory = [{ warehouse_id: warehouseId, quantity: variantQty(p, v) }];
        if (gtins[v.sku]) out.identifier_code = gtins[v.sku];
      }
      return out;
    });
    const res = await call(ctx, 'POST', `/product/202509/products/${productId}/partial_edit`, { body: { ...(withContent ? content : {}), skus } });
    const ids = { ...existing, ...skuIdMap(res.skus, p.variants) };
    skuIds = Object.fromEntries(list.filter((v) => ids[v.sku]).map((v) => [v.sku, ids[v.sku]]));
    for (const v of fresh) { prices[v.sku] = v.price; quantities[v.sku] = variantQty(p, v); }
    for (const sku of Object.keys(quantities)) if (!skuIds[sku]) { delete quantities[sku]; delete prices[sku]; }
    const removed = Object.keys(existing).filter((sku) => !skuIds[sku]);
    if (fresh.length) warnings.push(`Variações incluídas no anúncio: ${fresh.map((v) => v.sku).join(', ')}`);
    if (removed.length) warnings.push(`Variações retiradas do anúncio (sem estoque ou removidas na origem): ${removed.join(', ')}`);
  };

  // 2) Estrutura (SKUs, opções, fotos por valor) e conteúdo: dispara auditoria.
  const structureChanged = planKey() !== prev.structure_hash;
  if (structureChanged) await editStructure(contentChanged);
  else if (contentChanged) await call(ctx, 'POST', `/product/202509/products/${productId}/partial_edit`, { body: content });
  if (structureChanged || contentChanged) {
    meta.content_hash = contentHash(content);
    warnings.push('Variações/conteúdo alterados: o TikTok Shop reenvia o produto para auditoria');
  }

  // 3) Preço e estoque por SKU (publicação imediata, sem auditoria).
  const priceChanges = p.variants.filter((v) => skuIds[v.sku] && prices[v.sku] !== v.price);
  if (priceChanges.length) {
    try {
      await call(ctx, 'POST', `/product/202309/products/${productId}/prices/update`, {
        body: { skus: priceChanges.map((v) => ({ id: skuIds[v.sku], price: price(ctx, v.price) })) },
      });
      for (const v of priceChanges) prices[v.sku] = v.price;
    } catch (e) {
      warnings.push(`Preço não atualizado (há promoção ativa?): ${e.message}`);
    }
  }
  const stockChanges = p.variants.filter((v) => skuIds[v.sku] && quantities[v.sku] !== variantQty(p, v));
  if (stockChanges.length) {
    const zeros = new Set(stockChanges.filter((v) => variantQty(p, v) === 0).map((v) => v.sku));
    let failed = [];
    try {
      const res = await call(ctx, 'POST', `/product/202309/products/${productId}/inventory/update`, {
        body: { skus: stockChanges.map((v) => ({ id: skuIds[v.sku], inventory: [{ warehouse_id: warehouseId, quantity: variantQty(p, v) }] })) },
      });
      // code 0 pode vir com falha por SKU em data.errors.
      const bad = new Set((res.errors || []).map((x) => String((x.detail || {}).sku_id)));
      failed = stockChanges.filter((v) => bad.has(skuIds[v.sku])).map((v) => v.sku);
    } catch (e) {
      if (!zeros.size) throw e;
      failed = stockChanges.map((v) => v.sku);
    }
    for (const v of stockChanges) if (!failed.includes(v.sku)) quantities[v.sku] = variantQty(p, v);
    if (zeros.size && ![...zeros].some((sku) => failed.includes(sku))) zeroOk = true;
    if ([...zeros].some((sku) => failed.includes(sku))) {
      // A TikTok recusou estoque 0: tira essas SKUs do anúncio (voltam quando houver estoque).
      zeroOk = false;
      await editStructure(false);
      warnings.push('A TikTok não aceitou estoque 0 por SKU: variações esgotadas saem do anúncio (o produto vai para auditoria)');
    }
    const others = failed.filter((sku) => !zeros.has(sku));
    if (others.length) warnings.push(`Estoque não atualizado: ${others.join(', ')}`);
  }
  Object.assign(meta, { zero_ok: zeroOk, skus: skuIds, prices, quantities, structure_hash: planKey() });

  if (prev.deactivated) {
    await activate(ctx, productId);
    meta.deactivated = false;
    warnings.push('Produto reativado: o TikTok Shop reenvia para auditoria');
  }
  await syncVariantPromotion(ctx, productId, p, skuIds, prev, meta, warnings);
  return { externalId: productId, meta, warnings };
}

// Promoção por SKU (product_level VARIATION): só as variações com preço
// promocional entram; a janela é a do produto.
async function syncVariantPromotion(ctx, productId, p, skuIds, prev, meta, warnings) {
  const now = Math.floor(Date.now() / 1000);
  const old = prev.promo && prev.promo.end > now ? prev.promo : null;
  const promo = p.variants.filter((v) => v.promoPrice && skuIds[v.sku]).map((v) => ({ sku: v.sku, id: skuIds[v.sku], price: v.promoPrice }));
  try {
    if (!promo.length) {
      if (old) {
        await call(ctx, 'DELETE', `/promotion/202309/activities/${old.activity_id}/products`, { body: { product_ids: [productId] } });
        meta.promo = null;
      }
      return;
    }
    const key = JSON.stringify(promo.map((x) => [x.id, x.price]));
    const sameWindow = old && old.level === 'VARIATION' && old.requestedStart === (p.promoStart || null) && old.requestedEnd === (p.promoEnd || null);
    if (sameWindow && old.key === key) return;

    let activityId = sameWindow ? old.activity_id : null;
    let begin = sameWindow ? old.start : null;
    let end = sameWindow ? old.end : null;
    if (!activityId) {
      if (old) {
        await call(ctx, 'DELETE', `/promotion/202309/activities/${old.activity_id}/products`, { body: { product_ids: [productId] } })
          .catch((e) => warnings.push(`Promoção anterior não removida: ${e.message}`));
      }
      const win = promotionWindow(p, now);
      if (win.error) throw new PlatformError(win.error);
      ({ begin, end } = win);
      const a = await call(ctx, 'POST', '/promotion/202309/activities', {
        body: { title: `AzureHub ${p.sku} ${begin}`.slice(0, 100), activity_type: 'FIXED_PRICE', product_level: 'VARIATION', begin_time: begin, end_time: end },
      });
      activityId = a.activity_id;
    } else {
      // Mesma atividade: tira as SKUs que deixaram de ter promoção.
      const gone = Object.keys(old.skus || {}).filter((id) => !promo.some((x) => x.id === id));
      if (gone.length) await call(ctx, 'DELETE', `/promotion/202309/activities/${activityId}/products`, { body: { sku_ids: gone } });
    }
    await call(ctx, 'PUT', `/promotion/202309/activities/${activityId}/products`, {
      body: {
        activity_id: activityId,
        products: [{
          id: productId, quantity_limit: -1, quantity_per_user: -1,
          skus: promo.map((x) => ({ id: x.id, activity_price_amount: money(x.price), quantity_limit: -1, quantity_per_user: -1 })),
        }],
      },
    });
    meta.promo = {
      activity_id: activityId, level: 'VARIATION', key, start: begin, end, skus: Object.fromEntries(promo.map((x) => [x.id, x.price])),
      requestedStart: p.promoStart || null, requestedEnd: p.promoEnd || null,
    };
  } catch (e) {
    warnings.push(`Promoção não aplicada: ${e.message}`);
  }
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

async function uploadImage(ctx, url, useCase = 'MAIN_IMAGE') {
  const file = await download(url, { kind: 'image', maxBytes: IMAGE_MAX });
  const form = new FormData();
  form.append('data', new Blob([file.buffer], { type: file.contentType }), file.name);
  form.append('use_case', useCase);
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
  const all = res.attributes || [];
  attrCache.set(key, { at: Date.now(), list: all.filter((a) => a.type === 'PRODUCT_PROPERTY'), sales: all.filter((a) => a.type === 'SALES_PROPERTY') });
  return attrCache.get(key).list;
}

// Atributos de venda (SALES_PROPERTY) da categoria: Cor, Tamanho...
async function salesProperties(ctx, categoryId) {
  await categoryAttributes(ctx, categoryId);
  return attrCache.get(`${ctx.tokens.shop_cipher}:${categoryId}`).sales;
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
      const win = promotionWindow(p, now);
      if (win.error) throw new PlatformError(win.error);
      ({ begin, end } = win);
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

// Início precisa ser no futuro; fim, ao menos 10 min depois do início.
function promotionWindow(p, now = Math.floor(Date.now() / 1000)) {
  const begin = Math.max(p.promoStart ? Math.floor(new Date(p.promoStart) / 1000) : 0, now + 120);
  const end = p.promoEnd ? Math.floor(new Date(p.promoEnd) / 1000) : begin + 30 * 86400;
  return { begin, end, error: end < begin + 600 ? 'fim da promoção precisa ser ao menos 10 minutos depois do início' : null };
}

// ---------------------------------------------------------------- prévia
// Conectado: recomenda categoria, confere atributos obrigatórios e armazém
// (endpoints de leitura). Fotos e vídeo não são enviados na prévia.
const VIDEO_EXT = /\.(mp4|mov|mkv|wmv|webm|avi|3gp|flv|mpeg)($|\?)/i;

async function preview(ctx, p) {
  const errors = [];
  const warnings = [];
  const attempt = async (fn, fallback) => {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof PlatformError) || e.retryable) throw e;
      errors.push(e.message.replace(/^TikTok( Shop)?:\s*/, ''));
      return fallback;
    }
  };
  const variants = p.variants || [];
  const qty = variants.length ? variants.reduce((n, v) => n + variantQty(p, v), 0) : stockQty(p);
  if (!qty) warnings.push('Sem estoque ou inativo: a TikTok exige ao menos 1 unidade — o produto será criado quando houver estoque (ou desativado, se já existir)');
  if (variants.length) {
    const maxV = ctx ? maxSkus(ctx) : 300;
    if (variants.length > maxV) errors.push(`TikTok aceita no máximo ${maxV} variações (SKUs) por produto nesta região (recebido: ${variants.length})`);
    const empty = variants.filter((v) => !variantQty(p, v));
    if (empty.length && qty) warnings.push(`Variações sem estoque ficam fora do anúncio até haver estoque: ${empty.map((v) => v.sku).join(', ')}`);
    const dup = identifiersFor(variants, []);
    const gtinCount = variants.filter((v) => identifierCode(v.gtin)).length;
    if (Object.keys(dup).length < gtinCount) warnings.push('Há GTIN repetido entre variações: a TikTok exige GTIN único por SKU (os repetidos não serão enviados)');
  }
  if (p.images.length > 9) warnings.push('TikTok aceita até 9 fotos principais; as excedentes serão ignoradas');
  const video = p.videos[0] || null;
  if (video && !VIDEO_EXT.test(video)) warnings.push('Vídeo em formato não aceito pela TikTok (MP4, MOV, MKV, WMV, WEBM, AVI, 3GP, FLV, MPEG)');
  const identifier = identifierCode(p.gtin);
  if (!variants.length && p.gtin && !identifier) warnings.push(`GTIN/EAN "${p.gtin}" com formato inválido (8, 12, 13 ou 14 dígitos): não será enviado`);
  if (!variants.length && p.gtin && identifier && !H_.validGtin(p.gtin)) warnings.push(`GTIN "${p.gtin}" com dígito verificador inválido`);
  let promoText = 'Sem promoção';
  if (p.promoPrice) {
    const win = promotionWindow(p);
    if (win.error) errors.push(`Promoção: ${win.error}`);
    promoText = `${H_.money(p.promoPrice)} · ${H_.when(win.begin)} → ${H_.when(win.end)} (campanha de preço fixo)`;
  }

  const media = { mainImages: p.images.slice(0, 9).map((u) => ({ uri: `(foto) ${u}` })), videoId: video ? '(vídeo)' : null };
  let categoryId = p.categories.tiktok || (ctx && ctx.creds.default_category_id) || null;
  let attributes = null;
  let warehouse = ctx && ctx.creds.warehouse_id;
  let attrText = null;
  let structure = null;
  if (variants.length) {
    const keys = Object.keys(variants[0].options);
    if (keys.length > 3) errors.push(`TikTok aceita no máximo 3 tipos de variação (recebido: ${keys.join(', ')})`);
    for (const k of keys) if (k.length > 20) warnings.push(`Nome de variação "${k}" passa de 20 caracteres: só serve se casar com um atributo padrão da categoria`);
    for (const v of variants) for (const val of Object.values(v.options)) if (val.length > 50) errors.push(`Valor de variação "${val}" passa de 50 caracteres`);
  }
  if (ctx) {
    if (!categoryId) categoryId = await attempt(() => recommendCategory(ctx, p, []), null);
    if (categoryId) {
      attributes = await attempt(() => productAttributes(ctx, String(categoryId), p), null);
      const defs = await categoryAttributes(ctx, String(categoryId));
      attrText = (attributes || []).map((a) => {
        const d = defs.find((x) => String(x.id) === a.id) || { name: a.id, values: [] };
        return `${d.name}: ${a.values.map((v) => v.name || ((d.values || []).find((x) => String(x.id) === v.id) || {}).name || v.id).join(', ')}`;
      }).join('; ');
    }
    if (!warehouse) warehouse = await attempt(() => defaultWarehouse(ctx), null);
    if (variants.length && categoryId) {
      const axes = await attempt(() => salesAxes(ctx, String(categoryId), p, warnings), null);
      if (axes) {
        structure = axes.map((a) => `${a.key} (${a.def ? `padrão da TikTok: ${a.def.name}` : 'personalizado'})`).join(' · ');
      }
    }
  } else {
    warnings.push('Conta TikTok Shop não conectada: categoria, atributos obrigatórios e armazém serão validados no envio');
  }
  const content = contentFields(ctx || { tokens: {}, creds: {} }, p, media, attributes);
  return {
    online: !!ctx, errors, warnings,
    fields: [
      H_.field('Título', content.title),
      H_.field('Categoria', categoryId || (ctx ? '—' : 'recomendada pela TikTok no envio'), ctx && !p.categories.tiktok && !ctx.creds.default_category_id && categoryId ? 'recomendada pela TikTok' : null),
      H_.field('Preço', variants.length ? H_.priceRange(p) : H_.money(p.price), variants.length ? 'por variação' : null),
      H_.field('Promoção', promoText),
      H_.field('Estoque', qty || '0 — não criado/desativado', warehouse ? `armazém ${warehouse}` : null),
      H_.field('SKU do vendedor', variants.length ? `${variants.length} SKU(s), um por variação` : sellerSku(p.sku)),
      H_.field('GTIN', variants.length ? 'por variação' : (identifier ? `${identifier.code} (${identifier.type})` : 'não enviado'), 'só na criação (a TikTok não permite alterar depois)'),
      ...(variants.length ? [H_.field('Variações', structure || (ctx ? '—' : 'atributos de venda definidos no envio'),
        variants.some((v) => v.images.length) ? `foto por ${Object.keys(variants[0].options)[0]} (uma por valor)` : 'sem foto por variação')] : []),
      H_.field('Peso / medidas', `${content.package_weight.value} kg · ${content.package_dimensions ? `${content.package_dimensions.length}×${content.package_dimensions.width}×${content.package_dimensions.height} cm` : 'sem dimensões'}`),
      H_.field('Fotos', `${media.mainImages.length} de ${p.images.length}`),
      H_.field('Vídeo', video || 'Sem vídeo', video ? 'até 100 MB, proporção 9:16 a 16:9' : null),
      H_.field('Descrição', H_.excerpt(content.description.replace(/<[^>]+>/g, ' ')), `${content.description.length} caracteres, em HTML`),
      H_.field('Atributos', attrText === null ? (ctx ? '—' : 'validados no envio') : (attrText || 'nenhum')),
    ],
    variants: variants.length ? H_.variantRows(p, (v) => ({ stock: variantQty(p, v) })) : null,
    variantStructure: variants.length ? (structure || 'SKUs com atributos de venda') : null,
  };
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

module.exports._internal = { sign, videoName, identifierCode, weight, attrCache, sameName, idLookup, salesAttr };
