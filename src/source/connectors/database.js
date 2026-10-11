'use strict';
// Origem "Banco de dados": o hub roda uma consulta SELECT no banco do
// site/ERP. As colunas usam os nomes do hub (sku, title, price, promo_price,
// images...); uma linha por variação com parent_sku + option_<Nome>.
// Use SEMPRE um usuário de banco somente-leitura.
const { groupVariantRows } = require('../normalize');
const PRESETS = require('../presets');

function loadDriver(name) {
  try {
    return require(name);
  } catch {
    throw new Error(`Driver "${name}" não instalado. Rode: npm install ${name}`);
  }
}

async function query(cfg) {
  const sql = String(cfg.query || '').trim();
  if (!/^(select|with)\b/i.test(sql)) throw new Error('A consulta precisa ser um SELECT');
  switch (cfg.engine) {
    case 'mysql': {
      const mysql = loadDriver('mysql2/promise');
      const conn = await mysql.createConnection({
        host: cfg.host, port: Number(cfg.port || 3306), user: cfg.user, password: cfg.password,
        database: cfg.database, connectTimeout: 15000, ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
      });
      try { return (await conn.query(sql))[0]; } finally { await conn.end(); }
    }
    case 'postgres': {
      const { Client } = loadDriver('pg');
      const client = new Client({
        host: cfg.host, port: Number(cfg.port || 5432), user: cfg.user, password: cfg.password,
        database: cfg.database, connectionTimeoutMillis: 15000, ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
      });
      await client.connect();
      try { return (await client.query(sql)).rows; } finally { await client.end(); }
    }
    case 'sqlite': {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(cfg.database, { readOnly: true });
      try { return db.prepare(sql).all(); } finally { db.close(); }
    }
    default:
      throw new Error(`Banco não suportado: ${cfg.engine}`);
  }
}

module.exports = {
  id: 'database',
  name: 'Banco de dados',
  kind: 'Banco de dados',
  description: 'MySQL/MariaDB, PostgreSQL ou SQLite do seu site ou ERP, lido por uma consulta SELECT.',
  presets: PRESETS,
  fields: [
    { key: 'engine', label: 'Banco', type: 'select', options: [['mysql', 'MySQL / MariaDB'], ['postgres', 'PostgreSQL'], ['sqlite', 'SQLite (arquivo)']], default: 'mysql', required: true },
    { key: 'host', label: 'Host', type: 'text', placeholder: 'db.meusite.com.br', showIf: { engine: ['mysql', 'postgres'] }, required: true },
    { key: 'port', label: 'Porta', type: 'text', placeholder: '3306 / 5432', showIf: { engine: ['mysql', 'postgres'] } },
    { key: 'user', label: 'Usuário', type: 'text', help: 'Use um usuário somente-leitura.', showIf: { engine: ['mysql', 'postgres'] } },
    { key: 'password', label: 'Senha', type: 'password', showIf: { engine: ['mysql', 'postgres'] } },
    { key: 'database', label: 'Banco de dados', type: 'text', help: 'No SQLite, o caminho do arquivo.', required: true },
    { key: 'ssl', label: 'Conexão SSL', type: 'checkbox', showIf: { engine: ['mysql', 'postgres'] } },
    { key: 'query', label: 'Consulta de produtos (SELECT)', type: 'sql', required: true, default: PRESETS.generico.query, help: 'Colunas com os nomes do hub: sku, title, description, price, promo_price, stock, images, videos… Variações: uma linha por variação com parent_sku e option_<Nome>.' },
  ],

  async test(cfg) {
    const rows = groupVariantRows(await query(cfg));
    return { ok: true, count: rows.length, sample: rows.slice(0, 3) };
  },

  async fetchProducts(cfg) {
    return groupVariantRows(await query(cfg));
  },
};

module.exports._internal = { query };
