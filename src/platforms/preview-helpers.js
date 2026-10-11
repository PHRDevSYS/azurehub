'use strict';
// Formatação comum às prévias (valores exibidos como texto na tela Prévia).
const TZ = process.env.TZ_DISPLAY || 'America/Sao_Paulo';

const money = (v) => (v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const when = (sec) => new Date(sec * 1000).toLocaleString('pt-BR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' });
const excerpt = (text, n = 280) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const optionsLabel = (options) => Object.entries(options || {}).map(([k, v]) => `${k}: ${v}`).join(' · ');
const field = (label, value, note) => ({ label, value: value === null || value === undefined || value === '' ? '—' : String(value), note: note || null });

function priceRange(p) {
  const vs = p.variants || [];
  if (!vs.length) return money(p.price);
  const prices = vs.map((v) => v.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? money(min) : `${money(min)} a ${money(max)}`;
}

const totalStock = (p) => (p.active ? p.stock : 0);

// Dígito verificador GS1 (EAN-8/UPC-12/EAN-13/GTIN-14).
function validGtin(raw) {
  const code = String(raw || '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(code.length)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

function variantRows(p, extra = () => ({})) {
  return (p.variants || []).map((v) => ({
    sku: v.sku, options: optionsLabel(v.options), price: money(v.price), promoPrice: v.promoPrice ? money(v.promoPrice) : '—',
    stock: p.active && v.active !== false ? v.stock : 0, gtin: v.gtin || '—', ...extra(v),
  }));
}

module.exports = { money, when, excerpt, optionsLabel, field, priceRange, totalStock, validGtin, variantRows };
