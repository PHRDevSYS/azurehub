'use strict';
// Cliente HTTP das origens: respeita o limite de requisições de cada API
// (intervalo mínimo entre chamadas) e espera e tenta de novo em HTTP 429.
const { requestJson, PlatformError } = require('../lib/media');

const timing = { sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)) };

function throttled(minIntervalMs) {
  let last = 0;
  return async function request(url, opts = {}, attempt = 1) {
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await timing.sleep(wait);
    last = Date.now();
    try {
      return await requestJson(url, opts);
    } catch (e) {
      if (e.status === 429 && attempt < 5) {
        await timing.sleep(1000 * attempt);
        return request(url, opts, attempt + 1);
      }
      throw e;
    }
  };
}

// Variante que devolve também os cabeçalhos (paginação por header).
async function fetchWithHeaders(url, { headers = {}, timeoutMs = 60000 } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new PlatformError(`Falha de rede em ${new URL(url).host}: ${e.message}`, { retryable: true });
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const msg = (data && (data.message || data.description || data.error)) || res.statusText;
    throw new PlatformError(`${new URL(url).pathname} → HTTP ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, { status: res.status, body: data });
  }
  return { data, headers: res.headers };
}

// Converte peso/medidas para kg/cm.
const KG = { kg: 1, g: 0.001, lbs: 0.45359237, lb: 0.45359237, oz: 0.028349523125, GRAMS: 0.001, KILOGRAMS: 1, OUNCES: 0.028349523125, POUNDS: 0.45359237 };
const CM = { cm: 1, m: 100, mm: 0.1, in: 2.54, yd: 91.44 };
const toKg = (v, unit = 'kg') => (v === null || v === undefined || v === '' ? null : Math.round(Number(v) * (KG[unit] ?? 1) * 1000) / 1000 || null);
const toCm = (v, unit = 'cm') => (v === null || v === undefined || v === '' ? null : Math.round(Number(v) * (CM[unit] ?? 1) * 10) / 10 || null);

module.exports = { throttled, fetchWithHeaders, timing, toKg, toCm };
