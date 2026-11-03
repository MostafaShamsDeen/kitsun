// Loads main.js with Electron, win32, child_process and process.kill mocked, on a virtual clock (SPEED x faster),
// then exercises auto-restart, the update notice, the freeze watchdog and Stop. Nothing real is launched or killed.
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const { EventEmitter } = require('events');
const assert = require('assert');

// ---------- virtual clock ----------
const SPEED = 50;
const realNow = Date.now.bind(Date);
const realSetTimeout = setTimeout;
const realSetInterval = setInterval;
const T0 = realNow();
Date.now = () => T0 + (realNow() - T0) * SPEED;
global.setTimeout = (fn, ms = 0, ...a) => realSetTimeout(fn, Math.max(0, ms / SPEED), ...a);
global.setInterval = (fn, ms = 0, ...a) => realSetInterval(fn, Math.max(1, ms / SPEED), ...a);
const vsleep = (ms) => new Promise((r) => realSetTimeout(r, ms / SPEED)); // virtual ms

const ROOT = 'D:/Claud/multi-claude';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-health-'));
const LOCAL = path.join(tmp, 'local');
process.env.LOCALAPPDATA = LOCAL;
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
  ui: { panes: ['personal', 'main'], split: false, focused: 0, home: false },
  claudeVersion: '4.29.0.0',
}));

// ---------- fake Claude copies ----------
const B = String.fromCharCode(92);
const dataDir = (id) => (id === 'main' ? null : path.join(LOCAL, 'Claude-Profiles', id));
const logFile = (id) => (id === 'main' ? path.join(LOCAL, 'Claude', 'Logs', 'main.log') : path.join(dataDir(id), 'logs', 'main.log'));
const stamp = () => { const d = new Date(Date.now()); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const logLine = (id, msg) => { fs.mkdirSync(path.dirname(logFile(id)), { recursive: true }); fs.appendFileSync(logFile(id), `${stamp()} [info] ${msg}\n`); };

let version = '4.29.0.0';
let pkg = { version: '4.29.0.0', status: 'Ok' };
let nextPid = 1000;
const procs = new Map(); // pid -> { id, version, hwnd }
const hung = new Set();
const spawns = [];
const kills = [];
const asked = [];
let quitOnAsk = true;
// askTiming: { hwndGoneAt, exitAt } (virtual ms after the ask): Claude takes its window down before its process ends.
let askTiming = null;
// scanLag: the process list is read when asked for but answered this much later (virtual ms), like a slow PowerShell.
let scanLag = 0;
function addProc(id) {
  const pid = nextPid++;
  procs.set(pid, { id, version, hwnd: pid * 10 });
  logLine(id, 'Starting app {');
  return pid;
}
function removeProc(id) { for (const [pid, p] of procs) if (p.id === id) procs.delete(pid); }
const pidOf = (id) => [...procs].find(([, p]) => p.id === id)?.[0];
const exe = (v) => ['C:', 'Program Files', 'WindowsApps', `Claude_${v}_x64__pzs8sxrjxfjjc`, 'app', 'Claude.exe'].join(B);
const alias = ['C:', 'Users', 'x', 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'claude-desktop.exe'].join(B);
for (const id of ['main', 'personal', 'studio']) addProc(id);

// ---------- electron ----------
const handlers = {};
const appEvents = new EventEmitter();
let tray = null;
let win = null;
const notifications = [];
let dialogResponse = 0;
const dialogs = [];
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
FakeWindow.prototype.once = EventEmitter.prototype.once;
class FakeTray extends EventEmitter {
  constructor() { super(); tray = this; }
  setToolTip() {} setContextMenu(m) { this.menu = m; } displayBalloon() {} destroy() {}
}
class FakeNotification extends EventEmitter {
  constructor(o) { super(); this.o = o; notifications.push(this); }
  show() { this.shown = true; }
  static isSupported() { return true; }
}
const electron = {
  app: Object.assign(appEvents, {
    isPackaged: false, getPath: (n) => (n === 'userData' ? userData : tmp), requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), setAppUserModelId() {}, quit() {}, exit() {},
    getLoginItemSettings: () => ({}), setLoginItemSettings() {},
  }),
  BrowserWindow: FakeWindow, Tray: FakeTray, Notification: FakeNotification,
  ipcMain: { handle: (n, fn) => { handlers[n] = fn; }, on: (n, fn) => { handlers[n] = fn; } },
  shell: { writeShortcutLink() {} },
  dialog: { showMessageBox: async (_w, o) => { dialogs.push(o); return { response: dialogResponse }; } },
  Menu: { setApplicationMenu() {}, buildFromTemplate: (t) => t },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({}) },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }), getAllDisplays: () => [] },
  globalShortcut: { register: () => true, unregisterAll() {} },
};

// ---------- win32 ----------
const hwndAlive = (h) => [...procs.values()].some((p) => p.hwnd === h);
const win32 = {
  hwndFromBuffer: () => 1, dpiScale: () => 1,
  findAppWindow: (pid) => (procs.has(pid) ? procs.get(pid).hwnd : null),
  dock: () => ({ style: 0, exStyle: 0, rect: {}, wasMaximized: false }), undock() {},
  place() {}, hide() {}, show() {}, restore() {}, focus() {},
  isWindow: hwndAlive, isVisible: () => false, hasVisibleStyle: () => false, isHung: (h) => hung.has(h),
  isZoomedOrMinimized: () => false, windowRect: () => ({ x: 0, y: 0, width: 800, height: 600 }), clientOrigin: () => ({ x: 0, y: 0 }),
  focusedWindow: () => 0, contains: () => false,
  askToQuit: (h) => {
    asked.push(h);
    const pid = [...procs].find(([, p]) => p.hwnd === h)?.[0];
    if (quitOnAsk && pid) {
      const id = procs.get(pid).id;
      const t = askTiming || { exitAt: 3000 };
      if (t.hwndGoneAt) realSetTimeout(() => { const q = procs.get(pid); if (q) q.hwnd = -pid; }, t.hwndGoneAt / SPEED);
      realSetTimeout(() => { logLine(id, 'Windows session ending (close-app) - quitting the app'); logLine(id, 'beforeQuit: handler fired, going down'); procs.delete(pid); }, t.exitAt / SPEED);
    }
    return true;
  },
};

// ---------- child_process ----------
const cp = {
  spawn: (cmd, args) => {
    const child = new EventEmitter();
    child.unref = () => {};
    const m = args.find((a) => a.startsWith('--user-data-dir='));
    const id = m ? path.basename(m.slice(16)) : 'main';
    spawns.push(id);
    setImmediate(() => child.emit('spawn'));
    realSetTimeout(() => addProc(id), 2000 / SPEED); // Claude takes a moment to start
    return child;
  },
  spawnSync: () => ({ error: new Error('no') }),
  execFile: (cmd, args, opts, cb) => {
    const script = args.join(' ');
    setImmediate(() => {
      if (cmd === 'taskkill') {
        const pid = Number(args[1]);
        kills.push({ pid, force: args.includes('/F') });
        if (args.includes('/F')) procs.delete(pid);
        return cb(null, '');
      }
      if (/Get-AppxPackage/.test(script)) return cb(null, `${pkg.version}\t${pkg.status}\n`);
      if (/Get-CimInstance/.test(script)) {
        const list = [...procs].map(([pid, p]) => `${pid}\t${exe(p.version)}\t${alias} --disable-direct-composition${p.id === 'main' ? '' : ` --user-data-dir=${dataDir(p.id)}`}`).join('\n');
        if (scanLag) { realSetTimeout(() => cb(null, list), scanLag / SPEED); return; }
        return cb(null, list);
      }
      cb(new Error(`unexpected execFile ${cmd}`));
    });
  },
};
// Only the fake table: never signal a real process.
process.kill = (pid, sig) => {
  if (sig !== 0) throw new Error('process.kill with a real signal in a test');
  if (procs.has(pid)) return true;
  const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e;
};

const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'electron') return electron;
  if (req === 'child_process') return cp;
  if (/lib[\\/]win32$/.test(req)) return win32;
  return origLoad.apply(this, arguments);
};

const ev = () => ({ sender: win.webContents });
const status = (id) => handlers['state:get'](ev()).status[id];
const notices = () => win.webContents.sent.filter(([ch]) => ch === 'notice').map(([, n]) => n);
async function until(what, fn, ms = 300000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await vsleep(250); }
  throw new Error(`timed out waiting for: ${what}`);
}
const ok = (m) => console.log('ok', m);

(async () => {
  require(path.join(ROOT, 'main.js'));
  while (!win || !handlers['state:get']) await vsleep(100);
  await until('all docked', () => ['main', 'personal', 'studio'].every((id) => status(id).status === 'docked'));
  assert.strictEqual(spawns.length, 0, 'running copies are adopted, not launched');
  const s0 = status('personal');
  assert.deepStrictEqual(s0, { status: 'docked', error: null, running: true, frozen: false, exit: null });
  ok('startup: all three docked; payload ' + JSON.stringify(s0));

  // 1. Crash while Kitsun is hidden in the tray: noticed and reopened after ~5 s, with a notification.
  win.hide();
  removeProc('personal');
  await until('personal stopped (crash)', () => status('personal').exit && status('personal').exit.reason === 'crash');
  assert.strictEqual(status('personal').exit.reopening, true);
  const vanished = Date.now();
  await until('personal relaunched', () => spawns.includes('personal'));
  const delay = Date.now() - vanished;
  assert(delay > 3500 && delay < 9000, `restart after ~5 s, was ${delay}`);
  await until('personal docked again', () => status('personal').status === 'docked');
  assert.strictEqual(status('personal').exit, null);
  assert(notices().some((n) => n.kind === 'reopened' && /Personal's Claude closed unexpectedly · reopened it/.test(n.text)));
  assert(notifications.some((n) => n.shown && /reopened it/.test(n.o.body)), 'Windows notification while hidden');
  ok(`crash while hidden: reopened after ${Math.round(delay / 100) / 10}s, toast + Windows notification`);
  win.show();

  // 2. A plain quit from Claude's menu: never reopened.
  spawns.length = 0;
  logLine('studio', 'beforeQuit: handler fired, going down');
  logLine('studio', 'willQuit: handler is ready for quit, so quitting');
  removeProc('studio');
  await until('studio user', () => status('studio').exit && status('studio').exit.reason === 'user');
  await vsleep(20000);
  assert.strictEqual(spawns.length, 0, 'not reopened after a user quit');
  assert.deepStrictEqual(status('studio').exit, { reason: 'user', reopening: false, gaveUp: false });
  ok('user quit: not reopened, reason user');

  // 3. Windows shutdown: never reopened.
  await handlers['account:start'](ev(), 'studio');
  await until('studio docked', () => status('studio').status === 'docked');
  assert.strictEqual(status('studio').exit, null, 'Start clears the reason');
  spawns.length = 0;
  logLine('studio', 'Windows session ending (shutdown) - quitting the app');
  removeProc('studio');
  await until('studio shutdown', () => status('studio').exit && status('studio').exit.reason === 'shutdown');
  await vsleep(20000);
  assert.strictEqual(spawns.length, 0);
  ok('shutdown: not reopened');
  await handlers['account:start'](ev(), 'studio');
  await until('studio docked', () => status('studio').status === 'docked');

  // 4. Claude update: Windows closes every copy; Work installed it and reopens itself ~33 s later.
  spawns.length = 0;
  const before = notices().length;
  logLine('main', 'beforeQuitForUpdate handler fired, going down for update');
  for (const id of ['main', 'personal', 'studio']) logLine(id, 'Windows session ending (close-app) - quitting the app');
  for (const id of ['main', 'personal', 'studio']) removeProc(id);
  const updAt = Date.now();
  await until('all three update', () => ['main', 'personal', 'studio'].every((id) => status(id).exit && status(id).exit.reason === 'update' && status(id).exit.reopening));
  ok('update: all three classified update, reopening');
  // The package installs after ~25 s; Work comes back by itself at ~33 s.
  await vsleep(25000 - (Date.now() - updAt));
  assert.strictEqual(spawns.length, 0, 'nothing started while the update installs');
  version = '4.4212.0.0';
  pkg = { version, status: 'Ok' };
  await vsleep(33000 - (Date.now() - updAt));
  addProc('main');
  await until('personal + studio reopened', () => spawns.includes('personal') && spawns.includes('studio'));
  await until('all docked after update', () => ['main', 'personal', 'studio'].every((id) => status(id).status === 'docked'));
  assert(!spawns.includes('main'), 'Work reopened itself; Kitsun did not launch a second one');
  await until('update notice', () => notices().slice(before).some((n) => n.kind === 'update'));
  const upd = notices().slice(before).find((n) => n.kind === 'update');
  assert.strictEqual(upd.text, 'Claude updated to 4.4212 · reopened Personal and Studio');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(userData, 'profiles.json'), 'utf8')).claudeVersion, '4.4212.0.0');
  ok(`update: "${upd.text}" ${Math.round((Date.now() - updAt) / 1000)}s after the close; Work not double-launched`);

  // 5. Logs that can't be read: two copies closing within 15 s still count as an update.
  fs.rmSync(logFile('personal'));
  fs.rmSync(logFile('studio'));
  spawns.length = 0;
  removeProc('personal');
  await vsleep(4000);
  removeProc('studio');
  await until('both update', () => ['personal', 'studio'].every((id) => status(id).exit && status(id).exit.reason === 'update'));
  await until('both reopened', () => spawns.includes('personal') && spawns.includes('studio'), 400000);
  await until('docked', () => ['personal', 'studio'].every((id) => status(id).status === 'docked'));
  ok('unreadable logs, two closing together: treated as an update and reopened');

  // 6. The limit: Personal has been reopened 3 times within 10 minutes, so the next crash gives up.
  spawns.length = 0;
  removeProc('personal');
  await until('gave up', () => status('personal').exit && status('personal').exit.gaveUp);
  await vsleep(15000);
  assert.strictEqual(spawns.length, 0);
  assert.deepStrictEqual(status('personal').exit, { reason: 'crash', reopening: false, gaveUp: true });
  ok('limit: 4th close within 10 minutes is not reopened (gaveUp)');
  await handlers['account:start'](ev(), 'personal');
  await until('docked', () => status('personal').status === 'docked');

  // 7. autoRestart off: a crash is not reopened.
  await handlers['settings:set'](ev(), { autoRestart: false });
  spawns.length = 0;
  removeProc('studio');
  await until('studio crash', () => status('studio').exit && status('studio').exit.reason === 'crash');
  await vsleep(15000);
  assert.strictEqual(spawns.length, 0);
  assert.strictEqual(status('studio').exit.reopening, false);
  await handlers['settings:set'](ev(), { autoRestart: true });
  ok('autoRestart off: not reopened');
  await handlers['account:start'](ev(), 'studio');
  await until('docked', () => status('studio').status === 'docked');

  // 8. Freeze watchdog.
  const ph = procs.get(pidOf('personal')).hwnd;
  hung.add(ph);
  await vsleep(15000);
  assert.strictEqual(status('personal').frozen, false, 'not frozen before 20 s');
  await until('frozen', () => status('personal').frozen);
  assert(notices().some((n) => n.kind === 'frozen' && n.id === 'personal' && n.text === 'Personal isn\'t responding'));
  ok('freeze: marked frozen after 20 s, toast sent');
  await handlers['account:wait'](ev(), 'personal');
  assert.strictEqual(status('personal').frozen, false);
  await vsleep(30000);
  assert.strictEqual(status('personal').frozen, false, 'Wait holds for a minute');
  await until('frozen again', () => status('personal').frozen);
  hung.delete(ph);
  await until('recovered', () => !status('personal').frozen);
  assert(notices().some((n) => n.kind === 'recovered' && n.id === 'personal'));
  ok('freeze: Wait hides it for a minute; recovery clears it');
  hung.add(ph);
  await until('frozen 3', () => status('personal').frozen);
  dialogResponse = 1;
  const cancelled = await handlers['account:restart-frozen'](ev(), 'personal');
  assert(cancelled.cancelled && procs.has(pidOf('personal')));
  assert(/Claude Code session/.test(dialogs[dialogs.length - 1].detail));
  dialogResponse = 0;
  spawns.length = 0;
  kills.length = 0;
  const oldPid = pidOf('personal');
  const r8 = await handlers['account:restart-frozen'](ev(), 'personal');
  assert(r8.ok, JSON.stringify(r8));
  assert.deepStrictEqual(kills, [{ pid: oldPid, force: true }]);
  assert(spawns.includes('personal'));
  await until('docked after freeze restart', () => status('personal').status === 'docked');
  await vsleep(10000);
  assert.strictEqual(spawns.filter((s) => s === 'personal').length, 1, 'our kill is not taken for a crash');
  ok('freeze restart: confirm (cancel keeps it), taskkill /T /F, started once');
  // The main account's confirmation warns about Claude Code.
  hung.add(procs.get(pidOf('main')).hwnd);
  await until('main frozen', () => status('main').frozen);
  dialogResponse = 1;
  await handlers['account:restart-frozen'](ev(), 'main');
  assert(/main Claude app/.test(dialogs[dialogs.length - 1].detail) && /Claude Code session/.test(dialogs[dialogs.length - 1].detail));
  hung.delete(procs.get(pidOf('main')).hwnd);
  await until('main recovered', () => !status('main').frozen);
  ok('main account frozen: confirmation names the main app and Claude Code sessions');

  // 9. Stop: graceful (WM_ENDSESSION), stays stopped, tab click doesn't start it, Start does.
  spawns.length = 0;
  kills.length = 0;
  const r9 = await handlers['account:stop'](ev(), 'studio');
  assert(r9.ok, JSON.stringify(r9));
  assert.strictEqual(asked.length, 1);
  assert.strictEqual(kills.length, 0, 'no taskkill for a clean stop');
  assert.deepStrictEqual(status('studio').exit, { reason: 'stopped', reopening: false, gaveUp: false });
  assert.strictEqual(status('studio').status, 'stopped');
  await vsleep(15000);
  handlers['ui:show-account'](ev(), 'studio');
  await vsleep(3000);
  assert.strictEqual(spawns.length, 0, 'stopped by the user: not started by a tab click or auto-restart');
  assert(tray.menu.find((m) => m.label === 'Stop').submenu.find((m) => m.label === 'Studio…').enabled === false);
  await handlers['account:start'](ev(), 'studio');
  await until('studio docked', () => status('studio').status === 'docked');
  assert(tray.menu.find((m) => m.label === 'Stop').submenu.find((m) => m.label === 'Studio…').enabled === true);
  ok('stop: clean quit, stays stopped, tab click does not start it, Start does; tray Stop item follows');

  // 10. Stop that doesn't take: stillRunning, then force.
  quitOnAsk = false;
  const r10 = await handlers['account:stop'](ev(), 'studio');
  assert(!r10.ok && r10.stillRunning, JSON.stringify(r10));
  assert.strictEqual(status('studio').status, 'docked');
  assert.strictEqual(status('studio').exit, null);
  spawns.length = 0;
  const r10b = await handlers['account:stop'](ev(), 'studio', true);
  assert(r10b.ok);
  assert(kills.some((k) => k.force));
  assert.strictEqual(status('studio').exit.reason, 'stopped');
  await vsleep(15000);
  assert(!spawns.includes('studio'));
  ok('stop: no clean quit -> stillRunning; force -> taskkill /F, stays stopped');

  // 10b. Stop while a process list read before the exit is still on its way: stopped at once, not left 'stopping'.
  await handlers['account:start'](ev(), 'studio');
  await until('studio docked (10b)', () => status('studio').status === 'docked');
  quitOnAsk = true;
  askTiming = { hwndGoneAt: 1500, exitAt: 4500 };
  scanLag = 3000;
  const r10c = await handlers['account:stop'](ev(), 'studio');
  assert(r10c.ok, JSON.stringify(r10c));
  assert.strictEqual(status('studio').status, 'stopped', 'stopped once its exit is seen, whatever an older scan says');
  assert.strictEqual(status('studio').running, false);
  scanLag = 0;
  askTiming = null;
  await vsleep(6000);
  assert.strictEqual(status('studio').status, 'stopped');
  ok('stop with a stale scan in flight: stopped at once');

  // 10c. A crash of a copy started after a Stop is a crash, not that Stop (quitAskedAt cleared).
  spawns.length = 0;
  await handlers['account:start'](ev(), 'studio');
  await until('studio docked (10c)', () => status('studio').status === 'docked');
  removeProc('studio');
  await until('studio crash', () => status('studio').exit && status('studio').exit.reason !== undefined);
  assert.strictEqual(status('studio').exit.reason, 'crash', 'not taken for the earlier Stop');
  await until('studio reopened', () => status('studio').status === 'docked');
  ok('crash after a Stop and a new start: reopened as a crash');

  // 10d. Stop that can't ask: not responding, or no window yet. Nothing is sent or changed; the page is told so.
  const ch = procs.get(pidOf('studio')).hwnd;
  hung.add(ch);
  const askedBefore = asked.length;
  const r10d = await handlers['account:stop'](ev(), 'studio');
  assert(!r10d.ok && r10d.notAsked && r10d.reason === 'not responding' && !r10d.stillRunning, JSON.stringify(r10d));
  assert.strictEqual(asked.length, askedBefore, 'nothing sent');
  assert.strictEqual(status('studio').status, 'docked');
  assert.strictEqual(status('studio').exit, null);
  hung.delete(ch);
  procs.get(pidOf('studio')).hwnd = 0; // its window went; the process runs on
  await until('studio without a window', () => status('studio').status === 'starting');
  const r10e = await handlers['account:stop'](ev(), 'studio');
  assert(!r10e.ok && r10e.notAsked && r10e.reason === 'no window', JSON.stringify(r10e));
  assert.strictEqual(asked.length, askedBefore);
  procs.get(pidOf('studio')).hwnd = pidOf('studio') * 10;
  await until('studio docked (10d)', () => status('studio').status === 'docked');
  ok('stop that cannot ask: notAsked (not responding / no window), nothing sent');

  // 10e. Stop of a frozen account: a native confirmation in main (cancel keeps it), then taskkill /T /F; stays stopped.
  hung.add(procs.get(pidOf('studio')).hwnd);
  await until('studio frozen', () => status('studio').frozen);
  dialogResponse = 1;
  const r10f = await handlers['account:stop-frozen'](ev(), 'studio');
  assert(r10f.cancelled && procs.has(pidOf('studio')));
  assert(/Stop Studio\?/.test(dialogs[dialogs.length - 1].message) && /isn't responding/.test(dialogs[dialogs.length - 1].detail));
  dialogResponse = 0;
  kills.length = 0;
  spawns.length = 0;
  const cpid = pidOf('studio');
  const r10g = await handlers['account:stop-frozen'](ev(), 'studio');
  assert(r10g.ok, JSON.stringify(r10g));
  assert.deepStrictEqual(kills, [{ pid: cpid, force: true }]);
  assert.strictEqual(status('studio').status, 'stopped');
  assert.strictEqual(status('studio').exit.reason, 'stopped');
  await vsleep(15000);
  assert(!spawns.includes('studio'), 'not reopened');
  assert.strictEqual((await handlers['account:stop-frozen']({ sender: {} }, 'studio')).ok, false);
  ok('stop of a frozen account: native confirm, forced, stays stopped');

  // 10f. Restart of a frozen account while a stale scan is in flight: started again, not "still quitting".
  hung.add(procs.get(pidOf('personal')).hwnd);
  await until('personal frozen (10f)', () => status('personal').frozen);
  scanLag = 3000;
  const mp = procs.get(pidOf('main'));
  mp.hwnd = 0; // main's window goes for a moment: it is 'starting', so scans run every second (each answered late)
  await until('main starting', () => status('main').status === 'starting');
  await vsleep(1200);
  spawns.length = 0;
  const r10h = await handlers['account:restart-frozen'](ev(), 'personal');
  assert(r10h.ok, JSON.stringify(r10h));
  assert(spawns.includes('personal'));
  scanLag = 0;
  mp.hwnd = pidOf('main') * 10;
  await until('personal docked (10f)', () => status('personal').status === 'docked');
  await until('main docked (10f)', () => status('main').status === 'docked');
  ok('restart frozen with a stale scan in flight: started again');
  quitOnAsk = false;

  // 11. Tray Stop asks the page; IPC validation.
  tray.menu.find((m) => m.label === 'Stop').submenu.find((m) => m.label === 'Personal…').click();
  assert(win.webContents.sent.some(([ch, id]) => ch === 'request-stop' && id === 'personal'));
  assert.strictEqual((await handlers['account:stop']({ sender: {} }, 'personal')).ok, false);
  assert.strictEqual((await handlers['account:stop'](ev(), 'personal', 'yes')).ok, false);
  assert.strictEqual((await handlers['account:stop'](ev(), '../x')).ok, false);
  assert.strictEqual((await handlers['account:wait']({ sender: {} }, 'personal')).ok, false);
  assert.strictEqual((await handlers['account:restart-frozen'](ev(), 'nope')).ok, false);
  assert.strictEqual(status('personal').status, 'docked', 'nothing stopped by bad calls');
  ok('tray Stop -> request-stop; IPC rejects other senders, bad ids and bad force');

  // 12. Closing Kitsun: copies going away then are not reopened.
  appEvents.emit('before-quit');
  win.emit('close', { preventDefault() {} });
  spawns.length = 0;
  removeProc('personal');
  await vsleep(15000);
  assert.strictEqual(spawns.length, 0);
  ok('closing: nothing reopened');
  console.log('all ok');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
