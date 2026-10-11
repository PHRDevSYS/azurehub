'use strict';
// Bling ERP — API v3 (developer.bling.com.br; OpenAPI oficial).
// OAuth2: authorize em bling.com.br/Api/v3/oauth/authorize (code vale 1 min);
// token em api.bling.com.br/Api/v3/oauth/token com Basic base64(client_id:secret);
// access token 6 h, refresh token 30 dias. Limite: 3 req/s e 120 mil/dia (429).
// Lista: GET /produtos?pagina&limite&criterio=2 (ativos); detalhe completo
// (mídia, variações, tributação, dimensões, estoque) em GET /produtos/{id}.
// Variação: variacao.nome no formato "Tamanho:G;Cor:Verde".
const { requestJson, PlatformError } = require('../../lib/media');
const { throttled, toKg, toCm } = require('../http');

const API = 'https://api.bling.com.br/Api/v3';
const request = throttled(360);

const basic = (cfg) => `Basic ${Buffer.from(`${cfg.client_id}:${cfg.client_secret}`).toString('base64')}`;

async function token(cfg, params) {
  const res = await requestJson(`${API}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: basic(cfg), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.access_token) throw new PlatformError('Bling: token não recebido');
  return { access_token: res.access_token, refresh_token: res.refresh_token, expires_at: Date.now() + (res.expires_in || 21600) * 1000 };
}

const get = (tokens, path) => request(`${API}${path}`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });

// "Tamanho:G;Cor:Verde" → { Tamanho: 'G', Cor: 'Verde' }
function parseVariation(nome) {
  const out = {};
  for (const part of String(nome || '').split(';')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const DIM_UNIT = { 0: 'm', 1: 'cm', 2: 'mm' };

function imagesOf(item) {
  const im = (item.midia && item.midia.imagens) || {};
  // Internas são hospedadas no Bling e têm validade; externas são do vendedor.
  return [...(im.externas || []), ...(im.internas || [])].map((i) => i.link).filter(Boolean);
}

function mapProduct(d) {
  const dim = d.dimensoes || {};
  const unit = DIM_UNIT[dim.unidadeMedida] || 'cm';
  const trib = d.tributacao || {};
  const out = {
    sourceRef: `bling:${d.id}`,
    sku: d.codigo || `BLING-${d.id}`,
    title: d.nome,
    description: d.descricaoComplementar || d.descricaoCurta || '',
    brand: d.marca || null,
    gtin: d.gtin || null,
    condition: d.condicao === 2 ? 'used' : 'new',
    price: d.preco,
    cost: (d.fornecedor && (d.fornecedor.precoCusto || d.fornecedor.precoCompra)) || null,
    stock: Math.max(0, Math.trunc(Number((d.estoque || {}).saldoVirtualTotal) || 0)),
    weightKg: toKg(d.pesoBruto || d.pesoLiquido, 'kg'),
    lengthCm: toCm(dim.profundidade, unit), widthCm: toCm(dim.largura, unit), heightCm: toCm(dim.altura, unit),
    images: imagesOf(d),
    videos: d.midia && d.midia.video && d.midia.video.url ? [d.midia.video.url] : [],
    tax: { ncm: trib.ncm || undefined, cest: trib.cest || undefined, origin: trib.origem !== undefined && trib.origem !== null ? String(trib.origem) : undefined },
    active: d.situacao !== 'I',
  };
  if (d.formato === 'V' && (d.variacoes || []).length) {
    out.variants = d.variacoes.map((v) => ({
      sku: v.codigo || `BLING-${v.id}`,
      options: parseVariation(v.variacao && v.variacao.nome),
      price: v.preco || d.preco,
      stock: Math.max(0, Math.trunc(Number((v.estoque || {}).saldoVirtualTotal) || 0)),
      gtin: v.gtin || null,
      images: imagesOf(v).slice(0, 1),
      active: v.situacao !== 'I',
    }));
  }
  return out;
}

module.exports = {
  id: 'bling',
  name: 'Bling',
  kind: 'ERP',
  description: 'ERP Bling, pela API v3 com OAuth2 (crie um aplicativo no Bling e conecte).',
  docsUrl: 'https://developer.bling.com.br/',
  fields: [
    { key: 'client_id', label: 'Client ID', type: 'text', required: true, help: 'Bling › Central de extensões › Área do integrador › seu aplicativo (escopo de Produtos). Cadastre lá a URL de redirecionamento mostrada abaixo.' },
    { key: 'client_secret', label: 'Client secret', type: 'password', required: true },
  ],

  oauth: {
    available: (cfg) => !!(cfg.client_id && cfg.client_secret),
    authorizeUrl({ cfg, state }) {
      return `https://www.bling.com.br/Api/v3/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: cfg.client_id, state })}`;
    },
    async handleCallback({ cfg, query }) {
      if (!query.code) throw new PlatformError(`Bling: autorização negada (${query.error || 'sem code'})`);
      return token(cfg, { grant_type: 'authorization_code', code: query.code });
    },
    async refreshTokens({ cfg, tokens }) {
      return token(cfg, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    },
  },

  async test(cfg, tokens) {
    if (!tokens) throw new PlatformError('Bling: clique em "Conectar" para autorizar o acesso');
    const list = await get(tokens, '/produtos?pagina=1&limite=3&criterio=2');
    const sample = [];
    for (const item of (list.data || []).slice(0, 3)) sample.push(mapProduct((await get(tokens, `/produtos/${item.id}`)).data));
    return { ok: true, count: null, sample };
  },

  async fetchProducts(cfg, tokens) {
    if (!tokens) throw new PlatformError('Bling: clique em "Conectar" para autorizar o acesso');
    const out = [];
    for (let pagina = 1; pagina <= 2000; pagina++) {
      const list = await get(tokens, `/produtos?pagina=${pagina}&limite=100&criterio=2&tipo=P`);
      const items = list.data || [];
      for (const item of items) {
        if (item.idProdutoPai) continue; // variações vêm no detalhe do produto pai
        out.push(mapProduct((await get(tokens, `/produtos/${item.id}`)).data));
      }
      if (items.length < 100) break;
    }
    return out;
  },
};

module.exports._internal = { mapProduct, parseVariation };
