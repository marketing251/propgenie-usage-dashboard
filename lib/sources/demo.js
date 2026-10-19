// Demo source: the seeded SQLite data, shaped exactly like the live Wallet source.
// Used whenever WALLET_API_TOKEN isn't configured.
import { db } from '../db.js';
import { MODELS, CREDIT_VALUE, MARKUP } from '../pricing.js';

const bounds = (from, to) => [`${from}T00:00:00Z`, `${to}T23:59:59Z`];
const AGG = `COALESCE(SUM(credits),0) * ${CREDIT_VALUE} AS usd, COALESCE(SUM(credits),0) AS credits,
  COALESCE(SUM(cost_usd),0) AS apiCost, COUNT(*) AS transactions`;
const q = (sql, args) => db.prepare(sql).all(...args).map((r) => ({ ...r }));
const one = (sql, args) => ({ ...db.prepare(sql).get(...args) });

export async function settings() {
  return {
    conversionUsd: CREDIT_VALUE, conversionTokens: 1, creditPrice: CREDIT_VALUE,
    markupPercent: (1 - 1 / MARKUP) * 100, tokensPerCostUsd: MARKUP / CREDIT_VALUE,
    minHoldAmount: null, defaultAutoRenewalFrequencyDays: null,
    services: q('SELECT tool AS name, MIN(ts) AS createdAt FROM usage_events GROUP BY tool ORDER BY tool', []),
    tokenRates: Object.values(MODELS).map((m) => ({ llm: m.api, in: m.in, out: m.out })),
    products: [{ name: 'Starter pack', usdPrice: 29, credits: 2500 }, { name: 'Pro pack', usdPrice: 79, credits: 8000 }, { name: 'Agency pack', usdPrice: 199, credits: 25000 }],
  };
}

function breakdown(r, clientId) {
  const where = (from, to) => {
    const [lo, hi] = bounds(from, to);
    return clientId ? ['WHERE ts >= ? AND ts <= ? AND client_id = ?', [lo, hi, clientId]] : ['WHERE ts >= ? AND ts <= ?', [lo, hi]];
  };
  const [w, a] = where(r.from, r.to);
  const [pw, pa] = where(r.prevFrom, r.prevTo);
  return {
    totals: one(`SELECT ${AGG}, COUNT(DISTINCT client_id) AS customers FROM usage_events ${w}`, a),
    previous: one(`SELECT ${AGG}, COUNT(DISTINCT client_id) AS customers FROM usage_events ${pw}`, pa),
    byService: q(`SELECT tool AS service, ${AGG} FROM usage_events ${w} GROUP BY tool ORDER BY usd DESC`, a),
    byModel: q(`SELECT model, ${AGG}, SUM(input_tokens) AS tokensIn, SUM(output_tokens) AS tokensOut,
      SUM(cached_tokens) AS tokensCached, SUM(images) AS images FROM usage_events ${w} GROUP BY model ORDER BY usd DESC`, a)
      .map((m) => ({ ...m, llm: MODELS[m.model]?.api, label: MODELS[m.model]?.label })),
    daily: q(`SELECT substr(ts,1,10) AS day, tool AS service, ${AGG} FROM usage_events ${w} GROUP BY day, tool ORDER BY day`, a),
  };
}

const nameSql = `SELECT c.id, c.name, ${AGG} FROM clients c LEFT JOIN usage_events e ON e.client_id = c.id AND e.ts >= ? AND e.ts <= ?`;

export async function overview(r) {
  const b = breakdown(r);
  b.totals.balance = null;
  return { ...b, customerServices: q(`SELECT c.id, c.name, NULL AS balance, e.tool AS service, ${AGG} FROM usage_events e
    JOIN clients c ON c.id = e.client_id WHERE e.ts >= ? AND e.ts <= ? GROUP BY c.id, e.tool`, bounds(r.from, r.to)) };
}

export async function clients(r) {
  return q(`${nameSql} GROUP BY c.id ORDER BY usd DESC, c.name`, bounds(r.from, r.to)).map((c) => ({ ...c, balance: null }));
}

export async function client(id, r) {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  if (!c) throw Object.assign(new Error('Customer not found'), { status: 404 });
  return {
    client: { id: c.id, name: c.name, plan: c.plan, createdAt: c.created_at, balance: null, creditBalance: null, wallet: null },
    ...breakdown(r, id),
    orders: null,
  };
}

export async function events(id, r, { service, model, page = 1, limit = 50 }) {
  const [lo, hi] = bounds(r.from, r.to);
  const parts = ['client_id = ?', 'ts >= ?', 'ts <= ?'], args = [id, lo, hi];
  if (service) { parts.push('tool = ?'); args.push(service); }
  if (model) { parts.push('model = ?'); args.push(model); }
  const w = 'WHERE ' + parts.join(' AND ');
  return {
    total: one(`SELECT COUNT(*) AS n FROM usage_events ${w}`, args).n, page, limit,
    rows: q(`SELECT ts, tool AS service, model, input_tokens AS tokensIn, output_tokens AS tokensOut, credits, cost_usd AS apiCost
      FROM usage_events ${w} ORDER BY ts DESC LIMIT ? OFFSET ?`, [...args, limit, (page - 1) * limit])
      .map((e) => ({ ...e, model: MODELS[e.model]?.label || e.model, usd: e.credits * CREDIT_VALUE, reason: null, balanceUsd: null })),
  };
}

export const status = () => ({ source: 'demo', baseUrl: null, lastFetched: null, cacheMinutes: null, namesMapped: null });
