# AzureHub (beta)

Hub de integrações que publica os produtos de **qualquer site** no
**Mercado Livre**, na **Shopee** e no **TikTok Shop**. Envia título, descrição,
preço, preço promocional, estoque, peso/dimensões, marca/GTIN, fotos e vídeos.

![Painel](docs/painel.png)

> **Versão beta (0.1.0-beta.3).** O fluxo completo está implementado e coberto
> por testes com as APIs simuladas, mas ainda **não foi validado contra os
> sandboxes reais** das plataformas — ver [Antes de ir para produção](#antes-de-ir-para-produção).

## Como funciona

```
 Banco do site (MySQL/Postgres/SQLite) ──SELECT──┐
                                                 ├─► AzureHub ─► fila ─► Mercado Livre
 Site / ERP ── POST /api/v1/products ────────────┘   (normaliza,        ─► Shopee
                                                      detecta mudança)  ─► TikTok Shop
```

1. **Fonte de produtos.** Na instalação o hub pede as **credenciais do banco
   de dados do site** e uma consulta `SELECT` cujas colunas usam os nomes do
   hub (`sku`, `title`, `price`, `promo_price`, `images`…). Há modelos prontos
   (genérico e WooCommerce). Se o site preferir empurrar os dados, existe a
   API REST com chave (`X-Api-Key`).
2. **Normalização.** Todo produto vira um modelo único (ver
   `src/source/normalize.js`). Aceita preços no formato brasileiro (`1.234,50`)
   e listas de imagens em JSON ou separadas por vírgula, `;`, `|` ou quebra de linha.
3. **Detecção de mudança.** Cada produto tem um hash do conteúdo; só o que
   mudou entra na fila.
4. **Fila e reenvio.** Um envio por vez por plataforma (as três rodam em
   paralelo). Erros temporários (rede, 429, 5xx) são tentados de novo até
   5 vezes, com espera crescente (15 s → 30 min).
5. **Os 3 cards.** Cada plataforma tem seu card: credenciais, conectar a
   conta (OAuth), testar, ativar e sincronizar.

## Requisitos

- **Node.js 22.13+** (usa o SQLite embutido do Node, `node:sqlite`).
- Para ler o banco do site: `mysql2` (MySQL/MariaDB) ou `pg` (PostgreSQL). Os
  dois são instalados pelo `npm install` (são opcionais: se um falhar, o hub
  continua funcionando para os outros tipos).
- Em produção: **HTTPS** com URL pública (as três plataformas exigem HTTPS no
  retorno do OAuth) e fotos/vídeos em **URLs públicas**.

## Instalação

### Linux / VPS

```bash
cd AzureHub
bash install.sh        # confere o Node, instala os drivers e cria o .env com HUB_SECRET
nano .env              # ajuste PUBLIC_URL
npm start
```

Abra `PUBLIC_URL` no navegador e siga o assistente:

1. **Administrador**: e-mail e senha do painel.
2. **Banco de dados do site**: tipo, host, porta, usuário, senha, banco e a
   consulta. Use **Testar conexão** para ver uma amostra já validada.
3. **Concluir**: o hub mostra a **chave de API** uma única vez. Guarde-a.

### Docker

```bash
cp .env.example .env   # ajuste PUBLIC_URL e HUB_SECRET
docker compose up -d --build
```

### Rodar como serviço (systemd)

```ini
# /etc/systemd/system/azurehub.service
[Unit]
Description=AzureHub
After=network.target

[Service]
WorkingDirectory=/opt/azurehub
ExecStart=/usr/bin/node --no-warnings=ExperimentalWarning src/server.js
Restart=always
User=azurehub
EnvironmentFile=/opt/azurehub/.env

[Install]
WantedBy=multi-user.target
```

Atrás do nginx, publique com `proxy_pass http://127.0.0.1:3900;`.

### Variáveis (`.env`)

| Variável | Padrão | Uso |
|---|---|---|
| `PORT` | `3900` | Porta HTTP |
| `PUBLIC_URL` | `http://localhost:PORT` | Base dos redirect_uri do OAuth |
| `HUB_SECRET` | gerada em `data/.secret` | Chave mestra que cifra as credenciais. **Se perder, é preciso recadastrar tudo** |
| `HUB_DATA_DIR` | `data` | Pasta do banco interno |
| `MAX_MEDIA_MB` | `100` | Tamanho máximo de foto/vídeo baixado |
| `SESSION_HOURS` | `12` | Duração da sessão do painel |

## Credenciais de cada plataforma

Em todas, cadastre no app do desenvolvedor a **URL de retorno** exibida no card:
`<PUBLIC_URL>/oauth/<plataforma>/callback`.

### Mercado Livre
- Crie o app em <https://developers.mercadolivre.com.br/devcenter>.
- Informe **App ID** e **Chave secreta**; escopos `read`, `write`, `offline_access`.
- Categoria: usa `category_ml` do produto, depois a categoria padrão do card e,
  se nenhuma existir, **prevê pelo título** (`domain_discovery`).
- Promoção: campanha própria do vendedor (`PRICE_DISCOUNT`, `deal_price`).
- Vídeo: o anúncio aceita link do **YouTube** (`video_id`). Arquivos de vídeo
  (clips) ficam para a próxima versão; o hub avisa no log.

### Shopee
Conector conferido com a documentação oficial (<https://open.shopee.com/developer-guide/211>
e referência das APIs v2).

- Crie o app no Shopee Open Platform Console. Informe **Partner ID**, **Partner
  Key**, ambiente (`sandbox` / `production`) e região (`BR` usa
  `open.shopee.com.br` e `openplatform.shopee.com.br`; sandbox usa
  `openplatform.sandbox.test-stable.shopee.sg`). O Partner ID de teste só vale
  no sandbox.
- **No Console:** cadastre o domínio do hub em *Redirect URL Domain* (teste e
  produção) e declare o **IP do servidor** no *IP Address Whitelist* — a Shopee
  exige isso para todos os apps, e depois de ativado só os IPs declarados
  conseguem chamar a API.
- A autorização da loja vale **no máximo 365 dias** (o vendedor escolhe); o
  card mostra a data de expiração após o teste. Contas principais (várias
  lojas) são aceitas; o hub publica na primeira loja autorizada.
- **Antes de criar**, o hub consulta e valida tudo o que a categoria exige:
  - categoria: `category_shopee`, padrão do card ou recomendação por título + capa;
  - **limites** (`get_item_limit`): tamanho do título/descrição, nº de fotos,
    faixa de preço, estoque, GTIN, peso/dimensão obrigatórios, tabela de
    medidas e prazo de postagem;
  - **atributos** obrigatórios (`get_attribute_tree`), respeitando o tipo de
    campo: lista fechada, lista + valor livre, texto, múltipla escolha, número
    inteiro, **unidade** (ex.: `"2,5 L"`) e **data** (`"03/2026"`). Atributos
    filhos do valor escolhido também são tratados;
  - **marca** (`get_brand_list`, todas as páginas); marca não cadastrada na
    Shopee vira "Sem marca" com aviso;
  - **GTIN** pela regra da categoria: *Mandatory* (exige EAN válido, com
    dígito verificador), *Flexible* (envia `"00"` se não houver) ou *Optional*;
  - **canais logísticos** ativos (`enabled` e `mask_channel_id = 0`),
    descartando os que não comportam o peso/medidas ou exigem configuração
    manual de frete.
- **Variações** (tênis, roupas): até 2 níveis e 50 combinações, no formato
  padronizado `standardise_tier_variation` (o `tier_variation` foi
  descontinuado em 09/2025). "Cor"/"Tamanho" casam com "Color"/"Size"; opção
  fora da lista vai pelo nome. Variação que não existe na lista padronizada
  (ex.: "Estampa") cai na estrutura livre, com aviso. Uma foto por opção do
  1º nível (ex.: por cor). No BR, a variação mais cara não pode passar de **4×**
  a mais barata. O anúncio nasce oculto e só é listado depois que as variações
  existem; se a criação das variações falhar, o id do anúncio é guardado para
  não duplicar.
- **Tabela de medidas**: `sizeChart` (URL da imagem) ou `sizeChartId` (modelo
  da loja). Categorias que exigem tabela recusam o produto sem ela.
- **Pré-venda**: `daysToShip` acima do prazo padrão vira pré-venda, se a
  categoria permitir e dentro da faixa dela.
- **Fiscal (BR)**: `ncm`, `cest`, `origem` (ou o objeto `tax`) vão em `tax_info`.
- **Vídeo**: só MP4 até 30 MB (10 a 60 s), enviado em partes de 4 MB. Se a
  Shopee ainda estiver processando, o anúncio sai sem vídeo e o hub volta
  depois para anexá-lo.
- **Atualização**: `update_item` só quando título, descrição, fotos, atributos
  etc. mudam (a Shopee revalida o anúncio inteiro a cada edição); preço e
  estoque por modelo, só dos que mudaram. Inativo = deslistar (não apaga).
- **Desconto**: começa ao menos 1 h no futuro e dura menos de 180 dias (o hub
  ajusta e avisa). Com desconto ativo a Shopee não deixa mudar o preço
  original: isso vira aviso no log, sem travar o resto.
- Falhas parciais que a Shopee devolve com sucesso HTTP (`failure_list`,
  `error_list`) são verificadas em todas as chamadas em lote.

### TikTok Shop
Conector conferido com a referência oficial (<https://partner.tiktokshop.com/docv2>).

- Crie o app no TikTok Shop Partner Center (<https://partner.tiktokshop.com>).
- Informe **App Key**, **App Secret** e **Service ID**; cadastre o callback no app.
  Lojas dos EUA usam o host de autorização `services.us.tiktokshop.com`.
- A loja (`shop_cipher`, região) e o armazém de vendas ativo são descobertos
  automaticamente.
- **Categoria:** `category_tiktok` no produto, categoria padrão ou recomendação
  por título + descrição + fotos. Categoria recomendada sem permissão para a
  loja (`INVITE_ONLY`, `PROHIBITED`…) vira erro explicativo.
- **Atributos obrigatórios da categoria** são consultados e casados com
  `attributes` do produto (chave = nome ou id do atributo na TikTok, valor =
  nome ou id da opção). Se faltar algum, o erro lista quais são e as opções.
- **Fotos** (até 9, máx. 10 MB) e **vídeo** (máx. 100 MB; MP4, MOV, WEBM…) são
  enviados à TikTok. O nome do vídeo é saneado (sem espaços nem pontos extras).
- **Estoque**: a TikTok só aceita de 1 a 99.999 por SKU. Produto sem estoque ou
  inativo é **desativado** (e reativado quando o estoque volta); se ainda não
  existir na TikTok, a criação é adiada (status `skipped`).
- **Atualização sem auditoria desnecessária:** preço e estoque usam os
  endpoints próprios (publicação imediata); título, descrição, fotos, vídeo,
  peso e atributos só são reenviados (Partial Edit 202509, que dispara nova
  auditoria) quando mudam de fato.
- **GTIN/EAN** vai só na criação (a TikTok só permite alterá-lo em rascunho).
- **Promoção:** campanha `FIXED_PRICE` por produto; removida do produto quando
  o `promoPrice` some. Mudança de preço com promoção ativa pode ser recusada
  pela TikTok (vira aviso no log).
- Criação com `idempotency_key`: uma nova tentativa após queda de rede não
  duplica o produto.
- *Get Authorized Category Assets* (`/authorization/202405/category_assets`)
  é da autorização de **parceiro** (APIs de Affiliate Partner / TAP) e não se
  aplica à publicação de produtos do vendedor; o hub não o utiliza.

## API para o site

Autenticação: cabeçalho `X-Api-Key: azh_...` (gerada na instalação, renovável
na aba **Integração**).

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/api/v1/products` | Cria/atualiza 1 produto, uma lista ou `{ "products": [...] }` (até 1000) |
| `GET` | `/api/v1/products/:sku` | Produto + status em cada plataforma |
| `DELETE` | `/api/v1/products/:sku` | Desativa: zera o estoque nas plataformas (não apaga o anúncio) |

Formato do produto:

```json
{
  "sku": "CAM-001",
  "title": "Camiseta Algodão Azul",
  "description": "Texto ou HTML",
  "brand": "Minha Marca", "model": "Básica", "gtin": "7891234567895",
  "condition": "new",
  "price": 89.90,
  "promoPrice": 69.90,
  "promoStart": "2026-11-01T00:00:00-03:00",
  "promoEnd": "2026-11-30T23:59:59-03:00",
  "stock": 25,
  "weightKg": 0.3, "lengthCm": 30, "widthCm": 25, "heightCm": 3,
  "images": ["https://meusite.com/img/1.jpg"],
  "videos": ["https://meusite.com/video/1.mp4", "https://youtu.be/XXXXXXXXXXX"],
  "categories": { "mercadolivre": "MLB31447", "shopee": 100017, "tiktok": "601226" },
  "attributes": { "Material": "Algodão", "Capacidade": "2,5 L" },
  "sizeChart": "https://meusite.com/img/tabela-medidas.png",
  "daysToShip": 10,
  "ncm": "61091000",
  "active": true,
  "variants": [
    { "sku": "CAM-001-AZ-P", "options": { "Cor": "Azul", "Tamanho": "P" }, "price": 89.90, "stock": 5,
      "gtin": "7891234567895", "images": ["https://meusite.com/img/azul.jpg"] },
    { "sku": "CAM-001-AZ-M", "options": { "Cor": "Azul", "Tamanho": "M" }, "price": 89.90, "stock": 3 }
  ]
}
```

Obrigatórios: `sku`, `title`, `price > 0` e ao menos 1 imagem. A resposta traz
`received`, `changed`, `unchanged` e `invalid` (com o motivo de cada um).

- `attributes`: a chave é o **nome** (ou id) do atributo na plataforma e o
  valor é o nome (ou id) da opção. Quando falta um atributo obrigatório, o log
  diz qual é e lista as opções.
- `variants`: todas as variações precisam ter as mesmas chaves em `options`.
  Preço/estoque do produto passam a ser derivados delas; `promoPrice` do
  produto vale para as variações sem promoção própria.
- **Variações no Mercado Livre e no TikTok Shop ainda não são publicadas**
  (o produto fica com erro explicativo nesses dois); a Shopee já publica.

### Variações vindas do banco do site

Uma linha por variação, com `parent_sku` (o SKU do produto) e colunas
`option_<Nome>`:

```sql
SELECT p.codigo AS parent_sku, v.sku, p.nome AS title, p.descricao AS description,
       v.preco AS price, v.estoque AS stock, v.ean AS gtin, p.imagens AS images,
       v.imagem AS variant_images, v.cor AS option_Cor, v.tamanho AS option_Tamanho
FROM variacoes v JOIN produtos p ON p.id = v.produto_id
```

## Segurança

- Credenciais e tokens das plataformas e a senha do banco do site ficam
  **cifrados** (AES-256-GCM) no banco interno. O painel nunca devolve um
  segredo: mostra só os 4 últimos caracteres.
- Senha do painel com scrypt; sessão em cookie `HttpOnly` (`Secure` quando a
  URL é HTTPS); login bloqueia por 10 minutos após 5 erros.
- A chave de API é guardada só como hash.
- A consulta da fonte precisa começar com `SELECT`/`WITH`, mas **use um usuário
  de banco somente-leitura**: essa é a proteção real.
- OAuth com `state` de uso único (expira em 15 min).

## Estrutura

```
src/
  server.js            servidor HTTP (sem Express) + arquivos do painel
  config.js            .env e caminhos
  routes/api.js        instalação, login, cards, produtos, fila, OAuth
  lib/store.js         banco interno (node:sqlite)
  lib/crypto.js        cofre AES-GCM, scrypt, HMAC
  lib/media.js         cliente HTTP comum + download de fotos/vídeos
  source/              leitura do banco do site, modelos de consulta, normalização
  platforms/           mercadolivre.js, shopee.js, tiktok.js (+ index: tokens/refresh)
  sync/engine.js       fila, reenvio com backoff, importação automática
public/                painel (HTML/CSS/JS puro)
test/                  node:test (APIs das plataformas simuladas)
```

Testes: `npm test` (50 casos: instalação, autenticação, cofre, publicação nas
três plataformas, regras do TikTok e da Shopee — esta com cenários de **tênis**
(2 níveis de variação, GTIN obrigatório, foto por cor, tabela de medidas),
**roupa** (tamanho padronizado/livre, marca desconhecida, GTIN "00") e
**utensílio doméstico** (atributos com unidade/data, pré-venda, NCM, canal por
peso) —, variações vindas do banco, backoff e falha parcial).

## Antes de ir para produção

Itens que o beta **ainda não cobre** ou que precisam ser conferidos nos sandboxes:

- [ ] **Validar nos sandboxes reais** com apps de teste das três plataformas
      (TikTok e Shopee já foram conferidos contra a documentação oficial; falta
      a chamada real). Na Shopee, conferir em especial o endpoint de variações
      padronizadas (a referência cita `get_variation_tree` e os exemplos
      `get_variations`; o hub tenta os dois) e a estrutura livre de variação.
- [ ] **Atributos obrigatórios por categoria** no Mercado Livre (TikTok e
      Shopee já consultam e validam).
- [ ] **Variações no Mercado Livre e no TikTok Shop** (a Shopee já publica).
- [ ] **Vídeo no Mercado Livre** por arquivo (clips); hoje só YouTube.
- [ ] **Webhooks/notificações** das plataformas (pedidos, perguntas, mudança
      de status do anúncio) — o beta é só de envio (site → marketplaces).
- [ ] Shopee: canais de frete `SIZE_SELECTION`/`CUSTOM_PRICE` (exigem tamanho ou valor por produto) e produtos de lojas cross-border CNSC/KRSC (API de produto global).
- [ ] Declarar o IP da VPS no IP Address Whitelist da Shopee antes de produção.
- [ ] Hospedagem: subir na VPS com HTTPS (ex.: `https://azuresystem.com.br/azurehub`).

Documentação de referência:
[Mercado Livre](https://developers.mercadolivre.com.br/pt_br/api-docs-pt-br) ·
[Shopee Open Platform](https://open.shopee.com/developer-guide/211) ·
[TikTok Shop Partner](https://partner.tiktokshop.com/docv2/page/create-product-202309) ·
[Plug4Market](https://api.plug4market.com.br/docs) (referência de modelo de hub) ·
[projetos no GitHub](https://github.com/topics/api-mercado-livre).
