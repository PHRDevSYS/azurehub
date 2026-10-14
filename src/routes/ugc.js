'use strict';
// Rotas do gerador de mídia UGC (tela Prévia).
const fs = require('node:fs');
const store = require('../lib/store');
const { HttpError, readJson } = require('../lib/http');
const agent = require('../ugc/agent');
const ai = require('../ai/settings');
const runner = require('../ugc/runner');

const GENDERS = ['feminino', 'masculino'];
const agentKinds = () => agent.KINDS.map((k) => ({ kind: k, label: agent.LABELS[k] }));
const writer = () => ai.resolve('midia', 'text', { optional: true }) || { provider: { name: 'AzureHub' }, cfg: { models: {} }, fallback: null };

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

const validPrompt = (t) => { const n = String(t || '').trim().length; return n >= 20 && n <= 8000; };

function productOr404(sku) {
  const prod = store.getProduct(sku);
  if (!prod) throw new HttpError(404, 'Produto não encontrado');
  return prod;
}

function register(r, { requireAdmin }) {
  // Quem gera cada mídia (configurado em Agentes de IA), para a gaveta.
  r.get('/api/ugc/settings', requireAdmin, async () => {
    const all = ai.summary();
    const midia = all.agents.find((a) => a.id === 'midia');
    const names = Object.fromEntries(all.providers.filter((p) => p.connected).map((p) => [p.id, p.name]));
    const slots = Object.fromEntries(midia.slots.map((s) => [s.key, names[s.provider] ? { provider: s.provider, name: names[s.provider], model: s.model } : null]));
    return { slots, videoSeconds: midia.values.videoSeconds, kinds: agentKinds() };
  });

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
    // Sem modelo de texto escolhido, o agente usa os prompts-padrão.
    const { provider, cfg, fallback } = writer();
    const plan = await agent.planPrompts(provider, cfg, prod.data, gender, { videoSeconds: ai.videoSeconds(), fallback });
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
      if (!validPrompt(it.prompt)) throw new Error(`Prompt de "${agent.LABELS[it.kind]}" ${it.prompt.length < 20 ? 'está vazio ou curto demais' : 'passa de 8000 caracteres'}`);
    }
    const ids = runner.generate({ sku: prod.sku, gender, items: list });
    store.log('info', `Mídia UGC: ${ids.length} geração(ões) na fila`, { sku: prod.sku });
    return { queued: ids.length, items: itemsOf(prod.sku) };
  }));

  // Vários produtos de uma vez (os selecionados na Prévia): usa os prompts que
  // já estão na tela de cada um (mesmo gênero) ou pede o roteiro ao agente, e
  // enfileira as 4 mídias. Roda em segundo plano; a tela acompanha pela fila.
  r.post('/api/ugc/batch', requireAdmin, wrap(async (ctx) => {
    const { skus, gender } = await readJson(ctx.req);
    if (!GENDERS.includes(gender)) throw new Error('Escolha o gênero do(a) influencer: feminino ou masculino');
    const list = [...new Set(Array.isArray(skus) ? skus.map(String) : [])].filter((sku) => store.getProduct(sku));
    if (!list.length) throw new Error('Nenhum produto selecionado');
    if (list.length > 50) throw new Error('No máximo 50 produtos por vez');
    ai.resolve('midia', 'image');
    ai.resolve('midia', 'video');
    (async () => {
      for (const sku of list) {
        try {
          const latest = Object.fromEntries(store.ugcLatest(sku).filter((x) => x.gender === gender && validPrompt(x.prompt)).map((x) => [x.kind, x.prompt.trim()]));
          let prompts = latest;
          if (agent.KINDS.some((k) => !latest[k])) {
            const { provider, cfg, fallback } = writer();
            prompts = { ...(await agent.planPrompts(provider, cfg, store.getProduct(sku).data, gender, { videoSeconds: ai.videoSeconds(), fallback })).prompts, ...latest };
          }
          runner.generate({ sku, gender, items: agent.KINDS.map((kind) => ({ kind, prompt: prompts[kind] })) });
        } catch (e) {
          store.log('error', `Mídia UGC: ${e.message}`, { sku });
        }
      }
    })();
    store.log('info', `Mídia UGC: ${list.length} produto(s) na fila (4 mídias cada)`);
    return { products: list.length, queued: list.length * agent.KINDS.length };
  }));

  // Arquivo gerado (imagem ou vídeo).
  r.get('/api/ugc/media/:id', requireAdmin, async (ctx) => {
    const item = store.ugcGet(Number(ctx.params.id));
    const file = runner.filePath(item);
    if (!file) throw new HttpError(404, 'Mídia não encontrada');
    const download = ctx.url.searchParams.get('download') === '1';
    ctx.res.writeHead(200, {
      'Content-Type': /^(image\/(png|jpeg|webp|gif)|video\/(mp4|quicktime|webm))$/.test(item.mime || '') ? item.mime : 'application/octet-stream',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Length': fs.statSync(file).size,
      'Cache-Control': 'private, max-age=3600',
      ...(download ? { 'Content-Disposition': `attachment; filename="${item.sku.replace(/[^\w.-]+/g, '_')}-${item.kind}-${item.id}.${file.split('.').pop()}"` } : {}),
    });
    await new Promise((ok, bad) => fs.createReadStream(file).on('error', bad).pipe(ctx.res).on('finish', ok));
  });
}

module.exports = { register };
