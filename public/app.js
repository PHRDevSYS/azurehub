'use strict';
// Painel do AzureHub: instalação → login → 3 cards de plataformas + abas.
const $app = document.getElementById('app');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const when = (v) => (v ? new Date(v).toLocaleString('pt-BR') : '—');

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error(data.error || 'Sessão expirada'); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), isErr ? 8000 : 3500);
}

async function busy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Aguarde…';
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; btn.textContent = label; }
}

// Diálogo genérico com formulário; resolve com os valores ou null.
function dialog(title, html, okLabel = 'Salvar') {
  const dlg = document.getElementById('dlg');
  document.getElementById('dlg-title').textContent = title;
  document.getElementById('dlg-body').innerHTML = html;
  document.getElementById('dlg-ok').textContent = okLabel;
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      const values = {};
      dlg.querySelectorAll('[name]').forEach((el) => { values[el.name] = el.type === 'checkbox' ? el.checked : el.value; });
      resolve(values);
    };
  });
}

function field(f, value) {
  const help = f.help ? `<span class="help">${esc(f.help)}</span>` : '';
  const input = f.type === 'select'
    ? `<select name="${f.key}">${f.options.map((o) => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
    : `<input name="${f.key}" type="${f.type === 'password' ? 'password' : 'text'}" value="${esc(value)}" ${f.required ? 'required' : ''} autocomplete="off">`;
  return `<label>${esc(f.label)}${f.required ? ' *' : ''}${help}</label>${input}`;
}

// ---------------- formulário da fonte de dados (instalação e aba Fonte) ----------------
function sourceForm(s = {}, presets = {}) {
  const t = s.type || 'mysql';
  return `
    <label>Tipo de banco do site</label>
    <select name="type" id="src-type">
      <option value="mysql" ${t === 'mysql' ? 'selected' : ''}>MySQL / MariaDB</option>
      <option value="postgres" ${t === 'postgres' ? 'selected' : ''}>PostgreSQL</option>
      <option value="sqlite" ${t === 'sqlite' ? 'selected' : ''}>SQLite (arquivo)</option>
      <option value="api" ${t === 'api' ? 'selected' : ''}>Nenhum — o site envia os produtos pela API</option>
    </select>
    <div id="src-db">
      <div class="row net">
        <div><label>Host</label><input name="host" value="${esc(s.host)}" placeholder="db.meusite.com.br"></div>
        <div><label>Porta</label><input name="port" value="${esc(s.port)}" placeholder="3306"></div>
      </div>
      <div class="row net">
        <div><label>Usuário</label><input name="user" value="${esc(s.user)}" placeholder="usuário somente-leitura" autocomplete="off"></div>
        <div><label>Senha</label><input name="password" type="password" value="${esc(s.password)}" autocomplete="new-password"></div>
      </div>
      <label>Banco de dados <span class="help">No SQLite, o caminho do arquivo</span></label>
      <input name="database" value="${esc(s.database)}">
      <label class="switch net"><input type="checkbox" name="ssl" ${s.ssl ? 'checked' : ''}> Conexão SSL</label>
      <label>Consulta de produtos (SELECT)
        <span class="help">As colunas usam os nomes do hub: sku, title, description, price, promo_price, stock, images, videos…</span></label>
      <div class="toolbar">${Object.entries(presets).map(([k, p]) => `<button type="button" class="ghost" data-preset="${k}">Modelo: ${esc(p.label)}</button>`).join('')}</div>
      <textarea name="query" class="mono" spellcheck="false">${esc(s.query || (presets.generico && presets.generico.query) || '')}</textarea>
    </div>`;
}

function wireSourceForm(root, presets) {
  const type = root.querySelector('#src-type');
  const sync = () => {
    root.querySelector('#src-db').classList.toggle('hidden', type.value === 'api');
    root.querySelectorAll('.net').forEach((el) => el.classList.toggle('hidden', type.value === 'sqlite'));
    const port = root.querySelector('[name=port]');
    port.placeholder = type.value === 'postgres' ? '5432' : '3306';
  };
  type.onchange = sync;
  sync();
  root.querySelectorAll('[data-preset]').forEach((b) => {
    b.onclick = () => { root.querySelector('[name=query]').value = presets[b.dataset.preset].query; };
  });
}

function readSourceForm(root) {
  const v = (n) => root.querySelector(`[name=${n}]`);
  return {
    type: v('type').value, host: v('host').value.trim(), port: v('port').value.trim(),
    user: v('user').value.trim(), password: v('password').value, database: v('database').value.trim(),
    ssl: v('ssl').checked, query: v('query').value.trim(),
  };
}

function renderSample(res) {
  if (!res.sample || !res.sample.length) return `<p class="muted">${esc(res.note || `${res.count} linhas retornadas.`)}</p>`;
  return `<p><span class="badge ok">Conexão OK</span> ${res.count} produtos encontrados. Amostra:</p>
    <div class="table-wrap"><table><tr><th>SKU</th><th>Título</th><th>Preço</th><th>Promo</th><th>Estoque</th><th>Mídia</th><th>Validação</th></tr>
    ${res.sample.map(({ product: p, errors }) => `<tr><td>${esc(p.sku)}</td><td>${esc(p.title)}</td><td>${money(p.price)}</td>
      <td>${money(p.promoPrice)}</td><td>${p.stock}</td><td>${p.images.length} fotos, ${p.videos.length} vídeos</td>
      <td>${errors.length ? `<span class="lvl-error">${esc(errors.join('; '))}</span>` : '<span class="badge ok">ok</span>'}</td></tr>`).join('')}
    </table></div>`;
}

// ---------------- instalação ----------------
async function showInstall() {
  const presets = await api('/api/source/presets');
  let step = 1;
  const state = { email: '', password: '', source: null, autoImportMinutes: 30 };

  const draw = () => {
    const steps = ['Administrador', 'Banco de dados do site', 'Concluir'].map((s, i) => `<span class="${i + 1 === step ? 'on' : ''}">${i + 1}. ${s}</span>`).join('');
    let body = '';
    if (step === 1) {
      body = `<p class="muted">Crie o acesso de administrador do hub.</p>
        <label>E-mail</label><input id="i-email" type="email" value="${esc(state.email)}" autocomplete="username">
        <label>Senha (mín. 8 caracteres)</label><input id="i-pass" type="password" value="${esc(state.password)}" autocomplete="new-password">
        <div class="actions"><button class="primary" id="next">Continuar</button></div>`;
    } else if (step === 2) {
      body = `<p class="muted">Informe o banco de dados onde o site guarda os produtos. O hub só <b>lê</b> esse banco.</p>
        <div id="src">${sourceForm(state.source || {}, presets)}</div>
        <label>Importar automaticamente a cada (minutos) <span class="help">0 = só manual</span></label>
        <input id="i-auto" type="number" min="0" value="${state.autoImportMinutes}">
        <div id="test-out"></div>
        <div class="actions"><button class="ghost" id="back">Voltar</button><button id="test">Testar conexão</button><button class="primary" id="next">Continuar</button></div>`;
    } else {
      const s = state.source;
      body = `<p>Tudo pronto para instalar:</p>
        <ul><li>Administrador: <b>${esc(state.email)}</b></li>
        <li>Fonte: <b>${s.type === 'api' ? 'somente API' : `${esc(s.type)} — ${esc(s.host || s.database)}`}</b></li>
        <li>Importação automática: <b>${state.autoImportMinutes ? `a cada ${state.autoImportMinutes} min` : 'manual'}</b></li></ul>
        <p class="muted">Ao instalar, é gerada a <b>chave de API</b> que o seu site usa para enviar produtos. Ela é mostrada uma única vez.</p>
        <div class="actions"><button class="ghost" id="back">Voltar</button><button class="primary" id="install">Instalar AzureHub</button></div>`;
    }
    $app.innerHTML = `<div class="narrow"><h1>Instalação</h1><div class="steps">${steps}</div><div class="panel">${body}</div></div>`;

    const back = document.getElementById('back');
    if (back) back.onclick = () => { if (step === 2) state.source = readSourceForm(document.getElementById('src')); step--; draw(); };
    if (step === 1) {
      document.getElementById('next').onclick = () => {
        state.email = document.getElementById('i-email').value.trim();
        state.password = document.getElementById('i-pass').value;
        if (!/^\S+@\S+\.\S+$/.test(state.email)) return toast('E-mail inválido', true);
        if (state.password.length < 8) return toast('A senha precisa de ao menos 8 caracteres', true);
        step = 2; draw();
      };
    }
    if (step === 2) {
      const root = document.getElementById('src');
      wireSourceForm(root, presets);
      const collect = () => { state.source = readSourceForm(root); state.autoImportMinutes = Number(document.getElementById('i-auto').value || 0); };
      document.getElementById('test').onclick = (e) => busy(e.target, async () => {
        collect();
        const res = await api('/api/source/test', { method: 'POST', body: state.source });
        document.getElementById('test-out').innerHTML = renderSample(res);
      });
      document.getElementById('next').onclick = () => { collect(); step = 3; draw(); };
    }
    if (step === 3) {
      document.getElementById('install').onclick = (e) => busy(e.target, async () => {
        const res = await api('/api/install', { method: 'POST', body: state });
        await showApiKey(res.apiKey, 'Instalação concluída');
        showDashboard();
      });
    }
  };
  draw();
}

async function showApiKey(key, title) {
  await dialog(title, `<p>Guarde esta <b>chave de API</b>. Ela não será exibida de novo.</p>
    <div class="apikey"><input readonly value="${esc(key)}" id="k"><button type="button" onclick="navigator.clipboard.writeText(document.getElementById('k').value)">Copiar</button></div>
    <p class="muted">O site envia produtos com o cabeçalho <code>X-Api-Key</code> — veja a aba <b>Integração</b>.</p>`, 'Entendi');
}

// ---------------- login ----------------
function showLogin() {
  document.getElementById('btn-logout').classList.add('hidden');
  $app.innerHTML = `<div class="narrow"><div class="panel"><h1>Entrar</h1>
    <form id="login"><label>E-mail</label><input name="email" type="email" required autocomplete="username">
    <label>Senha</label><input name="password" type="password" required autocomplete="current-password">
    <div class="actions"><button class="primary">Entrar</button></div></form></div></div>`;
  document.getElementById('login').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    busy(e.submitter || e.target.querySelector('button'), async () => {
      await api('/api/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
      showDashboard();
    });
  };
}

// ---------------- dashboard ----------------
let currentTab = 'produtos';

async function showDashboard() {
  document.getElementById('btn-logout').classList.remove('hidden');
  $app.innerHTML = `
    <h1>Integrações</h1>
    <p class="muted">Configure as credenciais de cada marketplace, conecte a conta e ative a sincronização.</p>
    <div class="cards" id="cards"></div>
    <div class="tabs" id="tabs">
      ${[['produtos', 'Produtos'], ['fila', 'Fila'], ['logs', 'Logs'], ['fonte', 'Fonte de dados'], ['integracao', 'Integração (API)']]
        .map(([k, l]) => `<button data-tab="${k}" class="${k === currentTab ? 'on' : ''}">${l}</button>`).join('')}
    </div>
    <div id="tab"></div>`;
  document.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => {
      currentTab = b.dataset.tab;
      document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
      renderTab();
    };
  });
  await renderCards();
  renderTab();
}

async function renderCards() {
  const list = await api('/api/platforms');
  document.getElementById('cards').innerHTML = list.map((p) => {
    const status = p.connected ? '<span class="badge ok">Conectado</span>'
      : p.configured ? '<span class="badge warn">Falta conectar</span>' : '<span class="badge">Não configurado</span>';
    return `<article class="card" data-id="${p.id}">
      <div class="card-head" style="background:${p.color};color:${p.textColor}">${esc(p.name)} ${status}</div>
      <div class="card-body"><dl>
        <dt>Conta</dt><dd>${esc(p.account || '—')}</dd>
        <dt>Token até</dt><dd>${when(p.tokenExpiresAt)}</dd>
        <dt>Publicados</dt><dd>${p.stats.synced}</dd>
        <dt>Com erro</dt><dd>${p.stats.error ? `<span class="lvl-error">${p.stats.error}</span>` : 0}</dd>
        <dt>Redirect</dt><dd><code>${esc(p.redirectUri)}</code></dd>
      </dl></div>
      <div class="card-foot">
        <button data-act="creds">Credenciais</button>
        <button data-act="connect" ${p.configured ? '' : 'disabled'}>${p.connected ? 'Reconectar' : 'Conectar'}</button>
        <button data-act="test" ${p.connected ? '' : 'disabled'}>Testar</button>
        <button data-act="sync" ${p.enabled ? '' : 'disabled'}>Sincronizar</button>
        <label class="switch"><input type="checkbox" data-act="enable" ${p.enabled ? 'checked' : ''} ${p.connected ? '' : 'disabled'}> Ativo</label>
        ${p.connected ? '<button data-act="disconnect" class="ghost danger">Desconectar</button>' : ''}
      </div></article>`;
  }).join('');

  document.querySelectorAll('.card').forEach((card) => {
    const p = list.find((x) => x.id === card.dataset.id);
    card.querySelectorAll('[data-act]').forEach((el) => {
      const act = el.dataset.act;
      if (act === 'enable') {
        el.onchange = async () => {
          try { await api(`/api/platforms/${p.id}/enable`, { method: 'POST', body: { enabled: el.checked } }); toast(el.checked ? `${p.name} ativado` : `${p.name} pausado`); renderCards(); } catch (e) { toast(e.message, true); }
        };
        return;
      }
      el.onclick = () => busy(el, async () => {
        if (act === 'creds') {
          const html = `<p class="muted">Documentação: <a href="${esc(p.docsUrl)}" target="_blank" rel="noopener">${esc(p.docsUrl)}</a><br>
            Cadastre no app da plataforma a URL de retorno: <code>${esc(p.redirectUri)}</code></p>` +
            p.fields.map((f) => field(f, p.values[f.key])).join('');
          const values = await dialog(`Credenciais — ${p.name}`, html);
          if (!values) return;
          await api(`/api/platforms/${p.id}/credentials`, { method: 'PUT', body: values });
          toast('Credenciais salvas');
          renderCards();
        } else if (act === 'connect') {
          const { url } = await api(`/api/platforms/${p.id}/authorize`, { method: 'POST' });
          location.href = url;
        } else if (act === 'test') {
          const r = await api(`/api/platforms/${p.id}/test`, { method: 'POST' });
          toast(`Conexão OK: ${r.account}`);
          renderCards();
        } else if (act === 'sync') {
          const r = await api('/api/sync', { method: 'POST', body: { platform: p.id } });
          toast(`${r.queued} produtos na fila de ${p.name}`);
        } else if (act === 'disconnect') {
          if (!confirm(`Desconectar ${p.name}? A sincronização será pausada.`)) return;
          await api(`/api/platforms/${p.id}/disconnect`, { method: 'POST' });
          renderCards();
        }
      });
    });
  });
}

async function renderTab() {
  const el = document.getElementById('tab');
  el.innerHTML = '<p class="muted">Carregando…</p>';
  try {
    await TABS[currentTab](el);
  } catch (e) {
    el.innerHTML = `<p class="lvl-error">${esc(e.message)}</p>`;
  }
}

const PLAT_SHORT = { mercadolivre: 'ML', shopee: 'Shopee', tiktok: 'TikTok' };

function listingBadge(l) {
  if (!l) return '<span class="badge">—</span>';
  const cls = l.status === 'synced' ? (l.last_error ? 'warn' : 'ok') : l.status === 'error' ? 'err' : l.status === 'skipped' ? 'warn' : '';
  const title = [l.external_id && `ID ${l.external_id}`, l.last_error].filter(Boolean).join(' — ');
  return `<span class="badge ${cls}" title="${esc(title)}">${esc(l.status)}</span>`;
}

const TABS = {
  async produtos(el, search = '') {
    const data = await api(`/api/products?limit=100&q=${encodeURIComponent(search)}`);
    el.innerHTML = `<div class="toolbar">
        <input id="p-q" placeholder="Buscar SKU ou título" value="${esc(search)}">
        <button id="p-import" class="primary">Importar do banco agora</button>
        <button id="p-sync">Reenviar tudo</button>
        <span class="muted">${data.total} produtos</span></div>
      <div class="table-wrap"><table><tr><th></th><th>SKU</th><th>Título</th><th>Preço</th><th>Promo</th><th>Estoque</th>
        ${Object.values(PLAT_SHORT).map((n) => `<th>${n}</th>`).join('')}<th>Atualizado</th></tr>
      ${data.items.map((p) => `<tr><td>${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : ''}</td>
        <td>${esc(p.sku)}</td><td>${esc(p.title)}</td><td>${money(p.price)}</td><td>${money(p.promoPrice)}</td><td>${p.stock}</td>
        ${Object.keys(PLAT_SHORT).map((k) => `<td>${listingBadge(p.listings[k])}</td>`).join('')}
        <td>${when(p.updatedAt)}</td></tr>`).join('') || '<tr><td colspan="10" class="muted center">Nenhum produto ainda. Importe do banco ou envie pela API.</td></tr>'}
      </table></div>`;
    let t;
    el.querySelector('#p-q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => TABS.produtos(el, e.target.value).then(() => { const i = el.querySelector('#p-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }), 350); };
    el.querySelector('#p-import').onclick = (e) => busy(e.target, async () => {
      const r = await api('/api/source/import', { method: 'POST' });
      toast(r.note || `${r.received} lidos · ${r.changed} alterados · ${r.invalid.length} inválidos`);
      if (r.invalid.length) console.table(r.invalid);
      TABS.produtos(el, search);
    });
    el.querySelector('#p-sync').onclick = (e) => busy(e.target, async () => {
      const r = await api('/api/sync', { method: 'POST', body: {} });
      toast(`${r.queued} envios na fila (só plataformas ativas)`);
    });
  },

  async fila(el) {
    const data = await api('/api/jobs');
    const s = data.stats;
    el.innerHTML = `<div class="toolbar"><span>Na fila: <b>${s.queued || 0}</b> · Rodando: <b>${s.running || 0}</b> · Concluídos: <b>${s.done || 0}</b> · Com erro: <b class="lvl-error">${s.error || 0}</b></span>
      <button id="j-ref">Atualizar</button><button id="j-clear" class="ghost">Limpar concluídos</button></div>
      <div class="table-wrap"><table><tr><th>#</th><th>Plataforma</th><th>SKU</th><th>Status</th><th>Tentativas</th><th>Próx. tentativa</th><th>Erro</th></tr>
      ${data.items.map((j) => `<tr><td>${j.id}</td><td>${esc(PLAT_SHORT[j.platform])}</td><td>${esc(j.sku)}</td><td>${esc(j.status)}</td>
        <td>${j.attempts}</td><td>${j.status === 'queued' ? when(j.run_after) : '—'}</td><td class="lvl-error">${esc(j.error || '')}</td></tr>`).join('')}
      </table></div>`;
    el.querySelector('#j-ref').onclick = () => TABS.fila(el);
    el.querySelector('#j-clear').onclick = async () => { await api('/api/jobs/clear', { method: 'POST' }); TABS.fila(el); };
  },

  async logs(el) {
    const rows = await api('/api/logs');
    el.innerHTML = `<div class="toolbar"><button id="l-ref">Atualizar</button></div>
      <div class="table-wrap"><table><tr><th>Quando</th><th>Nível</th><th>Plataforma</th><th>SKU</th><th>Mensagem</th></tr>
      ${rows.map((l) => `<tr class="lvl-${l.level}"><td>${when(l.ts)}</td><td>${esc(l.level)}</td><td>${esc(PLAT_SHORT[l.platform] || '')}</td>
        <td>${esc(l.sku || '')}</td><td>${esc(l.message)}</td></tr>`).join('')}</table></div>`;
    el.querySelector('#l-ref').onclick = () => TABS.logs(el);
  },

  async fonte(el) {
    const [cfg, presets] = await Promise.all([api('/api/source'), api('/api/source/presets')]);
    el.innerHTML = `<div class="panel"><div id="src">${sourceForm(cfg.source || {}, presets)}</div>
      <label>Importar automaticamente a cada (minutos) <span class="help">0 = só manual</span></label>
      <input id="auto" type="number" min="0" value="${cfg.autoImportMinutes || 0}">
      <div id="test-out"></div>
      <div class="actions"><button id="test">Testar</button><button id="save" class="primary">Salvar</button></div></div>`;
    const root = el.querySelector('#src');
    wireSourceForm(root, presets);
    el.querySelector('#test').onclick = (e) => busy(e.target, async () => {
      el.querySelector('#test-out').innerHTML = renderSample(await api('/api/source/test', { method: 'POST', body: readSourceForm(root) }));
    });
    el.querySelector('#save').onclick = (e) => busy(e.target, async () => {
      await api('/api/source', { method: 'PUT', body: { source: readSourceForm(root), autoImportMinutes: Number(el.querySelector('#auto').value || 0) } });
      toast('Fonte de dados salva');
    });
  },

  async integracao(el) {
    const base = location.origin;
    el.innerHTML = `<div class="panel">
      <p>Além de ler o banco, o hub recebe produtos de <b>qualquer site</b> por HTTP. Cada envio entra na fila das plataformas ativas.</p>
      <h3>Enviar / atualizar produtos</h3>
      <pre>curl -X POST ${esc(base)}/api/v1/products \\
  -H "X-Api-Key: SUA_CHAVE" -H "Content-Type: application/json" \\
  -d '{
    "sku": "CAM-001",
    "title": "Camiseta Algodão Azul",
    "description": "Camiseta 100% algodão...",
    "brand": "Minha Marca",
    "gtin": "7891234567895",
    "price": 89.90,
    "promoPrice": 69.90,
    "promoStart": "2026-11-01T00:00:00-03:00",
    "promoEnd": "2026-11-30T23:59:59-03:00",
    "stock": 25,
    "weightKg": 0.3, "lengthCm": 30, "widthCm": 25, "heightCm": 3,
    "images": ["https://meusite.com/img/cam-001-1.jpg", "https://meusite.com/img/cam-001-2.jpg"],
    "videos": ["https://meusite.com/video/cam-001.mp4", "https://youtu.be/XXXXXXXXXXX"],
    "categories": { "mercadolivre": "MLB31447", "shopee": 100017, "tiktok": "601226" },
    "attributes": { "Material": "Algodão" },
    "sizeChart": "https://meusite.com/img/tabela.png",
    "variants": [
      { "sku": "CAM-001-AZ-P", "options": { "Cor": "Azul", "Tamanho": "P" }, "price": 89.90, "stock": 5 },
      { "sku": "CAM-001-AZ-M", "options": { "Cor": "Azul", "Tamanho": "M" }, "price": 89.90, "stock": 3 }
    ]
  }'</pre>
      <p class="muted"><code>attributes</code>: chave = nome do atributo na plataforma, valor = opção. <code>variants</code> (cor/tamanho) já publica na Shopee.</p>
      <p class="muted">Aceita um produto, uma lista <code>[...]</code> ou <code>{"products": [...]}</code> (até 1000 por envio).</p>
      <h3>Consultar status de um produto</h3>
      <pre>curl ${esc(base)}/api/v1/products/CAM-001 -H "X-Api-Key: SUA_CHAVE"</pre>
      <h3>Desativar (zera o estoque nas plataformas)</h3>
      <pre>curl -X DELETE ${esc(base)}/api/v1/products/CAM-001 -H "X-Api-Key: SUA_CHAVE"</pre>
      <div class="actions"><button id="rot" class="danger">Gerar nova chave de API</button></div></div>`;
    el.querySelector('#rot').onclick = (e) => busy(e.target, async () => {
      if (!confirm('A chave atual deixa de funcionar imediatamente. Continuar?')) return;
      const r = await api('/api/apikey/rotate', { method: 'POST' });
      await showApiKey(r.apiKey, 'Nova chave de API');
    });
  },
};

// ---------------- boot ----------------
document.getElementById('btn-logout').onclick = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); showLogin(); };

(async function boot() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('oauth')) {
    history.replaceState(null, '', location.pathname);
    if (hash.get('oauth') === 'ok') toast('Conta conectada com sucesso');
    else toast(`Falha ao conectar: ${hash.get('msg') || 'erro desconhecido'}`, true);
  }
  try {
    const st = await api('/api/status');
    document.getElementById('version').textContent = `v${st.version}`;
    if (!st.installed) return showInstall();
    await api('/api/me');
    showDashboard();
  } catch {
    /* api() já levou para o login em caso de 401 */
  }
})();
