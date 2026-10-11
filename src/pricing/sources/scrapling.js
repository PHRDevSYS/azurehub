'use strict';
// Raspagem por seletores CSS com o Scrapling (Python), para páginas sem
// dados estruturados. O Node valida robots.txt e intervalo por site e chama
// scraper/scrapling_worker.py; o Python só busca e extrai.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { robotsAllows, assertPublicUrl, PriceSourceError, USER_AGENT, timing, lastByHost } = require('../http');
const { parsePrice } = require('../match');

const WORKER = path.join(__dirname, '..', '..', '..', 'scraper', 'scrapling_worker.py');
const runner = {
  // Sobrescrevível nos testes e por PRICE_SCRAPER_CMD (ex.: /opt/venv/bin/python).
  command: () => (process.env.PRICE_SCRAPER_CMD || 'python3').split(' '),
};

function runWorker(input, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = runner.command();
    let child;
    try {
      child = spawn(cmd, [...args, WORKER], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new PriceSourceError(`não consegui iniciar o Python (${e.message})`));
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new PriceSourceError('raspagem excedeu o tempo limite')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new PriceSourceError(`Python indisponível (${e.message}); instale Python 3.10+ e o Scrapling`)); });
    child.on('close', () => {
      clearTimeout(timer);
      let res;
      try { res = JSON.parse(out.trim().split('\n').pop()); } catch {
        reject(new PriceSourceError(`resposta inválida do raspador${err ? `: ${err.slice(-300)}` : ''}`));
        return;
      }
      if (!res.ok) reject(new PriceSourceError(res.error || 'falha no raspador'));
      else resolve(res.items || []);
    });
    child.stdin.end(JSON.stringify(input));
  });
}

module.exports = {
  type: 'scrapling',
  label: 'Site por seletores CSS (Scrapling)',
  description: 'Para páginas sem dados estruturados: você informa os seletores CSS. Requer Python 3.10+ e Scrapling no servidor.',
  fields: [
    { key: 'search_url', label: 'URL de busca', type: 'text', required: true, placeholder: 'https://www.loja.com.br/busca?q={query}' },
    { key: 'item', label: 'Seletor do item', type: 'text', required: true, placeholder: '.product-card' },
    { key: 'title', label: 'Seletor do título', type: 'text', required: true, placeholder: '.product-name::text' },
    { key: 'price', label: 'Seletor do preço', type: 'text', required: true, placeholder: '.price-current::text' },
    { key: 'link', label: 'Seletor do link', type: 'text', placeholder: 'a::attr(href)' },
    { key: 'browser', label: 'Navegador (páginas com JavaScript)', type: 'checkbox', help: 'Usa o DynamicFetcher; exige "scrapling install".' },
  ],
  async search(src, q) {
    if (!/\{query\}/.test(src.search_url || '')) throw new PriceSourceError('a URL de busca precisa conter {query}');
    const url = src.search_url.replace('{query}', encodeURIComponent(q.text));
    // O Python busca a página sozinho: o endereço é conferido aqui antes.
    await assertPublicUrl(url);
    if (src.respect_robots !== false && !(await robotsAllows(url))) throw new PriceSourceError(`bloqueado pelo robots.txt de ${new URL(url).host}`);
    const host = new URL(url).host;
    const wait = (lastByHost.get(host) || 0) + Number(src.interval_ms || 3000) - timing.now();
    if (wait > 0) await timing.sleep(wait);
    lastByHost.set(host, timing.now());
    const items = await runWorker({ url, item: src.item, title: src.title, price: src.price, link: src.link, browser: !!src.browser, user_agent: USER_AGENT });
    return items.map((i) => ({ title: i.title, price: parsePrice(i.price), url: i.url, gtin: null, brand: null, condition: 'new' })).filter((o) => o.price);
  },
  runner,
  runWorker,
};
