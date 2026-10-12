'use strict';
// OpenRouter: uma chave para centenas de modelos de texto, imagem e vídeo
// (Llama, Qwen, DeepSeek, Gemini, GPT, Grok, Seedance, Veo, Kling…). Cada
// pedido vai ao fornecedor mais barato do modelo na hora (provider.sort) e
// trocar de modelo é só trocar o nome.
// Docs: https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion
//       https://openrouter.ai/docs/guides/overview/multimodal/image-generation
//       https://openrouter.ai/docs/guides/overview/multimodal/video-generation
//       https://openrouter.ai/docs/guides/routing/provider-selection
const { AiError, request, chatContent, fromBase64, dataUri, parseJsonText, COMMON_MIMES } = require('./http');

const BASE = 'https://openrouter.ai/api/v1';
const HOST = 'openrouter.ai';
const NAME = 'OpenRouter';
const FAILED = ['failed', 'cancelled', 'expired'];

const headers = (cfg) => ({ Authorization: `Bearer ${cfg.apiKey}`, 'X-OpenRouter-Title': 'AzureHub' });
const routing = (cfg) => ({ sort: ['price', 'throughput', 'latency'].includes(cfg.extra.sort) ? cfg.extra.sort : 'price' });
const asRef = (r) => ({ type: 'image_url', image_url: { url: dataUri(r) } });

// Durações e proporções aceitas por cada modelo de vídeo (lista pública,
// guardada por 1 hora) — a duração pedida é ajustada à mais próxima aceita.
let videoModels = { at: 0, byId: {} };
async function videoModel(cfg, id) {
  if (Date.now() - videoModels.at > 3600e3) {
    try {
      const data = await request(NAME, `${BASE}/videos/models`, { headers: headers(cfg), timeoutMs: 20000 });
      videoModels = { at: Date.now(), byId: Object.fromEntries((data.data || []).map((m) => [m.id, m])) };
    } catch {
      videoModels = { at: Date.now() - 3300e3, byId: videoModels.byId }; // tenta de novo em 5 min
    }
  }
  return videoModels.byId[id] || null;
}

// Limites de cada modelo de imagem (nº de referências, proporções), pela
// lista pública de endpoints do modelo — guardados por 1 hora.
const imageInfo = new Map();
async function imageLimits(cfg, id) {
  const hit = imageInfo.get(id);
  if (hit && Date.now() - hit.at < 3600e3) return hit;
  let info = { at: Date.now(), maxRefs: 16, ratios: null };
  try {
    const data = await request(NAME, `${BASE}/images/models/${id.split('/').map(encodeURIComponent).join('/')}/endpoints`, { headers: headers(cfg), timeoutMs: 20000 });
    const eps = data.endpoints || [];
    const maxes = eps.map((e) => ((e.supported_parameters || {}).input_references || {}).max).filter(Number.isFinite);
    // O roteador pode cair em qualquer endpoint: vale o mais restritivo.
    const ratios = eps.map((e) => ((e.supported_parameters || {}).aspect_ratio || {}).values).filter(Array.isArray);
    info = { at: Date.now(), maxRefs: maxes.length ? Math.min(...maxes) : 16, ratios: ratios.length ? ratios.reduce((a, b) => a.filter((r) => b.includes(r))) : null };
  } catch { info.at = Date.now() - 3300e3; /* tenta de novo em 5 min */ }
  imageInfo.set(id, info);
  return info;
}

// Proporção aceita mais próxima da pedida (ex.: 4:5 → 3:4 no Grok).
function closestRatio(ratios, want) {
  if (!ratios || !ratios.length || ratios.includes(want)) return want;
  const val = (r) => { const [w, h] = String(r).split(':').map(Number); return w / h; };
  const target = val(want);
  return ratios.filter((r) => r !== 'auto' && Number.isFinite(val(r))).sort((a, b) => Math.abs(val(a) - target) - Math.abs(val(b) - target))[0] || 'auto';
}

// Vídeo: a doc pede URL pública baixável; a foto da persona (gerada aqui) só
// existe local, então vai embutida.
const videoRef = (r) => ({ type: 'image_url', image_url: { url: /^https:\/\//.test(r.url || '') ? r.url : dataUri(r) } });

const nearest = (list, want) => (Array.isArray(list) && list.length
  ? list.map(Number).sort((a, b) => Math.abs(a - want) - Math.abs(b - want) || a - b)[0]
  : want);

module.exports = {
  id: 'openrouter',
  name: 'OpenRouter',
  docsUrl: 'https://openrouter.ai/settings/keys',
  note: 'Uma chave para centenas de modelos de texto, imagem e vídeo; sempre o fornecedor mais barato na hora.',
  models: {
    text: ['meta-llama/llama-3.3-70b-instruct', 'meta-llama/llama-3.1-8b-instruct', 'qwen/qwen3-14b', 'qwen/qwen3-32b',
      'deepseek/deepseek-v4-flash-0731', 'mistralai/mistral-small-3.2-24b-instruct', 'google/gemini-3.1-flash-lite', 'openai/gpt-5-nano'],
    image: ['google/gemini-nano-banana-2.1', 'openai/gpt-image-2.5-sunburst', 'bytedance-seed/seedream-5-0-flash', 'x-ai/grok-imagine-image-2.0',
      'black-forest-labs/flux-3-image', 'qwen/qwen-image-3'],
    video: ['x-ai/grok-imagine-video-1.5', 'google/veo-3.1-lite', 'google/veo-3.1-fast', 'bytedance/seedance-2.0-fast', 'kwaivgi/kling-v3.0-std', 'x-ai/grok-imagine-video'],
  },
  // Llama 3 e Qwen pequeno: baratos e bons para devolver JSON em português.
  // (O Qwen3 8B ficou sem fornecedor no OpenRouter; o 14B é o mais próximo.)
  recommended: { text: ['meta-llama/llama-3.3-70b-instruct', 'meta-llama/llama-3.1-8b-instruct', 'qwen/qwen3-14b'] },
  defaults: { text: 'meta-llama/llama-3.3-70b-instruct', image: 'google/gemini-nano-banana-2.1', video: 'x-ai/grok-imagine-video-1.5' },
  acceptMimes: COMMON_MIMES,
  fields: [
    { key: 'sort', label: 'Escolha do fornecedor', type: 'select', help: 'O OpenRouter manda cada pedido ao fornecedor do modelo conforme este critério',
      options: [['price', 'Mais barato (recomendado)'], ['throughput', 'Mais rápido (vazão)'], ['latency', 'Menor latência']] },
    { key: 'resolution', label: 'Resolução do vídeo', type: 'select', options: [['720p', '720p (recomendada)'], ['480p', '480p (rascunho)'], ['1080p', '1080p']] },
  ],

  // Dados da chave (crédito restante), sem custo.
  async test(cfg) {
    const { data = {} } = await request(NAME, `${BASE}/key`, { headers: headers(cfg), timeoutMs: 20000 });
    const left = data.limit_remaining;
    return {
      account: [data.label, Number.isFinite(left) ? `crédito restante US$ ${left.toFixed(2)}` : 'sem limite de gasto na chave', data.is_free_tier ? 'conta gratuita' : null].filter(Boolean).join(' · '),
      warning: Number.isFinite(left) && left <= 0 ? 'sem crédito na chave: adicione créditos no OpenRouter' : undefined,
    };
  },

  async writeJson(cfg, { system, user }) {
    const data = await request(NAME, `${BASE}/chat/completions`, {
      method: 'POST', headers: headers(cfg), timeoutMs: 180000,
      json: {
        model: cfg.models.text,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_object' },
        plugins: [{ id: 'response-healing' }], // conserta JSON levemente quebrado
        provider: routing(cfg),
      },
    });
    return parseJsonText(chatContent(NAME, data));
  },

  // Rota de imagens: até 16 imagens de referência; resposta em base64.
  async image(cfg, { prompt, refs, aspect }) {
    const lim = await imageLimits(cfg, cfg.models.image);
    const data = await request(NAME, `${BASE}/images`, {
      method: 'POST', headers: headers(cfg), timeoutMs: 300000,
      json: {
        model: cfg.models.image,
        prompt,
        input_references: refs.slice(0, lim.maxRefs).map(asRef),
        aspect_ratio: closestRatio(lim.ratios, aspect),
        n: 1,
        output_format: 'jpeg',
        provider: routing(cfg),
      },
    });
    const out = (data.data || [])[0];
    if (!out || !out.b64_json) throw new AiError(`${NAME}: a resposta não trouxe a imagem`);
    return fromBase64(out.b64_json, out.media_type || 'image/jpeg');
  },

  // Vídeo assíncrono: as fotos vão como referência (pessoa e produto), com
  // áudio; o id do job volta para consulta.
  async startVideo(cfg, { prompt, refs, seconds, aspect }) {
    const m = await videoModel(cfg, cfg.models.video);
    const ratio = m && Array.isArray(m.supported_aspect_ratios) && !m.supported_aspect_ratios.includes(aspect) ? null : aspect;
    if (!ratio) throw new AiError(`${NAME}: o modelo ${cfg.models.video} não gera vídeo ${aspect}; escolha outro em Agentes de IA`);
    const data = await request(NAME, `${BASE}/videos`, {
      method: 'POST', headers: headers(cfg), timeoutMs: 120000,
      json: {
        model: cfg.models.video,
        prompt,
        duration: nearest(m && m.supported_durations, Math.round(Number(seconds) || 8)),
        aspect_ratio: ratio,
        resolution: cfg.extra.resolution || '720p',
        generate_audio: true,
        input_references: refs.slice(0, 7).map(videoRef),
      },
    });
    if (!data.id) throw new AiError(`${NAME}: a criação do vídeo não devolveu um id`);
    if (FAILED.includes(data.status)) throw new AiError(`${NAME}: ${data.error || `vídeo ${data.status}`}`);
    return { job: data.id };
  },

  _resetVideoModels() { videoModels = { at: 0, byId: {} }; imageInfo.clear(); },

  async checkVideo(cfg, job) {
    const data = await request(NAME, `${BASE}/videos/${encodeURIComponent(job)}`, { headers: headers(cfg), timeoutMs: 60000 });
    if (FAILED.includes(data.status)) return { status: 'error', error: `${NAME}: ${data.error || `o vídeo terminou como "${data.status}"`}` };
    if (data.status !== 'completed') return { status: 'running' };
    const url = (data.unsigned_urls || [])[0] || `${BASE}/videos/${encodeURIComponent(job)}/content?index=0`;
    // O link não é assinado: vai com a chave — então só para o próprio OpenRouter.
    if (new URL(url).hostname !== HOST) return { status: 'error', error: `${NAME}: endereço de download inesperado` };
    const f = await request(NAME, url, { headers: headers(cfg), raw: true, timeoutMs: 300000 });
    return { status: 'done', buffer: f.buffer, mime: /^video\//.test(f.mime) ? f.mime : 'video/mp4' };
  },
};
