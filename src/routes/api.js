'use strict';
const store = require('../lib/store');
const config = require('../config');
const { HttpError, readJson, redirect, parseCookies } = require('../lib/http');
const { hashPassword, verifyPassword, sha256, randomToken, safeEqual } = require('../lib/crypto');
const platforms = require('../platforms');
const source = require('../source');
const engine = require('../sync/engine');
const { previewProducts } = require('../sync/preview');
const pricing = require('../pricing');

const COOKIE = 'azurehub_session';
const installed = () => !!store.getSetting('installed');

// ---------- middlewares ----------
function requireInstalled() {
  if (!installed()) throw new HttpError(409, 'Hub ainda não instalado');
}
function requireAdmin(ctx) {
  requireInstalled();
  const token = parseCookies(ctx.req)[COOKIE];
  if (!token || !store.sessionValid(sha256(token))) throw new HttpError(401, 'Faça login');
}
// Site integrado: X-Api-Key. A sessão do painel também é aceita.
function requireApiKeyOrAdmin(ctx) {
  requireInstalled();
  const key = ctx.req.headers['x-api-key'];
  if (key) {
    if (!safeEqual(sha256(key), store.getSetting('apiKeyHash') || '')) throw new HttpError(401, 'X-Api-Key inválida');
    return;
  }
  requireAdmin(ctx);
}

// Proteção simples contra força bruta no login.
const attempts = new Map();
function throttle(ip) {
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
  return a;
}

function setSession(ctx) {
  const token = randomToken();
  store.createSession(sha256(token), config.sessionHours);
  const secure = config.publicUrl.startsWith('https://') ? '; Secure' : '';
  ctx.res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${config.sessionHours * 3600}${secure}`);
}

// Corpo da origem: aceita o formato antigo ({type:'mysql', ...}).
function readSource(body) {
  const s = { ...(body || {}) };
  if (['mysql', 'postgres', 'sqlite'].includes(s.type)) { s.engine = s.type; s.type = 'database'; }
  try {
    return source.cleanSource(s);
  } catch (e) {
    throw new HttpError(400, e.message);
  }
}

// Testa antes de salvar quando a origem não depende de OAuth.
async function checkSource(cfg) {
  const c = source.connectors.get(cfg.type);
  if (c.push || c.oauth) return null;
  try {
    return await source.testSource(cfg);
  } catch (e) {
    throw new HttpError(400, `Falha ao acessar a origem: ${e.message}`);
  }
}

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);

// Preço de venda efetivo da Precificação (quando o módulo está ativo).
function withSalePrice(data) {
  const cfg = pricing.getSettings();
  if (!cfg.enabled) return data;
  const skus = [...new Set(data.items.map((i) => i.sku))];
  const pr = store.pricingFor(skus);
  const sale = {};
  for (const sku of skus) {
    const prod = pr[sku] && store.getProduct(sku);
    sale[sku] = prod ? pricing.salePrice(prod.data, pr[sku], cfg) : null;
  }
  for (const i of data.items) i.salePrice = sale[i.sku];
  return data;
}

function register(r) {
  // ---------- status / instalação ----------
  r.get('/api/status', async () => ({ installed: installed(), version: config.VERSION, publicUrl: config.publicUrl }));

  r.get('/api/sources', async (ctx) => {
    if (installed()) requireAdmin(ctx);
    return source.catalog();
  });

  r.post('/api/source/test', async (ctx) => {
    if (installed()) requireAdmin(ctx);
    const cfg = readSource(await readJson(ctx.req));
    try {
      return await source.testSource(cfg);
    } catch (e) {
      throw new HttpError(400, `Falha ao acessar a origem: ${e.message}`);
    }
  });

  r.post('/api/install', async (ctx) => {
    if (installed()) throw new HttpError(409, 'Hub já instalado');
    const body = await readJson(ctx.req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'E-mail inválido');
    if (password.length < 8) throw new HttpError(400, 'A senha precisa de ao menos 8 caracteres');
    const cfg = readSource(body.source);
    await checkSource(cfg);
    const apiKey = `azh_${randomToken(24)}`;
    store.setSetting('admin', { email, hash: hashPassword(password) });
    source.saveSource(cfg);
    store.setSetting('apiKeyHash', sha256(apiKey));
    store.setSetting('autoImportMinutes', Number(body.autoImportMinutes || 0));
    for (const id of platforms.ids()) store.ensurePlatform(id);
    store.setSetting('installed', true);
    store.log('info', `Hub instalado (origem: ${cfg.type})`);
    engine.scheduleAutoImport();
    setSession(ctx);
    return { ok: true, apiKey };
  });

  // ---------- sessão ----------
  r.post('/api/login', async (ctx) => {
    requireInstalled();
    const ip = ctx.req.socket.remoteAddress;
    const a = throttle(ip);
    const { email, password } = await readJson(ctx.req);
    const admin = store.getSetting('admin');
    if (!admin || String(email).toLowerCase() !== admin.email || !verifyPassword(String(password || ''), admin.hash)) {
      a.n++;
      if (a.n >= 5) { a.until = Date.now() + 10 * 60e3; a.n = 0; }
      attempts.set(ip, a);
      throw new HttpError(401, 'E-mail ou senha incorretos');
    }
    attempts.delete(ip);
    setSession(ctx);
    return { ok: true };
  });

  r.post('/api/logout', async (ctx) => {
    const token = parseCookies(ctx.req)[COOKIE];
    if (token) store.deleteSession(sha256(token));
    ctx.res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return { ok: true };
  });

  r.get('/api/me', requireAdmin, async () => ({ email: store.getSetting('admin').email }));

  // ---------- Integração: origem ----------
  r.get('/api/source', requireAdmin, async () => source.summary());

  r.put('/api/source', requireAdmin, async (ctx) => {
    const body = await readJson(ctx.req);
    const cfg = readSource(body.source);
    const test = await checkSource(cfg);
    source.saveSource(cfg);
    store.setSetting('autoImportMinutes', Number(body.autoImportMinutes || 0));
    engine.scheduleAutoImport();
    store.log('info', `Origem configurada: ${source.connectors.get(cfg.type).name}`);
    return { ok: true, test, summary: source.summary() };
  });

  r.post('/api/source/authorize', requireAdmin, async () => {
    const cfg = source.getSource();
    const c = cfg && source.connectors.get(cfg.type);
    if (!c || !c.oauth) throw new HttpError(400, 'A origem configurada não usa conexão por OAuth');
    if (!c.oauth.available(cfg)) throw new HttpError(400, 'Salve as credenciais do aplicativo antes de conectar');
    const state = randomToken(16);
    store.saveOAuthState(state, `source:${c.id}`);
    return { url: c.oauth.authorizeUrl({ cfg, state, redirectUri: source.redirectUri(c.id) }) };
  });

  r.post('/api/source/disconnect', requireAdmin, async () => {
    store.setSecretSetting('source_tokens', null);
    store.log('info', 'Origem desconectada');
    return source.summary();
  });

  // Captura agora (manual).
  r.post('/api/source/import', requireAdmin, async () => {
    try {
      return await source.importFromSource();
    } catch (e) {
      throw new HttpError(400, `Falha na captura: ${e.message}`);
    }
  });

  // ---------- Integração: destinos (os 3 cards) ----------
  r.get('/api/platforms', requireAdmin, async () => platforms.ids().map(platforms.summary));

  r.put('/api/platforms/:id/credentials', requireAdmin, async (ctx) => {
    const p = platforms.get(ctx.params.id);
    const body = await readJson(ctx.req);
    const prev = store.getCredentials(p.id) || {};
    const creds = {};
    for (const f of p.credentialFields) {
      let v = body[f.key];
      if (f.type === 'password' && (v === undefined || String(v).startsWith('••••••'))) v = prev[f.key];
      v = v === undefined || v === null ? '' : String(v).trim();
      if (f.required && !v) throw new HttpError(400, `Campo obrigatório: ${f.label}`);
      creds[f.key] = v || f.default || '';
    }
    // Trocar o app (client_id/partner_id/app_key) invalida os tokens antigos.
    const idKey = p.credentialFields[0].key;
    if (prev[idKey] && prev[idKey] !== creds[idKey]) store.setTokens(p.id, null);
    store.setCredentials(p.id, creds);
    store.log('info', 'Credenciais atualizadas', { platform: p.id });
    return platforms.summary(p.id);
  });

  r.post('/api/platforms/:id/authorize', requireAdmin, async (ctx) => {
    const p = platforms.get(ctx.params.id);
    const creds = store.getCredentials(p.id);
    if (!creds) throw new HttpError(400, 'Salve as credenciais antes de conectar');
    const state = randomToken(16);
    store.saveOAuthState(state, p.id);
    return { url: p.authorizeUrl({ creds, redirectUri: platforms.redirectUri(p.id), state }) };
  });

  r.post('/api/platforms/:id/enable', requireAdmin, async (ctx) => {
    const p = platforms.get(ctx.params.id);
    const { enabled } = await readJson(ctx.req);
    store.setEnabled(p.id, !!enabled);
    if (enabled) {
      // Produtos já selecionados para este destino e ainda não enviados entram na fila.
      const pending = store.open().prepare(
        `SELECT sku FROM listings WHERE platform = ? AND status IN ('pending', 'error', 'skipped')`,
      ).all(p.id);
      for (const row of pending) store.enqueue(p.id, row.sku);
    }
    return platforms.summary(p.id);
  });

  r.post('/api/platforms/:id/test', requireAdmin, async (ctx) => {
    const ctxP = await platforms.context(ctx.params.id);
    const res = await ctxP.platform.test(ctxP);
    store.setTokens(ctx.params.id, { ...store.getTokens(ctx.params.id), account: res.account });
    return res;
  });

  r.post('/api/platforms/:id/disconnect', requireAdmin, async (ctx) => {
    platforms.get(ctx.params.id);
    store.setTokens(ctx.params.id, null);
    store.setEnabled(ctx.params.id, false);
    store.log('info', 'Conta desconectada', { platform: ctx.params.id });
    return platforms.summary(ctx.params.id);
  });

  // ---------- Produtos capturados ----------
  r.get('/api/products', requireAdmin, async (ctx) => {
    const q = ctx.url.searchParams;
    const data = store.listProducts({
      limit: Math.min(500, Number(q.get('limit') || 100)),
      offset: Number(q.get('offset') || 0),
      search: q.get('q') || '',
      filter: q.get('filter') || 'all',
    });
    return withSalePrice(data);
  });

  // Detalhe completo (tela Sincronização): dados, mídia, vínculos, fila e log.
  r.get('/api/products/:sku', requireAdmin, async (ctx) => {
    const p = store.getProduct(ctx.params.sku);
    if (!p) throw new HttpError(404, 'Produto não encontrado');
    const listings = {};
    for (const id of platforms.ids()) {
      const l = store.getListing(id, p.sku);
      if (l) {
        const { images, video, size_chart: chart, ...meta } = l.meta || {};
        listings[id] = { ...l, meta, outdated: l.status === 'synced' && l.last_hash !== store.syncHashOf(p), mediaSent: images ? Object.keys(images).length : 0 };
      }
    }
    return {
      product: p.data, origin: p.origin, capturedAt: p.captured_at, updatedAt: p.updated_at,
      listings, jobs: store.jobsFor(p.sku), logs: store.listLogs({ sku: p.sku, limit: 50 }),
    };
  });

  // Enviar para integração: seleciona os produtos nos destinos e enfileira.
  r.post('/api/integrations/send', requireAdmin, async (ctx) => {
    const body = await readJson(ctx.req);
    const skus = list(body.skus);
    const targets = list(body.platforms);
    if (!skus.length) throw new HttpError(400, 'Selecione ao menos um produto');
    if (!targets.length) throw new HttpError(400, 'Selecione ao menos um destino');
    for (const id of targets) {
      const s = platforms.summary(id);
      if (!s.connected) throw new HttpError(400, `${s.name}: conecte a conta na tela Integração`);
      if (!s.enabled) throw new HttpError(400, `${s.name}: ative o destino na tela Integração`);
    }
    const queued = targets.reduce((n, id) => n + engine.enqueueAll(id, skus), 0);
    store.log('info', `Enviados para integração: ${skus.length} produto(s) → ${targets.join(', ')}`);
    return { queued };
  });

  // Parar de sincronizar (sem anúncio: desfaz a seleção; com anúncio: pausa).
  r.post('/api/integrations/stop', requireAdmin, async (ctx) => {
    const body = await readJson(ctx.req);
    const skus = list(body.skus);
    const targets = list(body.platforms).length ? list(body.platforms) : platforms.ids();
    for (const id of targets) for (const sku of skus) store.unselect(id, sku);
    return { ok: true };
  });

  // Prévia de como os produtos vão subir (sem enviar nada).
  r.post('/api/preview', requireAdmin, async (ctx) => {
    const body = await readJson(ctx.req);
    const skus = list(body.skus);
    const targets = list(body.platforms).filter((id) => platforms.ids().includes(id));
    if (!skus.length || !targets.length) throw new HttpError(400, 'Informe produtos e destinos');
    if (skus.length > 20) throw new HttpError(400, 'Prévia de no máximo 20 produtos por vez');
    return previewProducts(skus, targets);
  });

  // ---------- Sincronização ----------
  r.get('/api/sync', requireAdmin, async (ctx) => {
    const q = ctx.url.searchParams;
    const data = store.listSync({
      limit: Math.min(500, Number(q.get('limit') || 100)),
      offset: Number(q.get('offset') || 0),
      search: q.get('q') || '',
      platform: q.get('platform') || '',
      status: q.get('status') || '',
    });
    return { ...withSalePrice(data), counts: store.syncCounts(), jobs: store.jobStats(), lastCapture: store.getSetting('last_capture', null) };
  });

  // Reenviar: força o envio dos selecionados (ou de todos já selecionados).
  r.post('/api/sync', requireAdmin, async (ctx) => {
    const { platform, skus } = await readJson(ctx.req);
    if (platform) platforms.get(platform);
    return { queued: engine.enqueueAll(platform || null, skus && skus.length ? list(skus) : null) };
  });

  r.get('/api/jobs', requireAdmin, async () => ({ stats: store.jobStats(), items: store.listJobs(200) }));
  r.post('/api/jobs/clear', requireAdmin, async () => { store.clearFinishedJobs(); return { ok: true }; });
  r.get('/api/logs', requireAdmin, async (ctx) => store.listLogs({ platform: ctx.url.searchParams.get('platform') || null }));

  r.post('/api/apikey/rotate', requireAdmin, async () => {
    const apiKey = `azh_${randomToken(24)}`;
    store.setSetting('apiKeyHash', sha256(apiKey));
    store.log('info', 'Chave de API regenerada');
    return { apiKey };
  });

  // ---------- API para o site (origem "API própria") ----------
  // ?send=shopee,tiktok (ou "all") já envia para integração nesses destinos.
  r.post('/api/v1/products', requireApiKeyOrAdmin, async (ctx) => {
    const body = await readJson(ctx.req);
    const products = Array.isArray(body) ? body : Array.isArray(body.products) ? body.products : [body];
    if (products.length > 1000) throw new HttpError(413, 'Envie no máximo 1000 produtos por requisição');
    let sendTo = list(ctx.url.searchParams.get('send'));
    if (sendTo.includes('all')) sendTo = platforms.ids();
    for (const id of sendTo) platforms.get(id);
    return source.ingest(products, 'api', { sendTo });
  });

  r.delete('/api/v1/products/:sku', requireApiKeyOrAdmin, async (ctx) => {
    // Desativar: zera o estoque/deslista nos destinos, sem apagar anúncios.
    const p = store.getProduct(ctx.params.sku);
    if (!p) throw new HttpError(404, 'Produto não encontrado');
    return source.ingest([{ ...p.data, active: false, stock: 0 }], p.origin);
  });

  r.get('/api/v1/products/:sku', requireApiKeyOrAdmin, async (ctx) => {
    const p = store.getProduct(ctx.params.sku);
    if (!p) throw new HttpError(404, 'Produto não encontrado');
    const listings = Object.fromEntries(platforms.ids().map((id) => [id, store.getListing(id, p.sku)]));
    return { ...p.data, origin: p.origin, updatedAt: p.updated_at, listings };
  });

  // ---------- retornos de OAuth ----------
  r.get('/oauth/source/:id/callback', async (ctx) => {
    const query = Object.fromEntries(ctx.url.searchParams);
    const st = store.consumeOAuthState(query.state);
    const id = ctx.params.id;
    if (!st || st.platform !== `source:${id}`) {
      return redirect(ctx.res, `/#oauth=erro&p=origem&msg=${encodeURIComponent('Link de autorização expirado ou inválido. Tente conectar de novo.')}`);
    }
    try {
      const cfg = source.getSource();
      const c = source.connectors.get(id);
      if (!cfg || cfg.type !== id) throw new Error('A origem configurada mudou durante a autorização');
      const tokens = await c.oauth.handleCallback({ cfg, query, redirectUri: source.redirectUri(id) });
      store.setSecretSetting('source_tokens', tokens);
      store.log('info', `Origem ${c.name} conectada`);
      return redirect(ctx.res, '/#oauth=ok&p=origem');
    } catch (e) {
      store.log('error', `Falha ao conectar a origem: ${e.message}`);
      return redirect(ctx.res, `/#oauth=erro&p=origem&msg=${encodeURIComponent(e.message)}`);
    }
  });

  r.get('/oauth/:id/callback', async (ctx) => {
    const query = Object.fromEntries(ctx.url.searchParams);
    const st = store.consumeOAuthState(query.state);
    const id = ctx.params.id;
    if (!st || st.platform !== id) {
      return redirect(ctx.res, `/#oauth=erro&msg=${encodeURIComponent('Link de autorização expirado ou inválido. Tente conectar de novo.')}`);
    }
    try {
      const p = platforms.get(id);
      const creds = store.getCredentials(id);
      const tokens = await p.handleCallback({ creds, query, redirectUri: platforms.redirectUri(id) });
      store.setTokens(id, tokens);
      try {
        const info = await p.test({ creds, tokens, platform: p });
        store.setTokens(id, { ...tokens, account: info.account });
      } catch { /* conta conectada mesmo que o teste falhe */ }
      store.log('info', 'Conta conectada', { platform: id });
      return redirect(ctx.res, `/#oauth=ok&p=${id}`);
    } catch (e) {
      store.log('error', `Falha ao conectar: ${e.message}`, { platform: id });
      return redirect(ctx.res, `/#oauth=erro&p=${id}&msg=${encodeURIComponent(e.message)}`);
    }
  });
}

module.exports = { register, requireAdmin };
