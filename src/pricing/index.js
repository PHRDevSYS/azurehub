'use strict';
// Módulo de Precificação: compara o preço de origem com o mercado (pesquisa
// de produtos similares) e define o preço de venda enviado aos marketplaces.
//
// Valores por produto:
//   origem   = preço praticado na origem (promoção, se houver) — é o TETO
//   mínimo   = menor preço de mercado encontrado (valor raspado)
//   médio    = ponto intermediário entre o mínimo e a origem
//   sugerido = mediana do mercado com um pequeno desconto, arredondada,
//              entre o PISO e o teto
// O PISO protege a margem: maior entre (origem − desconto máximo) e
// (custo + margem mínima), quando o custo é conhecido.
const store = require('../lib/store');
const platforms = require('../platforms');

const DEFAULTS = {
  enabled: false,
  undercutPct: 3,          // sugerido = mediana − 3%
  maxDiscountPct: 30,      // piso: até 30% abaixo da origem
  minMarginPct: 10,        // piso: custo + 10% (se houver custo)
  rounding: '90',          // 90 → R$ x,90 | 99 → R$ x,99 | cent → centavos
  minSimilarity: 0.45,     // similaridade mínima para considerar uma oferta
  showOriginAsList: false, // envia a origem como preço "de" e o definido como "por"
  cacheHours: 12,
  sources: [],             // fontes de pesquisa configuradas
};

function getSettings() {
  return { ...DEFAULTS, ...(store.getSetting('pricing', {}) || {}) };
}

const r2 = (x) => Math.round(x * 100) / 100;
const brl = (x) => `R$ ${x.toFixed(2).replace('.', ',')}`;

function roundPrice(x, mode) {
  if (!(x > 0)) return x;
  if (mode === '90' || mode === '99') {
    const cents = mode === '90' ? 0.9 : 0.99;
    const v = Math.floor(x - cents) + cents; // arredonda PARA BAIXO até x,90 / x,99
    return v > 0 ? r2(v) : r2(x);
  }
  return r2(x);
}

// Preço de referência da origem (com variações: a variação mais barata).
function originPrice(p) {
  const vs = p.variants || [];
  if (vs.length) return Math.min(...vs.map((v) => v.promoPrice || v.price));
  return p.promoPrice || p.price;
}

function floorOf(p, origin, cfg) {
  const byDiscount = origin * (1 - cfg.maxDiscountPct / 100);
  const byCost = p.cost ? p.cost * (1 + cfg.minMarginPct / 100) : 0;
  return r2(Math.max(byDiscount, byCost));
}

// Preço de venda que vale AGORA. Estratégias acompanham a origem e o custo
// atuais: nunca acima da origem (teto) nem abaixo do piso — se a origem cair
// ou o custo subir depois de aplicar, o envio se ajusta sozinho. "origem"
// segue a origem; o manual é respeitado como foi digitado.
function salePrice(p, row, cfg = getSettings()) {
  if (!cfg.enabled || !row || row.strategy === 'origem') return null;
  if (row.price === null || row.price === undefined) return null;
  if (row.strategy === 'manual') return row.price;
  const origin = originPrice(p);
  return r2(Math.min(origin, Math.max(floorOf(p, origin, cfg), row.price)));
}

// Entra no hash de sincronização: mudou o preço efetivo → anúncio desatualizado.
function saleKey(sku, data, cfg = getSettings()) {
  const sp = salePrice(data, store.getPricing(sku), cfg);
  return sp === null ? '' : JSON.stringify([sp, !!cfg.showOriginAsList]);
}

// Calcula as referências e a sugestão de um produto.
function evaluate(p, research, pricing, cfg = getSettings()) {
  const origin = originPrice(p);
  const floor = floorOf(p, origin, cfg);
  const market = research && research.stats ? research.stats : null;
  const clamp = (v) => {
    if (v === null || v === undefined) return { price: null, note: 'sem dados de mercado' };
    if (v < floor) return { price: floor, note: `limitado ao piso de ${brl(floor)}`, clamped: true };
    if (v > origin) return { price: origin, note: 'mercado acima da origem: mantido o preço de origem', clamped: true };
    return { price: r2(v), note: null };
  };
  const values = {
    origem: { price: origin, note: null },
    minimo: clamp(market ? market.min : null),
    medio: clamp(market ? (market.min + origin) / 2 : null),
    sugerido: { price: origin, note: 'sem dados de mercado: mantido o preço de origem' },
  };
  if (market) {
    const target = market.median * (1 - cfg.undercutPct / 100);
    // Acima da origem fica a própria origem (sem arredondar para baixo do teto).
    let s = target >= origin ? origin : roundPrice(target, cfg.rounding);
    let note = `mediana de ${market.count} oferta(s) ${brl(market.median)} − ${cfg.undercutPct}% = ${brl(target)}`;
    if (target > origin) note += '; acima da origem → teto';
    if (s < floor) {
      s = floor;
      note += `; abaixo do piso → ${brl(floor)}`;
    }
    values.sugerido = { price: s, note };
  }
  const defined = pricing && pricing.price !== null && pricing.price !== undefined ? pricing.price : null;
  const sale = salePrice(p, pricing, cfg);
  const effective = sale === null ? origin : sale;
  return {
    origin, floor, cost: p.cost || null, market, values,
    price: defined, strategy: pricing ? pricing.strategy : null, effective,
    // Preço aplicado antes e ajustado agora ao piso/teto (origem ou custo mudaram).
    adjusted: sale !== null && defined !== null && sale !== defined,
    diffPct: origin ? r2(((effective - origin) / origin) * 100) : 0,
    belowMarket: market ? effective <= market.median : null,
  };
}

// Produto como será enviado: com o preço de venda definido (se houver).
function effectiveProduct(p, cfg = getSettings()) {
  if (!cfg.enabled) return p;
  const row = store.getPricing(p.sku);
  const target = salePrice(p, row, cfg);
  if (target === null) return p;
  const base = originPrice(p);
  const factor = base ? target / base : 1;
  // A janela de promoção da origem não vale para o preço definido aqui.
  const out = { ...p, promoStart: null, promoEnd: null, pricing: { origin: base, final: target, strategy: row.strategy } };
  if (cfg.showOriginAsList) {
    // Preço "de" = origem; "por" = definido (vira promoção nos marketplaces).
    out.price = p.price;
    out.promoPrice = target < p.price ? target : null;
    out.variants = (p.variants || []).map((v) => {
      const por = r2((v.promoPrice || v.price) * factor);
      return { ...v, promoPrice: por < v.price ? por : null };
    });
  } else {
    out.price = target;
    out.promoPrice = null;
    out.variants = (p.variants || []).map((v) => ({ ...v, price: r2((v.promoPrice || v.price) * factor), promoPrice: null }));
  }
  if (out.variants.length) out.price = Math.min(...out.variants.map((v) => v.price));
  return out;
}

// Reenvia, nos destinos ativos, os produtos já integrados cujo preço mudou.
function resyncIntegrated(skus) {
  let n = 0;
  for (const sku of skus) {
    const prod = store.getProduct(sku);
    if (!prod) continue;
    const syncHash = store.syncHashOf(prod);
    for (const id of platforms.ids()) {
      const l = store.getListing(id, sku);
      if (!l || l.status === 'paused' || !store.isEnabled(id)) continue;
      if (l.last_hash !== syncHash) { store.enqueue(id, sku); n++; }
    }
  }
  return n;
}

function saveSettings(input) {
  const cur = getSettings();
  const num = (v, min, max, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  const next = {
    ...cur,
    enabled: input.enabled !== undefined ? !!input.enabled : cur.enabled,
    undercutPct: num(input.undercutPct ?? cur.undercutPct, 0, 50, DEFAULTS.undercutPct),
    maxDiscountPct: num(input.maxDiscountPct ?? cur.maxDiscountPct, 0, 90, DEFAULTS.maxDiscountPct),
    minMarginPct: num(input.minMarginPct ?? cur.minMarginPct, 0, 500, DEFAULTS.minMarginPct),
    rounding: ['90', '99', 'cent'].includes(input.rounding) ? input.rounding : cur.rounding,
    minSimilarity: num(input.minSimilarity ?? cur.minSimilarity, 0.1, 1, DEFAULTS.minSimilarity),
    showOriginAsList: input.showOriginAsList !== undefined ? !!input.showOriginAsList : cur.showOriginAsList,
    cacheHours: num(input.cacheHours ?? cur.cacheHours, 0, 168, DEFAULTS.cacheHours),
    sources: input.sources !== undefined ? cleanSources(input.sources) : cur.sources,
  };
  store.setSetting('pricing', next);
  let queued = 0;
  if (['enabled', 'showOriginAsList', 'maxDiscountPct', 'minMarginPct'].some((k) => next[k] !== cur[k])) {
    // O preço efetivo dos produtos com preço definido pode ter mudado (módulo,
    // modo de envio, ou piso que agora limita um preço aplicado antes).
    store.refreshAllSyncHashes();
    const skus = store.open().prepare('SELECT sku FROM pricing WHERE price IS NOT NULL').all().map((r) => r.sku);
    queued = resyncIntegrated(skus);
  }
  return { settings: next, queued };
}

function cleanSources(list) {
  const { SOURCES } = require('./research');
  return (Array.isArray(list) ? list : []).slice(0, 30).map((s, i) => {
    const impl = SOURCES[s.type];
    if (!impl) throw new Error(`Tipo de fonte desconhecido: ${s.type}`);
    const out = {
      id: s.id || `src${Date.now().toString(36)}${i}`, type: s.type, name: String(s.name || impl.label).slice(0, 60),
      enabled: s.enabled !== false, respect_robots: s.respect_robots !== false,
      // Intervalo mínimo entre requisições ao mesmo site (ms); vazio = padrão da fonte.
      interval_ms: Number(s.interval_ms) > 0 ? Math.min(60000, Math.max(1000, Number(s.interval_ms))) : null,
    };
    for (const f of impl.fields) {
      const v = s[f.key];
      out[f.key] = f.type === 'checkbox' ? !!v : String(v ?? '').trim();
      if (f.required && !out[f.key]) throw new Error(`${out.name}: campo obrigatório "${f.label}"`);
    }
    for (const k of ['search_url', 'base_url']) {
      if (out[k] && !/^https?:\/\//i.test(out[k])) throw new Error(`${out.name}: "${k}" precisa começar com http(s)://`);
    }
    return out;
  });
}

// Aplica uma referência (mínimo/médio/origem/sugerido) em massa.
function applyStrategy(skus, strategy) {
  if (!['minimo', 'medio', 'origem', 'sugerido'].includes(strategy)) throw new Error('Estratégia inválida');
  const cfg = getSettings();
  const research = store.researchFor(skus);
  const pricing = store.pricingFor(skus);
  const done = [];
  const skipped = [];
  for (const sku of skus) {
    const prod = store.getProduct(sku);
    if (!prod) continue;
    const ev = evaluate(prod.data, research[sku], pricing[sku], cfg);
    const v = ev.values[strategy];
    if (v.price === null) { skipped.push({ sku, reason: v.note }); continue; }
    // "origem" não grava número: acompanha a origem quando ela mudar.
    store.setPricing(sku, { price: strategy === 'origem' ? null : v.price, strategy });
    done.push(sku);
  }
  return { applied: done.length, skipped, queued: resyncIntegrated(done) };
}

function setManual(sku, price) {
  const prod = store.getProduct(sku);
  if (!prod) throw new Error('Produto não encontrado');
  const value = r2(Number(price));
  if (!(value > 0)) throw new Error('Informe um preço maior que zero');
  const ev = evaluate(prod.data, store.getResearch(sku), store.getPricing(sku));
  store.setPricing(sku, { price: value, strategy: 'manual' });
  const warnings = [];
  if (value < ev.floor) warnings.push(`abaixo do piso de ${brl(ev.floor)} (margem/desconto máximo)`);
  if (value > ev.origin) warnings.push('acima do preço de origem');
  return { price: value, warnings, queued: resyncIntegrated([sku]) };
}

function clear(skus) {
  for (const sku of skus) if (store.getPricing(sku)) store.setPricing(sku, { price: null, strategy: null });
  return { cleared: skus.length, queued: resyncIntegrated(skus) };
}

function setWatch(sku, urls) {
  const list = (Array.isArray(urls) ? urls : String(urls || '').split(/\s+/)).map((u) => u.trim()).filter(Boolean);
  for (const u of list) if (!/^https?:\/\//i.test(u)) throw new Error(`URL inválida: ${u}`);
  store.setPricing(sku, { watch: [...new Set(list)].slice(0, 20) });
  return { watch: store.getPricing(sku).watch };
}

module.exports = {
  DEFAULTS, getSettings, saveSettings, evaluate, effectiveProduct, salePrice, saleKey, applyStrategy, setManual, clear, setWatch,
  originPrice, roundPrice, resyncIntegrated,
};
