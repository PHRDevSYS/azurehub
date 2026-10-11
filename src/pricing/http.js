'use strict';
// HTTP "educado" da pesquisa de preços: identifica o robô, respeita o
// robots.txt (como o ROBOTSTXT_OBEY do Scrapy), espera entre requisições ao
// mesmo site e guarda as respostas em cache.
//
// Proteções (as URLs vêm da configuração e de redirecionamentos de sites de
// terceiros): só http(s); nunca endereços internos (loopback, rede privada,
// link-local/metadados da nuvem), conferido em cada redirecionamento; corpo
// limitado a MAX_BYTES; cache com teto de entradas.
const dns = require('node:dns');
const net = require('node:net');
const config = require('../config');

const UA_TOKEN = 'AzureHubPriceBot';
// Cabeçalho HTTP: só ASCII (o curl_cffi do Scrapling recusa "ç").
const USER_AGENT = `${UA_TOKEN}/${config.VERSION} (+${config.publicUrl}; pesquisa de precos)`;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const CACHE_MAX = 1000;

class PriceSourceError extends Error {}

const timing = { sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)), now: () => Date.now() };
// Resolução de nomes sobrescrevível nos testes.
const resolver = { lookup: (host) => dns.promises.lookup(host, { all: true, verbatim: true }) };
const lastByHost = new Map();
const cache = new Map();
const robotsCache = new Map();

// ------------------------------------------------------ endereços internos
function ipv4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return ipv4Private(ip);
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Private(mapped[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(v)) {
    const [hi, lo] = v.slice(7).split(':').map((h) => parseInt(h, 16));
    return ipv4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  // "::"... (não especificado, loopback, IPv4-compatível como ::7f00:1) é todo reservado.
  return v.startsWith('::') || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v) || /^64:ff9b:/.test(v) || /^2001:db8:/.test(v);
}

// Liberado só por PRICE_ALLOW_PRIVATE=1 (ex.: loja de teste na rede local).
const allowPrivate = () => process.env.PRICE_ALLOW_PRIVATE === '1';

async function assertPublicUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new PriceSourceError(`URL inválida: ${url}`); }
  if (!/^https?:$/.test(u.protocol)) throw new PriceSourceError(`só http(s) é permitido: ${u.protocol}`);
  if (u.username || u.password) throw new PriceSourceError('URL com usuário/senha não é permitida');
  if (allowPrivate()) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new PriceSourceError(`endereço interno bloqueado: ${host}`);
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host }];
  else {
    try { addrs = await resolver.lookup(host); } catch (e) { throw new PriceSourceError(`não consegui resolver ${host} (${e.code || e.message})`); }
  }
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new PriceSourceError(`endereço interno bloqueado: ${host}`);
  return u;
}

async function readCapped(res, max = MAX_BYTES) {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > max) throw new PriceSourceError(`resposta grande demais (${Math.round(len / 1048576)} MB)`);
  if (!res.body) return '';
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > max) throw new PriceSourceError(`resposta maior que ${max / 1048576} MB`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function rawGet(url, { headers = {}, timeoutMs = 20000 } = {}) {
  let current = url;
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; ; hop++) {
    const u = await assertPublicUrl(current);
    let res;
    try {
      res = await fetch(u.href, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/html;q=0.9, */*;q=0.5', 'Accept-Language': 'pt-BR,pt;q=0.9', ...headers }, signal, redirect: 'manual' });
    } catch (e) {
      throw new PriceSourceError(`falha de rede em ${u.host}: ${e.message}`);
    }
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (loc) {
      if (hop >= MAX_REDIRECTS) throw new PriceSourceError(`redirecionamentos demais a partir de ${new URL(url).host}`);
      if (res.body) await res.body.cancel().catch(() => {});
      current = new URL(loc, u).href;
      continue;
    }
    try {
      return { status: res.status, ok: res.ok, text: await readCapped(res), headers: res.headers, url: u.href };
    } catch (e) {
      if (e instanceof PriceSourceError) throw e;
      throw new PriceSourceError(`falha ao ler a resposta de ${u.host}: ${e.message}`);
    }
  }
}

function cacheSet(key, value) {
  cache.delete(key);
  cache.set(key, { at: timing.now(), value });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// --------------------------------------------------------------- robots.txt
function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && cur) {
      lastWasAgent = false;
      if (key === 'disallow' && !val) continue; // "Disallow:" vazio = libera tudo
      cur.rules.push({ allow: key === 'allow', path: val });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

// Casamento das regras do robots.txt ("*" = qualquer sequência, "$" = fim)
// sem RegExp: os padrões vêm do site remoto e não podem custar caro.
function ruleMatches(pattern, path) {
  const anchored = pattern.endsWith('$');
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  if (!path.startsWith(parts[0])) return false;
  let pos = parts[0].length;
  if (parts.length === 1) return !anchored || pos === path.length;
  const last = parts.length - 1;
  for (let i = 1; i < last; i++) {
    const at = path.indexOf(parts[i], pos);
    if (at < 0) return false;
    pos = at + parts[i].length;
  }
  if (!anchored) return path.indexOf(parts[last], pos) >= 0;
  return path.length - parts[last].length >= pos && path.endsWith(parts[last]);
}

// Regra mais específica (mais longa) vence; empate → Allow.
function isAllowed(groups, pathWithQuery, agent = UA_TOKEN.toLowerCase()) {
  const group = groups.find((g) => g.agents.some((a) => a !== '*' && agent.includes(a))) || groups.find((g) => g.agents.includes('*'));
  if (!group) return true;
  let best = null;
  for (const r of group.rules) {
    if (!ruleMatches(r.path, pathWithQuery)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

async function robotsAllows(url) {
  const u = new URL(url);
  const key = u.origin;
  let entry = robotsCache.get(key);
  if (!entry || entry.at < timing.now() - 24 * 3600e3) {
    const res = await rawGet(`${u.origin}/robots.txt`, { timeoutMs: 10000 }).catch((e) => ({ status: 0, error: e.message }));
    // 4xx = sem restrições; 5xx/rede = trata como bloqueado (prática do Google).
    entry = { at: timing.now(), groups: res.status >= 200 && res.status < 300 ? parseRobots(res.text) : [], blocked: !res.status || res.status >= 500 };
    robotsCache.set(key, entry);
  }
  if (entry.blocked) return false;
  return isAllowed(entry.groups, u.pathname + u.search);
}

// --------------------------------------------------------------- requisição
async function politeGet(url, { respectRobots = true, minIntervalMs = 1500, cacheHours = 12, as = 'json', headers } = {}) {
  const hit = cache.get(url);
  if (hit && hit.at > timing.now() - cacheHours * 3600e3) return hit.value;
  await assertPublicUrl(url);
  if (respectRobots && !(await robotsAllows(url))) throw new PriceSourceError(`bloqueado pelo robots.txt de ${new URL(url).host}`);
  const host = new URL(url).host;
  const wait = (lastByHost.get(host) || 0) + minIntervalMs - timing.now();
  if (wait > 0) await timing.sleep(wait);
  lastByHost.set(host, timing.now());
  const res = await rawGet(url, { headers });
  if (res.status === 429) throw new PriceSourceError(`${host} limitou as requisições (429); tente mais tarde`);
  if (!res.ok) throw new PriceSourceError(`${host} respondeu HTTP ${res.status}`);
  let value = res.text;
  if (as === 'json') {
    try { value = JSON.parse(res.text); } catch { throw new PriceSourceError(`${host} não devolveu JSON`); }
  }
  cacheSet(url, value);
  return value;
}

module.exports = {
  politeGet, rawGet, robotsAllows, parseRobots, isAllowed, ruleMatches, assertPublicUrl, isPrivateAddress, readCapped,
  PriceSourceError, USER_AGENT, MAX_BYTES, timing, resolver, cache, robotsCache, lastByHost,
};
