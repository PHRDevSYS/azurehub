'use strict';
// HTTP "educado" da pesquisa de preços: identifica o robô, respeita o
// robots.txt (como o ROBOTSTXT_OBEY do Scrapy), espera entre requisições ao
// mesmo site e guarda as respostas em cache.
const config = require('../config');

const UA_TOKEN = 'AzureHubPriceBot';
// Cabeçalho HTTP: só ASCII (o curl_cffi do Scrapling recusa "ç").
const USER_AGENT = `${UA_TOKEN}/${config.VERSION} (+${config.publicUrl}; pesquisa de precos)`;

class PriceSourceError extends Error {}

const timing = { sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)), now: () => Date.now() };
const lastByHost = new Map();
const cache = new Map();
const robotsCache = new Map();

async function rawGet(url, { headers = {}, timeoutMs = 20000 } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/html;q=0.9, */*;q=0.5', 'Accept-Language': 'pt-BR,pt;q=0.9', ...headers }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  } catch (e) {
    throw new PriceSourceError(`falha de rede em ${new URL(url).host}: ${e.message}`);
  }
  return { status: res.status, ok: res.ok, text: await res.text(), headers: res.headers };
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

function ruleMatches(pattern, path) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`).test(path);
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
  cache.set(url, { at: timing.now(), value });
  return value;
}

module.exports = { politeGet, rawGet, robotsAllows, parseRobots, isAllowed, PriceSourceError, USER_AGENT, timing, cache, robotsCache, lastByHost };
