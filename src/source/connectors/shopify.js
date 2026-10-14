'use strict';
// Shopify Admin GraphQL API (shopify.dev/docs/api/admin-graphql), versão
// estável 2026-10. Token de app personalizado no header X-Shopify-Access-Token.
// Campos atuais: descriptionHtml, media (images/featuredImage/bodyHtml são
// descontinuados), ProductVariant.barcodes (barcode descontinuado),
// variant.media (image descontinuado), inventoryItem.measurement.weight.
// Custo máximo por consulta: 1000 pontos — por isso 2 produtos por página e
// variações paginadas à parte quando passam de 30.
const { requestJson, PlatformError } = require('../../lib/media');
const { timing, toKg } = require('../http');

// Estoque não rastreado na Shopify = venda sem limite: vai com um saldo alto, não 0.
const UNTRACKED_STOCK = 999;
const stockOf = (v) => (v.inventoryItem && v.inventoryItem.tracked === false ? UNTRACKED_STOCK : Math.max(0, v.inventoryQuantity || 0));

const VARIANT_FIELDS = `
  sku price compareAtPrice inventoryQuantity
  selectedOptions { name value }
  barcodes(first: 1) { nodes { value } }
  media(first: 1) { nodes { ... on MediaImage { image { url } } } }
  inventoryItem { tracked measurement { weight { unit value } } }`;

const PRODUCTS_QUERY = `query Produtos($cursor: String, $query: String) {
  products(first: 2, after: $cursor, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title handle descriptionHtml vendor status productType updatedAt
      options(first: 3) { name }
      media(first: 15) { nodes {
        mediaContentType
        ... on MediaImage { image { url } }
        ... on Video { sources { url mimeType } }
        ... on ExternalVideo { originUrl }
      } }
      variants(first: 30) { pageInfo { hasNextPage endCursor } nodes { ${VARIANT_FIELDS} } }
    }
  }
}`;

const VARIANTS_QUERY = `query Variacoes($id: ID!, $cursor: String) {
  product(id: $id) { variants(first: 50, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { ${VARIANT_FIELDS} } } }
}`;

function endpoint(cfg) {
  const shop = String(cfg.shop || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/\.myshopify\.com$/i.test(shop)) throw new Error('Informe o domínio da loja no formato minhaloja.myshopify.com');
  return `https://${shop}/admin/api/${cfg.api_version || '2026-10'}/graphql.json`;
}

async function gql(cfg, query, variables, attempt = 1) {
  const res = await requestJson(endpoint(cfg), {
    method: 'POST', headers: { 'X-Shopify-Access-Token': cfg.access_token }, body: { query, variables },
  });
  const err = (res.errors || [])[0];
  if (err) {
    const ext = err.extensions || {};
    // Limite de custo: espera o balde recompor e tenta de novo.
    if (ext.code === 'THROTTLED' && attempt < 6) {
      const t = ((res.extensions || {}).cost || {}).throttleStatus || {};
      const need = ((res.extensions || {}).cost || {}).requestedQueryCost || 700;
      const wait = Math.max(1, Math.ceil((need - (t.currentlyAvailable || 0)) / (t.restoreRate || 100)));
      await timing.sleep(wait * 1000);
      return gql(cfg, query, variables, attempt + 1);
    }
    throw new PlatformError(`Shopify: ${err.message}`);
  }
  return res.data;
}

const numericId = (gid) => String(gid).split('/').pop();

function priceOf(v) {
  const price = Number(v.price);
  const compare = v.compareAtPrice !== null && v.compareAtPrice !== undefined ? Number(v.compareAtPrice) : null;
  // Na Shopify, compareAtPrice é o preço "de" e price o "por".
  return compare && compare > price ? { price: compare, promoPrice: price } : { price, promoPrice: null };
}

function weightOf(v) {
  const w = v.inventoryItem && v.inventoryItem.measurement && v.inventoryItem.measurement.weight;
  return w ? toKg(w.value, w.unit) : null;
}

function mapProduct(p, variants) {
  const media = (p.media && p.media.nodes) || [];
  const images = media.filter((m) => m.image && m.image.url).map((m) => m.image.url);
  const videos = [];
  for (const m of media) {
    if (m.mediaContentType === 'VIDEO' && (m.sources || []).length) {
      const mp4 = m.sources.filter((s) => /mp4/i.test(s.mimeType || s.url));
      videos.push((mp4[mp4.length - 1] || m.sources[0]).url);
    } else if (m.mediaContentType === 'EXTERNAL_VIDEO' && m.originUrl) {
      videos.push(m.originUrl);
    }
  }
  // Produto sem variações reais tem uma variante única ("Default Title").
  const simple = variants.length === 1 && (variants[0].selectedOptions || []).every((o) => o.name === 'Title');
  const first = variants[0] || {};
  const out = {
    sourceRef: `shopify:${numericId(p.id)}`,
    title: p.title,
    description: p.descriptionHtml || '',
    brand: p.vendor || null,
    images,
    videos,
    active: p.status === 'ACTIVE',
  };
  if (simple) {
    Object.assign(out, priceOf(first), {
      sku: first.sku || `SHOPIFY-${numericId(p.id)}`,
      stock: stockOf(first),
      gtin: ((first.barcodes || {}).nodes || [])[0] ? first.barcodes.nodes[0].value : null,
      weightKg: weightOf(first),
    });
  } else {
    Object.assign(out, {
      sku: `SHOPIFY-${numericId(p.id)}`,
      weightKg: weightOf(first),
      variants: variants.map((v) => ({
        sku: v.sku || `SHOPIFY-${numericId(p.id)}-${(v.selectedOptions || []).map((o) => o.value).join('-')}`,
        options: Object.fromEntries((v.selectedOptions || []).map((o) => [o.name, o.value])),
        ...priceOf(v),
        stock: stockOf(v),
        gtin: ((v.barcodes || {}).nodes || [])[0] ? v.barcodes.nodes[0].value : null,
        images: ((v.media || {}).nodes || []).filter((m) => m.image).map((m) => m.image.url).slice(0, 1),
      })),
    });
  }
  return out;
}

module.exports = {
  id: 'shopify',
  name: 'Shopify',
  kind: 'Site/loja',
  description: 'Loja Shopify, pela Admin GraphQL API (token de app personalizado).',
  docsUrl: 'https://shopify.dev/docs/api/admin-graphql',
  fields: [
    { key: 'shop', label: 'Domínio da loja', type: 'text', placeholder: 'minhaloja.myshopify.com', required: true },
    { key: 'access_token', label: 'Token da Admin API (shpat_...)', type: 'password', required: true, help: 'Admin › Configurações › Apps › Desenvolver apps › criar app com escopo read_products e read_inventory.' },
    { key: 'api_version', label: 'Versão da API', type: 'text', default: '2026-10', help: 'A Shopify mantém cada versão por 12 meses; atualize a cada trimestre.' },
    { key: 'only_active', label: 'Só produtos ativos', type: 'checkbox', default: true },
  ],

  async test(cfg) {
    const data = await gql(cfg, PRODUCTS_QUERY, { cursor: null, query: cfg.only_active === false ? null : 'status:active' });
    const nodes = data.products.nodes;
    return { ok: true, count: null, sample: nodes.map((p) => mapProduct(p, p.variants.nodes)) };
  },

  async fetchProducts(cfg) {
    const out = [];
    let cursor = null;
    for (let page = 0; page < 5000; page++) {
      const data = await gql(cfg, PRODUCTS_QUERY, { cursor, query: cfg.only_active === false ? null : 'status:active' });
      for (const p of data.products.nodes) {
        const variants = [...p.variants.nodes];
        let vInfo = p.variants.pageInfo;
        while (vInfo.hasNextPage) {
          const more = await gql(cfg, VARIANTS_QUERY, { id: p.id, cursor: vInfo.endCursor });
          variants.push(...more.product.variants.nodes);
          vInfo = more.product.variants.pageInfo;
        }
        out.push(mapProduct(p, variants));
      }
      if (!data.products.pageInfo.hasNextPage) break;
      cursor = data.products.pageInfo.endCursor;
    }
    return out;
  },
};

module.exports._internal = { mapProduct, PRODUCTS_QUERY };
