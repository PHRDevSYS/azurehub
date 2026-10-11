'use strict';
// Motor de sincronização: consome a fila (jobs) e publica cada produto na
// plataforma. Um job por vez por plataforma; plataformas rodam em paralelo.
// Erros temporários (rede, 429, 5xx) voltam para a fila com backoff.
const store = require('../lib/store');
const platforms = require('../platforms');
const config = require('../config');

const MAX_ATTEMPTS = 5;
const busy = new Set();
let timer = null;
let autoImportTimer = null;

async function processJob(job) {
  const { platform, sku } = job;
  const product = store.getProduct(sku);
  if (!product) {
    store.finishJob(job.id, 'done', 'produto removido');
    return;
  }
  const listing = store.getListing(platform, sku);
  if (listing && listing.status === 'synced' && listing.last_hash === product.hash) {
    store.finishJob(job.id, 'done', 'sem alterações');
    return;
  }
  try {
    const ctx = await platforms.context(platform);
    const res = await ctx.platform.publish(ctx, product.data, listing);
    store.saveListing(platform, sku, {
      external_id: res.externalId, status: 'synced', last_hash: product.hash,
      meta: res.meta, last_error: res.warnings.length ? res.warnings.join(' | ') : null, last_sync: store.now(),
    });
    store.finishJob(job.id, 'done');
    store.log('info', `${listing && listing.external_id ? 'Atualizado' : 'Publicado'} → ${res.externalId}`, { platform, sku });
    for (const w of res.warnings) store.log('warn', w, { platform, sku });
  } catch (e) {
    const retry = e.retryable && job.attempts < MAX_ATTEMPTS;
    store.saveListing(platform, sku, { status: 'error', last_error: e.message, last_sync: store.now() });
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

function tick() {
  for (const platform of platforms.ids()) {
    if (busy.has(platform) || !store.isEnabled(platform)) continue;
    const job = nextFor(platform);
    if (!job) continue;
    busy.add(platform);
    processJob(job).finally(() => busy.delete(platform));
  }
}

function nextFor(platform) {
  // nextJob() pega o próximo de qualquer plataforma; filtramos por ela aqui.
  const db = store.open();
  const job = db.prepare(`SELECT * FROM jobs WHERE status = 'queued' AND platform = ? AND run_after <= ? ORDER BY id LIMIT 1`)
    .get(platform, store.now());
  if (!job) return null;
  db.prepare(`UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`).run(store.now(), job.id);
  return { ...job, attempts: job.attempts + 1 };
}

function enqueueAll(platform, skus) {
  const targets = platform ? [platform] : platforms.ids().filter(store.isEnabled);
  const list = skus && skus.length ? skus : store.open().prepare('SELECT sku FROM products').all().map((r) => r.sku);
  let n = 0;
  for (const p of targets) {
    for (const sku of list) {
      // Força reenvio mesmo sem alteração de conteúdo.
      const l = store.getListing(p, sku);
      if (l) store.saveListing(p, sku, { last_hash: null });
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
