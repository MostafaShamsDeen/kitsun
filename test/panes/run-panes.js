// Loads main.js with Electron, win32 and child_process mocked (temp LOCALAPPDATA / APPDATA / USERPROFILE), and checks
// the pane layouts: migration and sanitising of ui, ui:layout / ui:split / ui:focus-pane / ui:ratios, window placement
// for 1–3 panes, changed-only placement for divider drags, focus tracking, shortcuts, home, removal. Nothing real runs.
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const { EventEmitter } = require('events');
const assert = require('assert');

const ROOT = 'D:/Claud/multi-claude';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-panes-main-'));
const LOCAL = path.join(tmp, 'local');
process.env.LOCALAPPDATA = LOCAL;
process.env.APPDATA = path.join(tmp, 'roaming');
process.env.USERPROFILE = path.join(tmp, 'home');
process.env.HOME = process.env.USERPROFILE;
assert.strictEqual(os.homedir(), process.env.USERPROFILE);
fs.mkdirSync(path.join(LOCAL, 'Microsoft', 'WindowsApps'), { recursive: true });
fs.writeFileSync(path.join(LOCAL, 'Microsoft', 'WindowsApps', 'claude-desktop.exe'), '');
const userData = path.join(tmp, 'userData');
fs.mkdirSync(userData, { recursive: true });
// An old file: split on, right pane active, no layout or ratios. autoRestart off, so a closed copy stays closed.
fs.writeFileSync(path.join(userData, 'profiles.json'), JSON.stringify({
  accounts: [
    { id: 'main', name: 'Work', color: '#5b8def', main: true },
    { id: 'personal', name: 'Personal', color: '#d97757' },
    { id: 'studio', name: 'Studio', color: '#3fb68b' },
    { id: 'extra', name: 'Extra', color: '#c678dd' },
  ],
  ui: { panes: ['main', 'personal'], split: true, focused: 1, home: false },
  settings: { autoRestart: false },
}));
// --bad: junk stored values instead (a layout that doesn't exist / needs more accounts, repeats, bad ratios).
const BAD = process.argv.includes('--bad');
if (BAD) {
  fs.writeFileSync(path.join(userData, 'profiles.json'), JSON.stringify({
    accounts: [{ id: 'main', name: 'Work', color: '#5b8def', main: true }, { id: 'personal', name: 'Personal', color: '#d97757' }],
    // Three columns with two accounts, a removed account in the middle, the active pane on it, out-of-range ratios.
    ui: { layout: 'triple', panes: ['main', 'gone', 'personal'], split: false, focused: 2, splitRatio: 0.05, tripleRatios: [0.9, 0.05, 0.05], home: 'yes' },
    settings: { autoRestart: false },
  }));
}

// ---------- electron / win32 / child_process ----------
const handlers = {};
let win = null;
class FakeWindow extends EventEmitter {
  constructor() {
    super(); this.visible = false; this.minimized = false; this.focused = true; win = this;
    this.webContents = Object.assign(new EventEmitter(), { sent: [], send: (ch, ...a) => this.webContents.sent.push([ch, ...a]), setWindowOpenHandler() {}, toggleDevTools() {}, focus() {} });
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
class FakeTray extends EventEmitter { setToolTip() {} setContextMenu(m) { this.menu = m; } displayBalloon() {} destroy() {} }
class FakeNotification extends EventEmitter { show() {} static isSupported() { return true; } }
const shortcuts = {};
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
  globalShortcut: { register: (accel, fn) => { shortcuts[accel] = fn; return true; }, unregisterAll() {} },
};
const B = String.fromCharCode(92);
const procs = new Map([[1001, 'main'], [1002, 'personal'], [1003, 'studio'], [1004, 'extra']]);
const hwndOf = (id) => [...procs].find(([, x]) => x === id)?.[0] * 10;
const idOfHwnd = (h) => procs.get(h / 10);
const visible = new Set();
const placed = new Map(); // hwnd -> { x, y, width, height }
let places = [];
let focusHwnd = 0;
const win32 = {
  hwndFromBuffer: () => 1, dpiScale: () => 1, findAppWindow: (pid) => (procs.has(pid) ? pid * 10 : null),
  dock: () => ({}), undock() {}, restore() {}, focus: (h) => { focusHwnd = h; }, show: (h) => visible.add(h),
  place: (h, x, y, width, height, vis) => { places.push({ id: idOfHwnd(h), x, y, width, height }); placed.set(h, { x, y, width, height }); if (vis) visible.add(h); return true; },
  hide: (h) => { visible.delete(h); },
  isWindow: (h) => procs.has(h / 10), isVisible: (h) => visible.has(h), hasVisibleStyle: (h) => visible.has(h), isHung: () => false,
  isZoomedOrMinimized: () => false, windowRect: (h) => placed.get(h) || { x: 0, y: 0, width: 1, height: 1 }, clientOrigin: () => ({ x: 0, y: 0 }),
  focusedWindow: () => focusHwnd, contains: (p, h) => h !== 0 && h === p, askToQuit: () => true,
};
const exe = ['C:', 'Program Files', 'WindowsApps', 'Claude_4.4212.0.0_x64__pzs8sxrjxfjjc', 'app', 'Claude.exe'].join(B);
const launches = [];
const cp = {
  spawn: (cmd, args) => {
    launches.push(args.find((a) => a.startsWith('--user-data-dir=')) || 'main');
    const child = new EventEmitter(); child.unref = () => {}; setImmediate(() => child.emit('spawn')); return child;
  },
  spawnSync: () => ({ error: new Error('no') }),
  execFile: (cmd, args, opts, cb) => setImmediate(() => {
    if (/Get-CimInstance/.test(args.join(' '))) {
      return cb(null, [...procs].map(([pid, id]) => `${pid}\t${exe}\t${exe} --disable-direct-composition${id === 'main' ? '' : ` --user-data-dir=${path.join(LOCAL, 'Claude-Profiles', id)}`}`).join('\n'));
    }
    if (/Get-AppxPackage/.test(args.join(' '))) return cb(null, '4.4212.0.0\tOk\n');
    if (cmd === 'reg.exe' || cmd === 'reg') return cb(new Error('no reg in this test'));
    cb(new Error(`unexpected execFile ${cmd}`));
  }),
};
// Signal 0 only checks: a listed (fake) process exists, anything else is gone (main.js drops listed pids that are gone).
process.kill = (pid) => { if (procs.has(pid)) return true; throw Object.assign(new Error('gone'), { code: 'ESRCH' }); };
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'electron') return electron;
  if (req === 'child_process') return cp;
  if (/lib[\\/]win32$/.test(req)) return win32;
  return origLoad.apply(this, arguments);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = () => ({ sender: win.webContents });
const other = { sender: {} };
const lastStatus = () => { const s = win.webContents.sent.filter(([c]) => c === 'status').pop(); return s ? s[1] : {}; };
const uiPushes = () => win.webContents.sent.filter(([c]) => c === 'ui').map(([, u]) => u);
async function until(what, fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(50); }
  throw new Error(`timed out waiting for: ${what}`);
}
const ok = (m) => console.log('ok', m);
const RECTS3 = [{ x: 4, y: 72, width: 400, height: 600 }, { x: 412, y: 72, width: 380, height: 600 }, { x: 800, y: 72, width: 396, height: 600 }];
const shownIds = () => [...visible].map(idOfHwnd).sort();
const saved = () => JSON.parse(fs.readFileSync(path.join(userData, 'profiles.json'), 'utf8')).ui;

(async () => {
  // ---------- sanitizeState, without starting anything: the module is loaded once, so it is checked through state:get
  require(path.join(ROOT, 'main.js'));
  while (!win || !handlers['ui:layout']) await sleep(20);
  win.show();
  let st = await handlers['state:get'](ev());
  if (BAD) {
    const u = st.ui;
    assert.deepStrictEqual([u.layout, u.split, u.panes, u.home, u.splitRatio], ['split', true, ['main', 'personal', null], false, 0.2]);
    assert.strictEqual(u.focused, 1, 'the active pane follows Personal as the panes close up');
    assert(u.tripleRatios.every((x) => x >= 0.1 - 1e-9) && Math.abs(u.tripleRatios.reduce((s, x) => s + x) - 1) < 1e-9, String(u.tripleRatios));
    console.log('ok --bad: triple with 2 accounts -> split; removed id dropped and panes closed up; ratios clamped; home bool');
    console.log('\nall passed');
    process.exit(0);
  }
  assert.deepStrictEqual(
    { layout: st.ui.layout, panes: st.ui.panes, split: st.ui.split, focused: st.ui.focused, splitRatio: st.ui.splitRatio, tripleRatios: st.ui.tripleRatios },
    { layout: 'split', panes: ['main', 'personal', 'studio'], split: true, focused: 1, splitRatio: 0.5, tripleRatios: [1 / 3, 1 / 3, 1 / 3] },
  );
  assert.strictEqual(await handlers['state:get'](other), null);
  ok('old { split: true, focused: 1 } file migrates to layout split; third pane filled; default ratios');

  await until('all docked', () => Object.values(lastStatus()).length === 4 && Object.values(lastStatus()).every((x) => x.status === 'docked'));
  // The page sends rects for the shown panes.
  handlers['panes:rects'](ev(), RECTS3.slice(0, 2));
  assert.deepStrictEqual(shownIds(), ['main', 'personal']);

  // ---------- ui:layout guard and validation
  const layoutCall = (name, e = ev()) => handlers['ui:layout'](e, name);
  let ui = await layoutCall('triple', other);
  assert.strictEqual(ui.layout, 'split', 'other senders change nothing');
  for (const bad of ['quad', '', null, 3, { layout: 'triple' }, 'toString', '__proto__']) {
    ui = await layoutCall(bad);
    assert.strictEqual(ui.layout, 'split', `bad name ${String(bad)} changes nothing`);
  }
  ok('ui:layout: guarded, unknown names refused');

  // ---------- split -> triple: three windows placed at the three rects
  launches.length = 0;
  ui = await layoutCall('triple');
  assert.deepStrictEqual([ui.layout, ui.split, ui.panes, ui.focused, ui.home], ['triple', true, ['main', 'personal', 'studio'], 1, false]);
  places = [];
  handlers['panes:rects'](ev(), RECTS3);
  // Panes 1 and 2 kept their rects, so only the new third window is placed by the rects message.
  assert.deepStrictEqual(places.map((p) => [p.id, p.x, p.width]), [['studio', 800, 396]]);
  places = [];
  win.emit('focus');
  assert.deepStrictEqual(places.map((p) => [p.id, p.x, p.width]), [['main', 4, 400], ['personal', 412, 380], ['studio', 800, 396]]);
  assert.deepStrictEqual(shownIds(), ['studio', 'main', 'personal']);
  assert.strictEqual(saved().layout, 'triple');
  assert.strictEqual(launches.length, 0, 'running accounts are not launched again');
  ok('split -> triple: 3 windows at 3 rects, saved');

  // ---------- changed-only placement: a drag moving divider 1 re-places only panes 2 and 3
  places = [];
  handlers['panes:rects'](ev(), RECTS3);
  assert.strictEqual(places.length, 0, 'same rects again: nothing re-placed');
  const dragged = [RECTS3[0], { ...RECTS3[1], width: 430 }, { ...RECTS3[2], x: 850, width: 346 }];
  handlers['panes:rects'](ev(), dragged);
  assert.deepStrictEqual(places.map((p) => p.id), ['personal', 'studio']);
  // A full layout() (e.g. a tab click or focus) still re-places every shown window.
  places = [];
  win.emit('focus');
  assert.deepStrictEqual(places.map((p) => p.id).sort(), ['studio', 'main', 'personal']);
  // A window hidden behind our back (not visible) is placed again even with an unchanged rect.
  visible.delete(hwndOf('studio'));
  places = [];
  handlers['panes:rects'](ev(), dragged);
  assert.deepStrictEqual(places.map((p) => p.id), ['studio']);
  // Extra rects beyond 3 are ignored; bad ones are dropped.
  handlers['panes:rects'](ev(), [...dragged, { x: 0, y: 0, width: 5, height: 5 }]);
  handlers['panes:rects'](ev(), 'nope');
  handlers['panes:rects'](other, []);
  ok('panes:rects: only moved (or hidden) windows are re-placed; full layout re-places all');
  handlers['panes:rects'](ev(), RECTS3);

  // ---------- ui:focus-pane
  for (const bad of [3, -1, 1.5, '2', null]) {
    ui = await handlers['ui:focus-pane'](ev(), bad);
    assert.strictEqual(ui.focused, 1, `bad pane ${bad}`);
  }
  ui = await handlers['ui:focus-pane'](ev(), 2);
  assert.strictEqual(ui.focused, 2);
  ok('ui:focus-pane: 0–2 only');

  // ---------- Ctrl+Alt+N fills the active pane (pane 3): Extra (hidden) comes in, Studio goes to the hidden slot
  win.emit('focus');
  shortcuts['Control+Alt+4']();
  st = await handlers['state:get'](ev());
  assert.deepStrictEqual([st.ui.panes, st.ui.focused], [['main', 'personal', 'extra'], 2]);
  handlers['panes:rects'](ev(), RECTS3);
  assert.deepStrictEqual(shownIds(), ['extra', 'main', 'personal'], 'Studio hidden, Extra shown');
  // An account shown in pane 1 swaps with the active pane's
  shortcuts['Control+Alt+1']();
  st = await handlers['state:get'](ev());
  assert.deepStrictEqual([st.ui.panes, st.ui.focused], [['extra', 'personal', 'main'], 2]);
  ok('Ctrl+Alt+1–9 fills the active pane in three columns (swaps with a shown one)');

  // ---------- focus tracking: keyboard focus in pane 2's Claude window makes it active
  await sleep(400); // main hands the keyboard to the active pane 50 ms after a switch; let that happen first
  assert.strictEqual(focusHwnd, hwndOf('main'), 'the active pane got the keyboard');
  const before = uiPushes().length;
  focusHwnd = hwndOf('personal');
  await until('focused pane follows keyboard', () => uiPushes().length > before && uiPushes().pop().focused === 1, 3000);
  focusHwnd = hwndOf('extra');
  await until('focused pane 0', () => uiPushes().pop().focused === 0, 3000);
  ok('enforce(): the pane whose Claude has the keyboard becomes active (all 3 panes)');

  // ---------- triple -> split with pane 3 active: it stays on screen as the right pane
  await handlers['ui:focus-pane'](ev(), 2);
  focusHwnd = 0;
  ui = await layoutCall('split');
  assert.deepStrictEqual([ui.layout, ui.panes, ui.focused, ui.split], ['split', ['extra', 'main', 'personal'], 1, true]);
  handlers['panes:rects'](ev(), RECTS3.slice(0, 2));
  assert.deepStrictEqual(shownIds(), ['extra', 'main']);
  // split -> single with the right pane active: it is the one shown
  ui = await layoutCall('single');
  assert.deepStrictEqual([ui.layout, ui.panes, ui.focused, ui.split], ['single', ['main', 'extra', 'personal'], 0, false]);
  handlers['panes:rects'](ev(), [RECTS3[0]]);
  assert.deepStrictEqual(shownIds(), ['main']);
  // single -> triple: the kept accounts come back in order
  ui = await layoutCall('triple');
  assert.deepStrictEqual([ui.panes, ui.focused], [['main', 'extra', 'personal'], 0]);
  ok('fewer panes keep the active account on screen; more panes bring the kept ones back');

  // ---------- home and back
  await handlers['ui:home'](ev());
  handlers['panes:rects'](ev(), []);
  assert.deepStrictEqual(shownIds(), [], 'home: nothing shown');
  await handlers['ui:show-account'](ev(), 'personal');
  st = await handlers['state:get'](ev());
  assert.deepStrictEqual([st.ui.home, st.ui.layout, st.ui.panes], [false, 'triple', ['personal', 'extra', 'main']]);
  handlers['panes:rects'](ev(), RECTS3);
  assert.deepStrictEqual(shownIds(), ['extra', 'main', 'personal']);
  await handlers['ui:home'](ev());
  ui = await layoutCall('split');
  assert.deepStrictEqual([ui.home, ui.layout], [false, 'split'], 'choosing a layout leaves home');
  ok('home <-> triple / split');

  // ---------- ui:split (older form)
  ui = await handlers['ui:split'](ev(), false);
  assert.strictEqual(ui.layout, 'single');
  ui = await handlers['ui:split'](ev(), 'yes');
  assert.strictEqual(ui.layout, 'single', 'only true turns it on');
  ui = await handlers['ui:split'](ev(), true);
  assert.deepStrictEqual([ui.layout, ui.split], ['split', true]);
  ok('ui:split still works');

  // ---------- ui:ratios
  const ratios = (x, e = ev()) => handlers['ui:ratios'](e, x);
  ui = await ratios({ splitRatio: 0.3 });
  assert.strictEqual(ui.splitRatio, 0.3);
  assert.strictEqual(saved().splitRatio, 0.3);
  ui = await ratios({ splitRatio: 0.95 });
  assert.strictEqual(ui.splitRatio, 0.8, 'clamped to 0.8');
  ui = await ratios({ tripleRatios: [2, 1, 1] });
  assert.deepStrictEqual(ui.tripleRatios, [0.5, 0.25, 0.25], 'scaled to add up to 1');
  ui = await ratios({ tripleRatios: [0.95, 0.03, 0.02] });
  assert(ui.tripleRatios.every((x) => x >= 0.1 - 1e-9) && Math.abs(ui.tripleRatios.reduce((s, x) => s + x) - 1) < 1e-9, `min 10%: ${ui.tripleRatios}`);
  const keep = JSON.stringify(ui);
  for (const bad of [null, [], 'x', {}, { splitRatio: 'a' }, { splitRatio: NaN }, { splitRatio: Infinity }, { tripleRatios: [1, 1] }, { tripleRatios: [1, 0, 1] }, { tripleRatios: [1, -1, 2] }, { tripleRatios: 'abc' }, { splitRatio: 0.4, bogus: 1 }, { splitRatio: 0.4, tripleRatios: [1, 1] }]) {
    ui = await ratios(bad);
    assert.strictEqual(JSON.stringify(ui), keep, `refused: ${JSON.stringify(bad)}`);
  }
  ui = await ratios({ splitRatio: 0.6 }, other);
  assert.strictEqual(JSON.stringify(ui), keep, 'other sender');
  ui = await ratios({ splitRatio: 0.45, tripleRatios: [1, 1, 2] });
  assert.deepStrictEqual([ui.splitRatio, ui.tripleRatios], [0.45, [0.25, 0.25, 0.5]]);
  ok('ui:ratios: validated, clamped, saved');

  // ---------- a layout starts a stopped account that lands in a pane (not one the user stopped)
  await layoutCall('single');
  // Showing Studio and then Work in the single pane leaves Studio kept in the third pane.
  await handlers['ui:show-account'](ev(), 'studio');
  await handlers['ui:show-account'](ev(), 'main');
  st = await handlers['state:get'](ev());
  assert.deepStrictEqual(st.ui.panes, ['main', 'extra', 'studio']);
  procs.delete(1003); // Studio closes (no log: reason unknown, and autoRestart is off anyway)
  await until('studio stopped', () => lastStatus().studio && lastStatus().studio.status === 'stopped');
  launches.length = 0;
  ui = await layoutCall('triple');
  const studioShown = ui.panes.slice(0, 3).includes('studio');
  assert(studioShown, `studio in a pane: ${ui.panes}`);
  await until('studio launched', () => launches.length === 1);
  assert(/studio/.test(launches[0]));
  ok('a stopped account landing in a new pane is started');

  // ---------- removing an account in three columns: no empty pane, fewer panes when needed
  procs.set(1003, 'studio');
  await until('studio docked', () => lastStatus().studio && lastStatus().studio.status === 'docked');
  ui = await layoutCall('triple');
  st = await handlers['state:get'](ev());
  const mid = st.ui.panes[1];
  const last = st.ui.panes[2];
  await handlers['ui:focus-pane'](ev(), 2);
  // Remove the middle one (its Claude must be closed first).
  const pid = [...procs].find(([, x]) => x === mid)[0];
  if (mid === 'main') throw new Error('test setup: main in the middle');
  procs.delete(pid);
  await until(`${mid} stopped`, () => lastStatus()[mid] && lastStatus()[mid].status === 'stopped');
  let r = await handlers['account:remove'](ev(), mid);
  assert(r.ok, JSON.stringify(r));
  assert.strictEqual(r.ui.layout, 'triple', 'still 3 accounts');
  assert(r.ui.panes.slice(0, 3).every(Boolean), `no empty pane: ${r.ui.panes}`);
  assert.strictEqual(r.ui.panes[r.ui.focused], last, 'the active pane follows its account');
  // Remove another: down to two accounts -> split
  const victim = r.ui.panes.find((x) => x && x !== 'main' && x !== last) || r.ui.panes.find((x) => x && x !== 'main');
  const pid2 = [...procs].find(([, x]) => x === victim)[0];
  procs.delete(pid2);
  await until(`${victim} stopped`, () => lastStatus()[victim] && lastStatus()[victim].status === 'stopped');
  r = await handlers['account:remove'](ev(), victim);
  assert(r.ok, JSON.stringify(r));
  assert.deepStrictEqual([r.ui.layout, r.ui.panes[2], r.ui.panes.slice(0, 2).every(Boolean)], ['split', null, true]);
  ui = await layoutCall('triple');
  assert.strictEqual(ui.layout, 'split', 'three columns refused with two accounts');
  ok('removing accounts: panes close up, layout drops to what fits, triple refused');

  console.log('\nall passed');
  process.exit(0);
})().catch((err) => { console.error('FAILED:', err); process.exit(1); });
