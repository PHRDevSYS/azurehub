'use strict';
// Banco interno do hub (SQLite embutido do Node — node:sqlite).
// Guarda: configuração, credenciais cifradas, produtos normalizados,
// vínculo produto ↔ anúncio em cada plataforma, fila de jobs e logs.
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');
const { encrypt, decrypt } = require('./crypto');

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
  return db;
}

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
  const prev = get('SELECT hash FROM products WHERE sku = ?', product.sku);
  if (prev && prev.hash === hash) return false;
  run(`INSERT INTO products(sku, data, hash, origin, updated_at) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(sku) DO UPDATE SET data = excluded.data, hash = excluded.hash,
       origin = excluded.origin, updated_at = excluded.updated_at`,
    product.sku, JSON.stringify(product), hash, origin, now());
  return true;
}
function getProduct(sku) {
  const row = get('SELECT * FROM products WHERE sku = ?', sku);
  return row ? { ...row, data: JSON.parse(row.data) } : null;
}
function listProducts({ limit = 50, offset = 0, search = '' } = {}) {
  const like = `%${search}%`;
  const rows = all(`SELECT sku, data, origin, updated_at FROM products
    WHERE sku LIKE ? OR json_extract(data, '$.title') LIKE ?
    ORDER BY updated_at DESC LIMIT ? OFFSET ?`, like, like, limit, offset);
  const total = get(`SELECT COUNT(*) AS n FROM products
    WHERE sku LIKE ? OR json_extract(data, '$.title') LIKE ?`, like, like).n;
  const listings = all('SELECT * FROM listings');
  const bySku = {};
  for (const l of listings) (bySku[l.sku] ||= {})[l.platform] = l;
  return {
    total,
    items: rows.map((r) => {
      const d = JSON.parse(r.data);
      return {
        sku: r.sku, title: d.title, price: d.price, promoPrice: d.promoPrice, stock: d.stock,
        image: d.images[0] || null, origin: r.origin, updatedAt: r.updated_at,
        listings: bySku[r.sku] || {},
      };
    }),
  };
}
function deleteProduct(sku) {
  run('DELETE FROM products WHERE sku = ?', sku);
}

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
function listingStats(platform) {
  const rows = all('SELECT status, COUNT(*) AS n FROM listings WHERE platform = ? GROUP BY status', platform);
  const out = { synced: 0, error: 0, pending: 0, skipped: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

// ---------- fila ----------
function enqueue(platform, sku) {
  // Um job ativo por (plataforma, sku): reenfileirar só "acorda" o existente.
  const open_ = get(`SELECT id FROM jobs WHERE platform = ? AND sku = ? AND status IN ('queued','running')`, platform, sku);
  if (open_) return open_.id;
  const t = now();
  return Number(run(`INSERT INTO jobs(platform, sku, status, attempts, run_after, created_at, updated_at)
    VALUES(?, ?, 'queued', 0, ?, ?, ?)`, platform, sku, t, t, t).lastInsertRowid);
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
function listLogs({ limit = 200, platform = null } = {}) {
  return platform
    ? all('SELECT * FROM logs WHERE platform = ? ORDER BY id DESC LIMIT ?', platform, limit)
    : all('SELECT * FROM logs ORDER BY id DESC LIMIT ?', limit);
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
  upsertProduct, getProduct, listProducts, deleteProduct,
  getListing, saveListing, listingStats,
  enqueue, finishJob, resetStuckJobs, listJobs, jobStats, clearFinishedJobs,
  log, listLogs,
  createSession, sessionValid, deleteSession, saveOAuthState, consumeOAuthState,
};
