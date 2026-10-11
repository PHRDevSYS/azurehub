'use strict';
// APIs públicas de vitrine (as mesmas que o site da loja usa no navegador,
// sem autenticação):
// - VTEX: /api/catalog_system/pub/products/search (Search API, security: none);
//   EAN por fq=alternateIds_Ean:{ean}; preço em commertialOffer.Price.
// - Shopify: /search/suggest.json (Ajax API, predictive search) — a busca
//   cobre título, SKU e código de barras das variantes.
// - WooCommerce: Store API /wp-json/wc/store/v1/products?search= — preços
//   em unidade mínima (centavos) com currency_minor_unit.
const { politeGet } = require('../http');
const { parsePrice } = require('../match');

const baseUrl = (src) => String(src.base_url || '').trim().replace(/\/+$/, '');
const opts = (src) => ({ respectRobots: src.respect_robots !== false, minIntervalMs: Number(src.interval_ms || 1500), cacheHours: src.cache_hours ?? 12 });
const BASE_FIELD = (ph) => ({ key: 'base_url', label: 'Endereço da loja', type: 'text', required: true, placeholder: ph });

const vtex = {
  type: 'vtex',
  label: 'Loja VTEX (API pública de busca)',
  description: 'Lojas na plataforma VTEX: busca por texto e por EAN.',
  fields: [BASE_FIELD('https://www.loja.com.br')],
  async search(src, q) {
    const qs = q.gtin ? `fq=alternateIds_Ean:${encodeURIComponent(q.gtin)}` : `ft=${encodeURIComponent(q.text)}`;
    const list = await politeGet(`${baseUrl(src)}/api/catalog_system/pub/products/search?${qs}&_from=0&_to=19`, opts(src));
    const out = [];
    for (const p of Array.isArray(list) ? list : []) {
      let best = null;
      let ean = null;
      for (const it of p.items || []) {
        for (const s of it.sellers || []) {
          const o = s.commertialOffer || {};
          if (!(o.AvailableQuantity > 0)) continue;
          const price = parsePrice(o.Price);
          if (price && (!best || price < best)) { best = price; ean = it.ean || ean; }
        }
      }
      if (best) out.push({ title: p.productName, price: best, url: p.link, gtin: ean || null, brand: p.brand || null, condition: 'new' });
    }
    return out;
  },
};

const shopify = {
  type: 'shopify',
  label: 'Loja Shopify (busca pública)',
  description: 'Lojas Shopify: busca preditiva (título, SKU e código de barras).',
  fields: [BASE_FIELD('https://www.loja.com.br')],
  async search(src, q) {
    const base = baseUrl(src);
    const term = q.gtin || q.text;
    const data = await politeGet(`${base}/search/suggest.json?q=${encodeURIComponent(term)}&resources[type]=product&resources[limit]=10&resources[options][unavailable_products]=hide`, opts(src));
    const products = (((data || {}).resources || {}).results || {}).products || [];
    return products.filter((p) => p.available !== false).map((p) => ({
      title: p.title, price: parsePrice(p.price), url: p.url ? new URL(p.url, base).href : base, gtin: null, brand: p.vendor || null, condition: 'new',
    })).filter((o) => o.price);
  },
};

const woocommerce = {
  type: 'woocommerce',
  label: 'Loja WooCommerce (Store API pública)',
  description: 'Lojas WordPress + WooCommerce: Store API, sem autenticação.',
  fields: [BASE_FIELD('https://www.loja.com.br')],
  async search(src, q) {
    const list = await politeGet(`${baseUrl(src)}/wp-json/wc/store/v1/products?search=${encodeURIComponent(q.text)}&per_page=20`, opts(src));
    // Só em estoque e em reais (lojas multimoeda informam currency_code).
    return (Array.isArray(list) ? list : []).filter((p) => p.is_in_stock !== false && (!p.prices || !p.prices.currency_code || p.prices.currency_code === 'BRL')).map((p) => {
      const pr = p.prices || {};
      const unit = 10 ** Number(pr.currency_minor_unit ?? 2);
      const price = pr.price ? Math.round((Number(pr.price) / unit) * 100) / 100 : null;
      return { title: p.name, price, url: p.permalink, gtin: null, brand: null, condition: 'new' };
    }).filter((o) => o.price);
  },
};

module.exports = { vtex, shopify, woocommerce };
