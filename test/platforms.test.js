'use strict';
// Fonte de dados do site (SQLite) e normalização de variações.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeProduct, validateProduct, groupVariantRows } = require('../src/source/normalize');
const source = require('../src/source');

test('fonte SQLite: consulta o banco do site e normaliza', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'src-')), 'loja.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE produtos (codigo TEXT, nome TEXT, preco TEXT, estoque INT, imagens TEXT);
           INSERT INTO produtos VALUES ('X1', 'Mesa', '350,00', 2, 'https://site.test/m1.jpg;https://site.test/m2.jpg');`);
  db.close();
  const res = await source.testSource({
    type: 'sqlite', database: file,
    query: 'SELECT codigo AS sku, nome AS title, preco AS price, estoque AS stock, imagens AS images FROM produtos',
  });
  assert.equal(res.count, 1);
  assert.equal(res.sample[0].product.price, 350);
  assert.equal(res.sample[0].product.images.length, 2);
  assert.deepEqual(res.sample[0].errors, []);
  await assert.rejects(source.testSource({ type: 'sqlite', database: file, query: 'DELETE FROM produtos' }), /SELECT/);
});

test('linhas com parent_sku viram um produto com variações', () => {
  const rows = [
    { parent_sku: 'CAM-1', sku: 'CAM-1-P', title: 'Camiseta Básica', price: '59,90', stock: 4, images: 'https://site.test/c.jpg', option_Tamanho: 'P' },
    { parent_sku: 'CAM-1', sku: 'CAM-1-M', title: 'Camiseta Básica', price: '59,90', stock: 0, images: 'https://site.test/c.jpg', option_Tamanho: 'M', ean: '7891234567895' },
    { sku: 'PAN-1', title: 'Panela', price: 99, images: 'https://site.test/p.jpg' },
  ];
  const [cam, pan] = groupVariantRows(rows).map(normalizeProduct);
  assert.equal(cam.sku, 'CAM-1');
  assert.deepEqual(cam.variants.map((v) => [v.sku, v.options, v.stock, v.gtin]), [
    ['CAM-1-P', { Tamanho: 'P' }, 4, null],
    ['CAM-1-M', { Tamanho: 'M' }, 0, '7891234567895'],
  ]);
  assert.equal(cam.price, 59.9);
  assert.equal(cam.stock, 4, 'estoque do pai = soma das variações');
  assert.deepEqual(validateProduct(cam), []);
  assert.deepEqual(pan.variants, []);
});

test('validação de variações: opções inconsistentes, combinação e sku repetidos', () => {
  const p = normalizeProduct({
    sku: 'X', title: 'X', price: 10, images: ['https://site.test/x.jpg'],
    variants: [
      { sku: 'A', options: { Cor: 'Azul', Tamanho: 'P' } },
      { sku: 'A', options: { Cor: 'azul', Tamanho: 'P' } },
      { sku: 'B', options: { Cor: 'Rosa' } },
    ],
  });
  const errors = validateProduct(p).join(' | ');
  assert.match(errors, /sku de variação repetido: A/);
  assert.match(errors, /combinação repetida/);
  assert.match(errors, /B precisa ter exatamente as opções Cor, Tamanho/);
});

test('promoção da variação herda a do produto só se for desconto real', () => {
  const p = normalizeProduct({
    sku: 'X', title: 'X', price: 100, promoPrice: 80, images: ['https://site.test/x.jpg'],
    variants: [{ sku: 'A', options: { T: 'P' }, price: 100 }, { sku: 'B', options: { T: 'G' }, price: 70 }],
  });
  assert.equal(p.variants[0].promoPrice, 80);
  assert.equal(p.variants[1].promoPrice, null, '80 não é desconto sobre 70');
});
