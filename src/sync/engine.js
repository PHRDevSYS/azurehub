'use strict';
// Motor de sincronização: consome a fila (jobs) e publica cada produto na
// plataforma. Um job por vez por plataforma; plataformas rodam em paralelo.
// Erros temporários (rede, 429, 5xx) voltam para a fila com backoff.
const store = require('../lib/store');
const platforms = require('../platforms');
const config = require('../config');
const pricing = require('../pricing');

const MAX_ATTEMPTS = 5;
// Jobs em andamento por plataforma (sku de cada um): até CONCURRENCY ao mesmo
// tempo, nunca dois do mesmo produto.
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.SYNC_CONCURRENCY) || 2));
const busy = new Map();
let timer = null;
let autoImportTimer = null;

// Fim da promoção criada na plataforma (ms), se houver.
function promoEndMs(meta) {
  const e = meta && meta.promo && Number(meta.promo.end);
  if (!e) return 0;
  return e < 1e12 ? e * 1000 : e;
}

async function processJob(job) {
  const { platform, sku } = job;
  const product = store.getProduct(sku);
  if (!product) {
    store.finishJob(job.id, 'done', 'produto removido');
    return;
  }
  const listing = store.getListing(platform, sku);
  if (!listing || listing.status === 'paused') {
    store.finishJob(job.id, 'done', listing ? 'sincronização pausada' : 'produto não selecionado para este destino');
    return;
  }
  const syncHash = store.syncHashOf(product);
  const promoOver = promoEndMs(listing.meta) && promoEndMs(listing.meta) <= Date.now();
  if (listing.status === 'synced' && listing.last_hash === syncHash && !promoOver) {
    store.finishJob(job.id, 'done', 'sem alterações');
    return;
  }
  try {
    const ctx = await platforms.context(platform);
    // Preço definido na Precificação (se o módulo estiver ativo).
    const res = await ctx.platform.publish(ctx, pricing.effectiveProduct(product.data), listing);
    // Sem externalId = a plataforma adiou a criação (ex.: TikTok sem estoque).
    // followUpMs = há etapa pendente (ex.: vídeo transcodificando): volta à fila.
    // Preço recusado (promoção ativa na plataforma): volta à fila em 30 min, até
    // 6 vezes, em vez de dar o anúncio por sincronizado com o preço antigo.
    const priceStuck = res.warnings.some((w) => /^Preço não atualizado/.test(w));
    const tries = Number((listing.meta || {}).price_retries) || 0;
    res.meta = { ...res.meta, price_retries: priceStuck ? tries + 1 : 0 };
    if (priceStuck && tries < 6 && !res.followUpMs) res.followUpMs = 30 * 60e3;
    // Se o usuário parou de sincronizar enquanto o envio rodava, o anúncio
    // criado/atualizado continua vinculado, mas pausado.
    const after = store.getListing(platform, sku);
    const stopped = !after || after.status === 'paused';
    store.saveListing(platform, sku, {
      external_id: res.externalId, status: stopped && res.externalId ? 'paused' : res.externalId ? 'synced' : 'skipped',
      last_hash: res.followUpMs ? null : syncHash,
      meta: res.meta, last_error: res.warnings.length ? res.warnings.join(' | ') : null, last_sync: store.now(),
    });
    store.finishJob(job.id, 'done');
    // A campanha acaba: um novo envio no fim encerra (ou renova) a promoção.
    const endMs = promoEndMs(res.meta);
    if (endMs > Date.now() && !stopped && !res.followUpMs) store.enqueue(platform, sku, endMs - Date.now() + 60e3);
    if (res.followUpMs && !stopped) store.enqueue(platform, sku, res.followUpMs);
    if (res.externalId) store.log('info', `${listing && listing.external_id ? 'Atualizado' : 'Publicado'} → ${res.externalId}`, { platform, sku });
    for (const w of res.warnings) store.log('warn', w, { platform, sku });
  } catch (e) {
    const retry = e.retryable && job.attempts < MAX_ATTEMPTS;
    // Falha depois de criar o anúncio: guarda o id para não duplicar na próxima tentativa.
    const partial = e.partial ? { external_id: e.partial.externalId, meta: e.partial.meta, last_hash: null } : {};
    store.saveListing(platform, sku, { ...partial, status: 'error', last_error: e.message, last_sync: store.now() });
    if (retry) {
      const delay = Math.min(30 * 60e3, 15e3 * 2 ** (job.attempts - 1));
      store.finishJob(job.id, 'queued', e.message, delay);
      store.log('warn', `Falha temporária (tentativa ${job.attempts}/${MAX_ATTEMPTS}), nova tentativa em ${Math.round(delay / 1000)} s: ${e.message}`, { platform, sku });
    } else {
      store.finishJob(job.id, 'error', e.message);
      store.log('error', e.message, { platform, sku });
    }
  }
}

let lastPrune = 0;
function tick() {
  if (Date.now() - lastPrune > 3600e3) { lastPrune = Date.now(); try { store.pruneJobs(); } catch { /* tenta na próxima hora */ } }
  for (const platform of platforms.ids()) {
    if (!store.isEnabled(platform)) continue;
    const running = busy.get(platform) || new Set();
    busy.set(platform, running);
    while (running.size < CONCURRENCY) {
      const job = nextFor(platform, [...running]);
      if (!job) break;
      running.add(job.sku);
      processJob(job).finally(() => running.delete(job.sku));
    }
  }
}

function nextFor(platform, skipSkus = []) {
  // nextJob() pega o próximo de qualquer plataforma; filtramos por ela aqui.
  const db = store.open();
  const skip = skipSkus.length ? ` AND sku NOT IN (${skipSkus.map(() => '?').join(',')})` : '';
  const job = db.prepare(`SELECT * FROM jobs WHERE status = 'queued' AND platform = ? AND run_after <= ?${skip} ORDER BY id LIMIT 1`)
    .get(platform, store.now(), ...skipSkus);
  if (!job) return null;
  db.prepare(`UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`).run(store.now(), job.id);
  return { ...job, attempts: job.attempts + 1 };
}

// Reenvia: com `skus`, seleciona-os para o destino; sem, reenvia todos os
// produtos já selecionados. Força o envio mesmo sem alteração.
function enqueueAll(platform, skus) {
  const targets = platform ? [platform] : platforms.ids().filter(store.isEnabled);
  let n = 0;
  for (const p of targets) {
    const list = skus && skus.length ? skus : store.selectedSkus(p);
    for (const sku of list) {
      if (!store.getProduct(sku)) continue;
      store.selectForPlatform(p, sku);
      store.saveListing(p, sku, { last_hash: null });
      store.enqueue(p, sku);
      n++;
    }
  }
  return n;
}

function scheduleAutoImport() {
  clearInterval(autoImportTimer);
  const minutes = Number(store.getSetting('autoImportMinutes', 0));
  if (!minutes) return;
  const { importFromSource } = require('../source');
  autoImportTimer = setInterval(() => {
    importFromSource().catch((e) => store.log('error', `Importação automática: ${e.message}`));
  }, minutes * 60e3);
}

function start() {
  store.resetStuckJobs();
  timer = setInterval(tick, config.syncIntervalMs);
  scheduleAutoImport();
}

function stop() {
  clearInterval(timer);
  clearInterval(autoImportTimer);
}

module.exports = { start, stop, tick, processJob, enqueueAll, scheduleAutoImport };
