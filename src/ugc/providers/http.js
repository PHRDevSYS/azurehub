'use strict';
// HTTP comum aos provedores de IA (sem SDK): JSON, multipart e download,
// com mensagens de erro em português para a tela.
class AiError extends Error {
  constructor(message, { status, retryable } = {}) {
    super(message);
    this.status = status;
    this.retryable = !!retryable;
  }
}

// Erro HTTP do provedor → mensagem em português (o código do provedor vai
// junto, entre parênteses, para quem precisar abrir chamado).
function explain(provider, status, data) {
  const err = (data && (data.error || data)) || {};
  const raw = typeof err === 'string' ? err : err.message || data.message || data.detail || JSON.stringify(data).slice(0, 300);
  const msg = String(Array.isArray(raw) ? raw.map((x) => x.msg || x.message || JSON.stringify(x)).join('; ') : raw).slice(0, 400);
  const code = typeof err === 'object' ? [err.code, err.type, err.status].filter((x) => typeof x === 'string').join(' ') : '';
  const all = `${code} ${msg}`;
  if (status === 401 || /api[ _-]?key (not valid|invalid)|incorrect api key|api_key_invalid|authentication/i.test(all)) return `${provider}: chave de API inválida (${msg})`;
  if (status === 403) return `${provider}: a chave não tem permissão para este modelo ou recurso (${msg})`;
  if (status === 402 || /insufficient_quota|credit|billing|payment|exhausted|spend_limit/i.test(all)) return `${provider}: sem créditos ou faturamento desativado na conta do provedor (${msg})`;
  if (status === 404) return `${provider}: modelo ou recurso não encontrado — confira o id do modelo (${msg})`;
  if (status === 429) return `${provider}: limite de uso atingido; tente de novo em alguns minutos (${msg})`;
  if (/safety|policy|moderation|blocked|prohibited|sensitive|nsfw/i.test(all)) return `${provider}: o pedido foi bloqueado pela política de conteúdo do provedor — ajuste o prompt (${msg})`;
  return `${provider}: HTTP ${status} — ${msg}`;
}

async function request(provider, url, { method = 'GET', headers = {}, json, form, timeoutMs = 120000, raw = false } = {}) {
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers['Content-Type'] = 'application/json';
  } else if (form) {
    init.body = form; // fetch define o boundary
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new AiError(`${provider}: falha de rede (${e.message})`, { retryable: true });
  }
  if (raw && res.ok) {
    return { buffer: Buffer.from(await res.arrayBuffer()), mime: (res.headers.get('content-type') || '').split(';')[0] };
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 300) }; }
  if (!res.ok) throw new AiError(explain(provider, res.status, data), { status: res.status, retryable: res.status === 429 || res.status >= 500 });
  return data;
}

// Imagem em base64 → buffer (aceita data URI).
function fromBase64(b64, fallbackMime = 'image/png') {
  const m = String(b64).match(/^data:([^;]+);base64,(.*)$/s);
  return m ? { buffer: Buffer.from(m[2], 'base64'), mime: m[1] } : { buffer: Buffer.from(String(b64), 'base64'), mime: fallbackMime };
}

// Tipo real de uma imagem pelos primeiros bytes (o servidor da loja nem
// sempre manda o Content-Type certo, e os provedores recusam tipo errado).
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (buf.toString('ascii', 4, 8) === 'ftyp' && /^(heic|heix|mif1|msf1|heif)$/.test(buf.toString('ascii', 8, 12))) return 'image/heic';
  if (buf.toString('ascii', 4, 8) === 'ftyp' && /^avi[fs]$/.test(buf.toString('ascii', 8, 12))) return 'image/avif';
  return null;
}

// Primeiro item que existir em vários formatos de resposta.
const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');

const dataUri = (ref) => `data:${ref.mime || 'image/jpeg'};base64,${ref.buffer.toString('base64')}`;

// JSON vindo de um modelo de texto (tolera cercas ```json).
function parseJsonText(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) throw new AiError('o agente não devolveu JSON');
  return JSON.parse(s.slice(start, end + 1));
}

module.exports = { AiError, request, fromBase64, dataUri, parseJsonText, sniffImage, pick };
