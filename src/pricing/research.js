'use strict';
// Pesquisa de preços de produtos similares, em segundo plano.
// Para cada produto: consulta as fontes ativas (GTIN primeiro, depois título),
// pontua a similaridade (e, com o agente de IA configurado, confere se cada
// oferta é mesmo o mesmo produto), descarta usados e preços fora da curva, e
// grava as estatísticas usadas pela Precificação.
const store = require('../lib/store');
const platforms = require('../platforms');
const { buildQuery, similarity, markOutliers, stats } = require('./match');
const html = require('./sources/html');
const storefronts = require('./sources/storefronts');
const pricingAgent = require('../ai/pricing-agent');

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
      // A URL monitorada é a do próprio anúncio: vale como chave para não contar em dobro.
      if (found[0]) offers.push({ ...found[0], url, pageUrlOnly: false, source: 'URL monitorada', matchedBy: 'url', score: 1 });
      sources.push({ name: `URL monitorada (${new URL(url).host})`, type: 'watch', ok: !!found[0], count: found.length ? 1 : 0, error: found.length ? undefined : 'preço não encontrado na página' });
    } catch (e) {
      sources.push({ name: `URL monitorada (${new URL(url).host})`, type: 'watch', ok: false, error: e.message });
    }
  }
  dedupe(offers);
  const agent = await pricingAgent.reviewOffers(p, offers, cfg.minSimilarity);
  const accepted = offers.filter((o) => o.price > 0 && o.condition !== 'used' && pricingAgent.isSame(o, cfg.minSimilarity));
  const marked = markOutliers(accepted);
  const valid = marked.filter((o) => !o.outlier);
  const result = {
    query: q,
    offers: [
      ...marked.map((o) => ({ ...o, accepted: !o.outlier, reason: o.outlier ? 'preço fora da curva' : null })),
      ...offers.filter((o) => !accepted.includes(o)).map((o) => ({
        ...o, accepted: false, reason: rejectReason(o, cfg.minSimilarity),
      })),
    ].sort((a, b) => (b.accepted - a.accepted) || (a.price - b.price)).slice(0, 80),
    stats: stats(valid.map((o) => o.price)),
    sources,
    agent,
  };
  store.saveResearch(sku, result);
  return result;
}

function rejectReason(o, min) {
  if (o.condition === 'used') return 'usado';
  if (!(o.price > 0)) return 'sem preço';
  if (o.ai && !o.ai.same) return `agente de IA: outro produto${o.ai.reason ? ` (${o.ai.reason})` : ''}`;
  return `similaridade ${Math.round(o.score * 100)}% abaixo do mínimo`;
}

// O mesmo anúncio não conta duas vezes na mediana (ex.: URL monitorada que
// também veio na busca). Fica a cópia com a maior similaridade.
function offerKey(o) {
  if (o.url && !o.pageUrlOnly) {
    try {
      const u = new URL(o.url);
      for (const k of [...u.searchParams.keys()]) if (/^(_|utm_)/.test(k)) u.searchParams.delete(k);
      u.hash = '';
      return u.href.replace(/\/+(\?|$)/, '$1').toLowerCase();
    } catch { /* URL inválida: cai na chave por título */ }
  }
  return `${o.source}|${String(o.title || '').toLowerCase()}|${o.price}`;
}

function dedupe(offers) {
  const best = new Map();
  for (const o of offers) {
    const k = offerKey(o);
    const cur = best.get(k);
    if (!cur || o.score > cur.score) best.set(k, o);
  }
  const keep = new Set(best.values());
  for (let i = offers.length - 1; i >= 0; i--) if (!keep.has(offers[i])) offers.splice(i, 1);
  return offers;
}

// Inicia (ou devolve a que já está rodando).
function start(skus) {
  if (task && task.running) return { ...status(), started: false };
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
  return { ...status(), started: true };
}

module.exports = { SOURCES, start, status, researchOne, makeCtx, dedupe, offerKey };
