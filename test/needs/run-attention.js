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

(async () => {
  require(path.join(ROOT, 'main.js'));
  while (!win || !handlers['state:get']) await vsleep(100);
  win.show();
  await until('first sessions push', () => pushes().length > 0);
  let p = lastPush();
  assert.strictEqual(p.personal.waiting, 1);
  assert.deepStrictEqual(p.personal.items[0], { sessionId: `local_${U(4)}`, title: 'Teashop', folder: 'Claud', state: 'waiting', kind: 'permission', detail: 'Wants to use Bash', at: p.personal.items[0].at, key: `p:${RID(1)}` });
  assert.deepStrictEqual(p.main.usage && [p.main.usage.fiveHour, p.main.usage.weekly], [60, 52]);
  assert.strictEqual(p.studio.usage.fiveHour, 0, 'a sample older than 5 h means that window has reset');
  assert.strictEqual(notices().length, 0, 'what was already waiting at startup is not announced');
  assert.strictEqual(await handlers['sessions:get']({ sender: {} }), null, 'other senders get nothing');
  assert.deepStrictEqual(await handlers['sessions:get'](ev()), p);
  assert(tray.tips.includes('Kitsun · 1 session needs you'), `tray tip: ${tray.tips}`);
  ok('startup: pending prompt is waiting, usage per account, no notice, IPC guarded, tray tip');

  // A new prompt in Studio (not on screen): a toast with Show; no Windows notification while Kitsun is in front.
  writeSession('studio', U(5), { title: 'Studio server hardening' });
  logLine('studio', `Emitted tool permission request ${RID(2)} for AskUserQuestion in session local_${U(5)}`);
  await until('studio notice', () => notices().some((n) => n.kind === 'needs-you'));
  let n = notices().find((x) => x.kind === 'needs-you');
  assert.deepStrictEqual(n, { text: 'Studio needs you · Studio server hardening: Has a question for you', id: 'studio', kind: 'needs-you', action: { label: 'Show', id: 'studio' } });
  assert.strictEqual(notifications.length, 0);
  assert.strictEqual(lastPush().studio.waiting, 1);
  ok('background account: toast with Show, no Windows notification while focused');

  // Answered, then asked again 10 s later: the same waiting period, no second notice.
  logLine('studio', `Received permission response for ${RID(2)}: once (tool: AskUserQuestion)`);
  await until('studio no longer waiting', () => lastPush().studio.waiting === 0);
  await vsleep(10000);
  logLine('studio', `Emitted tool permission request ${RID(3)} for Bash in session local_${U(5)}`);
  await until('studio waiting again', () => lastPush().studio.waiting === 1);
  await vsleep(6000);
  assert.strictEqual(notices().filter((x) => x.kind === 'needs-you').length, 1, 'one notice per waiting period');
  ok('debounce: a second prompt within the same waiting period is not announced again');

  // Aborted, quiet for over a minute, then a new prompt while Kitsun is in the background: Windows notification.
  logLine('studio', `Permission request ${RID(3)} for Bash aborted`);
  await until('studio clear', () => lastPush().studio.waiting === 0);
  await vsleep(70000);
  win.focused = false;
  logLine('studio', `Emitted tool permission request ${RID(4)} for ExitPlanMode in session local_${U(5)}`);
  await until('second notice', () => notices().filter((x) => x.kind === 'needs-you').length === 2);
  assert.strictEqual(notices().filter((x) => x.kind === 'needs-you')[1].text, 'Studio needs you · Studio server hardening: Wants you to approve its plan');
  await until('windows notification', () => notifications.length === 1);
  assert(notifications[0].shown && /Studio needs you/.test(notifications[0].o.body));
  notifications[0].emit('click');
  assert.deepStrictEqual(handlers['state:get'](ev()).ui.panes[0], 'studio', 'clicking it shows that account');
  win.focused = true;
  ok('new waiting period: notices again; Windows notification while unfocused; click shows the account');

  // On screen: a prompt in the account being looked at says nothing.
  const before = notices().length;
  writeSession('studio', U(6), { title: 'Second' });
  logLine('studio', `Emitted tool permission request ${RID(5)} for Bash in session local_${U(6)}`);
  await until('studio two waiting', () => lastPush().studio.waiting === 2);
  await vsleep(6000);
  assert.strictEqual(notices().length, before, 'no notice for the account on screen');
  ok('account on screen: no notice');

  // Setting off: a new waiting session in a background account says nothing.
  await handlers['settings:set'](ev(), { notifyNeedsYou: false });
  writeSession('main', U(7), { title: 'Report', lastTurnEdgeAt: Date.now(), lastFocusedAt: Date.now() - MIN, completedTurns: 1, lastAssistantUuid: 'a1', postTurnSummaryFor: 'a1', postTurnSummary: { status_category: 'blocked', needs_action: 'Which sheet should I use?' } });
  await until('main waiting by summary', () => lastPush().main.waiting === 1);
  assert.strictEqual(lastPush().main.items[0].detail, 'Which sheet should I use?');
  await vsleep(6000);
  assert.strictEqual(notices().length, before, 'notifyNeedsYou off');
  await handlers['settings:set'](ev(), { notifyNeedsYou: true });
  ok('summary-based waiting; notifyNeedsYou off: no notice');

  // Showing Work (Kitsun in front) marks what it shows as seen: the summary-based wait and a finished turn go.
  writeSession('main', U(8), { title: 'Done thing', lastTurnEdgeAt: Date.now(), lastFocusedAt: Date.now() - 5 * MIN, completedTurns: 4, lastAssistantUuid: 'b', turnWrapUp: { description: 'Shipped it.' } });
  await until('main unseen', () => lastPush().main.unseen === 1);
  assert.strictEqual(lastPush().main.items.find((x) => x.state === 'unseen').detail, 'Shipped it.');
  await handlers['ui:show-account'](ev(), 'main');
  await until('main seen', () => lastPush().main.unseen === 0 && lastPush().main.waiting === 0);
  ok('finished-unseen; showing the account (focused) marks it and the summary wait as seen');

  // Working: a transcript that ends mid-turn, written just now, in a running account.
  writeSession('personal', U(9), { title: 'Busy' });
  writeTranscript(U(9), [
    { type: 'user', message: { content: 'go' } },
    { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
  ]);
  await until('personal working', () => lastPush().personal.working === 1);
  assert.strictEqual(lastPush().personal.items.find((x) => x.state === 'working').title, 'Busy');
  writeTranscript(U(9), [{ type: 'assistant', message: { stop_reason: 'end_turn', content: [] } }, { type: 'system', subtype: 'stop_hook_summary' }]);
  writeSession('personal', U(9), { lastTurnEdgeAt: Date.now(), lastFocusedAt: Date.now() - MIN, completedTurns: 1, lastAssistantUuid: 'c' });
  await until('personal done', () => lastPush().personal.working === 0 && lastPush().personal.unseen === 1);
  ok('working from the transcript, then finished-unseen');

  // Limits: Work reaches 95% -> one notice naming the account with the most left, with Switch; then a reset.
  writePlan('main', [[30 * MIN, 40, 50], [16 * MIN, 60, 52], [0, 95, 60]]);
  await until('limit notice', () => notices().some((x) => x.kind === 'limit'));
  assert.deepStrictEqual(notices().filter((x) => x.kind === 'limit'), [{ text: 'Work is at 95% of its 5-hour limit · Studio has the most left (at 0%)', id: 'studio', kind: 'limit', action: { label: 'Switch', id: 'studio' } }]);
  writePlan('main', [[30 * MIN, 40, 50], [16 * MIN, 60, 52], [MIN, 95, 60], [0, 97, 61]]);
  await vsleep(8000);
  assert.strictEqual(notices().filter((x) => x.kind === 'limit').length, 1, 'once per window');
  writePlan('main', [[16 * MIN, 60, 52], [2 * MIN, 95, 60], [MIN, 97, 61], [0, 2, 61]]);
  await until('reset notice', () => notices().some((x) => x.kind === 'limit' && /reset/.test(x.text)));
  assert.deepStrictEqual(notices().filter((x) => x.kind === 'limit')[1], { text: 'Work\'s 5-hour limit has reset', id: 'main', kind: 'limit', action: null });
  ok('limit alert with the best other account and Switch; once per window; reset');

  // Weekly, and notifyLimits off.
  writePlan('personal', [[10 * MIN, 20, 30], [0, 25, 92]]);
  await until('weekly notice', () => notices().some((x) => x.kind === 'limit' && /weekly/.test(x.text)));
  assert.strictEqual(notices().find((x) => /weekly/.test(x.text)).text, 'Personal is at 92% of its weekly limit · Studio has the most left (at 10%)');
  await handlers['settings:set'](ev(), { notifyLimits: false });
  const nLimits = notices().filter((x) => x.kind === 'limit').length;
  writePlan('studio', [[MIN, 50, 10], [0, 96, 11]]);
  await vsleep(8000);
  assert.strictEqual(notices().filter((x) => x.kind === 'limit').length, nLimits, 'notifyLimits off');
  ok('weekly alert; notifyLimits off: nothing');

  // Pushes only on change.
  const count = pushes().length;
  await vsleep(15000);
  assert.strictEqual(pushes().length, count, 'no push without a change');
  ok('sessions pushed only when something changed');

  console.log('\nall attention tests passed');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
