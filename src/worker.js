/* Kökortet – Worker: tar emot alla /api-anrop, kontrollerar inloggning och behörighet
   och skickar vidare till rätt Durable Object. Allt annat är statiska filer i public/. */
import { json, reply, isFail, canStaff, canSiteAdmin, isCentral } from './lib.js';
export { Hub } from './hub.js';
export { Site } from './site.js';

const MAX_BODY = 64 * 1024;
const SITE_ID = /^[a-z0-9-]{1,40}$/;

const hubOf = env => env.HUB.get(env.HUB.idFromName('hub'));
const siteOf = (env, id) => env.SITE.get(env.SITE.idFromName(id));
const bearer = req => (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
const deny = (user, what = 'Du har inte behörighet för det här.') => json({ error: user ? what : 'Logga in för att fortsätta.' }, user ? 403 : 401);

async function body(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 });
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
}

async function api(req, env, url) {
  const hub = hubOf(env), m = req.method, parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const user = await (async () => { const t = bearer(req); return t ? hub.verify(t) : null; })();

  /* ---- Uppsättning och inloggning ---- */
  if (parts[0] === 'setup') {
    if (m === 'GET') return reply(await hub.setupStatus());
    if (m === 'POST') return reply(await hub.setup(await body(req)), 201);
  }
  if (parts[0] === 'login' && m === 'POST') { const b = await body(req); return reply(await hub.login(b.email, b.password)); }
  if (parts[0] === 'logout' && m === 'POST') return reply(await hub.logout(bearer(req)));
  if (parts[0] === 'me' && m === 'GET') return user ? json({ user }) : deny(null);

  /* ---- Central konfiguration ---- */
  if (parts[0] === 'central' && parts.length === 1) {
    if (m === 'GET') return json(await hub.getCentral());
    if (m === 'PUT') return isCentral(user) ? reply(await hub.putCentral(await body(req))) : deny(user, 'Bara central administratör kan ändra gemensamma inställningar.');
  }

  /* ---- Konton ---- */
  if (parts[0] === 'users') {
    if (!user || user.role === 'staff') return deny(user);
    if (parts.length === 1 && m === 'GET') return json(await hub.listUsers(user));
    if (parts.length === 1 && m === 'POST') return reply(await hub.createUser(user, await body(req)), 201);
    if (parts.length === 2 && m === 'PATCH') return reply(await hub.updateUser(user, parts[1], await body(req)));
    if (parts.length === 2 && m === 'DELETE') return reply(await hub.deleteUser(user, parts[1]));
  }

  /* ---- Anläggningar ---- */
  if (parts[0] === 'sites') {
    if (parts.length === 1) {
      if (m === 'GET') return json(await hub.listSites());
      if (m === 'POST') return isCentral(user) ? reply(await hub.createSite(await body(req)), 201) : deny(user, 'Bara central administratör kan lägga till anläggningar.');
    }
    const id = parts[1];
    if (!SITE_ID.test(id || '')) return json({ error: 'Okänd anläggning.' }, 404);
    const site = siteOf(env, id), action = parts[2];

    if (!action && m === 'GET') return reply(await site.publicInfo());
    if (!action && m === 'PATCH') return isCentral(user) ? reply(await hub.renameSite(id, (await body(req)).name)) : deny(user);

    /* Realtid: alla får den publika vyn; personalen loggar in över anslutningen */
    if (action === 'live') {
      if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'Förväntade WebSocket.' }, 426);
      return site.fetch(req);
    }

    /* Incheckning är öppen för alla – det är kunden vid terminalen */
    if (action === 'checkin' && m === 'POST') return reply(await site.checkin(await body(req), req.headers.get('cf-connecting-ip') || ''), 201);

    /* Allt nedan kräver personal på just den här anläggningen */
    if (!canStaff(user, id)) return deny(user, 'Du har inte behörighet på den här anläggningen.');
    if (action === 'tickets' && parts.length === 3 && m === 'POST') return reply(await site.staffAdd(await body(req), user), 201);
    if (action === 'tickets' && parts.length === 5 && m === 'POST') return reply(await site.action(parts[3], parts[4], await body(req), user));
    if (action === 'call-next' && m === 'POST') { const b = await body(req); return reply(await site.callNext(b.desk, b.brands, user)); }

    /* Anläggningsadministratör */
    if (!canSiteAdmin(user, id)) return deny(user, 'Bara administratör för anläggningen kan göra det här.');
    if (action === 'local' && m === 'PUT') return reply(await site.putLocal(await body(req)));
    if (action === 'demo' && m === 'POST') return reply(await site.demo(user));
    if (action === 'clear' && m === 'POST') return reply(await site.clear());
  }

  return json({ error: 'Hittades inte.' }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await api(req, env, url);
    } catch (e) {
      if (e && e.status) return json({ error: e.status === 413 ? 'För stor förfrågan.' : 'Felaktig förfrågan.' }, e.status);
      console.error('API-fel', e && e.stack || e);
      return json({ error: 'Något gick fel på servern. Försök igen.' }, 500);
    }
  }
};
