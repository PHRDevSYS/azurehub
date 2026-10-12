'use strict';
// Auditor de anúncios: revisa, com o modelo escolhido em Agentes de IA, como o
// produto vai subir em cada marketplace (a mesma prévia da tela Prévia) e
// devolve achados com sugestão. Só lê — nada é alterado sozinho. O último
// resultado de cada produto fica salvo para não pagar de novo à toa.
const store = require('../lib/store');
const ai = require('./settings');
const { facts } = require('./facts');
const { previewProducts } = require('../sync/preview');

const PLATFORMS = { mercadolivre: 'Mercado Livre', shopee: 'Shopee', tiktok: 'TikTok Shop' };
const TITLE_MAX = { mercadolivre: 60, shopee: 120, tiktok: 255 };
const SEVERITY = ['alta', 'media', 'baixa'];
const FIELDS = ['título', 'descrição', 'atributos', 'variações', 'fotos', 'vídeo', 'preço', 'estoque', 'frete', 'categoria', 'outros'];

const SYSTEM = `Você é um auditor sênior de anúncios de marketplace no Brasil (Mercado Livre, Shopee e TikTok Shop).
Recebe os dados REAIS de um produto e a prévia de como ele será publicado em cada marketplace (campos, erros e avisos do sistema).
Aponte só problemas CONCRETOS e acionáveis que reduzem conversão, alcance na busca ou aprovação do anúncio:
título fraco, cortado ou sem palavras-chave de busca (marca, modelo, tipo, característica principal); descrição curta, confusa ou com informação
de contato/links; atributos importantes faltando ou inconsistentes com o título; variações confusas; poucas fotos; preço/promoção estranhos;
estoque zerado; peso/dimensões ausentes para o frete; termos proibidos ("réplica", "original" sem ser, promessas de saúde, menção a outro marketplace).
Regras: use apenas os dados recebidos (não invente especificações); não repita literalmente os erros/avisos do sistema, a menos que traga a correção;
escreva em português do Brasil, direto. Sugira um título otimizado por marketplace respeitando o limite de caracteres informado.
Responda somente com JSON neste formato:
{"nota": 0-10, "resumo": "1 a 2 frases",
 "achados": [{"gravidade": "alta|media|baixa", "plataforma": "todas|mercadolivre|shopee|tiktok", "campo": "título|descrição|atributos|variações|fotos|vídeo|preço|estoque|frete|categoria|outros", "problema": "...", "sugestao": "..."}],
 "titulos": {"mercadolivre": "...", "shopee": "...", "tiktok": "..."}}`;

const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// O que o modelo devolveu → formato fixo e seguro para a tela.
function normalize(out, platforms) {
  const nota = Math.max(0, Math.min(10, Math.round(Number(out.nota))));
  const findings = (Array.isArray(out.achados) ? out.achados : []).map((a) => ({
    severity: SEVERITY.includes(a.gravidade) ? a.gravidade : 'media',
    platform: platforms.includes(a.plataforma) ? a.plataforma : 'todas',
    field: FIELDS.includes(a.campo) ? a.campo : 'outros',
    problem: str(a.problema, 400),
    suggestion: str(a.sugestao, 600),
  })).filter((a) => a.problem).slice(0, 30)
    .sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity));
  const titles = {};
  for (const id of platforms) {
    const t = str((out.titulos || {})[id], TITLE_MAX[id]);
    if (t) titles[id] = t;
  }
  return { score: Number.isFinite(nota) ? nota : null, summary: str(out.resumo, 500), findings, titles };
}

async function audit(sku, requested) {
  const { provider, cfg, model } = ai.resolve('auditor', 'text');
  const platforms = (requested.length ? requested : Object.keys(PLATFORMS)).filter((id) => PLATFORMS[id]);
  if (!platforms.length) throw new Error('Escolha ao menos um marketplace para auditar');
  const prod = store.getProduct(sku);
  const { items: [pv] } = await previewProducts([sku], platforms);
  const brief = {
    produto: {
      ...facts(prod.data, { descriptionMax: 3000 }),
      sku, gtin: prod.data.gtin || null, preco: prod.data.price, preco_promocional: prod.data.promoPrice || null,
      estoque: prod.data.stock, fotos: (prod.data.images || []).length, videos: (prod.data.videos || []).length,
      variacoes: (prod.data.variants || []).length,
    },
    marketplaces: Object.fromEntries(platforms.map((id) => {
      const p = pv.platforms[id] || {};
      return [id, {
        nome: PLATFORMS[id], limite_titulo: TITLE_MAX[id], acao: p.action,
        campos: (p.fields || []).map((f) => `${f.label}: ${f.value}${f.note ? ` (${f.note})` : ''}`),
        erros: p.errors || [], avisos: p.warnings || [],
      }];
    })),
  };
  const out = await provider.writeJson(cfg, { system: SYSTEM, user: JSON.stringify(brief, null, 1) });
  const result = { ...normalize(out || {}, platforms), platforms, provider: provider.id, model };
  store.saveAudit(sku, result);
  store.log('info', `Auditor de anúncios: ${result.findings.length} achado(s), nota ${result.score ?? '—'}`, { sku });
  return { ...result, createdAt: new Date().toISOString() };
}

module.exports = { audit, normalize, SYSTEM, PLATFORMS };
