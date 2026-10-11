'use strict';
// Conector TikTok Shop contra a API simulada, seguindo as regras da
// referência oficial (partner.tiktokshop.com/docv2).
const test = require('node:test');
const assert = require('node:assert/strict');
const tiktok = require('../src/platforms/tiktok');
const { normalizeProduct } = require('../src/source/normalize');

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; tiktok._internal.attrCache.clear(); });

const base = {
  sku: 'FONE 01', title: 'Fone Bluetooth', description: 'Som limpo\n\nBateria 20h', price: 199.9, promoPrice: 149.9,
  promoEnd: new Date(Date.now() + 7 * 86400e3).toISOString(),
  stock: 3, weightKg: 0.2345, lengthCm: 15.4, widthCm: 10, heightCm: 5, gtin: '7891234567895',
  images: ['https://site.test/a.jpg'], videos: ['https://site.test/meu video.final.mp4'],
  categories: { tiktok: '601739' }, attributes: { Material: 'Plástico', '100107': 'Sem marca' },
};
const product = (over = {}) => normalizeProduct({ ...base, ...over });
const ctx = () => ({ creds: { app_key: 'ak', app_secret: 'as', currency: 'BRL' }, tokens: { access_token: 'AT', shop_cipher: 'CIPH', region: 'BR' } });

const ATTRS = {
  code: 0,
  data: {
    attributes: [
      { id: '100100', name: 'Material', type: 'PRODUCT_PROPERTY', is_requried: true, values: [{ id: '9001', name: 'Plástico' }, { id: '9002', name: 'Metal' }] },
      { id: '100107', name: 'Marca', type: 'PRODUCT_PROPERTY', is_requried: false, is_customizable: true, values: [] },
      { id: '100089', name: 'Cor', type: 'SALES_PROPERTY', values: [] },
    ],
  },
};

function mock(routes = {}) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const form = init.body instanceof FormData ? init.body : null;
    calls.push({ method: init.method || 'GET', path: u.pathname, query: u.searchParams, body, form, headers: init.headers || {} });
    if (u.hostname === 'site.test') {
      return new Response(Buffer.alloc(2048), { headers: { 'Content-Type': u.pathname.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg' } });
    }
    const key = `${init.method || 'GET'} ${u.pathname}`;
    const handler = routes[key] || routes[u.pathname];
    const out = handler ? handler(u, body) : { code: 0, data: {} };
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

const createRoutes = () => ({
  '/product/202309/images/upload': () => ({ code: 0, data: { uri: 'tos-img' } }),
  '/product/202309/files/upload': () => ({ code: 0, data: { id: 'vid-9' } }),
  '/product/202309/categories/601739/attributes': () => ATTRS,
  '/logistics/202309/warehouses': () => ({ code: 0, data: { warehouses: [
    { id: 'W0', type: 'SALES_WAREHOUSE', effect_status: 'DISABLED', is_default: true },
    { id: 'W1', type: 'SALES_WAREHOUSE', effect_status: 'ENABLED' },
  ] } }),
  'POST /product/202309/products': () => ({ code: 0, data: { product_id: 'TT1', skus: [{ id: 'S1' }] } }),
  'POST /promotion/202309/activities': () => ({ code: 0, data: { activity_id: 'A1' } }),
});

test('cria produto conforme a referência: SKU, mídia, atributos, idempotência e promoção', async () => {
  const calls = mock(createRoutes());
  const res = await tiktok.publish(ctx(), product(), null);
  assert.equal(res.externalId, 'TT1');
  assert.deepEqual(res.warnings, []);

  // Vídeo: nome sem espaço, sem ponto extra, com extensão.
  const vid = calls.find((c) => c.path === '/product/202309/files/upload');
  assert.equal(vid.form.get('name'), 'video_FONE_01.mp4');
  assert.ok(!vid.query.has('shop_cipher'), 'upload não leva shop_cipher');
  assert.equal(calls.find((c) => c.path === '/product/202309/images/upload').form.get('use_case'), 'MAIN_IMAGE');

  const create = calls.find((c) => c.method === 'POST' && c.path === '/product/202309/products');
  assert.equal(create.query.get('shop_cipher'), 'CIPH');
  assert.equal(create.headers['x-tts-access-token'], 'AT');
  const b = create.body;
  assert.equal(b.category_id, '601739');
  assert.equal(b.category_version, undefined, 'BR usa a árvore v1 (padrão)');
  assert.deepEqual(b.main_images, [{ uri: 'tos-img' }]);
  assert.deepEqual(b.video, { id: 'vid-9' });
  assert.equal(b.skus[0].seller_sku, 'FONE-01');
  assert.equal(b.skus[0].external_sku_id, 'FONE 01');
  assert.deepEqual(b.skus[0].price, { amount: '199.90', currency: 'BRL' });
  assert.deepEqual(b.skus[0].inventory, [{ warehouse_id: 'W1', quantity: 3 }], 'usa armazém ENABLED');
  assert.deepEqual(b.skus[0].identifier_code, { code: '7891234567895', type: 'EAN' });
  assert.deepEqual(b.package_weight, { value: '0.235', unit: 'KILOGRAM' });
  assert.deepEqual(b.package_dimensions, { length: '15', width: '10', height: '5', unit: 'CENTIMETER' });
  assert.deepEqual(b.product_attributes, [
    { id: '100100', values: [{ id: '9001' }] },
    { id: '100107', values: [{ name: 'Sem marca' }] },
  ]);
  assert.match(b.idempotency_key, /^azh-[0-9a-f]{64}$/);
  assert.equal(b.description, '<p>Som limpo</p><p>Bateria 20h</p>');

  const act = calls.find((c) => c.path === '/promotion/202309/activities');
  assert.equal(act.body.activity_type, 'FIXED_PRICE');
  assert.equal(act.body.product_level, 'PRODUCT');
  assert.ok(act.body.end_time >= act.body.begin_time + 600);
  assert.ok(act.body.title.startsWith('AzureHub FONE 01 '));
  const ap = calls.find((c) => c.path === '/promotion/202309/activities/A1/products');
  assert.deepEqual(ap.body.products, [{ id: 'TT1', activity_price_amount: '149.90', quantity_limit: -1, quantity_per_user: -1, skus: [] }]);

  assert.equal(res.meta.sku_id, 'S1');
  assert.ok(res.meta.content_hash);
});

test('mesma requisição gera a mesma chave de idempotência', async () => {
  const c1 = mock(createRoutes());
  await tiktok.publish(ctx(), product({ promoPrice: null }), null);
  const k1 = c1.find((c) => c.path === '/product/202309/products').body.idempotency_key;
  const c2 = mock(createRoutes());
  await tiktok.publish(ctx(), product({ promoPrice: null }), null);
  assert.equal(c2.find((c) => c.path === '/product/202309/products').body.idempotency_key, k1);
});

test('atributo obrigatório ausente vira erro claro, sem criar o produto', async () => {
  const calls = mock(createRoutes());
  await assert.rejects(tiktok.publish(ctx(), product({ attributes: {} }), null), /exige os atributos "Material" \(id 100100: Plástico \/ Metal\)/);
  assert.ok(!calls.some((c) => c.path === '/product/202309/products'));
});

test('valor fora da lista em atributo não customizável é recusado', async () => {
  mock(createRoutes());
  await assert.rejects(tiktok.publish(ctx(), product({ attributes: { Material: 'Madeira' } }), null), /"Madeira" inválido para o atributo "Material"/);
});

test('sem estoque: não cria (estoque mínimo é 1) e adia a criação', async () => {
  const calls = mock(createRoutes());
  const res = await tiktok.publish(ctx(), product({ stock: 0 }), null);
  assert.equal(res.externalId, null);
  assert.equal(calls.length, 0);
});

test('categoria recomendada sem permissão para a loja é recusada', async () => {
  mock({
    ...createRoutes(),
    '/product/202309/categories/recommend': () => ({ code: 0, data: { leaf_category_id: '605254', categories: [{ id: '605254', name: 'Chás', is_leaf: true, permission_statuses: ['INVITE_ONLY'] }] } }),
  });
  await assert.rejects(tiktok.publish(ctx(), product({ categories: {} }), null), /Chás.*INVITE_ONLY/);
});

test('update só de preço e estoque não faz edição de conteúdo (sem nova auditoria)', async () => {
  const created = await (async () => { mock(createRoutes()); return tiktok.publish(ctx(), product({ promoPrice: null }), null); })();
  const listing = { external_id: 'TT1', meta: created.meta };
  const calls = mock(createRoutes());
  const res = await tiktok.publish(ctx(), product({ promoPrice: null, price: 179.9, stock: 8 }), listing);
  assert.equal(res.externalId, 'TT1');
  assert.ok(!calls.some((c) => c.path.endsWith('/partial_edit')), 'conteúdo igual não reaudita');
  assert.ok(!calls.some((c) => c.path.includes('/upload')), 'mídia já enviada não sobe de novo');
  const pr = calls.find((c) => c.path === '/product/202309/products/TT1/prices/update');
  assert.deepEqual(pr.body, { skus: [{ id: 'S1', price: { amount: '179.90', currency: 'BRL' } }] });
  const inv = calls.find((c) => c.path === '/product/202309/products/TT1/inventory/update');
  assert.deepEqual(inv.body, { skus: [{ id: 'S1', inventory: [{ warehouse_id: 'W1', quantity: 8 }] }] });
});

test('mudança de título usa Partial Edit 202509 sem identifier_code', async () => {
  mock(createRoutes());
  const created = await tiktok.publish(ctx(), product({ promoPrice: null }), null);
  const calls = mock(createRoutes());
  const res = await tiktok.publish(ctx(), product({ promoPrice: null, title: 'Fone Bluetooth Pro' }), { external_id: 'TT1', meta: created.meta });
  const pe = calls.find((c) => c.path === '/product/202509/products/TT1/partial_edit');
  assert.equal(pe.method, 'POST');
  assert.equal(pe.body.title, 'Fone Bluetooth Pro');
  assert.equal(pe.body.skus, undefined);
  assert.ok(res.warnings.some((w) => /auditoria/.test(w)));
});

test('estoque zerado desativa; estoque de volta atualiza e reativa', async () => {
  mock(createRoutes());
  const created = await tiktok.publish(ctx(), product({ promoPrice: null }), null);
  let calls = mock(createRoutes());
  const off = await tiktok.publish(ctx(), product({ promoPrice: null, stock: 0 }), { external_id: 'TT1', meta: created.meta });
  assert.deepEqual(calls.map((c) => c.path), ['/product/202309/products/deactivate']);
  assert.deepEqual(calls[0].body, { product_ids: ['TT1'] });

  calls = mock(createRoutes());
  const meta = { ...created.meta, ...off.meta };
  const on = await tiktok.publish(ctx(), product({ promoPrice: null, stock: 4 }), { external_id: 'TT1', meta });
  const paths = calls.map((c) => c.path);
  assert.ok(paths.indexOf('/product/202309/products/TT1/inventory/update') < paths.indexOf('/product/202309/products/activate'));
  assert.equal(on.meta.deactivated, false);
});

test('reativação com erro por produto (code 0 + data.errors) é tratada como falha', async () => {
  mock(createRoutes());
  const created = await tiktok.publish(ctx(), product({ promoPrice: null }), null);
  mock({ ...createRoutes(), '/product/202309/products/activate': () => ({ code: 0, data: { errors: [{ code: 12052990, message: 'Batch activate business error.' }] } }) });
  await assert.rejects(
    tiktok.publish(ctx(), product({ promoPrice: null }), { external_id: 'TT1', meta: { ...created.meta, deactivated: true } }),
    /não foi possível reativar/,
  );
});

test('promoção removida tira o produto da atividade', async () => {
  mock(createRoutes());
  const created = await tiktok.publish(ctx(), product(), null);
  const calls = mock(createRoutes());
  const res = await tiktok.publish(ctx(), product({ promoPrice: null }), { external_id: 'TT1', meta: created.meta });
  const del = calls.find((c) => c.method === 'DELETE' && c.path === '/promotion/202309/activities/A1/products');
  assert.deepEqual(del.body, { product_ids: ['TT1'] });
  assert.equal(res.meta.promo, null);
});

test('código TikTok != 0 vira exceção', async () => {
  mock({ '/product/202309/images/upload': () => ({ code: 12052048, message: 'imagem inválida' }) });
  await assert.rejects(tiktok.publish(ctx(), product(), null), /imagem inválida/);
});

test('helpers: nome de vídeo, GTIN e peso', () => {
  const { videoName, identifierCode, weight } = tiktok._internal;
  assert.equal(videoName('Meu Vídeo.final.MOV', 'Ção 1'), 'video_Cao_1.mov');
  assert.equal(videoName('', 'x'), 'video_x.mp4');
  assert.deepEqual(identifierCode('012345678905'), { code: '012345678905', type: 'UPC' });
  assert.deepEqual(identifierCode('12345678'), { code: '12345678', type: 'EAN' });
  assert.deepEqual(identifierCode('00012345678905'), { code: '00012345678905', type: 'GTIN' });
  assert.equal(identifierCode('123'), null);
  assert.equal(weight(0.23456), '0.235');
  assert.equal(weight(0), '0.001');
});

test('PRÉVIA online: recomenda categoria, valida atributos e armazém sem subir mídia nem criar produto', async () => {
  const calls = mock({
    ...createRoutes(),
    '/product/202309/categories/recommend': () => ({ code: 0, data: { leaf_category_id: '601739', categories: [{ id: '601739', name: 'Fones', permission_statuses: ['AVAILABLE'] }] } }),
  });
  const r = await tiktok.preview(ctx(), product({ categories: {}, attributes: {} }));
  assert.ok(!calls.some((c) => /upload|\/products$|activities/.test(c.path)), 'nada de upload, criação ou promoção');
  assert.match(r.errors.join(), /exige os atributos "Material"/);
  const f = Object.fromEntries(r.fields.map((x) => [x.label, x.value]));
  assert.equal(f['Categoria'], '601739');
  assert.equal(f['SKU do vendedor'], 'FONE-01');
  assert.match(f['Estoque'], /^3$/);
});

test('PRÉVIA: variações e estoque zero explicados', async () => {
  const r = await tiktok.preview(null, product({ stock: 0, variants: [{ sku: 'A', options: { Cor: 'Azul' } }] }));
  assert.match(r.errors.join(), /variações ainda não/);
});
