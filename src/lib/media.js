'use strict';
// Cliente HTTP comum às plataformas + download de fotos e vídeos do site
// de origem (Shopee e TikTok exigem upload do arquivo; o Mercado Livre
// baixa sozinho a partir da URL pública).
const config = require('../config');
const { isInternalUrl } = require('./netguard');

class PlatformError extends Error {
  constructor(message, { status, body, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    // 429 e 5xx são temporários: o motor de sync tenta de novo com backoff.
    this.retryable = retryable || status === 429 || (status >= 500 && status < 600);
  }
}

async function requestJson(url, { method = 'GET', headers = {}, body, form, timeoutMs = 60000 } = {}) {
  const init = { method, headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) };
  if (form) {
    init.body = form; // FormData: fetch define o boundary sozinho
  } else if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new PlatformError(`Falha de rede em ${method} ${new URL(url).pathname}: ${e.message}`, { retryable: true });
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
  if (!res.ok) {
    const msg = data.message || data.error_description || data.error || data.msg || res.statusText;
    const cause = Array.isArray(data.cause) && data.cause.length
      ? ' — ' + data.cause.map((c) => c.message || c.code).join('; ') : '';
    throw new PlatformError(`${method} ${new URL(url).pathname} → HTTP ${res.status}: ${msg}${cause}`, { status: res.status, body: data });
  }
  return data;
}

// Fotos/vídeos de produto vêm de fora (origem, API do site): não podem
// apontar para a rede interna (SSRF), cada redirecionamento é conferido e o
// corpo é lido em partes, parando ao passar do limite (sem estourar a memória).
// MEDIA_ALLOW_PRIVATE=1 libera a rede interna (ex.: ERP com fotos na LAN).
const MAX_REDIRECTS = 5;
async function download(url, { kind = 'image', maxBytes = config.maxMediaBytes } = {}) {
  const signal = AbortSignal.timeout(kind === 'video' ? 300000 : 60000);
  const limitMsg = `${kind} ${url} passa do limite de ${Math.round(maxBytes / 1048576)} MB`;
  let current = url;
  let res;
  for (let hop = 0; ; hop++) {
    let u;
    try { u = new URL(current); } catch { throw new PlatformError(`URL de ${kind} inválida: ${current}`); }
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new PlatformError(`URL de ${kind} não permitida: ${u.protocol}//${u.host}`);
    if (process.env.MEDIA_ALLOW_PRIVATE !== '1' && await isInternalUrl(u)) {
      throw new PlatformError(`${kind} ${u.host}: endereço da rede interna bloqueado (use MEDIA_ALLOW_PRIVATE=1 se as fotos ficam na rede local)`);
    }
    try {
      res = await fetch(u.href, { signal, redirect: 'manual' });
    } catch (e) {
      throw new PlatformError(`Não consegui baixar ${kind} ${url}: ${e.message}`, { retryable: true });
    }
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc) break;
    if (res.body) await res.body.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw new PlatformError(`${kind} ${url}: redirecionamentos demais`);
    current = new URL(loc, u).href;
  }
  if (!res.ok) throw new PlatformError(`Não consegui baixar ${kind} ${url}: HTTP ${res.status}`, { status: res.status });
  const len = Number(res.headers.get('content-length') || 0);
  if (len > maxBytes) throw new PlatformError(limitMsg);
  const chunks = [];
  let size = 0;
  if (res.body) {
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > maxBytes) {
        res.body.cancel && res.body.cancel().catch(() => {});
        throw new PlatformError(limitMsg);
      }
      chunks.push(Buffer.from(chunk));
    }
  }
  const buffer = Buffer.concat(chunks, size);
  if (!buffer.length) throw new PlatformError(`${kind} ${url} está vazio (0 bytes)`);
  const contentType = (res.headers.get('content-type') || '').split(';')[0] ||
    (kind === 'video' ? 'video/mp4' : 'image/jpeg');
  let name = new URL(current).pathname.split('/').pop() || '';
  try { name = decodeURIComponent(name); } catch { /* nome com % inválido: fica como veio */ }
  name = name ||
    (kind === 'video' ? 'video.mp4' : 'image.jpg');
  return { buffer, contentType, name };
}

function youtubeId(url) {
  const m = String(url).match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

module.exports = { PlatformError, requestJson, download, youtubeId };
