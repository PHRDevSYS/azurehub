'use strict';
// Prévia: como cada produto vai subir em cada destino, sem enviar nada.
// Destino conectado → validação online só com endpoints de leitura;
// não conectado → regras fixas da plataforma.
const store = require('../lib/store');
const platforms = require('../platforms');

const TIMEOUT_MS = 45000;

function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('tempo esgotado')), ms); })])
    .finally(() => clearTimeout(t));
}

async function previewProducts(skus, targets) {
  const ctxs = {};
  for (const id of targets) {
    try {
      ctxs[id] = await platforms.context(id);
    } catch {
      ctxs[id] = null; // sem credenciais ou sem conexão: prévia offline
    }
  }
  const items = [];
  for (const sku of skus) {
    const prod = store.getProduct(sku);
    if (!prod) {
      items.push({ sku, missing: true, platforms: {} });
      continue;
    }
    const entry = { sku, title: prod.data.title, platforms: {} };
    for (const id of targets) {
      const listing = store.getListing(id, sku);
      const base = {
        action: listing && listing.external_id ? 'atualizar' : 'criar',
        externalId: listing ? listing.external_id : null,
        connected: !!ctxs[id],
        enabled: store.isEnabled(id),
      };
      const plat = platforms.get(id);
      try {
        const r = await withTimeout(plat.preview(ctxs[id], prod.data), TIMEOUT_MS);
        entry.platforms[id] = { ...base, ...r, ready: r.errors.length === 0 };
      } catch (e) {
        // Falha na conta (credencial, rede): mostra as regras offline e mantém o
        // problema como bloqueio — o envio falharia pelo mesmo motivo.
        const offline = await plat.preview(null, prod.data).catch(() => ({ fields: [], variants: null, warnings: [], errors: [] }));
        entry.platforms[id] = {
          ...base, ...offline, online: false, ready: false,
          errors: [`Não foi possível validar na conta (${e.message}). Confira as credenciais/conexão em Integração.`, ...offline.errors],
          warnings: offline.warnings.filter((w) => !/não conectada/.test(w)),
        };
      }
    }
    items.push(entry);
  }
  return { items };
}

module.exports = { previewProducts };
