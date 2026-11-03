// Unit tests for lib/attention.js's pure parts, plus replays of real (read-only) data.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const at = require('D:/Claud/multi-claude/lib/attention.js');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('ok', name); };
const NOW = Date.now();
const MIN = 60000, HOUR = 60 * MIN;

// ---------- log lines ----------
const stamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const L = (msg, ago = 0) => `${stamp(new Date(NOW - ago))} [info] ${msg}`;
const R1 = '46386b2d-5da4-4125-aba4-c5f74072621d', R2 = '10d6d767-f9ad-4aab-aa58-429f45160807', R3 = '5b5eb67d-a016-481e-a098-078d1a26240d';
const S1 = 'local_35b59085-e03e-4396-bbc5-3bd193fdb9fe', S2 = 'local_d20cee1f-b461-4e20-849b-ebc5d49427e7';

t('prompts: asked, answered, aborted, restart', () => {
  const p = new Map();
  at.applyLogLines([
    L(`Emitted tool permission request ${R1} for Bash in session ${S1}`, 5 * MIN),
    L(`Emitted tool permission request ${R2} for AskUserQuestion in session ${S2}`, 4 * MIN),
    L(`Emitted tool permission request ${R3} for mcp__claude-in-chrome__navigate in session ${S1}`, 3 * MIN),
    'garbage line', '  at continuation of a stack',
  ], p);
  assert.deepStrictEqual([...p.keys()].sort(), [R1, R2, R3].sort());
  assert.strictEqual(p.get(R3).tool, 'mcp__claude-in-chrome__navigate');
  assert.strictEqual(p.get(R2).sessionId, S2);
  assert.ok(Math.abs(p.get(R1).at - (NOW - 5 * MIN)) < 1500);
  at.applyLogLines([L(`LocalSessions.respondToToolPermission: requestId=${R1}, decision=once, hasUpdatedInput=true`)], p);
  at.applyLogLines([L(`Received permission response for ${R1}: once (tool: Bash)`)], p);
  at.applyLogLines([L(`Permission request ${R3} for mcp__claude-in-chrome__navigate aborted`)], p);
  assert.deepStrictEqual([...p.keys()], [R2]);
  at.applyLogLines([L('Starting app {')], p);
  assert.strictEqual(p.size, 0);
  at.applyLogLines([L(`Emitted tool permission request ${R1} for Bash in session ${S1}`), L(`No pending permission request found for ${R1}`)], p);
  assert.strictEqual(p.size, 0);
});

t('prompt text', () => {
  assert.deepStrictEqual(at.promptText('AskUserQuestion'), { kind: 'question', detail: 'Has a question for you' });
  assert.strictEqual(at.promptText('ExitPlanMode').kind, 'plan');
  assert.strictEqual(at.promptText('mcp__claude-in-chrome__navigate').detail, 'Wants to use claude-in-chrome · navigate');
  assert.strictEqual(at.promptText('Bash').detail, 'Wants to use Bash');
});

t('log follower: appended lines only, cut last line, rotation', async () => {});
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-att-'));
  const f = path.join(dir, 'main.log');
  const f2 = path.join(dir, 'main-rotated.log');
  fs.writeFileSync(f, 'x'.repeat(3000) + '\n' + L(`Emitted tool permission request ${R1} for Bash in session ${S1}`) + '\n' + L(`Emitted tool permission request ${R2} for Bash in sess`));
  const fol = at.createLogFollower();
  let p = await fol.read(f);
  assert.deepStrictEqual([...p.keys()], [R1], 'half-written line is not read yet');
  fs.appendFileSync(f, `ion ${S2}\n`);
  p = await fol.read(f);
  assert.deepStrictEqual([...p.keys()].sort(), [R1, R2].sort(), 'finished line is read');
  fs.appendFileSync(f, L(`Received permission response for ${R1}: once (tool: Bash)`) + '\n');
  p = await fol.read(f);
  assert.deepStrictEqual([...p.keys()], [R2]);
  // Rotation: main.log is replaced by a smaller, new file.
  fs.writeFileSync(f, L('Starting app {') + '\n');
  p = await fol.read(f);
  assert.strictEqual(p.size, 0);
  // Another file (e.g. a different candidate wins) starts over.
  fs.writeFileSync(f2, L(`Emitted tool permission request ${R3} for Bash in session ${S1}`) + '\n');
  p = await fol.read(f2);
  assert.deepStrictEqual([...p.keys()], [R3]);
  p = await fol.read(null);
  assert.strictEqual(p.size, 0);
  // A missing file keeps what it had.
  fs.writeFileSync(f2, L(`Emitted tool permission request ${R3} for Bash in session ${S1}`) + '\n');
  await fol.read(f2);
  p = await fol.read(path.join(dir, 'gone.log'));
  assert.strictEqual(p.size, 1);
  fs.rmSync(dir, { recursive: true, force: true });
  passed++; console.log('ok log follower (async)');

  // Real Personal log, read-only: replay the whole file, then compare with what the incremental reader says.
  const real = path.join(process.env.LOCALAPPDATA, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Local', 'Claude-Profiles', 'personal', 'logs', 'main.log');
  if (fs.existsSync(real)) {
    const all = at.applyLogLines(fs.readFileSync(real, 'utf8').split(/\r?\n/), new Map());
    const inc = await at.createLogFollower().read(real);
    console.log('   real Personal log: pending now', [...all.values()], 'incremental agrees:', all.size === inc.size);
    assert.strictEqual(all.size, inc.size);
    passed++;
  }
  finish();
})();

// ---------- transcript tails ----------
const J = (o) => JSON.stringify(o);
const asst = (stop, blocks = [{ type: 'text', text: 'hi' }]) => J({ type: 'assistant', timestamp: 'x', message: { stop_reason: stop, content: blocks } });
const user = (content, extra = {}) => J({ type: 'user', timestamp: 'x', message: { content }, ...extra });

t('turn state from the transcript tail', () => {
  assert.strictEqual(at.turnFromTail([asst('end_turn'), J({ type: 'system', subtype: 'stop_hook_summary' }), J({ type: 'last-prompt' })].join('\n')), 'done');
  assert.strictEqual(at.turnFromTail([asst('end_turn'), J({ type: 'cost-state' })].join('\n')), 'done');
  assert.strictEqual(at.turnFromTail([asst('end_turn'), user('next please')].join('\n')), 'mid');
  assert.strictEqual(at.turnFromTail([user('go'), asst('tool_use', [{ type: 'tool_use', name: 'Bash' }])].join('\n')), 'mid');
  assert.strictEqual(at.turnFromTail([asst('tool_use'), user([{ type: 'tool_result', content: 'ok' }]), J({ type: 'api-request' })].join('\n')), 'mid');
  assert.strictEqual(at.turnFromTail([asst('tool_use'), user([{ type: 'text', text: '[Request interrupted by user for tool use]' }])].join('\n')), 'done');
  assert.strictEqual(at.turnFromTail([asst('end_turn'), user('<local-command-stdout>Set model</local-command-stdout>'), user('caveat', { isMeta: true })].join('\n')), 'done');
  assert.strictEqual(at.turnFromTail(['{"type":"assistant","cut', asst('end_turn')].join('\n')), 'done');
  assert.strictEqual(at.turnFromTail('{"type":"user","message":{"content":"a very long line that was cut'), null);
  assert.strictEqual(at.turnFromTail([asst('end_turn'), J({ ...JSON.parse(asst('tool_use')), isSidechain: true })].join('\n')), 'done');
});

// ---------- classify ----------
const base = (o = {}) => ({
  sessionId: 'local_a', cliSessionId: 'c', title: 'T', archived: false, turns: 3, focusedAt: NOW - 2 * HOUR, turnEdgeAt: NOW - HOUR,
  userFrameAt: NOW - HOUR - MIN, awaitingAtQuit: 0, summaryCategory: 'completed', needsAction: null, summaryFor: 'u1', lastAssistantUuid: 'u1',
  wrapUp: 'Did the thing', summary: null, scheduled: false, ...o,
});

t('classify: waiting by prompt outranks everything', () => {
  const c = at.classify(base(), { prompt: { id: R1, tool: 'Bash', at: NOW - MIN }, turn: { state: 'mid', at: NOW }, running: true, now: NOW });
  assert.deepStrictEqual(c, { state: 'waiting', kind: 'permission', detail: 'Wants to use Bash', at: NOW - MIN, key: `p:${R1}` });
  assert.strictEqual(at.classify(base({ archived: true }), { prompt: { id: R1, tool: 'Bash', at: NOW } }), null);
});
t('classify: working only when running and recently written', () => {
  assert.strictEqual(at.classify(base(), { turn: { state: 'mid', at: NOW - 2 * MIN }, running: true, now: NOW }).state, 'working');
  assert.strictEqual(at.classify(base(), { turn: { state: 'mid', at: NOW - 20 * MIN }, running: true, now: NOW }), null, 'stale mid-turn: cut off, not finished');
  assert.strictEqual(at.classify(base(), { turn: { state: 'mid', at: NOW - 2 * MIN }, running: false, now: NOW }), null);
  assert.strictEqual(at.classify(base({ awaitingAtQuit: NOW - MIN }), { turn: { state: 'mid', at: NOW - 2 * MIN }, running: true, now: NOW }).kind, 'quit');
});
t('classify: waiting when it quit with a prompt pending', () => {
  const c = at.classify(base({ awaitingAtQuit: NOW - 3 * HOUR }), { now: NOW });
  assert.strictEqual(c.state, 'waiting'); assert.strictEqual(c.kind, 'quit');
  assert.strictEqual(at.classify(base({ awaitingAtQuit: NOW - 30 * HOUR, turnEdgeAt: NOW - 30 * HOUR }), { now: NOW }), null);
});
t('classify: waiting by summary, until looked at', () => {
  const s = base({ summaryCategory: 'blocked', needsAction: 'Shall I reboot now?' });
  assert.deepStrictEqual(at.classify(s, { turn: { state: 'done', at: NOW - HOUR }, now: NOW }), { state: 'waiting', kind: 'input', detail: 'Shall I reboot now?', at: NOW - HOUR, key: `s:${NOW - HOUR}` });
  assert.strictEqual(at.classify({ ...s, summaryCategory: 'need_input' }, { now: NOW }).state, 'waiting');
  assert.strictEqual(at.classify({ ...s, focusedAt: NOW - 10 * MIN }, { now: NOW }), null, 'focused in Claude after it asked');
  assert.strictEqual(at.classify(s, { seenEdge: NOW - HOUR, now: NOW }), null, 'its account was on screen');
  assert.strictEqual(at.classify({ ...s, summaryFor: 'old' }, { now: NOW }).state, 'unseen', 'summary of an older turn');
  assert.strictEqual(at.classify({ ...s, summaryCategory: 'failed' }, { now: NOW }).state, 'waiting');
  assert.strictEqual(at.classify({ ...s, summaryCategory: 'failed', needsAction: null }, { now: NOW }).state, 'unseen');
  assert.strictEqual(at.classify({ ...s, turnEdgeAt: NOW - 25 * HOUR }, { now: NOW }), null, 'older than a day');
  assert.strictEqual(at.classify({ ...s, scheduled: true }, { now: NOW }).state, 'waiting', 'a blocked routine run still needs the person');
});
t('classify: done-unseen', () => {
  const c = at.classify(base(), { turn: { state: 'done', at: NOW - HOUR }, now: NOW });
  assert.deepStrictEqual(c, { state: 'unseen', kind: 'done', detail: 'Did the thing', at: NOW - HOUR, key: `d:${NOW - HOUR}` });
  assert.strictEqual(at.classify(base({ focusedAt: NOW - 5 * MIN }), { now: NOW }), null);
  assert.strictEqual(at.classify(base({ scheduled: true }), { now: NOW }), null);
  assert.strictEqual(at.classify(base({ turns: 0, lastAssistantUuid: null, summaryCategory: null, wrapUp: null }), { now: NOW }), null, 'never finished a turn');
  assert.strictEqual(at.classify(base(), { seenEdge: NOW - 2 * HOUR, now: NOW }).state, 'unseen', 'seen an older turn only');
  assert.strictEqual(at.classify(base({ turnEdgeAt: 0 }), { now: NOW }), null);
});

// ---------- usage and limits ----------
t('usage: a window past its length has reset', () => {
  assert.deepStrictEqual(at.usageOf({ asOf: NOW - HOUR, fiveHour: 64, weekly: 71 }, NOW), { fiveHour: 64, weekly: 71, asOf: NOW - HOUR });
  assert.strictEqual(at.usageOf({ asOf: NOW - 6 * HOUR, fiveHour: 64, weekly: 71 }, NOW).fiveHour, 0);
  assert.strictEqual(at.usageOf({ asOf: NOW - 8 * 24 * HOUR, fiveHour: 64, weekly: 71 }, NOW).weekly, 0);
  assert.strictEqual(at.usageOf(null), null);
});
// A growing history: samples 15 minutes apart (or `gap`), each "written" a minute before `now`.
function series() {
  const h = [];
  return (fh, sd, gap = 15 * MIN) => {
    const t = h.length ? h[h.length - 1].t + gap : NOW - 24 * HOUR;
    h.push({ t, fh, sd });
    return { plan: { history: h.slice() }, now: t + MIN };
  };
}
t('limits: high once per window, reset, weekly', () => {
  const mem = {};
  const add = series();
  add(40, 50);
  let x = add(70, 50);
  assert.deepStrictEqual(at.limitEvents(mem, x.plan, x.now), [], 'first call: newest only, under 90');
  x = add(91, 50);
  assert.deepStrictEqual(at.limitEvents(mem, x.plan, x.now), [{ type: 'high', pct: 91 }]);
  x = add(95, 50);
  assert.deepStrictEqual(at.limitEvents(mem, x.plan, x.now), [], 'once per window');
  assert.deepStrictEqual(at.limitEvents(mem, x.plan, x.now), [], 'no new sample');
  x = add(0, 50);
  assert.deepStrictEqual(at.limitEvents(mem, x.plan, x.now), [{ type: 'reset', pct: 0 }]);
  x = add(92, 50);
  assert.deepStrictEqual(at.limitEvents(mem, x.plan, x.now), [{ type: 'high', pct: 92 }], 'a new window can alert again');
  x = add(93, 90);
  assert.deepStrictEqual(at.limitEvents(mem, x.plan, x.now), [{ type: 'weekly', pct: 90 }]);
  x = add(93, 95);
  assert.deepStrictEqual(at.limitEvents(mem, x.plan, x.now), []);
  // A dip that isn't a reset: 60 -> 30, and 49 -> 3 (it never got to 50).
  const m2 = {};
  const add2 = series();
  x = add2(60, 1); at.limitEvents(m2, x.plan, x.now);
  x = add2(30, 1); assert.deepStrictEqual(at.limitEvents(m2, x.plan, x.now), []);
  x = add2(49, 1); at.limitEvents(m2, x.plan, x.now);
  x = add2(3, 1); assert.deepStrictEqual(at.limitEvents(m2, x.plan, x.now), []);
  // At startup: a fresh 92% is said once; an old one isn't.
  x = series()(92, 1);
  assert.deepStrictEqual(at.limitEvents({}, x.plan, x.now), [{ type: 'high', pct: 92 }]);
  assert.deepStrictEqual(at.limitEvents({}, x.plan, x.now + HOUR), []);
  // Catching up on several samples at once (e.g. after sleep): the stale ones say nothing, a fresh one does.
  const m3 = {};
  const add3 = series();
  x = add3(10, 1); at.limitEvents(m3, x.plan, x.now);
  add3(95, 1, HOUR); add3(0, 1, HOUR); x = add3(60, 1, HOUR);
  assert.deepStrictEqual(at.limitEvents(m3, x.plan, x.now), []);
  x = add3(97, 1);
  assert.deepStrictEqual(at.limitEvents(m3, x.plan, x.now), [{ type: 'high', pct: 97 }]);
});

// Real Work history, read-only: replay sample by sample, as if each one had just been written.
t('limits: real Work history replay', () => {
  const file = path.join(process.env.LOCALAPPDATA, 'Claude-Data', 'claude_pzs8sxrjxfjjc', 'plan-usage-history.json');
  if (!fs.existsSync(file)) return;
  const samples = JSON.parse(fs.readFileSync(file, 'utf8')).samples.filter((s) => s && s.u).sort((a, b) => a.t - b.t);
  const org = samples[samples.length - 1].org;
  const h = samples.filter((s) => s.org === org).map((s) => ({ t: s.t, fh: Number(s.u.fh) || 0, sd: Number(s.u.sd) || 0 }));
  const mem = {};
  const said = [];
  for (let n = 1; n <= h.length; n++) {
    const now = h[n - 1].t + MIN;
    for (const e of at.limitEvents(mem, { history: h.slice(0, n) }, now)) said.push(`${new Date(h[n - 1].t).toLocaleString()} ${e.type} ${e.pct}%`);
  }
  console.log('   ', said.slice(-8).join('\n    '));
  assert.ok(said.some((s) => s.includes('reset')), 'today\'s 96% -> 0% shows as a reset');
});

function finish() { console.log(`\n${passed} passed`); }

t('classify: a prompt older than a finished turn is gone', () => {
  const p = { id: R1, tool: 'Bash', at: NOW - 10 * MIN };
  assert.strictEqual(at.classify(base({ focusedAt: NOW }), { prompt: p, turn: { state: 'done', at: NOW - MIN }, now: NOW }), null);
  assert.strictEqual(at.classify(base(), { prompt: p, turn: { state: 'mid', at: NOW - 9 * MIN }, now: NOW }).state, 'waiting');
  assert.strictEqual(at.classify(base(), { prompt: p, turn: { state: 'done', at: NOW - 11 * MIN }, now: NOW }).state, 'waiting');
});
