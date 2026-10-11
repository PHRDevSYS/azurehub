'use strict';
// Publicação na Shopee com a API simulada: confere upload de
// fotos/vídeo, corpo do anúncio e promoção. Também testa a fonte SQLite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const shopee = require('../src/platforms/shopee');
const { normalizeProduct } = require('../src/source/normalize');
const source = require('../src/source');

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

const product = normalizeProduct({
  sku: 'P1', title: 'Fone Bluetooth', description: 'Som limpo\n\nBateria 20h', price: 199.9, promoPrice: 149.9,
  stock: 3, weightKg: 0.2, lengthCm: 15, widthCm: 10, heightCm: 5,
  images: ['https://site.test/a.jpg'], videos: ['https://site.test/v.mp4'],
  categories: { shopee: 100535, tiktok: '601739' },
});

const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });

function mock(routes) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const u = new URL(url);
    let body = null;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    calls.push({ method: init.method || 'GET', path: u.pathname, query: u.searchParams, body, form: init.body instanceof FormData });
    if (u.hostname === 'site.test') {
      return new Response(Buffer.alloc(u.pathname.endsWith('.mp4') ? 5 * 1024 * 1024 : 1024), {
        headers: { 'Content-Type': u.pathname.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg' },
      });
    }
    const handler = routes[u.pathname];
    return json(handler ? handler(u, body) : { code: 0, data: {} });
  };
  return calls;
}

test('Shopee: sobe foto, vídeo em partes, cria anúncio e aplica desconto', async () => {
  const calls = mock({
    '/api/v2/media_space/upload_image': () => ({ response: { image_info: { image_id: 'IMG1' } } }),
    '/api/v2/media_space/init_video_upload': () => ({ response: { video_upload_id: 'VID1' } }),
    '/api/v2/media_space/get_video_upload_result': () => ({ response: { status: 'SUCCEEDED' } }),
    '/api/v2/logistics/get_channel_list': () => ({ response: { logistics_channel_list: [{ logistics_channel_id: 9, enabled: true }] } }),
    '/api/v2/product/add_item': () => ({ response: { item_id: 777 } }),
    '/api/v2/discount/add_discount': () => ({ response: { discount_id: 55 } }),
  });
  const ctx = { creds: { partner_id: '1', partner_key: 'k', environment: 'sandbox' }, tokens: { access_token: 'AT', shop_id: '42' } };
  const res = await shopee.publish(ctx, product, null);

  assert.equal(res.externalId, '777');
  assert.deepEqual(res.warnings, []);
  const parts = calls.filter((c) => c.path === '/api/v2/media_space/upload_video_part');
  assert.equal(parts.length, 2, 'vídeo de 5 MB = 2 partes de 4 MB');
  const add = calls.find((c) => c.path === '/api/v2/product/add_item');
  assert.equal(add.query.get('shop_id'), '42');
  assert.ok(add.query.get('sign'));
  assert.equal(add.body.original_price, 199.9);
  assert.equal(add.body.category_id, 100535);
  assert.deepEqual(add.body.image.image_id_list, ['IMG1']);
  assert.deepEqual(add.body.video_upload_id, ['VID1']);
  assert.deepEqual(add.body.seller_stock, [{ stock: 3 }]);
  assert.deepEqual(add.body.logistic_info, [{ logistic_id: 9, enabled: true }]);
  const di = calls.find((c) => c.path === '/api/v2/discount/add_discount_item');
  assert.equal(di.body.item_list[0].item_promotion_price, 149.9);

  // Segunda publicação: atualiza, sem reenviar a mesma foto/vídeo.
  const calls2 = mock({});
  await shopee.publish(ctx, product, { external_id: '777', meta: { images: res.meta.images, video: res.meta.video, promo: res.meta.promo } });
  assert.ok(!calls2.some((c) => c.path.includes('media_space')));
  assert.ok(calls2.some((c) => c.path === '/api/v2/product/update_item'));
  assert.ok(calls2.some((c) => c.path === '/api/v2/discount/update_discount_item'));
});

test('Shopee: erro no corpo (HTTP 200) vira exceção', async () => {
  mock({
    '/api/v2/media_space/upload_image': () => ({ response: { image_info: { image_id: 'IMG1' } } }),
    '/api/v2/product/add_item': () => ({ error: 'product.error_param', message: 'categoria inválida' }),
  });
  const ctx = { creds: { partner_id: '1', partner_key: 'k', logistic_ids: '1' }, tokens: { access_token: 'AT', shop_id: '42' } };
  await assert.rejects(shopee.publish(ctx, { ...product, videos: [] }, null), /categoria inválida/);
});

test('fonte SQLite: consulta o banco do site e normaliza', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'src-')), 'loja.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE produtos (codigo TEXT, nome TEXT, preco TEXT, estoque INT, imagens TEXT);
           INSERT INTO produtos VALUES ('X1', 'Mesa', '350,00', 2, 'https://site.test/m1.jpg;https://site.test/m2.jpg');`);
  db.close();
  const res = await source.testSource({
    type: 'sqlite', database: file,
    query: 'SELECT codigo AS sku, nome AS title, preco AS price, estoque AS stock, imagens AS images FROM produtos',
  });
  assert.equal(res.count, 1);
  assert.equal(res.sample[0].product.price, 350);
  assert.equal(res.sample[0].product.images.length, 2);
  assert.deepEqual(res.sample[0].errors, []);
  await assert.rejects(source.testSource({ type: 'sqlite', database: file, query: 'DELETE FROM produtos' }), /SELECT/);
});
