'use strict';
// Modelo canônico de produto do AzureHub. Tudo que entra (banco do site ou
// POST /api/v1/products) vira este formato; cada plataforma traduz a partir dele.
//
// {
//   sku, title, description, brand, model, gtin, condition: 'new'|'used',
//   price, promoPrice, promoStart, promoEnd, currency: 'BRL', stock,
//   weightKg, lengthCm, widthCm, heightCm,
//   images: [url], videos: [url],
//   categories: { mercadolivre, shopee, tiktok },   // ids de categoria por plataforma (opcional)
//   attributes: { NOME: valor },                      // atributos livres
//   active: true
// }
const { sha256 } = require('../lib/crypto');

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[R$\s]/g, '');
  // "1.234,56" → 1234.56 ; "1234.56" mantém
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function list(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.flatMap(list);
  const s = String(v).trim();
  if (s.startsWith('[')) {
    try { return list(JSON.parse(s)); } catch { /* cai no split */ }
  }
  if (typeof v === 'object') return v.url ? [String(v.url)] : v.src ? [String(v.src)] : [];
  return s.split(/[\n|,;]+/).map((x) => x.trim()).filter(Boolean);
}

function obj(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return {}; }
}

function date(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Aceita tanto camelCase (API) quanto snake_case (colunas SQL).
function pick(r, ...keys) {
  for (const k of keys) if (r[k] !== undefined && r[k] !== null && r[k] !== '') return r[k];
  return null;
}

function normalizeProduct(raw) {
  const r = raw || {};
  const sku = String(pick(r, 'sku', 'SKU', 'id') ?? '').trim();
  const p = {
    sku,
    title: String(pick(r, 'title', 'name', 'nome', 'titulo') ?? '').trim(),
    description: String(pick(r, 'description', 'descricao', 'desc') ?? '').trim(),
    brand: pick(r, 'brand', 'marca'),
    model: pick(r, 'model', 'modelo'),
    gtin: pick(r, 'gtin', 'ean', 'barcode') ? String(pick(r, 'gtin', 'ean', 'barcode')) : null,
    condition: String(pick(r, 'condition', 'condicao') || 'new').toLowerCase() === 'used' ? 'used' : 'new',
    price: num(pick(r, 'price', 'preco', 'regular_price')),
    promoPrice: num(pick(r, 'promoPrice', 'promo_price', 'sale_price', 'preco_promocional')),
    promoStart: date(pick(r, 'promoStart', 'promo_start')),
    promoEnd: date(pick(r, 'promoEnd', 'promo_end')),
    currency: String(pick(r, 'currency', 'moeda') || 'BRL').toUpperCase(),
    stock: Math.max(0, Math.trunc(num(pick(r, 'stock', 'estoque', 'quantity')) ?? 0)),
    weightKg: num(pick(r, 'weightKg', 'weight_kg', 'weight', 'peso')),
    lengthCm: num(pick(r, 'lengthCm', 'length_cm', 'length', 'comprimento')),
    widthCm: num(pick(r, 'widthCm', 'width_cm', 'width', 'largura')),
    heightCm: num(pick(r, 'heightCm', 'height_cm', 'height', 'altura')),
    images: [...new Set(list(pick(r, 'images', 'imagens', 'fotos')))],
    videos: [...new Set(list(pick(r, 'videos', 'video')))],
    categories: {
      mercadolivre: pick(r, 'category_ml', 'category_mercadolivre') ?? obj(r.categories).mercadolivre ?? null,
      shopee: pick(r, 'category_shopee') ?? obj(r.categories).shopee ?? null,
      tiktok: pick(r, 'category_tiktok') ?? obj(r.categories).tiktok ?? null,
    },
    attributes: obj(pick(r, 'attributes', 'atributos')),
    active: !['0', 'false', 'inativo', 'inactive'].includes(String(pick(r, 'active', 'ativo') ?? 'true').toLowerCase()),
  };
  // Promoção só vale se for menor que o preço cheio.
  if (p.promoPrice !== null && (p.price === null || p.promoPrice >= p.price)) p.promoPrice = null;
  return p;
}

function validateProduct(p) {
  const errors = [];
  if (!p.sku) errors.push('sku obrigatório');
  if (!p.title) errors.push('title obrigatório');
  if (p.price === null || p.price <= 0) errors.push('price deve ser > 0');
  if (!p.images.length) errors.push('ao menos 1 imagem (URL pública)');
  for (const u of [...p.images, ...p.videos]) {
    if (!/^https?:\/\//i.test(u)) errors.push(`URL de mídia inválida: ${u}`);
  }
  return errors;
}

const productHash = (p) => sha256(JSON.stringify(p));

module.exports = { normalizeProduct, validateProduct, productHash, num, list };
