// lib/search.js: a forced refresh asked for while a build is under way must still see a session written after that
// build listed the folders (finding #10/#13: the handoff's new session). Temp folders only.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-search-force-'));
process.env.LOCALAPPDATA = path.join(tmp, 'local');
process.env.APPDATA = path.join(tmp, 'roaming');
const dataDir = path.join(process.env.LOCALAPPDATA, 'Claude-Profiles', 'x');
const orgDir = path.join(dataDir, 'claude-code-sessions', 'acc', 'org');
fs.mkdirSync(orgDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'acc' }));
const write = (n) => fs.writeFileSync(path.join(orgDir, `local_${n}.json`), JSON.stringify({ sessionId: `local_${n}`, cliSessionId: n, cwd: 'D:\\x', title: `t${n}`, createdAt: Date.now(), lastActivityAt: Date.now() }));
write('one');
const { createSearch } = require('D:/Claud/multi-claude/lib/search.js');
const accounts = [{ id: 'x', name: 'X', main: false, shareCode: true }];

(async () => {
  const s = createSearch();
  await s.refresh(accounts);
  assert(s.find('x', 'local_one'));
  // The next build lists the org folder; right after that the new session lands and the forced refresh is asked for.
  const realReaddir = fs.readdirSync;
  let forced = null;
  fs.readdirSync = function (dir, ...rest) {
    const out = realReaddir.call(this, dir, ...rest);
    if (!forced && path.resolve(String(dir)) === path.resolve(orgDir)) {
      write('two');
      forced = s.refresh(accounts, { force: true });
      // A second forced call meanwhile shares the same rebuild.
      forced2 = s.refresh(accounts, { force: true });
    }
    return out;
  };
  let forced2 = null;
  const first = s.refresh(accounts, { force: true });
  await first;
  fs.readdirSync = realReaddir;
  assert(forced, 'the build listed the folder');
  assert.strictEqual(s.find('x', 'local_two'), null, 'the build under way listed the folder before the write');
  await forced;
  assert(s.find('x', 'local_two'), 'the forced refresh reads the folders after it was asked for');
  assert.strictEqual(forced, forced2, 'forced calls during one build share one rebuild');
  // A query while a build is under way just waits for that build.
  const q = await s.query(accounts, 'ttwo');
  assert.strictEqual(q[0] && q[0].sessionId, 'local_two');
  console.log('ok forced refresh during a build reads the folders again');
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
