'use strict';
// Provedores de IA usados pelos agentes. Cada um implementa o que suportar:
//   test(cfg)                                → { account?, warning? } (sem custo)
//   writeJson(cfg, { system, user })         → objeto (modelo de texto)
//   image(cfg, { prompt, refs, persona, aspect })              → { buffer, mime }
//   startVideo(cfg, { prompt, refs, persona, seconds, aspect }) → { job } ou { buffer, mime }
//   checkVideo(cfg, job)                     → { status: running|done|error, buffer?, mime?, error? }
// cfg = { apiKey, models: { text, image, video }, extra }
// e descreve: id, name, docsUrl, note, models (sugestões por tipo),
// defaults (modelo padrão por tipo) e fields (campos extras da conexão).
const registry = new Map();

function register(p) {
  registry.set(p.id, p);
  return p;
}

for (const p of [require('./openai'), require('./google'), require('./xai'), require('./deepseek'), require('./openrouter')]) register(p);

const can = (p, kind) => !!(p && (kind === 'video' ? p.startVideo : kind === 'text' ? p.writeJson : p.image));

module.exports = {
  register,
  can,
  get: (id) => registry.get(id) || null,
  list: () => [...registry.values()],
};
