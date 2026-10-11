'use strict';
// Painel do AzureHub.
// Fluxo: Integração (origem + destinos) → Produtos (selecionar o que foi
// capturado) → Prévia (como vai subir) → Sincronização (grade + detalhe).
// Fotos e vídeos só aparecem no detalhe da Sincronização.
const $app = document.getElementById('app');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => (v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const when = (v) => (v ? new Date(v).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '#');

const PLAT = { mercadolivre: 'Mercado Livre', shopee: 'Shopee', tiktok: 'TikTok Shop' };
const PLAT_SHORT = { mercadolivre: 'ML', shopee: 'Shopee', tiktok: 'TikTok' };
const STRATEGY = { minimo: 'mínimo', medio: 'médio', origem: 'origem', sugerido: 'sugerido', manual: 'manual' };
const STATUS = {
  pending: ['Aguardando', 'info'], synced: ['Sincronizado', 'ok'], error: ['Erro', 'err'],
  skipped: ['Adiado', 'warn'], paused: ['Pausado', ''],
};

const state = {
  selected: new Set(),          // SKUs marcados na tela Produtos
  targets: new Set(),           // destinos escolhidos para envio/prévia
  platforms: [],                // resumo dos 3 destinos
  products: { items: [], total: 0, q: '', filter: 'all' },
  sync: { q: '', platform: '', status: '', auto: true, picked: new Set(), tab: 'grade' },
  preview: null,                // { key, items, include, tab }
  modules: { pricing: false },  // módulos opcionais ativos
  pricing: { picked: new Set(), sel: new Set(), rows: [], poll: null, q: '', filter: 'all' }, // picked = escopo vindo de Produtos
};

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

const statusBadge = (status, extra = '') => {
  const [label, cls] = STATUS[status] || [status, ''];
  return `<span class="badge ${cls}" title="${esc(extra)}">${esc(label)}</span>`;
};

// ====================================================== formulário genérico
function field(f, value) {
  const help = f.help ? `<span class="help">${esc(f.help)}</span>` : '';
  const opts = (f.options || []).map((o) => (Array.isArray(o) ? o : [o, o]));
  const show = f.showIf ? ` data-show='${esc(JSON.stringify(f.showIf))}'` : '';
  let input;
  if (f.type === 'select') {
    input = `<select name="${f.key}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  } else if (f.type === 'checkbox') {
    return `<div class="fld"${show}><label class="switch"><input type="checkbox" name="${f.key}" ${value ? 'checked' : ''}> ${esc(f.label)}</label>${help}</div>`;
  } else if (f.type === 'sql') {
    input = `<textarea name="${f.key}" class="mono" spellcheck="false">${esc(value)}</textarea>`;
  } else {
    input = `<input name="${f.key}" type="${f.type === 'password' ? 'password' : 'text'}" value="${esc(value)}" placeholder="${esc(f.placeholder || '')}" autocomplete="off">`;
  }
  return `<div class="fld"${show}><label>${esc(f.label)}${f.required ? ' *' : ''}${help}</label>${input}</div>`;
}

function applyShowIf(root) {
  const val = (k) => { const el = root.querySelector(`[name="${k}"]`); return el ? el.value : undefined; };
  root.querySelectorAll('[data-show]').forEach((el) => {
    const cond = JSON.parse(el.dataset.show);
    el.classList.toggle('hidden', !Object.entries(cond).every(([k, vals]) => vals.includes(val(k))));
  });
}

function readFields(root) {
  const out = {};
  root.querySelectorAll('[name]').forEach((el) => { out[el.name] = el.type === 'checkbox' ? el.checked : el.value; });
  return out;
}

// ================================================================ origem
function originPicker(catalog, current) {
  const order = ['ERP', 'Site/loja', 'Banco de dados', 'API'];
  const list = [...catalog].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return `<div class="origins">${list.map((c) => `
    <button type="button" class="origin ${c.id === current ? 'on' : ''}" data-origin="${c.id}">
      <span class="kind">${esc(c.kind)}</span><b>${esc(c.name)}</b><small>${esc(c.description)}</small>
    </button>`).join('')}</div>
    <div id="origin-fields"></div>`;
}

function renderOriginFields(root, connector, values = {}) {
  const box = root.querySelector('#origin-fields');
  if (!connector) { box.innerHTML = ''; return; }
  const presets = connector.presets ? `<div class="toolbar">${Object.entries(connector.presets)
    .map(([k, p]) => `<button type="button" class="ghost" data-preset="${k}">Modelo: ${esc(p.label)}</button>`).join('')}</div>` : '';
  box.innerHTML = `
    ${connector.docsUrl ? `<p class="muted">Documentação: <a href="${esc(connector.docsUrl)}" target="_blank" rel="noopener">${esc(connector.docsUrl)}</a></p>` : ''}
    <div class="grid2">${connector.fields.filter((f) => f.type !== 'sql').map((f) => field(f, values[f.key] ?? f.default ?? '')).join('')}</div>
    ${connector.fields.filter((f) => f.type === 'sql').map((f) => field(f, values[f.key] ?? f.default ?? '') + presets).join('')}
    ${connector.oauth ? `<div class="callout">Cadastre no aplicativo da ${esc(connector.name)} a URL de redirecionamento:<br><code>${esc(connector.redirectUri)}</code></div>` : ''}
    ${connector.push ? '<div class="callout">Nesta origem o seu site envia os produtos ao hub. A chave de API e os exemplos aparecem abaixo depois de salvar.</div>' : ''}`;
  applyShowIf(box);
  box.querySelectorAll('select').forEach((s) => s.addEventListener('change', () => applyShowIf(box)));
  box.querySelectorAll('[data-preset]').forEach((b) => {
    b.onclick = () => { box.querySelector('[name=query]').value = connector.presets[b.dataset.preset].query; };
  });
}

function wireOriginPicker(root, catalog, initial, onChange) {
  let current = initial;
  root.querySelectorAll('[data-origin]').forEach((b) => {
    b.onclick = () => {
      current = b.dataset.origin;
      root.querySelectorAll('[data-origin]').forEach((x) => x.classList.toggle('on', x === b));
      renderOriginFields(root, catalog.find((c) => c.id === current), {});
      if (onChange) onChange(current);
    };
  });
  return () => current;
}

function sampleTable(res) {
  if (res.note) return `<p class="muted">${esc(res.note)}</p>`;
  if (!res.sample || !res.sample.length) return '<p class="muted">Conexão OK, mas nenhum produto retornado.</p>';
  return `<p><span class="badge ok">Conexão OK</span> ${res.count !== null && res.count !== undefined ? `${res.count} produtos encontrados. ` : ''}Amostra:</p>
    <div class="table-wrap"><table><tr><th>SKU</th><th>Título</th><th class="num">Preço</th><th class="num">Estoque</th><th class="num">Var.</th><th>Mídia</th><th>Validação</th></tr>
    ${res.sample.map(({ product: p, errors }) => `<tr><td>${esc(p.sku)}</td><td>${esc(p.title)}</td><td class="num">${money(p.price)}</td>
      <td class="num">${p.stock}</td><td class="num">${(p.variants || []).length || '—'}</td><td>${p.images.length} fotos, ${p.videos.length} vídeos</td>
      <td>${errors.length ? `<span class="lvl-error">${esc(errors.join('; '))}</span>` : '<span class="badge ok">ok</span>'}</td></tr>`).join('')}
    </table></div>`;
}

// ============================================================ instalação
async function showInstall() {
  const catalog = await api('/api/sources');
  let step = 1;
  const st = { email: '', password: '', origin: 'database', values: {}, autoImportMinutes: 30 };

  const draw = () => {
    const steps = ['Administrador', 'Origem dos produtos', 'Concluir'].map((s, i) => `<span class="${i + 1 === step ? 'on' : ''}">${i + 1}. ${s}</span>`).join('');
    let body = '';
    if (step === 1) {
      body = `<p class="muted">Crie o acesso de administrador do hub.</p>
        <label>E-mail</label><input id="i-email" type="email" value="${esc(st.email)}" autocomplete="username">
        <label>Senha (mín. 8 caracteres)</label><input id="i-pass" type="password" value="${esc(st.password)}" autocomplete="new-password">
        <div class="actions"><button class="primary" id="next">Continuar</button></div>`;
    } else if (step === 2) {
      body = `<p class="muted">De onde vêm os produtos? Escolha o ERP, a loja, o banco de dados ou a API do seu site.</p>
        <div id="src">${originPicker(catalog, st.origin)}</div>
        <label>Capturar automaticamente a cada (minutos) <span class="help">0 = só manual</span></label>
        <input id="i-auto" type="number" min="0" value="${st.autoImportMinutes}">
        <div id="test-out"></div>
        <div class="actions"><button class="ghost" id="back">Voltar</button><button id="test">Testar conexão</button><button class="primary" id="next">Continuar</button></div>`;
    } else {
      const c = catalog.find((x) => x.id === st.origin);
      body = `<p>Tudo pronto para instalar:</p>
        <ul><li>Administrador: <b>${esc(st.email)}</b></li><li>Origem: <b>${esc(c.name)}</b></li>
        <li>Captura automática: <b>${st.autoImportMinutes ? `a cada ${st.autoImportMinutes} min` : 'manual'}</b></li></ul>
        ${c.oauth ? `<p class="callout">Depois de instalar, conclua a conexão com ${esc(c.name)} em <b>Integração › Origem › Conectar</b>.</p>` : ''}
        <p class="muted">Será gerada a <b>chave de API</b> do hub. Ela é mostrada uma única vez.</p>
        <div class="actions"><button class="ghost" id="back">Voltar</button><button class="primary" id="install">Instalar AzureHub</button></div>`;
    }
    $app.innerHTML = `<div class="narrow"><h1>Instalação</h1><div class="steps">${steps}</div><div class="panel">${body}</div></div>`;

    const collect = () => {
      const root = document.getElementById('src');
      if (!root) return;
      st.values = readFields(root.querySelector('#origin-fields'));
      st.autoImportMinutes = Number(document.getElementById('i-auto').value || 0);
    };
    const back = document.getElementById('back');
    if (back) back.onclick = () => { collect(); step--; draw(); };
    if (step === 1) {
      document.getElementById('next').onclick = () => {
        st.email = document.getElementById('i-email').value.trim();
        st.password = document.getElementById('i-pass').value;
        if (!/^\S+@\S+\.\S+$/.test(st.email)) return toast('E-mail inválido', true);
        if (st.password.length < 8) return toast('A senha precisa de ao menos 8 caracteres', true);
        step = 2; draw();
      };
    }
    if (step === 2) {
      const root = document.getElementById('src');
      const getOrigin = wireOriginPicker(root, catalog, st.origin, (id) => { st.origin = id; st.values = {}; });
      renderOriginFields(root, catalog.find((c) => c.id === st.origin), st.values);
      document.getElementById('test').onclick = (e) => busy(e.target, async () => {
        collect();
        const res = await api('/api/source/test', { method: 'POST', body: { type: getOrigin(), ...st.values } });
        document.getElementById('test-out').innerHTML = sampleTable(res);
      });
      document.getElementById('next').onclick = () => { collect(); st.origin = getOrigin(); step = 3; draw(); };
    }
    if (step === 3) {
      document.getElementById('install').onclick = (e) => busy(e.target, async () => {
        const res = await api('/api/install', {
          method: 'POST',
          body: { email: st.email, password: st.password, autoImportMinutes: st.autoImportMinutes, source: { type: st.origin, ...st.values } },
        });
        await showApiKey(res.apiKey, 'Instalação concluída');
        startApp('integracao');
      });
    }
  };
  draw();
}

async function showApiKey(key, title) {
  await dialog(title, `<p>Guarde esta <b>chave de API</b>. Ela não será exibida de novo.</p>
    <div class="apikey"><input readonly value="${esc(key)}" id="k"><button type="button" onclick="navigator.clipboard.writeText(document.getElementById('k').value)">Copiar</button></div>
    <p class="muted">O site envia produtos com o cabeçalho <code>X-Api-Key</code> (origem "API própria").</p>`, 'Entendi');
}

// ================================================================= login
function showLogin() {
  document.getElementById('btn-logout').classList.add('hidden');
  document.getElementById('nav').classList.add('hidden');
  $app.innerHTML = `<div class="narrow"><div class="panel"><h1>Entrar</h1>
    <form id="login"><label>E-mail</label><input name="email" type="email" required autocomplete="username">
    <label>Senha</label><input name="password" type="password" required autocomplete="current-password">
    <div class="actions"><button class="primary">Entrar</button></div></form></div></div>`;
  document.getElementById('login').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    busy(e.submitter || e.target.querySelector('button'), async () => {
      await api('/api/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
      startApp();
    });
  };
}

// =============================================================== rotas
const VIEWS = { integracao: viewIntegracao, produtos: viewProdutos, precificacao: viewPrecificacao, previa: viewPrevia, sincronizacao: viewSincronizacao };
let refreshTimer = null;

function startApp(view) {
  document.getElementById('btn-logout').classList.remove('hidden');
  document.getElementById('nav').classList.remove('hidden');
  if (view && location.hash !== `#${view}`) location.hash = view;
  else route();
}

async function route() {
  const view = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'produtos';
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.view === view));
  clearInterval(refreshTimer);
  clearInterval(state.pricing.poll);
  state.pricing.poll = null;
  $app.classList.toggle('wide', view === 'precificacao');
  $app.innerHTML = '<p class="muted center">Carregando…</p>';
  try {
    [state.platforms, state.modules] = await Promise.all([api('/api/platforms'), api('/api/modules')]);
    document.getElementById('nav-pricing').classList.toggle('hidden', !state.modules.pricing);
    await VIEWS[view]();
  } catch (e) {
    if (!/Sessão|Faça login/.test(e.message)) $app.innerHTML = `<p class="lvl-error">${esc(e.message)}</p>`;
  }
}
window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#oauth')) route(); });

const usable = (p) => p.connected && p.enabled;

// =========================================================== Integração
async function viewIntegracao() {
  const [catalog, src] = await Promise.all([api('/api/sources'), api('/api/source')]);
  const current = (src.source && src.source.type) || 'database';
  const cfg = src.source || {};
  const c = catalog.find((x) => x.id === current);
  const lc = src.lastCapture;
  $app.innerHTML = `
    <div class="view-head"><div><h1>Integração</h1><p class="muted">Defina de onde vêm os produtos (origem) e para onde vão (destinos).</p></div></div>
    <section class="block panel">
      <h2>1. Origem dos produtos</h2>
      <div class="status-line">
        <span>Origem atual: <b>${esc(c ? c.name : '—')}</b></span>
        ${c && c.oauth ? (src.connected ? '<span class="badge ok">Conectado</span>' : '<span class="badge warn">Falta conectar</span>') : '<span class="badge ok">Configurado</span>'}
        <span class="muted">Última captura: ${lc ? `${when(lc.at)} — ${lc.error ? `<span class="lvl-error">${esc(lc.error)}</span>` : `${lc.received} lidos, ${lc.changed} novos/alterados, ${lc.invalid} inválidos`}` : 'nunca'}</span>
      </div>
      <div id="src">${originPicker(catalog, current)}</div>
      <div class="grid2">
        <div><label>Capturar automaticamente a cada (minutos) <span class="help">0 = só manual</span></label>
        <input id="auto" type="number" min="0" value="${src.autoImportMinutes || 0}"></div>
      </div>
      <div id="test-out"></div>
      <div class="actions">
        ${c && c.oauth ? (src.connected ? '<button id="o-disconnect" class="ghost danger">Desconectar origem</button>' : `<button id="o-connect" ${src.oauthAvailable ? '' : 'disabled title="Salve as credenciais primeiro"'}>Conectar ${esc(c.name)}</button>`) : ''}
        <button id="o-test">Testar conexão</button>
        <button id="o-save" class="primary">Salvar origem</button>
        ${current !== 'api' ? '<button id="o-capture" class="primary">Capturar produtos agora</button>' : ''}
      </div>
      <div id="api-box"></div>
    </section>
    <section class="block">
      <h2>2. Destinos (marketplaces)</h2>
      <p class="muted">Configure as credenciais, conecte a conta e deixe <b>Ativo</b> os marketplaces que vão receber produtos.</p>
      <div class="cards" id="cards"></div>
    </section>
    <section class="block panel">
      <h2>3. Módulos</h2>
      <div class="status-line">
        <label class="switch"><input type="checkbox" id="mod-pricing" ${state.modules.pricing ? 'checked' : ''}> <b>Precificação</b></label>
        <span class="muted">Compara o preço de origem com produtos similares no mercado e define o preço de venda. Fica entre Produtos e Prévia.</span>
        ${state.modules.pricing ? '<a href="#precificacao">Abrir Precificação</a>' : ''}
      </div>
    </section>`;

  const root = document.getElementById('src');
  const getOrigin = wireOriginPicker(root, catalog, current, (id) => {
    document.getElementById('test-out').innerHTML = id !== current ? '<p class="muted">Origem alterada: salve para aplicar.</p>' : '';
  });
  renderOriginFields(root, c, cfg);
  const read = () => ({ type: getOrigin(), ...readFields(root.querySelector('#origin-fields')) });

  document.getElementById('o-test').onclick = (e) => busy(e.target, async () => {
    document.getElementById('test-out').innerHTML = sampleTable(await api('/api/source/test', { method: 'POST', body: read() }));
  });
  document.getElementById('o-save').onclick = (e) => busy(e.target, async () => {
    const res = await api('/api/source', { method: 'PUT', body: { source: read(), autoImportMinutes: Number(document.getElementById('auto').value || 0) } });
    toast('Origem salva');
    await viewIntegracao();
    if (res.test) document.getElementById('test-out').innerHTML = sampleTable(res.test);
  });
  const cap = document.getElementById('o-capture');
  if (cap) cap.onclick = (e) => busy(e.target, async () => {
    const r = await api('/api/source/import', { method: 'POST' });
    toast(`${r.received} lidos · ${r.changed} novos/alterados · ${r.invalid.length} inválidos`);
    await viewIntegracao();
  });
  const con = document.getElementById('o-connect');
  if (con) con.onclick = (e) => busy(e.target, async () => { location.href = (await api('/api/source/authorize', { method: 'POST' })).url; });
  const dis = document.getElementById('o-disconnect');
  if (dis) dis.onclick = (e) => busy(e.target, async () => {
    if (!confirm('Desconectar a origem? A captura deixa de funcionar até conectar de novo.')) return;
    await api('/api/source/disconnect', { method: 'POST' });
    await viewIntegracao();
  });
  if (current === 'api') renderApiBox(document.getElementById('api-box'));
  document.getElementById('mod-pricing').onchange = async (e) => {
    try {
      const r = await api('/api/pricing/settings', { method: 'PUT', body: { enabled: e.target.checked } });
      toast(`Precificação ${e.target.checked ? 'ativada' : 'desativada'}${r.queued ? ` · ${r.queued} reenvio(s) na fila` : ''}`);
      route();
    } catch (err) { toast(err.message, true); e.target.checked = !e.target.checked; }
  };
  await renderCards();
}

function renderApiBox(el) {
  const base = location.origin;
  el.innerHTML = `<div class="callout">
    <p><b>Enviar / atualizar produtos</b> (aparecem na tela Produtos para seleção):</p>
    <pre>curl -X POST ${esc(base)}/api/v1/products \\
  -H "X-Api-Key: SUA_CHAVE" -H "Content-Type: application/json" \\
  -d '{ "sku": "CAM-001", "title": "Camiseta Algodão", "price": 89.90, "promoPrice": 69.90,
        "stock": 25, "images": ["https://meusite.com/img/1.jpg"],
        "variants": [ { "sku": "CAM-001-P", "options": { "Tamanho": "P" }, "stock": 5 } ] }'</pre>
    <p>Para já enviar para integração, acrescente <code>?send=shopee,tiktok,mercadolivre</code> (ou <code>?send=all</code>).
    Consulta: <code>GET /api/v1/products/SKU</code> · desativar: <code>DELETE /api/v1/products/SKU</code>.</p>
    <div class="actions"><button id="rot" class="danger">Gerar nova chave de API</button></div></div>`;
  el.querySelector('#rot').onclick = (e) => busy(e.target, async () => {
    if (!confirm('A chave atual deixa de funcionar imediatamente. Continuar?')) return;
    await showApiKey((await api('/api/apikey/rotate', { method: 'POST' })).apiKey, 'Nova chave de API');
  });
}

async function renderCards() {
  const list = state.platforms = await api('/api/platforms');
  const el = document.getElementById('cards');
  if (!el) return;
  el.innerHTML = list.map((p) => {
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
        <label class="switch"><input type="checkbox" data-act="enable" ${p.enabled ? 'checked' : ''} ${p.connected ? '' : 'disabled'}> Ativo</label>
        ${p.connected ? '<button data-act="disconnect" class="ghost danger">Desconectar</button>' : ''}
      </div></article>`;
  }).join('');
  el.querySelectorAll('.card').forEach((card) => {
    const p = list.find((x) => x.id === card.dataset.id);
    card.querySelectorAll('[data-act]').forEach((b) => {
      const act = b.dataset.act;
      if (act === 'enable') {
        b.onchange = async () => {
          try { await api(`/api/platforms/${p.id}/enable`, { method: 'POST', body: { enabled: b.checked } }); toast(b.checked ? `${p.name} ativo` : `${p.name} pausado`); renderCards(); } catch (e) { toast(e.message, true); }
        };
        return;
      }
      b.onclick = () => busy(b, async () => {
        if (act === 'creds') {
          const html = `<p class="muted">Documentação: <a href="${esc(p.docsUrl)}" target="_blank" rel="noopener">${esc(p.docsUrl)}</a><br>
            Cadastre no app da plataforma a URL de retorno: <code>${esc(p.redirectUri)}</code></p>` + p.fields.map((f) => field(f, p.values[f.key])).join('');
          const values = await dialog(`Credenciais — ${p.name}`, html);
          if (!values) return;
          await api(`/api/platforms/${p.id}/credentials`, { method: 'PUT', body: values });
          toast('Credenciais salvas');
          renderCards();
        } else if (act === 'connect') {
          location.href = (await api(`/api/platforms/${p.id}/authorize`, { method: 'POST' })).url;
        } else if (act === 'test') {
          toast(`Conexão OK: ${(await api(`/api/platforms/${p.id}/test`, { method: 'POST' })).account}`);
          renderCards();
        } else if (act === 'disconnect') {
          if (!confirm(`Desconectar ${p.name}? A sincronização será pausada.`)) return;
          await api(`/api/platforms/${p.id}/disconnect`, { method: 'POST' });
          renderCards();
        }
      });
    });
  });
}

// ============================================================= Produtos
async function viewProdutos() {
  const pr = state.products;
  const src = await api('/api/source');
  const lc = src.lastCapture;
  $app.innerHTML = `
    <div class="view-head">
      <div><h1>Produtos</h1><p class="muted">Produtos capturados na origem. Selecione um ou vários e envie para os marketplaces.</p>
      <p class="muted">Última captura: ${lc ? `${when(lc.at)}${lc.error ? ` — <span class="lvl-error">${esc(lc.error)}</span>` : ` — ${lc.received} lidos, ${lc.invalid} inválidos`}` : 'nunca'}</p></div>
      ${src.connector && src.connector !== 'api' ? '<button id="capture" class="primary">Capturar agora</button>' : ''}
    </div>
    <div class="toolbar">
      <input id="q" placeholder="Buscar SKU, título ou marca" value="${esc(pr.q)}">
      <select id="filter" style="max-width:220px">
        ${[['all', 'Todos'], ['not_sent', 'Ainda não enviados'], ['sent', 'Enviados para integração'], ['error', 'Com erro']].map(([v, l]) => `<option value="${v}" ${pr.filter === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <span class="muted" id="count"></span>
    </div>
    <div class="table-wrap"><table id="grid"></table></div>
    <div class="more" id="more"></div>
    <div id="bar"></div>`;
  const cap = document.getElementById('capture');
  if (cap) cap.onclick = (e) => busy(e.target, async () => {
    const r = await api('/api/source/import', { method: 'POST' });
    toast(`${r.received} lidos · ${r.changed} novos/alterados · ${r.invalid.length} inválidos`);
    if (r.invalid.length) console.table(r.invalid);
    await loadProducts(true);
  });
  let t;
  document.getElementById('q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { pr.q = e.target.value; loadProducts(true); }, 350); };
  document.getElementById('filter').onchange = (e) => { pr.filter = e.target.value; loadProducts(true); };
  await loadProducts(true);
}

async function loadProducts(reset) {
  const pr = state.products;
  if (reset) pr.items = [];
  const data = await api(`/api/products?limit=100&offset=${pr.items.length}&q=${encodeURIComponent(pr.q)}&filter=${pr.filter}`);
  pr.items.push(...data.items);
  pr.total = data.total;
  drawProducts();
}

function destBadges(listings) {
  return `<span class="dest">${Object.keys(PLAT).map((id) => {
    const l = listings[id];
    if (!l) return '';
    const [label, cls] = STATUS[l.status] || [l.status, ''];
    const out = l.outdated && l.status === 'synced' ? ' · desatualizado' : '';
    return `<span class="badge ${cls}" title="${esc(`${PLAT[id]}: ${label}${out}${l.last_error ? ` — ${l.last_error}` : ''}`)}">${PLAT_SHORT[id]}${out ? ' ↻' : ''}</span>`;
  }).join('') || '<span class="muted">—</span>'}</span>`;
}

function drawProducts() {
  const pr = state.products;
  const allOn = pr.items.length && pr.items.every((p) => state.selected.has(p.sku));
  document.getElementById('count').textContent = `${pr.total} produtos`;
  document.getElementById('grid').innerHTML = `
    <tr><th><input type="checkbox" class="chk" id="all" ${allOn ? 'checked' : ''} title="Selecionar todos desta lista"></th>
    <th>SKU</th><th>Produto</th><th class="num">Preço</th><th class="num">Estoque</th><th class="num">Var.</th><th>Mídia</th><th>Atualizado</th><th>Destinos</th></tr>
    ${pr.items.map((p) => `<tr class="clickable ${state.selected.has(p.sku) ? 'sel' : ''}" data-sku="${esc(p.sku)}">
      <td><input type="checkbox" class="chk" ${state.selected.has(p.sku) ? 'checked' : ''}></td>
      <td class="nowrap">${esc(p.sku)}</td>
      <td class="prod">${esc(p.title)}<span class="sub">${esc([p.brand, p.active ? null : 'inativo na origem'].filter(Boolean).join(' · '))}</span></td>
      <td class="num">${p.promoPrice ? `<span class="strike">${money(p.price)}</span>${money(p.promoPrice)}` : money(p.price)}${p.salePrice ? `<span class="sub sale">venda ${money(p.salePrice)}</span>` : ''}</td>
      <td class="num">${p.stock}</td><td class="num">${p.variants || '—'}</td>
      <td class="nowrap">${p.images} foto${p.images === 1 ? "" : "s"}${p.videos ? ` · ${p.videos} vídeo${p.videos > 1 ? 's' : ''}` : ''}</td>
      <td class="nowrap">${when(p.updatedAt)}</td>
      <td>${destBadges(p.listings)}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">Nenhum produto. Configure a origem em Integração e capture os produtos.</td></tr>'}`;
  document.getElementById('more').innerHTML = pr.items.length < pr.total ? '<button id="load-more">Carregar mais</button>' : '';
  const more = document.getElementById('load-more');
  if (more) more.onclick = (e) => busy(e.target, () => loadProducts(false));
  document.getElementById('all').onchange = (e) => {
    pr.items.forEach((p) => (e.target.checked ? state.selected.add(p.sku) : state.selected.delete(p.sku)));
    drawProducts();
  };
  document.querySelectorAll('#grid tr[data-sku]').forEach((tr) => {
    tr.onclick = () => {
      const sku = tr.dataset.sku;
      if (state.selected.has(sku)) state.selected.delete(sku); else state.selected.add(sku);
      drawProducts();
    };
  });
  drawActionBar();
}

function targetToggles() {
  return state.platforms.map((p) => {
    const ok = usable(p);
    if (!ok) state.targets.delete(p.id);
    const why = !p.connected ? 'conecte a conta em Integração' : !p.enabled ? 'ative o destino em Integração' : '';
    return `<label class="switch" title="${esc(why)}"><input type="checkbox" data-target="${p.id}" ${state.targets.has(p.id) ? 'checked' : ''} ${ok ? '' : 'disabled'}> ${esc(p.name)}${ok ? '' : ' <span class="muted">(indisponível)</span>'}</label>`;
  }).join('');
}

function drawActionBar() {
  const bar = document.getElementById('bar');
  const n = state.selected.size;
  if (!n) { bar.innerHTML = ''; return; }
  if (!state.targets.size) state.platforms.filter(usable).forEach((p) => state.targets.add(p.id));
  bar.innerHTML = `<div class="actionbar">
    <b>${n} selecionado${n > 1 ? 's' : ''}</b>
    <div class="targets">${targetToggles()}</div>
    <button id="b-clear" class="ghost">Limpar</button>
    <button id="b-stop" class="ghost danger">Parar de sincronizar</button>
    ${state.modules.pricing ? '<button id="b-pricing">Precificar</button>' : ''}
    <button id="b-preview">Pré-visualizar</button>
    <button id="b-send" class="primary">Enviar para integração</button></div>`;
  bar.querySelectorAll('[data-target]').forEach((c) => {
    c.onchange = () => { if (c.checked) state.targets.add(c.dataset.target); else state.targets.delete(c.dataset.target); };
  });
  bar.querySelector('#b-clear').onclick = () => { state.selected.clear(); drawProducts(); };
  bar.querySelector('#b-preview').onclick = () => { state.preview = null; location.hash = 'previa'; };
  const bp = bar.querySelector('#b-pricing');
  if (bp) bp.onclick = () => { state.pricing.picked = new Set(state.selected); location.hash = 'precificacao'; };
  bar.querySelector('#b-send').onclick = (e) => busy(e.target, async () => {
    const targets = [...state.targets];
    if (!targets.length) throw new Error('Escolha ao menos um destino disponível');
    if (!confirm(`Enviar ${n} produto(s) para ${targets.map((t) => PLAT[t]).join(', ')}?`)) return;
    const r = await api('/api/integrations/send', { method: 'POST', body: { skus: [...state.selected], platforms: targets } });
    toast(`${r.queued} envios na fila`);
    state.selected.clear();
    location.hash = 'sincronizacao';
  });
  bar.querySelector('#b-stop').onclick = (e) => busy(e.target, async () => {
    if (!confirm('Parar de sincronizar os selecionados? Itens ainda não publicados saem da integração; publicados ficam pausados.')) return;
    await api('/api/integrations/stop', { method: 'POST', body: { skus: [...state.selected], platforms: [...state.targets] } });
    toast('Sincronização interrompida');
    await loadProducts(true);
  });
}

// ========================================================= Precificação
// Fica entre Produtos e Prévia quando o módulo está ativo. Compara a origem
// (teto) com o mercado e define o preço de venda, por produto ou em massa.
const brNum = (v) => Number(v).toFixed(2).replace('.', ',');
// "1.234,56", "1234,56" e "1234.56" → 1234.56
const parseBr = (v) => { const t = String(v).trim().replace(/[R$\s]/g, ''); return Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t); };
const pct = (v) => `${v > 0 ? '+' : ''}${Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
// Tem preço de venda definido ("origem" = segue a origem, sem número gravado).
const hasSale = (r) => r.price !== null || r.strategy === 'origem';
const PZ_FILTERS = [['all', 'Todos'], ['none', 'Sem pesquisa'], ['defined', 'Com preço definido'], ['undefined', 'Sem preço definido'], ['above', 'Acima da mediana'], ['below', 'Na mediana ou abaixo']];

async function viewPrecificacao() {
  const pz = state.pricing;
  if (!state.modules.pricing) {
    $app.innerHTML = `<div class="view-head"><div><h1>Precificação</h1></div></div>
      <div class="panel empty">O módulo de Precificação está inativo. Ative em <a href="#integracao">Integração › Módulos</a>.</div>`;
    return;
  }
  $app.innerHTML = `
    <div class="view-head">
      <div><h1>Precificação</h1><p class="muted">Compare o preço da origem com produtos similares no mercado e defina o preço de venda enviado aos marketplaces.</p>
      <p class="muted" id="pz-scope"></p></div>
      <div class="toolbar" style="margin:0">
        <a href="#produtos" class="btn-link">Voltar para Produtos</a>
        <button id="pz-settings">Fontes e regras</button>
        <button id="pz-research" class="primary">Pesquisar preços</button>
      </div>
    </div>
    <div id="pz-rules" class="callout legend"></div>
    <div id="pz-status" class="status-line" style="margin:12px 0 4px"></div>
    <div class="progress hidden" id="pz-prog"><i style="width:0"></i></div>
    <div class="toolbar" style="margin-top:12px">
      <input id="pz-q" placeholder="Filtrar SKU, título ou marca" value="${esc(pz.q || '')}">
      <select id="pz-filter" style="max-width:220px">${PZ_FILTERS.map(([v, l]) => `<option value="${v}" ${pz.filter === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span class="muted" id="pz-count"></span>
    </div>
    <div class="table-wrap"><table id="pz-grid"></table></div>
    <div id="pz-bar"></div>
    <div class="actions"><button id="pz-next" class="primary">Continuar para Prévia</button></div>`;
  document.getElementById('pz-settings').onclick = () => openPricingSettings();
  document.getElementById('pz-research').onclick = () => startResearch(pz.sel.size ? [...pz.sel] : pz.rows.map((r) => r.sku));
  let t;
  document.getElementById('pz-q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { pz.q = e.target.value; drawPricing(); }, 250); };
  document.getElementById('pz-filter').onchange = (e) => { pz.filter = e.target.value; drawPricing(); };
  document.getElementById('pz-next').onclick = () => {
    const next = pz.sel.size ? pz.sel : pz.picked;
    if (!next.size) { toast('Marque os produtos que vão para a Prévia', true); return; }
    state.selected = new Set(next);
    state.preview = null;
    location.hash = 'previa';
  };
  await loadPricing();
}

async function loadPricing() {
  const pz = state.pricing;
  const skus = [...pz.picked];
  const data = await api(`/api/pricing${skus.length ? `?skus=${encodeURIComponent(skus.join(','))}` : ''}`);
  pz.rows = data.items;
  pz.settings = data.settings;
  pz.sources = data.sources;
  for (const sku of [...pz.sel]) if (!pz.rows.some((r) => r.sku === sku)) pz.sel.delete(sku);
  if (!document.getElementById('pz-grid')) return;
  const cfg = data.settings;
  document.getElementById('pz-scope').innerHTML = skus.length
    ? `Escopo: <b>${pz.rows.length}</b> produto(s) escolhidos em Produtos · <a href="#" id="pz-all">ver todos</a>`
    : `Escopo: os <b>${pz.rows.length}</b> produtos mais recentes. Para restringir, selecione em <a href="#produtos">Produtos</a> e clique em <b>Precificar</b>.`;
  const all = document.getElementById('pz-all');
  if (all) all.onclick = (e) => { e.preventDefault(); pz.picked.clear(); pz.sel.clear(); loadPricing(); };
  const round = { 90: 'final ,90', 99: 'final ,99', cent: 'centavos' }[cfg.rounding] || cfg.rounding;
  document.getElementById('pz-rules').innerHTML = `
    <b>Origem</b> = preço praticado na origem${cfg.allowAboveOrigin ? ` · <b>Teto</b> = origem + ${esc(cfg.maxAbovePct)}%` : ' (teto)'} · <b>Mínimo</b> = menor preço encontrado no mercado ·
    <b>Médio</b> = meio-termo entre o mínimo e a origem · <b>Sugerido</b> = mediana do mercado − ${esc(cfg.undercutPct)}%, ${esc(round)}.
    Nenhum valor fica abaixo do <b>piso</b> (origem − ${esc(cfg.maxDiscountPct)}% ou custo + ${esc(cfg.minMarginPct)}%, o maior) nem acima do teto.
    ${cfg.showOriginAsList ? '<br>Envio: origem como preço “de” e o preço de venda como “por” (promoção).' : ''}
    ${data.sources.active ? '' : '<br><span class="lvl-warn">Nenhuma fonte de pesquisa ativa — cadastre em <b>Fontes e regras</b>.</span>'}`;
  drawResearchStatus(data.research);
  drawPricing();
  if (data.research.running && !pz.poll) pollResearch();
}

function pzVisible() {
  const pz = state.pricing;
  const q = (pz.q || '').trim().toLowerCase();
  return pz.rows.filter((r) => {
    if (q && ![r.sku, r.title, r.brand].some((v) => String(v || '').toLowerCase().includes(q))) return false;
    switch (pz.filter) {
      case 'none': return !r.collectedAt;
      case 'defined': return hasSale(r);
      case 'undefined': return !hasSale(r);
      case 'above': return r.belowMarket === false;
      case 'below': return r.belowMarket === true;
      default: return true;
    }
  });
}

// Botão de um valor de referência: um clique aplica a estratégia ao produto.
function pickBtn(r, key) {
  const v = r.values[key];
  if (v.price === null) return `<span class="muted" title="${esc(v.note || '')}">—</span>`;
  const on = hasSale(r) && r.strategy === key;
  return `<button class="pick ${on ? 'on' : ''}" data-apply="${key}" title="${esc(`Aplicar ${STRATEGY[key]} neste produto${v.note ? ` — ${v.note}` : ''}`)}">${money(v.price)}${v.clamped ? '<small> ⚑</small>' : ''}</button>`;
}
const pickCell = (r, key) => `<td class="num">${pickBtn(r, key)}</td>`;

function drawPricing() {
  const pz = state.pricing;
  const grid = document.getElementById('pz-grid');
  if (!grid) return;
  const rows = pzVisible();
  const allOn = rows.length && rows.every((r) => pz.sel.has(r.sku));
  const researched = pz.rows.filter((r) => r.collectedAt).length;
  const defined = pz.rows.filter(hasSale).length;
  const above = pz.rows.filter((r) => r.belowMarket === false).length;
  document.getElementById('pz-status').innerHTML = `<span><b>${pz.rows.length}</b> produtos</span>
    <span class="badge info">${researched} pesquisados</span><span class="badge ok">${defined} com preço definido</span>
    ${above ? `<span class="badge warn">${above} acima da mediana do mercado</span>` : ''}`;
  document.getElementById('pz-count').textContent = rows.length === pz.rows.length ? '' : `${rows.length} de ${pz.rows.length} exibidos`;
  grid.innerHTML = `
    <tr><th><input type="checkbox" class="chk" id="pz-allchk" ${allOn ? 'checked' : ''} title="Selecionar todos exibidos"></th>
    <th>Produto</th><th class="num">Origem</th><th class="num">Mercado</th><th class="num">Mínimo</th><th class="num">Médio</th><th class="num">Sugerido</th>
    <th class="num">Preço de venda</th><th class="num">Δ origem</th><th>Pesquisado</th></tr>
    ${rows.map((r) => {
      const m = r.market;
      const mk = m ? `${money(m.min)} – ${money(m.max)}<span class="sub">mediana ${money(m.median)} · ${m.count} oferta${m.count > 1 ? 's' : ''}</span>`
        : `<span class="muted">${r.collectedAt ? 'sem ofertas' : 'não pesquisado'}</span>`;
      const fail = r.sourcesFailed.length ? `<span class="sub lvl-warn" title="${esc(r.sourcesFailed.join('\n'))}">${r.sourcesFailed.length} fonte(s) com falha</span>` : '';
      const mkt = r.belowMarket === null ? '' : r.belowMarket ? '<span class="sub down">≤ mediana</span>' : '<span class="sub up">acima da mediana</span>';
      return `<tr class="clickable ${pz.sel.has(r.sku) ? 'sel' : ''}" data-sku="${esc(r.sku)}">
        <td><input type="checkbox" class="chk" ${pz.sel.has(r.sku) ? 'checked' : ''}></td>
        <td class="prod">${esc(r.title)}<span class="sub">${esc([r.sku, r.brand, r.variants ? `${r.variants} variações` : null, r.active ? null : 'inativo na origem'].filter(Boolean).join(' · '))}</span></td>
        <td class="num">${pickBtn(r, 'origem')}<span class="sub" title="Piso e teto: faixa permitida pelas regras">piso ${money(r.floor)}${r.ceiling > r.origin ? ` · teto ${money(r.ceiling)}` : ''}${r.cost ? ` · custo ${money(r.cost)}` : ''}</span></td>
        <td class="num">${mk}${fail}</td>
        ${pickCell(r, 'minimo')}${pickCell(r, 'medio')}${pickCell(r, 'sugerido')}
        <td class="num"><input class="price-in" inputmode="decimal" value="${r.price === null ? '' : brNum(r.price)}" placeholder="${esc(brNum(r.origin))}" aria-label="Preço de venda de ${esc(r.sku)}">
          <span class="sub">${!hasSale(r) ? 'usa a origem' : `<span class="badge ${r.strategy === 'manual' ? 'warn' : 'info'}" title="${r.strategy === 'origem' ? 'Acompanha o preço da origem' : ''}">${esc(STRATEGY[r.strategy] || r.strategy)}</span>`}</span>
          ${r.adjusted ? `<span class="sub lvl-warn" title="A origem ou o custo mudaram depois de aplicar: o envio respeita o piso e o teto atuais">enviado ${money(r.effective)}</span>` : ''}</td>
        <td class="num ${r.diffPct < 0 ? 'down' : r.diffPct > 0 ? 'up' : ''}">${hasSale(r) ? pct(r.diffPct) : '—'}${mkt}</td>
        <td class="nowrap">${when(r.collectedAt)}${r.watch ? `<span class="sub">${r.watch} URL monitorada${r.watch > 1 ? 's' : ''}</span>` : ''}</td></tr>`;
    }).join('') || `<tr><td colspan="10" class="empty">${pz.rows.length ? 'Nenhum produto neste filtro.' : 'Nenhum produto capturado. Configure a origem em Integração.'}</td></tr>`}`;
  document.getElementById('pz-allchk').onchange = (e) => {
    rows.forEach((r) => (e.target.checked ? pz.sel.add(r.sku) : pz.sel.delete(r.sku)));
    drawPricing();
  };
  grid.querySelectorAll('tr[data-sku]').forEach((tr) => {
    const sku = tr.dataset.sku;
    tr.querySelector('.chk').onclick = (e) => {
      e.stopPropagation();
      if (e.target.checked) pz.sel.add(sku); else pz.sel.delete(sku);
      tr.classList.toggle('sel', e.target.checked);
      drawPricingBar();
    };
    tr.querySelectorAll('[data-apply]').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); busy(b, () => applyPricing([sku], b.dataset.apply)); };
    });
    const inp = tr.querySelector('.price-in');
    inp.onclick = (e) => e.stopPropagation();
    inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); };
    inp.onchange = () => setManualPrice(sku, inp.value);
    tr.onclick = () => openPricingDetail(sku);
  });
  drawPricingBar();
}

function drawPricingBar() {
  const pz = state.pricing;
  const bar = document.getElementById('pz-bar');
  if (!bar) return;
  const n = pz.sel.size;
  if (!n) { bar.innerHTML = ''; return; }
  bar.innerHTML = `<div class="actionbar"><b>${n} selecionado${n > 1 ? 's' : ''}</b>
    <div class="targets"><span class="muted">Aplicar em massa:</span>
      ${['minimo', 'medio', 'origem', 'sugerido'].map((k) => `<button data-bulk="${k}">${k === 'sugerido' ? 'Sugerido' : STRATEGY[k][0].toUpperCase() + STRATEGY[k].slice(1)}</button>`).join('')}</div>
    <button id="pz-unsel" class="ghost">Desmarcar</button>
    <button id="pz-clear" class="ghost danger" title="Volta a usar o preço da origem">Limpar preço</button>
    <button id="pz-res-sel">Pesquisar selecionados</button></div>`;
  bar.querySelectorAll('[data-bulk]').forEach((b) => { b.onclick = () => busy(b, () => applyPricing([...pz.sel], b.dataset.bulk)); });
  bar.querySelector('#pz-unsel').onclick = () => { pz.sel.clear(); drawPricing(); };
  bar.querySelector('#pz-clear').onclick = (e) => busy(e.target, async () => {
    if (!confirm(`Remover o preço definido de ${n} produto(s)? Eles voltam a ser enviados pelo preço da origem.`)) return;
    const r = await api('/api/pricing/clear', { method: 'POST', body: { skus: [...pz.sel] } });
    toast(`Preço removido${r.queued ? ` · ${r.queued} reenvio(s) na fila` : ''}`);
    await loadPricing();
  });
  bar.querySelector('#pz-res-sel').onclick = () => startResearch([...pz.sel]);
}

async function applyPricing(skus, strategy) {
  const r = await api('/api/pricing/apply', { method: 'POST', body: { skus, strategy } });
  const skipped = r.skipped.length ? ` · ${r.skipped.length} sem dados de mercado` : '';
  toast(`${STRATEGY[strategy]} aplicado a ${r.applied} produto(s)${skipped}${r.queued ? ` · ${r.queued} reenvio(s) na fila` : ''}`, !r.applied);
  await loadPricing();
  if (document.getElementById('drawer').open && skus.length === 1) openPricingDetail(skus[0]);
}

async function setManualPrice(sku, value) {
  try {
    if (String(value).trim() === '') {
      await api('/api/pricing/clear', { method: 'POST', body: { skus: [sku] } });
      toast('Preço removido: volta a usar a origem');
    } else {
      const price = parseBr(value);
      if (!(price > 0)) throw new Error('Preço inválido: use o formato 129,90');
      const r = await api('/api/pricing/manual', { method: 'POST', body: { sku, price } });
      toast(`Preço de ${sku}: ${money(r.price)}${r.warnings.length ? ` — atenção: ${r.warnings.join('; ')}` : ''}`, r.warnings.length > 0);
    }
  } catch (e) { toast(e.message, true); }
  await loadPricing();
}

// Sem busy(): o botão principal mostra o progresso enquanto a pesquisa roda.
async function startResearch(skus) {
  try {
    if (!skus.length) throw new Error('Nenhum produto para pesquisar');
    const st = await api('/api/pricing/research', { method: 'POST', body: { skus } });
    toast(st.started ? `Pesquisando ${skus.length} produto(s)…` : `Já existe uma pesquisa em andamento (${st.done}/${st.total})`);
    drawResearchStatus(st);
    pollResearch();
  } catch (e) { toast(e.message, true); }
}

function drawResearchStatus(st) {
  const prog = document.getElementById('pz-prog');
  const btn = document.getElementById('pz-research');
  if (!prog || !btn) return;
  prog.classList.toggle('hidden', !st.running);
  btn.disabled = !!st.running;
  if (st.running) {
    prog.querySelector('i').style.width = `${Math.round((st.done / Math.max(1, st.total)) * 100)}%`;
    btn.textContent = `Pesquisando ${st.done}/${st.total}…`;
  } else {
    btn.textContent = 'Pesquisar preços';
  }
}

function pollResearch() {
  const pz = state.pricing;
  clearInterval(pz.poll);
  pz.poll = setInterval(async () => {
    let st;
    try { st = await api('/api/pricing/research'); } catch { return; }
    drawResearchStatus(st);
    if (st.running) return;
    clearInterval(pz.poll);
    pz.poll = null;
    toast(`Pesquisa concluída: ${st.done} produto(s)${st.errors ? `, ${st.errors} sem resposta das fontes` : ''}`, st.errors > 0 && st.errors === st.done);
    await loadPricing();
  }, 1500);
}

// ------------------------------------------- gaveta: ofertas do produto
async function openPricingDetail(sku) {
  const drawer = document.getElementById('drawer');
  const body = document.getElementById('drawer-body');
  document.getElementById('drawer-title').textContent = sku;
  body.innerHTML = '<p class="muted">Carregando…</p>';
  if (!drawer.open) drawer.showModal();
  let d;
  try { d = await api(`/api/pricing/${encodeURIComponent(sku)}`); } catch (e) {
    body.innerHTML = `<p class="lvl-error">${esc(e.message)}</p>`;
    return;
  }
  const res = d.research;
  const m = d.market;
  document.getElementById('drawer-title').textContent = d.title;
  body.innerHTML = `
    <div class="status-line"><span>SKU <b>${esc(d.sku)}</b></span>
      <span>Origem <b>${money(d.origin)}</b></span><span>Piso <b>${money(d.floor)}</b></span><span>Teto <b>${money(d.ceiling)}</b>${d.ceiling > d.origin ? '' : ' <span class="muted">(= origem)</span>'}</span>
      ${d.cost ? `<span>Custo ${money(d.cost)}</span>` : '<span class="muted">custo não informado na origem</span>'}
      <span>Preço de venda <b>${money(d.effective)}</b>${hasSale(d) ? ` <span class="badge info">${esc(STRATEGY[d.strategy] || d.strategy)}</span>` : ' <span class="muted">(origem)</span>'}
        ${d.adjusted ? `<span class="lvl-warn">aplicado ${money(d.price)}, ajustado ao piso/teto atual</span>` : ''}</span></div>

    <h4>Referências</h4>
    <div class="table-wrap"><table><tr><th>Valor</th><th class="num">Preço</th><th>Como foi calculado</th><th></th></tr>
      ${['origem', 'minimo', 'medio', 'sugerido'].map((k) => {
        const v = d.values[k];
        const how = { origem: 'Preço praticado na origem (promoção, se houver; com variações, a mais barata). Aplicado, acompanha a origem.', minimo: 'Menor preço válido encontrado no mercado.', medio: 'Ponto intermediário entre o mínimo do mercado e a origem.', sugerido: '' }[k];
        return `<tr><td><b>${esc(STRATEGY[k][0].toUpperCase() + STRATEGY[k].slice(1))}</b></td><td class="num">${money(v.price)}</td>
          <td class="muted">${esc([how, v.note && v.note[0].toUpperCase() + v.note.slice(1)].filter(Boolean).join(' '))}</td>
          <td class="num">${v.price === null ? '' : `<button data-dapply="${k}" class="${hasSale(d) && d.strategy === k ? 'primary' : ''}">Aplicar</button>`}</td></tr>`;
      }).join('')}
      <tr><td><b>Manual</b></td><td class="num"><input id="pd-manual" class="price-in" inputmode="decimal" value="${d.strategy === 'manual' ? brNum(d.price) : ''}" placeholder="0,00"></td>
        <td class="muted">Valor livre. Abaixo do piso ou acima do teto, o AzureHub avisa mas respeita.</td><td class="num"><button id="pd-save">Salvar</button></td></tr>
    </table></div>

    <h4>Mercado</h4>
    ${res ? `<div class="status-line">
        <span>Pesquisado em <b>${when(res.collectedAt)}</b></span>
        ${m ? `<span>${m.count} oferta(s) válida(s): mín. <b>${money(m.min)}</b> · mediana <b>${money(m.median)}</b> · média ${money(m.avg)} · máx. ${money(m.max)}</span>` : '<span class="lvl-warn">nenhuma oferta válida</span>'}
      </div>
      <p class="muted">Busca: “${esc(res.query && res.query.text)}”${res.query && res.query.gtin ? ` · GTIN ${esc(res.query.gtin)}` : ''}</p>
      <div class="table-wrap"><table><tr><th>Fonte</th><th>Situação</th></tr>
        ${res.sources.map((s) => `<tr><td>${esc(s.name)}</td><td class="${s.ok ? '' : 'lvl-error'}">${s.ok ? `${s.count} resultado(s)` : esc(s.error)}</td></tr>`).join('') || '<tr><td colspan="2" class="empty">Nenhuma fonte consultada.</td></tr>'}
      </table></div>
      <h4>Ofertas encontradas (${res.offers.length})</h4>
      <div class="table-wrap"><table><tr><th>Anúncio</th><th>Fonte</th><th class="num">Preço</th><th class="num">Similaridade</th><th>Por</th><th>Situação</th></tr>
        ${res.offers.map((o) => `<tr class="${o.accepted ? '' : 'muted'}">
          <td class="prod">${o.url ? `<a href="${esc(safeUrl(o.url))}" target="_blank" rel="noopener nofollow">${esc(o.title || o.url)}</a>` : esc(o.title)}${o.brand ? `<span class="sub">${esc(o.brand)}</span>` : ''}</td>
          <td class="nowrap">${esc(o.source)}</td><td class="num">${money(o.price)}</td><td class="num">${Math.round((o.score || 0) * 100)}%</td>
          <td class="nowrap">${esc(o.matchedBy || '')}</td>
          <td>${o.accepted ? '<span class="badge ok">considerada</span>' : `<span class="badge">${esc(o.reason || 'descartada')}</span>`}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Nenhuma oferta.</td></tr>'}
      </table></div>` : '<p class="muted">Ainda não pesquisado. Use <b>Pesquisar</b> abaixo ou na grade.</p>'}
    <div class="actions" style="justify-content:flex-start"><button id="pd-research">Pesquisar este produto agora</button></div>

    <h4>URLs monitoradas</h4>
    <p class="muted">Páginas de concorrentes que vendem <b>este mesmo produto</b>, uma por linha. Entram na pesquisa com similaridade 100%;
      o preço é lido dos dados estruturados da página (JSON-LD/metatags), respeitando o robots.txt.</p>
    <textarea id="pd-watch" class="mono" style="min-height:90px" placeholder="https://www.concorrente.com.br/produto/123">${esc(d.watchUrls.join('\n'))}</textarea>
    <div class="actions"><button id="pd-watch-save">Salvar URLs</button></div>`;

  body.querySelectorAll('[data-dapply]').forEach((b) => { b.onclick = () => busy(b, () => applyPricing([sku], b.dataset.dapply)); });
  body.querySelector('#pd-save').onclick = (e) => busy(e.target, async () => {
    await setManualPrice(sku, body.querySelector('#pd-manual').value);
    openPricingDetail(sku);
  });
  body.querySelector('#pd-research').onclick = () => { drawer.close(); startResearch([sku]); };
  body.querySelector('#pd-watch-save').onclick = (e) => busy(e.target, async () => {
    const r = await api(`/api/pricing/${encodeURIComponent(sku)}/watch`, { method: 'PUT', body: { urls: body.querySelector('#pd-watch').value } });
    toast(`${r.watch.length} URL(s) monitorada(s). Pesquise de novo para atualizar o mercado.`);
  });
}

// ------------------------------------------ gaveta: fontes e regras
async function openPricingSettings() {
  const drawer = document.getElementById('drawer');
  const body = document.getElementById('drawer-body');
  document.getElementById('drawer-title').textContent = 'Precificação — fontes e regras';
  body.innerHTML = '<p class="muted">Carregando…</p>';
  if (!drawer.open) drawer.showModal();
  const { settings: cfg, sourceTypes } = await api('/api/pricing/settings');
  const types = Object.fromEntries(sourceTypes.map((t) => [t.type, t]));
  const srcs = cfg.sources.map((s) => ({ ...s }));
  const ml = state.platforms.find((p) => p.id === 'mercadolivre');

  body.innerHTML = `
    <div class="callout"><b>Coleta responsável.</b> O robô se identifica como <code>AzureHubPriceBot</code>, respeita o <code>robots.txt</code>,
      espaça as requisições a cada site e guarda as respostas em cache. Ele <b>não</b> contorna captcha, login ou bloqueios anti-robô.
      Prefira APIs públicas (VTEX, Shopify, WooCommerce) e a API oficial do Mercado Livre, e use só fontes cujos termos permitam a consulta.</div>
    <h4>Regras</h4>
    <div id="pz-rules-form" class="grid2">
      ${field({ key: 'enabled', label: 'Módulo de Precificação ativo', type: 'checkbox', help: 'Desativado: os marketplaces voltam a receber o preço da origem.' }, cfg.enabled)}
      ${field({ key: 'showOriginAsList', label: 'Enviar origem como preço “de”', type: 'checkbox', help: 'O preço de venda vira preço promocional (“por”) quando for menor que a origem.' }, cfg.showOriginAsList)}
      ${field({ key: 'allowAboveOrigin', label: 'Permitir preço acima da origem', type: 'checkbox', help: 'Quando o mercado está acima, mínimo, médio e sugerido podem passar da origem até o teto abaixo.' }, cfg.allowAboveOrigin)}
      ${field({ key: 'maxAbovePct', label: 'Teto: até quantos % acima da origem', type: 'text', help: '0 a 300. Só vale com a opção ao lado ligada.' }, cfg.maxAbovePct)}
      ${field({ key: 'undercutPct', label: 'Sugerido: % abaixo da mediana', type: 'text', help: '0 a 50' }, cfg.undercutPct)}
      ${field({ key: 'rounding', label: 'Arredondamento do sugerido', type: 'select', options: [['90', 'Final ,90 (para baixo)'], ['99', 'Final ,99 (para baixo)'], ['cent', 'Centavos']] }, cfg.rounding)}
      ${field({ key: 'maxDiscountPct', label: 'Piso: desconto máximo sobre a origem (%)', type: 'text', help: '0 a 90' }, cfg.maxDiscountPct)}
      ${field({ key: 'minMarginPct', label: 'Piso: margem mínima sobre o custo (%)', type: 'text', help: 'Só vale quando a origem informa o custo.' }, cfg.minMarginPct)}
      ${field({ key: 'minSimilarity', label: 'Similaridade mínima das ofertas (%)', type: 'text', help: 'Ofertas menos parecidas com o produto são descartadas. Padrão 45.' }, Math.round(cfg.minSimilarity * 100))}
      ${field({ key: 'cacheHours', label: 'Cache das consultas (horas)', type: 'text', help: '0 a 168. Evita repetir requisições aos mesmos sites.' }, cfg.cacheHours)}
    </div>
    <h4>Fontes de pesquisa</h4>
    <div id="pz-srcs"></div>
    <div class="toolbar"><select id="pz-newtype" style="max-width:340px">${sourceTypes.map((t) => `<option value="${t.type}">${esc(t.label)}</option>`).join('')}</select>
      <button id="pz-add">Adicionar fonte</button></div>
    <div class="actions"><button id="pz-cancel" class="ghost">Cancelar</button><button id="pz-save" class="primary">Salvar</button></div>`;

  const holder = body.querySelector('#pz-srcs');
  const collect = () => holder.querySelectorAll('.src-card').forEach((card) => {
    const i = Number(card.dataset.i);
    Object.assign(srcs[i], readFields(card));
  });
  const drawSrcs = () => {
    holder.innerHTML = srcs.map((s, i) => {
      const t = types[s.type] || { label: s.type, fields: [] };
      const needs = t.needsPlatform === 'mercadolivre' && !(ml && ml.connected)
        ? '<p class="lvl-warn">Conecte a conta do Mercado Livre em Integração › Destinos para usar esta fonte.</p>' : '';
      return `<div class="src-card" data-i="${i}">
        <header><span><b>${esc(t.label)}</b><small class="muted"> ${esc(t.description || '')}</small></span>
          <button class="ghost danger" data-rm="${i}">Remover</button></header>
        ${needs}
        <div class="grid2">
          ${field({ key: 'name', label: 'Nome', type: 'text' }, s.name || t.label)}
          ${field({ key: 'interval_ms', label: 'Intervalo entre requisições ao site (ms)', type: 'text', help: 'Vazio = padrão da fonte (1,5 a 3 s). Mínimo 1000.' }, s.interval_ms || '')}
          ${t.fields.map((f) => field(f, s[f.key])).join('')}
          ${field({ key: 'enabled', label: 'Ativa', type: 'checkbox' }, s.enabled !== false)}
          ${field({ key: 'respect_robots', label: 'Respeitar robots.txt', type: 'checkbox', help: 'Desligue apenas em sites seus ou com autorização expressa.' }, s.respect_robots !== false)}
        </div></div>`;
    }).join('') || '<p class="muted">Nenhuma fonte cadastrada. Sem fontes, a Precificação usa só a origem e os valores manuais.</p>';
    holder.querySelectorAll('[data-rm]').forEach((b) => {
      b.onclick = () => { collect(); srcs.splice(Number(b.dataset.rm), 1); drawSrcs(); };
    });
  };
  drawSrcs();
  body.querySelector('#pz-add').onclick = () => {
    collect();
    const type = body.querySelector('#pz-newtype').value;
    srcs.push({ type, name: types[type].label, enabled: true, respect_robots: true });
    drawSrcs();
    holder.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  body.querySelector('#pz-cancel').onclick = () => drawer.close();
  body.querySelector('#pz-save').onclick = (e) => busy(e.target, async () => {
    collect();
    const rules = readFields(body.querySelector('#pz-rules-form'));
    rules.minSimilarity = Number(String(rules.minSimilarity).replace(',', '.')) / 100;
    for (const k of ['undercutPct', 'maxDiscountPct', 'minMarginPct', 'maxAbovePct', 'cacheHours']) rules[k] = Number(String(rules[k]).replace(',', '.'));
    const r = await api('/api/pricing/settings', { method: 'PUT', body: { ...rules, sources: srcs } });
    toast(`Configurações salvas${r.queued ? ` · ${r.queued} reenvio(s) na fila` : ''}`);
    drawer.close();
    if (r.settings.enabled !== state.modules.pricing) route(); else loadPricing();
  });
}

// =============================================================== Prévia
async function viewPrevia() {
  const skus = [...state.selected];
  if (!skus.length) {
    $app.innerHTML = `<div class="view-head"><div><h1>Prévia</h1></div></div>
      <div class="panel empty">Nenhum produto selecionado. Escolha os produtos em <a href="#produtos">Produtos</a> e clique em <b>Pré-visualizar</b>.</div>`;
    return;
  }
  // Na prévia todos os destinos podem ser simulados (mesmo sem conexão).
  if (!state.targets.size) state.platforms.filter(usable).forEach((p) => state.targets.add(p.id));
  if (!state.targets.size) Object.keys(PLAT).forEach((id) => state.targets.add(id));
  const targets = Object.keys(PLAT).filter((id) => state.targets.has(id));
  const key = JSON.stringify([skus, targets]);
  $app.innerHTML = `
    <div class="view-head">
      <div><h1>Prévia</h1><p class="muted">Como os ${skus.length} produto(s) vão subir em cada marketplace. Nada é enviado nesta tela.</p></div>
      <div class="toolbar" style="margin:0"><a href="#produtos" class="btn-link">Voltar para Produtos</a>${state.modules.pricing ? '<a href="#precificacao" class="btn-link">Precificação</a>' : ''}<button id="pv-send" class="primary" disabled>Enviar prontos</button></div>
    </div>
    <div class="toolbar">${Object.keys(PLAT).map((id) => `<label class="switch"><input type="checkbox" data-pv-target="${id}" ${state.targets.has(id) ? 'checked' : ''}> ${PLAT[id]}</label>`).join('')}</div>
    <div id="pv-summary" class="status-line"></div>
    <div class="progress"><i id="pv-bar" style="width:0"></i></div>
    <div id="pv-list"></div>`;
  document.querySelectorAll('[data-pv-target]').forEach((c) => {
    c.onchange = () => {
      if (c.checked) state.targets.add(c.dataset.pvTarget); else state.targets.delete(c.dataset.pvTarget);
      state.preview = null;
      viewPrevia();
    };
  });
  if (!targets.length) {
    document.getElementById('pv-list').innerHTML = '<div class="panel empty">Marque ao menos um marketplace.</div>';
    return;
  }
  if (!state.preview || state.preview.key !== key) {
    state.preview = { key, items: [], include: {}, tab: {} };
    for (let i = 0; i < skus.length; i += 5) {
      if (!state.preview || state.preview.key !== key) return;
      const res = await api('/api/preview', { method: 'POST', body: { skus: skus.slice(i, i + 5), platforms: targets } });
      for (const it of res.items) {
        state.preview.items.push(it);
        for (const [pid, r] of Object.entries(it.platforms)) state.preview.include[`${it.sku}|${pid}`] = r.ready && r.enabled && r.connected;
      }
      drawPreview(skus.length, targets);
    }
  }
  drawPreview(skus.length, targets);
}

function drawPreview(total, targets) {
  const pv = state.preview;
  const bar = document.getElementById('pv-bar');
  if (!bar || !pv) return;
  bar.style.width = `${Math.round((pv.items.length / total) * 100)}%`;
  let ready = 0; let errors = 0; let included = 0;
  for (const it of pv.items) for (const [pid, r] of Object.entries(it.platforms)) {
    if (r.ready) ready++; else errors++;
    if (pv.include[`${it.sku}|${pid}`]) included++;
  }
  document.getElementById('pv-summary').innerHTML = `<span><b>${pv.items.length}</b> de ${total} produtos analisados</span>
    <span class="badge ok">${ready} prontos</span><span class="badge err">${errors} com erro</span><span class="muted">${included} marcados para envio</span>`;
  const send = document.getElementById('pv-send');
  send.disabled = !included || pv.items.length < total;
  send.textContent = `Enviar ${included} prontos`;
  send.onclick = (e) => busy(e.target, async () => {
    const byPlat = {};
    for (const [k, on] of Object.entries(pv.include)) if (on) { const [sku, pid] = k.split('|'); (byPlat[pid] ||= []).push(sku); }
    let q = 0;
    for (const [pid, skus] of Object.entries(byPlat)) q += (await api('/api/integrations/send', { method: 'POST', body: { skus, platforms: [pid] } })).queued;
    toast(`${q} envios na fila`);
    state.selected.clear();
    state.preview = null;
    location.hash = 'sincronizacao';
  });

  document.getElementById('pv-list').innerHTML = pv.items.map((it) => {
    if (it.missing) return `<div class="panel pv"><div class="pv-head"><h3>${esc(it.sku)}</h3><span class="badge err">não encontrado</span></div></div>`;
    const tab = pv.tab[it.sku] || targets.find((t) => it.platforms[t]);
    return `<article class="panel pv" data-sku="${esc(it.sku)}">
      <div class="pv-head"><h3>${esc(it.title)} <span class="muted">${esc(it.sku)}</span></h3>
        ${it.pricing ? `<span class="badge info" title="Definido na Precificação">Preço de venda ${money(it.pricing.final)} · origem ${money(it.pricing.origin)} · ${esc(STRATEGY[it.pricing.strategy] || it.pricing.strategy)}</span>` : ''}</div>
      <div class="pv-tabs">${targets.filter((t) => it.platforms[t]).map((t) => {
        const r = it.platforms[t];
        return `<button data-tab="${t}" class="${t === tab ? 'on' : ''}">${r.ready ? '✅' : '⛔'} ${PLAT[t]}</button>`;
      }).join('')}</div>
      <div class="pv-body">${previewBody(it, tab)}</div></article>`;
  }).join('');
  document.querySelectorAll('.pv[data-sku]').forEach((card) => {
    const sku = card.dataset.sku;
    card.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { pv.tab[sku] = b.dataset.tab; drawPreview(total, targets); }; });
    const inc = card.querySelector('[data-include]');
    if (inc) inc.onchange = () => { pv.include[inc.dataset.include] = inc.checked; drawPreview(total, targets); };
  });
}

function previewBody(it, pid) {
  const r = it.platforms[pid];
  const k = `${it.sku}|${pid}`;
  const canSend = r.ready && r.enabled && r.connected;
  const why = !r.connected ? 'conta não conectada' : !r.enabled ? 'destino inativo' : 'há erros a corrigir';
  return `
    <label class="include"><input type="checkbox" data-include="${esc(k)}" ${state.preview.include[k] ? 'checked' : ''} ${canSend ? '' : 'disabled'}>
      Incluir no envio ${canSend ? '' : `<span class="muted">(${why})</span>`}</label>
    <div class="status-line" style="margin-bottom:10px">
      <span class="badge ${r.online ? 'ok' : 'warn'}">${r.online ? 'Validado na conta' : 'Validação offline'}</span>
      <span class="badge info">Ação: ${esc(r.action)}${r.externalId ? ` (${esc(r.externalId)})` : ''}</span>
      ${r.variantStructure ? `<span class="badge">Variações: ${esc(r.variantStructure)}</span>` : ''}
    </div>
    ${r.errors.length ? `<ul class="issues err">${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
    ${r.warnings.length ? `<ul class="issues warn">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <dl class="kv">${r.fields.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}${f.note ? `<small>${esc(f.note)}</small>` : ''}</dd>`).join('')}</dl>
    ${r.variants && r.variants.length ? `<h4 style="margin:16px 0 6px">Variações (${r.variants.length})</h4>
      <div class="table-wrap"><table><tr><th>SKU</th><th>Opções</th><th class="num">Preço</th><th class="num">Promo</th><th class="num">Estoque</th><th>GTIN</th></tr>
      ${r.variants.map((v) => `<tr><td>${esc(v.sku)}</td><td>${esc(v.options)}</td><td class="num">${esc(v.price)}</td><td class="num">${esc(v.promoPrice)}</td><td class="num">${esc(v.stock)}</td><td>${esc(v.gtin)}</td></tr>`).join('')}
      </table></div>` : ''}`;
}

// ======================================================== Sincronização
async function viewSincronizacao() {
  const s = state.sync;
  $app.innerHTML = `
    <div class="view-head">
      <div><h1>Sincronização</h1><p class="muted">Produtos enviados para os marketplaces. Clique em uma linha para ver todos os dados, fotos e vídeos.</p></div>
      <div class="toolbar" style="margin:0">
        <label class="switch"><input type="checkbox" id="auto" ${s.auto ? 'checked' : ''}> Atualizar a cada 10 s</label>
        <button id="refresh">Atualizar</button>
      </div>
    </div>
    <div class="tabs" style="margin-top:0">${[['grade', 'Produtos sincronizados'], ['fila', 'Fila'], ['log', 'Log de eventos']]
      .map(([k, l]) => `<button data-sub="${k}" class="${s.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="sub"></div>`;
  document.querySelectorAll('[data-sub]').forEach((b) => { b.onclick = () => { s.tab = b.dataset.sub; viewSincronizacao(); }; });
  document.getElementById('auto').onchange = (e) => { s.auto = e.target.checked; };
  document.getElementById('refresh').onclick = () => drawSub();
  await drawSub();
  refreshTimer = setInterval(() => {
    if (s.auto && !document.getElementById('drawer').open && location.hash === '#sincronizacao') drawSub(true).catch(() => {});
  }, 10000);
}

async function drawSub(silent) {
  const s = state.sync;
  const el = document.getElementById('sub');
  if (!el) return;
  if (s.tab === 'fila') {
    const data = await api('/api/jobs');
    const st = data.stats;
    el.innerHTML = `<div class="toolbar"><span>Na fila: <b>${st.queued || 0}</b> · Enviando: <b>${st.running || 0}</b> · Concluídos: <b>${st.done || 0}</b> · Com erro: <b class="lvl-error">${st.error || 0}</b></span>
      <button id="j-clear" class="ghost">Limpar concluídos</button></div>
      <div class="table-wrap"><table><tr><th>#</th><th>Destino</th><th>SKU</th><th>Status</th><th class="num">Tentativas</th><th>Próxima tentativa</th><th>Erro</th></tr>
      ${data.items.map((j) => `<tr><td>${j.id}</td><td>${esc(PLAT[j.platform])}</td><td>${esc(j.sku)}</td><td>${esc(j.status)}</td>
        <td class="num">${j.attempts}</td><td>${j.status === 'queued' ? when(j.run_after) : '—'}</td><td class="lvl-error">${esc(j.error || '')}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Fila vazia.</td></tr>'}</table></div>`;
    el.querySelector('#j-clear').onclick = async () => { await api('/api/jobs/clear', { method: 'POST' }); drawSub(); };
    return;
  }
  if (s.tab === 'log') {
    const rows = await api('/api/logs');
    el.innerHTML = `<div class="table-wrap"><table><tr><th>Quando</th><th>Nível</th><th>Destino</th><th>SKU</th><th>Mensagem</th></tr>
      ${rows.map((l) => `<tr class="lvl-${l.level}"><td class="nowrap">${when(l.ts)}</td><td>${esc(l.level)}</td><td>${esc(PLAT_SHORT[l.platform] || '')}</td>
        <td>${esc(l.sku || '')}</td><td>${esc(l.message)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Sem eventos.</td></tr>'}</table></div>`;
    return;
  }
  const qs = new URLSearchParams({ limit: '200', q: s.q, platform: s.platform, status: s.status });
  const data = await api(`/api/sync?${qs}`);
  const c = data.counts;
  const queued = (data.jobs.queued || 0) + (data.jobs.running || 0);
  const tiles = [['', 'Todos', c.total, ''], ['pending', 'Aguardando', c.pending, ''], ['synced', 'Sincronizados', c.synced, 'ok'],
    ['outdated', 'Desatualizados', c.outdated, 'warn'], ['error', 'Com erro', c.error, 'err'], ['skipped', 'Adiados', c.skipped, 'warn'], ['paused', 'Pausados', c.paused, '']];
  if (!silent || !el.querySelector('#grid')) {
    el.innerHTML = `
      <div class="tiles">${tiles.map(([k, l, n, cls]) => `<button class="tile ${cls} ${s.status === k ? 'on' : ''}" data-status="${k}"><b>${n}</b><span>${l}</span></button>`).join('')}
        <div class="tile" id="t-queue"><b>${queued}</b><span>Na fila agora</span></div></div>
      <div class="toolbar">
        <input id="sq" placeholder="Buscar SKU, título ou ID no marketplace" value="${esc(s.q)}">
        <select id="sp" style="max-width:200px"><option value="">Todos os destinos</option>${Object.keys(PLAT).map((id) => `<option value="${id}" ${s.platform === id ? 'selected' : ''}>${PLAT[id]}</option>`).join('')}</select>
        <span class="muted" id="scount"></span>
      </div>
      <div class="table-wrap"><table id="grid"></table></div>
      <div id="sbar"></div>`;
    el.querySelectorAll('[data-status]').forEach((b) => { b.onclick = () => { s.status = b.dataset.status; drawSub(); }; });
    let t;
    el.querySelector('#sq').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { s.q = e.target.value; drawSub(); }, 350); };
    el.querySelector('#sp').onchange = (e) => { s.platform = e.target.value; drawSub(); };
  } else {
    el.querySelectorAll('[data-status]').forEach((b, i) => { b.querySelector('b').textContent = tiles[i][2]; });
    el.querySelector('#t-queue b').textContent = queued;
  }
  el.querySelector('#scount').textContent = `${data.total} vínculos produto × destino`;
  const key = (r) => `${r.platform}|${r.sku}`;
  el.querySelector('#grid').innerHTML = `
    <tr><th></th><th>Produto</th><th>Destino</th><th>Status</th><th>ID no marketplace</th><th class="num">Preço</th><th class="num">Estoque</th><th class="num">Var.</th>
    <th>Atualizado na origem</th><th>Última sincronização</th><th>Mensagem</th></tr>
    ${data.items.map((r) => {
      const job = r.job === 'running' ? '<span class="badge info">enviando…</span>' : r.job === 'queued' ? `<span class="badge info" title="${esc(when(r.jobRunAfter))}">na fila</span>` : '';
      return `<tr class="clickable ${s.picked.has(key(r)) ? 'sel' : ''}" data-key="${esc(key(r))}" data-sku="${esc(r.sku)}">
        <td><input type="checkbox" class="chk" ${s.picked.has(key(r)) ? 'checked' : ''}></td>
        <td class="prod">${esc(r.title)}<span class="sub">${esc(r.sku)}</span></td>
        <td class="nowrap">${esc(PLAT[r.platform])}</td>
        <td class="nowrap">${statusBadge(r.status)} ${r.outdated && r.status === 'synced' ? '<span class="badge warn">desatualizado</span>' : ''} ${job}</td>
        <td class="nowrap">${r.externalId ? (r.permalink ? `<a href="${esc(safeUrl(r.permalink))}" target="_blank" rel="noopener" data-stop>${esc(r.externalId)}</a>` : esc(r.externalId)) : '—'}</td>
        <td class="num">${r.salePrice ? `<span class="strike">${money(r.promoPrice || r.price)}</span>${money(r.salePrice)}<span class="sub sale">precificado</span>` : r.promoPrice ? `<span class="strike">${money(r.price)}</span>${money(r.promoPrice)}` : money(r.price)}</td>
        <td class="num">${r.stock}</td><td class="num">${r.variants || '—'}</td>
        <td class="nowrap">${when(r.productUpdatedAt)}</td><td class="nowrap">${when(r.lastSync)}</td>
        <td class="${r.status === 'error' ? 'lvl-error' : 'muted'}" title="${esc(r.message || '')}">${esc((r.message || '').slice(0, 90))}${(r.message || '').length > 90 ? '…' : ''}</td></tr>`;
    }).join('') || '<tr><td colspan="11" class="empty">Nada por aqui. Envie produtos para integração na tela Produtos.</td></tr>'}`;
  el.querySelectorAll('#grid tr[data-key]').forEach((tr) => {
    tr.querySelector('.chk').onclick = (e) => {
      e.stopPropagation();
      if (e.target.checked) s.picked.add(tr.dataset.key); else s.picked.delete(tr.dataset.key);
      tr.classList.toggle('sel', e.target.checked);
      drawSyncBar();
    };
    tr.querySelectorAll('[data-stop]').forEach((a) => { a.onclick = (e) => e.stopPropagation(); });
    tr.onclick = () => openDetail(tr.dataset.sku);
  });
  drawSyncBar();
}

function drawSyncBar() {
  const s = state.sync;
  const bar = document.getElementById('sbar');
  if (!bar) return;
  if (!s.picked.size) { bar.innerHTML = ''; return; }
  bar.innerHTML = `<div class="actionbar"><b>${s.picked.size} selecionado(s)</b><div class="targets"></div>
    <button id="s-clear" class="ghost">Limpar</button><button id="s-stop" class="ghost danger">Parar de sincronizar</button>
    <button id="s-resend" class="primary">Reenviar agora</button></div>`;
  const group = () => {
    const by = {};
    for (const k of s.picked) { const [pid, sku] = k.split('|'); (by[pid] ||= []).push(sku); }
    return by;
  };
  bar.querySelector('#s-clear').onclick = () => { s.picked.clear(); drawSub(); };
  bar.querySelector('#s-resend').onclick = (e) => busy(e.target, async () => {
    let q = 0;
    for (const [pid, skus] of Object.entries(group())) q += (await api('/api/sync', { method: 'POST', body: { platform: pid, skus } })).queued;
    toast(`${q} reenvios na fila`);
    s.picked.clear();
    drawSub();
  });
  bar.querySelector('#s-stop').onclick = (e) => busy(e.target, async () => {
    if (!confirm('Parar de sincronizar os selecionados?')) return;
    for (const [pid, skus] of Object.entries(group())) await api('/api/integrations/stop', { method: 'POST', body: { skus, platforms: [pid] } });
    s.picked.clear();
    drawSub();
  });
}

// ------------------------------------------------- detalhe (com mídia)
const ytId = (u) => { const m = String(u).match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/); return m ? m[1] : null; };
const plainText = (html) => String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<li>/gi, '• ')
  .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();

function videoHtml(u) {
  const yt = ytId(u);
  if (yt) return `<iframe src="https://www.youtube-nocookie.com/embed/${esc(yt)}" title="Vídeo" allowfullscreen loading="lazy"></iframe>`;
  if (/\.(mp4|webm|mov)($|\?)/i.test(u)) return `<video src="${esc(safeUrl(u))}" controls preload="metadata"></video>`;
  return `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${esc(u)}</a>`;
}

async function openDetail(sku) {
  const drawer = document.getElementById('drawer');
  document.getElementById('drawer-title').textContent = sku;
  document.getElementById('drawer-body').innerHTML = '<p class="muted">Carregando…</p>';
  if (!drawer.open) drawer.showModal();
  let d;
  try { d = await api(`/api/products/${encodeURIComponent(sku)}`); } catch (e) {
    document.getElementById('drawer-body').innerHTML = `<p class="lvl-error">${esc(e.message)}</p>`;
    return;
  }
  const p = d.product;
  const kv = (rows) => `<dl class="kv">${rows.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const dims = p.lengthCm && p.widthCm && p.heightCm ? `${p.lengthCm} × ${p.widthCm} × ${p.heightCm} cm` : '—';
  document.getElementById('drawer-title').textContent = p.title;
  document.getElementById('drawer-body').innerHTML = `
    <div class="status-line"><span>SKU <b>${esc(p.sku)}</b></span><span class="muted">Origem: ${esc(d.origin)}${p.sourceRef ? ` (${esc(p.sourceRef)})` : ''}</span>
      <span class="muted">Capturado: ${when(d.capturedAt)} · Atualizado: ${when(d.updatedAt)}</span>${p.active ? '' : '<span class="badge warn">inativo na origem</span>'}</div>

    <h4>Fotos (${p.images.length})</h4>
    ${p.images.length ? `<div class="gallery">${p.images.map((u) => `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener"><img src="${esc(safeUrl(u))}" alt="" loading="lazy"></a>`).join('')}</div>` : '<p class="muted">Sem fotos.</p>'}
    <h4>Vídeos (${p.videos.length})</h4>
    ${p.videos.length ? `<div class="videos">${p.videos.map(videoHtml).join('')}</div>` : '<p class="muted">Sem vídeos.</p>'}

    <h4>Dados do produto</h4>
    ${kv([
      ['Preço', money(p.price)], ['Preço promocional', p.promoPrice ? `${money(p.promoPrice)}${p.promoStart || p.promoEnd ? ` <small>${when(p.promoStart)} → ${when(p.promoEnd)}</small>` : ''}` : '—'],
      ['Estoque', esc(p.stock)], ['Marca', esc(p.brand || '—')], ['Modelo', esc(p.model || '—')], ['GTIN/EAN', esc(p.gtin || '—')],
      ['Condição', p.condition === 'used' ? 'Usado' : 'Novo'], ['Peso', p.weightKg ? `${esc(p.weightKg)} kg` : '—'], ['Dimensões', esc(dims)],
      ['Prazo de postagem', p.daysToShip ? `${esc(p.daysToShip)} dias` : '—'],
      ['Categorias', esc(Object.entries(p.categories || {}).filter(([, v]) => v).map(([k, v]) => `${PLAT_SHORT[k] || k}: ${v}`).join(' · ') || '—')],
      ['Atributos', esc(Object.entries(p.attributes || {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—')],
      ['Fiscal', esc(p.tax ? Object.entries(p.tax).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(' · ') : '—')],
      ['Tabela de medidas', p.sizeChart ? `<a href="${esc(safeUrl(p.sizeChart))}" target="_blank" rel="noopener"><img class="thumb" src="${esc(safeUrl(p.sizeChart))}" alt="Tabela de medidas"></a>` : (p.sizeChartId ? `modelo ${esc(p.sizeChartId)}` : '—')],
    ])}
    <h4>Descrição</h4>
    <div class="desc">${esc(plainText(p.description)) || '<span class="muted">Sem descrição.</span>'}</div>

    ${(p.variants || []).length ? `<h4>Variações (${p.variants.length})</h4>
      <div class="table-wrap"><table><tr><th></th><th>SKU</th><th>Opções</th><th class="num">Preço</th><th class="num">Promo</th><th class="num">Estoque</th><th>GTIN</th></tr>
      ${p.variants.map((v) => `<tr><td>${v.images[0] ? `<img class="thumb" src="${esc(safeUrl(v.images[0]))}" alt="" loading="lazy">` : ''}</td><td>${esc(v.sku)}</td>
        <td>${esc(Object.entries(v.options).map(([k, x]) => `${k}: ${x}`).join(' · '))}</td><td class="num">${money(v.price)}</td>
        <td class="num">${v.promoPrice ? money(v.promoPrice) : '—'}</td><td class="num">${v.stock}</td><td>${esc(v.gtin || '—')}</td></tr>`).join('')}</table></div>` : ''}

    <h4>Destinos</h4>
    ${Object.keys(d.listings).length ? Object.entries(d.listings).map(([pid, l]) => `<div class="dest-card">
      <header><span>${esc(PLAT[pid])}</span><span>${statusBadge(l.status)} ${l.outdated && l.status === 'synced' ? '<span class="badge warn">desatualizado</span>' : ''}</span></header>
      ${kv([
        ['ID no marketplace', l.external_id ? (l.meta.permalink ? `<a href="${esc(safeUrl(l.meta.permalink))}" target="_blank" rel="noopener">${esc(l.external_id)}</a>` : esc(l.external_id)) : '—'],
        ['Selecionado em', when(l.selected_at)], ['Última sincronização', when(l.last_sync)],
        ['Categoria usada', esc(l.meta.category_id || '—')], ['Fotos enviadas', esc(l.mediaSent || '—')],
        ['Variações (modelos)', l.meta.models ? esc(Object.keys(l.meta.models).length) : '—'],
        ['Promoção', l.meta.promo ? esc(`${money(l.meta.promo.price ?? '')} até ${when((l.meta.promo.end || 0) * 1000)}`) : '—'],
        ['Mensagem', l.last_error ? `<span class="${l.status === 'error' ? 'lvl-error' : ''}">${esc(l.last_error)}</span>` : '—'],
      ])}
      <div class="actions" style="margin-top:8px"><button data-resend="${pid}">Reenviar</button><button class="ghost danger" data-stop-pid="${pid}">Parar de sincronizar</button></div>
    </div>`).join('') : '<p class="muted">Ainda não enviado para nenhum destino.</p>'}

    <h4>Histórico</h4>
    <div class="table-wrap"><table><tr><th>Quando</th><th>Destino</th><th>Evento</th></tr>
      ${d.logs.map((l) => `<tr class="lvl-${l.level}"><td class="nowrap">${when(l.ts)}</td><td>${esc(PLAT_SHORT[l.platform] || '')}</td><td>${esc(l.message)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">Sem eventos.</td></tr>'}
    </table></div>`;
  document.querySelectorAll('[data-resend]').forEach((b) => {
    b.onclick = () => busy(b, async () => {
      await api('/api/sync', { method: 'POST', body: { platform: b.dataset.resend, skus: [sku] } });
      toast('Reenvio na fila');
      openDetail(sku);
    });
  });
  document.querySelectorAll('[data-stop-pid]').forEach((b) => {
    b.onclick = () => busy(b, async () => {
      if (!confirm('Parar de sincronizar este produto neste destino?')) return;
      await api('/api/integrations/stop', { method: 'POST', body: { skus: [sku], platforms: [b.dataset.stopPid] } });
      openDetail(sku);
    });
  });
}

document.getElementById('drawer-close').onclick = () => document.getElementById('drawer').close();
document.getElementById('drawer').addEventListener('close', () => {
  if (location.hash === '#sincronizacao') drawSub(true).catch(() => {});
  if (location.hash === '#precificacao') loadPricing().catch(() => {});
});

// ================================================================ boot
document.getElementById('btn-logout').onclick = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); showLogin(); };

(async function boot() {
  const hash = new URLSearchParams(location.hash.slice(1));
  let start = null;
  if (hash.get('oauth')) {
    if (hash.get('oauth') === 'ok') toast(hash.get('p') === 'origem' ? 'Origem conectada com sucesso' : 'Conta conectada com sucesso');
    else toast(`Falha ao conectar: ${hash.get('msg') || 'erro desconhecido'}`, true);
    start = 'integracao';
    history.replaceState(null, '', `${location.pathname}#integracao`);
  }
  try {
    const st = await api('/api/status');
    document.getElementById('version').textContent = `v${st.version}`;
    if (!st.installed) return showInstall();
    await api('/api/me');
    startApp(start);
  } catch {
    /* api() já levou para o login em caso de 401 */
  }
})();
