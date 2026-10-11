'use strict';
// Cliente HTTP comum às plataformas + download de fotos e vídeos do site
// de origem (Shopee e TikTok exigem upload do arquivo; o Mercado Livre
// baixa sozinho a partir da URL pública).
const config = require('../config');

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

async function download(url, { kind = 'image', maxBytes = config.maxMediaBytes } = {}) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(kind === 'video' ? 300000 : 60000) });
  } catch (e) {
    throw new PlatformError(`Não consegui baixar ${kind} ${url}: ${e.message}`, { retryable: true });
  }
  if (!res.ok) throw new PlatformError(`Não consegui baixar ${kind} ${url}: HTTP ${res.status}`, { status: res.status });
  const len = Number(res.headers.get('content-length') || 0);
  const limitMsg = `${kind} ${url} passa do limite de ${Math.round(maxBytes / 1048576)} MB`;
  if (len > maxBytes) throw new PlatformError(limitMsg);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw new PlatformError(limitMsg);
  if (!buffer.length) throw new PlatformError(`${kind} ${url} está vazio (0 bytes)`);
  const contentType = (res.headers.get('content-type') || '').split(';')[0] ||
    (kind === 'video' ? 'video/mp4' : 'image/jpeg');
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || `${kind}`) ||
    (kind === 'video' ? 'video.mp4' : 'image.jpg');
  return { buffer, contentType, name };
}

function youtubeId(url) {
  const m = String(url).match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

module.exports = { PlatformError, requestJson, download, youtubeId };
