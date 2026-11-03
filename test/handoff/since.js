// Read-only: for every real session, does its transcript have lines from more than a minute before the session's
// createdAt? (lib/stats.js now skips those for transcripts it hasn't counted yet, so forks don't count twice.)
const fs = require('fs'), path = require('path');
const { dataDirOf, codeDirOf, sessionsOf } = require('D:/Claud/multi-claude/lib/stats');
const H = require('D:/Claud/multi-claude/lib/handoff');
const st = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'Kitsun', 'profiles.json'), 'utf8'));
(async () => {
  let n = 0, early = 0;
  for (const a of st.accounts) {
    for (const s of await sessionsOf(dataDirOf(a))) {
      if (!s.cliSessionId || !s.createdAt) continue;
      const tr = H.findTranscript(codeDirOf(a), s.cliSessionId);
      if (!tr) continue;
      n++;
      const fd = fs.openSync(tr.file, 'r');
      const buf = Buffer.alloc(Math.min(tr.size, 256 * 1024));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      let first = null;
      for (const line of buf.toString('utf8').split('\n')) {
        const m = /"timestamp":"([^"]+)"/.exec(line);
        if (m && /"type":"(user|assistant)"/.test(line)) { first = Date.parse(m[1]); break; }
      }
      if (first && first < s.createdAt - 60000) { early++; console.log(`${a.name}: "${s.title}" first line ${Math.round((s.createdAt - first) / 60000)} min before createdAt`); }
    }
  }
  console.log(`${n} transcripts checked, ${early} start more than a minute before their session was made`);
})();
