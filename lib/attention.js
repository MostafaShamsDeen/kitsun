// "Needs you" and plan limits: which local Claude Code sessions of each account are waiting for the person,
// finished while nobody was looking, or are working; and when an account nears or resets its plan limit.
// Read from files each Claude copy already keeps; nothing is written. No Electron here, so it can be tested
// with plain node (main.js polls it every few seconds and decides what to show and notify).
//
// What the files say (checked against Claude 4.4212's own code in app.asar and the real session files of three
// accounts, read-only, on 29 Oct 2026):
//
// - A permission prompt, or a question from Claude's AskUserQuestion tool, is NOT saved in the session file:
//   Claude keeps pending prompts in memory (its "permission broker"). Its main.log does say so, though:
//     "Emitted tool permission request <id> for <tool> in session local_<uuid>"   (asked)
//     "Received permission response for <id>: once (tool: Bash)"                  (answered)
//     "LocalSessions.respondToToolPermission: requestId=<id>, …"                  (answered)
//     "Permission request <id> for <tool> aborted"                                 (turn stopped, prompt withdrawn)
//     "No pending permission request found for <id>"                               (already gone)
//   A restart ("Starting app") drops every pending prompt. Real logs show one aborted prompt among a dozen answered.
// - interruptedAwaitingPerson (+ interruptedByQuitAt): written when Claude quits in the middle of a turn; true when
//   a prompt was pending then. Claude itself only counts it with interruptedByQuitAt set and for 24 hours, and
//   clears it when the turn is resumed.
// - postTurnSummary { status_category, needs_action }: written a few seconds after a turn ends, for the turn whose
//   last reply is postTurnSummaryFor; cleared when the next message is sent. Claude's own notifications treat
//   'blocked', 'need_input' and 'failed' as "needs input" and show needs_action. Real values: 'completed',
//   'review_ready', and 'blocked' with a question in needs_action ("Shall I reboot now, or schedule it…?").
// - lastTurnEdgeAt: set whenever a turn starts or ends (Claude's isRunning flips), so after a turn it is when it
//   ended. lastFocusedAt: set when the session becomes visible in Claude (only then, not while it stays visible).
//   turnWrapUp.description: Claude's one-line "what happened" for the last turn.
// - No "running" flag is saved. The transcript (~/.claude/projects/<folder>/<cliSessionId>.jsonl, and the folder
//   is not always the session's cwd) is appended as the turn goes: a finished turn ends with an assistant message
//   whose stop_reason is end_turn, then a stop_hook_summary; a turn in progress ends with the prompt, a tool_use
//   or a tool_result. A long reply is written only once it is complete, so a busy transcript can be quiet for minutes.
//
// So, per session (archived ones are skipped):
// - waiting: a prompt from the log is pending for it; or it was waiting when Claude quit (24 h); or its last turn's
//   summary is blocked / need_input (or failed with needs_action), is for its latest turn, ended in the last 24 h,
//   and the person hasn't looked since (not focused in Claude after the turn ended, and its account wasn't on
//   screen in Multi Claude since: lastFocusedAt alone misses a turn that ends while it is being watched).
// - done-unseen: a turn ended in the last 24 h, after lastFocusedAt, and its account hasn't been on screen since.
//   Scheduled runs are left out: Claude files them under their routine, and there are dozens.
// - working: the transcript ends mid-turn, was written in the last 15 minutes, and the account's Claude is running.
// A pending prompt outranks working, which outranks the rest.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { dataDirOf, codeDirOf, sessionsOf, planOf, listDir } = require('./stats');
const health = require('./health');

const HOUR = 3600000;
const RECENT = 24 * HOUR; // waiting-by-summary and done-unseen only count for a day
const WORKING_STALE = 15 * 60000; // a mid-turn transcript quiet for longer is not counted as working
const LOG_FIRST_READ = 1024 * 1024; // bytes of main.log read the first time; later only what was appended
const LOG_MAX_STEP = 4 * 1024 * 1024; // a bigger jump is read from its last LOG_FIRST_READ bytes, starting over
const TAIL_BYTES = 64 * 1024;
const TAIL_MAX = 1024 * 1024; // a huge last line (tool output) needs more than TAIL_BYTES to reach a whole line
const SEARCH_AGAIN = 60000; // a transcript that wasn't found is looked for again after this
const MAX_ITEMS = 12; // per account, in the payload
const FIVE_HOURS = 5 * HOUR;
const WEEK = 7 * 24 * HOUR;
const FRESH_SAMPLE = 30 * 60000; // limit alerts only for samples this recent (Claude writes one every ~15 min)

// ---------- pending prompts, from main.log ----------

const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const TIME_RE = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.\d+)? \[\w+\] (.*)$/;
const ASKED_RE = new RegExp(`^Emitted tool permission request ${ID} for (.+) in session (local_[0-9a-f-]{36})\\s*$`);
const DONE_RES = [
  new RegExp(`^Received permission response for ${ID}`),
  new RegExp(`respondToToolPermission: requestId=${ID}`),
  new RegExp(`^Permission request ${ID} for .* aborted`),
  new RegExp(`^No pending permission request found for ${ID}`),
];

// Applies log lines to `pending` (request id -> { sessionId, tool, at }).
function applyLogLines(lines, pending) {
  for (const line of lines) {
    const m = TIME_RE.exec(line);
    if (!m) continue;
    const msg = m[7];
    if (/^Starting app\b/.test(msg)) { pending.clear(); continue; }
    const asked = ASKED_RE.exec(msg);
    if (asked) {
      const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
      pending.set(asked[1], { sessionId: asked[3], tool: asked[2].trim(), at });
      continue;
    }
    for (const re of DONE_RES) {
      const d = re.exec(msg);
      if (d) { pending.delete(d[1]); break; }
    }
  }
  return pending;
}

// Follows one account's main.log, reading only what was appended since the last call. Starts over when the
// file is a different one, or shrank (Claude rotates main.log to main1.log at ~10 MB).
function createLogFollower() {
  let file = null;
  let offset = 0;
  let carry = '';
  const pending = new Map();
  async function read(next) {
    if (!next) { file = null; pending.clear(); return pending; }
    let size;
    try { size = (await fsp.stat(next)).size; } catch { return pending; }
    let start = offset;
    if (next !== file || size < offset || size - offset > LOG_MAX_STEP) {
      // A first read (or a jump) begins mid-file, so its first line may be cut; TIME_RE ignores that.
      file = next;
      pending.clear();
      carry = '';
      start = Math.max(0, size - LOG_FIRST_READ);
    }
    if (size === start) { offset = size; return pending; }
    let fh;
    try {
      fh = await fsp.open(next, 'r');
      const buf = Buffer.alloc(size - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      const text = carry + buf.toString('utf8', 0, bytesRead);
      const nl = text.lastIndexOf('\n');
      // An unfinished last line is kept for the next read.
      carry = nl < 0 ? text : text.slice(nl + 1);
      applyLogLines(nl < 0 ? [] : text.slice(0, nl).split(/\r?\n/), pending);
      offset = start + bytesRead;
    } catch { /* unreadable right now; try again next time */ } finally {
      if (fh) await fh.close().catch(() => {});
    }
    return pending;
  }
  return { read, pending };
}

// ---------- turn state, from the transcript ----------

// 'mid' (a turn is in progress, or was cut off), 'done' (the last turn finished) or null (can't tell).
function turnFromTail(text) {
  const lines = text.split('\n');
  for (let n = lines.length - 1; n >= 0; n--) {
    const line = lines[n].trim();
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; } // the first line of a tail is usually cut
    if (!o || typeof o !== 'object' || o.isSidechain) continue;
    if (o.type === 'system') {
      if (o.subtype === 'stop_hook_summary' || o.subtype === 'turn_duration') return 'done';
      continue;
    }
    if (o.type === 'assistant') {
      const r = o.message && o.message.stop_reason;
      return r === 'tool_use' || r == null ? 'mid' : 'done';
    }
    if (o.type === 'user') {
      if (o.isMeta || o.isCompactSummary) continue;
      const c = o.message && o.message.content;
      if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) return 'mid';
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && b.type === 'text' ? b.text : '')).join('') : '';
      if (/^\s*\[Request interrupted/.test(t)) return 'done';
      // Slash-command echoes and local command output get no reply of their own.
      if (/^\s*<(local-command-|command-name>|command-message>)/.test(t)) continue;
      return 'mid';
    }
    // Anything else (attachments, titles, cost lines, api-request markers…) says nothing about the turn.
  }
  return null;
}

async function readTail(file, size, bytes) {
  const len = Math.min(size, bytes);
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, size - len);
    return buf.toString('utf8', 0, bytesRead);
  } catch {
    return '';
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// ---------- one session ----------

const lowerTool = (tool) => String(tool).replace(/^mcp__/, '').replace(/__/g, ' · ');

// What a pending prompt is asking for.
function promptText(tool) {
  if (tool === 'AskUserQuestion') return { kind: 'question', detail: 'Has a question for you' };
  if (tool === 'ExitPlanMode') return { kind: 'plan', detail: 'Wants you to approve its plan' };
  return { kind: 'permission', detail: `Wants to use ${lowerTool(tool)}` };
}

const NEEDS_INPUT = new Set(['blocked', 'need_input']);

const clip = (text, max = 160) => (text && text.length > max ? `${text.slice(0, max - 1)}…` : text);

// s: a session from stats.sessionsOf; prompt: its pending log prompt (newest) or null; turn: { state, at } from its
// transcript or null; seenEdge: the turn edge the person last saw it at (Multi Claude's own mark); running: its
// account's Claude is running. Returns null (nothing to say) or { state, kind, detail, at, key }.
// key changes when it is a new reason to wait, so main can notify once per waiting period.
function classify(s, { prompt = null, turn = null, seenEdge = 0, running = false, now = Date.now() } = {}) {
  if (s.archived) return null;
  // A prompt holds its turn open; a turn that finished after it was asked means it went (its "aborted" line was missed).
  if (prompt && turn && turn.state === 'done' && turn.at > prompt.at + 1000) prompt = null;
  if (prompt) {
    const p = promptText(prompt.tool);
    return { state: 'waiting', kind: p.kind, detail: p.detail, at: prompt.at, key: `p:${prompt.id}` };
  }
  const working = Boolean(turn && turn.state === 'mid' && running && now - turn.at < WORKING_STALE && !(s.awaitingAtQuit >= turn.at));
  if (working) return { state: 'working', kind: 'working', detail: null, at: turn.at, key: 'w' };
  if (s.awaitingAtQuit && now - s.awaitingAtQuit < RECENT) {
    return { state: 'waiting', kind: 'quit', detail: 'Was waiting for you when its Claude closed', at: s.awaitingAtQuit, key: `q:${s.awaitingAtQuit}` };
  }
  const edge = s.turnEdgeAt;
  // The last turn may have been cut off (Claude closed mid-turn): then nothing finished.
  if (!edge || now - edge > RECENT || (turn && turn.state === 'mid')) return null;
  const looked = Math.max(s.focusedAt || 0, seenEdge >= edge ? edge : 0) >= edge;
  if (looked) return null;
  const forLatest = !s.summaryFor || !s.lastAssistantUuid || s.summaryFor === s.lastAssistantUuid;
  const cat = s.summaryCategory;
  if (forLatest && (NEEDS_INPUT.has(cat) || (cat === 'failed' && s.needsAction))) {
    return { state: 'waiting', kind: 'input', detail: clip(s.needsAction || s.summary || 'Needs your input'), at: edge, key: `s:${edge}` };
  }
  if (s.scheduled) return null;
  // Only a session that has finished a turn: a brand-new, empty session has an edge too.
  if (!s.lastAssistantUuid && !s.turns && !cat && !s.wrapUp) return null;
  return { state: 'unseen', kind: 'done', detail: clip(s.wrapUp || s.summary || null), at: edge, key: `d:${edge}` };
}

// ---------- plan usage and limit alerts ----------

// The latest 5-hour and weekly %, as they stand now: a window ends at most 5 hours (a week) after its last sample,
// so an older sample means that limit has reset since.
function usageOf(plan, now = Date.now()) {
  if (!plan) return null;
  return {
    fiveHour: now - plan.asOf < FIVE_HOURS ? plan.fiveHour : 0,
    weekly: now - plan.asOf < WEEK ? plan.weekly : 0,
    asOf: plan.asOf,
  };
}

// Compares the samples Claude wrote since the last call with what came before. mem is this account's memory
// ({} at first): lastT (newest sample handled), highAt / weekAt (when that alert was given, so it is given once
// per window; cleared once usage falls back under 50%). Returns [{ type: 'high'|'weekly'|'reset', pct }], only
// for samples fresh enough to be news. The first call looks at the newest sample alone (no reset then).
function limitEvents(mem, plan, now = Date.now()) {
  const h = plan && Array.isArray(plan.history) ? plan.history : [];
  if (!h.length) return [];
  const first = mem.lastT === undefined;
  const from = first ? h.length - 1 : h.findIndex((x) => x.t > mem.lastT);
  if (from < 0) return [];
  const events = new Map(); // one of each type per call: the newest
  for (let n = from; n < h.length; n++) {
    const s = h[n];
    const prev = !first && n > 0 ? h[n - 1] : null;
    const fresh = now - s.t < FRESH_SAMPLE;
    if (prev && prev.fh >= 50 && s.fh <= 5) {
      mem.highAt = 0;
      if (fresh) events.set('reset', { type: 'reset', pct: s.fh });
    }
    if (s.fh < 50 || (mem.highAt && s.t - mem.highAt > FIVE_HOURS)) mem.highAt = 0;
    if (s.fh >= 90 && !mem.highAt) {
      mem.highAt = s.t;
      if (fresh) { events.set('high', { type: 'high', pct: s.fh }); events.delete('reset'); }
    }
    if (s.sd < 50) mem.weekAt = 0;
    if (s.sd >= 90 && !mem.weekAt) {
      mem.weekAt = s.t;
      if (fresh) events.set('weekly', { type: 'weekly', pct: s.sd });
    }
  }
  mem.lastT = h[h.length - 1].t;
  return [...events.values()];
}

// ---------- the watcher ----------

function createAttention() {
  const logs = new Map(); // account id -> log follower
  const transcripts = new Map(); // cliSessionId -> { file, size, mtimeMs, state, missingAt }
  const seen = new Map(); // sessionId -> turn edge the person has seen (its account was on screen)
  const plans = new Map(); // data folder -> { mtimeMs, plan }
  const limitMem = new Map(); // account id -> limitEvents memory

  async function turnOf(codeDir, s, now) {
    let t = transcripts.get(s.cliSessionId);
    if (t && !t.file && now - t.missingAt < SEARCH_AGAIN) return null;
    let st = null;
    if (t && t.file) { try { st = await fsp.stat(t.file); } catch { st = null; } }
    if (!st) {
      // The project folder is named after where the session was started, which isn't always its cwd now.
      const projects = path.join(codeDir, 'projects');
      let file = null;
      for (const dir of listDir(projects)) {
        const f = path.join(projects, dir, `${s.cliSessionId}.jsonl`);
        try { st = await fsp.stat(f); file = f; break; } catch { /* not in this folder */ }
      }
      if (!file) { transcripts.set(s.cliSessionId, { file: null, missingAt: now }); return null; }
      t = { file, size: -1, mtimeMs: -1, state: null };
      transcripts.set(s.cliSessionId, t);
    }
    if (st.size !== t.size || st.mtimeMs !== t.mtimeMs) {
      let state = turnFromTail(await readTail(t.file, st.size, TAIL_BYTES));
      if (state === null && st.size > TAIL_BYTES) state = turnFromTail(await readTail(t.file, st.size, TAIL_MAX));
      Object.assign(t, { size: st.size, mtimeMs: st.mtimeMs, state });
    }
    return t.state ? { state: t.state, at: t.mtimeMs } : null;
  }

  async function planFor(dataDir) {
    let mtimeMs;
    try { mtimeMs = (await fsp.stat(path.join(dataDir, 'plan-usage-history.json'))).mtimeMs; } catch { return null; }
    const hit = plans.get(dataDir);
    if (hit && hit.mtimeMs === mtimeMs) return hit.plan;
    const plan = await planOf(dataDir);
    plans.set(dataDir, { mtimeMs, plan });
    return plan;
  }

  async function account(a, { running, looking, now }) {
    const dataDir = dataDirOf(a);
    const out = { waiting: 0, unseen: 0, working: 0, items: [], usage: null };
    if (!dataDir) return { out, events: [] };
    if (!logs.has(a.id)) logs.set(a.id, createLogFollower());
    const [sessions, pending, plan] = await Promise.all([
      sessionsOf(dataDir),
      logs.get(a.id).read(health.findMainLog(a)),
      planFor(dataDir),
    ]);
    // Newest pending prompt per session.
    const prompts = new Map();
    for (const [id, p] of pending) {
      const prev = prompts.get(p.sessionId);
      if (!prev || p.at >= prev.at) prompts.set(p.sessionId, { ...p, id });
    }
    const codeDir = codeDirOf(a);
    for (const s of sessions) {
      if (s.archived || !s.sessionId) continue;
      const prompt = prompts.get(s.sessionId) || null;
      const lastTouch = Math.max(s.mtimeMs || 0, s.lastActivityAt || 0, s.turnEdgeAt, s.userFrameAt);
      // Only sessions touched in the last day can be anything but quiet; the rest cost one stat (in sessionsOf).
      if (!prompt && now - lastTouch > RECENT) continue;
      const turn = s.cliSessionId ? await turnOf(codeDir, s, now) : null;
      // On screen (with Multi Claude in front) counts as seen: the person was there when it finished.
      if (looking && s.turnEdgeAt && (!turn || turn.state !== 'mid')) seen.set(s.sessionId, Math.max(seen.get(s.sessionId) || 0, s.turnEdgeAt));
      const c = classify(s, { prompt, turn, seenEdge: seen.get(s.sessionId) || 0, running, now });
      if (!c) continue;
      out[c.state]++;
      out.items.push({ sessionId: s.sessionId, title: s.title, folder: s.folder || null, state: c.state, kind: c.kind, detail: c.detail, at: c.at, key: c.key });
    }
    const rank = { waiting: 0, working: 1, unseen: 2 };
    out.items.sort((x, y) => rank[x.state] - rank[y.state] || y.at - x.at);
    out.items = out.items.slice(0, MAX_ITEMS);
    out.usage = usageOf(plan, now);
    if (!limitMem.has(a.id)) limitMem.set(a.id, {});
    const events = limitEvents(limitMem.get(a.id), plan, now).map((e) => ({ ...e, id: a.id }));
    return { out, events };
  }

  // accounts: the saved accounts. running / looking: Sets of account ids whose Claude is running / that are on
  // screen with Multi Claude in front. Returns { accounts: id -> { waiting, unseen, working, items, usage }, limits }.
  async function poll(accounts, { running = new Set(), looking = new Set(), now = Date.now() } = {}) {
    const results = await Promise.all(accounts.map((a) => account(a, { running: running.has(a.id), looking: looking.has(a.id), now })
      .catch((err) => {
        console.error(`Could not check ${a.name}'s sessions:`, err);
        return { out: { waiting: 0, unseen: 0, working: 0, items: [], usage: null }, events: [] };
      })));
    // Forget accounts that were removed.
    const ids = new Set(accounts.map((a) => a.id));
    for (const id of logs.keys()) if (!ids.has(id)) logs.delete(id);
    for (const id of limitMem.keys()) if (!ids.has(id)) limitMem.delete(id);
    return {
      accounts: Object.fromEntries(accounts.map((a, n) => [a.id, results[n].out])),
      limits: results.flatMap((r) => r.events),
    };
  }

  return { poll };
}

module.exports = { createAttention, applyLogLines, createLogFollower, turnFromTail, classify, usageOf, limitEvents, promptText };
