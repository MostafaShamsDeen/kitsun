// Read-only against the real accounts: where a handoff would write (target account + org) and whether each account's
// newest session and its transcript are found. Writes nothing.
const fs = require('fs'), path = require('path');
const H = require('D:/Claud/multi-claude/lib/handoff');
const { dataDirOf, codeDirOf, sessionsOf } = require('D:/Claud/multi-claude/lib/stats');
const st = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'Kitsun', 'profiles.json'), 'utf8'));
(async () => {
  for (const a of st.accounts) {
    const d = dataDirOf(a);
    const cfg = JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8'));
    const acct = cfg.lastKnownAccountUuid;
    const org = H.pickOrg(path.join(d, 'claude-code-sessions', acct), H.lastOrgOf(d));
    const list = (await sessionsOf(d)).filter((s) => !s.archived && s.cliSessionId).sort((x, y) => (y.lastActivityAt || 0) - (x.lastActivityAt || 0));
    const s = list[0];
    const rec = s && H.findRecord(d, s.sessionId);
    const tr = s && H.findTranscript(codeDirOf(a), s.cliSessionId);
    const raw = rec && JSON.parse(fs.readFileSync(rec.file, 'utf8'));
    console.log(`${a.name}: target org ${org ? `${org.org.slice(0, 8)} (exists ${org.exists})` : 'none'}; newest "${s && s.title}" record ${rec ? 'found' : 'missing'}, transcript ${tr ? `${Math.round(tr.size / 1024)} KB in ${path.basename(tr.dir)}` : 'missing'}, unsupported: ${raw ? H.unsupported(raw) : '-'}`);
  }
})();
