/* Hub: en enda central Durable Object för hela bolaget.
   Håller konton, inloggningar, listan över anläggningar och den centrala konfigurationen. */
import { DurableObject } from 'cloudflare:workers';
import { KK, fail, isFail, randomHex, sha256, hashPassword, safeEqual, validEmail, PASSWORD_MIN, ROLES } from './lib.js';

const SESSION_DAYS = 30;
const SEED_SITES = ['Kungälv', 'Svedala', 'Linköping', 'Brännbacken'];
const LOCK_AFTER = 8, LOCK_MINUTES = 10;

const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, sites: u.sites || [], disabled: !!u.disabled });

export class Hub extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.s = ctx.storage; }

  siteStub(id) { return this.env.SITE.get(this.env.SITE.idFromName(id)); }

  /* ---------- Första uppstart ---------- */
  async setupStatus() { return { needed: !(await this.s.get('setupDone')) }; }

  async setup({ code, email, name, password } = {}) {
    if (await this.s.get('setupDone')) return fail(409, 'Kökortet är redan uppsatt.');
    if (!this.env.SETUP_CODE) return fail(503, 'Startkoden SETUP_CODE är inte inlagd i Cloudflare.');
    if (!safeEqual(String(code || ''), String(this.env.SETUP_CODE))) return fail(403, 'Fel startkod.');
    const err = this.checkNewUser({ email, name, password, role: 'central', sites: [] }, true);
    if (err) return err;
    await this.s.put('central', KK.sanitizeCentral(KK.DEFAULT_CENTRAL));
    const sites = [];
    for (const n of SEED_SITES) {
      const site = { id: KK.slug(n), name: n };
      await this.siteStub(site.id).init(site, KK.DEFAULT_LOCAL, await this.s.get('central'));
      sites.push(site);
    }
    await this.s.put('sites', sites);
    await this.storeUser({ email, name, password, role: 'central', sites: [] });
    await this.s.put('setupDone', true);
    return this.login(email, password);
  }

  /* ---------- Inloggning ---------- */
  async login(email, password) {
    email = String(email || '').trim().toLowerCase();
    const lockKey = 'lf:' + email, lock = (await this.s.get(lockKey)) || { n: 0, until: 0 };
    if (lock.until > Date.now()) return fail(429, `För många misslyckade försök. Försök igen om ${Math.ceil((lock.until - Date.now()) / 60000)} minuter.`);
    const uid = await this.s.get('e:' + email), u = uid && await this.s.get('u:' + uid);
    const ok = u && !u.disabled && safeEqual((await hashPassword(password, u.salt)).hash, u.hash);
    if (!ok) {
      lock.n += 1;
      if (lock.n >= LOCK_AFTER) { lock.until = Date.now() + LOCK_MINUTES * 60000; lock.n = 0; }
      await this.s.put(lockKey, lock);
      return fail(401, 'Fel e-post eller lösenord.');
    }
    await this.s.delete(lockKey);
    const token = randomHex(32), key = await sha256(token);
    await this.s.put('s:' + key, { uid: u.id, exp: Date.now() + SESSION_DAYS * 864e5 });
    u.sess = [...(u.sess || []), key].slice(-20);
    await this.s.put('u:' + u.id, u);
    return { token, user: publicUser(u) };
  }

  async verify(token) {
    if (!token || typeof token !== 'string' || token.length > 128) return null;
    const key = await sha256(token), s = await this.s.get('s:' + key);
    if (!s || s.exp < Date.now()) return null;
    const u = await this.s.get('u:' + s.uid);
    if (!u || u.disabled || !(u.sess || []).includes(key)) return null;
    if (s.exp - Date.now() < 15 * 864e5) await this.s.put('s:' + key, { ...s, exp: Date.now() + SESSION_DAYS * 864e5 });
    return publicUser(u);
  }

  async logout(token) {
    if (!token) return { ok: true };
    const key = await sha256(token), s = await this.s.get('s:' + key);
    await this.s.delete('s:' + key);
    if (s) { const u = await this.s.get('u:' + s.uid); if (u) { u.sess = (u.sess || []).filter(k => k !== key); await this.s.put('u:' + u.id, u); } }
    return { ok: true };
  }

  /* ---------- Central konfiguration och anläggningar ---------- */
  async getCentral() { return (await this.s.get('central')) || KK.sanitizeCentral(KK.DEFAULT_CENTRAL); }

  async putCentral(central) {
    const c = KK.sanitizeCentral(central);
    if (!c.brands.length) return fail(400, 'Det måste finnas minst ett företag med tjänster.');
    await this.s.put('central', c);
    const sites = await this.listSites();
    await Promise.allSettled(sites.map(s => this.siteStub(s.id).setCentral(c)));
    return { ok: true, central: c };
  }

  async listSites() { return (await this.s.get('sites')) || []; }

  async createSite({ name, copyFrom } = {}) {
    name = String(name || '').trim().slice(0, 60);
    const id = KK.slug(name);
    if (!name || !id) return fail(400, 'Skriv ett namn på anläggningen.');
    const sites = await this.listSites();
    if (sites.some(s => s.id === id)) return fail(409, `Det finns redan en anläggning som heter ${name}.`);
    let local = KK.DEFAULT_LOCAL;
    if (copyFrom) {
      if (!sites.some(s => s.id === copyFrom)) return fail(404, 'Anläggningen att kopiera från finns inte.');
      local = await this.siteStub(copyFrom).getLocal();
    }
    const site = { id, name };
    const r = await this.siteStub(id).init(site, local, await this.getCentral());
    if (isFail(r)) return r;
    sites.push(site);
    await this.s.put('sites', sites);
    return { ok: true, site };
  }

  async renameSite(id, name) {
    name = String(name || '').trim().slice(0, 60);
    if (!name) return fail(400, 'Skriv ett namn på anläggningen.');
    const sites = await this.listSites(), s = sites.find(x => x.id === id);
    if (!s) return fail(404, 'Anläggningen finns inte.');
    s.name = name;
    await this.s.put('sites', sites);
    await this.siteStub(id).setMeta({ id, name });
    return { ok: true, site: s };
  }

  /* ---------- Konton ---------- */
  checkNewUser({ email, name, password, role, sites }, isNew) {
    if (isNew && !validEmail(email)) return fail(400, 'Skriv en giltig e-postadress.');
    if (name != null && String(name).length > 60) return fail(400, 'Namnet får vara högst 60 tecken.');
    if ((isNew || password) && String(password || '').length < PASSWORD_MIN) return fail(400, `Lösenordet måste vara minst ${PASSWORD_MIN} tecken.`);
    if (role != null && !ROLES.includes(role)) return fail(400, 'Okänd roll.');
    if (role && role !== 'central' && (!Array.isArray(sites) || !sites.length)) return fail(400, 'Välj minst en anläggning.');
    return null;
  }

  async storeUser({ email, name, password, role, sites }) {
    email = String(email).trim().toLowerCase();
    if (await this.s.get('e:' + email)) return fail(409, 'Det finns redan ett konto med den e-postadressen.');
    const id = 'u' + randomHex(8), { salt, hash } = await hashPassword(password);
    const u = { id, email, name: String(name || '').trim(), role, sites: role === 'central' ? [] : sites, salt, hash, createdAt: Date.now(), sess: [] };
    await this.s.put('u:' + id, u);
    await this.s.put('e:' + email, id);
    return publicUser(u);
  }

  async allUsers() { return [...(await this.s.list({ prefix: 'u:' })).values()]; }

  /* Vem får se och ändra vem: central = alla, anläggningsadmin = personal på sina anläggningar */
  canManage(actor, target) {
    if (actor.role === 'central') return true;
    if (actor.role !== 'site') return false;
    return target.role === 'staff' && (target.sites || []).every(s => actor.sites.includes(s));
  }

  async listUsers(actor) {
    const all = await this.allUsers();
    const visible = actor.role === 'central' ? all
      : all.filter(u => u.id === actor.id || (u.sites || []).some(s => actor.sites.includes(s)));
    return visible.map(u => ({ ...publicUser(u), canEdit: u.id !== actor.id && this.canManage(actor, u) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'sv'));
  }

  async validSites(sites) {
    const known = new Set((await this.listSites()).map(s => s.id));
    return (Array.isArray(sites) ? sites : []).filter(s => known.has(s));
  }

  async createUser(actor, data = {}) {
    const role = data.role || 'staff', sites = await this.validSites(data.sites);
    if (actor.role === 'site' && (role !== 'staff' || !sites.every(s => actor.sites.includes(s))))
      return fail(403, 'Du kan bara lägga till personal på dina egna anläggningar.');
    if (actor.role === 'staff') return fail(403, 'Du har inte behörighet att lägga till konton.');
    const err = this.checkNewUser({ ...data, role, sites }, true);
    if (err) return err;
    return this.storeUser({ ...data, role, sites });
  }

  async countCentral(exceptId) { return (await this.allUsers()).filter(u => u.role === 'central' && !u.disabled && u.id !== exceptId).length; }

  async updateUser(actor, id, patch = {}) {
    const u = await this.s.get('u:' + id);
    if (!u) return fail(404, 'Kontot finns inte.');
    if (!this.canManage(actor, u) && actor.id !== id) return fail(403, 'Du har inte behörighet att ändra det här kontot.');
    if (actor.id === id && (patch.role || patch.sites || patch.disabled)) return fail(403, 'Du kan inte ändra roll eller anläggningar på ditt eget konto.');
    const role = patch.role || u.role, sites = patch.sites ? await this.validSites(patch.sites) : u.sites;
    if (actor.role === 'site' && (role !== 'staff' || !sites.every(s => actor.sites.includes(s))))
      return fail(403, 'Du kan bara hantera personal på dina egna anläggningar.');
    const err = this.checkNewUser({ name: patch.name, password: patch.password, role, sites }, false);
    if (err) return err;
    if (u.role === 'central' && (role !== 'central' || patch.disabled) && !(await this.countCentral(u.id)))
      return fail(409, 'Det måste finnas minst en aktiv central administratör.');
    if (patch.name != null) u.name = String(patch.name).trim();
    u.role = role; u.sites = role === 'central' ? [] : sites;
    if (patch.disabled != null) u.disabled = !!patch.disabled;
    let endSessions = patch.disabled === true || patch.role != null || patch.sites != null;
    if (patch.password) { Object.assign(u, await hashPassword(patch.password)); endSessions = actor.id !== id; }
    if (endSessions) { for (const k of u.sess || []) await this.s.delete('s:' + k); u.sess = []; }
    await this.s.put('u:' + id, u);
    return publicUser(u);
  }

  async deleteUser(actor, id) {
    const u = await this.s.get('u:' + id);
    if (!u) return fail(404, 'Kontot finns inte.');
    if (actor.id === id) return fail(403, 'Du kan inte ta bort ditt eget konto.');
    if (!this.canManage(actor, u)) return fail(403, 'Du har inte behörighet att ta bort det här kontot.');
    if (u.role === 'central' && !(await this.countCentral(u.id))) return fail(409, 'Det måste finnas minst en aktiv central administratör.');
    for (const k of u.sess || []) await this.s.delete('s:' + k);
    await this.s.delete('u:' + id);
    await this.s.delete('e:' + u.email);
    return { ok: true };
  }
}
