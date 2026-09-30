import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, READ_ONLY } from './db.js';
import { MODELS, TOOLS, CREDIT_VALUE, MARKUP, costOf, creditsFor } from './pricing.js';

const INGEST_KEY = process.env.INGEST_KEY || (READ_ONLY ? null : 'pg-usage-dev-key');
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const DAY = 864e5;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

// from/to are inclusive calendar dates (UTC). Also returns the equal-length previous window for deltas.
function range(q) {
  const bounds = db.prepare('SELECT MIN(ts) AS min, MAX(ts) AS max FROM usage_events').get();
  const today = iso(Date.now());
  const to = isDate(q.get('to')) ? q.get('to') : (bounds.max ? bounds.max.slice(0, 10) : today);
  const from = isDate(q.get('from')) ? q.get('from') : (bounds.min ? bounds.min.slice(0, 10) : to);
  const start = Date.parse(from), stop = Date.parse(to) + DAY;
  const len = stop - start;
  return {
    from, to,
    lo: `${from}T00:00:00Z`, hi: `${iso(stop)}T00:00:00Z`,
    prevLo: `${iso(start - len)}T00:00:00Z`, prevHi: `${from}T00:00:00Z`,
    min: bounds.min?.slice(0, 10) ?? null, max: bounds.max?.slice(0, 10) ?? null,
  };
}

const AGG = `COUNT(*) AS requests,
  COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(credits),0) AS credits,
  COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
  COALESCE(SUM(cached_tokens),0) AS cached_tokens, COALESCE(SUM(images),0) AS images,
  COALESCE(SUM(input_tokens + output_tokens + cached_tokens),0) AS tokens`;

// Builds WHERE for a window plus optional client/model/tool filters.
function where(lo, hi, f = {}) {
  const parts = ['ts >= ?', 'ts < ?'], args = [lo, hi];
  for (const k of ['client_id', 'model', 'tool']) if (f[k]) { parts.push(`${k} = ?`); args.push(f[k]); }
  return [`WHERE ${parts.join(' AND ')}`, args];
}
const all = (sql, args) => db.prepare(sql).all(...args);
const one = (sql, args) => db.prepare(sql).get(...args);

function breakdown(r, f) {
  const [w, a] = where(r.lo, r.hi, f);
  const [pw, pa] = where(r.prevLo, r.prevHi, f);
  return {
    range: { from: r.from, to: r.to, min: r.min, max: r.max },
    totals: { ...one(`SELECT ${AGG}, COUNT(DISTINCT client_id) AS clients FROM usage_events ${w}`, a) },
    previous: { ...one(`SELECT ${AGG}, COUNT(DISTINCT client_id) AS clients FROM usage_events ${pw}`, pa) },
    byModel: all(`SELECT model, ${AGG} FROM usage_events ${w} GROUP BY model ORDER BY cost DESC`, a),
    byTool: all(`SELECT tool, ${AGG} FROM usage_events ${w} GROUP BY tool ORDER BY cost DESC`, a),
    byToolModel: all(`SELECT tool, model, ${AGG} FROM usage_events ${w} GROUP BY tool, model ORDER BY cost DESC`, a),
    daily: all(`SELECT substr(ts,1,10) AS day, model, SUM(cost_usd) AS cost,
      SUM(input_tokens + output_tokens + cached_tokens) AS tokens, COUNT(*) AS requests
      FROM usage_events ${w} GROUP BY day, model ORDER BY day`, a),
  };
}

const routes = {
  'GET /api/meta': () => ({
    models: MODELS, tools: TOOLS, creditValue: CREDIT_VALUE, markup: MARKUP,
    demo: !!one(`SELECT 1 AS x FROM usage_events WHERE request_id LIKE 'demo_%' LIMIT 1`, []),
    ...range(new URLSearchParams()),
  }),

  'GET /api/overview': (q) => {
    const r = range(q);
    const [w, a] = where(r.lo, r.hi);
    return {
      ...breakdown(r, {}),
      topClients: all(`SELECT e.client_id AS id, c.name, c.plan, ${AGG} FROM usage_events e
        JOIN clients c ON c.id = e.client_id ${w.replace(/\b(ts)\b/g, 'e.ts')}
        GROUP BY e.client_id ORDER BY cost DESC LIMIT 10`, a),
    };
  },

  'GET /api/clients': (q) => {
    const r = range(q);
    return all(`SELECT c.id, c.name, c.plan, c.email, c.created_at,
        (SELECT MAX(ts) FROM usage_events WHERE client_id = c.id) AS last_active,
        COUNT(e.id) AS requests, COALESCE(SUM(e.cost_usd),0) AS cost, COALESCE(SUM(e.credits),0) AS credits,
        COALESCE(SUM(e.input_tokens + e.output_tokens + e.cached_tokens),0) AS tokens
      FROM clients c LEFT JOIN usage_events e ON e.client_id = c.id AND e.ts >= ? AND e.ts < ?
      GROUP BY c.id ORDER BY cost DESC, c.name`, [r.lo, r.hi]);
  },

  'GET /api/clients/:id': (q, id) => {
    const client = one(`SELECT c.*, (SELECT MAX(ts) FROM usage_events WHERE client_id = c.id) AS last_active,
      (SELECT MIN(ts) FROM usage_events WHERE client_id = c.id) AS first_active FROM clients c WHERE id = ?`, [id]);
    if (!client) throw Object.assign(new Error('Client not found'), { status: 404 });
    return { client: { ...client }, ...breakdown(range(q), { client_id: id }) };
  },

  'GET /api/clients/:id/events': (q, id) => {
    const r = range(q);
    const [w, a] = where(r.lo, r.hi, { client_id: id, model: q.get('model'), tool: q.get('tool') });
    const limit = Math.min(Number(q.get('limit')) || 50, 500);
    const page = Math.max(Number(q.get('page')) || 1, 1);
    const sort = { cost: 'cost_usd DESC', tokens: '(input_tokens+output_tokens+cached_tokens) DESC' }[q.get('sort')] || 'ts DESC';
    return {
      total: one(`SELECT COUNT(*) AS n FROM usage_events ${w}`, a).n,
      page, limit,
      rows: all(`SELECT id, ts, tool, model, input_tokens, output_tokens, cached_tokens, images, cost_usd, credits, request_id
        FROM usage_events ${w} ORDER BY ${sort} LIMIT ? OFFSET ?`, [...a, limit, (page - 1) * limit]),
    };
  },

  // Ingest from PropGenie: one event object or an array. Cost/credits computed here from the pricing table.
  'POST /api/usage': async (q, _id, req) => {
    if (READ_ONLY) throw Object.assign(new Error('Ingest is disabled on this read-only demo deployment. Configure a hosted database to accept live events.'), { status: 503 });
    if (!INGEST_KEY || req.headers['x-ingest-key'] !== INGEST_KEY) throw Object.assign(new Error('Invalid x-ingest-key'), { status: 401 });
    const body = JSON.parse(await readBody(req) || 'null');
    const events = Array.isArray(body) ? body : [body];
    const addClient = db.prepare('INSERT OR IGNORE INTO clients (id, name, plan, email, created_at) VALUES (?, ?, ?, ?, ?)');
    const updClient = db.prepare('UPDATE clients SET name = COALESCE(?, name), plan = COALESCE(?, plan), email = COALESCE(?, email) WHERE id = ?');
    const ins = db.prepare(`INSERT OR IGNORE INTO usage_events
      (ts, client_id, tool, model, input_tokens, output_tokens, cached_tokens, images, cost_usd, credits, request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let inserted = 0;
    db.exec('BEGIN');
    try {
      for (const e of events) {
        if (!e?.client_id || !e.tool || !MODELS[e.model]) throw Object.assign(new Error(`Each event needs client_id, tool and a model in: ${Object.keys(MODELS).join(', ')}`), { status: 400 });
        const u = { input_tokens: +e.input_tokens || 0, output_tokens: +e.output_tokens || 0, cached_tokens: +e.cached_tokens || 0, images: +e.images || 0 };
        const cost = e.cost_usd != null ? +e.cost_usd : costOf(e.model, u);
        const ts = e.ts ? new Date(e.ts).toISOString().replace(/\.\d+Z$/, 'Z') : new Date().toISOString().replace(/\.\d+Z$/, 'Z');
        addClient.run(String(e.client_id), e.client_name ?? String(e.client_id), e.plan ?? null, e.email ?? null, ts);
        updClient.run(e.client_name ?? null, e.plan ?? null, e.email ?? null, String(e.client_id));
        inserted += Number(ins.run(ts, String(e.client_id), e.tool, e.model, u.input_tokens, u.output_tokens, u.cached_tokens, u.images,
          cost, e.credits != null ? +e.credits : creditsFor(cost), e.request_id ?? null).changes);
      }
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    return { received: events.length, inserted };
  },
};

function readBody(req) {
  return new Promise((ok, fail) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => ok(data)); req.on('error', fail);
  });
}

function match(method, path) {
  for (const key of Object.keys(routes)) {
    const [m, pattern] = key.split(' ');
    if (m !== method) continue;
    const re = new RegExp('^' + pattern.replace(':id', '([^/]+)') + '$');
    const hit = path.match(re);
    if (hit) return [routes[key], hit[1] && decodeURIComponent(hit[1])];
  }
  return [];
}

export async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Vercel rewrite passes the original API path as ?__path=
  if (url.searchParams.has('__path')) { url.pathname = '/api/' + url.searchParams.get('__path'); url.searchParams.delete('__path'); }
  try {
    if (url.pathname.startsWith('/api/')) {
      const [handler, id] = match(req.method, url.pathname);
      if (!handler) throw Object.assign(new Error('Not found'), { status: 404 });
      const out = await handler(url.searchParams, id, req);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(out));
    }
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    const body = await readFile(join(PUBLIC, rel)).catch(() => readFile(join(PUBLIC, 'index.html')));
    res.writeHead(200, { 'content-type': MIME[extname(rel)] || 'text/html' });
    res.end(body);
  } catch (err) {
    res.writeHead(err.status || (err instanceof SyntaxError ? 400 : 500), { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}
