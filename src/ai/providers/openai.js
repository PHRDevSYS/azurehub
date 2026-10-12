'use strict';
// OpenAI: fotos com GPT Image (edição com as fotos reais do produto como
// referência) e roteiro (agente) com um modelo GPT. Sem vídeo: a OpenAI
// desligou a Videos API (Sora) em 24/09/2026 — o vídeo fica com outro provedor.
// Docs: https://developers.openai.com/api/reference/resources/images/methods/edit
const { AiError, request, fromBase64, dataUri, parseJsonText } = require('./http');

const BASE = 'https://api.openai.com/v1';
const NAME = 'OpenAI';
// Tamanhos válidos no GPT Image 2/2.5 (lados múltiplos de 16).
const SIZE = { '4:5': '1024x1280', '1:1': '1024x1024', '9:16': '1152x2048' };

function headers(cfg) {
  const h = { Authorization: `Bearer ${cfg.apiKey}` };
  if (cfg.extra.organization) h['OpenAI-Organization'] = cfg.extra.organization;
  return h;
}

module.exports = {
  id: 'openai',
  name: 'OpenAI (GPT)',
  docsUrl: 'https://platform.openai.com/api-keys',
  note: 'Fotos com GPT Image e roteiro com GPT. Não gera vídeo (a OpenAI desligou o Sora em 09/2026).',
  models: {
    text: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'],
    image: ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2'],
  },
  defaults: { text: 'gpt-6-luna', image: 'gpt-image-2.5-sunburst' },
  fields: [
    { key: 'quality', label: 'Qualidade das fotos', type: 'select', help: 'Alta preserva melhor o produto; média custa cerca de 1/4',
      options: [['high', 'Alta (recomendada)'], ['medium', 'Média'], ['xhigh', 'Muito alta (só GPT Image 2.5)'], ['low', 'Rascunho']] },
    { key: 'organization', label: 'Organização (opcional)', placeholder: 'org-…', help: 'Só se a chave tiver acesso a mais de uma organização' },
  ],

  // Lista os modelos da conta (não gera nada pago).
  async test(cfg) {
    const data = await request(NAME, `${BASE}/models`, { headers: headers(cfg), timeoutMs: 20000 });
    const ids = new Set((data.data || []).map((m) => m.id));
    const missing = [cfg.models.image, cfg.models.text].filter((m) => m && ids.size && !ids.has(m));
    return {
      account: `${ids.size} modelos liberados para a chave`,
      warning: missing.length ? `A chave não enxerga: ${missing.join(', ')} (a OpenAI pode exigir verificação da organização para GPT Image)` : undefined,
    };
  },

  async writeJson(cfg, { system, user }) {
    const data = await request(NAME, `${BASE}/chat/completions`, {
      method: 'POST', headers: headers(cfg), timeoutMs: 180000,
      json: {
        model: cfg.models.text,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      },
    });
    return parseJsonText(data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content);
  },

  // Edição com até 16 imagens de referência; a resposta vem sempre em base64.
  async image(cfg, { prompt, refs, aspect }) {
    const data = await request(NAME, `${BASE}/images/edits`, {
      method: 'POST', headers: headers(cfg), timeoutMs: 300000,
      json: {
        model: cfg.models.image,
        prompt,
        n: 1,
        size: SIZE[aspect] || 'auto',
        quality: cfg.extra.quality || 'high',
        output_format: 'jpeg',
        output_compression: 92,
        images: refs.slice(0, 16).map((r) => ({ image_url: dataUri(r) })),
      },
    });
    const b64 = data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) throw new AiError(`${NAME}: a resposta não trouxe a imagem`);
    return fromBase64(b64, 'image/jpeg');
  },
};
