'use strict';
// Rotas do gerador de mídia UGC (tela Prévia).
const fs = require('node:fs');
const store = require('../lib/store');
const { HttpError, readJson } = require('../lib/http');
const agent = require('../ugc/agent');
const settings = require('../ugc/settings');
const runner = require('../ugc/runner');

const GENDERS = ['feminino', 'masculino'];

function wrap(fn) {
  return async (ctx) => {
    try {
      return await fn(ctx);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, e.message);
    }
  };
}

const view = (r) => ({
  id: r.id, sku: r.sku, kind: r.kind, gender: r.gender, provider: r.provider, model: r.model, prompt: r.prompt,
  status: r.status, error: r.error, mime: r.mime, url: r.file ? `/api/ugc/media/${r.id}` : null, updatedAt: r.updated_at,
});

// As 4 mídias do produto: a versão mais recente de cada, com a última pronta
// junto quando a mais recente ainda não tem arquivo (rascunho, gerando, erro).
function itemsOf(sku) {
  const latest = Object.fromEntries(store.ugcLatest(sku).map((x) => [x.kind, view(x)]));
  const done = Object.fromEntries(store.ugcLastDone(sku).map((x) => [x.kind, view(x)]));
  return agent.KINDS.map((k) => {
    const it = latest[k] || { kind: k, status: 'empty' };
    return it.url || !done[k] ? it : { ...it, previous: done[k] };
  });
}

function productOr404(sku) {
  const prod = store.getProduct(sku);
  if (!prod) throw new HttpError(404, 'Produto não encontrado');
  return prod;
}

function register(r, { requireAdmin }) {
  r.get('/api/ugc/settings', requireAdmin, async () => ({ ...settings.summary(), kinds: agent.KINDS.map((k) => ({ kind: k, label: agent.LABELS[k] })) }));

  r.put('/api/ugc/settings', requireAdmin, wrap(async (ctx) => {
    const input = await readJson(ctx.req);
    const res = settings.save(input);
    store.log('info', `Mídia UGC: modelos de IA atualizados (fotos: ${res.use.image || '—'}, vídeo: ${res.use.video || '—'})`);
    return res;
  }));

  // Testa a chave de um provedor (sem gerar nada pago).
  r.post('/api/ugc/test', requireAdmin, wrap(async (ctx) => {
    const { provider: id } = await readJson(ctx.req);
    const { provider, cfg } = settings.active({ id: id || settings.get().image || settings.get().video });
    return { ok: true, provider: provider.id, ...(await provider.test(cfg)) };
  }));

  // Estado das 4 mídias do produto (a versão mais recente de cada).
  r.get('/api/ugc/:sku', requireAdmin, async (ctx) => {
    productOr404(ctx.params.sku);
    return { sku: ctx.params.sku, items: itemsOf(ctx.params.sku) };
  });

  // O agente escreve os 4 prompts (rascunhos editáveis na tela).
  r.post('/api/ugc/:sku/plan', requireAdmin, wrap(async (ctx) => {
    const prod = productOr404(ctx.params.sku);
    const { gender } = await readJson(ctx.req);
    if (!GENDERS.includes(gender)) throw new Error('Escolha o gênero do(a) influencer: feminino ou masculino');
    const videoSeconds = settings.get().videoSeconds;
    // Sem modelo de texto conectado, o agente usa os prompts-padrão.
    const { provider, cfg } = settings.writer() || { provider: { name: 'AzureHub' }, cfg: { models: {} } };
    const plan = await agent.planPrompts(provider, cfg, prod.data, gender, { videoSeconds });
    for (const k of agent.KINDS) store.ugcInsert({ sku: prod.sku, kind: k, gender, prompt: plan.prompts[k], status: 'draft' });
    return { by: plan.by, note: plan.note, items: itemsOf(prod.sku) };
  }));

  // Gera uma ou mais mídias com o prompt que estiver na tela.
  r.post('/api/ugc/:sku/generate', requireAdmin, wrap(async (ctx) => {
    const prod = productOr404(ctx.params.sku);
    const { gender, items } = await readJson(ctx.req);
    if (!GENDERS.includes(gender)) throw new Error('Escolha o gênero do(a) influencer: feminino ou masculino');
    const list = (Array.isArray(items) ? items : []).filter((it) => agent.KINDS.includes(it.kind));
    if (!list.length) throw new Error('Nada para gerar');
    for (const it of list) {
      it.prompt = String(it.prompt || '').trim();
      if (it.prompt.length < 20) throw new Error(`Prompt de "${agent.LABELS[it.kind]}" está vazio ou curto demais`);
      if (it.prompt.length > 8000) throw new Error(`Prompt de "${agent.LABELS[it.kind]}" passa de 8000 caracteres`);
    }
    const ids = runner.generate({ sku: prod.sku, gender, items: list });
    store.log('info', `Mídia UGC: ${ids.length} geração(ões) na fila`, { sku: prod.sku });
    return { queued: ids.length, items: itemsOf(prod.sku) };
  }));

  // Arquivo gerado (imagem ou vídeo).
  r.get('/api/ugc/media/:id', requireAdmin, async (ctx) => {
    const item = store.ugcGet(Number(ctx.params.id));
    const file = runner.filePath(item);
    if (!file) throw new HttpError(404, 'Mídia não encontrada');
    const download = ctx.url.searchParams.get('download') === '1';
    ctx.res.writeHead(200, {
      'Content-Type': item.mime || 'application/octet-stream',
      'Content-Length': fs.statSync(file).size,
      'Cache-Control': 'private, max-age=3600',
      ...(download ? { 'Content-Disposition': `attachment; filename="${item.sku.replace(/[^\w.-]+/g, '_')}-${item.kind}-${item.id}.${file.split('.').pop()}"` } : {}),
    });
    await new Promise((ok, bad) => fs.createReadStream(file).on('error', bad).pipe(ctx.res).on('finish', ok));
  });
}

module.exports = { register };
