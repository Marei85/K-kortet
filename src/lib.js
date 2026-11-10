/* Server-side helpers: responses, errors, crypto. */
import '../public/shared.js';
export const KK = globalThis.KK;

export const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

/* Durable Object methods return errors as values so the HTTP status survives the RPC boundary */
export const fail = (status, error) => ({ __fail: true, status, error });
export const isFail = r => !!(r && r.__fail);
export const reply = (r, okStatus = 200) => isFail(r) ? json({ error: r.error }, r.status) : json(r, okStatus);

const enc = new TextEncoder();
export const toHex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = hex => new Uint8Array((hex.match(/../g) || []).map(h => parseInt(h, 16)));
export const randomHex = (n = 16) => toHex(crypto.getRandomValues(new Uint8Array(n)));
export const sha256 = async s => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));

/* PBKDF2-SHA256, 100 000 iterationer (maxvärdet i Cloudflare Workers) */
export async function hashPassword(password, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return { salt: toHex(salt), hash: toHex(new Uint8Array(bits)) };
}

export function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const validEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(String(e || ''));
export const PASSWORD_MIN = 10;
export const ROLES = ['central', 'site', 'staff'];
export const ROLE_NAMES = { central: 'Central administratör', site: 'Anläggningsadministratör', staff: 'Personal' };

/* Behörighet */
export const canStaff = (u, site) => !!u && (u.role === 'central' || (u.sites || []).includes(site));
export const canSiteAdmin = (u, site) => !!u && (u.role === 'central' || (u.role === 'site' && (u.sites || []).includes(site)));
export const isCentral = u => !!u && u.role === 'central';
