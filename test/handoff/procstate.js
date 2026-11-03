// Read-only: turn state and age of the transcripts named by running claude.exe --resume ids.
const fs = require('fs'); const path = require('path'); const os = require('os');
const { turnFromTail } = require('D:/Claud/multi-claude/lib/attention');
const projects = path.join(os.homedir(), '.claude', 'projects');
for (const id of process.argv.slice(2)) {
  for (const d of fs.readdirSync(projects)) {
    const f = path.join(projects, d, `${id}.jsonl`);
    if (!fs.existsSync(f)) continue;
    const st = fs.statSync(f);
    const buf = Buffer.alloc(Math.min(st.size, 256 * 1024)); const fd = fs.openSync(f, 'r'); fs.readSync(fd, buf, 0, buf.length, st.size - buf.length); fs.closeSync(fd);
    console.log(id, d, turnFromTail(buf.toString('utf8')), Math.round((Date.now() - st.mtimeMs) / 60000), 'min ago');
  }
}
