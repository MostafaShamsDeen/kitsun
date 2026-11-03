// Pure helpers for keeping the Claude copies running: why a copy closed (from its own main.log),
// which Claude version is installed (from claude.exe's package folder), and how often a copy may be
// reopened. No Electron here, so each piece can be tested with plain node.

const fs = require('fs');
const path = require('path');

const LOG_TAIL_BYTES = 256 * 1024;

// ---------- where each copy writes main.log ----------

function listDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return -1; }
}

// The Claude app is a Store (MSIX) app, so its logs may sit in the package's LocalCache instead of the
// path it asked for, and the main copy may have moved its data to Claude-Data. Every candidate is listed;
// the most recently written one that exists is the live log.
function logCandidates(account, env = process.env) {
  const local = env.LOCALAPPDATA || '';
  const packagesDir = path.join(local, 'Packages');
  const packages = listDir(packagesDir).filter((n) => /^Claude_/i.test(n));
  if (account.main) {
    return [
      path.join(local, 'Claude', 'Logs', 'main.log'),
      ...packages.map((n) => path.join(packagesDir, n, 'LocalCache', 'Local', 'Claude', 'Logs', 'main.log')),
      ...listDir(path.join(local, 'Claude-Data')).filter((n) => /^claude_/i.test(n)).map((n) => path.join(local, 'Claude-Data', n, 'logs', 'main.log')),
    ];
  }
  return [
    path.join(local, 'Claude-Profiles', account.id, 'logs', 'main.log'),
    ...packages.map((n) => path.join(packagesDir, n, 'LocalCache', 'Local', 'Claude-Profiles', account.id, 'logs', 'main.log')),
  ];
}

function findMainLog(account, env = process.env) {
  let best = null;
  let bestTime = -1;
  for (const file of logCandidates(account, env)) {
    const t = mtime(file);
    if (t > bestTime) { best = file; bestTime = t; }
  }
  return best;
}

// The last `bytes` of a file as text ('' if it can't be read). A cut first line is harmless: only whole
// lines that start with a timestamp are looked at.
function readTail(file, bytes = LOG_TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

// ---------- why a copy closed ----------

// "2026-10-29 19:38:47 [info] message" in local time.
const LINE_RE = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.\d+)? \[\w+\] (.*)$/;

function lineTime(m) {
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
}

// Classifies the last quit in a main.log tail, looking only after the last "Starting app" (the run that
// just ended). Returns { reason, at, startedAt }:
//   'update'   Windows closed it for a package update ("Windows session ending (close-app)"), or it was
//              the copy that installed the update ("beforeQuitForUpdate"), or Claude's updater restarted it
//              once its sessions were idle ("[updater-guard] nothing left to wait for; restarting"). selfRelaunch
//              is true for the last two: Claude reopens that copy by itself once the update is in.
//   'shutdown' Windows was signing out or shutting down ("Windows session ending (shutdown|logoff…)").
//   'user'     A plain quit (Claude's File > Exit or its tray menu) that went ahead. Claude can veto a quit
//              ("beforeQuit: vetoed by before-quit interceptor": its quit-confirm prompt, or the updater waiting for
//              sessions); a vetoed "beforeQuit: handler fired" doesn't count, so a later crash still reads as one.
//   'crash'    No quit line at all: the process just ended.
//   'unknown'  Nothing could be read.
// at: when the deciding line was written (for 'user', the last line of the quit that went ahead; null for
// crash/unknown).
function classifyQuit(text) {
  if (!text) return { reason: 'unknown', at: null, startedAt: null, selfRelaunch: false };
  const lines = text.split(/\r?\n/);
  let start = 0;
  let startedAt = null;
  for (let n = lines.length - 1; n >= 0; n--) {
    const m = LINE_RE.exec(lines[n]);
    if (m && /^Starting app\b/.test(m[7])) { start = n + 1; startedAt = lineTime(m); break; }
  }
  let update = null;
  let shutdown = null;
  let user = null; // the last line of a quit that went ahead
  let asked = null; // a "beforeQuit: handler fired" not (yet) vetoed
  let selfRelaunch = false;
  for (let n = start; n < lines.length; n++) {
    const m = LINE_RE.exec(lines[n]);
    if (!m) continue;
    const msg = m[7];
    if (/^beforeQuitForUpdate handler fired/.test(msg) || /^\[updater-guard\] nothing left to wait for; restarting/.test(msg)) {
      update = lineTime(m);
      selfRelaunch = true;
      continue;
    }
    const s = /^Windows session ending \(([^)]*)\)/.exec(msg);
    if (s) {
      if (s[1].split(/,\s*/).includes('close-app')) update = lineTime(m);
      else shutdown = lineTime(m);
      continue;
    }
    // Claude logs the veto right after the "fired" line, so a "fired" line still standing at the end went ahead.
    if (/^beforeQuit: handler fired/.test(msg)) asked = lineTime(m);
    else if (/^beforeQuit: vetoed\b/.test(msg)) asked = null;
    else if (/^beforeQuit: handler is (ready for quit|not yet run|already running)|^willQuit: handler (fired|is ready)/.test(msg)) user = lineTime(m);
  }
  if (asked !== null && (user === null || asked > user)) user = asked;
  // A session ending also runs the normal quit handlers afterwards, so it outranks a plain quit.
  if (update !== null) return { reason: 'update', at: update, startedAt, selfRelaunch };
  if (shutdown !== null) return { reason: 'shutdown', at: shutdown, startedAt, selfRelaunch: false };
  if (user !== null) return { reason: 'user', at: user, startedAt, selfRelaunch: false };
  return { reason: 'crash', at: null, startedAt, selfRelaunch: false };
}

// Reads the account's live main.log and classifies its last quit. A quit line written long before the
// copy was seen to go is from some other run (a stale log candidate), so it counts as unknown.
function exitReason(account, vanishedAt = Date.now(), env = process.env) {
  const file = findMainLog(account, env);
  if (!file) return { reason: 'unknown', at: null, startedAt: null, selfRelaunch: false, file: null };
  const r = classifyQuit(readTail(file));
  if (r.at !== null && vanishedAt - r.at > 3 * 60000) return { ...r, reason: 'unknown', file };
  return { ...r, file };
}

// ---------- the installed Claude version ----------

// ...\WindowsApps\Claude_4.4212.0.0_x64__pzs8sxrjxfjjc\app\claude.exe -> '4.4212.0.0'
function versionFromExe(exe) {
  const m = /\\Claude_(\d+(?:\.\d+)+)_[^\\]*\\app\\claude\.exe$/i.exec(String(exe || ''));
  return m ? m[1] : null;
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let n = 0; n < Math.max(pa.length, pb.length); n++) {
    const d = (pa[n] || 0) - (pb[n] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// '4.4212.0.0' -> '4.4212', the way Claude names its versions.
function displayVersion(v) {
  const parts = String(v).split('.');
  while (parts.length > 2 && parts[parts.length - 1] === '0') parts.pop();
  return parts.join('.');
}

// ---------- how often a copy may be reopened ----------

// Timestamps of the automatic restarts still inside the window, and whether another one is allowed.
function restartBudget(history, now = Date.now(), { max = 3, windowMs = 10 * 60000 } = {}) {
  const recent = (history || []).filter((t) => now - t < windowMs);
  return { recent, allowed: recent.length < max };
}

// "A", "A and B", "A, B and C"
function listNames(names) {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

module.exports = {
  LOG_TAIL_BYTES, logCandidates, findMainLog, readTail, classifyQuit, exitReason,
  versionFromExe, compareVersions, displayVersion, restartBudget, listNames,
};
