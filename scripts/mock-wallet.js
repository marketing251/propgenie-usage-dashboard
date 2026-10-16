// Spec-shaped mock of the FPFX Wallet API for local testing (GET endpoints only), backed by the demo DB.
// Run: npm run mock   then start the dashboard with WALLET_API_URL=http://localhost:5899 WALLET_API_TOKEN=mock-token
import http from 'node:http';
import { createHash } from 'node:crypto';
import { db } from '../lib/db.js';
import { MODELS } from '../lib/pricing.js';

const PORT = 5899, CREDIT = 0.01;
const uuid = (s) => { const h = createHash('md5').update(s).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };
const clients = db.prepare('SELECT * FROM clients').all().map((c) => ({ ...c, uuid: uuid(c.id) }));
const byUuid = Object.fromEntries(clients.map((c) => [c.uuid, c]));
const tools = db.prepare('SELECT DISTINCT tool FROM usage_events ORDER BY tool').all().map((r) => r.tool);
const svcUuid = Object.fromEntries(tools.map((t) => [t, uuid('svc' + t)]));
const iso = (s) => s.replace('Z', '.000Z');
const s = (n) => String(Math.round(n * 1e6) / 1e6); // spec allows numeric strings

const routes = [
  [/^\/v1\/Config\/settings$/, () => ({ minHoldAmount: 0.5, holdExpiryMinutes: 15, defaultAutoRenewalFrequencyDays: 30, conversionUsd: 1, conversionTokens: 100, tokensPerCostUsd: 500, markupPercent: 80, wooCommerceStoreUrl: 'https://shop.example', wooCommerceConsumerKey: 'ck_mock_should_not_leak', wooCommerceConsumerSecretSet: true, wooCommerceWebhookSecretSet: true })],
  [/^\/v1\/Services$/, () => tools.map((t, i) => ({ id: i + 1, uuid: svcUuid[t], name: t, createdAt: '2026-06-01T00:00:00Z', updatedAt: null }))],
  [/^\/v1\/Config\/token-rates$/, () => Object.values(MODELS).map((m, i) => ({ id: i + 1, llm: m.api, usdPerMtokInput: m.in, usdPerMtokOutput: m.out }))],
  [/^\/v1\/Products$/, () => [{ id: 1, wooProductId: 11, name: 'Starter 2,500 credits', usdPrice: 29, tokens: 2500, active: true, createdAt: '2026-06-01T00:00:00Z' }, { id: 2, wooProductId: 12, name: 'Pro 8,000 credits', usdPrice: 79, tokens: 8000, active: true, createdAt: '2026-06-01T00:00:00Z' }]],
  [/^\/v1\/Wallets$/, (q) => db.prepare(`SELECT c.id, COALESCE(SUM(e.credits),0) AS cr FROM clients c LEFT JOIN usage_events e ON e.client_id=c.id AND e.ts>=? AND e.ts<=? GROUP BY c.id`)
      .all(q.get('from') || '0', q.get('to') || '9').map((r) => { const c = clients.find((x) => x.id === r.id); return { tenantUuid: c.uuid, availableUsdBalance: s(50 + (c.uuid.charCodeAt(0) % 9) * 20), usdAmountSpent: s(r.cr * CREDIT) }; })],
  [/^\/v1\/Tenants\/([^/]+)\/wallet$/, (q, [, t]) => byUuid[t] && { tenantUuid: t, startingUsdBalance: 100, conversionUsd: null, conversionTokens: null, tokensPerCostUsd: 500, autoRenewal: true, autoRenewalUsdBalance: 79, autoRenewalFrequencyDays: 30, nextRenewalDate: '2026-11-01T00:00:00Z', createdAt: iso(byUuid[t].created_at), updatedAt: null }],
  [/^\/v1\/Tenants\/([^/]+)\/balance$/, (q, [, t]) => byUuid[t] && { availableTokenBalance: 5000 + (t.charCodeAt(1) % 9) * 900, availableUsdBalance: 50 + (t.charCodeAt(0) % 9) * 20 }],
  [/^\/v1\/Tenants\/([^/]+)\/consumption$/, (q, [, t]) => {
    if (!byUuid[t]) return null;
    const interval = q.get('interval'); // mock enum: 2 = day, 3 = month, anything else = no bucketing
    const bucket = interval === '2' ? 'substr(ts,1,10)' : interval === '3' ? "substr(ts,1,7)||'-01'" : 'NULL';
    const items = db.prepare(`SELECT ${bucket} AS p, tool, SUM(credits) AS cr, COUNT(*) AS n FROM usage_events WHERE client_id=? AND ts>=? AND ts<=? GROUP BY p, tool`)
      .all(byUuid[t].id, q.get('from'), q.get('to'))
      .map((r) => ({ serviceUuid: svcUuid[r.tool], serviceName: r.tool, periodStart: r.p ? `${r.p}T00:00:00Z` : null, tokenAmount: r.cr, usdAmount: s(r.cr * CREDIT), transactionCount: r.n }));
    return { items, totalTokenAmount: items.reduce((a, i) => a + i.tokenAmount, 0), totalUsdAmount: items.reduce((a, i) => a + +i.usdAmount, 0), totalTransactionCount: items.reduce((a, i) => a + i.transactionCount, 0) };
  }],
  [/^\/v1\/Tenants\/([^/]+)\/ledger$/, (q, [, t]) => {
    if (!byUuid[t]) return null;
    const page = +q.get('page') || 1, size = +q.get('pageSize') || 50;
    const args = [byUuid[t].id, q.get('from'), q.get('to')]; let extra = '';
    if (q.get('serviceName')) { extra = ' AND tool=?'; args.push(q.get('serviceName')); }
    const total = db.prepare(`SELECT COUNT(*) n FROM usage_events WHERE client_id=? AND ts>=? AND ts<=?${extra}`).get(...args).n;
    const items = db.prepare(`SELECT * FROM usage_events WHERE client_id=? AND ts>=? AND ts<=?${extra} ORDER BY ts DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size)
      .map((e) => ({ action: 2, actor: 1, reason: `${e.tool} generation`, tokenAmount: -e.credits, usdAmount: s(-e.credits * CREDIT), tokenBalance: 4200, usdBalance: s(42), serviceName: e.tool, occurredAt: iso(e.ts), registeredAt: iso(e.ts) }));
    return { items, page, pageSize: size, totalCount: total, totalPages: Math.ceil(total / size) };
  }],
  [/^\/v1\/Orders\/([^/]+)$/, (q, [, t]) => byUuid[t] && { items: [{ id: 901, productId: 2, productName: 'Pro 8,000 credits', status: 3, usdPrice: 79, tokens: 8000, paymentUrl: null, providerOrderId: 5521, providerStatus: 'completed', currency: 'USD', createdAt: '2026-09-02T10:00:00Z', paidAt: '2026-09-02T10:01:00Z', creditedAt: '2026-09-02T10:01:05Z' }], page: 1, pageSize: 50, totalCount: 1, totalPages: 1 }],
];

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.headers.authorization !== 'Bearer mock-token') { res.writeHead(401, { 'www-authenticate': 'Bearer' }); return res.end(); }
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  for (const [re, fn] of routes) {
    const m = url.pathname.match(re);
    if (!m) continue;
    const body = fn(url.searchParams, m);
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    return res.end(body ? JSON.stringify(body) : '');
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => console.log(`Mock Wallet API → http://localhost:${PORT}`));
