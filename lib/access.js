// Cloudflare Access verification. When CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD are set, every /api
// request must carry a valid Access JWT (Cf-Access-Jwt-Assertion header or CF_Authorization cookie).
import { createPublicKey, verify } from 'node:crypto';

const TEAM = (process.env.CF_ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const AUD = process.env.CF_ACCESS_AUD || '';
export const accessConfigured = () => !!(TEAM && AUD);

let keys = null, keysAt = 0;
async function getKeys(force) {
  if (!force && keys && Date.now() - keysAt < 3600e3) return keys;
  const res = await fetch(`https://${TEAM}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10e3) });
  if (!res.ok) throw new Error(`Could not load Cloudflare Access certs (${res.status})`);
  keys = Object.fromEntries((await res.json()).keys.map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })]));
  keysAt = Date.now();
  return keys;
}

const b64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const deny = (msg) => Object.assign(new Error(msg), { status: 403 });

export async function verifyAccess(req) {
  const cookie = (req.headers.cookie || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
  const token = req.headers['cf-access-jwt-assertion'] || cookie;
  if (!token) throw deny('Cloudflare Access login required.');
  const [h, p, s] = token.split('.');
  if (!s) throw deny('Malformed Access token.');
  const header = JSON.parse(b64(h)), payload = JSON.parse(b64(p));
  let key = (await getKeys())[header.kid] || (await getKeys(true))[header.kid];
  if (!key || header.alg !== 'RS256') throw deny('Unknown Access signing key.');
  if (!verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, b64(s))) throw deny('Invalid Access token signature.');
  const aud = [].concat(payload.aud);
  if (!aud.includes(AUD)) throw deny('Access token is for a different application.');
  if (payload.iss !== `https://${TEAM}`) throw deny('Access token issuer mismatch.');
  if (payload.exp * 1000 < Date.now()) throw deny('Access session expired — reload to sign in again.');
  return { email: payload.email || null };
}
