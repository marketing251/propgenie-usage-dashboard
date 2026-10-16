// Live source: aggregates FPFX Wallet API data into the dashboard's shapes.
// Wallet "tokens" are PropGenie credits; usdAmount is what the customer was charged.
import { get, mapLimit, lastFetched, CACHE_MINUTES, WALLET_URL } from '../wallet.js';

const CONCURRENCY = 6;
const DAY = 864e5;

// Customer names aren't exposed by any Wallet GET endpoint; map them via env until they are.
let NAMES = {};
try { NAMES = JSON.parse(process.env.TENANT_NAMES || '{}'); } catch { console.warn('TENANT_NAMES is not valid JSON'); }
const nameOf = (id) => NAMES[id] || `Tenant ${String(id).slice(0, 8)}`;

const startIso = (d) => `${d}T00:00:00.000Z`;
const endIso = (d) => `${d}T23:59:59.999Z`;
const span = (r) => ({ from: startIso(r.from), to: endIso(r.to) });

export async function settings() {
  const [s, services, tokenRates, products] = await Promise.all([
    get('/v1/Config/settings').catch(() => null),
    get('/v1/Services').catch(() => []),
    get('/v1/Config/token-rates').catch(() => []),
    get('/v1/Products').catch(() => []),
  ]);
  return {
    // WooCommerce keys/secrets in this payload are intentionally dropped.
    conversionUsd: s?.conversionUsd ?? null,
    conversionTokens: s?.conversionTokens ?? null,
    creditPrice: s?.conversionUsd && s?.conversionTokens ? s.conversionUsd / s.conversionTokens : null,
    markupPercent: s?.markupPercent ?? null,
    tokensPerCostUsd: s?.tokensPerCostUsd ?? null,
    minHoldAmount: s?.minHoldAmount ?? null,
    defaultAutoRenewalFrequencyDays: s?.defaultAutoRenewalFrequencyDays ?? null,
    services: (services || []).map((x) => ({ uuid: x.uuid, name: x.name, createdAt: x.createdAt })),
    tokenRates: (tokenRates || []).map((x) => ({ llm: x.llm, in: x.usdPerMtokInput, out: x.usdPerMtokOutput })),
    products: (products || []).filter((p) => p.active).map((p) => ({ name: p.name, usdPrice: p.usdPrice, credits: p.tokens })),
  };
}

const apiCostOf = (usd, markup) => (markup == null ? null : usd * (1 - markup / 100));

// ConsumptionInterval is an undocumented integer enum. Probe once for the value that yields daily buckets.
let dayInterval;
async function detectDayInterval(tenant) {
  if (dayInterval !== undefined) return dayInterval;
  if (process.env.WALLET_DAY_INTERVAL) return (dayInterval = process.env.WALLET_DAY_INTERVAL);
  const to = new Date(), from = new Date(to - 30 * DAY);
  for (const k of [0, 1, 2, 3, 4]) {
    const r = await get(`/v1/Tenants/${tenant}/consumption`, { from: from.toISOString(), to: to.toISOString(), interval: k }).catch(() => null);
    const starts = [...new Set((r?.items || []).map((i) => i.periodStart).filter(Boolean))].sort();
    if (starts.length < 2) continue;
    const gaps = starts.slice(1).map((s, i) => Date.parse(s) - Date.parse(starts[i]));
    if (Math.min(...gaps) === DAY) return (dayInterval = k);
  }
  return null; // undetermined: don't cache, try again next request
}

async function tenantConsumption(tenant, r) {
  const interval = await detectDayInterval(tenant);
  const res = await get(`/v1/Tenants/${tenant}/consumption`, { ...span(r), ...(interval != null ? { interval } : {}) });
  return (res?.items || []).map((i) => ({
    day: (i.periodStart || startIso(r.from)).slice(0, 10),
    service: i.serviceName || 'Unassigned',
    usd: i.usdAmount || 0, credits: i.tokenAmount || 0, transactions: i.transactionCount || 0,
  }));
}

function rollup(rows, markup) {
  const totals = { usd: 0, credits: 0, transactions: 0 };
  const svc = new Map(), daily = new Map();
  for (const x of rows) {
    totals.usd += x.usd; totals.credits += x.credits; totals.transactions += x.transactions;
    const s = svc.get(x.service) || { service: x.service, usd: 0, credits: 0, transactions: 0 };
    s.usd += x.usd; s.credits += x.credits; s.transactions += x.transactions; svc.set(x.service, s);
    const k = x.day + '|' + x.service;
    const d = daily.get(k) || { day: x.day, service: x.service, usd: 0, credits: 0, transactions: 0 };
    d.usd += x.usd; d.credits += x.credits; d.transactions += x.transactions; daily.set(k, d);
  }
  totals.apiCost = apiCostOf(totals.usd, markup);
  return {
    totals,
    byService: [...svc.values()].map((s) => ({ ...s, apiCost: apiCostOf(s.usd, markup) })).sort((a, b) => b.usd - a.usd),
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

async function wallets(r) {
  return (await get('/v1/Wallets', span(r))) || [];
}

export async function overview(r) {
  const [cfg, list, prevList] = await Promise.all([settings(), wallets(r), wallets({ from: r.prevFrom, to: r.prevTo })]);
  const perTenant = await mapLimit(list, CONCURRENCY, async (w) => ({ w, rows: await tenantConsumption(w.tenantUuid, r) }));
  const agg = rollup(perTenant.flatMap((t) => t.rows), cfg.markupPercent);
  const clients = perTenant.map(({ w, rows }) => {
    const t = rollup(rows, cfg.markupPercent).totals;
    return { id: w.tenantUuid, name: nameOf(w.tenantUuid), ...t, balance: w.availableUsdBalance ?? null };
  });
  const prevUsd = prevList.reduce((s, w) => s + (w.usdAmountSpent || 0), 0);
  return {
    ...agg,
    totals: { ...agg.totals, customers: clients.filter((c) => c.transactions > 0).length, balance: list.reduce((s, w) => s + (w.availableUsdBalance || 0), 0) },
    previous: { usd: prevUsd, apiCost: apiCostOf(prevUsd, cfg.markupPercent), customers: prevList.filter((w) => w.usdAmountSpent > 0).length },
    byModel: null,
    topClients: clients.sort((a, b) => b.usd - a.usd).slice(0, 10),
  };
}

export async function clients(r) {
  const [cfg, list] = await Promise.all([settings(), wallets(r)]);
  const rows = await mapLimit(list, CONCURRENCY, async (w) => {
    const t = rollup(await tenantConsumption(w.tenantUuid, r), cfg.markupPercent).totals;
    return { id: w.tenantUuid, name: nameOf(w.tenantUuid), ...t, balance: w.availableUsdBalance ?? null, spentInRange: w.usdAmountSpent ?? null };
  });
  return rows.sort((a, b) => b.usd - a.usd || a.name.localeCompare(b.name));
}

export async function client(id, r) {
  const [cfg, wallet, balance, rows, prevList, orders] = await Promise.all([
    settings(),
    get(`/v1/Tenants/${id}/wallet`),
    get(`/v1/Tenants/${id}/balance`),
    tenantConsumption(id, r),
    wallets({ from: r.prevFrom, to: r.prevTo }),
    get(`/v1/Orders/${id}`, { page: 1, pageSize: 50 }).catch(() => null),
  ]);
  if (!wallet && !balance) throw Object.assign(new Error('Customer not found in Wallet API'), { status: 404 });
  const agg = rollup(rows, cfg.markupPercent);
  const prevUsd = prevList.find((w) => w.tenantUuid === id)?.usdAmountSpent || 0;
  return {
    client: {
      id, name: nameOf(id), createdAt: wallet?.createdAt ?? null,
      balance: balance?.availableUsdBalance ?? null, creditBalance: balance?.availableTokenBalance ?? null,
      wallet: wallet && {
        startingUsdBalance: wallet.startingUsdBalance, autoRenewal: wallet.autoRenewal,
        autoRenewalUsdBalance: wallet.autoRenewalUsdBalance, autoRenewalFrequencyDays: wallet.autoRenewalFrequencyDays,
        nextRenewalDate: wallet.nextRenewalDate, conversionUsd: wallet.conversionUsd, conversionTokens: wallet.conversionTokens,
      },
    },
    ...agg,
    previous: { usd: prevUsd, apiCost: apiCostOf(prevUsd, cfg.markupPercent) },
    byModel: null,
    orders: (orders?.items || []).map((o) => ({
      id: o.id, product: o.productName, usd: o.usdPrice, credits: o.tokens, status: o.providerStatus ?? o.status,
      createdAt: o.createdAt, paidAt: o.paidAt, creditedAt: o.creditedAt,
    })),
  };
}

export async function events(id, r, { service, page = 1, limit = 50 }) {
  const res = await get(`/v1/Tenants/${id}/ledger`, { ...span(r), serviceName: service, page, pageSize: Math.min(limit, 200) });
  return {
    total: res?.totalCount ?? 0, page, limit,
    rows: (res?.items || []).map((e) => ({
      ts: e.occurredAt, service: e.serviceName, reason: e.reason, action: e.action, actor: e.actor,
      credits: e.tokenAmount, usd: e.usdAmount, balanceUsd: e.usdBalance, balanceCredits: e.tokenBalance,
      // Not exposed by the ledger today; shown automatically if the Wallet API adds them.
      model: e.llm ?? null, tokensIn: e.tokensIn ?? null, tokensOut: e.tokensOut ?? null,
    })),
  };
}

export const status = () => ({ source: 'wallet', baseUrl: WALLET_URL, lastFetched, cacheMinutes: CACHE_MINUTES, namesMapped: Object.keys(NAMES).length });
