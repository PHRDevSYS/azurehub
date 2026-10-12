'use strict';
// Fila da mídia UGC, em segundo plano.
// - Fotos: uma chamada ao modelo de imagem, com até 3 fotos reais do produto
//   como referência (o produto precisa sair idêntico).
// - Persona: a foto 1 pronta (mesmo gênero) também vai como referência nas
//   mídias 2 e 4, para ser a mesma pessoa em todas.
// - Vídeo: o provedor devolve um job; o hub consulta o status até ficar
//   pronto e baixa o arquivo. O id do job fica gravado: se o servidor
//   reiniciar, a consulta continua de onde parou (sem gerar — e pagar — de novo).
// Arquivos em data/ugc/<sku>/<id>.<ext>; servidos só pelo painel (com login).
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const store = require('../lib/store');
const { download } = require('../lib/media');
const settings = require('./settings');
const agent = require('./agent');
const { sniffImage } = require('./providers/http');

const DIR = path.join(config.dataDir, 'ugc');
const REF_MAX = 3;
const timing = { sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)), pollMs: 10000, maxWaitMs: 25 * 60e3, personaWaitMs: 10 * 60e3 };
const LIMIT = { image: 2, video: 2 };
const busy = { image: 0, video: 0 };
const waiting = { image: [], video: [] };
const lane = (kind) => (kind === 'video' ? 'video' : 'image');

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };

function enqueue(id, kind) {
  const l = lane(kind);
  if (!waiting[l].includes(id)) waiting[l].push(id);
  pump(l);
}

function pump(l) {
  while (busy[l] < LIMIT[l] && waiting[l].length) {
    const id = waiting[l].shift();
    busy[l]++;
    work(id).catch((e) => fail(id, e)).finally(() => { busy[l]--; pump(l); });
  }
}

function fail(id, e) {
  const item = store.ugcGet(id);
  store.ugcUpdate(id, { status: 'error', error: String(e && e.message ? e.message : e).slice(0, 1000) });
  if (item) store.log('error', `Mídia UGC (${item.kind}): ${e.message || e}`, { sku: item.sku });
}

// Fotos de referência: as do produto (e das variações), as primeiras.
async function references(p) {
  const urls = [...new Set([...(p.images || []), ...(p.variants || []).flatMap((v) => v.images || [])])].slice(0, REF_MAX);
  const out = [];
  for (const url of urls) {
    try {
      const f = await download(url, { kind: 'image', maxBytes: 10 * 1024 * 1024 });
      const mime = sniffImage(f.buffer) || (/^image\//.test(f.contentType) ? f.contentType : null);
      if (!mime) continue; // não é imagem
      out.push({ url, buffer: f.buffer, mime, name: f.name });
    } catch { /* foto inacessível: segue com as outras */ }
  }
  if (!out.length) throw new Error('nenhuma foto do produto pôde ser baixada para servir de referência');
  return out;
}

function save(item, buffer, mime) {
  const dir = path.join(DIR, item.sku.replace(/[^\w.-]+/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${item.id}.${EXT[mime] || (item.kind === 'video' ? 'mp4' : 'png')}`);
  fs.writeFileSync(file, buffer);
  store.ugcUpdate(item.id, { status: 'done', file: path.relative(config.dataDir, file), mime, error: null });
}

// Foto 1 (influencer usando o produto) do mesmo gênero, para as mídias 2 e 4
// terem a mesma pessoa. Se ela ainda está sendo gerada, espera um pouco.
async function persona(item) {
  const started = Date.now();
  for (;;) {
    const uso = store.ugcLatestOf(item.sku, 'uso');
    // Só espera a que entrou antes na fila (já está gerando): sem risco de travar.
    const pending = uso && uso.id < item.id && uso.gender === item.gender && ['queued', 'running'].includes(uso.status);
    if (!pending || Date.now() - started > timing.personaWaitMs) break;
    await timing.sleep(timing.pollMs);
  }
  const done = store.ugcLatestOf(item.sku, 'uso', { status: 'done', gender: item.gender });
  const file = filePath(done);
  if (!file) return null;
  return { url: `ugc:${done.id}`, buffer: fs.readFileSync(file), mime: done.mime || 'image/png', name: path.basename(file) };
}

async function work(id) {
  const item = store.ugcGet(id);
  if (!item || !['queued', 'running'].includes(item.status)) return;
  const prod = store.getProduct(item.sku);
  if (!prod) throw new Error('produto não encontrado');
  const slot = item.kind === 'video' ? 'video' : 'image';
  const active = settings.active({ id: item.provider, kind: slot });
  const { provider } = active;
  // O modelo gravado no pedido vale, mesmo que a configuração mude depois.
  const cfg = { ...active.cfg, models: { ...active.cfg.models, [slot]: item.model || active.cfg.models[slot] } };
  const inputs = async () => {
    const products = await references(prod.data);
    const face = ['posse', 'video'].includes(item.kind) ? await persona(item) : null;
    const refs = face ? [face, ...products] : products;
    const prompt = `${item.prompt}\n\n${agent.referenceNote(item.kind, { persona: !!face, products: products.length })}`;
    return { refs, prompt, persona: !!face };
  };
  if (slot === 'image') {
    store.ugcUpdate(id, { status: 'running' });
    const { refs, prompt, persona: hasPersona } = await inputs();
    const out = await provider.image(cfg, { prompt, refs, persona: hasPersona, aspect: '4:5' });
    save(item, out.buffer, out.mime);
    return;
  }
  let job = item.job;
  if (!job) {
    store.ugcUpdate(id, { status: 'running' });
    const { refs, prompt, persona: hasPersona } = await inputs();
    const out = await provider.startVideo(cfg, { prompt, refs, persona: hasPersona, seconds: cfg.videoSeconds, aspect: '9:16' });
    if (out.buffer) { save(item, out.buffer, out.mime || 'video/mp4'); return; } // provedor que responde na hora
    job = out.job;
    store.ugcUpdate(id, { job: String(job) });
  }
  const started = Date.now();
  for (;;) {
    const st = await provider.checkVideo(cfg, job);
    if (st.status === 'done') { save(item, st.buffer, st.mime || 'video/mp4'); return; }
    if (st.status === 'error') throw new Error(st.error || 'o provedor não conseguiu gerar o vídeo');
    if (Date.now() - started > timing.maxWaitMs) throw new Error('o vídeo não ficou pronto a tempo; gere de novo');
    await timing.sleep(timing.pollMs);
  }
}

// Cria e enfileira uma geração por mídia pedida. Valida tudo antes de gravar
// (nada entra na fila se faltar o provedor de uma das mídias). A foto 1 vai
// primeiro: ela é a referência da persona nas mídias 2 e 4.
const ORDER = ['uso', 'especificacoes', 'posse', 'video'];
function generate({ sku, gender, items }) {
  const plan = [...items].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)).map((it) => {
    const slot = it.kind === 'video' ? 'video' : 'image';
    const { provider, cfg } = settings.active({ kind: slot });
    const model = cfg.models[slot];
    if (!model) throw new Error(`Escolha o modelo de ${slot === 'video' ? 'vídeo' : 'imagem'} de ${provider.name} em "Modelo de IA"`);
    return { ...it, provider: provider.id, model };
  });
  return plan.map((it) => {
    const id = store.ugcInsert({ sku, kind: it.kind, gender, provider: it.provider, model: it.model, prompt: it.prompt, status: 'queued' });
    enqueue(id, it.kind);
    return id;
  });
}

// Ao subir o servidor: retoma o que ficou na fila ou gerando.
function resume() {
  for (const it of store.ugcActive()) enqueue(it.id, it.kind);
}

function filePath(item) {
  if (!item || !item.file) return null;
  const full = path.resolve(config.dataDir, item.file);
  return full.startsWith(DIR + path.sep) && fs.existsSync(full) ? full : null;
}

module.exports = { generate, resume, enqueue, work, references, filePath, timing, DIR };
