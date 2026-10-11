'use strict';
// Módulo de Precificação: similaridade, robots.txt, fontes de pesquisa (com
// fetch simulado), regras de preço, preço efetivo no envio e rotas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurehub-pz-'));
process.env.HUB_DATA_DIR = dir;
process.env.HUB_SECRET = 'teste';
process.env.PUBLIC_URL = 'http://hub.test';

const { createServer } = require('../src/server');
const store = require('../src/lib/store');
const { similarity, buildQuery, parsePrice, markOutliers, stats } = require('../src/pricing/match');
const pzHttp = require('../src/pricing/http');
const pricing = require('../src/pricing');
const research = require('../src/pricing/research');
const storefronts = require('../src/pricing/sources/storefronts');
const html = require('../src/pricing/sources/html');
const scrapling = require('../src/pricing/sources/scrapling');
const ml = require('../src/pricing/sources/mercadolivre');

const realFetch = global.fetch;
pzHttp.timing.sleep = async () => {}; // sem esperas reais entre requisições
let server;
let base;
let cookie = '';

async function call(method, url, body) {
  const res = await realFetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ------------------------------------------------- concorrentes simulados
const hits = [];
const CAT = [
  ['Tênis Corrida Run Pro Nike Preto', 264.9], ['Tênis Nike Run Pro Corrida Masculino', 279.9], ['Tênis Run Pro Nike Corrida Usado', 120],
  ['Meia Esportiva Nike Run', 39.9], ['Tênis Corrida Run Pro Nike Edição Ouro', 1899.9],
  ['Garrafa Térmica Stanley Inox 1L', 249.9], ['Garrafa Térmica Stanley Inox 500ml', 149.9],
];
const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const find = (q) => { const t = norm(q).split(/\s+/).filter((w) => w.length > 2); return CAT.filter(([n]) => t.filter((w) => norm(n).includes(w)).length >= 2); };
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(url, opts = {}) {
  const u = new URL(String(url));
  hits.push({ url: u.href, ua: (opts.headers || {})['User-Agent'] });
  if (u.pathname === '/robots.txt') {
    if (u.host === 'bloqueada.test') return Promise.resolve(new Response('User-agent: *\nDisallow: /wp-json/\n'));
    if (u.host === 'fora.test') return Promise.resolve(new Response('erro', { status: 503 }));
    return Promise.resolve(new Response('User-agent: *\nDisallow: /checkout\n'));
  }
  if (u.host === 'woo.test' && u.pathname === '/wp-json/wc/store/v1/products') {
    return Promise.resolve(json(find(u.searchParams.get('search')).map(([n, p], i) => ({ name: n, permalink: `https://woo.test/p/${i}`, is_in_stock: true, prices: { price: String(Math.round(p * 100)), currency_minor_unit: 2 } }))));
  }
  if (u.host === 'vtex.test' && u.pathname === '/api/catalog_system/pub/products/search') {
    const fq = u.searchParams.get('fq');
    if (fq) return Promise.resolve(json(fq === 'alternateIds_Ean:7891234567895' ? [{ productName: 'Jogo de Panelas Tramontina 5 Peças', brand: 'Tramontina', link: 'https://vtex.test/panelas/p', items: [{ ean: '7891234567895', sellers: [{ commertialOffer: { Price: 299.9, AvailableQuantity: 3 } }] }, { ean: '7891234567895', sellers: [{ commertialOffer: { Price: 199, AvailableQuantity: 0 } }] }] }] : []));
    return Promise.resolve(json(find(u.searchParams.get('ft')).map(([n, p]) => ({ productName: n, link: `https://vtex.test/${encodeURIComponent(n)}/p`, items: [{ ean: '', sellers: [{ commertialOffer: { Price: p + 5, AvailableQuantity: 10 } }] }] }))));
  }
  if (u.host === 'shop.test' && u.pathname === '/search/suggest.json') {
    return Promise.resolve(json({ resources: { results: { products: [
      { title: 'Garrafa Térmica Stanley Inox 1L', price: '239.90', url: '/products/garrafa', vendor: 'Stanley', available: true },
      { title: 'Garrafa Térmica Stanley Inox 1L Esgotada', price: '199.00', url: '/products/garrafa-2', vendor: 'Stanley', available: false },
    ] } } }));
  }
  if (u.host === 'loja.test' && u.pathname === '/garrafa') {
    return Promise.resolve(new Response(`<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Product', name: 'Garrafa Térmica Inox 1L Stanley', offers: { '@type': 'Offer', price: '229.90', availability: 'https://schema.org/InStock' } }] })}</script></head></html>`));
  }
  if (u.host === 'meta.test') {
    return Promise.resolve(new Response('<html><head><title>Garrafa X</title><meta property="product:price:amount" content="219,90"></head></html>'));
  }
  if (u.host === 'api.mercadolibre.com') {
    if (u.pathname === '/products/search') return Promise.resolve(json({ results: [{ id: 'MLB123', name: 'Garrafa Térmica Stanley 1L' }] }));
    if (u.pathname === '/products/MLB123/items') return Promise.resolve(json({ results: [{ item_id: 'MLB999', price: 244.5, condition: 'new' }, { item_id: 'MLB998', price: 99, condition: 'used' }] }));
  }
  return Promise.resolve(new Response('não encontrado', { status: 404 }));
}

function resetHttp() {
  pzHttp.cache.clear();
  pzHttp.robotsCache.clear();
  pzHttp.lastByHost.clear();
  hits.length = 0;
}

test.before(async () => {
  global.fetch = fakeFetch;
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

// ================================================================ unidade
test('similaridade: mesmo produto alto; volume diferente e acessório baixos', () => {
  const p = { title: 'Garrafa Térmica Inox 1L', brand: 'Stanley' };
  assert.ok(similarity(p, 'Garrafa Térmica Stanley Inox 1L') >= 0.9);
  assert.ok(similarity(p, 'Garrafa Térmica Inox 1 L Stanley') >= 0.9, 'normaliza "1 L"');
  assert.ok(similarity(p, 'Garrafa Térmica Stanley Inox 500ml') < 0.45, '1L × 500ml');
  const t = { title: 'Tênis Corrida Run Pro', brand: 'Nike' };
  assert.ok(similarity(t, 'Meia Esportiva Nike Run') < 0.45);
  assert.ok(similarity(t, 'TENIS CORRIDA RUN PRO NIKE') >= 0.9, 'ignora acentos e caixa');
});

test('busca: título + marca e GTIN só quando válido', () => {
  assert.deepEqual(buildQuery({ title: 'Jogo de Panelas 5 Peças', brand: 'Tramontina', gtin: '7891234567895' }),
    { text: 'Jogo Panelas 5 Peças Tramontina', gtin: '7891234567895', brand: 'Tramontina' });
  assert.equal(buildQuery({ title: 'Panela Tramontina', brand: 'Tramontina', gtin: '123' }).text, 'Panela Tramontina');
  assert.equal(buildQuery({ title: 'X', gtin: '123' }).gtin, null);
});

test('preço: formatos brasileiro e internacional', () => {
  assert.equal(parsePrice('R$ 1.234,56'), 1234.56);
  assert.equal(parsePrice('1,234.56'), 1234.56);
  assert.equal(parsePrice('R$ 99,9'), 99.9);
  assert.equal(parsePrice('1.299'), 1299);
  assert.equal(parsePrice(49.9), 49.9);
  assert.equal(parsePrice('grátis'), null);
  assert.equal(parsePrice(0), null);
});

test('estatística descarta preços fora da curva', () => {
  const offers = [100, 105, 110, 98, 20, 900].map((price) => ({ price }));
  const marked = markOutliers(offers);
  assert.deepEqual(marked.filter((o) => o.outlier).map((o) => o.price), [20, 900]);
  assert.deepEqual(stats(marked.filter((o) => !o.outlier).map((o) => o.price)), { count: 4, min: 98, max: 110, median: 102.5, avg: 103.25 });
  assert.equal(stats([]), null);
});

test('robots.txt: regra mais longa vence, grupo do robô, âncora $ e Disallow vazio', () => {
  const g = pzHttp.parseRobots(`
User-agent: *
Disallow: /busca
Allow: /busca/publica
Disallow: /*.pdf$

User-agent: AzureHubPriceBot
User-agent: OutroBot
Disallow: /privado

User-agent: Livre
Disallow:
`);
  assert.equal(pzHttp.isAllowed(g, '/busca?q=x', 'qualquer'), false);
  assert.equal(pzHttp.isAllowed(g, '/busca/publica?q=x', 'qualquer'), true);
  assert.equal(pzHttp.isAllowed(g, '/manual.pdf', 'qualquer'), false);
  assert.equal(pzHttp.isAllowed(g, '/manual.pdf?v=1', 'qualquer'), true);
  // O grupo específico substitui o "*": /busca liberada para o AzureHubPriceBot.
  assert.equal(pzHttp.isAllowed(g, '/busca?q=x'), true);
  assert.equal(pzHttp.isAllowed(g, '/privado/x'), false);
  assert.equal(pzHttp.isAllowed(g, '/qualquer', 'livre'), true);
});

test('arredondamento do sugerido é sempre para baixo', () => {
  assert.equal(pricing.roundPrice(152.37, '90'), 151.9);
  assert.equal(pricing.roundPrice(152.95, '90'), 152.9);
  assert.equal(pricing.roundPrice(152.37, '99'), 151.99);
  assert.equal(pricing.roundPrice(152.371, 'cent'), 152.37);
  assert.equal(pricing.roundPrice(0.5, '90'), 0.5);
});

test('regras: mínimo, médio, sugerido, piso e teto', () => {
  const cfg = { ...pricing.DEFAULTS, enabled: true };
  const market = { stats: { count: 5, min: 80, max: 120, median: 90, avg: 95 } };
  let ev = pricing.evaluate({ price: 120, promoPrice: 100 }, market, null, cfg);
  assert.equal(ev.origin, 100, 'origem = promoção');
  assert.equal(ev.floor, 70);
  assert.equal(ev.values.minimo.price, 80);
  assert.equal(ev.values.medio.price, 90);
  assert.equal(ev.values.sugerido.price, 86.9, 'mediana 90 − 3% = 87,30 → 86,90');
  assert.equal(ev.effective, 100, 'sem preço definido vale a origem');

  // Custo 85 + 10% = piso 93,50: nada abaixo disso.
  ev = pricing.evaluate({ price: 100, cost: 85 }, market, null, cfg);
  assert.equal(ev.floor, 93.5);
  assert.deepEqual([ev.values.minimo.price, ev.values.minimo.clamped], [93.5, true]);
  assert.equal(ev.values.sugerido.price, 93.5);

  // Mercado acima da origem: a origem é o teto.
  ev = pricing.evaluate({ price: 50 }, market, { price: 49.9, strategy: 'manual' }, cfg);
  assert.equal(ev.values.minimo.price, 50);
  assert.equal(ev.values.sugerido.price, 50);
  assert.equal(ev.effective, 49.9);
  assert.equal(ev.belowMarket, true);

  // Variações: a mais barata é a referência.
  ev = pricing.evaluate({ price: 0, variants: [{ price: 60, promoPrice: 55 }, { price: 58 }] }, null, null, cfg);
  assert.equal(ev.origin, 55);
  assert.equal(ev.values.minimo.price, null);
  assert.match(ev.values.sugerido.note, /sem dados de mercado/);
});

// ============================================================= fontes
const q = (text, gtin = null) => ({ text, gtin, brand: null });

test('WooCommerce, VTEX (texto e EAN) e Shopify: preços normalizados e só itens disponíveis', async () => {
  resetHttp();
  const woo = await storefronts.woocommerce.search({ base_url: 'https://woo.test/' }, q('Garrafa Térmica Stanley'));
  assert.deepEqual(woo.map((o) => o.price), [249.9, 149.9]);
  const vt = await storefronts.vtex.search({ base_url: 'https://vtex.test' }, q('x', '7891234567895'));
  assert.deepEqual(vt, [{ title: 'Jogo de Panelas Tramontina 5 Peças', price: 299.9, url: 'https://vtex.test/panelas/p', gtin: '7891234567895', brand: 'Tramontina', condition: 'new' }]);
  const sh = await storefronts.shopify.search({ base_url: 'https://shop.test' }, q('Garrafa'));
  assert.deepEqual(sh.map((o) => [o.price, o.url]), [[239.9, 'https://shop.test/products/garrafa']]);
  assert.ok(hits.every((h) => /^AzureHubPriceBot\//.test(h.ua)), 'o robô sempre se identifica');
  assert.match(pzHttp.USER_AGENT, /^[\x20-\x7e]+$/, 'User-Agent só com ASCII');
  assert.ok(hits.some((h) => h.url === 'https://woo.test/robots.txt'), 'consulta o robots.txt');
});

test('respeita robots.txt (bloqueio e 5xx) e usa cache', async () => {
  resetHttp();
  await assert.rejects(storefronts.woocommerce.search({ base_url: 'https://bloqueada.test' }, q('Garrafa')), /robots\.txt/);
  await assert.rejects(storefronts.woocommerce.search({ base_url: 'https://fora.test' }, q('Garrafa')), /robots\.txt/);
  assert.ok(!hits.some((h) => h.url.includes('/wp-json/')), 'nenhuma busca em site bloqueado');
  // Só quem desliga explicitamente passa (site próprio/autorizado).
  // (o site simulado não tem catálogo: chegar ao 404 prova que passou do robots.txt)
  await assert.rejects(storefronts.woocommerce.search({ base_url: 'https://bloqueada.test', respect_robots: false }, q('Garrafa')), /HTTP 404/);
  // Cache: a mesma busca não sai de novo.
  await storefronts.woocommerce.search({ base_url: 'https://woo.test' }, q('Garrafa Térmica'));
  const n = hits.length;
  await storefronts.woocommerce.search({ base_url: 'https://woo.test' }, q('Garrafa Térmica'));
  assert.equal(hits.length, n);
});

test('HTML: JSON-LD (@graph) e metatags de preço', async () => {
  resetHttp();
  assert.deepEqual((await html.fetchPage('https://loja.test/garrafa', {})).map((o) => [o.title, o.price]), [['Garrafa Térmica Inox 1L Stanley', 229.9]]);
  assert.deepEqual((await html.fetchPage('https://meta.test/x', {})).map((o) => [o.title, o.price]), [['Garrafa X', 219.9]]);
  await assert.rejects(html.search({ search_url: 'https://loja.test/busca' }, q('x')), /\{query\}/);
  assert.deepEqual(await html.search({ search_url: 'https://loja.test/ean/{gtin}' }, q('x')), [], 'sem GTIN não busca por GTIN');
});

test('Mercado Livre: API oficial com o token da conta conectada', async () => {
  resetHttp();
  await assert.rejects(ml.search({}, q('Garrafa'), null), /conecte a conta/);
  const ctx = { platform: async () => ({ tokens: { access_token: 'TOK' }, creds: {} }) };
  const out = await ml.search({}, q('Garrafa', '7891234567895'), ctx);
  assert.deepEqual(out.map((o) => [o.price, o.condition, o.url]), [[244.5, 'new', 'https://produto.mercadolivre.com.br/MLB-999'], [99, 'used', 'https://produto.mercadolivre.com.br/MLB-998']]);
  assert.ok(hits[0].url.includes('/products/search?status=active&site_id=MLB&product_identifier=7891234567895'));
});

test('Scrapling: Node valida robots e chama o trabalhador Python (simulado)', async () => {
  resetHttp();
  const orig = scrapling.runner.command;
  const fake = `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);
    console.log(JSON.stringify({ok:true,items:[{title:'Garrafa Stanley 1L',price:'R$ 1.249,90',url:r.url+'#'+encodeURIComponent(r.user_agent)},{title:'Sem preço',price:'',url:r.url}]}))})`;
  scrapling.runner.command = () => [process.execPath, '-e', fake];
  try {
    const src = { search_url: 'https://woo.test/busca?q={query}', item: '.p', title: '.t::text', price: '.v::text' };
    const out = await scrapling.search(src, q('Garrafa 1L'));
    assert.equal(out.length, 1);
    assert.equal(out[0].price, 1249.9);
    assert.match(decodeURIComponent(out[0].url), /busca\?q=Garrafa 1L#AzureHubPriceBot\//);
    await assert.rejects(scrapling.search({ ...src, search_url: 'https://bloqueada.test/wp-json/busca?q={query}' }, q('x')), /robots\.txt/);
    scrapling.runner.command = () => [process.execPath, '-e', 'console.log(JSON.stringify({ok:false,error:"Scrapling não instalado"}))'];
    await assert.rejects(scrapling.search(src, q('x')), /Scrapling não instalado/);
  } finally {
    scrapling.runner.command = orig;
  }
});

// ============================================================ fluxo
let apiKey;
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function waitResearch() {
  for (let i = 0; i < 100; i++) {
    const st = (await call('GET', '/api/pricing/research')).body;
    if (!st.running) return st;
    await wait(30);
  }
  throw new Error('pesquisa não terminou');
}

test('fluxo: módulo, fontes, pesquisa, aplicação em massa, manual e envio', async () => {
  resetHttp();
  let r = await call('POST', '/api/install', { email: 'adm@x.com', password: '12345678', source: { type: 'api' } });
  assert.equal(r.status, 200);
  apiKey = r.body.apiKey;
  const push = (p) => realFetch(`${base}/api/v1/products`, { method: 'POST', headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
  assert.equal((await push({ sku: 'TEN', title: 'Tênis Corrida Run Pro', brand: 'Nike', price: 299.9, promoPrice: 289.9, stock: 5, images: ['https://img.test/1.jpg'] })).status, 200);
  assert.equal((await push({ sku: 'GAR', title: 'Garrafa Térmica Inox 1L', brand: 'Stanley', price: 259.9, cost: 150, stock: 3, images: ['https://img.test/2.jpg'],
    variants: [{ sku: 'GAR-PT', options: { Cor: 'Preta' }, price: 259.9, stock: 1 }, { sku: 'GAR-VD', options: { Cor: 'Verde' }, price: 269.9, stock: 2 }] })).status, 200);

  // Módulo desligado: rota de módulos e preço de envio inalterado.
  assert.deepEqual((await call('GET', '/api/modules')).body, { pricing: false });
  r = await call('POST', '/api/pricing/research', { skus: ['TEN'] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /fonte/);

  // Validação das fontes.
  r = await call('PUT', '/api/pricing/settings', { sources: [{ type: 'woocommerce', name: 'Woo' }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /obrigatório/);
  r = await call('PUT', '/api/pricing/settings', { sources: [{ type: 'html', search_url: 'ftp://x/{query}' }] });
  assert.equal(r.status, 400);
  r = await call('PUT', '/api/pricing/settings', { sources: [{ type: 'nada' }] });
  assert.equal(r.status, 400);

  r = await call('PUT', '/api/pricing/settings', {
    enabled: true, undercutPct: 2, rounding: '90',
    sources: [
      { type: 'woocommerce', name: 'Woo', base_url: 'https://woo.test', interval_ms: 10 },
      { type: 'vtex', name: 'VTEX', base_url: 'https://vtex.test' },
      { type: 'woocommerce', name: 'Bloqueada', base_url: 'https://bloqueada.test' },
      { type: 'shopify', name: 'Desligada', base_url: 'https://shop.test', enabled: false },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.settings.sources[0].interval_ms, 1000, 'intervalo mínimo de 1 s');
  assert.deepEqual((await call('GET', '/api/modules')).body, { pricing: true });
  const types = (await call('GET', '/api/pricing/settings')).body.sourceTypes.map((t) => t.type);
  assert.deepEqual(types.sort(), ['html', 'mercadolivre', 'scrapling', 'shopify', 'vtex', 'woocommerce']);

  // URL monitorada para a garrafa.
  r = await call('PUT', '/api/pricing/GAR/watch', { urls: 'https://loja.test/garrafa\nhttps://loja.test/garrafa' });
  assert.deepEqual(r.body.watch, ['https://loja.test/garrafa']);
  assert.equal((await call('PUT', '/api/pricing/GAR/watch', { urls: 'javascript:alert(1)' })).status, 400);

  r = await call('POST', '/api/pricing/research', { skus: ['TEN', 'GAR'] });
  assert.equal(r.status, 200);
  const st = await waitResearch();
  assert.equal(st.done, 2);
  assert.ok(!hits.some((h) => h.url.startsWith('https://shop.test')), 'fonte desligada não é consultada');

  const ten = (await call('GET', '/api/pricing/TEN')).body;
  const offers = ten.research.offers;
  assert.ok(offers.find((o) => /Usado/.test(o.title) && !o.accepted && o.reason === 'usado'), 'título com "Usado" é descartado');
  assert.ok(offers.find((o) => /Meia/.test(o.title) && /similaridade/.test(o.reason)));
  assert.ok(offers.find((o) => /Ouro/.test(o.title) && o.reason === 'preço fora da curva'));
  assert.deepEqual(ten.research.sources.map((s) => [s.name, s.ok]), [['Woo', true], ['VTEX', true], ['Bloqueada', false]]);
  assert.match(ten.sourcesFailed[0], /robots/);
  assert.deepEqual(ten.market, { count: 4, min: 264.9, max: 284.9, median: 274.9, avg: 274.9 });
  assert.equal(ten.values.sugerido.price, 268.9, 'mediana 274,90 − 2% = 269,40 → 268,90');

  const gar = (await call('GET', '/api/pricing/GAR')).body;
  assert.ok(gar.research.offers.find((o) => o.source === 'URL monitorada' && o.price === 229.9 && o.accepted));
  assert.ok(gar.research.offers.find((o) => /500ml/.test(o.title) && !o.accepted), '500ml não é a garrafa de 1L');
  assert.equal(gar.origin, 259.9, 'variação mais barata');
  assert.equal(gar.cost, 150);

  // Em massa: mínimo.
  r = await call('POST', '/api/pricing/apply', { skus: ['TEN', 'GAR'], strategy: 'minimo' });
  assert.deepEqual([r.body.applied, r.body.skipped.length], [2, 0]);
  let grid = (await call('GET', '/api/pricing?skus=TEN,GAR')).body;
  assert.deepEqual(grid.items.map((i) => [i.sku, i.price, i.strategy]), [['TEN', 264.9, 'minimo'], ['GAR', 229.9, 'minimo']]);
  assert.equal((await call('POST', '/api/pricing/apply', { skus: ['TEN'], strategy: 'xpto' })).status, 400);

  // A grade de Produtos mostra o preço de venda.
  const prods = (await call('GET', '/api/products?limit=10')).body.items;
  assert.equal(prods.find((p) => p.sku === 'TEN').salePrice, 264.9);

  // Preço efetivo: variações proporcionais, sem promoção.
  let eff = pricing.effectiveProduct(store.getProduct('GAR').data);
  assert.deepEqual([eff.price, eff.promoPrice, eff.variants.map((v) => v.price)], [229.9, null, [229.9, 238.75]]);
  assert.deepEqual(eff.pricing, { origin: 259.9, final: 229.9, strategy: 'minimo' });

  // Manual abaixo do piso avisa.
  r = await call('POST', '/api/pricing/manual', { sku: 'GAR', price: 150 });
  assert.equal(r.status, 200);
  assert.match(r.body.warnings[0], /abaixo do piso de R\$ 181,93/);
  assert.equal((await call('POST', '/api/pricing/manual', { sku: 'GAR', price: -1 })).status, 400);

  // Prévia mostra o preço de venda.
  const pv = (await call('POST', '/api/preview', { skus: ['TEN'], platforms: ['shopee'] })).body;
  assert.deepEqual(pv.items[0].pricing, { origin: 289.9, final: 264.9, strategy: 'minimo' });

  // Origem como preço "de": o definido vira promoção.
  await call('PUT', '/api/pricing/settings', { showOriginAsList: true });
  eff = pricing.effectiveProduct(store.getProduct('TEN').data);
  assert.deepEqual([eff.price, eff.promoPrice], [299.9, 264.9]);

  // Limpar volta à origem.
  await call('POST', '/api/pricing/clear', { skus: ['TEN'] });
  grid = (await call('GET', '/api/pricing?skus=TEN')).body;
  assert.equal(grid.items[0].price, null);
  assert.equal(grid.items[0].effective, 289.9);
});

test('mudar o preço de produto já integrado o deixa desatualizado e reenvia', async () => {
  const prod = store.getProduct('TEN');
  store.setEnabled('mercadolivre', true);
  store.selectForPlatform('mercadolivre', 'TEN');
  store.saveListing('mercadolivre', 'TEN', { status: 'synced', external_id: 'MLB1', last_hash: store.syncHashOf(prod) });
  const before = store.syncHashOf(store.getProduct('TEN'));

  let r = await call('POST', '/api/pricing/apply', { skus: ['TEN'], strategy: 'sugerido' });
  assert.equal(r.body.queued, 1);
  const after = store.syncHashOf(store.getProduct('TEN'));
  assert.notEqual(after, before);
  const row = (await call('GET', '/api/sync?platform=mercadolivre')).body.items.find((i) => i.sku === 'TEN');
  assert.equal(row.outdated, true);
  assert.equal(row.salePrice, 268.9);

  // Desligar o módulo volta ao preço da origem → novo hash e reenvio.
  store.saveListing('mercadolivre', 'TEN', { last_hash: after });
  store.clearFinishedJobs();
  r = await call('PUT', '/api/pricing/settings', { enabled: false });
  assert.equal(r.body.queued, 1);
  assert.equal(store.syncHashOf(store.getProduct('TEN')), prod.hash);
  assert.equal(pricing.effectiveProduct(store.getProduct('TEN').data).price, 299.9);
});

test('custo fica fora do hash: atualiza o dado sem reenviar', () => {
  const { normalizeProduct, productHash } = require('../src/source/normalize');
  const a = normalizeProduct({ sku: 'H1', title: 'Produto', price: 10, images: ['https://img.test/h.jpg'] });
  const b = normalizeProduct({ sku: 'H1', title: 'Produto', price: 10, custo: '6,50', images: ['https://img.test/h.jpg'] });
  assert.equal(b.cost, 6.5);
  assert.equal(productHash(a), productHash(b));
  const { cost, ...semCusto } = a;
  assert.equal(productHash(a), require('../src/lib/crypto').sha256(JSON.stringify(semCusto)), 'hash igual ao das versões anteriores');
  assert.equal(store.upsertProduct(a, productHash(a), 'teste'), true);
  assert.equal(store.upsertProduct(a, productHash(a), 'teste'), false);
  assert.equal(store.upsertProduct(b, productHash(b), 'teste'), true, 'custo novo é gravado');
  assert.equal(store.getProduct('H1').data.cost, 6.5);
  assert.equal(store.getProduct('H1').hash, productHash(a));
});

test('rotas de precificação exigem sessão', async () => {
  const saved = cookie;
  cookie = '';
  for (const [m, u] of [['GET', '/api/modules'], ['GET', '/api/pricing'], ['PUT', '/api/pricing/settings'], ['POST', '/api/pricing/apply'], ['GET', '/api/pricing/TEN']]) {
    assert.equal((await call(m, u, m === 'GET' ? undefined : {})).status, 401, `${m} ${u}`);
  }
  cookie = saved;
});
