'use strict';
// Gerador de mídia UGC (tela Prévia): agente, fila, arquivos e rotas, com um
// provedor de IA simulado (os conectores reais têm testes próprios).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurehub-ugc-'));
process.env.HUB_DATA_DIR = dir;
process.env.HUB_SECRET = 'teste';

const { createServer } = require('../src/server');
const store = require('../src/lib/store');
const providers = require('../src/ugc/providers');
const runner = require('../src/ugc/runner');
const agent = require('../src/ugc/agent');
const { normalizeProduct } = require('../src/source/normalize');

const realFetch = global.fetch;
let server;
let base;
let cookie = '';
let apiKey;
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function call(method, url, body) {
  const res = await realFetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const type = res.headers.get('content-type') || '';
  return { status: res.status, type, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

// ------------------------------------------------- provedor simulado
const seen = { text: [], image: [], video: [], checks: 0 };
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const fake = providers.register({
  id: 'fake', name: 'IA Simulada', docsUrl: 'https://fake.test/docs', note: 'teste',
  models: { text: ['txt-1'], image: ['img-1'], video: ['vid-1'] }, defaults: { text: 'txt-1', image: 'img-1', video: 'vid-1' },
  async test(cfg) { return { account: `chave ${cfg.apiKey.slice(-3)}` }; },
  async writeJson(cfg, { system, user }) {
    seen.text.push({ cfg, system, user: JSON.parse(user) });
    if (fake.failText) throw new Error('modelo de texto fora do ar');
    return { uso: 'Prompt do agente: influencer usando a garrafa na academia, produto idêntico às fotos.', posse: 'curto', especificacoes: 'Prompt do agente: arte com especificações reais da garrafa térmica.', video: 'Prompt do agente: vídeo 9:16 com CTA "Corre!" na primeira frase e fala em português.' };
  },
  async image(cfg, { prompt, refs, persona, aspect }) {
    seen.image.push({ model: cfg.models.image, prompt, refs: refs.map((r) => r.url), persona, aspect });
    if (/BLOQUEIA/.test(prompt)) throw new Error('IA Simulada: o pedido foi bloqueado pela política de conteúdo');
    return { buffer: PNG, mime: 'image/png' };
  },
  async startVideo(cfg, { prompt, refs, persona, seconds, aspect }) {
    seen.video.push({ model: cfg.models.video, prompt, refs: refs.map((r) => r.url), persona, seconds, aspect });
    return { job: `job-${seen.video.length}` };
  },
  async checkVideo(cfg, job) {
    seen.checks++;
    return seen.checks % 2 ? { status: 'running' } : { status: 'done', buffer: Buffer.from('mp4data'), mime: 'video/mp4' };
  },
});

// Provedor só de imagem (como a OpenAI hoje): o vídeo precisa vir de outro.
providers.register({
  id: 'soimagem', name: 'Só Imagem', docsUrl: 'https://so.test', models: { image: ['si-1'] }, defaults: { image: 'si-1' },
  async test() { return {}; },
  async image() { return { buffer: PNG, mime: 'image/png' }; },
});

test.before(async () => {
  runner.timing.pollMs = 5;
  global.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname === 'site.test') return new Response(Buffer.alloc(1024, 7), { headers: { 'Content-Type': 'image/jpeg' } });
    return realFetch(url, init);
  };
  server = createServer();
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await call('POST', '/api/install', { email: 'adm@x.com', password: '12345678', source: { type: 'api' } });
  apiKey = r.body.apiKey;
  await realFetch(`${base}/api/v1/products`, { method: 'POST', headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({
    sku: 'GAR', title: 'Garrafa Térmica Inox 1L', brand: 'Stanley', price: 189.9, promoPrice: 169.9, stock: 4,
    description: 'Mantém a bebida gelada por 24 horas. Aço inox resistente a quedas. Tampa à prova de vazamento.',
    attributes: { Material: 'Aço inox', Capacidade: '1 L' },
    images: ['https://site.test/g1.jpg', 'https://site.test/g2.jpg', 'https://site.test/g3.jpg', 'https://site.test/g4.jpg'],
  }) });
});

test.after(() => {
  global.fetch = realFetch;
  server.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function untilDone(sku) {
  for (let i = 0; i < 200; i++) {
    const r = await call('GET', `/api/ugc/${sku}`);
    if (!r.body.items.some((x) => ['queued', 'running'].includes(x.status))) return r.body.items;
    await wait(10);
  }
  throw new Error('geração não terminou');
}

// ===================================================================== agente
test('prompts-padrão: 4 mídias, persona fictícia, produto idêntico às fotos e CTA no início do vídeo', () => {
  const p = normalizeProduct({ sku: 'X', title: 'Garrafa Térmica Inox 1L', brand: 'Stanley', price: 100, promoPrice: 90, stock: 1, images: ['https://site.test/a.jpg'],
    description: 'Mantém gelado por 24 horas. Não vaza na bolsa.', attributes: { Material: 'Aço inox' }, weightKg: 0.5 });
  const fem = agent.templatePrompts(p, 'feminino', { videoSeconds: 8 });
  const masc = agent.templatePrompts(p, 'masculino', { videoSeconds: 12 });
  assert.deepEqual(Object.keys(fem), agent.KINDS);
  for (const k of agent.KINDS) {
    assert.match(fem[k], /IDÊNTICO às fotos de referência/);
    if (k !== 'especificacoes') assert.match(fem[k], /persona fictícia/i);
  }
  assert.match(fem.uso, /influenciadora brasileira/);
  assert.match(masc.uso, /influenciador brasileiro/);
  assert.match(fem.uso, /USANDO o produto/);
  assert.match(fem.posse, /segura o produto/);
  assert.match(fem.especificacoes, /• Material: Aço inox/);
  assert.match(fem.especificacoes, /• Peso: 0,5 kg/);
  assert.match(fem.especificacoes, /Não invente preços/);
  const lines = fem.video.split('\n');
  const cta = lines.findIndex((l) => /^1\. CTA logo no início/.test(l));
  assert.ok(cta > 0 && lines.findIndex((l) => /^2\./.test(l)) > cta, 'CTA é a primeira fala');
  assert.match(fem.video, /preço especial/, 'produto em promoção: CTA fala do preço especial');
  assert.match(masc.video, /12 segundos/);
});

// ===================================================================== fluxo
test('rotas exigem login', async () => {
  const saved = cookie;
  cookie = '';
  for (const [m, u] of [['GET', '/api/ugc/settings'], ['POST', '/api/ugc/GAR/plan'], ['GET', '/api/ugc/media/1']]) {
    assert.equal((await call(m, u, m === 'POST' ? {} : undefined)).status, 401, `${m} ${u}`);
  }
  cookie = saved;
});

test('sem modelo conectado: o roteiro sai dos prompts-padrão e gerar pede a conexão', async () => {
  const s = (await call('GET', '/api/ugc/settings')).body;
  assert.deepEqual(s.use, { image: null, video: null });
  assert.ok(s.providers.some((p) => p.id === 'fake' && !p.connected));
  assert.deepEqual(s.kinds.map((k) => k.kind), agent.KINDS);

  const plan = await call('POST', '/api/ugc/GAR/plan', { gender: 'feminino' });
  assert.equal(plan.status, 200);
  assert.equal(plan.body.by, 'modelo');
  assert.equal(plan.body.items.length, 4);
  assert.ok(plan.body.items.every((x) => x.status === 'draft' && x.prompt.length > 40));

  const gen = await call('POST', '/api/ugc/GAR/generate', { gender: 'feminino', items: [{ kind: 'uso', prompt: plan.body.items[0].prompt }] });
  assert.equal(gen.status, 400);
  assert.match(gen.body.error, /Conecte um modelo de IA de imagem/);
});

test('configura o modelo: chave cifrada e mascarada, modelos e teste de conexão', async () => {
  let r = await call('PUT', '/api/ugc/settings', { provider: 'fake', apiKey: 'sk-segredo-123', models: { image: 'img-2', video: '', text: 'txt-1' }, videoSeconds: 12 });
  assert.equal(r.status, 200);
  const p = r.body.providers.find((x) => x.id === 'fake');
  assert.deepEqual(r.body.use, { image: 'fake', video: 'fake' }, 'o primeiro provedor conectado assume fotos e vídeo');
  assert.deepEqual([p.connected, p.key, p.models.image, p.models.video, r.body.videoSeconds], [true, '••••-123', 'img-2', 'vid-1', 12]);
  const raw = JSON.stringify(store.open().prepare("SELECT value FROM settings WHERE key LIKE 'ugc%'").all());
  assert.ok(!raw.includes('sk-segredo-123'), 'a chave não fica em texto puro no banco');
  // Reenviar a máscara não troca a chave.
  await call('PUT', '/api/ugc/settings', { provider: 'fake', apiKey: '••••-123', models: { image: 'img-2', text: 'txt-1' }, videoSeconds: 12 });
  r = await call('POST', '/api/ugc/test', { provider: 'fake' });
  assert.equal(r.body.account, 'chave 123');
  assert.equal((await call('PUT', '/api/ugc/settings', { provider: 'nada' })).status, 400);
});

test('fotos e vídeo podem vir de provedores diferentes; gerar valida tudo antes de enfileirar', async () => {
  let r = await call('PUT', '/api/ugc/settings', { use: { video: 'soimagem' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Só Imagem não gera vídeos/);
  r = await call('PUT', '/api/ugc/settings', { provider: 'soimagem', apiKey: 'k-soimagem' });
  assert.deepEqual(r.body.use, { image: 'fake', video: 'fake' }, 'conectar outro provedor não troca a escolha feita');
  r = await call('PUT', '/api/ugc/settings', { use: { image: 'soimagem' } });
  assert.deepEqual(r.body.use, { image: 'soimagem', video: 'fake' });
  assert.equal(r.body.providers.find((x) => x.id === 'soimagem').models.video, '', 'sem vídeo, sem modelo de vídeo');
  // Sem modelo de texto no provedor das fotos, o roteiro sai do provedor do vídeo.
  const plan = await call('POST', '/api/ugc/GAR/plan', { gender: 'feminino' });
  assert.equal(plan.body.by, 'agente');

  r = await call('PUT', '/api/ugc/settings', { use: { image: 'fake', video: null } });
  const before = store.ugcHistory('GAR', 1000).length;
  const gen = await call('POST', '/api/ugc/GAR/generate', { gender: 'feminino', items: plan.body.items.map((x) => ({ kind: x.kind, prompt: x.prompt })) });
  assert.equal(gen.status, 400);
  assert.match(gen.body.error, /Conecte um modelo de IA de vídeo/);
  assert.equal(store.ugcHistory('GAR', 1000).length, before, 'nada entra na fila pela metade');

  // Remover a chave tira o provedor do papel que ele ocupava.
  await call('PUT', '/api/ugc/settings', { use: { image: 'soimagem', video: 'fake' } });
  r = await call('PUT', '/api/ugc/settings', { provider: 'soimagem', removeKey: true });
  assert.deepEqual(r.body.use, { image: null, video: 'fake' });
  r = await call('PUT', '/api/ugc/settings', { use: { image: 'fake' } });
  assert.deepEqual(r.body.use, { image: 'fake', video: 'fake' });
});

test('o agente escreve os prompts com o modelo de texto (e cai para o padrão no que vier fraco)', async () => {
  const r = await call('POST', '/api/ugc/GAR/plan', { gender: 'masculino' });
  assert.equal(r.body.by, 'agente');
  assert.match(r.body.note, /txt-1/);
  const byKind = Object.fromEntries(r.body.items.map((x) => [x.kind, x]));
  assert.match(byKind.uso.prompt, /^Prompt do agente/);
  assert.match(byKind.posse.prompt, /influenciador brasileiro/, '"curto" demais: usa o prompt-padrão');
  assert.ok(r.body.items.every((x) => x.gender === 'masculino'));
  const brief = seen.text.at(-1).user;
  assert.equal(brief.genero, 'masculino');
  assert.equal(brief.duracao_video_segundos, 12);
  assert.equal(brief.produto.title, 'Garrafa Térmica Inox 1L');
  assert.match(seen.text.at(-1).system, /CTA forte LOGO NA PRIMEIRA FRASE/);

  fake.failText = true;
  const fb = await call('POST', '/api/ugc/GAR/plan', { gender: 'feminino' });
  fake.failText = false;
  assert.equal(fb.body.by, 'modelo');
  assert.match(fb.body.note, /fora do ar/);
  assert.equal((await call('POST', '/api/ugc/GAR/plan', { gender: 'outro' })).status, 400);
});

test('gera as 4 mídias: fotos com as fotos reais do produto, vídeo assíncrono 9:16, arquivos servidos com login', async () => {
  const drafts = (await call('GET', '/api/ugc/GAR')).body.items;
  const items = drafts.map((x) => ({ kind: x.kind, prompt: x.prompt }));
  const r = await call('POST', '/api/ugc/GAR/generate', { gender: 'feminino', items });
  assert.equal(r.body.queued, 4);
  const done = await untilDone('GAR');
  assert.deepEqual(done.map((x) => [x.kind, x.status]), agent.KINDS.map((k) => [k, 'done']));

  const byKind = Object.fromEntries(done.map((x) => [x.kind, x]));
  const imgs = Object.fromEntries(seen.image.slice(-3).map((x) => [x.prompt.split('\n')[0], x]));
  const sent = (kind) => Object.values(imgs).find((x) => x.prompt.startsWith(byKind[kind].prompt));
  const photos = ['https://site.test/g1.jpg', 'https://site.test/g2.jpg', 'https://site.test/g3.jpg'];
  assert.deepEqual(sent('uso').refs, photos, 'até 3 fotos do produto como referência');
  assert.deepEqual(sent('especificacoes').refs, photos);
  // A foto 1 pronta vira referência da persona na foto 2 e no vídeo (mesma pessoa).
  assert.deepEqual(sent('posse').refs, [`ugc:${byKind.uso.id}`, ...photos]);
  assert.equal(sent('posse').persona, true);
  assert.match(sent('posse').prompt, /a 1ª é o\(a\) influencer/);
  assert.match(sent('uso').prompt, /Imagens anexadas: 3 foto\(s\) real\(is\) do produto/);
  assert.ok(Object.values(imgs).every((x) => x.aspect === '4:5' && x.model === 'img-2'));
  const vid = seen.video.at(-1);
  assert.deepEqual([vid.aspect, vid.seconds, vid.model, vid.refs[0], vid.persona], ['9:16', 12, 'vid-1', `ugc:${byKind.uso.id}`, true]);
  assert.match(vid.prompt, /não como quadro inicial literal/);

  const video = done.find((x) => x.kind === 'video');
  assert.equal(video.mime, 'video/mp4');
  const file = await call('GET', video.url);
  assert.equal(file.type, 'video/mp4');
  assert.equal(file.body.toString(), 'mp4data');
  const photo = await call('GET', done.find((x) => x.kind === 'uso').url);
  assert.equal(photo.type, 'image/png');
  assert.ok(fs.existsSync(path.join(dir, 'ugc', 'GAR')), 'arquivos em data/ugc/<sku>');
  assert.equal((await call('GET', '/api/ugc/media/99999')).status, 404);
});

test('prompt editado regera só aquela mídia; erro do provedor aparece na mídia', async () => {
  const before = Object.fromEntries((await call('GET', '/api/ugc/GAR')).body.items.map((x) => [x.kind, x]));
  let r = await call('POST', '/api/ugc/GAR/generate', { gender: 'feminino', items: [{ kind: 'posse', prompt: 'Novo prompt: influencer segurando a garrafa na praia, produto idêntico às fotos.' }] });
  assert.equal(r.body.queued, 1);
  let now = Object.fromEntries((await untilDone('GAR')).map((x) => [x.kind, x]));
  assert.notEqual(now.posse.id, before.posse.id);
  assert.match(now.posse.prompt, /^Novo prompt/);
  assert.equal(now.posse.status, 'done');
  for (const k of ['uso', 'especificacoes', 'video']) assert.equal(now[k].id, before[k].id, `${k} não muda`);

  r = await call('POST', '/api/ugc/GAR/generate', { gender: 'feminino', items: [{ kind: 'uso', prompt: 'BLOQUEIA este pedido de propósito para testar o erro.' }] });
  now = Object.fromEntries((await untilDone('GAR')).map((x) => [x.kind, x]));
  assert.equal(now.uso.status, 'error');
  assert.match(now.uso.error, /política de conteúdo/);
  assert.equal(now.uso.previous.id, before.uso.id, 'a última versão pronta continua disponível');
  assert.ok(now.uso.previous.url);
  assert.equal(now.posse.previous, undefined, 'mídia pronta não traz a anterior');

  // O modelo gravado no pedido vale, mesmo se a configuração mudar antes de gerar.
  const id = store.ugcInsert({ sku: 'GAR', kind: 'especificacoes', gender: 'feminino', provider: 'fake', model: 'img-antigo', prompt: 'arte do produto com especificações', status: 'queued' });
  await runner.work(id);
  assert.equal(seen.image.at(-1).model, 'img-antigo');

  assert.equal((await call('POST', '/api/ugc/GAR/generate', { gender: 'feminino', items: [{ kind: 'uso', prompt: 'curto' }] })).status, 400);
  assert.equal((await call('POST', '/api/ugc/GAR/generate', { gender: 'feminino', items: [{ kind: 'nada', prompt: 'x'.repeat(30) }] })).status, 400);
  assert.equal((await call('POST', '/api/ugc/NAOEXISTE/plan', { gender: 'feminino' })).status, 404);
});

test('ao reiniciar, vídeo em andamento continua do job salvo (sem gerar de novo)', async () => {
  const startsBefore = seen.video.length;
  const id = store.ugcInsert({ sku: 'GAR', kind: 'video', gender: 'feminino', provider: 'fake', model: 'vid-1', prompt: 'vídeo retomado', status: 'running', job: 'job-antigo' });
  runner.resume();
  await untilDone('GAR');
  const item = store.ugcGet(id);
  assert.equal(item.status, 'done');
  assert.equal(seen.video.length, startsBefore, 'não chamou startVideo de novo');
});
