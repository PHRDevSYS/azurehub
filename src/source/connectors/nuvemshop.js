'use strict';
// Nuvemshop / Tiendanube API (tiendanube.github.io/api-documentation).
// Base BR: https://api.nuvemshop.com.br/{versão}/{store_id}; token em
// "Authorization: Bearer"; User-Agent com nome do app e contato é obrigatório
// (sem ele, 400). Limite: balde de 40 requisições, 2/s. per_page até 200.
// Token por OAuth (não expira) ou informado manualmente.
const { requestJson, PlatformError } = require('../../lib/media');
const { throttled, fetchWithHeaders, toKg, toCm } = require('../http');

const request = throttled(550);

function auth(cfg, tokens) {
  const token = (tokens && tokens.access_token) || cfg.access_token;
  const storeId = (tokens && tokens.store_id) || cfg.store_id;
  if (!token || !storeId) throw new PlatformError('Nuvemshop: conecte a loja (OAuth) ou informe store_id e access token');
  return { token, storeId };
}

function base(cfg, storeId) {
  return `https://api.nuvemshop.com.br/${cfg.api_version || '2025-03'}/${storeId}`;
}

function headers(cfg, token) {
  return { Authorization: `Bearer ${token}`, 'User-Agent': `AzureHub (${cfg.contact_email || 'contato@azuresystem.com.br'})` };
}

const lang = (obj, l) => (obj && typeof obj === 'object' ? obj[l] || obj.pt || Object.values(obj)[0] : obj) || '';

function mapProduct(p, cfg) {
  const l = cfg.language || 'pt';
  const images = [...(p.images || [])].sort((a, b) => (a.position || 0) - (b.position || 0));
  const imageById = new Map(images.map((i) => [i.id, i.src]));
  const attrNames = (p.attributes || []).map((a) => lang(a, l));
  const variants = p.variants || [];
  const stockOf = (v) => (v.stock === null || v.stock === undefined ? Number(cfg.unmanaged_stock || 0) : Math.max(0, Number(v.stock)));
  const promoOf = (v) => (v.promotional_price !== null && v.promotional_price !== undefined && v.promotional_price !== '' ? v.promotional_price : null);
  const first = variants[0] || {};
  const out = {
    sourceRef: `nuvemshop:${p.id}`,
    title: lang(p.name, l),
    description: lang(p.description, l),
    brand: p.brand || null,
    images: images.map((i) => i.src),
    videos: p.video_url ? [p.video_url] : [],
    weightKg: toKg(first.weight, 'kg'),
    lengthCm: toCm(first.depth, 'cm'), widthCm: toCm(first.width, 'cm'), heightCm: toCm(first.height, 'cm'),
    active: p.published !== false,
  };
  if (!attrNames.length || variants.length <= 1) {
    Object.assign(out, {
      sku: first.sku || `NUVEM-${p.id}`,
      price: first.price, promoPrice: promoOf(first), stock: stockOf(first), gtin: first.barcode || null,
    });
  } else {
    Object.assign(out, {
      sku: `NUVEM-${p.id}`,
      variants: variants.map((v) => ({
        sku: v.sku || `NUVEM-${p.id}-${v.id}`,
        options: Object.fromEntries(attrNames.map((name, i) => [name, lang((v.values || [])[i], l)])),
        price: v.price, promoPrice: promoOf(v), stock: stockOf(v), gtin: v.barcode || null,
        images: v.image_id && imageById.get(v.image_id) ? [imageById.get(v.image_id)] : [],
        active: v.visible !== false,
      })),
    });
  }
  return out;
}

module.exports = {
  id: 'nuvemshop',
  name: 'Nuvemshop',
  kind: 'Site/loja',
  description: 'Loja Nuvemshop (Tiendanube), pela API oficial: conecte por OAuth ou informe o token.',
  docsUrl: 'https://tiendanube.github.io/api-documentation/intro',
  fields: [
    { key: 'app_id', label: 'App ID (para conectar por OAuth)', type: 'text', help: 'Portal de parceiros Nuvemshop › seu app. Cadastre lá a URL de redirecionamento mostrada abaixo.' },
    { key: 'client_secret', label: 'Client secret', type: 'password' },
    { key: 'store_id', label: 'Store ID (se já tiver o token)', type: 'text' },
    { key: 'access_token', label: 'Access token (se já tiver)', type: 'password' },
    { key: 'contact_email', label: 'E-mail de contato (User-Agent)', type: 'text', required: true, help: 'A Nuvemshop exige identificar o app e um contato em toda chamada.' },
    { key: 'api_version', label: 'Versão da API', type: 'text', default: '2025-03' },
    { key: 'language', label: 'Idioma dos textos', type: 'select', options: [['pt', 'Português'], ['es', 'Espanhol'], ['en', 'Inglês']], default: 'pt' },
    { key: 'only_published', label: 'Só produtos publicados', type: 'checkbox', default: true },
    { key: 'unmanaged_stock', label: 'Estoque para variações sem controle de estoque', type: 'text', default: '0', help: 'Na Nuvemshop, estoque vazio significa "infinito".' },
  ],

  oauth: {
    available: (cfg) => !!(cfg.app_id && cfg.client_secret),
    authorizeUrl({ cfg, state }) {
      return `https://www.nuvemshop.com.br/apps/${encodeURIComponent(cfg.app_id)}/authorize?${new URLSearchParams({ state })}`;
    },
    async handleCallback({ cfg, query }) {
      if (!query.code) throw new PlatformError('Nuvemshop: autorização sem code');
      // O code vale 5 minutos; os dados vão no corpo, não na URL.
      const res = await requestJson('https://www.nuvemshop.com.br/apps/authorize/token', {
        method: 'POST',
        body: { client_id: cfg.app_id, client_secret: cfg.client_secret, grant_type: 'authorization_code', code: query.code },
      });
      if (!res.access_token) throw new PlatformError(`Nuvemshop: ${res.error_description || res.error || 'token não recebido'}`);
      return { access_token: res.access_token, store_id: String(res.user_id || res.store_id) };
    },
  },

  async test(cfg, tokens) {
    const { token, storeId } = auth(cfg, tokens);
    const { data, headers: h } = await fetchWithHeaders(`${base(cfg, storeId)}/products?per_page=3`, { headers: headers(cfg, token) });
    return { ok: true, account: `loja ${storeId}`, count: Number(h.get('x-total-count')) || null, sample: (data || []).map((p) => mapProduct(p, cfg)) };
  },

  async fetchProducts(cfg, tokens) {
    const { token, storeId } = auth(cfg, tokens);
    const out = [];
    const params = { per_page: '200' };
    if (cfg.only_published !== false) params.published = 'true';
    for (let page = 1; page <= 1000; page++) {
      let list;
      try {
        list = await request(`${base(cfg, storeId)}/products?${new URLSearchParams({ ...params, page: String(page) })}`, { headers: headers(cfg, token) });
      } catch (e) {
        if (e.status === 404 && page > 1) break; // além da última página
        throw e;
      }
      out.push(...(list || []).map((p) => mapProduct(p, cfg)));
      if (!list || list.length < 200) break;
    }
    return out;
  },
};

module.exports._internal = { mapProduct };
