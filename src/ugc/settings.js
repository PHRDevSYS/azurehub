'use strict';
// Conexão com os modelos de IA da mídia UGC. Cada provedor guarda a própria
// chave de API (cifrada no banco, como as credenciais dos marketplaces; o
// painel só vê os 4 últimos caracteres) e os modelos escolhidos. Fotos e
// vídeo podem vir de provedores diferentes (ex.: imagens no GPT, vídeo no
// Gemini), porque nem todo provedor gera os dois.
const store = require('../lib/store');
const providers = require('./providers');

const DEFAULTS = { image: null, video: null, models: {}, extra: {}, videoSeconds: 8 };
const keyName = (id) => `ugc_key_${id}`;
const mask = (k) => (k ? `••••${k.slice(-4)}` : null);
const clean = (v) => (v === undefined || v === null ? '' : String(v).trim().slice(0, 200));
const can = (p, kind) => !!(kind === 'video' ? p.startVideo : kind === 'text' ? p.writeJson : p.image);
const label = (kind) => (kind === 'video' ? 'vídeo' : 'imagem');

function get() {
  return { ...DEFAULTS, ...(store.getSetting('ugc', {}) || {}) };
}

// Modelo escolhido para cada uso; vazio cai no padrão do provedor.
function modelsOf(cfg, p) {
  const chosen = (cfg.models || {})[p.id] || {};
  return Object.fromEntries(['text', 'image', 'video'].map((k) => [k, can(p, k) ? chosen[k] || (p.defaults || {})[k] || '' : '']));
}

function summary() {
  const cfg = get();
  return {
    use: { image: cfg.image, video: cfg.video },
    videoSeconds: cfg.videoSeconds,
    providers: providers.list().map((p) => {
      const key = store.getSecretSetting(keyName(p.id));
      return {
        id: p.id, name: p.name, docsUrl: p.docsUrl, note: p.note || null,
        can: { text: can(p, 'text'), image: can(p, 'image'), video: can(p, 'video') },
        options: p.models, defaults: p.defaults, models: modelsOf(cfg, p),
        fields: p.fields || [], extra: (cfg.extra || {})[p.id] || {},
        connected: !!key, key: mask(key),
      };
    }),
  };
}

// Salva a conexão de um provedor (chave, modelos, campos extras) e/ou a
// escolha de quem gera as fotos e o vídeo.
function save(input = {}) {
  const cfg = get();
  if (input.provider !== undefined) {
    const p = providers.get(input.provider);
    if (!p) throw new Error('Escolha um provedor de IA');
    if (input.removeKey) store.setSecretSetting(keyName(p.id), null);
    else if (input.apiKey && !/^•/.test(String(input.apiKey))) store.setSecretSetting(keyName(p.id), String(input.apiKey).trim());
    const m = input.models || {};
    cfg.models = { ...cfg.models, [p.id]: { text: clean(m.text), image: clean(m.image), video: clean(m.video) } };
    cfg.extra = { ...cfg.extra, [p.id]: Object.fromEntries((p.fields || []).map((f) => [f.key, clean((input.extra || {})[f.key])])) };
    // Primeiro provedor conectado já assume o que sabe fazer.
    const connected = !!store.getSecretSetting(keyName(p.id));
    for (const kind of ['image', 'video']) {
      if (connected && can(p, kind) && !cfg[kind]) cfg[kind] = p.id;
      if (!connected && cfg[kind] === p.id) cfg[kind] = null;
    }
  }
  if (input.use) {
    for (const kind of ['image', 'video']) {
      if (!(kind in input.use)) continue;
      const id = input.use[kind] || null;
      if (id) {
        const p = providers.get(id);
        if (!p) throw new Error(`Provedor de IA desconhecido: ${id}`);
        if (!can(p, kind)) throw new Error(`${p.name} não gera ${kind === 'video' ? 'vídeos' : 'imagens'}`);
      }
      cfg[kind] = id;
    }
  }
  const secs = Number(input.videoSeconds);
  if (input.videoSeconds !== undefined && input.videoSeconds !== '' && Number.isFinite(secs)) cfg.videoSeconds = Math.min(20, Math.max(3, Math.round(secs)));
  store.setSetting('ugc', cfg);
  return summary();
}

function ready(p, cfg) {
  const apiKey = store.getSecretSetting(keyName(p.id));
  if (!apiKey) throw new Error(`Informe a chave de API de ${p.name} em "Modelo de IA"`);
  return { provider: p, cfg: { apiKey, models: modelsOf(cfg, p), extra: (cfg.extra || {})[p.id] || {}, videoSeconds: cfg.videoSeconds } };
}

// Provedor pronto para uso: por id (o gravado no pedido) ou pelo papel
// ('image' = fotos 1–3, 'video' = mídia 4).
function active({ id, kind } = {}) {
  const cfg = get();
  const pid = id || cfg[kind === 'video' ? 'video' : 'image'];
  if (!pid) throw new Error(`Conecte um modelo de IA de ${label(kind)} em "Modelo de IA" antes de gerar`);
  const p = providers.get(pid);
  if (!p) throw new Error(`Provedor de IA desconhecido: ${pid}`);
  if (kind && !can(p, kind)) throw new Error(`${p.name} não gera ${kind === 'video' ? 'vídeos' : 'imagens'}; escolha outro em "Modelo de IA"`);
  return ready(p, cfg);
}

// Quem escreve o roteiro (agente): o provedor das fotos ou, se ele não tiver
// modelo de texto, o do vídeo. Sem nenhum, null (prompts-padrão).
function writer() {
  const cfg = get();
  for (const pid of [cfg.image, cfg.video]) {
    const p = pid && providers.get(pid);
    if (p && can(p, 'text') && store.getSecretSetting(keyName(p.id))) return ready(p, cfg);
  }
  return null;
}

module.exports = { get, save, summary, active, writer, keyName, can };
