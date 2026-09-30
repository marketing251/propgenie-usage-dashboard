/* PropGenie Usage dashboard — vanilla SPA, hash-routed. */
const MODEL_COLORS = {
  'genie-pro': '#3987e5', 'genie-flash': '#d95926', 'genie-canvas': '#199e70',
  'genie-vision': '#c98500', 'webbuilder': '#d55181',
};
const DAY = 864e5;
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const state = { meta: null, range: { preset: '30' }, charts: [], log: null, clients: null, metric: 'cost' };

try { const saved = JSON.parse(localStorage.getItem('pgu.range')); if (saved?.preset) state.range = saved; } catch {}

/* ---------- formatting ---------- */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function usd(v, full = false) {
  const a = Math.abs(v || 0);
  if (!full && a >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (!full && a >= 1e4) return '$' + (v / 1e3).toFixed(1) + 'K';
  if (a >= 1 || a === 0) return '$' + (v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return '$' + v.toFixed(4);
}
function tok(v) {
  const a = Math.abs(v || 0);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(v || 0);
}
const int = (v) => (v || 0).toLocaleString('en-US');
const pct = (v) => (v * 100).toFixed(1) + '%';
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const fmtDate = (d) => d ? new Date(d.length === 10 ? d + 'T00:00:00Z' : d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—';
const fmtTs = (d) => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
const modelLabel = (m) => state.meta?.models[m]?.label || m;
const swatch = (m) => `<span class="swatch" style="--c:${MODEL_COLORS[m] || '#64748b'}"></span>`;
const modelTag = (m) => `<span class="tag-model">${swatch(m)}${esc(modelLabel(m))}</span>`;
const retail = (credits) => credits * (state.meta?.creditValue ?? 0.01);
const margin = (t) => { const r = retail(t.credits); return r ? (r - t.cost) / r : 0; };

function delta(cur, prev) {
  if (!prev) return cur ? '<span class="sub">new this period</span>' : '<span class="sub">no activity</span>';
  const d = (cur - prev) / prev;
  const cls = d > 0.0005 ? 'up' : d < -0.0005 ? 'down' : '';
  return `<span class="sub delta ${cls}">${pct(Math.abs(d))} vs prev</span>`;
}

/* ---------- data ---------- */
function rangeDates() {
  const r = state.range;
  const today = isoDay(Date.now());
  if (r.preset === 'custom') return { from: r.from, to: r.to };
  if (r.preset === 'all') return { from: state.meta?.min || today, to: today };
  if (r.preset === 'mtd') return { from: today.slice(0, 8) + '01', to: today };
  return { from: isoDay(Date.now() - (Number(r.preset) - 1) * DAY), to: today };
}
const qs = (extra = {}) => new URLSearchParams({ ...rangeDates(), ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== '' && v != null)) }).toString();
async function api(path) {
  const res = await fetch(path);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

/* ---------- controls ---------- */
function syncControls() {
  const { from, to } = rangeDates();
  $('#from').value = from; $('#to').value = to;
  document.querySelectorAll('#range-seg button').forEach((b) => b.classList.toggle('on', b.dataset.range === state.range.preset));
  try { localStorage.setItem('pgu.range', JSON.stringify(state.range)); } catch {}
}
$('#range-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.range = { preset: b.dataset.range }; if (state.log) state.log.page = 1; route();
});
['from', 'to'].forEach((id) => $('#' + id).addEventListener('change', () => {
  const from = $('#from').value, to = $('#to').value;
  if (!from || !to || from > to) return;
  state.range = { preset: 'custom', from, to }; if (state.log) state.log.page = 1; route();
}));
$('#refresh').addEventListener('click', async () => { state.meta = await api('/api/meta'); route(); });
$('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

/* ---------- charts ---------- */
function destroyCharts() { state.charts.forEach((c) => c.destroy()); state.charts = []; }

function dailyChart(canvas, legendEl, daily, metric) {
  const { from, to } = rangeDates();
  const days = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY) days.push(isoDay(t));
  const models = Object.keys(state.meta.models).filter((m) => daily.some((d) => d.model === m));
  const idx = Object.fromEntries(days.map((d, i) => [d, i]));
  const datasets = models.map((m) => {
    const data = new Array(days.length).fill(0);
    daily.forEach((d) => { if (d.model === m && idx[d.day] != null) data[idx[d.day]] += d[metric]; });
    return {
      label: modelLabel(m), key: m, data, backgroundColor: MODEL_COLORS[m], hoverBackgroundColor: MODEL_COLORS[m],
      borderColor: '#15151e', borderWidth: days.length > 60 ? 0 : { top: 2 }, borderSkipped: false,
      borderRadius: 3, maxBarThickness: 28,
    };
  });
  const fmt = metric === 'cost' ? (v) => usd(v) : metric === 'tokens' ? tok : int;
  legendEl.innerHTML = models.map((m) => `<button data-m="${m}">${swatch(m)}${esc(modelLabel(m))}</button>`).join('');
  const chart = new Chart(canvas, {
    type: 'bar',
    data: { labels: days, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: true, grid: { display: false }, border: { color: '#252533' },
          ticks: { color: '#64748b', maxRotation: 0, autoSkipPadding: 18, font: { family: 'Space Mono', size: 10.5 },
            callback: (v, i) => new Date(days[i] + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) } },
        y: { stacked: true, grid: { color: '#1f1f2c' }, border: { display: false },
          ticks: { color: '#64748b', font: { family: 'Space Mono', size: 10.5 }, callback: (v) => fmt(v), maxTicksLimit: 6 } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1d1d2a', borderColor: '#34344a', borderWidth: 1, padding: 10, boxPadding: 4,
          titleColor: '#f8fafc', bodyColor: '#cbd5e1', footerColor: '#f8fafc',
          titleFont: { family: 'DM Sans', weight: '600' }, bodyFont: { family: 'Space Mono', size: 11.5 }, footerFont: { family: 'Space Mono', size: 11.5 },
          filter: (item) => item.raw > 0, itemSort: (a, b) => b.raw - a.raw,
          callbacks: {
            title: (items) => items.length ? fmtDate(items[0].label) : '',
            label: (item) => ` ${item.dataset.label}: ${fmt(item.raw)}`,
            footer: (items) => items.length ? `Total: ${fmt(items.reduce((s, i) => s + i.raw, 0))}` : 'No usage',
          },
        },
      },
    },
  });
  legendEl.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const i = datasets.findIndex((d) => d.key === b.dataset.m);
    chart.setDatasetVisibility(i, !chart.isDatasetVisible(i)); chart.update();
    b.classList.toggle('off', !chart.isDatasetVisible(i));
  };
  state.charts.push(chart);
}

function chartSection(title, id, daily) {
  return `<section class="section">
    <div class="section-head"><h2>${title}</h2><span class="spacer"></span>
      <div class="seg" data-metric-seg="${id}">
        ${[['cost', 'Spend'], ['tokens', 'Tokens'], ['requests', 'Requests']].map(([k, l]) => `<button data-metric="${k}" class="${state.metric === k ? 'on' : ''}">${l}</button>`).join('')}
      </div></div>
    <div class="card chart-card">
      <div class="legend" id="${id}-legend"></div>
      <div class="chart-wrap"><canvas id="${id}" aria-label="${title}" role="img"></canvas></div>
    </div></section>`;
}
function mountChart(id, daily) {
  const draw = () => {
    state.charts.filter((c) => c.canvas.id === id).forEach((c) => c.destroy());
    state.charts = state.charts.filter((c) => c.canvas.id !== id);
    if (!daily.length) { $('#' + id).parentElement.innerHTML = '<div class="empty">No usage in this range.</div>'; return; }
    dailyChart($('#' + id), $(`#${id}-legend`), daily, state.metric);
  };
  $(`[data-metric-seg="${id}"]`).onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.metric = b.dataset.metric;
    b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    draw();
  };
  draw();
}

/* ---------- shared blocks ---------- */
function kpiTiles(t, p, extra = []) {
  const tiles = [
    { label: 'API Spend', value: usd(t.cost, t.cost < 1e5), cls: 'green', sub: delta(t.cost, p.cost) },
    { label: 'Total Tokens', value: tok(t.tokens), sub: delta(t.tokens, p.tokens) },
    { label: 'Requests', value: int(t.requests), sub: delta(t.requests, p.requests) },
    ...extra,
    { label: 'Credits Billed', value: int(t.credits), sub: `<span class="sub">${usd(retail(t.credits))} retail</span>` },
    { label: 'Gross Margin', value: t.credits ? pct(margin(t)) : '—', sub: `<span class="sub">${usd(retail(t.credits) - t.cost)} after API cost</span>` },
  ];
  return `<div class="grid tiles">${tiles.map((x) => `<div class="card tile">
    <div class="label">${x.label}</div><div class="value ${x.cls || ''}">${x.value}</div>${x.sub || ''}</div>`).join('')}</div>`;
}

function modelCards(byModel, totalCost, showAll) {
  const rows = Object.keys(state.meta.models).map((m) => byModel.find((r) => r.model === m) || { model: m, cost: 0, tokens: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, images: 0, requests: 0 })
    .filter((r) => showAll || r.requests);
  if (!rows.length) return '<div class="card empty">No model usage in this range.</div>';
  return `<div class="grid models">${rows.map((r) => {
    const m = state.meta.models[r.model];
    const share = totalCost ? r.cost / totalCost : 0;
    return `<div class="card model-card" style="--c:${MODEL_COLORS[r.model]}">
      <div class="model-name">${swatch(r.model)}${esc(m.label)}</div>
      <div class="model-api">${esc(m.provider)} · ${esc(m.api)}</div>
      <div class="value">${usd(r.cost)}</div>
      <div class="sub mono muted" style="font-size:12px">${pct(share)} of spend</div>
      <dl class="kv">
        <dt>Total tokens</dt><dd>${tok(r.tokens)}</dd>
        <dt>Input</dt><dd>${tok(r.input_tokens)}</dd>
        <dt>Output</dt><dd>${tok(r.output_tokens)}</dd>
        ${r.cached_tokens ? `<dt>Cached</dt><dd>${tok(r.cached_tokens)}</dd>` : ''}
        ${r.images ? `<dt>Images</dt><dd>${int(r.images)}</dd>` : ''}
        <dt>Requests</dt><dd>${int(r.requests)}</dd>
        <dt>Avg / request</dt><dd>${r.requests ? usd(r.cost / r.requests) : '—'}</dd>
      </dl>
      <div class="share"><span style="width:${(share * 100).toFixed(1)}%"></span></div>
    </div>`;
  }).join('')}</div>`;
}

function modelTable(byModel, t) {
  return `<div class="card table-wrap" style="padding:6px 6px 0"><table>
    <thead><tr><th>Model</th><th>API model</th><th class="num">Requests</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cached</th><th class="num">Images</th><th class="num">Total tokens</th><th class="num">API spend</th><th class="num">Share</th></tr></thead>
    <tbody>${byModel.map((r) => `<tr><td>${modelTag(r.model)}</td><td class="mono muted" style="font-size:12px">${esc(state.meta.models[r.model]?.api)}</td>
      <td class="num">${int(r.requests)}</td><td class="num">${int(r.input_tokens)}</td><td class="num">${int(r.output_tokens)}</td>
      <td class="num">${int(r.cached_tokens)}</td><td class="num">${int(r.images)}</td><td class="num">${int(r.tokens)}</td>
      <td class="num">${usd(r.cost, true)}</td><td class="num">${t.cost ? pct(r.cost / t.cost) : '—'}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>Total</td><td></td><td class="num">${int(t.requests)}</td><td class="num">${int(t.input_tokens)}</td><td class="num">${int(t.output_tokens)}</td>
      <td class="num">${int(t.cached_tokens)}</td><td class="num">${int(t.images)}</td><td class="num">${int(t.tokens)}</td><td class="num">${usd(t.cost, true)}</td><td class="num">100%</td></tr></tfoot>
  </table></div>`;
}

function toolTable(byTool, t) {
  const max = Math.max(...byTool.map((r) => r.cost), 0);
  return `<div class="card table-wrap" style="padding:6px 6px 0"><table>
    <thead><tr><th>Tool</th><th class="num">Requests</th><th class="num">Tokens</th><th>API spend</th></tr></thead>
    <tbody>${byTool.map((r) => `<tr><td>${esc(r.tool)}</td><td class="num">${int(r.requests)}</td><td class="num">${tok(r.tokens)}</td>
      <td><div class="bar-cell"><div class="bar"><span style="width:${max ? (r.cost / max * 100).toFixed(1) : 0}%"></span></div><span class="mono" style="font-size:12.5px;min-width:74px;text-align:right">${usd(r.cost)}</span></div></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No usage</td></tr>'}</tbody>
  </table></div>`;
}

/* ---------- pages ---------- */
async function renderOverview() {
  $('#page-title').textContent = '📊 Usage Overview';
  const d = await api('/api/overview?' + qs());
  const t = d.totals, p = d.previous;
  view.innerHTML = `
    ${state.meta.demo ? `<div class="banner">⚠️ Showing seeded demo data. Point PropGenie at <a href="#/ingest">POST /api/usage</a> and run <code>npm run reset</code> to go live.</div>` : ''}
    ${kpiTiles(t, p, [{ label: 'Active Clients', value: int(t.clients), sub: delta(t.clients, p.clients) }])}
    <section class="section">
      <div class="section-head"><h2>Spend by model</h2><span class="hint">${usd(t.cost)} · ${tok(t.tokens)} tokens</span></div>
      ${modelCards(d.byModel, t.cost, true)}
    </section>
    <section class="section">
      <div class="section-head"><h2>Token usage by model</h2></div>
      ${modelTable(d.byModel, t)}
    </section>
    ${chartSection('Daily usage by model', 'ov-daily')}
    <div class="grid two-col section">
      <section>
        <div class="section-head"><h2>Top clients</h2><span class="spacer"></span><a class="btn" href="#/clients">All clients →</a></div>
        <div class="card table-wrap" style="padding:6px 6px 0"><table>
          <thead><tr><th>Client</th><th>Plan</th><th class="num">Requests</th><th class="num">Tokens</th><th class="num">API spend</th></tr></thead>
          <tbody>${d.topClients.map((c) => `<tr class="clickable" data-href="#/clients/${encodeURIComponent(c.id)}"><td>${esc(c.name)}</td><td><span class="pill ${esc(c.plan)}">${esc(c.plan || '—')}</span></td>
            <td class="num">${int(c.requests)}</td><td class="num">${tok(c.tokens)}</td><td class="num">${usd(c.cost)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No usage</td></tr>'}</tbody>
        </table></div>
      </section>
      <section>
        <div class="section-head"><h2>Spend by tool</h2></div>
        ${toolTable(d.byTool, t)}
      </section>
    </div>`;
  mountChart('ov-daily', d.daily);
}

async function renderClients(id) {
  $('#page-title').textContent = '👥 Client Usage';
  const clients = await api('/api/clients?' + qs());
  state.clients = clients;
  if (!clients.length) { view.innerHTML = '<div class="card empty">No clients yet. Events posted to /api/usage create clients automatically.</div>'; return; }
  if (!id || !clients.some((c) => c.id === id)) { location.replace('#/clients/' + encodeURIComponent(clients[0].id)); return; }
  if (state.log?.client !== id) state.log = { client: id, model: '', tool: '', sort: 'ts', page: 1 };

  const q = $('#client-search')?.value || '';
  view.innerHTML = `<div class="split">
    <div class="client-list">
      <div class="search"><input class="input" id="client-search" placeholder="Search ${clients.length} clients…" value="${esc(q)}" /></div>
      <div class="items" id="client-items"></div>
    </div>
    <div id="client-detail"><div class="loading">Loading client…</div></div>
  </div>`;
  const drawList = () => {
    const needle = $('#client-search').value.trim().toLowerCase();
    $('#client-items').innerHTML = clients.filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle))
      .map((c) => `<a class="client-item ${c.id === id ? 'active' : ''}" href="#/clients/${encodeURIComponent(c.id)}">
        <span class="name">${esc(c.name)}</span><span class="amt">${usd(c.cost)}</span></a>`).join('') || '<div class="empty" style="padding:20px">No match</div>';
  };
  $('#client-search').addEventListener('input', drawList);
  drawList();
  $('#client-items .active')?.scrollIntoView({ block: 'nearest' });

  const d = await api(`/api/clients/${encodeURIComponent(id)}?` + qs());
  const c = d.client, t = d.totals, p = d.previous;
  const usedModels = d.byModel.map((r) => r.model);
  const tools = [...new Set(d.byTool.map((r) => r.tool))];
  $('#client-detail').innerHTML = `
    <div class="detail-head">
      <h2>${esc(c.name)}</h2><span class="pill ${esc(c.plan)}">${esc(c.plan || 'No plan')}</span>
      <span class="muted mono" style="font-size:12px">${esc(c.id)}</span><span class="spacer" style="flex:1"></span>
      <span class="muted" style="font-size:13px">Client since ${fmtDate(c.created_at)} · Last active ${c.last_active ? fmtDate(c.last_active) : 'never'}</span>
    </div>
    ${kpiTiles(t, p, [{ label: 'Avg Cost / Request', value: t.requests ? usd(t.cost / t.requests) : '—', sub: `<span class="sub">${t.requests ? tok(t.tokens / t.requests) : 0} tokens / request</span>` }])}
    <section class="section">
      <div class="section-head"><h2>Spend by model</h2><span class="hint">${usd(t.cost)} · ${tok(t.tokens)} tokens</span></div>
      ${modelCards(d.byModel, t.cost, false)}
    </section>
    <section class="section">
      <div class="section-head"><h2>Usage by tool &amp; model</h2><span class="muted" style="font-size:13px">Click a row to filter the usage log</span></div>
      <div class="card table-wrap" style="padding:6px 6px 0"><table>
        <thead><tr><th>Tool</th><th>Model</th><th class="num">Requests</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cached</th><th class="num">Images</th><th class="num">Total tokens</th><th class="num">API spend</th><th class="num">Credits</th><th class="num">Share</th></tr></thead>
        <tbody>${d.byToolModel.map((r) => `<tr class="clickable ${state.log.tool === r.tool && state.log.model === r.model ? 'selected' : ''}" data-tool="${esc(r.tool)}" data-model="${esc(r.model)}">
          <td>${esc(r.tool)}</td><td>${modelTag(r.model)}</td><td class="num">${int(r.requests)}</td><td class="num">${int(r.input_tokens)}</td><td class="num">${int(r.output_tokens)}</td>
          <td class="num">${int(r.cached_tokens)}</td><td class="num">${int(r.images)}</td><td class="num">${int(r.tokens)}</td><td class="num">${usd(r.cost, true)}</td>
          <td class="num">${int(r.credits)}</td><td class="num">${t.cost ? pct(r.cost / t.cost) : '—'}</td></tr>`).join('') || '<tr><td colspan="11" class="muted">No usage in this range</td></tr>'}</tbody>
        ${d.byToolModel.length ? `<tfoot><tr><td>Total</td><td></td><td class="num">${int(t.requests)}</td><td class="num">${int(t.input_tokens)}</td><td class="num">${int(t.output_tokens)}</td>
          <td class="num">${int(t.cached_tokens)}</td><td class="num">${int(t.images)}</td><td class="num">${int(t.tokens)}</td><td class="num">${usd(t.cost, true)}</td><td class="num">${int(t.credits)}</td><td class="num">100%</td></tr></tfoot>` : ''}
      </table></div>
    </section>
    ${chartSection('Daily usage by model', 'cl-daily')}
    <section class="section" id="log">
      <div class="section-head"><h2>Usage log</h2><span class="hint" id="log-count"></span><span class="spacer"></span><button class="btn" id="export">⬇ Export CSV</button></div>
      <div class="filters">
        <div class="chips" id="model-chips">
          <button class="chip" data-model="">All models</button>
          ${usedModels.map((m) => `<button class="chip" data-model="${m}">${swatch(m)}${esc(modelLabel(m))}</button>`).join('')}
        </div>
        <select class="input" id="tool-filter"><option value="">All tools</option>${tools.map((x) => `<option>${esc(x)}</option>`).join('')}</select>
        <select class="input" id="sort"><option value="ts">Newest first</option><option value="cost">Highest cost</option><option value="tokens">Most tokens</option></select>
        <button class="btn" id="clear-filters" hidden>Clear filters</button>
      </div>
      <div class="card table-wrap" style="padding:6px 6px 0"><table>
        <thead><tr><th>Time</th><th>Tool</th><th>Model</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cached</th><th class="num">Images</th><th class="num">Total tokens</th><th class="num">API cost</th><th class="num">Credits</th></tr></thead>
        <tbody id="log-rows"><tr><td colspan="10" class="muted">Loading…</td></tr></tbody>
      </table></div>
      <div class="pager" id="pager"></div>
    </section>`;

  mountChart('cl-daily', d.daily);
  $('#client-detail tbody').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-tool]'); if (!row) return;
    const same = state.log.tool === row.dataset.tool && state.log.model === row.dataset.model;
    Object.assign(state.log, same ? { tool: '', model: '' } : { tool: row.dataset.tool, model: row.dataset.model }, { page: 1 });
    document.querySelectorAll('tr[data-tool]').forEach((r) => r.classList.toggle('selected', !same && r === row));
    loadLog(); if (!same) $('#log').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#model-chips').onclick = (e) => { const b = e.target.closest('.chip'); if (!b) return; Object.assign(state.log, { model: b.dataset.model, page: 1 }); loadLog(); };
  $('#tool-filter').onchange = (e) => { Object.assign(state.log, { tool: e.target.value, page: 1 }); loadLog(); };
  $('#sort').onchange = (e) => { Object.assign(state.log, { sort: e.target.value, page: 1 }); loadLog(); };
  $('#clear-filters').onclick = () => { Object.assign(state.log, { model: '', tool: '', page: 1 }); loadLog(); };
  $('#export').onclick = () => exportCsv(c);
  loadLog();
}

function logParams(extra = {}) {
  const L = state.log;
  return qs({ model: L.model, tool: L.tool, sort: L.sort, page: L.page, limit: 50, ...extra });
}
async function loadLog() {
  const L = state.log;
  document.querySelectorAll('#model-chips .chip').forEach((b) => b.classList.toggle('on', b.dataset.model === L.model));
  const tf = $('#tool-filter');
  if (L.tool && ![...tf.options].some((o) => o.value === L.tool)) tf.add(new Option(L.tool, L.tool));
  tf.value = L.tool; $('#sort').value = L.sort;
  $('#clear-filters').hidden = !L.model && !L.tool;
  document.querySelectorAll('tr[data-tool]').forEach((r) => r.classList.toggle('selected', r.dataset.tool === L.tool && r.dataset.model === L.model));

  const d = await api(`/api/clients/${encodeURIComponent(L.client)}/events?` + logParams());
  if (state.log !== L) return;
  const pages = Math.max(1, Math.ceil(d.total / d.limit));
  $('#log-count').textContent = `${int(d.total)} events`;
  $('#log-rows').innerHTML = d.rows.map((r) => `<tr>
    <td class="mono" style="font-size:12px">${fmtTs(r.ts)}</td><td>${esc(r.tool)}</td><td>${modelTag(r.model)}</td>
    <td class="num">${int(r.input_tokens)}</td><td class="num">${int(r.output_tokens)}</td><td class="num">${int(r.cached_tokens)}</td>
    <td class="num">${int(r.images)}</td><td class="num">${int(r.input_tokens + r.output_tokens + r.cached_tokens)}</td>
    <td class="num">${usd(r.cost_usd)}</td><td class="num">${int(r.credits)}</td></tr>`).join('') || '<tr><td colspan="10" class="muted">No events match these filters.</td></tr>';
  $('#pager').innerHTML = `<span>Page ${d.page} of ${pages}</span>
    <button class="btn" data-p="${d.page - 1}" ${d.page <= 1 ? 'disabled' : ''}>← Prev</button>
    <button class="btn" data-p="${d.page + 1}" ${d.page >= pages ? 'disabled' : ''}>Next →</button>`;
  $('#pager').onclick = (e) => { const b = e.target.closest('button[data-p]'); if (!b || b.disabled) return; L.page = Number(b.dataset.p); loadLog(); };
}

async function exportCsv(client) {
  const btn = $('#export'); btn.disabled = true; btn.textContent = 'Exporting…';
  try {
    const rows = [];
    for (let page = 1; ; page++) {
      const d = await api(`/api/clients/${encodeURIComponent(client.id)}/events?` + logParams({ page, limit: 500 }));
      rows.push(...d.rows);
      if (rows.length >= d.total || !d.rows.length) break;
    }
    const head = ['timestamp_utc', 'client_id', 'client_name', 'tool', 'model', 'api_model', 'input_tokens', 'output_tokens', 'cached_tokens', 'images', 'total_tokens', 'api_cost_usd', 'credits', 'request_id'];
    const cell = (v) => /[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : (v ?? '');
    const csv = [head.join(','), ...rows.map((r) => [r.ts, client.id, client.name, r.tool, r.model, state.meta.models[r.model]?.api,
      r.input_tokens, r.output_tokens, r.cached_tokens, r.images, r.input_tokens + r.output_tokens + r.cached_tokens,
      r.cost_usd.toFixed(6), r.credits, r.request_id].map(cell).join(','))].join('\n');
    const { from, to } = rangeDates();
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
      download: `${client.id}_usage_${from}_${to}.csv`,
    });
    a.click(); URL.revokeObjectURL(a.href);
  } finally { btn.disabled = false; btn.textContent = '⬇ Export CSV'; }
}

function renderPricing() {
  $('#page-title').textContent = '💲 Model Pricing';
  const M = state.meta.models;
  view.innerHTML = `
    <p class="muted" style="margin-top:0">Provider list prices used to compute API cost for every event (USD per 1M tokens). Edit <code>lib/pricing.js</code> when a provider changes prices — new events use the new rates; existing events keep the cost they were logged with.</p>
    <div class="card table-wrap" style="padding:6px 6px 0"><table>
      <thead><tr><th>PropGenie model</th><th>Provider</th><th>API model</th><th class="num">Input / 1M</th><th class="num">Output / 1M</th><th class="num">Cached / 1M</th><th class="num">Per image</th></tr></thead>
      <tbody>${Object.entries(M).map(([k, m]) => `<tr><td>${modelTag(k)}</td><td>${esc(m.provider)}</td><td class="mono" style="font-size:12px">${esc(m.api)}</td>
        <td class="num">${usd(m.in)}</td><td class="num">${m.out ? usd(m.out) : '—'}</td><td class="num">${m.cached ? usd(m.cached) : '—'}</td><td class="num">${m.perImage ? usd(m.perImage) : '—'}</td></tr>`).join('')}</tbody>
    </table></div>
    <section class="section"><div class="grid tiles">
      <div class="card tile"><div class="label">Credit value</div><div class="value">${usd(state.meta.creditValue)}</div><span class="sub">retail per credit</span></div>
      <div class="card tile"><div class="label">Markup</div><div class="value">${state.meta.markup}×</div><span class="sub">${pct(1 - 1 / state.meta.markup)} target margin</span></div>
      <div class="card tile"><div class="label">Rounding</div><div class="value">Up</div><span class="sub">credits rounded up per action</span></div>
    </div></section>`;
}

function renderIngest() {
  $('#page-title').textContent = '🔌 Ingest API';
  const origin = location.origin;
  view.innerHTML = `
    <div class="card">
      <p style="margin-top:0">PropGenie logs one event per model call. Cost and credits are computed server-side from the <a href="#/pricing" style="text-decoration:underline">pricing table</a> unless you send <code>cost_usd</code> / <code>credits</code> yourself. Unknown clients are created automatically. <code>request_id</code> is deduplicated, so retries are safe.</p>
      <pre class="code">curl -X POST ${esc(origin)}/api/usage \\
  -H "content-type: application/json" \\
  -H "x-ingest-key: $INGEST_KEY" \\
  -d '{
    "client_id": "cl_acme",
    "client_name": "Acme Funding",
    "plan": "Pro",
    "tool": "Social Post Writer",
    "model": "genie-pro",
    "input_tokens": 2140,
    "output_tokens": 612,
    "cached_tokens": 0,
    "images": 0,
    "request_id": "req_8f2c1",
    "ts": "2026-09-30T14:02:11Z"
  }'</pre>
      <p class="muted" style="margin-bottom:0">Send an array to batch many events in one call. <code>model</code> must be one of: ${Object.keys(state.meta.models).map((m) => `<code>${m}</code>`).join(', ')}. Set <code>INGEST_KEY</code> in the server environment (dev default <code>pg-usage-dev-key</code>).</p>
    </div>`;
}

/* ---------- router ---------- */
async function route() {
  destroyCharts();
  syncControls();
  const [, page = '', id] = location.hash.replace(/^#/, '').split('/');
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (page || 'overview')));
  $('#sidebar').classList.remove('open');
  $('#controls').style.display = ['pricing', 'ingest'].includes(page) ? 'none' : '';
  try {
    if (page === 'clients') {
      if (!$('#client-detail')) view.innerHTML = '<div class="loading">Loading clients…</div>';
      await renderClients(id && decodeURIComponent(id));
    }
    else if (page === 'pricing') renderPricing();
    else if (page === 'ingest') renderIngest();
    else { view.innerHTML = '<div class="loading">Loading usage…</div>'; await renderOverview(); }
  } catch (err) {
    view.innerHTML = `<div class="card empty">Couldn't load data: ${esc(err.message)}</div>`;
  }
}
view.addEventListener('click', (e) => { const r = e.target.closest('tr[data-href]'); if (r) location.hash = r.dataset.href; });
window.addEventListener('hashchange', route);

(async () => {
  Chart.defaults.font.family = "'DM Sans', sans-serif";
  state.meta = await api('/api/meta');
  $('#data-status').innerHTML = `${state.meta.demo ? '<span class="pill demo">Demo data</span><br>' : ''}Data through ${fmtDate(state.meta.max)}`;
  route();
})();
