'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { normalizeProduct, validateProduct } = require('../src/source/normalize');
const shopee = require('../src/platforms/shopee');
const tiktok = require('../src/platforms/tiktok');
const ml = require('../src/platforms/mercadolivre');
const { youtubeId } = require('../src/lib/media');

test('normaliza colunas SQL e valores no formato brasileiro', () => {
  const p = normalizeProduct({
    sku: 'A1', nome: 'Caneca', preco: 'R$ 1.234,50', promo_price: '999,90', estoque: '7',
    images: 'https://x/1.jpg, https://x/2.jpg|https://x/1.jpg', videos: '["https://x/v.mp4"]', ativo: '1',
  });
  assert.equal(p.title, 'Caneca');
  assert.equal(p.price, 1234.5);
  assert.equal(p.promoPrice, 999.9);
  assert.equal(p.stock, 7);
  assert.deepEqual(p.images, ['https://x/1.jpg', 'https://x/2.jpg']);
  assert.deepEqual(p.videos, ['https://x/v.mp4']);
  assert.equal(p.active, true);
  assert.deepEqual(validateProduct(p), []);
});

test('descarta promoção maior ou igual ao preço e valida obrigatórios', () => {
  const p = normalizeProduct({ sku: 'B', title: 'X', price: 10, promoPrice: 12 });
  assert.equal(p.promoPrice, null);
  assert.ok(validateProduct(p).some((e) => e.includes('imagem')));
  assert.ok(validateProduct(normalizeProduct({})).length >= 3);
});

test('assinatura Shopee = HMAC(partner_key, partner_id+path+ts+token+shop)', () => {
  const creds = { partner_id: '1001', partner_key: 'segredo' };
  const expected = crypto.createHmac('sha256', 'segredo').update('1001/api/v2/product/add_item1700000000TOK42').digest('hex');
  assert.equal(shopee._internal.sign(creds, '/api/v2/product/add_item', 1700000000, 'TOK', '42'), expected);
});

test('assinatura TikTok ordena params, ignora sign/access_token e envolve com o secret', () => {
  const params = { timestamp: '1700000000', app_key: 'k', shop_cipher: 'c', access_token: 'nao', sign: 'nao' };
  const body = '{"a":1}';
  const base = '/product/202309/products' + 'app_keyk' + 'shop_cipherc' + 'timestamp1700000000' + body;
  const expected = crypto.createHmac('sha256', 's').update(`s${base}s`).digest('hex');
  assert.equal(tiktok._internal.sign('s', '/product/202309/products', params, body), expected);
});

test('descrição do Mercado Livre vira texto puro', () => {
  assert.equal(ml._internal.plainText('<p>Olá &amp; bem-vindo</p><ul><li>Um</li></ul>'), 'Olá & bem-vindo\n• Um');
});

test('extrai id de vídeo do YouTube', () => {
  assert.equal(youtubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://site.com/v.mp4'), null);
});
