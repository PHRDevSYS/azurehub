'use strict';
// Mercado Livre — https://developers.mercadolivre.com.br/pt_br/api-docs-pt-br
// OAuth 2.0 (authorization code). Access token dura 6 h; refresh token é de
// uso único (cada refresh devolve um novo — por isso sempre regravamos).
const { requestJson, PlatformError, youtubeId } = require('../lib/media');
const { sha256 } = require('../lib/crypto');
const H_ = require('./preview-helpers');
const MA = require('./ml-attributes');

const API = 'https://api.mercadolibre.com';
const AUTH_HOSTS = {
  MLB: 'https://auth.mercadolivre.com.br',
  MLA: 'https://auth.mercadolibre.com.ar',
  MLM: 'https://auth.mercadolibre.com.mx',
};

module.exports = {
  id: 'mercadolivre',
  name: 'Mercado Livre',
  color: '#FFE600',
  textColor: '#2D3277',
  docsUrl: 'https://developers.mercadolivre.com.br/pt_br/api-docs-pt-br',
  credentialFields: [
    { key: 'client_id', label: 'App ID (client_id)', type: 'text', required: true },
    { key: 'client_secret', label: 'Chave secreta (client_secret)', type: 'password', required: true },
    { key: 'site_id', label: 'Site', type: 'select', options: ['MLB', 'MLA', 'MLM'], default: 'MLB' },
    { key: 'listing_type_id', label: 'Tipo de anúncio', type: 'select', options: ['gold_special', 'gold_pro', 'free'], default: 'gold_special', help: 'gold_special = Clássico, gold_pro = Premium' },
    { key: 'default_category_id', label: 'Categoria padrão (opcional)', type: 'text', help: 'Ex.: MLB1055. Vazio = o hub prevê a categoria pelo título.' },
    { key: 'shipping_mode', label: 'Modo de envio', type: 'select', options: ['me2', 'not_specified'], default: 'me2', help: 'me2 = Mercado Envios' },
  ],

  authorizeUrl({ creds, redirectUri, state }) {
    const host = AUTH_HOSTS[creds.site_id || 'MLB'] || AUTH_HOSTS.MLB;
    const q = new URLSearchParams({ response_type: 'code', client_id: creds.client_id, redirect_uri: redirectUri, state });
    return `${host}/authorization?${q}`;
  },

  async handleCallback({ creds, query, redirectUri }) {
    if (!query.code) throw new PlatformError(`Autorização negada: ${query.error || 'sem code'}`);
    return tokenRequest({
      grant_type: 'authorization_code', client_id: creds.client_id, client_secret: creds.client_secret,
      code: query.code, redirect_uri: redirectUri,
    });
  },

  async refreshTokens({ creds, tokens }) {
    return tokenRequest({
      grant_type: 'refresh_token', client_id: creds.client_id, client_secret: creds.client_secret,
      refresh_token: tokens.refresh_token,
    });
  },

  async test(ctx) {
    const me = await api(ctx, 'GET', '/users/me');
    return { account: `${me.nickname} (id ${me.id})` };
  },

  async publish(ctx, p, listing) {
    if ((p.variants || []).length) return publishVariants(ctx, p, listing);
    if (listing && listing.external_id && listing.meta && listing.meta.model) {
      throw new PlatformError('Mercado Livre: o produto foi publicado com variações e agora chegou sem elas. Pare de sincronizar e envie de novo para criar um anúncio simples.');
    }
    const warnings = [];
    const meta = {};
    const prev = (listing && listing.meta) || {};
    const pictures = p.images.slice(0, 10).map((source) => ({ source }));
    if (p.images.length > 10) warnings.push('Mercado Livre aceita até 10 fotos; as excedentes foram ignoradas');

    // Vídeo: o anúncio aceita vídeo do YouTube (video_id). Arquivos de vídeo
    // (clips) passam por outro fluxo do ML que ainda não está no beta.
    let videoId = null;
    for (const v of p.videos) {
      videoId = youtubeId(v);
      if (videoId) break;
    }
    if (p.videos.length && !videoId) warnings.push('Mercado Livre: só vídeos do YouTube são enviados no beta (clips ficam para a próxima versão)');

    let itemId = listing && listing.external_id;
    const categoryId = prev.category_id || p.categories.mercadolivre || ctx.creds.default_category_id || (itemId ? null : await predictCategory(ctx, p.title));
    const info = categoryId ? await categoryInfo(ctx, categoryId) : { attrs: [] };
    const built = MA.buildAttributes(p, info.attrs);
    attributeIssues(built, !itemId, warnings);
    const attributes = [{ id: 'SELLER_SKU', value_name: p.sku }, ...built.attributes,
      p.gtin ? { id: 'GTIN', value_name: String(p.gtin) } : { id: 'EMPTY_GTIN_REASON', value_id: '17055160' }]; // 17055160 = "O produto não tem código cadastrado"
    const stock = p.active ? p.stock : 0;

    if (!itemId) {
      const body = {
        title: p.title.slice(0, 60),
        category_id: categoryId,
        price: p.price,
        currency_id: p.currency || 'BRL',
        available_quantity: stock,
        buying_mode: 'buy_it_now',
        condition: p.condition,
        listing_type_id: ctx.creds.listing_type_id || 'gold_special',
        pictures,
        attributes,
        shipping: shippingOf(ctx, p),
      };
      if (videoId) body.video_id = videoId;
      await checkConditional(ctx, categoryId, info, body, built.sent, warnings);
      let item;
      try {
        item = await api(ctx, 'POST', '/items', body);
      } catch (e) {
        // Categorias do modelo "User Products" exigem family_name no lugar de title.
        if (/family_name/i.test(e.message)) {
          const { title, ...rest } = body;
          item = await api(ctx, 'POST', '/items', { ...rest, family_name: title });
        } else {
          throw e;
        }
      }
      itemId = item.id;
      meta.permalink = item.permalink;
      meta.category_id = categoryId;
      if (p.description) {
        await api(ctx, 'POST', `/items/${itemId}/description`, { plain_text: plainText(p.description) });
      }
    } else {
      // Título não pode mudar depois da primeira venda — por isso não reenviamos.
      const body = { price: p.price, available_quantity: stock, pictures, attributes };
      if (videoId) body.video_id = videoId;
      await api(ctx, 'PUT', `/items/${itemId}`, body);
      if (p.description) {
        await api(ctx, 'PUT', `/items/${itemId}/description`, { plain_text: plainText(p.description) });
      }
      Object.assign(meta, await syncStatus(ctx, itemId, p.active, prev, warnings));
    }

    meta.promo = await syncDiscount(ctx, itemId, p.promoPrice, p, prev.promo, warnings);
    return { externalId: itemId, meta, warnings };
  },

  preview: (ctx, p) => preview(ctx, p),
};

// Inativo na origem → pausa; ativo de novo → reativa (o estoque sozinho não
// tira do "paused" um anúncio pausado pelo vendedor).
async function syncStatus(ctx, itemId, active, prev, warnings) {
  if (!active && !prev.paused) {
    await api(ctx, 'PUT', `/items/${itemId}`, { status: 'paused' }).catch((e) => warnings.push(`Não pausei ${itemId}: ${e.message}`));
    return { paused: true };
  }
  if (active && prev.paused) {
    await api(ctx, 'PUT', `/items/${itemId}`, { status: 'active' });
    warnings.push(`Anúncio ${itemId} reativado`);
    return { paused: false };
  }
  return {};
}

// "conditional_required": o ML diz, para este item, quais são obrigatórios
// (POST /categories/{id}/attributes/conditional, só AR/BR/MX).
async function checkConditional(ctx, categoryId, info, body, sent, warnings) {
  if (!MA.needsConditional(info.attrs, sent)) return;
  let res;
  try {
    res = await api(ctx, 'POST', `/categories/${categoryId}/attributes/conditional`, body);
  } catch (e) {
    warnings.push(`Mercado Livre: não consegui conferir os atributos condicionais (${e.message})`);
    return;
  }
  const missing = (res.required_attributes || []).filter((a) => !sent.has(a.id) && !MA.HANDLED.has(a.id));
  if (missing.length) {
    throw new PlatformError(`Mercado Livre: para este produto a categoria exige ${missing.map((a) => `"${a.name}" (${a.id})`).join(', ')} — envie em "attributes"`);
  }
}

function shippingOf(ctx, p) {
  const dims = p.lengthCm && p.widthCm && p.heightCm && p.weightKg
    ? `${Math.ceil(p.heightCm)}x${Math.ceil(p.widthCm)}x${Math.ceil(p.lengthCm)},${Math.ceil(p.weightKg * 1000)}`
    : null;
  return { mode: ctx.creds.shipping_mode || 'me2', local_pick_up: false, free_shipping: false, ...(dims ? { dimensions: dims } : {}) };
}

// Preço promocional: campanha própria do vendedor (PRICE_DISCOUNT), por item.
// A doc (pt_br/desconto-individua) limita a campanha a 14 dias: sem data de
// fim (ou fim mais longe), o hub pede 14 dias e renova quando ela termina.
const PROMO_MAX_DAYS = 14;
const round2 = (x) => Math.round(x * 100) / 100;
const mlDate = (d) => d.toISOString().replace(/\.\d+Z$/, '');

function promoWindow(p, now = Date.now()) {
  const start = p.promoStart && new Date(p.promoStart) > new Date(now) ? new Date(p.promoStart) : new Date(now + 5 * 60e3);
  const max = new Date(start.getTime() + PROMO_MAX_DAYS * 86400e3);
  const wanted = p.promoEnd ? new Date(p.promoEnd) : max;
  return { start, end: wanted > max ? max : wanted, capped: !!p.promoEnd && wanted > max };
}

async function removeDiscount(ctx, itemId, warnings) {
  await api(ctx, 'DELETE', `/seller-promotions/items/${itemId}?promotion_type=PRICE_DISCOUNT&app_version=v2`)
    .catch((e) => warnings.push(`Promoção anterior não removida (${itemId}): ${e.message}`));
}

// Deixa o desconto do item igual ao da origem. Devolve o estado para o meta
// (null = sem promoção) e só chama a API quando algo mudou ou a campanha venceu.
async function syncDiscount(ctx, itemId, dealPrice, p, prev, warnings) {
  const now = Date.now();
  const live = prev && prev.end && new Date(prev.end).getTime() > now ? prev : null;
  if (!dealPrice) {
    if (live) await removeDiscount(ctx, itemId, warnings);
    return null;
  }
  const price = round2(dealPrice);
  const requested = [p.promoStart || null, p.promoEnd || null];
  if (live && live.price === price && JSON.stringify(live.requested) === JSON.stringify(requested)) return live;
  if (live) await removeDiscount(ctx, itemId, warnings);
  const win = promoWindow(p, now);
  if (p.promoEnd && win.end <= win.start) return null; // a promoção da origem já terminou
  try {
    await api(ctx, 'POST', `/seller-promotions/items/${itemId}?app_version=v2`, {
      promotion_type: 'PRICE_DISCOUNT', deal_price: price, start_date: mlDate(win.start), finish_date: mlDate(win.end),
    });
    if (win.capped) warnings.push(`Mercado Livre: desconto limitado a ${PROMO_MAX_DAYS} dias por campanha; o hub renova quando terminar`);
    return { price, start: win.start.toISOString(), end: win.end.toISOString(), requested };
  } catch (e) {
    warnings.push(`Promoção não aplicada${itemId ? ` (${itemId})` : ''}: ${e.message}`);
    return null;
  }
}

// ============================================================== variações
// Dois modelos convivem no ML (developers.mercadolivre.com.br/pt_br/preco-variacao):
// - CLÁSSICO: um item com "variations" (attribute_combinations por variação);
//   o preço é o mesmo em todas (com preços diferentes o comprador paga o
//   maior) e, no PUT, variação omitida é APAGADA e sem id é recriada.
// - USER PRODUCTS (conta com a tag user_product_seller): "variations" e
//   "title" dão erro 400; cada variação é um item próprio com family_name, e
//   o ML agrupa pelo nome da família + atributos. Preço e estoque por item.
const SYNONYMS_ML = [
  ['COLOR', 'cor', 'cores', 'color', 'colour'], ['SIZE', 'tamanho', 'tamanhos', 'tam', 'size', 'numeracao', 'numero'],
  ['VOLTAGE', 'voltagem', 'tensao', 'voltage'], ['FLAVOR', 'sabor', 'flavor'], ['PATTERN_NAME', 'estampa', 'padrao', 'pattern'],
];
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const hasTag = (def, tag) => !!(def && def.tags && (def.tags[tag] === true || (Array.isArray(def.tags) && def.tags.includes(tag))));

const sellerTags = new Map();
async function isUpSeller(ctx) {
  const key = String(ctx.tokens.user_id || ctx.creds.client_id);
  const hit = sellerTags.get(key);
  if (hit && hit.at > Date.now() - 3600e3) return hit.up;
  const me = await api(ctx, 'GET', '/users/me');
  const up = (me.tags || []).includes('user_product_seller');
  sellerTags.set(key, { at: Date.now(), up });
  return up;
}

const categoryCache = new Map();
async function categoryInfo(ctx, categoryId) {
  const hit = categoryCache.get(categoryId);
  if (hit && hit.at > Date.now() - 6 * 3600e3) return hit.info;
  const [cat, attrs] = await Promise.all([api(ctx, 'GET', `/categories/${categoryId}`), api(ctx, 'GET', `/categories/${categoryId}/attributes`)]);
  const info = { name: cat.name, types: cat.attribute_types, settings: cat.settings || {}, attrs: Array.isArray(attrs) ? attrs : [] };
  categoryCache.set(categoryId, { at: Date.now(), info });
  return info;
}

// Opção da origem (Cor, Tamanho...) → atributo da categoria que permite variar.
function variationAxes(p, info, up) {
  const keys = Object.keys(p.variants[0].options);
  const variable = info.attrs.filter((a) => hasTag(a, 'allow_variations') || a.hierarchy === 'CHILD_PK');
  const axes = keys.map((key) => {
    const group = SYNONYMS_ML.find((g) => g.slice(1).includes(norm(key)) || g[0] === key.toUpperCase());
    const def = variable.find((a) => a.id === key.toUpperCase() || norm(a.name) === norm(key) || (group && a.id === group[0])) || null;
    return { key, def };
  });
  const custom = axes.filter((a) => !a.def);
  if (up && custom.length) {
    throw new PlatformError(`Mercado Livre (User Products): a variação "${custom.map((a) => a.key).join(', ')}" não existe na categoria. ` +
      `Use os nomes dos atributos do ML (ex.: ${variable.slice(0, 4).map((a) => a.name).join(', ') || 'Cor, Tamanho'}).`);
  }
  if (custom.length > 1) throw new PlatformError(`Mercado Livre: só uma variação personalizada é permitida por anúncio (sem atributo na categoria: ${custom.map((a) => a.key).join(', ')})`);
  return axes;
}

function axisValue(axis, value) {
  if (!axis.def) return { name: axis.key, value_name: value };
  const known = (axis.def.values || []).find((x) => norm(x.name) === norm(value));
  return known ? { id: axis.def.id, value_id: String(known.id), value_name: known.name } : { id: axis.def.id, value_name: value };
}

// SELLER_SKU e GTIN (ou o motivo de não ter) por variação.
function variationAttrs(v) {
  return [{ id: 'SELLER_SKU', value_name: v.sku }, v.gtin ? { id: 'GTIN', value_name: String(v.gtin) } : { id: 'EMPTY_GTIN_REASON', value_id: '17055160' }];
}

// Fotos por variação. Com atributo "defines_picture" (ex.: Cor), variações do
// mesmo valor dividem as fotos; sem foto própria, usa as do produto.
function variantPictures(p, axes, maxPerVar, warnings) {
  const pic = axes.find((a) => hasTag(a.def, 'defines_picture'));
  const lists = p.variants.map((v) => {
    let imgs = v.images;
    if (!imgs.length && pic) {
      const same = p.variants.find((x) => x.options[pic.key] === v.options[pic.key] && x.images.length);
      if (same) imgs = same.images;
    }
    return (imgs.length ? imgs : p.images).slice(0, maxPerVar);
  });
  if (pic) {
    const byValue = new Map();
    p.variants.forEach((v, i) => byValue.set(v.options[pic.key], lists[i].join('|')));
    if (new Set(byValue.values()).size < byValue.size) {
      warnings.push(`Mercado Livre: cada ${pic.key} precisa de fotos próprias (variações de ${pic.key} diferente com as mesmas fotos podem ser recusadas)`);
    }
  }
  return lists;
}

const variantQty = (p, v) => (p.active && v.active !== false ? Math.max(0, v.stock) : 0);

// Na criação, atributo inválido ou obrigatório faltando barra o envio (o ML
// recusaria). Num anúncio já publicado vira aviso: o PUT de atributos é
// parcial e preço/estoque não podem parar por causa de um atributo.
function attributeIssues(built, creating, warnings) {
  if (built.errors.length && creating) throw new PlatformError(`Mercado Livre: ${built.errors.join('; ')}`);
  warnings.push(...built.errors.map((e) => `Mercado Livre: atributo não atualizado — ${e}`), ...built.warnings.map((w) => `Mercado Livre: ${w}`));
}

// Atributos comuns do anúncio (os eixos da variação vão à parte).
function itemAttributes(p, axes, info, warnings, creating) {
  const built = MA.buildAttributes(p, info.attrs, { exclude: axes.filter((a) => a.def).map((a) => a.def.id) });
  attributeIssues(built, creating, warnings);
  return built;
}

async function publishVariants(ctx, p, listing) {
  const warnings = [];
  const prev = (listing && listing.meta) || {};
  const categoryId = prev.category_id || p.categories.mercadolivre || ctx.creds.default_category_id || await predictCategory(ctx, p.title);
  const info = await categoryInfo(ctx, categoryId);
  const up = prev.model ? prev.model === 'up' : await isUpSeller(ctx);
  if (!up && info.types && info.types !== 'variations') {
    throw new PlatformError(`Mercado Livre: a categoria ${info.name || categoryId} (${categoryId}) não aceita variações`);
  }
  const max = info.settings.max_variations_allowed;
  if (!up && max && p.variants.length > max) throw new PlatformError(`Mercado Livre: a categoria aceita no máximo ${max} variações (recebido: ${p.variants.length})`);
  const axes = variationAxes(p, info, up);
  const pictures = variantPictures(p, axes, info.settings.max_pictures_per_item_var || 10, warnings);
  const creating = !(listing && listing.external_id) && !Object.keys(prev.items || {}).length;
  const shared = itemAttributes(p, axes, info, warnings, creating);
  const base = { categoryId, info, axes, pictures, warnings, shared };
  try {
    return up ? await upFamily(ctx, p, listing, base) : await classicVariations(ctx, p, listing, base);
  } catch (e) {
    // Conta migrada para User Products sem a tag em cache: refaz no modelo novo.
    if (!up && !(listing && listing.external_id) && /family_name|variations is invalid|fields \[title\]|user.product/i.test(e.message)) {
      sellerTags.set(String(ctx.tokens.user_id || ctx.creds.client_id), { at: Date.now(), up: true });
      const upAxes = variationAxes(p, info, true);
      return upFamily(ctx, p, listing, { ...base, axes: upAxes, shared: itemAttributes(p, upAxes, info, [], true), warnings: [...warnings, 'A conta usa o modelo User Products do ML: cada variação vira um anúncio da mesma família'] });
    }
    throw e;
  }
}

// ---------------------------------------------------------- clássico
async function classicVariations(ctx, p, listing, { categoryId, info, axes, pictures, warnings, shared }) {
  const meta = { model: 'classic', category_id: categoryId };
  const prices = [...new Set(p.variants.map((v) => v.price))];
  const unitPrice = Math.max(...prices);
  if (prices.length > 1) {
    warnings.push(`Mercado Livre (modelo clássico): todas as variações têm o mesmo preço; enviado o maior (${unitPrice.toFixed(2)}), ` +
      'porque o ML cobra o maior preço do anúncio. Preço por variação exige o modelo User Products.');
  }
  // Fotos do item = todas as das variações (+ as do produto, até o limite).
  const limit = info.settings.max_pictures_per_item || 12;
  let perVar = pictures;
  let union = [...new Set(perVar.flat())];
  if (union.length > limit) {
    perVar = pictures.map((l) => l.slice(0, 1));
    union = [...new Set(perVar.flat())];
    warnings.push(`Mercado Livre: fotos das variações passam de ${limit}; enviada só a 1ª de cada variação`);
    if (union.length > limit) throw new PlatformError(`Mercado Livre: ${union.length} variações com fotos diferentes passam do limite de ${limit} fotos do anúncio`);
  }
  for (const u of p.images) if (union.length < limit && !union.includes(u)) union.push(u);

  const variationBody = (v, i) => ({
    attribute_combinations: axes.map((a) => axisValue(a, v.options[a.key])),
    price: unitPrice,
    available_quantity: variantQty(p, v),
    picture_ids: perVar[i],
    attributes: variationAttrs(v),
  });
  const comboKey = (combo) => combo.map((c) => `${c.id || norm(c.name)}=${norm(c.value_name)}`).join('|');
  const videoId = p.videos.map(youtubeId).find(Boolean);
  let itemId = listing && listing.external_id;

  if (!itemId) {
    const body = {
      title: p.title.slice(0, info.settings.max_title_length || 60),
      category_id: categoryId, price: unitPrice, currency_id: p.currency || 'BRL',
      available_quantity: p.variants.reduce((n, v) => n + variantQty(p, v), 0),
      buying_mode: 'buy_it_now', condition: p.condition, listing_type_id: ctx.creds.listing_type_id || 'gold_special',
      pictures: union.map((source) => ({ source })),
      attributes: shared.attributes,
      variations: p.variants.map(variationBody),
      shipping: shippingOf(ctx, p),
    };
    if (videoId) body.video_id = videoId;
    await checkConditional(ctx, categoryId, info, body, new Set([...shared.sent, ...axes.filter((a) => a.def).map((a) => a.def.id)]), warnings);
    const item = await api(ctx, 'POST', '/items', body);
    itemId = item.id;
    meta.permalink = item.permalink;
    meta.variations = mapVariations(item.variations, p, axes, comboKey);
    if (p.description) await api(ctx, 'POST', `/items/${itemId}/description`, { plain_text: plainText(p.description) });
  } else {
    // PUT com TODAS as variações que ficam (com id); as omitidas são apagadas.
    const cur = await api(ctx, 'GET', `/items/${itemId}?include_attributes=all`);
    const existing = mapVariations(cur.variations, p, axes, comboKey);
    const currentCombo = new Map((cur.variations || []).map((x) => [String(x.id), comboKey((x.attribute_combinations || []).map((c) => ({ id: c.id, name: c.name, value_name: c.value_name })))]));
    const variations = p.variants.map((v, i) => {
      const b = variationBody(v, i);
      if (!existing[v.sku]) return b;
      const { attribute_combinations: combo, ...rest } = b;
      const out = { id: Number(existing[v.sku]) || existing[v.sku], ...rest };
      // Só reenvia a combinação se ela mudou na origem (o ML recusa em variação com vendas).
      if (currentCombo.get(String(existing[v.sku])) !== comboKey(combo)) {
        out.attribute_combinations = combo;
        warnings.push(`Variação ${v.sku}: opções alteradas na origem (${Object.values(v.options).join(' / ')})`);
      }
      return out;
    });
    const removed = (cur.variations || []).filter((x) => !Object.values(existing).map(String).includes(String(x.id)));
    const body = { pictures: union.map((source) => ({ source })), attributes: shared.attributes, variations };
    if (videoId) body.video_id = videoId;
    const res = await api(ctx, 'PUT', `/items/${itemId}`, body);
    meta.variations = { ...existing, ...mapVariations(res && res.variations, p, axes, comboKey) };
    const added = p.variants.filter((v) => !existing[v.sku]);
    if (added.length) warnings.push(`Variações incluídas: ${added.map((v) => v.sku).join(', ')}`);
    if (removed.length) warnings.push(`Variações removidas do anúncio: ${removed.length}`);
    if (p.description) await api(ctx, 'PUT', `/items/${itemId}/description`, { plain_text: plainText(p.description) });
    Object.assign(meta, await syncStatus(ctx, itemId, p.active, (listing && listing.meta) || {}, warnings));
  }
  meta.category_id = categoryId;

  // Desconto é por item: vale para todas as variações (só se todas tiverem promoção).
  const promos = p.variants.map((v) => v.promoPrice);
  let deal = null;
  if (promos.every((x) => x)) {
    deal = Math.max(...promos);
    if (new Set(promos).size > 1) warnings.push(`Mercado Livre (modelo clássico): a promoção vale para o anúncio todo; usado o maior preço promocional (${deal.toFixed(2)})`);
  } else if (promos.some((x) => x)) {
    warnings.push('Mercado Livre (modelo clássico): promoção só em algumas variações não existe — o desconto é do anúncio todo; não aplicado');
  }
  meta.promo = await syncDiscount(ctx, itemId, deal, p, ((listing && listing.meta) || {}).promo, warnings);
  return { externalId: itemId, meta, warnings };
}

// Variação do ML → SKU da origem: pelo SELLER_SKU; sem ele, pela combinação.
function mapVariations(list, p, axes, comboKey) {
  const out = {};
  for (const x of list || []) {
    const skuAttr = (x.attributes || []).find((a) => a.id === 'SELLER_SKU');
    let v = skuAttr && p.variants.find((y) => y.sku === skuAttr.value_name);
    if (!v) {
      const key = comboKey((x.attribute_combinations || []).map((c) => ({ id: c.id, name: c.name, value_name: c.value_name })));
      v = p.variants.find((y) => comboKey(axes.map((a) => axisValue(a, y.options[a.key]))) === key);
    }
    if (v && x.id) out[v.sku] = x.id;
  }
  return out;
}

// ------------------------------------------------------ User Products
async function upFamily(ctx, p, listing, { categoryId, info, axes, pictures, warnings, shared: built }) {
  const prev = (listing && listing.meta) || {};
  const meta = { model: 'up', category_id: categoryId, family_name: prev.family_name || p.title.slice(0, info.settings.max_title_length || 60) };
  const items = { ...(prev.items || {}) };
  const paused = { ...(prev.paused || {}) };
  const promos = { ...(prev.promos || {}) };
  const descHash = sha256(p.description || '');
  const videoId = p.videos.map(youtubeId).find(Boolean);
  const shared = built.attributes;
  let checked = false;
  let firstId = listing && listing.external_id;
  let permalink = prev.permalink;

  for (const [i, v] of p.variants.entries()) {
    const qty = variantQty(p, v);
    let id = items[v.sku] || await findBySellerSku(ctx, v.sku);
    if (!id) {
      if (!qty) { warnings.push(`Variação ${v.sku} sem estoque: o anúncio dela será criado quando houver estoque`); continue; }
      const body = {
        family_name: meta.family_name, category_id: categoryId, price: v.price, currency_id: p.currency || 'BRL',
        available_quantity: qty, buying_mode: 'buy_it_now', condition: p.condition, listing_type_id: ctx.creds.listing_type_id || 'gold_special',
        pictures: pictures[i].map((source) => ({ source })),
        attributes: [...shared, ...axes.map((a) => axisValue(a, v.options[a.key])), ...variationAttrs(v)],
        shipping: shippingOf(ctx, p),
      };
      if (videoId) body.video_id = videoId;
      if (!checked) {
        await checkConditional(ctx, categoryId, info, body, new Set([...built.sent, ...axes.map((a) => a.def.id)]), warnings);
        checked = true;
      }
      const item = await api(ctx, 'POST', '/items', body);
      id = item.id;
      if (item.family_id) meta.family_id = item.family_id;
      permalink = permalink || item.permalink;
      if (p.description) await api(ctx, 'POST', `/items/${id}/description`, { plain_text: plainText(p.description) });
      warnings.push(`Variação ${v.sku}: anúncio ${id} criado na família "${meta.family_name}"`);
    } else {
      // Cor/tamanho de um item User Products só mudam pelo editor de família: aqui vão preço, estoque e fotos.
      const body = { price: v.price, available_quantity: qty, pictures: pictures[i].map((source) => ({ source })) };
      if (videoId) body.video_id = videoId;
      if (paused[v.sku] && p.active && qty) body.status = 'active';
      await api(ctx, 'PUT', `/items/${id}`, body);
      if (body.status) delete paused[v.sku];
      if (p.description && descHash !== prev.desc_hash) await api(ctx, 'PUT', `/items/${id}/description`, { plain_text: plainText(p.description) });
      if (!p.active && !paused[v.sku]) { await api(ctx, 'PUT', `/items/${id}`, { status: 'paused' }).catch(() => {}); paused[v.sku] = true; }
    }
    items[v.sku] = id;
    firstId = firstId || id;
    promos[v.sku] = await syncDiscount(ctx, id, v.promoPrice, p, (prev.promos || {})[v.sku], warnings);
  }
  // Variação que saiu da origem: pausa o anúncio dela (encerrar não tem volta).
  for (const sku of Object.keys(items)) {
    if (p.variants.some((v) => v.sku === sku)) continue;
    if (!paused[sku]) {
      await api(ctx, 'PUT', `/items/${items[sku]}`, { status: 'paused' }).catch((e) => warnings.push(`Não pausei ${items[sku]}: ${e.message}`));
      warnings.push(`Variação ${sku} removida na origem: anúncio ${items[sku]} pausado`);
    }
    paused[sku] = true;
  }
  if (!firstId) {
    return { externalId: null, meta: { ...meta, items, skipped: true }, warnings: [...warnings, 'Mercado Livre: nenhuma variação com estoque — anúncios criados quando houver estoque'] };
  }
  return { externalId: String(firstId), meta: { ...meta, items, paused, promos, permalink, desc_hash: descHash }, warnings };
}

async function findBySellerSku(ctx, sku) {
  const userId = ctx.tokens.user_id || (await api(ctx, 'GET', '/users/me')).id;
  const res = await api(ctx, 'GET', `/users/${userId}/items/search?seller_sku=${encodeURIComponent(sku)}`).catch(() => null);
  return res && Array.isArray(res.results) && res.results[0] ? res.results[0] : null;
}

// =============================================================== prévia
// Regras do anúncio + (conectado) categoria prevista e atributos obrigatórios
// da categoria, só com endpoints de leitura.
async function preview(ctx, p) {
  const errors = [];
  const warnings = [];
  const variants = p.variants || [];
  if (p.title.length > 60) warnings.push(`Título será cortado em 60 caracteres: "${p.title.slice(0, 60)}"`);
  if (p.images.length > 10 && !variants.length) warnings.push('Mercado Livre aceita até 10 fotos; as excedentes serão ignoradas');
  const yt = p.videos.map(youtubeId).find(Boolean);
  if (p.videos.length && !yt) warnings.push('Só vídeos do YouTube são enviados ao Mercado Livre');
  if (!variants.length && p.gtin && !H_.validGtin(p.gtin)) warnings.push(`GTIN "${p.gtin}" com dígito verificador inválido`);
  for (const v of variants) if (v.gtin && !H_.validGtin(v.gtin)) warnings.push(`GTIN "${v.gtin}" da variação ${v.sku} com dígito verificador inválido`);
  const sent = ['SELLER_SKU', p.brand ? 'BRAND' : null, p.model ? 'MODEL' : null, p.gtin || variants.length ? 'GTIN' : 'EMPTY_GTIN_REASON',
    ...Object.keys(p.attributes || {}).filter((k) => /^[A-Z0-9_]+$/.test(k))].filter(Boolean);
  let promoText = 'Sem promoção';
  const promo = variants.length ? (variants.every((v) => v.promoPrice) ? Math.max(...variants.map((v) => v.promoPrice)) : null) : p.promoPrice;
  if (promo) {
    const win = promoWindow(p);
    promoText = `${H_.money(promo)} · ${H_.when(win.start / 1000)} → ${H_.when(win.end / 1000)} (campanha do vendedor)`;
    if (win.capped || !p.promoEnd) warnings.push(`O ML limita o desconto a ${PROMO_MAX_DAYS} dias por campanha: o hub renova quando terminar`);
  }
  let category = p.categories.mercadolivre || (ctx && ctx.creds.default_category_id) || null;
  let categoryNote = null;
  let model = null;
  let axesText = null;
  let priceText = variants.length ? H_.priceRange(p) : H_.money(p.price);
  let priceNote = null;
  if (ctx) {
    try {
      if (!category) {
        category = await predictCategory(ctx, p.title);
        categoryNote = 'prevista pelo título';
      }
      const info = await categoryInfo(ctx, category);
      categoryNote = [info.name, categoryNote].filter(Boolean).join(' — ');
      if (variants.length) {
        model = (await isUpSeller(ctx)) ? 'up' : 'classic';
        if (model === 'classic' && info.types && info.types !== 'variations') errors.push(`a categoria ${info.name || category} não aceita variações`);
        const max = info.settings.max_variations_allowed;
        if (model === 'classic' && max && variants.length > max) errors.push(`a categoria aceita no máximo ${max} variações (recebido: ${variants.length})`);
        try {
          const axes = variationAxes(p, info, model === 'up');
          for (const a of axes) if (a.def) sent.push(a.def.id);
          axesText = axes.map((a) => (a.def ? `${a.key} → ${a.def.name} (${a.def.id})` : `${a.key} (personalizada)`)).join(' · ');
          variantPictures(p, axes, info.settings.max_pictures_per_item_var || 10, warnings);
        } catch (e) {
          errors.push(e.message.replace(/^Mercado Livre( \(User Products\))?:\s*/, ''));
        }
        const prices = [...new Set(variants.map((v) => v.price))];
        if (model === 'classic' && prices.length > 1) {
          priceText = H_.money(Math.max(...prices));
          priceNote = 'modelo clássico: preço único por anúncio — vai o maior; preço por variação exige User Products';
          warnings.push(`Variações com preços diferentes: no modelo clássico vai o maior (${H_.money(Math.max(...prices))}) para todas`);
        }
        if (model === 'up' && variants.some((v) => !variantQty(p, v))) warnings.push('Variações sem estoque: o anúncio delas é criado quando houver estoque');
        if (model === 'classic' && variants.some((v) => v.promoPrice) && !variants.every((v) => v.promoPrice)) {
          warnings.push('Promoção só em algumas variações não existe no modelo clássico (o desconto vale para o anúncio todo): não será aplicada');
        }
      }
      // Mesmas regras do envio: nome ou id → formato do value_type; obrigatórios.
      const axisIds = sent.filter((id) => info.attrs.some((a) => a.id === id && (MA.HANDLED.has(id) ? false : (a.tags || {}).allow_variations)));
      const built = MA.buildAttributes(p, info.attrs, { exclude: variants.length ? axisIds : [] });
      errors.push(...built.errors);
      warnings.push(...built.warnings);
      sent.splice(0, sent.length, 'SELLER_SKU', ...built.attributes.map((a) => a.id), ...axisIds, variants.length || p.gtin ? 'GTIN' : 'EMPTY_GTIN_REASON');
      if (!built.errors.length && MA.needsConditional(info.attrs, new Set(sent))) {
        try {
          const res = await api(ctx, 'POST', `/categories/${category}/attributes/conditional`, {
            title: p.title.slice(0, 60), category_id: category, price: p.price, currency_id: p.currency || 'BRL', available_quantity: Math.max(1, p.stock),
            buying_mode: 'buy_it_now', condition: p.condition, listing_type_id: ctx.creds.listing_type_id || 'gold_special',
            pictures: p.images.slice(0, 1).map((source) => ({ source })), attributes: built.attributes,
          });
          const missing = (res.required_attributes || []).filter((a) => !sent.includes(a.id) && !MA.HANDLED.has(a.id));
          if (missing.length) errors.push(`para este produto a categoria exige ${missing.map((a) => `"${a.name}" (${a.id})`).join(', ')} — envie em "attributes"`);
        } catch (e) {
          if (e instanceof PlatformError && !e.retryable) warnings.push(`atributos condicionais não conferidos (${e.message})`);
          else throw e;
        }
      }
    } catch (e) {
      if (!(e instanceof PlatformError) || e.retryable) throw e;
      errors.push(e.message);
    }
  } else {
    warnings.push('Conta Mercado Livre não conectada: categoria e atributos obrigatórios serão validados no envio');
  }
  const modelText = { up: `User Products: ${variants.length} anúncio(s), um por variação, na mesma família`, classic: `Clássico: 1 anúncio com ${variants.length} variações` }[model]
    || 'definido pela conta no envio (clássico ou User Products)';
  return {
    online: !!ctx, errors, warnings,
    fields: [
      H_.field(variants.length && model === 'up' ? 'Nome da família' : 'Título', p.title.slice(0, 60)),
      H_.field('Categoria', category || 'prevista pelo título no envio', categoryNote),
      H_.field('Tipo de anúncio', ctx ? ctx.creds.listing_type_id || 'gold_special' : 'conforme o card', 'gold_special = Clássico, gold_pro = Premium'),
      ...(variants.length ? [H_.field('Modelo de anúncio', modelText), H_.field('Variações', axesText || (ctx ? '—' : 'atributos da categoria conferidos no envio'))] : []),
      H_.field('Condição', p.condition === 'used' ? 'Usado' : 'Novo'),
      H_.field('Preço', priceText, priceNote),
      H_.field('Promoção', promoText),
      H_.field('Estoque', p.active ? p.stock : '0 — inativo: anúncio pausado'),
      H_.field('Fotos', variants.length ? 'por variação (mesma cor, mesmas fotos)' : `${Math.min(10, p.images.length)} de ${p.images.length}`, 'o Mercado Livre baixa as fotos pela URL'),
      H_.field('Vídeo', yt ? `YouTube ${yt}` : 'Sem vídeo'),
      H_.field('Descrição', H_.excerpt(plainText(p.description || '')), 'texto puro (sem HTML)'),
      H_.field('Atributos enviados', [...new Set(sent)].join(', '), variants.length ? 'SELLER_SKU e GTIN por variação' : null),
      H_.field('Envio', `${ctx ? ctx.creds.shipping_mode || 'me2' : 'me2'}${p.lengthCm && p.widthCm && p.heightCm && p.weightKg ? ` · ${Math.ceil(p.heightCm)}x${Math.ceil(p.widthCm)}x${Math.ceil(p.lengthCm)} cm, ${Math.ceil(p.weightKg * 1000)} g` : ' · sem dimensões'}`),
    ],
    variants: variants.length ? H_.variantRows(p) : null,
    variantStructure: variants.length ? ({ up: 'User Products (anúncio por variação)', classic: 'clássico (variações no anúncio)' }[model] || null) : null,
  };
}

async function tokenRequest(params) {
  const data = await requestJson(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    user_id: data.user_id,
    expires_at: Date.now() + (data.expires_in || 21600) * 1000,
  };
}

function api(ctx, method, path, body) {
  return requestJson(`${API}${path}`, {
    method, body, headers: { Authorization: `Bearer ${ctx.tokens.access_token}` },
  });
}

async function predictCategory(ctx, title) {
  const site = ctx.creds.site_id || 'MLB';
  const res = await api(ctx, 'GET', `/sites/${site}/domain_discovery/search?limit=1&q=${encodeURIComponent(title)}`);
  if (!Array.isArray(res) || !res.length) {
    throw new PlatformError('Não foi possível prever a categoria. Informe category_ml no produto ou uma categoria padrão.');
  }
  return res[0].category_id;
}

// O ML só aceita texto puro na descrição.
function plainText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, 50000);
}

module.exports._internal = { plainText, sellerTags, categoryCache, variationAxes };
