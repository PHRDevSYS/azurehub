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
// Os sites simulados (*.test) "resolvem" para um IP público; os demais, pelo DNS real.
const realLookup = pzHttp.resolver.lookup;
pzHttp.resolver.lookup = async (host) => {
  if (host === 'interno.test') return [{ address: '10.1.2.3', family: 4 }];
  if (host === 'misto.test') return [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }];
  return /\.test$/.test(host) ? [{ address: '93.184.216.34', family: 4 }] : realLookup(host);
};
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
  if (u.host === 'redir.test') {
    const to = { '/interno': 'http://169.254.169.254/latest/meta-data/', '/ok': 'https://loja.test/garrafa', '/laco': '/laco' }[u.pathname];
    return Promise.resolve(new Response(null, { status: 302, headers: { location: to } }));
  }
  if (u.host === 'usd.test' && u.pathname === '/wp-json/wc/store/v1/products') {
    return Promise.resolve(json([
      { name: 'Garrafa Térmica Stanley Inox 1L', permalink: 'https://usd.test/p/1', is_in_stock: true, prices: { price: '4990', currency_code: 'USD', currency_minor_unit: 2 } },
      { name: 'Garrafa Térmica Stanley Inox 1L', permalink: 'https://usd.test/p/2', is_in_stock: true, prices: { price: '24990', currency_code: 'BRL', currency_minor_unit: 2 } },
    ]));
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

test('opção "permitir acima da origem": teto = origem + X%', () => {
  const market = { stats: { count: 4, min: 110, max: 140, median: 120, avg: 122 } };
  const off = { ...pricing.DEFAULTS, enabled: true };
  let ev = pricing.evaluate({ price: 100 }, market, null, off);
  assert.deepEqual([ev.ceiling, ev.values.minimo.price, ev.values.medio.price, ev.values.sugerido.price], [100, 100, 100, 100], 'desligada: origem é o teto');

  const on = { ...off, allowAboveOrigin: true, maxAbovePct: 20 };
  ev = pricing.evaluate({ price: 100 }, market, null, on);
  assert.equal(ev.ceiling, 120);
  assert.equal(ev.values.minimo.price, 110);
  assert.equal(ev.values.medio.price, 105, '(mínimo + origem) / 2');
  assert.equal(ev.values.sugerido.price, 115.9, 'mediana 120 − 3% = 116,40 → 115,90');
  assert.equal(ev.values.origem.price, 100);

  ev = pricing.evaluate({ price: 100 }, market, null, { ...on, maxAbovePct: 10 });
  assert.deepEqual([ev.ceiling, ev.values.minimo.price, ev.values.sugerido.price], [110, 110, 109.9], 'sugerido no teto calculado é arredondado para baixo');
  assert.match(ev.values.sugerido.note, /acima do teto de R\$ 110,00 → R\$ 109,90/);
  ev = pricing.evaluate({ price: 100 }, market, null, { ...on, maxAbovePct: 0 });
  assert.deepEqual([ev.ceiling, ev.values.sugerido.price], [100, 100], 'arredondar o teto nunca fica abaixo da origem');
  ev = pricing.evaluate({ price: 100 }, { stats: { ...market.stats, min: 150 } }, null, { ...on, maxAbovePct: 10 });
  assert.deepEqual([ev.values.minimo.price, ev.values.minimo.clamped], [110, true]);
  assert.match(ev.values.minimo.note, /teto de R\$ 110,00 \(origem \+ 10%\)/);

  // Aplicado acima da origem: vale até o teto; desligar a opção volta à origem.
  assert.equal(pricing.salePrice({ price: 100 }, { price: 118, strategy: 'sugerido' }, on), 118);
  assert.equal(pricing.salePrice({ price: 100 }, { price: 130, strategy: 'minimo' }, on), 120);
  assert.equal(pricing.salePrice({ price: 100 }, { price: 118, strategy: 'sugerido' }, off), 100);
  assert.equal(pricing.salePrice({ price: 100 }, { price: 150, strategy: 'manual' }, off), 150, 'manual não é limitado');

  // Custo alto: piso acima do teto → fica o teto (nunca acima dele).
  ev = pricing.evaluate({ price: 100, cost: 200 }, market, null, on);
  assert.deepEqual([ev.floor, ev.ceiling, ev.values.minimo.price, ev.values.sugerido.price], [220, 120, 120, 120]);
  assert.equal(pricing.salePrice({ price: 100, cost: 200 }, { price: 90, strategy: 'minimo' }, on), 120);
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

// ============================================ proteção de rede e limites
test('bloqueia endereços internos, esquemas e credenciais na URL', async () => {
  const P = (ip) => pzHttp.isPrivateAddress(ip);
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.1.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', '::7f00:1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe']) assert.equal(P(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '93.184.216.34', '2001:4860:4860::8888', '::ffff:808:808']) assert.equal(P(ip), false, ip);

  for (const url of ['http://127.0.0.1/x', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]:3900/', 'http://[::ffff:127.0.0.1]/',
    'http://[::127.0.0.1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://localhost.:3900/',
    'http://localhost:3900/api', 'http://painel.local/', 'http://interno.test/', 'http://misto.test/']) {
    await assert.rejects(pzHttp.assertPublicUrl(url), /interno/, url);
  }
  await assert.rejects(pzHttp.assertPublicUrl('file:///etc/passwd'), /http\(s\)/);
  await assert.rejects(pzHttp.assertPublicUrl('ftp://loja.test/'), /http\(s\)/);
  await assert.rejects(pzHttp.assertPublicUrl('https://user:senha@loja.test/'), /usuário/);
  assert.equal((await pzHttp.assertPublicUrl('https://loja.test/x')).host, 'loja.test');

  process.env.PRICE_ALLOW_PRIVATE = '1';
  try { assert.equal((await pzHttp.assertPublicUrl('http://127.0.0.1:8801/')).port, '8801'); } finally { delete process.env.PRICE_ALLOW_PRIVATE; }

  // Fontes não chegam a fazer a requisição.
  resetHttp();
  await assert.rejects(storefronts.woocommerce.search({ base_url: 'http://169.254.169.254' }, q('x')), /interno/);
  await assert.rejects(html.fetchPage('http://interno.test/p', {}), /interno/);
  await assert.rejects(scrapling.search({ search_url: 'http://127.0.0.1/busca?q={query}', item: 'a', title: 'a', price: 'a' }, q('x')), /interno/);
  assert.equal(hits.length, 0);
});

test('redirecionamento para rede interna é barrado; para site público é seguido', async () => {
  resetHttp();
  await assert.rejects(pzHttp.rawGet('https://redir.test/interno'), /interno/);
  assert.ok(!hits.some((h) => h.url.includes('169.254')), 'não toca o endereço de metadados');
  const ok = await pzHttp.rawGet('https://redir.test/ok');
  assert.equal(ok.url, 'https://loja.test/garrafa');
  assert.match(ok.text, /229\.90/);
  await assert.rejects(pzHttp.rawGet('https://redir.test/laco'), /redirecionamentos demais/);
});

test('corpo da resposta limitado (declarado e real)', async () => {
  await assert.rejects(pzHttp.readCapped(new Response('abcdef'), 3), /maior que/);
  await assert.rejects(pzHttp.readCapped(new Response('ab', { headers: { 'content-length': String(50 * 1024 * 1024) } })), /grande demais/);
  assert.equal(await pzHttp.readCapped(new Response('ábc')), 'ábc');
});

test('robots.txt sem RegExp: curingas, âncora e padrão hostil rápido', () => {
  const m = pzHttp.ruleMatches;
  assert.equal(m('/busca', '/busca?q=1'), true);
  assert.equal(m('/*.pdf$', '/a/b.pdf'), true);
  assert.equal(m('/*.pdf$', '/a/b.pdf?x'), false);
  assert.equal(m('/a*b*c', '/a-x-b-y-c-z'), true);
  assert.equal(m('/a*b*c', '/a-x-c-y-b'), false);
  assert.equal(m('/a*c$', '/abcbc'), true);
  assert.equal(m('/x$', '/x'), true);
  assert.equal(m('/x$', '/xy'), false);
  assert.equal(m('*', '/qualquer'), true);
  const hostile = `/${'*a'.repeat(40)}$`;
  const t0 = process.hrtime.bigint();
  assert.equal(m(hostile, `/${'a'.repeat(20000)}b`), false);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 200, 'padrão hostil não trava');
});

test('cache em memória tem teto', async () => {
  resetHttp();
  for (let i = 0; i < 1010; i++) await pzHttp.politeGet(`https://loja.test/garrafa?i=${i}`, { as: 'text', minIntervalMs: 0 });
  assert.ok(pzHttp.cache.size <= 1000, String(pzHttp.cache.size));
  assert.ok(!pzHttp.cache.has('https://loja.test/garrafa?i=0') && pzHttp.cache.has('https://loja.test/garrafa?i=1009'), 'descarta os mais antigos');
});

test('ofertas: outra moeda é ignorada, JSON-LD variado, sem contar o mesmo anúncio duas vezes', async () => {
  resetHttp();
  const usd = await storefronts.woocommerce.search({ base_url: 'https://usd.test' }, q('Garrafa'));
  assert.deepEqual(usd.map((o) => o.price), [249.9]);

  const page = (...nodes) => nodes.map((n) => `<script type="application/ld+json">${JSON.stringify(n)}</script>`).join('');
  const offers = html.extract(page(
    { '@type': 'Product', name: 'A', offers: { '@type': 'AggregateOffer', offers: [{ price: '99.90', priceCurrency: 'BRL' }, { price: '79,90', availability: 'https://schema.org/OutOfStock' }] } },
    { '@type': 'Product', name: 'B', offers: { price: '50', priceCurrency: 'USD' } },
    { '@type': 'Product', name: 'C', url: 'http://[quebrada', offers: { priceSpecification: [{ priceType: 'https://schema.org/ListPrice', price: 200 }, { price: 150 }] } },
    { '@type': 'Product', name: 'D', url: 'javascript:alert(1)', offers: { price: 10 } },
  ), 'https://busca.test/?q=x');
  assert.deepEqual(offers.map((o) => [o.title, o.price, o.url, o.pageUrlOnly]), [
    ['A', 99.9, 'https://busca.test/?q=x', true], ['C', 150, 'https://busca.test/?q=x', true], ['D', 10, 'https://busca.test/?q=x', true]]);

  const { dedupe } = research;
  const list = [
    { source: 'Woo', url: 'https://loja.test/garrafa/?_pos=1&utm_source=x', price: 229.9, score: 0.9 },
    { source: 'URL monitorada', url: 'https://loja.test/garrafa', price: 229.9, score: 1 },
    { source: 'Busca', url: 'https://busca.test/?q=x', pageUrlOnly: true, title: 'A', price: 99.9, score: 0.8 },
    { source: 'Busca', url: 'https://busca.test/?q=x', pageUrlOnly: true, title: 'C', price: 150, score: 0.8 },
  ];
  assert.deepEqual(dedupe(list).map((o) => o.source + ':' + (o.title || o.price)), ['URL monitorada:229.9', 'Busca:A', 'Busca:C']);
});

// ============================================ preço efetivo × origem/custo
test('preço aplicado acompanha origem e custo atuais (teto e piso no envio)', async () => {
  const push = (p) => realFetch(`${base}/api/v1/products`, { method: 'POST', headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(p) })
    .then((r) => r.json());
  await call('PUT', '/api/pricing/settings', { enabled: true, showOriginAsList: false, maxDiscountPct: 30, minMarginPct: 10 });
  const base0 = { sku: 'PAN', title: 'Panela', price: 120, promoPrice: 100, promoStart: '2026-10-01T00:00:00Z', promoEnd: '2026-10-31T00:00:00Z', stock: 2, images: ['https://img.test/p.jpg'] };
  await push(base0);
  store.saveResearch('PAN', { query: { text: 'Panela' }, offers: [], sources: [], stats: { count: 3, min: 80, max: 110, median: 95, avg: 95 } });
  store.selectForPlatform('mercadolivre', 'PAN');

  let r = await call('POST', '/api/pricing/apply', { skus: ['PAN'], strategy: 'minimo' });
  assert.equal(r.body.applied, 1);
  let row = (await call('GET', '/api/pricing/PAN')).body;
  assert.deepEqual([row.price, row.effective, row.adjusted], [80, 80, false]);
  let eff = pricing.effectiveProduct(store.getProduct('PAN').data);
  assert.deepEqual([eff.price, eff.promoPrice, eff.promoStart, eff.promoEnd], [80, null, null, null], 'janela da origem não vaza');
  store.saveListing('mercadolivre', 'PAN', { status: 'synced', external_id: 'MLB2', last_hash: store.syncHashOf(store.getProduct('PAN')) });
  store.clearFinishedJobs();

  // A origem caiu para 75: o envio não passa do teto.
  await push({ ...base0, promoPrice: 75 });
  row = (await call('GET', '/api/pricing/PAN')).body;
  assert.deepEqual([row.price, row.effective, row.adjusted], [80, 75, true]);
  assert.equal(pricing.effectiveProduct(store.getProduct('PAN').data).price, 75);
  const sync = (await call('GET', '/api/sync?platform=mercadolivre')).body.items.find((i) => i.sku === 'PAN');
  assert.deepEqual([sync.outdated, sync.salePrice], [true, 75]);
  assert.ok(store.listJobs().some((j) => j.sku === 'PAN' && j.status === 'queued'), 'reenvio na fila');

  // Volta a origem; o custo sobe (fora do hash do produto): o piso sobe e o envio acompanha.
  await push(base0);
  store.saveListing('mercadolivre', 'PAN', { last_hash: store.syncHashOf(store.getProduct('PAN')) });
  const before = store.syncHashOf(store.getProduct('PAN'));
  await push({ ...base0, cost: 80 });
  row = (await call('GET', '/api/pricing/PAN')).body;
  assert.deepEqual([row.floor, row.effective, row.adjusted], [88, 88, true]);
  assert.notEqual(store.syncHashOf(store.getProduct('PAN')), before, 'preço efetivo novo → hash novo');

  // Margem mínima menor nas regras: o piso volta a 70 e o reenvio entra na fila.
  store.saveListing('mercadolivre', 'PAN', { last_hash: store.syncHashOf(store.getProduct('PAN')) });
  store.clearFinishedJobs();
  r = await call('PUT', '/api/pricing/settings', { minMarginPct: 0 });
  assert.ok(r.body.queued >= 1);
  assert.equal((await call('GET', '/api/pricing/PAN')).body.effective, 80);

  // Manual é respeitado como digitado, mesmo acima da origem.
  await call('POST', '/api/pricing/manual', { sku: 'PAN', price: 130 });
  assert.equal(pricing.effectiveProduct(store.getProduct('PAN').data).price, 130);

  // "Origem" não grava número: acompanha a origem quando ela muda.
  r = await call('POST', '/api/pricing/apply', { skus: ['PAN'], strategy: 'origem' });
  assert.deepEqual([store.getPricing('PAN').price, store.getPricing('PAN').strategy], [null, 'origem']);
  await push({ ...base0, promoPrice: 90 });
  row = (await call('GET', '/api/pricing/PAN')).body;
  assert.deepEqual([row.strategy, row.effective, row.adjusted], ['origem', 90, false]);
  assert.equal(pricing.effectiveProduct(store.getProduct('PAN').data).promoPrice, 90, 'envia a origem como ela é');
  assert.equal((await call('GET', '/api/products?limit=50')).body.items.find((i) => i.sku === 'PAN').salePrice, null);
});

test('acima da origem no envio: preço cheio, de/por e reenvio ao mudar a opção', async () => {
  const push = (p) => realFetch(`${base}/api/v1/products`, { method: 'POST', headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(p) })
    .then((r) => r.json());
  await call('PUT', '/api/pricing/settings', { enabled: true, showOriginAsList: false, maxDiscountPct: 30, minMarginPct: 10, allowAboveOrigin: true, maxAbovePct: 20 });
  await push({ sku: 'CAN', title: 'Caneca', price: 50, stock: 3, images: ['https://img.test/c.jpg'],
    variants: [{ sku: 'CAN-A', options: { Cor: 'Azul' }, price: 50, promoPrice: 40, stock: 1 }, { sku: 'CAN-B', options: { Cor: 'Rosa' }, price: 60, stock: 2 }] });
  store.saveResearch('CAN', { query: { text: 'Caneca' }, offers: [], sources: [], stats: { count: 3, min: 44, max: 60, median: 50, avg: 51 } });
  store.selectForPlatform('mercadolivre', 'CAN');

  let r = await call('POST', '/api/pricing/apply', { skus: ['CAN'], strategy: 'minimo' });
  assert.equal(r.body.applied, 1);
  let row = (await call('GET', '/api/pricing/CAN')).body;
  assert.deepEqual([row.origin, row.ceiling, row.price, row.effective, row.diffPct], [40, 48, 44, 44, 10]);
  assert.match((await call('GET', '/api/pricing?skus=CAN')).body.settings.maxAbovePct + '', /20/);
  let eff = pricing.effectiveProduct(store.getProduct('CAN').data);
  assert.deepEqual(eff.variants.map((v) => [v.price, v.promoPrice]), [[44, null], [66, null]], 'variações sobem na mesma proporção');

  // Origem como "de": acima do preço promocional mas abaixo do cheio → de/por; acima do cheio → preço cheio.
  await call('PUT', '/api/pricing/settings', { showOriginAsList: true });
  eff = pricing.effectiveProduct(store.getProduct('CAN').data);
  assert.deepEqual([eff.price, eff.promoPrice], [50, 44]);
  assert.deepEqual(eff.variants.map((v) => [v.price, v.promoPrice]), [[50, 44], [66, null]]);
  await call('POST', '/api/pricing/manual', { sku: 'CAN', price: 55 });
  eff = pricing.effectiveProduct(store.getProduct('CAN').data);
  assert.deepEqual([eff.pricing.final, eff.promoPrice], [55, null]);
  assert.deepEqual(eff.variants.map((v) => [v.price, v.promoPrice]), [[55, null], [82.5, null]], 'manual acima do preço cheio não volta à origem');
  r = await call('POST', '/api/pricing/manual', { sku: 'CAN', price: 60 });
  assert.match(r.body.warnings[0], /acima do teto de R\$ 48,00/);

  // Desligar a opção: o mínimo aplicado volta ao teto = origem, com reenvio.
  await call('PUT', '/api/pricing/settings', { showOriginAsList: false });
  await call('POST', '/api/pricing/apply', { skus: ['CAN'], strategy: 'minimo' });
  store.saveListing('mercadolivre', 'CAN', { status: 'synced', external_id: 'MLB3', last_hash: store.syncHashOf(store.getProduct('CAN')) });
  store.clearFinishedJobs();
  r = await call('PUT', '/api/pricing/settings', { allowAboveOrigin: false });
  assert.ok(r.body.queued >= 1);
  row = (await call('GET', '/api/pricing/CAN')).body;
  assert.deepEqual([row.ceiling, row.price, row.effective, row.adjusted], [40, 44, 40, true]);
});

test('pesquisa já em andamento não inicia outra', async () => {
  resetHttp();
  global.fetch = (u, o) => new Promise((ok) => setTimeout(ok, 40)).then(() => fakeFetch(u, o)); // pesquisa "lenta"
  try {
    const first = (await call('POST', '/api/pricing/research', { skus: ['TEN', 'GAR'] })).body;
    const second = (await call('POST', '/api/pricing/research', { skus: ['TEN'] })).body;
    assert.equal(first.started, true);
    assert.equal(second.started, false);
    assert.equal(second.total, 2, 'devolve o andamento da que já roda');
    await waitResearch();
  } finally {
    global.fetch = fakeFetch;
  }
});

test('rotas de precificação exigem sessão', async () => {
  const saved = cookie;
  cookie = '';
  for (const [m, u] of [['GET', '/api/modules'], ['GET', '/api/pricing'], ['PUT', '/api/pricing/settings'], ['POST', '/api/pricing/apply'], ['GET', '/api/pricing/TEN']]) {
    assert.equal((await call(m, u, m === 'GET' ? undefined : {})).status, 401, `${m} ${u}`);
  }
  cookie = saved;
});
