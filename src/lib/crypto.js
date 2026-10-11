'use strict';
// Cofre de credenciais (AES-256-GCM) e hash de senha (scrypt).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

let masterKey = null;

function getMasterKey() {
  if (masterKey) return masterKey;
  let raw = config.secret;
  if (!raw) {
    const file = path.join(config.dataDir, '.secret');
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
    }
    raw = fs.readFileSync(file, 'utf8').trim();
  }
  // Aceita qualquer string: deriva 32 bytes estáveis dela.
  masterKey = crypto.createHash('sha256').update(raw).digest();
  return masterKey;
}

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMasterKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

function decrypt(text) {
  if (!text) return null;
  const [ver, iv, tag, data] = String(text).split('.');
  if (ver !== 'v1') throw new Error('Formato de cofre desconhecido');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getMasterKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const out = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [algo, salt, hash] = String(stored || '').split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, got);
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const hmacHex = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest('hex');
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

module.exports = { encrypt, decrypt, hashPassword, verifyPassword, sha256, randomToken, hmacHex, md5, safeEqual };
