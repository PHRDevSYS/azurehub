'use strict';
// Configuração central da IA: a chave de API de cada provedor (cifrada no
// banco, como as credenciais dos marketplaces — o painel só vê os 4 últimos
// caracteres), os campos extras de cada conexão e, para cada agente, qual
// provedor e qual modelo executam cada função.
const store = require('../lib/store');
const providers = require('./providers');
const agents = require('./agents');

const keyName = (id) => `ai_key_${id}`;
const mask = (k) => (k ? `••••${k.slice(-4)}` : null);
const clean = (v, max = 200) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const KIND = { text: 'texto', image: 'imagem', video: 'vídeo' };

// Versão anterior (só mídia UGC): { image, video, models, extra, videoSeconds }
// e chaves "ugc_key_<id>". Migra uma vez para o formato por agente.
function migrate() {
  const old = store.getSetting('ugc', null);
  const cfg = { agents: {}, extra: {} };
  if (!old) return cfg;
  const pick = (pid, kind) => (pid ? { provider: pid, model: ((old.models || {})[pid] || {})[kind] || '' } : null);
  const writer = [old.image, old.video].find((pid) => providers.can(providers.get(pid), 'text'));
  cfg.agents.midia = {
    slots: { image: pick(old.image, 'image'), video: pick(old.video, 'video'), text: pick(writer, 'text') },
    options: { videoSeconds: old.videoSeconds || 8 },
  };
  cfg.extra = old.extra || {};
  for (const p of providers.list()) {
    const k = store.getSecretSetting(`ugc_key_${p.id}`);
    if (k && !store.getSecretSetting(keyName(p.id))) store.setSecretSetting(keyName(p.id), k);
  }
  return cfg;
}

function get() {
  let cfg = store.getSetting('ai', null);
  if (!cfg) {
    cfg = migrate();
    store.setSetting('ai', cfg);
  }
  return { agents: cfg.agents || {}, extra: cfg.extra || {} };
}

const keyOf = (pid) => store.getSecretSetting(keyName(pid));

// Opções do agente com os valores padrão preenchidos.
function optionsOf(agent, cfg) {
  const saved = ((cfg.agents[agent.id] || {}).options) || {};
  return Object.fromEntries(agent.options.map((o) => [o.key, saved[o.key] ?? o.default]));
}

// Função de um agente: provedor e modelo (vazio = padrão do provedor).
function pickOf(saved, slot) {
  if (!saved || !saved.provider) return null;
  const p = providers.get(saved.provider);
  return { provider: saved.provider, model: saved.model || (p && (p.defaults || {})[slot.kind]) || '' };
}

// Modelo reserva: entra no lugar do principal quando ele falha (fora do ar,
// sem saldo, limite de uso…). Igual ao principal não conta.
function slotOf(agent, slot, cfg) {
  const saved = (((cfg.agents[agent.id] || {}).slots) || {})[slot.key];
  const main = pickOf(saved, slot);
  if (!main) return { provider: null, model: '', fallback: null };
  let fb = pickOf(saved.fallback, slot);
  if (fb && fb.provider === main.provider && fb.model === main.model) fb = null;
  return { ...main, fallback: fb };
}

function summary() {
  const cfg = get();
  return {
    providers: providers.list().map((p) => {
      const key = keyOf(p.id);
      return {
        id: p.id, name: p.name, docsUrl: p.docsUrl, note: p.note || null,
        can: { text: providers.can(p, 'text'), image: providers.can(p, 'image'), video: providers.can(p, 'video') },
        models: p.models || {}, defaults: p.defaults || {}, recommended: p.recommended || {},
        fields: p.fields || [], extra: cfg.extra[p.id] || {},
        connected: !!key, key: mask(key),
      };
    }),
    agents: agents.AGENTS.map((a) => ({
      id: a.id, name: a.name, status: a.status, description: a.description, options: a.options,
      slots: a.slots.map((s) => ({ ...s, ...slotOf(a, s, cfg) })),
      values: optionsOf(a, cfg),
    })),
  };
}

// Chave e campos extras de um provedor.
function saveProvider(id, input = {}) {
  const p = providers.get(id);
  if (!p) throw new Error(`Provedor de IA desconhecido: ${id}`);
  const cfg = get();
  if (input.removeKey) store.setSecretSetting(keyName(p.id), null);
  else if (input.apiKey && !/^•/.test(String(input.apiKey))) store.setSecretSetting(keyName(p.id), clean(input.apiKey, 500));
  if (input.extra) cfg.extra[p.id] = Object.fromEntries((p.fields || []).map((f) => [f.key, clean(input.extra[f.key])]));
  // Sem chave, o provedor sai das funções que ocupava.
  if (!keyOf(p.id)) {
    for (const a of Object.values(cfg.agents)) {
      for (const [k, s] of Object.entries(a.slots || {})) {
        if (s && s.provider === p.id) a.slots[k] = null;
        else if (s && s.fallback && s.fallback.provider === p.id) delete s.fallback;
      }
    }
  }
  store.setSetting('ai', cfg);
  return summary();
}

// Provedor e modelo de cada função do agente, e as opções.
function saveAgent(id, input = {}) {
  const agent = agents.get(id);
  if (!agent) throw new Error(`Agente desconhecido: ${id}`);
  const cfg = get();
  const cur = cfg.agents[id] || { slots: {}, options: {} };
  const slots = { ...cur.slots };
  for (const s of agent.slots) {
    if (!input.slots || !(s.key in input.slots)) continue;
    const v = input.slots[s.key] || {};
    const pid = clean(v.provider);
    if (!pid) { slots[s.key] = null; continue; }
    const check = (id, what) => {
      const p = providers.get(id);
      if (!p) throw new Error(`Provedor de IA desconhecido: ${id}`);
      if (!providers.can(p, s.kind)) throw new Error(`${p.name} não tem modelo de ${KIND[s.kind]} para "${s.label}"`);
      if (!keyOf(p.id)) throw new Error(`Conecte ${p.name} (chave de API) antes de usá-lo em "${s.label}"${what}`);
      return p;
    };
    const p = check(pid, '');
    slots[s.key] = { provider: p.id, model: clean(v.model) };
    const fid = v.fallback ? clean(v.fallback.provider) : '';
    if (fid) {
      const fp = check(fid, ' (modelo reserva)');
      slots[s.key].fallback = { provider: fp.id, model: clean(v.fallback.model) };
    }
  }
  const options = { ...cur.options };
  for (const o of agent.options) {
    if (!input.options || input.options[o.key] === undefined || input.options[o.key] === '') continue;
    const n = Number(input.options[o.key]);
    if (!Number.isFinite(n)) throw new Error(`"${o.label}" precisa ser um número`);
    options[o.key] = Math.min(o.max, Math.max(o.min, Math.round(n)));
  }
  cfg.agents[id] = { slots, options };
  store.setSetting('ai', cfg);
  return summary();
}

// Conexão pronta de um provedor (chave + extras), com os modelos pedidos.
function connection(pid, models = {}) {
  const p = providers.get(pid);
  if (!p) throw new Error(`Provedor de IA desconhecido: ${pid}`);
  const apiKey = keyOf(p.id);
  if (!apiKey) throw new Error(`Informe a chave de API de ${p.name} em "Agentes de IA"`);
  return { provider: p, cfg: { apiKey, models, extra: get().extra[p.id] || {} } };
}

// Função de um agente pronta para uso: { provider, model, cfg }. Sem
// configuração, erro com a explicação (ou null com { optional: true }).
function resolve(agentId, slotKey, { optional = false } = {}) {
  const agent = agents.get(agentId);
  const slot = agent && agent.slots.find((s) => s.key === slotKey);
  if (!slot) throw new Error(`Função desconhecida: ${agentId}.${slotKey}`);
  const cfg = get();
  const { provider: pid, model } = slotOf(agent, slot, cfg);
  if (!pid || !keyOf(pid) || !model) {
    if (optional) return null;
    throw new Error(`Escolha o modelo de ${KIND[slot.kind]} para "${slot.label}" em Agentes de IA › ${agent.name}`);
  }
  const conn = connection(pid, { [slot.kind]: model });
  const out = { ...conn, model, kind: slot.kind, fallback: null };
  const fb = slotOf(agent, slot, cfg).fallback;
  if (fb && fb.model && keyOf(fb.provider)) out.fallback = { ...connection(fb.provider, { [slot.kind]: fb.model }), model: fb.model, kind: slot.kind };
  return out;
}

// Executa fn(alvo) no modelo principal; se ele falhar e houver reserva, repete
// no reserva. Devolve também qual dos dois respondeu.
async function withFallback(target, fn) {
  try {
    return { value: await fn(target), used: target, fellBack: false };
  } catch (e) {
    if (!target.fallback) throw e;
    store.log('warn', `Agentes de IA: ${target.provider.name} (${target.model}) falhou — usando o modelo reserva ${target.fallback.provider.name} (${target.fallback.model}): ${e.message}`);
    return { value: await fn(target.fallback), used: target.fallback, fellBack: true };
  }
}

const options = (agentId) => optionsOf(agents.get(agentId), get());

// Duração do vídeo da mídia UGC, limitada ao máximo do modelo escolhido
// (o roteiro de fala é escrito para esta duração).
function videoSeconds() {
  const secs = options('midia').videoSeconds;
  const r = resolve('midia', 'video', { optional: true });
  const max = r && r.provider.maxVideoSeconds ? r.provider.maxVideoSeconds(r.model) : null;
  return max ? Math.min(secs, max) : secs;
}

// Modelos que os agentes usam de um provedor (o teste de conexão confere se a
// chave enxerga cada um).
function modelsInUse(pid) {
  const cfg = get();
  const out = {};
  for (const a of agents.AGENTS) {
    for (const s of a.slots) {
      const v = slotOf(a, s, cfg);
      if (v.provider === pid && v.model && !out[s.kind]) out[s.kind] = v.model;
      else if (v.fallback && v.fallback.provider === pid && v.fallback.model && !out[s.kind]) out[s.kind] = v.fallback.model;
    }
  }
  return out;
}

module.exports = { get, summary, saveProvider, saveAgent, connection, resolve, withFallback, options, videoSeconds, modelsInUse, keyName };
