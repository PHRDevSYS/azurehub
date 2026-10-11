'use strict';
// WooCommerce REST API v3 (woocommerce.github.io/woocommerce-rest-api-docs).
// Autenticação: chave/segredo de consumidor por HTTP Basic sobre HTTPS.
// Paginação: per_page até 100 + cabeçalho X-WP-TotalPages. Produto
// "variable" tem as variações em /products/{id}/variations.
const { fetchWithHeaders, toKg, toCm } = require('../http');

const MAX_PAGES = 500;

function base(cfg) {
  const url = String(cfg.url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) throw new Error('Informe a URL do site (https://...)');
  return `${url}/wp-json/wc/v3`;
}

function headers(cfg) {
  return { Authorization: `Basic ${Buffer.from(`${cfg.consumer_key}:${cfg.consumer_secret}`).toString('base64')}` };
}

async function* pages(cfg, path, params = {}) {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const q = new URLSearchParams({ per_page: '100', page: String(page), ...params });
    const { data, headers: h } = await fetchWithHeaders(`${base(cfg)}${path}?${q}`, { headers: headers(cfg) });
    yield data || [];
    const total = Number(h.get('x-wp-totalpages') || 1);
    if (page >= total || !(data || []).length) return;
  }
}

function stockOf(item, cfg) {
  if (item.manage_stock === true || (item.manage_stock === 'parent' && item.stock_quantity !== null)) {
    return Math.max(0, Number(item.stock_quantity) || 0);
  }
  // Loja sem controle de estoque: "em estoque" usa a quantidade padrão configurada.
  return item.stock_status === 'instock' || item.stock_status === 'onbackorder' ? Number(cfg.unmanaged_stock || 0) : 0;
}

function promo(item) {
  const sale = item.sale_price !== '' && item.sale_price !== null && item.sale_price !== undefined ? item.sale_price : null;
  return { promoPrice: sale, promoStart: item.date_on_sale_from_gmt || item.date_on_sale_from || null, promoEnd: item.date_on_sale_to_gmt || item.date_on_sale_to || null };
}

function mapProduct(p, variations, cfg) {
  const wu = cfg.weight_unit || 'kg';
  const du = cfg.dimension_unit || 'cm';
  const d = p.dimensions || {};
  const attributes = {};
  for (const a of p.attributes || []) if (!a.variation && (a.options || []).length) attributes[a.name] = a.options.join(', ');
  const out = {
    sourceRef: `woocommerce:${p.id}`,
    sku: p.sku || `WOO-${p.id}`,
    title: p.name,
    description: p.description || p.short_description || '',
    brand: (p.brands || [])[0] ? p.brands[0].name : null,
    gtin: p.global_unique_id || null,
    price: p.regular_price || p.price,
    ...promo(p),
    stock: stockOf(p, cfg),
    weightKg: toKg(p.weight, wu),
    lengthCm: toCm(d.length, du), widthCm: toCm(d.width, du), heightCm: toCm(d.height, du),
    images: (p.images || []).map((i) => i.src),
    attributes,
    active: p.status === 'publish',
  };
  if (p.type === 'variable') {
    out.variants = variations.map((v) => ({
      sku: v.sku || `WOO-${p.id}-${v.id}`,
      options: Object.fromEntries((v.attributes || []).map((a) => [a.name, a.option])),
      price: v.regular_price || v.price,
      promoPrice: promo(v).promoPrice,
      stock: stockOf(v, cfg),
      gtin: v.global_unique_id || null,
      images: v.image && v.image.src ? [v.image.src] : [],
      active: v.status === undefined || v.status === 'publish',
    }));
  }
  return out;
}

module.exports = {
  id: 'woocommerce',
  name: 'WooCommerce',
  kind: 'Site/loja',
  description: 'Loja WordPress + WooCommerce, pela REST API v3 (chave e segredo de consumidor).',
  docsUrl: 'https://woocommerce.github.io/woocommerce-rest-api-docs/',
  fields: [
    { key: 'url', label: 'URL do site', type: 'text', placeholder: 'https://minhaloja.com.br', required: true },
    { key: 'consumer_key', label: 'Chave do consumidor (ck_...)', type: 'text', required: true, help: 'WooCommerce › Configurações › Avançado › REST API › Adicionar chave (permissão Leitura).' },
    { key: 'consumer_secret', label: 'Segredo do consumidor (cs_...)', type: 'password', required: true },
    { key: 'only_published', label: 'Só produtos publicados', type: 'checkbox', default: true },
    { key: 'weight_unit', label: 'Unidade de peso da loja', type: 'select', options: [['kg', 'kg'], ['g', 'g'], ['lbs', 'lbs'], ['oz', 'oz']], default: 'kg' },
    { key: 'dimension_unit', label: 'Unidade de medida da loja', type: 'select', options: [['cm', 'cm'], ['m', 'm'], ['mm', 'mm'], ['in', 'pol']], default: 'cm' },
    { key: 'unmanaged_stock', label: 'Estoque para produtos sem controle de estoque', type: 'text', default: '0', help: 'Quantidade enviada quando o produto está "em estoque" mas a loja não controla quantidade.' },
  ],

  async test(cfg) {
    const { data, headers: h } = await fetchWithHeaders(`${base(cfg)}/products?per_page=3`, { headers: headers(cfg) });
    return { ok: true, count: Number(h.get('x-wp-total') || (data || []).length), sample: (data || []).map((p) => mapProduct(p, [], cfg)) };
  },

  async fetchProducts(cfg) {
    const out = [];
    const params = cfg.only_published === false ? {} : { status: 'publish' };
    for await (const list of pages(cfg, '/products', params)) {
      for (const p of list) {
        if (p.type === 'grouped' || p.type === 'external') continue; // sem estoque próprio
        const variations = [];
        if (p.type === 'variable') {
          for await (const vs of pages(cfg, `/products/${p.id}/variations`)) variations.push(...vs);
        }
        out.push(mapProduct(p, variations, cfg));
      }
    }
    return out;
  },
};

module.exports._internal = { mapProduct };
