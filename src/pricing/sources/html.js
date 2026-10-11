'use strict';
// Páginas HTML: extrai ofertas dos dados estruturados que as lojas publicam
// para buscadores — JSON-LD schema.org (Product, Offer, AggregateOffer,
// ItemList) e metatags de preço (product:price:amount, og:price:amount,
// itemprop="price"). Não depende do layout da página.
const { politeGet, PriceSourceError } = require('../http');
const { parsePrice } = require('../match');

function jsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { out.push(JSON.parse(m[1].trim())); } catch { /* bloco inválido: ignora */ }
  }
  return out;
}

const typeOf = (n) => [].concat(n && n['@type'] ? n['@type'] : []).map(String);

function* walk(node) {
  if (Array.isArray(node)) { for (const x of node) yield* walk(x); return; }
  if (!node || typeof node !== 'object') return;
  yield node;
  for (const k of ['@graph', 'itemListElement', 'item', 'mainEntity', 'hasVariant']) if (node[k]) yield* walk(node[k]);
}

// Menor preço disponível em reais. Aceita Offer, lista de Offers,
// AggregateOffer (lowPrice ou offers internas) e priceSpecification (ignora
// o preço "de": ListPrice/StrikethroughPrice).
function offerPrice(offers) {
  const prices = [];
  const visit = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 4) return;
    if (Array.isArray(o)) { o.forEach((x) => visit(x, depth + 1)); return; }
    if (/OutOfStock|Discontinued|SoldOut/i.test(String(o.availability || ''))) return;
    const specs = [].concat(o.priceSpecification || []).filter((x) => x && typeof x === 'object' && !/ListPrice|Strikethrough|MSRP/i.test(String(x.priceType || '')));
    const cur = String(o.priceCurrency || (specs[0] && specs[0].priceCurrency) || '').toUpperCase();
    if (cur && cur !== 'BRL') return;
    const p = parsePrice(o.price ?? o.lowPrice ?? (specs[0] && specs[0].price));
    if (p) prices.push(p);
    else if (o.offers) visit(o.offers, depth + 1);
  };
  visit(offers);
  return prices.length ? Math.min(...prices) : null;
}

function extract(html, pageUrl) {
  const offers = [];
  const seen = new Set();
  for (const block of jsonLdBlocks(html)) {
    for (const n of walk(block)) {
      if (!typeOf(n).some((t) => /Product/i.test(t))) continue;
      const price = offerPrice(n.offers);
      if (!price) continue;
      const url = n.url || (n.offers && !Array.isArray(n.offers) && n.offers.url) || pageUrl;
      const key = `${n.name}|${price}|${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let abs = pageUrl;
      try { abs = new URL(String(url), pageUrl).href; } catch { /* URL inválida no JSON-LD: usa a da página */ }
      offers.push({
        title: String(n.name || '').trim(), price, url: /^https?:/i.test(abs) ? abs : pageUrl,
        // Sem URL própria (ex.: vários produtos numa página de busca): a URL é a da página.
        pageUrlOnly: abs === pageUrl || !/^https?:/i.test(abs),
        gtin: String(n.gtin13 || n.gtin || n.gtin14 || n.gtin12 || n.gtin8 || '').replace(/\D/g, '') || null,
        brand: n.brand ? (typeof n.brand === 'string' ? n.brand : n.brand.name) : null,
        condition: /UsedCondition|Refurbished/i.test(JSON.stringify(n.offers || {})) ? 'used' : 'new',
      });
    }
  }
  if (!offers.length) {
    // Página de produto sem JSON-LD: metatags.
    const meta = (prop) => {
      const m = html.match(new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name|itemprop)=["']${prop}["']`, 'i'));
      return m ? m[1] : null;
    };
    const price = parsePrice(meta('product:price:amount') || meta('og:price:amount') || meta('price'));
    const title = meta('og:title') || ((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').trim();
    if (price) offers.push({ title, price, url: pageUrl, gtin: null, brand: null, condition: 'new' });
  }
  return offers;
}

async function fetchPage(url, src) {
  const html = await politeGet(url, { as: 'text', respectRobots: src.respect_robots !== false, minIntervalMs: Number(src.interval_ms || 2000), cacheHours: src.cache_hours ?? 12 });
  return extract(html, url);
}

module.exports = {
  type: 'html',
  label: 'Site (dados estruturados da página)',
  description: 'Qualquer loja que publique schema.org (JSON-LD) ou metatags de preço na página de busca ou de produto.',
  fields: [
    { key: 'search_url', label: 'URL de busca', type: 'text', required: true, placeholder: 'https://www.loja.com.br/busca?q={query}', help: '{query} é trocado pelo texto de busca; {gtin} pelo código de barras.' },
  ],
  async search(src, q) {
    if (!/\{query\}|\{gtin\}/.test(src.search_url || '')) throw new PriceSourceError('a URL de busca precisa conter {query} ou {gtin}');
    if (/\{gtin\}/.test(src.search_url) && !q.gtin) return [];
    const url = src.search_url.replace('{query}', encodeURIComponent(q.text)).replace('{gtin}', encodeURIComponent(q.gtin || ''));
    return fetchPage(url, src);
  },
  fetchPage,
  extract,
};
