// Kitsun (formerly Multi Claude): one window with a tab per AI. Each tab has a kind (TAB_KINDS); a Claude tab hosts
// the real Claude desktop app, signed in to its own account.
//
// Every extra Claude account is the official Claude app started with its own data folder (--user-data-dir),
// so it has its own sign-in, chats, settings and usage; the Claude app supports this and logs
// "stay_chosen_folder". Each Claude window is then docked inside our window as a child window.
// Chromium only paints inside another program's window when DirectComposition is off, so every copy
// is started with --disable-direct-composition; a copy started without it can't be docked.

const { app, BrowserWindow, WebContentsView, session, clipboard, ipcMain, shell, dialog, Menu, Tray, nativeImage, screen, globalShortcut, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { spawn, spawnSync, execFile, execFileSync } = require('child_process');
const win32 = require('./lib/win32');
// main.js has its own dataDirOf (a command line's --user-data-dir), so the account one is renamed here.
const { createStats, dataDirOf: accountDataDir, codeDirOf } = require('./lib/stats');
const health = require('./lib/health');
const { createAttention } = require('./lib/attention');
const { createSearch, sessionLink, SESSION_ID_RE, MAX_QUERY } = require('./lib/search');
const { createChrome, PROFILE_DIR_RE } = require('./lib/chrome');
const { continueSession } = require('./lib/handoff');
const { createCatalog, findEntry, safeUrl } = require('./lib/catalog');

const APP_ID = 'local.kitsun';
const APP_NAME = 'Kitsun';
// What this app was called before: its settings folder, login item, Start Menu shortcut and install folder are taken
// over once (takeOverOldSettings, quitOldApp, takeOverOldShellItems).
const OLD_APP = { name: 'Multi Claude', id: 'local.multi-claude' };
// Dev aid: KITSUN_USER_DATA=<folder> runs from source with its own settings (and single-instance lock), e.g. a test
// profiles.json with only website tabs, so it never touches the Claude windows the installed Kitsun holds.
if (process.env.KITSUN_USER_DATA && !app.isPackaged) app.setPath('userData', path.resolve(process.env.KITSUN_USER_DATA));
// The kinds of tab. lib/attention, search, stats, chrome and handoff are Claude-only and
// only ever get Claude tabs (claudeTabs()).
const TAB_KINDS = ['claude', 'web', 'app', 'terminal'];
// A Store app's id as Windows starts it: <package family>!<app id>.
const AUMID_RE = /^[\w.-]+_[a-z0-9]+![\w.-]+$/i;
const ACCOUNT_ID_RE = /^[a-z0-9-]{1,64}$/;
const DOCK_FLAG = '--disable-direct-composition';
const CLAUDE_ALIAS_DIR = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps');
const PROFILES_ROOT = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Claude-Profiles');
const CODE_CONFIG_ROOT = path.join(os.homedir(), '.claude-accounts');

// ---------- persisted state ----------

const dataFile = () => path.join(app.getPath('userData'), 'profiles.json');
const autoDataDir = (id) => path.join(PROFILES_ROOT, id);
const autoCodeDir = (id) => path.join(CODE_CONFIG_ROOT, id);

// App-wide settings (the Settings dialog). Each value's type is fixed by its default: sanitizeState() and
// settings:set reject anything else, so adding a setting is one line here plus one in renderer/app.js.
const DEFAULT_SETTINGS = {
  startWithWindows: false, // a Windows login item (installed app only), started with --hidden
  startHidden: false, // start in the tray; every account still starts
  closeToTray: true, // the close button hides Kitsun to the tray instead of quitting
  autoRestart: true, // start an account's Claude again if it quits or crashes
  notifyNeedsYou: true, // notify when an account is waiting for the user
  notifyLimits: true, // notify when an account nears its plan limit
  notifyRestarts: true, // notify (while Kitsun is in the background) about Claude updates, reopened and frozen accounts
};

// The account already signed in to the normal Claude app is the "main" one; it keeps the app's own data folder.
const DEFAULT_STATE = {
  accounts: [
    { id: 'main', name: 'Work', color: '#5b8def', main: true, shareCode: true },
    { id: 'personal', name: 'Personal', color: '#d97757', main: false, shareCode: true },
  ],
  // layout: how many panes show side by side (LAYOUTS). panes: the account in each pane, also the hidden ones, so going
  // back to more panes shows the same accounts again. split: layout !== 'single', kept for older builds reading this file.
  // splitRatio: the left pane's share in 'split'; tripleRatios: each column's share in 'triple' (the dividers set both).
  ui: { layout: 'single', panes: ['main', 'personal', null], split: false, focused: 0, home: false, splitRatio: 0.5, tripleRatios: [1 / 3, 1 / 3, 1 / 3] },
  window: null,
  settings: DEFAULT_SETTINGS,
  trayHintShown: false, // the "still running in the tray" note shows once, the first time the window hides
  claudeVersion: null, // newest Claude app version seen running, so an update is noticed even across restarts
};

// Pane layouts and how many panes each shows.
const LAYOUTS = { single: 1, split: 2, triple: 3 };
const MAX_PANES = 3;

// A divider position: the left pane's share in 'split', kept between 20% and 80%. null if it isn't a number.
function sanitizeSplitRatio(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(0.8, Math.max(0.2, v)) : null;
}

// Each column's share in 'triple': three positive numbers, scaled to add up to 1, none under 10% (the page also keeps
// every pane at least ~360 px wide on screen). null if it isn't three positive numbers.
function sanitizeTripleRatios(v) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0)) return null;
  const sum = v[0] + v[1] + v[2];
  const f = v.map((x) => x / sum);
  const MIN = 0.1;
  const need = f.reduce((s, x) => s + Math.max(0, MIN - x), 0);
  if (!need) return f;
  // Raise the small ones to the minimum, taking it from the others in proportion to what they have above it.
  const spare = f.reduce((s, x) => s + Math.max(0, x - MIN), 0);
  return f.map((x) => (x < MIN ? MIN : x - ((x - MIN) / spare) * need));
}

// The account in each of the MAX_PANES panes. An account shows in one pane at most and unknown ids go; empty panes get
// the first accounts not shown yet, and any left empty (fewer accounts than panes) move to the end, so a layout never
// shows an empty pane while there are accounts for it.
function fillPanes(panes, accounts) {
  const out = panes.slice(0, MAX_PANES).map((id) => (accounts.some((a) => a.id === id) ? id : null));
  while (out.length < MAX_PANES) out.push(null);
  out.forEach((id, p) => { if (id && out.indexOf(id) < p) out[p] = null; });
  out.forEach((id, p) => { if (!id) out[p] = accounts.find((a) => !out.includes(a.id))?.id || null; });
  return [...out.filter(Boolean), ...out.filter((id) => !id)];
}

function sanitizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (typeof raw[k] === typeof DEFAULT_SETTINGS[k]) out[k] = raw[k];
  return out;
}

// null for an entry that can't be a tab (a website tab without a usable address).
function sanitizeAccount(a) {
  const kind = TAB_KINDS.includes(a.kind) ? a.kind : 'claude'; // files from before tab kinds only had Claude accounts
  const base = {
    id: a.id,
    kind,
    name: String(a.name || 'Account').slice(0, 40),
    color: /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : '#888888',
    // The catalogue entry it was added from (lib/catalog.js), if any; only used to show where it came from.
    catalogId: typeof a.catalogId === 'string' && findEntry(a.catalogId) ? a.catalogId : null,
  };
  if (kind === 'web') {
    const url = safeUrl(a.url);
    return url ? { ...base, url, main: false } : null;
  }
  if (kind === 'app') {
    // The program's exe (also how its windows are recognised); aumid: a Store app, which Windows has to start itself.
    const exe = typeof a.exe === 'string' && path.isAbsolute(a.exe) && /\.exe$/i.test(a.exe) ? path.normalize(a.exe) : null;
    const aumid = typeof a.aumid === 'string' && AUMID_RE.test(a.aumid) ? a.aumid : null;
    return exe ? { ...base, exe, aumid, main: false } : null;
  }
  if (kind === 'terminal') {
    // command: what runs in PowerShell when it opens (null: just PowerShell); cwd: the folder it starts in.
    const command = typeof a.command === 'string' && a.command.trim() ? a.command.trim().slice(0, 500) : null;
    const cwd = typeof a.cwd === 'string' && path.isAbsolute(a.cwd) ? path.normalize(a.cwd) : os.homedir();
    return { ...base, command, cwd, main: false };
  }
  return {
    ...base,
    main: a.main === true,
    shareCode: a.main === true ? true : a.shareCode !== false,
    // A Chrome profile folder picked by hand for the Chrome button; null = automatic (lib/chrome.js). account:save also
    // checks it against Chrome's Local State; here only its shape, so a profile missing for a moment isn't forgotten.
    chromeProfile: typeof a.chromeProfile === 'string' && PROFILE_DIR_RE.test(a.chromeProfile) ? a.chromeProfile : null,
  };
}

function sanitizeState(raw) {
  const state = JSON.parse(JSON.stringify(DEFAULT_STATE));
  if (!raw || typeof raw !== 'object') return state;
  if (Array.isArray(raw.accounts)) {
    const seen = new Set();
    const raws = raw.accounts.filter((a) => a && ACCOUNT_ID_RE.test(a.id) && !seen.has(a.id) && seen.add(a.id));
    const isClaude = (a) => (a.kind || 'claude') === 'claude';
    // At most one main account (the normal Claude app), always first. A list of only Claude tabs always has one, as
    // before tab kinds; a list with other kinds of tab doesn't have to have Claude at all.
    let mi = raws.findIndex((a) => isClaude(a) && a.main === true);
    if (mi < 0) mi = raws.findIndex((a) => isClaude(a) && a.id === 'main');
    const others = raws.filter((_, i) => i !== mi).map((a) => sanitizeAccount({ ...a, main: false })).filter(Boolean);
    const main = mi >= 0 ? sanitizeAccount({ ...raws[mi], main: true })
      : raws.every(isClaude) ? sanitizeAccount(DEFAULT_STATE.accounts[0]) : null;
    state.accounts = main ? [main, ...others] : others;
  }
  const ui = raw.ui && typeof raw.ui === 'object' ? raw.ui : {};
  const before = Array.isArray(ui.panes) ? ui.panes.slice(0, MAX_PANES) : [];
  const activeId = Number.isInteger(ui.focused) ? before[ui.focused] : null;
  const panes = fillPanes(before, state.accounts);
  // Files from before layouts only have split (true: two panes). A layout needs an account for each of its panes.
  let shape = typeof ui.layout === 'string' && Object.hasOwn(LAYOUTS, ui.layout) ? ui.layout : ui.split === true ? 'split' : 'single';
  while (LAYOUTS[shape] > 1 && !panes[LAYOUTS[shape] - 1]) shape = LAYOUTS[shape] === 3 ? 'split' : 'single';
  // The active pane follows its account if the panes moved up (e.g. one was removed), else it is the first.
  const fi = activeId ? panes.indexOf(activeId) : -1;
  state.ui = {
    layout: shape,
    panes,
    split: shape !== 'single',
    focused: fi >= 0 && fi < LAYOUTS[shape] ? fi : 0,
    home: ui.home === true,
    splitRatio: sanitizeSplitRatio(ui.splitRatio) ?? 0.5,
    tripleRatios: sanitizeTripleRatios(ui.tripleRatios) || [1 / 3, 1 / 3, 1 / 3],
  };
  const w = raw.window;
  if (w && typeof w === 'object' && [w.width, w.height].every(Number.isFinite)) {
    state.window = { width: w.width, height: w.height, maximized: w.maximized === true };
    if (Number.isFinite(w.x) && Number.isFinite(w.y)) Object.assign(state.window, { x: w.x, y: w.y });
  }
  state.settings = sanitizeSettings(raw.settings);
  state.trayHintShown = raw.trayHintShown === true;
  state.claudeVersion = typeof raw.claudeVersion === 'string' && /^\d+(\.\d+){1,3}$/.test(raw.claudeVersion) ? raw.claudeVersion : null;
  return state;
}

let state;

// A settings file that can't be read is kept as profiles.json.unreadable-<time> before the defaults replace it, so the
// tabs in it can be recovered.
function loadState() {
  let text;
  try { text = fs.readFileSync(dataFile(), 'utf8'); } catch { return sanitizeState(null); }
  try {
    return sanitizeState(JSON.parse(text));
  } catch (err) {
    console.error('Could not read the settings file:', err);
    try { fs.copyFileSync(dataFile(), `${dataFile()}.unreadable-${Date.now()}`); } catch { /* the defaults are used either way */ }
    return sanitizeState(null);
  }
}

function saveState() {
  try {
    const tmp = dataFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, dataFile());
  } catch (err) {
    console.error('Could not save state:', err);
  }
}

// Earlier versions embedded claude.ai web pages or made per-account shortcuts; their leftovers go once.
function removeOldLeftovers() {
  const ud = app.getPath('userData');
  for (const p of ['accounts.json', 'Partitions', 'launchers']) {
    try { fs.rmSync(path.join(ud, p), { recursive: true, force: true }); } catch { /* in use or gone */ }
  }
}

const accountById = (id) => state.accounts.find((a) => a.id === id);
const claudeTabs = () => state.accounts.filter((a) => a.kind === 'claude');
const isClaudeTab = (id) => { const a = accountById(id); return Boolean(a && a.kind === 'claude'); };

// ---------- the Claude app ----------

// The alias name differs between Claude builds; the first one that exists is used.
function claudeAlias() {
  for (const name of ['claude-desktop.exe', 'claude-desktop-msstore.exe', 'claude-desktop-nest.exe']) {
    const p = path.join(CLAUDE_ALIAS_DIR, name);
    try { fs.lstatSync(p); return p; } catch { /* try the next one */ }
  }
  return null;
}

// Variables a Claude Code session leaves behind if Kitsun was started from one. The user's own
// settings (proxy, Git Bash path, API settings…) are passed through untouched.
const SESSION_VARS = /^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|CLAUDE_CONFIG_DIR|CLAUDE_AGENT_SDK_.*|CLAUDE_CODE_SESSION_.*)$/i;

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !SESSION_VARS.test(k)));

function claudeEnv(account) {
  const env = cleanEnv();
  if (!account.shareCode) env.CLAUDE_CONFIG_DIR = autoCodeDir(account.id);
  return env;
}

function spawnDetached(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, env });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

async function launchClaude(account, extraArgs = []) {
  const alias = claudeAlias();
  if (!alias) return { ok: false, error: 'The Claude desktop app is not installed. Install it from claude.ai/download, then reopen Kitsun.' };
  try {
    // Chromium pauses windows it thinks are covered; a docked window is easily misjudged as covered.
    const args = [DOCK_FLAG, '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion'];
    if (!account.main) {
      fs.mkdirSync(autoDataDir(account.id), { recursive: true });
      args.push(`--user-data-dir=${autoDataDir(account.id)}`);
    }
    if (!account.shareCode) fs.mkdirSync(autoCodeDir(account.id), { recursive: true });
    await spawnDetached(alias, [...args, ...extraArgs], claudeEnv(account));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

// Only sign-in links are accepted, so the sign-in box can never trigger other app actions.
function toClaudeLink(text) {
  let url;
  try { url = new URL(String(text).trim()); } catch { return null; }
  const isMagic = url.pathname === '/magic-link' && /^#[^:]+:[^:]+$/.test(url.hash);
  const isSso = url.pathname === '/sso-callback';
  if (url.protocol === 'claude:') {
    const ok = (url.host === 'claude.ai' && (isMagic || isSso)) || (url.host === 'login' && url.pathname === '/google-auth');
    return ok ? url.toString() : null;
  }
  if (url.protocol === 'https:' && (url.hostname === 'claude.ai' || url.hostname === 'claude.com')) {
    if (isMagic) {
      const anon = url.searchParams.get('anon_id');
      return `claude://claude.ai/magic-link${anon ? `?anon_id=${encodeURIComponent(anon)}` : ''}${url.hash}`;
    }
    if (isSso) return `claude://claude.ai/sso-callback${url.search}`;
  }
  return null;
}

// ---------- which copies are running ----------

// Main processes of the Claude app (not its helpers, and not the Claude Code CLI, which also runs
// as claude.exe but from inside a data folder rather than the app package).
function listClaudeProcesses() {
  return new Promise((resolve) => {
    const ps = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
      + "Get-CimInstance Win32_Process -Filter \"Name LIKE 'claude%.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { \"$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)\" }";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) return resolve(null);
      const appExe = /\\WindowsApps\\([^\\]*Claude[^\\]*\\app\\claude\.exe|claude-desktop[^\\]*\.exe)"?$/i;
      resolve(stdout.split(/\r?\n/).map((l) => l.split('\t')).filter((p) => p.length >= 3)
        .map(([pid, exe, cmd]) => ({ pid: Number(pid), exe, cmd }))
        .filter((p) => appExe.test(p.exe) || appExe.test(p.cmd.split(/\s+--/)[0].trim())));
    });
  });
}

// Node quotes the whole argument when the path has a space ("--user-data-dir=C:\a b"); handle both forms.
function dataDirOf(commandLine) {
  const m = /"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=(\S+)/i.exec(commandLine);
  return m ? path.resolve(m[1] || m[2] || m[3]).toLowerCase() : null;
}

// accountId -> { status, pid, hwnd, saved, launchedAt, error, ... }
// status: 'stopped' | 'starting' | 'docked' | 'external' (running without the dock flag) | 'stopping' (our Stop is waiting for it to quit)
// Also: version (Claude version it runs), exit ({ reason, at, reopening, gaveUp, ... }: why it last closed, kept
// until it is docked again), stoppedByUser, restarts (times of automatic reopens), restartTimer,
// expectExitUntil (we are ending it ourselves), hungSince / frozen / waitUntil (the freeze watchdog).
const instances = new Map();
const inst = (id) => {
  if (!instances.has(id)) instances.set(id, { status: 'stopped', pid: null, hwnd: null, saved: null, launchedAt: 0, error: null });
  return instances.get(id);
};

let scanInflight = null;
let firstScanDone = false;
// fresh: the process list must be read after this call (e.g. a copy was just seen to exit). A scan already under way
// may have read it before, so it is waited for and another one is started.
function scanProcesses({ fresh = false } = {}) {
  if (fresh && scanInflight) return scanInflight.catch(() => false).then(() => scanProcesses());
  scanInflight ??= (async () => {
    const listed = await listClaudeProcesses();
    if (!listed || closing) return false;
    // The list takes a moment to read: a copy that exited meanwhile may still be in it.
    const procs = listed.filter((p) => !processGone(p.pid));
    firstScanDone = true;
    noteClaudeVersion(procs);
    for (const a of claudeTabs()) {
      const i = inst(a.id);
      const want = a.main ? null : autoDataDir(a.id).toLowerCase();
      const proc = procs.find((p) => dataDirOf(p.cmd) === want);
      if (!proc) {
        if (i.hwnd) forgetWindow(a.id);
        const wasRunning = Boolean(i.pid);
        i.pid = null;
        if (i.status === 'external') {
          // The user quit a copy that was running on its own: reopen it here, as the notice promised.
          i.status = 'stopped';
          startAccount(a.id);
          continue;
        }
        // It was running at the last scan and is gone now: find out why, and maybe reopen it.
        if (wasRunning) { onClosed(a, i); continue; }
        // Give a fresh launch time to show up before calling it stopped.
        if (i.status === 'starting' && Date.now() - i.launchedAt <= 45000) continue;
        const neverShowed = i.status === 'starting';
        i.status = 'stopped';
        // An automatic reopen that never showed up gets another try, within the same limit.
        if (neverShowed && i.exit && i.exit.reopening && !i.restartTimer) scheduleRestart(a.id, RESTART_DELAY);
        continue;
      }
      i.pid = proc.pid;
      i.version = health.versionFromExe(proc.exe);
      if (i.status === 'stopping') continue; // quitting: leave its window alone, and don't nudge it
      if (!proc.cmd.includes(DOCK_FLAG)) {
        if (i.hwnd) forgetWindow(a.id);
        i.status = 'external';
      } else if (!i.hwnd) {
        if (i.status !== 'starting') {
          i.status = 'starting';
          i.launchedAt = Date.now();
          i.nudged = false;
        } else if (!i.nudged && Date.now() - i.launchedAt > 20000) {
          // Running but no window to dock (e.g. it was destroyed): launching it again makes
          // Claude's single-instance handoff show or recreate its window.
          i.nudged = true;
          launchClaude(a);
        }
      }
    }
    attachWindows();
    return true;
  })().finally(() => { scanInflight = null; });
  return scanInflight;
}

// Finds and docks the window of every copy that is running with the dock flag.
function attachWindows() {
  if (!mainWindow || closing) return;
  let changed = false;
  for (const a of claudeTabs()) {
    const i = inst(a.id);
    if (!i.pid || i.status === 'external' || i.status === 'stopping' || i.hwnd) continue;
    const hwnd = win32.findAppWindow(i.pid);
    if (!hwnd) continue;
    try {
      i.saved = win32.dock(hwnd, parentHwnd);
      i.hwnd = hwnd;
      i.status = 'docked';
      i.nudged = false;
      i.error = null;
      reopened(a, i);
      changed = true;
    } catch (err) {
      i.error = err.message;
    }
  }
  if (changed) layout();
  pushStatus();
}

function forgetWindow(id) {
  const i = inst(id);
  i.hwnd = null;
  i.saved = null;
  i.placed = null;
}

// Puts every docked window back as a normal (hidden) Claude window, which keeps running like
// a Claude window closed to the tray. Must run before our own window is destroyed.
// A desktop app's window is handed back visible: unlike Claude it has no tray icon to bring it back from.
function undockAll({ show = false } = {}) {
  for (const [id, i] of instances) {
    if (!i.hwnd) continue;
    const a = accountById(id);
    try { win32.undock(i.hwnd, i.saved, { show: show || Boolean(a && a.kind === 'app') }); } catch { /* window already gone */ }
    forgetWindow(id);
    if (i.status === 'docked') i.status = 'starting';
  }
}

// ---------- website tabs ----------

// A website tab is a WebContentsView laid over its pane body, as a Claude window is docked over its pane. Each tab has
// its own persistent browser partition, so its sign-ins, cookies and storage are its own: two ChatGPT tabs can be two
// accounts. Stopping one closes the page (freeing its memory); its sign-in stays.
const webViews = new Map(); // tab id -> WebContentsView (website tabs, and terminal tabs' pages)
const partitionOf = (id) => `persist:tab-${id}`;
// Sign-in pages a site may open in a popup (and expect to talk back to): they open in a small window with the tab's own
// partition. Other links to other sites go to the default browser.
const AUTH_HOSTS = /(^|\.)(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|github\.com|auth\.openai\.com|auth0\.com|okta\.com|x\.com|twitter\.com|facebook\.com|discord\.com|stytch\.com|workos\.com)$/i;
// What a site may ask for: clipboard, notifications, full screen, and the microphone/camera (voice modes).
const WEB_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen', 'media']);

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
// chat.example.com and example.com are the same site here.
function sameSite(a, b) {
  const base = (h) => h.split('.').slice(-2).join('.');
  const ha = hostOf(a);
  const hb = hostOf(b);
  return Boolean(ha && hb && base(ha) === base(hb));
}

function openExternal(url) {
  if (/^https?:\/\//i.test(String(url))) shell.openExternal(url).catch(() => {});
}

// Chromium's own user agent, without the Electron and Kitsun parts that some sites refuse (Google's sign-in among them).
let cleanUA = null;
function browserUserAgent() {
  cleanUA ??= session.defaultSession.getUserAgent().replace(/\s(Electron|Kitsun)\/\S+/gi, '');
  return cleanUA;
}

const preparedSessions = new Set();
function webSessionFor(id) {
  const ses = session.fromPartition(partitionOf(id));
  if (!preparedSessions.has(id)) {
    preparedSessions.add(id);
    ses.setUserAgent(browserUserAgent());
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(WEB_PERMISSIONS.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => WEB_PERMISSIONS.has(permission));
  }
  return ses;
}

function webContextMenu(wc, p) {
  const items = [];
  for (const s of (p.dictionarySuggestions || []).slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
  if (items.length) items.push({ type: 'separator' });
  if (p.linkURL) {
    items.push({ label: 'Open link in your browser', click: () => openExternal(p.linkURL) }, { label: 'Copy link', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' });
  }
  if (p.isEditable) {
    items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy }, { role: 'paste', enabled: p.editFlags.canPaste }, { role: 'selectAll' }, { type: 'separator' });
  } else if (p.selectionText) items.push({ role: 'copy' }, { type: 'separator' });
  const h = wc.navigationHistory;
  items.push(
    { label: 'Back', accelerator: 'Alt+Left', enabled: h.canGoBack(), click: () => h.goBack() },
    { label: 'Forward', accelerator: 'Alt+Right', enabled: h.canGoForward(), click: () => h.goForward() },
    { label: 'Reload', accelerator: 'F5', click: () => wc.reload() },
    { type: 'separator' },
    { label: 'Open this page in your browser', click: () => openExternal(wc.getURL()) },
  );
  Menu.buildFromTemplate(items).popup({ window: mainWindow });
}

function startWeb(account) {
  const i = inst(account.id);
  if (!mainWindow || closing) return { ok: false };
  if (!webViews.has(account.id)) {
    const partition = partitionOf(account.id);
    webSessionFor(account.id);
    const view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: true } });
    view.setBackgroundColor('#0d0f15');
    view.setVisible(false);
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      if (url === 'about:blank' || AUTH_HOSTS.test(hostOf(url))) {
        return { action: 'allow', overrideBrowserWindowOptions: { parent: mainWindow, width: 520, height: 720, autoHideMenuBar: true, webPreferences: { partition, sandbox: true } } };
      }
      // The same site's own links stay in the tab; anything else opens in the default browser.
      if (sameSite(url, account.url)) wc.loadURL(url).catch(() => {});
      else openExternal(url);
      return { action: 'deny' };
    });
    wc.on('context-menu', (_e, p) => webContextMenu(wc, p));
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      const h = wc.navigationHistory;
      if (input.alt && input.key === 'ArrowLeft') { if (h.canGoBack()) h.goBack(); e.preventDefault(); }
      else if (input.alt && input.key === 'ArrowRight') { if (h.canGoForward()) h.goForward(); e.preventDefault(); }
      else if (input.key === 'F5' || (input.control && !input.shift && !input.alt && input.key.toLowerCase() === 'r')) { wc.reload(); e.preventDefault(); }
    });
    // Clicking into a page makes its pane the active one, as clicking into a Claude window does.
    wc.on('focus', () => {
      if (state.ui.home || paneCount() < 2) return;
      const p = visiblePanes().find((q) => state.ui.panes[q] === account.id);
      if (p !== undefined && state.ui.focused !== p) { state.ui.focused = p; pushUi(); }
    });
    // A crashed page is reloaded.
    wc.on('render-process-gone', (_e, d) => {
      if (closing || d.reason === 'clean-exit') return;
      setTimeout(() => { if (!wc.isDestroyed()) wc.reload(); }, 2000);
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame && code !== -3) console.log(`${account.name}: could not load ${url} (${desc})`); // -3: aborted by a redirect
    });
    // Dev aid: KITSUN_WEB_SHOTS=<folder> saves a picture of each website tab a few seconds after it loads, and logs
    // its title and address, so a run from source can be checked without looking at the screen.
    if (process.env.KITSUN_WEB_SHOTS && !app.isPackaged) {
      wc.on('did-finish-load', () => setTimeout(async () => {
        if (wc.isDestroyed()) return;
        console.log(`web ${account.id}: "${wc.getTitle()}" ${wc.getURL()}`);
        const img = await wc.capturePage().catch(() => null);
        if (img) fs.writeFileSync(path.join(process.env.KITSUN_WEB_SHOTS, `${account.id}.png`), img.toPNG());
      }, 6000));
    }
    mainWindow.contentView.addChildView(view);
    webViews.set(account.id, view);
    wc.loadURL(account.url).catch(() => {}); // a redirect aborts the first load; a failed one shows Chromium's error page
  }
  i.status = 'docked';
  i.error = null;
  i.startedAt ??= Date.now();
  layout();
  pushStatus();
  return { ok: true };
}

function stopWeb(id) {
  const view = webViews.get(id);
  webViews.delete(id);
  if (view) {
    try { if (mainWindow) mainWindow.contentView.removeChildView(view); } catch { /* window gone */ }
    try { view.webContents.close(); } catch { /* already closed */ }
  }
  const i = inst(id);
  i.status = 'stopped';
  i.startedAt = null;
}

function placeView(view, r) {
  view.setBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height)) });
  view.setVisible(true);
}

// ---------- desktop app tabs ----------

// A desktop app tab docks the main window of an installed program, the way a Claude tab docks Claude's. Its windows are
// told apart by the exe of the process that owns them: that exe, or another in its install folder (some apps show their
// window from a helper exe). Opening the tab docks a window of it that is already open and that no tab holds (e.g. the
// one Kitsun handed back when it last quit), else starts the program and waits for its window. Closing the tab closes
// that window as its X button would, so the app can ask to save first, in its pane.
// Chromium-based apps (Electron: VS Code, Cursor, LM Studio…) are started with Claude's switches that keep a docked window
// from being throttled as if covered, but not DOCK_FLAG: VS Code (Electron 43) painted nothing docked with it, and fine
// without it. So one already open in its own window is docked as it is.
const APP_WAIT = 90000; // how long a starting app gets to show its window (VS Code's first start after an update: ~1 min)
const APP_GONE_WAIT = 8000; // after its window closed, how long it gets to show another one (some apps swap windows)
const APP_CLOSE_WAIT = 15000; // how long Close waits for the window to go (the app may be asking to save)
const CHROMIUM_ARGS = ['--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion'];

// Whether a process's exe belongs to the app: its own exe, or one in its install folder unless that folder is a shared
// one (Windows' own folders, or a drive's root), where it would match unrelated programs.
function appMatcher(exe) {
  const want = exe.toLowerCase();
  const dir = path.dirname(want);
  const windir = (process.env.WINDIR || 'C:\\Windows').toLowerCase();
  const shared = dir === path.parse(want).root || dir === windir || dir.startsWith(windir + path.sep);
  return (p) => { const q = p.toLowerCase(); return q === want || (!shared && q.startsWith(dir + path.sep)); };
}

// Chromium's resource files next to the exe, or one folder down (VS Code keeps them in a folder per version).
function isChromiumApp(exe) {
  const dir = path.dirname(exe);
  const has = (d) => ['chrome_100_percent.pak', path.join('resources', 'app.asar')].some((f) => fs.existsSync(path.join(d, f)));
  if (has(dir)) return true;
  try { return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && has(path.join(dir, e.name))); } catch { return false; }
}

// Docks a visible window of the app that no tab holds; true if there was one.
function dockAppWindow(account) {
  const i = inst(account.id);
  const held = new Set([...instances.values()].map((x) => x.hwnd).filter(Boolean));
  const w = win32.appWindows(appMatcher(account.exe)).find((x) => x.visible && !held.has(x.hwnd) && x.hwnd !== parentHwnd);
  if (!w) return false;
  try {
    i.saved = win32.dock(w.hwnd, parentHwnd);
  } catch (err) {
    i.error = err.message;
    return false;
  }
  Object.assign(i, { hwnd: w.hwnd, pid: w.pid, status: 'docked', error: null, exit: null, lost: false });
  console.log(`${account.name}: docked "${w.title}" (${path.basename(w.exe)}, pid ${w.pid})`);
  i.startedAt ??= Date.now();
  layout();
  pushStatus();
  if (shownPanes().some((p) => state.ui.panes[p] === account.id)) setTimeout(focusActivePane, 50);
  return true;
}

function appFailed(account, error) {
  const i = inst(account.id);
  Object.assign(i, { status: 'stopped', pid: null, error, lost: false });
  console.log(`${account.name}: ${error}`);
  pushStatus();
  return { ok: false, error };
}

async function startApp(account) {
  const i = inst(account.id);
  if (i.hwnd || i.status === 'starting') return { ok: true };
  i.stoppedByUser = false;
  i.exit = null;
  i.error = null;
  if (!fs.existsSync(account.exe)) return appFailed(account, `${account.name} isn't at ${account.exe} any more. Remove this tab and add it again.`);
  Object.assign(i, { status: 'starting', launchedAt: Date.now(), lost: false });
  pushStatus();
  if (dockAppWindow(account)) return { ok: true };
  const chromium = !account.aumid && isChromiumApp(account.exe);
  try {
    // A Store app is started by Windows (it can't be run from its exe), so it gets no extra switches.
    const [cmd, args] = account.aumid ? ['explorer.exe', [`shell:AppsFolder\\${account.aumid}`]] : [account.exe, chromium ? CHROMIUM_ARGS : []];
    await new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: path.dirname(account.exe), detached: true, stdio: 'ignore', env: cleanEnv() });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  } catch (err) {
    return appFailed(account, `${account.name} couldn't be started: ${err.message}`);
  }
  console.log(`${account.name}: started ${account.aumid || account.exe}${chromium ? ' (Chromium: not throttled while covered)' : ''}`);
  watchApps();
  return { ok: true };
}

// Close: the window is asked to close, and stays docked meanwhile, so a "save your changes?" question shows in its pane.
// watchWindows() marks the tab closed once the window is gone. Answering Cancel keeps it open, as with its own X.
async function stopApp(account) {
  const i = inst(account.id);
  const hwnd = i.hwnd;
  if (!hwnd) {
    Object.assign(i, { status: 'stopped', pid: null, stoppedByUser: true, lost: false, exit: { reason: 'stopped', at: Date.now(), reopening: false, gaveUp: false } });
    pushStatus();
    return { ok: true };
  }
  if (win32.isHung(hwnd)) return { ok: false, error: `${account.name} isn't responding, so it can't be asked to close.` };
  i.stoppedByUser = true;
  i.exit = { reason: 'stopped', at: Date.now(), reopening: false, gaveUp: false };
  win32.askToClose(hwnd);
  const until = Date.now() + APP_CLOSE_WAIT;
  while (Date.now() < until && win32.isWindow(hwnd) && i.hwnd === hwnd) await sleep(250);
  if (!win32.isWindow(hwnd)) {
    if (i.hwnd === hwnd) forgetWindow(account.id);
    Object.assign(i, { status: 'stopped', pid: null });
    layout();
    pushStatus();
    return { ok: true };
  }
  i.stoppedByUser = false;
  i.exit = null;
  return { ok: false, error: `${account.name} is still open. It may be asking you something in its tab.` };
}

// Looks every second for the window of each app tab that is starting, or whose window just closed.
let appTimer = null;
function watchApps() {
  if (appTimer) return;
  appTimer = setInterval(() => {
    let waiting = false;
    for (const a of closing ? [] : state.accounts) {
      if (a.kind !== 'app') continue;
      const i = inst(a.id);
      if (i.status !== 'starting' || dockAppWindow(a)) continue;
      if (Date.now() - i.launchedAt < (i.lost ? APP_GONE_WAIT : APP_WAIT)) { waiting = true; continue; }
      if (i.lost) {
        // Closed from inside the app (File > Exit…): the tab shows it closed, with Open.
        Object.assign(i, { status: 'stopped', pid: null, lost: false, error: null, exit: { reason: 'closed', at: Date.now(), reopening: false, gaveUp: false } });
        pushStatus();
      } else {
        appFailed(a, `No window of ${a.name} showed up. Some Microsoft Store apps can't be shown inside Kitsun.`);
      }
    }
    if (!waiting) { clearInterval(appTimer); appTimer = null; }
  }, 1000);
}

// ---------- terminal tabs ----------

// A terminal tab runs PowerShell in a pseudo console (node-pty, over Windows' ConPTY) owned by main, and shows it in a
// WebContentsView with xterm.js (renderer/terminal.html), laid over its pane like a website tab. A catalogue entry's
// command (codex, gemini, …) runs in it at once (-NoExit -Command), so when the tool ends you are left at a prompt in the
// same folder. It keeps running while its tab is hidden; the page keeps the scrollback, and main keeps the latest
// output (TERM_BACKLOG) so a page that reloads draws it again. Close (or typing exit) ends it with everything it runs.
const TERM_BACKLOG = 256 * 1024;
const terms = new Map(); // tab id -> { pty, backlog, pending, flush, ready, wcId }
const termByWc = new Map(); // a terminal page's webContents id -> its tab id

// Packaged, node-pty is loaded from app.asar.unpacked: it starts a worker and a console helper from its own files,
// which can't be inside the archive. Loaded on first use, so a broken pty never stops Kitsun starting.
let ptyModule = null;
function loadPty() {
  const base = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules') : path.join(__dirname, 'node_modules');
  ptyModule ??= require(path.join(base, '@lydell', 'node-pty'));
  return ptyModule;
}

const powershellExe = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function termFailed(account, error) {
  const i = inst(account.id);
  Object.assign(i, { status: 'stopped', error });
  console.log(`${account.name}: ${error}`);
  pushStatus();
  return { ok: false, error };
}

function startTerminal(account) {
  const i = inst(account.id);
  if (!mainWindow || closing) return { ok: false };
  if (terms.has(account.id)) return { ok: true };
  i.stoppedByUser = false;
  i.exit = null;
  i.error = null;
  const cwd = fs.existsSync(account.cwd) ? account.cwd : os.homedir();
  const env = { ...cleanEnv(), COLORTERM: 'truecolor', TERM_PROGRAM: 'Kitsun' };
  let p;
  try {
    p = loadPty().spawn(powershellExe(), account.command ? ['-NoLogo', '-NoExit', '-Command', account.command] : ['-NoLogo'],
      { name: 'xterm-256color', cols: 100, rows: 30, cwd, env });
  } catch (err) {
    return termFailed(account, `${account.name} couldn't start: ${err.message}`);
  }
  const t = { pty: p, backlog: '', pending: '', flush: null, ready: false, wcId: null };
  terms.set(account.id, t);
  p.onData((data) => {
    t.backlog = (t.backlog + data).slice(-TERM_BACKLOG);
    if (!t.ready) return;
    // Output comes in many small pieces; they are sent to the page in one message per frame.
    t.pending += data;
    t.flush ??= setTimeout(() => {
      t.flush = null;
      const view = webViews.get(account.id);
      if (view && !view.webContents.isDestroyed()) view.webContents.send('term:data', t.pending);
      t.pending = '';
    }, 16);
  });
  p.onExit(() => {
    if (terms.get(account.id) !== t) return;
    // exit typed in it, or the window closing: the tab shows it closed, with Open.
    endTerminal(account.id);
    if (!i.stoppedByUser) i.exit = { reason: 'closed', at: Date.now(), reopening: false, gaveUp: false };
    layout();
    pushStatus();
  });

  const view = new WebContentsView({
    webPreferences: { partition: 'kitsun-terminal', sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload-terminal.js') },
  });
  view.setBackgroundColor('#0d0f15');
  view.setVisible(false);
  const wc = view.webContents;
  t.wcId = wc.id;
  termByWc.set(wc.id, account.id);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('focus', () => {
    if (state.ui.home || paneCount() < 2) return;
    const pn = visiblePanes().find((q) => state.ui.panes[q] === account.id);
    if (pn !== undefined && state.ui.focused !== pn) { state.ui.focused = pn; pushUi(); }
  });
  wc.on('render-process-gone', (_e, d) => {
    if (closing || d.reason === 'clean-exit') return;
    t.ready = false; // the reloaded page asks again (term:ready) and gets the backlog
    setTimeout(() => { if (!wc.isDestroyed()) wc.reload(); }, 1000);
  });
  // Dev aid: KITSUN_TERM_TEST=<folder> types a command through the page's own bridge once it has loaded, then logs the
  // end of the output and saves a picture of the page, so a run from source can be checked without touching the keyboard.
  if (process.env.KITSUN_TERM_TEST && !app.isPackaged) {
    wc.once('did-finish-load', () => setTimeout(async () => {
      if (wc.isDestroyed()) return;
      await wc.executeJavaScript("window.kitsunTerm.write('Write-Output \"kitsun-ok $($PSVersionTable.PSVersion)\"; Get-Location\\r')");
      setTimeout(async () => {
        if (wc.isDestroyed()) return;
        console.log(`term ${account.id}: ${JSON.stringify(t.backlog.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').slice(-300))}`);
        const img = await wc.capturePage().catch(() => null);
        if (img) fs.writeFileSync(path.join(process.env.KITSUN_TERM_TEST, `${account.id}.png`), img.toPNG());
      }, 4000);
    }, 3000));
  }
  mainWindow.contentView.addChildView(view);
  webViews.set(account.id, view);
  wc.loadFile(path.join(__dirname, 'renderer', 'terminal.html'));
  console.log(`${account.name}: started PowerShell${account.command ? ` running ${account.command}` : ''} in ${cwd}`);
  i.status = 'docked';
  i.startedAt = Date.now();
  layout();
  pushStatus();
  return { ok: true };
}

// Ends the pseudo console (and everything running in it) and closes its page.
function endTerminal(id) {
  const t = terms.get(id);
  terms.delete(id);
  if (t) {
    clearTimeout(t.flush);
    termByWc.delete(t.wcId);
    try { t.pty.kill(); } catch { /* already gone */ }
  }
  stopWeb(id);
}

// The terminal page's own calls: each is answered only for the tab whose page sent it.
const termOf = (event) => { const id = termByWc.get(event.sender.id); return id ? { id, t: terms.get(id) } : null; };
ipcMain.handle('term:ready', (event) => {
  const x = termOf(event);
  if (!x || !x.t) return null;
  x.t.ready = true;
  x.t.pending = '';
  const a = accountById(x.id);
  return { backlog: x.t.backlog, name: a ? a.name : '', color: a ? a.color : null };
});
ipcMain.on('term:input', (event, data) => {
  const x = termOf(event);
  if (x && x.t && typeof data === 'string' && data.length <= 1024 * 1024) x.t.pty.write(data);
});
ipcMain.on('term:resize', (event, cols, rows) => {
  const x = termOf(event);
  if (!x || !x.t || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 1000 || rows > 500) return;
  try { x.t.pty.resize(cols, rows); } catch { /* it just exited */ }
});
ipcMain.on('term:copy', (event, text) => { if (termOf(event) && typeof text === 'string') clipboard.writeText(text); });
ipcMain.handle('term:paste', (event) => (termOf(event) ? clipboard.readText() : ''));
ipcMain.on('term:open-link', (event, url) => { if (termOf(event)) openExternal(String(url)); });

// ---------- layout ----------

let stats = null; // the home screen's statistics collector, created once the app is ready
let paneRects = []; // pane body rects from the renderer, in DIP, relative to the window's client area
let overlayHidden = false; // true while a dialog is open over the panes
let closing = false; // set as soon as our window starts closing: nothing may be docked into it after that

const paneCount = () => LAYOUTS[state.ui.layout] || 1;

function visiblePanes() {
  return [...Array(paneCount()).keys()];
}

// The pane a tab click or Ctrl+Alt+1–9 fills.
const activePane = () => (state.ui.focused < paneCount() ? state.ui.focused : 0);

// The panes whose Claude windows are on screen: none while the home screen is shown.
function shownPanes() {
  return state.ui.home ? [] : visiblePanes();
}
// The home screen has no panes, so the renderer sends no rects while it shows. Leaving home uses the
// last real ones until the renderer's arrive, so a Claude window is placed at once instead of blinking.
let lastPaneRects = [];

// The DPI Windows actually uses for our window (right even when it straddles two monitors).
function scale() {
  return parentHwnd ? win32.dpiScale(parentHwnd) : 1;
}

// changedOnly: re-place only the windows whose pane moved or that aren't showing. Dragging a pane divider sends new
// rects every frame, and each SetWindowPos waits on that Claude's own thread, so the panes that didn't move are left
// alone then. Every other caller re-places them all, which is also what wakes a Claude that stopped painting.
function layout({ changedOnly = false } = {}) {
  if (!mainWindow || closing) return;
  const sf = scale();
  const shown = new Set();
  const rects = paneRects.length ? paneRects : lastPaneRects;
  if (!overlayHidden && !windowAway()) {
    for (const p of shownPanes()) {
      const id = state.ui.panes[p];
      const i = id && instances.get(id);
      const r = rects[p];
      // A website tab's view is placed in DIP, like the pane rects themselves.
      const view = id && webViews.get(id);
      if (view && r) { placeView(view, r); shown.add(id); continue; }
      // A copy we are stopping is hidden while it quits; its pane shows that instead.
      if (!i || !i.hwnd || !r || i.status === 'stopping') continue;
      const box = [r.x * sf, r.y * sf, r.width * sf, r.height * sf];
      const key = box.map(Math.round).join(',');
      if (!changedOnly || i.placed !== key || !win32.isVisible(i.hwnd)) i.placed = win32.place(i.hwnd, ...box, true) === false ? null : key;
      shown.add(id);
    }
  }
  for (const [id, view] of webViews) if (!shown.has(id)) view.setVisible(false);
  for (const [id, i] of instances) {
    if (!i.hwnd || shown.has(id)) continue;
    // Hiding is asynchronous; enforce() must not mistake a window still on its way out for one asking for attention.
    if (win32.hasVisibleStyle(i.hwnd)) i.hideSentAt = Date.now();
    win32.hide(i.hwnd);
    i.placed = null;
  }
}

// Minimised, or hidden in the tray: every docked window is hidden then.
function windowAway() {
  return !mainWindow.isVisible() || mainWindow.isMinimized();
}

// Notices docked windows that went away (returns true if any did) and runs the freeze watchdog: a window
// that has not responded for FREEZE_AFTER is marked frozen, so its account offers Wait or Restart.
function watchWindows() {
  const now = Date.now();
  let lost = false;
  let changed = false;
  for (const [id, i] of instances) {
    if (!i.hwnd || !win32.isWindow(i.hwnd)) {
      if (i.hwnd) {
        forgetWindow(id);
        const a = accountById(id);
        if (a && a.kind === 'app') {
          // Closed with the tab's Close (stoppedByUser), or by the app itself: then it gets a moment to show another.
          if (i.stoppedByUser) Object.assign(i, { status: 'stopped', pid: null });
          else Object.assign(i, { status: 'starting', launchedAt: now, lost: true });
        } else if (i.status !== 'stopping') {
          // Give it time to show a new window; scanProcesses() finds out if the process is gone instead.
          i.status = 'starting';
          i.launchedAt = now;
        }
        lost = true;
      }
      if (i.hungSince || i.frozen) { i.hungSince = 0; changed ||= i.frozen; i.frozen = false; }
      continue;
    }
    if (!isClaudeTab(id)) continue; // the freeze watchdog (Wait / Restart) is Claude's
    if (win32.isHung(i.hwnd)) {
      i.hungSince ||= now;
      if (!i.frozen && i.status === 'docked' && now - i.hungSince > FREEZE_AFTER && now > (i.waitUntil || 0)) {
        i.frozen = true;
        changed = true;
        const a = accountById(id);
        if (a) notify(`${a.name} isn't responding`, { id, kind: 'frozen' });
      }
    } else if (i.hungSince) {
      const was = i.frozen;
      i.hungSince = 0;
      i.frozen = false;
      i.waitUntil = 0;
      if (was) {
        changed = true;
        const a = accountById(id);
        if (a) notify(`${a.name} is responding again`, { id, kind: 'recovered', system: false });
      }
    }
  }
  if (changed) pushStatus();
  return lost;
}

// Keeps docked windows where they belong: Claude may maximise itself, move when its title bar is
// dragged, or show itself (e.g. after a notification is clicked). Cheap Win32 checks, no processes.
function enforce() {
  if (!mainWindow || closing) return;
  // Runs in every state, also while hidden in the tray: a copy that closes then must still be noticed and reopened.
  if (watchWindows()) { layout(); pushStatus(); watchStartup(); watchApps(); }
  if (windowAway()) {
    // All docked windows are hidden while minimised or in the tray, so one that shows itself means Claude
    // asked for attention (e.g. a notification was clicked): bring Kitsun back with that account showing.
    // IsWindowVisible() is false for every child of a hidden window, so the child's own WS_VISIBLE bit is read.
    for (const [id, i] of instances) {
      if (!i.hwnd || i.status === 'stopping' || win32.isHung(i.hwnd) || !win32.hasVisibleStyle(i.hwnd)) continue;
      // Still on its way out (layout() just hid it). Not hidden again here, so a real request in that moment still counts once it passes.
      if (Date.now() - (i.hideSentAt || 0) < 1500) continue;
      showWindow();
      if (!shownPanes().some((p) => state.ui.panes[p] === id)) showAccount(id);
      return;
    }
    return;
  }
  if (overlayHidden) {
    // A dialog is open: keep every Claude window hidden, even one that tries to show itself.
    for (const i of instances.values()) if (i.hwnd && win32.isVisible(i.hwnd)) win32.hide(i.hwnd);
    return;
  }
  let relayout = false;
  for (const [id, i] of instances) {
    if (!i.hwnd || i.status === 'stopping') continue;
    if (win32.isHung(i.hwnd)) continue;
    const paneIndex = shownPanes().find((p) => state.ui.panes[p] === id);
    if (win32.isZoomedOrMinimized(i.hwnd)) {
      win32.restore(i.hwnd);
      if (paneIndex === undefined) { win32.hide(i.hwnd); i.hideSentAt = Date.now(); continue; }
      relayout = true;
    }
    if (paneIndex === undefined && win32.isVisible(i.hwnd)) {
      // Still on its way out: layout() just hid it (a tab switch, going home), and hiding is asynchronous. Taking it for
      // Claude bringing itself forward would flip the switch back. Not hidden again here, as in the away branch above.
      if (Date.now() - (i.hideSentAt || 0) < 1500) continue;
      // Claude brought itself forward: show that account in the active pane.
      showAccount(id);
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      return;
    }
    if (paneIndex !== undefined && !relayout && paneRects[paneIndex]) {
      // Only move it if it drifted (e.g. its title bar was dragged), so Claude isn't re-laid-out constantly.
      const sf = scale();
      const origin = win32.clientOrigin(parentHwnd);
      const r = paneRects[paneIndex];
      const actual = win32.windowRect(i.hwnd);
      const off = Math.abs(actual.x - (origin.x + Math.round(r.x * sf))) + Math.abs(actual.y - (origin.y + Math.round(r.y * sf)))
        + Math.abs(actual.width - Math.round(r.width * sf)) + Math.abs(actual.height - Math.round(r.height * sf));
      if (off > 3 || !win32.isVisible(i.hwnd)) relayout = true;
    }
  }
  if (relayout) layout();

  // With two or three panes, the pane whose Claude window has keyboard focus becomes the active pane.
  if (paneCount() > 1 && !state.ui.home) {
    const focus = win32.focusedWindow();
    for (const p of visiblePanes()) {
      const i = instances.get(state.ui.panes[p]);
      if (i && i.hwnd && win32.contains(i.hwnd, focus) && state.ui.focused !== p) {
        state.ui.focused = p;
        pushUi();
      }
    }
  }
}

// Fills the active pane. An account already in another pane (shown or not) swaps places with the active pane's.
function showAccount(id) {
  const ui = state.ui;
  const p = activePane();
  const other = ui.panes.indexOf(id);
  if (other >= 0 && other !== p) ui.panes[other] = ui.panes[p];
  ui.panes[p] = id;
  ui.focused = p;
  ui.home = false;
  saveState();
  layout();
  pushUi();
  pokeAttention(); // its "unseen" dot goes once it is on screen
  const i = instances.get(id);
  // Before the first scan we don't know what is running yet; the startup code starts what's needed.
  // One the user stopped stays stopped until they click Start in its pane.
  if (firstScanDone && (!i || (i.status === 'stopped' && !i.stoppedByUser))) startAccount(id);
  else if (i && i.hwnd) setTimeout(focusActivePane, 50);
}

function showHome() {
  state.ui.home = true;
  saveState();
  layout();
  pushUi();
}

function focusActivePane() {
  if (!mainWindow || closing || overlayHidden || state.ui.home || !mainWindow.isFocused()) return;
  const view = webViews.get(state.ui.panes[activePane()]);
  if (view) { view.webContents.focus(); return; }
  const i = instances.get(state.ui.panes[activePane()]);
  if (i && i.hwnd && win32.isWindow(i.hwnd) && !win32.isHung(i.hwnd)) win32.focus(i.hwnd);
}

// Switches between one, two and three panes side by side (LAYOUTS). Refused (nothing changes) without an account for
// every pane. Fewer panes keep the active pane's account on screen; more panes show the accounts kept for them, or the
// first ones not shown yet. Accounts that land in a pane and are stopped (not by the user) are started.
function setLayout(name) {
  const ui = state.ui;
  const n = LAYOUTS[name];
  if (!n || n > state.accounts.length) return false;
  ui.home = false;
  // Accounts added since the panes were last filled get the empty panes; the active pane keeps its account.
  const activeId = ui.panes[activePane()];
  ui.panes = fillPanes(ui.panes, state.accounts);
  const p = activeId ? Math.max(0, ui.panes.indexOf(activeId)) : 0;
  if (p >= n) {
    // e.g. three columns with the right one active, down to two: it becomes the right one of the two.
    [ui.panes[n - 1], ui.panes[p]] = [ui.panes[p], ui.panes[n - 1]];
    ui.focused = n - 1;
  } else ui.focused = p;
  ui.layout = name;
  ui.split = n > 1;
  saveState();
  layout();
  pokeAttention(); // an account that came on screen loses its "unseen" dot
  for (const q of visiblePanes()) {
    const id = ui.panes[q];
    const i = instances.get(id);
    if (firstScanDone && id && (!i || (i.status === 'stopped' && !i.stoppedByUser))) startAccount(id);
  }
  return true;
}

// auto: an automatic reopen, which keeps the reason it closed (its pane says why it is reopening).
// Any other start is the user's (or startup's): it ends a Stop and replaces a pending automatic reopen.
async function startAccount(id, { auto = false } = {}) {
  const account = accountById(id);
  if (!account) return { ok: false };
  const i = inst(id);
  if (account.kind === 'web') {
    i.stoppedByUser = false;
    i.exit = null;
    return startWeb(account);
  }
  if (account.kind === 'app') return startApp(account);
  if (account.kind === 'terminal') return startTerminal(account);
  if (i.status === 'external') return { ok: false, error: 'external' };
  if (i.status === 'stopping') return { ok: false, error: `${account.name} is still quitting. Try again in a moment.` };
  if (!auto) {
    cancelRestart(i);
    i.stoppedByUser = false;
    i.exit = null;
  }
  i.status = 'starting';
  i.launchedAt = Date.now();
  i.error = null;
  i.quitAskedAt = 0; // a new copy: an earlier Stop's request was for the old one
  pushStatus();
  const result = await launchClaude(account);
  if (!result.ok) { i.status = 'stopped'; i.error = result.error; pushStatus(); return result; }
  watchStartup();
  return result;
}

// After a launch, look for the new window often for a while, then fall back to the slow scan.
let startupTimer = null;
function watchStartup() {
  clearInterval(startupTimer);
  let ticks = 0;
  startupTimer = setInterval(async () => {
    ticks++;
    if (closing) { clearInterval(startupTimer); return; }
    await scanProcesses();
    const waiting = [...instances.values()].some((i) => i.status === 'starting');
    if (!waiting || ticks > 40) clearInterval(startupTimer);
  }, 1000);
}

// ---------- keeping accounts running ----------

// Windows closes every running copy of the Claude package to install an update (each copy's main.log says
// "Windows session ending (close-app)"); only the copy that installed it reopens itself. So when a copy we
// didn't stop goes away, its log says why, and one closed for an update or by a crash is reopened.
const RESTART_DELAY = 5000; // lets the old process let go of its files first
const SEVERAL_AT_ONCE = 15000; // copies closing this close together were closed by Windows
const UPDATE_WAIT = 120000; // longest wait for an update to finish installing before reopening anyway
const SELF_RELAUNCH_WAIT = 45000; // how long the copy that installed the update gets to reopen itself
const FREEZE_AFTER = 20000; // a window that hasn't responded for this long counts as frozen
const STOP_WAIT = 20000; // Claude's own quit clean-up gives up after 15 s
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let recentCloses = []; // { id, at } of copies that closed on their own lately

function onClosed(account, i) {
  const at = Date.now();
  i.status = 'stopped';
  i.frozen = false;
  i.hungSince = 0;
  // A Stop that took longer than we waited still counts as the user's Stop (its log would say close-app).
  if (!i.stoppedByUser && at - (i.quitAskedAt || 0) < 120000) {
    i.stoppedByUser = true;
    i.exit = { reason: 'stopped', at, reopening: false, gaveUp: false };
  }
  i.quitAskedAt = 0; // that copy is gone; a Stop asked of it says nothing about the next one
  // Our own Stop or freeze restart; or Kitsun itself is quitting.
  if (i.stoppedByUser || at < (i.expectExitUntil || 0) || closing) { pushStatus(); return; }
  recentCloses = recentCloses.filter((c) => at - c.at < 60000);
  const others = recentCloses.filter((c) => c.id !== account.id && at - c.at <= SEVERAL_AT_ONCE);
  recentCloses.push({ id: account.id, at });
  const r = health.exitReason(account, at);
  let reason = r.reason;
  // Several copies going together means Windows closed them, even when a log can't be read.
  const together = (x) => x === 'crash' || x === 'unknown';
  if (others.length && together(reason)) reason = 'update';
  i.exit = { reason, at, selfRelaunch: r.selfRelaunch, fromVersion: i.version || state.claudeVersion, reopening: false, gaveUp: false };
  console.log(`${account.name}'s Claude closed (${reason})${r.file ? `, from ${r.file}` : ''}`);
  if (reason === 'update') {
    for (const c of others) {
      const o = instances.get(c.id);
      if (o && o.exit && o.status === 'stopped' && together(o.exit.reason)) { o.exit.reason = 'update'; scheduleRestart(c.id); }
    }
  }
  scheduleRestart(account.id);
}

// Reopens it after `delay`, if the settings and the limit (3 times in 10 minutes) allow.
function scheduleRestart(id, delay = RESTART_DELAY) {
  const i = inst(id);
  const e = i.exit;
  if (!e || closing || i.stoppedByUser || !state.settings.autoRestart || !['update', 'crash'].includes(e.reason)) { pushStatus(); return; }
  const budget = health.restartBudget(i.restarts);
  i.restarts = budget.recent;
  clearTimeout(i.restartTimer);
  i.restartTimer = null;
  if (!budget.allowed) {
    e.reopening = false;
    e.gaveUp = true;
  } else {
    e.reopening = true;
    i.restartTimer = setTimeout(() => {
      i.restartTimer = null;
      reopen(id, e).catch((err) => console.error('Could not reopen', id, err));
    }, delay);
  }
  pushStatus();
}

function cancelRestart(i) {
  clearTimeout(i.restartTimer);
  i.restartTimer = null;
  if (i.exit) i.exit.reopening = false;
}

// Still wanted after a wait? The user may have started or stopped it, or turned the setting off, meanwhile.
function stillReopening(id, e) {
  const i = instances.get(id);
  return Boolean(i && i.exit === e && e.reopening && !closing && !i.stoppedByUser && state.settings.autoRestart && accountById(id));
}

async function reopen(id, e) {
  if (!stillReopening(id, e)) return;
  if (e.reason === 'update') {
    await claudeUpdateInstalled(e.fromVersion, e.at);
    if (e.selfRelaunch) await comesBackByItself(id, SELF_RELAUNCH_WAIT);
  }
  if (!stillReopening(id, e)) return;
  // It may be back already: Claude reopens the copy that installed the update by itself.
  if (!(await scanProcesses())) { scheduleRestart(id, 10000); return; }
  const i = inst(id);
  if (!stillReopening(id, e) || i.pid || i.status !== 'stopped') return;
  i.restarts.push(Date.now());
  e.launched = true;
  const result = await startAccount(id, { auto: true });
  if (!result.ok && i.exit === e) scheduleRestart(id, 20000);
}

async function comesBackByItself(id, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until && !closing) {
    await scanProcesses();
    if (inst(id).pid) return true;
    await sleep(3000);
  }
  return false;
}

// Resolves once the Claude package reports a version other than `fromVersion` (or a copy already runs one),
// or after UPDATE_WAIT. Shared, so several copies closed by one update wait on one check.
let updateWait = null;
let runningVersion = null; // newest Claude version seen in the last process scan
function claudeUpdateInstalled(fromVersion, since) {
  if (updateWait && updateWait.from === fromVersion) return updateWait.promise;
  const entry = { from: fromVersion, promise: null };
  entry.promise = (async () => {
    await sleep(RESTART_DELAY);
    while (Date.now() < since + UPDATE_WAIT && !closing) {
      if (fromVersion && runningVersion && health.compareVersions(runningVersion, fromVersion) > 0) return true;
      const pkg = await claudePackage();
      if (pkg && /^ok$/i.test(pkg.status)) {
        // Without a version to compare with, a package that has been fine for 30 s will have to do.
        if (fromVersion ? health.compareVersions(pkg.version, fromVersion) !== 0 : Date.now() - since > 30000) return true;
      }
      await sleep(5000);
    }
    return false;
  })().finally(() => { if (updateWait === entry) updateWait = null; });
  updateWait = entry;
  return entry.promise;
}

// The installed Claude package's version and status ('Ok' once an update has finished installing).
function claudePackage() {
  return new Promise((resolve) => {
    const ps = "Get-AppxPackage -Name 'Claude*' | Where-Object { $_.PackageFamilyName -like 'Claude_*' } | Select-Object -First 1 | ForEach-Object { \"$($_.Version)`t$($_.Status)\" }";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      const [version, status] = String(stdout || '').trim().split('\t');
      resolve(!err && /^\d+(\.\d+)+$/.test(version || '') ? { version, status: status || '' } : null);
    });
  });
}

// Remembers the newest Claude version running. A newer one than before means Claude updated: say so once
// the copies it closed are back (or after 3 minutes), naming the ones Kitsun reopened.
let updateNotice = null;
let announceTimer = null;
function noteClaudeVersion(procs) {
  const versions = procs.map((p) => health.versionFromExe(p.exe)).filter(Boolean);
  if (!versions.length) return;
  const newest = versions.reduce((a, b) => (health.compareVersions(a, b) >= 0 ? a : b));
  runningVersion = newest;
  const known = state.claudeVersion;
  if (known === newest) return;
  state.claudeVersion = newest;
  saveState();
  if (!known || health.compareVersions(newest, known) <= 0) return;
  updateNotice = { version: newest, at: Date.now() };
  clearInterval(announceTimer);
  announceTimer = setInterval(() => {
    if (closing || !updateNotice) { clearInterval(announceTimer); return; }
    const pending = [...instances.values()].some((i) => i.exit && i.exit.reason === 'update' && i.exit.reopening);
    if (pending && Date.now() - updateNotice.at < 3 * 60000) return;
    clearInterval(announceTimer);
    const since = updateNotice.at - 5 * 60000;
    const names = state.accounts.filter((a) => { const r = inst(a.id).reopened; return r && r.reason === 'update' && r.at >= since; }).map((a) => a.name);
    notify(`Claude updated to ${health.displayVersion(updateNotice.version)}${names.length ? ` · reopened ${health.listNames(names)}` : ''}`, { kind: 'update' });
    updateNotice = null;
  }, 2000);
}

// Called when a copy is docked: an automatic reopen has worked, so its closing reason is done with.
function reopened(account, i) {
  const e = i.exit;
  i.exit = null;
  i.stoppedByUser = false;
  // Only the ones Kitsun launched count; the copy that installed an update reopens itself.
  if (!e || !e.reopening || !e.launched) return;
  i.reopened = { reason: e.reason, at: Date.now() };
  // An update is announced as a whole (see noteClaudeVersion); a crash on its own.
  if (e.reason === 'crash') notify(`${account.name}'s Claude closed unexpectedly · reopened it`, { id: account.id, kind: 'reopened' });
}

// Tells the page (a toast in the title bar) and, while Kitsun is hidden or in the background and the
// setting allows it, Windows too. Clicking the notification shows that account.
// setting: the Settings key that allows the Windows notification. action: { label, id }, a button in the toast
// that shows account `id` (e.g. "Switch").
const liveNotifications = new Set(); // kept referenced, or a click may never arrive
function notify(text, { id = null, kind = 'info', system = true, setting = 'notifyRestarts', action = null } = {}) {
  if (!mainWindow || closing) return;
  mainWindow.webContents.send('notice', { text, id, kind, action: action && accountById(action.id) ? { label: action.label, id: action.id } : null });
  if (!system || !state.settings[setting] || !(windowAway() || !mainWindow.isFocused())) return;
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: 'Kitsun', body: text, icon: path.join(__dirname, 'build', 'icon.png') });
    liveNotifications.add(n);
    const drop = () => liveNotifications.delete(n);
    n.on('click', () => { drop(); showWindow(); if (id && accountById(id)) showAccount(id); });
    n.on('close', drop);
    n.show();
  } catch (err) {
    console.error('Could not show a notification:', err);
  }
}

// ---------- "needs you" and plan limits ----------

// lib/attention.js works out which Claude Code sessions are waiting for the person, finished unseen or are working
// (its header has the evidence), and reads each account's plan usage. Polled every few seconds: a stat per file and a
// parse of what changed. The page gets 'sessions' only when something changed.
const ATTENTION_EVERY = 5000;
const WAIT_GAP = 30000; // a session back to waiting within this is still in the same waiting period (no second notice)
let attention = null;
let attentionTimer = null;
let attentionBusy = false;
let attentionPrimed = false; // the first poll only learns what is already waiting; it notifies nothing
let sessionsPayload = {};
let lastSessions = '';
const waitingSeenAt = new Map(); // sessionId -> last poll it was waiting at

// The accounts whose Claude window is on screen (not home, not hidden or minimised).
function onScreenAccounts() {
  if (!mainWindow || closing || windowAway()) return new Set();
  return new Set(shownPanes().map((p) => state.ui.panes[p]).filter(Boolean));
}

async function pollAttention() {
  if (!attention || attentionBusy || closing || !mainWindow) return;
  attentionBusy = true;
  try {
    const shown = onScreenAccounts();
    // On screen with Kitsun in front (no dialog over it) counts as seen: the person was there when it finished.
    const looking = mainWindow.isFocused() && !overlayHidden ? shown : new Set();
    const running = new Set(state.accounts.filter((a) => inst(a.id).pid).map((a) => a.id));
    const { accounts, limits } = await attention.poll(claudeTabs(), { running, looking });
    if (closing || !mainWindow) return;
    noticeWaiting(accounts, shown);
    for (const e of limits) noticeLimit(e, accounts);
    // The search index reads the same session files (cached by file time); it rebuilds at most every 10 s.
    if (search) search.refresh(claudeTabs()).catch((err) => console.error('Could not index sessions:', err));
    // A sign-in to Claude in Chrome (or a new Chrome profile) shows on the Chrome buttons within half a minute.
    if (Date.now() - chromeAt > CHROME_EVERY) refreshChrome();
    attentionPrimed = true;
    sessionsPayload = accounts;
    const s = JSON.stringify(accounts);
    if (s !== lastSessions) {
      lastSessions = s;
      mainWindow.webContents.send('sessions', accounts);
      updateTrayTip();
    }
  } catch (err) {
    console.error('Could not check sessions:', err);
  } finally {
    attentionBusy = false;
  }
}

// Soon after the person switches accounts, so a badge they have just looked at goes away quickly.
let attentionPoke = null;
function pokeAttention() {
  clearTimeout(attentionPoke);
  attentionPoke = setTimeout(pollAttention, 400);
}

// A session in an account that isn't on screen started waiting for the person: one toast (and a Windows notification
// while Kitsun isn't in front) per waiting period, so a turn asking for several permissions in a row says it once.
function noticeWaiting(accounts, shown) {
  const now = Date.now();
  const fresh = [];
  for (const a of claudeTabs()) {
    for (const it of (accounts[a.id] && accounts[a.id].items) || []) {
      if (it.state !== 'waiting') continue;
      const last = waitingSeenAt.get(it.sessionId);
      waitingSeenAt.set(it.sessionId, now);
      if (last !== undefined && now - last <= WAIT_GAP + ATTENTION_EVERY) continue;
      if (attentionPrimed && !shown.has(a.id)) fresh.push({ a, it });
    }
  }
  for (const [sid, t] of waitingSeenAt) if (now - t > 10 * 60000) waitingSeenAt.delete(sid);
  if (!fresh.length || !state.settings.notifyNeedsYou) return;
  const { a, it } = fresh[0];
  const more = fresh.length - 1;
  notify(`${a.name} needs you · ${it.title}: ${it.detail}${more ? ` · and ${more} more` : ''}`,
    { id: a.id, kind: 'needs-you', setting: 'notifyNeedsYou', action: { label: 'Show', id: a.id } });
}

// type: 'high' (5-hour >= 90%), 'weekly' (weekly >= 90%) or 'reset' (5-hour back from >= 50% to <= 5%).
function noticeLimit({ id, type, pct }, accounts) {
  const a = accountById(id);
  if (!a || !state.settings.notifyLimits) return;
  if (type === 'reset') { notify(`${a.name}'s 5-hour limit has reset`, { id, kind: 'limit', setting: 'notifyLimits' }); return; }
  const key = type === 'weekly' ? 'weekly' : 'fiveHour';
  // The other account with the most of the same limit left, if it has more left than this one.
  const best = claudeTabs()
    .filter((o) => o.id !== id && accounts[o.id] && accounts[o.id].usage)
    .map((o) => ({ o, used: accounts[o.id].usage[key] }))
    .sort((x, y) => x.used - y.used)[0];
  const alt = best && best.used < pct ? best : null;
  notify(`${a.name} is at ${Math.round(pct)}% of its ${type === 'weekly' ? 'weekly' : '5-hour'} limit${alt ? ` · ${alt.o.name} has the most left (at ${Math.round(alt.used)}%)` : ''}`,
    { id: alt ? alt.o.id : id, kind: 'limit', setting: 'notifyLimits', action: alt ? { label: 'Switch', id: alt.o.id } : null });
}

// ---------- search across accounts ----------

// lib/search.js indexes every account's local Code sessions; search:query answers from it.
let search = null;

// Shows a session found by search in its own account. The link goes to that account's copy only: launchClaude starts
// the alias with the account's own --user-data-dir (none for the main account), and Claude's single-instance handoff
// passes it to the copy already running with that folder (or the new copy opens it). Claude then shows the session,
// or Code's home if it has no such non-archived session. opened: false means the link wasn't sent (archived).
async function openSession(id, sessionId) {
  const account = accountById(id);
  const i = inst(id);
  const doc = search && search.find(id, sessionId);
  if (!doc) return { ok: false, error: `That session isn't in ${account.name} any more.` };
  // Claude's handler only looks among sessions that aren't archived, so it would just show Code's home.
  if (doc.archived) { showAccount(id); return { ok: true, opened: false }; }
  if (i.status === 'stopping') return { ok: false, error: `${account.name} is still quitting. Try again in a moment.` };
  const link = sessionLink(doc.sessionId);
  const wasStopped = i.status === 'stopped';
  if (wasStopped) {
    // Opening a session starts its account, like the user's Start (it ends a Stop and a pending reopen).
    cancelRestart(i);
    i.stoppedByUser = false;
    i.exit = null;
    i.status = 'starting';
    i.launchedAt = Date.now();
    i.error = null;
    i.quitAskedAt = 0; // a new copy: an earlier Stop's request was for the old one
    pushStatus();
  }
  showAccount(id); // set to 'starting' first, so this doesn't launch a second copy
  const result = await launchClaude(account, [link]);
  if (!result.ok) {
    if (wasStopped) { i.status = 'stopped'; i.error = result.error; pushStatus(); }
    return result;
  }
  watchStartup();
  return { ok: true, opened: true };
}

// The quick switcher (Ctrl+Alt+K, the title bar's search button, the tray menu). The page must have the keyboard
// first: while a docked Claude window has it, the switcher's box would get no typing.
function openSwitcher() {
  if (!mainWindow || closing) return;
  mainWindow.webContents.focus();
  mainWindow.webContents.send('open-switcher');
}

function updateTrayTip() {
  if (!tray) return;
  const n = Object.values(sessionsPayload).reduce((sum, r) => sum + ((r && r.waiting) || 0), 0);
  try { tray.setToolTip(n ? `Kitsun · ${n} session${n === 1 ? ' needs' : 's need'} you` : 'Kitsun'); } catch { /* cosmetic */ }
}

// ---------- each account's Chrome profile ----------

// lib/chrome.js reads Chrome's profiles and finds the one whose Claude in Chrome extension is signed in to each account
// (its header has the rule); an account can also have one picked by hand (account.chromeProfile). The page and the tray
// only ever name an account: main resolves the profile and starts chrome.exe itself.
const CHROME_EVERY = 30000; // re-checked this often (piggybacking on the attention poll); unchanged files aren't re-read
let chrome = null;
let chromeSnap = null; // the last snapshot, for the tray menu (built synchronously)
let chromeAt = 0;
let lastChrome = '';

// What the page gets: no exe path or account UUIDs. accounts[id]: { auto: { dir, name, how } | null, chosen, missing, link: { dir, name, manual } | null }.
const chromePayload = (s) => ({ installed: Boolean(s && s.exe), profiles: s ? s.profiles : [], accounts: s ? s.links : {} });

async function refreshChrome({ fresh = false } = {}) {
  if (!chrome || closing) return chromeSnap;
  chromeAt = Date.now();
  try {
    chromeSnap = await chrome.snapshot(claudeTabs(), { fresh });
  } catch (err) {
    console.error('Could not read Chrome profiles:', err);
    return chromeSnap;
  }
  const s = JSON.stringify(chromePayload(chromeSnap));
  if (s !== lastChrome && !closing) {
    lastChrome = s;
    if (mainWindow) mainWindow.webContents.send('chrome', JSON.parse(s));
    updateTrayMenu();
  }
  return chromeSnap;
}

// Opens the account's Chrome profile in a new Chrome window (Chrome hands it to its running copy, if any).
async function openChrome(id) {
  const account = accountById(id);
  if (!account || !chrome) return { ok: false };
  const snap = await refreshChrome({ fresh: true });
  if (!snap || !snap.exe) return { ok: false, error: 'Google Chrome isn\'t installed on this PC.' };
  const link = snap.links[id] && snap.links[id].link;
  if (!link || !PROFILE_DIR_RE.test(link.dir)) {
    return { ok: false, unlinked: true, error: `No Chrome profile is linked to ${account.name} yet. Sign in to Claude in Chrome with it, or pick a profile in its settings.` };
  }
  try {
    await spawnDetached(snap.exe, [`--profile-directory=${link.dir}`], cleanEnv());
  } catch (err) {
    return { ok: false, error: `Chrome didn't start: ${err && err.message ? err.message : err}` };
  }
  return { ok: true, profile: link.name };
}

// ---------- stopping and restarting a copy ----------

// process.kill(pid, 0) only checks; EPERM means it exists but isn't ours to signal.
function processGone(pid) {
  try { process.kill(pid, 0); return false; } catch (err) { return err.code === 'ESRCH'; }
}

// The copy's process was seen to exit (waitForExit): it is stopped now, without waiting for a process list that may
// have been read before it went. Only if it is still the process we waited on (not a new copy started meanwhile).
function markExited(id, pid) {
  const i = inst(id);
  if (i.pid !== pid) return;
  forgetWindow(id);
  i.pid = null;
  i.quitAskedAt = 0; // the Stop it was asked by is done with
  i.status = 'stopped';
  i.frozen = false;
  i.hungSince = 0;
  pushStatus();
}

async function waitForExit(pid, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (processGone(pid)) return true;
    await sleep(500);
  }
  return processGone(pid);
}

function killTree(pid) {
  return new Promise((resolve) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
}

// Stop: Claude is asked to quit the way Windows asks an app to close for an update (WM_ENDSESSION). Claude
// treats that like File > Exit: it runs its own clean-up and quits, where a plain close (WM_CLOSE, or
// taskkill without /F) only hides it to its tray. If it is still running after STOP_WAIT the page asks the
// user whether to force it (force: taskkill /T /F). It then stays stopped until its Start is clicked or
// Kitsun starts again.
async function stopAccount(id, { force = false } = {}) {
  const account = accountById(id);
  const i = inst(id);
  if (account.kind === 'web') {
    stopWeb(id);
    i.stoppedByUser = true;
    i.exit = { reason: 'stopped', at: Date.now(), reopening: false, gaveUp: false };
    layout();
    pushStatus();
    return { ok: true };
  }
  if (account.kind === 'app') return stopApp(account);
  if (account.kind === 'terminal') {
    i.stoppedByUser = true;
    i.exit = { reason: 'stopped', at: Date.now(), reopening: false, gaveUp: false };
    endTerminal(id);
    layout();
    pushStatus();
    return { ok: true };
  }
  if (i.status === 'stopping') return { ok: false, error: `${account.name} is already stopping.` };
  if (!(await scanProcesses())) return { ok: false, error: 'Could not check whether its Claude is running. Try again.' };
  if (i.status === 'external') return { ok: false, error: `${account.name} is open in its own window. Quit it from that window.` };
  const pid = i.pid;
  // Asking means a window that responds. Without one nothing is sent, and the page is told so (notAsked), rather than
  // that it "didn't quit": forcing it is then the only way, and the page words its question that way.
  const hwnd = pid && !force ? i.hwnd || win32.findAppWindow(pid) : 0;
  if (pid && !force && (!hwnd || win32.isHung(hwnd))) {
    const reason = hwnd ? 'not responding' : 'no window';
    return { ok: false, notAsked: true, reason, error: `${account.name}'s Claude ${hwnd ? 'isn\'t responding' : 'has no window yet'}, so it couldn't be asked to quit.` };
  }
  cancelRestart(i);
  i.stoppedByUser = true;
  i.exit = { reason: 'stopped', at: Date.now(), reopening: false, gaveUp: false };
  if (!pid) { i.status = 'stopped'; pushStatus(); return { ok: true }; }
  i.status = 'stopping';
  i.frozen = false;
  layout();
  pushStatus();
  let gone = false;
  let asked = false;
  if (force) {
    await killTree(pid);
    gone = await waitForExit(pid, 10000);
  } else {
    asked = win32.askToQuit(hwnd);
    if (asked) i.quitAskedAt = Date.now();
    gone = asked && (await waitForExit(pid, STOP_WAIT));
  }
  if (gone) {
    // Stopped now; the process list (read again, after the exit) just catches up. onClosed isn't run: it is our Stop.
    markExited(id, pid);
    await scanProcesses({ fresh: true });
    return { ok: true };
  }
  // Still running: back to how it was, so the user can decide about forcing it.
  i.stoppedByUser = false;
  i.exit = null;
  i.status = i.hwnd ? 'docked' : 'starting';
  i.launchedAt = Date.now();
  layout();
  pushStatus();
  if (force) return { ok: false, error: `${account.name}'s Claude couldn't be stopped.` };
  if (!asked) return { ok: false, notAsked: true, reason: 'not responding', error: `${account.name}'s Claude couldn't be asked to quit.` };
  return { ok: false, stillRunning: true, error: `${account.name}'s Claude didn't quit.` };
}

// Stop for a frozen copy: it can't be asked to quit, so it is ended (taskkill /T /F) after a native confirmation, for
// the same reason as restartFrozen: a dialog in our page would sit under the frozen window, and make the title bar's
// Wait / Restart alert inert while it is open.
async function stopFrozen(id) {
  const account = accountById(id);
  const i = inst(id);
  const pid = i.pid;
  if (!pid || i.status === 'stopping' || i.status === 'external') return { ok: false, error: `${account.name} isn't running here.` };
  const detail = account.main
    ? `${account.name} is your main Claude app and isn't responding, so it can't be asked to quit. Stopping it ends everything running in it at once, including every Claude Code session in it. It stays closed until you start it again.`
    : `${account.name}'s Claude isn't responding, so it can't be asked to quit. Stopping it ends everything running in it at once, including any Claude Code session working there. It stays closed until you start it again.`;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning', title: 'Kitsun', message: `Stop ${account.name}?`, detail,
    buttons: [`Stop ${account.name}`, 'Keep waiting'], defaultId: 1, cancelId: 1, noLink: true,
  });
  if (response !== 0 || closing) return { ok: false, cancelled: true };
  if (i.pid !== pid) return { ok: true }; // it went away meanwhile
  return stopAccount(id, { force: true });
}

// A frozen copy can't be asked to quit, so it is ended (with everything it runs) and started again, after a
// native confirmation: a dialog in our page would sit under the frozen window, which can't be hidden.
async function restartFrozen(id) {
  const account = accountById(id);
  const i = inst(id);
  const pid = i.pid;
  if (!pid || i.status === 'stopping' || i.status === 'external') return { ok: false, error: `${account.name} isn't running here.` };
  const detail = account.main
    ? `${account.name} is your main Claude app. Restarting it ends everything running in it, including any Claude Code session working there. Your chats and past sessions are kept.`
    : `This ends everything running in ${account.name}'s Claude, including any Claude Code session working there, and starts it again. Your chats and past sessions are kept.`;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning', title: 'Kitsun', message: `Restart ${account.name}?`, detail,
    buttons: [`Restart ${account.name}`, 'Keep waiting'], defaultId: 1, cancelId: 1, noLink: true,
  });
  if (response !== 0 || closing) return { ok: false, cancelled: true };
  if (i.pid !== pid) return { ok: true }; // it went away meanwhile
  cancelRestart(i);
  i.exit = null;
  i.stoppedByUser = false;
  i.expectExitUntil = Date.now() + 30000;
  i.status = 'stopping';
  i.frozen = false;
  i.hungSince = 0;
  layout();
  pushStatus();
  await killTree(pid);
  const gone = await waitForExit(pid, 10000);
  // Once it is gone it is stopped at once: a process list read before it went would keep it 'stopping', and
  // startAccount below would refuse.
  if (gone) markExited(id, pid);
  await scanProcesses({ fresh: true });
  if (!gone) {
    i.status = i.hwnd ? 'docked' : 'starting';
    i.launchedAt = Date.now();
    pushStatus();
    return { ok: false, error: `${account.name}'s Claude couldn't be ended. Try again, or end it in Task Manager.` };
  }
  await sleep(1000);
  return startAccount(id);
}

// ---------- continue a session in another account (beta) ----------

// lib/handoff.js copies a Claude Code session into a NEW session of another account that shares the same Claude Code
// folder (its header has the evidence from Claude's own code); the original is never changed. The page names only
// the accounts and the session; main checks that its own search index found that session in that account, and finds
// every folder itself. A copy that is running only lists the sessions it read when it started, so it has to restart
// to show the new one (handoff:restart, after the page has asked).
const handoffs = new Map(); // new session id -> the account it was made in, so handoff:restart only shows those
let handoffBusy = false;

const sameFolder = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// Whether a Claude Code process is resuming that session (each copy runs it as claude.exe … --resume=<cliSessionId>,
// and keeps it running while the session is open, idle or not). true / false, or null when it can't be told.
// Only asked about a transcript that ends mid-turn: without such a process, the turn was cut off by a quit or crash.
function cliSessionRunning(cliSessionId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(cliSessionId))) return Promise.resolve(null);
  return new Promise((resolve) => {
    const ps = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
      + "Get-CimInstance Win32_Process -Filter \"Name LIKE 'claude%.exe'\" | Where-Object { $_.CommandLine -like '*" + cliSessionId + "*' } | ForEach-Object { $_.CommandLine }";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(new RegExp(`--resume[= ]"?${cliSessionId}\\b`, 'i').test(String(stdout || '')));
    });
  });
}

// needsRestart: the target's Claude is running and lists the session only after a restart (canRestart: Kitsun
// can do that; not for a copy open in its own window). started: it wasn't running and starts with the session open.
async function startHandoff(fromId, toId, sessionId) {
  const from = accountById(fromId);
  const to = accountById(toId);
  if (handoffBusy) return { ok: false, error: 'Another session is being copied. Try again in a moment.' };
  if (!sameFolder(codeDirOf(from), codeDirOf(to))) {
    return { ok: false, error: `${to.name} uses its own Claude Code folder, so it can't read this conversation. Turn on "Share Claude Code settings" for both accounts.` };
  }
  if (search) await search.refresh(claudeTabs(), { force: true }).catch(() => {});
  const doc = search && search.find(fromId, sessionId);
  if (!doc) return { ok: false, error: `That session isn't in ${from.name} any more.` };
  // Mid-turn, the copy would stop halfway through what Claude is doing. A pending permission, question or plan prompt
  // holds its turn open too. These are the watcher's last view; continueSession also reads the transcript itself, so a
  // turn whose "working" went stale (a long reply) is refused there.
  const live = ((sessionsPayload[fromId] || {}).items || []).find((it) => it.sessionId === sessionId);
  if (live && live.state === 'working') return { ok: false, error: `“${doc.title}” is still working in ${from.name}. Wait for its turn to end (or stop it), then try again.` };
  if (live && live.state === 'waiting' && ['permission', 'question', 'plan'].includes(live.kind)) {
    return { ok: false, error: `“${doc.title}” is waiting for your answer in ${from.name}. Answer it (or stop the turn) there, then try again.` };
  }
  handoffBusy = true;
  let r;
  try {
    r = await continueSession({
      sessionId,
      source: { name: from.name, dataDir: accountDataDir(from), codeDir: codeDirOf(from) },
      target: { name: to.name, dataDir: accountDataDir(to), codeDir: codeDirOf(to) },
      cliRunning: cliSessionRunning,
    });
  } finally {
    handoffBusy = false;
  }
  if (!r.ok) return { ok: false, error: r.error };
  console.log(`Continued ${sessionId} (${from.name}) as ${r.sessionId} in ${to.name}`);
  handoffs.set(r.sessionId, toId);
  if (search) await search.refresh(claudeTabs(), { force: true }).catch(() => {});
  const base = { ok: true, sessionId: r.sessionId, title: r.title };
  await scanProcesses(); // whether its Claude runs right now decides between a restart and a plain start
  const i = inst(toId);
  if (i.status === 'external') return { ...base, needsRestart: true, canRestart: false };
  if (i.pid || i.status !== 'stopped') return { ...base, needsRestart: true, canRestart: true };
  // Not running: it reads the new session as it starts, and the link opens it.
  const o = await openSession(toId, r.sessionId);
  return { ...base, started: o.ok, opened: Boolean(o.ok && o.opened), error: o.ok ? undefined : o.error };
}

// Restarts the target the way Stop does (a clean quit), then starts it with the new session open. stillRunning: it
// didn't quit; the page offers to force it (account:stop with force) and asks again, which then only starts it.
async function restartForHandoff(toId, sessionId) {
  const to = accountById(toId);
  const i = inst(toId);
  if (i.status === 'external') return { ok: false, error: `${to.name} is open in its own window. Quit it there (File > Exit); it then reopens here and lists the session.` };
  if (i.pid || i.status === 'starting' || i.status === 'docked' || i.status === 'stopping') {
    const s = await stopAccount(toId);
    if (!s.ok) return s;
    await sleep(1000); // lets the old process let go of its files
  }
  return openSession(toId, sessionId);
}

// ---------- renderer messaging ----------

function statusPayload() {
  return Object.fromEntries(state.accounts.map((a) => {
    const i = inst(a.id);
    // exit.reason: 'update' | 'crash' | 'user' | 'shutdown' | 'unknown' | 'stopped' (our Stop). reopening: an
    // automatic reopen is on its way; gaveUp: it closed too often to be reopened again.
    const exit = i.exit ? { reason: i.exit.reason, reopening: i.exit.reopening === true, gaveUp: i.exit.gaveUp === true } : null;
    return [a.id, { status: i.status, error: i.error, running: Boolean(i.pid) || webViews.has(a.id), frozen: i.frozen === true, exit }];
  }));
}

// Only sent when something changed: every push re-renders the tabs and panes.
let lastStatus = '';
const pushStatus = () => {
  if (!mainWindow) return;
  const s = JSON.stringify(statusPayload());
  if (s === lastStatus) return;
  lastStatus = s;
  mainWindow.webContents.send('status', JSON.parse(s));
  updateTrayMenu(); // its Stop submenu lists the running accounts
};
const pushUi = () => mainWindow && mainWindow.webContents.send('ui', state.ui);

// ---------- window ----------

let mainWindow = null;
let parentHwnd = 0;
let enforceTimer = null;
let scanTimer = null;
let pendingMaximize = false; // started hidden in the tray from a maximised window
let tray = null;

function initialBounds() {
  const saved = state.window || {};
  const area = screen.getPrimaryDisplay().workArea;
  const bounds = { width: Math.min(saved.width || 1400, area.width), height: Math.min(saved.height || 900, area.height) };
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      saved.x < a.x + a.width - 80 && saved.x + bounds.width > a.x + 80 && saved.y >= a.y - 10 && saved.y < a.y + a.height - 40);
    if (visible) Object.assign(bounds, { x: saved.x, y: saved.y });
  }
  return bounds;
}

// Brings Kitsun back from the tray or the taskbar. Docked windows follow through the 'show' and 'focus' events.
function showWindow() {
  if (!mainWindow || closing) return;
  if (pendingMaximize) { pendingMaximize = false; mainWindow.maximize(); } else if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// The close button with "close to tray" on. The Claude windows stay docked and running as children of
// the hidden window; layout() hides them, and enforce() brings everything back if one asks for attention.
function hideToTray() {
  mainWindow.hide();
  if (state.trayHintShown || !tray) return;
  state.trayHintShown = true;
  saveState();
  try {
    tray.displayBalloon({
      icon: nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')),
      title: 'Kitsun is still running',
      content: 'Your AIs keep running here. Click the tray icon to come back, or right-click it to quit.',
    });
  } catch { /* cosmetic */ }
}

function createWindow({ hidden = false } = {}) {
  mainWindow = new BrowserWindow({
    ...initialBounds(),
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0d0f15',
    title: 'Kitsun',
    icon: path.join(__dirname, 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#090b10', symbolColor: '#edf0f7', height: 40 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  parentHwnd = win32.hwndFromBuffer(mainWindow.getNativeWindowHandle());
  // maximize() also shows a hidden window, so a window that starts in the tray maximises on its first show.
  const maximized = Boolean(state.window && state.window.maximized);
  if (hidden) pendingMaximize = maximized;
  else {
    if (maximized) mainWindow.maximize();
    mainWindow.once('ready-to-show', () => mainWindow.show());
  }

  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') mainWindow.webContents.toggleDevTools();
  });

  // Ctrl+Alt+1–9 switches accounts and Ctrl+Alt+0 goes home, even while a Claude window has the keyboard.
  // Only registered while Kitsun is the active window, so it never steals the keys from other programs.
  const registerKeys = () => {
    globalShortcut.unregisterAll();
    try { globalShortcut.register('Control+Alt+0', showHome); } catch { /* invalid on this keyboard */ }
    // Not plain Ctrl+K: Claude uses that itself.
    try {
      if (!globalShortcut.register('Control+Alt+K', openSwitcher)) console.warn('Ctrl+Alt+K is taken by another program');
    } catch { /* invalid on this keyboard */ }
    for (let n = 1; n <= 9; n++) {
      try {
        if (!globalShortcut.register(`Control+Alt+${n}`, () => { const a = state.accounts[n - 1]; if (a) showAccount(a.id); })) {
          console.warn(`Ctrl+Alt+${n} is taken by another program`);
        }
      } catch { /* invalid on this keyboard */ }
    }
  };
  // When Kitsun is activated (Alt+Tab, taskbar), Windows gives the keyboard to our own page, and the
  // docked Claude window ignores input until it is focused itself. Hand focus straight to the account on show.
  // Re-placing the docked windows is what a tab click does, and it is what wakes a docked Claude that
  // Chromium stopped painting while Kitsun was in the background.
  mainWindow.on('focus', () => {
    registerKeys();
    layout();
    pokeAttention();
    setTimeout(focusActivePane, 30);
    setTimeout(() => { layout(); focusActivePane(); }, 250);
  });
  mainWindow.on('blur', () => globalShortcut.unregisterAll());
  // Hidden in the tray: no shortcuts (Kitsun isn't the active window) and no docked window on screen.
  mainWindow.on('hide', () => { globalShortcut.unregisterAll(); layout(); });
  mainWindow.on('show', layout);

  const rememberBounds = () => {
    if (!mainWindow || mainWindow.isMinimized() || mainWindow.isFullScreen()) return;
    // Started in the tray and never shown: it isn't maximised yet, but will be on its first show (pendingMaximize).
    const maximized = mainWindow.isMaximized() || (pendingMaximize && !mainWindow.isVisible());
    state.window = { ...mainWindow.getNormalBounds(), maximized };
  };
  for (const ev of ['resize', 'maximize', 'unmaximize', 'restore']) mainWindow.on(ev, () => { rememberBounds(); layout(); });
  mainWindow.on('move', rememberBounds);
  mainWindow.on('minimize', layout);

  const shutDown = () => {
    closing = true;
    rememberBounds();
    saveState();
    clearInterval(enforceTimer);
    clearTimeout(scanTimer);
    clearInterval(startupTimer);
    clearInterval(announceTimer);
    clearInterval(attentionTimer);
    clearTimeout(attentionPoke);
    for (const i of instances.values()) cancelRestart(i);
    globalShortcut.unregisterAll();
    undockAll();
    for (const id of [...terms.keys()]) endTerminal(id);
  };
  mainWindow.on('close', (event) => {
    // The close button hides to the tray. Quitting from the tray menu sets `closing` first (before-quit),
    // so it closes for real, as does the close button with the setting off or without a tray icon.
    if (!closing && tray && state.settings.closeToTray) {
      event.preventDefault();
      hideToTray();
      return;
    }
    shutDown();
  });
  // Windows is signing out or shutting down; there may be no 'close' event, so save and let go of the windows now.
  mainWindow.on('session-end', () => { if (!closing) shutDown(); });
  mainWindow.on('closed', () => { mainWindow = null; });

  enforceTimer = setInterval(enforce, 400);
  // Faster while some account is waiting to be brought in, so quitting the main app is noticed quickly.
  // Skipped while every account is docked: enforce() already notices a window going away.
  const scheduleScan = () => {
    const waiting = [...instances.values()].some((i) => i.status === 'external');
    scanTimer = setTimeout(async () => {
      if (closing) return;
      if (claudeTabs().some((a) => inst(a.id).status !== 'docked')) await scanProcesses();
      if (mainWindow && !closing) scheduleScan();
    }, waiting ? 3000 : 8000);
  };
  scheduleScan();

  // Dev aid: KITSUN_EVAL=<file.js> runs a script in the page after startup and prints the result.
  if (process.env.KITSUN_EVAL && !app.isPackaged) {
    mainWindow.webContents.once('did-finish-load', () => setTimeout(async () => {
      console.log('eval:', await mainWindow.webContents.executeJavaScript(fs.readFileSync(process.env.KITSUN_EVAL, 'utf8')).catch((e) => e.message));
    }, Number(process.env.KITSUN_EVAL_DELAY) || 3000));
  }

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ---------- tray icon ----------

// Built from the 256 px app icon at each size Windows may ask for, so it stays sharp at any display scale.
function trayImage() {
  const src = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
  if (src.isEmpty()) return src;
  const img = nativeImage.createEmpty();
  for (const sf of [1, 1.25, 1.5, 2]) {
    const px = Math.round(16 * sf);
    img.addRepresentation({ scaleFactor: sf, buffer: src.resize({ width: px, height: px, quality: 'best' }).toPNG() });
  }
  return img;
}

function createTray() {
  try {
    tray = new Tray(trayImage());
  } catch (err) {
    // Without a tray icon there would be no way back to a hidden window, so it never hides (see 'close').
    console.error('Could not create the tray icon:', err);
    tray = null;
    return;
  }
  tray.setToolTip('Kitsun');
  tray.on('click', showWindow);
  updateTrayMenu();
}

// Rebuilt whenever accounts are added, renamed or removed.
function updateTrayMenu() {
  if (!tray) return;
  const thenShow = (fn) => () => { showWindow(); fn(); };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Kitsun', click: showWindow },
    { label: 'Home', click: thenShow(showHome) },
    { label: 'Search…', click: thenShow(openSwitcher) },
    { type: 'separator' },
    // '&' marks a menu shortcut letter on Windows; '&&' shows it as itself.
    ...state.accounts.map(({ id, name }) => ({ label: name.replace(/&/g, '&&'), click: thenShow(() => { if (accountById(id)) showAccount(id); }) })),
    { type: 'separator' },
    { label: 'Open all tabs', click: startAllAccounts },
    // The page asks for confirmation first, so this shows the window.
    { label: 'Stop', submenu: state.accounts.map(({ id, name }) => {
      const i = inst(id);
      return {
        label: `${name.replace(/&/g, '&&')}…`,
        enabled: (Boolean(i.pid) || webViews.has(id)) && i.status !== 'external' && i.status !== 'stopping',
        click: thenShow(() => { if (mainWindow && accountById(id)) mainWindow.webContents.send('request-stop', id); }),
      };
    }) },
    // Each account's linked Chrome profile ("Studio · Studio Labs"); opens Chrome without showing Kitsun.
    ...(chromeSnap && chromeSnap.exe ? [{ label: 'Open Chrome', submenu: claudeTabs().map(({ id, name }) => {
      const link = chromeSnap.links[id] && chromeSnap.links[id].link;
      return {
        label: `${name} · ${link ? link.name : 'no profile linked'}`.replace(/&/g, '&&'),
        enabled: Boolean(link),
        click: () => openChrome(id).then((r) => { if (!r.ok && r.error) { showWindow(); notify(r.error, { system: false }); } }),
      };
    }) }] : []),
    { label: 'Settings…', click: thenShow(() => { if (mainWindow) mainWindow.webContents.send('open-settings'); }) },
    { type: 'separator' },
    { label: 'Quit Kitsun', click: () => app.quit() },
  ]));
}

function startAllAccounts() {
  // Before the first scan we don't know what is running yet; the startup code starts what's needed.
  if (!firstScanDone) return;
  for (const a of state.accounts) if (inst(a.id).status === 'stopped') startAccount(a.id);
}

// ---------- start with Windows ----------

// Only the installed app registers itself: a run from source would point Windows at electron.exe.
// The entry is named after the app ID, so this must run after app.setAppUserModelId().
const LOGIN_ARGS = ['--hidden'];

// Only the installed copy (%LOCALAPPDATA%\Programs\Kitsun) owns the login item. Another packaged copy (the dist
// build) would point Windows at itself, and the installed one would then show the setting off while Windows still
// starts that other, possibly stale, build.
const INSTALLED_DIR = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Kitsun');
const samePath = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
const isInstalledCopy = () => app.isPackaged && Boolean(process.env.LOCALAPPDATA) && samePath(path.dirname(process.execPath), INSTALLED_DIR);

// The exe our Run entry (HKCU, named after APP_ID like Electron's own) starts, or null if there is none. Read from the
// registry: getLoginItemSettings only lists entries for this exe, so it can't see one that starts another copy.
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
function runEntryExe(name = APP_ID) {
  try {
    const out = execFileSync('reg.exe', ['query', RUN_KEY, '/v', name], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`^\\s*${esc}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$`, 'mi').exec(String(out));
    if (!m) return null;
    const v = m[1].trim();
    const quoted = /^"([^"]*)"/.exec(v);
    return quoted ? quoted[1] : v.split(/\s+/)[0];
  } catch {
    return null; // no entry (reg exits with 1), or it couldn't be read
  }
}

function applyLoginItem() {
  if (!isInstalledCopy()) return;
  app.setLoginItemSettings({ openAtLogin: state.settings.startWithWindows, args: LOGIN_ARGS });
}

// The login item can also be removed or turned off elsewhere (Task Manager's Startup apps), so the real
// entry wins over the saved setting. A live entry without --hidden (written by hand, or by an older build) is rewritten.
// An entry under our name that starts another copy (left by the dist build) is pointed here when the saved setting is
// on, or removed when it is off.
function syncLoginItem() {
  if (!isInstalledCopy()) return;
  try {
    let li = app.getLoginItemSettings({ args: LOGIN_ARGS });
    const exe = runEntryExe();
    if (exe && !samePath(exe, process.execPath)) {
      applyLoginItem(); // same entry name: rewritten to this exe, or deleted
      li = app.getLoginItemSettings({ args: LOGIN_ARGS });
    }
    state.settings.startWithWindows = li.executableWillLaunchAtLogin === true;
    if (state.settings.startWithWindows && !li.openAtLogin) applyLoginItem();
  } catch (err) {
    console.error('Could not read the login item:', err);
  }
}

// ---------- IPC ----------

function fromShell(event) {
  return mainWindow && event.sender === mainWindow.webContents;
}

ipcMain.handle('state:get', (event) => {
  if (!fromShell(event)) return null;
  lastStatus = '';
  return { accounts: state.accounts, ui: state.ui, status: statusPayload(), claudeInstalled: claudeAlias() !== null };
});

// canStartWithWindows: only the installed copy registers itself (see isInstalledCopy).
ipcMain.handle('settings:get', (event) => {
  if (!fromShell(event)) return null;
  return { settings: { ...state.settings }, canStartWithWindows: isInstalledCopy() };
});

// Takes only the keys to change. Unknown keys or wrong types reject the whole change.
ipcMain.handle('settings:set', (event, changes) => {
  if (!fromShell(event)) return { ok: false };
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return { ok: false, error: 'Nothing to change.' };
  const entries = Object.entries(changes);
  const bad = entries.find(([k, v]) => !Object.hasOwn(DEFAULT_SETTINGS, k) || typeof v !== typeof DEFAULT_SETTINGS[k]);
  if (bad || !entries.length) return { ok: false, error: 'That setting can\'t be changed.', settings: { ...state.settings } };
  const before = { ...state.settings };
  Object.assign(state.settings, Object.fromEntries(entries));
  if (state.settings.startWithWindows !== before.startWithWindows) {
    if (!isInstalledCopy()) {
      state.settings.startWithWindows = before.startWithWindows;
      return { ok: false, error: 'Only the installed Kitsun (in %LOCALAPPDATA%\\Programs) can start with Windows.', settings: { ...state.settings } };
    }
    try {
      applyLoginItem();
    } catch (err) {
      state.settings.startWithWindows = before.startWithWindows;
      return { ok: false, error: `Windows didn't accept the change: ${err.message}`, settings: { ...state.settings } };
    }
  }
  // Turned off: reopens already on their way are called off too.
  if (!state.settings.autoRestart && before.autoRestart) {
    for (const i of instances.values()) if (i.exit && i.exit.reopening) cancelRestart(i);
    pushStatus();
  }
  saveState();
  return { ok: true, settings: { ...state.settings } };
});

ipcMain.on('panes:rects', (event, rects) => {
  if (!fromShell(event) || !Array.isArray(rects)) return;
  paneRects = rects.slice(0, MAX_PANES).map((r) => (r && [r.x, r.y, r.width, r.height].every(Number.isFinite) ? r : null));
  if (paneRects.length) lastPaneRects = paneRects;
  // Sent every frame while a divider is dragged: only the windows that move are re-placed.
  layout({ changedOnly: true });
});

ipcMain.on('overlay', (event, hidden) => {
  if (!fromShell(event)) return;
  overlayHidden = Boolean(hidden);
  layout();
  if (!overlayHidden) setTimeout(focusActivePane, 30);
});

ipcMain.handle('ui:show-account', (event, id) => {
  if (fromShell(event) && accountById(id)) showAccount(id);
  return state.ui;
});

ipcMain.handle('ui:home', (event) => {
  if (fromShell(event)) showHome();
  return state.ui;
});

// Never rejects: the home screen shows what it can.
ipcMain.handle('stats:get', async (event) => {
  if (!fromShell(event) || !stats) return null;
  try {
    return await stats.get(claudeTabs(), instances);
  } catch (err) {
    console.error('Could not collect stats:', err);
    return { generatedAt: Date.now(), scanning: false, accounts: [] };
  }
});

// The latest "needs you" and plan usage per account (see pollAttention); later changes come as 'sessions'.
ipcMain.handle('sessions:get', (event) => (fromShell(event) ? sessionsPayload : null));

// Ranked sessions across accounts: [{ accountId, sessionId, title, folder, snippet, at, archived }], at most 30.
// Never rejects: the switcher shows what it can.
ipcMain.handle('search:query', async (event, text) => {
  if (!fromShell(event) || !search || typeof text !== 'string' || text.length > MAX_QUERY) return [];
  try {
    return await search.query(claudeTabs(), text);
  } catch (err) {
    console.error('Search failed:', err);
    return [];
  }
});

// Only a session the index found, in the account it was found in, is ever opened (see openSession).
ipcMain.handle('search:open', (event, id, sessionId) => {
  if (!fromShell(event) || !isClaudeTab(id) || typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return { ok: false };
  return openSession(id, sessionId);
});

// { sessionId, fromAccountId, toAccountId } and nothing else: ids only, never a path (see startHandoff).
const HANDOFF_KEYS = ['fromAccountId', 'sessionId', 'toAccountId'];
ipcMain.handle('handoff:start', async (event, input) => {
  if (!fromShell(event) || !input || typeof input !== 'object' || Array.isArray(input)) return { ok: false };
  if (Object.keys(input).sort().join() !== HANDOFF_KEYS.join()) return { ok: false };
  const { sessionId, fromAccountId, toAccountId } = input;
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId) || typeof fromAccountId !== 'string' || typeof toAccountId !== 'string'
    || fromAccountId === toAccountId || !isClaudeTab(fromAccountId) || !isClaudeTab(toAccountId)) return { ok: false };
  try {
    return await startHandoff(fromAccountId, toAccountId, sessionId);
  } catch (err) {
    console.error('Could not continue the session:', err);
    return { ok: false, error: 'Couldn\'t copy the session.' };
  }
});

// Only for a session handoff:start made in that account.
ipcMain.handle('handoff:restart', (event, id, sessionId) => {
  if (!fromShell(event) || typeof id !== 'string' || !accountById(id) || typeof sessionId !== 'string' || handoffs.get(sessionId) !== id) return { ok: false };
  return restartForHandoff(id, sessionId);
});

// 'single' | 'split' | 'triple' (see setLayout); an unknown name, or too few accounts, changes nothing.
ipcMain.handle('ui:layout', (event, name) => {
  if (fromShell(event) && typeof name === 'string' && Object.hasOwn(LAYOUTS, name)) setLayout(name);
  return state.ui;
});

// The older on/off form: true = two panes (when there are two accounts), false = one.
ipcMain.handle('ui:split', (event, split) => {
  if (fromShell(event)) setLayout(split === true && state.accounts.length > 1 ? 'split' : 'single');
  return state.ui;
});

ipcMain.handle('ui:focus-pane', (event, p) => {
  if (!fromShell(event) || !Number.isInteger(p) || p < 0 || p >= MAX_PANES) return state.ui;
  state.ui.focused = p < paneCount() ? p : 0;
  saveState();
  setTimeout(focusActivePane, 30);
  return state.ui;
});

// Where the pane dividers were dragged to: { splitRatio } and/or { tripleRatios }. Anything else, or a value that isn't
// a number (or three positive numbers), changes nothing. Saved only: the page lays the panes out and sends their rects.
ipcMain.handle('ui:ratios', (event, input) => {
  if (!fromShell(event) || !input || typeof input !== 'object' || Array.isArray(input)) return state.ui;
  const keys = Object.keys(input);
  if (!keys.length || keys.some((k) => k !== 'splitRatio' && k !== 'tripleRatios')) return state.ui;
  const split = keys.includes('splitRatio') ? sanitizeSplitRatio(input.splitRatio) : state.ui.splitRatio;
  const triple = keys.includes('tripleRatios') ? sanitizeTripleRatios(input.tripleRatios) : state.ui.tripleRatios;
  if (split === null || triple === null) return state.ui;
  state.ui.splitRatio = split;
  state.ui.tripleRatios = triple;
  saveState();
  return state.ui;
});

ipcMain.handle('account:start', (event, id) => (fromShell(event) && accountById(id) ? startAccount(id) : { ok: false }));

// force: skip asking Claude to quit and end it (taskkill /T /F); the page confirms that first.
ipcMain.handle('account:stop', (event, id, force) => {
  if (!fromShell(event) || !accountById(id) || (force !== undefined && typeof force !== 'boolean')) return { ok: false };
  return stopAccount(id, { force: force === true });
});

// "Wait" on a frozen account: hide the notice, and ask again if it still hasn't responded in a minute.
ipcMain.handle('account:wait', (event, id) => {
  if (!fromShell(event) || !accountById(id)) return { ok: false };
  const i = inst(id);
  i.frozen = false;
  i.waitUntil = Date.now() + 60000;
  pushStatus();
  return { ok: true };
});

ipcMain.handle('account:restart-frozen', (event, id) => (fromShell(event) && accountById(id) ? restartFrozen(id) : { ok: false }));
ipcMain.handle('account:stop-frozen', (event, id) => (fromShell(event) && accountById(id) ? stopFrozen(id) : { ok: false }));

// For a copy that is running on its own (without the dock flag): close it and start it again inside.
ipcMain.handle('account:restart-here', async (event, id) => {
  const account = fromShell(event) && accountById(id);
  if (!account || account.kind !== 'claude' || account.main) return { ok: false, error: 'Quit your main Claude app from its own menu; it then opens here by itself.' };
  await scanProcesses();
  const i = inst(id);
  if (i.status !== 'external' || !i.pid) return { ok: true };
  await new Promise((resolve) => execFile('taskkill', ['/PID', String(i.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
  // Ended on purpose: not a copy that closed by itself (see onClosed).
  i.pid = null;
  i.expectExitUntil = Date.now() + 30000;
  i.status = 'stopped';
  await new Promise((r) => setTimeout(r, 1500));
  return startAccount(id);
});

// chromeProfile: left out = keep, null = automatic, or a profile folder Chrome's Local State lists (anything else
// rejects the whole save, so the page can never point the Chrome button at an arbitrary folder).
// A new tab is kind 'claude' (the default) or 'web'. A website tab's address comes from its catalogue entry, or for "Any
// website" from input.url (also how an existing one's address is changed); sanitizeAccount refuses anything but https
// (and http to this PC). catalogId must name an entry of the same kind.
ipcMain.handle('account:save', async (event, input) => {
  if (!fromShell(event) || !input || typeof input !== 'object') return null;
  const existing = accountById(input.id);
  const kind = existing ? existing.kind : ['web', 'app', 'terminal'].includes(input.kind) ? input.kind : 'claude';
  const entry = !existing && typeof input.catalogId === 'string' ? findEntry(input.catalogId) : null;
  if (entry && entry.kind !== kind) return null;
  if (kind === 'web') {
    const url = existing ? (Object.hasOwn(input, 'url') ? input.url : existing.url) : (entry && entry.url) || input.url;
    const next = sanitizeAccount({ id: input.id, kind, name: input.name, color: input.color, url, catalogId: existing ? existing.catalogId : entry && entry.id });
    if (!next) return null;
    if (existing) {
      const moved = next.url !== existing.url;
      Object.assign(existing, next);
      const view = webViews.get(existing.id);
      if (moved && view) view.webContents.loadURL(existing.url).catch(() => {});
    } else {
      if (!ACCOUNT_ID_RE.test(input.id) || accountById(input.id)) return null;
      state.accounts.push(next);
    }
    saveState();
    updateTrayMenu();
    return state.accounts;
  }
  if (kind === 'terminal') {
    // A catalogue entry's command is its own (e.g. codex); only "Any command" (or a tab from no entry) takes the typed
    // one, which is the person's own command line, run as typed. The folder must exist; a change applies on next open.
    const custom = existing ? !existing.catalogId || findEntry(existing.catalogId).custom : !entry || entry.custom;
    const command = custom ? (Object.hasOwn(input, 'command') ? input.command : existing && existing.command) : (existing ? existing.command : entry.command);
    let cwd = existing ? existing.cwd : os.homedir();
    if (Object.hasOwn(input, 'cwd')) {
      try { if (typeof input.cwd === 'string' && path.isAbsolute(input.cwd) && fs.statSync(input.cwd).isDirectory()) cwd = input.cwd; else return null; } catch { return null; }
    }
    if (!existing && (!ACCOUNT_ID_RE.test(input.id) || accountById(input.id))) return null;
    const next = sanitizeAccount({ id: input.id, kind, name: input.name, color: input.color, command, cwd, catalogId: existing ? existing.catalogId : entry && entry.id });
    if (!next) return null;
    if (existing) Object.assign(existing, next); else state.accounts.push(next);
    saveState();
    updateTrayMenu();
    return state.accounts;
  }
  if (kind === 'app') {
    // The exe comes from the catalogue's detection, or from the file the user picked in app:pick (named by its token);
    // never a path from the page.
    let { exe, aumid } = existing || { exe: null, aumid: null };
    if (!existing) {
      if (!ACCOUNT_ID_RE.test(input.id) || accountById(input.id)) return null;
      const picked = pickedApp && typeof input.pick === 'string' && input.pick === pickedApp.token ? pickedApp : null;
      const found = !picked && entry && !entry.custom && catalog ? (await catalog.detect())[entry.id] : null;
      if (picked) ({ exe } = picked);
      else if (found && found.exe) ({ exe, aumid } = found);
    }
    const next = sanitizeAccount({ id: input.id, kind, name: input.name, color: input.color, exe, aumid, catalogId: existing ? existing.catalogId : entry && entry.id });
    if (!next) return null;
    if (existing) Object.assign(existing, next);
    else { state.accounts.push(next); pickedApp = null; }
    saveState();
    updateTrayMenu();
    return state.accounts;
  }
  let chromeProfile = existing ? existing.chromeProfile : null;
  if (Object.hasOwn(input, 'chromeProfile')) {
    const want = input.chromeProfile;
    if (want === null) chromeProfile = null;
    else if (typeof want === 'string' && (want === chromeProfile || (chrome && (await chrome.isProfile(want))))) chromeProfile = want;
    else return null;
  }
  if (existing) {
    Object.assign(existing, sanitizeAccount({ ...existing, name: input.name, color: input.color, shareCode: input.shareCode, chromeProfile }));
  } else {
    if (!ACCOUNT_ID_RE.test(input.id) || accountById(input.id)) return null;
    state.accounts.push(sanitizeAccount({ id: input.id, kind, name: input.name, color: input.color, main: false, shareCode: input.shareCode, chromeProfile, catalogId: entry && entry.id }));
  }
  saveState();
  updateTrayMenu();
  refreshChrome({ fresh: true });
  return state.accounts;
});

// Every Chrome profile, and which one each account's Chrome button opens (see chromePayload).
ipcMain.handle('chrome:get', async (event) => {
  if (!fromShell(event)) return null;
  return chromePayload(await refreshChrome());
});

// The renderer names only the account; main picks the profile and the chrome.exe it starts.
ipcMain.handle('chrome:open', (event, id) => {
  if (!fromShell(event) || !isClaudeTab(id)) return { ok: false };
  return openChrome(id);
});

// Removing an extra account deletes its Claude data folder (sign-in, settings, local sessions) and
// its own Claude Code folder if it had one. The main Claude app's data is never touched.
// Removing a website tab closes its page and deletes its partition (its sign-in, cookies and storage on this PC).
ipcMain.handle('account:remove', async (event, id) => {
  if (!fromShell(event)) return { ok: false };
  const account = accountById(id);
  if (!account || account.main) return { ok: false, error: 'The main account cannot be removed.' };
  if (account.kind === 'web') {
    stopWeb(id);
    try { await session.fromPartition(partitionOf(id)).clearStorageData(); } catch (err) { console.error('Could not clear', id, err); }
    try { fs.rmSync(path.join(app.getPath('userData'), 'Partitions', `tab-${id}`), { recursive: true, force: true }); } catch { /* cleared above; the folder goes next start */ }
    preparedSessions.delete(id);
    return forgetTab(id);
  }
  if (account.kind === 'terminal') {
    endTerminal(id);
    return forgetTab(id);
  }
  if (account.kind === 'app') {
    // Its app keeps running, handed back as a normal window; nothing of it is deleted.
    const i = inst(id);
    if (i.hwnd) { try { win32.undock(i.hwnd, i.saved, { show: true }); } catch { /* window gone */ } forgetWindow(id); }
    return forgetTab(id);
  }
  if (!(await scanProcesses())) return { ok: false, error: 'Could not check whether its Claude window is running. Try again.' };
  if (inst(id).pid) {
    return { ok: false, error: inst(id).status === 'external'
      ? `${account.name}'s Claude is still running in its own window. Quit it there first (Claude's menu > File > Exit).`
      : `${account.name}'s Claude is still running. Stop it first (the Stop button here), then remove it.` };
  }
  // The Claude app is a Store (MSIX) app: Windows quietly redirects the files it writes under
  // %LOCALAPPDATA%\Claude-Profiles into its package's LocalCache folder, so both places are cleared.
  let virtualized = [];
  try {
    const packages = path.join(process.env.LOCALAPPDATA || '', 'Packages');
    virtualized = fs.readdirSync(packages).filter((n) => /^Claude_/i.test(n))
      .map((n) => path.join(packages, n, 'LocalCache', 'Local', 'Claude-Profiles', id));
  } catch { /* no packages folder */ }
  // Renaming first fails if any file inside is still in use, so a live profile is never half-deleted.
  for (const dir of [...virtualized, autoDataDir(id), autoCodeDir(id)]) {
    const doomed = `${dir}.removing-${Date.now()}`;
    try {
      fs.renameSync(dir, doomed);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      return { ok: false, error: `Some of ${account.name}'s files are still in use. Close its Claude window and try again.` };
    }
    try { fs.rmSync(doomed, { recursive: true, force: true }); } catch (err) { console.error('Could not finish deleting', doomed, err); }
  }
  return forgetTab(id);
});

function forgetTab(id) {
  state.accounts = state.accounts.filter((a) => a.id !== id);
  cancelRestart(inst(id));
  instances.delete(id);
  state.ui.panes = state.ui.panes.map((p) => (p === id ? null : p));
  state = sanitizeState(state);
  saveState();
  updateTrayMenu();
  refreshChrome({ fresh: true });
  layout();
  pushUi();
  pushStatus();
  return { ok: true, accounts: state.accounts, ui: state.ui };
}

// The AIs that can be added, and which are on this PC (lib/catalog.js). fresh: look again now.
let catalog = null;
ipcMain.handle('catalog:get', async (event, fresh) => {
  if (!fromShell(event) || !catalog) return null;
  try {
    return await catalog.list({ fresh: fresh === true, kinds: TAB_KINDS });
  } catch (err) {
    console.error('Could not read the catalogue:', err);
    return null;
  }
});

// "Get it": the entry's own download page, never an address from the page.
ipcMain.handle('catalog:get-it', (event, id) => {
  const e = fromShell(event) && typeof id === 'string' ? findEntry(id) : null;
  if (!e || !e.get) return false;
  openExternal(e.get);
  return true;
});

// "Any app", or an app the catalogue couldn't find the exe of: the user picks the program. Main keeps the path and gives
// the page a token for account:save, so the page never names a program to run.
let pickedApp = null;
// A terminal tab's starting folder, picked in a folder dialog (the page then sends the path with account:save, which
// checks it is a folder).
ipcMain.handle('folder:pick', async (event, current) => {
  if (!fromShell(event)) return null;
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Pick the folder the terminal starts in',
    defaultPath: typeof current === 'string' && path.isAbsolute(current) ? current : os.homedir(),
    properties: ['openDirectory'],
  });
  return r.canceled ? null : r.filePaths[0] || null;
});

ipcMain.handle('app:pick', async (event) => {
  if (!fromShell(event)) return null;
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Pick the app to open in a tab',
    defaultPath: path.join(process.env.LOCALAPPDATA || os.homedir(), 'Programs'),
    filters: [{ name: 'Programs', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  const exe = !r.canceled && r.filePaths[0];
  if (!exe || !/\.exe$/i.test(exe)) return null;
  if (samePath(exe, process.execPath) || /\\WindowsApps\\(Claude_|claude-desktop)/i.test(exe)) {
    return { error: 'Add Claude with the Claude entry instead: it gets its own sign-in per tab.' };
  }
  pickedApp = { token: `${Date.now()}-${Math.random().toString(36).slice(2)}`, exe };
  return { token: pickedApp.token, file: exe, name: path.basename(exe, path.extname(exe)) };
});

ipcMain.handle('account:sign-in-link', async (event, id, text) => {
  const account = fromShell(event) && accountById(id);
  if (!account || account.kind !== 'claude' || account.main) return { ok: false };
  const link = toClaudeLink(text);
  if (!link) return { ok: false, error: 'That is not a Claude sign-in link. It should start with https://claude.ai/magic-link, https://claude.ai/sso-callback or claude://' };
  const i = inst(id);
  const wasStopped = i.status === 'stopped';
  if (wasStopped) { i.status = 'starting'; i.launchedAt = Date.now(); i.error = null; pushStatus(); }
  const result = await launchClaude(account, [link]);
  if (!result.ok && wasStopped) { i.status = 'stopped'; i.error = result.error; pushStatus(); } else if (result.ok) watchStartup();
  return result;
});

// ---------- lifecycle ----------

// Explorer caches icons by file path, and Kitsun.exe keeps its path across updates, so after a new icon the taskbar,
// desktop and Start would go on showing the old one. Shortcuts point at a copy of the icon named after its contents
// instead: a new icon is a new path, which Explorer has to read afresh. Falls back to the exe itself.
let iconCopy = null;
function shortcutIcon() {
  if (iconCopy) return iconCopy;
  try {
    const ico = fs.readFileSync(path.join(__dirname, 'build', 'icon.ico'));
    const name = `kitsun-${crypto.createHash('sha1').update(ico).digest('hex').slice(0, 10)}.ico`;
    const dir = path.join(app.getPath('userData'), 'icons');
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, ico);
    }
    iconCopy = file;
  } catch {
    iconCopy = process.execPath;
  }
  return iconCopy;
}

// Every shortcut on the desktop, in Start and pinned to the taskbar that opens Kitsun gets the current icon. One that
// still opens the old Multi Claude (e.g. a desktop shortcut made before the rename) is pointed at Kitsun as well.
function refreshShortcutIcons() {
  const icon = shortcutIcon();
  const oldExe = path.join(path.dirname(path.dirname(process.execPath)), OLD_APP.name, `${OLD_APP.name}.exe`);
  const folders = [
    app.getPath('desktop'),
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(app.getPath('appData'), 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
  ];
  let changed = false;
  for (const dir of folders) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.lnk')); } catch { continue; }
    for (const n of names) {
      const lnk = path.join(dir, n);
      try {
        const s = shell.readShortcutLink(lnk);
        const ours = samePath(s.target, process.execPath);
        if (!ours && !samePath(s.target, oldExe)) continue;
        if (ours && samePath(s.icon || '', icon)) continue;
        shell.writeShortcutLink(lnk, 'update', { target: process.execPath, icon, iconIndex: 0, ...(ours ? {} : { appUserModelId: APP_ID, description: 'All your AIs in one window' }) });
        changed = true;
        // A desktop shortcut can take the new name too (a taskbar pin can't: the pin is tied to its file name).
        const renamed = path.join(dir, 'Kitsun.lnk');
        if (!ours && dir === folders[0] && n === `${OLD_APP.name}.lnk` && !fs.existsSync(renamed)) fs.renameSync(lnk, renamed);
      } catch { /* not a readable shortcut */ }
    }
  }
  if (changed) { try { win32.iconsChanged(); } catch { /* Explorer picks it up later */ } }
}

// Windows only shows notifications for apps that have a Start Menu shortcut carrying their app ID.
function ensureStartMenuShortcut() {
  if (!app.isPackaged) return;
  try {
    const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Kitsun.lnk');
    shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'update' : 'create', {
      target: process.execPath, appUserModelId: APP_ID, icon: shortcutIcon(), iconIndex: 0,
      description: 'All your AIs in one window',
    });
  } catch { /* cosmetic */ }
  if (isInstalledCopy()) refreshShortcutIcons();
}

// ---------- taking over from Multi Claude (this app's old name) ----------

// Its settings (accounts, layout, Settings) and the stats cache are copied once, the first time Kitsun starts. The old
// folder is left as it was, so the old app still works if it is ever started again.
function takeOverOldSettings() {
  const oldDir = path.join(app.getPath('appData'), OLD_APP.name);
  if (fs.existsSync(dataFile()) || !fs.existsSync(path.join(oldDir, 'profiles.json'))) return;
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    for (const f of ['profiles.json', 'stats-cache.json']) {
      if (fs.existsSync(path.join(oldDir, f))) fs.copyFileSync(path.join(oldDir, f), path.join(app.getPath('userData'), f));
    }
    console.log(`Took over ${OLD_APP.name}'s settings`);
  } catch (err) {
    console.error(`Could not copy ${OLD_APP.name}'s settings:`, err);
  }
}

// A running Multi Claude holds the same Claude windows, and two apps docking them would fight over every one, so it is
// asked to quit (its own `--quit`, which hands the windows back) before Kitsun docks anything. oldAppExe() finds it;
// quitOldApp resolves once it is gone, or after 20 s.
function oldAppExe() {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Name '${OLD_APP.name}' -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1).Path`],
    { windowsHide: true, timeout: 15000, encoding: 'utf8' }).trim();
  } catch { return ''; }
}

async function quitOldApp(exe) {
  const find = oldAppExe;
  console.log(`Asking ${OLD_APP.name} to quit`);
  try { spawn(exe, ['--quit'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { return; }
  for (let t = 0; t < 20 && find(); t++) await sleep(1000);
}

// The installed copy also takes over the old login item (keeping the setting as it was) and Start Menu shortcut.
function takeOverOldShellItems() {
  if (!isInstalledCopy()) return;
  if (runEntryExe(OLD_APP.id)) {
    try { execFileSync('reg.exe', ['delete', RUN_KEY, '/v', OLD_APP.id, '/f'], { windowsHide: true, timeout: 5000 }); } catch { /* left for Task Manager */ }
    if (state.settings.startWithWindows) applyLoginItem();
  }
  try { fs.rmSync(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${OLD_APP.name}.lnk`), { force: true }); } catch { /* cosmetic */ }
  // A taskbar pin of the old app would start the old app (with the old logo). It is pointed at Kitsun in place:
  // Windows lets no program pin itself, and the pin is tied to that file name, so it can't be renamed either (its
  // tooltip keeps the old name until it is unpinned and Kitsun is pinned again). The app ID joins it to Kitsun's window.
  const pin = path.join(app.getPath('appData'), 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', `${OLD_APP.name}.lnk`);
  try {
    if (fs.existsSync(pin) && !samePath(shell.readShortcutLink(pin).target, process.execPath)) {
      shell.writeShortcutLink(pin, 'replace', { target: process.execPath, appUserModelId: APP_ID, icon: shortcutIcon(), iconIndex: 0, description: 'All your AIs in one window' });
    }
  } catch { /* cosmetic */ }
}

// When Kitsun is started from inside a Store app (e.g. by a Claude Code session in the Claude
// app), Windows quietly redirects its %APPDATA% files into that app's private folder, so settings saved
// then are missing the next time it is opened normally. Detect that by writing a probe file and
// looking for it in the Store apps' folders.
function settingsRedirected() {
  const userData = app.getPath('userData');
  const name = `redirect-probe-${process.pid}`;
  const probe = path.join(userData, name);
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(probe, '');
    const rel = path.relative(app.getPath('appData'), userData);
    const packages = path.join(process.env.LOCALAPPDATA || '', 'Packages');
    return fs.readdirSync(packages).some((n) => fs.existsSync(path.join(packages, n, 'LocalCache', 'Roaming', rel, name)));
  } catch {
    return false;
  } finally {
    try { fs.rmSync(probe, { force: true }); } catch { /* best effort */ }
  }
}

// Explorer starts programs outside any Store app, so hand the launch to it. The marker stops a loop
// if the relaunched copy is somehow redirected too (it would start within a few seconds); it then
// just carries on as before. If Explorer can't be started, it carries on as before too.
function relaunchOutsideStoreApp() {
  const marker = path.join(app.getPath('userData'), 'relaunched-at');
  try {
    if (Date.now() - Number(fs.readFileSync(marker, 'utf8')) < 10000) return false;
  } catch { /* no recent relaunch */ }
  try {
    fs.writeFileSync(marker, String(Date.now()));
    const explorer = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
    // Explorer hands the launch to the desktop shell and exits at once (with code 1, which is normal).
    return !spawnSync(explorer, [process.execPath], { timeout: 10000, windowsHide: true }).error;
  } catch {
    return false;
  }
}

// Checked before taking the single-instance lock, so the relaunched copy can take it.
// A `--quit` request only signals the running copy, so it never needs relaunching (that would drop the flag).
if (app.isPackaged && !process.argv.includes('--quit') && settingsRedirected() && relaunchOutsideStoreApp()) {
  app.exit(0);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else if (process.argv.includes('--quit')) {
  // Nothing was running to quit: a `--quit` never starts Kitsun itself.
  app.exit(0);
} else {
  // Opening Kitsun again (Start menu, taskbar) shows the running one, also from the tray.
  // A second start from the login item (--hidden) leaves it where it is.
  app.on('second-instance', (_event, argv) => {
    // `Kitsun.exe --quit` really quits a running copy (the close button only hides it to the tray),
    // e.g. so an update script can replace the files. It runs the normal quit path, which undocks every window.
    if (Array.isArray(argv) && argv.includes('--quit')) { app.quit(); return; }
    if (!Array.isArray(argv) || !argv.includes('--hidden')) showWindow();
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID);
    Menu.setApplicationMenu(null);
    takeOverOldSettings();
    state = loadState();
    if (!fs.existsSync(dataFile())) removeOldLeftovers();
    takeOverOldShellItems();
    syncLoginItem();
    saveState();
    ensureStartMenuShortcut();
    stats = createStats({
      cacheFile: path.join(app.getPath('userData'), 'stats-cache.json'),
      onActivityUpdated: () => { if (mainWindow && !closing) mainWindow.webContents.send('stats-updated'); },
    });
    const oldExe = oldAppExe();
    if (oldExe) await quitOldApp(oldExe); // before anything is docked
    createTray();
    // Started by the login item, or set to start in the tray: every account still starts below, but the
    // window waits in the tray. Without a tray icon there'd be no way to open it, so it shows then.
    const hidden = Boolean(tray) && (process.argv.includes('--hidden') || state.settings.startHidden);
    createWindow({ hidden });
    attention = createAttention();
    search = createSearch();
    chrome = createChrome();
    catalog = createCatalog({ claudeInstalled: () => claudeAlias() !== null });
    refreshChrome(); // fills the tray's Open Chrome submenu
    attentionTimer = setInterval(pollAttention, ATTENTION_EVERY);
    pollAttention();

    // Start every account so they all run side by side; ones already running are picked up as they are.
    // If the process list can't be read, start nothing (it could launch copies that are already open).
    const ok = (await scanProcesses()) || (await scanProcesses());
    if (ok) for (const a of state.accounts) if (inst(a.id).status === 'stopped') startAccount(a.id);
    watchStartup();
  });

  // If something goes badly wrong, hand the Claude windows back (visible, so nothing seems lost) and exit,
  // rather than limp on and dock them again.
  let bailedOut = false;
  process.on('uncaughtException', (err) => {
    console.error(err);
    if (bailedOut) return;
    bailedOut = true;
    closing = true;
    clearInterval(enforceTimer);
    clearTimeout(scanTimer);
    clearInterval(startupTimer);
    clearInterval(attentionTimer);
    try { undockAll({ show: true }); } catch { /* nothing more to do */ }
    setImmediate(() => app.exit(1));
  });
  app.on('before-quit', () => { closing = true; });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    // Otherwise the icon can linger in the notification area until the mouse passes over it.
    if (tray) { tray.destroy(); tray = null; }
  });
  app.on('window-all-closed', () => app.quit());
}
