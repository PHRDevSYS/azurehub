'use strict';
// Conectores de origem contra APIs simuladas no formato documentado de cada
// plataforma (WooCommerce REST v3, Shopify Admin GraphQL, Nuvemshop, Bling v3).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.HUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'azurehub-src-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProduct, validateProduct } = require('../src/source/normalize');
const http = require('../src/source/http');
const woo = require('../src/source/connectors/woocommerce');
const shopify = require('../src/source/connectors/shopify');
const nuvem = require('../src/source/connectors/nuvemshop');
const bling = require('../src/source/connectors/bling');

http.timing.sleep = async () => {};
const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

function mock(handler) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = typeof init.body === 'string' ? init.body : null;
    calls.push({ url: u, method: init.method || 'GET', headers: init.headers || {}, body });
    const r = await handler(u, init, body);
    return new Response(JSON.stringify(r.body ?? r), { status: r.status || 200, headers: { 'Content-Type': 'application/json', ...(r.headers || {}) } });
  };
  return calls;
}

test('WooCommerce: paginação, produto variável, unidades, GTIN, marca e estoque sem controle', async () => {
  const page1 = [
    {
      id: 10, type: 'variable', status: 'publish', name: 'Tênis Run', sku: 'TEN', description: '<p>Leve</p>', regular_price: '', price: '299.9',
      weight: '1100', dimensions: { length: '33', width: '22', height: '12' }, brands: [{ name: 'Nike' }],
      images: [{ src: 'https://loja.test/t1.jpg' }], attributes: [{ name: 'Material', options: ['Sintético'], variation: false }, { name: 'Cor', options: ['Preto'], variation: true }],
    },
    { id: 11, type: 'grouped', status: 'publish', name: 'Kit', images: [] },
  ];
  const page2 = [{
    id: 12, type: 'simple', status: 'publish', name: 'Garrafa Térmica', sku: '', regular_price: '89.90', sale_price: '79.90',
    date_on_sale_to_gmt: '2026-12-01T00:00:00', manage_stock: false, stock_status: 'instock', global_unique_id: '7891234567895',
    weight: '600', dimensions: {}, images: [{ src: 'https://loja.test/g.jpg' }], attributes: [],
  }];
  const variations = [
    { id: 101, sku: 'TEN-P-40', regular_price: '299.9', sale_price: '249.9', manage_stock: true, stock_quantity: 5, global_unique_id: '', image: { src: 'https://loja.test/preto.jpg' }, attributes: [{ name: 'Cor', option: 'Preto' }, { name: 'Tamanho', option: '40' }] },
    { id: 102, sku: 'TEN-P-41', regular_price: '299.9', sale_price: '', manage_stock: true, stock_quantity: 0, image: null, attributes: [{ name: 'Cor', option: 'Preto' }, { name: 'Tamanho', option: '41' }] },
  ];
  const calls = mock((u) => {
    if (u.pathname.endsWith('/products/10/variations')) return { body: variations, headers: { 'x-wp-totalpages': '1' } };
    const page = u.searchParams.get('page');
    return { body: page === '1' ? page1 : page2, headers: { 'x-wp-totalpages': '2' } };
  });
  const cfg = { url: 'https://loja.test/', consumer_key: 'ck_1', consumer_secret: 'cs_2', weight_unit: 'g', dimension_unit: 'cm', unmanaged_stock: '7' };
  const rows = await woo.fetchProducts(cfg);
  assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://loja.test/wp-json/wc/v3/products');
  assert.equal(calls[0].url.searchParams.get('status'), 'publish');
  assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from('ck_1:cs_2').toString('base64')}`);
  assert.equal(rows.length, 2, 'produto agrupado é ignorado');

  const [tenis, garrafa] = rows.map(normalizeProduct);
  assert.equal(tenis.weightKg, 1.1, '1100 g → 1,1 kg');
  assert.equal(tenis.brand, 'Nike');
  assert.deepEqual(tenis.attributes, { Material: 'Sintético' });
  assert.deepEqual(tenis.variants.map((v) => [v.sku, v.options, v.price, v.promoPrice, v.stock, v.images]), [
    ['TEN-P-40', { Cor: 'Preto', Tamanho: '40' }, 299.9, 249.9, 5, ['https://loja.test/preto.jpg']],
    ['TEN-P-41', { Cor: 'Preto', Tamanho: '41' }, 299.9, null, 0, []],
  ]);
  assert.deepEqual(validateProduct(tenis), []);
  assert.equal(garrafa.sku, 'WOO-12', 'sem SKU → id estável da origem');
  assert.equal(garrafa.stock, 7, 'sem controle de estoque → quantidade padrão');
  assert.equal(garrafa.promoPrice, 79.9);
  assert.equal(garrafa.gtin, '7891234567895');
  assert.equal(garrafa.sourceRef, 'woocommerce:12');
});

test('Shopify: GraphQL 2026-10, compareAtPrice, barcodes, peso, mídia, variações paginadas e limite de custo', async () => {
  let throttled = false;
  const variant = (sku, opts, price, compare, qty, extra = {}) => ({
    sku, price, compareAtPrice: compare, inventoryQuantity: qty, selectedOptions: opts,
    barcodes: { nodes: extra.barcode ? [{ value: extra.barcode }] : [] },
    media: { nodes: extra.img ? [{ image: { url: extra.img } }] : [] },
    inventoryItem: { measurement: { weight: { unit: 'GRAMS', value: 900 } } },
  });
  const calls = mock((u, init, body) => {
    const { query, variables } = JSON.parse(body);
    if (!throttled) {
      throttled = true;
      return { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], extensions: { cost: { requestedQueryCost: 700, throttleStatus: { currentlyAvailable: 100, restoreRate: 100 } } } };
    }
    if (query.includes('query Variacoes')) {
      return { data: { product: { variants: { pageInfo: { hasNextPage: false }, nodes: [variant('CAM-G', [{ name: 'Tamanho', value: 'G' }], '59.90', null, 2)] } } } };
    }
    assert.equal(variables.query, 'status:active');
    return {
      data: {
        products: {
          pageInfo: { hasNextPage: false, endCursor: 'c1' },
          nodes: [
            {
              id: 'gid://shopify/Product/111', title: 'Garrafa', descriptionHtml: '<p>Inox</p>', vendor: 'Stanley', status: 'ACTIVE',
              media: { nodes: [{ mediaContentType: 'IMAGE', image: { url: 'https://cdn.test/g.jpg' } }, { mediaContentType: 'VIDEO', sources: [{ url: 'https://cdn.test/v.m3u8', mimeType: 'application/x-mpegURL' }, { url: 'https://cdn.test/v.mp4', mimeType: 'video/mp4' }] }] },
              variants: { pageInfo: { hasNextPage: false }, nodes: [variant('GAR-1', [{ name: 'Title', value: 'Default Title' }], '79.90', '89.90', 30, { barcode: '7891234567895' })] },
            },
            {
              id: 'gid://shopify/Product/222', title: 'Camiseta', descriptionHtml: '', vendor: 'Marca', status: 'ACTIVE',
              media: { nodes: [{ mediaContentType: 'EXTERNAL_VIDEO', originUrl: 'https://youtu.be/dQw4w9WgXcQ' }, { mediaContentType: 'IMAGE', image: { url: 'https://cdn.test/c.jpg' } }] },
              variants: { pageInfo: { hasNextPage: true, endCursor: 'v1' }, nodes: [variant('CAM-P', [{ name: 'Tamanho', value: 'P' }], '59.90', null, 4, { img: 'https://cdn.test/p.jpg' })] },
            },
          ],
        },
      },
    };
  });
  const rows = await shopify.fetchProducts({ shop: 'https://minhaloja.myshopify.com/admin', access_token: 'shpat_x' });
  assert.equal(calls[0].url.href, 'https://minhaloja.myshopify.com/admin/api/2026-10/graphql.json');
  assert.equal(calls[0].headers['X-Shopify-Access-Token'], 'shpat_x');
  assert.equal(calls.length, 3, '1 tentativa limitada + produtos + variações restantes');
  const [garrafa, camiseta] = rows.map(normalizeProduct);
  assert.deepEqual([garrafa.sku, garrafa.price, garrafa.promoPrice, garrafa.gtin, garrafa.weightKg], ['GAR-1', 89.9, 79.9, '7891234567895', 0.9]);
  assert.deepEqual(garrafa.videos, ['https://cdn.test/v.mp4'], 'prefere a fonte MP4');
  assert.equal(camiseta.sku, 'SHOPIFY-222');
  assert.deepEqual(camiseta.variants.map((v) => [v.sku, v.options.Tamanho, v.images]), [['CAM-P', 'P', ['https://cdn.test/p.jpg']], ['CAM-G', 'G', []]]);
  assert.deepEqual(camiseta.videos, ['https://youtu.be/dQw4w9WgXcQ']);
});

test('Nuvemshop: versão no caminho, Bearer, User-Agent, idioma, variações e estoque infinito', async () => {
  const product = (id, extra) => ({
    id, name: { pt: `Produto ${id}`, es: 'Producto' }, description: { pt: '<p>Desc</p>' }, published: true, brand: 'Marca',
    images: [{ id: 2, src: 'https://img.test/2.jpg', position: 2 }, { id: 1, src: 'https://img.test/1.jpg', position: 1 }],
    ...extra,
  });
  const list = [
    product(1, { attributes: [], variants: [{ id: 9, sku: 'SIMPLES', price: '50.00', promotional_price: '45.00', stock: null, weight: '0.4', width: '10', height: '5', depth: '20', barcode: '7891234567895', values: [] }] }),
    product(2, { attributes: [{ pt: 'Cor' }, { pt: 'Tamanho' }], video_url: 'https://youtu.be/dQw4w9WgXcQ', variants: [
      { id: 21, sku: 'C-AZ-P', price: '60.00', promotional_price: null, stock: 3, values: [{ pt: 'Azul' }, { pt: 'P' }], image_id: 2 },
      { id: 22, sku: 'C-AZ-M', price: '60.00', promotional_price: null, stock: 0, values: [{ pt: 'Azul' }, { pt: 'M' }], image_id: null },
    ] }),
  ];
  const calls = mock(() => list);
  const rows = await nuvem.fetchProducts({ store_id: '777', access_token: 'tok', contact_email: 'dev@loja.test', unmanaged_stock: '15' });
  assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://api.nuvemshop.com.br/2025-03/777/products');
  assert.equal(calls[0].url.searchParams.get('per_page'), '200');
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].headers['User-Agent'], 'AzureHub (dev@loja.test)');
  assert.equal(calls.length, 1, 'menos de 200 itens = última página');
  const [simples, camiseta] = rows.map(normalizeProduct);
  assert.deepEqual([simples.sku, simples.title, simples.price, simples.promoPrice, simples.stock, simples.gtin], ['SIMPLES', 'Produto 1', 50, 45, 15, '7891234567895']);
  assert.deepEqual(simples.images, ['https://img.test/1.jpg', 'https://img.test/2.jpg'], 'ordenadas por posição');
  assert.deepEqual([simples.lengthCm, simples.widthCm, simples.heightCm, simples.weightKg], [20, 10, 5, 0.4]);
  assert.equal(camiseta.sku, 'NUVEM-2');
  assert.deepEqual(camiseta.variants.map((v) => [v.sku, v.options, v.images]), [
    ['C-AZ-P', { Cor: 'Azul', Tamanho: 'P' }, ['https://img.test/2.jpg']],
    ['C-AZ-M', { Cor: 'Azul', Tamanho: 'M' }, []],
  ]);
  assert.deepEqual(camiseta.videos, ['https://youtu.be/dQw4w9WgXcQ']);
});

test('Nuvemshop OAuth: troca o code com os dados no corpo e guarda o store_id', async () => {
  const calls = mock(() => ({ access_token: 'novo', token_type: 'bearer', user_id: 4242 }));
  const t = await nuvem.oauth.handleCallback({ cfg: { app_id: '55', client_secret: 's' }, query: { code: 'abc' } });
  assert.equal(calls[0].url.href, 'https://www.nuvemshop.com.br/apps/authorize/token');
  assert.deepEqual(JSON.parse(calls[0].body), { client_id: '55', client_secret: 's', grant_type: 'authorization_code', code: 'abc' });
  assert.deepEqual(t, { access_token: 'novo', store_id: '4242' });
  assert.match(nuvem.oauth.authorizeUrl({ cfg: { app_id: '55' }, state: 'S' }), /^https:\/\/www\.nuvemshop\.com\.br\/apps\/55\/authorize\?state=S$/);
});

test('Bling: OAuth com Basic, lista + detalhe, variações "Cor:Azul;Tamanho:P", mm → cm, NCM e imagens', async () => {
  const calls = mock((u) => {
    if (u.pathname.endsWith('/oauth/token')) return { access_token: 'AT', refresh_token: 'RT', expires_in: 21600 };
    if (u.pathname.endsWith('/produtos')) return { data: [{ id: 1, formato: 'V' }, { id: 2, idProdutoPai: 1 }, { id: 3, formato: 'S' }] };
    if (u.pathname.endsWith('/produtos/1')) {
      return { data: {
        id: 1, codigo: 'CAM', nome: 'Camiseta', formato: 'V', preco: 59.9, situacao: 'A', marca: 'Marca', descricaoComplementar: 'Algodão',
        pesoBruto: 0.3, dimensoes: { largura: 250, altura: 30, profundidade: 300, unidadeMedida: 2 }, tributacao: { ncm: '61091000', origem: 0 },
        midia: { video: { url: 'https://youtu.be/dQw4w9WgXcQ' }, imagens: { externas: [{ link: 'https://ext.test/1.jpg' }], internas: [{ link: 'https://bling.test/int.jpg' }] } },
        variacoes: [
          { id: 11, codigo: 'CAM-AZ-P', preco: 59.9, situacao: 'A', estoque: { saldoVirtualTotal: 4 }, gtin: '7891234567895', variacao: { nome: 'Cor:Azul;Tamanho:P' } },
          { id: 12, codigo: 'CAM-AZ-M', preco: 0, situacao: 'I', estoque: { saldoVirtualTotal: 2 }, variacao: { nome: 'Cor:Azul;Tamanho:M' } },
        ],
      } };
    }
    return { data: { id: 3, codigo: 'GAR', nome: 'Garrafa', formato: 'S', preco: 89.9, condicao: 2, estoque: { saldoVirtualTotal: 7.0 }, midia: { imagens: { externas: [{ link: 'https://ext.test/g.jpg' }] } } } };
  });
  const cfg = { client_id: 'cid', client_secret: 'sec' };
  const tokens = await bling.oauth.handleCallback({ cfg, query: { code: 'xyz' } });
  assert.equal(calls[0].url.href, 'https://api.bling.com.br/Api/v3/oauth/token');
  assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from('cid:sec').toString('base64')}`);
  assert.equal(calls[0].body, 'grant_type=authorization_code&code=xyz');
  assert.ok(tokens.expires_at > Date.now() + 21000e3);

  const rows = await bling.fetchProducts(cfg, tokens);
  const list = calls.find((c) => c.url.pathname.endsWith('/produtos'));
  assert.equal(list.url.searchParams.get('criterio'), '5', 'ativos e inativos: o inativo pausa o anúncio');
  assert.equal(list.headers.Authorization, 'Bearer AT');
  assert.ok(!calls.some((c) => c.url.pathname.endsWith('/produtos/2')), 'variação listada solta não é buscada de novo');
  const [cam, gar] = rows.map(normalizeProduct);
  assert.deepEqual([cam.lengthCm, cam.widthCm, cam.heightCm], [30, 25, 3], 'mm → cm');
  assert.deepEqual(cam.tax, { ncm: '61091000', origin: '0' });
  assert.deepEqual(cam.images, ['https://ext.test/1.jpg', 'https://bling.test/int.jpg']);
  assert.deepEqual(cam.variants.map((v) => [v.sku, v.options, v.stock, v.price]), [
    ['CAM-AZ-P', { Cor: 'Azul', Tamanho: 'P' }, 4, 59.9],
    ['CAM-AZ-M', { Cor: 'Azul', Tamanho: 'M' }, 0, 59.9],
  ], 'variação inativa → estoque 0; sem preço → preço do pai');
  assert.deepEqual([gar.sku, gar.stock, gar.condition], ['GAR', 7, 'used']);
  assert.match(bling.oauth.authorizeUrl({ cfg, state: 'S' }), /^https:\/\/www\.bling\.com\.br\/Api\/v3\/oauth\/authorize\?response_type=code&client_id=cid&state=S$/);
});

test('origem: campos obrigatórios respeitam showIf e senha mascarada mantém a salva', () => {
  const src = require('../src/source');
  assert.throws(() => src.cleanSource({ type: 'database', engine: 'mysql', database: 'loja', query: 'SELECT 1' }), /Host/);
  const ok = src.cleanSource({ type: 'database', engine: 'sqlite', database: '/tmp/x.db', query: 'SELECT 1' });
  assert.equal(ok.engine, 'sqlite');
  assert.throws(() => src.cleanSource({ type: 'woocommerce', url: 'https://x' }), /Chave do consumidor/);
  assert.throws(() => src.cleanSource({ type: 'inexistente' }), /Origem desconhecida/);
});
