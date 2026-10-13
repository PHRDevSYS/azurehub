'use strict';
const http = require('node:http');
const path = require('node:path');
const config = require('./config');
const store = require('./lib/store');
const { createRouter, send, serveStatic, HttpError } = require('./lib/http');
const engine = require('./sync/engine');

const PUBLIC = path.join(config.ROOT, 'public');

function createServer() {
  store.open();
  const router = createRouter();
  const api = require('./routes/api');
  api.register(router);
  require('./routes/pricing').register(router, { requireAdmin: api.requireAdmin });
  require('./routes/ugc').register(router, { requireAdmin: api.requireAdmin });
  require('./routes/ai').register(router, { requireAdmin: api.requireAdmin });

  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      const url = new URL(req.url, 'http://local');
      const m = router.match(req.method, url.pathname);
      if (!m) {
        if (req.method === 'GET' && serveStatic(PUBLIC, req, res, url.pathname)) return;
        return send(res, 404, { error: 'Rota não encontrada' });
      }
      checkSameSite(req, url.pathname);
      const ctx = { req, res, url, params: m.params };
      let result;
      for (const h of m.handlers) result = await h(ctx);
      if (!res.headersSent) send(res, 200, result ?? { ok: true });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e.status && e.status < 500 ? 400 : e instanceof TypeError && /Invalid URL/.test(e.message) ? 400 : 500;
      if (status >= 500) console.error(e);
      send(res, status, { error: e.message, details: e.details });
    }
  });
}

// CSRF: o painel usa cookie de sessão. Escrita vinda de outro site é
// recusada (Sec-Fetch-Site/Origin) e o corpo precisa ser JSON — um
// <form> de outro site não consegue mandar application/json.
// /api/v1 usa chave de API (não cookie) e fica de fora.
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
function checkSameSite(req, pathname) {
  if (SAFE.has(req.method) || !pathname.startsWith('/api/') || pathname.startsWith('/api/v1/')) return;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Requisição de outro site recusada');
  const origin = req.headers.origin;
  if (!site && origin && origin !== 'null') {
    let host;
    try { host = new URL(origin).host; } catch { throw new HttpError(403, 'Origem inválida'); }
    const allowed = [req.headers.host, req.headers['x-forwarded-host'], new URL(config.publicUrl).host].filter(Boolean);
    if (!allowed.includes(host)) throw new HttpError(403, 'Requisição de outro site recusada');
  }
  const hasBody = Number(req.headers['content-length'] || 0) > 0 || !!req.headers['transfer-encoding'];
  if (hasBody && !/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Envie o corpo como application/json');
}

if (require.main === module) {
  const server = createServer();
  server.listen(config.port, config.host, () => {
    console.log(`AzureHub ${config.VERSION} em ${config.publicUrl} (porta ${config.port})`);
  });
  engine.start();
  require('./ugc/runner').resume(); // gerações de mídia UGC interrompidas
  const shutdown = () => {
    engine.stop();
    server.close(() => { store.close(); process.exit(0); });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer };
