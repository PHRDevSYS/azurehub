'use strict';
// Provedores de IA para a mídia UGC. Cada um implementa (o que suportar):
//   test(cfg)                                → { account? }
//   writeJson(cfg, { system, user })         → objeto (modelo de texto: o agente)
//   image(cfg, { prompt, refs, aspect })     → { buffer, mime }
//   startVideo(cfg, { prompt, ref, refs, seconds, aspect }) → { job }
//   checkVideo(cfg, job)                     → { status: running|done|error, buffer?, mime?, error? }
// cfg = { apiKey, models: { text, image, video }, extra, videoSeconds }
const registry = new Map();

function register(p) {
  registry.set(p.id, p);
  return p;
}

for (const name of ['openai', 'google', 'xai', 'fal', 'replicate']) {
  try {
    register(require(`./${name}`));
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND' || !String(e.message).includes(`/${name}`)) throw e;
  }
}

module.exports = {
  register,
  get: (id) => registry.get(id) || null,
  list: () => [...registry.values()],
};
