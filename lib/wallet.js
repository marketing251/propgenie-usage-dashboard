// Read-only client for the FPFX Wallet API (wallet.fpfxtech.io).
// Only GET requests are ever made — the token may be an admin token, so this client
// deliberately has no way to call credit/debit/adjustment endpoints.

export const WALLET_URL = (process.env.WALLET_API_URL || 'https://wallet.fpfxtech.io').replace(/\/$/, '');
const TOKEN = process.env.WALLET_API_TOKEN || '';
export const CACHE_MINUTES = Number(process.env.CACHE_MINUTES || 15);
export const walletEnabled = () => !!TOKEN;

const cache = new Map(); // url -> { at, promise }
export let lastFetched = null;
export function clearCache() { cache.clear(); }

export class WalletError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// The spec allows numbers to arrive as strings ("12.5"); normalise them recursively.
function numify(v) {
  if (Array.isArray(v)) return v.map(numify);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, numify(x)]));
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

export function get(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const url = `${WALLET_URL}${path}${qs.size ? '?' + qs : ''}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MINUTES * 60e3) return hit.promise;
  const promise = (async () => {
    const res = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' }, signal: AbortSignal.timeout(30e3) });
    if (res.status === 401 || res.status === 403) throw new WalletError('Wallet API rejected the token (check WALLET_API_TOKEN).', 502);
    if (res.status === 404) return null;
    if (!res.ok) throw new WalletError(`Wallet API ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`, 502);
    lastFetched = new Date().toISOString();
    return numify(await res.json());
  })();
  cache.set(url, { at: Date.now(), promise });
  promise.catch(() => cache.delete(url)); // never cache failures
  return promise;
}

// Run fn over items with bounded concurrency so a fan-out across tenants stays polite.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}
