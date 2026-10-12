'use strict';
// Conectores de IA da mídia UGC: o formato exato das requisições e a leitura
// das respostas de cada provedor, com o fetch simulado (sem chamadas pagas).
const test = require('node:test');
const assert = require('node:assert/strict');

const openai = require('../src/ai/providers/openai');
const google = require('../src/ai/providers/google');
const xai = require('../src/ai/providers/xai');
const deepseek = require('../src/ai/providers/deepseek');
const openrouter = require('../src/ai/providers/openrouter');
const { sniffImage } = require('../src/ai/providers/http');

const realFetch = global.fetch;
let calls = [];
let replies = [];
const JPG = Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const ref = (n) => ({ url: `https://site.test/${n}.jpg`, buffer: JPG, mime: 'image/jpeg' });

function reply(status, body, headers = {}) {
  replies.push(typeof body === 'string' || Buffer.isBuffer(body)
    ? new Response(body, { status, headers })
    : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } }));
}

test.beforeEach(() => {
  calls = [];
  replies = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    if (!replies.length) throw new Error(`resposta não programada para ${url}`);
    return replies.shift();
  };
});
test.after(() => { global.fetch = realFetch; });

const cfgOf = (p, extra = {}) => ({ apiKey: 'chave-xyz', models: { ...p.defaults }, extra, videoSeconds: 8 });

// ===================================================================== OpenAI
test('OpenAI: foto com as fotos do produto em /images/edits (JSON, data URL, 4:5)', async () => {
  reply(200, { data: [{ b64_json: JPG.toString('base64') }], output_format: 'jpeg' });
  const out = await openai.image(cfgOf(openai, { quality: 'medium' }), { prompt: 'influencer usando', refs: [ref(1), ref(2)], aspect: '4:5' });
  assert.equal(out.mime, 'image/jpeg');
  assert.ok(out.buffer.equals(JPG));
  const c = calls[0];
  assert.equal(c.url, 'https://api.openai.com/v1/images/edits');
  assert.equal(c.headers.Authorization, 'Bearer chave-xyz');
  assert.equal(c.body.model, 'gpt-image-2.5-sunburst');
  assert.equal(c.body.size, '1024x1280');
  assert.equal(c.body.quality, 'medium');
  assert.equal(c.body.images.length, 2);
  assert.match(c.body.images[0].image_url, /^data:image\/jpeg;base64,\/9j\//);
  assert.equal(c.body.response_format, undefined, 'GPT Image não aceita response_format');
  assert.equal(openai.startVideo, undefined, 'a OpenAI não gera vídeo (Sora desligado)');
});

test('OpenAI: roteiro em JSON pelo chat e teste da chave sem custo', async () => {
  reply(200, { choices: [{ message: { content: '```json\n{"uso":"a","posse":"b","especificacoes":"c","video":"d"}\n```' } }] });
  const out = await openai.writeJson(cfgOf(openai), { system: 'Responda em JSON', user: '{"x":1}' });
  assert.deepEqual(out, { uso: 'a', posse: 'b', especificacoes: 'c', video: 'd' });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  assert.equal(calls[0].body.model, 'gpt-6-luna');

  reply(200, { data: [{ id: 'gpt-6-luna' }, { id: 'gpt-image-2' }] });
  const t = await openai.test(cfgOf(openai));
  assert.equal(calls[1].url, 'https://api.openai.com/v1/models');
  assert.match(t.warning, /gpt-image-2\.5-sunburst/, 'avisa quando a chave não enxerga o modelo escolhido');
});

test('OpenAI: raciocínio baixo como "developer", qualidade só até "high" fora do 2.5 e recusa explicada', async () => {
  reply(200, { choices: [{ finish_reason: 'stop', message: { content: '{"a":1}', refusal: null } }] });
  await openai.writeJson(cfgOf(openai), { system: 's', user: 'u' });
  const c = calls[0].body;
  assert.deepEqual([c.reasoning_effort, c.messages[0].role, c.max_completion_tokens], ['low', 'developer', 16000]);
  reply(200, { choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'Não posso ajudar com isso.' } }] });
  await assert.rejects(openai.writeJson(cfgOf(openai), { system: 's', user: 'u' }), /recusou o pedido \(Não posso ajudar com isso\.\)/);
  reply(200, { choices: [{ finish_reason: 'length', message: { content: '{"a":' } }] });
  await assert.rejects(openai.writeJson(cfgOf(openai), { system: 's', user: 'u' }), /cortada pelo limite/);

  reply(200, { data: [{ b64_json: JPG.toString('base64') }] });
  await openai.image({ ...cfgOf(openai, { quality: 'xhigh' }), models: { image: 'gpt-image-2' } }, { prompt: 'x', refs: [ref(1)], aspect: '4:5' });
  assert.equal(calls.at(-1).body.quality, 'high', 'gpt-image-2 não tem "xhigh"');
  reply(200, { data: [{ b64_json: JPG.toString('base64') }] });
  await openai.image(cfgOf(openai, { quality: 'xhigh' }), { prompt: 'x', refs: [ref(1)], aspect: '4:5' });
  assert.equal(calls.at(-1).body.quality, 'xhigh');
});

test('OpenAI: erros viram mensagens claras (chave, créditos, conteúdo bloqueado)', async () => {
  reply(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } });
  await assert.rejects(openai.test(cfgOf(openai)), /chave de API inválida/);
  reply(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } });
  await assert.rejects(openai.image(cfgOf(openai), { prompt: 'x', refs: [ref(1)], aspect: '4:5' }), (e) => /sem créditos/.test(e.message) && !e.retryable, 'crédito: não adianta repetir');
  reply(429, { error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } }, { 'Retry-After': '7' });
  await assert.rejects(openai.image(cfgOf(openai), { prompt: 'x', refs: [ref(1)], aspect: '4:5' }), (e) => e.retryable && e.retryAfter === 7);
  reply(403, { error: { message: 'Country, region, or territory not supported', type: 'request_forbidden', code: 'unsupported_country_region_territory' } });
  await assert.rejects(openai.test(cfgOf(openai)), /não atende a região/);
  reply(400, { error: { type: 'image_generation_user_error', code: 'moderation_blocked', message: 'Your request was rejected by the safety system.' } });
  await assert.rejects(openai.image(cfgOf(openai), { prompt: 'x', refs: [ref(1)], aspect: '4:5' }), (e) => /política de conteúdo/.test(e.message) && !e.retryable);
});

// ===================================================================== Google
const interaction = (status, content, extra = {}) => ({
  id: 'v1_abc/123', object: 'interaction', status, ...extra,
  steps: content ? [{ type: 'thought', content: [{ type: 'thought', text: '…' }] }, { type: 'model_output', content }] : [],
});

test('Google: foto com Nano Banana pela Interactions API (imagens inline, 4:5)', async () => {
  reply(200, interaction('completed', [{ type: 'image', mime_type: 'image/jpeg', data: JPG.toString('base64') }]));
  const out = await google.image(cfgOf(google, { imageSize: '2K' }), { prompt: 'influencer segurando', refs: [ref(1), { ...ref(2), buffer: PNG, mime: 'image/png' }], aspect: '4:5' });
  assert.ok(out.buffer.equals(JPG));
  assert.equal(out.mime, 'image/jpeg');
  const c = calls[0];
  assert.equal(c.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(c.headers['x-goog-api-key'], 'chave-xyz');
  assert.equal(c.body.model, 'gemini-nano-banana-2.1');
  assert.deepEqual(c.body.input[0], { type: 'text', text: 'influencer segurando' });
  assert.deepEqual(c.body.input.slice(1).map((x) => [x.type, x.mime_type]), [['image', 'image/jpeg'], ['image', 'image/png']]);
  assert.equal(c.body.input[1].data, JPG.toString('base64'));
  assert.deepEqual(c.body.response_format, { type: 'image', aspect_ratio: '4:5', image_size: '2K' });

  reply(200, interaction('completed', [{ type: 'text', text: 'Não consigo gerar isso.' }]));
  await assert.rejects(google.image(cfgOf(google), { prompt: 'x', refs: [ref(1)], aspect: '4:5' }), /não devolveu imagem/);
});

test('Google: vídeo com Gemini Omni em segundo plano, consulta e download', async () => {
  reply(200, { id: 'v1_abc/123', status: 'in_progress' });
  const { job } = await google.startVideo(cfgOf(google, { resolution: '1080p' }), { prompt: 'fala com CTA', refs: [ref('persona'), ref(1)], seconds: 14, aspect: '9:16' });
  assert.equal(job, 'v1_abc/123');
  const c = calls[0];
  assert.equal(c.body.model, 'gemini-omni-1.1-flash');
  assert.equal(c.body.background, true);
  assert.deepEqual(c.body.response_format, { type: 'video', aspect_ratio: '9:16', resolution: '1080p', duration: '10s' }, 'Omni aceita até 10 s');
  assert.deepEqual(c.body.input.map((x) => x.type), ['image', 'image', 'text'], 'imagens antes do texto, na ordem da legenda');
  assert.equal(c.headers['Api-Revision'], '2026-05-20');

  reply(200, { id: job, status: 'in_progress' });
  assert.deepEqual(await google.checkVideo(cfgOf(google), job), { status: 'running' });
  assert.equal(calls[1].url, 'https://generativelanguage.googleapis.com/v1beta/interactions/v1_abc%2F123');

  const mp4 = Buffer.from('000000206674797069736f6d', 'hex');
  reply(200, interaction('completed', [{ type: 'video', mime_type: 'video/mp4', data: mp4.toString('base64') }]));
  const done = await google.checkVideo(cfgOf(google), job);
  assert.equal(done.status, 'done');
  assert.ok(done.buffer.equals(mp4));
  assert.equal(done.mime, 'video/mp4');

  // Entregue por URI: baixa com a chave, só do domínio do Google.
  reply(200, interaction('completed', [{ type: 'video', mime_type: 'video/mp4', uri: 'https://generativelanguage.googleapis.com/v1beta/files/f1:download?alt=media' }]));
  reply(200, mp4, { 'Content-Type': 'video/mp4' });
  const byUri = await google.checkVideo(cfgOf(google), job);
  assert.ok(byUri.buffer.equals(mp4));
  assert.equal(calls.at(-1).headers['x-goog-api-key'], 'chave-xyz');
  reply(200, interaction('completed', [{ type: 'video', mime_type: 'video/mp4', uri: 'https://evil.test/v.mp4' }]));
  await assert.rejects(google.checkVideo(cfgOf(google), job), /endereço de download inesperado/);

  reply(200, interaction('failed', null, { errors: [{ code: 'safety', message: 'Blocked by safety filters' }] }));
  const failed = await google.checkVideo(cfgOf(google), job);
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /política de conteúdo/);
});

test('Google: sem suporte a segundo plano, gera o vídeo na mesma chamada', async () => {
  reply(400, { error: { code: 'invalid_request', message: 'background is not supported for this model' } });
  const mp4 = Buffer.from('mp4!');
  reply(200, interaction('completed', [{ type: 'video', mime_type: 'video/mp4', data: mp4.toString('base64') }]));
  const out = await google.startVideo(cfgOf(google), { prompt: 'x', refs: [ref(1)], seconds: 8, aspect: '9:16' });
  assert.ok(out.buffer.equals(mp4));
  assert.equal(calls[1].body.background, undefined);
});

test('Google: roteiro em JSON e teste da chave', async () => {
  reply(200, interaction('completed', [{ type: 'text', text: '{"uso":"a","posse":"b","especificacoes":"c","video":"d"}' }]));
  const out = await google.writeJson(cfgOf(google), { system: 'sys', user: '{"x":1}' });
  assert.equal(out.video, 'd');
  assert.deepEqual([calls[0].body.model, calls[0].body.system_instruction, calls[0].body.input], ['gemini-3.6-flash', 'sys', '{"x":1}']);
  assert.deepEqual(calls[0].body.response_format, { type: 'text', mime_type: 'application/json' });

  reply(200, { models: [{ name: 'models/gemini-nano-banana-2.1' }, { name: 'models/gemini-omni-1.1-flash' }, { name: 'models/gemini-3.6-flash' }] });
  const t = await google.test(cfgOf(google));
  assert.equal(t.warning, undefined);
  reply(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } });
  await assert.rejects(google.test(cfgOf(google)), /chave de API inválida/);
  reply(402, { error: { code: 'payment_required', message: 'Prepaid credits exhausted' } });
  await assert.rejects(google.image(cfgOf(google), { prompt: 'x', refs: [ref(1)], aspect: '4:5' }), /sem créditos/);
});

// ======================================================================== xAI
test('xAI: foto com Grok Imagine (várias referências com etiquetas, 3:4) e erro de chave', async () => {
  reply(200, { data: [{ b64_json: JPG.toString('base64'), mime_type: 'image/jpeg' }] });
  const out = await xai.image(cfgOf(xai), { prompt: 'influencer segurando', refs: [ref('persona'), ref(1), ref(2)], persona: true, aspect: '4:5' });
  assert.ok(out.buffer.equals(JPG));
  const c = calls[0];
  assert.equal(c.url, 'https://api.x.ai/v1/images/edits');
  assert.equal(c.headers.Authorization, 'Bearer chave-xyz');
  assert.equal(c.body.model, 'grok-imagine-image-2.0');
  assert.equal(c.body.aspect_ratio, '3:4', 'sem 4:5 no Grok: o mais próximo');
  assert.equal(c.body.response_format, 'b64_json');
  assert.equal(c.body.images.length, 3);
  assert.match(c.body.images[0].url, /^data:image\/jpeg;base64,/);
  assert.match(c.body.prompt, /<IMAGE_0> = o\(a\) influencer; <IMAGE_1> = foto do produto; <IMAGE_2> = foto do produto/);

  reply(400, { code: 'invalid-argument', error: 'Incorrect API key provided. You can obtain an API key from https://console.x.ai.' });
  await assert.rejects(xai.test(cfgOf(xai)), /chave de API inválida/);
});

test('xAI: vídeo por referência (pessoa + produto), consulta e download', async () => {
  reply(200, { request_id: 'req-1' });
  const { job } = await xai.startVideo(cfgOf(xai), { prompt: 'fala com CTA', refs: [ref('persona'), ref(1)], persona: true, seconds: 20, aspect: '9:16' });
  assert.equal(job, 'req-1');
  const c = calls[0];
  assert.equal(c.url, 'https://api.x.ai/v1/videos/generations');
  assert.deepEqual([c.body.model, c.body.duration, c.body.aspect_ratio, c.body.resolution], ['grok-imagine-video-1.5', 15, '9:16', '720p']);
  assert.equal(c.body.reference_images.length, 2);
  assert.equal(c.body.image, undefined, 'referência, não primeiro quadro');

  reply(200, { status: 'pending', progress: 40 });
  assert.deepEqual(await xai.checkVideo(cfgOf(xai), job), { status: 'running' });
  const mp4 = Buffer.from('mp4-grok');
  reply(200, { status: 'done', video: { url: 'https://vidgen.x.ai/abc/video.mp4', duration: 15, respect_moderation: true } });
  reply(200, mp4, { 'Content-Type': 'video/mp4' });
  const done = await xai.checkVideo(cfgOf(xai), job);
  assert.equal(done.status, 'done');
  assert.ok(done.buffer.equals(mp4));
  assert.equal(calls.at(-1).url, 'https://vidgen.x.ai/abc/video.mp4');

  reply(200, { status: 'done', video: { url: '', respect_moderation: false } });
  assert.match((await xai.checkVideo(cfgOf(xai), job)).error, /política de conteúdo/);
  reply(200, { status: 'failed', error: { code: 'internal_error', message: 'Engine error' } });
  assert.deepEqual(await xai.checkVideo(cfgOf(xai), job), { status: 'error', error: 'xAI: Engine error' });
});

test('xAI: roteiro pelo chat (JSON no texto)', async () => {
  reply(200, { choices: [{ message: { content: 'Aqui está: {"uso":"a","posse":"b","especificacoes":"c","video":"d"}' } }] });
  const out = await xai.writeJson(cfgOf(xai), { system: 's', user: 'u' });
  assert.equal(out.posse, 'b');
  assert.deepEqual([calls[0].url, calls[0].body.model], ['https://api.x.ai/v1/chat/completions', 'grok-4.3']);
});

// =================================================================== DeepSeek
test('DeepSeek: JSON sem raciocínio, nova tentativa quando volta vazio, saldo e erros', async () => {
  reply(200, { choices: [{ finish_reason: 'stop', message: { content: '' } }] });
  reply(200, { choices: [{ finish_reason: 'stop', message: { content: '{"ofertas":[{"i":0,"mesmo":true}]}' } }] });
  const out = await deepseek.writeJson(cfgOf(deepseek), { system: 'Confira as ofertas', user: '{"x":1}' });
  assert.deepEqual(out, { ofertas: [{ i: 0, mesmo: true }] });
  assert.equal(calls.length, 2, 'repete uma vez quando o modo JSON volta vazio');
  const c = calls[0];
  assert.equal(c.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(c.headers.Authorization, 'Bearer chave-xyz');
  assert.deepEqual([c.body.model, c.body.thinking, c.body.response_format], ['deepseek-flash', { type: 'disabled' }, { type: 'json_object' }]);
  assert.match(c.body.messages[0].content, /json/, 'o modo JSON exige a palavra "json" no prompt');
  assert.equal(deepseek.image, undefined, 'DeepSeek não gera imagem');
  assert.equal(deepseek.startVideo, undefined, 'nem vídeo');

  reply(200, { choices: [{ finish_reason: 'length', message: { content: '{"ofertas":[' } }] });
  await assert.rejects(deepseek.writeJson(cfgOf(deepseek), { system: 's', user: 'u' }), /cortada/);

  reply(200, { is_available: false, balance_infos: [{ currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' }] });
  const t = await deepseek.test(cfgOf(deepseek));
  assert.equal(calls.at(-1).url, 'https://api.deepseek.com/user/balance');
  assert.deepEqual([t.account, /sem saldo/.test(t.warning)], ['saldo 0.00 USD', true]);
  reply(401, 'Authentication Fails (governor)');
  await assert.rejects(deepseek.test(cfgOf(deepseek)), /chave de API inválida/);
  reply(402, { error: { message: 'Insufficient Balance', type: 'unknown_error', code: 'invalid_request_error' } });
  await assert.rejects(deepseek.writeJson(cfgOf(deepseek), { system: 's', user: 'u' }), /sem créditos/);
});

// ================================================================= OpenRouter
test('OpenRouter: roteiro com Llama 3 pelo fornecedor mais barato e teste da chave', async () => {
  reply(200, { choices: [{ message: { content: '{"uso":"a","posse":"b","especificacoes":"c","video":"d"}' } }] });
  const out = await openrouter.writeJson(cfgOf(openrouter), { system: 's', user: 'u' });
  assert.equal(out.uso, 'a');
  const c = calls[0];
  assert.equal(c.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(c.headers.Authorization, 'Bearer chave-xyz');
  assert.equal(c.body.model, 'meta-llama/llama-3.3-70b-instruct');
  assert.deepEqual([c.body.response_format, c.body.provider], [{ type: 'json_object' }, { sort: 'price' }]);
  assert.ok(openrouter.recommended.text.includes('meta-llama/llama-3.1-8b-instruct') && openrouter.recommended.text.some((m) => m.startsWith('qwen/')), 'Llama 3 e Qwen pequeno recomendados');
  assert.deepEqual(c.body.plugins, [{ id: 'response-healing' }]);
  // Falha do modelo com HTTP 200 (corpo só com "error").
  reply(200, { error: { code: 502, message: 'Provider returned error' } });
  await assert.rejects(openrouter.writeJson(cfgOf(openrouter), { system: 's', user: 'u' }), (e) => /Provider returned error/.test(e.message) && e.retryable);
  calls.length = 1;

  reply(200, { data: { label: 'azurehub', limit: 10, limit_remaining: 7.5, usage: 2.5, is_free_tier: false } });
  const t = await openrouter.test(cfgOf(openrouter, { sort: 'latency' }));
  assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/key');
  assert.equal(t.account, 'azurehub · crédito restante US$ 7.50');
  reply(402, { error: { code: 402, message: 'Insufficient credits. Add more using https://openrouter.ai/credits' } });
  await assert.rejects(openrouter.writeJson(cfgOf(openrouter), { system: 's', user: 'u' }), /sem créditos/);
});

test('OpenRouter: fotos pela rota de imagens com referências (data URL), no limite de cada modelo', async () => {
  openrouter._resetVideoModels();
  reply(200, { id: 'google/gemini-nano-banana-2.1', endpoints: [{ supported_parameters: { aspect_ratio: { type: 'enum', values: ['1:1', '3:4', '4:5', '9:16'] }, input_references: { type: 'range', min: 0, max: 14 } } }] });
  reply(200, { created: 1, data: [{ b64_json: JPG.toString('base64'), media_type: 'image/jpeg' }] });
  const out = await openrouter.image(cfgOf(openrouter), { prompt: 'influencer usando', refs: [ref('persona'), ref(1)], aspect: '4:5' });
  assert.ok(out.buffer.equals(JPG));
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/images/models/google/gemini-nano-banana-2.1/endpoints');
  const c = calls[1];
  assert.equal(c.url, 'https://openrouter.ai/api/v1/images');
  assert.deepEqual([c.body.model, c.body.aspect_ratio, c.body.n], ['google/gemini-nano-banana-2.1', '4:5', 1]);
  assert.equal(c.body.input_references.length, 2);
  assert.equal(c.body.input_references[0].type, 'image_url');
  assert.match(c.body.input_references[0].image_url.url, /^data:image\/jpeg;base64,/);

  // Grok Imagine: até 3 referências e sem 4:5 → 3:4.
  const grok = { ...cfgOf(openrouter), models: { image: 'x-ai/grok-imagine-image-2.0' } };
  reply(200, { id: 'x-ai/grok-imagine-image-2.0', endpoints: [{ supported_parameters: { aspect_ratio: { type: 'enum', values: ['1:1', '3:4', '4:3', '9:16', '16:9', 'auto'] }, input_references: { type: 'range', min: 0, max: 3 } } }] });
  reply(200, { created: 1, data: [{ b64_json: JPG.toString('base64') }] });
  await openrouter.image(grok, { prompt: 'x', refs: [ref('persona'), ref(1), ref(2), ref(3)], aspect: '4:5' });
  const g = calls.at(-1).body;
  assert.deepEqual([g.input_references.length, g.aspect_ratio], [3, '3:4']);
});

test('OpenRouter: vídeo com duração ajustada ao modelo, consulta e download só do OpenRouter', async () => {
  reply(200, { data: [{ id: 'google/veo-3.1-fast', supported_durations: [4, 6, 8], supported_aspect_ratios: ['16:9', '9:16'] }] });
  reply(200, { id: 'gen-vid-1-abcdefghijklmnopqrst', polling_url: 'https://openrouter.ai/api/v1/videos/gen-vid-1-abcdefghijklmnopqrst', status: 'pending' });
  const cfg = { ...cfgOf(openrouter), models: { video: 'google/veo-3.1-fast' } };
  const { job } = await openrouter.startVideo(cfg, { prompt: 'fala com CTA', refs: [ref('persona'), ref(1)], seconds: 7, aspect: '9:16' });
  assert.equal(job, 'gen-vid-1-abcdefghijklmnopqrst');
  const c = calls[1];
  assert.equal(c.url, 'https://openrouter.ai/api/v1/videos');
  assert.deepEqual([c.body.duration, c.body.aspect_ratio, c.body.resolution, c.body.generate_audio], [6, '9:16', '720p', true], '7 s → 6 s (a mais próxima aceita)');
  assert.equal(c.body.input_references.length, 2);
  assert.match(c.body.input_references[0].image_url.url, /^https:\/\/site\.test\//, 'foto do produto vai pela URL pública');

  reply(200, { id: job, status: 'in_progress', polling_url: 'x' });
  assert.deepEqual(await openrouter.checkVideo(cfg, job), { status: 'running' });
  const mp4 = Buffer.from('mp4-or');
  reply(200, { id: job, status: 'completed', polling_url: 'x', unsigned_urls: [`https://openrouter.ai/api/v1/videos/${job}/content?index=0`] });
  reply(200, mp4, { 'Content-Type': 'video/mp4' });
  const done = await openrouter.checkVideo(cfg, job);
  assert.ok(done.buffer.equals(mp4));
  assert.equal(calls.at(-1).headers.Authorization, 'Bearer chave-xyz', 'o link de download não é assinado: vai com a chave');
  reply(200, { id: job, status: 'completed', polling_url: 'x', unsigned_urls: ['https://evil.test/v.mp4'] });
  assert.match((await openrouter.checkVideo(cfg, job)).error, /endereço de download inesperado/);
  reply(200, { id: job, status: 'failed', polling_url: 'x', error: 'Content policy violation' });
  assert.deepEqual(await openrouter.checkVideo(cfg, job), { status: 'error', error: 'OpenRouter: Content policy violation' });

  // Modelo que não faz vertical: erro claro antes de gastar.
  const wide = { ...cfgOf(openrouter), models: { video: 'minimax/hailuo-2.3' } };
  openrouter._resetVideoModels();
  reply(200, { data: [{ id: 'minimax/hailuo-2.3', supported_durations: [6, 10], supported_aspect_ratios: ['16:9'] }] });
  await assert.rejects(openrouter.startVideo(wide, { prompt: 'x', refs: [ref(1)], seconds: 8, aspect: '9:16' }), /não gera vídeo 9:16/);
});

test('tipo real da foto pelos primeiros bytes', () => {
  assert.equal(sniffImage(JPG), 'image/jpeg');
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(Buffer.from('<html><body>404</body></html>')), null);
});
