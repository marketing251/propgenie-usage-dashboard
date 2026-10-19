// Live source: aggregates FPFX Wallet API data into the dashboard's shapes.
// Wallet "tokens" are PropGenie credits; usdAmount is what the customer was charged.
import { get, mapLimit, lastFetched, CACHE_MINUTES, WALLET_URL } from '../wallet.js';

const CONCURRENCY = 6;
const DAY = 864e5;

// Names come from the Wallet's tenantName; TENANT_NAMES (JSON uuid -> name) can override individual tenants.
let NAMES = {};
try { NAMES = JSON.parse(process.env.TENANT_NAMES || '{}'); } catch { console.warn('TENANT_NAMES is not valid JSON'); }
const nameOf = (id, apiName) => NAMES[id] || apiName || `Tenant ${String(id).slice(0, 8)}`;

const startIso = (d) => `${d}T00:00:00.000Z`;
const endIso = (d) => `${d}T23:59:59.999Z`;
const span = (r) => ({ from: startIso(r.from), to: endIso(r.to) });

export async function settings() {
  const now = new Date().toISOString().slice(0, 10);
  const [s, services, tokenRates, products, allTime] = await Promise.all([
    get('/v1/Config/settings').catch(() => null),
    get('/v1/Services').catch(() => []),
    get('/v1/Config/token-rates').catch(() => []),
    get('/v1/Products').catch(() => []),
    get('/v1/Consumptions/services', span({ from: '2025-01-01', to: now })).catch(() => []),
  ]);
  const spend = new Map((allTime || []).map((x) => [x.serviceName || UNATTRIBUTED, x.usdAmount || 0]));
  const svc = (services || []).map((x) => ({ uuid: x.uuid, name: x.name, createdAt: x.createdAt, allTimeUsd: spend.get(x.name) || 0 }));
  if (spend.get(UNATTRIBUTED)) svc.push({ uuid: null, name: UNATTRIBUTED, createdAt: null, allTimeUsd: spend.get(UNATTRIBUTED) });
  // Colour order: all-time spend, so the busiest services always get the distinct hues.
  svc.sort((a, b) => b.allTimeUsd - a.allTimeUsd || a.name.localeCompare(b.name));
  const active = (products || []).filter((p) => p.active);
  const derived = s ? null : await derivePricing(active, now);
  return {
    // WooCommerce keys/secrets in this payload are intentionally dropped.
    conversionUsd: s?.conversionUsd ?? derived?.conversionUsd ?? null,
    conversionTokens: s?.conversionTokens ?? derived?.conversionTokens ?? null,
    creditPrice: s?.conversionUsd && s?.conversionTokens ? s.conversionUsd / s.conversionTokens : derived?.creditPrice ?? null,
    markupPercent: s?.markupPercent ?? derived?.markupPercent ?? null,
    tokensPerCostUsd: s?.tokensPerCostUsd ?? derived?.tokensPerCostUsd ?? null,
    pricingSource: s ? "settings" : derived ? "derived" : null,
    minHoldAmount: s?.minHoldAmount ?? null,
    defaultAutoRenewalFrequencyDays: s?.defaultAutoRenewalFrequencyDays ?? null,
    services: svc,
    tokenRates: (tokenRates || []).map((x) => ({ llm: x.llm, in: x.usdPerMtokInput, out: x.usdPerMtokOutput })),
    products: active.map((p) => ({ name: p.name, usdPrice: p.usdPrice, credits: p.tokens })),
  };
}

// /v1/Config/settings can be off-limits to the reader token (it holds WooCommerce keys). Rebuild pricing from
// what it can read: credit price from the base credit pack, credits-per-$1-of-cost from any tenant wallet.
async function derivePricing(active, now) {
  const base = active.filter((p) => p.tokens > 0 && p.usdPrice > 0).sort((a, b) => b.usdPrice / b.tokens - a.usdPrice / a.tokens)[0];
  const first = ((await get("/v1/Wallets", span({ from: "2025-01-01", to: now })).catch(() => [])) || [])[0];
  const wallet = first && (await get(`/v1/Tenants/${first.tenantUuid}/wallet`).catch(() => null));
  if (!base) return null;
  const creditPrice = base.usdPrice / base.tokens;
  const tokensPerCostUsd = wallet?.tokensPerCostUsd ?? null;
  return {
    conversionUsd: 1, conversionTokens: 1 / creditPrice, creditPrice, tokensPerCostUsd,
    // Charged credits per $1 of cost vs credits per $1 of price: 1 - 100,000 / 125,000 = 20%.
    markupPercent: tokensPerCostUsd ? (1 - 1 / creditPrice / tokensPerCostUsd) * 100 : null,
  };
}

const apiCostOf = (usd, markup) => (markup == null ? null : usd * (1 - markup / 100));

// ConsumptionInterval (verified against the live API): 0 = day, 1 = week, 2 = month, 3 = year.
const DAY_INTERVAL = process.env.WALLET_DAY_INTERVAL || 0;
const UNATTRIBUTED = "Unattributed"; // usage debits recorded before the service was tracked

async function tenantConsumption(tenant, r) {
  const res = await get(`/v1/Tenants/${tenant}/consumption`, { ...span(r), interval: DAY_INTERVAL });
  return (res?.items || []).map((i) => ({
    day: (i.periodStart || startIso(r.from)).slice(0, 10),
    service: i.serviceName || UNATTRIBUTED,
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
    return { id: w.tenantUuid, name: nameOf(w.tenantUuid, w.tenantName), ...t, balance: w.availableUsdBalance ?? null };
  });
  const prevUsd = prevList.reduce((s, w) => s + (w.usdAmountSpent || 0), 0);
  return {
    ...agg,
    // Wallet "spent" also counts manual admin debits, which the consumption reports (tool usage) exclude.
    totals: { ...agg.totals, customers: clients.filter((c) => c.transactions > 0).length, balance: list.reduce((s, w) => s + (w.availableUsdBalance || 0), 0),
      otherDebits: Math.max(0, list.reduce((s, w) => s + (w.usdAmountSpent || 0), 0) - agg.totals.usd) },
    previous: { usd: prevUsd, apiCost: apiCostOf(prevUsd, cfg.markupPercent), customers: prevList.filter((w) => w.usdAmountSpent > 0).length },
    byModel: null,
    // Every active customer split by service, so the overview can rank top customers for any service selection.
    customerServices: perTenant.flatMap(({ w, rows }) => rollup(rows, cfg.markupPercent).byService.map((x) => ({
      id: w.tenantUuid, name: nameOf(w.tenantUuid, w.tenantName), balance: w.availableUsdBalance ?? null,
      service: x.service, usd: x.usd, credits: x.credits, transactions: x.transactions,
    }))),
  };
}

export async function clients(r) {
  const [cfg, list] = await Promise.all([settings(), wallets(r)]);
  const rows = await mapLimit(list, CONCURRENCY, async (w) => {
    const t = rollup(await tenantConsumption(w.tenantUuid, r), cfg.markupPercent).totals;
    return { id: w.tenantUuid, name: nameOf(w.tenantUuid, w.tenantName), ...t, balance: w.availableUsdBalance ?? null, spentInRange: w.usdAmountSpent ?? null };
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
      id, name: nameOf(id, wallet?.tenantName), createdAt: wallet?.createdAt ?? null,
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
  const res = await get(`/v1/Tenants/${id}/ledger`, { ...span(r), serviceName: service === UNATTRIBUTED ? undefined : service, page, pageSize: Math.min(limit, 200) });
  return {
    total: res?.totalCount ?? 0, page, limit,
    rows: (res?.items || []).map((e) => ({
      ts: e.occurredAt, service: e.serviceName || (e.action === 'Debit' ? UNATTRIBUTED : null), reason: e.reason, action: e.action, actor: e.actor,
      credits: e.tokenAmount, usd: e.usdAmount, balanceUsd: e.usdBalance, balanceCredits: e.tokenBalance,
      // Not exposed by the ledger today; shown automatically if the Wallet API adds them.
      model: e.llm ?? null, tokensIn: e.tokensIn ?? null, tokensOut: e.tokensOut ?? null,
    })),
  };
}

export const status = () => ({ source: 'wallet', baseUrl: WALLET_URL, lastFetched, cacheMinutes: CACHE_MINUTES, namesMapped: Object.keys(NAMES).length });
