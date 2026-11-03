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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-att-main-'));
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
// ---------- Chrome-specific additions (appended to the mc-needs/mc-search harness base) ----------
// Chrome's files are fakes in the temp LOCALAPPDATA; chrome.exe is an empty file found through a mocked registry.
const launches = [];
cp.spawn = (cmd, args, opts) => {
  launches.push({ cmd, args, env: opts && opts.env, opts });
  const child = new EventEmitter();
  child.unref = () => {};
  setImmediate(() => child.emit('spawn'));
  return child;
};
process.env.CLAUDECODE = '1'; // must not reach Chrome
for (const k of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) process.env[k] = path.join(tmp, 'pf-' + k.length);
const chromeExe = path.join(tmp, 'Google Chrome', 'chrome.exe');
fs.mkdirSync(path.dirname(chromeExe), { recursive: true });
fs.writeFileSync(chromeExe, '');
const baseExec = cp.execFile;
cp.execFile = (cmd, args, opts, cb) => {
  if (cmd === 'reg.exe') {
    return setImmediate(() => (args[1].startsWith('HKLM') ? cb(null, `\r\n${args[1]}\r\n    (Default)    REG_SZ    ${chromeExe}\r\n`) : cb(new Error('not found'), '')));
  }
  return baseExec(cmd, args, opts, cb);
};

// LevelDB log files, as Chrome writes them.
function vint(n) { const o = []; while (n >= 128) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); }
function batch(seq, ops) {
  const h = Buffer.alloc(12); h.writeUInt32LE(seq, 0); h.writeUInt32LE(ops.length, 8);
  return Buffer.concat([h, ...ops.flatMap(([t, k, v]) => [Buffer.from([t]), vint(Buffer.byteLength(k)), Buffer.from(k), ...(t === 1 ? [vint(Buffer.byteLength(v)), Buffer.from(v)] : [])])]);
}
function logRecords(batches) {
  return Buffer.concat(batches.map((b) => { const h = Buffer.alloc(7); h.writeUInt16LE(b.length, 4); h[6] = 1; return Buffer.concat([h, b]); }));
}
const UD = path.join(LOCAL, 'Google', 'Chrome', 'User Data');
const uuidOf = { main: '438f5f8e-9c89-4d6b-a11e-d87f5f0179bc', personal: '512a5ff6-4cdb-45e7-ac48-5465ae391332', studio: '98117410-4545-4247-a9dd-19201f55b931' };
for (const id of Object.keys(uuidOf)) fs.writeFileSync(path.join(dataDir(id), 'config.json'), JSON.stringify({ lastKnownAccountUuid: uuidOf[id] }));
const extDb = (p) => path.join(UD, p, 'Local Extension Settings', 'fcoeoabgfenejglbffodgkkbkcdhcgfn');
const setDb = (p, batches) => { fs.mkdirSync(extDb(p), { recursive: true }); fs.writeFileSync(path.join(extDb(p), '000003.log'), logRecords(batches)); };
const localState = { profile: { profiles_order: ['Default', 'Profile 4', 'Profile 6'], info_cache: {
  'Default': { name: 'Private', user_name: 'me@example.com', active_time: 300 },
  'Profile 4': { name: 'Dev (Agency)', user_name: 'dev@example.com', active_time: 100 },
  'Profile 6': { name: 'Studio & Labs', user_name: 'labs@example.com', active_time: 200 },
} } };
const writeLocalState = () => { fs.mkdirSync(UD, { recursive: true }); fs.writeFileSync(path.join(UD, 'Local State'), JSON.stringify(localState)); };
writeLocalState();
const J = JSON.stringify;
setDb('Default', [batch(5, [[1, 'accountUuid', J(uuidOf.personal)]]), batch(9, [[1, 'tabGroups', '{}']])]);
// Profile 4: signed in as Personal first (consent record kept), then as Work. The newest record wins.
setDb('Profile 4', [batch(3, [[1, 'accountUuid', J(uuidOf.personal)], [1, 'permissionConsentByAccount', J({ [uuidOf.personal]: {} })]]), batch(40, [[1, 'accountUuid', J(uuidOf.main)]])]);
setDb('Profile 6', [batch(7, [[1, 'accountUuid', J(uuidOf.studio)]])]);

const chromePushes = () => win.webContents.sent.filter(([c]) => c === 'chrome').map(([, c]) => c);
const lastStatus = () => { const s = win.webContents.sent.filter(([c]) => c === 'status').pop(); return s ? s[1] : {}; };
const savedState = () => JSON.parse(fs.readFileSync(path.join(userData, 'profiles.json'), 'utf8'));
const acc = (id) => savedState().accounts.find((a) => a.id === id);
const save = (input, sender = ev()) => handlers['account:save'](sender, input);
const base = (id) => { const a = acc(id); return { id, name: a.name, color: a.color, shareCode: a.shareCode }; };
const fresh = async () => { await vsleep(6000); return handlers['chrome:get'](ev()); }; // past the snapshot reuse window

// Bad stored values can't break startup: sanitizeState keeps only a profile folder name's shape.
{
  const s = JSON.parse(fs.readFileSync(path.join(userData, 'profiles.json'), 'utf8'));
  s.accounts[0].chromeProfile = '..\\..\\Windows';
  s.accounts[1].chromeProfile = 42;
  s.accounts[2].chromeProfile = 'Profile 6';
  fs.writeFileSync(path.join(userData, 'profiles.json'), JSON.stringify(s));
}

(async () => {
  require(path.join(ROOT, 'main.js'));
  {
    while (!win || !handlers['state:get']) await vsleep(100);
    const st = await handlers['state:get'](ev());
    assert.deepStrictEqual(st.accounts.map((a) => a.chromeProfile), [null, null, 'Profile 6']);
    assert(await handlers['account:save'](ev(), { ...st.accounts[2], chromeProfile: null }));
    ok('sanitizeState: bad stored chromeProfile values become automatic');
  }
  while (!win || !handlers['chrome:get']) await vsleep(100);
  win.show();
  await until('all docked', () => Object.values(lastStatus()).length === 3 && Object.values(lastStatus()).every((x) => x.status === 'docked'));
  await until('first chrome push', () => chromePushes().length > 0);

  // Guards.
  assert.strictEqual(await handlers['chrome:get']({ sender: {} }), null, 'other senders get nothing');
  assert.deepStrictEqual(await handlers['chrome:open']({ sender: {} }, 'main'), { ok: false });
  assert.deepStrictEqual(await handlers['chrome:open'](ev(), 'nope'), { ok: false });
  assert.deepStrictEqual(await handlers['chrome:open'](ev(), { id: 'main' }), { ok: false });
  assert.strictEqual(launches.length, 0, 'nothing launched by bad calls');
  ok('IPC guards');

  // The mapping, using the newest record (Profile 4 also holds Personal's UUID, from before).
  let g = await handlers['chrome:get'](ev());
  assert.strictEqual(g.installed, true);
  assert.deepStrictEqual(g.profiles.map((p) => p.dir), ['Default', 'Profile 4', 'Profile 6']);
  assert.deepStrictEqual(Object.fromEntries(Object.entries(g.accounts).map(([id, l]) => [id, l.link && l.link.dir])), { main: 'Profile 4', personal: 'Default', studio: 'Profile 6' });
  assert.strictEqual(g.accounts.main.auto.how, 'signed-in');
  const flat = JSON.stringify(g);
  assert(!flat.includes('chrome.exe') && !flat.includes('Google Chrome'), 'no exe path in the payload');
  assert(!flat.includes(uuidOf.main), 'no account UUIDs in the payload');
  ok('mapping: Work -> Profile 4, Personal -> Default, Studio -> Profile 6; payload has no paths or UUIDs');

  // Opening: main's exe, the profile as one argument, detached, no Claude Code session variables.
  let r = await handlers['chrome:open'](ev(), 'studio');
  assert.deepStrictEqual(r, { ok: true, profile: 'Studio & Labs' });
  const l = launches.pop();
  assert.strictEqual(l.cmd, chromeExe);
  assert.deepStrictEqual(l.args, ['--profile-directory=Profile 6']);
  assert.strictEqual(l.opts.detached, true);
  assert.strictEqual(l.env.CLAUDECODE, undefined);
  ok('chrome:open starts chrome.exe --profile-directory=Profile 6, detached, clean env');

  // Tray submenu ('&' escaped); clicking opens Chrome without the page.
  const sub = tray.menu.find((m) => m.label === 'Open Chrome');
  assert(sub, 'tray has Open Chrome');
  assert.deepStrictEqual(sub.submenu.map((i) => i.label), ['Work · Dev (Agency)', 'Personal · Private', 'Studio · Studio && Labs']);
  sub.submenu[1].click();
  await until('tray launch', () => launches.length === 1);
  assert.deepStrictEqual(launches.pop().args, ['--profile-directory=Default']);
  ok('tray Open Chrome submenu');

  // Manual choice: validated against Local State; left out keeps it; null goes back to automatic.
  for (const bad of ['..', 'C:\\Windows', '..\\Profile 6', 'Profile 9', 42, {}, '']) {
    assert.strictEqual(await save({ ...base('studio'), chromeProfile: bad }), null, `rejects ${J(bad)}`);
  }
  assert.strictEqual(acc('studio').chromeProfile, null);
  assert.strictEqual(await save({ ...base('studio'), chromeProfile: 'Profile 4' }, { sender: {} }), null);
  assert(await save({ ...base('studio'), chromeProfile: 'Profile 4' }));
  assert.strictEqual(acc('studio').chromeProfile, 'Profile 4');
  g = await handlers['chrome:get'](ev());
  assert.deepStrictEqual(g.accounts.studio.link, { dir: 'Profile 4', name: 'Dev (Agency)', manual: true });
  assert.strictEqual(g.accounts.studio.auto.dir, 'Profile 6');
  assert(await save({ ...base('studio'), name: 'Studio 2' }));
  assert.strictEqual(acc('studio').chromeProfile, 'Profile 4', 'a save without chromeProfile keeps it');
  r = await handlers['chrome:open'](ev(), 'studio');
  assert.strictEqual(launches.pop().args[0], '--profile-directory=Profile 4');
  assert(await save({ id: 'newbie', name: 'New', color: '#888888', shareCode: true, chromeProfile: 'Default' }));
  assert.strictEqual(acc('newbie').chromeProfile, 'Default');
  ok('manual choice: bad values rejected, kept across saves, used by chrome:open');

  // A chosen profile Chrome no longer has: automatic again (and flagged), but the choice stays in profiles.json.
  delete localState.profile.info_cache['Profile 4'];
  writeLocalState();
  g = await fresh();
  assert.strictEqual(g.accounts.studio.missing, true);
  assert.strictEqual(g.accounts.studio.link.dir, 'Profile 6');
  assert.strictEqual(g.accounts.main.link, null, 'Work had only Profile 4');
  assert.strictEqual(acc('studio').chromeProfile, 'Profile 4');
  r = await handlers['chrome:open'](ev(), 'main');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.unlinked, true); assert(/No Chrome profile is linked to Work/.test(r.error));
  assert(await save({ ...base('studio'), chromeProfile: 'Profile 4' }), 'resaving the same (now missing) choice is allowed');
  assert(await save({ ...base('studio'), chromeProfile: null }));
  assert.strictEqual(acc('studio').chromeProfile, null);
  ok('missing chosen profile falls back to automatic; Work unlinked gives a clear error');

  // Sign-in changes are picked up by the poll and pushed.
  const pushesBefore = chromePushes().length;
  setDb('Profile 6', [batch(7, [[1, 'accountUuid', J(uuidOf.studio)]]), batch(50, [[1, 'accountUuid', J(uuidOf.personal)]])]);
  await until('chrome push after sign-in change', () => chromePushes().length > pushesBefore, 5 * MIN);
  g = chromePushes().pop();
  assert.strictEqual(g.accounts.studio.link, null);
  assert.strictEqual(g.accounts.personal.link.dir, 'Default', 'Default was used more recently');
  localState.profile.info_cache['Profile 6'].active_time = 999; writeLocalState();
  g = await fresh();
  assert.strictEqual(g.accounts.personal.link.dir, 'Profile 6', 'two profiles signed in: the one Chrome used last');
  // Signed out (a deletion): it still links to the account it was last signed in to, if no profile is signed in to that.
  setDb('Profile 6', [batch(7, [[1, 'accountUuid', J(uuidOf.studio)]]), batch(60, [[0, 'accountUuid']])]);
  g = await fresh();
  assert.deepStrictEqual(g.accounts.studio.auto, { dir: 'Profile 6', name: 'Studio & Labs', how: 'last-signed-in' });
  assert.strictEqual(g.accounts.personal.link.dir, 'Default');
  ok('sign-in changes pushed; ties go to the most recently used profile; signed-out keeps its last account');

  // No Chrome: the tray item goes; opening says so.
  fs.rmSync(chromeExe);
  g = await fresh();
  assert.strictEqual(g.installed, false);
  r = await handlers['chrome:open'](ev(), 'personal');
  assert(/isn't installed/.test(r.error));
  assert(!tray.menu.some((m) => m.label === 'Open Chrome'), 'no tray item without Chrome');
  ok('Chrome not installed');

  console.log('\nall passed');
  process.exit(0);
})().catch((err) => { console.error('FAILED:', err); process.exit(1); });
