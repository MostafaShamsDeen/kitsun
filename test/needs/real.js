// Runs the attention watcher against the real accounts, read-only. node real.js [polls]
const { createAttention } = require('D:/Claud/multi-claude/lib/attention.js');
const accounts = [
  { id: 'main', name: 'Work', main: true, shareCode: true },
  { id: 'personal', name: 'Personal', main: false, shareCode: true },
  { id: 'client-1-mvsl0lu8mg', name: 'Studio', main: false, shareCode: true },
];
(async () => {
  const w = createAttention();
  const running = new Set(accounts.map((a) => a.id));
  for (let n = 0; n < (Number(process.argv[2]) || 1); n++) {
    const t0 = Date.now();
    const r = await w.poll(accounts, { running });
    console.log(`poll ${n} took ${Date.now() - t0} ms`);
    for (const a of accounts) {
      const x = r.accounts[a.id];
      console.log(a.name, { waiting: x.waiting, unseen: x.unseen, working: x.working, usage: x.usage });
      for (const it of x.items) console.log('   ', it.state.padEnd(8), it.kind.padEnd(10), `${Math.round((Date.now() - it.at) / 60000)}m`, it.title, '|', it.detail);
    }
    console.log('limits', r.limits);
  }
})();
