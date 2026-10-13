'use strict';
// Mini-roteador sobre node:http — evita depender de Express.
const fs = require('node:fs');
const path = require('node:path');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function createRouter() {
  const routes = [];
  const add = (method) => (pattern, ...handlers) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => {
      keys.push(k);
      return '/([^/]+)';
    }) + '/?$');
    routes.push({ method, re, keys, handlers });
  };
  return {
    get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'),
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = pathname.match(r.re);
        if (!m) continue;
        const params = {};
        try {
          r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        } catch {
          throw new HttpError(400, 'Endereço inválido');
        }
        return { handlers: r.handlers, params };
      }
      return null;
    },
  };
}

async function readJson(req, limit = 20 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Corpo da requisição grande demais');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json',
};

function serveStatic(root, req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

module.exports = { HttpError, createRouter, readJson, send, redirect, parseCookies, serveStatic };
