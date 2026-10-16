import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walletEnabled, clearCache } from './wallet.js';
import { accessConfigured, verifyAccess } from './access.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const DAY = 864e5;
const LIVE = walletEnabled();
// Never serve real customer data from a public deployment: on Vercel, live mode needs Cloudflare Access.
// PROTECTED_BY=vercel-auth declares that Vercel Authentication (Deployment Protection: All Deployments) guards the site.
const VERCEL_AUTH = process.env.PROTECTED_BY === 'vercel-auth';
const NEEDS_ACCESS = LIVE && !!process.env.VERCEL && !VERCEL_AUTH && process.env.ALLOW_UNPROTECTED !== '1';
const protection = () => (accessConfigured() ? 'cloudflare' : VERCEL_AUTH ? 'vercel' : null);

const src = await import(LIVE ? './sources/wallet.js' : './sources/demo.js');

const iso = (t) => new Date(t).toISOString().slice(0, 10);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

// from/to are inclusive UTC calendar dates; prev* is the equal-length window just before.
function range(q) {
  const to = isDate(q.get('to')) ? q.get('to') : iso(Date.now());
  const from = isDate(q.get('from')) ? q.get('from') : iso(Date.parse(to) - 29 * DAY);
  const len = Date.parse(to) - Date.parse(from) + DAY;
  return { from, to, prevFrom: iso(Date.parse(from) - len), prevTo: iso(Date.parse(from) - DAY) };
}

let lastRefresh = 0;
const routes = {
  'GET /api/meta': async () => { const settings = await src.settings(); return { ...src.status(), live: LIVE, accessProtected: accessConfigured(), protection: protection(), settings }; },
  'GET /api/overview': async (q) => { const r = range(q); return { range: r, ...(await src.overview(r)) }; },
  'GET /api/clients': async (q) => src.clients(range(q)),
  'GET /api/clients/:id': async (q, id) => { const r = range(q); return { range: r, ...(await src.client(id, r)) }; },
  'GET /api/clients/:id/events': async (q, id) => src.events(id, range(q), {
    service: q.get('service') || undefined, model: q.get('model') || undefined,
    page: Math.max(Number(q.get('page')) || 1, 1), limit: Math.min(Number(q.get('limit')) || 50, 200),
  }),
  // Drops the cached Wallet API responses so the next load is fresh. Rate-limited to once a minute.
  'POST /api/refresh': async () => {
    if (Date.now() - lastRefresh < 60e3) return { refreshed: false, retryInSeconds: Math.ceil((60e3 - (Date.now() - lastRefresh)) / 1000) };
    lastRefresh = Date.now(); clearCache();
    return { refreshed: true };
  },
};

function match(method, path) {
  for (const key of Object.keys(routes)) {
    const [m, pattern] = key.split(' ');
    if (m !== method) continue;
    const hit = path.match(new RegExp('^' + pattern.replace(':id', '([^/]+)') + '$'));
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
      if (accessConfigured()) await verifyAccess(req);
      else if (NEEDS_ACCESS) throw Object.assign(new Error('Live Wallet data is locked until Cloudflare Access is configured (CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD).'), { status: 403 });
      const [route, id] = match(req.method, url.pathname);
      if (!route) throw Object.assign(new Error('Not found'), { status: 404 });
      const out = await route(url.searchParams, id, req);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'private, no-store' });
      return res.end(JSON.stringify(out));
    }
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    const body = await readFile(join(PUBLIC, rel)).catch(() => readFile(join(PUBLIC, 'index.html')));
    res.writeHead(200, { 'content-type': MIME[extname(rel)] || 'text/html' });
    res.end(body);
  } catch (err) {
    if (!err.status) console.error(err);
    res.writeHead(err.status || 500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: err.message }));
  }
}
