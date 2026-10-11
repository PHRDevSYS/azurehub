'use strict';
// Consultas prontas para plataformas de loja comuns. O instalador oferece
// estas como ponto de partida; o usuário ajusta nomes de tabela/prefixo.
// Colunas reconhecidas: sku, title, description, brand, model, gtin, condition,
// price, promo_price, promo_start, promo_end, stock, weight_kg, length_cm,
// width_cm, height_cm, images, videos, category_ml, category_shopee,
// category_tiktok, attributes (JSON), active.
// images/videos aceitam array JSON ou lista separada por vírgula, ";", "|" ou quebra de linha.

module.exports = {
  generico: {
    label: 'Genérico (tabela própria)',
    types: ['mysql', 'postgres', 'sqlite'],
    query: `SELECT
  codigo        AS sku,
  nome          AS title,
  descricao     AS description,
  marca         AS brand,
  ean           AS gtin,
  preco         AS price,
  preco_promo   AS promo_price,
  promo_inicio  AS promo_start,
  promo_fim     AS promo_end,
  estoque       AS stock,
  peso_kg       AS weight_kg,
  comprimento_cm AS length_cm,
  largura_cm    AS width_cm,
  altura_cm     AS height_cm,
  imagens       AS images,
  videos        AS videos
FROM produtos
WHERE ativo = 1`,
  },
  woocommerce: {
    label: 'WooCommerce (WordPress / MySQL)',
    types: ['mysql'],
    // Prefixo padrão "wp_". Peso/dimensões seguem a unidade configurada no
    // WooCommerce (o padrão é kg/cm). A URL das imagens vem de wp_posts.guid,
    // que é a URL original do upload — confira se é pública no seu site.
    query: `SELECT
  sku.meta_value                         AS sku,
  p.post_title                           AS title,
  p.post_content                         AS description,
  COALESCE(reg.meta_value, pr.meta_value) AS price,
  sale.meta_value                        AS promo_price,
  FROM_UNIXTIME(NULLIF(sfrom.meta_value, '')) AS promo_start,
  FROM_UNIXTIME(NULLIF(sto.meta_value, ''))   AS promo_end,
  COALESCE(stk.meta_value, 0)            AS stock,
  wgt.meta_value                         AS weight_kg,
  len.meta_value                         AS length_cm,
  wid.meta_value                         AS width_cm,
  hgt.meta_value                         AS height_cm,
  CONCAT_WS(',', thumb.guid,
    (SELECT GROUP_CONCAT(g.guid ORDER BY FIND_IN_SET(g.ID, gal.meta_value))
       FROM wp_posts g WHERE FIND_IN_SET(g.ID, gal.meta_value))) AS images
FROM wp_posts p
JOIN wp_postmeta sku   ON sku.post_id = p.ID AND sku.meta_key = '_sku' AND sku.meta_value <> ''
LEFT JOIN wp_postmeta reg   ON reg.post_id = p.ID AND reg.meta_key = '_regular_price'
LEFT JOIN wp_postmeta pr    ON pr.post_id = p.ID AND pr.meta_key = '_price'
LEFT JOIN wp_postmeta sale  ON sale.post_id = p.ID AND sale.meta_key = '_sale_price'
LEFT JOIN wp_postmeta sfrom ON sfrom.post_id = p.ID AND sfrom.meta_key = '_sale_price_dates_from'
LEFT JOIN wp_postmeta sto   ON sto.post_id = p.ID AND sto.meta_key = '_sale_price_dates_to'
LEFT JOIN wp_postmeta stk   ON stk.post_id = p.ID AND stk.meta_key = '_stock'
LEFT JOIN wp_postmeta wgt   ON wgt.post_id = p.ID AND wgt.meta_key = '_weight'
LEFT JOIN wp_postmeta len   ON len.post_id = p.ID AND len.meta_key = '_length'
LEFT JOIN wp_postmeta wid   ON wid.post_id = p.ID AND wid.meta_key = '_width'
LEFT JOIN wp_postmeta hgt   ON hgt.post_id = p.ID AND hgt.meta_key = '_height'
LEFT JOIN wp_postmeta th    ON th.post_id = p.ID AND th.meta_key = '_thumbnail_id'
LEFT JOIN wp_posts thumb    ON thumb.ID = th.meta_value
LEFT JOIN wp_postmeta gal   ON gal.post_id = p.ID AND gal.meta_key = '_product_image_gallery'
WHERE p.post_type = 'product' AND p.post_status = 'publish'`,
  },
};
