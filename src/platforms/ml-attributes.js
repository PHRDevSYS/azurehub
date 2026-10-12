'use strict';
// Atributos do Mercado Livre por categoria (developers.mercadolivre.com.br/pt_br/atributos).
//
// O produto informa "attributes" com a chave = NOME ("Gênero", "Material
// principal") ou ID do ML ("GENDER"); aqui cada um vira o formato que o
// value_type da categoria exige:
//   list        → um dos valores da lista (value_id + value_name)
//   boolean     → o value_id de "Sim"/"Não" (a doc exige o id)
//   number_unit → "número unidade", com unidade de allowed_units ("10cm" → "10 cm")
//   number      → só número
//   string      → texto livre (value_id quando bate com um valor conhecido),
//                 até value_max_length
// Obrigatórios = tag "required" (e "new_required" para produto novo); os
// "conditional_required" são conferidos à parte, em /attributes/conditional.
// As dimensões do pacote vão também como SELLER_PACKAGE_* (inteiros em cm e g),
// exigidas para vendedores ME2 mesmo sem a tag "required".

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const hasTag = (def, tag) => !!(def && def.tags && (def.tags[tag] === true || (Array.isArray(def.tags) && def.tags.includes(tag))));
const YES = ['sim', 's', 'yes', 'y', 'true', '1', 'verdadeiro'];
const NO = ['nao', 'n', 'no', 'false', '0', 'falso'];
// Tratados por quem chama (SKU e GTIN por produto/variação).
const HANDLED = new Set(['SELLER_SKU', 'GTIN', 'EMPTY_GTIN_REASON']);
const PACKAGE = ['SELLER_PACKAGE_HEIGHT', 'SELLER_PACKAGE_WIDTH', 'SELLER_PACKAGE_LENGTH', 'SELLER_PACKAGE_WEIGHT'];

function findDef(attrs, key) {
  const k = String(key).trim();
  return attrs.find((a) => a.id === k.toUpperCase()) || attrs.find((a) => norm(a.name) === norm(k)) || null;
}

const options = (def, n = 8) => (def.values || []).slice(0, n).map((v) => v.name).join(' / ') + ((def.values || []).length > n ? '…' : '');

function numberOf(raw) {
  const s = String(raw).trim().replace(/\s+/g, '');
  if (!/^-?\d+([.,]\d+)?$/.test(s)) return null;
  return Number(s.replace(',', '.'));
}

// Valor do produto → { value_id?, value_name } ou { error }.
function valueFor(def, raw) {
  const label = `"${def.name}" (${def.id})`;
  const text = Array.isArray(raw) ? raw.map(String).join(',') : String(raw).trim();
  if (!text) return { error: `${label} sem valor` };
  const known = (name) => (def.values || []).find((v) => String(v.id) === name || norm(v.name) === norm(name));
  switch (def.value_type) {
    case 'boolean': {
      const wanted = YES.includes(norm(text)) ? YES : NO.includes(norm(text)) ? NO : null;
      const hit = wanted && (def.values || []).find((v) => wanted.includes(norm(v.name)));
      return hit ? { value_id: String(hit.id), value_name: hit.name } : { error: `${label} aceita só Sim ou Não (recebido "${text}")` };
    }
    case 'list': {
      const parts = hasTag(def, 'multivalued') ? text.split(',').map((x) => x.trim()).filter(Boolean) : [text];
      const hits = parts.map(known);
      if (hits.some((h) => !h)) return { error: `valor "${text}" inválido para ${label}. Opções: ${options(def)}` };
      return hits.length === 1 ? { value_id: String(hits[0].id), value_name: hits[0].name } : { value_name: hits.map((h) => h.name).join(',') };
    }
    case 'number_unit': {
      const m = text.replace(',', '.').match(/^(-?\d+(?:\.\d+)?)\s*(.*)$/);
      if (!m) return { error: `${label} precisa ser número com unidade (ex.: 10 ${def.default_unit || 'cm'}); recebido "${text}"` };
      const units = def.allowed_units || [];
      const given = m[2].trim();
      const unit = given ? units.find((u) => norm(u.id) === norm(given) || norm(u.name) === norm(given)) : units.find((u) => u.id === def.default_unit);
      if (!unit) {
        return { error: `${label}: unidade "${given || '(nenhuma)'}" não aceita. Use ${units.map((u) => u.id).join(', ') || def.default_unit}` };
      }
      return { value_name: `${m[1]} ${unit.id}` };
    }
    case 'number': {
      const n = numberOf(text);
      return n === null ? { error: `${label} precisa ser um número (recebido "${text}")` } : { value_name: String(n) };
    }
    default: {
      const max = def.value_max_length || 255;
      if (text.length > max) return { error: `${label} passa de ${max} caracteres` };
      const hit = !hasTag(def, 'multivalued') && known(text);
      return hit ? { value_id: String(hit.id), value_name: hit.name } : { value_name: text };
    }
  }
}

// Dimensões do pacote como atributos SELLER_PACKAGE_* (só inteiros, cm e g).
function packageAttributes(p) {
  if (!(p.lengthCm && p.widthCm && p.heightCm && p.weightKg)) return [];
  return [
    { id: 'SELLER_PACKAGE_HEIGHT', value_name: `${Math.ceil(p.heightCm)} cm` },
    { id: 'SELLER_PACKAGE_WIDTH', value_name: `${Math.ceil(p.widthCm)} cm` },
    { id: 'SELLER_PACKAGE_LENGTH', value_name: `${Math.ceil(p.lengthCm)} cm` },
    { id: 'SELLER_PACKAGE_WEIGHT', value_name: `${Math.ceil(p.weightKg * 1000)} g` },
  ];
}

// Atributos do item a partir do produto. exclude = ids que quem chama envia
// de outro jeito (eixos das variações). Devolve também os erros (valor
// inválido, obrigatório faltando) para barrar o envio antes de chamar a API.
function buildAttributes(p, attrs, { exclude = [] } = {}) {
  const skip = new Set([...exclude, ...HANDLED]);
  const errors = [];
  const warnings = [];
  const byId = new Map();
  const entries = [];
  if (p.brand) entries.push(['BRAND', p.brand]);
  if (p.model) entries.push(['MODEL', p.model]);
  entries.push(...Object.entries(p.attributes || {}));

  for (const [key, raw] of entries) {
    const def = findDef(attrs, key);
    if (!def) {
      // Id no formato do ML que a categoria não lista (ex.: atributo oculto): vai como veio.
      if (/^[A-Z0-9_]+$/.test(key)) byId.set(key, { id: key, value_name: String(raw) });
      else if (attrs.length) warnings.push(`atributo "${key}" não existe nesta categoria do ML; ignorado`);
      else byId.set(key, null); // categoria desconhecida: nada a validar
      continue;
    }
    if (skip.has(def.id)) continue;
    if (hasTag(def, 'read_only') || hasTag(def, 'fixed') || hasTag(def, 'inferred')) {
      warnings.push(`atributo "${def.name}" (${def.id}) é definido pelo ML; ignorado`);
      continue;
    }
    const r = valueFor(def, raw);
    if (r.error) errors.push(r.error);
    else byId.set(def.id, { id: def.id, ...r });
  }
  for (const a of packageAttributes(p)) if (!byId.has(a.id)) byId.set(a.id, a);

  const missing = attrs.filter((a) => (hasTag(a, 'required') || (p.condition !== 'used' && hasTag(a, 'new_required')))
    && !byId.has(a.id) && !skip.has(a.id) && !hasTag(a, 'read_only') && !hasTag(a, 'fixed') && !hasTag(a, 'inferred'));
  if (missing.length) {
    errors.push(`a categoria exige ${missing.map((a) => `"${a.name}" (${a.id}${(a.values || []).length ? `: ${options(a, 5)}` : ''})`).join('; ')} — envie em "attributes" do produto (chave = nome ou id)`);
  }
  return { attributes: [...byId.values()].filter(Boolean), errors, warnings, sent: new Set(byId.keys()) };
}

// Atributos condicionais (GTIN à parte, que o hub sempre resolve).
const needsConditional = (attrs, sent) => attrs.some((a) => hasTag(a, 'conditional_required') && !HANDLED.has(a.id) && !sent.has(a.id));

module.exports = { buildAttributes, valueFor, packageAttributes, findDef, needsConditional, PACKAGE, HANDLED };
