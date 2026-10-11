'use strict';
// Fluxo ponta a ponta com as APIs das plataformas simuladas (fetch mockado):
// instalação → envio de produto pela API → publicação no Mercado Livre.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurehub-'));
process.env.HUB_DATA_DIR = dir;
process.env.HUB_SECRET = 'teste';
process.env.PUBLIC_URL = 'http://hub.test';

const { createServer } = require('../src/server');
const store = require('../src/lib/store');
const engine = require('../src/sync/engine');

const realFetch = global.fetch;
let server;
let base;
let cookie = '';

async function call(method, url, body, headers = {}) {
  const res = await realFetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers },
    body: body ? JSON.stringify(body) : undefined, redirect: 'manual',
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

test.before(async () => {
  server = createServer();
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  global.fetch = realFetch;
  server.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let apiKey;

test('instala o hub (fonte somente API) e recusa segunda instalação', async () => {
  let r = await call('GET', '/api/status');
  assert.equal(r.body.installed, false);
  r = await call('POST', '/api/install', { email: 'adm@x.com', password: '12345678', source: { type: 'api' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  apiKey = r.body.apiKey;
  assert.match(apiKey, /^azh_/);
  r = await call('POST', '/api/install', { email: 'b@x.com', password: '12345678', source: { type: 'api' } });
  assert.equal(r.status, 409);
});

test('rotas do painel exigem sessão; login errado é recusado', async () => {
  const saved = cookie;
  cookie = '';
  assert.equal((await call('GET', '/api/platforms')).status, 401);
  assert.equal((await call('POST', '/api/login', { email: 'adm@x.com', password: 'errada' })).status, 401);
  assert.equal((await call('POST', '/api/login', { email: 'adm@x.com', password: '12345678' })).status, 200);
  assert.ok(cookie && cookie !== saved);
});

test('credenciais são cifradas e voltam mascaradas', async () => {
  const r = await call('PUT', '/api/platforms/mercadolivre/credentials', { client_id: '123', client_secret: 'supersecreto99' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.values.client_secret, '••••••to99');
  const raw = fs.readFileSync(path.join(dir, 'azurehub.db'));
  assert.ok(!raw.includes('supersecreto99'), 'segredo não pode aparecer em claro no banco');
  const list = await call('GET', '/api/platforms');
  assert.equal(list.body.length, 3);
});

test('API key inválida é recusada', async () => {
  const r = await realFetch(`${base}/api/v1/products`, { method: 'POST', headers: { 'X-Api-Key': 'azh_errada' }, body: '{}' });
  assert.equal(r.status, 401);
});

test('produto enviado pela API é publicado no Mercado Livre com preço, promoção, fotos e vídeo', async () => {
  store.setTokens('mercadolivre', { access_token: 'AT', refresh_token: 'RT', expires_at: Date.now() + 3600e3 });
  store.setEnabled('mercadolivre', true);

  const product = {
    sku: 'CAM-1', title: 'Camiseta Azul', description: '<p>Algodão</p>', brand: 'Azure',
    price: 89.9, promoPrice: 69.9, stock: 5, images: ['https://site.test/1.jpg', 'https://site.test/2.jpg'],
    videos: ['https://youtu.be/dQw4w9WgXcQ'], categories: { mercadolivre: 'MLB31447' },
  };
  const r = await realFetch(`${base}/api/v1/products`, {
    method: 'POST', headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(product),
  }).then((x) => x.json());
  assert.equal(r.changed, 1);
  assert.equal(store.jobStats().queued, 1);

  const calls = [];
  global.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization });
    const json = u.pathname === '/items' ? { id: 'MLB999', permalink: 'https://ml/MLB999' } : {};
    return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const job = store.open().prepare(`SELECT * FROM jobs WHERE status = 'queued'`).get();
  await engine.processJob({ ...job, attempts: 1 });
  global.fetch = realFetch;

  const create = calls.find((c) => c.method === 'POST' && c.path === '/items');
  assert.equal(create.auth, 'Bearer AT');
  assert.equal(create.body.price, 89.9);
  assert.equal(create.body.category_id, 'MLB31447');
  assert.equal(create.body.available_quantity, 5);
  assert.deepEqual(create.body.pictures, [{ source: 'https://site.test/1.jpg' }, { source: 'https://site.test/2.jpg' }]);
  assert.equal(create.body.video_id, 'dQw4w9WgXcQ');
  assert.ok(calls.some((c) => c.path === '/items/MLB999/description' && c.body.plain_text === 'Algodão'));
  const promo = calls.find((c) => c.path === '/seller-promotions/items/MLB999');
  assert.equal(promo.body.deal_price, 69.9);

  const listing = store.getListing('mercadolivre', 'CAM-1');
  assert.equal(listing.status, 'synced');
  assert.equal(listing.external_id, 'MLB999');

  // Reenviar o mesmo produto não gera job novo.
  const again = await realFetch(`${base}/api/v1/products`, {
    method: 'POST', headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(product),
  }).then((x) => x.json());
  assert.equal(again.unchanged, 1);
});

test('erro 429 da plataforma volta para a fila com backoff', async () => {
  store.enqueue('mercadolivre', 'CAM-1');
  store.saveListing('mercadolivre', 'CAM-1', { last_hash: null });
  global.fetch = async () => new Response('{"message":"too many requests"}', { status: 429 });
  const job = store.open().prepare(`SELECT * FROM jobs WHERE status = 'queued'`).get();
  await engine.processJob({ ...job, attempts: 1 });
  global.fetch = realFetch;
  const after = store.open().prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
  assert.equal(after.status, 'queued');
  assert.ok(new Date(after.run_after) > new Date());
});

test('motor: falha parcial guarda o id externo e follow-up volta à fila', async () => {
  const ml = require('../src/platforms').REGISTRY.mercadolivre;
  const original = ml.publish;
  try {
    store.saveListing('mercadolivre', 'CAM-1', { external_id: null, last_hash: null, meta: {} });
    store.open().prepare(`DELETE FROM listings WHERE platform = 'mercadolivre' AND sku = 'CAM-1'`).run();
    ml.publish = async () => {
      const e = new Error('variações falharam');
      e.partial = { externalId: 'MLB-PARCIAL', meta: { x: 1 } };
      throw e;
    };
    const id = store.enqueue('mercadolivre', 'CAM-1');
    await engine.processJob({ ...store.open().prepare('SELECT * FROM jobs WHERE id = ?').get(id), attempts: 1 });
    let l = store.getListing('mercadolivre', 'CAM-1');
    assert.equal(l.external_id, 'MLB-PARCIAL');
    assert.equal(l.status, 'error');

    ml.publish = async (ctx, p, listing) => {
      assert.equal(listing.external_id, 'MLB-PARCIAL', 'nova tentativa continua do item já criado');
      return { externalId: 'MLB-PARCIAL', meta: {}, warnings: [], followUpMs: 60000 };
    };
    const id2 = store.enqueue('mercadolivre', 'CAM-1');
    await engine.processJob({ ...store.open().prepare('SELECT * FROM jobs WHERE id = ?').get(id2), attempts: 1 });
    l = store.getListing('mercadolivre', 'CAM-1');
    assert.equal(l.status, 'synced');
    assert.equal(l.last_hash, null, 'follow-up não pode ser pulado como "sem alterações"');
    const next = store.open().prepare(`SELECT * FROM jobs WHERE platform = 'mercadolivre' AND sku = 'CAM-1' AND status = 'queued'`).get();
    assert.ok(next && new Date(next.run_after) > new Date(Date.now() + 50000));
  } finally {
    ml.publish = original;
  }
});
