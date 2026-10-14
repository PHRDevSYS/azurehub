'use strict';
// Teste de navegador do painel (opcional; precisa do Playwright instalado).
// Uso: HUB_DATA_DIR=/tmp/e2e PORT=4871 HUB_SECRET=t npm start   (banco vazio)
//      node tools/e2e-panel.js        # PW_CHROMIUM=/caminho/do/chrome se preciso
// Cobre: troca rápida de telas, busca de produtos, Esc em diálogo, sessão expirada.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, args: ['--no-sandbox'] }).catch(async () => chromium.launch({ args: ['--no-sandbox'] }));
  const page = await b.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message + ' ' + (e.stack||'').split('\n').slice(1,4).join(' / ')));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  const base = 'http://localhost:4871';
  await page.goto(base);
  // instala via API
  const r = await page.evaluate(async () => (await fetch('/api/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.com', password: '12345678', source: { type: 'api' } }) })).json());
  const key = r.apiKey;
  for (let i = 0; i < 30; i++) { const rr = await page.evaluate(async ([k, i]) => (await fetch('/api/v1/products', { method: 'POST', headers: { 'X-Api-Key': k, 'Content-Type': 'application/json' }, body: JSON.stringify({ sku: 'P' + i, title: 'Produto ' + i, price: 10 + i, stock: 5, images: ['https://example.com/a.jpg'] }) })).text(), [key, i]); if (i === 0) console.log('post:', rr.slice(0, 200)); }
  await page.goto(base);
  await page.waitForTimeout(800);
  console.log('após instalar:', (await page.textContent('#app')).slice(0, 80).replace(/\n/g, ' '));
  // troca rápida de telas
  for (const h of ['sincronizacao', 'produtos', 'integracao', 'agentes', 'sincronizacao', 'produtos']) { await page.evaluate((h) => { location.hash = h; }, h); await page.waitForTimeout(40); }
  await page.waitForTimeout(800);
  console.log('tela final:', (await page.textContent('#app')).replace(/\s+/g, ' ').slice(0, 100));
  // busca de produtos
  await page.fill('#q', 'Produto 1').catch(() => {});
  await page.waitForTimeout(800);
  console.log('contagem:', await page.textContent('#count').catch(() => 'sem #count'));
  // Esc no diálogo de credenciais
  await page.evaluate(() => { location.hash = 'integracao'; });
  await page.waitForTimeout(600);
  let puts = 0; page.on('request', (rq) => { if (rq.method() === 'PUT' && rq.url().includes('credentials')) puts++; });
  const btn = await page.$('[data-act="creds"]');
  if (btn) {
    await btn.click(); await page.waitForTimeout(200);
    await page.fill('#dlg input >> nth=0', 'x').catch(() => {});
    await page.click('#dlg-ok'); await page.waitForTimeout(500);   // 1º: salva (returnValue = ok)
    const after1 = puts;
    await btn.click(); await page.waitForTimeout(200); await page.keyboard.press('Escape'); await page.waitForTimeout(500); // 2º: Esc
    console.log('PUT após salvar:', after1, '| após Esc:', puts, '(Esc não deve salvar)');
  } else console.log('sem botão creds');
  // agentes: rascunho preservado
  await page.evaluate(() => { location.hash = 'agentes'; });
  await page.waitForTimeout(600);
  await page.click('[data-ai-provider="openrouter"]');
  console.log('agentes ok:', (await page.textContent('#app')).includes('Agentes de IA'));
  // sessão expirada: apaga cookie e espera polling
  await page.evaluate(() => { location.hash = 'sincronizacao'; });
  await page.waitForTimeout(500);
  await page.context().clearCookies();
  await page.click('#refresh').catch(() => {});
  await page.waitForTimeout(800);
  console.log('login visível:', await page.isVisible('#login'));
  console.log('erros:', errs.length ? errs : 'nenhum');
  await b.close();
})().catch((e) => { console.error('FALHA', e); process.exit(1); });
