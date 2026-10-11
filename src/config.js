'use strict';
// Configuração lida do ambiente (ou de .env, se existir). Nada aqui é segredo
// de plataforma — credenciais de Mercado Livre / Shopee / TikTok ficam
// cifradas no banco do hub, cadastradas pela interface.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

const dataDir = path.resolve(ROOT, process.env.HUB_DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true });

const port = Number(process.env.PORT || 3900);

module.exports = {
  VERSION: require('../package.json').version,
  ROOT,
  dataDir,
  dbFile: path.join(dataDir, 'azurehub.db'),
  port,
  host: process.env.HOST || '0.0.0.0',
  // URL pública do hub — usada para montar os redirect_uri do OAuth.
  // Tem de ser HTTPS em produção (exigência das três plataformas).
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  // Chave mestra que cifra as credenciais. Se não vier do ambiente, é gerada
  // uma vez e guardada em data/.secret (perder o arquivo = recadastrar tudo).
  secret: process.env.HUB_SECRET || null,
  syncIntervalMs: Number(process.env.SYNC_WORKER_MS || 3000),
  maxMediaBytes: Number(process.env.MAX_MEDIA_MB || 100) * 1024 * 1024,
  sessionHours: Number(process.env.SESSION_HOURS || 12),
};
