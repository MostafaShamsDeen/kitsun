// For the most recent sessions: where the transcript is and what its last entries are (read-only).
const fs = require('fs'), path = require('path'), os = require('os');
const all = require('./all.json');
const projects = path.join(os.homedir(), '.claude', 'projects');
const slug = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');
all.sort((a, b) => (b.s.lastActivityAt || 0) - (a.s.lastActivityAt || 0));
for (const { acct, s } of all.slice(0, Number(process.argv[2]) || 8)) {
  const cand = fs.readdirSync(projects).map((d) => path.join(projects, d, `${s.cliSessionId}.jsonl`));
  const file = cand.find((f) => fs.existsSync(f));
  console.log('\n==', acct, s.title, s.cliSessionId, file ? '' : `MISSING ${cand.join(' | ')}`);
  if (!file) continue;
  const st = fs.statSync(file);
  console.log('  size', st.size, 'mtime ago s', Math.round((Date.now() - st.mtimeMs) / 1000), 'edge ago s', Math.round((Date.now() - (s.lastTurnEdgeAt || 0)) / 1000));
  const fd = fs.openSync(file, 'r'); const len = Math.min(st.size, 200000); const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n').filter(Boolean).slice(-6);
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      const c = o.message && o.message.content;
      const kinds = Array.isArray(c) ? c.map((b) => b.type + (b.name ? `:${b.name}` : '')).join(',') : typeof c;
      console.log('  ', o.type, o.subtype || '', o.timestamp, 'stop', o.message && o.message.stop_reason, kinds, o.isMeta ? 'meta' : '');
    } catch { console.log('   (cut line)'); }
  }
}
