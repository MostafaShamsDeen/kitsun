
// ---------- search-specific additions (appended to the mc-needs harness base) ----------
// Launches are recorded, never run: each one "spawns" at once.
const launches = [];
cp.spawn = (cmd, args, opts) => {
  launches.push({ cmd, args, env: opts && opts.env });
  const child = new EventEmitter();
  child.unref = () => {};
  setImmediate(() => child.emit('spawn'));
  return child;
};
const shortcuts = {};
electron.globalShortcut.register = (accel, fn) => { shortcuts[accel] = fn; return true; };

// Sessions to find: titles, an earlier title, a summary, a wrap-up, a model, and a first prompt in a transcript.
writeSession('main', U(11), { title: 'Acme Spend', previousTitles: ['Company card spend tracker webapp'], shellFolders: ['D:\\Claud\\acme-spend'], postTurnSummary: { status_category: 'completed', status_detail: 'CSV export now matches the ledger' }, model: 'claude-opus-5-5', lastActivityAt: Date.now() - 2 * MIN });
writeSession('personal', U(12), { title: 'Teashop site', turnWrapUp: { description: 'Product page hero redone with the matcha origin story' }, model: 'claude-sonnet-4-5-20250929', lastActivityAt: Date.now() - 5 * MIN });
writeSession('personal', U(13), { title: 'Old backup notes', isArchived: true, lastActivityAt: Date.now() - 3 * 24 * 60 * MIN });
writeSession('studio', U(14), { title: 'Server hardening', lastActivityAt: Date.now() - 9 * MIN });
writeTranscript(U(12), [
  { type: 'user', isMeta: true, message: { content: '<system-reminder>ignore me</system-reminder>' }, timestamp: new Date().toISOString() },
  { type: 'user', message: { content: [{ type: 'text', text: 'Remake the Shopify theme for my friend\'s ceremonial grade tea brand' }] }, timestamp: new Date().toISOString() },
  { type: 'assistant', message: { stop_reason: 'end_turn', content: [] }, timestamp: new Date().toISOString() },
]);
const linkOf = (l) => l.args.find((a) => a.startsWith('claude://'));
const dirOf = (l) => (l.args.find((a) => a.startsWith('--user-data-dir=')) || '').slice('--user-data-dir='.length) || null;
const lastStatus = () => { const s = win.webContents.sent.filter(([c]) => c === 'status').pop(); return s ? s[1] : {}; };

(async () => {
  require(path.join(ROOT, 'main.js'));
  while (!win || !handlers['search:query']) await vsleep(100);
  win.show();
  await until('first sessions push', () => pushes().length > 0);
  await until('all docked', () => Object.values(lastStatus()).length === 3 && Object.values(lastStatus()).every((x) => x.status === 'docked'));
  const q = (text, sender = ev()) => handlers['search:query'](sender, text);

  // IPC guard and argument checks.
  assert.deepStrictEqual(await q('spend', { sender: {} }), [], 'other senders get nothing');
  assert.deepStrictEqual(await q(42), []);
  assert.deepStrictEqual(await q(null), []);
  assert.deepStrictEqual(await q('x'.repeat(201)), []);
  ok('search:query: guarded and validated');

  let r = await q('spend tracker');
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual(Object.keys(r[0]).sort(), ['accountId', 'archived', 'at', 'folder', 'sessionId', 'snippet', 'title']);
  assert.deepStrictEqual([r[0].accountId, r[0].sessionId, r[0].title, r[0].folder, r[0].snippet], ['main', `local_${U(11)}`, 'Acme Spend', 'acme-spend', 'Was “Company card spend tracker webapp”']);
  r = await q('LEDGER');
  assert.strictEqual(r[0].title, 'Acme Spend');
  assert(/ledger/.test(r[0].snippet), r[0].snippet);
  r = await q('matcha');
  assert.deepStrictEqual(r.map((x) => x.title), ['Teashop site'], 'found by its wrap-up');
  r = await q('sonnet 4.5');
  assert.deepStrictEqual(r.map((x) => x.title), ['Teashop site'], 'found by model name');
  r = await q('personal teashop');
  assert.deepStrictEqual(r.map((x) => [x.accountId, x.title]).sort(), [['personal', 'Teashop'], ['personal', 'Teashop site']], 'account name narrows');
  await vsleep(12000); // the index rebuilds at most every 10 s; the first prompt is read in the background
  r = await q('ceremonial tea');
  assert.deepStrictEqual(r.map((x) => x.title), ['Teashop site'], 'found by its first prompt');
  assert(/ceremonial/.test(r[0].snippet), r[0].snippet);
  r = await q('backup');
  assert.deepStrictEqual([r[0].title, r[0].archived], ['Old backup notes', true]);
  r = await q('');
  assert(r.length && r.every((x) => !x.archived), 'empty query: latest sessions, archived left out');
  ok('ranking: title, earlier title, summary, wrap-up, model, account, first prompt; archived flagged; empty = recent');

  // A new session shows up without a restart (the attention poll refreshes the index).
  writeSession('studio', U(15), { title: 'Storefront nightly job', lastActivityAt: Date.now() });
  await vsleep(12000);
  r = await q('storefront');
  assert.deepStrictEqual(r.map((x) => [x.accountId, x.title]), [['studio', 'Storefront nightly job']]);
  ok('index picks up new sessions');

  // Opening: validation.
  const open = (id, sid, sender = ev()) => handlers['search:open'](sender, id, sid);
  assert.deepStrictEqual(await open('personal', `local_${U(12)}`, { sender: {} }), { ok: false });
  assert.deepStrictEqual(await open('nobody', `local_${U(12)}`), { ok: false });
  assert.deepStrictEqual(await open('personal', 'local_../../x'), { ok: false });
  assert.deepStrictEqual(await open('personal', `local_${U(12)}&x=1`), { ok: false });
  assert.deepStrictEqual(await open('personal', 42), { ok: false });
  // A session of Personal asked for in Work: never sent to Work's copy.
  let res = await open('main', `local_${U(12)}`);
  assert.strictEqual(res.ok, false);
  assert(/isn't in Work/.test(res.error), res.error);
  assert.strictEqual(launches.length, 0, 'nothing launched for bad input');
  ok('search:open: guarded; ids checked; a session only opens in its own account');

  // A running extra account: its own --user-data-dir and the link; its tab shows.
  res = await open('personal', `local_${U(12)}`);
  assert.deepStrictEqual(res, { ok: true, opened: true });
  assert.strictEqual(launches.length, 1);
  let l = launches[0];
  assert(/claude-desktop\.exe$/.test(l.cmd));
  assert.strictEqual(linkOf(l), `claude://code/continue?session=local_${U(12)}`);
  assert.strictEqual(path.resolve(dirOf(l)), path.resolve(path.join(LOCAL, 'Claude-Profiles', 'personal')));
  assert(l.args.includes('--disable-direct-composition'));
  let ui = win.webContents.sent.filter(([c]) => c === 'ui').pop()[1];
  assert.deepStrictEqual([ui.panes[0], ui.home], ['personal', false]);
  ok('open in Personal: launched with its own data folder and the link; tab shown');

  // The main account: no --user-data-dir.
  res = await open('main', `local_${U(11)}`);
  assert.deepStrictEqual(res, { ok: true, opened: true });
  l = launches[1];
  assert.strictEqual(dirOf(l), null);
  assert.strictEqual(linkOf(l), `claude://code/continue?session=local_${U(11)}`);
  ok('open in Work (main): no --user-data-dir');

  // Archived: not sent (Claude would only show Code's home); the tab shows.
  res = await open('personal', `local_${U(13)}`);
  assert.deepStrictEqual(res, { ok: true, opened: false });
  assert.strictEqual(launches.length, 2);
  ui = win.webContents.sent.filter(([c]) => c === 'ui').pop()[1];
  assert.strictEqual(ui.panes[0], 'personal');
  ok('archived: only the tab is shown');

  // A stopped account: started once, with the link (showAccount must not launch a second copy).
  procs.delete(1003);
  await until('studio stopped', () => lastStatus().studio && lastStatus().studio.status === 'stopped');
  const before = launches.length;
  res = await open('studio', `local_${U(14)}`);
  assert.deepStrictEqual(res, { ok: true, opened: true });
  assert.strictEqual(launches.length, before + 1, 'launched once');
  assert.strictEqual(linkOf(launches[before]), `claude://code/continue?session=local_${U(14)}`);
  assert.strictEqual(path.resolve(dirOf(launches[before])), path.resolve(path.join(LOCAL, 'Claude-Profiles', 'studio')));
  const st = lastStatus().studio;
  assert.strictEqual(st.status, 'starting');
  assert.strictEqual(st.exit, null, 'a pending reopen is replaced');
  await vsleep(8000);
  assert.strictEqual(launches.length, before + 1, 'the reopen timer did not launch another copy');
  ok('stopped account: started once with the link, pending reopen cancelled');

  // Ctrl+Alt+K (registered while focused) and the tray's Search… open the switcher with the page focused.
  win.emit('focus');
  assert(shortcuts['Control+Alt+K'], 'Ctrl+Alt+K registered');
  let focused = 0;
  win.webContents.focus = () => { focused++; };
  const sent = () => win.webContents.sent.filter(([c]) => c === 'open-switcher').length;
  shortcuts['Control+Alt+K']();
  assert.deepStrictEqual([sent(), focused], [1, 1]);
  const item = tray.menu.find((m) => m.label === 'Search…');
  assert(item, 'tray menu has Search…');
  item.click();
  assert.deepStrictEqual([sent(), focused], [2, 2]);
  ok('Ctrl+Alt+K and the tray item open the switcher and give the page the keyboard');

  console.log('\nall passed');
  process.exit(0);
})().catch((err) => { console.error('FAILED:', err); process.exit(1); });
