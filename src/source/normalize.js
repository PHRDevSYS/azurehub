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
//   active: true,
//   variants: [                                       // opcional: tênis, roupas...
//     { sku, options: { Cor: 'Preto', Tamanho: '42' }, price, promoPrice, stock, gtin, images: [url] }
//   ],
//   daysToShip,                                       // prazo de postagem (pré-venda), opcional
//   sizeChart, sizeChartId,                           // tabela de medidas: URL da imagem ou id do modelo
//   tax: { ncm, cest, origin, ... }                   // dados fiscais (Shopee BR / NF-e)
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
    cost: num(pick(r, 'cost', 'custo', 'preco_custo')),
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
    sourceRef: pick(r, 'sourceRef', 'source_ref') ? String(pick(r, 'sourceRef', 'source_ref')) : null,
  };
  const days = num(pick(r, 'daysToShip', 'days_to_ship', 'prazo_envio'));
  p.daysToShip = days ? Math.trunc(days) : null;
  p.sizeChart = pick(r, 'sizeChart', 'size_chart', 'tabela_medidas') || null;
  p.sizeChartId = pick(r, 'sizeChartId', 'size_chart_id') ? String(pick(r, 'sizeChartId', 'size_chart_id')) : null;
  p.tax = taxInfo(r);

  p.variants = listOf(pick(r, 'variants', 'variacoes', 'variations')).map((v) => normalizeVariant(v, p));
  if (p.variants.length) {
    // Preço e estoque do "pai" refletem as variações.
    const prices = p.variants.map((v) => v.price).filter((x) => x !== null);
    if (p.price === null && prices.length) p.price = Math.min(...prices);
    p.stock = p.variants.reduce((n, v) => n + v.stock, 0);
  }
  // Promoção só vale se for menor que o preço cheio.
  if (p.promoPrice !== null && (p.price === null || p.promoPrice >= p.price)) p.promoPrice = null;
  return p;
}

function listOf(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; }
  }
  return [];
}

function normalizeVariant(raw, parent) {
  const r = raw || {};
  let options = { ...obj(pick(r, 'options', 'opcoes', 'attributes')) };
  // Também aceita colunas option_Cor / opcao_Tamanho (vindas do SQL).
  for (const [k, val] of Object.entries(r)) {
    const m = k.match(/^(?:option|opcao|variacao)_(.+)$/i);
    if (m && val !== null && val !== '') options[m[1]] = val;
  }
  options = Object.fromEntries(Object.entries(options).map(([k, val]) => [String(k).trim(), String(val).trim()]));
  const v = {
    sku: String(pick(r, 'sku', 'SKU') ?? '').trim(),
    options,
    price: num(pick(r, 'price', 'preco')) ?? parent.price,
    promoPrice: num(pick(r, 'promoPrice', 'promo_price', 'preco_promocional')),
    stock: Math.max(0, Math.trunc(num(pick(r, 'stock', 'estoque', 'quantity')) ?? 0)),
    gtin: pick(r, 'gtin', 'ean', 'barcode') ? String(pick(r, 'gtin', 'ean', 'barcode')) : null,
    images: [...new Set(list(pick(r, 'images', 'imagens', 'image', 'imagem')))],
    active: !['0', 'false', 'inativo', 'inactive'].includes(String(pick(r, 'active', 'ativo') ?? 'true').toLowerCase()),
  };
  // Sem promoção própria, herda a do produto se ainda for desconto real.
  if (v.promoPrice === null && parent.promoPrice !== null) v.promoPrice = parent.promoPrice;
  if (v.promoPrice !== null && (v.price === null || v.promoPrice >= v.price)) v.promoPrice = null;
  if (!v.active) v.stock = 0;
  return v;
}

const TAX_KEYS = ['ncm', 'cest', 'origin', 'csosn', 'same_state_cfop', 'diff_state_cfop', 'measure_unit',
  'pis', 'cofins', 'icms_cst', 'pis_cofins_cst', 'federal_state_taxes', 'operation_type', 'ex_tipi', 'additional_info'];

function taxInfo(r) {
  const src = { ...obj(pick(r, 'tax', 'fiscal')) };
  if (pick(r, 'ncm')) src.ncm = pick(r, 'ncm');
  if (pick(r, 'cest')) src.cest = pick(r, 'cest');
  if (pick(r, 'origem', 'origin') !== null) src.origin = pick(r, 'origem', 'origin');
  const out = {};
  for (const k of TAX_KEYS) if (src[k] !== undefined && src[k] !== null && src[k] !== '') out[k] = String(src[k]);
  return Object.keys(out).length ? out : null;
}

function validateProduct(p) {
  const errors = [];
  if (!p.sku) errors.push('sku obrigatório');
  if (!p.title) errors.push('title obrigatório');
  if (p.price === null || p.price <= 0) errors.push('price deve ser > 0');
  if (!p.images.length) errors.push('ao menos 1 imagem (URL pública)');
  const variantImages = (p.variants || []).flatMap((v) => v.images);
  for (const u of [...p.images, ...p.videos, ...variantImages, ...(p.sizeChart ? [p.sizeChart] : [])]) {
    if (!/^https?:\/\//i.test(u)) errors.push(`URL de mídia inválida: ${u}`);
  }
  if (p.variants && p.variants.length) errors.push(...validateVariants(p.variants));
  return errors;
}

function validateVariants(variants) {
  const errors = [];
  const keys = Object.keys(variants[0].options);
  const skus = new Set();
  const combos = new Set();
  if (!keys.length) errors.push('variações precisam de "options" (ex.: {"Cor":"Preto","Tamanho":"42"})');
  if (keys.length > 3) errors.push('no máximo 3 tipos de variação (ex.: Cor, Tamanho)');
  for (const v of variants) {
    if (!v.sku) errors.push('toda variação precisa de sku');
    else if (skus.has(v.sku)) errors.push(`sku de variação repetido: ${v.sku}`);
    skus.add(v.sku);
    const vk = Object.keys(v.options);
    if (vk.length !== keys.length || vk.some((k) => !keys.includes(k))) {
      errors.push(`variação ${v.sku || '?'} precisa ter exatamente as opções ${keys.join(', ')}`);
      continue;
    }
    const combo = keys.map((k) => v.options[k].toLowerCase()).join('|');
    if (combos.has(combo)) errors.push(`combinação repetida: ${keys.map((k) => v.options[k]).join(' / ')}`);
    combos.add(combo);
    if (v.price === null || v.price <= 0) errors.push(`variação ${v.sku}: price deve ser > 0`);
  }
  return errors;
}

// O custo só serve à Precificação (nunca vai aos marketplaces): fica fora do
// hash para não disparar reenvio nem mudar o hash de quem já estava integrado.
const productHash = (p) => sha256(JSON.stringify({ ...p, cost: undefined }));

// Banco do site com uma linha por variação: linhas com o mesmo parent_sku
// viram um produto com "variants". Os dados do produto (título, descrição,
// fotos...) vêm da primeira linha do grupo; cada linha traz sku, preço,
// estoque, gtin e as colunas option_<Nome> (ex.: option_Cor, option_Tamanho).
function groupVariantRows(rows) {
  const out = [];
  const groups = new Map();
  for (const row of rows) {
    const parent = row.parent_sku ?? row.sku_pai ?? null;
    if (parent === null || parent === undefined || parent === '') {
      out.push(row);
      continue;
    }
    const key = String(parent).trim();
    if (!groups.has(key)) {
      const head = { ...row, sku: key, variants: [] };
      delete head.parent_sku;
      delete head.sku_pai;
      groups.set(key, head);
      out.push(head);
    }
    groups.get(key).variants.push({
      sku: row.sku, price: row.price ?? row.preco, promo_price: row.promo_price ?? row.preco_promocional,
      stock: row.stock ?? row.estoque, gtin: row.gtin ?? row.ean, images: row.variant_images ?? row.imagens_variacao,
      active: row.active ?? row.ativo,
      ...Object.fromEntries(Object.entries(row).filter(([k]) => /^(option|opcao|variacao)_/i.test(k))),
    });
  }
  for (const head of groups.values()) {
    // Preço/estoque do pai são derivados das variações.
    delete head.price; delete head.preco; delete head.stock; delete head.estoque; delete head.gtin; delete head.ean;
    for (const k of Object.keys(head)) if (/^(option|opcao|variacao)_/i.test(k)) delete head[k];
  }
  return out;
}

module.exports = { normalizeProduct, validateProduct, productHash, num, list, groupVariantRows };
