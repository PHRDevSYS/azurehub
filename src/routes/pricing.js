'use strict';
// Rotas do módulo de Precificação.
const store = require('../lib/store');
const { HttpError, readJson } = require('../lib/http');
const pricing = require('../pricing');
const research = require('../pricing/research');

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);

function wrap(fn) {
  return async (ctx) => {
    try {
      return await fn(ctx);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, e.message);
    }
  };
}

function row(prod, res, pr, cfg) {
  const p = prod.data;
  const ev = pricing.evaluate(p, res, pr, cfg);
  return {
    sku: p.sku, title: p.title, brand: p.brand, variants: (p.variants || []).length, active: p.active,
    ...ev,
    collectedAt: res ? res.collectedAt : null,
    offers: res ? res.offers.filter((o) => o.accepted).length : 0,
    sourcesFailed: res ? res.sources.filter((s) => !s.ok).map((s) => `${s.name}: ${s.error}`) : [],
    watch: pr ? pr.watch.length : 0,
  };
}

function register(r, { requireAdmin }) {
  r.get('/api/modules', requireAdmin, async () => ({ pricing: pricing.getSettings().enabled }));

  r.get('/api/pricing/settings', requireAdmin, async () => ({
    settings: pricing.getSettings(),
    sourceTypes: Object.values(research.SOURCES).map((s) => ({
      type: s.type, label: s.label, description: s.description, fields: s.fields, needsPlatform: s.needsPlatform || null,
    })),
  }));

  r.put('/api/pricing/settings', requireAdmin, wrap(async (ctx) => {
    const res = pricing.saveSettings(await readJson(ctx.req));
    store.log('info', `Precificação: configurações salvas (módulo ${res.settings.enabled ? 'ativo' : 'inativo'})`);
    return res;
  }));

  // Grade comparativa. Sem skus: os 200 produtos mais recentes.
  r.get('/api/pricing', requireAdmin, async (ctx) => {
    let skus = list(ctx.url.searchParams.get('skus'));
    if (!skus.length) skus = store.listProducts({ limit: 200 }).items.map((i) => i.sku);
    const cfg = pricing.getSettings();
    const res = store.researchFor(skus);
    const pr = store.pricingFor(skus);
    const items = [];
    for (const sku of skus) {
      const prod = store.getProduct(sku);
      if (prod) items.push(row(prod, res[sku], pr[sku], cfg));
    }
    const { enabled, rounding, undercutPct, maxDiscountPct, minMarginPct, showOriginAsList } = cfg;
    return {
      settings: { enabled, rounding, undercutPct, maxDiscountPct, minMarginPct, showOriginAsList },
      sources: { total: cfg.sources.length, active: cfg.sources.filter((s) => s.enabled !== false).length },
      items, research: research.status(),
    };
  });

  r.post('/api/pricing/research', requireAdmin, wrap(async (ctx) => {
    const { skus } = await readJson(ctx.req);
    const l = list(skus);
    if (!l.length) throw new HttpError(400, 'Selecione os produtos a pesquisar');
    return research.start(l.slice(0, 500));
  }));
  r.get('/api/pricing/research', requireAdmin, async () => research.status());

  r.post('/api/pricing/apply', requireAdmin, wrap(async (ctx) => {
    const { skus, strategy } = await readJson(ctx.req);
    const res = pricing.applyStrategy(list(skus), strategy);
    store.log('info', `Precificação: "${strategy}" aplicado a ${res.applied} produto(s)${res.queued ? `, ${res.queued} reenvio(s) na fila` : ''}`);
    return res;
  }));

  r.post('/api/pricing/manual', requireAdmin, wrap(async (ctx) => {
    const { sku, price } = await readJson(ctx.req);
    return pricing.setManual(sku, price);
  }));

  r.post('/api/pricing/clear', requireAdmin, wrap(async (ctx) => pricing.clear(list((await readJson(ctx.req)).skus))));

  r.get('/api/pricing/:sku', requireAdmin, async (ctx) => {
    const prod = store.getProduct(ctx.params.sku);
    if (!prod) throw new HttpError(404, 'Produto não encontrado');
    const res = store.getResearch(prod.sku);
    const pr = store.getPricing(prod.sku);
    return { ...row(prod, res, pr, pricing.getSettings()), research: res, watchUrls: pr ? pr.watch : [] };
  });

  r.put('/api/pricing/:sku/watch', requireAdmin, wrap(async (ctx) => {
    if (!store.getProduct(ctx.params.sku)) throw new HttpError(404, 'Produto não encontrado');
    return pricing.setWatch(ctx.params.sku, (await readJson(ctx.req)).urls);
  }));
}

module.exports = { register };
