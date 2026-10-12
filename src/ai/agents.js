'use strict';
// Agentes de IA do AzureHub. Cada um tem "funções" (slots) que pedem um tipo
// de modelo — texto, imagem ou vídeo — e o usuário escolhe, na tela Agentes
// de IA, qual provedor e qual modelo executa cada função.
const AGENTS = [
  {
    id: 'midia',
    name: 'Geração de mídia UGC',
    status: 'ativo',
    description: 'Cria, na Prévia, 3 fotos e 1 vídeo com influencer UGC fictício a partir das fotos reais do produto.',
    slots: [
      { key: 'text', kind: 'text', label: 'Roteiro (prompts das 4 mídias)', optional: true, help: 'Sem modelo, usa os prompts-padrão do AzureHub' },
      { key: 'image', kind: 'image', label: 'Fotos (mídias 1 a 3)' },
      { key: 'video', kind: 'video', label: 'Vídeo falado (mídia 4)' },
    ],
    options: [
      { key: 'videoSeconds', label: 'Duração do vídeo (segundos)', type: 'number', min: 3, max: 20, default: 8, help: 'Ajustada ao que o modelo aceita (ex.: Gemini Omni 3–10 s, Grok até 15 s)' },
    ],
  },
  {
    id: 'precificacao',
    name: 'Precificação',
    status: 'ativo',
    description: 'Na pesquisa de mercado, confere se cada oferta encontrada é mesmo o mesmo produto: descarta parecidos (outro tamanho, kit, acessório) e recupera iguais com título diferente.',
    slots: [{ key: 'text', kind: 'text', label: 'Modelo que confere as ofertas', optional: true, help: 'Sem modelo, vale só a similaridade do título' }],
    options: [],
  },
  {
    id: 'auditor',
    name: 'Auditor de anúncios',
    status: 'ativo',
    description: 'Na Prévia, revisa título, descrição, atributos e variações de cada anúncio e aponta problemas e melhorias por marketplace (nada é alterado sozinho).',
    slots: [{ key: 'text', kind: 'text', label: 'Modelo do auditor' }],
    options: [],
  },
  {
    id: 'crm',
    name: 'CRM (atendimento)',
    status: 'em breve',
    description: 'Responder perguntas e mensagens de compradores nos marketplaces. A escolha do modelo já fica salva para quando o agente for liberado.',
    slots: [{ key: 'text', kind: 'text', label: 'Modelo do atendimento' }],
    options: [],
  },
];

const byId = Object.fromEntries(AGENTS.map((a) => [a.id, a]));

module.exports = { AGENTS, get: (id) => byId[id] || null };
