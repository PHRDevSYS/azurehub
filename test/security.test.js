'use strict';
// Segurança do servidor: URL malformada, CSRF, bloqueio de login, senha da
// origem reaproveitada para outro host e download de mídia da rede interna.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurehub-sec-'));
process.env.HUB_DATA_DIR = dir;
process.env.HUB_SECRET = 'teste';

const { createServer } = require('../src/server');
const store = require('../src/lib/store');
const source = require('../src/source');
const { download } = require('../src/lib/media');

let server;
let base;
let cookie = '';

async function call(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// Requisição crua (o fetch normaliza a URL; aqui ela vai do jeito que veio).
function raw(pathname) {
  return new Promise((ok, bad) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: pathname, method: 'GET' }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode)); });
    req.on('error', bad);
    req.end();
  });
}

test.before(async () => {
  server = createServer();
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
  await call('POST', '/api/install', { email: 'adm@x.com', password: '12345678', source: { type: 'api' } });
});

test.after(() => {
  server.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('URL malformada responde 400 e o servidor continua de pé', async () => {
  assert.equal(await raw('/api/products/%E0%A4%A'), 400);
  assert.equal(await raw('/api/ugc/%ZZ'), 400);
  assert.equal((await call('GET', '/api/ai')).status, 200, 'segue respondendo');
});

test('CSRF: escrita de outro site é recusada e o corpo precisa ser JSON', async () => {
  let r = await call('POST', '/api/apikey/rotate', {}, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(r.status, 403);
  r = await call('POST', '/api/apikey/rotate', {}, { 'Sec-Fetch-Site': 'same-site' });
  assert.equal(r.status, 403, 'subdomínio irmão também não');
  r = await call('POST', '/api/apikey/rotate', {}, { Origin: 'https://atacante.test' });
  assert.equal(r.status, 403);
  r = await call('PUT', '/api/pricing/settings', '{"enabled":true}', { 'Content-Type': 'text/plain' });
  assert.equal(r.status, 415, 'formulário text/plain de outro site não passa');
  r = await call('PUT', '/api/ai/agents/crm', { slots: {} }, { 'Sec-Fetch-Site': 'same-origin', Origin: base });
  assert.equal(r.status, 200, 'o próprio painel continua funcionando');
});

test('login: senhas erradas de outro IP não bloqueiam o administrador', async () => {
  const saved = cookie;
  for (let i = 0; i < 5; i++) {
    const r = await call('POST', '/api/login', { email: 'adm@x.com', password: 'errada' }, { 'X-Real-IP': '203.0.113.9' });
    assert.equal(r.status, 401);
  }
  assert.equal((await call('POST', '/api/login', { email: 'adm@x.com', password: '12345678' }, { 'X-Real-IP': '203.0.113.9' })).status, 429, 'quem errou fica bloqueado');
  assert.equal((await call('POST', '/api/login', { email: 'adm@x.com', password: '12345678' }, { 'X-Real-IP': '198.51.100.7' })).status, 200, 'o admin em outro IP entra');
  cookie = saved;
});

test('a senha salva da origem não vai para outro host', async () => {
  const cfg = { type: 'woocommerce', url: 'https://loja.test', consumer_key: 'ck_1', consumer_secret: 'cs_SEGREDO' };
  source.saveSource(source.cleanSource(cfg));
  // Mesmo host, senha mascarada: mantém a salva.
  assert.equal(source.cleanSource({ ...cfg, consumer_secret: '••••••REDO' }).consumer_secret, 'cs_SEGREDO');
  // Host novo com a senha mascarada: a salva não é reaproveitada.
  assert.throws(() => source.cleanSource({ ...cfg, url: 'https://atacante.test', consumer_secret: '••••••REDO' }), /Campo obrigatório/);
});

test('download de foto/vídeo não acessa a rede interna nem estoura a memória', async () => {
  await assert.rejects(download('http://127.0.0.1:9/x.jpg'), /rede interna bloqueado/);
  await assert.rejects(download('http://169.254.169.254/latest/meta-data/'), /rede interna bloqueado/);
  await assert.rejects(download('http://localhost/x.jpg'), /rede interna bloqueado/);
  const realFetch = global.fetch;
  try {
    // Redirecionamento para a rede interna também é barrado.
    global.fetch = async (url) => (String(url).startsWith('https://cdn.test/')
      ? new Response(null, { status: 302, headers: { Location: 'http://10.0.0.5/segredo' } })
      : new Response('x'));
    await assert.rejects(download('https://cdn.test/foto.jpg'), /rede interna bloqueado/);
    // Corpo sem Content-Length maior que o limite: para no meio.
    let sent = 0;
    global.fetch = async () => new Response(new ReadableStream({
      pull(c) { if (sent > 50) return c.close(); sent++; c.enqueue(new Uint8Array(1024 * 1024)); },
    }), { headers: { 'Content-Type': 'image/jpeg' } });
    await assert.rejects(download('https://cdn.test/grande.jpg', { maxBytes: 5 * 1024 * 1024 }), /passa do limite/);
    assert.ok(sent < 10, `parou cedo (${sent} MB lidos)`);
  } finally {
    global.fetch = realFetch;
  }
});
