// Loads main.js with Electron, win32 and child_process mocked, on a virtual clock, with fake Claude data folders,
// logs and transcripts in a temp folder (LOCALAPPDATA, APPDATA and USERPROFILE point there). Exercises the
// "needs you" watcher and plan-limit alerts end to end. Nothing real is launched, read or written.
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const { EventEmitter } = require('events');
const assert = require('assert');

// ---------- virtual clock ----------
const SPEED = 20;
const realNow = Date.now.bind(Date);
const realSetTimeout = setTimeout;
const realSetInterval = setInterval;
const T0 = realNow();
Date.now = () => T0 + (realNow() - T0) * SPEED;
global.setTimeout = (fn, ms = 0, ...a) => realSetTimeout(fn, Math.max(0, ms / SPEED), ...a);
global.setInterval = (fn, ms = 0, ...a) => realSetInterval(fn, Math.max(1, ms / SPEED), ...a);
const vsleep = (ms) => new Promise((r) => realSetTimeout(r, ms / SPEED));
const MIN = 60000;

const ROOT = 'D:/Claud/multi-claude';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-search-main-'));
const LOCAL = path.join(tmp, 'local');
process.env.LOCALAPPDATA = LOCAL;
process.env.APPDATA = path.join(tmp, 'roaming');
process.env.USERPROFILE = path.join(tmp, 'home');
process.env.HOME = process.env.USERPROFILE;
assert.strictEqual(os.homedir(), process.env.USERPROFILE, 'transcripts must come from the temp home');
fs.mkdirSync(path.join(LOCAL, 'Microsoft', 'WindowsApps'), { recursive: true });
fs.writeFileSync(path.join(LOCAL, 'Microsoft', 'WindowsApps', 'claude-desktop.exe'), '');
const userData = path.join(tmp, 'userData');
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, 'profiles.json'), JSON.stringify({
  accounts: [
    { id: 'main', name: 'Work', color: '#5b8def', main: true },
    { id: 'personal', name: 'Personal', color: '#d97757' },
    { id: 'studio', name: 'Studio', color: '#3fb68b' },
  ],
  ui: { panes: ['main', 'personal'], split: false, focused: 0, home: false },
}));

// ---------- fake Claude data ----------
const dataDir = (id) => (id === 'main' ? path.join(process.env.APPDATA, 'Claude') : path.join(LOCAL, 'Claude-Profiles', id));
const logFile = (id) => (id === 'main' ? path.join(LOCAL, 'Claude', 'Logs', 'main.log') : path.join(dataDir(id), 'logs', 'main.log'));
const stamp = () => { const d = new Date(Date.now()); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const logLine = (id, msg) => { fs.mkdirSync(path.dirname(logFile(id)), { recursive: true }); fs.appendFileSync(logFile(id), `${stamp()} [info] ${msg}\n`); };
const sessDir = (id) => path.join(dataDir(id), 'claude-code-sessions', `acc-${id}`, 'org');
function writeSession(id, uuid, fields) {
  fs.mkdirSync(sessDir(id), { recursive: true });
  fs.writeFileSync(path.join(dataDir(id), 'config.json'), JSON.stringify({ lastKnownAccountUuid: `acc-${id}` }));
  const file = path.join(sessDir(id), `local_${uuid}.json`);
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.writeFileSync(file, JSON.stringify({ sessionId: `local_${uuid}`, cliSessionId: `cli-${uuid}`, cwd: 'D:\\Claud', isArchived: false, createdAt: Date.now() - 60 * MIN, lastActivityAt: Date.now(), ...prev, ...fields }));
}
const projects = path.join(process.env.USERPROFILE, '.claude', 'projects', 'D--Claud');
function writeTranscript(uuid, lines) {
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, `cli-${uuid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
function writePlan(id, samples) {
  fs.mkdirSync(dataDir(id), { recursive: true });
  fs.writeFileSync(path.join(dataDir(id), 'plan-usage-history.json'), JSON.stringify({ version: 1, samples: samples.map(([ago, fh, sd]) => ({ t: Date.now() - ago, org: 'o', u: { fh, sd } })) }));
}
const U = (n) => `0000000${n}-0000-4000-8000-000000000000`.slice(-36);
const RID = (n) => `aaaaaaa${n}-0000-4000-8000-000000000000`.slice(-36);

for (const id of ['main', 'personal', 'studio']) { writeSession(id, U(id === 'main' ? 1 : id === 'personal' ? 2 : 3), { title: `${id} idle`, lastTurnEdgeAt: Date.now() - 50 * MIN, lastFocusedAt: Date.now() - 40 * MIN, completedTurns: 2, lastAssistantUuid: 'x' }); logLine(id, 'Starting app {'); }
// Personal: a prompt pending since before Kitsun started (the first poll learns it, without a notice).
writeSession('personal', U(4), { title: 'Teashop', completedTurns: 3 });
logLine('personal', `Emitted tool permission request ${RID(1)} for Bash in session local_${U(4)}`);
writePlan('main', [[30 * MIN, 40, 50], [16 * MIN, 60, 52]]);
writePlan('personal', [[10 * MIN, 20, 30]]);
writePlan('studio', [[6 * 60 * MIN, 70, 10]]); // older than 5 h: its 5-hour window has reset

// ---------- electron / win32 / child_process ----------
const handlers = {};
let tray = null;
let win = null;
const notifications = [];
class FakeWindow extends EventEmitter {
  constructor() {
    super(); this.visible = false; this.minimized = false; this.focused = true; win = this;
    this.webContents = Object.assign(new EventEmitter(), { sent: [], send: (ch, ...a) => this.webContents.sent.push([ch, ...a]), setWindowOpenHandler() {}, toggleDevTools() {} });
  }
  getNativeWindowHandle() { return Buffer.alloc(8); }
  maximize() { this.show(); }
  show() { if (!this.visible) { this.visible = true; this.emit('show'); } }
  hide() { if (this.visible) { this.visible = false; this.emit('hide'); } }
  focus() {} restore() { this.minimized = false; }
  isVisible() { return this.visible; } isMinimized() { return this.minimized; } isFocused() { return this.focused; }
  isFullScreen() { return false; } isMaximized() { return false; }
  getNormalBounds() { return { x: 10, y: 10, width: 1200, height: 800 }; }
  loadFile() {}
}
class FakeTray extends EventEmitter {
  constructor() { super(); tray = this; this.tips = []; }
  setToolTip(t) { this.tips.push(t); } setContextMenu(m) { this.menu = m; } displayBalloon() {} destroy() {}
}
class FakeNotification extends EventEmitter {
  constructor(o) { super(); this.o = o; notifications.push(this); }
  show() { this.shown = true; }
  static isSupported() { return true; }
}
const electron = {
  app: Object.assign(new EventEmitter(), {
    isPackaged: false, getPath: (n) => (n === 'userData' ? userData : tmp), requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), setAppUserModelId() {}, quit() {}, exit() {},
    getLoginItemSettings: () => ({}), setLoginItemSettings() {},
  }),
  BrowserWindow: FakeWindow, Tray: FakeTray, Notification: FakeNotification,
  ipcMain: { handle: (n, fn) => { handlers[n] = fn; }, on: (n, fn) => { handlers[n] = fn; } },
  shell: { writeShortcutLink() {} },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  Menu: { setApplicationMenu() {}, buildFromTemplate: (t) => t },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({}) },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }), getAllDisplays: () => [] },
  globalShortcut: { register: () => true, unregisterAll() {} },
};
const B = String.fromCharCode(92);
const procs = new Map([[1001, 'main'], [1002, 'personal'], [1003, 'studio']]);
const win32 = {
  hwndFromBuffer: () => 1, dpiScale: () => 1, findAppWindow: (pid) => (procs.has(pid) ? pid * 10 : null),
  dock: () => ({}), undock() {}, place() {}, hide() {}, show() {}, restore() {}, focus() {},
  isWindow: (h) => procs.has(h / 10), isVisible: () => false, hasVisibleStyle: () => false, isHung: () => false,
  isZoomedOrMinimized: () => false, windowRect: () => ({ x: 0, y: 0, width: 800, height: 600 }), clientOrigin: () => ({ x: 0, y: 0 }),
  focusedWindow: () => 0, contains: () => false, askToQuit: () => true,
};
const exe = ['C:', 'Program Files', 'WindowsApps', 'Claude_4.4212.0.0_x64__pzs8sxrjxfjjc', 'app', 'Claude.exe'].join(B);
const cp = {
  spawn: () => { throw new Error('nothing may be launched in this test'); },
  spawnSync: () => ({ error: new Error('no') }),
  execFile: (cmd, args, opts, cb) => setImmediate(() => {
    if (/Get-CimInstance/.test(args.join(' '))) {
      return cb(null, [...procs].map(([pid, id]) => `${pid}\t${exe}\t${exe} --disable-direct-composition${id === 'main' ? '' : ` --user-data-dir=${path.join(LOCAL, 'Claude-Profiles', id)}`}`).join('\n'));
    }
    if (/Get-AppxPackage/.test(args.join(' '))) return cb(null, '4.4212.0.0\tOk\n');
    cb(new Error(`unexpected execFile ${cmd}`));
  }),
};
process.kill = () => { throw new Error('no process.kill in this test'); };
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'electron') return electron;
  if (req === 'child_process') return cp;
  if (/lib[\\/]win32$/.test(req)) return win32;
  return origLoad.apply(this, arguments);
};

const ev = () => ({ sender: win.webContents });
const pushes = () => win.webContents.sent.filter(([ch]) => ch === 'sessions').map(([, s]) => s);
const lastPush = () => pushes()[pushes().length - 1];
const notices = () => win.webContents.sent.filter(([ch]) => ch === 'notice').map(([, n]) => n);
async function until(what, fn, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await vsleep(250); }
  throw new Error(`timed out waiting for: ${what}`);
}
const ok = (m) => console.log('ok', m);

// ---------- search-specific additions (appended to the mc-needs harness base) ----------
// Launches are recorded, never run: each one "spawns" at once.
const launches = [];
cp.spawn = (cmd, args, opts) => {
  launches.push({ cmd, args, env: opts && opts.env });
  const child = new EventEmitter();
  child.unref = () => {};
  setImmediate(() => child.emit('spawn'));
  return child;
};
const shortcuts = {};
electron.globalShortcut.register = (accel, fn) => { shortcuts[accel] = fn; return true; };

// Sessions to find: titles, an earlier title, a summary, a wrap-up, a model, and a first prompt in a transcript.
writeSession('main', U(11), { title: 'Acme Spend', previousTitles: ['Company card spend tracker webapp'], shellFolders: ['D:\\Claud\\acme-spend'], postTurnSummary: { status_category: 'completed', status_detail: 'CSV export now matches the ledger' }, model: 'claude-opus-5-5', lastActivityAt: Date.now() - 2 * MIN });
writeSession('personal', U(12), { title: 'Teashop site', turnWrapUp: { description: 'Product page hero redone with the matcha origin story' }, model: 'claude-sonnet-4-5-20250929', lastActivityAt: Date.now() - 5 * MIN });
writeSession('personal', U(13), { title: 'Old backup notes', isArchived: true, lastActivityAt: Date.now() - 3 * 24 * 60 * MIN });
writeSession('studio', U(14), { title: 'Server hardening', lastActivityAt: Date.now() - 9 * MIN });
writeTranscript(U(12), [
  { type: 'user', isMeta: true, message: { content: '<system-reminder>ignore me</system-reminder>' }, timestamp: new Date().toISOString() },
  { type: 'user', message: { content: [{ type: 'text', text: 'Remake the Shopify theme for my friend\'s ceremonial grade tea brand' }] }, timestamp: new Date().toISOString() },
  { type: 'assistant', message: { stop_reason: 'end_turn', content: [] }, timestamp: new Date().toISOString() },
]);
const linkOf = (l) => l.args.find((a) => a.startsWith('claude://'));
const dirOf = (l) => (l.args.find((a) => a.startsWith('--user-data-dir=')) || '').slice('--user-data-dir='.length) || null;
const lastStatus = () => { const s = win.webContents.sent.filter(([c]) => c === 'status').pop(); return s ? s[1] : {}; };

(async () => {
  require(path.join(ROOT, 'main.js'));
  while (!win || !handlers['search:query']) await vsleep(100);
  win.show();
  await until('first sessions push', () => pushes().length > 0);
  await until('all docked', () => Object.values(lastStatus()).length === 3 && Object.values(lastStatus()).every((x) => x.status === 'docked'));
  const q = (text, sender = ev()) => handlers['search:query'](sender, text);

  // IPC guard and argument checks.
  assert.deepStrictEqual(await q('spend', { sender: {} }), [], 'other senders get nothing');
  assert.deepStrictEqual(await q(42), []);
  assert.deepStrictEqual(await q(null), []);
  assert.deepStrictEqual(await q('x'.repeat(201)), []);
  ok('search:query: guarded and validated');

  let r = await q('spend tracker');
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual(Object.keys(r[0]).sort(), ['accountId', 'archived', 'at', 'folder', 'sessionId', 'snippet', 'title']);
  assert.deepStrictEqual([r[0].accountId, r[0].sessionId, r[0].title, r[0].folder, r[0].snippet], ['main', `local_${U(11)}`, 'Acme Spend', 'acme-spend', 'Was “Company card spend tracker webapp”']);
  r = await q('LEDGER');
  assert.strictEqual(r[0].title, 'Acme Spend');
  assert(/ledger/.test(r[0].snippet), r[0].snippet);
  r = await q('matcha');
  assert.deepStrictEqual(r.map((x) => x.title), ['Teashop site'], 'found by its wrap-up');
  r = await q('sonnet 4.5');
  assert.deepStrictEqual(r.map((x) => x.title), ['Teashop site'], 'found by model name');
  r = await q('personal teashop');
  assert.deepStrictEqual(r.map((x) => [x.accountId, x.title]).sort(), [['personal', 'Teashop'], ['personal', 'Teashop site']], 'account name narrows');
  await vsleep(12000); // the index rebuilds at most every 10 s; the first prompt is read in the background
  r = await q('ceremonial tea');
  assert.deepStrictEqual(r.map((x) => x.title), ['Teashop site'], 'found by its first prompt');
  assert(/ceremonial/.test(r[0].snippet), r[0].snippet);
  r = await q('backup');
  assert.deepStrictEqual([r[0].title, r[0].archived], ['Old backup notes', true]);
  r = await q('');
  assert(r.length && r.every((x) => !x.archived), 'empty query: latest sessions, archived left out');
  ok('ranking: title, earlier title, summary, wrap-up, model, account, first prompt; archived flagged; empty = recent');

  // A new session shows up without a restart (the attention poll refreshes the index).
  writeSession('studio', U(15), { title: 'Storefront nightly job', lastActivityAt: Date.now() });
  await vsleep(12000);
  r = await q('storefront');
  assert.deepStrictEqual(r.map((x) => [x.accountId, x.title]), [['studio', 'Storefront nightly job']]);
  ok('index picks up new sessions');

  // Opening: validation.
  const open = (id, sid, sender = ev()) => handlers['search:open'](sender, id, sid);
  assert.deepStrictEqual(await open('personal', `local_${U(12)}`, { sender: {} }), { ok: false });
  assert.deepStrictEqual(await open('nobody', `local_${U(12)}`), { ok: false });
  assert.deepStrictEqual(await open('personal', 'local_../../x'), { ok: false });
  assert.deepStrictEqual(await open('personal', `local_${U(12)}&x=1`), { ok: false });
  assert.deepStrictEqual(await open('personal', 42), { ok: false });
  // A session of Personal asked for in Work: never sent to Work's copy.
  let res = await open('main', `local_${U(12)}`);
  assert.strictEqual(res.ok, false);
  assert(/isn't in Work/.test(res.error), res.error);
  assert.strictEqual(launches.length, 0, 'nothing launched for bad input');
  ok('search:open: guarded; ids checked; a session only opens in its own account');

  // A running extra account: its own --user-data-dir and the link; its tab shows.
  res = await open('personal', `local_${U(12)}`);
  assert.deepStrictEqual(res, { ok: true, opened: true });
  assert.strictEqual(launches.length, 1);
  let l = launches[0];
  assert(/claude-desktop\.exe$/.test(l.cmd));
  assert.strictEqual(linkOf(l), `claude://code/continue?session=local_${U(12)}`);
  assert.strictEqual(path.resolve(dirOf(l)), path.resolve(path.join(LOCAL, 'Claude-Profiles', 'personal')));
  assert(l.args.includes('--disable-direct-composition'));
  let ui = win.webContents.sent.filter(([c]) => c === 'ui').pop()[1];
  assert.deepStrictEqual([ui.panes[0], ui.home], ['personal', false]);
  ok('open in Personal: launched with its own data folder and the link; tab shown');

  // The main account: no --user-data-dir.
  res = await open('main', `local_${U(11)}`);
  assert.deepStrictEqual(res, { ok: true, opened: true });
  l = launches[1];
  assert.strictEqual(dirOf(l), null);
  assert.strictEqual(linkOf(l), `claude://code/continue?session=local_${U(11)}`);
  ok('open in Work (main): no --user-data-dir');

  // Archived: not sent (Claude would only show Code's home); the tab shows.
  res = await open('personal', `local_${U(13)}`);
  assert.deepStrictEqual(res, { ok: true, opened: false });
  assert.strictEqual(launches.length, 2);
  ui = win.webContents.sent.filter(([c]) => c === 'ui').pop()[1];
  assert.strictEqual(ui.panes[0], 'personal');
  ok('archived: only the tab is shown');

  // A stopped account: started once, with the link (showAccount must not launch a second copy).
  procs.delete(1003);
  await until('studio stopped', () => lastStatus().studio && lastStatus().studio.status === 'stopped');
  const before = launches.length;
  res = await open('studio', `local_${U(14)}`);
  assert.deepStrictEqual(res, { ok: true, opened: true });
  assert.strictEqual(launches.length, before + 1, 'launched once');
  assert.strictEqual(linkOf(launches[before]), `claude://code/continue?session=local_${U(14)}`);
  assert.strictEqual(path.resolve(dirOf(launches[before])), path.resolve(path.join(LOCAL, 'Claude-Profiles', 'studio')));
  const st = lastStatus().studio;
  assert.strictEqual(st.status, 'starting');
  assert.strictEqual(st.exit, null, 'a pending reopen is replaced');
  await vsleep(8000);
  assert.strictEqual(launches.length, before + 1, 'the reopen timer did not launch another copy');
  ok('stopped account: started once with the link, pending reopen cancelled');

  // Ctrl+Alt+K (registered while focused) and the tray's Search… open the switcher with the page focused.
  win.emit('focus');
  assert(shortcuts['Control+Alt+K'], 'Ctrl+Alt+K registered');
  let focused = 0;
  win.webContents.focus = () => { focused++; };
  const sent = () => win.webContents.sent.filter(([c]) => c === 'open-switcher').length;
  shortcuts['Control+Alt+K']();
  assert.deepStrictEqual([sent(), focused], [1, 1]);
  const item = tray.menu.find((m) => m.label === 'Search…');
  assert(item, 'tray menu has Search…');
  item.click();
  assert.deepStrictEqual([sent(), focused], [2, 2]);
  ok('Ctrl+Alt+K and the tray item open the switcher and give the page the keyboard');

  console.log('\nall passed');
  process.exit(0);
})().catch((err) => { console.error('FAILED:', err); process.exit(1); });
