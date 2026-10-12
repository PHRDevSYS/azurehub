'use strict';
// Conectores de IA da mídia UGC: o formato exato das requisições e a leitura
// das respostas de cada provedor, com o fetch simulado (sem chamadas pagas).
const test = require('node:test');
const assert = require('node:assert/strict');

const openai = require('../src/ugc/providers/openai');
const google = require('../src/ugc/providers/google');
const { sniffImage } = require('../src/ugc/providers/http');

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

test('OpenAI: erros viram mensagens claras (chave, créditos, conteúdo bloqueado)', async () => {
  reply(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } });
  await assert.rejects(openai.test(cfgOf(openai)), /chave de API inválida/);
  reply(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } });
  await assert.rejects(openai.image(cfgOf(openai), { prompt: 'x', refs: [ref(1)], aspect: '4:5' }), /sem créditos/);
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

test('tipo real da foto pelos primeiros bytes', () => {
  assert.equal(sniffImage(JPG), 'image/jpeg');
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(Buffer.from('<html><body>404</body></html>')), null);
});
