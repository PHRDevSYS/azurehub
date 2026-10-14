'use strict';
// Agente de mídia UGC: transforma os dados REAIS do produto em 4 briefings
// (prompts) para o modelo de imagem/vídeo escolhido:
//   uso            → influencer usando o produto
//   posse          → influencer segurando / mostrando o produto
//   especificacoes → arte do produto com especificações e vantagens
//   video          → influencer falando do produto, com CTA logo no início
// Com um modelo de texto conectado, o agente atua como diretor criativo de
// UGC e escreve prompts sob medida; sem ele (ou se falhar), usa os modelos
// abaixo. Os prompts são editáveis na tela antes de cada geração.

const KINDS = ['uso', 'posse', 'especificacoes', 'video'];
const LABELS = {
  uso: 'Influencer usando o produto',
  posse: 'Influencer com o produto em mãos',
  especificacoes: 'Produto com especificações e vantagens',
  video: 'Vídeo do influencer falando do produto',
};

const { facts } = require('../ai/facts');

const persona = (gender) => (gender === 'masculino'
  ? { a: 'um influenciador brasileiro', the: 'o influenciador', he: 'Ele' }
  : { a: 'uma influenciadora brasileira', the: 'a influenciadora', he: 'Ela' });

const FIDELITY = 'O produto deve ser IDÊNTICO às fotos de referência anexadas (formato, cor, logotipo, textura, detalhes e proporções). ' +
  'Não invente outro produto, outra marca nem acessórios que não estejam nas fotos.';
const PERSONA_NOTE = 'Persona fictícia criada por IA (não é uma pessoa real), entre 25 e 35 anos, aparência natural, simpática e acessível.';

function sentences(text, n) {
  return String(text || '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 12 && s.length < 160).slice(0, n);
}

// Prompts-padrão (sem modelo de texto): usam só os fatos do produto.
function templatePrompts(p, gender, { videoSeconds = 8 } = {}) {
  const f = facts(p);
  const who = persona(gender);
  const name = [f.title, f.brand && !f.title.toLowerCase().includes(String(f.brand).toLowerCase()) ? `(${f.brand})` : null].filter(Boolean).join(' ');
  const specs = [...f.attributes, f.variants.length ? f.variants.join(' · ') : null, f.dimensions ? `Medidas: ${f.dimensions}` : null, f.weight ? `Peso: ${f.weight}` : null]
    .filter(Boolean).slice(0, 5);
  const perks = sentences(f.description, 3);
  const short = f.title.split(/\s+/).slice(0, 4).join(' ');
  // Frases sem artigo: o nome do produto pode ser masculino ou feminino.
  const cta = f.onSale ? `Olha isso: ${short} com preço especial! Clica e aproveita agora.` : `Para tudo e olha isso: ${short}! Clica e confere agora.`;
  return {
    uso: [
      `Foto vertical 4:5 no estilo UGC (conteúdo de cliente), como se tirada com celular. ${who.a[0].toUpperCase()}${who.a.slice(1)} — ${PERSONA_NOTE}`,
      `${who.he} está USANDO o produto "${name}" numa situação real do dia a dia em que esse produto é usado, de forma natural e espontânea, com expressão de satisfação.`,
      FIDELITY,
      'Luz natural, ambiente realista (casa ou rotina), enquadramento de meio corpo, produto bem visível. Sem texto, sem marca d\'água, sem logotipos extras.',
    ].join('\n'),
    posse: [
      `Foto vertical 4:5 no estilo UGC (selfie ou foto de espelho), ${who.a} — ${PERSONA_NOTE}`,
      `${who.he} segura o produto "${name}" com as mãos e o mostra para a câmera com entusiasmo, como quem acabou de receber a compra. Produto em primeiro plano, nítido e bem iluminado.`,
      FIDELITY,
      'Luz natural, fundo de casa levemente desfocado. Sem texto, sem marca d\'água, sem logotipos extras.',
    ].join('\n'),
    especificacoes: [
      `Arte vertical 4:5 para anúncio de e-commerce do produto "${name}", com o produto em destaque no centro.`,
      FIDELITY,
      'Fundo limpo e moderno, layout organizado com ícones simples. Textos curtos, legíveis e com ortografia correta em português do Brasil:',
      `Título: "${f.title}"`,
      specs.length ? `Especificações:\n${specs.map((s) => `• ${s}`).join('\n')}` : 'Especificações: use apenas o que estiver nas fotos e no título.',
      perks.length ? `Vantagens:\n${perks.map((s) => `• ${s}`).join('\n')}` : null,
      'Não invente preços, selos, certificações nem números que não estejam neste texto.',
    ].filter(Boolean).join('\n'),
    video: [
      `Vídeo vertical 9:16 de ${videoSeconds} segundos, estilo UGC gravado com celular (selfie). ${who.a[0].toUpperCase()}${who.a.slice(1)} — ${PERSONA_NOTE}`,
      `${who.he} fala em português do Brasil, olhando para a câmera, segurando e usando o produto "${name}". ${FIDELITY}`,
      'Fala, nesta ordem (tom animado, natural e convincente):',
      `1. CTA logo no início: "${cta}"`,
      `2. Qualidades: "${perks[0] || `${short}: prático e muito bem acabado.`}"`,
      `3. No dia a dia: "${perks[1] || 'Uso todo dia e faz diferença na minha rotina.'}"`,
      '4. Fecho que gera desejo: "Depois que experimenta, não quer mais ficar sem. Garante já!"',
      'Plano único contínuo, sem cortes de cena, câmera de celular na mão; luz natural, ambiente de casa, o produto sempre visível. Sem legendas, sem música de fundo, sem textos na tela.',
    ].join('\n'),
  };
}

const SYSTEM = `Você é um diretor criativo especialista em conteúdo UGC (user-generated content) para e-commerce no Brasil.
Escreva 4 prompts em português do Brasil para um modelo de geração de imagem/vídeo, a partir APENAS dos fatos do produto recebidos.
Regras obrigatórias:
- A pessoa é uma persona FICTÍCIA criada por IA (nunca uma pessoa real ou famosa), do gênero informado, entre 25 e 35 anos, aparência natural.
- O produto deve aparecer IDÊNTICO às fotos de referência que serão anexadas (repita essa exigência em cada prompt).
- Não invente especificações, números, preços, selos, certificações ou promessas que não estejam nos fatos.
- "uso": foto vertical 4:5 estilo UGC com a pessoa USANDO o produto numa cena realista e específica do uso dele.
- "posse": foto vertical 4:5 estilo UGC com a pessoa segurando/mostrando o produto para a câmera com entusiasmo.
- "especificacoes": arte vertical 4:5 de e-commerce com o produto em destaque e textos curtos em português (título, até 5 especificações e até 3 vantagens tirados dos fatos), ortografia correta.
- "video": vídeo vertical 9:16 com a duração informada, a pessoa falando em português do Brasil para a câmera, em plano único contínuo (sem cortes de cena); inclua o roteiro de fala com um CTA forte LOGO NA PRIMEIRA FRASE, depois qualidades, vantagens no uso diário e um fecho que gere desejo de compra. O roteiro precisa caber na duração (cerca de 2,5 palavras por segundo).
Responda somente com JSON: {"uso": "...", "posse": "...", "especificacoes": "...", "video": "..."}`;

function briefFor(p, gender, videoSeconds) {
  return JSON.stringify({ genero: gender, duracao_video_segundos: videoSeconds, produto: facts(p) }, null, 2);
}

// Legenda das imagens anexadas, acrescentada ao prompt na hora de gerar (a
// ordem das imagens é a mesma): a persona (foto 1 já gerada) primeiro, para o
// mesmo rosto aparecer nas mídias 2 e 4, e depois as fotos reais do produto.
function referenceNote(kind, { persona = false, products = 0 } = {}) {
  const prod = `${products} foto(s) real(is) do produto — reproduza o produto idêntico a elas`;
  const note = persona
    ? `Imagens anexadas, nesta ordem: a 1ª é o(a) influencer (mantenha exatamente o mesmo rosto, cabelo, tom de pele e estilo); as seguintes são ${prod}.`
    : `Imagens anexadas: ${prod}.`;
  return kind === 'video' ? `${note} Use as imagens como referência, não como quadro inicial literal.` : note;
}

// Prompts pelo agente (modelo de texto do provedor) com fallback para os modelos.
async function planPrompts(provider, cfg, p, gender, { videoSeconds = 8, fallback = null } = {}) {
  const base = templatePrompts(p, gender, { videoSeconds });
  if (!provider.writeJson || !cfg.models.text) return { prompts: base, by: 'modelo', note: 'Prompts-padrão do AzureHub (provedor sem modelo de texto)' };
  try {
    const ask = (t) => t.provider.writeJson(t.cfg, { system: SYSTEM, user: briefFor(p, gender, videoSeconds) });
    let out;
    try {
      out = await ask({ provider, cfg });
    } catch (e) {
      if (!fallback) throw e;
      cfg = fallback.cfg; // modelo reserva do roteiro
      out = await ask(fallback);
    }
    const prompts = {};
    for (const k of KINDS) prompts[k] = typeof out[k] === 'string' && out[k].trim().length > 40 ? out[k].trim() : base[k];
    return { prompts, by: 'agente', note: `Roteiro escrito pelo agente (${cfg.models.text})` };
  } catch (e) {
    return { prompts: base, by: 'modelo', note: `Agente indisponível (${e.message}); usados os prompts-padrão` };
  }
}

module.exports = { KINDS, LABELS, facts, templatePrompts, planPrompts, referenceNote, SYSTEM };
