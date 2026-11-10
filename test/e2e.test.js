/* Kökortet – helhetstest. Startar servern lokalt (wrangler dev) med tom databas och kör
   terminal, väntrumsskärm, personal och kundens mobil i en riktig webbläsare.
   Kör: npm test   (kräver Playwright med Chromium: npm i -D playwright && npx playwright install chromium) */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8800 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
/* wrangler dev läser hemligheter från .dev.vars i projektmappen; finns ingen skapas en tillfällig */
const DEV_VARS = path.join(ROOT, '.dev.vars');
const OWN_DEV_VARS = !fs.existsSync(DEV_VARS);
const CODE = OWN_DEV_VARS ? 'test-startkod-' + Date.now() : (fs.readFileSync(DEV_VARS, 'utf8').match(/^SETUP_CODE=(.*)$/m) || [])[1];
const ADMIN = { email: 'admin@example.se', name: 'Ada Admin', password: 'admin-losen-123' };
let server, browser, persist;
const S = {};   // shared state between steps

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(p, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + '/api/' + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
/* Mocks for things a headless browser lacks: voices, notifications, vibration, audio */
const deviceMocks = () => {
  window.__spoken = []; window.__notes = [];
  navigator.vibrate = () => true;
  window.Notification = class { constructor(t, o) { window.__notes.push(t + ' | ' + o.body); } static get permission() { return 'granted'; } static requestPermission() { return Promise.resolve('granted'); } };
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  const voices = [['Microsoft Mattias Online (Natural) - Swedish (Sweden)', 'sv-SE'], ['Microsoft Sofie Online (Natural) - Swedish (Sweden)', 'sv-SE']].map(([name, lang]) => ({ name, lang }));
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { getVoices: () => voices, speak: u => window.__spoken.push({ text: u.text, voice: u.voice && u.voice.name }), cancel() {}, addEventListener() {} } });
  window.AudioContext = class { constructor() { this.currentTime = 0; this.destination = {}; } createOscillator() { return { type: '', frequency: {}, connect: x => x, start() {}, stop() {} }; } createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: x => x }; } };
};
async function newPage(vp = { width: 1280, height: 860 }) {
  const ctx = await browser.newContext({ viewport: vp });
  await ctx.addInitScript(deviceMocks);
  await ctx.route('**/*', r => r.request().url().startsWith(BASE) ? r.continue() : r.abort());   // inga externa typsnitt i testet
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  return page;
}
const text = (page, sel) => page.$eval(sel, el => el.innerText.replace(/ /g, ' ').replace(/\s+/g, ' ').trim());

before(async () => {
  persist = fs.mkdtempSync(path.join(os.tmpdir(), 'kokortet-'));
  if (OWN_DEV_VARS) fs.writeFileSync(DEV_VARS, `SETUP_CODE=${CODE}\n`);
  assert.ok(CODE, '.dev.vars saknar SETUP_CODE');
  server = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = ''; server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d);
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(BASE + '/api/setup')).ok) break; } catch {}
    await sleep(1000);
    if (i === 89) throw new Error('wrangler dev startade inte:\n' + log.slice(-2000));
  }
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  fs.rmSync(persist, { recursive: true, force: true });
  if (OWN_DEV_VARS) fs.rmSync(DEV_VARS, { force: true });
});

test('första uppstart: fel startkod nekas, rätt kod skapar admin och fyra anläggningar', async () => {
  assert.equal((await api('setup')).data.needed, true);
  const page = await newPage();
  await page.goto(BASE + '/');
  await page.waitForSelector('#setup-form');
  await page.fill('#su-code', 'fel-kod'); await page.fill('#su-name', ADMIN.name); await page.fill('#su-email', ADMIN.email); await page.fill('#su-pw', ADMIN.password);
  await page.click('#setup-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Fel startkod'));
  await page.fill('#su-code', CODE);
  await page.click('#setup-form button[type="submit"]');
  await page.waitForURL(/\/kungalv\/#installningar$/);
  await page.waitForSelector('.settings');
  const sites = (await api('sites')).data.map(s => s.name);
  assert.deepEqual(sites, ['Kungälv', 'Svedala', 'Linköping', 'Brännbacken']);
  assert.equal((await api('setup', { method: 'POST', body: { code: CODE, ...ADMIN } })).status, 409, 'uppsättning kan bara göras en gång');
  S.admin = (await api('login', { method: 'POST', body: ADMIN })).data.token;
  assert.ok(S.admin);
  assert.deepEqual(page.errors, []);
});

test('väljaren visar anläggningarna, okänd anläggning ger tydligt besked', async () => {
  const page = await newPage();
  await page.goto(BASE + '/');
  await page.waitForSelector('.site-list a');
  assert.equal((await page.$$('.site-list a')).length, 4);
  await page.goto(BASE + '/finnsinte/#terminal');
  await page.waitForFunction(() => document.body.innerText.includes('finns inte'));
});

test('terminalen: incheckning utan inloggning, QR-kod med hemlig länk', async () => {
  const page = await newPage({ width: 1180, height: 820 });
  S.terminal = page;
  await page.goto(BASE + '/kungalv/#terminal');
  await page.waitForSelector('[data-act="t-brand"][data-id="kvdbil"]');
  assert.equal((await page.textContent('.t-site')).trim(), 'Kungälv', 'kunden ser vilken anläggning det är');
  await page.click('[data-act="t-brand"][data-id="kvdbil"]');
  await page.click('[data-act="t-purpose"][data-id="hamta"]');
  await page.fill('#t-name', 'Robert Svensson');
  await page.fill('#t-phone', '070-111 22 33');
  await page.fill('#t-reg', 'abc123');
  assert.match(await text(page, '.privacy'), /raderas automatiskt efter 30 dagar/);
  await page.click('#t-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#t-qr img[src^="data:image"]'));
  const r = await page.evaluate(() => S.term.result);
  assert.match(r.fid, /^[0-9a-f]{32}$/, 'följlänken använder en lång slumpkod');
  assert.equal(r.name, 'Robert Svensson');
  S.fid = r.fid; S.ticketId = r.id;
  assert.equal(await page.evaluate(fid => followLink(fid), r.fid), `${BASE}/kungalv/#folj=${r.fid}`);
  assert.deepEqual(page.errors, []);
});

test('publika vyer får aldrig telefonnummer, regnummer eller efternamn', async () => {
  const msg = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/sites/kungalv/live`);
    ws.onmessage = e => { resolve(String(e.data)); ws.close(); };
    ws.onerror = reject;
  });
  const follow = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/sites/kungalv/live?follow=${S.fid}`);
    ws.onmessage = e => { resolve(String(e.data)); ws.close(); };
    ws.onerror = reject;
  });
  for (const m of [msg, follow]) {
    assert.ok(!m.includes('46701112233') && !m.includes('Svensson') && !m.includes('ABC123'), 'inga personuppgifter i publik data');
    assert.ok(!m.includes(S.fid), 'följkoden skickas inte ut');
  }
  assert.ok(follow.includes('"name":"Robert S."'));
  /* den gamla brister: att lista hela kön publikt – nu får publika vyer bara ropade kunder */
  assert.ok(!JSON.parse(msg).tickets, 'publika vyer får ingen ärendelista');
});

test('obehörig: utan inloggning och med fel anläggning nekas allt utom incheckning', async () => {
  assert.equal((await api(`sites/kungalv/tickets/${S.ticketId}/call`, { method: 'POST', body: { desk: 'd2' } })).status, 401);
  const created = await api('users', { method: 'POST', token: S.admin, body: { email: 'svea@example.se', name: 'Svea Svedala', role: 'staff', sites: ['svedala'], password: 'svea-losen-123' } });
  assert.equal(created.status, 201);
  const svea = (await api('login', { method: 'POST', body: { email: 'svea@example.se', password: 'svea-losen-123' } })).data.token;
  assert.equal((await api(`sites/kungalv/tickets/${S.ticketId}/call`, { method: 'POST', token: svea, body: { desk: 'd2' } })).status, 403);
  assert.equal((await api('central', { method: 'PUT', token: svea, body: {} })).status, 403);
  assert.equal((await api('users', { token: svea })).status, 403);
  assert.equal((await api('sites', { method: 'POST', token: svea, body: { name: 'X' } })).status, 403);
  /* inloggningen låses efter upprepade fel */
  let last;
  for (let i = 0; i < 9; i++) last = await api('login', { method: 'POST', body: { email: 'svea@example.se', password: 'fel' } });
  assert.equal(last.status, 429);
});

test('personal: loggar in, ser hela uppgifterna, ropar – skärm och mobil följer med', async () => {
  await api('users', { method: 'POST', token: S.admin, body: { email: 'kim@example.se', name: 'Kim Kungälv', role: 'staff', sites: ['kungalv'], password: 'kim-losen-1234' } });
  const tv = await newPage({ width: 1600, height: 900 });
  await tv.goto(BASE + '/kungalv/#skarm');
  await tv.waitForSelector('[data-act="sound"]');
  await tv.click('[data-act="sound"]');
  const phone = await newPage({ width: 390, height: 844 });
  await phone.goto(`${BASE}/kungalv/#folj=${S.fid}`);
  await phone.waitForSelector('.f-card');
  assert.match(await text(phone, '#follow'), /Näst på tur/);
  await phone.click('[data-act="f-notify"]');

  const staff = await newPage();
  await staff.goto(BASE + '/kungalv/#personal');
  await staff.waitForSelector('#lg-form');
  await staff.fill('#lg-email', 'kim@example.se'); await staff.fill('#lg-pw', 'kim-losen-1234');
  await staff.click('#lg-form button[type="submit"]');
  await staff.waitForSelector('#s-list .row');
  const list = await text(staff, '#s-list');
  assert.match(list, /Robert Svensson/); assert.match(list, /ABC123/);
  await staff.selectOption('#s-desk', 'd2');
  await staff.click('[data-act="call-next"]');
  await staff.waitForSelector('#s-current .current');
  assert.match(await text(staff, '#s-current'), /070-111 22 33/);

  await tv.waitForSelector('.tv-call');
  assert.match(await text(tv, '.tv-call .nm'), /Välkommen Robert S\. – du har grönt ljus till Disk 2/);
  await tv.waitForFunction(() => window.__spoken.length >= 2);
  const spoken = await tv.evaluate(() => window.__spoken.at(-1));
  assert.match(spoken.voice, /Sofie/, 'kvinnlig röst väljs');
  assert.match(spoken.text.replace(/\u00a0/g, ' '), /Robert S – du har grönt ljus till Disk 2/);

  await phone.waitForSelector('.f-card.called');
  assert.equal(await text(phone, '.f-call'), 'Välkommen Robert – du har grönt ljus till Disk 2');
  /* Ropa igen → mobilen får en ny notis */
  await staff.click('#s-current [data-act="recall"]');
  await phone.waitForFunction(() => window.__notes.length >= 2);
  /* terminalens rad längst ned visar den ropade */
  await S.terminal.waitForFunction(() => document.querySelector('#t-ticker')?.innerText.includes('Robert S.'));
  S.staff = staff; S.phone = phone; S.tv = tv;
  for (const p of [tv, phone, staff]) assert.deepEqual(p.errors, []);
});

test('två medarbetare kan inte ropa samma kund', async () => {
  const r = await api('sites/kungalv/tickets', { method: 'POST', token: S.admin, body: { brand: 'kvdbil', purpose: 'lamna', name: 'Lisa Larsson' } });
  assert.equal(r.status, 201);
  const [a, b] = await Promise.all([
    api(`sites/kungalv/tickets/${r.data.ticket.id}/call`, { method: 'POST', token: S.admin, body: { desk: 'd1' } }),
    api(`sites/kungalv/tickets/${r.data.ticket.id}/call`, { method: 'POST', token: S.admin, body: { desk: 'd2' } })
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
});

test('avslutat besök raderar mobilnumret direkt', async () => {
  await S.staff.click('#s-current [data-act="serve"]');
  await S.staff.waitForSelector('#s-current [data-act="done"]');
  await S.staff.click('#s-current [data-act="done"]');
  await S.phone.waitForFunction(() => document.querySelector('#follow').innerText.includes('Tack för besöket'));
  const snap = await S.staff.evaluate(id => S.tickets.find(t => t.id === id), S.ticketId);
  assert.equal(snap.status, 'done'); assert.equal(snap.phone, '');
});

test('behörighet i inställningar: personal ser inga inställningar, anläggningsadmin kan inte ändra gemensamt', async () => {
  await S.staff.goto(BASE + '/kungalv/#installningar');
  await S.staff.waitForFunction(() => document.body.innerText.includes('kan bara ändras av en administratör'));
  await api('users', { method: 'POST', token: S.admin, body: { email: 'sara@example.se', name: 'Sara Site', role: 'site', sites: ['kungalv'], password: 'sara-losen-1234' } });
  const page = await newPage();
  await page.goto(BASE + '/kungalv/#installningar');
  await page.waitForSelector('#lg-form');
  await page.fill('#lg-email', 'sara@example.se'); await page.fill('#lg-pw', 'sara-losen-1234');
  await page.click('#lg-form button[type="submit"]');
  await page.waitForSelector('.settings', { timeout:8000 }).catch(async e => { throw new Error('Inställningarna visades inte. Sidan visar: ' + (await page.evaluate(() => document.querySelector('#view').innerText.slice(0, 300) + ' | toast: ' + document.querySelector('#toast').textContent))); });
  assert.equal(await page.$eval('[data-k="callText"]', el => el.disabled), true, 'gemensam text är låst');
  assert.equal(await page.$eval('[data-k="desks.1.name"]', el => el.disabled), false, 'lokal disk går att ändra');
  await page.fill('[data-k="desks.1.name"]', 'Disk Två');
  await page.click('[data-act="s-save"]');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('sparade'));
  const info = (await api('sites/kungalv')).data;
  assert.equal(info.config.desks[1].name, 'Disk Två');
  assert.equal((await api('sites/svedala')).data.config.desks[1].name, 'Disk 2', 'andra anläggningar påverkas inte');
  /* anläggningsadmin kan lägga till personal på sin anläggning men inte på andras */
  const own = await api('users', { method: 'POST', token: (await api('login', { method: 'POST', body: { email: 'sara@example.se', password: 'sara-losen-1234' } })).data.token,
    body: { email: 'ola@example.se', name: 'Ola', role: 'staff', sites: ['svedala'], password: 'ola-losen-12345' } });
  assert.equal(own.status, 403);
  assert.deepEqual(page.errors, []);
});

test('central admin: gemensam text slår igenom överallt och ny anläggning kopieras', async () => {
  const c = (await api('central')).data;
  c.callText = '{namn}, du har grönt ljus till {disk}!';
  assert.equal((await api('central', { method: 'PUT', token: S.admin, body: c })).status, 200);
  assert.equal((await api('sites/svedala')).data.config.callText, c.callText);
  const created = await api('sites', { method: 'POST', token: S.admin, body: { name: 'Göteborg', copyFrom: 'kungalv' } });
  assert.equal(created.status, 201);
  assert.equal(created.data.site.id, 'goteborg');
  assert.equal((await api('sites/goteborg')).data.config.desks[1].name, 'Disk Två', 'diskarna kopierades från Kungälv');
  assert.equal((await api('sites', { method: 'POST', token: S.admin, body: { name: 'Göteborg' } })).status, 409);
});

test('kontohantering: avstängt konto loggas ut direkt', async () => {
  const users = (await api('users', { token: S.admin })).data;
  const kim = users.find(u => u.email === 'kim@example.se');
  const kimToken = (await api('login', { method: 'POST', body: { email: 'kim@example.se', password: 'kim-losen-1234' } })).data.token;
  assert.equal((await api('me', { token: kimToken })).status, 200);
  assert.equal((await api('users/' + kim.id, { method: 'PATCH', token: S.admin, body: { disabled: true } })).status, 200);
  assert.equal((await api('me', { token: kimToken })).status, 401);
  /* den sista centrala administratören kan inte tas bort */
  const me = users.find(u => u.email === ADMIN.email);
  const meToken = S.admin;
  assert.equal((await api('users/' + me.id, { method: 'DELETE', token: meToken })).status, 403);
});

test('webbsidan innehåller inga nycklar eller hemligheter', async () => {
  for (const f of ['/', '/app.js', '/shared.js']) {
    const body = await (await fetch(BASE + f)).text();
    assert.ok(!/apiKey|AIza|SETUP_CODE=|firebase/i.test(body), `${f} innehåller inget som liknar en nyckel`);
  }
  const res = await fetch(BASE + '/kungalv/');
  assert.match(res.headers.get('content-security-policy') || '', /script-src 'self'/);
});

test('kvdbils designsystem: ordmärket laddas och sidan hämtar inget från andra webbplatser', async () => {
  for (const f of ['/brand/kvdbil-wordmark-navy.svg', '/brand/kvdbil-wordmark-white.svg', '/brand/hand-car-key-suit.webp']) {
    const res = await fetch(BASE + f);
    assert.equal(res.status, 200, f);
  }
  const page = await newPage({ width: 1180, height: 820 });
  const external = [];
  page.on('request', r => { if (!r.url().startsWith(BASE) && !r.url().startsWith('data:')) external.push(r.url()); });
  await page.goto(BASE + '/kungalv/#terminal');
  await page.waitForSelector('.t-field .field-mark');
  assert.equal(await page.$eval('.t-field .field-mark', img => img.complete && img.naturalWidth > 0), true, 'ordmärket visas');
  assert.equal(await text(page, '.t-field .field-number'), '01.');
  assert.match(await page.$eval('body', b => getComputedStyle(b).fontFamily), /^Arial/);
  assert.deepEqual(external, [], 'inga externa anrop (typsnitt, skript)');
});

