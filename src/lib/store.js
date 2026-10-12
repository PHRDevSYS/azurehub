'use strict';
// Banco interno do hub (SQLite embutido do Node — node:sqlite).
// Guarda: configuração, credenciais cifradas, produtos normalizados,
// vínculo produto ↔ anúncio em cada plataforma, fila de jobs e logs.
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');
const { encrypt, decrypt, sha256 } = require('./crypto');

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS platform_config (
  platform TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  credentials TEXT,          -- cifrado
  tokens TEXT,               -- cifrado
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS products (
  sku TEXT PRIMARY KEY,
  data TEXT NOT NULL,        -- JSON do produto normalizado
  hash TEXT NOT NULL,
  origin TEXT NOT NULL,      -- 'db' | 'api'
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS listings (
  platform TEXT NOT NULL,
  sku TEXT NOT NULL,
  external_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | synced | error
  last_hash TEXT,
  meta TEXT,                 -- JSON (ids de mídia, promoção, sku externo...)
  last_error TEXT,
  last_sync TEXT,
  PRIMARY KEY (platform, sku)
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  sku TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | error
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_after);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  platform TEXT,
  sku TEXT,
  message TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pricing (
  sku TEXT PRIMARY KEY,
  price REAL,                -- preço de venda definido (NULL = usa o da origem)
  strategy TEXT,             -- minimo | medio | origem | sugerido | manual
  watch TEXT,                -- JSON: URLs de concorrentes monitoradas
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS price_research (
  sku TEXT PRIMARY KEY,
  data TEXT NOT NULL,        -- JSON: ofertas, estatísticas, fontes consultadas
  collected_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ugc_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL,
  kind TEXT NOT NULL,        -- uso | posse | especificacoes | video
  gender TEXT,               -- feminino | masculino
  provider TEXT,
  model TEXT,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,      -- draft | queued | running | done | error
  job TEXT,                  -- id do job assíncrono no provedor (vídeo)
  file TEXT,                 -- caminho relativo em data/ugc
  mime TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ugc_media_sku ON ugc_media(sku, kind, id);
CREATE TABLE IF NOT EXISTS ai_audits (
  sku TEXT PRIMARY KEY,
  data TEXT NOT NULL,        -- JSON: achados do Auditor de anúncios (IA)
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  extra TEXT,
  expires_at TEXT NOT NULL
);
`;

const now = () => new Date().toISOString();

function open(file = config.dbFile) {
  if (db) return db;
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate();
  return db;
}

// Colunas adicionadas depois da primeira versão (bancos já instalados).
function migrate() {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!cols('products').includes('captured_at')) {
    db.exec('ALTER TABLE products ADD COLUMN captured_at TEXT');
    db.exec('UPDATE products SET captured_at = updated_at WHERE captured_at IS NULL');
  }
  if (!cols('listings').includes('selected_at')) db.exec('ALTER TABLE listings ADD COLUMN selected_at TEXT');
  if (!cols('products').includes('sync_hash')) db.exec('ALTER TABLE products ADD COLUMN sync_hash TEXT');
}

// Hash do que vai para os marketplaces: conteúdo do produto + preço de venda
// efetivo da Precificação (quando o módulo está ativo). Mudar o preço também
// deixa o anúncio "desatualizado" e dispara o reenvio dos já integrados.
// (require tardio: o módulo de Precificação depende deste arquivo.)
function refreshSyncHash(sku) {
  const row = get('SELECT hash, data FROM products WHERE sku = ?', sku);
  if (!row) return null;
  const key = require('../pricing').saleKey(sku, JSON.parse(row.data));
  const syncHash = key ? sha256(`${row.hash}|${key}`) : row.hash;
  run('UPDATE products SET sync_hash = ? WHERE sku = ?', syncHash, sku);
  return syncHash;
}

const syncHashOf = (row) => row.sync_hash || row.hash;

function close() {
  if (db) db.close();
  db = null;
}

const get = (sql, ...a) => open().prepare(sql).get(...a);
const all = (sql, ...a) => open().prepare(sql).all(...a);
const run = (sql, ...a) => open().prepare(sql).run(...a);

// ---------- settings ----------
function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? JSON.parse(row.value) : fallback;
}
function setSetting(key, value) {
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, JSON.stringify(value));
}
function getSecretSetting(key) {
  const v = getSetting(key);
  return v ? decrypt(v) : null;
}
function setSecretSetting(key, value) {
  setSetting(key, value == null ? null : encrypt(value));
}

// ---------- plataformas ----------
function platformRow(platform) {
  return get('SELECT * FROM platform_config WHERE platform = ?', platform) || null;
}
function ensurePlatform(platform) {
  run('INSERT OR IGNORE INTO platform_config(platform, enabled, updated_at) VALUES(?, 0, ?)', platform, now());
}
function getCredentials(platform) {
  const row = platformRow(platform);
  return row && row.credentials ? decrypt(row.credentials) : null;
}
function setCredentials(platform, creds) {
  ensurePlatform(platform);
  run('UPDATE platform_config SET credentials = ?, updated_at = ? WHERE platform = ?', encrypt(creds), now(), platform);
}
function getTokens(platform) {
  const row = platformRow(platform);
  return row && row.tokens ? decrypt(row.tokens) : null;
}
function setTokens(platform, tokens) {
  ensurePlatform(platform);
  run('UPDATE platform_config SET tokens = ?, updated_at = ? WHERE platform = ?',
    tokens ? encrypt(tokens) : null, now(), platform);
}
function setEnabled(platform, enabled) {
  ensurePlatform(platform);
  run('UPDATE platform_config SET enabled = ?, updated_at = ? WHERE platform = ?', enabled ? 1 : 0, now(), platform);
}
function isEnabled(platform) {
  const row = platformRow(platform);
  return !!(row && row.enabled);
}

// ---------- produtos ----------
function upsertProduct(product, hash, origin) {
  const prev = get('SELECT hash, data FROM products WHERE sku = ?', product.sku);
  // Mesmo hash e mesmos dados = nada a fazer. Só o custo mudou: grava, sem reenvio.
  if (prev && prev.hash === hash && prev.data === JSON.stringify(product)) return false;
  const t = now();
  run(`INSERT INTO products(sku, data, hash, origin, updated_at, captured_at) VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(sku) DO UPDATE SET data = excluded.data, hash = excluded.hash,
       origin = excluded.origin, updated_at = excluded.updated_at`,
    product.sku, JSON.stringify(product), hash, origin, t, t);
  refreshSyncHash(product.sku);
  return true;
}
function getProduct(sku) {
  const row = get('SELECT * FROM products WHERE sku = ?', sku);
  return row ? { ...row, data: JSON.parse(row.data) } : null;
}
function listingsBySku(skus) {
  const bySku = {};
  if (!skus.length) return bySku;
  const rows = all(`SELECT platform, sku, external_id, status, last_error, last_sync, last_hash, selected_at FROM listings
    WHERE sku IN (${skus.map(() => '?').join(',')})`, ...skus);
  for (const l of rows) (bySku[l.sku] ||= {})[l.platform] = l;
  return bySku;
}

// Grade da tela Produtos (sem mídia). filter: all | not_sent | sent | error
function listProducts({ limit = 50, offset = 0, search = '', filter = 'all' } = {}) {
  const like = `%${search}%`;
  const where = [`(sku LIKE ? OR json_extract(data, '$.title') LIKE ? OR json_extract(data, '$.brand') LIKE ?)`];
  const args = [like, like, like];
  if (filter === 'not_sent') where.push('sku NOT IN (SELECT sku FROM listings)');
  if (filter === 'sent') where.push('sku IN (SELECT sku FROM listings)');
  if (filter === 'error') where.push(`sku IN (SELECT sku FROM listings WHERE status = 'error')`);
  const w = where.join(' AND ');
  const rows = all(`SELECT sku, data, hash, sync_hash, origin, updated_at, captured_at FROM products WHERE ${w}
    ORDER BY updated_at DESC LIMIT ? OFFSET ?`, ...args, limit, offset);
  const total = get(`SELECT COUNT(*) AS n FROM products WHERE ${w}`, ...args).n;
  const bySku = listingsBySku(rows.map((r) => r.sku));
  return {
    total,
    items: rows.map((r) => {
      const d = JSON.parse(r.data);
      const listings = bySku[r.sku] || {};
      for (const l of Object.values(listings)) l.outdated = l.last_hash !== syncHashOf(r);
      return {
        sku: r.sku, title: d.title, brand: d.brand, price: d.price, promoPrice: d.promoPrice, stock: d.stock,
        variants: (d.variants || []).length, images: d.images.length, videos: d.videos.length, active: d.active,
        origin: r.origin, sourceRef: d.sourceRef || null, capturedAt: r.captured_at, updatedAt: r.updated_at, listings,
      };
    }),
  };
}

// Grade da tela Sincronização: uma linha por produto × destino selecionado.
function listSync({ limit = 100, offset = 0, search = '', platform = '', status = '' } = {}) {
  const like = `%${search}%`;
  const where = [`(l.sku LIKE ? OR json_extract(p.data, '$.title') LIKE ? OR IFNULL(l.external_id, '') LIKE ?)`];
  const args = [like, like, like];
  if (platform) { where.push('l.platform = ?'); args.push(platform); }
  // Desatualizado = já publicado, mas o produto mudou na origem desde o último envio.
  if (status === 'outdated') where.push(`l.status = 'synced' AND (l.last_hash IS NULL OR l.last_hash != COALESCE(p.sync_hash, p.hash))`);
  else if (status) { where.push('l.status = ?'); args.push(status); }
  const w = where.join(' AND ');
  const rows = all(`SELECT l.*, p.data, COALESCE(p.sync_hash, p.hash) AS hash, p.updated_at AS product_updated_at,
      (SELECT j.status || '|' || j.run_after FROM jobs j WHERE j.platform = l.platform AND j.sku = l.sku AND j.status IN ('queued','running') ORDER BY j.id DESC LIMIT 1) AS job
    FROM listings l JOIN products p ON p.sku = l.sku WHERE ${w}
    ORDER BY COALESCE(l.last_sync, l.selected_at, p.updated_at) DESC LIMIT ? OFFSET ?`, ...args, limit, offset);
  const total = get(`SELECT COUNT(*) AS n FROM listings l JOIN products p ON p.sku = l.sku WHERE ${w}`, ...args).n;
  return {
    total,
    items: rows.map((r) => {
      const d = JSON.parse(r.data);
      const meta = r.meta ? JSON.parse(r.meta) : {};
      const [jobStatus, runAfter] = r.job ? r.job.split('|') : [null, null];
      return {
        platform: r.platform, sku: r.sku, title: d.title, price: d.price, promoPrice: d.promoPrice, stock: d.stock,
        variants: (d.variants || []).length, status: r.status, externalId: r.external_id, permalink: meta.permalink || null,
        lastSync: r.last_sync, selectedAt: r.selected_at, productUpdatedAt: r.product_updated_at,
        outdated: r.status === 'synced' && r.last_hash !== r.hash, message: r.last_error, job: jobStatus, jobRunAfter: runAfter,
      };
    }),
  };
}

// ---------- precificação ----------
function getPricing(sku) {
  const row = get('SELECT * FROM pricing WHERE sku = ?', sku);
  return row ? { ...row, watch: row.watch ? JSON.parse(row.watch) : [] } : null;
}
function pricingFor(skus) {
  if (!skus.length) return {};
  const rows = all(`SELECT * FROM pricing WHERE sku IN (${skus.map(() => '?').join(',')})`, ...skus);
  return Object.fromEntries(rows.map((r) => [r.sku, { ...r, watch: r.watch ? JSON.parse(r.watch) : [] }]));
}
function setPricing(sku, fields) {
  const cur = getPricing(sku) || { price: null, strategy: null, watch: [] };
  const next = { ...cur, ...fields };
  run(`INSERT INTO pricing(sku, price, strategy, watch, updated_at) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(sku) DO UPDATE SET price = excluded.price, strategy = excluded.strategy,
       watch = excluded.watch, updated_at = excluded.updated_at`,
    sku, next.price ?? null, next.strategy ?? null, JSON.stringify(next.watch || []), now());
  return refreshSyncHash(sku);
}
function getResearch(sku) {
  const row = get('SELECT * FROM price_research WHERE sku = ?', sku);
  return row ? { ...JSON.parse(row.data), collectedAt: row.collected_at } : null;
}
function researchFor(skus) {
  if (!skus.length) return {};
  const rows = all(`SELECT * FROM price_research WHERE sku IN (${skus.map(() => '?').join(',')})`, ...skus);
  return Object.fromEntries(rows.map((r) => [r.sku, { ...JSON.parse(r.data), collectedAt: r.collected_at }]));
}
function saveResearch(sku, data) {
  run(`INSERT INTO price_research(sku, data, collected_at) VALUES(?, ?, ?)
       ON CONFLICT(sku) DO UPDATE SET data = excluded.data, collected_at = excluded.collected_at`, sku, JSON.stringify(data), now());
}
function getAudit(sku) {
  const row = get('SELECT * FROM ai_audits WHERE sku = ?', sku);
  return row ? { ...JSON.parse(row.data), createdAt: row.created_at } : null;
}
function saveAudit(sku, data) {
  run(`INSERT INTO ai_audits(sku, data, created_at) VALUES(?, ?, ?)
       ON CONFLICT(sku) DO UPDATE SET data = excluded.data, created_at = excluded.created_at`, sku, JSON.stringify(data), now());
}
// Ligar/desligar o módulo muda o preço efetivo de todos os produtos com preço definido.
function refreshAllSyncHashes() {
  for (const r of all('SELECT sku FROM pricing')) refreshSyncHash(r.sku);
}

function deleteProduct(sku) {
  run('DELETE FROM products WHERE sku = ?', sku);
}

// ---------- mídia UGC ----------
const UGC_FIELDS = ['sku', 'kind', 'gender', 'provider', 'model', 'prompt', 'status', 'job', 'file', 'mime', 'error'];
function ugcInsert(fields) {
  const t = now();
  const cols = UGC_FIELDS.filter((k) => fields[k] !== undefined);
  return Number(run(`INSERT INTO ugc_media(${cols.join(', ')}, created_at, updated_at) VALUES(${cols.map(() => '?').join(', ')}, ?, ?)`,
    ...cols.map((k) => fields[k]), t, t).lastInsertRowid);
}
function ugcUpdate(id, fields) {
  const cols = UGC_FIELDS.filter((k) => fields[k] !== undefined);
  if (!cols.length) return;
  run(`UPDATE ugc_media SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((k) => fields[k]), now(), id);
}
const ugcGet = (id) => get('SELECT * FROM ugc_media WHERE id = ?', id) || null;
// A versão mais recente de cada uma das 4 mídias do produto.
function ugcLatest(sku) {
  return all(`SELECT * FROM ugc_media WHERE id IN (SELECT MAX(id) FROM ugc_media WHERE sku = ? GROUP BY kind)`, sku);
}
// Última versão pronta de cada mídia (fica na tela enquanto uma nova é gerada ou se ela falhar).
function ugcLastDone(sku) {
  return all(`SELECT * FROM ugc_media WHERE id IN (SELECT MAX(id) FROM ugc_media WHERE sku = ? AND status = 'done' GROUP BY kind)`, sku);
}
// A mais recente de um tipo (com filtros opcionais de status e gênero).
function ugcLatestOf(sku, kind, { status, gender } = {}) {
  const where = ['sku = ?', 'kind = ?'];
  const args = [sku, kind];
  if (status) { where.push('status = ?'); args.push(status); }
  if (gender) { where.push('gender = ?'); args.push(gender); }
  return get(`SELECT * FROM ugc_media WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 1`, ...args) || null;
}
const ugcHistory = (sku, limit = 40) => all('SELECT * FROM ugc_media WHERE sku = ? ORDER BY id DESC LIMIT ?', sku, limit);
const ugcActive = () => all(`SELECT * FROM ugc_media WHERE status IN ('queued', 'running') ORDER BY id`);

// ---------- vínculos (anúncios) ----------
function getListing(platform, sku) {
  const row = get('SELECT * FROM listings WHERE platform = ? AND sku = ?', platform, sku);
  return row ? { ...row, meta: row.meta ? JSON.parse(row.meta) : {} } : null;
}
function saveListing(platform, sku, fields) {
  const cur = getListing(platform, sku) || { meta: {} };
  const merged = { ...cur, ...fields, meta: { ...cur.meta, ...(fields.meta || {}) } };
  run(`INSERT INTO listings(platform, sku, external_id, status, last_hash, meta, last_error, last_sync)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(platform, sku) DO UPDATE SET external_id = excluded.external_id,
       status = excluded.status, last_hash = excluded.last_hash, meta = excluded.meta,
       last_error = excluded.last_error, last_sync = excluded.last_sync`,
    platform, sku, merged.external_id ?? null, merged.status || 'pending', merged.last_hash ?? null,
    JSON.stringify(merged.meta), merged.last_error ?? null, merged.last_sync ?? null);
}
// Marca o produto para sincronizar com o destino (cria o vínculo 'pending').
function selectForPlatform(platform, sku) {
  const cur = getListing(platform, sku);
  if (cur) {
    if (cur.status === 'paused') run(`UPDATE listings SET status = CASE WHEN external_id IS NULL THEN 'pending' ELSE 'synced' END, last_hash = NULL WHERE platform = ? AND sku = ?`, platform, sku);
    return false;
  }
  run(`INSERT INTO listings(platform, sku, status, meta, selected_at) VALUES(?, ?, 'pending', '{}', ?)`, platform, sku, now());
  return true;
}

// Parar de sincronizar: sem anúncio criado, o vínculo some; com anúncio, fica pausado.
function unselect(platform, sku) {
  const cur = getListing(platform, sku);
  if (!cur) return;
  if (!cur.external_id) run('DELETE FROM listings WHERE platform = ? AND sku = ?', platform, sku);
  else run(`UPDATE listings SET status = 'paused' WHERE platform = ? AND sku = ?`, platform, sku);
  run(`DELETE FROM jobs WHERE platform = ? AND sku = ? AND status = 'queued'`, platform, sku);
}

// Contadores da tela Sincronização.
function syncCounts() {
  const out = { total: 0, pending: 0, synced: 0, error: 0, skipped: 0, paused: 0, outdated: 0 };
  for (const r of all('SELECT status, COUNT(*) AS n FROM listings GROUP BY status')) { out[r.status] = r.n; out.total += r.n; }
  out.outdated = get(`SELECT COUNT(*) AS n FROM listings l JOIN products p ON p.sku = l.sku
    WHERE l.status = 'synced' AND (l.last_hash IS NULL OR l.last_hash != COALESCE(p.sync_hash, p.hash))`).n;
  return out;
}

function selectedSkus(platform) {
  return all(`SELECT sku FROM listings WHERE platform = ? AND status != 'paused'`, platform).map((r) => r.sku);
}

function listingStats(platform) {
  const rows = all('SELECT status, COUNT(*) AS n FROM listings WHERE platform = ? GROUP BY status', platform);
  const out = { synced: 0, error: 0, pending: 0, skipped: 0, paused: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

// ---------- fila ----------
function enqueue(platform, sku, delayMs = 0) {
  // Um job ativo por (plataforma, sku): reenfileirar só "acorda" o existente.
  const open_ = get(`SELECT id FROM jobs WHERE platform = ? AND sku = ? AND status = 'queued'`, platform, sku);
  if (open_) return open_.id;
  const t = now();
  const runAfter = new Date(Date.now() + delayMs).toISOString();
  return Number(run(`INSERT INTO jobs(platform, sku, status, attempts, run_after, created_at, updated_at)
    VALUES(?, ?, 'queued', 0, ?, ?, ?)`, platform, sku, runAfter, t, t).lastInsertRowid);
}
function finishJob(id, status, error = null, retryInMs = 0) {
  const runAfter = new Date(Date.now() + retryInMs).toISOString();
  run('UPDATE jobs SET status = ?, error = ?, run_after = ?, updated_at = ? WHERE id = ?', status, error, runAfter, now(), id);
}
function resetStuckJobs() {
  run(`UPDATE jobs SET status = 'queued' WHERE status = 'running'`);
}
function listJobs(limit = 100) {
  return all('SELECT * FROM jobs ORDER BY id DESC LIMIT ?', limit);
}
function jobStats() {
  const rows = all('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status');
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
function clearFinishedJobs() {
  run(`DELETE FROM jobs WHERE status = 'done'`);
}

// ---------- logs ----------
function log(level, message, { platform = null, sku = null } = {}) {
  run('INSERT INTO logs(ts, level, platform, sku, message) VALUES(?, ?, ?, ?, ?)',
    now(), level, platform, sku, String(message).slice(0, 4000));
  run('DELETE FROM logs WHERE id <= (SELECT MAX(id) - 5000 FROM logs)');
  const line = `[${level}]${platform ? ` [${platform}]` : ''}${sku ? ` [${sku}]` : ''} ${message}`;
  (level === 'error' ? console.error : console.log)(line);
}
function listLogs({ limit = 200, platform = null, sku = null } = {}) {
  const where = [];
  const args = [];
  if (platform) { where.push('platform = ?'); args.push(platform); }
  if (sku) { where.push('sku = ?'); args.push(sku); }
  return all(`SELECT * FROM logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, ...args, limit);
}

function jobsFor(sku) {
  return all(`SELECT * FROM jobs WHERE sku = ? ORDER BY id DESC LIMIT 20`, sku);
}

// ---------- sessões / OAuth ----------
function createSession(tokenHash, hours) {
  run('DELETE FROM sessions WHERE expires_at < ?', now());
  run('INSERT INTO sessions(token_hash, expires_at) VALUES(?, ?)', tokenHash,
    new Date(Date.now() + hours * 3600e3).toISOString());
}
function sessionValid(tokenHash) {
  return !!get('SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?', tokenHash, now());
}
function deleteSession(tokenHash) {
  run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
}
function saveOAuthState(state, platform, extra = {}) {
  run('DELETE FROM oauth_states WHERE expires_at < ?', now());
  run('INSERT INTO oauth_states(state, platform, extra, expires_at) VALUES(?, ?, ?, ?)',
    state, platform, JSON.stringify(extra), new Date(Date.now() + 15 * 60e3).toISOString());
}
function consumeOAuthState(state) {
  const row = get('SELECT * FROM oauth_states WHERE state = ? AND expires_at > ?', String(state || ''), now());
  if (!row) return null;
  run('DELETE FROM oauth_states WHERE state = ?', row.state);
  return { platform: row.platform, extra: JSON.parse(row.extra || '{}') };
}

module.exports = {
  open, close, now,
  getSetting, setSetting, getSecretSetting, setSecretSetting,
  platformRow, ensurePlatform, getCredentials, setCredentials, getTokens, setTokens, setEnabled, isEnabled,
  upsertProduct, getProduct, listProducts, listSync, deleteProduct, refreshSyncHash, syncHashOf,
  getPricing, pricingFor, setPricing, getResearch, researchFor, saveResearch, refreshAllSyncHashes,
  ugcInsert, ugcUpdate, ugcGet, ugcLatest, ugcLastDone, ugcLatestOf, ugcHistory, ugcActive, getAudit, saveAudit,
  getListing, saveListing, listingStats, selectForPlatform, unselect, selectedSkus, syncCounts,
  enqueue, finishJob, resetStuckJobs, listJobs, jobStats, clearFinishedJobs,
  log, listLogs, jobsFor,
  createSession, sessionValid, deleteSession, saveOAuthState, consumeOAuthState,
};
