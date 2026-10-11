'use strict';
// Origem "API do site": o próprio site/ERP envia os produtos ao hub
// (POST /api/v1/products com X-Api-Key). Não há captura ativa.
module.exports = {
  id: 'api',
  name: 'API própria (push)',
  kind: 'API',
  description: 'Seu site ou ERP envia os produtos para o hub por HTTP, com a chave de API.',
  fields: [],
  push: true,

  async test() {
    return { ok: true, count: 0, sample: [], note: 'O site envia os produtos por POST /api/v1/products (veja a seção API desta tela).' };
  },

  async fetchProducts() {
    return [];
  },
};
