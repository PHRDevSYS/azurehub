'use strict';
// Tela Agentes de IA: provedores (chaves) e o modelo de cada agente.
const store = require('../lib/store');
const { HttpError, readJson } = require('../lib/http');
const ai = require('../ai/settings');
const auditor = require('../ai/auditor');

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

function register(r, { requireAdmin }) {
  r.get('/api/ai', requireAdmin, async () => ai.summary());

  r.put('/api/ai/providers/:id', requireAdmin, wrap(async (ctx) => {
    const input = await readJson(ctx.req);
    const res = ai.saveProvider(ctx.params.id, input);
    store.log('info', `Agentes de IA: ${input.removeKey ? 'chave removida' : 'conexão salva'} (${ctx.params.id})`);
    return res;
  }));

  // Testa a chave sem gerar nada pago (lista os modelos da conta).
  r.post('/api/ai/providers/:id/test', requireAdmin, wrap(async (ctx) => {
    const { provider, cfg } = ai.connection(ctx.params.id, ai.modelsInUse(ctx.params.id));
    return { ok: true, ...(await provider.test(cfg)) };
  }));

  r.put('/api/ai/agents/:id', requireAdmin, wrap(async (ctx) => {
    const res = ai.saveAgent(ctx.params.id, await readJson(ctx.req));
    store.log('info', `Agentes de IA: modelos do agente "${ctx.params.id}" atualizados`);
    return res;
  }));

  // Auditor de anúncios (tela Prévia): último resultado e nova auditoria.
  r.get('/api/ai/auditor/:sku', requireAdmin, async (ctx) => ({ audit: store.getAudit(ctx.params.sku) }));
  r.post('/api/ai/auditor/:sku', requireAdmin, wrap(async (ctx) => {
    if (!store.getProduct(ctx.params.sku)) throw new HttpError(404, 'Produto não encontrado');
    const { platforms } = await readJson(ctx.req);
    return auditor.audit(ctx.params.sku, Array.isArray(platforms) ? platforms : []);
  }));
}

module.exports = { register };
