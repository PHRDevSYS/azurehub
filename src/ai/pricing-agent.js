'use strict';
// Agente de Precificação: depois da busca, o modelo escolhido em Agentes de IA
// confere se cada oferta é mesmo o mesmo produto. A similaridade do título
// erra nos dois sentidos — "Garrafa 1L" × "Garrafa 500 ml" parece igual, e o
// mesmo produto com título bem diferente fica de fora. O agente decide só a
// dúvida: oferta pelo mesmo código de barras ou URL monitorada já é certa.
const ai = require('./settings');
const { facts } = require('./facts');

const MAX = 40;        // ofertas por consulta (as mais parecidas)
const MARGIN = 0.25;   // também confere as que ficaram até 25 pontos abaixo do mínimo

const SYSTEM = `Você confere ofertas de lojas online para a pesquisa de preço de um produto no Brasil.
Para cada oferta, diga se é EXATAMENTE o mesmo produto do cadastro: mesma marca (quando informada), mesmo modelo/linha, mesmo
tamanho/volume/capacidade/potência e mesma quantidade de unidades. Variação só de cor/estampa conta como o mesmo produto quando o
cadastro tem variações de cor. É DIFERENTE: kit ou combo com outros itens, pacote com outra quantidade, refil, peça de reposição,
acessório para o produto, modelo/geração diferente, outro tamanho, produto usado/recondicionado.
Na dúvida, marque como diferente. Responda somente com JSON: {"ofertas": [{"i": 0, "mesmo": true, "motivo": "curto"}]}`;

const needsCheck = (o, min) => o.price > 0 && o.condition !== 'used' && o.score < 1 && o.score >= min - MARGIN;

// Marca as ofertas com o veredito do agente (o.ai = { same, reason }).
// Devolve o resumo para a tela, ou null sem agente configurado.
async function reviewOffers(product, offers, minSimilarity) {
  const conn = ai.resolve('precificacao', 'text', { optional: true });
  if (!conn) return null;
  const list = offers.filter((o) => needsCheck(o, minSimilarity)).sort((a, b) => b.score - a.score).slice(0, MAX);
  const info = { provider: conn.provider.id, model: conn.model, checked: 0, rejected: 0, rescued: 0 };
  if (!list.length) return info;
  const f = facts(product, { descriptionMax: 600 });
  const brief = {
    produto: { ...f, gtin: product.gtin || null, temVariacaoDeCor: (f.variants || []).some((v) => /^cor\b/i.test(v)) },
    ofertas: list.map((o, i) => ({ i, titulo: String(o.title || '').slice(0, 200), preco: o.price, loja: o.seller || o.source || null })),
  };
  try {
    const { value: out, used } = await ai.withFallback(conn, (t) => t.provider.writeJson(t.cfg, { system: SYSTEM, user: JSON.stringify(brief) }));
    info.provider = used.provider.id;
    info.model = used.model;
    for (const v of Array.isArray(out && out.ofertas) ? out.ofertas : []) {
      const o = list[Number(v.i)];
      if (!o || typeof v.mesmo !== 'boolean' || o.ai) continue;
      o.ai = { same: v.mesmo, reason: String(v.motivo || '').replace(/\s+/g, ' ').trim().slice(0, 160) };
      info.checked++;
      if (!v.mesmo && o.score >= minSimilarity) info.rejected++;
      if (v.mesmo && o.score < minSimilarity) info.rescued++;
    }
  } catch (e) {
    info.error = e.message;
  }
  return info;
}

// Aceita pela decisão do agente quando houver; senão, pela similaridade.
const isSame = (o, minSimilarity) => (o.ai ? o.ai.same : o.score >= minSimilarity);

module.exports = { reviewOffers, isSame, SYSTEM };
