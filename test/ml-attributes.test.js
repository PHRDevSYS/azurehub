'use strict';
// Atributos do Mercado Livre por categoria, com os atributos REAIS de duas
// categorias do MLB (API pública /categories/{id}/attributes, out/2026):
// MLB31447 (Camisetas e Regatas) e MLB1055 (Celulares e Smartphones).
const test = require('node:test');
const assert = require('node:assert/strict');
const MA = require('../src/platforms/ml-attributes');
const ml = require('../src/platforms/mercadolivre');
const { normalizeProduct } = require('../src/source/normalize');

const CAMISETA = require('./fixtures/ml-MLB31447-attributes.json');
const CELULAR = require('./fixtures/ml-MLB1055-attributes.json');
const byId = (list, id) => list.find((a) => a.id === id);

const camiseta = (attributes, over = {}) => normalizeProduct({
  sku: 'CAM-1', title: 'Camiseta Básica', price: 59.9, stock: 3, brand: 'Minha Marca', model: 'Básica',
  images: ['https://site.test/c.jpg'], categories: { mercadolivre: 'MLB31447' }, attributes, ...over,
});
const FULL = { 'Gênero': 'Masculino', 'Tipo de roupa': 'Camiseta', 'Tipo de manga': 'curta', 'Material principal': 'Algodão', Cor: 'Preto' };

test('nomes em português viram os ids e formatos do ML (lista, sim/não, texto conhecido)', () => {
  const r = MA.buildAttributes(camiseta({ ...FULL, 'Com materiais reciclados': 'não' }), CAMISETA);
  assert.deepEqual(r.errors, []);
  const get = (id) => r.attributes.find((a) => a.id === id);
  assert.deepEqual(get('GENDER'), { id: 'GENDER', value_id: byId(CAMISETA, 'GENDER').values.find((v) => v.name === 'Masculino').id, value_name: 'Masculino' });
  assert.equal(get('SLEEVE_TYPE').value_name, 'Curta', 'caixa e acento não importam; vai o nome da lista');
  assert.deepEqual(get('WITH_RECYCLED_MATERIALS'), { id: 'WITH_RECYCLED_MATERIALS', value_id: '242084', value_name: 'Não' }, 'booleano vai pelo value_id');
  assert.ok(get('MAIN_MATERIAL').value_id, 'texto que bate com valor conhecido leva o value_id');
  assert.equal(get('BRAND').value_name, 'Minha Marca', 'marca fora da lista sugerida vai como texto');
  assert.equal(get('COLOR').value_name, 'Preto');
});

test('obrigatório faltando e valor fora da lista viram erro com as opções', () => {
  let r = MA.buildAttributes(camiseta({ 'Gênero': 'Masculino' }), CAMISETA);
  const msg = r.errors.join(' | ');
  for (const id of ['GARMENT_TYPE', 'SLEEVE_TYPE', 'MAIN_MATERIAL', 'COLOR']) assert.match(msg, new RegExp(id));
  assert.match(msg, /"Tipo de manga" \(SLEEVE_TYPE: Curta \/ Longa/);
  assert.doesNotMatch(msg, /GTIN|SELLER_SKU|PACKAGE/, 'GTIN, SKU e pacote são tratados à parte');

  r = MA.buildAttributes(camiseta({ ...FULL, 'Tipo de manga': 'Média' }), CAMISETA);
  assert.match(r.errors.join(), /valor "Média" inválido para "Tipo de manga" \(SLEEVE_TYPE\)\. Opções: Curta \/ Longa \/ 3\/4/);
  r = MA.buildAttributes(camiseta({ ...FULL, 'Com materiais reciclados': 'talvez' }), CAMISETA);
  assert.match(r.errors.join(), /aceita só Sim ou Não/);
});

test('com variações, os eixos (Cor) não são exigidos no item', () => {
  const p = camiseta({ 'Gênero': 'Masculino', 'Tipo de roupa': 'Camiseta', 'Tipo de manga': 'Curta', 'Material principal': 'Algodão' });
  assert.match(MA.buildAttributes(p, CAMISETA).errors.join(), /COLOR/);
  assert.deepEqual(MA.buildAttributes(p, CAMISETA, { exclude: ['COLOR'] }).errors, []);
});

test('número com unidade, número e obrigatórios de celular', () => {
  const cel = (attributes) => normalizeProduct({ sku: 'CEL', title: 'Celular', price: 999, stock: 1, brand: 'Marca', model: 'X1', images: ['https://site.test/x.jpg'], attributes });
  const base = { 'É Dual SIM': 'sim', Operadora: 'Desbloqueado', Fabricante: 'Fabricante X', 'Número de homologação da Anatel': '12345', 'Modelo alfanumérico': 'RMX3624', Cor: 'Preto' };
  let r = MA.buildAttributes(cel({ ...base, 'Memória interna': '128GB', 'Memória RAM': '8', 'Velocidade do processador': '2,4 ghz' }), CELULAR);
  assert.deepEqual(r.errors, []);
  const get = (id) => r.attributes.find((a) => a.id === id);
  assert.equal(get('INTERNAL_MEMORY').value_name, '128 GB', '"128GB" → "128 GB"');
  assert.equal(get('RAM').value_name, '8 GB', 'sem unidade: usa a unidade padrão');
  assert.equal(get('PROCESSOR_SPEED').value_name, '2.4 GHz');
  assert.equal(get('CELLPHONES_ANATEL_HOMOLOGATION_NUMBER').value_name, '12345');
  assert.equal(get('IS_DUAL_SIM').value_name, 'Sim');

  r = MA.buildAttributes(cel({ ...base, 'Memória interna': '128 litros', 'Número de homologação da Anatel': 'ABC' }), CELULAR);
  assert.match(r.errors.join(), /unidade "litros" não aceita\. Use GB, KB, MB, TB/);
  assert.match(r.errors.join(), /precisa ser um número/);

  r = MA.buildAttributes(cel({ Cor: 'Preto' }), CELULAR);
  for (const id of ['IS_DUAL_SIM', 'CARRIER', 'MANUFACTURER', 'CELLPHONES_ANATEL_HOMOLOGATION_NUMBER', 'ALPHANUMERIC_MODELS']) assert.match(r.errors.join(), new RegExp(id));
});

test('pacote vira SELLER_PACKAGE_* inteiros (cm e g); atributos do ML e desconhecidos', () => {
  const r = MA.buildAttributes(camiseta({ ...FULL, 'Origem do dado do pacote de envio': 'x', 'Cor do bolso': 'Azul', GRID_ID: '123' },
    { lengthCm: 30.2, widthCm: 25, heightCm: 2.1, weightKg: 0.2141 }), CAMISETA);
  assert.deepEqual(r.attributes.filter((a) => a.id.startsWith('SELLER_PACKAGE_')).map((a) => [a.id, a.value_name]), [
    ['SELLER_PACKAGE_HEIGHT', '3 cm'], ['SELLER_PACKAGE_WIDTH', '25 cm'], ['SELLER_PACKAGE_LENGTH', '31 cm'], ['SELLER_PACKAGE_WEIGHT', '215 g']]);
  assert.match(r.warnings.join(), /"Origem do dado do pacote de envio" \(SELLER_PACKAGE_DATA_SOURCE\) é definido pelo ML/);
  assert.match(r.warnings.join(), /"Cor do bolso" não existe nesta categoria/);
  assert.ok(r.attributes.some((a) => a.id === 'GRID_ID' && a.value_name === '123'), 'id no formato do ML vai como veio');
});

// ============================================================ no conector
const ctx = () => ({ creds: { client_id: 'app', listing_type_id: 'gold_special', shipping_mode: 'me2' }, tokens: { access_token: 'AT', user_id: 99 } });
const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; ml._internal.categoryCache.clear(); ml._internal.sellerTags.clear(); });

function mock(routes = {}) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || 'GET', path: u.pathname, body });
    const key = `${init.method || 'GET'} ${u.pathname}`;
    const defaults = {
      'GET /categories/MLB31447': () => ({ id: 'MLB31447', name: 'Camisetas e Regatas', attribute_types: 'variations', settings: { max_title_length: 60 } }),
      'GET /categories/MLB31447/attributes': () => CAMISETA,
      'POST /categories/MLB31447/attributes/conditional': () => ({ required_attributes: [] }),
      'POST /items': () => ({ id: 'MLB55', permalink: 'https://ml/MLB55' }),
      'GET /users/me': () => ({ id: 99, tags: ['normal'] }),
    };
    const handler = routes[key] || defaults[key];
    return new Response(JSON.stringify(handler ? handler(u, body) : {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

test('ML: produto simples envia os atributos convertidos e confere os condicionais antes de criar', async () => {
  const calls = mock();
  const res = await ml.publish(ctx(), camiseta(FULL, { lengthCm: 30, widthCm: 25, heightCm: 3, weightKg: 0.2 }), null);
  assert.equal(res.externalId, 'MLB55');
  const cond = calls.find((c) => c.path === '/categories/MLB31447/attributes/conditional');
  assert.ok(cond, 'categoria tem UNITS_PER_PACK condicional');
  const post = calls.find((c) => c.method === 'POST' && c.path === '/items').body;
  const ids = post.attributes.map((a) => a.id);
  for (const id of ['SELLER_SKU', 'BRAND', 'MODEL', 'GENDER', 'GARMENT_TYPE', 'SLEEVE_TYPE', 'MAIN_MATERIAL', 'COLOR', 'SELLER_PACKAGE_WEIGHT', 'EMPTY_GTIN_REASON']) assert.ok(ids.includes(id), id);
  assert.ok(calls.indexOf(cond) < calls.findIndex((c) => c.method === 'POST' && c.path === '/items'));
});

test('ML: obrigatório faltando ou condicional exigido barra antes de chamar POST /items', async () => {
  let calls = mock();
  await assert.rejects(ml.publish(ctx(), camiseta({ 'Gênero': 'Masculino' }), null), /a categoria exige .*SLEEVE_TYPE/);
  assert.ok(!calls.some((c) => c.method === 'POST' && c.path === '/items'));

  calls = mock({ 'POST /categories/MLB31447/attributes/conditional': () => ({ required_attributes: [{ id: 'UNITS_PER_PACK', name: 'Quantidade de camisetas por kit' }] }) });
  await assert.rejects(ml.publish(ctx(), camiseta(FULL), null), /para este produto a categoria exige "Quantidade de camisetas por kit" \(UNITS_PER_PACK\)/);
  assert.ok(!calls.some((c) => c.method === 'POST' && c.path === '/items'));

  mock();
  const ok = await ml.publish(ctx(), camiseta({ ...FULL, 'Quantidade de camisetas por kit': 3 }), null);
  assert.equal(ok.externalId, 'MLB55', 'informado o condicional, segue');
});

test('ML PRÉVIA: mostra os atributos obrigatórios faltando com as opções', async () => {
  mock();
  const r = await ml.preview(ctx(), camiseta({ 'Gênero': 'Masculino', Cor: 'Preto' }));
  assert.match(r.errors.join(), /SLEEVE_TYPE: Curta \/ Longa/);
  assert.match(r.fields.find((f) => f.label === 'Atributos enviados').value, /GENDER/);
  const ok = await ml.preview(ctx(), camiseta(FULL));
  assert.deepEqual(ok.errors, []);
});

test('ML: anúncio já publicado não trava preço/estoque por atributo — vira aviso', async () => {
  const calls = mock({ 'PUT /items/MLB55': () => ({ id: 'MLB55' }) });
  const res = await ml.publish(ctx(), camiseta({ 'Gênero': 'Masculino', 'Tipo de manga': 'Média' }, { price: 49.9 }),
    { external_id: 'MLB55', meta: { category_id: 'MLB31447' } });
  const put = calls.find((c) => c.method === 'PUT' && c.path === '/items/MLB55' && c.body.price);
  assert.equal(put.body.price, 49.9, 'preço atualizado mesmo com atributo pendente');
  assert.ok(!put.body.attributes.some((a) => a.id === 'SLEEVE_TYPE'), 'valor inválido não vai');
  assert.match(res.warnings.join(), /atributo não atualizado — valor "Média" inválido/);
  assert.match(res.warnings.join(), /atributo não atualizado — a categoria exige/);
});
