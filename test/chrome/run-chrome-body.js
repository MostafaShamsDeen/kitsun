// ---------- Chrome-specific additions (appended to the mc-needs/mc-search harness base) ----------
// Chrome's files are fakes in the temp LOCALAPPDATA; chrome.exe is an empty file found through a mocked registry.
const launches = [];
cp.spawn = (cmd, args, opts) => {
  launches.push({ cmd, args, env: opts && opts.env, opts });
  const child = new EventEmitter();
  child.unref = () => {};
  setImmediate(() => child.emit('spawn'));
  return child;
};
process.env.CLAUDECODE = '1'; // must not reach Chrome
for (const k of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) process.env[k] = path.join(tmp, 'pf-' + k.length);
const chromeExe = path.join(tmp, 'Google Chrome', 'chrome.exe');
fs.mkdirSync(path.dirname(chromeExe), { recursive: true });
fs.writeFileSync(chromeExe, '');
const baseExec = cp.execFile;
cp.execFile = (cmd, args, opts, cb) => {
  if (cmd === 'reg.exe') {
    return setImmediate(() => (args[1].startsWith('HKLM') ? cb(null, `\r\n${args[1]}\r\n    (Default)    REG_SZ    ${chromeExe}\r\n`) : cb(new Error('not found'), '')));
  }
  return baseExec(cmd, args, opts, cb);
};

// LevelDB log files, as Chrome writes them.
function vint(n) { const o = []; while (n >= 128) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); }
function batch(seq, ops) {
  const h = Buffer.alloc(12); h.writeUInt32LE(seq, 0); h.writeUInt32LE(ops.length, 8);
  return Buffer.concat([h, ...ops.flatMap(([t, k, v]) => [Buffer.from([t]), vint(Buffer.byteLength(k)), Buffer.from(k), ...(t === 1 ? [vint(Buffer.byteLength(v)), Buffer.from(v)] : [])])]);
}
function logRecords(batches) {
  return Buffer.concat(batches.map((b) => { const h = Buffer.alloc(7); h.writeUInt16LE(b.length, 4); h[6] = 1; return Buffer.concat([h, b]); }));
}
const UD = path.join(LOCAL, 'Google', 'Chrome', 'User Data');
const uuidOf = { main: '438f5f8e-9c89-4d6b-a11e-d87f5f0179bc', personal: '512a5ff6-4cdb-45e7-ac48-5465ae391332', studio: '98117410-4545-4247-a9dd-19201f55b931' };
for (const id of Object.keys(uuidOf)) fs.writeFileSync(path.join(dataDir(id), 'config.json'), JSON.stringify({ lastKnownAccountUuid: uuidOf[id] }));
const extDb = (p) => path.join(UD, p, 'Local Extension Settings', 'fcoeoabgfenejglbffodgkkbkcdhcgfn');
const setDb = (p, batches) => { fs.mkdirSync(extDb(p), { recursive: true }); fs.writeFileSync(path.join(extDb(p), '000003.log'), logRecords(batches)); };
const localState = { profile: { profiles_order: ['Default', 'Profile 4', 'Profile 6'], info_cache: {
  'Default': { name: 'Private', user_name: 'me@example.com', active_time: 300 },
  'Profile 4': { name: 'Dev (Agency)', user_name: 'dev@example.com', active_time: 100 },
  'Profile 6': { name: 'Studio & Labs', user_name: 'labs@example.com', active_time: 200 },
} } };
const writeLocalState = () => { fs.mkdirSync(UD, { recursive: true }); fs.writeFileSync(path.join(UD, 'Local State'), JSON.stringify(localState)); };
writeLocalState();
const J = JSON.stringify;
setDb('Default', [batch(5, [[1, 'accountUuid', J(uuidOf.personal)]]), batch(9, [[1, 'tabGroups', '{}']])]);
// Profile 4: signed in as Personal first (consent record kept), then as Work. The newest record wins.
setDb('Profile 4', [batch(3, [[1, 'accountUuid', J(uuidOf.personal)], [1, 'permissionConsentByAccount', J({ [uuidOf.personal]: {} })]]), batch(40, [[1, 'accountUuid', J(uuidOf.main)]])]);
setDb('Profile 6', [batch(7, [[1, 'accountUuid', J(uuidOf.studio)]])]);

const chromePushes = () => win.webContents.sent.filter(([c]) => c === 'chrome').map(([, c]) => c);
const lastStatus = () => { const s = win.webContents.sent.filter(([c]) => c === 'status').pop(); return s ? s[1] : {}; };
const savedState = () => JSON.parse(fs.readFileSync(path.join(userData, 'profiles.json'), 'utf8'));
const acc = (id) => savedState().accounts.find((a) => a.id === id);
const save = (input, sender = ev()) => handlers['account:save'](sender, input);
const base = (id) => { const a = acc(id); return { id, name: a.name, color: a.color, shareCode: a.shareCode }; };
const fresh = async () => { await vsleep(6000); return handlers['chrome:get'](ev()); }; // past the snapshot reuse window

// Bad stored values can't break startup: sanitizeState keeps only a profile folder name's shape.
{
  const s = JSON.parse(fs.readFileSync(path.join(userData, 'profiles.json'), 'utf8'));
  s.accounts[0].chromeProfile = '..\\..\\Windows';
  s.accounts[1].chromeProfile = 42;
  s.accounts[2].chromeProfile = 'Profile 6';
  fs.writeFileSync(path.join(userData, 'profiles.json'), JSON.stringify(s));
}

(async () => {
  require(path.join(ROOT, 'main.js'));
  {
    while (!win || !handlers['state:get']) await vsleep(100);
    const st = await handlers['state:get'](ev());
    assert.deepStrictEqual(st.accounts.map((a) => a.chromeProfile), [null, null, 'Profile 6']);
    assert(await handlers['account:save'](ev(), { ...st.accounts[2], chromeProfile: null }));
    ok('sanitizeState: bad stored chromeProfile values become automatic');
  }
  while (!win || !handlers['chrome:get']) await vsleep(100);
  win.show();
  await until('all docked', () => Object.values(lastStatus()).length === 3 && Object.values(lastStatus()).every((x) => x.status === 'docked'));
  await until('first chrome push', () => chromePushes().length > 0);

  // Guards.
  assert.strictEqual(await handlers['chrome:get']({ sender: {} }), null, 'other senders get nothing');
  assert.deepStrictEqual(await handlers['chrome:open']({ sender: {} }, 'main'), { ok: false });
  assert.deepStrictEqual(await handlers['chrome:open'](ev(), 'nope'), { ok: false });
  assert.deepStrictEqual(await handlers['chrome:open'](ev(), { id: 'main' }), { ok: false });
  assert.strictEqual(launches.length, 0, 'nothing launched by bad calls');
  ok('IPC guards');

  // The mapping, using the newest record (Profile 4 also holds Personal's UUID, from before).
  let g = await handlers['chrome:get'](ev());
  assert.strictEqual(g.installed, true);
  assert.deepStrictEqual(g.profiles.map((p) => p.dir), ['Default', 'Profile 4', 'Profile 6']);
  assert.deepStrictEqual(Object.fromEntries(Object.entries(g.accounts).map(([id, l]) => [id, l.link && l.link.dir])), { main: 'Profile 4', personal: 'Default', studio: 'Profile 6' });
  assert.strictEqual(g.accounts.main.auto.how, 'signed-in');
  const flat = JSON.stringify(g);
  assert(!flat.includes('chrome.exe') && !flat.includes('Google Chrome'), 'no exe path in the payload');
  assert(!flat.includes(uuidOf.main), 'no account UUIDs in the payload');
  ok('mapping: Work -> Profile 4, Personal -> Default, Studio -> Profile 6; payload has no paths or UUIDs');

  // Opening: main's exe, the profile as one argument, detached, no Claude Code session variables.
  let r = await handlers['chrome:open'](ev(), 'studio');
  assert.deepStrictEqual(r, { ok: true, profile: 'Studio & Labs' });
  const l = launches.pop();
  assert.strictEqual(l.cmd, chromeExe);
  assert.deepStrictEqual(l.args, ['--profile-directory=Profile 6']);
  assert.strictEqual(l.opts.detached, true);
  assert.strictEqual(l.env.CLAUDECODE, undefined);
  ok('chrome:open starts chrome.exe --profile-directory=Profile 6, detached, clean env');

  // Tray submenu ('&' escaped); clicking opens Chrome without the page.
  const sub = tray.menu.find((m) => m.label === 'Open Chrome');
  assert(sub, 'tray has Open Chrome');
  assert.deepStrictEqual(sub.submenu.map((i) => i.label), ['Work · Dev (Agency)', 'Personal · Private', 'Studio · Studio && Labs']);
  sub.submenu[1].click();
  await until('tray launch', () => launches.length === 1);
  assert.deepStrictEqual(launches.pop().args, ['--profile-directory=Default']);
  ok('tray Open Chrome submenu');

  // Manual choice: validated against Local State; left out keeps it; null goes back to automatic.
  for (const bad of ['..', 'C:\\Windows', '..\\Profile 6', 'Profile 9', 42, {}, '']) {
    assert.strictEqual(await save({ ...base('studio'), chromeProfile: bad }), null, `rejects ${J(bad)}`);
  }
  assert.strictEqual(acc('studio').chromeProfile, null);
  assert.strictEqual(await save({ ...base('studio'), chromeProfile: 'Profile 4' }, { sender: {} }), null);
  assert(await save({ ...base('studio'), chromeProfile: 'Profile 4' }));
  assert.strictEqual(acc('studio').chromeProfile, 'Profile 4');
  g = await handlers['chrome:get'](ev());
  assert.deepStrictEqual(g.accounts.studio.link, { dir: 'Profile 4', name: 'Dev (Agency)', manual: true });
  assert.strictEqual(g.accounts.studio.auto.dir, 'Profile 6');
  assert(await save({ ...base('studio'), name: 'Studio 2' }));
  assert.strictEqual(acc('studio').chromeProfile, 'Profile 4', 'a save without chromeProfile keeps it');
  r = await handlers['chrome:open'](ev(), 'studio');
  assert.strictEqual(launches.pop().args[0], '--profile-directory=Profile 4');
  assert(await save({ id: 'newbie', name: 'New', color: '#888888', shareCode: true, chromeProfile: 'Default' }));
  assert.strictEqual(acc('newbie').chromeProfile, 'Default');
  ok('manual choice: bad values rejected, kept across saves, used by chrome:open');

  // A chosen profile Chrome no longer has: automatic again (and flagged), but the choice stays in profiles.json.
  delete localState.profile.info_cache['Profile 4'];
  writeLocalState();
  g = await fresh();
  assert.strictEqual(g.accounts.studio.missing, true);
  assert.strictEqual(g.accounts.studio.link.dir, 'Profile 6');
  assert.strictEqual(g.accounts.main.link, null, 'Work had only Profile 4');
  assert.strictEqual(acc('studio').chromeProfile, 'Profile 4');
  r = await handlers['chrome:open'](ev(), 'main');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.unlinked, true); assert(/No Chrome profile is linked to Work/.test(r.error));
  assert(await save({ ...base('studio'), chromeProfile: 'Profile 4' }), 'resaving the same (now missing) choice is allowed');
  assert(await save({ ...base('studio'), chromeProfile: null }));
  assert.strictEqual(acc('studio').chromeProfile, null);
  ok('missing chosen profile falls back to automatic; Work unlinked gives a clear error');

  // Sign-in changes are picked up by the poll and pushed.
  const pushesBefore = chromePushes().length;
  setDb('Profile 6', [batch(7, [[1, 'accountUuid', J(uuidOf.studio)]]), batch(50, [[1, 'accountUuid', J(uuidOf.personal)]])]);
  await until('chrome push after sign-in change', () => chromePushes().length > pushesBefore, 5 * MIN);
  g = chromePushes().pop();
  assert.strictEqual(g.accounts.studio.link, null);
  assert.strictEqual(g.accounts.personal.link.dir, 'Default', 'Default was used more recently');
  localState.profile.info_cache['Profile 6'].active_time = 999; writeLocalState();
  g = await fresh();
  assert.strictEqual(g.accounts.personal.link.dir, 'Profile 6', 'two profiles signed in: the one Chrome used last');
  // Signed out (a deletion): it still links to the account it was last signed in to, if no profile is signed in to that.
  setDb('Profile 6', [batch(7, [[1, 'accountUuid', J(uuidOf.studio)]]), batch(60, [[0, 'accountUuid']])]);
  g = await fresh();
  assert.deepStrictEqual(g.accounts.studio.auto, { dir: 'Profile 6', name: 'Studio & Labs', how: 'last-signed-in' });
  assert.strictEqual(g.accounts.personal.link.dir, 'Default');
  ok('sign-in changes pushed; ties go to the most recently used profile; signed-out keeps its last account');

  // No Chrome: the tray item goes; opening says so.
  fs.rmSync(chromeExe);
  g = await fresh();
  assert.strictEqual(g.installed, false);
  r = await handlers['chrome:open'](ev(), 'personal');
  assert(/isn't installed/.test(r.error));
  assert(!tray.menu.some((m) => m.label === 'Open Chrome'), 'no tray item without Chrome');
  ok('Chrome not installed');

  console.log('\nall passed');
  process.exit(0);
})().catch((err) => { console.error('FAILED:', err); process.exit(1); });
