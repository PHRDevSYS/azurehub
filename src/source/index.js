'use strict';
// Fonte de produtos: o banco de dados do site do cliente.
// O hub roda uma consulta SELECT (configurada na instalação) cujas colunas
// usam os nomes canônicos (sku, title, price, promo_price, images...).
// Assim qualquer site — WooCommerce, Magento, ERP próprio — se integra só
// ajustando a consulta. Use SEMPRE um usuário de banco somente-leitura.
const store = require('../lib/store');
const { normalizeProduct, validateProduct, productHash, groupVariantRows } = require('./normalize');
const PRESETS = require('./presets');

function loadDriver(name) {
  try {
    return require(name);
  } catch {
    throw new Error(`Driver "${name}" não instalado. Rode: npm install ${name}`);
  }
}

async function query(source) {
  const sql = String(source.query || '').trim();
  if (!/^(select|with)\b/i.test(sql)) throw new Error('A consulta da fonte precisa ser um SELECT');
  switch (source.type) {
    case 'mysql': {
      const mysql = loadDriver('mysql2/promise');
      const conn = await mysql.createConnection({
        host: source.host, port: Number(source.port || 3306), user: source.user,
        password: source.password, database: source.database, connectTimeout: 15000,
        ssl: source.ssl ? { rejectUnauthorized: false } : undefined,
      });
      try {
        const [rows] = await conn.query(sql);
        return rows;
      } finally {
        await conn.end();
      }
    }
    case 'postgres': {
      const { Client } = loadDriver('pg');
      const client = new Client({
        host: source.host, port: Number(source.port || 5432), user: source.user,
        password: source.password, database: source.database, connectionTimeoutMillis: 15000,
        ssl: source.ssl ? { rejectUnauthorized: false } : undefined,
      });
      await client.connect();
      try {
        return (await client.query(sql)).rows;
      } finally {
        await client.end();
      }
    }
    case 'sqlite': {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(source.database, { readOnly: true });
      try {
        return db.prepare(sql).all();
      } finally {
        db.close();
      }
    }
    case 'api':
      return [];
    default:
      throw new Error(`Tipo de fonte desconhecido: ${source.type}`);
  }
}

// Testa a conexão e devolve uma amostra já normalizada (sem gravar nada).
async function testSource(source) {
  if (source.type === 'api') return { ok: true, count: 0, sample: [], note: 'Modo somente API: o site envia os produtos via POST /api/v1/products' };
  const products = groupVariantRows(await query(source));
  const sample = products.slice(0, 3).map((r) => {
    const p = normalizeProduct(r);
    return { product: p, errors: validateProduct(p) };
  });
  return { ok: true, count: products.length, sample };
}

// Grava produtos no hub e enfileira sync nas plataformas ativas.
// Devolve contadores para a interface/API.
function ingest(rawProducts, origin) {
  const out = { received: rawProducts.length, changed: 0, unchanged: 0, invalid: [] };
  const platforms = require('../platforms').ids().filter(store.isEnabled);
  for (const raw of rawProducts) {
    const p = normalizeProduct(raw);
    const errors = validateProduct(p);
    if (errors.length) {
      out.invalid.push({ sku: p.sku || null, errors });
      continue;
    }
    const changed = store.upsertProduct(p, productHash(p), origin);
    if (changed) {
      out.changed++;
      for (const platform of platforms) store.enqueue(platform, p.sku);
    } else {
      out.unchanged++;
    }
  }
  return out;
}

async function importFromSource() {
  const source = store.getSecretSetting('source');
  if (!source || source.type === 'api') return { received: 0, changed: 0, unchanged: 0, invalid: [], note: 'Fonte em modo somente API' };
  const rows = groupVariantRows(await query(source));
  const result = ingest(rows, 'db');
  store.log('info', `Importação da fonte: ${result.received} lidos, ${result.changed} alterados, ${result.invalid.length} inválidos`);
  return result;
}

module.exports = { query, testSource, ingest, importFromSource, PRESETS };
