/* Kökortet – webbsidan. All data och behörighet hanteras av servern (/api); här finns bara visning.
   Delad logik (standardinställningar, sammanslagning av central/lokal konfiguration) finns i shared.js som KK. */
const COLORS = { amber:'Gul', teal:'Teal', red:'Röd', violet:'Magenta', blue:'Blå', green:'Grön' };
/* kvdbils ordmärke – används alltid som bild, aldrig satt med typsnitt */
const WORDMARK = (ink = 'navy', cls = 'wm') => `<img class="${cls}" src="/brand/kvdbil-wordmark-${ink}.svg" alt="kvdbil" width="90" height="28">`;
/* Terminalens funktionsfält: stegnummer och rubrik i ett gult fält till höger, som i kvdbils mallar */
const T_FIELD = { brand:['01.','Välj ärende'], purpose:['01.','Välj ärende'], details:['02.','Dina uppgifter'], done:['03.','Klart'] };
const DIRS = { left:['←','till vänster'], right:['→','till höger'], straight:['↑','rakt fram'], back:['↓','bakåt'] };
const STATUS = { waiting:'Väntar', called:'Ropad', serving:'Betjänas', done:'Klar', noshow:'Kom ej', expired:'Avbruten' };
const ROLE_NAMES = { central:'Central administratör', site:'Anläggningsadministratör', staff:'Personal' };
const VIEWS = ['terminal','skarm','personal','installningar'];

const $ = (s, r=document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2,'0');
const dayStr = KK.dayStr;
const clock = (t=Date.now()) => { const d=new Date(t); return pad(d.getHours())+':'+pad(d.getMinutes()); };
const mins = ms => Math.max(0, Math.floor(ms/60000));
const uid = () => Math.random().toString(36).slice(2,8);
const ls = {
  get(k,d){ try{ const v=localStorage.getItem('kokortet.'+k); return v==null?d:JSON.parse(v); }catch{ return d; } },
  set(k,v){ try{ localStorage.setItem('kokortet.'+k, JSON.stringify(v)); }catch{} },
  del(k){ try{ localStorage.removeItem('kokortet.'+k); }catch{} }
};
const clone = KK.clone;

/* The site comes from the address: /kungalv/#terminal */
const SITE = (location.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
const siteKey = k => SITE + '.' + k;

const S = {
  cfg:null, tickets:[], called:[], stats:{}, loaded:false, view:'personal', day:dayStr(), mode:'public',
  site:null, sites:[], setupNeeded:false,
  term:{ step:'brand', brand:null, purpose:null, result:null, resetAt:0 },
  staff:{ desk:ls.get(siteKey('desk'),''), brands:ls.get(siteKey('brands'),null), tab:'waiting', transferId:null, confirmClear:false },
  draft:null, dirty:false, seen:{}, firstSnap:true, sound:false, audio:null, navOpen:false, followId:null, follow:null, notify:false, alerts:false,
  user:null, token:ls.get('token',''), authReady:false, users:null, ws:null, wsTries:0
};

/* ---------- Server ---------- */
async function api(path, { method='GET', body } = {}){
  const headers = { 'content-type':'application/json' };
  if (S.token) headers.authorization = 'Bearer ' + S.token;
  let res;
  try { res = await fetch('/api/' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw Object.assign(new Error('Ingen anslutning till servern. Kontrollera nätverket och försök igen.'), { status:0 }); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.token && path !== 'login'){ signedOut(); }
  if (!res.ok) throw Object.assign(new Error(data.error || 'Något gick fel. Försök igen.'), { status:res.status });
  return data;
}
const siteApi = (path, opts) => api(`sites/${SITE}/${path}`, opts);

async function write(fn, okMsg){
  try { const r = await fn(); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg); return r || true; }
  catch(e){ toast(e.message || 'Kunde inte spara. Försök igen.'); return false; }
}

/* ---------- Realtid ---------- */
function connectLive(){
  if (!SITE || S.setupNeeded) return;
  try { S.ws?.close(); } catch {}
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const q = S.view === 'folj' && S.followId ? '?follow=' + encodeURIComponent(S.followId) : '';
  const ws = new WebSocket(`${proto}//${location.host}/api/sites/${SITE}/live${q}`);
  S.ws = ws;
  const timer = setTimeout(() => { if (!S.loaded) showBanner('Kön går inte att nå just nu. Visningen uppdateras så fort anslutningen är tillbaka.'); }, 10000);
  ws.onopen = () => { S.wsTries = 0; if (S.token && S.view !== 'folj') ws.send(JSON.stringify({ type:'auth', token:S.token })); };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'snapshot'){ clearTimeout(timer); onSnapshot(m); }
    if (m.type === 'auth' && !m.ok && S.user){ toast('Du har inte behörighet på den här anläggningen.'); }
  };
  ws.onclose = () => {
    clearTimeout(timer);
    if (S.ws !== ws) return;
    S.wsTries += 1;
    if (S.wsTries > 2) showBanner('Anslutningen till kön bröts. Försöker igen…');
    setTimeout(connectLive, Math.min(15000, 1000 * 2 ** Math.min(S.wsTries, 4)));
  };
}
function onSnapshot(m){
  S.loaded = true; showBanner('');
  S.site = m.site; S.stats = m.stats || {}; S.day = m.day || S.day;
  const firstCfg = !S.cfg, cfgChanged = JSON.stringify(m.config) !== JSON.stringify(S.cfg);
  S.cfg = m.config;
  $('#site-name').textContent = m.site?.name || '';
  document.title = 'Kökortet' + (m.site?.name ? ' · ' + m.site.name : '');
  if (m.mode === 'staff'){ S.mode = 'staff'; S.tickets = m.tickets || []; S.called = []; detectCalls(S.tickets); }
  else if (m.mode === 'follow'){ S.mode = 'follow'; S.follow = { ticket:m.ticket, ahead:m.ahead || 0 }; detectCalls(m.ticket ? [m.ticket] : []); }
  else { if (S.mode !== 'staff') S.mode = 'public'; S.called = m.called || []; if (S.mode === 'public') detectCalls(S.called); }
  if (S.view === 'installningar'){ if (cfgChanged && !S.dirty && !S.editUser){ S.draft = null; renderView(); } }
  /* Never redraw the check-in form while a customer is typing in it */
  else if (S.view === 'terminal' && S.term.step === 'details') return;
  else if (firstCfg || cfgChanged) renderView();
  else renderData();
}
function signedOut(){
  S.token = ''; S.user = null; S.mode = 'public'; S.tickets = []; S.users = null;
  ls.del('token');
  $('#logout').hidden = true; $('#who').hidden = true;
  connectLive();
  renderView();
}

/* ---------- Config & ticket helpers ---------- */
const FALLBACK = KK.mergeConfig(KK.DEFAULT_CENTRAL, KK.DEFAULT_LOCAL);
const cfg = () => S.cfg || FALLBACK;
const brandsOn = () => cfg().brands.filter(b => b.enabled !== false);
const brand = id => cfg().brands.find(b => b.id===id);
const desk = id => cfg().desks.find(d => d.id===id);
const purposeOf = t => brand(t.brand)?.purposes.find(p => p.id===t.purpose);
const bvar = b => `--b:var(--c-${b?.color || 'teal'})`;
const num = t => (brand(t.brand)?.prefix || '') + t.seq;
const shortName = n => KK.shortName(n, cfg().nameFormat);
function initials(n){
  const p = String(n||'').trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] || '') + (p.length > 1 ? p[p.length-1][0] : '')).toUpperCase();
}
function greetingFor(min){
  const m = Number.isFinite(min) ? min : 0;
  const g = [...(cfg().greetings || [])].sort((a,b) => a.upTo-b.upTo).find(x => m <= x.upTo);
  return g ? g.text : (cfg().greetingLong || 'Välkommen!');
}
const callGreeting = t => greetingFor(mins((t.calledAt || Date.now()) - t.createdAt));
const trimEnd = s => String(s || '').replace(/[\s!.,?:;–-]+$/, '');
/* The call line: "Välkommen Robert – du har grönt ljus till Disk 2". who: screen (Robert S.), speech, first (Robert) */
function callText(t, who = 'screen', html = false){
  const d = desk(t.desk);
  const namn = who === 'first' ? String(t.name || '').trim().split(/\s+/)[0]
    : who === 'speech' ? shortName(t.name).replace('.', '') : shortName(t.name);
  const v = { halsning:trimEnd(callGreeting(t)), namn, disk:d?.name || 'disken', plats:d?.location || '', foretag:brand(t.brand)?.name || '' };
  const tpl = String(cfg().callText || KK.DEFAULT_CENTRAL.callText);
  const out = tpl.split(/(\{\w+\})/).map(seg => {
    const k = (seg.match(/^\{(\w+)\}$/) || [])[1];
    if (!k || !(k in v)) return html ? esc(seg) : seg;
    if (!html) return v[k];
    return k === 'namn' ? `<span class="cn">${esc(v[k])}</span>` : k === 'disk' ? `<span class="cd">${esc(v[k])}</span>` : esc(v[k]);
  }).join('').replace(/\s+/g, ' ').trim().replace(/ ([–—-]) /g, ' $1 ');
  return out.charAt(0).toUpperCase() + out.slice(1);
}
const greet = () => { const h = new Date().getHours(); return h < 10 ? 'God morgon' : h < 18 ? 'Hej' : 'God kväll'; };
const dirOf = d => DIRS[d?.dir] || null;
/* Full ticket list exists only for signed-in staff; everyone else gets counts and averages from the server */
const waiting = bId => S.tickets.filter(t => t.status==='waiting' && (!bId || t.brand===bId)).sort((a,b) => a.createdAt-b.createdAt);
const stat = bId => (S.stats && S.stats[bId]) || { waiting:0, done:0, avg:6, desks:1, longest:0 };
const queueLen = bId => stat(bId).waiting;
const avgService = bId => stat(bId).avg;
const estWait = (bId, ahead) => Math.round(ahead * stat(bId).avg / (stat(bId).desks || 1));
/* Who is called right now: staff see their full list, the screens get the server's short list */
const calledNow = () => (S.mode === 'staff' ? S.tickets.filter(t => t.status==='called') : S.called).slice().sort((a,b) => b.calledAt-a.calledAt);
const waitLabel = m => m <= 1 ? 'strax' : `ca ${m} min`;

function detectCalls(rows){
  const fresh = [];
  for (const t of rows){
    if (t.status !== 'called') continue;
    const c = t.callCount || 1;
    if (!S.firstSnap && (S.seen[t.id] || 0) < c) fresh.push(t);
    S.seen[t.id] = c;
  }
  S.firstSnap = false;
  if (fresh.length) announce(fresh);
}

/* ---------- Announcements ---------- */
/* A soft two-tone "ding-dong": lower notes, slow attack, quiet */
function chime(){
  if (!S.audio) return;
  const ctx = S.audio, now = ctx.currentTime;
  [[784,0],[523,.4]].forEach(([f,o]) => {
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = 'sine'; osc.frequency.value = f;
    g.gain.setValueAtTime(0, now+o); g.gain.linearRampToValueAtTime(.22, now+o+.06); g.gain.exponentialRampToValueAtTime(.001, now+o+1.5);
    osc.connect(g).connect(ctx.destination); osc.start(now+o); osc.stop(now+o+1.6);
  });
}

/* ---------- Uppläsning: en mjuk, kvinnlig svensk röst ----------
   Rösterna finns i enheten/webbläsaren, så valet sparas per skärm.
   Kvinnliga svenska röster i önskad ordning: Edge (Sofie, Hillevi – naturliga), Apple (Klara, Alva), Windows (Hedvig), Chrome (Google svenska). */
const FEMALE_SV = [/sofie/i, /hillevi/i, /klara/i, /alva/i, /hedvig/i, /google svenska/i];
const MALE_SV = /mattias|oskar|\bmale\b/i;
function svVoices(){ try { return speechSynthesis.getVoices().filter(v => /^sv([-_]|$)/i.test(v.lang)); } catch { return []; } }
function voiceRank(v){ const i = FEMALE_SV.findIndex(re => re.test(v.name)); return i >= 0 ? i : MALE_SV.test(v.name) ? 99 : 50; }
function pickVoice(){
  const vs = svVoices(); if (!vs.length) return null;
  const saved = ls.get('voice', '');
  return vs.find(v => v.name === saved) || [...vs].sort((a,b) => voiceRank(a) - voiceRank(b))[0];
}
const voiceLabel = v => v.name.replace(/^Microsoft\s+/, '').replace(/\s*-\s*Swedish.*$/i, '').replace(/Online \(Natural\)/i, '(naturlig)').trim();
function speak(text){
  try {
    const u = new SpeechSynthesisUtterance(text), v = pickVoice();
    if (v){ u.voice = v; u.lang = v.lang; } else u.lang = 'sv-SE';
    u.rate = .88; u.pitch = 1; u.volume = .9;   /* lugnt tempo = mjukare intryck */
    speechSynthesis.speak(u);
  } catch {}
}
const voiceSample = () => callText({ name:'Anna Svensson', brand:brandsOn()[0]?.id, desk:(cfg().desks[1] || cfg().desks[0])?.id, createdAt:Date.now(), calledAt:Date.now() }, 'speech');
function renderTvSound(){
  const el = $('#tv-sound'); if (!el) return;
  if (!S.sound){ el.innerHTML = '<button class="btn" data-act="sound">Slå på ljud och uppläsning</button>'; return; }
  const vs = svVoices().sort((a,b) => voiceRank(a) - voiceRank(b)), cur = pickVoice();
  const knownFemale = vs.some(v => voiceRank(v) < FEMALE_SV.length);
  el.innerHTML = vs.length
    ? `<label class="tv-voice">Röst <select class="input" id="tv-voice">${vs.map(v => `<option value="${esc(v.name)}" ${v === cur ? 'selected' : ''}>${esc(voiceLabel(v))}</option>`).join('')}</select></label>
       <button class="btn" data-act="voice-test">Testa</button>
       ${knownFemale ? '' : '<span class="tv-hint">Ingen kvinnlig svensk röst hittades här. Öppna skärmen i Microsoft Edge för rösten Sofie.</span>'}`
    : '<span>Ljud på</span><span class="tv-hint">Den här enheten saknar svensk röst. Öppna skärmen i Microsoft Edge för rösten Sofie.</span>';
}
try { speechSynthesis.addEventListener('voiceschanged', () => { if (S.view === 'skarm') renderTvSound(); }); } catch {}

function announce(list){
  S.justCalled = new Set(list.map(t => t.id));
  if (S.view === 'skarm' && S.sound){
    chime();
    const say = list.map(t => callText(t, 'speech')).join('. ');
    setTimeout(() => speak(say), 1300);
  }
  if (S.view === 'terminal') $('#t-ticker')?.classList.add('flash');
  if (S.view === 'folj' && S.follow?.ticket){
    /* the phone only ever receives its own ticket, so a call in this list is always for this customer */
    const mine = list.find(t => t.id === S.follow.ticket.id);
    if (mine) notifyFollow(mine);
  }
}

/* ---------- Routing & shell ---------- */
function route(){
  const h = location.hash.slice(1);
  const m = h.match(/^folj=(.+)$/);
  if (m) S.followId = decodeURIComponent(m[1]);
  const v = m ? 'folj' : (VIEWS.includes(h) ? h : 'personal');
  const followChanged = (S.view === 'folj') !== (v === 'folj');
  if (S.view === 'installningar' && v !== 'installningar') S.draft = null;
  S.view = v;
  document.body.classList.toggle('kiosk', v==='terminal' || v==='skarm');
  document.body.classList.toggle('customer', v==='folj');
  document.body.classList.remove('nav-open'); S.navOpen = false;
  document.querySelectorAll('#tabs-nav a').forEach(a => a.dataset.v===v ? a.setAttribute('aria-current','page') : a.removeAttribute('aria-current'));
  if (v==='terminal' || v==='skarm' || v==='folj'){ try { navigator.wakeLock?.request('screen').catch(()=>{}); } catch {} }
  renderView();
  if (followChanged && S.authReady){ S.seen = {}; S.firstSnap = true; S.loaded = false; connectLive(); }
}
function showBanner(msg){ const b = $('#banner'); b.textContent = msg; b.hidden = !msg; }
let toastT;
function toast(msg){ const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200); }

const needsLogin = () => !S.user && (S.view==='personal' || S.view==='installningar');
const hasStaffAccess = () => !!S.user && (S.user.role === 'central' || (S.user.sites || []).includes(SITE));
const isSiteAdmin = () => !!S.user && (S.user.role === 'central' || (S.user.role === 'site' && (S.user.sites || []).includes(SITE)));
const isCentralAdmin = () => S.user?.role === 'central';
function loginHTML(){
  if (!S.authReady) return `<div class="login"><div class="empty">Ansluter…</div></div>`;
  return `<div class="login"><form id="lg-form">
    <h2>Personal</h2>
    <p class="muted" style="margin:0">Logga in med ditt konto för att ropa kunder och ändra inställningar.</p>
    <div class="field"><label class="label" for="lg-email">E-post</label><input class="input" id="lg-email" name="username" type="email" autocomplete="username" required value="${esc(ls.get('lastEmail',''))}"></div>
    <div class="field"><label class="label" for="lg-pw">Lösenord</label><input class="input" id="lg-pw" name="password" type="password" autocomplete="current-password" required></div>
    <button class="btn primary" type="submit">Logga in</button>
    <span class="muted" style="font-size:13px">Du förblir inloggad på den här enheten tills du loggar ut. Logga inte in på terminalen eller väntrumsskärmen.</span>
  </form></div>`;
}
function setupHTML(){
  return `<div class="login"><form id="setup-form">
    <h2>Välkommen till Kökortet</h2>
    <p class="muted" style="margin:0">Skapa den första administratören. Startkoden är den hemliga kod som lades in i Cloudflare (SETUP_CODE).</p>
    <div class="field"><label class="label" for="su-code">Startkod</label><input class="input" id="su-code" type="password" autocomplete="off" required></div>
    <div class="field"><label class="label" for="su-name">Ditt namn</label><input class="input" id="su-name" autocomplete="name" required maxlength="60"></div>
    <div class="field"><label class="label" for="su-email">Din e-post</label><input class="input" id="su-email" type="email" autocomplete="username" required></div>
    <div class="field"><label class="label" for="su-pw">Välj lösenord <span class="muted">(minst 10 tecken)</span></label><input class="input" id="su-pw" type="password" autocomplete="new-password" minlength="10" required></div>
    <button class="btn primary" type="submit">Skapa administratör</button>
    <span class="muted" style="font-size:13px">Anläggningarna Kungälv, Svedala, Linköping och Brännbacken skapas automatiskt.</span>
  </form></div>`;
}
function pickerHTML(){
  return `<div class="picker">
    <h1>Välj anläggning</h1>
    <p class="muted" style="margin:0">Varje anläggning har en egen kö, egna diskar och egna länkar till terminal, väntrumsskärm och personal.</p>
    <div class="site-list">${S.sites.length ? S.sites.map(s => `<a href="/${esc(s.id)}/#personal"><b>${esc(s.name)}</b><span class="muted">/${esc(s.id)}/</span></a>`).join('')
      : '<div class="empty">Inga anläggningar ännu.</div>'}</div>
  </div>`;
}
function renderView(){
  const v = $('#view');
  if (S.setupNeeded){ document.body.classList.remove('kiosk'); v.innerHTML = setupHTML(); return; }
  if (!SITE){ document.body.classList.remove('kiosk','customer'); v.innerHTML = pickerHTML(); return; }
  if (needsLogin()){ v.innerHTML = loginHTML(); setTimeout(() => $(ls.get('lastEmail','') ? '#lg-pw' : '#lg-email')?.focus(), 50); return; }
  if ((S.view==='personal' || S.view==='installningar') && !hasStaffAccess()){
    v.innerHTML = `<div class="login"><div class="empty">Ditt konto har inte behörighet på den här anläggningen. <a href="/">Välj en annan anläggning</a>.</div></div>`; return;
  }
  if (S.view==='terminal') v.innerHTML = terminalHTML();
  else if (S.view==='skarm'){
    /* The sound/voice controls live outside the part that re-renders, so an open voice list is not closed by queue updates */
    v.innerHTML = `<div class="tv tv-wrap" id="tv"><div id="tv-main"></div><div class="tv-msg"><span id="tv-msg-text"></span><span id="tv-sound"></span></div></div>`;
    renderTvSound();
  }
  else if (S.view==='folj') v.innerHTML = `<div class="follow" id="follow"></div>`;
  else if (S.view==='personal') v.innerHTML = staffHTML();
  else if (!isSiteAdmin()) v.innerHTML = `<div class="login"><div class="empty">Inställningarna kan bara ändras av en administratör. Fråga din anläggningsadministratör om du behöver ändra något.</div></div>`;
  else { if (!S.draft){ S.draft = clone(cfg()); S.dirty = false; } v.innerHTML = settingsHTML(); if (!S.users) loadUsers(); }
  renderData();
  if (S.view==='terminal' && S.term.step==='done') renderQr();
  /* Focus right away – a delayed focus could steal the cursor from a field the customer already tapped */
  if (S.view==='terminal' && S.term.step==='details') $('#t-name')?.focus();
}
function renderData(){
  if (S.view==='terminal') updateTerminal();
  else if (S.view==='skarm') updateTv();
  else if (S.view==='folj') updateFollow();
  else if (S.view==='personal') updateStaff();
}

/* ---------- Terminal ---------- */
function terminalHTML(){
  const T = S.term, b = brand(T.brand), p = b?.purposes.find(x => x.id===T.purpose);
  const top = `<div class="t-top"><span class="t-hello">Välkommen in</span><div class="clock num" data-clock></div></div>`;
  const [fn, fh] = T_FIELD[T.step] || T_FIELD.brand, photo = T.step === 'brand' || T.step === 'done';
  const field = `<aside class="t-field" aria-label="Steg ${fn} ${fh}"><span class="field-number">${fn}</span><span class="field-heading">${fh}</span>
    ${photo ? '<img class="field-photo" src="/brand/hand-car-key-suit.webp" alt="" width="750" height="1000">' : ''}${WORDMARK('navy', 'wm field-mark')}</aside>`;
  let body = '';
  if (T.step==='brand'){
    body = `<div class="t-head"><h1>Vad gäller ditt besök?</h1><p>Tryck på det som passar dig. Du behöver ingen papperslapp, vi ropar ditt namn.</p></div>
    <div class="t-brands">${brandsOn().map(b => `
      <button class="t-brand" data-act="t-brand" data-id="${b.id}" style="${bvar(b)}">
        <span class="t-mark">${esc(b.prefix)}</span>
        <span class="t-brand-name">${esc(b.name)}</span>
        <span class="t-brand-tag">${esc(b.tagline)}</span>
        <span class="t-brand-list">${b.purposes.filter(p => p.enabled).map(p => esc(p.label)).join(' · ')}</span>
        <span class="t-brand-q" data-q="${b.id}"></span>
      </button>`).join('')}</div>`;
  } else if (T.step==='purpose'){
    body = `<button class="btn t-back" data-act="t-back">← Tillbaka</button>
    <div class="t-head"><h1>${esc(b.name)}: vad ska du göra?</h1></div>
    <div class="t-purposes">${b.purposes.filter(p => p.enabled).map(p => `
      <button class="t-purpose" data-act="t-purpose" data-id="${p.id}" style="${bvar(b)}"><b>${esc(p.label)}</b><span>${esc(p.hint||'')}</span></button>`).join('')}</div>`;
  } else if (T.step==='details'){
    body = `<button class="btn t-back" data-act="t-back">← Tillbaka</button>
    <div class="t-crumb"><span class="pill" style="${bvar(b)}"><span class="dot"></span>${esc(b.name)}</span><b>${esc(p?.label||'')}</b></div>
    <div class="t-head"><h1>Vad heter du?</h1><p>Ditt namn visas på skärmen när det är din tur.</p></div>
    <form class="t-form" id="t-form" autocomplete="off">
      <div class="field"><label for="t-name">För- och efternamn</label>
        <input class="input" id="t-name" maxlength="40" required autocapitalize="words" enterkeyhint="next" placeholder="Anna Andersson"></div>
      <div class="field"><label for="t-phone">Mobilnummer</label>
        <input class="input num" id="t-phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="16" enterkeyhint="next" placeholder="070-123 45 67">
        <span class="muted" style="font-size:16px">Vi använder numret om vi behöver nå dig under besöket. Numret raderas när besöket är klart.</span></div>
      <div class="field"><label for="t-reg">Registreringsnummer <span class="muted">(valfritt)</span></label>
        <input class="input num" id="t-reg" maxlength="7" autocapitalize="characters" enterkeyhint="done" placeholder="ABC 123" style="text-transform:uppercase;letter-spacing:.08em"></div>
      <button class="btn primary" type="submit">Ställ mig i kö</button>
      <p class="privacy">Namn och nummer används bara för det här besöket. Skärmen visar bara förnamn och initial. Uppgifterna raderas automatiskt efter ${cfg().retentionDays || 30} dagar.</p>
    </form>`;
  } else if (T.step==='done'){
    const t = T.result, tb = brand(t.brand), tp = purposeOf(t);
    const ahead = t.ahead || 0;
    body = `<div class="t-head"><h1>Klart, ${esc(t.name.split(' ')[0])}! Du står i kö.</h1></div>
    <div class="t-done">
      <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
      <div class="t-ticket" style="${bvar(tb)};flex:1">
        <span class="av av-xl">${esc(initials(t.name))}</span>
        <span class="who">${esc(shortName(t.name))}</span>
        <span class="label">Så här visas du på skärmen</span>
        <span class="pill" style="${bvar(tb)};font-size:15px"><span class="dot"></span>${esc(tb.name)} · ${esc(tp?.label||'')}</span>
      </div>
      ${followOn() ? `<div class="t-qr-card">
        <div class="qr" id="t-qr" role="img" aria-label="QR-kod: följ ditt ärende i mobilen"></div>
        <div><b>Följ ditt ärende i mobilen</b><span class="muted">Skanna koden med mobilkameran – se din plats i kön och få en notis när det är din tur.</span></div>
      </div>` : ''}
      </div>
      <div class="t-steps">
        <div class="t-step"><i>1</i><div><b>${esc(tb.waitText || 'Ta plats i väntrummet')}</b><span class="muted">${ahead===0 ? 'Du är först i kön.' : `${ahead} före dig, ${waitLabel(estWait(t.brand, ahead))}.`}</span></div></div>
        <div class="t-step"><i>2</i><div><b>Håll utkik på skärmen${followOn() ? ' eller i mobilen' : ''}</b><span class="muted">${followOn() ? 'Ditt namn visas med en ljudsignal, och mobilen plingar om du har skannat koden.' : 'Ditt namn visas med en ljudsignal när det är din tur.'}</span></div></div>
        <div class="t-step"><i>3</i><div><b>Gå dit skärmen visar</b><span class="muted">${tp?.desk && desk(tp.desk) ? `Troligen ${esc(desk(tp.desk).name)}: ${esc(desk(tp.desk).location)}.` : 'Skärmen visar vilken disk du ska gå till.'}</span></div></div>
        <div class="t-reset"><button class="btn" data-act="t-reset">Klar</button><span id="t-count"></span></div>
      </div>
    </div>`;
  }
  return `<div class="t-shell"><div class="term">${top}${body}<div class="t-ticker" id="t-ticker"></div></div>${field}</div>`;
}
function updateTerminal(){
  document.querySelectorAll('[data-q]').forEach(el => {
    const n = queueLen(el.dataset.q);
    el.innerHTML = n ? `<span class="dot" style="${bvar(brand(el.dataset.q))}"></span>${n} väntar · ${waitLabel(estWait(el.dataset.q, n))}` : `<span class="dot" style="--b:var(--ok)"></span>Ingen kö just nu`;
  });
  const called = calledNow().slice(0,4);
  const tk = $('#t-ticker');
  if (tk) tk.innerHTML = `<span class="label">Välkommen fram</span><div class="t-ticker-items">${called.length ? called.map(t => `<span><b>${esc(shortName(t.name))}</b>${dirOf(desk(t.desk))?.[0] || '→'} ${esc(desk(t.desk)?.name || '')}</span>`).join('') : '<span>Vi ropar snart nästa kund</span>'}</div>`;
}
function termGo(step){ S.term.step = step; S.term.resetAt = Date.now() + (step==='done' ? 45000 : 60000); renderView(); }
async function termSubmit(e){
  e.preventDefault();
  const name = $('#t-name').value.trim().replace(/\s+/g,' ');
  if (name.length < 2){ toast('Skriv ditt namn så vi kan ropa dig.'); $('#t-name').focus(); return; }
  const reg = $('#t-reg').value.toUpperCase().replace(/[^A-ZÅÄÖ0-9]/g,'').slice(0,6);
  const phone = normPhone($('#t-phone').value);
  if (!phone){ toast(phone === '' ? 'Skriv ditt mobilnummer, till exempel 070-123 45 67.' : 'Kontrollera mobilnumret, till exempel 070-123 45 67.'); $('#t-phone').focus(); return; }
  const btn = e.submitter; if (btn) btn.disabled = true;
  const r = await write(() => siteApi('checkin', { method:'POST', body:{ brand:S.term.brand, purpose:S.term.purpose, name, phone, regnr:reg } }));
  if (r){ S.term.result = { ...r.ticket, name, ahead:r.ahead }; termGo('done'); }
  else if (btn) btn.disabled = false;
}
function termReset(){ S.term = { step:'brand', brand:null, purpose:null, result:null, resetAt:0 }; renderView(); }

/* ---------- Personal ---------- */
function myBrands(){ return S.staff.brands || cfg().brands.map(b => b.id); }
function staffHTML(){
  const d = cfg().desks;
  return `<div class="staff">
    <aside class="console">
      <div class="panel">
        <div class="field"><label class="label" for="s-desk">Min station</label>
          <select class="input" id="s-desk"><option value="">Välj station…</option>${d.map(x => `<option value="${x.id}" ${x.id===S.staff.desk?'selected':''}>${esc(x.name)}</option>`).join('')}</select></div>
        <div class="field"><span class="label">Jag tar kunder från</span>
          <div class="chips" id="s-chips">${cfg().brands.map(b => `<button class="chip" data-act="s-chip" data-id="${b.id}" style="${bvar(b)}" aria-pressed="${myBrands().includes(b.id)}"><span class="dot"></span>${esc(b.name)}</button>`).join('')}</div></div>
        <button class="btn primary call-next" data-act="call-next" id="s-callnext">Ropa nästa kund</button>
      </div>
      <div id="s-current"></div>
      <details class="panel" id="s-add-wrap">
        <summary>Lägg till kund manuellt</summary>
        <form id="s-add" class="field" style="gap:10px" autocomplete="off">
          <input class="input" id="a-name" placeholder="Namn" maxlength="40" required>
          <div class="grid2">
            <select class="input" id="a-brand">${cfg().brands.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select>
            <select class="input" id="a-purpose"></select>
          </div>
          <input class="input" id="a-phone" type="tel" inputmode="tel" placeholder="Mobilnummer (valfritt)" maxlength="16">
          <input class="input" id="a-reg" placeholder="Reg.nr (valfritt)" maxlength="7" style="text-transform:uppercase">
          <button class="btn" type="submit">Lägg i kön</button>
        </form>
      </details>
    </aside>
    <section class="board">
      <div class="stats" id="s-stats"></div>
      <div class="seg" role="tablist" id="s-tabs"></div>
      <div class="list" id="s-list"></div>
    </section>
  </div>`;
}
function fillPurposeSelect(){
  const b = brand($('#a-brand')?.value); const sel = $('#a-purpose');
  if (b && sel) sel.innerHTML = b.purposes.filter(p => p.enabled).map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
}
function updateStaff(){
  if (!$('#s-stats')) return;
  if ($('#a-purpose') && !$('#a-purpose').options.length) fillPurposeSelect();
  const now = Date.now();
  $('#s-stats').innerHTML = cfg().brands.map(b => {
    const w = waiting(b.id), longest = w.length ? mins(now - w[0].createdAt) : 0;
    const served = S.tickets.filter(t => t.brand===b.id && t.status==='done').length;
    return `<div class="stat" style="${bvar(b)}"><div class="head"><span class="dot"></span>${esc(b.name)}</div>
      <div class="v num">${w.length}<span class="s"> väntar</span></div>
      <div class="s">${w.length ? `Längst ${longest} min · ` : ''}${served} klara idag · snitt ${Math.round(avgService(b.id))} min</div></div>`;
  }).join('');

  const mine = S.tickets.filter(t => t.desk===S.staff.desk && S.staff.desk && ['called','serving'].includes(t.status)).sort((a,b) => b.calledAt-a.calledAt);
  $('#s-current').innerHTML = !S.staff.desk ? `<div class="empty">Välj din station för att börja ropa kunder.</div>`
    : mine.length ? mine.map(t => currentCard(t)).join('') : `<div class="empty">Ingen kund vid ${esc(desk(S.staff.desk)?.name||'')} just nu.</div>`;
  $('#s-callnext').disabled = !S.staff.desk;

  const groups = { waiting:['waiting'], active:['called','serving'], done:['done','noshow'] };
  const counts = Object.fromEntries(Object.entries(groups).map(([k,v]) => [k, S.tickets.filter(t => v.includes(t.status)).length]));
  const tabs = { waiting:'Väntar', active:'Ropade & pågår', done:'Klara' };
  $('#s-tabs').innerHTML = Object.entries(tabs).map(([k,l]) => `<button role="tab" aria-selected="${S.staff.tab===k}" data-act="s-tab" data-id="${k}">${l}<span class="c">${counts[k]}</span></button>`).join('');

  let rows = S.tickets.filter(t => groups[S.staff.tab].includes(t.status));
  rows.sort(S.staff.tab==='waiting' ? (a,b) => a.createdAt-b.createdAt : (a,b) => (b.doneAt||b.calledAt||0)-(a.doneAt||a.calledAt||0));
  $('#s-list').innerHTML = !S.loaded && !rows.length ? `<div class="empty">Hämtar kön…</div>`
    : rows.length ? rows.map(rowHTML).join('')
    : `<div class="empty">${S.staff.tab==='waiting' ? 'Ingen väntar. Kunder som checkar in på terminalen dyker upp här direkt.' : S.staff.tab==='active' ? 'Ingen är ropad just nu.' : 'Inga avslutade besök idag än.'}</div>`;
}
function currentCard(t){
  const b = brand(t.brand), p = purposeOf(t);
  return `<div class="current" style="${bvar(b)}">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span class="av">${esc(initials(t.name))}</span><span class="pill" style="${t.status==='serving'?'--b:var(--ok)':bvar(b)}">${STATUS[t.status]}${t.status==='called' && (t.callCount||1)>1 ? ` ×${t.callCount}`:''}</span></div>
    <div class="nm">${esc(t.name)}</div>
    <div class="muted">${esc(b?.name||'')} · ${esc(p?.label||'')}${t.regnr ? ` · <span class="reg">${esc(t.regnr)}</span>`:''}${t.phone ? ` · <span style="white-space:nowrap">${fmtPhone(t.phone)}</span>` : ''}</div>
    <div class="muted" style="font-size:14px">Väntade ${mins((t.calledAt||Date.now()) - t.createdAt)} min · ropad ${clock(t.calledAt)}</div>
    ${t.status==='called' ? `<div class="muted" style="font-size:14px">På skärmen: ”${esc(callText(t))}”</div>` : ''}
    <div class="btn-row">${t.status==='called'
      ? `<button class="btn primary sm" data-act="serve" data-id="${t.id}">Kunden är här</button><button class="btn sm" data-act="recall" data-id="${t.id}">Ropa igen</button><button class="btn sm danger" data-act="noshow" data-id="${t.id}">Kom ej</button>`
      : `<button class="btn primary sm" data-act="done" data-id="${t.id}">Avsluta besök</button>`}
      <button class="btn sm ghost" data-act="transfer" data-id="${t.id}">Flytta…</button></div>
    ${S.staff.transferId===t.id ? transferHTML(t) : ''}
  </div>`;
}
function rowHTML(t){
  const b = brand(t.brand), p = purposeOf(t), w = mins((t.status==='waiting' ? Date.now() : (t.calledAt||Date.now())) - t.createdAt);
  let acts = '';
  if (t.status==='waiting') acts = `<button class="btn sm primary" data-act="call" data-id="${t.id}" ${S.staff.desk?'':'disabled'}>Ropa</button><button class="btn sm ghost" data-act="transfer" data-id="${t.id}">Flytta</button>`;
  else if (t.status==='called') acts = `<button class="btn sm" data-act="recall" data-id="${t.id}">Ropa igen</button><button class="btn sm" data-act="serve" data-id="${t.id}">Här</button>`;
  else if (t.status==='serving') acts = `<button class="btn sm" data-act="done" data-id="${t.id}">Avsluta</button>`;
  else if (t.status==='noshow') acts = `<button class="btn sm" data-act="requeue" data-id="${t.id}">Tillbaka i kö</button>`;
  return `<div class="row" style="${bvar(b)}">
    <span class="av">${esc(initials(t.name))}</span>
    <div style="min-width:0"><div class="nm">${esc(t.name)} ${t.demo?'<span class="pill">Exempel</span>':''}</div><div class="sub">${t.regnr?`<span class="reg">${esc(t.regnr)}</span> `:''}${t.source==='staff'?'Manuellt tillagd':'Terminal'} ${clock(t.createdAt)}</div></div>
    <div class="pcol" style="min-width:0"><div>${esc(p?.label||t.purpose)}</div><div class="sub">${t.status==='waiting' ? esc(b?.name||'') : `${STATUS[t.status]}${t.desk?' · '+esc(desk(t.desk)?.name||''):''}`}</div></div>
    <span class="wait ${t.status==='waiting' && w>=20?'long':''}">${w} min</span>
    <div class="acts">${acts}</div>
    ${S.staff.transferId===t.id ? transferHTML(t) : ''}
  </div>`;
}
function transferHTML(t){
  return `<div class="transfer"><select class="input" id="tr-${t.id}">${cfg().brands.map(b => `<optgroup label="${esc(b.name)}">${b.purposes.filter(p => p.enabled).map(p => `<option value="${b.id}|${p.id}" ${b.id===t.brand&&p.id===t.purpose?'selected':''}>${esc(b.name)}: ${esc(p.label)}</option>`).join('')}</optgroup>`).join('')}</select>
    <button class="btn sm primary" data-act="transfer-go" data-id="${t.id}">Flytta och behåll plats</button><button class="btn sm ghost" data-act="transfer" data-id="${t.id}">Avbryt</button></div>`;
}
const T = id => S.tickets.find(t => t.id===id);
/* All status changes go through the server, which checks that nobody else got there first */
const ticketAction = (id, action, body = {}) => siteApi(`tickets/${encodeURIComponent(id)}/${action}`, { method:'POST', body });
async function callTicket(t, again = false){
  if (!S.staff.desk){ toast('Välj din station först.'); return; }
  await write(() => ticketAction(t.id, again ? 'recall' : 'call', { desk:S.staff.desk }), `${shortName(t.name)} ropas till ${desk(S.staff.desk)?.name}`);
}

/* ---------- Telefonnummer ---------- */
function normPhone(v){
  let d = String(v||'').trim();
  const plus = d.startsWith('+');
  d = d.replace(/\D/g,'');
  if (!d) return '';
  if (!plus){ if (d.startsWith('00')) d = d.slice(2); else if (d.startsWith('0')) d = '46' + d.slice(1); }
  return d.length >= 10 && d.length <= 15 ? d : null;
}
function fmtPhone(p){
  const d = String(p||'');
  if (!d.startsWith('46')) return '+' + d;
  const l = '0' + d.slice(2);
  return l.length === 10 ? `${l.slice(0,3)}-${l.slice(3,6)} ${l.slice(6,8)} ${l.slice(8)}` : l;
}

/* ---------- Följ i mobilen ---------- */
const followOn = () => cfg().follow?.enabled !== false;
/* The follow link carries a long random code, not the ticket id, so nobody can guess someone else's link */
const followLink = fid => `${location.origin}/${SITE}/#folj=${encodeURIComponent(fid)}`;
function renderQr(){
  const el = $('#t-qr'); if (!el || !S.term.result) return;
  const url = followLink(S.term.result.fid);
  el.innerHTML = '';
  if (window.QRCode) new QRCode(el, { text:url, width:124, height:124, colorDark:'#16212C', colorLight:'#ffffff', correctLevel:QRCode.CorrectLevel.M });
  else el.innerHTML = `<span class="muted" style="font-size:11px;overflow-wrap:anywhere;max-width:140px;display:block">${esc(url)}</span>`;
}
function notifyFollow(t){
  try { navigator.vibrate?.([300,150,300,150,300]); } catch {}
  chime();
  if (S.notify && window.Notification?.permission === 'granted'){
    try {
      const d = desk(t.desk);
      new Notification('Grönt ljus – det är din tur!', { body:`${callText(t, 'first')}${d?.location ? '. ' + d.location : ''}.`, tag:'kokortet-'+t.id, renotify:true });
    } catch {}
  }
}
function updateFollow(){
  const el = $('#follow'); if (!el) return;
  const head = `<div class="f-top"><div class="logo">${WORDMARK()}<span class="sep"></span><span class="product">Kökortet</span></div><span class="clock num" data-clock></span></div>`;
  const t = S.follow?.ticket;
  if (!t){
    el.innerHTML = head + `<div class="empty" style="padding:44px 20px">${
      S.loaded ? 'Vi hittar inte ditt ärende. Det kan vara avslutat eller gälla en annan dag – fråga gärna personalen.'
      : 'Hämtar ditt ärende… Om det dröjer: håll utkik på skärmen i väntrummet, där visas ditt namn när det är din tur.'}</div>`;
    tickClock(); return;
  }
  const b = brand(t.brand), p = purposeOf(t), d = desk(t.desk), dr = dirOf(d);
  const ahead = S.follow.ahead || 0;
  let card;
  if (t.status === 'waiting'){
    card = `<div class="f-card waiting"><span class="label">Din plats i kön</span>
      ${ahead === 0 ? `<span class="f-big">Näst på tur</span><span class="muted">Du ropas som nästa kund.</span>`
        : `<span class="f-pos num">${ahead}</span><span class="muted">${ahead === 1 ? '1 kund' : ahead + ' kunder'} före dig · ${waitLabel(estWait(t.brand, ahead))}</span>`}
      <span class="muted">${esc(b?.waitText || 'Ta plats i väntrummet')}. Den här sidan säger till när det är din tur.</span></div>`;
  } else if (t.status === 'called'){
    card = `<div class="f-card called"><span class="label gl-label"><span class="gl"></span>Det är din tur${(t.callCount||1) > 1 ? ' – vi ropar igen' : ''}!</span>
      <span class="f-big f-call">${callText(t, 'first', true)}</span>
      ${d?.location ? `<span class="muted" style="font-size:18px">${esc(d.location)}</span>` : ''}
      ${dr ? `<span class="dir" role="img" aria-label="${dr[1]}">${dr[0]}</span>` : ''}</div>`;
  } else if (t.status === 'serving'){
    card = `<div class="f-card"><span class="label">Pågår</span><span class="f-big">Du betjänas nu</span><span class="muted">${d ? `Vid ${esc(d.name)}. ` : ''}Trevligt besök!</span></div>`;
  } else if (t.status === 'noshow'){
    card = `<div class="f-card noshow"><span class="label">Vi ropade dig</span><span class="f-big">Vi fick inget svar</span><span class="muted">Gå fram till disken eller säg till personalen, så hjälper vi dig direkt.</span></div>`;
  } else {
    card = `<div class="f-card"><span class="f-big">Tack för besöket!</span><span class="muted">Ditt ärende är avslutat. Välkommen åter.</span></div>`;
  }
  const notis = !['waiting','called'].includes(t.status) ? ''
    : S.alerts
      ? `<div class="f-note"><span class="dot" style="--b:var(--ok)"></span>${S.notify ? 'Notis, ljud och vibration är på' : 'Ljud och vibration är på'} – håll sidan öppen</div>`
      : `<button class="btn primary" data-act="f-notify" style="min-height:54px;font-size:17px">Säg till mig när det är min tur</button>
         <span class="muted" style="font-size:13px;text-align:center">Mobilen plingar och vibrerar när du ropas, så länge sidan är öppen.</span>`;
  el.innerHTML = head + `
    <div class="f-card f-id" style="${bvar(b)}">
      <span class="av">${esc(initials(t.name))}</span>
      <div style="min-width:0"><div style="font-weight:700">${esc(t.name)}</div>
      <div class="muted" style="font-size:14px">${esc(b?.name || '')} · ${esc(p?.label || t.purpose)}${t.regnr ? ` · <span class="reg">${esc(t.regnr)}</span>` : ''}</div></div>
    </div>
    ${card}${notis}
    <span class="muted" style="font-size:13px;text-align:center">Sidan uppdateras automatiskt · incheckad ${clock(t.createdAt)}</span>`;
  tickClock();
}

/* ---------- Skärm ---------- */
function updateTv(){
  const el = $('#tv-main'); if (!el) return;
  $('#tv-msg-text').textContent = cfg().screenMessage || '';
  const called = calledNow().slice(0,6);
  const fresh = S.justCalled || new Set(); S.justCalled = null;
  el.innerHTML = `
    <div class="tv-head"><div><span class="label">${greet()} · ${esc(new Date().toLocaleDateString('sv-SE',{weekday:'long',day:'numeric',month:'long'}))}</span><h1>Välkommen fram</h1></div><span class="clock num" data-clock></span></div>
    <div class="tv-calls">${called.length ? called.map(t => { const d = desk(t.desk), b = brand(t.brand), p = purposeOf(t), dr = dirOf(d); return `
      <div class="tv-call ${fresh.has(t.id)?'new':''}" style="${bvar(b)}">
        <span class="av">${esc(initials(t.name))}</span>
        <span class="nm"><span class="hi"><span class="gl"></span>${esc(b?.name || '')}${p ? ' · ' + esc(p.label) : ''}</span>${callText(t, 'screen', true)}</span>
        <span class="to">${d?.location ? `<span>${esc(d.location)}</span>` : ''}${dr ? `<span class="dir" role="img" aria-label="${dr[1]}">${dr[0]}</span>` : ''}</span>
      </div>`; }).join('') : `<div class="tv-empty">Vi ropar snart nästa kund.<br>Ta gärna en kopp kaffe så länge.</div>`}</div>
    <div class="tv-side"><span class="field-number">Kö</span><span class="field-heading">Just nu</span>${brandsOn().map(b => { const n = queueLen(b.id); return `
      <div class="tv-q" style="${bvar(b)}"><div class="top"><h3>${esc(b.name)}</h3><span class="v num">${n}</span></div>
      <span class="s">${esc(b.tagline)} · ${n ? `${n} i kö, ${waitLabel(estWait(b.id, n))}` : 'ingen kö'}</span></div>`; }).join('')}${WORDMARK('navy', 'wm field-mark')}</div>`;
  tickClock();
}

/* ---------- Inställningar ---------- */
function settingsHTML(){
  const c = S.draft, base = `${location.origin}/${SITE}/`, ro = isCentralAdmin() ? '' : 'disabled';
  const ALL = '<span class="scope">Alla anläggningar</span>', HERE = `<span class="scope">${esc(S.site?.name || 'Den här anläggningen')}</span>`;
  const deskOpts = sel => `<option value="">Ingen förvald</option>` + c.desks.map(d => `<option value="${d.id}" ${d.id===sel?'selected':''}>${esc(d.name)}</option>`).join('');
  return `<div class="settings">
    <div><h2>Inställningar · ${esc(S.site?.name || '')}</h2><p class="set-intro">Ändringar gäller direkt när du sparar. Fält märkta <b>Alla anläggningar</b> är gemensamma och ändras bara av central administratör${isCentralAdmin() ? '' : ' (de är låsta för dig)'}. Diskar, vilka tjänster som är på och skärmtexten gäller bara den här anläggningen.</p></div>
    <div class="links">${[['terminal','Terminal','För iPaden vid entrén'],['skarm','Väntrumsskärm','För TV:n i loungen'],['personal','Personal','För disk och verkstad']].map(([h,t,s]) => `<a href="${base}#${h}"><b>${t}</b><span class="muted">${s}</span><br><span class="muted" style="font-size:12px;overflow-wrap:anywhere">${esc(base)}#${h}</span></a>`).join('')}</div>
    ${c.brands.map((b,i) => `
    <section class="brand-card" style="${bvar(b)}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><h2>${esc(b.name)}</h2>
        <label style="display:flex;gap:10px;align-items:center;font-weight:600">Visas på terminalen här <span class="toggle"><input type="checkbox" data-k="brands.${i}.enabled" ${b.enabled!==false?'checked':''}><span></span></span></label></div>
      <div>${ALL}</div>
      <div class="f-grid">
        <div class="field"><label class="label" for="b${i}n">Namn</label><input class="input" id="b${i}n" data-k="brands.${i}.name" ${ro} value="${esc(b.name)}"></div>
        <div class="field"><label class="label" for="b${i}t">Undertext</label><input class="input" id="b${i}t" data-k="brands.${i}.tagline" ${ro} value="${esc(b.tagline)}"></div>
        <div class="field"><label class="label" for="b${i}p">Bokstav på knappen</label><input class="input" id="b${i}p" data-k="brands.${i}.prefix" maxlength="2" ${ro} value="${esc(b.prefix)}"></div>
        <div class="field"><label class="label" for="b${i}c">Färg</label><select class="input" id="b${i}c" data-k="brands.${i}.color" data-rerender ${ro}>${Object.entries(COLORS).map(([k,l]) => `<option value="${k}" ${k===b.color?'selected':''}>${l}</option>`).join('')}</select></div>
      </div>
      <div>${HERE}</div>
      <div class="field"><label class="label" for="b${i}w">Var kunden väntar</label><input class="input" id="b${i}w" data-k="brands.${i}.waitText" value="${esc(b.waitText||'')}"></div>
      <div class="field"><span class="label">Tjänster</span><span class="muted" style="font-size:13px">Namn och förklaring gäller alla anläggningar. Förvald disk och På/Av gäller bara här.</span>
        <div class="p-row p-head"><span>Knapptext</span><span>Förklaring</span><span>Förvald disk</span><span>På</span><span></span></div>
        ${b.purposes.map((p,j) => `<div class="p-row">
          <input class="input" aria-label="Knapptext" data-k="brands.${i}.purposes.${j}.label" ${ro} value="${esc(p.label)}">
          <input class="input p-hint" aria-label="Förklaring" data-k="brands.${i}.purposes.${j}.hint" ${ro} value="${esc(p.hint||'')}">
          <select class="input p-desk" aria-label="Förvald disk" data-k="brands.${i}.purposes.${j}.desk">${deskOpts(p.desk)}</select>
          <span class="toggle"><input type="checkbox" aria-label="Visa ${esc(p.label)}" data-k="brands.${i}.purposes.${j}.enabled" ${p.enabled?'checked':''}><span></span></span>
          ${ro ? '<span></span>' : `<button class="btn sm ghost danger" data-act="p-del" data-b="${i}" data-p="${j}" aria-label="Ta bort ${esc(p.label)}">Ta bort</button>`}
        </div>`).join('')}
        ${ro ? '' : `<div><button class="btn sm" data-act="p-add" data-b="${i}">+ Lägg till tjänst</button></div>`}
      </div>
    </section>`).join('')}
    <section class="panel">
      <h2>Stationer och diskar ${HERE}</h2>
      <p class="set-intro" style="margin:0">Platsbeskrivningen och pilen visas på väntrumsskärmen så kunden vet vart den ska gå.</p>
      ${c.desks.map((d,i) => `<div class="d-row">
        <input class="input" aria-label="Namn" data-k="desks.${i}.name" value="${esc(d.name)}">
        <input class="input d-loc" aria-label="Platsbeskrivning" data-k="desks.${i}.location" value="${esc(d.location)}">
        <select class="input d-dir" aria-label="Pil på skärmen" data-k="desks.${i}.dir"><option value="">Ingen pil</option>${Object.entries(DIRS).map(([k,[a,l]]) => `<option value="${k}" ${d.dir===k?'selected':''}>${a} ${l.charAt(0).toUpperCase()+l.slice(1)}</option>`).join('')}</select>
        <button class="btn sm ghost danger" data-act="d-del" data-i="${i}">Ta bort</button></div>`).join('')}
      <div><button class="btn sm" data-act="d-add">+ Lägg till station</button></div>
    </section>
    <section class="panel">
      <h2>När kunden ropas ${ALL}</h2>
      <p class="set-intro" style="margin:0">Inropningstexten visas på väntrumsskärmen och i kundens mobil, och läses upp. Du kan använda {halsning}, {namn}, {disk}, {plats} och {foretag}. Namnet och disken lyfts fram, disken i grönt.</p>
      <div class="field"><label class="label" for="ct">Inropningstext</label><input class="input" id="ct" data-k="callText" maxlength="160" ${ro} value="${esc(c.callText || '')}">
        <span class="muted" style="font-size:13px">Till exempel: <span id="ct-prev">${esc(callPreview(c))}</span></span></div>
      <p class="set-intro" style="margin:0"><b>{halsning}</b> väljs efter hur länge kunden har väntat:</p>
      ${(c.greetings || []).map((g,i) => `<div class="g-row">
        <label class="g-max">Upp till <input class="input num" type="number" min="0" max="240" aria-label="Antal minuter" data-k="greetings.${i}.upTo" ${ro} value="${esc(g.upTo)}"> min</label>
        <input class="input" aria-label="Hälsning" data-k="greetings.${i}.text" ${ro} value="${esc(g.text)}">
        ${ro ? '<span></span>' : `<button class="btn sm ghost danger" data-act="g-del" data-i="${i}">Ta bort</button>`}</div>`).join('')}
      <div class="g-row"><span class="g-max">Längre väntan</span>
        <input class="input" aria-label="Hälsning vid längre väntan" data-k="greetingLong" ${ro} value="${esc(c.greetingLong || '')}"><span></span></div>
      ${ro ? '' : '<div><button class="btn sm" data-act="g-add">+ Lägg till nivå</button></div>'}
    </section>
    <section class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><h2>Följ i mobilen ${ALL}</h2>
        <label style="display:flex;gap:10px;align-items:center;font-weight:600">Visa QR-kod efter incheckning <span class="toggle"><input type="checkbox" data-k="follow.enabled" ${ro} ${c.follow?.enabled!==false?'checked':''}><span></span></span></label></div>
      <p class="set-intro" style="margin:0">Efter incheckningen visar terminalen en QR-kod. Kunden skannar den och ser sin plats i kön, beräknad väntetid och vart den ska gå. När personalen ropar plingar och vibrerar mobilen, och en notis visas om kunden har tillåtit det.</p>
    </section>
    <section class="panel">
      <h2>Skärm och integritet</h2>
      <div>${ALL}</div>
      <div class="f-grid">
        <div class="field"><label class="label" for="nf">Namn på skärmen</label><select class="input" id="nf" data-k="nameFormat" ${ro}><option value="short" ${c.nameFormat!=='full'?'selected':''}>Förnamn + initial (Anna S.)</option><option value="full" ${c.nameFormat==='full'?'selected':''}>Fullständigt namn</option></select></div>
        <div class="field"><label class="label" for="rd">Radera biljetter efter (dagar)</label><input class="input" id="rd" type="number" min="1" max="365" data-k="retentionDays" ${ro} value="${c.retentionDays||30}"></div>
      </div>
      <div>${HERE}</div>
      <div class="field"><label class="label" for="sm">Meddelande på väntrumsskärmen</label><input class="input" id="sm" data-k="screenMessage" value="${esc(c.screenMessage||'')}"></div>
    </section>
    ${usersHTML()}
    ${sitesHTML()}
    <section class="panel">
      <h2>Dagens kö ${HERE}</h2>
      <div class="btn-row">
        <button class="btn" data-act="demo">Fyll kön med exempelkunder</button>
        ${S.staff.confirmClear ? `<button class="btn danger" data-act="clear-yes">Ja, töm dagens kö</button><button class="btn ghost" data-act="clear-no">Avbryt</button>` : `<button class="btn danger" data-act="clear">Töm dagens kö…</button>`}
      </div>
    </section>
  </div>
  <div class="savebar"><span class="muted" id="dirty">${S.dirty ? 'Osparade ändringar' : 'Allt sparat'}</span><button class="btn" data-act="s-revert" ${S.dirty?'':'disabled'}>Ångra</button><button class="btn primary" data-act="s-save" ${S.dirty?'':'disabled'}>Spara ändringar</button></div>`;
}
function roleOpts(sel){ return (isCentralAdmin() ? ['staff','site','central'] : ['staff']).map(r => `<option value="${r}" ${r===sel?'selected':''}>${ROLE_NAMES[r]}</option>`).join(''); }
function siteChecks(sel){
  const allowed = isCentralAdmin() ? S.sites : S.sites.filter(x => (S.user.sites || []).includes(x.id));
  return allowed.map(x => `<label class="chk"><input type="checkbox" name="uf-site" value="${esc(x.id)}" ${sel.includes(x.id)?'checked':''}> ${esc(x.name)}</label>`).join('');
}
function userFormHTML(u){
  const isNew = !u, role = u?.role || 'staff', sites = u?.sites?.length ? u.sites : [SITE];
  return `<form class="u-form" id="u-form" data-id="${esc(u?.id || '')}">
    <div class="f-grid">
      <div class="field"><label class="label" for="uf-name">Namn</label><input class="input" id="uf-name" required maxlength="60" value="${esc(u?.name || '')}"></div>
      ${isNew ? '<div class="field"><label class="label" for="uf-email">E-post</label><input class="input" id="uf-email" type="email" required autocomplete="off"></div>' : ''}
      <div class="field"><label class="label" for="uf-role">Roll</label><select class="input" id="uf-role">${roleOpts(role)}</select></div>
      <div class="field"><label class="label" for="uf-pw">${isNew ? 'Startlösenord (minst 10 tecken)' : 'Nytt lösenord (lämna tomt för att behålla)'}</label><input class="input" id="uf-pw" type="password" autocomplete="new-password" ${isNew ? 'required minlength="10"' : ''}></div>
    </div>
    <div class="field"><span class="label">Anläggningar <span class="muted">(gäller inte central administratör, som ser alla)</span></span><div class="chips">${siteChecks(sites)}</div></div>
    <div class="btn-row"><button class="btn primary sm" type="submit">${isNew ? 'Skapa konto' : 'Spara'}</button><button class="btn sm ghost" type="button" data-act="u-cancel">Avbryt</button>
      ${isNew ? '' : `<button class="btn sm" type="button" data-act="u-toggle" data-id="${esc(u.id)}">${u.disabled ? 'Aktivera kontot' : 'Stäng av kontot'}</button>
        <button class="btn sm ghost danger" type="button" data-act="u-del" data-id="${esc(u.id)}">${S.confirmDel === u.id ? 'Ja, ta bort kontot' : 'Ta bort…'}</button>`}</div>
  </form>`;
}
function usersHTML(){
  const head = `<h2>Personal och behörighet</h2>
    <p class="set-intro" style="margin:0">Varje medarbetare har ett eget konto. <b>Personal</b> ropar kunder. <b>Anläggningsadministratör</b> ändrar dessutom anläggningens inställningar och lägger till personal. <b>Central administratör</b> styr allt, även gemensamma inställningar och nya anläggningar.</p>`;
  if (!S.users) return `<section class="panel">${head}<div class="empty">Hämtar konton…</div></section>`;
  const siteName = id => S.sites.find(x => x.id === id)?.name || id;
  return `<section class="panel">${head}
    <div class="list">${S.users.map(u => `<div class="row u-row">
      <div style="min-width:0"><b>${esc(u.name || u.email)}</b>${u.disabled ? ' <span class="pill" style="--b:var(--bad)">Avstängt</span>' : ''}<div class="sub">${esc(u.email)}</div></div>
      <span>${ROLE_NAMES[u.role] || u.role}</span>
      <span class="sites">${u.role === 'central' ? 'Alla anläggningar' : u.sites.map(siteName).map(esc).join(', ')}</span>
      <span class="acts">${u.canEdit ? `<button class="btn sm" data-act="u-edit" data-id="${esc(u.id)}">Ändra</button>` : u.id === S.user.id ? '<span class="muted">Du</span>' : ''}</span>
      ${S.editUser === u.id ? `<div style="grid-column:1/-1">${userFormHTML(u)}</div>` : ''}
    </div>`).join('')}</div>
    ${S.editUser === 'new' ? userFormHTML(null) : '<div><button class="btn sm" data-act="u-new">+ Lägg till konto</button></div>'}
  </section>`;
}
function sitesHTML(){
  if (!isCentralAdmin()) return '';
  return `<section class="panel"><h2>Anläggningar</h2>
    <p class="set-intro" style="margin:0">Varje anläggning har egen kö, egna diskar och egna länkar. Företag, tjänster och texter är gemensamma.</p>
    <div class="list">${S.sites.map(x => `<div class="row u-row"><b>${esc(x.name)}</b><span class="muted">/${esc(x.id)}/</span><span></span><span class="acts"><a class="btn sm" href="/${esc(x.id)}/#installningar">Öppna</a></span></div>`).join('')}</div>
    <form id="site-form" class="f-grid" style="align-items:end">
      <div class="field"><label class="label" for="sf-name">Ny anläggning</label><input class="input" id="sf-name" required maxlength="60" placeholder="Till exempel Göteborg"></div>
      <div class="field"><label class="label" for="sf-copy">Kopiera diskar och inställningar från</label><select class="input" id="sf-copy"><option value="">Börja från standard</option>${S.sites.map(x => `<option value="${esc(x.id)}" ${x.id === SITE ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
      <div><button class="btn primary" type="submit">Lägg till anläggning</button></div>
    </form></section>`;
}
async function loadUsers(){
  try { S.users = await api('users'); } catch(e){ S.users = []; toast(e.message); }
  if (S.view === 'installningar') renderView();
}
function callPreview(c){
  const d = c.desks[1] || c.desks[0];
  const v = { halsning:trimEnd(c.greetings?.[0]?.text || c.greetingLong || ''), namn:c.nameFormat === 'full' ? 'Robert Svensson' : 'Robert S.', disk:d?.name || 'disken', plats:d?.location || '', foretag:c.brands[0]?.name || '' };
  const s = String(c.callText || '').replace(/\{(\w+)\}/g, (m,k) => k in v ? v[k] : m).replace(/\s+/g,' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function setPath(obj, path, val){
  const k = path.split('.'); let o = obj;
  for (let i=0;i<k.length-1;i++) o = o[k[i]];
  o[k[k.length-1]] = val;
}
function markDirty(){ S.dirty = true; $('#dirty').textContent = 'Osparade ändringar'; document.querySelectorAll('[data-act="s-save"],[data-act="s-revert"]').forEach(b => b.disabled = false); }
function slug(s){ return (s||'').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g,'').slice(0,16) || 'syfte'; }

/* ---------- Events ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const a = el.dataset.act, id = el.dataset.id, t = id && T(id);
  switch(a){
    case 't-brand': {
      S.term.brand = id; const ps = brand(id).purposes.filter(p => p.enabled);
      if (ps.length === 1){ S.term.purpose = ps[0].id; termGo('details'); } else termGo('purpose');
      break; }
    case 't-purpose': S.term.purpose = id; termGo('details'); break;
    case 't-back': {
      const one = brand(S.term.brand)?.purposes.filter(p => p.enabled).length === 1;
      termGo(S.term.step==='details' && !one ? 'purpose' : 'brand'); break; }
    case 't-reset': termReset(); break;
    case 's-chip': {
      const set = new Set(myBrands()); set.has(id) ? set.delete(id) : set.add(id);
      S.staff.brands = [...set]; ls.set(siteKey('brands'), S.staff.brands); el.setAttribute('aria-pressed', set.has(id)); break; }
    case 'call-next': {
      if (!S.staff.desk){ toast('Välj din station först.'); break; }
      el.disabled = true;
      await write(() => siteApi('call-next', { method:'POST', body:{ desk:S.staff.desk, brands:myBrands() } }), r => `${shortName(r.ticket?.name)} ropas till ${desk(S.staff.desk)?.name}`);
      el.disabled = false; break; }
    case 'call': if (t) await callTicket(t); break;
    case 'recall': if (t) await callTicket(t, true); break;
    case 'serve': await write(() => ticketAction(id, 'serve')); break;
    case 'done': await write(() => ticketAction(id, 'done'), 'Besöket är avslutat'); break;
    case 'noshow': await write(() => ticketAction(id, 'noshow'), 'Markerad som ej på plats. Du hittar kunden under Klara.'); break;
    case 'requeue': await write(() => ticketAction(id, 'requeue'), 'Kunden står i kön igen'); break;
    case 's-tab': S.staff.tab = id; S.staff.transferId = null; updateStaff(); break;
    case 'transfer': S.staff.transferId = S.staff.transferId===id ? null : id; updateStaff(); break;
    case 'transfer-go': {
      const [b, p] = $('#tr-'+id).value.split('|');
      S.staff.transferId = null;
      await write(() => ticketAction(id, 'transfer', { brand:b, purpose:p }), `Flyttad till ${brand(b)?.name}, platsen i kön behålls`); break; }
    case 'sound': {
      try { S.audio = new (window.AudioContext || window.webkitAudioContext)(); S.sound = true; chime(); } catch { toast('Ljud stöds inte på den här skärmen.'); }
      renderTvSound();
      if (S.sound) setTimeout(() => speak('Ljud och uppläsning är på.'), 1300);
      break; }
    case 'voice-test': chime(); setTimeout(() => speak(voiceSample()), 1300); break;
    case 'f-notify': {
      try { S.audio = S.audio || new (window.AudioContext || window.webkitAudioContext)(); S.audio.resume?.(); } catch {}
      S.alerts = true;
      if ('Notification' in window){
        let perm = 'denied';
        try { perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission(); } catch {}
        S.notify = perm === 'granted';
      }
      chime();
      toast(S.notify ? 'Klart – mobilen säger till när det är din tur.' : 'Klart – håll sidan öppen så plingar mobilen när det är din tur.');
      updateFollow(); break; }
    case 'p-add': { const b = S.draft.brands[el.dataset.b]; b.purposes.push({ id:'nytt'+uid(), label:'Ny tjänst', hint:'', enabled:true, desk:'' }); markDirty(); renderView(); break; }
    case 'p-del': S.draft.brands[el.dataset.b].purposes.splice(el.dataset.p, 1); markDirty(); renderView(); break;
    case 'd-add': S.draft.desks.push({ id:'s'+uid(), name:'Ny station', location:'', dir:'' }); markDirty(); renderView(); break;
    case 'g-add': {
      const g = S.draft.greetings || (S.draft.greetings = []);
      g.push({ upTo:(g.length ? (parseInt(g[g.length-1].upTo) || 0) : 0) + 10, text:'Ny hälsning' }); markDirty(); renderView(); break; }
    case 'g-del': S.draft.greetings.splice(el.dataset.i, 1); markDirty(); renderView(); break;
    case 'd-del': S.draft.desks.splice(el.dataset.i, 1); markDirty(); renderView(); break;
    case 's-revert': S.draft = clone(cfg()); S.dirty = false; renderView(); break;
    case 's-save': {
      const c = S.draft;
      c.brands.forEach(b => { b.prefix = (b.prefix||'').toUpperCase().trim() || b.name[0].toUpperCase(); b.purposes.forEach(p => { if (p.id.startsWith('nytt')) p.id = slug(p.label) + '-' + uid().slice(0,3); }); });
      c.retentionDays = Math.max(1, Math.min(365, parseInt(c.retentionDays) || 30));
      c.callText = String(c.callText || '').trim() || KK.DEFAULT_CENTRAL.callText;
      c.greetings = (c.greetings || []).map(g => ({ upTo:Math.max(0, parseInt(g.upTo) || 0), text:String(g.text || '').trim() })).filter(g => g.text).sort((a,b) => a.upTo-b.upTo);
      const { central, local } = KK.splitConfig(c);
      el.disabled = true;
      /* Central first, so a new service exists at every site before this site sets its desk */
      const ok = await write(async () => {
        if (isCentralAdmin()) await api('central', { method:'PUT', body:central });
        await siteApi('local', { method:'PUT', body:local });
      }, 'Inställningarna är sparade');
      el.disabled = false;
      if (ok){ S.dirty = false; S.draft = null; }
      break; }
    case 'demo': await write(() => siteApi('demo', { method:'POST' }), 'Sju exempelkunder är tillagda'); break;
    case 'clear': S.staff.confirmClear = true; renderView(); break;
    case 'clear-no': S.staff.confirmClear = false; renderView(); break;
    case 'clear-yes': {
      S.staff.confirmClear = false;
      await write(() => siteApi('clear', { method:'POST' }), r => `${r.removed} ärenden borttagna`);
      renderView(); break; }
    case 'logout': {
      try { await api('logout', { method:'POST' }); } catch {}
      signedOut(); toast('Du är utloggad'); break; }
    case 'u-new': S.editUser = 'new'; S.confirmDel = null; renderView(); break;
    case 'u-edit': S.editUser = S.editUser === id ? null : id; S.confirmDel = null; renderView(); break;
    case 'u-cancel': S.editUser = null; S.confirmDel = null; renderView(); break;
    case 'u-toggle': {
      const u = S.users?.find(x => x.id === id);
      if (u && await write(() => api('users/' + id, { method:'PATCH', body:{ disabled:!u.disabled } }), u.disabled ? 'Kontot är aktiverat' : 'Kontot är avstängt och utloggat')){ S.editUser = null; loadUsers(); }
      break; }
    case 'u-del': {
      if (S.confirmDel !== id){ S.confirmDel = id; renderView(); break; }
      if (await write(() => api('users/' + id, { method:'DELETE' }), 'Kontot är borttaget')){ S.editUser = null; S.confirmDel = null; loadUsers(); }
      break; }
  }
});
document.addEventListener('input', e => {
  const k = e.target.dataset?.k; if (!k || !S.draft) return;
  setPath(S.draft, k, e.target.type==='checkbox' ? e.target.checked : e.target.value);
  markDirty();
  if (/^(callText|greetings|desks|nameFormat)/.test(k) && $('#ct-prev')) $('#ct-prev').textContent = callPreview(S.draft);
  if (e.target.hasAttribute('data-rerender')) renderView();
});
document.addEventListener('change', e => {
  if (e.target.id==='s-desk'){ S.staff.desk = e.target.value; ls.set(siteKey('desk'), S.staff.desk); updateStaff(); }
  if (e.target.id==='a-brand') fillPurposeSelect();
  if (e.target.id==='tv-voice'){ ls.set('voice', e.target.value); speak(voiceSample()); }
});
document.addEventListener('submit', async e => {
  if (e.target.id==='t-form') return termSubmit(e);
  if (e.target.id==='lg-form'){
    e.preventDefault();
    const btn = e.submitter || $('#lg-form button'); btn.disabled = true;
    const email = $('#lg-email').value.trim();
    try { signedIn(await api('login', { method:'POST', body:{ email, password:$('#lg-pw').value } })); ls.set('lastEmail', email); }
    catch(err){ toast(err.message); btn.disabled = false; $('#lg-pw')?.select(); }
    return;
  }
  if (e.target.id==='setup-form'){
    e.preventDefault();
    const btn = e.submitter || $('#setup-form button'); btn.disabled = true;
    try {
      const r = await api('setup', { method:'POST', body:{ code:$('#su-code').value, name:$('#su-name').value.trim(), email:$('#su-email').value.trim(), password:$('#su-pw').value } });
      S.setupNeeded = false; S.sites = await api('sites');
      signedIn(r);
      if (!SITE) location.href = `/${S.sites[0]?.id || ''}/#installningar`;
    } catch(err){ toast(err.message); btn.disabled = false; }
    return;
  }
  if (e.target.id==='u-form'){
    e.preventDefault();
    const id = e.target.dataset.id, sites = [...e.target.querySelectorAll('[name="uf-site"]:checked')].map(x => x.value);
    const body = { name:$('#uf-name').value.trim(), role:$('#uf-role').value, sites };
    const pw = $('#uf-pw').value; if (pw) body.password = pw;
    if (!id) body.email = $('#uf-email').value.trim();
    const r = await write(() => id ? api('users/' + id, { method:'PATCH', body }) : api('users', { method:'POST', body }), id ? 'Kontot är uppdaterat' : 'Kontot är skapat. Ge medarbetaren e-post och startlösenord.');
    if (r){ S.editUser = null; loadUsers(); }
    return;
  }
  if (e.target.id==='site-form'){
    e.preventDefault();
    const r = await write(() => api('sites', { method:'POST', body:{ name:$('#sf-name').value.trim(), copyFrom:$('#sf-copy').value } }), r => `${r.site.name} är tillagd`);
    if (r){ S.sites = await api('sites').catch(() => S.sites); renderView(); }
    return;
  }
  if (e.target.id==='s-add'){
    e.preventDefault();
    const name = $('#a-name').value.trim(); if (name.length < 2) return;
    const b = $('#a-brand').value, phone = normPhone($('#a-phone').value);
    if (phone === null){ toast('Kontrollera mobilnumret, till exempel 070-123 45 67.'); $('#a-phone').focus(); return; }
    const body = { brand:b, purpose:$('#a-purpose').value, name, phone, regnr:$('#a-reg').value.toUpperCase().replace(/[^A-ZÅÄÖ0-9]/g,'').slice(0,7) };
    if (await write(() => siteApi('tickets', { method:'POST', body }), `${name} är tillagd i kön`)){ $('#a-name').value=''; $('#a-phone').value=''; $('#a-reg').value=''; }
  }
});
/* kiosk escape: hold the corner for a second to reveal the staff menu */
(() => {
  const k = $('#kiosk-key'); let timer;
  const stop = () => { clearTimeout(timer); k.classList.remove('holding'); };
  k.addEventListener('pointerdown', () => { k.classList.add('holding'); timer = setTimeout(() => { stop(); S.navOpen = !S.navOpen; document.body.classList.toggle('nav-open', S.navOpen); }, 1100); });
  ['pointerup','pointerleave','pointercancel'].forEach(ev => k.addEventListener(ev, stop));
  k.addEventListener('contextmenu', e => e.preventDefault());
})();

function tickClock(){ document.querySelectorAll('[data-clock]').forEach(el => el.textContent = clock()); }
setInterval(() => {
  tickClock();
  if (S.view==='terminal' && S.term.step!=='brand'){
    const left = Math.ceil((S.term.resetAt - Date.now())/1000);
    const c = $('#t-count'); if (c) c.textContent = `Skärmen återställs om ${Math.max(0,left)} s`;
    if (left <= 0) termReset();
  }
}, 1000);
document.addEventListener('pointerdown', () => { if (S.view==='terminal' && S.term.step!=='brand' && S.term.step!=='done') S.term.resetAt = Date.now() + 60000; }, true);
setInterval(() => {
  if (S.authReady && S.view !== 'folj' && dayStr() !== S.day){ S.seen = {}; S.firstSnap = true; connectLive(); }
  if (S.view !== 'installningar' && !(S.view==='terminal' && S.term.step==='details')) renderData();
}, 20000);

window.addEventListener('hashchange', route);
route();
tickClock();

function signedIn(r){
  S.token = r.token; S.user = r.user; ls.set('token', r.token);
  showWho();
  S.users = null; S.draft = null; S.dirty = false;
  if (S.ws?.readyState === 1 && S.view !== 'folj') S.ws.send(JSON.stringify({ type:'auth', token:S.token }));
  else connectLive();
  renderView();
}
function showWho(){
  $('#logout').hidden = !S.user; $('#who').hidden = !S.user;
  $('#who').textContent = S.user ? `${S.user.name || S.user.email} · ${ROLE_NAMES[S.user.role] || ''}` : '';
}

/* ---------- Start ---------- */
(async () => {
  const pill = $('#mode-pill');
  try {
    const [setup, sites] = await Promise.all([api('setup'), api('sites')]);
    S.setupNeeded = setup.needed; S.sites = sites;
    pill.textContent = 'Live'; pill.classList.add('live');
  } catch(e){
    pill.textContent = 'Offline';
    showBanner('Servern går inte att nå just nu. Sidan försöker igen automatiskt.');
    setTimeout(() => location.reload(), 15000);
  }
  if (SITE && !S.setupNeeded && !S.sites.some(x => x.id === SITE)){
    $('#view').innerHTML = `<div class="login"><div class="empty">Anläggningen ”${esc(SITE)}” finns inte. <a href="/">Välj anläggning</a>.</div></div>`;
    return;
  }
  if (S.token && !S.setupNeeded){
    try { S.user = (await api('me')).user; } catch { S.token = ''; ls.del('token'); }
  }
  S.authReady = true;
  showWho();
  renderView();
  connectLive();
})();
