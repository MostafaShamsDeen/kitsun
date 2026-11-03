// Continue in another account (beta): carry a local Claude Code session on in another account, e.g. when the first
// one has used up its plan. Creates a NEW session in the target account's copy that starts from a copy of the
// conversation; the original session, its record and its transcript are never changed, moved or deleted.
// No Electron here, so it can be tested with plain node against a copied folder tree (main.js passes the real folders).
//
// What Claude 4.4212's own code does (app.asar, read-only, 30 Oct 2026):
// - Sessions are read from <dataDir>/claude-code-sessions/<accountUuid>/<orgUuid>/local_<uuid>.json only when the
//   copy starts or its signed-in account changes (LocalSessionManager.loadSessions). Nothing watches the folder, so a
//   running copy shows a new file only after it restarts.
// - Claude's own fork (forkSession) gives the fork a new local_<uuid> whose cliSessionId is the same uuid, copies the
//   transcript <cli>.jsonl to <newCli>.jsonl with a plain file copy (lines keep the old sessionId; Claude Code resumes
//   by file name), copies the subagent transcripts, then appends lines that clear inherited Remote Control bridge
//   pointers ("bridge-session") and worktree bindings ("worktree-state"). This module does the same.
// - Claude's own import from another profile (registerExternalSession) writes a deliberately small record: ids, cwd,
//   originCwd, title, times, isArchived, cliMcpAppServerNames. Everything else in a session file belongs to the account,
//   org or that run: bridgeSessionIds (Remote Control), remoteMcpServersConfig / enabledMcpTools (the org's
//   connectors), sessionPermissionUpdates / alwaysAllowedReasons / permissionMode / bypassChosenInApp (permission
//   grants), chrome* (Claude in Chrome grants), scheduledTaskId, spawnSeed, prompt and tool snapshots, publishedArtifacts,
//   postTurnSummary, model / effort (the target's plan may not offer the model). The record written here is the same
//   small one, so the target uses its own defaults for those.
// - Two copies resuming one cliSessionId at once would both append to one transcript file (interleaved turns, two
//   branches). A forked copy has its own cliSessionId and file, so both sessions can be used; they just don't sync.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { turnFromTail } = require('./attention');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID_RE = /^local_[A-Za-z0-9-]{1,64}$/; // what lib/search.js and Claude's link handler accept
const MAX_RECORD = 10 * 1024 * 1024; // Claude skips session files bigger than this
const MAX_SUBAGENT_FILES = 500;
const TAIL_STEP = 64 * 1024;
const BRIDGE_MARK = '"type":"bridge-session"';
const WORKTREE_MARK = 'worktree-state';
const SAFE_NAME_RE = /^[A-Za-z0-9_.-]{1,200}$/;

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function listDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

// A real file or folder, not a link to somewhere else.
function lstatOf(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}
const isFile = (p) => { const s = lstatOf(p); return Boolean(s && s.isFile()); };
const isDir = (p) => { const s = lstatOf(p); return Boolean(s && s.isDirectory()); };

function readJsonSync(file, max = MAX_RECORD) {
  const s = lstatOf(file);
  if (!s || !s.isFile() || s.size > max) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const accountUuidOf = (dataDir) => {
  const c = readJsonSync(path.join(dataDir, 'config.json'));
  return c && isUuid(c.lastKnownAccountUuid) ? c.lastKnownAccountUuid : null;
};

// The organisation the copy used last, from its plan-usage samples (each names its org). The samples name no account
// and outlive a sign-in to another one, so pickOrg only trusts this for an org folder the current account has.
function lastOrgOf(dataDir) {
  const raw = readJsonSync(path.join(dataDir, 'plan-usage-history.json'));
  const samples = raw && Array.isArray(raw.samples) ? raw.samples.filter((s) => s && Number.isFinite(s.t) && isUuid(s.org)) : [];
  if (!samples.length) return null;
  return samples.reduce((a, b) => (b.t > a.t ? b : a)).org;
}

// Which org folder of the target account (<dataDir>/claude-code-sessions/<accountUuid>) Claude will list sessions from:
// the org its plan usage was last read for, if this account has that folder with a session in it; else the folder
// with the newest session file; else the only one. Never a folder the account doesn't have yet: a guessed org may be
// one Claude never lists. null when it can't be told (no org folder, or several without sessions).
function pickOrg(accountDir, preferred) {
  const orgs = listDir(accountDir).filter((o) => isUuid(o) && isDir(path.join(accountDir, o)));
  const newest = new Map(); // org -> newest session file time
  for (const o of orgs) {
    for (const f of listDir(path.join(accountDir, o))) {
      if (!/^local_.*\.json$/.test(f)) continue;
      const s = lstatOf(path.join(accountDir, o, f));
      if (s && s.isFile() && s.mtimeMs > (newest.get(o) ?? -1)) newest.set(o, s.mtimeMs);
    }
  }
  const hit = preferred && orgs.find((o) => o.toLowerCase() === preferred.toLowerCase() && newest.has(o));
  if (hit) return { org: hit, exists: true };
  let best = null;
  for (const [o, t] of newest) if (!best || t > newest.get(best)) best = o;
  if (best) return { org: best, exists: true };
  return orgs.length === 1 ? { org: orgs[0], exists: true } : null;
}

// 'mid' when the transcript ends in the middle of a turn (see lib/attention.js turnFromTail), else 'done' or null.
async function turnOfTranscript(file, size) {
  for (const bytes of [TAIL_STEP, 1024 * 1024]) {
    const len = Math.min(size, bytes);
    let fh;
    let text = '';
    try {
      fh = await fsp.open(file, 'r');
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, size - len);
      text = buf.toString('utf8', 0, bytesRead);
    } catch {
      return null;
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
    const turn = turnFromTail(text);
    // A huge last line (tool output) needs a longer read to reach a whole line.
    if (turn !== null || len >= size) return turn;
  }
  return null;
}

// The session's record in the source copy, among its signed-in account's folders (like lib/stats.js sessionsOf).
function findRecord(dataDir, sessionId) {
  const root = path.join(dataDir, 'claude-code-sessions');
  const acct = accountUuidOf(dataDir);
  for (const a of acct ? [acct] : listDir(root)) {
    for (const o of listDir(path.join(root, a))) {
      const file = path.join(root, a, o, `${sessionId}.json`);
      if (isFile(file)) return { file, accountUuid: acct };
    }
  }
  return null;
}

// <codeDir>/projects/<folder>/<cli>.jsonl. The folder isn't always the session's cwd, so all are looked in; a session
// found in two folders (moved or resumed elsewhere) is taken from the larger copy, which has more of it.
function findTranscript(codeDir, cli) {
  const projects = path.join(codeDir, 'projects');
  let best = null;
  for (const dir of listDir(projects)) {
    const file = path.join(projects, dir, `${cli}.jsonl`);
    const s = lstatOf(file);
    if (s && s.isFile() && (!best || s.size > best.size)) best = { file, dir: path.join(projects, dir), size: s.size };
  }
  return best;
}

// Cuts a line Claude Code was still writing off the end of our copy, so it ends on a whole line.
async function endOnWholeLine(file) {
  const fh = await fsp.open(file, 'r+');
  try {
    const { size } = await fh.stat();
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - TAIL_STEP);
      const buf = Buffer.alloc(end - start);
      await fh.read(buf, 0, buf.length, start);
      const nl = buf.lastIndexOf(10);
      if (nl >= 0) {
        const keep = start + nl + 1;
        if (keep < size) await fh.truncate(keep);
        return keep;
      }
      end = start;
    }
    return 0;
  } finally {
    await fh.close();
  }
}

// The same clean-up Claude's fork does: the last bridge pointer and worktree binding of each session id in the
// transcript; any still set gets a line appended that clears it, so the copy doesn't take over the original's Remote
// Control link or worktree.
async function inheritedLinks(file) {
  const bridges = new Map();
  const worktrees = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(file, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  for await (const line of rl) {
    const bridge = line.includes(BRIDGE_MARK);
    if (!bridge && !line.includes(WORKTREE_MARK)) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object' || typeof o.sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(o.sessionId)) continue;
    if (o.type === 'bridge-session') bridges.set(o.sessionId, Boolean(o.bridgeSessionId));
    else if (o.type === 'worktree-state') worktrees.set(o.sessionId, Boolean(o.worktreeSession));
  }
  const on = (m) => [...m].filter(([, v]) => v).map(([k]) => k);
  return [
    ...on(bridges).map((s) => JSON.stringify({ type: 'bridge-session', sessionId: s, bridgeSessionId: '', lastSequenceNum: 0 })),
    ...on(worktrees).map((s) => JSON.stringify({ type: 'worktree-state', worktreeSession: null, sessionId: s })),
  ];
}

// Why a session can't be carried over at all (it lives somewhere a copy of its transcript doesn't reach).
function unsupported(rec) {
  if (rec.sshConfig || rec.wslConfig) return 'it runs on another machine (SSH or WSL)';
  if (rec.movedToCloud) return 'it was moved to the cloud';
  if (rec.worktreePath || rec.worktreeLazy || (Array.isArray(rec.folderWorktrees) && rec.folderWorktrees.length)) return 'it works in a Git worktree';
  return null;
}

// The record for the new session: what Claude's own import keeps, with new ids and fresh times (so it is at the top
// of the target's list), plus the folders its shell worked in (Home groups sessions by them).
function newRecord(src, sessionId, cliSessionId, now) {
  const strings = (v, n) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length < 1000).slice(0, n) : []);
  const rec = {
    sessionId,
    cliSessionId,
    cwd: src.cwd,
    originCwd: typeof src.originCwd === 'string' && src.originCwd ? src.originCwd : src.cwd,
    title: typeof src.title === 'string' && src.title ? src.title.slice(0, 500) : 'Untitled session',
    createdAt: now,
    lastActivityAt: now,
    isArchived: false,
  };
  const servers = strings(src.cliMcpAppServerNames, 50);
  if (servers.length) rec.cliMcpAppServerNames = servers;
  const shell = strings(src.shellFolders, 20);
  if (shell.length) rec.shellFolders = shell;
  return rec;
}

// source / target: { name, dataDir, codeDir }. Checks everything before writing anything; writes only new files
// (each opened with "fail if it exists") and removes those again if a later step fails. Returns
// { ok: true, sessionId, cliSessionId, title, record, transcript } or { ok: false, error }.
// cliRunning(cliSessionId): optional, resolves true / false / null (can't tell) for whether a Claude Code process is
// resuming that session; without it a mid-turn transcript is always refused.
async function continueSession({ sessionId, source, target, now = Date.now(), newUuid = crypto.randomUUID(), cliRunning = null }) {
  const fail = (error) => ({ ok: false, error });
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return fail('That isn\'t a Claude Code session.');
  if (!isUuid(newUuid)) return fail('Couldn\'t make a new session id.');
  if (!source || !target || !source.dataDir || !target.dataDir) return fail(`${(target && target.name) || 'That account'} hasn't been opened yet. Start it and sign in first.`);
  if (!same(source.codeDir, target.codeDir)) {
    return fail(`${source.name} and ${target.name} use different Claude Code folders, so ${target.name} can't read this conversation. Turn on "Share Claude Code settings" for both.`);
  }

  // The source session and its conversation.
  const found = findRecord(source.dataDir, sessionId);
  if (!found) return fail(`That session isn't in ${source.name} any more.`);
  const src = readJsonSync(found.file);
  if (!src || src.sessionId !== sessionId) return fail('That session\'s file couldn\'t be read.');
  if (!isUuid(src.cliSessionId)) return fail('That session has no conversation yet.');
  if (typeof src.cwd !== 'string' || !path.isAbsolute(src.cwd)) return fail('That session has no project folder.');
  const why = unsupported(src);
  if (why) return fail(`That session can't be continued in another account yet: ${why}.`);
  const tr = findTranscript(source.codeDir, src.cliSessionId);
  if (!tr || !tr.size) return fail('Its Claude Code conversation file wasn\'t found.');
  // Mid-turn (working, or held by a permission, question or plan prompt), the copy would stop halfway through what
  // Claude is doing. A transcript cut off mid-turn by a quit or crash reads the same, so when the caller can tell that
  // no Claude Code process is resuming this session (cliRunning resolves false), it is copied as it is.
  if ((await turnOfTranscript(tr.file, tr.size)) === 'mid') {
    const live = cliRunning ? await Promise.resolve(cliRunning(src.cliSessionId)).catch(() => null) : null;
    if (live !== false) return fail(`That session is in the middle of a turn in ${source.name}. Wait for it to finish (or stop it there), then try again.`);
  }

  // Where the target copy keeps its sessions: its signed-in account and the org it uses.
  const toAccount = accountUuidOf(target.dataDir);
  if (!toAccount) return fail(`${target.name} isn't signed in yet. Sign in there first.`);
  if (found.accountUuid && found.accountUuid.toLowerCase() === toAccount.toLowerCase()) {
    return fail(`${source.name} and ${target.name} are signed in to the same Claude account, so they share one usage limit.`);
  }
  const accountDir = path.join(target.dataDir, 'claude-code-sessions', toAccount);
  const org = pickOrg(accountDir, lastOrgOf(target.dataDir));
  if (!org) {
    const none = !listDir(accountDir).some((o) => isUuid(o) && isDir(path.join(accountDir, o)));
    return fail(none ? `Open the Code tab in ${target.name} once, then try again.` : `Couldn't tell which organisation ${target.name} uses. Start a Code session in ${target.name} once, then try again.`);
  }
  const orgDir = path.join(accountDir, org.org);

  const newSid = `local_${newUuid}`;
  const recordFile = path.join(orgDir, `${newSid}.json`);
  const transcript = path.join(tr.dir, `${newUuid}.jsonl`);
  const sideDir = path.join(tr.dir, newUuid);
  if ([recordFile, transcript, sideDir, path.join(orgDir, `deleted_${newUuid}`)].some((p) => lstatOf(p))) return fail('A file for the new session already exists. Try again.');

  // From here on, every file and folder made is remembered, so a failure leaves nothing behind.
  const made = [];
  const madeDirs = [];
  const mkdirs = async (dir) => {
    const missing = [];
    for (let d = dir; !lstatOf(d); d = path.dirname(d)) {
      missing.unshift(d);
      if (path.dirname(d) === d) break;
    }
    for (const d of missing) { await fsp.mkdir(d); madeDirs.push(d); }
  };
  try {
    await fsp.copyFile(tr.file, transcript, fs.constants.COPYFILE_EXCL);
    made.push(transcript);
    if (!(await endOnWholeLine(transcript))) throw new Error('empty conversation');
    const fixes = await inheritedLinks(transcript);
    if (fixes.length) await fsp.appendFile(transcript, fixes.map((l) => `${l}\n`).join(''));

    // Subagent transcripts, as Claude's fork copies them. Not needed to carry on, so a failure here doesn't stop it.
    const subSrc = path.join(tr.dir, src.cliSessionId, 'subagents');
    if (isDir(subSrc)) {
      try {
        const names = listDir(subSrc).filter((n) => SAFE_NAME_RE.test(n) && isFile(path.join(subSrc, n))).slice(0, MAX_SUBAGENT_FILES);
        if (names.length) await mkdirs(path.join(sideDir, 'subagents'));
        for (const n of names) {
          const to = path.join(sideDir, 'subagents', n);
          await fsp.copyFile(path.join(subSrc, n), to, fs.constants.COPYFILE_EXCL);
          made.push(to);
        }
      } catch (err) {
        console.error('Could not copy subagent transcripts:', err.message);
      }
    }

    const rec = newRecord(src, newSid, newUuid, now);
    await fsp.writeFile(recordFile, JSON.stringify(rec), { flag: 'wx' });
    made.push(recordFile);
    return { ok: true, sessionId: newSid, cliSessionId: newUuid, title: rec.title, record: recordFile, transcript };
  } catch (err) {
    // Only what this call made is removed (newest first); nothing that was there before.
    for (const f of made.reverse()) await fsp.unlink(f).catch(() => {});
    for (const d of madeDirs.reverse()) await fsp.rmdir(d).catch(() => {});
    return fail(`Couldn't copy the session: ${err && err.message ? err.message : err}`);
  }
}

module.exports = { continueSession, pickOrg, lastOrgOf, findRecord, findTranscript, inheritedLinks, newRecord, unsupported, SESSION_ID_RE, UUID_RE };
