// Read-only survey of the real Code session files of all three accounts.
const fs = require('fs'), path = require('path');
const L = process.env.LOCALAPPDATA;
const dirs = {
  Work: path.join(L, 'Claude-Data', 'claude_pzs8sxrjxfjjc'),
  Personal: path.join(L, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Local', 'Claude-Profiles', 'personal'),
  Studio: path.join(L, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Local', 'Claude-Profiles', 'client-1-mvsl0lu8mg'),
};
const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const keyCount = {}; let n = 0; const all = [];
for (const [name, dd] of Object.entries(dirs)) {
  const cfg = JSON.parse(fs.readFileSync(path.join(dd, 'config.json'), 'utf8'));
  const root = path.join(dd, 'claude-code-sessions');
  console.log(name, 'uuid', cfg.lastKnownAccountUuid, 'dirs', ls(root));
  const au = cfg.lastKnownAccountUuid;
  for (const org of ls(path.join(root, au))) for (const f of ls(path.join(root, au, org))) if (/^local_.*\.json$/.test(f)) {
    const file = path.join(root, au, org, f);
    const s = JSON.parse(fs.readFileSync(file, 'utf8')); n++;
    for (const k of Object.keys(s)) keyCount[k] = (keyCount[k] || 0) + 1;
    all.push({ acct: name, file, s, mtime: fs.statSync(file).mtimeMs });
  }
}
console.log('sessions', n); console.log(keyCount);
fs.writeFileSync(path.join(__dirname, 'all.json'), JSON.stringify(all));
