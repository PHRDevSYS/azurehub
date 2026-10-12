'use strict';
// Dados do produto em texto simples para os agentes de IA (roteiro UGC,
// precificação, auditor): só o que existe no cadastro, sem HTML.
const plain = (html) => String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

// Fatos do produto que os agentes podem usar (nada além disso).
function facts(p, { descriptionMax = 1200 } = {}) {
  const description = plain(p.description).slice(0, descriptionMax);
  const attributes = Object.entries(p.attributes || {}).filter(([k]) => !/^[A-Z0-9_]+$/.test(k) || k.length > 3)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).slice(0, 12);
  const options = {};
  for (const v of p.variants || []) for (const [k, val] of Object.entries(v.options)) (options[k] ||= new Set()).add(val);
  const variants = Object.entries(options).map(([k, set]) => `${k}: ${[...set].join(', ')}`);
  const br = (n) => String(n).replace('.', ',');
  const dims = p.lengthCm && p.widthCm && p.heightCm ? `${br(p.lengthCm)} × ${br(p.widthCm)} × ${br(p.heightCm)} cm` : null;
  return {
    title: p.title, brand: p.brand || null, model: p.model || null, description, attributes, variants,
    dimensions: dims, weight: p.weightKg ? `${br(p.weightKg)} kg` : null, onSale: !!p.promoPrice,
  };
}

module.exports = { plain, facts };
