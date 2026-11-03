
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

  console.log('\nall passed');
  process.exit(0);
})().catch((err) => { console.error('FAILED:', err); process.exit(1); });
