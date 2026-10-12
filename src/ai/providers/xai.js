'use strict';
// xAI (Grok): fotos com Grok Imagine Image (edição com até 5 imagens de
// referência), vídeo falado com Grok Imagine Video 1.5 (referências de pessoa e
// produto, fala com sincronia labial, até 15 s) e roteiro com Grok.
// Docs: https://docs.x.ai/developers/rest-api-reference/inference/images
//       https://docs.x.ai/developers/model-capabilities/video/reference-to-video
const { AiError, request, chatContent, fromBase64, dataUri, parseJsonText, COMMON_MIMES } = require('./http');

const BASE = 'https://api.x.ai/v1';
const NAME = 'xAI';
// Sem 4:5 no Grok Imagine: 3:4 é o mais próximo.
const ASPECT = { '4:5': '3:4', '1:1': '1:1', '9:16': '9:16', '16:9': '16:9' };

const headers = (cfg) => ({ Authorization: `Bearer ${cfg.apiKey}` });

// Etiquetas que o Grok usa para citar as imagens no prompt.
function tagged(prompt, refs, persona) {
  const tags = refs.map((_, i) => `<IMAGE_${i}> = ${persona && i === 0 ? 'o(a) influencer' : 'foto do produto'}`);
  return `${prompt}\n${tags.join('; ')}.`;
}

module.exports = {
  id: 'xai',
  name: 'xAI (Grok)',
  docsUrl: 'https://console.x.ai',
  note: 'Fotos e vídeo falado com Grok Imagine (sincronia labial, até 15 s) e roteiro com Grok.',
  models: {
    text: ['grok-4.3', 'grok-4.7'],
    image: ['grok-imagine-image-2.0', 'grok-imagine-image-quality', 'grok-imagine-image'],
    video: ['grok-imagine-video-1.5', 'grok-imagine-video-1.5-lite', 'grok-imagine-video'],
  },
  defaults: { text: 'grok-4.3', image: 'grok-imagine-image-2.0', video: 'grok-imagine-video-1.5' },
  acceptMimes: COMMON_MIMES,
  fields: [
    { key: 'resolution', label: 'Resolução das fotos', type: 'select', options: [['1k', '1K'], ['2k', '2K']] },
    { key: 'videoResolution', label: 'Resolução do vídeo', type: 'select', help: 'Com imagens de referência, o máximo é 720p',
      options: [['720p', '720p (recomendada)'], ['480p', '480p (rascunho)']] },
  ],

  async test(cfg) {
    const data = await request(NAME, `${BASE}/models`, { headers: headers(cfg), timeoutMs: 20000 });
    const ids = new Set((data.data || []).map((m) => m.id));
    const missing = [cfg.models.image, cfg.models.video, cfg.models.text].filter((m) => m && ids.size && !ids.has(m));
    return { account: `${ids.size} modelos liberados para a chave`, warning: missing.length ? `A chave não enxerga: ${missing.join(', ')}` : undefined };
  },

  // Chat compatível com a OpenAI; o JSON vem pedido no próprio prompt.
  async writeJson(cfg, { system, user }) {
    const data = await request(NAME, `${BASE}/chat/completions`, {
      method: 'POST', headers: headers(cfg), timeoutMs: 180000,
      json: { model: cfg.models.text, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
    });
    return parseJsonText(chatContent(NAME, data));
  },

  async image(cfg, { prompt, refs, persona, aspect }) {
    const imgs = refs.slice(0, 5);
    const data = await request(NAME, `${BASE}/images/edits`, {
      method: 'POST', headers: headers(cfg), timeoutMs: 300000,
      json: {
        model: cfg.models.image,
        prompt: tagged(prompt, imgs, persona),
        images: imgs.map((r) => ({ url: dataUri(r) })),
        aspect_ratio: ASPECT[aspect] || 'auto',
        resolution: cfg.extra.resolution || '1k',
        response_format: 'b64_json',
        n: 1,
      },
    });
    const out = data.data && data.data[0];
    if (!out || !out.b64_json) throw new AiError(`${NAME}: a resposta não trouxe a imagem`);
    return fromBase64(out.b64_json, out.mime_type || 'image/jpeg');
  },

  // Referência → vídeo: a pessoa e o produto entram como referências (sem
  // travar o primeiro quadro); devolve o request_id para consulta.
  async startVideo(cfg, { prompt, refs, persona, seconds, aspect }) {
    const imgs = refs.slice(0, 7);
    const data = await request(NAME, `${BASE}/videos/generations`, {
      method: 'POST', headers: headers(cfg), timeoutMs: 120000,
      json: {
        model: cfg.models.video,
        prompt: tagged(prompt, imgs, persona),
        reference_images: imgs.map((r) => ({ url: dataUri(r) })),
        duration: Math.min(15, Math.max(1, Math.round(Number(seconds) || 8))),
        aspect_ratio: ASPECT[aspect] || '9:16',
        resolution: cfg.extra.videoResolution || '720p',
      },
    });
    if (!data.request_id) throw new AiError(`${NAME}: a criação do vídeo não devolveu um id`);
    return { job: data.request_id };
  },

  async checkVideo(cfg, job) {
    const data = await request(NAME, `${BASE}/videos/${encodeURIComponent(job)}`, { headers: headers(cfg), timeoutMs: 60000 });
    if (data.status === 'failed') {
      const e = data.error || {};
      return { status: 'error', error: `${NAME}: ${e.message || e.code || 'a geração do vídeo falhou'}` };
    }
    if (data.status !== 'done') return { status: 'running' };
    const v = data.video || {};
    if (v.respect_moderation === false || !v.url) return { status: 'error', error: `${NAME}: o vídeo foi bloqueado pela política de conteúdo — ajuste o prompt` };
    if (!/^https:\/\//.test(v.url)) return { status: 'error', error: `${NAME}: endereço de download inesperado` };
    const f = await request(NAME, v.url, { raw: true, timeoutMs: 300000 });
    return { status: 'done', buffer: f.buffer, mime: /^video\//.test(f.mime) ? f.mime : 'video/mp4' };
  },
};
