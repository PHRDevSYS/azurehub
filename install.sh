#!/usr/bin/env bash
# Instalação do AzureHub em Linux (VPS). Uso: bash install.sh
set -euo pipefail
cd "$(dirname "$0")"

need_major=22
if ! command -v node >/dev/null; then
  echo "Node.js não encontrado. Instale o Node ${need_major}+ (https://nodejs.org)." >&2; exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt "$need_major" ]; then
  echo "Node $(node -v) é antigo; o AzureHub exige ${need_major}.13 ou mais novo." >&2; exit 1
fi

echo "› Instalando drivers de banco (MySQL e PostgreSQL)…"
npm install --omit=dev --no-audit --no-fund

if [ ! -f .env ]; then
  cp .env.example .env
  secret=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
  sed -i "s|^HUB_SECRET=.*|HUB_SECRET=${secret}|" .env
  echo "› .env criado com HUB_SECRET novo. Ajuste PUBLIC_URL antes de conectar as plataformas."
fi
mkdir -p data

cat <<MSG

AzureHub pronto.
  Iniciar:            npm start
  Como serviço:       veja "Rodar como serviço (systemd)" no README.md
  Depois abra PUBLIC_URL no navegador e siga o assistente de instalação.
MSG
