// Read-only: which real session record has a given cliSessionId.
const { dataDirOf } = require('D:/Claud/multi-claude/lib/stats');
const fs = require('fs'), path = require('path');
const st = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'Kitsun', 'profiles.json'), 'utf8'));
const want = process.argv[2];
for (const a of st.accounts) {
  const d = dataDirOf(a); const root = path.join(d, 'claude-code-sessions');
  for (const u of fs.readdirSync(root)) for (const o of fs.readdirSync(path.join(root, u))) for (const f of fs.readdirSync(path.join(root,u,o))) {
    if (!/^local_.*\.json$/.test(f)) continue;
    const s = JSON.parse(fs.readFileSync(path.join(root,u,o,f),'utf8'));
    if (s.cliSessionId === want) console.log(a.id, path.join(root,u,o,f), s.title, 'bridges', (s.bridgeSessionIds||[]).length, 'archived', s.isArchived);
  }
}
