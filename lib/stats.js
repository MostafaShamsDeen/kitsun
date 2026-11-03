// Statistics for the home screen, read from files each Claude copy already keeps on this PC:
// its plan-usage history, its local Code sessions, and the Claude Code chat transcripts.
// Nothing here talks to the network, and nothing is written except our own cache file.
//
// Transcripts can add up to gigabytes, so they are read once in the background and remembered
// (by file and byte offset) in stats-cache.json; later passes only read what was appended since.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const DAY = 86400000;
const CACHE_VERSION = 2;
const KEEP_DAYS = 35; // per-day and per-hour detail older than this is folded into the all-time totals
const MAX_PARSED_LINE = 8 * 1024 * 1024; // longer lines are huge tool output; only token counts are read from them
const RECENT_REPLIES = 32; // replies remembered per transcript, so a reply's lines are counted once

// ---------- where each copy keeps its files ----------

function listDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return -1; }
}

// The Claude app is a Store (MSIX) app: files it writes under %APPDATA% or %LOCALAPPDATA% may sit in
// its package's LocalCache instead, and the main copy may have moved its data to Claude-Data. Every
// candidate is checked and the one whose config.json was written most recently wins.
function dataDirOf(account) {
  const local = process.env.LOCALAPPDATA || '';
  const roaming = process.env.APPDATA || '';
  const packagesDir = path.join(local, 'Packages');
  const packages = listDir(packagesDir).filter((n) => /^Claude_/i.test(n));
  const candidates = account.main
    ? [
      ...listDir(path.join(local, 'Claude-Data')).filter((n) => /^claude_/i.test(n)).map((n) => path.join(local, 'Claude-Data', n)),
      ...packages.map((n) => path.join(packagesDir, n, 'LocalCache', 'Roaming', 'Claude')),
      path.join(roaming, 'Claude'),
    ]
    : [
      ...packages.map((n) => path.join(packagesDir, n, 'LocalCache', 'Local', 'Claude-Profiles', account.id)),
      path.join(local, 'Claude-Profiles', account.id),
    ];
  let best = null;
  let bestTime = -1;
  for (const dir of candidates) {
    const t = mtime(path.join(dir, 'config.json'));
    if (t > bestTime) { best = dir; bestTime = t; }
  }
  return best;
}

// Claude Code's own folder for the account: the usual ~/.claude when it shares it, else its own.
function codeDirOf(account) {
  return account.shareCode ? path.join(os.homedir(), '.claude') : path.join(os.homedir(), '.claude-accounts', account.id);
}

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
}

// ---------- plan usage ----------

async function planOf(dataDir) {
  const raw = await readJson(path.join(dataDir, 'plan-usage-history.json'));
  const samples = raw && Array.isArray(raw.samples) ? raw.samples.filter((s) => s && Number.isFinite(s.t) && s.u) : [];
  if (!samples.length) return null;
  samples.sort((a, b) => a.t - b.t);
  const last = samples[samples.length - 1];
  // A copy signed in to several organisations keeps samples for each; show the one in use now.
  const since = Date.now() - 7 * DAY;
  const history = samples.filter((s) => s.org === last.org && s.t >= since)
    .map((s) => ({ t: s.t, fh: Number(s.u.fh) || 0, sd: Number(s.u.sd) || 0 }));
  return { asOf: last.t, fiveHour: Number(last.u.fh) || 0, weekly: Number(last.u.sd) || 0, history };
}

// ---------- local Code sessions ----------

const sessionCache = new Map(); // file -> { mtimeMs, info }

// The project a session worked on. Sessions often start in a shared parent folder (e.g. D:\Claud),
// so the first folder its shell worked in says more: the first level below the start folder.
function projectFolder(s) {
  const cwd = typeof s.cwd === 'string' ? s.cwd : '';
  const worked = Array.isArray(s.shellFolders) ? s.shellFolders.find((f) => typeof f === 'string') : null;
  if (worked && cwd) {
    const rel = path.relative(cwd, worked);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep)[0];
  }
  return path.basename(worked || cwd);
}

async function readSession(file) {
  let st;
  try { st = await fsp.stat(file); } catch { return null; }
  const hit = sessionCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.info;
  const s = await readJson(file);
  if (!s || typeof s !== 'object') return null;
  const summary = s.postTurnSummary && typeof s.postTurnSummary.status_detail === 'string' ? s.postTurnSummary.status_detail : null;
  const str = (v) => (typeof v === 'string' && v ? v : null);
  const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const pts = s.postTurnSummary && typeof s.postTurnSummary === 'object' ? s.postTurnSummary : {};
  const info = {
    // For the "needs you" watcher (lib/attention.js, which documents what each field means). Not sent to the page.
    sessionId: str(s.sessionId),
    mtimeMs: st.mtimeMs,
    focusedAt: num(s.lastFocusedAt),
    turnEdgeAt: num(s.lastTurnEdgeAt),
    userFrameAt: num(s.latestUserFrameAt),
    awaitingAtQuit: s.interruptedAwaitingPerson === true ? num(s.interruptedByQuitAt) : 0,
    summaryCategory: str(pts.status_category),
    needsAction: str(pts.needs_action),
    summaryFor: str(s.postTurnSummaryFor),
    lastAssistantUuid: str(s.lastAssistantUuid),
    wrapUp: s.turnWrapUp && typeof s.turnWrapUp === 'object' ? str(s.turnWrapUp.description) : null,
    scheduled: Boolean(s.scheduledTaskId),
    cliSessionId: typeof s.cliSessionId === 'string' ? s.cliSessionId : null,
    title: typeof s.title === 'string' && s.title ? s.title : 'Untitled session',
    // For search across accounts (lib/search.js): what the session was called before Claude renamed it.
    previousTitles: Array.isArray(s.previousTitles) ? s.previousTitles.filter((t) => typeof t === 'string' && t).slice(-10).map((t) => t.slice(0, 200)) : [],
    folder: projectFolder(s),
    model: typeof s.model === 'string' ? s.model : null,
    archived: s.isArchived === true,
    turns: Number(s.completedTurns) || 0,
    createdAt: Number(s.createdAt) || null,
    lastActivityAt: Number(s.lastActivityAt) || Number(s.createdAt) || null,
    summary,
  };
  sessionCache.set(file, { mtimeMs: st.mtimeMs, info });
  return info;
}

async function sessionsOf(dataDir) {
  const config = await readJson(path.join(dataDir, 'config.json'));
  const root = path.join(dataDir, 'claude-code-sessions');
  // Sessions are kept per signed-in account; a copy that was once signed in to another account
  // still has that account's folder, so only the current one counts.
  const accountUuid = config && typeof config.lastKnownAccountUuid === 'string' ? config.lastKnownAccountUuid : null;
  const accountDirs = accountUuid ? [accountUuid] : listDir(root);
  const files = [];
  for (const a of accountDirs) {
    for (const org of listDir(path.join(root, a))) {
      for (const f of listDir(path.join(root, a, org))) {
        if (/^local_.*\.json$/.test(f)) files.push(path.join(root, a, org, f));
      }
    }
  }
  return (await Promise.all(files.map(readSession))).filter(Boolean);
}

function summarizeSessions(list) {
  const weekAgo = Date.now() - 7 * DAY;
  const count = (key) => {
    const m = new Map();
    for (const s of list) if (s[key]) m.set(s[key], (m.get(s[key]) || 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).map(([name, sessions]) => ({ name, sessions }));
  };
  const live = list.filter((s) => !s.archived);
  const byRecent = [...list].sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  // Recurring sessions (e.g. a weekly report) share a title; list each title once.
  const titles = new Set();
  const distinct = byRecent.filter((s) => !s.archived && !titles.has(s.title) && titles.add(s.title));
  return {
    total: list.length,
    archived: list.length - live.length,
    active7d: list.filter((s) => (s.lastActivityAt || 0) >= weekAgo).length,
    turns: list.reduce((n, s) => n + s.turns, 0),
    lastActivityAt: byRecent.length ? byRecent[0].lastActivityAt : null,
    // sessionId: for the card's "Continue in…" (main checks it against its own index before using it).
    recent: distinct.slice(0, 5)
      .map(({ sessionId, title, lastActivityAt, turns, folder, summary }) => ({ sessionId, title, lastActivityAt, turns, folder, summary })),
    topFolders: count('folder').slice(0, 3),
    models: count('model'),
  };
}

// ---------- running processes ----------

let procCache = { at: 0, list: null };

// claude.exe processes with parent, memory and start time, so each copy's whole process tree
// (its helpers and its Claude Code sessions) can be added up.
function claudeProcesses() {
  if (procCache.list && Date.now() - procCache.at < 8000) return Promise.resolve(procCache.list);
  const ps = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $e=[datetime]\'1970-01-01\'; '
    + "Get-CimInstance Win32_Process -Filter \"Name LIKE 'claude%.exe'\" | ForEach-Object { "
    + '"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.WorkingSetSize)`t$([int64]($_.CreationDate.ToUniversalTime() - $e).TotalMilliseconds)`t$([int]($_.CommandLine -like \'*--output-format stream-json*\'))" }';
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) return resolve(procCache.list || []);
      const list = stdout.split(/\r?\n/).map((l) => l.split('\t')).filter((p) => p.length === 5)
        .map(([pid, ppid, ws, started, code]) => ({ pid: Number(pid), ppid: Number(ppid), ws: Number(ws) || 0, started: Number(started) || null, code: code === '1' }));
      procCache = { at: Date.now(), list };
      resolve(list);
    });
  });
}

function liveOf(instance, procs) {
  const status = instance ? instance.status : 'stopped';
  const root = instance && instance.pid ? procs.find((p) => p.pid === instance.pid) : null;
  if (!root) return { status, startedAt: null, memoryMB: null, codeSessionsOpen: 0 };
  const children = new Map();
  for (const p of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  let ws = 0;
  let code = 0;
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    ws += p.ws;
    if (p.code) code++;
    stack.push(...(children.get(p.pid) || []));
  }
  return { status, startedAt: root.started, memoryMB: Math.round(ws / 1048576), codeSessionsOpen: code };
}

// ---------- chat transcripts ----------

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Text the person typed, as opposed to lines Claude Code adds to the chat: command output, task and
// schedule notices, reminders, "[Request interrupted…]" markers. Slash commands they typed count.
function typedByPerson(text) {
  if (!text) return false;
  if (text.startsWith('<')) return text.startsWith('<command-message>') || text.startsWith('<command-name>');
  return !text.startsWith('[Request interrupted');
}

// Claude Code writes one line per block of a reply, each repeating the reply's usage; the count can
// grow until the last block. Returns how many of this line's output tokens are not counted yet.
function newOutputTokens(entry, id, out) {
  if (!id) return out;
  const known = entry.replies.find((r) => r[0] === id);
  if (!known) {
    entry.replies.push([id, out]);
    if (entry.replies.length > RECENT_REPLIES) entry.replies.shift();
    return out;
  }
  const extra = Math.max(0, out - known[1]);
  known[1] = Math.max(known[1], out);
  return extra;
}

// One transcript line: a prompt the person typed, or one reply from Claude with its token usage.
function readLine(line, entry) {
  let ts = null;
  let prompt = false;
  let out = 0;
  if (line.length <= MAX_PARSED_LINE) {
    let o;
    try { o = JSON.parse(line); } catch { return; }
    if (!o || typeof o !== 'object' || typeof o.timestamp !== 'string') return;
    ts = o.timestamp;
    if (o.type === 'user') {
      if (o.isSidechain || o.isMeta || o.isCompactSummary || o.toolUseResult !== undefined) return;
      const c = o.message && o.message.content;
      const text = typeof c === 'string' ? c
        : Array.isArray(c) && !c.some((b) => b && b.type === 'tool_result') ? c.map((b) => (b && b.type === 'text' ? b.text : '')).join('').trim() : null;
      // A prompt that is only an image has no text but was still typed (pasted) by the person.
      const imageOnly = Array.isArray(c) && !text && c.some((b) => b && b.type === 'image');
      if (!imageOnly && !typedByPerson(text)) return;
      prompt = true;
    } else if (o.type === 'assistant' && o.message && o.message.usage) {
      out = newOutputTokens(entry, o.message.id, Number(o.message.usage.output_tokens) || 0);
    } else {
      return;
    }
  } else {
    const m = /"type":"assistant","uuid":"[^"]*","timestamp":"([^"]+)"/.exec(line);
    if (!m) return;
    ts = m[1];
    const id = /"id":"(msg_[A-Za-z0-9_-]+)"/.exec(line);
    const at = line.lastIndexOf('"usage":{');
    const tok = at >= 0 ? /"output_tokens":(\d+)/.exec(line.slice(at)) : null;
    out = newOutputTokens(entry, id ? id[1] : null, tok ? Number(tok[1]) : 0);
  }
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return;
  // A forked session (Claude's own fork, or Multi Claude's "Continue in…") starts with a copy of another session's
  // conversation; those lines were counted with the original, so only what was added since the fork counts.
  if (entry.since && d.getTime() < entry.since) return;
  const key = dayKey(d);
  const day = entry.d[key] || (entry.d[key] = [0, 0]);
  if (prompt) {
    day[0]++;
    entry.tp++;
    const hk = `${key}|${d.getHours()}`;
    entry.h[hk] = (entry.h[hk] || 0) + 1;
  }
  day[1] += out;
  entry.to += out;
}

// Reads a transcript from where the last pass stopped. Only whole lines are consumed, so a line
// Claude Code is in the middle of writing is read next time.
async function readTranscript(file, entry, size) {
  const stream = fs.createReadStream(file, { start: entry.offset, end: size - 1, highWaterMark: 1 << 20 });
  let carry = Buffer.alloc(0);
  for await (const chunk of stream) {
    let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let start = 0;
    let nl;
    while ((nl = buf.indexOf(10, start)) !== -1) {
      if (nl > start) readLine(buf.toString('utf8', start, nl), entry);
      entry.offset += nl + 1 - start;
      start = nl + 1;
    }
    carry = buf.subarray(start);
  }
}

function emptyEntry() {
  return { size: 0, offset: 0, replies: [], d: {}, h: {}, tp: 0, to: 0 };
}

// Detail older than KEEP_DAYS is dropped (all-time totals are kept separately).
function prune(entry) {
  const cutoff = dayKey(new Date(Date.now() - KEEP_DAYS * DAY));
  for (const k of Object.keys(entry.d)) if (k < cutoff) delete entry.d[k];
  for (const k of Object.keys(entry.h)) if (k < cutoff) delete entry.h[k];
}

// Every transcript of a session, including its subagents' transcripts kept in a folder named after it.
// A session can appear under two project folders (it was moved or resumed elsewhere) with the same
// conversation in both, so each transcript is taken once: the largest copy, which has the most of it.
function transcriptFiles(codeDir, sessionIds) {
  const best = new Map(); // session id + path inside the project folder -> { file, sid, size }
  const projects = path.join(codeDir, 'projects');
  const add = (file, sid, rel) => {
    let size;
    try { size = fs.statSync(file).size; } catch { return; }
    const key = `${sid}|${rel}`;
    const prev = best.get(key);
    if (!prev || size > prev.size) best.set(key, { file, sid, size });
  };
  const walk = (dir, sid, rel, depth) => {
    for (const n of listDir(dir)) {
      const p = path.join(dir, n);
      if (n.endsWith('.jsonl')) add(p, sid, `${rel}/${n}`);
      else if (depth < 4 && !n.includes('.')) walk(p, sid, `${rel}/${n}`, depth + 1);
    }
  };
  for (const project of listDir(projects)) {
    const dir = path.join(projects, project);
    for (const n of listDir(dir)) {
      const sid = n.endsWith('.jsonl') ? n.slice(0, -6) : n;
      if (!sessionIds.has(sid)) continue;
      const p = path.join(dir, n);
      if (n.endsWith('.jsonl')) add(p, sid, n);
      else walk(p, sid, n, 0);
    }
  }
  return [...best.values()];
}

// ---------- the collector ----------

function createStats({ cacheFile, onActivityUpdated }) {
  let cache = { version: CACHE_VERSION, files: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (raw && raw.version === CACHE_VERSION && raw.files && typeof raw.files === 'object') cache = raw;
  } catch { /* first run */ }

  let scanning = false;
  let firstPassDone = false; // until then the home screen says it is still counting
  let lastScanAt = 0;
  let sessionToAccount = new Map(); // cliSessionId -> account id, from the latest stats request
  let codeDirs = new Map(); // code folder -> Set of session ids in it
  let createdAt = new Map(); // cliSessionId -> when its session was made (see readLine: forks count from then)

  async function saveCache() {
    try {
      await fsp.writeFile(`${cacheFile}.tmp`, JSON.stringify(cache));
      await fsp.rename(`${cacheFile}.tmp`, cacheFile);
    } catch (err) {
      console.error('Could not save stats cache:', err);
    }
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    let changed = false;
    const first = !firstPassDone;
    try {
      const seen = new Set();
      for (const [codeDir, ids] of codeDirs) {
        for (const { file, sid } of transcriptFiles(codeDir, ids)) {
          seen.add(file);
          let st;
          try { st = await fsp.stat(file); } catch { continue; }
          let entry = cache.files[file];
          // A file that shrank was rewritten: start it over.
          if (!entry || st.size < entry.offset) {
            // A minute early, so a normal session's first lines (written just after it was made) always count.
            const made = createdAt.get(sid);
            entry = cache.files[file] = { ...emptyEntry(), sid, ...(made ? { since: made - 60000 } : {}) };
          }
          entry.sid = sid;
          if (st.size === entry.size && entry.offset >= st.size) continue;
          try {
            await readTranscript(file, entry, st.size);
          } catch { /* unreadable right now; try again next pass */ }
          entry.size = st.size;
          prune(entry);
          changed = true;
        }
      }
      // Forget transcripts that are gone, belong to no account now, or are a duplicate copy of another.
      for (const file of Object.keys(cache.files)) if (!seen.has(file)) { delete cache.files[file]; changed = true; }
      if (changed) await saveCache();
    } finally {
      scanning = false;
      firstPassDone = true;
      lastScanAt = Date.now();
    }
    // The first pass always reports back, so the home screen stops saying it is still counting.
    if (changed || first) onActivityUpdated();
  }

  function activityOf(accountId) {
    const today = new Date();
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      days.push({ date: dayKey(d), prompts: 0, outputTokens: 0 });
    }
    const index = new Map(days.map((d, i) => [d.date, i]));
    const weekStart = days[7].date;
    const hoursFrom = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 27));
    const hours = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const totals = { prompts7d: 0, outputTokens7d: 0, promptsAll: 0, outputTokensAll: 0 };
    for (const entry of Object.values(cache.files)) {
      if (sessionToAccount.get(entry.sid) !== accountId) continue;
      totals.promptsAll += entry.tp;
      totals.outputTokensAll += entry.to;
      for (const [k, [p, o]] of Object.entries(entry.d)) {
        const i = index.get(k);
        if (i !== undefined) { days[i].prompts += p; days[i].outputTokens += o; }
        if (k >= weekStart) { totals.prompts7d += p; totals.outputTokens7d += o; }
      }
      for (const [k, n] of Object.entries(entry.h)) {
        const [date, hour] = k.split('|');
        if (date < hoursFrom) continue;
        const [y, m, dd] = date.split('-').map(Number);
        hours[new Date(y, m - 1, dd).getDay()][Number(hour)] += n;
      }
    }
    return { days, totals, hours };
  }

  // accounts: the saved accounts; instances: account id -> { status, pid }.
  async function get(accounts, instances) {
    const procs = await claudeProcesses();
    const nextMap = new Map();
    const nextDirs = new Map();
    const nextMade = new Map();
    const result = await Promise.all(accounts.map(async (a) => {
      const dataDir = dataDirOf(a);
      const [plan, sessions] = dataDir ? await Promise.all([planOf(dataDir), sessionsOf(dataDir)]) : [null, []];
      const codeDir = codeDirOf(a);
      if (!nextDirs.has(codeDir)) nextDirs.set(codeDir, new Set());
      for (const s of sessions) {
        if (!s.cliSessionId) continue;
        nextMap.set(s.cliSessionId, a.id);
        nextDirs.get(codeDir).add(s.cliSessionId);
        if (s.createdAt) nextMade.set(s.cliSessionId, s.createdAt);
      }
      return { a, plan, sessions };
    }));
    sessionToAccount = nextMap;
    codeDirs = nextDirs;
    createdAt = nextMade;
    // Look for new messages at most every 15 seconds, in the background.
    if (!scanning && Date.now() - lastScanAt > 15000) scan().catch((err) => console.error('Stats scan failed:', err));
    return {
      generatedAt: Date.now(),
      scanning: scanning && !firstPassDone,
      accounts: result.map(({ a, plan, sessions }) => ({
        id: a.id,
        name: a.name,
        color: a.color,
        main: a.main,
        live: liveOf(instances.get(a.id), procs),
        plan,
        sessions: summarizeSessions(sessions),
        activity: activityOf(a.id),
      })),
    };
  }

  return { get };
}

// The helpers are shared with lib/attention.js, which watches the same files more often.
module.exports = { createStats, dataDirOf, codeDirOf, sessionsOf, planOf, listDir };
