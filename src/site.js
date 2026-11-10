/* Site: en Durable Object per anläggning. Håller dagens kö, anläggningens inställningar
   och realtidsanslutningarna till terminal, väntrumsskärm, personal och kunders mobiler. */
import { DurableObject } from 'cloudflare:workers';
import { KK, fail, randomHex } from './lib.js';

const OPEN = ['waiting', 'called', 'serving'];
const MAINTENANCE_EVERY = 6 * 3600e3;
const RATE_WINDOW = 5 * 60e3, RATE_PER_IP = 30, RATE_PER_SITE = 120;
const DEMO_NAMES = ['Anna Svensson', 'Johan Lind', 'Fatima Rahimi', 'Erik Nilsson', 'Maria Holm', 'Ali Karimi', 'Sara Ek'];
const DEMO_PLAN = [['kvdbil', 'hamta'], ['autoexperten', 'inlamning'], ['kvdbil', 'provkor'], ['carglass', 'inlamning'], ['kvdbil', 'lamna'], ['autoexperten', 'upphamtning'], ['kvdbil', 'ovrigt']];

export class Site extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.s = ctx.storage;
    this.day = null;
    this.tickets = new Map();
    this.hits = [];
    ctx.blockConcurrencyWhile(() => this.load());
  }

  async load() {
    [this.meta, this.local, this.central] = await Promise.all(['meta', 'local', 'central'].map(k => this.s.get(k)));
    this.day = null;
    await this.loadDay();
    if (this.meta && !(await this.s.getAlarm())) await this.s.setAlarm(Date.now() + 60e3);
  }

  /* Byter till en ny dag vid midnatt (svensk tid) */
  async loadDay() {
    const day = KK.dayStr();
    if (day === this.day) return;
    this.day = day;
    this.tickets = new Map();
    for (const t of (await this.s.list({ prefix: `t:${day}:` })).values()) this.tickets.set(t.id, t);
  }

  async guard() {
    await this.loadDay();
    return this.meta ? null : fail(404, 'Anläggningen finns inte.');
  }

  get config() { return KK.mergeConfig(this.central, this.local); }

  /* ---------- Uppsättning (anropas från Hub) ---------- */
  async init(meta, local, central) {
    if (this.meta) return fail(409, 'Anläggningen finns redan.');
    this.meta = meta;
    this.central = KK.sanitizeCentral(central);
    this.local = KK.sanitizeLocal(local, this.central);
    await this.s.put({ meta: this.meta, central: this.central, local: this.local });
    await this.s.setAlarm(Date.now() + MAINTENANCE_EVERY);
    return { ok: true };
  }

  async setMeta(meta) { this.meta = meta; await this.s.put('meta', meta); this.broadcast(); return { ok: true }; }

  async setCentral(central) {
    if (!this.meta) return fail(404, 'Anläggningen finns inte.');
    this.central = KK.sanitizeCentral(central);
    this.local = KK.sanitizeLocal(this.local, this.central);   // nya tjänster blir påslagna, borttagna försvinner
    await this.s.put({ central: this.central, local: this.local });
    this.broadcast();
    return { ok: true };
  }

  async getLocal() { return this.local || KK.DEFAULT_LOCAL; }

  async putLocal(local) {
    const g = await this.guard(); if (g) return g;
    const l = KK.sanitizeLocal(local, this.central);
    if (!l.desks.length) return fail(400, 'Det måste finnas minst en disk.');
    this.local = l;
    await this.s.put('local', l);
    this.broadcast();
    return { ok: true, local: l };
  }

  async publicInfo() {
    const g = await this.guard(); if (g) return g;
    return { site: this.meta, config: this.config };
  }

  /* ---------- Ärenden ---------- */
  key(t) { return `t:${t.day}:${t.id}`; }

  async save(t) { this.tickets.set(t.id, t); await this.s.put(this.key(t), t); }

  /* Det som terminal, skärm och kundens mobil får se: kortnamn, inga telefonnummer eller regnummer */
  pub(t) {
    return { id: t.id, seq: t.seq, brand: t.brand, purpose: t.purpose, name: KK.shortName(t.name, this.central && this.central.nameFormat),
      status: t.status, desk: t.desk || '', createdAt: t.createdAt, calledAt: t.calledAt || 0, servedAt: t.servedAt || 0,
      doneAt: t.doneAt || 0, callCount: t.callCount || 0 };
  }

  staffView(t) { const { fid, ...rest } = t; return rest; }

  waitingIn(brand) { return [...this.tickets.values()].filter(t => t.status === 'waiting' && (!brand || t.brand === brand)).sort((a, b) => a.createdAt - b.createdAt); }

  aheadOf(t) { return this.waitingIn(t.brand).filter(x => x.createdAt < t.createdAt).length; }

  /* Underlag för väntetidsberäkning per företag */
  stats() {
    const out = {}, all = [...this.tickets.values()];
    for (const b of this.config.brands) {
      const mine = all.filter(t => t.brand === b.id);
      const done = mine.filter(t => t.status === 'done' && t.doneAt && (t.servedAt || t.calledAt));
      const avg = done.length < 2 ? 6 : Math.min(30, Math.max(2, done.reduce((s, t) => s + (t.doneAt - (t.servedAt || t.calledAt)), 0) / done.length / 60000));
      const desks = new Set(mine.filter(t => t.status === 'called' || t.status === 'serving').map(t => t.desk)).size || 1;
      out[b.id] = { waiting: mine.filter(t => t.status === 'waiting').length, done: done.length, avg, desks,
        longest: mine.filter(t => t.status === 'waiting').reduce((m, t) => Math.max(m, Date.now() - t.createdAt), 0) };
    }
    return out;
  }

  rateOk(ip) {
    const now = Date.now();
    this.hits = this.hits.filter(h => now - h.at < RATE_WINDOW);
    if (this.hits.length >= RATE_PER_SITE || this.hits.filter(h => h.ip === ip).length >= RATE_PER_IP) return false;
    this.hits.push({ ip, at: now });
    return true;
  }

  async newTicket(fields) {
    const seqKey = `seq:${this.day}:${fields.brand}`, seq = ((await this.s.get(seqKey)) || 0) + 1;
    await this.s.put(seqKey, seq);
    const t = { id: randomHex(6), fid: randomHex(16), day: this.day, seq, status: 'waiting', desk: '', callCount: 0,
      createdAt: Date.now(), name: '', phone: '', regnr: '', ...fields };
    await this.save(t);
    return t;
  }

  validEntry(d, { phoneRequired }) {
    const cfg = this.config, b = cfg.brands.find(x => x.id === d.brand && x.enabled);
    const p = b && b.purposes.find(x => x.id === d.purpose && x.enabled);
    if (!b || !p) return fail(400, 'Välj ett ärende.');
    const name = String(d.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (name.length < 2) return fail(400, 'Skriv ditt namn så vi kan ropa dig.');
    const phone = String(d.phone || '');
    if ((phoneRequired || phone) && !/^\d{10,15}$/.test(phone)) return fail(400, 'Kontrollera mobilnumret, till exempel 070-123 45 67.');
    const regnr = String(d.regnr || '').toUpperCase().replace(/[^A-ZÅÄÖ0-9]/g, '').slice(0, 7);
    return { brand: b.id, purpose: p.id, name, phone, regnr };
  }

  async checkin(d = {}, ip = '') {
    const g = await this.guard(); if (g) return g;
    if (!this.rateOk(ip)) return fail(429, 'Många incheckningar just nu. Vänta en minut och försök igen.');
    const e = this.validEntry(d, { phoneRequired: true }); if (e.__fail) return e;
    const t = await this.newTicket({ ...e, source: 'terminal' });
    this.broadcast();
    return { ticket: { ...this.pub(t), fid: t.fid }, ahead: this.aheadOf(t) };
  }

  async staffAdd(d = {}, user) {
    const g = await this.guard(); if (g) return g;
    const e = this.validEntry(d, { phoneRequired: false }); if (e.__fail) return e;
    const t = await this.newTicket({ ...e, source: 'staff', addedBy: user.id });
    this.broadcast();
    return { ok: true, ticket: this.staffView(t) };
  }

  /* Alla statusbyten kontrolleras här, så att två medarbetare inte kan ropa samma kund */
  async action(id, name, d = {}, user) {
    const g = await this.guard(); if (g) return g;
    const t = this.tickets.get(id);
    if (!t) return fail(404, 'Ärendet finns inte längre.');
    const now = Date.now(), cfg = this.config, deskOk = x => cfg.desks.some(k => k.id === x);
    const from = (...st) => st.includes(t.status) ? null : fail(409, 'Ärendet har redan ändrats av någon annan. Listan är uppdaterad.');
    let err = null;
    switch (name) {
      case 'call':
        if ((err = from('waiting'))) return err;
        if (!deskOk(d.desk)) return fail(400, 'Välj din station först.');
        Object.assign(t, { status: 'called', desk: d.desk, calledAt: now, callCount: (t.callCount || 0) + 1, calledBy: user.id });
        break;
      case 'recall':
        if ((err = from('called'))) return err;
        Object.assign(t, { desk: deskOk(d.desk) ? d.desk : t.desk, calledAt: now, callCount: (t.callCount || 0) + 1, calledBy: user.id });
        break;
      case 'serve':
        if ((err = from('called'))) return err;
        Object.assign(t, { status: 'serving', servedAt: now });
        break;
      case 'done':
        if ((err = from('called', 'serving'))) return err;
        Object.assign(t, { status: 'done', doneAt: now, phone: '' });   // mobilnumret raderas när besöket är klart
        break;
      case 'noshow':
        if ((err = from('called'))) return err;
        Object.assign(t, { status: 'noshow', doneAt: now });             // numret raderas i nattens gallring
        break;
      case 'requeue':
        if ((err = from('noshow'))) return err;
        Object.assign(t, { status: 'waiting', desk: '' });                // behåller sin ursprungliga plats
        break;
      case 'transfer': {
        if ((err = from('waiting', 'called', 'noshow'))) return err;
        const b = cfg.brands.find(x => x.id === d.brand && x.enabled), p = b && b.purposes.find(x => x.id === d.purpose && x.enabled);
        if (!p) return fail(400, 'Välj ett giltigt ärende att flytta till.');
        Object.assign(t, { brand: b.id, purpose: p.id, status: 'waiting', desk: '' });
        break;
      }
      case 'delete':
        this.tickets.delete(t.id);
        await this.s.delete(this.key(t));
        this.broadcast();
        return { ok: true };
      default:
        return fail(400, 'Okänd åtgärd.');
    }
    await this.save(t);
    this.broadcast();
    return { ok: true, ticket: this.staffView(t) };
  }

  async callNext(desk, brands, user) {
    const g = await this.guard(); if (g) return g;
    const want = new Set(Array.isArray(brands) ? brands : []);
    const next = this.waitingIn().find(t => want.has(t.brand));
    if (!next) return fail(404, 'Ingen väntar i dina köer just nu.');
    return this.action(next.id, 'call', { desk }, user);
  }

  async demo(user) {
    const g = await this.guard(); if (g) return g;
    const cfg = this.config, now = Date.now();
    for (let i = 0; i < DEMO_NAMES.length; i++) {
      const [bId, pId] = DEMO_PLAN[i], b = cfg.brands.find(x => x.id === bId) || cfg.brands[0];
      if (!b) break;
      const p = b.purposes.find(x => x.id === pId) || b.purposes[0];
      const t = await this.newTicket({ brand: b.id, purpose: p.id, name: DEMO_NAMES[i], regnr: i % 2 ? '' : ['ABC123', 'MLK42X', 'GHT771', 'RPO55B'][i / 2 | 0],
        source: 'terminal', demo: true, createdAt: now - (DEMO_NAMES.length - i) * 3 * 60000 });
      if (i === 0 && cfg.desks[0]) { Object.assign(t, { status: 'called', desk: (cfg.desks.find(x => x.id === p.desk) || cfg.desks[0]).id, calledAt: now - 60000, callCount: 1 }); await this.save(t); }
    }
    this.broadcast();
    return { ok: true, added: DEMO_NAMES.length };
  }

  async clear() {
    const g = await this.guard(); if (g) return g;
    const n = this.tickets.size, keys = [...this.tickets.values()].map(t => this.key(t));
    for (let i = 0; i < keys.length; i += 128) await this.s.delete(keys.slice(i, i + 128));
    this.tickets.clear();
    this.broadcast();
    return { ok: true, removed: n };
  }

  /* ---------- Realtid via WebSocket (vilande mellan meddelanden, så det kostar nästan inget) ---------- */
  async fetch(req) {
    await this.loadDay();
    if (!this.meta) return new Response('Anläggningen finns inte', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Förväntade WebSocket', { status: 426 });
    const fid = (new URL(req.url).searchParams.get('follow') || '').slice(0, 64);
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const a = { mode: fid ? 'follow' : 'public', fid };
    server.serializeAttachment(a);
    server.send(JSON.stringify(this.snapshot(a)));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, msg) {
    await this.loadDay();
    let m; try { m = JSON.parse(msg); } catch { return; }
    if (m.type === 'ping') return ws.send('{"type":"pong"}');
    if (m.type === 'auth') {
      const user = await this.env.HUB.get(this.env.HUB.idFromName('hub')).verify(m.token);
      if (user && (user.role === 'central' || (user.sites || []).includes(this.meta.id))) {
        ws.serializeAttachment({ mode: 'staff', uid: user.id });
        ws.send(JSON.stringify({ type: 'auth', ok: true }));
        ws.send(JSON.stringify(this.snapshot({ mode: 'staff' })));
      } else ws.send(JSON.stringify({ type: 'auth', ok: false }));
    }
  }

  async webSocketClose(ws, code) { try { ws.close(code, 'closing'); } catch {} }

  snapshot(a) {
    const base = { type: 'snapshot', mode: a.mode, site: this.meta, config: this.config, stats: this.stats(), day: this.day, now: Date.now() };
    const all = [...this.tickets.values()];
    if (a.mode === 'staff') return { ...base, tickets: all.map(t => this.staffView(t)) };
    if (a.mode === 'follow') {
      const t = a.fid && all.find(x => x.fid === a.fid);
      return { ...base, ticket: t ? this.pub(t) : null, ahead: t && t.status === 'waiting' ? this.aheadOf(t) : 0 };
    }
    return { ...base, called: all.filter(t => t.status === 'called').sort((x, y) => y.calledAt - x.calledAt).slice(0, 8).map(t => this.pub(t)) };
  }

  broadcast() {
    const cache = {};
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || { mode: 'public' };
      const k = a.mode === 'follow' ? 'f:' + a.fid : a.mode;
      try { ws.send(cache[k] || (cache[k] = JSON.stringify(this.snapshot(a)))); } catch {}
    }
  }

  /* ---------- Gallring enligt GDPR, var sjätte timme ---------- */
  async alarm() {
    await this.loadDay();
    if (!this.meta) return;
    const cutoff = KK.dayStr(Date.now() - ((this.central && this.central.retentionDays) || 30) * 864e5);
    for (const [k, t] of await this.s.list({ prefix: 't:' })) {
      if (t.day < cutoff) { await this.s.delete(k); continue; }
      if (t.day < this.day && (t.phone || OPEN.includes(t.status))) {
        t.phone = '';
        if (OPEN.includes(t.status)) t.status = 'expired';
        await this.s.put(k, t);
      }
    }
    for (const k of (await this.s.list({ prefix: 'seq:' })).keys()) if (k.split(':')[1] < this.day) await this.s.delete(k);
    await this.s.setAlarm(Date.now() + MAINTENANCE_EVERY);
  }
}
