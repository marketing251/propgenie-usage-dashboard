// Deterministic demo data: ~24 prop-firm clients, 120 days of PropGenie usage.
// `npm run seed` rebuilds demo data; `npm run reset` empties the database for live ingest.
import { db } from '../lib/db.js';
import { costOf, creditsFor } from '../lib/pricing.js';

db.exec('DELETE FROM usage_events; DELETE FROM clients;');
if (process.argv.includes('--empty')) {
  console.log('Database emptied. Ready for live ingest via POST /api/usage.');
  process.exit(0);
}

let s = 20260930;
const rand = () => ((s = (s + 0x6d2b79f5) | 0), (((s ^ (s >>> 15)) * (1 | s) ^ (s >>> 7)) >>> 0) / 4294967296);
const int = (a, b) => Math.floor(a + rand() * (b - a + 1));
const pick = (weights) => {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (const [k, w] of Object.entries(weights)) if ((r -= w) <= 0) return k;
  return Object.keys(weights)[0];
};

// Per-tool: which models it can run on, and a token profile per call.
const TOOL_PROFILES = {
  'Social Post Writer':       { models: { 'genie-flash': 3, 'genie-pro': 2 }, in: [1500, 3000], out: [400, 900] },
  'Caption Generator':        { models: { 'genie-flash': 1 },                 in: [800, 1500],  out: [150, 400] },
  'Ad Copy Studio':           { models: { 'genie-pro': 3, 'genie-flash': 1 }, in: [2000, 4000], out: [600, 1500] },
  'Email Campaign Writer':    { models: { 'genie-pro': 1, 'genie-flash': 2 }, in: [2500, 5000], out: [900, 2200] },
  'Competitor Insights':      { models: { 'genie-pro': 1 },                   in: [6000, 12000], out: [1000, 2000] },
  'Image Creator':            { models: { 'genie-canvas': 1 },                in: [200, 600],   out: [3500, 6000] },
  'Banner Studio':            { models: { 'genie-vision': 1 },                in: [500, 1500],  out: [0, 0], images: [1, 4] },
  'WebBuilder – Page Update': { models: { 'webbuilder': 1 },                  in: [8000, 15000], out: [1500, 3000], cached: [0, 20000] },
  'WebBuilder – Full Page':   { models: { 'webbuilder': 1 },                  in: [15000, 25000], out: [8000, 14000] },
};

const NAMES = [
  'Summit Trader Fund', 'Northwind Funded', 'Kestrel Capital', 'Lumen Prop', 'Harbor Point Funding',
  'Ironvale Traders', 'Cobalt Ridge Capital', 'Pinecrest Funded', 'Vantor Markets', 'Solace Trading Co',
  'Redfern Prop', 'Aster Funding', 'Halcyon Traders', 'Quarry Capital', 'Meridian Edge', 'Oakline Funded',
  'Brightwater Prop', 'Talon Funding', 'Silverbirch Capital', 'Granite Peak Funding', 'Ember Prop Co',
  'Tidewater Funded', 'Crescent Flow Capital', 'Zephyr Funding',
];
const PLANS = { Starter: [2, 7], Pro: [8, 22], Agency: [25, 60] };

const DAYS = 120;
const end = Date.UTC(2026, 8, 30); // 2026-09-30
const insClient = db.prepare('INSERT INTO clients (id, name, plan, email, created_at) VALUES (?, ?, ?, ?, ?)');
const insEvent = db.prepare(`INSERT INTO usage_events
  (ts, client_id, tool, model, input_tokens, output_tokens, cached_tokens, images, cost_usd, credits, request_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const tools = Object.keys(TOOL_PROFILES);
let n = 0;
db.exec('BEGIN');
NAMES.forEach((name, i) => {
  const plan = pick({ Starter: 5, Pro: 4, Agency: 2 });
  const id = 'cl_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_$/, '');
  const startDay = int(0, 70); // clients onboard at different times
  const created = new Date(end - (DAYS - startDay) * 864e5).toISOString();
  insClient.run(id, name, plan, `marketing@${name.toLowerCase().replace(/[^a-z]/g, '')}.example`, created);

  // Each client favours a few tools.
  const mix = Object.fromEntries(tools.map((t) => [t, rand() < 0.35 ? 0.2 : rand() * 4 + 0.5]));
  const [lo, hi] = PLANS[plan];
  const growth = 0.6 + rand() * 1.2;

  for (let d = startDay; d < DAYS; d++) {
    const dayStart = end - (DAYS - d) * 864e5;
    const dow = new Date(dayStart).getUTCDay();
    const trend = 0.7 + ((d - startDay) / DAYS) * growth;
    const weekday = dow === 0 || dow === 6 ? 0.45 : 1;
    const calls = Math.round(int(lo, hi) * trend * weekday * (rand() < 0.08 ? 2.5 : 1));
    for (let c = 0; c < calls; c++) {
      const tool = pick(mix);
      const p = TOOL_PROFILES[tool];
      const model = pick(p.models);
      const u = {
        input_tokens: int(...p.in),
        output_tokens: int(...p.out),
        cached_tokens: p.cached && rand() < 0.6 ? int(...p.cached) : 0,
        images: p.images ? int(...p.images) : 0,
      };
      const cost = costOf(model, u);
      const ts = new Date(dayStart + int(6, 23) * 36e5 + int(0, 3599) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
      insEvent.run(ts, id, tool, model, u.input_tokens, u.output_tokens, u.cached_tokens, u.images,
        cost, creditsFor(cost), `demo_${i}_${d}_${c}`);
      n++;
    }
  }
});
db.exec('COMMIT');
console.log(`Seeded ${NAMES.length} clients, ${n.toLocaleString()} usage events.`);
