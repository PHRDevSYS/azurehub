'use strict';
const store = require('../lib/store');
const config = require('../config');
const { HttpError, readJson, redirect, parseCookies } = require('../lib/http');
const { hashPassword, verifyPassword, sha256, randomToken, safeEqual } = require('../lib/crypto');
const platforms = require('../platforms');
const source = require('../source');
const engine = require('../sync/engine');

const COOKIE = 'azurehub_session';
const installed = () => !!store.getSetting('installed');

// ---------- middlewares ----------
function requireInstalled(ctx) {
  if (!installed()) throw new HttpError(409, 'Hub ainda não instalado');
}
function requireAdmin(ctx) {
  requireInstalled(ctx);
  const token = parseCookies(ctx.req)[COOKIE];
  if (!token || !store.sessionValid(sha256(token))) throw new HttpError(401, 'Faça login');
}
// Site integrado: X-Api-Key. A sessão do painel também é aceita.
function requireApiKeyOrAdmin(ctx) {
  requireInstalled(ctx);
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

function cleanSource(s) {
  if (!s || !['mysql', 'postgres', 'sqlite', 'api'].includes(s.type)) throw new HttpError(400, 'Tipo de banco inválido');
  const out = { type: s.type };
  if (s.type !== 'api') {
    for (const k of ['host', 'port', 'user', 'password', 'database', 'query', 'ssl']) out[k] = s[k];
    if (!out.database) throw new HttpError(400, 'Informe o banco de dados');
    if (!out.query) throw new HttpError(400, 'Informe a consulta de produtos');
    if (s.type !== 'sqlite' && !out.host) throw new HttpError(400, 'Informe o host do banco');
  }
  return out;
}

function maskSource(s) {
  if (!s) return null;
  return { ...s, password: s.password ? '••••••' : '' };
}

function register(r) {
  // ---------- status / instalação ----------
  r.get('/api/status', async () => ({
    installed: installed(), version: config.VERSION, publicUrl: config.publicUrl,
  }));

  r.get('/api/source/presets', async () => source.PRESETS);

  r.post('/api/source/test', async (ctx) => {
    if (installed()) requireAdmin(ctx);
    const body = await readJson(ctx.req);
    let s = cleanSource(body);
    // Senha mascarada = manter a já salva.
    if (installed() && s.password === '••••••') s.password = (store.getSecretSetting('source') || {}).password;
    try {
      return await source.testSource(s);
    } catch (e) {
      throw new HttpError(400, `Falha ao consultar a fonte: ${e.message}`);
    }
  });

  r.post('/api/install', async (ctx) => {
    if (installed()) throw new HttpError(409, 'Hub já instalado');
    const body = await readJson(ctx.req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'E-mail inválido');
    if (password.length < 8) throw new HttpError(400, 'A senha precisa de ao menos 8 caracteres');
    const s = cleanSource(body.source);
    if (s.type !== 'api') {
      try { await source.testSource(s); } catch (e) { throw new HttpError(400, `Falha ao consultar a fonte: ${e.message}`); }
    }
    const apiKey = `azh_${randomToken(24)}`;
    store.setSetting('admin', { email, hash: hashPassword(password) });
    store.setSecretSetting('source', s);
    store.setSetting('apiKeyHash', sha256(apiKey));
    store.setSetting('autoImportMinutes', Number(body.autoImportMinutes || 0));
    for (const id of platforms.ids()) store.ensurePlatform(id);
    store.setSetting('installed', true);
    store.log('info', `Hub instalado (fonte: ${s.type})`);
    engine.scheduleAutoImport();
    setSession(ctx);
    return { ok: true, apiKey };
  });

  // ---------- sessão ----------
  r.post('/api/login', async (ctx) => {
    requireInstalled(ctx);
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

  // ---------- plataformas (os 3 cards) ----------
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
      // Produtos ainda não enviados para esta plataforma entram na fila.
      const pending = store.open().prepare(
        `SELECT sku FROM products WHERE sku NOT IN (SELECT sku FROM listings WHERE platform = ? AND status = 'synced')`,
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

  // ---------- produtos ----------
  // Endpoint de integração para qualquer site: aceita 1 produto ou lista.
  r.post('/api/v1/products', requireApiKeyOrAdmin, async (ctx) => {
    const body = await readJson(ctx.req);
    const list = Array.isArray(body) ? body : Array.isArray(body.products) ? body.products : [body];
    if (list.length > 1000) throw new HttpError(413, 'Envie no máximo 1000 produtos por requisição');
    return source.ingest(list, 'api');
  });

  r.delete('/api/v1/products/:sku', requireApiKeyOrAdmin, async (ctx) => {
    // Remover do hub não apaga anúncios: zera o estoque antes, via sync.
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

  r.get('/api/products', requireAdmin, async (ctx) => {
    const q = ctx.url.searchParams;
    return store.listProducts({
      limit: Math.min(200, Number(q.get('limit') || 50)),
      offset: Number(q.get('offset') || 0),
      search: q.get('q') || '',
    });
  });

  // ---------- fonte / sincronização ----------
  r.get('/api/source', requireAdmin, async () => ({
    source: maskSource(store.getSecretSetting('source')),
    autoImportMinutes: store.getSetting('autoImportMinutes', 0),
  }));

  r.put('/api/source', requireAdmin, async (ctx) => {
    const body = await readJson(ctx.req);
    const s = cleanSource(body.source);
    if (s.password === '••••••') s.password = (store.getSecretSetting('source') || {}).password;
    if (s.type !== 'api') {
      try { await source.testSource(s); } catch (e) { throw new HttpError(400, `Falha ao consultar a fonte: ${e.message}`); }
    }
    store.setSecretSetting('source', s);
    store.setSetting('autoImportMinutes', Number(body.autoImportMinutes || 0));
    engine.scheduleAutoImport();
    return { ok: true };
  });

  r.post('/api/source/import', requireAdmin, async () => {
    try {
      return await source.importFromSource();
    } catch (e) {
      throw new HttpError(400, `Falha na importação: ${e.message}`);
    }
  });

  r.post('/api/sync', requireAdmin, async (ctx) => {
    const { platform, skus } = await readJson(ctx.req);
    if (platform) platforms.get(platform);
    return { queued: engine.enqueueAll(platform || null, skus) };
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

  // ---------- retorno do OAuth ----------
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

module.exports = { register };
