'use strict';
// Conector Shopee contra uma API simulada que segue a documentação oficial,
// em três cenários de catálogo: tênis (2 níveis de variação), roupa
// (tamanho, tabela de medidas) e utensílio doméstico (item simples com
// atributos de unidade, pré-venda e dimensões obrigatórias).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const shopee = require('../src/platforms/shopee');
const { normalizeProduct } = require('../src/source/normalize');

const { timing, cache, validGtin } = shopee._internal;
const realFetch = global.fetch;
const slept = [];
timing.sleep = async (ms) => { slept.push(ms); };
timing.videoPollMs = 0;
test.afterEach(() => { global.fetch = realFetch; cache.clear(); slept.length = 0; });

// EAN-13 com dígito verificador correto.
function ean(base12) {
  const sum = base12.split('').reverse().map(Number).reduce((a, d, i) => a + d * (i % 2 === 0 ? 3 : 1), 0);
  return base12 + ((10 - (sum % 10)) % 10);
}

const CREDS = { partner_id: '2001887', partner_key: 'chave', environment: 'sandbox', region: 'BR' };
const ctx = () => ({ creds: { ...CREDS }, tokens: { access_token: 'AT', shop_id: '42', region: 'BR' } });

const LIMIT = (extra = {}) => ({
  price_limit: { min_limit: 1, max_limit: 100000 },
  stock_limit: { min_limit: 0, max_limit: 999999 },
  item_name_length_limit: { min_limit: 10, max_limit: 120 },
  item_description_length_limit: { min_limit: 20, max_limit: 3000 },
  item_image_count_limit: { min_limit: 1, max_limit: 9 },
  tier_variation_name_length_limit: { min_limit: 1, max_limit: 14 },
  tier_variation_option_length_limit: { min_limit: 1, max_limit: 30 },
  dts_limit: { days_to_ship_limit: { min_limit: -1, max_limit: -1 }, non_pre_order_days_to_ship: 2 },
  dimension_limit: { dimension_mandatory: false },
  size_chart_limit: { size_chart_mandatory: false, support_image_size_chart: true, support_template_size_chart: true },
  ...extra,
});
const dd = (id, name, values, info, mandatory = true) => ({
  attribute_id: id, name, mandatory, attribute_info: info,
  attribute_value_list: values.map(([value_id, n]) => ({ value_id, name: n })),
});

const CATS = {
  // Tênis
  100700: {
    limit: LIMIT({ size_chart_limit: { size_chart_mandatory: true, support_image_size_chart: true, support_template_size_chart: true } }),
    gtin: 'Mandatory',
    attrs: [
      dd(1, 'Material', [[11, 'Couro'], [12, 'Sintético'], [13, 'Tecido']], { input_type: 1 }),
      dd(2, 'Gênero', [[21, 'Masculino'], [22, 'Feminino'], [23, 'Unissex']], { input_type: 1 }),
    ],
    brands: [[{ brand_id: 1002, original_brand_name: 'Adidas' }], [{ brand_id: 1001, original_brand_name: 'Nike' }]],
    variations: [
      { variation_id: 1, variation_name: 'Cor', variation_group_list: [{ variation_group_id: 11, variation_option_list: [{ variation_option_id: 101, variation_option_name: 'Preto' }, { variation_option_id: 102, variation_option_name: 'Branco' }] }] },
      { variation_id: 2, variation_name: 'Tamanho', variation_group_list: [{ variation_group_id: 21, variation_option_list: ['38', '39', '40', '41', '42'].map((n, i) => ({ variation_option_id: 200 + i, variation_option_name: n })) }] },
    ],
  },
  // Roupa
  100011: {
    limit: LIMIT({ size_chart_limit: { size_chart_mandatory: true, support_image_size_chart: true, support_template_size_chart: true } }),
    gtin: 'Flexible',
    attrs: [
      dd(30, 'Material', [[31, 'Algodão'], [32, 'Poliéster']], { input_type: 2 }),
      dd(33, 'Estilo', [[34, 'Casual'], [35, 'Esporte']], { input_type: 5, max_value_count: 3 }, false),
    ],
    brands: [[]],
    variations: [
      { variation_id: 2, variation_name: 'Size', variation_group_list: [{ variation_group_id: 22, variation_option_list: [{ variation_option_id: 301, variation_option_name: 'P' }, { variation_option_id: 302, variation_option_name: 'M' }, { variation_option_id: 303, variation_option_name: 'G' }] }] },
    ],
  },
  // Utensílio doméstico
  100636: {
    limit: LIMIT({
      dts_limit: { days_to_ship_limit: { min_limit: 7, max_limit: 30 }, non_pre_order_days_to_ship: 2 },
      dimension_limit: { dimension_mandatory: true },
    }),
    gtin: 'Flexible',
    attrs: [
      dd(40, 'Material', [[41, 'Alumínio'], [42, 'Inox']], { input_type: 2 }),
      dd(43, 'Capacidade', [], { input_type: 3, format_type: 2, attribute_unit_list: ['ml', 'L'] }),
      dd(44, 'Quantidade de Peças', [], { input_type: 3, input_validation_type: 1 }),
      dd(45, 'Data de Fabricação', [], { input_type: 3, input_validation_type: 4 }, false),
    ],
    brands: [[{ brand_id: 2001, original_brand_name: 'Tramontina' }]],
    variations: [],
  },
};

const CHANNELS = [
  { logistics_channel_id: 90001, logistics_channel_name: 'Shopee Xpress', enabled: true, mask_channel_id: 0, fee_type: 'SIZE_INPUT', weight_limit: { item_max_weight: 30 } },
  { logistics_channel_id: 90002, logistics_channel_name: 'Correios', enabled: true, mask_channel_id: 0, fee_type: 'FIXED_DEFAULT_PRICE', weight_limit: { item_max_weight: 10 }, item_max_dimension: { length: 100, width: 100, height: 100 } },
  { logistics_channel_id: 90003, logistics_channel_name: 'Retirada', enabled: false, mask_channel_id: 0, fee_type: 'FIXED_DEFAULT_PRICE' },
  { logistics_channel_id: 90004, logistics_channel_name: 'Xpress (fulfillment)', enabled: true, mask_channel_id: 90001, fee_type: 'SIZE_INPUT' },
  { logistics_channel_id: 90005, logistics_channel_name: 'Entrega própria', enabled: true, mask_channel_id: 0, fee_type: 'CUSTOM_PRICE' },
];

// API Shopee simulada. `over` troca respostas por "MÉTODO caminho".
function mockShopee(over = {}) {
  const calls = [];
  let img = 0;
  let lastInit = null;
  global.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const form = init.body instanceof FormData ? init.body : null;
    calls.push({ method, path: u.pathname, host: u.host, query: u.searchParams, body, form });
    if (u.hostname === 'site.test') {
      const ext = u.pathname.split('.').pop();
      const type = { jpg: 'image/jpeg', png: 'image/png', mp4: 'video/mp4', webp: 'image/webp' }[ext] || 'application/octet-stream';
      return new Response(Buffer.alloc(ext === 'mp4' ? 5 * 1024 * 1024 : 2048, 1), { headers: { 'Content-Type': type } });
    }
    const key = `${method} ${u.pathname}`;
    const reply = (o) => new Response(JSON.stringify({ error: '', message: '', request_id: 'r', ...o }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (over[key]) return reply(over[key](u, body, form));
    const cat = CATS[u.searchParams.get('category_id') || u.searchParams.get('category_id_list')];
    switch (key) {
      case 'POST /api/v2/media_space/upload_image': img++; return reply({ response: { image_info: { image_id: `img${img}` } } });
      case 'GET /api/v2/product/category_recommend': return reply({ response: { category_id: [100636] } });
      case 'GET /api/v2/product/get_item_limit': return reply({ response: cat.limit, gtin_limit: { gtin_validation_rule: cat.gtin } });
      case 'GET /api/v2/product/get_attribute_tree': return reply({ response: { list: [{ category_id: Number(u.searchParams.get('category_id_list')), attribute_tree: cat.attrs }] } });
      case 'GET /api/v2/product/get_brand_list': {
        const page = Number(u.searchParams.get('offset')) / 100;
        return reply({ response: { brand_list: cat.brands[page] || [], has_next_page: page < cat.brands.length - 1, next_offset: (page + 1) * 100, is_mandatory: true } });
      }
      case 'GET /api/v2/logistics/get_channel_list': return reply({ response: { logistics_channel_list: CHANNELS } });
      case 'GET /api/v2/product/get_variation_tree': return reply({ data: { standardise_variation_list: cat.variations } });
      case 'POST /api/v2/product/add_item': return reply({ response: { item_id: 5001 } });
      case 'POST /api/v2/product/init_tier_variation': lastInit = body; return reply({ response: { item_id: body.item_id } });
      case 'GET /api/v2/product/get_model_list':
        return reply({ response: { model: (lastInit ? lastInit.model : []).map((m, i) => ({ model_id: 9000 + i, tier_index: m.tier_index, model_sku: m.model_sku })) } });
      case 'POST /api/v2/media_space/init_video_upload': return reply({ response: { video_upload_id: 'vid1' } });
      case 'GET /api/v2/media_space/get_video_upload_result': return reply({ response: { status: 'SUCCEEDED' } });
      case 'POST /api/v2/discount/add_discount': return reply({ response: { discount_id: 777 } });
      case 'POST /api/v2/discount/add_discount_item': return reply({ response: { discount_id: 777, count: 1, error_list: [] } });
      default: return reply({ response: {} });
    }
  };
  return calls;
}
const find = (calls, method, path) => calls.find((c) => c.method === method && c.path === path);
const all = (calls, method, path) => calls.filter((c) => c.method === method && c.path === path);

// ------------------------------------------------------------- produtos
const tenis = (over = {}) => normalizeProduct({
  sku: 'TEN-RUN', title: 'Tênis Corrida Run Pro', description: 'Tênis leve para corrida, com amortecimento em espuma.',
  brand: 'Nike', price: 299.9, promoPrice: 249.9, weightKg: 1.1, lengthCm: 33, widthCm: 22, heightCm: 12,
  images: ['https://site.test/ten-1.jpg', 'https://site.test/ten-2.jpg'], sizeChart: 'https://site.test/tabela.png',
  categories: { shopee: 100700 }, attributes: { Material: 'Sintético', 'Gênero': 'Masculino' },
  variants: [
    { sku: 'TEN-PT-40', options: { Cor: 'Preto', Tamanho: '40' }, stock: 5, gtin: ean('789100000001'), images: ['https://site.test/ten-preto.jpg'] },
    { sku: 'TEN-PT-41', options: { Cor: 'Preto', Tamanho: '41' }, stock: 3, gtin: ean('789100000002') },
    { sku: 'TEN-BR-40', options: { Cor: 'Branco', Tamanho: '40' }, stock: 2, gtin: ean('789100000003') },
  ],
  ...over,
});

const camiseta = (over = {}) => normalizeProduct({
  sku: 'CAM-BAS', title: 'Camiseta Básica Algodão', description: 'Camiseta 100% algodão, malha penteada, gola careca.',
  brand: 'Marca Própria', price: 59.9, weightKg: 0.25, lengthCm: 30, widthCm: 25, heightCm: 3,
  images: ['https://site.test/cam.jpg'], sizeChartId: '556677',
  categories: { shopee: 100011 }, attributes: { Material: 'Malha fria', Estilo: 'Casual, Esporte' },
  variants: [
    { sku: 'CAM-P', options: { Tamanho: 'P' }, stock: 10 },
    { sku: 'CAM-M', options: { Tamanho: 'M' }, stock: 0 },
    { sku: 'CAM-GG', options: { Tamanho: 'GG' }, stock: 4, price: 64.9 },
  ],
  ...over,
});

const panelas = (over = {}) => normalizeProduct({
  sku: 'PAN-5', title: 'Jogo de Panelas Antiaderente 5 Peças', description: 'Jogo com 5 panelas antiaderentes, cabo baquelite.',
  brand: 'Tramontina', price: 389.9, promoPrice: 329.9, stock: 12, weightKg: 4.2, lengthCm: 45, widthCm: 30, heightCm: 25,
  images: ['https://site.test/pan-1.jpg', 'https://site.test/pan-2.jpg'], daysToShip: 10, ncm: '73239300', origem: '0',
  attributes: { Material: 'Alumínio', Capacidade: '2,5 L', 'Quantidade de Peças': '5', 'Data de Fabricação': '03/2026' },
  ...over,
});

// ================================================================ testes
test('domínios e assinatura por tipo de API (Shop x Public)', async () => {
  const calls = mockShopee();
  await shopee.publish(ctx(), panelas(), null);
  const upload = find(calls, 'POST', '/api/v2/media_space/upload_image');
  assert.equal(upload.host, 'openplatform.sandbox.test-stable.shopee.sg');
  assert.ok(!upload.query.has('access_token') && !upload.query.has('shop_id'), 'upload_image é Public');
  const ts = upload.query.get('timestamp');
  const expect = crypto.createHmac('sha256', 'chave').update(`2001887/api/v2/media_space/upload_image${ts}`).digest('hex');
  assert.equal(upload.query.get('sign'), expect);
  const add = find(calls, 'POST', '/api/v2/product/add_item');
  assert.equal(add.query.get('shop_id'), '42');
  const ts2 = add.query.get('timestamp');
  assert.equal(add.query.get('sign'), crypto.createHmac('sha256', 'chave').update(`2001887/api/v2/product/add_item${ts2}AT42`).digest('hex'));

  // Produção BR usa o domínio brasileiro.
  const prodCalls = mockShopee();
  await shopee.publish({ ...ctx(), creds: { ...CREDS, environment: 'production' } }, panelas(), null);
  assert.equal(prodCalls.find((c) => c.path.startsWith('/api/')).host, 'openplatform.shopee.com.br');
});

test('autorização: link novo (sem assinatura, com state) e conta principal', async () => {
  const link = new URL(shopee.authorizeUrl({ creds: { ...CREDS, environment: 'production' }, redirectUri: 'https://hub.test/oauth/shopee/callback', state: 'S1' }));
  assert.equal(link.origin + link.pathname, 'https://open.shopee.com.br/auth');
  assert.deepEqual(Object.fromEntries(link.searchParams), {
    partner_id: '2001887', auth_type: 'seller', redirect_uri: 'https://hub.test/oauth/shopee/callback', response_type: 'code', state: 'S1',
  });
  const calls = mockShopee({ 'POST /api/v2/auth/token/get': () => ({ access_token: 'A', refresh_token: 'R', expire_in: 14400, shop_id_list: [11, 12] }) });
  const tokens = await shopee.handleCallback({ creds: CREDS, query: { code: 'c', main_account_id: '99' } });
  assert.deepEqual(find(calls, 'POST', '/api/v2/auth/token/get').body, { code: 'c', partner_id: 2001887, main_account_id: 99 });
  assert.equal(tokens.shop_id, '11');
  assert.deepEqual(tokens.shop_ids, ['11', '12']);
});

test('TÊNIS: 2 níveis padronizados, GTIN por variação, foto por cor, tabela de medidas e desconto por modelo', async () => {
  const calls = mockShopee();
  const res = await shopee.publish(ctx(), tenis(), null);
  assert.equal(res.externalId, '5001');

  const add = find(calls, 'POST', '/api/v2/product/add_item').body;
  assert.equal(add.item_status, 'UNLIST', 'nasce oculto até as variações existirem');
  assert.equal(add.condition, 'NEW');
  assert.equal(add.original_price, 299.9);
  assert.deepEqual(add.brand, { brand_id: 1001, original_brand_name: 'Nike' }, 'achou a marca na 2ª página');
  assert.deepEqual(add.attribute_list, [
    { attribute_id: 1, attribute_value_list: [{ value_id: 12 }] },
    { attribute_id: 2, attribute_value_list: [{ value_id: 21 }] },
  ]);
  assert.equal(add.gtin_code, undefined, 'GTIN vai por modelo');
  assert.deepEqual(add.logistic_info.map((l) => l.logistic_id), [90001, 90002], 'ignora canal inativo, mascarado e de frete customizado');
  assert.ok(add.size_chart_info.size_chart);
  const chartUpload = all(calls, 'POST', '/api/v2/media_space/upload_image').find((c) => c.form.get('scene') === 'desc');
  assert.ok(chartUpload, 'tabela de medidas sobe com scene=desc (sem recorte quadrado)');

  assert.deepEqual(slept, [5000], 'espera 5 s entre add_item e init_tier_variation');
  const initBody = find(calls, 'POST', '/api/v2/product/init_tier_variation').body;
  assert.equal(initBody.tier_variation, undefined);
  const [cor, tam] = initBody.standardise_tier_variation;
  assert.equal(cor.variation_id, 1);
  assert.equal(cor.variation_group_id, 11);
  assert.deepEqual(cor.variation_option_list.map((o) => [o.variation_option_id, o.variation_option_name, !!o.image_id]), [[101, 'Preto', true], [102, 'Branco', true]]);
  assert.deepEqual(tam.variation_option_list.map((o) => o.variation_option_id), [202, 203]);
  assert.equal(tam.variation_option_list[0].image_id, undefined, 'imagem só no 1º nível');
  assert.deepEqual(initBody.model.map((m) => [m.tier_index, m.model_sku, m.seller_stock[0].stock]), [
    [[0, 0], 'TEN-PT-40', 5], [[0, 1], 'TEN-PT-41', 3], [[1, 0], 'TEN-BR-40', 2],
  ]);
  assert.ok(initBody.model.every((m) => validGtin(m.gtin_code)));

  assert.deepEqual(find(calls, 'POST', '/api/v2/product/unlist_item').body, { item_list: [{ item_id: 5001, unlist: false }] });
  const disc = find(calls, 'POST', '/api/v2/discount/add_discount').body;
  assert.ok(disc.start_time >= Math.floor(Date.now() / 1000) + 3600, 'início ≥ 1 h no futuro');
  assert.ok(disc.end_time - disc.start_time >= 3600 && disc.end_time - disc.start_time < 180 * 86400);
  const di = find(calls, 'POST', '/api/v2/discount/add_discount_item').body;
  assert.deepEqual(di.item_list[0].model_list, [9000, 9001, 9002].map((model_id) => ({ model_id, model_promotion_price: 249.9 })));
  assert.deepEqual(res.meta.models, { 'TEN-PT-40': 9000, 'TEN-PT-41': 9001, 'TEN-BR-40': 9002 });
});

test('TÊNIS: categoria exige GTIN e uma variação não tem → recusa antes de criar', async () => {
  const calls = mockShopee();
  const p = tenis();
  p.variants[1].gtin = '7891000000029'; // dígito verificador errado
  await assert.rejects(shopee.publish(ctx(), p, null), /exige GTIN\/EAN válido \(variação TEN-PT-41/);
  assert.ok(!find(calls, 'POST', '/api/v2/product/add_item'));
});

test('TÊNIS: preço da variação mais cara > 4× a mais barata é recusado (regra BR)', async () => {
  mockShopee();
  const p = tenis();
  p.variants[2].price = 1299.9;
  await assert.rejects(shopee.publish(ctx(), p, null), /não pode passar de 4×/);
});

test('TÊNIS: categoria exige tabela de medidas', async () => {
  mockShopee();
  await assert.rejects(shopee.publish(ctx(), tenis({ sizeChart: null }), null), /exige tabela de medidas/);
});

test('ROUPA: tamanho padronizado com opção fora da lista, modelo de tabela, marca desconhecida e GTIN "00"', async () => {
  const calls = mockShopee();
  const res = await shopee.publish(ctx(), camiseta(), null);
  const add = find(calls, 'POST', '/api/v2/product/add_item').body;
  assert.deepEqual(add.brand, { brand_id: 0, original_brand_name: 'NoBrand' });
  assert.ok(res.warnings.some((w) => /Marca "Marca Própria" não está na lista/.test(w)));
  assert.deepEqual(add.size_chart_info, { size_chart_id: 556677 });
  assert.deepEqual(add.attribute_list, [
    { attribute_id: 30, attribute_value_list: [{ value_id: 0, original_value_name: 'Malha fria' }] },
    { attribute_id: 33, attribute_value_list: [{ value_id: 34 }, { value_id: 35 }] },
  ]);
  const [tam] = find(calls, 'POST', '/api/v2/product/init_tier_variation').body.standardise_tier_variation;
  assert.equal(tam.variation_id, 2, '"Tamanho" casa com "Size"');
  assert.deepEqual(tam.variation_option_list, [
    { variation_option_id: 301, variation_option_name: 'P' },
    { variation_option_id: 302, variation_option_name: 'M' },
    { variation_option_name: 'GG' },
  ]);
  const models = find(calls, 'POST', '/api/v2/product/init_tier_variation').body.model;
  assert.deepEqual(models.map((m) => [m.model_sku, m.original_price, m.gtin_code]), [['CAM-P', 59.9, '00'], ['CAM-M', 59.9, '00'], ['CAM-GG', 64.9, '00']]);
});

test('ROUPA: variação fora da lista padronizada usa estrutura livre com aviso', async () => {
  const calls = mockShopee();
  const p = camiseta({
    variants: [
      { sku: 'CAM-FL-P', options: { Estampa: 'Floral', Tamanho: 'P' }, stock: 1 },
      { sku: 'CAM-LI-P', options: { Estampa: 'Lisa', Tamanho: 'P' }, stock: 1 },
    ],
  });
  const res = await shopee.publish(ctx(), p, null);
  const body = find(calls, 'POST', '/api/v2/product/init_tier_variation').body;
  assert.deepEqual(body.tier_variation, [
    { name: 'Estampa', option_list: [{ option: 'Floral' }, { option: 'Lisa' }] },
    { name: 'Tamanho', option_list: [{ option: 'P' }] },
  ]);
  assert.ok(res.warnings.some((w) => /Estampa.*não existe na lista padronizada/.test(w)));
});

test('ROUPA: valor inválido em atributo de lista fechada é recusado', async () => {
  mockShopee();
  await assert.rejects(shopee.publish(ctx(), tenis({ attributes: { Material: 'Madeira', 'Gênero': 'Masculino' } }), null), /"Madeira" inválido para "Material"/);
});

test('UTENSÍLIO: categoria recomendada, unidade, inteiro, data, marca, GTIN "00", pré-venda, NCM e canal por peso', async () => {
  const calls = mockShopee();
  const res = await shopee.publish(ctx(), panelas(), null);
  const rec = find(calls, 'GET', '/api/v2/product/category_recommend');
  assert.equal(rec.query.get('product_cover_image'), 'img1', 'recomenda pela foto de capa');
  const add = find(calls, 'POST', '/api/v2/product/add_item').body;
  assert.equal(add.category_id, 100636);
  assert.deepEqual(add.attribute_list, [
    { attribute_id: 40, attribute_value_list: [{ value_id: 41 }] },
    { attribute_id: 43, attribute_value_list: [{ value_id: 0, original_value_name: '2.5', value_unit: 'L' }] },
    { attribute_id: 44, attribute_value_list: [{ value_id: 0, original_value_name: '5' }] },
    { attribute_id: 45, attribute_value_list: [{ value_id: 0, original_value_name: String(Date.UTC(2026, 2, 1) / 1000) }] },
  ]);
  assert.deepEqual(add.brand, { brand_id: 2001, original_brand_name: 'Tramontina' });
  assert.equal(add.gtin_code, '00', 'regra Flexible sem GTIN → "00"');
  assert.deepEqual(add.pre_order, { is_pre_order: true, days_to_ship: 10 });
  assert.deepEqual(add.tax_info, { ncm: '73239300', origin: '0' });
  assert.deepEqual(add.dimension, { package_length: 45, package_width: 30, package_height: 25 });
  assert.deepEqual(add.seller_stock, [{ stock: 12 }]);
  assert.equal(add.item_status, 'NORMAL');
  assert.deepEqual(add.logistic_info.map((l) => l.logistic_id), [90001, 90002]);
  assert.equal(find(calls, 'POST', '/api/v2/discount/add_discount_item').body.item_list[0].item_promotion_price, 329.9);
  assert.equal(res.meta.price, 389.9);

  // Peso acima do limite dos Correios (10 kg) → só Xpress.
  const heavy = mockShopee();
  const r2 = await shopee.publish(ctx(), panelas({ weightKg: 12 }), null);
  assert.deepEqual(find(heavy, 'POST', '/api/v2/product/add_item').body.logistic_info.map((l) => l.logistic_id), [90001]);
  assert.ok(r2.warnings.some((w) => /Correios: peso acima de 10 kg/.test(w)));
});

test('UTENSÍLIO: dimensões obrigatórias, atributo obrigatório e pré-venda fora da faixa', async () => {
  mockShopee();
  await assert.rejects(shopee.publish(ctx(), panelas({ lengthCm: null }), null), /exige dimensões do pacote/);
  await assert.rejects(shopee.publish(ctx(), panelas({ attributes: { Material: 'Inox' } }), null), /exige os atributos "Capacidade".*"Quantidade de Peças"/);
  await assert.rejects(shopee.publish(ctx(), panelas({ daysToShip: 45 }), null), /fora da faixa de pré-venda \[7, 30\]/);
  await assert.rejects(shopee.publish(ctx(), panelas({ attributes: { Material: 'Inox', Capacidade: '2 xícaras', 'Quantidade de Peças': '5' } }), null), /unidade inválida em "Capacidade"/);
});

test('UTENSÍLIO: atualização só de preço/estoque não chama update_item; falha por modelo vira aviso', async () => {
  mockShopee();
  const created = await shopee.publish(ctx(), panelas({ promoPrice: null }), null);
  const calls = mockShopee({ 'POST /api/v2/product/update_price': () => ({ response: { failure_list: [{ model_id: 0, failed_reason: 'error_cannt_edit_price_in_promotion' }] } }) });
  const res = await shopee.publish(ctx(), panelas({ promoPrice: null, price: 359.9, stock: 7 }), { external_id: '5001', meta: created.meta });
  assert.ok(!find(calls, 'POST', '/api/v2/product/update_item'), 'conteúdo igual não reenvia');
  assert.deepEqual(find(calls, 'POST', '/api/v2/product/update_price').body, { item_id: 5001, price_list: [{ model_id: 0, original_price: 359.9 }] });
  assert.deepEqual(find(calls, 'POST', '/api/v2/product/update_stock').body, { item_id: 5001, stock_list: [{ model_id: 0, seller_stock: [{ stock: 7 }] }] });
  assert.ok(res.warnings.some((w) => /Preço não atualizado.*cannt_edit_price_in_promotion/.test(w)));
  assert.equal(res.meta.price, undefined, 'preço não confirmado não é gravado');
  assert.equal(res.meta.stock, 7);
});

test('UTENSÍLIO: mudança de título usa update_item; inativo deslista e reativo relista', async () => {
  mockShopee();
  const created = await shopee.publish(ctx(), panelas({ promoPrice: null }), null);
  let calls = mockShopee();
  const r1 = await shopee.publish(ctx(), panelas({ promoPrice: null, title: 'Jogo de Panelas Antiaderente 5 Peças Vermelho' }), { external_id: '5001', meta: created.meta });
  assert.equal(find(calls, 'POST', '/api/v2/product/update_item').body.item_name, 'Jogo de Panelas Antiaderente 5 Peças Vermelho');

  calls = mockShopee();
  const meta = { ...created.meta, ...r1.meta };
  const off = await shopee.publish(ctx(), panelas({ promoPrice: null, title: 'Jogo de Panelas Antiaderente 5 Peças Vermelho', active: false }), { external_id: '5001', meta });
  assert.deepEqual(find(calls, 'POST', '/api/v2/product/unlist_item').body, { item_list: [{ item_id: 5001, unlist: true }] });
  assert.equal(off.meta.unlisted, true);
});

test('TÊNIS: atualizar estoque de uma variação só mexe nesse modelo; nova numeração reinicia a estrutura', async () => {
  mockShopee();
  const created = await shopee.publish(ctx(), tenis({ promoPrice: null }), null);
  let calls = mockShopee();
  const p = tenis({ promoPrice: null });
  p.variants[1].stock = 9;
  await shopee.publish(ctx(), p, { external_id: '5001', meta: created.meta });
  assert.deepEqual(find(calls, 'POST', '/api/v2/product/update_stock').body.stock_list, [{ model_id: 9001, seller_stock: [{ stock: 9 }] }]);
  assert.ok(!find(calls, 'POST', '/api/v2/product/init_tier_variation'));
  assert.ok(!find(calls, 'POST', '/api/v2/product/update_price'));

  calls = mockShopee();
  const bigger = tenis({ promoPrice: null });
  bigger.variants.push({ sku: 'TEN-PT-42', options: { Cor: 'Preto', Tamanho: '42' }, stock: 1, gtin: ean('789100000004'), images: [], price: 299.9, promoPrice: null, active: true });
  await shopee.publish(ctx(), bigger, { external_id: '5001', meta: created.meta });
  const init = find(calls, 'POST', '/api/v2/product/init_tier_variation');
  assert.equal(init.body.model.length, 4);
});

test('VÍDEO: upload em partes (Public), transcodificação pendente volta à fila e é anexado depois', async () => {
  let status = 'TRANSCODING';
  const calls = mockShopee({ 'GET /api/v2/media_space/get_video_upload_result': () => ({ response: { status } }) });
  const p = panelas({ promoPrice: null, videos: ['https://site.test/panela.mp4'] });
  const created = await shopee.publish(ctx(), p, null);
  const parts = all(calls, 'POST', '/api/v2/media_space/upload_video_part');
  assert.equal(parts.length, 2, '5 MB = partes de 4 MB + 1 MB');
  assert.ok(!parts[0].query.has('access_token'), 'upload_video_part é Public');
  assert.ok(find(calls, 'POST', '/api/v2/media_space/init_video_upload').query.has('access_token'), 'init_video_upload é Shop');
  assert.ok(!find(calls, 'POST', '/api/v2/media_space/complete_video_upload').query.has('access_token'), 'complete_video_upload é Public');
  assert.equal(find(calls, 'POST', '/api/v2/product/add_item').body.video_upload_id, undefined);
  assert.equal(created.followUpMs, 120000);
  assert.equal(created.meta.video.pending, true);

  status = 'SUCCEEDED';
  const calls2 = mockShopee({ 'GET /api/v2/media_space/get_video_upload_result': () => ({ response: { status } }) });
  const done = await shopee.publish(ctx(), p, { external_id: '5001', meta: created.meta });
  assert.ok(!find(calls2, 'POST', '/api/v2/media_space/init_video_upload'), 'não reenvia o arquivo');
  assert.deepEqual(find(calls2, 'POST', '/api/v2/product/update_item').body.video_upload_id, ['vid1']);
  assert.equal(done.followUpMs, undefined);
});

test('VÍDEO: formato diferente de MP4 é ignorado com aviso', async () => {
  const calls = mockShopee();
  const res = await shopee.publish(ctx(), panelas({ videos: ['https://site.test/v.mov'] }), null);
  assert.ok(!find(calls, 'POST', '/api/v2/media_space/init_video_upload'));
  assert.ok(res.warnings.some((w) => /só vídeo MP4/.test(w)));
});

test('falha nas variações depois do add_item guarda o item_id (não duplica na próxima tentativa)', async () => {
  mockShopee({ 'POST /api/v2/product/init_tier_variation': () => ({ error: 'error_param', message: 'tier_index overflow' }) });
  await assert.rejects(shopee.publish(ctx(), tenis(), null), (e) => {
    assert.equal(e.partial.externalId, '5001');
    assert.equal(e.partial.meta.unlisted, true);
    return true;
  });
});

test('desconto: error_list no add_discount_item vira aviso, sem derrubar a publicação', async () => {
  mockShopee({ 'POST /api/v2/discount/add_discount_item': () => ({ response: { count: 0, error_list: [{ item_id: 5001, fail_message: 'Promotion Sock should be less than current stock' }] } }) });
  const res = await shopee.publish(ctx(), panelas(), null);
  assert.equal(res.externalId, '5001');
  assert.ok(res.warnings.some((w) => /Desconto não aplicado: item 5001: Promotion Sock/.test(w)));
  assert.equal(res.meta.promo, undefined);
});

test('erro no corpo com HTTP 200 vira exceção', async () => {
  mockShopee({ 'POST /api/v2/product/add_item': () => ({ error: 'product.error_busi', message: 'Condition is required for BR' }) });
  await assert.rejects(shopee.publish(ctx(), panelas(), null), /product.error_busi — Condition is required/);
});

test('GTIN: dígito verificador GS1', () => {
  assert.ok(validGtin('7891234567895'));
  assert.ok(!validGtin('7891234567890'));
  assert.ok(validGtin('012345678905'));
  assert.ok(!validGtin('123'));
});
