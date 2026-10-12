'use strict';
// DeepSeek: modelo de texto barato para os agentes (roteiro UGC, precificação,
// auditor, CRM). A API da DeepSeek não gera imagem nem vídeo — para as mídias
// UGC, combine com outro provedor nas funções de foto/vídeo.
// Docs: https://api-docs.deepseek.com/api/create-chat-completion
//       https://api-docs.deepseek.com/guides/json_mode
const { AiError, request, parseJsonText } = require('./http');

const BASE = 'https://api.deepseek.com';
const NAME = 'DeepSeek';

const headers = (cfg) => ({ Authorization: `Bearer ${cfg.apiKey}` });

async function chat(cfg, { system, user }) {
  // O modo JSON exige a palavra "json" no prompt; o raciocínio (thinking,
  // ligado por padrão) só encareceria e atrasaria uma resposta curta.
  const data = await request(NAME, `${BASE}/chat/completions`, {
    method: 'POST', headers: headers(cfg), timeoutMs: 180000,
    json: {
      model: cfg.models.text,
      thinking: { type: cfg.extra.thinking === 'enabled' ? 'enabled' : 'disabled' },
      response_format: { type: 'json_object' },
      max_tokens: 8000,
      messages: [{ role: 'system', content: `${system}\n\nResponda em json.` }, { role: 'user', content: user }],
    },
  });
  const choice = (data.choices || [])[0] || {};
  if (choice.finish_reason === 'length') throw new AiError(`${NAME}: a resposta foi cortada pelo limite de tokens`);
  if (choice.finish_reason === 'content_filter') throw new AiError(`${NAME}: o pedido foi bloqueado pela política de conteúdo — ajuste os dados`);
  if (['insufficient_system_resource', 'aborted'].includes(choice.finish_reason)) throw new AiError(`${NAME}: servidor sobrecarregado; tente de novo`, { retryable: true });
  return choice.message && choice.message.content;
}

module.exports = {
  id: 'deepseek',
  name: 'DeepSeek',
  docsUrl: 'https://platform.deepseek.com/api_keys',
  note: 'Texto muito barato para roteiro, precificação e auditor. Não gera imagem nem vídeo.',
  models: { text: ['deepseek-flash', 'deepseek-v4-pro'] },
  recommended: { text: ['deepseek-flash'] },
  defaults: { text: 'deepseek-flash' },
  fields: [
    { key: 'thinking', label: 'Raciocínio (thinking)', type: 'select', help: 'Desligado é mais rápido e barato para estas tarefas',
      options: [['disabled', 'Desligado (recomendado)'], ['enabled', 'Ligado']] },
  ],

  // Saldo da conta (não consome tokens).
  async test(cfg) {
    const data = await request(NAME, `${BASE}/user/balance`, { headers: headers(cfg), timeoutMs: 20000 });
    const bal = (data.balance_infos || []).map((b) => `${b.total_balance} ${b.currency}`).join(' + ');
    return {
      account: bal ? `saldo ${bal}` : 'chave válida',
      warning: data.is_available === false ? 'sem saldo: recarregue a conta DeepSeek para usar a API' : undefined,
    };
  },

  async writeJson(cfg, input) {
    let content = await chat(cfg, input);
    // A doc avisa que o modo JSON às vezes volta vazio: uma nova tentativa.
    if (!String(content || '').trim()) content = await chat(cfg, input);
    if (!String(content || '').trim()) throw new AiError(`${NAME}: o modelo respondeu vazio`);
    return parseJsonText(content);
  },
};
