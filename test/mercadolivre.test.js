'use strict';
// Conector Mercado Livre com variações, contra a API simulada nos dois
// modelos documentados (developers.mercadolivre.com.br/pt_br/variacoes e
// /pt_br/preco-variacao): clássico (variations) e User Products (família).
const test = require('node:test');
const assert = require('node:assert/strict');
const ml = require('../src/platforms/mercadolivre');
const { normalizeProduct } = require('../src/source/normalize');

const realFetch = global.fetch;
test.afterEach(() => {
  global.fetch = realFetch;
  ml._internal.sellerTags.clear();
  ml._internal.categoryCache.clear();
});

const ctx = () => ({ creds: { client_id: 'app', listing_type_id: 'gold_special', shipping_mode: 'me2' }, tokens: { access_token: 'AT', user_id: 99 } });
const camiseta = (over = {}) => normalizeProduct({
  sku: 'CAM', title: 'Camiseta Básica Algodão', description: 'Algodão', price: 59.9, brand: 'Minha Marca',
  images: ['https://site.test/cam.jpg'], categories: { mercadolivre: 'MLB31447' }, attributes: { GENDER: 'Masculino' },
  variants: [
    { sku: 'CAM-PR-P', options: { Cor: 'Preto', Tamanho: 'P' }, price: 59.9, stock: 4, gtin: '7891234567895', images: ['https://site.test/preto.jpg'] },
    { sku: 'CAM-PR-M', options: { Cor: 'Preto', Tamanho: 'M' }, price: 59.9, stock: 2 },
    { sku: 'CAM-AZ-G', options: { Cor: 'Azul', Tamanho: 'G' }, price: 64.9, stock: 0, images: ['https://site.test/azul.jpg'] },
  ],
  ...over,
});

const CATEGORY = { id: 'MLB31447', name: 'Camisetas e Regatas', attribute_types: 'variations',
  settings: { max_variations_allowed: 250, max_pictures_per_item_var: 10, max_pictures_per_item: 12, max_title_length: 60 } };
const ATTRS = [
  { id: 'BRAND', name: 'Marca', tags: { required: true }, hierarchy: 'PARENT_PK' },
  { id: 'GENDER', name: 'Gênero', tags: { required: true }, hierarchy: 'PARENT_PK' },
  { id: 'COLOR', name: 'Cor', tags: { allow_variations: true, defines_picture: true, required: true }, hierarchy: 'CHILD_PK', values: [{ id: '52049', name: 'Preto' }] },
  { id: 'SIZE', name: 'Tamanho', tags: { allow_variations: true }, hierarchy: 'CHILD_PK' },
  { id: 'SELLER_SKU', name: 'SKU', tags: { hidden: true, variation_attribute: true }, hierarchy: 'ITEM' },
];

function mock(routes = {}, { up = false } = {}) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || 'GET', path: u.pathname, search: u.search, body });
    const key = `${init.method || 'GET'} ${u.pathname}`;
    const defaults = {
      'GET /users/me': () => ({ id: 99, nickname: 'LOJA', tags: up ? ['normal', 'user_product_seller'] : ['normal'] }),
      'GET /categories/MLB31447': () => CATEGORY,
      'GET /categories/MLB31447/attributes': () => ATTRS,
      'GET /users/99/items/search': () => ({ results: [] }),
    };
    const handler = routes[key] || defaults[key];
    const out = handler ? handler(u, body) : {};
    const status = out && out.__status ? out.__status : 200;
    return new Response(JSON.stringify(out), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

// ===================================================================== clássico
test('CLÁSSICO: um anúncio com variations, preço único (o maior), fotos por cor e SKU/GTIN por variação', async () => {
  const calls = mock({
    'POST /items': (u, b) => ({ id: 'MLB1', permalink: 'https://ml/MLB1',
      variations: b.variations.map((v, i) => ({ id: 1000 + i, attribute_combinations: v.attribute_combinations.map((c) => ({ ...c, name: c.id })) })) }),
  });
  const res = await ml.publish(ctx(), camiseta(), null);
  assert.equal(res.externalId, 'MLB1');
  const b = calls.find((c) => c.method === 'POST' && c.path === '/items').body;
  assert.equal(b.title, 'Camiseta Básica Algodão');
  assert.equal(b.family_name, undefined);
  assert.equal(b.price, 64.9, 'mesmo preço em todas: o maior');
  assert.match(res.warnings.join(), /enviado o maior \(64\.90\)/);
  assert.equal(b.available_quantity, 6);
  assert.deepEqual(b.variations[0].attribute_combinations, [{ id: 'COLOR', value_id: '52049', value_name: 'Preto' }, { id: 'SIZE', value_name: 'P' }]);
  assert.deepEqual(b.variations.map((v) => v.price), [64.9, 64.9, 64.9]);
  assert.deepEqual(b.variations.map((v) => v.available_quantity), [4, 2, 0], 'variação sem estoque fica com 0 (o ML pausa só a variação)');
  assert.deepEqual(b.variations.map((v) => v.picture_ids), [['https://site.test/preto.jpg'], ['https://site.test/preto.jpg'], ['https://site.test/azul.jpg']], 'mesma cor, mesmas fotos');
  assert.deepEqual(b.pictures, [{ source: 'https://site.test/preto.jpg' }, { source: 'https://site.test/azul.jpg' }, { source: 'https://site.test/cam.jpg' }]);
  assert.deepEqual(b.variations[0].attributes, [{ id: 'SELLER_SKU', value_name: 'CAM-PR-P' }, { id: 'GTIN', value_name: '7891234567895' }]);
  assert.deepEqual(b.variations[1].attributes[1], { id: 'EMPTY_GTIN_REASON', value_id: '17055160' });
  assert.ok(!b.attributes.some((a) => ['SELLER_SKU', 'GTIN', 'COLOR', 'SIZE'].includes(a.id)), 'SKU/GTIN/eixos não vão no item');
  assert.ok(b.attributes.some((a) => a.id === 'GENDER'));
  assert.deepEqual(res.meta.variations, { 'CAM-PR-P': 1000, 'CAM-PR-M': 1001, 'CAM-AZ-G': 1002 });
  assert.equal(res.meta.model, 'classic');
  assert.ok(calls.some((c) => c.path === '/items/MLB1/description'));
});

test('CLÁSSICO: atualização manda todas as variações que ficam (com id); nova sem id; removida omitida', async () => {
  const p = camiseta();
  p.variants.splice(1, 1); // CAM-PR-M saiu da origem
  p.variants.push({ ...p.variants[0], sku: 'CAM-PR-GG', options: { Cor: 'Preto', Tamanho: 'GG' }, gtin: null, stock: 3, images: [] });
  const calls = mock({
    'GET /items/MLB1': () => ({ id: 'MLB1', variations: [
      { id: 1000, attribute_combinations: [{ id: 'COLOR', value_name: 'Preto' }, { id: 'SIZE', value_name: 'P' }], attributes: [{ id: 'SELLER_SKU', value_name: 'CAM-PR-P' }] },
      { id: 1001, attribute_combinations: [{ id: 'COLOR', value_name: 'Preto' }, { id: 'SIZE', value_name: 'M' }], attributes: [{ id: 'SELLER_SKU', value_name: 'CAM-PR-M' }] },
      { id: 1002, attribute_combinations: [{ id: 'COLOR', value_name: 'Azul' }, { id: 'SIZE', value_name: 'G' }] },
    ] }),
    'PUT /items/MLB1': (u, b) => ({ id: 'MLB1', variations: (b.variations || []).map((v, i) => ({ id: v.id || 2000 + i, attributes: v.attributes })) }),
  });
  const res = await ml.publish(ctx(), p, { external_id: 'MLB1', meta: { model: 'classic', category_id: 'MLB31447' } });
  const get = calls.find((c) => c.method === 'GET' && c.path === '/items/MLB1');
  assert.match(get.search, /include_attributes=all/);
  const put = calls.find((c) => c.method === 'PUT' && c.path === '/items/MLB1' && c.body.variations).body;
  assert.deepEqual(put.variations.map((v) => v.id), [1000, 1002, undefined], 'CAM-PR-M omitida = apagada');
  assert.equal(put.variations[0].attribute_combinations, undefined, 'combinação de variação existente não é reenviada');
  assert.deepEqual(put.variations[2].attribute_combinations, [{ id: 'COLOR', value_id: '52049', value_name: 'Preto' }, { id: 'SIZE', value_name: 'GG' }]);
  assert.deepEqual(put.variations[2].picture_ids, ['https://site.test/preto.jpg'], 'sem foto própria: usa a da mesma cor');
  assert.equal(put.title, undefined, 'título não muda depois de publicado');
  assert.match(res.warnings.join(), /incluídas: CAM-PR-GG/);
  assert.match(res.warnings.join(), /removidas do anúncio: 1/);
  assert.equal(res.meta.variations['CAM-PR-GG'], 2002);
});

test('CLÁSSICO: promoção é do anúncio todo — só se todas as variações tiverem', async () => {
  let calls = mock({ 'POST /items': () => ({ id: 'MLB2', variations: [] }) });
  const all = camiseta({ variants: camiseta().variants.map((v) => ({ ...v, promoPrice: v.price - 10 })) });
  let res = await ml.publish(ctx(), all, null);
  const promo = calls.find((c) => c.path === '/seller-promotions/items/MLB2');
  assert.equal(promo.body.deal_price, 54.9, 'maior preço promocional');
  assert.equal(res.meta.promo.price, 54.9);

  calls = mock({ 'POST /items': () => ({ id: 'MLB3', variations: [] }) });
  const some = camiseta();
  some.variants[0].promoPrice = 49.9;
  res = await ml.publish(ctx(), some, null);
  assert.ok(!calls.some((c) => c.path.startsWith('/seller-promotions')));
  assert.match(res.warnings.join(), /promoção só em algumas variações/);
});

test('CLÁSSICO: categoria sem variações e mais de uma variação personalizada são recusadas', async () => {
  mock({ 'GET /categories/MLB31447': () => ({ ...CATEGORY, attribute_types: 'attributes' }) });
  await assert.rejects(ml.publish(ctx(), camiseta(), null), /não aceita variações/);
  ml._internal.categoryCache.clear();
  mock();
  const p = camiseta({ variants: [{ sku: 'A', options: { Estilo: 'X', Acabamento: 'Y' }, price: 10, stock: 1 }] });
  await assert.rejects(ml.publish(ctx(), p, null), /só uma variação personalizada/);
});

// =============================================================== User Products
test('USER PRODUCTS: um item por variação com family_name, preço/estoque próprios, sem title nem variations', async () => {
  let n = 0;
  const calls = mock({
    'POST /items': (u, b) => ({ id: `MLB10${n++}`, family_id: 777, permalink: 'https://ml/fam', family_name: b.family_name }),
  }, { up: true });
  const p = camiseta();
  p.variants[1].promoPrice = 49.9;
  const res = await ml.publish(ctx(), p, null);
  const posts = calls.filter((c) => c.method === 'POST' && c.path === '/items').map((c) => c.body);
  assert.equal(posts.length, 2, 'variação sem estoque não cria anúncio');
  assert.match(res.warnings.join(), /CAM-AZ-G sem estoque/);
  for (const b of posts) {
    assert.equal(b.family_name, 'Camiseta Básica Algodão');
    assert.equal(b.title, undefined);
    assert.equal(b.variations, undefined);
  }
  assert.deepEqual(posts.map((b) => [b.price, b.available_quantity]), [[59.9, 4], [59.9, 2]]);
  const a0 = posts[0].attributes;
  assert.ok(a0.some((a) => a.id === 'COLOR' && a.value_id === '52049'));
  assert.ok(a0.some((a) => a.id === 'SIZE' && a.value_name === 'P'));
  assert.ok(a0.some((a) => a.id === 'SELLER_SKU' && a.value_name === 'CAM-PR-P'));
  assert.ok(a0.some((a) => a.id === 'GENDER'), 'atributos da família em todos os itens');
  assert.ok(calls.some((c) => c.path === '/users/99/items/search' && /seller_sku=CAM-PR-P/.test(c.search)), 'procura antes de criar (sem duplicar)');
  assert.equal(res.externalId, 'MLB100');
  assert.deepEqual(res.meta.items, { 'CAM-PR-P': 'MLB100', 'CAM-PR-M': 'MLB101' });
  assert.equal(res.meta.family_id, 777);
  assert.equal(res.meta.model, 'up');
  const promo = calls.filter((c) => c.path.startsWith('/seller-promotions'));
  assert.deepEqual(promo.map((c) => [c.path, c.body.deal_price]), [['/seller-promotions/items/MLB101', 49.9]], 'promoção por variação');
});

test('USER PRODUCTS: atualização por item, variação que voltou ao estoque é criada e a removida é pausada', async () => {
  const p = camiseta();
  p.variants[2].stock = 5; // CAM-AZ-G ganhou estoque
  p.variants.splice(1, 1); // CAM-PR-M saiu
  p.variants[0].price = 55.9;
  const calls = mock({
    'POST /items': () => ({ id: 'MLB102', family_id: 777 }),
  }, { up: true });
  const listing = { external_id: 'MLB100', meta: { model: 'up', category_id: 'MLB31447', family_name: 'Camiseta Básica Algodão', items: { 'CAM-PR-P': 'MLB100', 'CAM-PR-M': 'MLB101' }, desc_hash: 'x' } };
  const res = await ml.publish(ctx(), p, listing);
  const put100 = calls.find((c) => c.method === 'PUT' && c.path === '/items/MLB100').body;
  assert.deepEqual([put100.price, put100.available_quantity], [55.9, 4]);
  assert.equal(put100.attributes, undefined, 'cor/tamanho de item UP não mudam por PUT /items');
  assert.equal(calls.find((c) => c.method === 'POST' && c.path === '/items').body.family_name, 'Camiseta Básica Algodão');
  assert.ok(calls.some((c) => c.method === 'PUT' && c.path === '/items/MLB101' && c.body.status === 'paused'));
  assert.match(res.warnings.join(), /CAM-PR-M removida na origem: anúncio MLB101 pausado/);
  assert.equal(res.meta.items['CAM-AZ-G'], 'MLB102');
  assert.equal(res.meta.paused['CAM-PR-M'], true);
});

test('USER PRODUCTS: item já existente com o mesmo SELLER_SKU é reaproveitado (sem duplicar)', async () => {
  const calls = mock({
    'GET /users/99/items/search': (u) => ({ results: u.searchParams.get('seller_sku') === 'CAM-PR-P' ? ['MLB555'] : [] }),
    'POST /items': () => ({ id: 'MLB556' }),
  }, { up: true });
  const res = await ml.publish(ctx(), camiseta(), null);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path === '/items').length, 1);
  assert.ok(calls.some((c) => c.method === 'PUT' && c.path === '/items/MLB555'));
  assert.equal(res.meta.items['CAM-PR-P'], 'MLB555');
});

test('conta migrada sem a tag em cache: erro do modelo clássico refaz no modelo User Products', async () => {
  let n = 0;
  const calls = mock({
    'POST /items': (u, b) => (b.variations
      ? { __status: 400, message: 'The field variations is invalid with family name', error: 'body.invalid_fields' }
      : { id: `MLB20${n++}` }),
  });
  const res = await ml.publish(ctx(), camiseta(), null);
  assert.equal(res.meta.model, 'up');
  assert.match(res.warnings.join(), /modelo User Products/);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path === '/items' && c.body.family_name).length, 2);
  assert.equal(ml._internal.sellerTags.get('99').up, true, 'a conta fica marcada como UP');
});

test('USER PRODUCTS: variação sem atributo correspondente na categoria é recusada com orientação', async () => {
  mock({}, { up: true });
  const p = camiseta({ variants: [{ sku: 'A', options: { Estilo: 'Liso' }, price: 10, stock: 1 }] });
  await assert.rejects(ml.publish(ctx(), p, null), /"Estilo" não existe na categoria.*Cor, Tamanho/);
});

test('produto publicado com variações que chega sem elas é recusado', async () => {
  mock();
  const simples = normalizeProduct({ sku: 'CAM', title: 'Camiseta', price: 10, stock: 1, images: ['https://site.test/x.jpg'] });
  await assert.rejects(ml.publish(ctx(), simples, { external_id: 'MLB1', meta: { model: 'classic' } }), /publicado com variações/);
});

// ====================================================================== prévia
test('PRÉVIA com variações: modelo da conta, eixos e regra de preço do clássico', async () => {
  mock();
  let r = await ml.preview(ctx(), camiseta());
  assert.deepEqual(r.errors, []);
  const f = (label) => r.fields.find((x) => x.label === label);
  assert.match(f('Modelo de anúncio').value, /Clássico: 1 anúncio com 3 variações/);
  assert.equal(f('Variações').value, 'Cor → Cor (COLOR) · Tamanho → Tamanho (SIZE)');
  assert.match(f('Preço').value, /^R\$\s64,90$/);
  assert.match(f('Preço').note, /vai o maior/);
  assert.equal(r.variantStructure, 'clássico (variações no anúncio)');

  ml._internal.sellerTags.clear();
  mock({}, { up: true });
  r = await ml.preview(ctx(), camiseta());
  assert.deepEqual(r.errors, []);
  assert.match(r.fields.find((x) => x.label === 'Modelo de anúncio').value, /User Products: 3 anúncio\(s\)/);
  assert.equal(r.fields.find((x) => x.label === 'Nome da família').value, 'Camiseta Básica Algodão');
  assert.match(r.fields.find((x) => x.label === 'Preço').value, /R\$\s59,90 a R\$\s64,90/);
  assert.match(r.warnings.join(), /criado quando houver estoque/);

  const off = await ml.preview(null, camiseta());
  assert.deepEqual(off.errors, []);
  assert.match(off.fields.find((x) => x.label === 'Modelo de anúncio').value, /definido pela conta/);
});

// ============================================== promoção e status (todos os modos)
const simples = (over = {}) => normalizeProduct({
  sku: 'GAR', title: 'Garrafa Térmica', price: 100, stock: 3, images: ['https://site.test/g.jpg'], categories: { mercadolivre: 'MLB1' }, ...over,
});
const promoCalls = (calls) => calls.filter((c) => c.path.startsWith('/seller-promotions'));

test('PROMOÇÃO: janela de até 14 dias, não recria a mesma, renova quando vence e remove quando sai da origem', async () => {
  // Sem data de fim: pede 14 dias (o limite da doc), não 30.
  let calls = mock({ 'POST /items': () => ({ id: 'MLB7' }) });
  let res = await ml.publish(ctx(), simples({ promoPrice: 89.9 }), null);
  let post = promoCalls(calls).find((c) => c.method === 'POST');
  const days = (new Date(post.body.finish_date + 'Z') - new Date(post.body.start_date + 'Z')) / 86400e3;
  assert.ok(Math.abs(days - 14) < 0.01, `janela de ${days} dias`);
  const listing = { external_id: 'MLB7', meta: res.meta };

  // Mesma promoção na próxima sincronização: nenhuma chamada de promoção.
  calls = mock();
  res = await ml.publish(ctx(), simples({ promoPrice: 89.9 }), listing);
  assert.equal(promoCalls(calls).length, 0);
  assert.equal(res.meta.promo.price, 89.9);

  // Preço promocional mudou: remove a campanha anterior e cria outra.
  calls = mock();
  res = await ml.publish(ctx(), simples({ promoPrice: 79.9 }), listing);
  assert.deepEqual(promoCalls(calls).map((c) => [c.method, c.body && c.body.deal_price]), [['DELETE', null], ['POST', 79.9]]);
  assert.match(promoCalls(calls)[0].search, /promotion_type=PRICE_DISCOUNT/);

  // Campanha vencida com a origem ainda em promoção: renova.
  calls = mock();
  const expired = { ...listing, meta: { ...listing.meta, promo: { ...listing.meta.promo, end: new Date(Date.now() - 1000).toISOString() } } };
  await ml.publish(ctx(), simples({ promoPrice: 89.9 }), expired);
  assert.deepEqual(promoCalls(calls).map((c) => c.method), ['POST'], 'vencida não precisa de DELETE');

  // Promoção saiu da origem: remove do ML e limpa o meta.
  calls = mock();
  res = await ml.publish(ctx(), simples(), listing);
  assert.deepEqual(promoCalls(calls).map((c) => c.method), ['DELETE']);
  assert.equal(res.meta.promo, null);

  // Fim pedido além de 14 dias: limitado, com aviso.
  calls = mock({ 'POST /items': () => ({ id: 'MLB8' }) });
  res = await ml.publish(ctx(), simples({ promoPrice: 89.9, promoEnd: new Date(Date.now() + 40 * 86400e3).toISOString() }), null);
  post = promoCalls(calls).find((c) => c.method === 'POST');
  assert.ok((new Date(post.body.finish_date + 'Z') - Date.now()) / 86400e3 < 14.1);
  assert.match(res.warnings.join(), /limitado a 14 dias/);
});

test('STATUS: inativo na origem pausa uma vez; ativo de novo reativa o anúncio', async () => {
  let calls = mock();
  let res = await ml.publish(ctx(), simples({ active: false }), { external_id: 'MLB7', meta: {} });
  assert.ok(calls.some((c) => c.method === 'PUT' && c.body && c.body.status === 'paused'));
  assert.equal(res.meta.paused, true);

  calls = mock();
  await ml.publish(ctx(), simples({ active: false }), { external_id: 'MLB7', meta: { paused: true } });
  assert.ok(!calls.some((c) => c.body && c.body.status), 'já pausado: não repete');

  calls = mock();
  res = await ml.publish(ctx(), simples(), { external_id: 'MLB7', meta: { paused: true } });
  assert.ok(calls.some((c) => c.method === 'PUT' && c.body && c.body.status === 'active'));
  assert.equal(res.meta.paused, false);
  assert.match(res.warnings.join(), /reativado/);
});

test('CLÁSSICO: opção corrigida na origem reenvia a combinação só daquela variação', async () => {
  const p = camiseta();
  p.variants[0].options = { Cor: 'Preto', Tamanho: 'PP' }; // corrigido de P para PP
  const calls = mock({
    'GET /items/MLB1': () => ({ id: 'MLB1', variations: [
      { id: 1000, attribute_combinations: [{ id: 'COLOR', value_name: 'Preto' }, { id: 'SIZE', value_name: 'P' }], attributes: [{ id: 'SELLER_SKU', value_name: 'CAM-PR-P' }] },
      { id: 1001, attribute_combinations: [{ id: 'COLOR', value_name: 'Preto' }, { id: 'SIZE', value_name: 'M' }], attributes: [{ id: 'SELLER_SKU', value_name: 'CAM-PR-M' }] },
      { id: 1002, attribute_combinations: [{ id: 'COLOR', value_name: 'Azul' }, { id: 'SIZE', value_name: 'G' }], attributes: [{ id: 'SELLER_SKU', value_name: 'CAM-AZ-G' }] },
    ] }),
    'PUT /items/MLB1': () => ({ id: 'MLB1' }),
  });
  const res = await ml.publish(ctx(), p, { external_id: 'MLB1', meta: { model: 'classic', category_id: 'MLB31447' } });
  const put = calls.find((c) => c.method === 'PUT' && c.body && c.body.variations).body;
  assert.deepEqual(put.variations[0].attribute_combinations, [{ id: 'COLOR', value_id: '52049', value_name: 'Preto' }, { id: 'SIZE', value_name: 'PP' }]);
  assert.equal(put.variations[1].attribute_combinations, undefined);
  assert.equal(put.variations[2].attribute_combinations, undefined);
  assert.match(res.warnings.join(), /CAM-PR-P: opções alteradas/);
});

test('USER PRODUCTS: promoção removida de uma variação sai só do anúncio dela', async () => {
  const listing = { external_id: 'MLB100', meta: { model: 'up', category_id: 'MLB31447', family_name: 'Camiseta Básica Algodão',
    items: { 'CAM-PR-P': 'MLB100', 'CAM-PR-M': 'MLB101' }, desc_hash: 'x',
    promos: { 'CAM-PR-M': { price: 49.9, start: new Date().toISOString(), end: new Date(Date.now() + 86400e3).toISOString(), requested: [null, null] } } } };
  const p = camiseta();
  p.variants.splice(2, 1);
  const calls = mock({}, { up: true });
  const res = await ml.publish(ctx(), p, listing);
  assert.deepEqual(promoCalls(calls).map((c) => [c.method, c.path]), [['DELETE', '/seller-promotions/items/MLB101']]);
  assert.equal(res.meta.promos['CAM-PR-M'], null);
});
