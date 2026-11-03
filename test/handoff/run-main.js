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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-handoff-main-'));
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

// ---------- handoff-specific additions (appended to the mc-search / mc-needs harness base) ----------
const crypto = require('crypto');
// Launches are recorded, never run: each one "spawns" at once.
const launches = [];
cp.spawn = (cmd, args, opts) => {
  launches.push({ cmd, args, env: opts && opts.env });
  const child = new EventEmitter();
  child.unref = () => {};
  setImmediate(() => child.emit('spawn'));
  return child;
};
// Only the fake pids exist; a Stop (WM_ENDSESSION) makes the fake copy quit a moment later.
process.kill = (pid) => { if (procs.has(pid)) return true; const e = new Error('no such process'); e.code = 'ESRCH'; throw e; };
const quitAsked = [];
win32.askToQuit = (hwnd) => { const pid = hwnd / 10; quitAsked.push(pid); realSetTimeout(() => procs.delete(pid), 50); return true; };
// Claude Code processes (claude.exe … --resume=<cli>), as main's cliSessionRunning query finds them.
const cliProcs = new Set();
const cliQueries = [];
const baseExecFile = cp.execFile;
cp.execFile = (cmd, args, opts, cb) => {
  const script = args.join(' ');
  if (/CommandLine -like/.test(script)) {
    cliQueries.push(script);
    return setImmediate(() => cb(null, [...cliProcs].filter((c) => script.includes(c)).map((c) => `C:\\x\\claude.exe --output-format stream-json --resume=${c} --model=claude-opus-5-5`).join('\r\n')));
  }
  return baseExecFile(cmd, args, opts, cb);
};

// Four accounts: Studio keeps its own Claude Code folder; Spare shares it and isn't running.
fs.writeFileSync(path.join(userData, 'profiles.json'), JSON.stringify({
  accounts: [
    { id: 'main', name: 'Work', color: '#5b8def', main: true },
    { id: 'personal', name: 'Personal', color: '#d97757' },
    { id: 'studio', name: 'Studio', color: '#3fb68b', shareCode: false },
    { id: 'spare', name: 'Spare', color: '#c678dd' },
  ],
  ui: { panes: ['main', 'personal'], split: false, focused: 0, home: false },
}));
const ACC = { main: crypto.randomUUID(), personal: crypto.randomUUID(), studio: crypto.randomUUID(), spare: crypto.randomUUID() };
const ORG = crypto.randomUUID();
const hDir = (id) => path.join(dataDir(id), 'claude-code-sessions', ACC[id], ORG);
function writeH(id, sid, cli, fields) {
  fs.mkdirSync(hDir(id), { recursive: true });
  fs.writeFileSync(path.join(dataDir(id), 'config.json'), JSON.stringify({ lastKnownAccountUuid: ACC[id] }));
  const file = path.join(hDir(id), `local_${sid}.json`);
  fs.writeFileSync(file, JSON.stringify({
    sessionId: `local_${sid}`, cliSessionId: cli, cwd: 'D:\\Claud', originCwd: 'D:\\Claud', isArchived: false, createdAt: Date.now() - 60 * MIN, lastActivityAt: Date.now() - 5 * MIN,
    model: 'claude-opus-5-5', permissionMode: 'acceptEdits', bridgeSessionIds: ['cse_x'], remoteMcpServersConfig: [{ uuid: 'r1' }], sessionPermissionUpdates: [{ type: 'addRules' }], ...fields,
  }));
  return file;
}
const ts = () => new Date(Date.now()).toISOString();
function writeT(cli, lines) {
  fs.mkdirSync(projects, { recursive: true });
  const file = path.join(projects, `${cli}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}
for (const id of ['main', 'personal', 'studio', 'spare']) writeH(id, crypto.randomUUID(), crypto.randomUUID(), { title: `${id} other` });
// Work's session to carry on: idle (its last turn ended), with a live Remote Control pointer in its transcript.
const S1 = crypto.randomUUID(); const C1 = crypto.randomUUID();
const rec1 = writeH('main', S1, C1, { title: 'Acme spend', lastTurnEdgeAt: Date.now() - 5 * MIN });
const tr1 = writeT(C1, [
  { type: 'user', message: { role: 'user', content: 'build the spend tracker' }, timestamp: new Date(Date.now() - 60 * MIN).toISOString(), sessionId: C1, uuid: 'u1' },
  { type: 'bridge-session', sessionId: C1, bridgeSessionId: 'cse_live', lastSequenceNum: 4 },
  { type: 'assistant', message: { id: 'msg_1', role: 'assistant', stop_reason: 'end_turn', usage: { output_tokens: 500 }, content: [{ type: 'text', text: 'done' }] }, timestamp: new Date(Date.now() - 59 * MIN).toISOString(), sessionId: C1, uuid: 'a1' },
  { type: 'system', subtype: 'stop_hook_summary', timestamp: ts(), sessionId: C1 },
]);
// Work's session that is mid-turn (its transcript ends on the prompt, just now).
const S2 = crypto.randomUUID(); const C2 = crypto.randomUUID();
writeH('main', S2, C2, { title: 'Busy one', lastTurnEdgeAt: Date.now() });
writeT(C2, [{ type: 'user', message: { role: 'user', content: 'go' }, timestamp: ts(), sessionId: C2, uuid: 'u2' }]);
// Work's session held by a permission prompt (its transcript ends on the tool_use).
const S3 = crypto.randomUUID(); const C3 = crypto.randomUUID();
writeH('main', S3, C3, { title: 'Asks first', lastTurnEdgeAt: Date.now() - 2 * MIN });
writeT(C3, [
  { type: 'user', message: { role: 'user', content: 'deploy' }, timestamp: ts(), sessionId: C3, uuid: 'u3' },
  { type: 'assistant', message: { id: 'msg_3', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: {} }] }, timestamp: ts(), sessionId: C3, uuid: 'a3' },
]);
logLine('main', `Emitted tool permission request ${RID(9)} for Bash in session local_${S3}`);
// Work's session mid-turn but quiet for 30 minutes (a long reply): the watcher no longer calls it working.
const S4 = crypto.randomUUID(); const C4 = crypto.randomUUID();
writeH('main', S4, C4, { title: 'Long reply' });
const tr4 = writeT(C4, [
  { type: 'user', message: { role: 'user', content: 'write it all' }, timestamp: ts(), sessionId: C4, uuid: 'u4' },
  { type: 'assistant', message: { id: 'msg_4', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't4', name: 'Bash', input: {} }] }, sessionId: C4, uuid: 'a4' },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't4', content: 'ok' }] }, sessionId: C4, uuid: 'r4' },
]);
fs.utimesSync(tr4, new Date(Date.now() - 30 * MIN), new Date(Date.now() - 30 * MIN));
cliProcs.add(C4);
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const before = { rec: hash(rec1), tr: hash(tr1) };
const linkOf = (l) => l.args.find((a) => a.startsWith('claude://'));
const dirOf = (l) => (l.args.find((a) => a.startsWith('--user-data-dir=')) || '').slice('--user-data-dir='.length) || null;
const lastStatus = () => { const s = win.webContents.sent.filter(([c]) => c === 'status').pop(); return s ? s[1] : {}; };
const newRecords = (id) => fs.readdirSync(hDir(id)).filter((f) => /^local_.*\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(hDir(id), f), 'utf8'))).filter((r) => r.title === 'Acme spend');

(async () => {
  require(path.join(ROOT, 'main.js'));
  while (!win || !handlers['handoff:start']) await vsleep(100);
  win.show();
  await until('first sessions push', () => pushes().length > 0);
  await until('three docked, spare given up', () => {
    const s = lastStatus();
    return ['main', 'personal', 'studio'].every((id) => s[id] && s[id].status === 'docked') && s.spare && s.spare.status === 'stopped';
  });
  await until('busy session seen as working', () => ((lastPush().main || {}).items || []).some((it) => it.sessionId === `local_${S2}` && it.state === 'working'));
  launches.length = 0;
  const start = (req, sender = ev()) => handlers['handoff:start'](sender, req);
  const req = (to, sid = `local_${S1}`, from = 'main') => ({ sessionId: sid, fromAccountId: from, toAccountId: to });

  // Guards: the page gives ids only; anything else is refused without a word.
  for (const bad of [
    [req('personal'), { sender: {} }],
    [{ ...req('personal'), path: 'C:\\x' }],
    [{ sessionId: `local_${S1}`, fromAccountId: 'main' }],
    [req('personal', '../../x')],
    [req('personal', `local_${S1}&x`)],
    [req('main')],
    [req('nobody')],
    [{ sessionId: `local_${S1}`, fromAccountId: 'main', toAccountId: 7 }],
    [null], [[1, 2, 3]], ['local_x'],
  ]) assert.deepStrictEqual(await start(...bad), { ok: false }, JSON.stringify(bad[0]));
  assert.deepStrictEqual(await handlers['handoff:restart']({ sender: {} }, 'personal', `local_${S1}`), { ok: false });
  assert.deepStrictEqual(await handlers['handoff:restart'](ev(), 'personal', `local_${S1}`), { ok: false }, 'not one handoff:start made');
  ok('handoff IPC: guarded; ids only; nothing else accepted');

  let r = await start(req('studio'));
  assert(!r.ok && /own Claude Code folder/.test(r.error), r.error);
  r = await start(req('personal', `local_${S2}`));
  assert(!r.ok && /still working/.test(r.error), r.error);
  r = await start(req('main', `local_${S1}`, 'personal'));
  assert(!r.ok && /isn't in Personal/.test(r.error), r.error);
  assert.strictEqual(newRecords('personal').length + newRecords('studio').length, 0);
  assert.strictEqual(launches.length, 0);
  ok(`refused: other Claude Code folder, mid-turn, a session from another account (${r.error})`);

  // Waiting on a permission prompt: refused by main from the watcher's view.
  await until('prompt seen as waiting', () => ((lastPush().main || {}).items || []).some((it) => it.sessionId === `local_${S3}` && it.state === 'waiting' && it.kind === 'permission'));
  r = await start(req('personal', `local_${S3}`));
  assert(!r.ok && /waiting for your answer in Work/.test(r.error), r.error);
  // Mid-turn but stale (not "working" any more) while its Claude Code process runs: refused from the transcript.
  assert(!((lastPush().main || {}).items || []).some((it) => it.sessionId === `local_${S4}` && it.state === 'working'), 'stale: not working');
  r = await start(req('personal', `local_${S4}`));
  assert(!r.ok && /middle of a turn in Work/.test(r.error), r.error);
  assert(cliQueries.some((q) => q.includes(C4)), 'asked whether a process resumes it');
  assert.strictEqual(newRecords('personal').length + fs.readdirSync(hDir('personal')).filter((f) => f.includes('Long')).length, 0);
  assert.strictEqual(launches.length, 0);
  ok('refused: waiting on a prompt; mid-turn with a stale "working" while its Claude Code process runs');

  // To a running account: the new session is written, and a restart is needed to show it.
  r = await start(req('personal'));
  assert(r.ok && r.needsRestart === true && r.canRestart === true, JSON.stringify(r));
  assert(/^local_[0-9a-f-]{36}$/.test(r.sessionId) && r.title === 'Acme spend');
  assert.strictEqual(launches.length, 0, 'nothing started yet');
  const [nr] = newRecords('personal');
  assert(nr && nr.sessionId === r.sessionId && nr.cliSessionId === r.sessionId.slice(6));
  for (const k of ['model', 'permissionMode', 'bridgeSessionIds', 'remoteMcpServersConfig', 'sessionPermissionUpdates']) assert(!(k in nr), k);
  const copy = fs.readFileSync(path.join(projects, `${nr.cliSessionId}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(copy[copy.length - 1], { type: 'bridge-session', sessionId: C1, bridgeSessionId: '', lastSequenceNum: 0 });
  assert.deepStrictEqual([hash(rec1), hash(tr1)], [before.rec, before.tr]);
  ok('to running Personal: new session in its folder, transcript forked, bridge cleared, original untouched; restart offered');

  // Restart: guarded to that account; a clean quit, then started with the session's link.
  assert.deepStrictEqual(await handlers['handoff:restart'](ev(), 'main', r.sessionId), { ok: false }, 'other account');
  let rr = await handlers['handoff:restart'](ev(), 'personal', r.sessionId);
  assert.deepStrictEqual(rr, { ok: true, opened: true });
  assert.deepStrictEqual(quitAsked, [1002]);
  assert.strictEqual(launches.length, 1);
  assert.strictEqual(linkOf(launches[0]), `claude://code/continue?session=${r.sessionId}`);
  assert.strictEqual(path.resolve(dirOf(launches[0])), path.resolve(path.join(LOCAL, 'Claude-Profiles', 'personal')));
  assert.strictEqual(lastStatus().personal.status, 'starting');
  ok('handoff:restart: Personal asked to quit, then started with the new session\'s link');

  // To an account that isn't running: started once, with the link.
  launches.length = 0;
  r = await start(req('spare'));
  assert(r.ok && r.started === true && r.opened === true && !r.needsRestart, JSON.stringify(r));
  assert.strictEqual(launches.length, 1);
  assert.strictEqual(linkOf(launches[0]), `claude://code/continue?session=${r.sessionId}`);
  assert.strictEqual(path.resolve(dirOf(launches[0])), path.resolve(path.join(LOCAL, 'Claude-Profiles', 'spare')));
  assert.strictEqual(newRecords('spare').length, 1);
  ok('to stopped Spare: started once with the new session open');

  // The same session can be carried on twice (each is its own copy); still the original is unchanged.
  procs.set(1004, 'spare');
  await until('spare docked', () => lastStatus().spare && lastStatus().spare.status === 'docked');
  r = await start(req('spare'));
  assert(r.ok && r.needsRestart, JSON.stringify(r));
  assert.strictEqual(newRecords('spare').length, 2);
  assert.deepStrictEqual([hash(rec1), hash(tr1)], [before.rec, before.tr]);
  ok('a second copy is a second new session; the original is still untouched');

  // Home's numbers: a copy's history was counted with the original, so the account it went to doesn't count it again.
  await handlers['stats:get'](ev());
  const updates = () => win.webContents.sent.filter(([ch]) => ch === 'stats-updated').length;
  await until('stats scanned', () => updates() > 0);
  const s2 = await handlers['stats:get'](ev());
  const tot = (id) => s2.accounts.find((x) => x.id === id).activity.totals;
  console.log('prompts/tokens:', ['main', 'personal', 'spare'].map((id) => `${id} ${tot(id).promptsAll}/${tot(id).outputTokensAll}`).join(', '));
  assert(tot('main').promptsAll >= 1 && tot('main').outputTokensAll === 500);
  assert.deepStrictEqual([tot('personal').promptsAll, tot('personal').outputTokensAll, tot('spare').promptsAll, tot('spare').outputTokensAll], [0, 0, 0, 0]);
  ok('Home stats: the copied history counts once, for Work only');

  // The same long reply cut off (its Claude Code process is gone, e.g. Claude crashed): copied as it is.
  cliProcs.delete(C4);
  r = await start(req('personal', `local_${S4}`));
  assert(r.ok && r.needsRestart, JSON.stringify(r));
  ok('mid-turn transcript nothing resumes any more (cut off): copied');

  console.log('\nall passed');
  process.exit(0);
})().catch((err) => { console.error('FAILED:', err); process.exit(1); });
