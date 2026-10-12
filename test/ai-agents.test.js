'use strict';
// Agentes de IA: migração da configuração antiga da mídia UGC, agente de
// Precificação (confere as ofertas) e Auditor de anúncios, com um provedor
// de IA simulado.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurehub-ai-'));
process.env.HUB_DATA_DIR = dir;
process.env.HUB_SECRET = 'teste';

const { createServer } = require('../src/server');
const store = require('../src/lib/store');
const providers = require('../src/ai/providers');
const ai = require('../src/ai/settings');
const auditor = require('../src/ai/auditor');
const research = require('../src/pricing/research');
const pricing = require('../src/pricing');

let server;
let base;
let cookie = '';
const seen = [];
let reply = null; // (system, brief) → objeto que o "modelo" devolve

providers.register({
  id: 'fk', name: 'IA Teste', docsUrl: 'https://fk.test', note: 'teste',
  models: { text: ['t1', 't2'], image: ['i1'], video: ['v1'] }, recommended: { text: ['t1'] },
  defaults: { text: 't1', image: 'i1', video: 'v1' },
  fields: [{ key: 'q', label: 'Qualidade' }],
  async test() { return {}; },
  async writeJson(cfg, { system, user }) {
    const brief = JSON.parse(user);
    seen.push({ model: cfg.models.text, system, brief });
    return reply(system, brief);
  },
  async image() { return {}; },
  async startVideo() { return { job: 'x' }; },
  async checkVideo() { return { status: 'running' }; },
});

async function call(method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, body: await res.json() };
}

test.before(async () => {
  store.open();
  // Configuração da versão anterior (só mídia UGC), antes de qualquer acesso à IA.
  store.setSetting('ugc', { image: 'fk', video: 'fk', models: { fk: { text: 't2', image: 'i1', video: '' } }, extra: { fk: { q: 'alta' } }, videoSeconds: 10 });
  store.setSecretSetting('ugc_key_fk', 'chave-antiga-1234');
  server = createServer();
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await call('POST', '/api/install', { email: 'adm@x.com', password: '12345678', source: { type: 'api' } });
  await fetch(`${base}/api/v1/products`, { method: 'POST', headers: { 'X-Api-Key': r.body.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({
    sku: 'GAR', title: 'Garrafa Térmica Inox 1L Stanley', brand: 'Stanley', price: 189.9, stock: 4, gtin: '7891234567895',
    description: '<p>Mantém a bebida gelada por <b>24 horas</b>.</p>', attributes: { Material: 'Aço inox', Capacidade: '1 L' },
    images: ['https://site.test/g1.jpg'],
  }) });
});

test.after(() => {
  server.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ================================================================= migração
test('migra a configuração antiga da mídia UGC para os Agentes de IA', () => {
  const s = ai.summary();
  const fk = s.providers.find((p) => p.id === 'fk');
  assert.deepEqual([fk.connected, fk.key, fk.extra.q], [true, '••••1234', 'alta']);
  assert.deepEqual(fk.recommended, { text: ['t1'] });
  const midia = s.agents.find((a) => a.id === 'midia');
  const slot = (k) => midia.slots.find((x) => x.key === k);
  assert.deepEqual([slot('image').provider, slot('image').model, slot('video').model, slot('text').model, midia.values.videoSeconds], ['fk', 'i1', 'v1', 't2', 10]);
  for (const id of ['precificacao', 'auditor', 'crm']) {
    assert.ok(s.agents.find((a) => a.id === id).slots.every((x) => x.provider === null), `${id} começa sem modelo`);
  }
  assert.equal(s.agents.find((a) => a.id === 'crm').status, 'em breve');
});

// ============================================================ precificação
const OFFERS = [
  { title: 'Garrafa Térmica Inox 1L Stanley', price: 179.9, url: 'https://loja.test/a' },          // igual: certeza, não vai à IA
  { title: 'Garrafa Térmica Stanley Inox 1 Litro Original', price: 175, url: 'https://loja.test/b' }, // igual com título diferente
  { title: 'Garrafa Térmica Inox 500ml Stanley', price: 99.9, url: 'https://loja.test/c' },          // parecida: outro volume
  { title: 'Kit 2 Garrafas Térmicas Inox 1L Stanley', price: 320, url: 'https://loja.test/d' },      // kit
  { title: 'Cadeira de praia dobrável', price: 80, url: 'https://loja.test/e' },                      // nada a ver: nem vai à IA
];

async function runResearch() {
  research.SOURCES.teste = { label: 'Teste', fields: [], search: async () => OFFERS.map((o) => ({ ...o })) };
  pricing.saveSettings({ sources: [{ type: 'teste', name: 'Loja Teste' }], minSimilarity: 0.6, cacheHours: 0 });
  return research.researchOne('GAR', pricing.getSettings(), research.makeCtx());
}

test('Precificação sem agente: vale só a similaridade do título', async () => {
  seen.length = 0;
  const r = await runResearch();
  assert.equal(r.agent, null);
  assert.equal(seen.length, 0);
});

test('agente de Precificação confere as ofertas duvidosas: descarta parecidas e recupera iguais', async () => {
  const set = await call('PUT', '/api/ai/agents/precificacao', { slots: { text: { provider: 'fk', model: 't1' } } });
  assert.equal(set.status, 200);
  seen.length = 0;
  reply = (system, brief) => ({ ofertas: brief.ofertas.map((o) => ({ i: o.i, mesmo: /1 Litro/.test(o.titulo), motivo: /500/.test(o.titulo) ? 'outro volume (500 ml)' : 'outro item' })) });
  const r = await runResearch();
  const sent = seen[0].brief;
  assert.match(seen[0].system, /EXATAMENTE o mesmo produto/);
  assert.equal(sent.produto.title, 'Garrafa Térmica Inox 1L Stanley');
  assert.equal(sent.produto.gtin, '7891234567895');
  assert.ok(!sent.ofertas.some((o) => o.titulo === OFFERS[0].title), 'título idêntico (100%) não precisa da IA');
  assert.ok(!sent.ofertas.some((o) => /Cadeira/.test(o.titulo)), 'muito diferente nem vai à IA');
  const by = Object.fromEntries(r.offers.map((o) => [o.url, o]));
  assert.equal(by['https://loja.test/a'].accepted, true);
  assert.equal(by['https://loja.test/b'].accepted, true, 'recuperada pela IA');
  assert.equal(by['https://loja.test/b'].ai.same, true);
  assert.equal(by['https://loja.test/c'].accepted, false);
  assert.match(by['https://loja.test/c'].reason, /agente de IA: outro produto \(outro volume \(500 ml\)\)/);
  assert.equal(by['https://loja.test/d'].accepted, false);
  assert.equal(r.agent.model, 't1');
  assert.equal(r.agent.checked, sent.ofertas.length);
  assert.ok(r.agent.rescued >= 1);
  assert.equal(r.stats.count, 2);
});

test('agente de Precificação fora do ar: a pesquisa segue pela similaridade e mostra o erro', async () => {
  reply = () => { throw new Error('modelo indisponível'); };
  const r = await runResearch();
  assert.match(r.agent.error, /modelo indisponível/);
  assert.ok(r.offers.every((o) => !o.ai));
  assert.equal(r.offers.find((o) => o.url === 'https://loja.test/a').accepted, true);
});

// ================================================================== auditor
test('Auditor de anúncios: revisa a prévia de cada marketplace e devolve achados normalizados', async () => {
  let r = await call('POST', '/api/ai/auditor/GAR', { platforms: ['mercadolivre', 'shopee'] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Escolha o modelo de texto para "Modelo do auditor"/);

  await call('PUT', '/api/ai/agents/auditor', { slots: { text: { provider: 'fk' } } });
  seen.length = 0;
  reply = () => ({
    nota: 7.6, resumo: 'Bom anúncio, título pode melhorar.',
    achados: [
      { gravidade: 'baixa', plataforma: 'shopee', campo: 'fotos', problema: 'Só 1 foto', sugestao: 'Use ao menos 5 fotos' },
      { gravidade: 'critica', plataforma: 'amazon', campo: 'título', problema: 'Falta o volume no início', sugestao: 'Comece por "Garrafa Térmica 1L"' },
      { gravidade: 'alta', plataforma: 'todas', campo: 'xyz', problema: '', sugestao: 'vazio é descartado' },
    ],
    titulos: { mercadolivre: 'Garrafa Térmica Stanley Inox 1 Litro Mantém Gelado 24 Horas Original Promoção', shopee: 'Garrafa Térmica Stanley 1L', tiktok: 'não pedido' },
  });
  r = await call('POST', '/api/ai/auditor/GAR', { platforms: ['mercadolivre', 'shopee', 'amazon'] });
  assert.equal(r.status, 200);
  const brief = seen[0].brief;
  assert.deepEqual(Object.keys(brief.marketplaces), ['mercadolivre', 'shopee']);
  assert.equal(brief.marketplaces.mercadolivre.limite_titulo, 60);
  assert.ok(brief.marketplaces.mercadolivre.campos.some((c) => c.startsWith('Título: ')));
  assert.match(brief.produto.description, /gelada por 24 horas/);
  assert.ok(!/<b>/.test(brief.produto.description), 'descrição sem HTML');
  assert.equal(brief.produto.fotos, 1);

  const a = r.body;
  assert.equal(a.score, 8);
  assert.equal(a.findings.length, 2, 'achado sem problema é descartado');
  assert.deepEqual(a.findings[0], { severity: 'media', platform: 'todas', field: 'título', problem: 'Falta o volume no início', suggestion: 'Comece por "Garrafa Térmica 1L"' },
    'gravidade/plataforma desconhecidas viram média/todas; ordena por gravidade');
  assert.equal(a.titles.mercadolivre.length, 60, 'título cortado no limite do marketplace');
  assert.equal(a.titles.tiktok, undefined, 'só os marketplaces auditados');
  assert.equal(a.model, 't1');

  const saved = (await call('GET', '/api/ai/auditor/GAR')).body.audit;
  assert.equal(saved.findings.length, 2);
  assert.ok(saved.createdAt);
  assert.equal((await call('POST', '/api/ai/auditor/NAOEXISTE', {})).status, 404);
});

test('normalize aguenta resposta vazia ou torta do modelo', () => {
  const n = auditor.normalize({}, ['mercadolivre']);
  assert.deepEqual(n, { score: null, summary: '', findings: [], titles: {} });
  assert.equal(auditor.normalize({ nota: 99, achados: 'x' }, []).score, 10);
});
