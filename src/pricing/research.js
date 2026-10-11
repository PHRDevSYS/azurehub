'use strict';
// Pesquisa de preços de produtos similares, em segundo plano.
// Para cada produto: consulta as fontes ativas (GTIN primeiro, depois título),
// pontua a similaridade, descarta usados e preços fora da curva, e grava as
// estatísticas usadas pela Precificação.
const store = require('../lib/store');
const platforms = require('../platforms');
const { buildQuery, similarity, markOutliers, stats } = require('./match');
const html = require('./sources/html');
const storefronts = require('./sources/storefronts');

const SOURCES = {
  mercadolivre: require('./sources/mercadolivre'),
  vtex: storefronts.vtex,
  shopify: storefronts.shopify,
  woocommerce: storefronts.woocommerce,
  html,
  scrapling: require('./sources/scrapling'),
};

let task = null;
const USED = /\b(usad[oa]s?|seminov[oa]s?|semi-nov[oa]s?|recondicionad[oa]s?|vitrine|mostru[aá]rio|refurbished|used)\b/i;

function status() {
  return task ? { ...task, products: undefined } : { running: false };
}

function makeCtx() {
  const memo = {};
  return { platform: (id) => (memo[id] ||= platforms.context(id).catch(() => null)) };
}

async function researchOne(sku, cfg, ctx) {
  const prod = store.getProduct(sku);
  if (!prod) return null;
  const p = prod.data;
  const q = buildQuery(p);
  const offers = [];
  const sources = [];
  for (const s of cfg.sources.filter((x) => x.enabled !== false)) {
    const src = { ...s, cache_hours: cfg.cacheHours };
    const impl = SOURCES[src.type];
    if (!impl) continue;
    const found = [];
    try {
      // Por código de barras é mais preciso; sem resultado, tenta pelo título.
      if (q.gtin && ['mercadolivre', 'vtex', 'shopify'].includes(src.type)) {
        found.push(...(await impl.search(src, q, ctx)).map((o) => ({ ...o, matchedBy: 'gtin' })));
      }
      if (!found.length) found.push(...(await impl.search(src, { ...q, gtin: null }, ctx)).map((o) => ({ ...o, matchedBy: 'título' })));
      sources.push({ name: src.name, type: src.type, ok: true, count: found.length });
    } catch (e) {
      sources.push({ name: src.name, type: src.type, ok: false, error: e.message });
    }
    for (const o of found) {
      const sameGtin = q.gtin && o.gtin && o.gtin.replace(/^0+/, '') === q.gtin.replace(/^0+/, '');
      // Muitas lojas não marcam a condição: o título denuncia o usado.
      const condition = o.condition === 'used' || USED.test(o.title || '') ? 'used' : o.condition;
      offers.push({ ...o, condition, source: src.name, score: sameGtin || (o.matchedBy === 'gtin' && q.gtin) ? 1 : similarity(p, o.title) });
    }
  }
  // URLs de concorrentes cadastradas para este produto (curadoria manual).
  const watch = (store.getPricing(sku) || {}).watch || [];
  for (const url of watch) {
    try {
      const found = await html.fetchPage(url, { respect_robots: true, cache_hours: cfg.cacheHours });
      if (found[0]) offers.push({ ...found[0], url, source: 'URL monitorada', matchedBy: 'url', score: 1 });
      sources.push({ name: `URL monitorada (${new URL(url).host})`, type: 'watch', ok: !!found[0], count: found.length ? 1 : 0, error: found.length ? undefined : 'preço não encontrado na página' });
    } catch (e) {
      sources.push({ name: `URL monitorada (${new URL(url).host})`, type: 'watch', ok: false, error: e.message });
    }
  }
  const accepted = offers.filter((o) => o.price > 0 && o.condition !== 'used' && o.score >= cfg.minSimilarity);
  const marked = markOutliers(accepted);
  const valid = marked.filter((o) => !o.outlier);
  const result = {
    query: q,
    offers: [
      ...marked.map((o) => ({ ...o, accepted: !o.outlier, reason: o.outlier ? 'preço fora da curva' : null })),
      ...offers.filter((o) => !accepted.includes(o)).map((o) => ({
        ...o, accepted: false, reason: o.condition === 'used' ? 'usado' : o.score < cfg.minSimilarity ? `similaridade ${Math.round(o.score * 100)}% abaixo do mínimo` : 'sem preço',
      })),
    ].sort((a, b) => (b.accepted - a.accepted) || (a.price - b.price)).slice(0, 80),
    stats: stats(valid.map((o) => o.price)),
    sources,
  };
  store.saveResearch(sku, result);
  return result;
}

// Inicia (ou devolve a que já está rodando).
function start(skus) {
  if (task && task.running) return status();
  const cfg = require('./index').getSettings();
  if (!cfg.sources.some((s) => s.enabled !== false)) throw new Error('Cadastre ao menos uma fonte de pesquisa em Precificação › Fontes');
  task = { running: true, total: skus.length, done: 0, current: null, errors: 0, startedAt: store.now(), finishedAt: null };
  (async () => {
    const ctx = makeCtx();
    for (const sku of skus) {
      task.current = sku;
      try {
        const r = await researchOne(sku, cfg, ctx);
        if (r && r.sources.every((s) => !s.ok)) task.errors++;
      } catch (e) {
        task.errors++;
        store.log('error', `Pesquisa de preço: ${e.message}`, { sku });
      }
      task.done++;
    }
    task.running = false;
    task.current = null;
    task.finishedAt = store.now();
    store.log('info', `Pesquisa de preços concluída: ${task.done} produto(s), ${task.errors} sem resposta das fontes`);
  })();
  return status();
}

module.exports = { SOURCES, start, status, researchOne, makeCtx };
