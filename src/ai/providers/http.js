'use strict';
// HTTP comum aos provedores de IA (sem SDK): JSON, multipart e download,
// com mensagens de erro em português para a tela.
class AiError extends Error {
  constructor(message, { status, retryable, retryAfter } = {}) {
    super(message);
    this.status = status;
    this.retryable = !!retryable;
    this.retryAfter = retryAfter || null; // segundos (header Retry-After)
  }
}

// Falta de crédito/limite de gasto: tentar de novo não resolve.
const BILLING = /insufficient_quota|payment_required|credit balance|insufficient credits|insufficient balance|spend_limit|usage_limit_exceeded|enable billing|billing (is )?(disabled|not enabled)|credit_balance|credits? (are |is )?(exhausted|depleted)/i;

// Erro HTTP do provedor → mensagem em português (o código do provedor vai
// junto, entre parênteses, para quem precisar abrir chamado).
function explain(provider, status, data) {
  // Alguns endpoints (Google /interactions) devolvem os erros como array.
  if (Array.isArray(data)) data = data.find((x) => x && x.error) || data[0] || {};
  const err = (data && (data.error || data)) || {};
  const raw = typeof err === 'string' ? err : err.message || data.message || data.detail || JSON.stringify(data).slice(0, 300);
  const msg = String(Array.isArray(raw) ? raw.map((x) => x.msg || x.message || JSON.stringify(x)).join('; ') : raw).slice(0, 400);
  const code = typeof err === 'object' ? [err.code, err.type, err.status, ...((err.details || []).map((d) => d && d.reason))].filter((x) => typeof x === 'string').join(' ') : '';
  const all = `${code} ${msg}`;
  if (status === 401 || /api[ _-]?key (not valid|invalid)|incorrect api key|api_key_invalid|authentication/i.test(all)) return `${provider}: chave de API inválida (${msg})`;
  if (status === 403 && /country|region|territory/i.test(all)) return `${provider}: a API não atende a região de onde o servidor está acessando (${msg})`;
  if (status === 403) return `${provider}: a chave não tem permissão para este modelo ou recurso (${msg})`;
  if (status === 429 && /per ?day|perday|daily/i.test(all) && !BILLING.test(all)) return `${provider}: cota diária do modelo esgotada; renova no próximo dia (${msg})`;
  if (status === 402 || BILLING.test(all)) return `${provider}: sem créditos ou faturamento desativado na conta do provedor (${msg})`;
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
    // Estouro do tempo-limite do cliente: o pedido pode ter sido aceito (e
    // cobrado). Repetir um POST de geração geraria uma segunda cobrança.
    const timedOut = e && e.name === 'TimeoutError';
    throw new AiError(timedOut ? `${provider}: o provedor não respondeu em ${Math.round(timeoutMs / 1000)} s` : `${provider}: falha de rede (${e.message})`, { retryable: !timedOut || method === 'GET' });
  }
  if (raw && res.ok) {
    return { buffer: Buffer.from(await res.arrayBuffer()), mime: (res.headers.get('content-type') || '').split(';')[0] };
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 300) }; }
  if (!res.ok) {
    const transient = (res.status === 429 && !BILLING.test(text)) || res.status === 408 || res.status >= 500;
    throw new AiError(explain(provider, res.status, data), { status: res.status, retryable: transient, retryAfter: Number(res.headers.get('retry-after')) || null });
  }
  return data;
}

// Conteúdo de um chat no formato da OpenAI (OpenAI, xAI, DeepSeek,
// OpenRouter): recusa, corte por limite e filtro viram mensagens claras.
function chatContent(provider, data) {
  // Alguns roteadores (OpenRouter) devolvem a falha do modelo com HTTP 200.
  if (data && data.error && !(data.choices || []).length) {
    const e = data.error;
    throw new AiError(explain(provider, Number(e.code) || 502, data), { retryable: [408, 429, 502, 503].includes(Number(e.code)) });
  }
  const ch = ((data && data.choices) || [])[0] || {};
  const m = ch.message || {};
  if (ch.error || ch.finish_reason === 'error') throw new AiError(`${provider}: ${(ch.error && ch.error.message) || 'o modelo falhou ao responder'}`, { retryable: true });
  if (m.refusal) throw new AiError(`${provider}: o modelo recusou o pedido (${String(m.refusal).slice(0, 200)})`);
  if (ch.finish_reason === 'content_filter') throw new AiError(`${provider}: resposta bloqueada pelo filtro de conteúdo do provedor`);
  if (ch.finish_reason === 'length') throw new AiError(`${provider}: a resposta foi cortada pelo limite de tokens`);
  return m.content;
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
  if (start < 0 || end < start) throw new AiError('o modelo não devolveu JSON');
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (e) {
    throw new AiError(`o modelo devolveu JSON inválido (${e.message})`);
  }
}

// Formatos de foto que a maioria dos modelos aceita como referência.
const COMMON_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

module.exports = { AiError, request, chatContent, fromBase64, dataUri, parseJsonText, sniffImage, pick, COMMON_MIMES };
