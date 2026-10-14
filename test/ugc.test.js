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
const providers = require('../src/ai/providers');
const runner = require('../src/ugc/runner');
const agent = require('../src/ugc/agent');
const { normalizeProduct } = require('../src/source/normalize');
const { AiError } = require('../src/ai/providers/http');

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
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const MP4 = Buffer.concat([Buffer.from('000000186674797069736f6d', 'hex'), Buffer.from('mp4data')]);
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
    if (/HTMLFALSO/.test(prompt)) return { buffer: Buffer.from('<html><script>alert(1)</script></html>'), mime: 'text/html' };
    if (/OCUPADO/.test(prompt) && fake.busy-- > 0) throw new AiError('IA Simulada: limite de uso atingido', { status: 429, retryable: true });
    return { buffer: PNG, mime: 'image/png' };
  },
  async startVideo(cfg, { prompt, refs, persona, seconds, aspect }) {
    seen.video.push({ model: cfg.models.video, prompt, refs: refs.map((r) => r.url), persona, seconds, aspect });
    return { job: `job-${seen.video.length}` };
  },
  async checkVideo(cfg, job) {
    seen.checks++;
    return seen.checks % 2 ? { status: 'running' } : { status: 'done', buffer: MP4, mime: 'video/mp4' };
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
  runner.timing.retryMs = [1, 1];
  global.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname === 'site.test') return new Response(Buffer.alloc(1024, 7), { headers: { 'Content-Type': 'image/jpeg' } });
    if (u.hostname === 'heic.test') return new Response(Buffer.concat([Buffer.from('000000186674797068656963', 'hex'), Buffer.alloc(64)]), { headers: { 'Content-Type': 'image/heic' } });
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
  await realFetch(`${base}/api/v1/products`, { method: 'POST', headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({
    sku: 'COP', title: 'Copo Térmico 500 ml', price: 79.9, stock: 9, description: 'Mantém o café quente por 6 horas.', images: ['https://site.test/c1.jpg'],
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
  for (const [m, u] of [['GET', '/api/ugc/settings'], ['POST', '/api/ugc/GAR/plan'], ['GET', '/api/ugc/media/1'], ['GET', '/api/ai'], ['PUT', '/api/ai/providers/fake'], ['PUT', '/api/ai/agents/midia']]) {
    assert.equal((await call(m, u, m === 'GET' ? undefined : {})).status, 401, `${m} ${u}`);
  }
  cookie = saved;
});

const setAgent = (id, body) => call('PUT', `/api/ai/agents/${id}`, body);
const midia = (r) => r.body.agents.find((a) => a.id === 'midia');
const slot = (r, key) => midia(r).slots.find((s) => s.key === key);

test('sem modelo escolhido: o roteiro sai dos prompts-padrão e gerar pede o modelo', async () => {
  const s = (await call('GET', '/api/ugc/settings')).body;
  assert.deepEqual(s.slots, { text: null, image: null, video: null });
  assert.deepEqual(s.kinds.map((k) => k.kind), agent.KINDS);
  const all = (await call('GET', '/api/ai')).body;
  assert.ok(all.providers.some((p) => p.id === 'fake' && !p.connected));
  assert.deepEqual(all.agents.map((a) => a.id), ['midia', 'precificacao', 'auditor', 'crm']);

  const plan = await call('POST', '/api/ugc/GAR/plan', { gender: 'feminino' });
  assert.equal(plan.status, 200);
  assert.equal(plan.body.by, 'modelo');
  assert.equal(plan.body.items.length, 4);
  assert.ok(plan.body.items.every((x) => x.status === 'draft' && x.prompt.length > 40));

  const gen = await call('POST', '/api/ugc/GAR/generate', { gender: 'feminino', items: [{ kind: 'uso', prompt: plan.body.items[0].prompt }] });
  assert.equal(gen.status, 400);
  assert.match(gen.body.error, /Escolha o modelo de imagem para "Fotos \(mídias 1 a 3\)" em Agentes de IA/);
});

test('Agentes de IA: chave cifrada e mascarada, teste de conexão e modelo por função', async () => {
  let r = await setAgent('midia', { slots: { image: { provider: 'fake' } } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Conecte IA Simulada/, 'sem chave não dá para escolher o provedor');

  r = await call('PUT', '/api/ai/providers/fake', { apiKey: 'sk-segredo-123' });
  assert.equal(r.status, 200);
  const p = r.body.providers.find((x) => x.id === 'fake');
  assert.deepEqual([p.connected, p.key], [true, '••••-123']);
  const raw = JSON.stringify(store.open().prepare("SELECT value FROM settings WHERE key LIKE 'ai%'").all());
  assert.ok(!raw.includes('sk-segredo-123'), 'a chave não fica em texto puro no banco');
  // Reenviar a máscara não troca a chave.
  await call('PUT', '/api/ai/providers/fake', { apiKey: '••••-123' });
  r = await call('POST', '/api/ai/providers/fake/test');
  assert.equal(r.body.account, 'chave 123');
  assert.equal((await call('PUT', '/api/ai/providers/nada', { apiKey: 'x' })).status, 400);

  r = await setAgent('midia', { slots: { image: { provider: 'fake', model: 'img-2' }, video: { provider: 'fake', model: '' }, text: { provider: 'fake', model: 'txt-1' } }, options: { videoSeconds: 12 } });
  assert.equal(r.status, 200);
  assert.deepEqual([slot(r, 'image').model, slot(r, 'video').model, slot(r, 'text').model, midia(r).values.videoSeconds], ['img-2', 'vid-1', 'txt-1', 12],
    'modelo vazio usa o padrão do provedor');
  assert.equal((await setAgent('midia', { options: { videoSeconds: 'x' } })).status, 400);
  assert.equal((await setAgent('nada', {})).status, 400);
  const d = (await call('GET', '/api/ugc/settings')).body;
  assert.deepEqual(d.slots.image, { provider: 'fake', name: 'IA Simulada', model: 'img-2' });
  assert.equal(d.videoSeconds, 12);
});

test('fotos e vídeo podem vir de provedores diferentes; gerar valida tudo antes de enfileirar', async () => {
  await call('PUT', '/api/ai/providers/soimagem', { apiKey: 'k-soimagem' });
  let r = await setAgent('midia', { slots: { video: { provider: 'soimagem' } } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Só Imagem não tem modelo de vídeo/);
  r = await setAgent('midia', { slots: { text: { provider: 'soimagem' } } });
  assert.match(r.body.error, /não tem modelo de texto/);
  r = await setAgent('midia', { slots: { image: { provider: 'soimagem' } } });
  assert.deepEqual([slot(r, 'image').provider, slot(r, 'image').model, slot(r, 'video').provider], ['soimagem', 'si-1', 'fake']);
  const plan = await call('POST', '/api/ugc/GAR/plan', { gender: 'feminino' });
  assert.equal(plan.body.by, 'agente', 'o roteiro tem função própria');

  await setAgent('midia', { slots: { image: { provider: 'fake', model: 'img-2' }, video: { provider: '' } } });
  const before = store.ugcHistory('GAR', 1000).length;
  const gen = await call('POST', '/api/ugc/GAR/generate', { gender: 'feminino', items: plan.body.items.map((x) => ({ kind: x.kind, prompt: x.prompt })) });
  assert.equal(gen.status, 400);
  assert.match(gen.body.error, /Escolha o modelo de vídeo/);
  assert.equal(store.ugcHistory('GAR', 1000).length, before, 'nada entra na fila pela metade');

  // Remover a chave tira o provedor das funções que ele ocupava.
  await setAgent('midia', { slots: { image: { provider: 'soimagem' }, video: { provider: 'fake' } } });
  r = await call('PUT', '/api/ai/providers/soimagem', { removeKey: true });
  assert.deepEqual([slot(r, 'image').provider, slot(r, 'video').provider], [null, 'fake']);
  r = await setAgent('midia', { slots: { image: { provider: 'fake', model: 'img-2' } } });
  assert.equal(slot(r, 'image').model, 'img-2');
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
  assert.ok(file.body.equals(MP4));
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

test('vários produtos de uma vez: usa os prompts editados de cada um e gera os que faltam pelo agente', async () => {
  const edited = 'Prompt editado na tela: influencer usando a garrafa na trilha, produto idêntico às fotos.';
  await call('POST', '/api/ugc/GAR/generate', { gender: 'feminino', items: [{ kind: 'uso', prompt: edited }] });
  await untilDone('GAR');
  const before = seen.image.length;
  const r = await call('POST', '/api/ugc/batch', { skus: ['GAR', 'COP', 'NAOEXISTE', 'COP'], gender: 'feminino' });
  assert.deepEqual(r.body, { products: 2, queued: 8 });
  let items;
  for (let i = 0; i < 300; i++) {
    items = [...(await call('GET', '/api/ugc/GAR')).body.items, ...(await call('GET', '/api/ugc/COP')).body.items];
    if (seen.image.length - before >= 6 && items.every((x) => x.status === 'done')) break;
    await wait(10);
  }
  assert.ok(items.every((x) => x.status === 'done'), JSON.stringify(items.map((x) => [x.sku, x.kind, x.status])));
  const gar = Object.fromEntries(items.filter((x) => x.sku === 'GAR').map((x) => [x.kind, x]));
  assert.equal(gar.uso.prompt, edited, 'mantém o prompt que o usuário editou');
  const cop = items.filter((x) => x.sku === 'COP');
  assert.ok(cop.every((x) => x.prompt.length > 40));
  assert.equal((await call('POST', '/api/ugc/batch', { skus: [], gender: 'feminino' })).status, 400);
});

test('limite de uso do provedor: espera e tenta de novo; foto em formato recusado explica o motivo', async () => {
  fake.busy = 1;
  const before = seen.image.length;
  await call('POST', '/api/ugc/GAR/generate', { gender: 'feminino', items: [{ kind: 'especificacoes', prompt: 'OCUPADO na primeira vez: arte com especificações da garrafa.' }] });
  const now = Object.fromEntries((await untilDone('GAR')).map((x) => [x.kind, x]));
  assert.equal(now.especificacoes.status, 'done');
  assert.equal(seen.image.length - before, 2, 'uma nova tentativa depois do 429');

  await realFetch(`${base}/api/v1/products`, { method: 'POST', headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({
    sku: 'HEIC', title: 'Caneca de cerâmica 350 ml', price: 39.9, stock: 3, images: ['https://heic.test/c1.heic'],
  }) });
  await call('POST', '/api/ugc/HEIC/generate', { gender: 'feminino', items: [{ kind: 'uso', prompt: 'Influencer tomando café na caneca, foto vertical.' }] });
  const heic = Object.fromEntries((await untilDone('HEIC')).map((x) => [x.kind, x]));
  assert.equal(heic.uso.status, 'error');
  assert.match(heic.uso.error, /image\/heic, formato que este modelo não aceita/);
});

test('arquivo devolvido pelo provedor que não é imagem nunca é gravado nem servido como HTML', async () => {
  await call('POST', '/api/ugc/GAR/generate', { gender: 'feminino', items: [{ kind: 'especificacoes', prompt: 'HTMLFALSO: arte com especificações da garrafa térmica.' }] });
  const now = Object.fromEntries((await untilDone('GAR')).map((x) => [x.kind, x]));
  assert.equal(now.especificacoes.status, 'error');
  assert.match(now.especificacoes.error, /não é imagem \(text\/html\)/);
  const media = await call('GET', now.especificacoes.previous.url);
  assert.equal(media.type, 'image/png');
});

test('não enfileira a mesma mídia duas vezes e a persona só espera a foto que entrou antes', async () => {
  const id = store.ugcInsert({ sku: 'COP', kind: 'posse', gender: 'masculino', provider: 'fake', model: 'img-1', prompt: 'x'.repeat(30), status: 'running' });
  const r = await call('POST', '/api/ugc/COP/generate', { gender: 'masculino', items: [{ kind: 'posse', prompt: 'Influencer segurando o copo térmico, foto vertical.' }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /em andamento/);
  store.ugcUpdate(id, { status: 'error', error: 'x' });

  const first = store.ugcInsert({ sku: 'COP', kind: 'uso', gender: 'masculino', provider: 'fake', model: 'img-1', prompt: 'x'.repeat(30), status: 'running' });
  const later = store.ugcInsert({ sku: 'COP', kind: 'uso', gender: 'masculino', provider: 'fake', model: 'img-1', prompt: 'x'.repeat(30), status: 'queued' });
  assert.equal(store.ugcPendingUso('COP', 'masculino', later).id, first, 'a anterior ainda gera: espera');
  assert.equal(store.ugcPendingUso('COP', 'masculino', first), null, 'a mais nova não trava a mais antiga');
  store.ugcUpdate(first, { status: 'error', error: 'x' });
  store.ugcUpdate(later, { status: 'error', error: 'x' });
});
