'use strict';
// Fluxo do painel pela API: origem → captura → Produtos → Prévia → envio →
// Sincronização (grade e detalhe) → parar de sincronizar.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurehub-hub-'));
process.env.HUB_DATA_DIR = dir;
process.env.HUB_SECRET = 'teste';
process.env.PUBLIC_URL = 'http://hub.test';

const { DatabaseSync } = require('node:sqlite');
const { createServer } = require('../src/server');
const store = require('../src/lib/store');

const shopDb = path.join(dir, 'loja.db');
const db = new DatabaseSync(shopDb);
db.exec(`CREATE TABLE p (parent_sku TEXT, sku TEXT, nome TEXT, preco TEXT, estoque INT, imagens TEXT, cor TEXT, tam TEXT);
  INSERT INTO p VALUES ('TEN', 'TEN-P-40', 'Tênis Corrida Run', '299,90', 5, 'https://site.test/t.jpg', 'Preto', '40');
  INSERT INTO p VALUES ('TEN', 'TEN-P-41', 'Tênis Corrida Run', '299,90', 3, 'https://site.test/t.jpg', 'Preto', '41');
  INSERT INTO p VALUES (NULL, 'GAR', 'Garrafa Térmica Inox', '89,90', 30, 'https://site.test/g.jpg', NULL, NULL);
  INSERT INTO p VALUES (NULL, 'RUIM', 'Sem foto', '10', 1, NULL, NULL, NULL);`);
db.close();
const QUERY = 'SELECT parent_sku, sku, nome AS title, preco AS price, estoque AS stock, imagens AS images, cor AS option_Cor, tam AS option_Tamanho FROM p';

let server;
let base;
let cookie = '';
async function call(method, url, body) {
  const res = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual',
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}

test.before(async () => {
  server = createServer();
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('instala com origem "Banco de dados" e a captura só grava (não enfileira)', async () => {
  const cat = await call('GET', '/api/sources');
  assert.deepEqual(cat.body.map((c) => c.id).sort(), ['api', 'bling', 'database', 'nuvemshop', 'shopify', 'woocommerce']);
  const bad = await call('POST', '/api/install', { email: 'a@b.com', password: '12345678', source: { type: 'database', engine: 'sqlite', database: '/nao/existe.db', query: QUERY } });
  assert.equal(bad.status, 400, 'origem inacessível bloqueia a instalação');
  const r = await call('POST', '/api/install', { email: 'a@b.com', password: '12345678', source: { type: 'database', engine: 'sqlite', database: shopDb, query: QUERY } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const cap = await call('POST', '/api/source/import');
  assert.deepEqual([cap.body.received, cap.body.changed, cap.body.invalid.length, cap.body.queued], [3, 2, 1, 0]);
  assert.match(cap.body.invalid[0].errors.join(), /imagem/);
  const src = await call('GET', '/api/source');
  assert.equal(src.body.lastCapture.received, 3);
  assert.equal(store.jobStats().queued || 0, 0);
});

test('Produtos: grade sem mídia, com contagem de variações e filtros', async () => {
  const r = await call('GET', '/api/products?filter=not_sent');
  assert.equal(r.body.total, 2);
  const ten = r.body.items.find((i) => i.sku === 'TEN');
  assert.deepEqual([ten.variants, ten.stock, ten.images], [2, 8, 1]);
  assert.equal(ten.image, undefined, 'a grade não traz URL de foto');
  assert.equal((await call('GET', '/api/products?filter=sent')).body.total, 0);
});

test('Prévia offline e envio exige destino conectado e ativo', async () => {
  const pv = await call('POST', '/api/preview', { skus: ['TEN', 'GAR'], platforms: ['shopee', 'mercadolivre'] });
  assert.equal(pv.status, 200);
  const ten = pv.body.items.find((i) => i.sku === 'TEN');
  assert.equal(ten.platforms.shopee.ready, true);
  assert.equal(ten.platforms.shopee.connected, false);
  assert.equal(ten.platforms.mercadolivre.ready, false, 'ML ainda não publica variações');
  assert.equal(ten.platforms.shopee.action, 'criar');

  let s = await call('POST', '/api/integrations/send', { skus: ['GAR'], platforms: ['shopee'] });
  assert.equal(s.status, 400);
  assert.match(s.body.error, /conecte a conta/);
  store.setCredentials('shopee', { partner_id: '1', partner_key: 'k', environment: 'sandbox', region: 'BR' });
  store.setTokens('shopee', { access_token: 'AT', refresh_token: 'RT', shop_id: '42', expires_at: Date.now() + 3600e3 });
  s = await call('POST', '/api/integrations/send', { skus: ['GAR'], platforms: ['shopee'] });
  assert.match(s.body.error, /ative o destino/);
  store.setEnabled('shopee', true);
  s = await call('POST', '/api/integrations/send', { skus: ['GAR', 'TEN'], platforms: ['shopee'] });
  assert.equal(s.body.queued, 2);
  assert.equal(store.jobStats().queued, 2);
});

test('Sincronização: grade com status, desatualizados, fila e detalhe completo', async () => {
  const g = store.getProduct('GAR');
  store.saveListing('shopee', 'GAR', { external_id: '555', status: 'synced', last_hash: g.hash, last_sync: store.now(), meta: { permalink: 'https://shopee.com.br/product/42/555' } });
  let r = await call('GET', '/api/sync?platform=shopee');
  assert.equal(r.body.total, 2);
  assert.deepEqual(r.body.counts, { total: 2, pending: 1, synced: 1, error: 0, skipped: 0, paused: 0, outdated: 0 });
  const gar = r.body.items.find((i) => i.sku === 'GAR');
  assert.deepEqual([gar.status, gar.externalId, gar.permalink, gar.outdated, gar.job], ['synced', '555', 'https://shopee.com.br/product/42/555', false, 'queued']);

  // Muda na origem → captura → vira "desatualizado" e volta para a fila (já estava selecionado).
  const d = new DatabaseSync(shopDb);
  d.exec(`UPDATE p SET preco = '79,90' WHERE sku = 'GAR'`);
  d.close();
  const cap = await call('POST', '/api/source/import');
  assert.equal(cap.body.changed, 1);
  r = await call('GET', '/api/sync?status=outdated');
  assert.deepEqual(r.body.items.map((i) => i.sku), ['GAR']);

  const det = await call('GET', '/api/products/TEN');
  assert.equal(det.body.product.variants.length, 2);
  assert.deepEqual(det.body.product.images, ['https://site.test/t.jpg'], 'o detalhe traz a mídia');
  assert.equal(det.body.listings.shopee.status, 'pending');
  assert.ok(det.body.logs.length >= 0);
});

test('Parar de sincronizar: sem anúncio sai da integração; com anúncio fica pausado', async () => {
  await call('POST', '/api/integrations/stop', { skus: ['TEN', 'GAR'], platforms: ['shopee'] });
  assert.equal(store.getListing('shopee', 'TEN'), null);
  assert.equal(store.getListing('shopee', 'GAR').status, 'paused');
  const r = await call('GET', '/api/sync');
  assert.equal(r.body.counts.paused, 1);
  // Pausado não volta para a fila em uma nova mudança.
  const d = new DatabaseSync(shopDb);
  d.exec(`UPDATE p SET preco = '69,90' WHERE sku = 'GAR'`);
  d.close();
  const cap = await call('POST', '/api/source/import');
  assert.equal(cap.body.queued, 0);
  // Reenviar reativa.
  const s = await call('POST', '/api/sync', { platform: 'shopee', skus: ['GAR'] });
  assert.equal(s.body.queued, 1);
  assert.equal(store.getListing('shopee', 'GAR').status, 'synced');
});
