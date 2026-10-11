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
  require('./routes/api').register(router);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    const m = router.match(req.method, url.pathname);
    if (!m) {
      if (req.method === 'GET' && serveStatic(PUBLIC, req, res, url.pathname)) return;
      return send(res, 404, { error: 'Rota não encontrada' });
    }
    const ctx = { req, res, url, params: m.params };
    try {
      let result;
      for (const h of m.handlers) result = await h(ctx);
      if (!res.headersSent) send(res, 200, result ?? { ok: true });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e.status && e.status < 500 ? 400 : 500;
      if (status >= 500) console.error(e);
      send(res, status, { error: e.message, details: e.details });
    }
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(config.port, config.host, () => {
    console.log(`AzureHub ${config.VERSION} em ${config.publicUrl} (porta ${config.port})`);
  });
  engine.start();
  const shutdown = () => {
    engine.stop();
    server.close(() => { store.close(); process.exit(0); });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer };
