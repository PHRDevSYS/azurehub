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
const VIEWS = { integracao: viewIntegracao, produtos: viewProdutos, previa: viewPrevia, sincronizacao: viewSincronizacao };
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
  $app.innerHTML = '<p class="muted center">Carregando…</p>';
  try {
    state.platforms = await api('/api/platforms');
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
      <td class="num">${p.promoPrice ? `<span class="strike">${money(p.price)}</span>${money(p.promoPrice)}` : money(p.price)}</td>
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
    <button id="b-preview">Pré-visualizar</button>
    <button id="b-send" class="primary">Enviar para integração</button></div>`;
  bar.querySelectorAll('[data-target]').forEach((c) => {
    c.onchange = () => { if (c.checked) state.targets.add(c.dataset.target); else state.targets.delete(c.dataset.target); };
  });
  bar.querySelector('#b-clear').onclick = () => { state.selected.clear(); drawProducts(); };
  bar.querySelector('#b-preview').onclick = () => { state.preview = null; location.hash = 'previa'; };
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
      <div class="toolbar" style="margin:0"><a href="#produtos" class="btn-link">Voltar para Produtos</a><button id="pv-send" class="primary" disabled>Enviar prontos</button></div>
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
      <div class="pv-head"><h3>${esc(it.title)} <span class="muted">${esc(it.sku)}</span></h3></div>
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
        <td class="num">${r.promoPrice ? `<span class="strike">${money(r.price)}</span>${money(r.promoPrice)}` : money(r.price)}</td>
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
document.getElementById('drawer').addEventListener('close', () => { if (location.hash === '#sincronizacao') drawSub(true).catch(() => {}); });

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
