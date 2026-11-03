// Stand-in for preload.js's window.kitsun, so the renderer runs in a normal browser.
// ?state=full (default) | empty (all zeros, no plan data, still scanning) | one (a single account) | two (two accounts)
// &scan=1 shows the "counting messages" state and fires onStatsUpdated a few seconds later.

(() => {
  const params = new URLSearchParams(location.search);
  const mode = params.get('state') || 'full';
  const scanFirst = params.get('scan') === '1';
  const NOW = Date.now();
  const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

  // Seeded random numbers, so screenshots are stable between reloads.
  let seed = 1234567;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = (x, mu, sd) => Math.exp(-((x - mu) ** 2) / (2 * sd * sd));
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const ALL = [
    {
      id: 'work', name: 'Work', color: '#5b8def', main: true, shareCode: true, scale: 1,
      live: { status: 'docked', startedAt: NOW - (3 * HOUR + 12 * MIN), memoryMB: 1430, codeSessionsOpen: 3 },
      plan: { fh: 64, sd: 71, asOfAgo: 4 * MIN },
      sessions: { total: 186, archived: 41, active7d: 23, turns: 9412 },
      folders: [['acme-spend', 38], ['multi-claude', 27], ['parts-shop', 19]],
      models: [['claude-opus-5-5', 151], ['claude-sonnet-4-5-20250929', 35]],
      recent: [
        ['Kitsun app', 'multi-claude', 12 * MIN, 48, 'Building the home dashboard: stats cards, charts and the hero animation'],
        ['Acme Spend', 'acme-spend', 2 * HOUR + 5 * MIN, 31, 'Fixed the monthly roll-up; CSV export now matches the ledger'],
        ['Parts Shop barcode scan', 'parts-shop', 26 * HOUR, 19, null],
        ['OpSync outreach sequences', 'opsync', 2 * DAY, 12, 'Drafted the LinkedIn + email cadence for the pilot client'],
      ],
    },
    {
      id: 'personal', name: 'Personal', color: '#d97757', shareCode: true, scale: 0.46,
      live: { status: 'docked', startedAt: NOW - (26 * HOUR + 40 * MIN), memoryMB: 820, codeSessionsOpen: 1 },
      plan: { fh: 22, sd: 38, asOfAgo: 9 * MIN },
      sessions: { total: 74, archived: 12, active7d: 9, turns: 2875 },
      folders: [['teashop', 22], ['icloud-backup', 8], ['higgsfield-reels', 6]],
      models: [['claude-opus-5-5', 60]],
      recent: [
        ['Teashop', 'teashop', 47 * MIN, 36, 'Shopify theme remake: product page hero and matcha origin story'],
        ['Higgsfield reel prompts', 'higgsfield-reels', 5 * HOUR, 14, 'Three reel concepts at ~100 credits each, waiting for approval'],
        ['iCloud backup task', 'icloud-backup', 3 * DAY, 9, null],
      ],
    },
    {
      id: 'studio', name: 'Studio', color: '#3fb68b', shareCode: false, scale: 0.21,
      live: { status: 'stopped', startedAt: null, memoryMB: null, codeSessionsOpen: 0 },
      plan: { fh: 0, sd: 12, asOfAgo: 3 * HOUR },
      sessions: { total: 19, archived: 2, active7d: 3, turns: 640 },
      folders: [['studio-vps', 11], ['storefront', 5]],
      models: [['claude-sonnet-4-5-20250929', 15], ['claude-opus-5-5', 4]],
      recent: [
        ['Studio server hardening', 'studio-vps', 3 * HOUR + 20 * MIN, 22, 'Closed the old SSH port and rotated the deploy key'],
        ['Storefront nightly job', 'storefront', 4 * DAY, 7, null],
      ],
    },
  ];
  const picked = mode === 'one' ? ALL.slice(0, 1) : mode === 'two' ? ALL.slice(0, 2) : ALL;

  // ---------- sample stats ----------

  function days14(a) {
    const out = [];
    const today = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i, 12);
      const wd = d.getDay();
      const weekday = wd === 0 ? 0.25 : wd === 6 ? 0.4 : 1;
      const partial = i === 0 ? Math.min(1, today.getHours() / 20 + 0.15) : 1;
      const prompts = Math.round(a.scale * 118 * weekday * (0.65 + rand() * 0.7) * partial);
      out.push({ date: ymd(d), prompts, outputTokens: Math.round(prompts * (900 + rand() * 1500)) });
    }
    return out;
  }

  function hours28(a) {
    return Array.from({ length: 7 }, (_, wd) => Array.from({ length: 24 }, (_, h) => {
      const weekend = wd === 0 || wd === 6;
      // Afternoon and evening peaks, a smaller late-morning bump; weekends lighter and later.
      const shape = gauss(h, weekend ? 16 : 15, 2.6) + 0.8 * gauss(h, 21, 1.8) + 0.35 * gauss(h, 10.5, 1.4);
      return Math.round(a.scale * 26 * (weekend ? 0.35 : 1) * shape * (0.7 + rand() * 0.6));
    }));
  }

  function planHistory(p) {
    // Samples every 3 hours over 7 days; the weekly window reset 4.5 days ago.
    const out = [];
    const reset = NOW - 4.5 * DAY;
    for (let t = NOW - 7 * DAY; t <= NOW - p.asOfAgo; t += 3 * HOUR) {
      const sd = t < reset
        ? 62 + ((t - (NOW - 7 * DAY)) / (reset - (NOW - 7 * DAY))) * 30
        : ((t - reset) / (NOW - p.asOfAgo - reset)) * p.sd;
      const hourOfWindow = ((t / HOUR) % 5) / 5;
      out.push({ t, fh: Math.round(hourOfWindow * 80 * rand()), sd: Math.round(Math.max(0, Math.min(100, sd))) });
    }
    out.push({ t: NOW - p.asOfAgo, fh: p.fh, sd: p.sd });
    return out;
  }

  function full(a) {
    const days = days14(a);
    const last7 = days.slice(7);
    const prompts7d = last7.reduce((s, d) => s + d.prompts, 0);
    const outputTokens7d = last7.reduce((s, d) => s + d.outputTokens, 0);
    return {
      id: a.id, name: a.name, color: a.color, main: Boolean(a.main),
      live: { ...a.live },
      plan: { asOf: NOW - a.plan.asOfAgo, fiveHour: a.plan.fh, weekly: a.plan.sd, history: planHistory(a.plan) },
      sessions: {
        ...a.sessions,
        lastActivityAt: NOW - a.recent[0][2],
        recent: a.recent.slice(0, 5).map(([title, folder, ago, turns, summary], n) => ({ sessionId: `local_${a.id}-r${n}`, title, folder, lastActivityAt: NOW - ago, turns, summary })),
        topFolders: a.folders.map(([name, sessions]) => ({ name, sessions })),
        models: a.models.map(([name, sessions]) => ({ name, sessions })),
      },
      activity: {
        days,
        totals: { prompts7d, outputTokens7d, promptsAll: prompts7d * 11 + 380, outputTokensAll: outputTokens7d * 12 },
        hours: hours28(a),
      },
    };
  }

  function empty(a) {
    const today = new Date();
    return {
      id: a.id, name: a.name, color: a.color, main: Boolean(a.main),
      live: { ...a.live, memoryMB: a.live.status === 'docked' ? 0 : null, codeSessionsOpen: 0 },
      plan: null,
      sessions: { total: 0, archived: 0, active7d: 0, turns: 0, lastActivityAt: null, recent: [], topFolders: [], models: [] },
      activity: {
        days: Array.from({ length: 14 }, (_, i) => ({ date: ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 13 + i, 12)), prompts: 0, outputTokens: 0 })),
        totals: { prompts7d: 0, outputTokens7d: 0, promptsAll: 0, outputTokensAll: 0 },
        hours: Array.from({ length: 7 }, () => new Array(24).fill(0)),
      },
    };
  }

  const sample = picked.map(mode === 'empty' ? empty : full);
  let scanning = mode === 'empty' || scanFirst;

  // ---------- the stubbed bridge ----------

  const accounts = picked.map(({ id, name, color, main, shareCode }) => ({ id, name, color, main: Boolean(main), shareCode }));
  // Same shape as main.js statusPayload(): exit says why a copy closed, frozen marks one not responding.
  const st = (s, extra = {}) => ({ status: s, error: null, running: s === 'docked' || s === 'stopping', frozen: false, exit: null, ...extra });
  const status = Object.fromEntries(picked.map((a) => [a.id, st(a.live.status)]));
  let ui = { layout: 'single', panes: [picked[0].id, picked[1] ? picked[1].id : null, picked[2] ? picked[2].id : null], split: false, focused: 0, home: true, splitRatio: 0.5, tripleRatios: [1 / 3, 1 / 3, 1 / 3] };
  // &health=1: Personal frozen, Studio closed by a Claude update and about to be reopened.
  // &exit=update|crash|user|shutdown|stopped|gaveup|reopening-crash sets how Studio closed instead; &stopping=1 shows Personal stopping.
  // &show=<id> opens that account instead of home (&split=1 for two panes).
  const EXITS = {
    update: { reason: 'update', reopening: true, gaveUp: false },
    'update-off': { reason: 'update', reopening: false, gaveUp: false },
    crash: { reason: 'crash', reopening: true, gaveUp: false },
    gaveup: { reason: 'crash', reopening: false, gaveUp: true },
    user: { reason: 'user', reopening: false, gaveUp: false },
    shutdown: { reason: 'shutdown', reopening: false, gaveUp: false },
    stopped: { reason: 'stopped', reopening: false, gaveUp: false },
  };
  if (params.get('health') === '1' || params.get('exit')) {
    if (status.personal && params.get('health') === '1') status.personal.frozen = true;
    if (status.studio) status.studio = st('stopped', { exit: EXITS[params.get('exit') || 'update'] || EXITS.update });
  }
  if (params.get('stopping') === '1' && status.personal) status.personal = st('stopping');
  if (params.get('reopening') === '1' && status.studio) status.studio = st('starting', { exit: EXITS.update });
  // &show=<id> shows that account in the first pane. &layout=split|triple (or &split=1) shows two or three panes,
  // &focus=N makes pane N (0-based) the active one, &ratio=0.3 sets the split divider, &ratios=0.2,0.5,0.3 the triple ones.
  const showId = params.get('show');
  if (showId && status[showId]) {
    const others = picked.filter((a) => a.id !== showId).map((a) => a.id);
    const layout = ['split', 'triple'].includes(params.get('layout')) ? params.get('layout') : params.get('split') === '1' ? 'split' : 'single';
    ui = { ...ui, panes: [showId, others[0] || null, others[1] || null], layout, split: layout !== 'single', focused: Number(params.get('focus')) || 0, home: false };
  }
  if (params.get('ratio')) ui.splitRatio = Number(params.get('ratio'));
  if (params.get('ratios')) ui.tripleRatios = params.get('ratios').split(',').map(Number);
  // &tabs=N pads the title bar with extra (stopped) accounts, to check that a crowded title bar still fits.
  const extraTabs = Math.min(20, Number(params.get('tabs')) || 0);
  const EXTRA_NAMES = ['Client Atlas', 'Teashop Ads', 'Puzzleshop', 'Storefront Ops', 'Shop', 'Acme', 'Agency', 'OpSync', 'Research', 'Sandbox'];
  for (let n = 0; n < extraTabs; n++) {
    const id = `extra-${n}`;
    accounts.push({ id, name: EXTRA_NAMES[n % EXTRA_NAMES.length], color: '#9b968c', main: false, shareCode: true });
    status[id] = st('stopped');
  }
  // Same shape as main.js's 'sessions' push (lib/attention.js): what waits for the person, finished unseen or is
  // working, and plan usage for the tab rings. &needs=0: nothing waiting; &needs=unseen: only finished-unseen dots.
  const SECOND = 1000;
  const item = (sessionId, title, folder, state, kind, detail, ago) => ({ sessionId, title, folder, state, kind, detail, at: NOW - ago, key: `${kind}:${ago}` });
  const SESSIONS = {
    work: [
      item('local_w1', 'OpSync outreach sequences', 'opsync', 'waiting', 'plan', 'Wants you to approve its plan', 2 * MIN),
      item('local_w2', 'Kitsun app', 'multi-claude', 'working', 'working', null, 40 * SECOND),
      item('local_w3', 'Acme Spend', 'acme-spend', 'unseen', 'done', 'The dashboard chart now has a Day / Week / Month switch, and there\'s a "Largest purchases" card.', 25 * MIN),
    ],
    personal: [
      item('local_p1', 'Teashop', 'teashop', 'waiting', 'permission', 'Wants to use Bash', 50 * SECOND),
      item('local_p2', 'Studio Labs', 'studio-vps', 'waiting', 'input', 'Shall I reboot now, or schedule it for around 5 am, after the nightly backups, when the shops are quiet?', 14 * MIN),
      item('local_p3', 'Higgsfield reel prompts', 'higgsfield-reels', 'waiting', 'question', 'Has a question for you', 41 * MIN),
    ],
    studio: [
      item('local_c1', 'Studio server hardening', 'studio-vps', 'unseen', 'done', 'Closed the old SSH port and rotated the deploy key', 3 * HOUR),
    ],
  };
  const needsMode = params.get('needs');
  const sessionsSample = Object.fromEntries(picked.map((a) => {
    let items = mode === 'empty' || needsMode === '0' ? [] : SESSIONS[a.id] || [];
    if (needsMode === 'unseen') items = items.map((x) => ({ ...x, state: 'unseen', kind: 'done' }));
    const n = (s) => items.filter((x) => x.state === s).length;
    const usage = mode === 'empty' ? null : { fiveHour: a.plan.fh, weekly: a.plan.sd, asOf: NOW - a.plan.asOfAgo };
    return [a.id, { waiting: n('waiting'), unseen: n('unseen'), working: n('working'), items, usage }];
  }));

  // Sample index for search:query (lib/search.js): the same fields it matches on, per session. Same result shape and a
  // simplified ranking (field weight, then recency). &searchdelay=<ms> slows the answers to show "Searching…".
  const doc = (accountId, sessionId, title, folder, ago, summary, extra = {}) => ({ accountId, sessionId, title, folder, at: NOW - ago, summary, previous: [], prompt: '', model: 'claude-opus-5-5', archived: false, ...extra });
  const SEARCH_DOCS = [
    doc('work', 'local_s1', 'Kitsun app', 'multi-claude', 12 * MIN, 'Building the quick switcher: search across accounts, Ctrl+Alt+K', { previous: ['Multi-account Claude desktop app'], prompt: 'one window with a tab per Claude account, each the real Claude desktop app' }),
    doc('work', 'local_s2', 'Acme Spend', 'acme-spend', 2 * HOUR + 5 * MIN, 'Fixed the monthly roll-up; CSV export now matches the ledger', { previous: ['Company card spend tracker webapp'], prompt: 'build a spend tracker for the company cards' }),
    doc('work', 'local_s3', 'OpSync outreach sequences', 'opsync', 2 * MIN, 'Wants you to approve its plan: LinkedIn + email cadence for the pilot client', { prompt: 'move the LinkedIn and email sequences into OpSync' }),
    doc('work', 'local_s4', 'Parts Shop barcode scan', 'parts-shop', 26 * HOUR, 'auto-update live; Owner\'s iPhone needs one reopen', { previous: ['Inventory management app with barcode scanning'], model: 'claude-sonnet-4-5-20250929' }),
    doc('work', 'local_s5', 'Agency Main', 'agency', 3 * DAY, 'Alpha copy handed to Morgan; awaiting her step 3 and Riley review', { previous: ['Work email license handoff'] }),
    doc('personal', 'local_s6', 'Teashop', 'teashop', 47 * MIN, 'Shopify theme remake: product page hero and matcha origin story', { prompt: 'i am going to start working for my friends matcha brand, a full remake of its website' }),
    doc('personal', 'local_s7', 'Higgsfield reel prompts', 'higgsfield-reels', 5 * HOUR, 'Three reel concepts at ~100 credits each, waiting for approval'),
    doc('personal', 'local_s8', 'Studio Labs', 'studio-vps', 14 * MIN, 'Shall I reboot now, or schedule it for around 5 am, after the nightly backups, when the shops are quiet?'),
    doc('personal', 'local_s9', 'Job Haunting', 'Claud', 6 * DAY, 'Shortlisted 12 roles in Beirut; cover letters drafted for the top 3', { prompt: 'help me find jobs in Lebanon but first review my LinkedIn' }),
    doc('personal', 'local_s10', 'iCloud backup task', 'icloud-backup', 3 * DAY, 'Weekly Sunday 04:00 archive to iCloud per project', { archived: true }),
    doc('studio', 'local_s11', 'Studio server hardening', 'studio-vps', 3 * HOUR + 20 * MIN, 'Closed the old SSH port and rotated the deploy key', { model: 'claude-sonnet-4-5-20250929' }),
    doc('studio', 'local_s12', 'Storefront nightly job', 'storefront', 4 * DAY, 'The nightly security check runs at 02:00 and mails a summary'),
  ].filter((d) => picked.some((a) => a.id === d.accountId) && mode !== 'empty');
  const SEARCH_WEIGHTS = { title: 10, previous: 6, folder: 6, summary: 4, prompt: 3, model: 2, account: 2 };
  const clipText = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  function searchSample(text) {
    const tokens = String(text).toLowerCase().split(/\s+/).filter(Boolean);
    const fields = (d) => ({ title: d.title, previous: d.previous.join(' '), folder: d.folder, summary: d.summary, prompt: d.prompt, model: d.model.replace(/-/g, ' '), account: (accounts.find((a) => a.id === d.accountId) || {}).name || '' });
    const ranked = [];
    for (const d of SEARCH_DOCS) {
      if (!tokens.length) { if (!d.archived) ranked.push({ d, score: 0, field: null }); continue; }
      const f = fields(d);
      let score = 0;
      let field = null;
      let ok = true;
      for (const t of tokens) {
        const best = Object.entries(SEARCH_WEIGHTS).filter(([k]) => f[k].toLowerCase().includes(t)).sort((x, y) => y[1] - x[1])[0];
        if (!best) { ok = false; break; }
        score += best[1];
        if (best[0] !== 'title' && !field) field = best[0];
      }
      if (ok) ranked.push({ d, score: (score + 3 * Math.exp(-(NOW - d.at) / (7 * DAY))) * (d.archived ? 0.6 : 1), field });
    }
    ranked.sort((x, y) => y.score - x.score || y.d.at - x.d.at);
    return ranked.slice(0, tokens.length ? 30 : 8).map(({ d, field }) => {
      const prev = d.previous.find((p) => tokens.some((t) => p.toLowerCase().includes(t)));
      const snippet = field === 'previous' && prev ? `Was “${prev}”` : field === 'prompt' ? clipText(d.prompt, 140) : clipText(d.summary || d.prompt, 140);
      return { accountId: d.accountId, sessionId: d.sessionId, title: d.title, folder: d.folder, snippet, at: d.at, archived: d.archived };
    });
  }

  // Sessions "Continue in…" knows: the search index's and the home cards' recent ones (ids local_<account>-r<n>).
  const handoffsMade = new Map(); // new session id -> account it was made in
  let handoffSeq = 0;
  function sessionTitle(accountId, sessionId) {
    const d = SEARCH_DOCS.find((x) => x.accountId === accountId && x.sessionId === sessionId);
    if (d) return d.title;
    const acc = sample.find((x) => x.id === accountId);
    const r = acc && acc.sessions.recent.find((x) => x.sessionId === sessionId);
    return r ? r.title : null;
  }

  // Same shape as main.js's chrome:get (lib/chrome.js). Automatic links: Work -> Profile 4, Personal -> Default, Studio ->
  // Profile 6, as on the real PC. &chrome=0: Chrome not installed; &chrome=unlinked: Studio has no profile signed in;
  // &chrome=manual: Personal picked "Studio Labs" by hand; &chrome=missing: Personal's pick is gone from Chrome.
  const chromeMode = params.get('chrome');
  const CHROME_PROFILES = [
    { dir: 'Default', name: 'Private', email: 'dev@example.com' },
    { dir: 'Profile 4', name: 'Dev (Agency)', email: 'dev@example.com' },
    { dir: 'Profile 6', name: 'Studio Labs', email: 'labs@example.com' },
  ];
  const CHROME_AUTO = { work: 'Profile 4', personal: 'Default', studio: chromeMode === 'unlinked' ? null : 'Profile 6' };
  for (const a of accounts) a.chromeProfile = null;
  const personalAcc = accounts.find((a) => a.id === 'personal');
  if (personalAcc && chromeMode === 'manual') personalAcc.chromeProfile = 'Profile 6';
  if (personalAcc && chromeMode === 'missing') personalAcc.chromeProfile = 'Profile 9';
  function chromeSample() {
    const byDir = new Map(CHROME_PROFILES.map((p) => [p.dir, p]));
    const links = Object.fromEntries(accounts.map((a) => {
      const auto = CHROME_AUTO[a.id] ? { dir: CHROME_AUTO[a.id], name: byDir.get(CHROME_AUTO[a.id]).name, how: 'signed-in' } : null;
      const chosen = a.chromeProfile && byDir.has(a.chromeProfile) ? a.chromeProfile : null;
      const dir = chosen || (auto && auto.dir);
      return [a.id, { auto, chosen: a.chromeProfile || null, missing: Boolean(a.chromeProfile && !chosen), link: dir ? { dir, name: byDir.get(dir).name, manual: Boolean(chosen) } : null }];
    }));
    return { installed: chromeMode !== '0', profiles: chromeMode === '0' ? [] : copy(CHROME_PROFILES), accounts: links };
  }

  const listeners = { status: [], ui: [], stats: [], openSettings: [], notice: [], requestStop: [], sessions: [], openSwitcher: [], chrome: [] };
  const later = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms));
  const copy = (x) => JSON.parse(JSON.stringify(x));
  const pushStatus = () => listeners.status.forEach((fn) => fn(copy(status)));

  // ---------- panes: the same rules as main.js (showAccount, setLayout, ui:focus-pane, ui:ratios, sanitizeState) ----------
  const LAYOUTS = { single: 1, split: 2, triple: 3 };
  const paneCount = () => LAYOUTS[ui.layout] || 1;
  const activePane = () => (ui.focused < paneCount() ? ui.focused : 0);
  const pushUi = () => listeners.ui.forEach((fn) => fn(copy(ui)));
  const isAccount = (id) => accounts.some((a) => a.id === id);
  // Fills the active pane; an account already in another pane swaps places with the active pane's.
  function showAccountHere(id) {
    const panes = ui.panes.slice();
    const p = activePane();
    const other = panes.indexOf(id);
    if (other >= 0 && other !== p) panes[other] = panes[p];
    panes[p] = id;
    ui = { ...ui, panes, focused: p, home: false };
  }
  // Repeated or unknown panes are emptied, empty ones get the first accounts not shown yet, and any still empty go last.
  function fillPanes(panes) {
    const out = panes.slice(0, 3).map((id) => (isAccount(id) ? id : null));
    while (out.length < 3) out.push(null);
    out.forEach((id, p) => { if (id && out.indexOf(id) < p) out[p] = null; });
    out.forEach((id, p) => { if (!id) out[p] = (accounts.find((a) => !out.includes(a.id)) || {}).id || null; });
    return [...out.filter(Boolean), ...out.filter((id) => !id)];
  }
  function setLayoutHere(name) {
    const n = LAYOUTS[name];
    if (!n || n > accounts.length) return;
    const activeId = ui.panes[activePane()];
    const panes = fillPanes(ui.panes);
    let focused = activeId ? Math.max(0, panes.indexOf(activeId)) : 0;
    if (focused >= n) { [panes[n - 1], panes[focused]] = [panes[focused], panes[n - 1]]; focused = n - 1; }
    ui = { ...ui, panes, focused, layout: name, split: n > 1, home: false };
    // Like main: an account that lands in a pane and is stopped (not by the user's Stop) starts.
    for (let q = 0; q < n; q++) {
      const s = status[panes[q]];
      if (s && s.status === 'stopped' && !(s.exit && s.exit.reason === 'stopped')) window.kitsun.startAccount(panes[q]);
    }
  }
  // After an account is removed (main runs sanitizeState): refill, and fewer panes if there aren't enough accounts left.
  function sanitizeUi() {
    const activeId = ui.panes[ui.focused];
    const panes = fillPanes(ui.panes);
    let layout = ui.layout;
    while (LAYOUTS[layout] > 1 && !panes[LAYOUTS[layout] - 1]) layout = LAYOUTS[layout] === 3 ? 'split' : 'single';
    const fi = activeId ? panes.indexOf(activeId) : -1;
    ui = { ...ui, panes, layout, split: layout !== 'single', focused: fi >= 0 && fi < LAYOUTS[layout] ? fi : 0 };
  }
  const clampSplit = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(0.8, Math.max(0.2, v)) : null);
  const validTriple = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0);

  // Same keys, defaults and checks as main.js (DEFAULT_SETTINGS, settings:set). &dev=1 acts like a run from source.
  const DEFAULT_SETTINGS = { startWithWindows: false, startHidden: false, closeToTray: true, autoRestart: true, notifyNeedsYou: true, notifyLimits: true, notifyRestarts: true };
  const settings = { ...DEFAULT_SETTINGS, startWithWindows: true };
  const packaged = params.get('dev') !== '1';
  const setSettings = (changes) => {
    const entries = Object.entries(changes || {});
    if (!entries.length || entries.some(([k, v]) => !(k in DEFAULT_SETTINGS) || typeof v !== typeof DEFAULT_SETTINGS[k])) {
      return later(20, { ok: false, error: 'That setting can\'t be changed.', settings: copy(settings) });
    }
    if (!packaged && 'startWithWindows' in changes) return later(20, { ok: false, error: 'Only the installed Kitsun can start with Windows.', settings: copy(settings) });
    Object.assign(settings, changes);
    console.debug('[stub] settings', copy(settings));
    return later(20, { ok: true, settings: copy(settings) });
  };

  window.kitsun = {
    getState: () => later(30, { accounts: copy(accounts), ui: copy(ui), status: copy(status), claudeInstalled: true }),
    showAccount: (id) => { if (isAccount(id)) showAccountHere(id); return later(10, copy(ui)); },
    setLayout: (name) => { if (typeof name === 'string' && Object.hasOwn(LAYOUTS, name)) setLayoutHere(name); return later(10, copy(ui)); },
    setSplit: (split) => { setLayoutHere(split === true && accounts.length > 1 ? 'split' : 'single'); return later(10, copy(ui)); },
    focusPane: (p) => {
      if (Number.isInteger(p) && p >= 0 && p < 3) ui = { ...ui, focused: p < paneCount() ? p : 0 };
      return later(10, copy(ui));
    },
    // Like main: only these two keys; a bad value changes nothing.
    setPaneRatios: (r) => {
      const keys = r && typeof r === 'object' ? Object.keys(r) : [];
      const split = 'splitRatio' in (r || {}) ? clampSplit(r.splitRatio) : ui.splitRatio;
      const okTriple = !('tripleRatios' in (r || {})) || validTriple(r.tripleRatios);
      if (!keys.length || keys.some((k) => k !== 'splitRatio' && k !== 'tripleRatios') || split === null || !okTriple) return later(10, copy(ui));
      const t = r.tripleRatios;
      ui = { ...ui, splitRatio: split, tripleRatios: t ? t.map((x) => x / (t[0] + t[1] + t[2])) : ui.tripleRatios };
      console.debug('[stub] ratios', ui.splitRatio, ui.tripleRatios);
      return later(10, copy(ui));
    },
    goHome: () => { ui = { ...ui, home: true }; return later(10, copy(ui)); },
    startAccount: (id) => {
      status[id] = st('starting');
      pushStatus();
      setTimeout(() => {
        status[id] = st('docked');
        const s = sample.find((x) => x.id === id);
        if (s) s.live = { ...s.live, status: 'docked', startedAt: Date.now(), memoryMB: 610 };
        pushStatus();
      }, 1500);
      return later(20, { ok: true });
    },
    restartHere: () => later(20, { ok: true }),
    // Like main: chromeProfile left out keeps it, null is automatic, anything else must be a listed profile.
    saveAccount: (a) => {
      const i = accounts.findIndex((x) => x.id === a.id);
      if ('chromeProfile' in a && a.chromeProfile !== null && !CHROME_PROFILES.some((p) => p.dir === a.chromeProfile)
        && !(i >= 0 && accounts[i].chromeProfile === a.chromeProfile)) return later(20, null);
      if (i >= 0) accounts[i] = { ...accounts[i], ...a }; else { accounts.push({ chromeProfile: null, ...a, main: false }); status[a.id] = st('starting'); }
      setTimeout(() => listeners.chrome.forEach((fn) => fn(chromeSample())), 50);
      return later(20, copy(accounts));
    },
    removeAccount: (id) => {
      const i = accounts.findIndex((x) => x.id === id);
      if (i >= 0) accounts.splice(i, 1);
      sanitizeUi();
      return later(20, { ok: true, accounts: copy(accounts), ui: copy(ui) });
    },
    finishSignIn: () => later(20, { ok: true }),
    sendPaneRects: (rects) => console.debug('[stub] pane rects', rects),
    setOverlay: (hidden) => console.debug('[stub] overlay', hidden),
    getSettings: () => later(20, { settings: copy(settings), canStartWithWindows: packaged }),
    setSettings,
    onOpenSettings: (fn) => listeners.openSettings.push(fn),
    onStatus: (fn) => listeners.status.push(fn),
    onUi: (fn) => listeners.ui.push(fn),
    getStats: () => later(250, { generatedAt: Date.now(), scanning, accounts: copy(sample) }),
    onStatsUpdated: (fn) => listeners.stats.push(fn),
    // Stop: a clean quit takes a moment; &stuck=1 acts like a Claude that doesn't quit (stillRunning, then force), and
    // &stuck=noask like one that couldn't be asked (no window yet: notAsked, then force).
    stopAccount: (id, force) => {
      if (!status[id] || !status[id].running) return later(20, { ok: false, error: 'It isn\'t running.' });
      if (params.get('stuck') === '1' && !force) return later(800, { ok: false, stillRunning: true, error: 'It didn\'t quit.' });
      if (params.get('stuck') === 'noask' && !force) return later(20, { ok: false, notAsked: true, reason: 'no window', error: 'It couldn\'t be asked to quit.' });
      status[id] = st('stopping');
      pushStatus();
      return later(1500, null).then(() => {
        status[id] = st('stopped', { exit: EXITS.stopped });
        pushStatus();
        return { ok: true };
      });
    },
    waitForAccount: (id) => { if (status[id]) status[id].frozen = false; pushStatus(); return later(10, { ok: true }); },
    // The real one asks in a native dialog first; here it just restarts.
    restartFrozen: (id) => { status[id] = st('starting'); pushStatus(); setTimeout(() => { status[id] = st('docked'); pushStatus(); }, 1500); return later(20, { ok: true }); },
    // Also a native dialog first in the real one; here it just stops it (forced).
    stopFrozen: (id) => { status[id] = st('stopped', { exit: EXITS.stopped }); pushStatus(); return later(20, { ok: true }); },
    onNotice: (fn) => listeners.notice.push(fn),
    onRequestStop: (fn) => listeners.requestStop.push(fn),
    getSessions: () => later(15, copy(sessionsSample)),
    onSessions: (fn) => listeners.sessions.push(fn),
    searchSessions: (text) => later(Number(params.get('searchdelay')) || 60, typeof text === 'string' && text.length <= 200 ? searchSample(text) : []),
    // Like main's openSession: shows the account; an archived session isn't sent to Claude (opened: false).
    openSession: (id, sessionId) => {
      const d = SEARCH_DOCS.find((x) => x.accountId === id && x.sessionId === sessionId);
      if (!d) return later(20, { ok: false, error: 'That session isn\'t there any more.' });
      showAccountHere(id);
      pushUi();
      return later(20, { ok: true, opened: !d.archived });
    },
    onOpenSwitcher: (fn) => listeners.openSwitcher.push(fn),
    // Like main's handoff:start (lib/handoff.js): ids only; both accounts must share the Claude Code folder; a session
    // mid-turn is refused. A running target needs a restart to list the new session; a stopped one starts with it open.
    startHandoff: (req) => {
      const keys = req && typeof req === 'object' && !Array.isArray(req) ? Object.keys(req).sort().join() : '';
      const from = req && accounts.find((a) => a.id === req.fromAccountId);
      const to = req && accounts.find((a) => a.id === req.toAccountId);
      if (keys !== 'fromAccountId,sessionId,toAccountId' || !from || !to || from === to || !/^local_[A-Za-z0-9-]{1,64}$/.test(req.sessionId)) return later(20, { ok: false });
      if (!from.shareCode || !to.shareCode) return later(200, { ok: false, error: `${to.name} uses its own Claude Code folder, so it can't read this conversation. Turn on "Share Claude Code settings" for both accounts.` });
      const title = sessionTitle(from.id, req.sessionId);
      if (!title) return later(200, { ok: false, error: `That session isn't in ${from.name} any more.` });
      if (((sessionsSample[from.id] || {}).items || []).some((it) => it.sessionId === req.sessionId && it.state === 'working')) {
        return later(200, { ok: false, error: `“${title}” is still working in ${from.name}. Wait for its turn to end (or stop it), then try again.` });
      }
      const sessionId = `local_h${++handoffSeq}-${Date.now().toString(36)}`;
      handoffsMade.set(sessionId, to.id);
      SEARCH_DOCS.push(doc(to.id, sessionId, title, '', 0, ''));
      console.debug('[stub] handoff', req, '->', sessionId);
      const s = status[to.id] || {};
      if (s.status === 'external') return later(600, { ok: true, sessionId, title, needsRestart: true, canRestart: false });
      if (s.status !== 'stopped') return later(600, { ok: true, sessionId, title, needsRestart: true, canRestart: true });
      window.kitsun.startAccount(to.id);
      showAccountHere(to.id);
      pushUi();
      return later(600, { ok: true, sessionId, title, started: true, opened: true });
    },
    // Like main's handoff:restart: only for a session startHandoff made there; a clean quit (&stuck=1: it won't), then a start.
    restartForHandoff: async (id, sessionId) => {
      if (handoffsMade.get(sessionId) !== id) return { ok: false };
      if (status[id] && status[id].running) {
        const r = await window.kitsun.stopAccount(id, false);
        if (!r.ok) return r;
      }
      window.kitsun.startAccount(id);
      showAccountHere(id);
      pushUi();
      return later(200, { ok: true, opened: true });
    },
    getChrome: () => later(40, chromeSample()),
    onChrome: (fn) => listeners.chrome.push(fn),
    // Like main's openChrome: nothing is started here.
    openChrome: (id) => {
      const s = chromeSample();
      const a = accounts.find((x) => x.id === id);
      if (!a) return later(20, { ok: false });
      if (!s.installed) return later(20, { ok: false, error: 'Google Chrome isn\'t installed on this PC.' });
      const link = s.accounts[id].link;
      if (!link) return later(20, { ok: false, unlinked: true, error: `No Chrome profile is linked to ${a.name} yet. Sign in to Claude in Chrome with it, or pick a profile in its settings.` });
      console.debug('[stub] chrome --profile-directory=', link.dir);
      return later(20, { ok: true, profile: link.name });
    },
  };

  // Ctrl+Alt+0 is a global shortcut in the real app (main pushes ui); mimic it here.
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && e.key === '0') {
      ui = { ...ui, home: true };
      pushUi();
    }
    // Ctrl+Alt+1–9 fills the active pane with that account.
    if (e.ctrlKey && e.altKey && /^[1-9]$/.test(e.key) && accounts[Number(e.key) - 1]) {
      e.preventDefault();
      showAccountHere(accounts[Number(e.key) - 1].id);
      pushUi();
    }
    // Ctrl+Alt+K: main sends 'open-switcher'.
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); listeners.openSwitcher.forEach((fn) => fn()); }
  });

  // &switcher=<text> opens the quick switcher with that text typed (empty for none); &move=N then presses ↓ N times.
  if (params.has('switcher')) {
    setTimeout(() => {
      window.openSwitcher(params.get('switcher'));
      const n = Number(params.get('move')) || 0;
      setTimeout(() => {
        const input = document.getElementById('sw-input');
        for (let i = 0; i < n; i++) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      }, 300);
    }, 500);
  }

  // &hint=1 fills the title-bar hint as hovering a tab would (headless screenshots can't hover).
  if (params.get('hint') === '1') setTimeout(() => { document.getElementById('hint').textContent = 'Storefront Ops · Ctrl+Alt+9 · right-click to edit'; }, 400);

  // &dialog=settings opens Settings the way the tray menu does (main sends 'open-settings').
  if (params.get('dialog') === 'settings') setTimeout(() => listeners.openSettings.forEach((fn) => fn()), 400);
  // &dialog=account opens Personal's account dialog (right-click on its tab), which has Stop while it runs;
  // &dialog=stop asks to stop Personal the way the tray menu's Stop item does.
  // &for=<name> opens that account's dialog instead (e.g. &for=Studio).
  if (params.get('dialog') === 'account') {
    setTimeout(() => {
      const tab = [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes(params.get('for') || 'Personal'));
      if (tab) tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    }, 400);
  }
  if (params.get('dialog') === 'stop') setTimeout(() => listeners.requestStop.forEach((fn) => fn('personal')), 400);

  // &notice=update|frozen|reopened|needs|limit|reset shows the toast main sends for that event (needs and limit have a button).
  const NOTICES = {
    update: { text: 'Claude updated to 4.4212 · reopened Personal and Studio' },
    frozen: { text: 'Personal isn\'t responding' },
    reopened: { text: 'Studio\'s Claude closed unexpectedly · reopened it' },
    needs: { text: 'Personal needs you · Teashop: Wants to use Bash · and 1 more', id: 'personal', action: { label: 'Show', id: 'personal' } },
    limit: { text: 'Work is at 92% of its 5-hour limit · Personal has the most left (at 22%)', id: 'personal', action: { label: 'Switch', id: 'personal' } },
    reset: { text: 'Work\'s 5-hour limit has reset', id: 'work' },
  };
  const notice = NOTICES[params.get('notice')];
  if (notice) setTimeout(() => listeners.notice.forEach((fn) => fn({ id: null, action: null, ...notice, kind: params.get('notice') })), 500);

  // &openchrome=<id> presses that account's Chrome button on its home card (its toast shows the result).
  if (params.get('openchrome')) {
    setTimeout(() => {
      const card = [...document.querySelectorAll('.acard')].find((c) => c.querySelector('h3').textContent === (accounts.find((a) => a.id === params.get('openchrome')) || {}).name);
      if (card) card.querySelector('.chrome-btn').click();
    }, 1500);
  }

  // &menu=layout opens the title bar's layout menu. &drag=<k>:<dx> drags divider k by dx px with the pointer
  // (&drag=0:-200:hold keeps the button down, to see the dragging look); &dblclick=<k> double-clicks divider k.
  if (params.get('menu') === 'layout') setTimeout(() => document.getElementById('split').click(), 500);
  if (params.get('drag')) {
    const [k, dx, hold] = params.get('drag').split(':');
    setTimeout(() => {
      const d = document.querySelectorAll('.divider')[Number(k)];
      if (!d) return;
      const r = d.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const ev = (type, cx, buttons) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, button: 0, buttons, clientX: cx, clientY: y, isPrimary: true });
      d.dispatchEvent(ev('pointerdown', x, 1));
      for (let s = 1; s <= 10; s++) window.dispatchEvent(ev('pointermove', x + (Number(dx) * s) / 10, 1));
      if (hold !== 'hold') window.dispatchEvent(ev('pointerup', x + Number(dx), 0));
    }, 600);
  }
  if (params.get('dblclick')) setTimeout(() => { const d = document.querySelectorAll('.divider')[Number(params.get('dblclick'))]; if (d) d.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); }, 600);
  // &handoff=menu presses "Continue in…" on the first recent session of Work's home card (&from=<id> for another card);
  // =confirm then picks &to=<name> (default: the first account it can go to); =restart presses Continue in that
  // confirmation (a running target then asks to restart); =done presses Restart too. =switcher opens the switcher with
  // "spend" typed and presses Ctrl+Enter on the chosen session.
  const handoffStep = params.get('handoff');
  if (handoffStep) {
    const click = (sel) => { const n = typeof sel === 'string' ? document.querySelector(sel) : sel; if (n) n.click(); return Boolean(n); };
    const steps = ['menu', 'confirm', 'restart', 'done'];
    const upTo = steps.indexOf(handoffStep);
    const pickTarget = () => {
      const items = [...document.querySelectorAll('#handoff-list .menu-item')];
      const want = params.get('to');
      return want ? items.find((n) => n.textContent.startsWith(want)) : items.find((n) => n.getAttribute('aria-disabled') !== 'true');
    };
    const run = async () => {
      if (handoffStep === 'switcher') {
        window.openSwitcher('spend');
        await later(400);
        document.getElementById('sw-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
        return;
      }
      const fromName = (accounts.find((a) => a.id === (params.get('from') || picked[0].id)) || {}).name;
      const card = [...document.querySelectorAll('.acard')].find((c) => c.querySelector('h3').textContent === fromName);
      if (!card || !click(card.querySelector('.handoff-btn')) || upTo < 1) return;
      await later(200);
      if (!click(pickTarget()) || upTo < 2) return;
      await later(200);
      if (!click('#confirm-ok') || upTo < 3) return;
      await later(1200);
      click('#confirm-ok');
    };
    setTimeout(run, 1500);
  }

  // For checks from the browser's console: what main would hold now.
  window.kitsunStub = { ui: () => copy(ui), status: () => copy(status) };

  // With &scan=1 the first pass "finishes" after a few seconds.
  if (scanFirst && mode !== 'empty') setTimeout(() => { scanning = false; listeners.stats.forEach((fn) => fn()); }, 4000);
})();
