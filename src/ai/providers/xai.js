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
    image: ['grok-imagine-image-2.0', 'grok-imagine-image'],
    // O 1.5-lite não aceita imagens de referência; o clássico não tem fala com sincronia labial.
    video: ['grok-imagine-video-1.5'],
  },
  defaults: { text: 'grok-4.3', image: 'grok-imagine-image-2.0', video: 'grok-imagine-video-1.5' },
  acceptMimes: COMMON_MIMES,
  maxVideoSeconds: () => 15,
  fields: [
    { key: 'resolution', label: 'Resolução das fotos', type: 'select', options: [['1k', '1K'], ['2k', '2K']] },
    { key: 'videoResolution', label: 'Resolução do vídeo', type: 'select', help: 'Com imagens de referência, o máximo é 720p',
      options: [['720p', '720p (recomendada)'], ['480p', '480p (rascunho)']] },
  ],

  async test(cfg) {
    const data = await request(NAME, `${BASE}/models`, { headers: headers(cfg), timeoutMs: 20000 });
    const ids = new Set((data.data || []).flatMap((m) => [m.id, ...(m.aliases || [])]));
    const missing = [cfg.models.image, cfg.models.video, cfg.models.text].filter((m) => m && ids.size && !ids.has(m));
    return { account: `${ids.size} modelos liberados para a chave`, warning: missing.length ? `A chave não enxerga: ${missing.join(', ')}` : undefined };
  },

  // Chat compatível com a OpenAI; o JSON vem pedido no próprio prompt.
  async writeJson(cfg, { system, user }) {
    const data = await request(NAME, `${BASE}/chat/completions`, {
      method: 'POST', headers: headers(cfg), timeoutMs: 180000,
      json: {
        model: cfg.models.text,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_object' },
        ...(/^grok-4\.7/.test(cfg.models.text || '') ? { reasoning_effort: 'low' } : {}),
      },
    });
    return parseJsonText(chatContent(NAME, data));
  },

  async image(cfg, { prompt, refs, persona, aspect }) {
    // Até 5 imagens só no 2.0; os modelos antigos aceitam 3.
    const imgs = refs.slice(0, /^grok-imagine-image-2\.0/.test(cfg.models.image || '') ? 5 : 3);
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
    if (out && out.respect_moderation === false) throw new AiError(`${NAME}: a foto foi bloqueada pela política de conteúdo — ajuste o prompt`);
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
        duration: Math.min(cfg.models.video === 'grok-imagine-video' ? 10 : 15, Math.max(1, Math.round(Number(seconds) || 8))),
        aspect_ratio: ASPECT[aspect] || '9:16',
        resolution: cfg.extra.videoResolution || '720p',
      },
    });
    if (!data.request_id) throw new AiError(`${NAME}: a criação do vídeo não devolveu um id`);
    return { job: data.request_id };
  },

  async checkVideo(cfg, job) {
    let data;
    try {
      data = await request(NAME, `${BASE}/videos/${encodeURIComponent(job)}`, { headers: headers(cfg), timeoutMs: 60000 });
    } catch (e) {
      if (e.status === 404) return { status: 'error', error: `${NAME}: o pedido de vídeo não existe mais no provedor (expirou); gere de novo` };
      throw e;
    }
    const st = data.status;
    const v = data.video || {};
    if (st === 'failed' || st === 'expired') {
      const e = data.error || {};
      return { status: 'error', error: `${NAME}: ${st === 'expired' ? 'o pedido de vídeo expirou no provedor; gere de novo' : e.message || e.code || 'a geração do vídeo falhou'}` };
    }
    if (st !== 'done' && !(st == null && v.url)) return { status: 'running' };
    if (v.respect_moderation === false) return { status: 'error', error: `${NAME}: o vídeo foi bloqueado pela política de conteúdo — ajuste o prompt` };
    const url = v.url || (v.file_output && v.file_output.public_url);
    if (!url) return { status: 'error', error: `${NAME}: o vídeo ficou pronto mas o provedor não devolveu o link${v.storage_error ? ` (${v.storage_error})` : ''}` };
    const u = new URL(url);
    if (u.protocol !== 'https:' || !(u.hostname === 'x.ai' || u.hostname.endsWith('.x.ai'))) return { status: 'error', error: `${NAME}: endereço de download inesperado (${u.hostname})` };
    try {
      const f = await request(NAME, url, { raw: true, timeoutMs: 300000 });
      return { status: 'done', buffer: f.buffer, mime: /^video\//.test(f.mime) ? f.mime : 'video/mp4' };
    } catch (e) {
      if (e.status && e.status < 500) return { status: 'error', error: `${NAME}: o link temporário do vídeo expirou (HTTP ${e.status}); gere de novo` };
      throw e;
    }
  },
};
