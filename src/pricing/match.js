'use strict';
// Casamento de produtos similares e estatística de preços.
// Similaridade por palavras (coeficiente de Dice) com ajuste por marca e por
// números do título (tamanho, volume, quantidade: "1L" ≠ "500ml").

const STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'com', 'para', 'pra', 'e', 'em', 'a', 'o', 'as', 'os', 'um', 'uma',
  'por', 'sem', 'na', 'no', 'nas', 'nos', 'ao', 'the', 'and', 'with', 'for', 'novo', 'nova', 'original', 'promocao', 'oferta', 'frete', 'gratis']);

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function tokens(s) {
  return norm(s)
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/(\d)\s+(ml|l|kg|g|cm|mm|m|w|v|gb|tb|pcs|pecas|unidades|un)\b/g, '$1$2')
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t && !STOP.has(t) && (t.length > 1 || /\d/.test(t)));
}

const numbers = (toks) => toks.filter((t) => /\d/.test(t));

// 0..1 — 1 = mesmo produto.
function similarity(product, candidateTitle) {
  const a = new Set(tokens(product.title));
  const b = new Set(tokens(candidateTitle));
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  let score = (2 * inter) / (a.size + b.size);
  const brand = tokens(product.brand || '');
  if (brand.length && brand.every((t) => b.has(t))) score += 0.1;
  const nums = numbers([...a]);
  if (nums.length) {
    const missing = nums.filter((n) => !b.has(n));
    // Tamanho/volume diferente ("1l" × "500ml") pesa mais que um número solto.
    score += missing.length ? -missing.reduce((acc, n) => acc + (/[a-z]/.test(n) ? 0.35 : 0.15), 0) : 0.1;
  }
  return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}

// Texto de busca: até 8 palavras significativas do título, com a marca.
function buildQuery(product) {
  const words = String(product.title || '').split(/\s+/).filter((w) => !STOP.has(norm(w).replace(/[^a-z0-9]/g, '')) && w.length > 0);
  const out = words.slice(0, 8);
  if (product.brand && !norm(out.join(' ')).includes(norm(product.brand))) out.push(product.brand);
  const gtin = String(product.gtin || '').replace(/\D/g, '');
  return { text: out.join(' '), gtin: [8, 12, 13, 14].includes(gtin.length) ? gtin : null, brand: product.brand || null };
}

function parsePrice(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  let s = String(v).replace(/[^\d.,]/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = s.replace(',', '.');
  else if ((s.match(/\./g) || []).length > 1 || /\.\d{3}$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

const median = (xs) => {
  const s = [...xs].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Descarta ofertas fora de [40%, 250%] da mediana (acessórios, kits, erros).
function markOutliers(offers) {
  const prices = offers.map((o) => o.price);
  if (prices.length < 3) return offers.map((o) => ({ ...o, outlier: false }));
  const m = median(prices);
  return offers.map((o) => ({ ...o, outlier: o.price < m * 0.4 || o.price > m * 2.5 }));
}

function stats(prices) {
  if (!prices.length) return null;
  const s = [...prices].sort((x, y) => x - y);
  const r2 = (x) => Math.round(x * 100) / 100;
  return { count: s.length, min: s[0], max: s[s.length - 1], median: r2(median(s)), avg: r2(s.reduce((a, b) => a + b, 0) / s.length) };
}

module.exports = { tokens, similarity, buildQuery, parsePrice, markOutliers, stats, median, norm };
