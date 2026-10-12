'use strict';
// Google Gemini API (Interactions API): fotos com Nano Banana, vídeo falado
// com Gemini Omni Flash (áudio nativo, 9:16, 3–10 s) e roteiro com Gemini.
// O vídeo roda em segundo plano (background) e o hub consulta até ficar pronto.
// Docs: https://ai.google.dev/gemini-api/docs/image-generation
//       https://ai.google.dev/gemini-api/docs/omni
//       https://ai.google.dev/api/interactions-api
const { AiError, request, fromBase64, parseJsonText } = require('./http');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const NAME = 'Google Gemini';
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif', 'image/gif', 'image/bmp', 'image/tiff'];
const FAILED = ['failed', 'cancelled', 'incomplete', 'budget_exceeded', 'requires_action'];

const headers = (cfg) => ({ 'x-goog-api-key': cfg.apiKey, 'Api-Revision': '2026-05-20' });
const asImage = (r) => ({ type: 'image', mime_type: IMAGE_MIMES.includes(r.mime) ? r.mime : 'image/jpeg', data: r.buffer.toString('base64') });

// Conteúdo gerado: o último bloco do tipo pedido nos passos "model_output".
function output(it, type) {
  const steps = (it && it.steps) || [];
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].type !== 'model_output') continue;
    const found = (steps[i].content || []).filter((c) => c.type === type).pop();
    if (found) return found;
  }
  return null;
}

function failure(it) {
  const errs = [...(it.errors || []), ...((it.steps || []).map((s) => s.error).filter(Boolean))];
  const msg = errs.map((e) => e.message || e.code).filter(Boolean).join('; ');
  if (it.status === 'budget_exceeded') return `${NAME}: limite de gastos do projeto atingido`;
  if (/safety|prohibited|blocklist|spii|recitation|content_blocked/i.test(msg)) return `${NAME}: o pedido foi bloqueado pela política de conteúdo — ajuste o prompt (${msg})`;
  return `${NAME}: a geração terminou como "${it.status}"${msg ? ` (${msg})` : ''}`;
}

async function media(cfg, block, kind) {
  if (block.data) return fromBase64(block.data, block.mime_type || (kind === 'video' ? 'video/mp4' : 'image/jpeg'));
  if (block.uri) {
    const url = new URL(block.uri);
    if (url.hostname !== 'generativelanguage.googleapis.com') throw new AiError(`${NAME}: endereço de download inesperado`);
    const f = await request(NAME, block.uri, { headers: headers(cfg), raw: true, timeoutMs: 300000 });
    return { buffer: f.buffer, mime: block.mime_type || f.mime || 'video/mp4' };
  }
  throw new AiError(`${NAME}: a resposta não trouxe ${kind === 'video' ? 'o vídeo' : 'a imagem'}`);
}

module.exports = {
  id: 'google',
  name: 'Google Gemini',
  docsUrl: 'https://aistudio.google.com/apikey',
  note: 'Fotos com Nano Banana e vídeo falado com Gemini Omni (áudio nativo, até 10 s). Exige projeto com faturamento.',
  models: {
    text: ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest'],
    image: ['gemini-nano-banana-2.1', 'gemini-3-pro-image', 'gemini-3.1-flash-lite-image'],
    video: ['gemini-omni-1.1-flash'],
  },
  defaults: { text: 'gemini-3.6-flash', image: 'gemini-nano-banana-2.1', video: 'gemini-omni-1.1-flash' },
  acceptMimes: IMAGE_MIMES,
  fields: [
    { key: 'imageSize', label: 'Tamanho das fotos', type: 'select', options: [['1K', '1K (928×1152)'], ['2K', '2K (1856×2304)']] },
    { key: 'resolution', label: 'Resolução do vídeo', type: 'select', help: '1080p sai mais caro e demora mais',
      options: [['720p', '720p (recomendada)'], ['1080p', '1080p'], ['360p', '360p (rascunho rápido)']] },
  ],

  async test(cfg) {
    const data = await request(NAME, `${BASE}/models?pageSize=1000`, { headers: headers(cfg), timeoutMs: 20000 });
    const ids = new Set((data.models || []).map((m) => String(m.name).replace(/^models\//, '')));
    const missing = [cfg.models.image, cfg.models.video, cfg.models.text].filter((m) => m && ids.size && !ids.has(m));
    return {
      account: `${ids.size} modelos liberados para a chave`,
      warning: missing.length ? `A chave não enxerga: ${missing.join(', ')}` : undefined,
    };
  },

  async writeJson(cfg, { system, user }) {
    const it = await request(NAME, `${BASE}/interactions`, {
      method: 'POST', headers: headers(cfg), timeoutMs: 180000,
      json: { model: cfg.models.text, system_instruction: system, input: user, response_format: { type: 'text', mime_type: 'application/json' }, store: false },
    });
    const text = output(it, 'text');
    if (!text) throw new AiError(FAILED.includes(it.status) ? failure(it) : `${NAME}: o agente não respondeu`);
    return parseJsonText(text.text);
  },

  async image(cfg, { prompt, refs, aspect }) {
    const it = await request(NAME, `${BASE}/interactions`, {
      method: 'POST', headers: headers(cfg), timeoutMs: 300000,
      json: {
        model: cfg.models.image,
        input: [{ type: 'text', text: prompt }, ...refs.slice(0, 14).map(asImage)],
        response_format: { type: 'image', aspect_ratio: aspect, image_size: cfg.extra.imageSize || '1K' },
        store: false,
      },
    });
    const img = output(it, 'image');
    if (!img) throw new AiError(FAILED.includes(it.status) ? failure(it) : `${NAME}: o modelo não devolveu imagem (tente reescrever o prompt)`);
    return media(cfg, img, 'image');
  },

  // Vídeo em segundo plano: devolve o id da interação para consulta. Se o
  // modelo não aceitar background, gera na mesma chamada (espera mais).
  async startVideo(cfg, { prompt, refs, seconds, aspect }) {
    const secs = Math.min(10, Math.max(3, Math.round(Number(seconds) || 8)));
    const body = {
      model: cfg.models.video,
      input: [...refs.slice(0, 6).map(asImage), { type: 'text', text: prompt }],
      response_format: { type: 'video', aspect_ratio: aspect === '16:9' ? '16:9' : '9:16', resolution: cfg.extra.resolution || '720p', duration: `${secs}s` },
    };
    let it;
    try {
      it = await request(NAME, `${BASE}/interactions`, { method: 'POST', headers: headers(cfg), timeoutMs: 120000, json: { ...body, background: true } });
    } catch (e) {
      if (!(e.status === 400 && /background/i.test(e.message))) throw e;
      it = await request(NAME, `${BASE}/interactions`, { method: 'POST', headers: headers(cfg), timeoutMs: 15 * 60e3, json: { ...body, store: false } });
      const vid = output(it, 'video');
      if (!vid) throw new AiError(FAILED.includes(it.status) ? failure(it) : `${NAME}: o vídeo terminou sem arquivo`);
      return media(cfg, vid, 'video');
    }
    if (!it.id) throw new AiError(`${NAME}: a criação do vídeo não devolveu um id`);
    if (FAILED.includes(it.status)) throw new AiError(failure(it));
    return { job: it.id };
  },

  async checkVideo(cfg, job) {
    const it = await request(NAME, `${BASE}/interactions/${encodeURIComponent(job)}`, { headers: headers(cfg), timeoutMs: 300000 });
    if (it.status === 'completed') {
      const vid = output(it, 'video');
      if (!vid) return { status: 'error', error: `${NAME}: o vídeo terminou sem arquivo` };
      return { status: 'done', ...(await media(cfg, vid, 'video')) };
    }
    if (FAILED.includes(it.status)) return { status: 'error', error: failure(it) };
    return { status: 'running' };
  },
};
