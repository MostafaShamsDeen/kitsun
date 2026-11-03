const assert = require('assert');
const h = require('D:/Claud/multi-claude/lib/health.js');
const fs = require('fs');
const t = (s) => { const [d, tm] = s.split(' '); const [y, mo, da] = d.split('-').map(Number); const [hh, mi, ss] = tm.split(':').map(Number); return new Date(y, mo - 1, da, hh, mi, ss).getTime(); };
// Cuts the real log just before the Nth "Starting app" at or after a given time, as if the copy had just closed then.
function cutBefore(text, stamp) {
  const i = text.indexOf(`${stamp} [info] Starting app`);
  assert(i > 0, `no Starting app at ${stamp}`);
  return text.slice(0, i);
}
// Cuts the real log just after the line that starts with `start`, as if the copy had died right then.
function cutAfter(text, start) {
  const i = text.indexOf(start);
  assert(i > 0, `no line ${start}`);
  return text.slice(0, text.indexOf('\n', i) + 1);
}
const accounts = { work: { id: 'main', main: true }, personal: { id: 'personal' }, studio: { id: 'client-1-mvsl0lu8mg' } };
for (const [k, a] of Object.entries(accounts)) console.log(k, h.findMainLog(a));
const read = (a) => fs.readFileSync(h.findMainLog(a), 'utf8');
const personal = read(accounts.personal), studio = read(accounts.studio), work = read(accounts.work);

const cases = [
  ['personal update 19:38:47', cutBefore(personal, '2026-10-29 20:26:47'), 'update', '2026-10-29 19:38:47', false],
  ['studio update 19:38:47', cutBefore(studio, '2026-10-29 20:26:41'), 'update', '2026-10-29 19:38:47', false],
  ['personal user quit 20:28', cutBefore(personal, '2026-10-29 20:29:37'), 'user', '2026-10-29 20:28:38', false],
  ['studio user quit 20:28', cutBefore(studio, '2026-10-29 20:29:37'), 'user', '2026-10-29 20:28:53', false],
  ['personal shutdown 15:18', cutBefore(personal, '2026-10-29 15:20:08'), 'shutdown', '2026-10-29 15:18:50', false],
  ['studio shutdown 11:09', cutBefore(studio, '2026-10-29 15:23:54'), 'shutdown', '2026-10-29 11:09:36', false],
  ['work stealth update 19:38:47', cutBefore(work, '2026-10-29 19:39:20'), 'update', '2026-10-29 19:38:47', true],
  ['work user quit 20:28:51', cutBefore(work, '2026-10-29 20:28:53'), 'user', '2026-10-29 20:28:51', false],
  // Vetoed first (quit-confirm prompt), confirmed 3 s later: the quit that went ahead counts.
  ['work vetoed then quit 13:38', cutBefore(work, '2026-10-28 13:38:37'), 'user', '2026-10-28 13:38:33', false],
  // Vetoed by the updater guard, which later restarts Claude itself to update.
  ['work updater-guard restart 20:45:47', cutBefore(work, '2026-10-28 21:02:04'), 'update', '2026-10-28 20:45:47', true],
  // Vetoed, and the copy then died before anything else: a crash, not the user's quit.
  ['work vetoed then crash 20:42', cutAfter(work, '2026-10-28 20:42:38 [info] [updater-guard] restart deferred'), 'crash', null, false],
];
for (const [name, text, reason, at, self] of cases) {
  const tail = text.slice(-h.LOG_TAIL_BYTES); // what readTail would see
  const r = h.classifyQuit(tail);
  assert.strictEqual(r.reason, reason, name);
  // A quit that went ahead is dated by its last quit line, a second or two after it was asked for.
  if (at === null) assert.strictEqual(r.at, null, name + ' at');
  else if (reason === 'user') assert(r.at >= t(at) && r.at - t(at) <= 5000, name + ' at');
  else assert.strictEqual(r.at, t(at), name + ' at');
  assert.strictEqual(r.selfRelaunch, self, name + ' self');
  console.log('ok', name, r.reason, new Date(r.at).toTimeString().slice(0, 8));
}
// The running copies: no quit line after their last start, i.e. what a crash right now would look like.
for (const k of ['personal', 'studio', 'work']) {
  const r = h.classifyQuit(h.readTail(h.findMainLog(accounts[k])));
  assert.strictEqual(r.reason, 'crash', k); console.log('ok', k, 'live run reads as crash; started', new Date(r.startedAt).toTimeString().slice(0, 8));
}
// Synthetic edge cases.
assert.strictEqual(h.classifyQuit('').reason, 'unknown');
assert.strictEqual(h.classifyQuit('garbage\nmore').reason, 'crash');
assert.strictEqual(h.classifyQuit('2026-10-29 10:00:00 [info] Windows session ending (close-app, critical) - quitting the app').reason, 'update');
assert.strictEqual(h.classifyQuit('2026-10-29 10:00:00 [info] Windows session ending (logoff) - quitting the app').reason, 'shutdown');
// An earlier run's quit lines don't count.
assert.strictEqual(h.classifyQuit('2026-10-29 10:00:00 [info] beforeQuit: handler fired, going down\n2026-10-29 10:01:00 [info] Starting app {\n  appVersion: 1\n}\n2026-10-29 10:02:00 [info] x').reason, 'crash');
// Vetoed quits (quit-confirm prompt, updater guard) don't count; one that went ahead does, dated by its last line.
const L = (tm, msg) => `2026-10-29 ${tm} [info] ${msg}`;
const veto = [L('10:00:00', 'Starting app {'), L('10:05:00', 'beforeQuit: handler fired, going down'), L('10:05:00', 'beforeQuit: vetoed by before-quit interceptor')];
assert.strictEqual(h.classifyQuit(veto.join('\n')).reason, 'crash');
assert.strictEqual(h.classifyQuit([...veto, L('10:06:00', 'something else')].join('\n')).reason, 'crash');
const went = h.classifyQuit([...veto, L('10:07:00', 'beforeQuit: handler fired, going down'), L('10:07:00', 'beforeQuit: handler is not yet run, preventing quit and cleaning things up'),
  L('10:07:01', 'beforeQuit: handler fired, going down'), L('10:07:01', 'beforeQuit: handler is ready for quit, so quitting'), L('10:07:02', 'willQuit: handler fired, going down')].join('\n'));
assert.deepStrictEqual([went.reason, went.at], ['user', t('2026-10-29 10:07:02')]);
// A "fired" line that is the last thing written went ahead (a veto line would follow it at once).
assert.strictEqual(h.classifyQuit([...veto, L('10:08:00', 'beforeQuit: handler fired, going down')].join('\n')).reason, 'user');
const guard = h.classifyQuit([...veto, L('10:05:05', '[updater-guard] restart deferred; 1 local or SSH session(s) still running'),
  L('10:09:00', '[updater-guard] nothing left to wait for; restarting with background shells in 0 session(s)'), L('10:09:00', 'beforeQuit: handler fired, going down'),
  L('10:09:01', 'willQuit: handler fired, going down')].join('\n'));
assert.deepStrictEqual([guard.reason, guard.at, guard.selfRelaunch], ['update', t('2026-10-29 10:09:00'), true]);
console.log('ok vetoed quits');
// Stale quit line -> unknown (exitReason) is checked via the time rule.
const tmp = require('path').join(process.env.TEMP, 'mc-health', 'env');
fs.mkdirSync(require('path').join(tmp, 'Claude-Profiles', 'x', 'logs'), { recursive: true });
fs.writeFileSync(require('path').join(tmp, 'Claude-Profiles', 'x', 'logs', 'main.log'), '2026-10-29 10:00:00 [info] beforeQuit: handler fired, going down\n');
assert.strictEqual(h.exitReason({ id: 'x' }, t('2026-10-29 10:01:00'), { LOCALAPPDATA: tmp }).reason, 'user');
assert.strictEqual(h.exitReason({ id: 'x' }, t('2026-10-29 10:30:00'), { LOCALAPPDATA: tmp }).reason, 'unknown');
assert.strictEqual(h.exitReason({ id: 'nope' }, Date.now(), { LOCALAPPDATA: tmp }).reason, 'unknown');
// Versions.
assert.strictEqual(h.displayVersion('4.4212.0.0'), '4.4212');
assert.strictEqual(h.displayVersion('4.29.0'), '4.29');
assert.strictEqual(h.compareVersions('4.4212.0.0', '4.29.0.0'), 1);
assert.strictEqual(h.compareVersions('4.29', '4.29.0.0'), 0);
// Budget.
const now = 1e7;
assert.strictEqual(h.restartBudget([now - 1000, now - 2000], now).allowed, true);
assert.strictEqual(h.restartBudget([now - 1000, now - 2000, now - 3000], now).allowed, false);
assert.strictEqual(h.restartBudget([now - 11 * 60000, now - 2000, now - 3000], now).allowed, true);
assert.strictEqual(h.listNames(['Personal', 'Studio']), 'Personal and Studio');
assert.strictEqual(h.listNames(['A', 'B', 'C']), 'A, B and C');
console.log('all ok');
const B = String.fromCharCode(92);
assert.strictEqual(h.versionFromExe(['C:', 'Program Files', 'WindowsApps', 'Claude_4.4212.0.0_x64__pzs8sxrjxfjjc', 'app', 'Claude.exe'].join(B)), '4.4212.0.0');
assert.strictEqual(h.versionFromExe(['C:', 'Users', 'x', 'claude-code', '2.1.309', 'claude.exe'].join(B)), null);
console.log('versions ok');
