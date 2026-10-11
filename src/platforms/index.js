'use strict';
// Registro das plataformas + montagem do contexto autenticado
// (credenciais decifradas e token renovado quando perto de expirar).
const store = require('../lib/store');
const config = require('../config');
const { PlatformError } = require('../lib/media');

const REGISTRY = {
  mercadolivre: require('./mercadolivre'),
  shopee: require('./shopee'),
  tiktok: require('./tiktok'),
};

const ids = () => Object.keys(REGISTRY);

function get(id) {
  const p = REGISTRY[id];
  if (!p) throw new PlatformError(`Plataforma desconhecida: ${id}`);
  return p;
}

const redirectUri = (id) => `${config.publicUrl}/oauth/${id}/callback`;

// Evita dois refresh simultâneos da mesma plataforma (o refresh token do ML
// e da TikTok é de uso único — duas renovações paralelas derrubam a conexão).
const refreshing = {};

async function context(id) {
  const platform = get(id);
  const creds = store.getCredentials(id);
  if (!creds) throw new PlatformError(`${platform.name}: credenciais não cadastradas`);
  let tokens = store.getTokens(id);
  if (!tokens || !tokens.access_token) throw new PlatformError(`${platform.name}: conta não conectada (clique em Conectar)`);
  if (tokens.expires_at && tokens.expires_at < Date.now() + 120e3) {
    refreshing[id] ||= (async () => {
      try {
        const fresh = await platform.refreshTokens({ creds, tokens });
        store.setTokens(id, fresh);
        store.log('info', 'Token renovado', { platform: id });
        return fresh;
      } finally {
        delete refreshing[id];
      }
    })();
    tokens = await refreshing[id];
  }
  return { creds, tokens, platform };
}

function summary(id) {
  const p = get(id);
  const creds = store.getCredentials(id);
  const tokens = store.getTokens(id);
  const masked = {};
  for (const f of p.credentialFields) {
    const v = creds && creds[f.key];
    masked[f.key] = f.type === 'password' ? (v ? '••••••' + String(v).slice(-4) : '') : (v ?? f.default ?? '');
  }
  return {
    id, name: p.name, color: p.color, textColor: p.textColor, docsUrl: p.docsUrl,
    fields: p.credentialFields, values: masked,
    configured: !!creds, connected: !!(tokens && tokens.access_token),
    account: tokens && tokens.account || null,
    tokenExpiresAt: tokens && tokens.expires_at ? new Date(tokens.expires_at).toISOString() : null,
    enabled: store.isEnabled(id),
    redirectUri: redirectUri(id),
    stats: store.listingStats(id),
  };
}

module.exports = { REGISTRY, ids, get, context, summary, redirectUri };
