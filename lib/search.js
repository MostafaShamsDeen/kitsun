// Search across accounts: every account's local Claude Code sessions, matched on what each Claude copy already
// keeps about them (title, earlier titles, project folder, the last turn's summary and wrap-up, model), and on the
// first prompt typed in the session, read from the start of its Claude Code transcript. Nothing is written.
// No Electron here, so it can be tested with plain node (main.js keeps one index and answers search:query).
//
// Opening a result: Claude 4.4212 handles claude://code/continue?session=local_<id> (its claudeURLHandler, host
// "code"): it looks the session up among its own non-archived local sessions and shows it, or shows Code's home
// if there is no such session. sessionLink() builds that link; main.js hands it to the right copy (see openSession).

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { dataDirOf, codeDirOf, sessionsOf, listDir } = require('./stats');

const DAY = 86400000;
const LIMIT = 30;
const RECENT_SHOWN = 8; // an empty query lists the latest sessions
const MAX_QUERY = 200;
const MAX_TOKENS = 8;
const PROMPT_BYTES = 64 * 1024; // only the start of a transcript is read for its first prompt
const PROMPT_KEEP = 2000; // characters of the first prompt kept for matching
const PROMPT_RETRY = 60000; // a transcript that wasn't there (or had no prompt yet) is looked at again after this
const SNIPPET = 140;
const SESSION_ID_RE = /^local_[A-Za-z0-9-]{1,64}$/; // what Claude's own handler accepts

// How much a match in each field counts. Earlier titles and the folder are nearly as telling as the title.
const WEIGHTS = { title: 10, previous: 6, folder: 6, summary: 4, prompt: 3, model: 2, account: 2 };

// claude-opus-5-5 -> "opus 5.5", so "opus" or "sonnet 4.5" finds sessions by model.
function modelWords(id) {
  const parts = String(id || '').replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-');
  return [parts.filter((p) => !/^\d+$/.test(p)).join(' '), parts.filter((p) => /^\d+$/.test(p)).join('.')].filter(Boolean).join(' ');
}

function tokensOf(text) {
  const out = [];
  for (const t of String(text || '').slice(0, MAX_QUERY).toLowerCase().split(/\s+/)) if (t && !out.includes(t)) out.push(t);
  return out.slice(0, MAX_TOKENS);
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const oneLine = (text) => String(text || '').replace(/\s+/g, ' ').trim();

// ---------- the first prompt, from the transcript ----------

// The first thing the person typed: the first user line that is neither tool output nor something Claude Code adds
// (reminders, command echoes, a scheduled task's instructions, which all start with '<').
function firstPrompt(text) {
  for (const line of text.split('\n')) {
    if (!line.includes('"user"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; } // the last line of a 64 KB read is usually cut
    if (!o || o.type !== 'user' || o.isMeta || o.isSidechain || o.isCompactSummary || o.toolUseResult !== undefined) continue;
    const c = o.message && o.message.content;
    if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) continue;
    const t = oneLine(typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && b.type === 'text' ? b.text : '')).join(' ') : '');
    if (!t || t.startsWith('<') || t.startsWith('[Request interrupted')) continue;
    return t.slice(0, PROMPT_KEEP);
  }
  return null;
}

async function readHead(file, bytes) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } catch {
    return '';
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// ---------- ranking ----------

// Where `token` occurs in `text` (already lower case), and whether at the start of a word.
function hit(text, token) {
  if (!text) return null;
  let at = text.indexOf(token);
  if (at < 0) return null;
  const first = at;
  while (at >= 0) {
    if (at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1])) return { at, word: true };
    at = text.indexOf(token, at + 1);
  }
  return { at: first, word: false };
}

// The text around the first place a token occurs, on one line.
function around(text, tokens) {
  const lower = text.toLowerCase();
  const at = Math.min(...tokens.map((t) => { const i = lower.indexOf(t); return i < 0 ? Infinity : i; }));
  if (!Number.isFinite(at) || at < SNIPPET - 40) return clip(text, SNIPPET);
  const start = text.lastIndexOf(' ', at - 30) + 1 || at - 30;
  return clip(`…${text.slice(start)}`, SNIPPET);
}

// doc: one indexed session. Returns null (some token matches nothing) or { score, field } with the field that
// counted most apart from the title, for the snippet.
function score(doc, tokens, now) {
  let total = 0;
  const counted = {};
  for (const t of tokens) {
    let best = 0;
    let bestField = null;
    for (const [field, w] of Object.entries(WEIGHTS)) {
      const h = hit(doc.lc[field], t);
      if (!h) continue;
      const s = w * (h.word ? 1 : 0.6);
      if (s > best) { best = s; bestField = field; }
    }
    if (!best) return null;
    total += best;
    counted[bestField] = (counted[bestField] || 0) + best;
  }
  if (doc.lc.title === tokens.join(' ')) total += 6;
  // Newer work first among similar matches: up to 3 points, halving about every 5 days.
  total += 3 * Math.exp(-Math.max(0, now - doc.at) / (7 * DAY));
  if (doc.archived) total *= 0.6;
  if (doc.scheduled) total *= 0.8; // scheduled runs repeat by the dozen
  const field = Object.entries(counted).filter(([f]) => f !== 'title').sort((a, b) => b[1] - a[1])[0];
  return { score: total, field: field ? field[0] : null };
}

function snippetOf(doc, field, tokens) {
  const r = doc.raw;
  if (field === 'previous') return `Was “${r.previous.find((p) => tokens.some((t) => p.toLowerCase().includes(t))) || r.previous[0]}”`;
  if (field === 'summary' || field === 'prompt') return around(r[field], tokens);
  if (field === 'model') return modelWords(r.model);
  // Matched on the title, folder or account (both shown anyway): say what the session was about.
  return r.summary ? clip(r.summary, SNIPPET) : r.prompt ? clip(r.prompt, SNIPPET) : null;
}

// ---------- the index ----------

function createSearch({ maxAge = 10000 } = {}) {
  let docs = [];
  let builtAt = 0;
  let builtSig = '';
  let building = null;
  let rebuild = null; // a forced refresh waiting for the build under way, to build again after it
  const prompts = new Map(); // codeDir|cliSessionId -> { text, size, final, checkedAt }
  let filling = false;

  const sigOf = (accounts) => accounts.map((a) => `${a.id}:${a.name}:${a.main ? 1 : 0}:${a.shareCode ? 1 : 0}`).join('|');

  function docOf(a, s, codeDir) {
    const summary = oneLine([s.needsAction, s.summary, s.wrapUp].filter((x, i, all) => x && all.indexOf(x) === i).join(' · '));
    const raw = {
      title: s.title, previous: s.previousTitles || [], folder: s.folder || '', summary,
      model: s.model || '', account: a.name,
    };
    const doc = {
      accountId: a.id, sessionId: s.sessionId, cliSessionId: s.cliSessionId, codeDir,
      title: s.title, folder: s.folder || null, archived: s.archived === true, scheduled: s.scheduled === true,
      at: s.lastActivityAt || s.createdAt || s.mtimeMs || 0, raw,
    };
    doc.lc = {
      title: raw.title.toLowerCase(), previous: raw.previous.join(' \n ').toLowerCase(), folder: raw.folder.toLowerCase(),
      summary: summary.toLowerCase(), model: `${raw.model} ${modelWords(raw.model)}`.toLowerCase(), account: raw.account.toLowerCase(), prompt: '',
    };
    return doc;
  }

  // Reads every account's session list (cached by file time in lib/stats.js, so this is a stat per session).
  // force: the index reads the folders after this call (e.g. a session was just written there). A build already under
  // way may have listed them before that, so a forced refresh waits for it and then builds again (once for all the
  // forced calls that came in meanwhile).
  function refresh(accounts, { force = false } = {}) {
    const sig = sigOf(accounts);
    if (!force && sig === builtSig && Date.now() - builtAt < maxAge) return Promise.resolve(false);
    if (force && building) {
      rebuild ??= building.catch(() => {}).then(() => { rebuild = null; return refresh(accounts, { force: true }); });
      return rebuild;
    }
    building ??= (async () => {
      const lists = await Promise.all(accounts.map(async (a) => {
        const dir = dataDirOf(a);
        if (!dir) return [];
        const codeDir = codeDirOf(a);
        const sessions = await sessionsOf(dir).catch(() => []);
        return sessions.filter((s) => s.sessionId && SESSION_ID_RE.test(s.sessionId)).map((s) => docOf(a, s, codeDir));
      }));
      docs = lists.flat();
      for (const d of docs) applyPrompt(d);
      builtAt = Date.now();
      builtSig = sig;
      fillPrompts().catch((err) => console.error('Could not read first prompts:', err));
      return true;
    })().finally(() => { building = null; });
    return building;
  }

  function applyPrompt(d) {
    const p = d.cliSessionId ? prompts.get(`${d.codeDir}|${d.cliSessionId}`) : null;
    d.raw.prompt = (p && p.text) || '';
    d.lc.prompt = d.raw.prompt.toLowerCase();
  }

  // Reads the first prompt of each session that doesn't have one yet, a transcript at a time, in the background.
  // Transcripts are named after the session's Claude Code id, in a project folder that isn't always its cwd.
  async function fillPrompts() {
    if (filling) return;
    filling = true;
    try {
      const now = Date.now();
      const todo = docs.filter((d) => {
        if (!d.cliSessionId || d.scheduled) return false;
        const p = prompts.get(`${d.codeDir}|${d.cliSessionId}`);
        return !p || (!p.final && now - p.checkedAt > PROMPT_RETRY);
      });
      if (!todo.length) return;
      const files = new Map(); // codeDir -> Map(file name -> path)
      for (const d of todo) {
        if (!files.has(d.codeDir)) {
          const m = new Map();
          const projects = path.join(d.codeDir, 'projects');
          for (const dir of listDir(projects)) for (const n of listDir(path.join(projects, dir))) if (n.endsWith('.jsonl') && !m.has(n)) m.set(n, path.join(projects, dir, n));
          files.set(d.codeDir, m);
        }
        const key = `${d.codeDir}|${d.cliSessionId}`;
        const file = files.get(d.codeDir).get(`${d.cliSessionId}.jsonl`);
        let size = -1;
        if (file) { try { size = (await fsp.stat(file)).size; } catch { size = -1; } }
        const prev = prompts.get(key);
        if (size < 0) { prompts.set(key, { text: null, size, final: false, checkedAt: Date.now() }); continue; }
        if (prev && prev.size === size) { prev.checkedAt = Date.now(); continue; }
        const text = firstPrompt(await readHead(file, PROMPT_BYTES));
        // No prompt in a short transcript may just mean nothing was typed yet; in a long one there is none to find.
        prompts.set(key, { text, size, final: Boolean(text) || size >= PROMPT_BYTES, checkedAt: Date.now() });
      }
      for (const d of docs) applyPrompt(d);
    } finally {
      filling = false;
    }
  }

  // text: what was typed. Every word must occur in some field (any case). Results are ranked by where they match
  // and how recent the session is; a session per title and account (scheduled runs share one). An empty text
  // lists the latest non-archived sessions.
  async function query(accounts, text, { now = Date.now() } = {}) {
    // A build already under way is fresh enough for typing; only an index older than 3 s is built again.
    if (building) await building.catch(() => {});
    else await refresh(accounts, { force: Date.now() - builtAt > 3000 });
    const tokens = tokensOf(text);
    let ranked;
    if (!tokens.length) {
      ranked = docs.filter((d) => !d.archived && !d.scheduled).sort((a, b) => b.at - a.at).slice(0, RECENT_SHOWN)
        .map((d) => ({ d, field: null }));
    } else {
      ranked = [];
      for (const d of docs) {
        const s = score(d, tokens, now);
        if (s) ranked.push({ d, score: s.score, field: s.field });
      }
      ranked.sort((a, b) => b.score - a.score || b.d.at - a.d.at);
    }
    const seen = new Set();
    const out = [];
    for (const { d, field } of ranked) {
      const key = `${d.accountId}|${d.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        accountId: d.accountId, sessionId: d.sessionId, title: d.title, folder: d.folder,
        snippet: tokens.length ? snippetOf(d, field, tokens) : (d.raw.summary ? clip(d.raw.summary, SNIPPET) : null),
        at: d.at || null, archived: d.archived,
      });
      if (out.length >= LIMIT) break;
    }
    return out;
  }

  // The indexed session (or null): main only opens sessions it found itself, in the account it found them in.
  function find(accountId, sessionId) {
    return docs.find((d) => d.accountId === accountId && d.sessionId === sessionId) || null;
  }

  return { refresh, query, find, builtAt: () => builtAt };
}

// The link that makes a Claude copy show one of its local Code sessions; null for anything else.
function sessionLink(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId) ? `claude://code/continue?session=${sessionId}` : null;
}

module.exports = { createSearch, sessionLink, firstPrompt, tokensOf, score, modelWords, SESSION_ID_RE, MAX_QUERY };
