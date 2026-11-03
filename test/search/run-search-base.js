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
