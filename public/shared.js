/* Kökortet – logik som delas mellan webbsidan och servern.
   Laddas som vanligt skript i webbläsaren (globalt KK) och importeras av servern (src/). */
(function (root) {
  'use strict';

  const COLORS = ['blue', 'red', 'amber', 'green', 'violet', 'teal'];
  const DIR_KEYS = ['left', 'right', 'straight', 'back'];

  /* Gemensamt för alla anläggningar: tjänstekatalog, texter, hälsningar, integritet */
  const DEFAULT_CENTRAL = {
    brands: [
      { id: 'kvdbil', name: 'KVD Bil', tagline: 'Bilförsäljning', prefix: 'K', color: 'blue', purposes: [
        { id: 'hamta', label: 'Hämta bil', hint: 'Du har köpt en bil och ska hämta ut den' },
        { id: 'lamna', label: 'Lämna bil', hint: 'Du ska lämna in en bil som vi säljer åt dig' },
        { id: 'provkor', label: 'Provkörning', hint: 'Du har bokat eller vill göra en provkörning' },
        { id: 'ovrigt', label: 'Övrigt ärende', hint: 'Frågor om köp, betalning eller papper' }
      ] },
      { id: 'autoexperten', name: 'Autoexperten', tagline: 'Verkstadsbesök', prefix: 'A', color: 'red', purposes: [
        { id: 'inlamning', label: 'Lämna in bil', hint: 'Service, reparation eller däckbyte' },
        { id: 'upphamtning', label: 'Hämta bil', hint: 'Din bil är klar att hämtas' }
      ] },
      { id: 'carglass', name: 'Carglass', tagline: 'Bilglasbyte', prefix: 'C', color: 'amber', purposes: [
        { id: 'inlamning', label: 'Lämna in bil', hint: 'Stenskott eller rutbyte' },
        { id: 'upphamtning', label: 'Hämta bil', hint: 'Ditt glasbyte är klart' }
      ] }
    ],
    greetings: [
      { upTo: 10, text: 'Välkommen' },
      { upTo: 20, text: 'Tack för väntan' },
      { upTo: 30, text: 'Äntligen' }
    ],
    greetingLong: 'Tack för ditt tålamod',
    callText: '{halsning} {namn} – du har grönt ljus till {disk}',
    nameFormat: 'short',
    retentionDays: 30,
    follow: { enabled: true }
  };

  /* Per anläggning: diskar, vilka tjänster som är på, förvald disk, väntplats, skärmtext */
  const DEFAULT_LOCAL = {
    desks: [
      { id: 'd1', name: 'Disk 1', location: 'Receptionen, vänster sida', dir: 'left' },
      { id: 'd2', name: 'Disk 2', location: 'Receptionen, höger sida', dir: 'right' },
      { id: 'u1', name: 'Utlämningen', location: 'Glasdörren mot parkering P2', dir: 'straight' },
      { id: 'v1', name: 'Verkstadsdisken', location: 'Genom korridoren till höger', dir: 'right' },
      { id: 'g1', name: 'Carglass-disken', location: 'Hall B, vid port 3', dir: 'left' }
    ],
    screenMessage: 'Välkommen! Håll utkik här, vi ropar ditt namn och visar vart du ska gå.',
    brands: {
      kvdbil: { enabled: true, waitText: 'Ta plats i loungen vid entrén', purposes: {
        hamta: { enabled: true, desk: 'u1' }, lamna: { enabled: true, desk: 'd1' },
        provkor: { enabled: true, desk: 'd2' }, ovrigt: { enabled: true, desk: 'd1' } } },
      autoexperten: { enabled: true, waitText: 'Ta plats i loungen, verkstaden ropar dig här', purposes: {
        inlamning: { enabled: true, desk: 'v1' }, upphamtning: { enabled: true, desk: 'v1' } } },
      carglass: { enabled: true, waitText: 'Ta plats i loungen, Carglass ropar dig här', purposes: {
        inlamning: { enabled: true, desk: 'g1' }, upphamtning: { enabled: true, desk: 'g1' } } }
    }
  };

  const clone = o => JSON.parse(JSON.stringify(o));
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const arr = (v, max) => (Array.isArray(v) ? v : []).slice(0, max);
  const idv = v => (/^[a-z0-9][a-z0-9-]{0,39}$/i.test(String(v || '')) ? String(v) : '');
  const clampInt = (v, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; };
  const uniqBy = (list, key) => { const seen = new Set(); return list.filter(x => !seen.has(x[key]) && seen.add(x[key])); };

  /* Sätter ihop central och lokal konfiguration till den form som gränssnittet använder */
  function mergeConfig(central, local) {
    const c = central || DEFAULT_CENTRAL, l = local || {}, lb = l.brands || {};
    return {
      brands: (c.brands || []).map(b => {
        const o = lb[b.id] || {}, lp = o.purposes || {};
        return {
          id: b.id, name: b.name, tagline: b.tagline || '', prefix: b.prefix || '', color: b.color || 'teal',
          enabled: o.enabled !== false, waitText: o.waitText == null ? '' : o.waitText,
          purposes: (b.purposes || []).map(p => ({
            id: p.id, label: p.label, hint: p.hint || '',
            enabled: !(lp[p.id] && lp[p.id].enabled === false), desk: (lp[p.id] && lp[p.id].desk) || ''
          }))
        };
      }),
      desks: l.desks || [],
      screenMessage: l.screenMessage == null ? '' : l.screenMessage,
      greetings: c.greetings || [],
      greetingLong: c.greetingLong || '',
      callText: c.callText || DEFAULT_CENTRAL.callText,
      nameFormat: c.nameFormat === 'full' ? 'full' : 'short',
      retentionDays: c.retentionDays || 30,
      follow: { enabled: !(c.follow && c.follow.enabled === false) }
    };
  }

  /* Delar upp en sammanslagen konfiguration i central och lokal del inför sparning */
  function splitConfig(m) {
    return {
      central: {
        brands: m.brands.map(b => ({ id: b.id, name: b.name, tagline: b.tagline, prefix: b.prefix, color: b.color,
          purposes: b.purposes.map(p => ({ id: p.id, label: p.label, hint: p.hint })) })),
        greetings: m.greetings, greetingLong: m.greetingLong, callText: m.callText,
        nameFormat: m.nameFormat, retentionDays: m.retentionDays, follow: { enabled: m.follow ? m.follow.enabled !== false : true }
      },
      local: {
        desks: m.desks, screenMessage: m.screenMessage,
        brands: Object.fromEntries(m.brands.map(b => [b.id, { enabled: b.enabled !== false, waitText: b.waitText || '',
          purposes: Object.fromEntries(b.purposes.map(p => [p.id, { enabled: p.enabled !== false, desk: p.desk || '' }])) }]))
      }
    };
  }

  function sanitizeCentral(c) {
    c = c || {};
    const brands = uniqBy(arr(c.brands, 20).map(b => ({
      id: idv(b && b.id), name: str(b && b.name, 60) || 'Namnlös', tagline: str(b && b.tagline, 80),
      prefix: str(b && b.prefix, 2).toUpperCase(), color: COLORS.includes(b && b.color) ? b.color : 'teal',
      purposes: uniqBy(arr(b && b.purposes, 30).map(p => ({ id: idv(p && p.id), label: str(p && p.label, 60) || 'Namnlös', hint: str(p && p.hint, 120) }))
        .filter(p => p.id), 'id')
    })).filter(b => b.id), 'id');
    brands.forEach(b => { if (!b.prefix) b.prefix = b.name.charAt(0).toUpperCase(); });
    return {
      brands,
      greetings: arr(c.greetings, 20).map(g => ({ upTo: clampInt(g && g.upTo, 0, 600), text: str(g && g.text, 120) }))
        .filter(g => g.text).sort((a, b) => a.upTo - b.upTo),
      greetingLong: str(c.greetingLong, 120),
      callText: str(c.callText, 160) || DEFAULT_CENTRAL.callText,
      nameFormat: c.nameFormat === 'full' ? 'full' : 'short',
      retentionDays: clampInt(c.retentionDays || 30, 1, 365),
      follow: { enabled: !(c.follow && c.follow.enabled === false) }
    };
  }

  function sanitizeLocal(l, central) {
    l = l || {};
    const desks = uniqBy(arr(l.desks, 50).map(d => ({
      id: idv(d && d.id), name: str(d && d.name, 40) || 'Disk', location: str(d && d.location, 120),
      dir: DIR_KEYS.includes(d && d.dir) ? d.dir : ''
    })).filter(d => d.id), 'id');
    const deskIds = new Set(desks.map(d => d.id)), lb = l.brands || {};
    const brands = {};
    for (const b of (central || DEFAULT_CENTRAL).brands) {
      const o = lb[b.id] || {}, lp = o.purposes || {}, purposes = {};
      for (const p of b.purposes) {
        const q = lp[p.id] || {};
        purposes[p.id] = { enabled: q.enabled !== false, desk: deskIds.has(q.desk) ? q.desk : '' };
      }
      brands[b.id] = { enabled: o.enabled !== false, waitText: str(o.waitText, 120), purposes };
    }
    return { desks, screenMessage: str(l.screenMessage, 200), brands };
  }

  function shortName(n, format) {
    n = String(n || '').trim();
    if (format === 'full') return n;
    const p = n.split(/\s+/).filter(Boolean);
    return p.length > 1 ? `${p[0]} ${p[p.length - 1][0].toUpperCase()}.` : (p[0] || '');
  }

  function slug(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }

  /* Datum i svensk tid, så att "dagens kö" byts vid midnatt i Sverige */
  function dayStr(t) {
    const d = new Date(t == null ? Date.now() : t);
    try {
      return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    } catch (e) { return d.toISOString().slice(0, 10); }
  }

  root.KK = { COLORS, DIR_KEYS, DEFAULT_CENTRAL, DEFAULT_LOCAL, clone, mergeConfig, splitConfig, sanitizeCentral, sanitizeLocal, shortName, slug, dayStr };
})(typeof globalThis !== 'undefined' ? globalThis : this);
