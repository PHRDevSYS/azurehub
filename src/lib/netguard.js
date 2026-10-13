'use strict';
// Proteção contra SSRF: endereços da rede interna (loopback, privados,
// link-local/metadados de nuvem, reservados) não podem ser buscados a partir
// de URLs que vêm de fora (fontes de pesquisa, fotos/vídeos de produto).
const dns = require('node:dns');
const net = require('node:net');

// Resolução de nomes sobrescrevível nos testes.
const resolver = { lookup: (host) => dns.promises.lookup(host, { all: true, verbatim: true }) };

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

const INTERNAL_NAME = /^localhost$|\.localhost$|\.local$|\.internal$/i;

// true se a URL aponta para a rede interna. Nome que não resolve não é
// considerado interno (a conexão falharia de qualquer jeito).
async function isInternalUrl(u) {
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (INTERNAL_NAME.test(host)) return true;
  if (net.isIP(host)) return isPrivateAddress(host);
  let addrs;
  try { addrs = await resolver.lookup(host); } catch { return false; }
  return addrs.some((a) => isPrivateAddress(a.address));
}

module.exports = { isPrivateAddress, isInternalUrl, resolver, INTERNAL_NAME };
