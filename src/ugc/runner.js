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
const ai = require('../ai/settings');
const providers = require('../ai/providers');
const agent = require('./agent');
const { sniffImage, COMMON_MIMES } = require('../ai/providers/http');

const DIR = path.join(config.dataDir, 'ugc');
const REF_MAX = 3;
const timing = { sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)), pollMs: 10000, maxWaitMs: 25 * 60e3, personaWaitMs: 10 * 60e3, retryMs: [5000, 20000] };
const PERSONA_MAX = 10 * 1024 * 1024;
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

// Fotos de referência: as do produto (e das variações), as primeiras que o
// provedor aceita (formato) — uma foto HEIC/AVIF não derruba a geração.
async function references(p, accept = COMMON_MIMES) {
  const urls = [...new Set([...(p.images || []), ...(p.variants || []).flatMap((v) => v.images || [])])].slice(0, 8);
  const out = [];
  const refused = new Set();
  for (const url of urls) {
    if (out.length >= REF_MAX) break;
    try {
      const f = await download(url, { kind: 'image', maxBytes: 10 * 1024 * 1024 });
      const mime = sniffImage(f.buffer) || (/^image\//.test(f.contentType) ? f.contentType : null);
      if (!mime) continue; // não é imagem
      if (!accept.includes(mime)) { refused.add(mime); continue; }
      out.push({ url, buffer: f.buffer, mime, name: f.name });
    } catch { /* foto inacessível: segue com as outras */ }
  }
  if (!out.length && refused.size) throw new Error(`as fotos do produto estão em ${[...refused].join(', ')}, formato que este modelo não aceita; use JPG, PNG ou WebP na origem`);
  if (!out.length) throw new Error('nenhuma foto do produto pôde ser baixada para servir de referência');
  return out;
}

// Erro temporário do provedor (limite de uso, sobrecarga, rede): espera e
// tenta de novo, até 2 vezes. Falta de crédito ou bloqueio de conteúdo não.
async function retrying(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!e.retryable || attempt >= timing.retryMs.length) throw e;
      await timing.sleep(Math.min(60000, e.retryAfter ? e.retryAfter * 1000 : timing.retryMs[attempt]));
    }
  }
}

// O tipo vem do conteúdo (não do que o provedor disse): só imagem/vídeo
// conhecidos são gravados — nada de text/html ou svg servido pelo painel.
function mediaType(kind, buffer, claimed) {
  if (kind !== 'video') {
    const img = sniffImage(buffer);
    if (!img || !EXT[img]) throw new Error(`o provedor devolveu um arquivo que não é imagem (${claimed || 'tipo desconhecido'})`);
    return img;
  }
  const isMp4 = buffer.length > 12 && buffer.toString('ascii', 4, 8) === 'ftyp';
  const isWebm = buffer.length > 4 && buffer.readUInt32BE(0) === 0x1a45dfa3;
  if (isWebm) return 'video/webm';
  if (isMp4) return claimed === 'video/quicktime' ? 'video/quicktime' : 'video/mp4';
  throw new Error(`o provedor devolveu um arquivo que não é vídeo (${claimed || 'tipo desconhecido'})`);
}

async function save(item, buffer, claimed) {
  const mime = mediaType(item.kind, buffer, claimed);
  const dir = path.join(DIR, item.sku.replace(/[^\w.-]+/g, '_'));
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${item.id}.${EXT[mime] || (item.kind === 'video' ? 'mp4' : 'png')}`);
  await fs.promises.writeFile(file, buffer); // vídeo pode ter dezenas de MB: sem travar o servidor
  store.ugcUpdate(item.id, { status: 'done', file: path.relative(config.dataDir, file), mime, error: null });
}

// Foto 1 (influencer usando o produto) do mesmo gênero, para as mídias 2 e 4
// terem a mesma pessoa. Se ela ainda está sendo gerada, espera um pouco.
async function persona(item, accept = COMMON_MIMES) {
  const started = Date.now();
  for (;;) {
    // Só espera a que entrou antes na fila (já está gerando): sem risco de travar.
    const pending = store.ugcPendingUso(item.sku, item.gender, item.id);
    if (!pending || Date.now() - started > timing.personaWaitMs) break;
    await timing.sleep(timing.pollMs);
  }
  const done = store.ugcLatestOf(item.sku, 'uso', { status: 'done', gender: item.gender });
  const file = filePath(done);
  if (!file || (await fs.promises.stat(file)).size > PERSONA_MAX) return null;
  const buffer = await fs.promises.readFile(file);
  const mime = sniffImage(buffer) || done.mime || 'image/png';
  return accept.includes(mime) ? { url: `ugc:${done.id}`, buffer, mime, name: path.basename(file) } : null;
}

async function work(id) {
  const item = store.ugcGet(id);
  if (!item || !['queued', 'running'].includes(item.status)) return;
  const prod = store.getProduct(item.sku);
  if (!prod) throw new Error('produto não encontrado');
  const slot = item.kind === 'video' ? 'video' : 'image';
  // O provedor e o modelo gravados no pedido valem, mesmo que a escolha na
  // tela Agentes de IA mude depois.
  let { provider, cfg } = ai.connection(item.provider, { [slot]: item.model });
  if (!providers.can(provider, slot)) throw new Error(`${provider.name} não gera ${slot === 'video' ? 'vídeos' : 'imagens'}`);
  // Modelo reserva da função (Agentes de IA), se houver e for outro modelo.
  const reserve = () => {
    const r = ai.resolve('midia', slot, { optional: true });
    const fb = r && r.fallback;
    return fb && !(fb.provider.id === provider.id && fb.model === item.model) ? fb : null;
  };
  const switchTo = (fb, why) => {
    store.log('warn', `Mídia UGC: ${provider.name} (${item.model}) falhou — usando o modelo reserva ${fb.provider.name} (${fb.model}): ${why}`, { sku: item.sku });
    provider = fb.provider;
    cfg = fb.cfg;
    item.provider = fb.provider.id;
    item.model = fb.model;
    store.ugcUpdate(id, { provider: item.provider, model: item.model });
  };
  const inputs = async () => {
    const accept = provider.acceptMimes || COMMON_MIMES;
    const products = await references(prod.data, accept);
    const face = ['posse', 'video'].includes(item.kind) ? await persona(item, accept) : null;
    const refs = face ? [face, ...products] : products;
    const prompt = `${item.prompt}\n\n${agent.referenceNote(item.kind, { persona: !!face, products: products.length })}`;
    return { refs, prompt, persona: !!face };
  };
  if (slot === 'image') {
    store.ugcUpdate(id, { status: 'running' });
    const shoot = async () => {
      const { refs, prompt, persona: hasPersona } = await inputs();
      return retrying(() => provider.image(cfg, { prompt, refs, persona: hasPersona, aspect: '4:5' }));
    };
    let out;
    try {
      out = await shoot();
    } catch (e) {
      const fb = reserve();
      if (!fb) throw e;
      switchTo(fb, e.message);
      out = await shoot();
    }
    await save(item, out.buffer, out.mime);
    return;
  }
  let job = item.job;
  if (!job) {
    store.ugcUpdate(id, { status: 'running' });
    const begin = async () => {
      const { refs, prompt, persona: hasPersona } = await inputs();
      return retrying(() => provider.startVideo(cfg, { prompt, refs, persona: hasPersona, seconds: ai.videoSeconds(), aspect: '9:16' }));
    };
    let out;
    try {
      out = await begin();
    } catch (e) {
      const fb = reserve();
      if (!fb) throw e;
      switchTo(fb, e.message);
      out = await begin();
    }
    if (out.buffer) { await save(item, out.buffer, out.mime || 'video/mp4'); return; } // provedor que responde na hora
    job = out.job;
    store.ugcUpdate(id, { job: String(job) });
  }
  const started = Date.now();
  let pollErrors = 0;
  for (;;) {
    // O vídeo já existe (e foi cobrado) no provedor: falha de rede ou 5xx na
    // consulta não o descarta; só um erro definitivo (chave, 4xx) encerra.
    let st;
    try {
      st = await retrying(() => provider.checkVideo(cfg, job));
    } catch (e) {
      if (!(e && e.retryable) || ++pollErrors > 20) throw e;
      st = { status: 'running' };
    }
    if (st.status === 'done') { await save(item, st.buffer, st.mime || 'video/mp4'); return; }
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
    const { provider, model } = ai.resolve('midia', it.kind === 'video' ? 'video' : 'image');
    return { ...it, provider: provider.id, model };
  });
  for (const it of plan) {
    if (store.ugcInFlight(sku, it.kind, gender)) throw new Error('Já existe uma geração desta mídia em andamento; aguarde terminar');
  }
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
