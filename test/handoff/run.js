// End-to-end test of lib/handoff.js on COPIES only: builds a fake data-dir tree under %TEMP%\mc-handoff\tree from one
// real session record and its transcript (read-only), runs continueSession against it and inspects the output.
const fs = require('fs'), fsp = fs.promises, path = require('path'), crypto = require('crypto'), assert = require('assert');
const H = require('D:/Claud/multi-claude/lib/handoff');
const { dataDirOf, sessionsOf } = require('D:/Claud/multi-claude/lib/stats');

const ROOT = path.join(process.env.TEMP, 'mc-handoff', 'tree');
const ACC_P = '512a5ff6-4cdb-45e7-ac48-5465ae391332', ORG_P = 'e9db3197-9bfe-467e-af87-e6be64a6099e';
const ACC_C = 'a2ba386d-0000-4000-8000-000000000001', ORG_C = '17852551-cde9-4464-a6d6-3da45b9133b0';
const SID = 'local_b1bac301-84aa-4320-863f-53ca7ae73a41', CLI = '9e5f3f44-2be5-4e1a-aba6-8093aeefe651';
const realProj = path.join(require('os').homedir(), '.claude', 'projects', 'C--Users-mosta-Documents-Claud');
const personalReal = dataDirOf({ id: 'personal', main: false });

const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
let pass = 0;
const ok = (name) => { pass++; console.log('ok', name); };

function build() {
  if (!ROOT.startsWith(process.env.TEMP)) throw new Error('not in TEMP');
  fs.rmSync(ROOT, { recursive: true, force: true });
  const P = path.join(ROOT, 'personal'), C = path.join(ROOT, 'studio'), code = path.join(ROOT, 'home', '.claude');
  w(path.join(P, 'config.json'), JSON.stringify({ lastKnownAccountUuid: ACC_P }));
  fs.mkdirSync(path.join(P, 'claude-code-sessions', ACC_P, ORG_P), { recursive: true });
  fs.copyFileSync(path.join(personalReal, 'claude-code-sessions', ACC_P, ORG_P, `${SID}.json`), path.join(P, 'claude-code-sessions', ACC_P, ORG_P, `${SID}.json`));
  w(path.join(C, 'config.json'), JSON.stringify({ lastKnownAccountUuid: ACC_C }));
  w(path.join(C, 'plan-usage-history.json'), JSON.stringify({ version: 1, samples: [{ t: 1, org: ORG_C, u: { fh: 1, sd: 2 } }] }));
  w(path.join(C, 'claude-code-sessions', ACC_C, ORG_C, 'local_00000000-0000-4000-8000-00000000abcd.json'), '{}');
  const proj = path.join(code, 'projects', 'C--Users-mosta-Documents-Claud');
  fs.mkdirSync(path.join(proj, CLI, 'subagents'), { recursive: true });
  fs.copyFileSync(path.join(realProj, `${CLI}.jsonl`), path.join(proj, `${CLI}.jsonl`));
  for (const n of fs.readdirSync(path.join(realProj, CLI, 'subagents'))) fs.copyFileSync(path.join(realProj, CLI, 'subagents', n), path.join(proj, CLI, 'subagents', n));
  return { P, C, code, proj };
}

function* walk(d) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const s = fs.lstatSync(p); yield `${p}:${s.size}`; if (s.isDirectory()) yield* walk(p); } }
const snapshot = () => JSON.stringify([...walk(ROOT)]);

(async () => {
  const t = build();
  const src = { name: 'Personal', dataDir: t.P, codeDir: t.code };
  const dst = { name: 'Studio', dataDir: t.C, codeDir: t.code };
  const srcRec = path.join(t.P, 'claude-code-sessions', ACC_P, ORG_P, `${SID}.json`);
  const srcTr = path.join(t.proj, `${CLI}.jsonl`);
  // A turn half written: the source ends mid-line.
  fs.appendFileSync(srcTr, '{"type":"assistant","half":');
  const before = { rec: hash(srcRec), tr: hash(srcTr), size: fs.statSync(srcTr).size };

  // 1. The happy path.
  const id1 = crypto.randomUUID();
  const t0 = Date.now();
  const r = await H.continueSession({ sessionId: SID, source: src, target: dst, newUuid: id1, now: 1700000000000 });
  console.log('took', Date.now() - t0, 'ms', r.ok ? r.sessionId : r.error);
  assert(r.ok, r.error);
  assert.strictEqual(r.sessionId, `local_${id1}`);
  assert.strictEqual(r.record, path.join(t.C, 'claude-code-sessions', ACC_C, ORG_C, `local_${id1}.json`));
  const rec = JSON.parse(fs.readFileSync(r.record, 'utf8'));
  const orig = JSON.parse(fs.readFileSync(srcRec, 'utf8'));
  console.log('new record:', JSON.stringify(rec));
  const want = ['cliSessionId', 'createdAt', 'cwd', 'isArchived', 'lastActivityAt', 'originCwd', 'sessionId', 'title'];
  if (orig.cliMcpAppServerNames && orig.cliMcpAppServerNames.length) want.push('cliMcpAppServerNames');
  if (orig.shellFolders && orig.shellFolders.length) want.push('shellFolders');
  assert.deepStrictEqual(Object.keys(rec).sort(), want.sort());
  assert.strictEqual(rec.cliSessionId, id1);
  assert.strictEqual(rec.cwd, orig.cwd);
  assert.strictEqual(rec.title, orig.title);
  for (const k of ['bridgeSessionIds', 'remoteMcpServersConfig', 'sessionPermissionUpdates', 'permissionMode', 'model', 'chromePermissionMode', 'spawnSeed']) assert(!(k in rec), k);
  ok('record is the small import-style one, for the target account and org');
  const copy = fs.readFileSync(r.transcript, 'utf8');
  const srcText = fs.readFileSync(srcTr, 'utf8');
  const whole = srcText.slice(0, srcText.lastIndexOf('\n') + 1);
  assert(copy.startsWith(whole), 'copy starts with the source up to its last whole line');
  const extra = copy.slice(whole.length).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  console.log('appended:', JSON.stringify(extra));
  assert(extra.length >= 1 && extra.every((o) => (o.type === 'bridge-session' && o.bridgeSessionId === '') || o.type === 'worktree-state'));
  assert(!copy.includes('"half":'), 'half line cut');
  ok('transcript copied, half line cut, bridge pointers cleared');
  // The last bridge line for each session id in the copy now has an empty bridge id (what Claude reads).
  const lastBridge = new Map();
  for (const l of copy.split('\n')) if (l.includes('"type":"bridge-session"')) { const o = JSON.parse(l); lastBridge.set(o.sessionId, o.bridgeSessionId); }
  assert(lastBridge.size && [...lastBridge.values()].every((v) => v === ''));
  ok('no inherited bridge stays live');
  const subs = fs.readdirSync(path.join(t.proj, id1, 'subagents'));
  assert.deepStrictEqual(subs.sort(), fs.readdirSync(path.join(t.proj, CLI, 'subagents')).sort());
  ok(`subagents copied (${subs.length} files)`);
  assert.strictEqual(hash(srcRec), before.rec);
  assert.strictEqual(hash(srcTr), before.tr);
  assert.strictEqual(fs.statSync(srcTr).size, before.size);
  ok('source record and transcript unchanged');

  // 2. Refusals that must write nothing.
  const refuse = async (name, args, re) => {
    const s0 = snapshot();
    const x = await H.continueSession({ sessionId: SID, source: src, target: dst, newUuid: crypto.randomUUID(), ...args });
    assert(!x.ok && re.test(x.error), `${name}: ${x.error}`);
    assert.strictEqual(snapshot(), s0, `${name} wrote something`);
    ok(`refused: ${name} (${x.error})`);
  };
  await refuse('other code folder', { target: { ...dst, codeDir: path.join(ROOT, 'other') } }, /different Claude Code folders/);
  await refuse('same account', { target: { ...dst, dataDir: t.P } }, /same Claude account/);
  await refuse('unknown session', { sessionId: 'local_00000000-1111-4000-8000-000000000000' }, /isn't in Personal/);
  await refuse('bad id', { sessionId: '../x' }, /isn't a Claude Code session/);
  await refuse('bad new id', { newUuid: 'nope' }, /new session id/);
  await refuse('target never opened', { target: { ...dst, dataDir: null } }, /hasn't been opened/);
  fs.writeFileSync(path.join(t.C, 'config.json'), '{}');
  await refuse('target signed out', {}, /isn't signed in/);
  fs.writeFileSync(path.join(t.C, 'config.json'), JSON.stringify({ lastKnownAccountUuid: ACC_C }));
  await refuse('existing destination', { newUuid: id1 }, /already exists/);
  const wt = JSON.parse(fs.readFileSync(srcRec, 'utf8'));
  fs.renameSync(srcRec, `${srcRec}.bak`);
  fs.writeFileSync(srcRec, JSON.stringify({ ...wt, worktreePath: 'D:\\x\\.claude\\worktrees\\y' }));
  await refuse('worktree session', {}, /Git worktree/);
  fs.rmSync(srcRec);
  fs.renameSync(`${srcRec}.bak`, srcRec);
  fs.renameSync(srcTr, `${srcTr}.bak`);
  await refuse('no transcript', {}, /wasn't found/);
  fs.renameSync(`${srcTr}.bak`, srcTr);
  assert.strictEqual(hash(srcRec), before.rec);

  // 3. A failure after copying removes what this call made, and only that.
  const s0 = snapshot();
  const realWrite = fsp.writeFile;
  fsp.writeFile = async (f, ...rest) => { if (String(f).includes('claude-code-sessions')) throw new Error('disk full (test)'); return realWrite(f, ...rest); };
  const id3 = crypto.randomUUID();
  const x3 = await H.continueSession({ sessionId: SID, source: src, target: dst, newUuid: id3 });
  fsp.writeFile = realWrite;
  assert(!x3.ok && /disk full/.test(x3.error), x3.error);
  assert.strictEqual(snapshot(), s0);
  assert(!fs.existsSync(path.join(t.proj, `${id3}.jsonl`)) && !fs.existsSync(path.join(t.proj, id3)));
  ok('rolled back after a failed record write');

  // 4. Org choice: the plan-usage org only if this account has that folder with a session in it (samples carry no
  // account and outlive a sign-in); else the folder with the newest session; never a folder made up.
  const accDir = path.join(t.C, 'claude-code-sessions', ACC_C);
  const NEW_ORG = 'cf4c4732-fd3b-4f8a-a5b6-0871950a2f22';
  const OLD_ORG = '58731921-fa11-4437-a08e-a05d0f325414';
  const planSays = (org) => fs.writeFileSync(path.join(t.C, 'plan-usage-history.json'), JSON.stringify({ samples: [{ t: 5, org }, { t: 2, org: ORG_C }] }));
  planSays(NEW_ORG); // an org of some earlier sign-in: no folder here
  const x4 = await H.continueSession({ sessionId: SID, source: src, target: dst, newUuid: crypto.randomUUID() });
  assert(x4.ok && x4.record.includes(ORG_C), x4.error || x4.record);
  assert(!fs.existsSync(path.join(accDir, NEW_ORG)), 'no org folder is made');
  ok('plan-usage org without a folder here: the org with sessions is used, nothing made');
  fs.mkdirSync(path.join(accDir, NEW_ORG));
  assert.strictEqual(H.pickOrg(accDir, NEW_ORG).org, ORG_C);
  ok('plan-usage org whose folder has no session: not trusted');
  // An older org with sessions, named by the plan usage, wins over the newest session file.
  w(path.join(accDir, OLD_ORG, 'local_00000000-0000-4000-8000-00000000aaaa.json'), '{}');
  fs.utimesSync(path.join(accDir, OLD_ORG, 'local_00000000-0000-4000-8000-00000000aaaa.json'), new Date(1000), new Date(1000));
  assert.strictEqual(H.pickOrg(accDir, OLD_ORG).org, OLD_ORG);
  assert.strictEqual(H.pickOrg(accDir, OLD_ORG.toUpperCase()).org, OLD_ORG);
  ok('plan-usage org with sessions here: used');
  fs.rmSync(path.join(t.C, 'plan-usage-history.json'));
  const pick = H.pickOrg(accDir, null);
  console.log('without plan usage:', pick);
  assert(pick && pick.org !== OLD_ORG && pick.exists);
  ok('org from the newest session file without plan usage');
  assert.strictEqual(H.pickOrg(path.join(ROOT, 'nowhere'), null), null);
  assert.strictEqual(H.pickOrg(path.join(ROOT, 'nowhere'), NEW_ORG), null);
  ok('no org folder: none, even with plan usage');
  // An account with no org folder at all is refused, and nothing is made.
  const C2 = path.join(ROOT, 'studio2');
  w(path.join(C2, 'config.json'), JSON.stringify({ lastKnownAccountUuid: ACC_C }));
  w(path.join(C2, 'plan-usage-history.json'), JSON.stringify({ samples: [{ t: 5, org: ORG_C }] }));
  const x4b = await H.continueSession({ sessionId: SID, source: src, target: { name: 'Studio', dataDir: C2, codeDir: t.code }, newUuid: crypto.randomUUID() });
  assert(!x4b.ok && x4b.error === 'Open the Code tab in Studio once, then try again.', x4b.error);
  assert(!fs.existsSync(path.join(C2, 'claude-code-sessions')));
  ok('refused: target account has no org folder (' + x4b.error + ')');
  // Two org folders, neither with a session: can't tell.
  fs.mkdirSync(path.join(C2, 'claude-code-sessions', ACC_C, NEW_ORG), { recursive: true });
  fs.mkdirSync(path.join(C2, 'claude-code-sessions', ACC_C, OLD_ORG), { recursive: true });
  assert.strictEqual(H.pickOrg(path.join(C2, 'claude-code-sessions', ACC_C), ORG_C), null);
  fs.rmSync(path.join(C2, 'claude-code-sessions', ACC_C, OLD_ORG), { recursive: true });
  assert.strictEqual(H.pickOrg(path.join(C2, 'claude-code-sessions', ACC_C), ORG_C).org, NEW_ORG);
  ok('several empty org folders: none; a single one: that one');

  // 4b. Mid-turn: refused unless the caller knows no Claude Code process resumes it (cut off by a quit or crash).
  const midTr = path.join(t.proj, `${CLI}.jsonl`);
  const keep = fs.readFileSync(midTr);
  fs.appendFileSync(midTr, '\n' + JSON.stringify({ type: 'assistant', sessionId: CLI, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }) + '\n');
  const s5 = snapshot();
  for (const [label, cliRunning] of [['no check', undefined], ['running', async () => true], ["can't tell", async () => null], ['check throws', async () => { throw new Error('x'); }]]) {
    const m = await H.continueSession({ sessionId: SID, source: src, target: dst, newUuid: crypto.randomUUID(), cliRunning });
    assert(!m.ok && /middle of a turn in Personal/.test(m.error), label + ': ' + m.error);
    assert.strictEqual(snapshot(), s5, label + ': nothing written');
  }
  ok('refused: mid-turn (no check, running, unknown)');
  let asked = null;
  const m2 = await H.continueSession({ sessionId: SID, source: src, target: dst, newUuid: crypto.randomUUID(), cliRunning: async (c) => { asked = c; return false; } });
  assert(m2.ok && asked === CLI, m2.error);
  ok('mid-turn transcript nothing resumes (cut off): copied');
  // A pending permission prompt ends the transcript on the tool_use too; a finished turn is fine without a check.
  fs.writeFileSync(midTr, keep);
  fs.appendFileSync(midTr, '\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }) + '\n');
  const m3 = await H.continueSession({ sessionId: SID, source: src, target: dst, newUuid: crypto.randomUUID() });
  assert(!m3.ok && /middle of a turn/.test(m3.error));
  fs.writeFileSync(midTr, keep);
  ok('refused: tool result without a reply yet');

  // 5. As main reads it (lib/stats.js): the new session is listed in the target.
  const list = await sessionsOf(t.C);
  const mine = list.find((s) => s.sessionId === `local_${id1}`);
  assert(mine && mine.cliSessionId === id1 && mine.title === orig.title, 'listed by sessionsOf');
  ok('lib/stats.js lists the new session in the target');
  console.log(`\n${pass} checks passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
