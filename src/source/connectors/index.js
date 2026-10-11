'use strict';
// Registro das origens de produtos (ERP / site / banco / API).
const REGISTRY = {
  database: require('./database'),
  api: require('./api'),
  woocommerce: require('./woocommerce'),
  shopify: require('./shopify'),
  nuvemshop: require('./nuvemshop'),
  bling: require('./bling'),
};

function get(id) {
  const c = REGISTRY[id];
  if (!c) throw new Error(`Origem desconhecida: ${id}`);
  return c;
}

module.exports = { REGISTRY, get, ids: () => Object.keys(REGISTRY) };
