'use strict';
// Origem dos produtos: um conector por ERP/site (ver connectors/).
// A captura grava os produtos no hub; eles só vão para um marketplace depois
// de selecionados e enviados para integração (tela Produtos). Produtos já
// enviados são ressincronizados automaticamente quando mudam na origem.
const store = require('../lib/store');
const config = require('../config');
const connectors = require('./connectors');
const { normalizeProduct, validateProduct, productHash } = require('./normalize');
const PRESETS = require('./presets');

const LEGACY_DB = ['mysql', 'postgres', 'sqlite'];

// Configuração salva (cifrada). Aceita o formato antigo {type:'mysql',...}.
function getSource() {
  const s = store.getSecretSetting('source');
  if (!s) return null;
  if (LEGACY_DB.includes(s.type)) return { ...s, type: 'database', engine: s.type };
  return s;
}

function saveSource(cfg) {
  const prev = getSource();
  store.setSecretSetting('source', cfg);
  // Trocar de origem (ou de app) invalida os tokens anteriores.
  const c = connectors.get(cfg.type);
  const sameApp = prev && prev.type === cfg.type && (prev.client_id || prev.app_id) === (cfg.client_id || cfg.app_id);
  if (!sameApp || !c.oauth) store.setSecretSetting('source_tokens', null);
}

// Valida e limpa os campos conforme o conector; senha mascarada = manter a salva.
// Campos que identificam PARA ONDE vai a senha: mudou algum, a senha salva
// não é reaproveitada (senão uma sessão do painel enviaria o segredo a outro host).
const CONNECTION = /^(url|host|port|user|database|engine|shop|store_id|app_id|client_id|consumer_key)$/;

function cleanSource(body) {
  const c = connectors.get(body && body.type);
  const prev = getSource() || {};
  const sameTarget = prev.type === c.id && c.fields.filter((f) => CONNECTION.test(f.key))
    .every((f) => String(body[f.key] ?? f.default ?? '').trim() === String(prev[f.key] ?? f.default ?? '').trim());
  const out = { type: c.id };
  for (const f of c.fields) {
    let v = body[f.key];
    if (f.type === 'password' && (v === undefined || String(v).startsWith('••••••'))) v = sameTarget ? prev[f.key] : undefined;
    if (f.type === 'checkbox') v = v === undefined ? (f.default ?? false) : !!v;
    else v = v === undefined || v === null ? (f.default ?? '') : String(v).trim();
    const visible = !f.showIf || Object.entries(f.showIf).every(([k, vals]) => vals.includes(body[k] ?? (c.fields.find((x) => x.key === k) || {}).default));
    if (f.required && visible && (v === '' || v === undefined)) throw new Error(`Campo obrigatório: ${f.label}`);
    out[f.key] = v;
  }
  return out;
}

function maskSource(cfg) {
  if (!cfg) return null;
  const c = connectors.get(cfg.type);
  const out = { ...cfg };
  for (const f of c.fields) if (f.type === 'password' && out[f.key]) out[f.key] = `••••••${String(out[f.key]).slice(-4)}`;
  return out;
}

const redirectUri = (id) => `${config.publicUrl}/oauth/source/${id}/callback`;

// Tokens OAuth da origem, renovados quando perto de expirar.
async function tokens(cfg) {
  const c = connectors.get(cfg.type);
  let t = store.getSecretSetting('source_tokens');
  if (!c.oauth || !t) return t || null;
  if (t.expires_at && t.expires_at < Date.now() + 120e3 && c.oauth.refreshTokens) {
    t = { ...t, ...(await c.oauth.refreshTokens({ cfg, tokens: t })) };
    store.setSecretSetting('source_tokens', t);
    store.log('info', `Origem ${c.name}: token renovado`);
  }
  return t;
}

function summary() {
  const cfg = getSource();
  const t = store.getSecretSetting('source_tokens');
  const c = cfg ? connectors.get(cfg.type) : null;
  return {
    source: maskSource(cfg),
    connector: c ? c.id : null,
    connected: !!(c && (!c.oauth || t || (c.id === 'nuvemshop' && cfg.access_token))),
    oauthAvailable: !!(c && c.oauth && c.oauth.available(cfg)),
    redirectUri: c && c.oauth ? redirectUri(c.id) : null,
    lastCapture: store.getSetting('last_capture', null),
    autoImportMinutes: store.getSetting('autoImportMinutes', 0),
  };
}

function catalog() {
  return Object.values(connectors.REGISTRY).map((c) => ({
    id: c.id, name: c.name, kind: c.kind, description: c.description, docsUrl: c.docsUrl || null,
    fields: c.fields, oauth: !!c.oauth, push: !!c.push, presets: c.presets || null,
    redirectUri: c.oauth ? redirectUri(c.id) : null,
  }));
}

// Testa a configuração (sem gravar) e devolve amostra normalizada.
async function testSource(cfg) {
  const c = connectors.get(cfg.type);
  const saved = getSource();
  const t = saved && saved.type === cfg.type ? await tokens(saved) : null;
  const res = await c.test(cfg, t);
  return {
    ...res,
    sample: (res.sample || []).map((raw) => {
      const p = normalizeProduct(raw);
      return { product: p, errors: validateProduct(p) };
    }),
  };
}

// Grava produtos no hub. Enfileira apenas os destinos em que o produto foi
// selecionado (e os pedidos em `sendTo`, que passam a ficar selecionados).
function ingest(rawProducts, origin, { sendTo = [] } = {}) {
  const out = { received: rawProducts.length, changed: 0, unchanged: 0, invalid: [], queued: 0 };
  const enabled = require('../platforms').ids().filter(store.isEnabled);
  for (const raw of rawProducts) {
    const p = normalizeProduct(raw);
    const errors = validateProduct(p);
    if (errors.length) {
      out.invalid.push({ sku: p.sku || null, title: p.title || null, errors });
      continue;
    }
    const changed = store.upsertProduct(p, productHash(p), origin);
    if (changed) out.changed++;
    else out.unchanged++;
    for (const platform of sendTo) store.selectForPlatform(platform, p.sku);
    for (const platform of enabled) {
      const l = store.getListing(platform, p.sku);
      if (!l || l.status === 'paused') continue;
      if (changed || sendTo.includes(platform)) {
        store.enqueue(platform, p.sku);
        out.queued++;
      }
    }
  }
  return out;
}

// Captura da origem configurada.
let capturing = null;
async function importFromSource() {
  if (capturing) return capturing;
  capturing = (async () => {
    const cfg = getSource();
    const started = store.now();
    if (!cfg || cfg.type === 'api') return { received: 0, changed: 0, unchanged: 0, invalid: [], note: 'Origem por API: o site envia os produtos.' };
    const c = connectors.get(cfg.type);
    try {
      const rows = await c.fetchProducts(cfg, await tokens(cfg));
      const result = ingest(rows, c.id);
      store.setSetting('last_capture', { at: store.now(), startedAt: started, origin: c.id, ...result, invalid: result.invalid.length, invalidList: result.invalid.slice(0, 50) });
      store.log('info', `Captura (${c.name}): ${result.received} lidos, ${result.changed} novos/alterados, ${result.invalid.length} inválidos, ${result.queued} na fila`);
      return result;
    } catch (e) {
      store.setSetting('last_capture', { at: store.now(), startedAt: started, origin: c.id, error: e.message });
      store.log('error', `Captura (${c.name}): ${e.message}`);
      throw e;
    }
  })();
  try { return await capturing; } finally { capturing = null; }
}

module.exports = {
  getSource, saveSource, cleanSource, maskSource, tokens, summary, catalog, testSource, ingest, importFromSource,
  redirectUri, PRESETS, connectors,
};
