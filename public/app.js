/* PropGenie Usage dashboard — vanilla SPA, hash-routed. Data: FPFX Wallet API (live) or seeded demo. */
// Validated dark categorical slots, assigned to services in their fixed Wallet order (never by rank).
const PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9'];
const OTHER = '#6b7280';
const DAY = 864e5;
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const state = { meta: null, range: { preset: '30' }, charts: [], log: null, metric: 'usd' };

try { const saved = JSON.parse(localStorage.getItem('pgu.range')); if (saved?.preset) state.range = saved; } catch {}

/* ---------- formatting ---------- */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function usd(v, full = false) {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (!full && a >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (!full && a >= 1e4) return '$' + (v / 1e3).toFixed(1) + 'K';
  if (a >= 1 || a === 0) return (v < 0 ? '-$' : '$') + a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (a >= 0.01) return (v < 0 ? '-$' : '$') + a.toFixed(4).replace(/0{1,2}$/, '');
  return (v < 0 ? '-$' : '$') + Number(a.toPrecision(2)).toFixed(Math.min(10, 1 - Math.floor(Math.log10(a)))).replace(/0+$/, '');
}
const signed = (v, f) => (v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + f(Math.abs(v)));
function compact(v) {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(1) + 'K';
  return Math.round(v).toLocaleString('en-US');
}
const int = (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'));
const pct = (v) => (v * 100).toFixed(1) + '%';
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const fmtDate = (d) => d ? new Date(d.length === 10 ? d + 'T00:00:00Z' : d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—';
const fmtTs = (d) => d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC' : '—';
const ago = (d) => { if (!d) return 'never'; const m = Math.round((Date.now() - Date.parse(d)) / 60e3); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

// Service colours follow the Wallet's service order; past the 7th, services share the neutral "Other" tone.
function serviceColor(name) {
  const i = (state.meta?.settings.services || []).findIndex((s) => s.name === name);
  return i >= 0 && i < PALETTE.length ? PALETTE[i] : OTHER;
}
const swatch = (c) => `<span class="swatch" style="--c:${c}"></span>`;
const svcTag = (s) => `<span class="tag-model">${swatch(serviceColor(s))}${esc(s || 'Unassigned')}</span>`;

function delta(cur, prev) {
  if (prev == null || cur == null) return '';
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
  if (r.preset === 'all') return { from: '2025-01-01', to: today };
  if (r.preset === 'mtd') return { from: today.slice(0, 8) + '01', to: today };
  return { from: isoDay(Date.now() - (Number(r.preset) - 1) * DAY), to: today };
}
const qs = (extra = {}) => new URLSearchParams({ ...rangeDates(), ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== '' && v != null)) }).toString();
async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
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
$('#refresh').addEventListener('click', async () => {
  const b = $('#refresh'); b.disabled = true;
  try { await api('/api/refresh', { method: 'POST' }); await loadMeta(); await route(); } finally { b.disabled = false; }
});
$('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

/* ---------- charts ---------- */
const METRICS = { usd: ['Spend', (v) => usd(v)], credits: ['Credits', compact], transactions: ['Uses', int] };

function dailyChart(canvas, legendEl, daily, metric) {
  const { from, to } = rangeDates();
  const first = daily.length ? daily[0].day : from;
  const start = state.range.preset === 'all' ? first : from;
  const days = [];
  for (let t = Date.parse(start); t <= Date.parse(to); t += DAY) days.push(isoDay(t));
  const idx = Object.fromEntries(days.map((d, i) => [d, i]));
  // Series = coloured services in Wallet order, then everything else folded into "Other".
  const order = (state.meta.settings.services || []).map((s) => s.name);
  const present = [...new Set(daily.map((d) => d.service))];
  const named = order.filter((s) => present.includes(s) && serviceColor(s) !== OTHER);
  const keyOf = (s) => (named.includes(s) ? s : 'Other');
  const keys = [...named, ...(present.some((s) => !named.includes(s)) ? ['Other'] : [])];
  const datasets = keys.map((k) => {
    const data = new Array(days.length).fill(0);
    daily.forEach((d) => { if (keyOf(d.service) === k && idx[d.day] != null) data[idx[d.day]] += Math.abs(d[metric]); });
    const color = k === 'Other' ? OTHER : serviceColor(k);
    return { label: k, data, backgroundColor: color, hoverBackgroundColor: color, borderColor: '#15151e',
      borderWidth: days.length > 60 ? 0 : { top: 2 }, borderSkipped: false, borderRadius: 3, maxBarThickness: 28 };
  });
  const fmt = METRICS[metric][1];
  legendEl.innerHTML = keys.map((k) => `<button data-k="${esc(k)}">${swatch(k === 'Other' ? OTHER : serviceColor(k))}${esc(k)}</button>`).join('');
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
    const i = keys.indexOf(b.dataset.k);
    chart.setDatasetVisibility(i, !chart.isDatasetVisible(i)); chart.update();
    b.classList.toggle('off', !chart.isDatasetVisible(i));
  };
  state.charts.push(chart);
}

function chartSection(title, id) {
  return `<section class="section">
    <div class="section-head"><h2>${title}</h2><span class="spacer"></span>
      <div class="seg" data-metric-seg="${id}">
        ${Object.entries(METRICS).map(([k, [l]]) => `<button data-metric="${k}" class="${state.metric === k ? 'on' : ''}">${l}</button>`).join('')}
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
const tiles = (list) => `<div class="grid tiles">${list.map((x) => `<div class="card tile">
  <div class="label">${x.label}</div><div class="value ${x.cls || ''}">${x.value}</div>${x.sub || ''}</div>`).join('')}</div>`;

function usageTiles(t, p, extra = []) {
  const markup = state.meta.settings.markupPercent;
  return tiles([
    { label: 'Customer Spend', value: usd(t.usd, t.usd < 1e5), cls: 'green', sub: (delta(t.usd, p?.usd) || '<span class="sub">tool usage charged to wallets</span>')
      + (t.otherDebits > 0.005 ? `<br><span class="sub">+ ${usd(t.otherDebits)} manual admin debits excluded</span>` : '') },
    { label: 'Credits Used', value: compact(t.credits), sub: delta(t.credits, p?.credits) || `<span class="sub">${int(t.credits)} credits</span>` },
    { label: state.meta.live ? 'Est. API Cost' : 'API Cost', value: usd(t.apiCost),
      sub: state.meta.live ? `<span class="sub">spend × (1 − ${markup ?? '?'}% markup)</span>` : delta(t.apiCost, p?.apiCost) },
    { label: 'Uses', value: int(t.transactions), sub: delta(t.transactions, p?.transactions) || '<span class="sub">tool transactions</span>' },
    ...extra,
  ]);
}

function serviceCards(byService, total) {
  if (!byService.length) return '<div class="card empty">No usage in this range.</div>';
  return `<div class="grid models">${byService.map((r) => {
    const share = total ? Math.abs(r.usd) / Math.abs(total) : 0;
    return `<div class="card model-card" style="--c:${serviceColor(r.service)}">
      <div class="model-name">${swatch(serviceColor(r.service))}${esc(r.service)}</div>
      <div class="value">${usd(Math.abs(r.usd))}</div>
      <div class="sub mono muted" style="font-size:12px">${pct(share)} of spend</div>
      <dl class="kv">
        <dt>Credits used</dt><dd>${int(Math.abs(r.credits))}</dd>
        <dt>Uses</dt><dd>${int(r.transactions)}</dd>
        <dt>Avg credits / use</dt><dd>${r.transactions ? compact(Math.abs(r.credits) / r.transactions) : '—'}</dd>
        ${r.apiCost != null ? `<dt>${state.meta.live ? 'Est. API cost' : 'API cost'}</dt><dd>${usd(Math.abs(r.apiCost))}</dd>` : ''}
      </dl>
      <div class="share"><span style="width:${(share * 100).toFixed(1)}%"></span></div>
    </div>`;
  }).join('')}</div>`;
}

const canFilter = (clickable, r) => clickable && !(state.meta.live && r.service === 'Unattributed');
function serviceTable(byService, t, clickable) {
  return `<div class="card table-wrap" style="padding:6px 6px 0"><table>
    <thead><tr><th>Service / tool</th><th class="num">Uses</th><th class="num">Credits</th><th class="num">Spend</th><th class="num">${state.meta.live ? 'Est. API cost' : 'API cost'}</th><th class="num">Share</th></tr></thead>
    <tbody>${byService.map((r) => `<tr class="${canFilter(clickable, r) ? 'clickable' : ''} ${clickable && state.log?.service === r.service ? 'selected' : ''}" ${canFilter(clickable, r) ? `data-service="${esc(r.service)}"` : ''}>
      <td>${svcTag(r.service)}</td><td class="num">${int(r.transactions)}</td><td class="num">${int(Math.abs(r.credits))}</td>
      <td class="num">${usd(Math.abs(r.usd), true)}</td><td class="num">${usd(r.apiCost == null ? null : Math.abs(r.apiCost), true)}</td>
      <td class="num">${t.usd ? pct(Math.abs(r.usd) / Math.abs(t.usd)) : '—'}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No usage in this range</td></tr>'}</tbody>
    ${byService.length ? `<tfoot><tr><td>Total</td><td class="num">${int(t.transactions)}</td><td class="num">${int(Math.abs(t.credits))}</td><td class="num">${usd(Math.abs(t.usd), true)}</td><td class="num">${usd(t.apiCost == null ? null : Math.abs(t.apiCost), true)}</td><td class="num">100%</td></tr></tfoot>` : ''}
  </table></div>`;
}

// Per-model LLM tokens — only rendered when the source provides them (demo today; live once the Wallet API exposes llm/tokensIn/tokensOut).
function modelSection(byModel) {
  if (!byModel?.length) return '';
  return `<section class="section">
    <div class="section-head"><h2>LLM tokens by model</h2></div>
    <div class="card table-wrap" style="padding:6px 6px 0"><table>
      <thead><tr><th>Model</th><th class="num">Uses</th><th class="num">Input tokens</th><th class="num">Output tokens</th><th class="num">Credits</th><th class="num">Spend</th><th class="num">API cost</th></tr></thead>
      <tbody>${byModel.map((m) => `<tr><td>${esc(m.label || m.llm || m.model)} <span class="muted mono" style="font-size:11.5px">${esc(m.llm || '')}</span></td>
        <td class="num">${int(m.transactions)}</td><td class="num">${int(m.tokensIn)}</td><td class="num">${int(m.tokensOut)}</td>
        <td class="num">${int(m.credits)}</td><td class="num">${usd(m.usd, true)}</td><td class="num">${usd(m.apiCost, true)}</td></tr>`).join('')}</tbody>
    </table></div></section>`;
}

const banner = () => state.meta.live ? '' :
  `<div class="banner">⚠️ Showing seeded demo data. Add <code>WALLET_API_TOKEN</code> to switch to live PropGenie usage from the Wallet API — see <a href="#/settings">Settings</a>.</div>`;

/* ---------- pages ---------- */
async function renderOverview() {
  $('#page-title').textContent = '📊 Usage Overview';
  const d = await api('/api/overview?' + qs());
  const t = d.totals, p = d.previous;
  view.innerHTML = `${banner()}
    ${usageTiles(t, p, [
      { label: 'Active Customers', value: int(t.customers), sub: delta(t.customers, p?.customers) || '<span class="sub">with usage in range</span>' },
      ...(t.balance != null ? [{ label: 'Wallet Balances', value: usd(t.balance, t.balance < 1e5), sub: '<span class="sub">available across customers</span>' }] : []),
    ])}
    <section class="section">
      <div class="section-head"><h2>Usage by service</h2><span class="hint">${usd(Math.abs(t.usd))} · ${compact(Math.abs(t.credits))} credits</span></div>
      ${serviceCards(d.byService, t.usd)}
    </section>
    ${modelSection(d.byModel)}
    ${chartSection('Daily usage by service', 'ov-daily')}
    <div class="grid two-col section">
      <section>
        <div class="section-head"><h2>Top customers</h2><span class="spacer"></span><a class="btn" href="#/clients">All customers →</a></div>
        <div class="card table-wrap" style="padding:6px 6px 0"><table>
          <thead><tr><th>Customer</th><th class="num">Uses</th><th class="num">Credits</th><th class="num">Spend</th>${t.balance != null ? '<th class="num">Balance</th>' : ''}</tr></thead>
          <tbody>${d.topClients.map((c) => `<tr class="clickable" data-href="#/clients/${encodeURIComponent(c.id)}"><td>${esc(c.name)}</td>
            <td class="num">${int(c.transactions)}</td><td class="num">${compact(Math.abs(c.credits))}</td><td class="num">${usd(Math.abs(c.usd))}</td>
            ${t.balance != null ? `<td class="num">${usd(c.balance)}</td>` : ''}</tr>`).join('') || '<tr><td colspan="5" class="muted">No usage</td></tr>'}</tbody>
        </table></div>
      </section>
      <section>
        <div class="section-head"><h2>Spend by service</h2></div>
        ${serviceTable(d.byService, t, false)}
      </section>
    </div>`;
  mountChart('ov-daily', d.daily);
}

async function renderClients(id) {
  $('#page-title').textContent = '👥 Customer Usage';
  const clients = await api('/api/clients?' + qs());
  if (!clients.length) { view.innerHTML = `${banner()}<div class="card empty">No customers found for this range.</div>`; return; }
  if (!id || !clients.some((c) => c.id === id)) { location.replace('#/clients/' + encodeURIComponent(clients[0].id)); return; }
  if (state.log?.client !== id) state.log = { client: id, service: '', page: 1 };

  const q = $('#client-search')?.value || '';
  view.innerHTML = `${banner()}<div class="split">
    <div class="client-list">
      <div class="search"><input class="input" id="client-search" placeholder="Search ${clients.length} customers…" value="${esc(q)}" /></div>
      <div class="items" id="client-items"></div>
    </div>
    <div id="client-detail"><div class="loading">Loading customer…</div></div>
  </div>`;
  const drawList = () => {
    const needle = $('#client-search').value.trim().toLowerCase();
    $('#client-items').innerHTML = clients.filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle))
      .map((c) => `<a class="client-item ${c.id === id ? 'active' : ''}" href="#/clients/${encodeURIComponent(c.id)}">
        <span class="name">${esc(c.name)}</span><span class="amt">${usd(Math.abs(c.usd))}</span></a>`).join('') || '<div class="empty" style="padding:20px">No match</div>';
  };
  $('#client-search').addEventListener('input', drawList);
  drawList();
  $('#client-items .active')?.scrollIntoView({ block: 'nearest' });

  const d = await api(`/api/clients/${encodeURIComponent(id)}?` + qs());
  const c = d.client, t = d.totals, w = c.wallet;
  const services = d.byService.map((r) => r.service);
  $('#client-detail').innerHTML = `
    <div class="detail-head">
      <h2>${esc(c.name)}</h2>${c.plan ? `<span class="pill ${esc(c.plan)}">${esc(c.plan)}</span>` : ''}
      <span class="muted mono" style="font-size:12px">${esc(c.id)}</span><span style="flex:1"></span>
      <span class="muted" style="font-size:13px">Customer since ${fmtDate(c.createdAt)}</span>
    </div>
    ${usageTiles(t, d.previous, [
      ...(c.balance != null ? [{ label: 'Wallet Balance', value: usd(c.balance), sub: `<span class="sub">${int(c.creditBalance)} credits available</span>` }] : []),
      { label: 'Avg Credits / Use', value: t.transactions ? compact(Math.abs(t.credits) / t.transactions) : '—', sub: `<span class="sub">${t.transactions ? usd(Math.abs(t.usd) / t.transactions) : '—'} per use</span>` },
    ])}
    ${w ? `<section class="section"><div class="card"><dl class="kv wallet-kv">
      <dt>Auto-renewal</dt><dd>${w.autoRenewal ? `On · ${usd(w.autoRenewalUsdBalance)} every ${int(w.autoRenewalFrequencyDays)} days` : 'Off'}</dd>
      <dt>Next renewal</dt><dd>${w.autoRenewal ? fmtDate(w.nextRenewalDate) : '—'}</dd>
      <dt>Starting balance</dt><dd>${usd(w.startingUsdBalance)}</dd>
      <dt>Credit price</dt><dd>${w.conversionUsd && w.conversionTokens ? usd(w.conversionUsd / w.conversionTokens) + ' (custom)' : 'Standard'}</dd>
    </dl></div></section>` : ''}
    <section class="section">
      <div class="section-head"><h2>Usage by service</h2><span class="muted" style="font-size:13px">Click a row to filter the usage log</span></div>
      ${serviceTable(d.byService, t, true)}
    </section>
    ${modelSection(d.byModel)}
    ${chartSection('Daily usage by service', 'cl-daily')}
    ${d.orders ? `<section class="section">
      <div class="section-head"><h2>Credit purchases</h2><span class="hint">${d.orders.length} orders</span></div>
      <div class="card table-wrap" style="padding:6px 6px 0"><table>
        <thead><tr><th>Date</th><th>Package</th><th>Status</th><th class="num">Credits</th><th class="num">Price</th><th>Credited</th></tr></thead>
        <tbody>${d.orders.map((o) => `<tr><td class="mono" style="font-size:12px">${fmtDate(o.createdAt)}</td><td>${esc(o.product)}</td><td>${esc(o.status)}</td>
          <td class="num">${int(o.credits)}</td><td class="num">${usd(o.usd, true)}</td><td class="mono" style="font-size:12px">${o.creditedAt ? fmtDate(o.creditedAt) : '—'}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No purchases</td></tr>'}</tbody>
      </table></div></section>` : ''}
    <section class="section" id="log">
      <div class="section-head"><h2>Usage log</h2><span class="hint" id="log-count"></span><span class="spacer"></span><button class="btn" id="export">⬇ Export CSV</button></div>
      <div class="filters">
        <select class="input" id="service-filter"><option value="">All services</option>${services.filter((x) => !(state.meta.live && x === 'Unattributed')).map((s) => `<option>${esc(s)}</option>`).join('')}</select>
        <button class="btn" id="clear-filters" hidden>Clear filter</button>
      </div>
      <div class="card table-wrap" style="padding:6px 6px 0"><table>
        <thead id="log-head"></thead>
        <tbody id="log-rows"><tr><td class="muted">Loading…</td></tr></tbody>
      </table></div>
      <div class="pager" id="pager"></div>
    </section>`;

  mountChart('cl-daily', d.daily);
  $('#client-detail').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-service]'); if (!row) return;
    const same = state.log.service === row.dataset.service;
    Object.assign(state.log, { service: same ? '' : row.dataset.service, page: 1 });
    loadLog(); if (!same) $('#log').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#service-filter').onchange = (e) => { Object.assign(state.log, { service: e.target.value, page: 1 }); loadLog(); };
  $('#clear-filters').onclick = () => { Object.assign(state.log, { service: '', page: 1 }); loadLog(); };
  $('#export').onclick = () => exportCsv(c);
  loadLog();
}

const logParams = (extra = {}) => qs({ service: state.log.service, page: state.log.page, limit: 50, ...extra });
function logColumns(rows) {
  const has = (k) => rows.some((r) => r[k] != null);
  return [
    ['Time', (r) => `<td class="mono" style="font-size:12px">${fmtTs(r.ts)}</td>`],
    ...(has('action') ? [['Type', (r) => `<td>${esc(r.action)}${r.actor ? ` <span class="muted" style="font-size:12px">· ${esc(r.actor)}</span>` : ''}</td>`]] : []),
    ['Service', (r) => `<td>${r.service ? svcTag(r.service) : '<span class="muted">—</span>'}</td>`],
    ...(has('reason') ? [['Reason', (r) => `<td class="muted">${esc(r.reason || '')}</td>`]] : []),
    ...(has('model') ? [['Model', (r) => `<td>${esc(r.model || '—')}</td>`]] : []),
    ...(has('tokensIn') ? [['Input tokens', (r) => `<td class="num">${int(r.tokensIn)}</td>`, 1], ['Output tokens', (r) => `<td class="num">${int(r.tokensOut)}</td>`, 1]] : []),
    ['Credits', (r) => `<td class="num">${has('action') ? signed(r.credits, int) : int(r.credits)}</td>`, 1],
    ['Amount', (r) => `<td class="num">${has('action') ? signed(r.usd, (v) => usd(v)) : usd(r.usd)}</td>`, 1],
    ...(has('apiCost') ? [['API cost', (r) => `<td class="num">${usd(r.apiCost)}</td>`, 1]] : []),
    ...(has('balanceUsd') ? [['Balance after', (r) => `<td class="num">${usd(r.balanceUsd)}</td>`, 1]] : []),
  ];
}
async function loadLog() {
  const L = state.log;
  const sf = $('#service-filter');
  if (L.service && ![...sf.options].some((o) => o.value === L.service)) sf.add(new Option(L.service, L.service));
  sf.value = L.service;
  $('#clear-filters').hidden = !L.service;
  document.querySelectorAll('tr[data-service]').forEach((r) => r.classList.toggle('selected', r.dataset.service === L.service));

  const d = await api(`/api/clients/${encodeURIComponent(L.client)}/events?` + logParams());
  if (state.log !== L) return;
  const cols = logColumns(d.rows);
  const pages = Math.max(1, Math.ceil(d.total / d.limit));
  $('#log-count').textContent = `${int(d.total)} entries`;
  $('#log-head').innerHTML = `<tr>${cols.map(([h, , n]) => `<th class="${n ? 'num' : ''}">${h}</th>`).join('')}</tr>`;
  $('#log-rows').innerHTML = d.rows.map((r) => `<tr>${cols.map(([, f]) => f(r)).join('')}</tr>`).join('')
    || `<tr><td colspan="${cols.length}" class="muted">No entries for this range.</td></tr>`;
  $('#pager').innerHTML = `<span>Page ${d.page} of ${pages}</span>
    <button class="btn" data-p="${d.page - 1}" ${d.page <= 1 ? 'disabled' : ''}>← Prev</button>
    <button class="btn" data-p="${d.page + 1}" ${d.page >= pages ? 'disabled' : ''}>Next →</button>`;
  $('#pager').onclick = (e) => { const b = e.target.closest('button[data-p]'); if (!b || b.disabled) return; L.page = Number(b.dataset.p); loadLog(); };
}

async function exportCsv(client) {
  const btn = $('#export'); btn.disabled = true; btn.textContent = 'Exporting…';
  try {
    const rows = [];
    for (let page = 1; page <= 200; page++) {
      const d = await api(`/api/clients/${encodeURIComponent(client.id)}/events?` + logParams({ page, limit: 200 }));
      rows.push(...d.rows);
      if (rows.length >= d.total || !d.rows.length) break;
    }
    const head = ['timestamp_utc', 'customer_id', 'customer_name', 'type', 'actor', 'service', 'reason', 'model', 'tokens_in', 'tokens_out', 'credits', 'spend_usd', 'balance_after_usd'];
    const cell = (v) => /[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : (v ?? '');
    const csv = [head.join(','), ...rows.map((r) => [r.ts, client.id, client.name, r.action, r.actor, r.service, r.reason, r.model, r.tokensIn, r.tokensOut,
      r.credits, r.usd, r.balanceUsd].map(cell).join(','))].join('\n');
    const { from, to } = rangeDates();
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
      download: `${client.name.replace(/[^\w-]+/g, '_')}_usage_${from}_${to}.csv`,
    });
    a.click(); URL.revokeObjectURL(a.href);
  } finally { btn.disabled = false; btn.textContent = '⬇ Export CSV'; }
}

function renderSettings() {
  $('#page-title').textContent = '⚙️ Settings';
  const m = state.meta, s = m.settings;
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  view.innerHTML = `
    <div class="grid settings-grid">
      <section class="card">
        <div class="section-head"><h2>Data source</h2><span class="spacer"></span>${m.live ? '<span class="pill live">● Live</span>' : '<span class="pill demo">Demo data</span>'}</div>
        <dl class="kv">
          ${row('Source', m.live ? 'FPFX Wallet API' : 'Seeded demo database')}
          ${m.live ? row('Endpoint', `<span class="mono">${esc(m.baseUrl)}</span>`) : ''}
          ${m.live ? row('Last fetched', esc(ago(m.lastFetched))) : ''}
          ${m.live ? row('Refresh cadence', `Live, cached ${m.cacheMinutes} min`) : ''}
          ${m.live ? row('Customer names mapped', int(m.namesMapped)) : ''}
          ${row('Cloudflare Access', m.accessProtected ? 'Enforced on every API request' : 'Not configured')}
        </dl>
        ${m.live ? '<p class="muted small">Data is read live from the Wallet API and cached briefly. Use <b>Refresh</b> (top bar) to pull the latest immediately.</p>'
          : '<p class="muted small">Set <code>WALLET_API_TOKEN</code> (a Wallet service or admin token) in <code>.env.local</code> locally or in Vercel → Settings → Environment Variables, then redeploy. The dashboard only ever makes read (GET) requests.</p>'}
      </section>
      <section class="card">
        <div class="section-head"><h2>Credit pricing</h2></div>
        <dl class="kv">
          ${row('Credit price', s.creditPrice != null ? usd(s.creditPrice) + ' per credit' : '—')}
          ${row('Conversion', s.conversionUsd != null ? `${usd(s.conversionUsd)} = ${int(s.conversionTokens)} credits` : '—')}
          ${row('Markup', s.markupPercent != null ? s.markupPercent.toFixed(1) + '%' : '—')}
          ${row('Credits per $1 API cost', s.tokensPerCostUsd != null ? int(s.tokensPerCostUsd) : '—')}
          ${s.minHoldAmount != null ? row('Min hold', usd(s.minHoldAmount)) : ''}
          ${s.defaultAutoRenewalFrequencyDays != null ? row('Default renewal', `every ${int(s.defaultAutoRenewalFrequencyDays)} days`) : ''}
        </dl>
        <p class="muted small">Credits are the Wallet's “tokens” (sold as packs like “1M Tokens”). Est. API cost = customer spend × (1 − markup). Credit price is what customers pay per credit.</p>
      </section>
    </div>
    <section class="section">
      <div class="section-head"><h2>LLM token rates</h2><span class="muted" style="font-size:13px">USD per 1M tokens, from the Wallet config</span></div>
      <div class="card table-wrap" style="padding:6px 6px 0"><table>
        <thead><tr><th>LLM</th><th class="num">Input / 1M</th><th class="num">Output / 1M</th></tr></thead>
        <tbody>${s.tokenRates.map((r) => `<tr><td class="mono" style="font-size:12.5px">${esc(r.llm)}</td><td class="num">${usd(r.in)}</td><td class="num">${usd(r.out)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">None configured</td></tr>'}</tbody>
      </table></div>
    </section>
    <div class="grid two-col section">
      <section>
        <div class="section-head"><h2>Services</h2><span class="hint">${s.services.length}</span></div>
        <div class="card table-wrap" style="padding:6px 6px 0"><table>
          <thead><tr><th>Service / tool</th><th>Added</th></tr></thead>
          <tbody>${s.services.map((x) => `<tr><td>${svcTag(x.name)}</td><td class="mono" style="font-size:12px">${fmtDate(x.createdAt)}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">None</td></tr>'}</tbody>
        </table></div>
      </section>
      <section>
        <div class="section-head"><h2>Credit packages</h2></div>
        <div class="card table-wrap" style="padding:6px 6px 0"><table>
          <thead><tr><th>Package</th><th class="num">Credits</th><th class="num">Price</th><th class="num">Per credit</th></tr></thead>
          <tbody>${s.products.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${int(p.credits)}</td><td class="num">${usd(p.usdPrice, true)}</td>
            <td class="num">${p.credits ? usd(p.usdPrice / p.credits) : '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">None active</td></tr>'}</tbody>
        </table></div>
      </section>
    </div>
    ${m.live ? `<section class="section card">
      <h2>Customer names</h2>
      <p class="muted small">The Wallet API doesn't return customer names yet, so customers show as <span class="mono">Tenant xxxxxxxx</span>. Set <code>TENANT_NAMES</code> to a JSON map of tenant UUID → name (Vercel env var), or ask the Wallet team to add <span class="mono">name</span> to <span class="mono">GET /v1/Wallets</span>.</p>
    </section>` : ''}`;
}

/* ---------- router ---------- */
async function route() {
  state.charts.forEach((c) => c.destroy()); state.charts = [];
  syncControls();
  const [, page = '', id] = location.hash.replace(/^#/, '').split('/');
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (page || 'overview')));
  $('#sidebar').classList.remove('open');
  $('#controls').style.display = page === 'settings' ? 'none' : '';
  try {
    if (!state.meta) await loadMeta();
    if (page === 'clients') {
      if (!$('#client-detail')) view.innerHTML = '<div class="loading">Loading customers…</div>';
      await renderClients(id && decodeURIComponent(id));
    } else if (page === 'settings') renderSettings();
    else { view.innerHTML = '<div class="loading">Loading usage…</div>'; await renderOverview(); }
  } catch (err) {
    view.innerHTML = `<div class="card empty">Couldn't load data: ${esc(err.message)}</div>`;
  }
}
async function loadMeta() {
  state.meta = await api('/api/meta');
  $('#data-status').innerHTML = state.meta.live
    ? `<span class="pill live">● Live · Wallet API</span><br>Updated ${esc(ago(state.meta.lastFetched))}`
    : '<span class="pill demo">Demo data</span>';
}
view.addEventListener('click', (e) => { const r = e.target.closest('tr[data-href]'); if (r) location.hash = r.dataset.href; });
window.addEventListener('hashchange', route);

Chart.defaults.font.family = "'DM Sans', sans-serif";
route();
