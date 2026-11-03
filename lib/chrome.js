// Which Chrome profile goes with each Claude account, and where chrome.exe is, so an account's "Chrome" button
// opens the Chrome profile its Claude in Chrome extension is signed in to. Everything here only reads Chrome's
// files (with shared access, while Chrome runs); nothing is written. No Electron, so it can be tested with plain node.
//
// What the files say (checked read-only against Chrome's real profiles and Claude in Chrome on 29 Oct 2026):
// - <User Data>\Local State is JSON: profile.info_cache maps each profile folder ("Default", "Profile 6") to
//   { name, user_name, active_time }. Only folders listed there are real profiles.
// - The extension (id fcoeoabgfenejglbffodgkkbkcdhcgfn) keeps chrome.storage.local in
//   <profile>\Local Extension Settings\<id>, a LevelDB. Its key "accountUuid" holds the signed-in Claude account
//   as a JSON string, the same UUID as lastKnownAccountUuid in that account's Claude config.json.
// - Other UUIDs turn up in that LevelDB too: "…ConsentByAccount" keeps a record per account that ever used the
//   extension in the profile, and LevelDB keeps old values until it compacts them. So a profile that once
//   signed in as Personal and now uses Work still contains Personal's UUID ("Profile 4" does). A plain byte
//   search can't tell them apart, and file times don't help either (both files are written all the time).
//
// The rule: the database is actually read. Every record of "accountUuid" in its .log (write batches) and .ldb
// (tables, snappy-compressed) files is found with its sequence number, and the one with the highest number is
// the value Chrome itself would return now (a deletion means signed out). An account links to:
//   1. a profile whose extension is signed in to it now; or
//   2. a signed-out profile whose last sign-in was this account (only while no profile is signed in to it).
// When several profiles qualify, the one Chrome used most recently (Local State active_time) wins, then the one
// whose extension storage was written last.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const { dataDirOf } = require('./stats');

const EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
const ACCOUNT_KEY = 'accountUuid';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A profile folder name: one folder directly under User Data ("Default", "Profile 6"), never a path.
const PROFILE_DIR_RE = /^(?!\.{1,2}$)[A-Za-z0-9 ._-]{1,64}$/;
const MAX_DB_FILE = 64 * 1024 * 1024; // bigger files are skipped rather than read into memory
const SNAPSHOT_EVERY = 5000; // answers within this reuse the last snapshot

function userDataDir(env = process.env) {
  return path.join(env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
}

// ---------- Local State ----------

// [{ dir, name, email, activeTime }], in Chrome's own profile order where it has one.
function parseLocalState(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return []; }
  const cache = raw && raw.profile && raw.profile.info_cache;
  if (!cache || typeof cache !== 'object') return [];
  const order = Array.isArray(raw.profile.profiles_order) ? raw.profile.profiles_order : [];
  const list = Object.entries(cache)
    .filter(([dir, v]) => PROFILE_DIR_RE.test(dir) && v && typeof v === 'object')
    .map(([dir, v]) => ({
      dir,
      name: (typeof v.name === 'string' && v.name.trim() ? v.name.trim() : dir).slice(0, 80),
      email: typeof v.user_name === 'string' ? v.user_name.slice(0, 120) : '',
      activeTime: Number.isFinite(v.active_time) ? v.active_time : 0,
    }));
  const rank = (d) => { const i = order.indexOf(d); return i < 0 ? order.length : i; };
  return list.sort((a, b) => rank(a.dir) - rank(b.dir) || a.dir.localeCompare(b.dir));
}

// ---------- LevelDB, read-only ----------

function varint(c) {
  let v = 0;
  let shift = 0;
  for (;;) {
    if (c.i >= c.b.length || shift > 63) throw new Error('bad varint');
    const byte = c.b[c.i++];
    v += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return v;
    shift += 7;
  }
}

// Snappy's raw format (LevelDB compresses table blocks with it): a length, then literals and back-references.
function unsnappy(src) {
  const c = { b: src, i: 0 };
  const len = varint(c);
  if (len > MAX_DB_FILE) throw new Error('block too big');
  const out = Buffer.alloc(len);
  let o = 0;
  while (c.i < src.length) {
    const tag = src[c.i++];
    const kind = tag & 3;
    if (kind === 0) {
      let n = tag >> 2;
      if (n >= 60) {
        const bytes = n - 59;
        n = 0;
        for (let k = 0; k < bytes; k++) n += src[c.i++] * 2 ** (8 * k);
      }
      n += 1;
      if (c.i + n > src.length || o + n > len) throw new Error('bad literal');
      src.copy(out, o, c.i, c.i + n);
      c.i += n;
      o += n;
      continue;
    }
    let n;
    let off;
    if (kind === 1) { n = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[c.i++]; } else if (kind === 2) { n = (tag >> 2) + 1; off = src.readUInt16LE(c.i); c.i += 2; } else { n = (tag >> 2) + 1; off = src.readUInt32LE(c.i); c.i += 4; }
    if (!off || off > o || o + n > len) throw new Error('bad copy');
    for (let k = 0; k < n; k++, o++) out[o] = out[o - off]; // may overlap itself, so byte by byte
  }
  if (o !== len) throw new Error('short block');
  return out;
}

// A table block's contents, or null for a compression this reader doesn't know (that block is skipped).
function tableBlock(buf, off, size) {
  if (off + size + 5 > buf.length) throw new Error('block outside the file');
  const data = buf.subarray(off, off + size);
  const type = buf[off + size];
  if (type === 0) return data;
  if (type === 1) return unsnappy(data);
  return null;
}

// Each entry of a block: keys are stored as "shared prefix + rest"; restart points at the end are not needed here.
function* blockEntries(block) {
  if (block.length < 4) return;
  const restarts = block.readUInt32LE(block.length - 4);
  const end = block.length - 4 - 4 * restarts;
  if (end < 0) return;
  const c = { b: block, i: 0 };
  let key = Buffer.alloc(0);
  while (c.i < end) {
    const shared = varint(c);
    const unshared = varint(c);
    const vlen = varint(c);
    if (shared > key.length || c.i + unshared + vlen > end) throw new Error('bad entry');
    key = Buffer.concat([key.subarray(0, shared), block.subarray(c.i, c.i + unshared)]);
    c.i += unshared;
    yield [key, block.subarray(c.i, c.i + vlen)];
    c.i += vlen;
  }
}

// Calls found(seq, deleted, value) for every record of `want` in a table (.ldb) file.
function scanTable(buf, want, found) {
  if (buf.length < 48) return;
  const foot = buf.subarray(buf.length - 48);
  if (foot.readUInt32LE(40) !== 0x8b80fb57 || foot.readUInt32LE(44) !== 0xdb477524) throw new Error('not a table');
  const c = { b: foot, i: 0 };
  varint(c); varint(c); // the metaindex block (filters): not needed
  const index = tableBlock(buf, varint(c), varint(c));
  if (!index) return;
  for (const [, handle] of blockEntries(index)) {
    const h = { b: handle, i: 0 };
    const data = tableBlock(buf, varint(h), varint(h));
    if (!data) continue;
    for (const [ikey, value] of blockEntries(data)) {
      // An internal key is the user key plus 8 bytes: (sequence << 8) | type, little-endian. Type 0 is a deletion.
      if (ikey.length !== want.length + 8 || !ikey.subarray(0, want.length).equals(want)) continue;
      const lo = ikey.readUInt32LE(want.length);
      const hi = ikey.readUInt32LE(want.length + 4);
      found((lo >>> 8) + hi * 2 ** 24, (lo & 0xff) === 0, value);
    }
  }
}

// The write-ahead log (.log): 32 KB blocks of records (7-byte header), which put together are write batches.
// A record cut short at the end is one Chrome is still writing; it is left for next time.
function scanLog(buf, want, found) {
  const BLOCK = 32768;
  let i = 0;
  let parts = null;
  const batch = (b) => {
    if (b.length < 12) return;
    const seq = b.readUInt32LE(0) + b.readUInt32LE(4) * 2 ** 32;
    const count = b.readUInt32LE(8);
    const c = { b, i: 12 };
    for (let n = 0; n < count && c.i < b.length; n++) {
      const type = b[c.i++];
      const klen = varint(c);
      const key = b.subarray(c.i, c.i + klen);
      c.i += klen;
      let value = null;
      if (type === 1) { const vlen = varint(c); value = b.subarray(c.i, c.i + vlen); c.i += vlen; } else if (type !== 0) return;
      if (key.equals(want)) found(seq + n, type === 0, value);
    }
  };
  while (i + 7 <= buf.length) {
    const left = BLOCK - (i % BLOCK);
    if (left < 7) { i += left; continue; } // block trailer padding
    const len = buf.readUInt16LE(i + 4);
    const type = buf[i + 6];
    const start = i + 7;
    if (start + len > buf.length) break;
    if (type < 1 || type > 4) { i += left; parts = null; continue; } // zeroed or unknown: skip the rest of the block
    const frag = buf.subarray(start, start + len);
    i = start + len;
    try {
      if (type === 1) { parts = null; batch(frag); } else if (type === 2) parts = [frag];
      else if (type === 3) { if (parts) parts.push(frag); } else if (parts) { parts.push(frag); batch(Buffer.concat(parts)); parts = null; }
    } catch { parts = null; /* a damaged batch: skip it */ }
  }
}

// The newest record of `key` across a LevelDB folder's files: { seq, deleted, value, last } or null.
// last: the newest value that wasn't a deletion (what it held before a sign-out, if LevelDB still has it).
async function readKey(dbDir, key) {
  const want = Buffer.from(key, 'utf8');
  let best = null;
  let last = null;
  let names;
  try { names = await fsp.readdir(dbDir); } catch { return null; }
  for (const n of names) {
    const isLog = /^\d+\.log$/.test(n);
    if (!isLog && !/^\d+\.(ldb|sst)$/.test(n)) continue;
    let buf;
    try {
      const file = path.join(dbDir, n);
      if ((await fsp.stat(file)).size > MAX_DB_FILE) continue;
      buf = await fsp.readFile(file); // Node opens files with shared read/write access, so Chrome keeps working
    } catch { continue; }
    const found = (seq, deleted, value) => {
      const v = deleted ? null : Buffer.from(value);
      if (!best || seq > best.seq) best = { seq, deleted, value: v };
      if (!deleted && (!last || seq > last.seq)) last = { seq, value: v };
    };
    try { if (isLog) scanLog(buf, want, found); else scanTable(buf, want, found); } catch { /* damaged or mid-compaction: other files may still have it */ }
  }
  return best ? { ...best, last: last ? last.value : null } : null;
}

// A stored chrome.storage value is JSON; a Claude account UUID is a JSON string.
function uuidOf(value) {
  if (!value) return null;
  try {
    const v = JSON.parse(value.toString('utf8'));
    return typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : null;
  } catch { return null; }
}

// ---------- matching ----------

// profiles: [{ dir, activeTime, writtenAt, uuid (signed in now), was (last signed in) }]. Returns the best one for uuid, or null.
function pickProfile(profiles, uuid) {
  if (!uuid) return null;
  const u = uuid.toLowerCase();
  const newest = (list) => list.sort((a, b) => (b.activeTime - a.activeTime) || (b.writtenAt - a.writtenAt))[0] || null;
  const now = newest(profiles.filter((p) => p.uuid === u));
  if (now) return { profile: now, how: 'signed-in' };
  const before = newest(profiles.filter((p) => !p.uuid && p.was === u));
  return before ? { profile: before, how: 'last-signed-in' } : null;
}

async function accountUuid(account) {
  const dir = dataDirOf(account);
  if (!dir) return null;
  try {
    const v = JSON.parse(await fsp.readFile(path.join(dir, 'config.json'), 'utf8')).lastKnownAccountUuid;
    return typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : null;
  } catch { return null; }
}

// ---------- chrome.exe ----------

function regDefault(key) {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', key, '/ve'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      const m = !err && /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(String(stdout));
      resolve(m ? m[1].replace(/%([^%]+)%/g, (all, v) => process.env[v] || all).replace(/^"|"$/g, '') : null);
    });
  });
}

const isChromeExe = (p) => typeof p === 'string' && path.isAbsolute(p) && path.basename(p).toLowerCase() === 'chrome.exe' && fs.existsSync(p);

// The registry's App Paths entry (what Windows' Run box uses), then the standard install folders.
async function findChromeExe(env = process.env) {
  const appPath = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe';
  for (const hive of ['HKCU', 'HKLM']) {
    const p = await regDefault(`${hive}\\${appPath}`);
    if (isChromeExe(p)) return p;
  }
  const tail = ['Google', 'Chrome', 'Application', 'chrome.exe'];
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.LOCALAPPDATA]) {
    if (!root) continue;
    const p = path.join(root, ...tail);
    if (isChromeExe(p)) return p;
  }
  return null;
}

// ---------- the collector ----------

function createChrome({ env = process.env } = {}) {
  const dbCache = new Map(); // profile dir -> { sig, uuid, was, writtenAt }
  let exe;
  let last = null;
  let lastAt = 0;
  let inflight = null;

  async function exePath() {
    if (exe === undefined || (exe && !fs.existsSync(exe))) exe = await findChromeExe(env);
    return exe;
  }

  async function profiles() {
    try { return parseLocalState(await fsp.readFile(path.join(userDataDir(env), 'Local State'), 'utf8')); } catch { return []; }
  }

  // What a profile's extension says, re-read only when its files changed.
  async function extensionState(dir) {
    const db = path.join(userDataDir(env), dir, 'Local Extension Settings', EXTENSION_ID);
    let sig = '';
    let writtenAt = 0;
    try {
      for (const n of (await fsp.readdir(db)).sort()) {
        if (!/\.(log|ldb|sst)$/.test(n)) continue;
        const st = await fsp.stat(path.join(db, n));
        sig += `${n}:${st.size}:${st.mtimeMs}|`;
        writtenAt = Math.max(writtenAt, st.mtimeMs);
      }
    } catch { return { uuid: null, was: null, writtenAt: 0 }; }
    const hit = dbCache.get(dir);
    if (hit && hit.sig === sig) return hit;
    const r = await readKey(db, ACCOUNT_KEY);
    const out = { sig, uuid: r && !r.deleted ? uuidOf(r.value) : null, was: r ? uuidOf(r.last) : null, writtenAt };
    dbCache.set(dir, out);
    return out;
  }

  async function build(accounts) {
    const [exeFound, list] = await Promise.all([exePath(), profiles()]);
    const found = await Promise.all(list.map(async (p) => ({ ...p, ...(await extensionState(p.dir)) })));
    for (const dir of dbCache.keys()) if (!list.some((p) => p.dir === dir)) dbCache.delete(dir);
    const byDir = new Map(list.map((p) => [p.dir, p]));
    const links = {};
    await Promise.all(accounts.map(async (a) => {
      const uuid = await accountUuid(a);
      const auto = pickProfile(found.map((p) => ({ ...p })), uuid);
      // A chosen profile that Chrome no longer has falls back to the automatic one.
      const chosen = a.chromeProfile && byDir.has(a.chromeProfile) ? a.chromeProfile : null;
      const dir = chosen || (auto ? auto.profile.dir : null);
      links[a.id] = {
        auto: auto ? { dir: auto.profile.dir, name: byDir.get(auto.profile.dir).name, how: auto.how } : null,
        chosen: a.chromeProfile || null,
        missing: Boolean(a.chromeProfile && !chosen),
        link: dir ? { dir, name: byDir.get(dir).name, manual: Boolean(chosen) } : null,
      };
    }));
    return { exe: exeFound, profiles: list.map(({ dir, name, email }) => ({ dir, name, email })), links };
  }

  // { exe, profiles: [{ dir, name, email }], links: { [accountId]: { auto, chosen, missing, link } } }.
  // fresh: skip the short reuse window (after an account's choice changed).
  function snapshot(accounts, { fresh = false } = {}) {
    if (!fresh && last && Date.now() - lastAt < SNAPSHOT_EVERY && !inflight) return Promise.resolve(last);
    if (inflight && !fresh) return inflight;
    const p = build(accounts).then((r) => { last = r; lastAt = Date.now(); return r; }).finally(() => { if (inflight === p) inflight = null; });
    inflight = p;
    return p;
  }

  // For validating a choice from the page: only a folder Local State lists is accepted.
  async function isProfile(dir) {
    return typeof dir === 'string' && PROFILE_DIR_RE.test(dir) && (await profiles()).some((p) => p.dir === dir);
  }

  return { snapshot, isProfile, exePath, cached: () => last };
}

module.exports = {
  createChrome, parseLocalState, readKey, scanLog, scanTable, unsnappy, uuidOf, pickProfile, findChromeExe, userDataDir,
  EXTENSION_ID, ACCOUNT_KEY, PROFILE_DIR_RE, UUID_RE,
};
