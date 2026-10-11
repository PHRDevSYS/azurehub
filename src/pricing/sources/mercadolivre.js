'use strict';
// Mercado Livre pela API oficial, com a conta conectada no card do destino.
// A busca pública (/sites/MLB/search) responde 403 sem token. Caminho
// principal: catálogo (/products/search por GTIN ou texto) e as ofertas de
// cada produto de catálogo (/products/{id}/items); em seguida, a busca de
// anúncios com token. VALIDAR COM A CONTA: o ML restringe esses endpoints
// por aplicativo.
const { requestJson } = require('../../lib/media');
const { PriceSourceError } = require('../http');

const API = 'https://api.mercadolibre.com';
const itemUrl = (id) => `https://produto.mercadolivre.com.br/${String(id).replace(/^([A-Z]+)(\d+)$/, '$1-$2')}`;

module.exports = {
  type: 'mercadolivre',
  label: 'Mercado Livre (API oficial)',
  description: 'Ofertas do catálogo do Mercado Livre. Usa a conta conectada no destino Mercado Livre.',
  fields: [],
  needsPlatform: 'mercadolivre',
  async search(src, q, ctx) {
    const ml = ctx ? await ctx.platform('mercadolivre') : null;
    if (!ml) throw new PriceSourceError('conecte a conta do Mercado Livre em Integração para usar esta fonte');
    const auth = { Authorization: `Bearer ${ml.tokens.access_token}` };
    const site = ml.creds.site_id || 'MLB';
    const get = (path) => requestJson(`${API}${path}`, { headers: auth });
    const out = [];
    try {
      const qs = q.gtin ? `product_identifier=${encodeURIComponent(q.gtin)}` : `q=${encodeURIComponent(q.text)}`;
      const found = await get(`/products/search?status=active&site_id=${site}&${qs}&limit=5`);
      for (const prod of (found.results || []).slice(0, 3)) {
        const items = await get(`/products/${prod.id}/items?limit=10`);
        for (const it of items.results || []) {
          if (!it.price) continue;
          out.push({ title: prod.name, price: Number(it.price), url: itemUrl(it.item_id), gtin: q.gtin || null, brand: null, condition: it.condition || 'new', seller: it.seller_id || null });
        }
      }
    } catch (e) {
      if (e.status !== 403 && e.status !== 404) throw e;
    }
    if (!out.length && !q.gtin) {
      const res = await get(`/sites/${site}/search?q=${encodeURIComponent(q.text)}&limit=20`).catch((e) => {
        throw new PriceSourceError(`busca do Mercado Livre indisponível para este aplicativo (${e.message})`);
      });
      for (const r of res.results || []) out.push({ title: r.title, price: Number(r.price), url: r.permalink, gtin: null, brand: null, condition: r.condition || 'new' });
    }
    return out;
  },
};
