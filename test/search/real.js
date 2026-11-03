// Read-only check of lib/search.js against the real accounts.
const { createSearch } = require('D:/Claud/multi-claude/lib/search.js');
const accounts = [
  { id: 'main', name: 'Work', main: true, shareCode: true },
  { id: 'personal', name: 'Personal', main: false, shareCode: true },
  { id: 'client-1-mvsl0lu8mg', name: 'Studio', main: false, shareCode: true },
];
(async () => {
  const s = createSearch();
  let t = Date.now();
  let r = await s.query(accounts, '');
  console.log('first (empty) query ms', Date.now() - t, 'results', r.length);
  for (const x of r) console.log('  ', x.accountId, '|', x.title, '|', x.folder, '|', (x.snippet || '').slice(0, 80));
  await new Promise((res) => setTimeout(res, 1500));
  for (const q of ['acme', 'spend tracker', 'company card', 'opus', 'teashop', 'reboot', 'agency', 'personal shop', 'zzzqqq', 'job haunting']) {
    t = Date.now();
    r = await s.query(accounts, q);
    console.log(`\n"${q}" ${Date.now() - t}ms ${r.length} results`);
    for (const x of r.slice(0, 4)) console.log('  ', x.accountId, '|', x.title, '|', x.folder, '|', (x.snippet || '').slice(0, 90), x.archived ? '[archived]' : '');
  }
})();
