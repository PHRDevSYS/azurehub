#!/usr/bin/env python3
"""Trabalhador opcional de raspagem do AzureHub, baseado no Scrapling
(https://github.com/D4Vinci/Scrapling, BSD-3).

Recebe um JSON na entrada padrão e devolve um JSON na saída padrão:

  entrada: {"url": "...", "item": ".produto", "title": ".nome::text",
            "price": ".preco::text", "link": "a::attr(href)",
            "browser": false, "user_agent": "AzureHubPriceBot/..."}
  saída:   {"ok": true, "items": [{"title": "...", "price": "R$ 10,90", "url": "..."}]}

O robots.txt e o intervalo entre requisições são verificados pelo AzureHub
(Node) antes de chamar este script. O robô se identifica pelo User-Agent e NÃO
usa os recursos de disfarce do Scrapling (cabeçalhos "stealth", referer do
Google, StealthyFetcher): o AzureHub não contorna bloqueios anti-robô de
terceiros. Páginas que dependem de JavaScript usam o DynamicFetcher.
Instalação:
  pip install "scrapling[fetchers]"      # Python 3.10+
  scrapling install                       # só para o modo navegador
"""
import json
import sys
from urllib.parse import urljoin


def first(node, selector):
    if not selector:
        return None
    try:
        value = node.css(selector).get()
    except Exception:
        return None
    return value.strip() if isinstance(value, str) else value


def main():
    try:
        req = json.load(sys.stdin)
    except Exception as exc:  # entrada inválida
        print(json.dumps({"ok": False, "error": f"entrada inválida: {exc}"}))
        return 2
    try:
        from scrapling.fetchers import Fetcher, DynamicFetcher
    except ImportError:
        print(json.dumps({"ok": False, "error": 'Scrapling não instalado: pip install "scrapling[fetchers]"'}))
        return 3

    url = req["url"]
    headers = {"User-Agent": req.get("user_agent") or "AzureHubPriceBot"}
    try:
        if req.get("browser"):
            page = DynamicFetcher.fetch(url, headless=True, network_idle=True, google_search=False,
                                        useragent=headers["User-Agent"], timeout=60000)
        else:
            page = Fetcher.get(url, headers=headers, stealthy_headers=False, timeout=30)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"falha ao buscar {url}: {exc}"}))
        return 4

    status = getattr(page, "status", 200)
    if status and int(status) >= 400:
        print(json.dumps({"ok": False, "error": f"{url} respondeu HTTP {status}"}))
        return 5

    items = []
    for node in page.css(req["item"])[:40]:
        title = first(node, req.get("title"))
        price = first(node, req.get("price"))
        link = first(node, req.get("link"))
        if title and price:
            items.append({"title": str(title), "price": str(price), "url": urljoin(url, str(link)) if link else url})
    print(json.dumps({"ok": True, "items": items}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
