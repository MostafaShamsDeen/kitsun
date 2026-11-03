// Home screen: a dashboard of every account, shown in place of the panes while ui.home is true.
// The main process hides all Claude windows then, so everything drawn here is visible.
// Loaded after app.js and uses its globals (api, el, accounts, status, show, openAccountDialog, openSwitcher,
// chromeInfo, openChrome, SW_ICONS, openHandoffMenu, handoffIcon).

const Home = (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const REFRESH_MS = 20000;
  const GAP = 2; // surface gap between touching marks (stacked segments, donut slices)
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // heatmap rows run Mon..Sun; the stats matrix starts on Sunday

  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = () => motionQuery.matches;

  let root = null;          // the whole home view, built once and re-attached on each visit (canvas and charts survive)
  let refs = {};            // nodes that get updated in place
  let cardRefs = new Map(); // account id -> live-status nodes of its card (the cheap onStatus path)
  let sky = null;           // the hero's canvas animation
  let shown = false;
  let stats = null;
  let timer = 0;
  let fetchSeq = 0;
  let builtKey = null;      // account ids of the last full paint; a change replays the entrance animations
  let builtSig = null;      // ids + names + colours of the last full paint
  let skySig = null;
  let tableView = false;
  let chartsWidth = 0;
  let entranceUntil = 0;    // a repaint before this would cut the entrance animations short

  // ---------- small helpers ----------

  function svg(tag, attrs = {}, children = []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'text') node.textContent = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) if (c != null) node.append(c);
    return node;
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const sum = (arr) => arr.reduce((s, v) => s + (v || 0), 0);
  // Two frames: the first lets the browser lay out the start state, so a CSS transition runs from it.
  const afterPaint = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));

  const intFmt = new Intl.NumberFormat();
  const int = (n) => intFmt.format(Math.round(n || 0));

  // 950 / 1.2k / 34k / 3.4M
  function compact(n) {
    n = Math.max(0, Math.round(n || 0));
    if (n < 1000) return String(n);
    for (const [v, unit] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']]) {
      if (n >= v * 0.9995) {
        const x = n / v;
        return `${x >= 100 ? Math.round(x) : x.toFixed(1).replace(/\.0$/, '')}${unit}`;
      }
    }
    return String(n);
  }
  const count = (n) => (n >= 10000 ? compact(n) : int(n));

  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  function uptime(startedAt) {
    const m = Math.max(0, Math.floor((Date.now() - startedAt) / 60000));
    const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
    if (d) return `up ${d}d ${h}h`;
    if (h) return `up ${h}h ${m % 60}m`;
    return `up ${m}m`;
  }

  function memory(mb) {
    if (mb == null) return '—';
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
  }

  // claude-opus-5-5 -> Opus 5.5; claude-sonnet-4-5-20250929 -> Sonnet 4.5
  function modelName(id) {
    const parts = String(id || '').replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-');
    const words = parts.filter((p) => !/^\d+$/.test(p));
    const nums = parts.filter((p) => /^\d+$/.test(p));
    const word = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    return [word, nums.join('.')].filter(Boolean).join(' ');
  }

  function greeting() {
    const h = new Date().getHours();
    if (h >= 5 && h < 12) return 'Good morning';
    if (h >= 12 && h < 18) return 'Good afternoon';
    return 'Good evening';
  }

  function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function parseDay(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d, 12);
  }

  // Count a number up (or tween it to a new value) in a text node.
  function countTo(node, from, to, fmt, animate) {
    cancelAnimationFrame(node._tween || 0);
    if (!animate || reduced() || from === to) { node.textContent = fmt(to); return; }
    const t0 = performance.now();
    const dur = from === 0 ? 1100 : 600;
    const step = (now) => {
      // A frame's timestamp can be slightly earlier than t0, which would briefly show a negative number.
      const k = Math.min(1, Math.max(0, (now - t0) / dur));
      const e = 1 - Math.pow(1 - k, 3);
      node.textContent = fmt(from + (to - from) * e);
      if (k < 1) node._tween = requestAnimationFrame(step);
    };
    node._tween = requestAnimationFrame(step);
  }

  // ---------- data ----------

  function normalise(s) {
    s = s || {};
    const live = { status: 'stopped', startedAt: null, memoryMB: null, codeSessionsOpen: 0, ...(s.live || {}) };
    const sessions = { total: 0, archived: 0, active7d: 0, turns: 0, lastActivityAt: null, recent: [], topFolders: [], models: [], ...(s.sessions || {}) };
    const act = s.activity || {};
    const totals = { prompts7d: 0, outputTokens7d: 0, promptsAll: 0, outputTokensAll: 0, ...(act.totals || {}) };
    return { live, plan: s.plan || null, sessions, activity: { days: act.days || [], totals, hours: act.hours || [] } };
  }

  // The status pushed by onStatus is fresher than the stats snapshot.
  const liveStatusOf = (id, s) => (status[id] && status[id].status) || s.live.status || 'stopped';

  // The 14 local days the charts cover: the stats' own dates when present (the main process decides
  // what "today" is), otherwise computed here.
  function chartDays() {
    const first = ((stats && stats.accounts) || []).find((a) => a.activity && a.activity.days && a.activity.days.length);
    if (first) return first.activity.days.map((d) => d.date);
    const out = [];
    const now = new Date();
    for (let i = 13; i >= 0; i--) out.push(ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12)));
    return out;
  }

  // Accounts in tab order (names and colours from the app, which an edit updates first), with their stats.
  function view() {
    const byStat = new Map(((stats && stats.accounts) || []).map((s) => [s.id, s]));
    const days = chartDays();
    return accounts.map((a) => {
      const s = normalise(byStat.get(a.id));
      const perDay = new Map(s.activity.days.map((d) => [d.date, d]));
      return {
        ...s, id: a.id, name: a.name, color: a.color, main: Boolean(a.main), account: a,
        state: liveStatusOf(a.id, s),
        daily: days.map((d) => (perDay.get(d) || {}).prompts || 0),
      };
    });
  }

  const sigOf = () => accounts.map((a) => `${a.id}:${a.name}:${a.color}`).join('|');
  const keyOf = () => accounts.map((a) => a.id).join('|');

  // ---------- tooltip (one, shared; values lead, labels follow) ----------

  const tip = {
    node: null,
    show(anchor, children) {
      if (!this.node) { this.node = el('div', { class: 'home-tip', role: 'tooltip' }); document.body.append(this.node); }
      const t = this.node;
      t.replaceChildren(...children);
      t.classList.add('show');
      const r = t.getBoundingClientRect();
      let x = anchor.x - r.width / 2;
      let y = anchor.y - r.height - 10;
      if (y < 48) y = anchor.y + 14; // no room above (title bar): flip below
      x = clamp(x, 8, innerWidth - r.width - 8);
      y = clamp(y, 8, innerHeight - r.height - 8);
      t.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    },
    hide() { if (this.node) this.node.classList.remove('show'); },
  };

  function tipHead(text) { return el('div', { class: 'tt-head', text }); }
  function tipRow(color, value, name) {
    return el('div', { class: 'tt-row' }, [
      color ? el('i', { class: 'tt-key', style: `--c:${color}` }) : el('i', { class: 'tt-key blank' }),
      el('b', { class: 'tt-val', text: value }),
      el('span', { class: 'tt-name', text: name }),
    ]);
  }

  // ---------- hero canvas: a slow constellation, one glowing cluster per account ----------

  function makeSky(canvas) {
    const ctx = canvas.getContext('2d');
    let w = 0, h = 0, dpr = 1, raf = 0, last = 0, lastT = 0;
    let active = false, inView = true;
    let orbs = [];
    const mouse = { x: 0, y: 0, tx: 0, ty: 0 }; // pointer offset from the centre, -1..1, eased
    const sprites = new Map();

    function rgb(hex) {
      const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
      const n = m ? parseInt(m[1], 16) : 0x9b968c;
      return [n >> 16, (n >> 8) & 255, n & 255];
    }

    // A pre-rendered glow per colour: drawing a bitmap is far cheaper than a gradient per orb per frame.
    function sprite(hex) {
      if (sprites.has(hex)) return sprites.get(hex);
      const [r, g, b] = rgb(hex);
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const x = c.getContext('2d');
      const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, `rgba(${r},${g},${b},1)`);
      gr.addColorStop(0.16, `rgba(${r},${g},${b},.8)`);
      gr.addColorStop(0.42, `rgba(${r},${g},${b},.16)`);
      gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
      x.fillStyle = gr;
      x.fillRect(0, 0, 64, 64);
      sprites.set(hex, c);
      return c;
    }

    function rng(seed) {
      return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    function hash(s) {
      let x = 2166136261;
      for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
      return x >>> 0;
    }

    // list: [{ id, color, weight }] with weights summing to 1 (more active -> more and larger orbs).
    function seed(list) {
      orbs = [];
      const n = list.length;
      if (!n) { paintStatic(); return; }
      const rand = rng(hash(list.map((a) => a.id).join('|')));
      const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-6)) * Math.cos(2 * Math.PI * rand());
      const budget = 60;
      const big = n <= 6 ? 1 : 0; // one soft bokeh disc per account while there is room
      const base = Math.max(2, Math.min(4, Math.floor(budget / n) - big));
      const spare = Math.max(0, budget - n * (base + big));
      list.forEach((a, i) => {
        const share = a.weight;
        const small = base + Math.round(spare * share);
        const cx = (i + 0.5) / n + (rand() - 0.5) * 0.08;
        const cy = 0.32 + rand() * 0.36;
        const spread = 0.05 + 0.07 * Math.min(1, share * n * 0.7);
        const color = a.color;
        const tint = rgb(color).join(',');
        for (let k = 0; k < small + big; k++) {
          const isBig = k >= small;
          orbs.push({
            color, tint, big: isBig,
            hx: cx + gauss() * spread, hy: cy + gauss() * spread * 1.6,
            r: isBig ? 16 + rand() * 18 * (0.6 + share) : (1.3 + rand() * 2.2) * (0.85 + share * 0.8),
            z: isBig ? 0.2 + rand() * 0.2 : 0.35 + rand() * 0.65,
            ax: 6 + rand() * 22, ay: 4 + rand() * 14,
            sx: 0.05 + rand() * 0.13, sy: 0.04 + rand() * 0.11,
            p: rand() * Math.PI * 2,
            a: isBig ? 0.09 + rand() * 0.06 : 0.45 + rand() * 0.45,
            x: 0, y: 0,
          });
        }
      });
      if (orbs.length > budget) orbs.length = budget;
      paintStatic();
    }

    function resize() {
      const nw = canvas.clientWidth, nh = canvas.clientHeight;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      if (nw === w && nh === h && canvas.width === Math.round(nw * dpr)) return;
      w = nw; h = nh;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      paintStatic();
    }

    function draw(t) {
      lastT = t;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!w || !h) return;
      mouse.x += (mouse.tx - mouse.x) * 0.05;
      mouse.y += (mouse.ty - mouse.y) * 0.05;
      for (const o of orbs) {
        // Nearer orbs (bigger z) lean further toward the pointer: a cheap parallax.
        o.x = o.hx * w + Math.sin(t * o.sx + o.p) * o.ax + mouse.x * o.z * 22;
        o.y = o.hy * h + Math.cos(t * o.sy + o.p * 1.3) * o.ay + mouse.y * o.z * 14;
      }
      const reach = clamp(w / 8, 80, 150);
      const reach2 = reach * reach;
      ctx.lineWidth = 1;
      for (let i = 0; i < orbs.length; i++) {
        const a = orbs[i];
        if (a.big) continue;
        for (let j = i + 1; j < orbs.length; j++) {
          const b = orbs[j];
          if (b.big) continue;
          const dx = a.x - b.x, dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > reach2) continue;
          const alpha = (1 - Math.sqrt(d2) / reach) * 0.22 * Math.min(a.z, b.z);
          ctx.strokeStyle = `rgba(${a.tint},${alpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
      ctx.globalCompositeOperation = 'lighter';
      for (const o of orbs) {
        const size = o.big ? o.r * 2.6 : o.r * 7;
        ctx.globalAlpha = o.a * (o.big ? 1 : 0.8 + 0.2 * Math.sin(t * 0.9 + o.p * 3));
        ctx.drawImage(sprite(o.color), o.x - size / 2, o.y - size / 2, size, size);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (now - last < 33) return; // ~30 fps is plenty for something this slow
      last = now;
      draw(now / 1000);
    }

    const running = () => active && inView && !document.hidden && !reduced() && orbs.length > 0;

    function update() {
      if (running()) { if (!raf) raf = requestAnimationFrame(frame); return; }
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    }

    // Reduced motion, or paused: one still frame (re-centred pointer) so the hero isn't empty.
    function paintStatic() {
      if (running()) return;
      mouse.x = mouse.tx; mouse.y = mouse.ty;
      if (reduced()) { mouse.x = mouse.y = mouse.tx = mouse.ty = 0; }
      draw(lastT);
    }

    new ResizeObserver(resize).observe(canvas);
    new IntersectionObserver((entries) => { inView = entries[entries.length - 1].isIntersecting; update(); }).observe(canvas);
    document.addEventListener('visibilitychange', update);
    motionQuery.addEventListener('change', () => { update(); paintStatic(); });

    return {
      seed,
      start() { active = true; resize(); update(); paintStatic(); },
      stop() { active = false; update(); },
      pointer(e) {
        const r = canvas.getBoundingClientRect();
        if (!r.width || reduced()) return;
        mouse.tx = clamp(((e.clientX - r.left) / r.width - 0.5) * 2, -1, 1);
        mouse.ty = clamp(((e.clientY - r.top) / r.height - 0.5) * 2, -1, 1);
      },
    };
  }

  function seedSky(list) {
    const weights = list.map((v) => v.activity.totals.prompts7d || 0);
    const total = sum(weights);
    sky.seed(list.map((v, i) => ({ id: v.id, color: v.color, weight: total ? weights[i] / total : 1 / list.length })));
  }

  // ---------- skeleton ----------

  const TILES = [
    { key: 'running', label: 'Accounts running' },
    { key: 'code', label: 'Claude Code sessions open' },
    { key: 'prompts', label: 'Prompts · last 7 days' },
    { key: 'tokens', label: 'Output tokens · last 7 days' },
    { key: 'memory', label: 'Memory in use' },
  ];

  function build() {
    const canvas = el('canvas', { class: 'hero-canvas', 'aria-hidden': 'true' });
    refs.greet = el('h1');
    refs.date = el('p', { class: 'hero-date' });
    refs.tiles = {};
    const tiles = el('div', { class: 'tiles' }, TILES.map((t) => {
      const value = el('span', { class: 'num', text: '—' });
      const suffix = el('small');
      const sub = el('div', { class: 'tile-sub' });
      refs.tiles[t.key] = { value, suffix, sub, current: 0 };
      return el('div', { class: 'tile' }, [el('div', { class: 'tile-label', text: t.label }), el('div', { class: 'tile-value' }, [value, suffix]), sub]);
    }));
    // Search lives in the quick switcher (app.js); this box only opens it, carrying over what was typed.
    const searchInput = el('input', {
      type: 'text', placeholder: 'Search sessions in every account', 'aria-label': 'Search sessions in every account',
      spellcheck: 'false', autocomplete: 'off', 'aria-haspopup': 'dialog',
      oninput: (e) => { const v = e.target.value; e.target.value = ''; openSwitcher(v); },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); openSwitcher(''); } },
    });
    const searchBox = el('label', { class: 'home-search', onclick: (e) => { e.preventDefault(); openSwitcher(''); } }, [
      svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [svg('circle', { cx: 10.5, cy: 10.5, r: 6 }), svg('path', { d: 'M15 15l5 5' })]),
      searchInput,
      el('kbd', { text: 'Ctrl+Alt+K' }),
    ]);
    const hero = el('section', { class: 'hero' }, [
      canvas,
      el('div', { class: 'hero-top' }, [el('div', { class: 'hero-text' }, [refs.greet, refs.date]), searchBox]),
      tiles,
    ]);

    refs.cards = el('div', { class: 'cards' }, [el('p', { class: 'muted loading', text: 'Loading your accounts…' })]);
    refs.scan = el('span', { class: 'scan', hidden: true }, [el('i'), el('span', { text: 'Counting messages in your chat history…' })]);
    refs.tableBtn = el('button', {
      class: 'btn ghost small', type: 'button', 'aria-pressed': 'false', text: 'Show as tables',
      onclick: () => {
        tableView = !tableView;
        refs.tableBtn.setAttribute('aria-pressed', String(tableView));
        refs.tableBtn.textContent = tableView ? 'Show as charts' : 'Show as tables';
        renderCharts(view(), false);
      },
    });
    refs.charts = el('div', { class: 'charts' });

    // Sessions waiting for the person, across accounts; only there while some are (renderNeeds).
    refs.needs = el('section', { class: 'needs', hidden: true, 'aria-label': 'Sessions that need you' });

    root = el('div', { class: 'home', id: 'home-view' }, [
      el('div', { class: 'home-inner' }, [
        refs.needs,
        hero,
        el('section', { class: 'home-section' }, [
          el('div', { class: 'section-head' }, [
            el('h2', { text: 'Accounts' }),
            el('span', { class: 'note', text: 'Right-click a card to edit it' }),
          ]),
          refs.cards,
        ]),
        el('section', { class: 'home-section' }, [
          el('div', { class: 'section-head' }, [el('h2', { text: 'Activity' }), refs.scan, el('span', { class: 'spacer' }), refs.tableBtn]),
          refs.charts,
        ]),
      ]),
    ]);

    root.addEventListener('pointermove', (e) => sky.pointer(e));
    root.addEventListener('scroll', () => tip.hide(), { passive: true });
    sky = makeSky(canvas);

    // Charts are drawn at their real pixel width, so redraw (without animation) when that changes.
    new ResizeObserver(() => {
      const w = refs.charts.clientWidth;
      if (!shown || !stats || Math.abs(w - chartsWidth) < 2) return;
      chartsWidth = w;
      requestAnimationFrame(() => renderCharts(view(), false));
    }).observe(refs.charts);
  }

  // ---------- hero ----------

  function renderHero(list, animate) {
    refs.greet.textContent = greeting();
    const now = new Date();
    const running = list.filter((v) => v.state === 'docked' || v.state === 'external').length;
    const lastAt = Math.max(0, ...list.map((v) => v.sessions.lastActivityAt || 0));
    refs.date.textContent = [
      now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
      `${list.length} account${list.length === 1 ? '' : 's'}`,
      stats && lastAt ? `last prompt ${ago(lastAt)}` : null,
    ].filter(Boolean).join(' · ');

    setTile('running', running, int, animate, ` of ${list.length}`,
      list.some((v) => v.state === 'starting') ? `${list.filter((v) => v.state === 'starting').length} starting` : 'right now');
    if (!stats) return;
    const memValues = list.map((v) => v.live.memoryMB).filter((m) => m != null);
    setTile('code', sum(list.map((v) => v.live.codeSessionsOpen)), int, animate, '', 'across all accounts');
    const today = sum(list.map((v) => v.daily[v.daily.length - 1]));
    setTile('prompts', sum(list.map((v) => v.activity.totals.prompts7d)), count, animate, '', `${int(today)} today`);
    setTile('tokens', sum(list.map((v) => v.activity.totals.outputTokens7d)), compact, animate, '',
      `${compact(sum(list.map((v) => v.activity.totals.outputTokensAll)))} all time`);
    if (memValues.length) {
      setTile('memory', sum(memValues), memory, animate, '', `${memValues.length} Claude cop${memValues.length === 1 ? 'y' : 'ies'}`);
    } else {
      setTile('memory', null, memory, false, '', 'nothing running');
    }
  }

  function setTile(key, value, fmt, animate, suffix, sub) {
    const t = refs.tiles[key];
    t.suffix.textContent = suffix;
    t.sub.textContent = sub || '';
    if (value == null) { cancelAnimationFrame(t.value._tween || 0); t.value.textContent = '—'; t.current = 0; return; }
    // Entrance: count up from zero. Refresh: glide from the old value (or jump with reduced motion).
    countTo(t.value, animate ? 0 : t.current, value, fmt, animate || t.value.textContent !== '—');
    t.current = value;
  }

  // ---------- account cards ----------

  const PILLS = {
    docked: ['live', 'Live'],
    starting: ['starting', 'Starting'],
    stopped: ['stopped', 'Stopped'],
    external: ['external', 'Open outside Multi Claude'],
    stopping: ['stopping', 'Stopping'],
  };

  function ring(pct, color, label, animate) {
    const R = 24, C = 2 * Math.PI * R;
    const p = clamp(pct || 0, 0, 100);
    const len = (p / 100) * C;
    const arc = p > 0 ? svg('circle', {
      class: `ring-arc${animate ? ' sweep' : ''}`, cx: 30, cy: 30, r: R, fill: 'none', stroke: color, 'stroke-width': 6,
      'stroke-linecap': 'round', 'stroke-dasharray': `${animate ? 0 : len} ${C}`, transform: 'rotate(-90 30 30)',
    }) : null;
    if (arc && animate && !reduced()) afterPaint(() => arc.setAttribute('stroke-dasharray', `${len} ${C}`));
    else if (arc) arc.setAttribute('stroke-dasharray', `${len} ${C}`);
    return el('div', { class: 'gauge' }, [
      svg('svg', { viewBox: '0 0 60 60', role: 'img', 'aria-label': `${label}: ${Math.round(p)}% used` }, [
        svg('circle', { class: 'ring-track', cx: 30, cy: 30, r: R, fill: 'none', 'stroke-width': 6 }),
        arc,
        svg('text', { class: 'ring-val', x: 30, y: 34.5, 'text-anchor': 'middle', text: `${Math.round(p)}%` }),
      ]),
      el('span', { class: 'ring-label', text: label }),
    ]);
  }

  // Weekly plan usage over the last 7 days: one series, so the title names it and there is no legend.
  function sparkline(history, color) {
    const pts = (history || []).filter((s) => s && s.t && s.sd != null);
    const box = el('div', { class: 'spark' });
    const nowPct = pts.length ? Math.round(pts[pts.length - 1].sd) : null;
    box.append(el('div', { class: 'spark-title' }, [
      el('span', { text: 'Weekly usage · 7 days' }),
      nowPct != null ? el('b', { text: `${nowPct}%` }) : null,
    ]));
    if (pts.length < 2) {
      box.append(el('div', { class: 'spark-empty muted', text: 'Not enough history yet' }));
      return box;
    }
    // Drawn in a 0..100 box stretched to the plot; the line keeps 2px (non-scaling stroke) and the
    // dots are HTML so they stay round.
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
    const xs = pts.map((s) => ((s.t - t0) / Math.max(1, t1 - t0)) * 100);
    const ys = pts.map((s) => 100 - clamp(s.sd, 0, 100));
    const line = pts.map((_, i) => `${i ? 'L' : 'M'}${xs[i].toFixed(2)},${ys[i].toFixed(2)}`).join(' ');
    const plot = el('div', { class: 'spark-plot', tabindex: '0', 'aria-label': `Weekly usage over the last 7 days, now ${nowPct}%` });
    plot.append(
      svg('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' }, [
        svg('line', { class: 'spark-grid', x1: 0, x2: 100, y1: 0, y2: 0, 'vector-effect': 'non-scaling-stroke' }),
        svg('line', { class: 'spark-base', x1: 0, x2: 100, y1: 100, y2: 100, 'vector-effect': 'non-scaling-stroke' }),
        svg('path', { d: `${line} L100,100 L0,100 Z`, fill: color, 'fill-opacity': 0.1 }),
        svg('path', { d: line, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }),
      ]),
      el('span', { class: 'spark-dot', style: `left:100%;top:${ys[ys.length - 1]}%;--c:${color}` }),
    );
    const cross = el('span', { class: 'spark-cross' });
    const hoverDot = el('span', { class: 'spark-dot hover', style: `--c:${color}` });
    plot.append(cross, hoverDot);
    const showAt = (i) => {
      const s = pts[i];
      cross.style.left = hoverDot.style.left = `${xs[i]}%`;
      hoverDot.style.top = `${ys[i]}%`;
      plot.classList.add('hovering');
      const r = plot.getBoundingClientRect();
      const when = new Date(s.t);
      tip.show({ x: r.left + (xs[i] / 100) * r.width, y: r.top + (ys[i] / 100) * r.height }, [
        tipHead(`${DAY_NAMES[when.getDay()]} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`),
        tipRow(color, `${Math.round(s.sd)}%`, 'of the weekly limit'),
        s.fh != null ? tipRow(null, `${Math.round(s.fh)}%`, 'of the 5-hour limit') : null,
      ].filter(Boolean));
    };
    // The crosshair snaps to the nearest sample, so the pointer only has to be near the right time.
    plot.addEventListener('pointermove', (e) => {
      const r = plot.getBoundingClientRect();
      const fx = ((e.clientX - r.left) / r.width) * 100;
      let best = 0;
      xs.forEach((x, i) => { if (Math.abs(x - fx) < Math.abs(xs[best] - fx)) best = i; });
      showAt(best);
    });
    plot.addEventListener('focus', () => showAt(pts.length - 1));
    const leave = () => { plot.classList.remove('hovering'); tip.hide(); };
    plot.addEventListener('pointerleave', leave);
    plot.addEventListener('blur', leave);
    box.append(plot);
    return box;
  }

  function fillLive(r, v) {
    const [cls, text] = PILLS[v.state] || PILLS.stopped;
    r.pill.className = `pill ${cls}`;
    r.pillText.textContent = text;
    const up = (v.state === 'docked' || v.state === 'external') && v.live.startedAt ? uptime(v.live.startedAt) : null;
    const mem = (v.state === 'docked' || v.state === 'external') && v.live.memoryMB != null ? memory(v.live.memoryMB) : null;
    const code = v.live.codeSessionsOpen ? `${v.live.codeSessionsOpen} Code session${v.live.codeSessionsOpen === 1 ? '' : 's'} open` : null;
    const att = sessions[v.id] || {};
    const working = att.working ? `${att.working} working` : null;
    // A stopped copy says why it closed (closedText() in app.js), e.g. "Closed for a Claude update · reopening…".
    r.meta.textContent = v.state === 'stopped' ? closedText(v.account, (status[v.id] || {}).exit).short
      : [up, mem, code, working].filter(Boolean).join(' · ') || 'Running';
    // "2 need you" (Claude is waiting), or "3 new" (turns that finished while nobody looked).
    r.needs.hidden = !att.waiting && !att.unseen;
    r.needs.className = `needs-pill${att.waiting ? ' waiting' : ''}`;
    r.needs.textContent = att.waiting ? `${att.waiting} need${att.waiting === 1 ? 's' : ''} you` : att.unseen ? `${att.unseen} new` : '';
    r.needs.dataset.hint = att.waiting ? 'Claude Code sessions waiting for your answer or permission' : 'Claude Code turns that finished while you were elsewhere';
    fillChrome(r, v);
    const stopped = v.state === 'stopped';
    r.action.textContent = stopped ? 'Start' : 'Open';
    r.action.setAttribute('aria-label', `${stopped ? 'Start' : 'Open'} ${v.name}`);
    r.action.dataset.mode = stopped ? 'start' : 'open';
  }

  // "Chrome: Studio Labs" opens that Chrome profile; with none linked, the button opens the account's settings to pick one.
  function fillChrome(r, v) {
    r.chrome.hidden = !chromeInfo.installed;
    const link = (chromeInfo.accounts[v.id] || {}).link;
    r.chromeText.textContent = `Chrome: ${link ? link.name : 'not linked'}`;
    r.chrome.classList.toggle('unlinked', !link);
    r.chrome.setAttribute('aria-label', link ? `Open ${v.name}'s Chrome profile, ${link.name}` : `Choose a Chrome profile for ${v.name}`);
    r.chrome.dataset.hint = link
      ? `Open Chrome as ${link.name}${link.manual ? ' (picked in its settings)' : ' (its Claude in Chrome is signed in here)'}`
      : `No Chrome profile is signed in to ${v.name}'s Claude in Chrome · click to pick one`;
  }

  function mini(value, label) {
    return el('div', { class: 'mini' }, [el('b', { text: value }), el('span', { text: label })]);
  }

  function card(v, idx, animate) {
    const r = {};
    r.pillText = el('span');
    r.pill = el('span', { class: 'pill' }, [el('i'), r.pillText]);
    r.needs = el('span', { class: 'needs-pill', hidden: true });
    r.meta = el('div', { class: 'acard-meta' });
    r.action = el('button', {
      class: 'btn primary', type: 'button',
      onclick: async (e) => {
        const b = e.currentTarget;
        if (b.dataset.mode === 'start') { b.disabled = true; await api.startAccount(v.id); }
        show(v.id);
      },
    });
    r.chromeText = el('span');
    r.chrome = el('button', {
      class: 'btn ghost chrome-btn', type: 'button',
      onclick: () => {
        const a = byId(v.id);
        if (!a) return;
        if ((chromeInfo.accounts[a.id] || {}).link) openChrome(a); else openAccountDialog(a);
      },
    }, [svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [svg('path', { d: SW_ICONS.chrome })]), r.chromeText]);

    const s = v.sessions;
    const plan = v.plan;
    let usage;
    if (plan) {
      const stale = plan.asOf && Date.now() - plan.asOf > 30 * 60000;
      usage = el('div', { class: 'usage' }, [
        el('div', { class: 'gauges' }, [
          ring(plan.fiveHour, v.color, '5-hour', animate),
          ring(plan.weekly, v.color, 'Weekly', animate),
        ]),
        sparkline(plan.history, v.color),
      ]);
      if (stale) usage = el('div', {}, [usage, el('div', { class: 'as-of muted', text: `Plan usage as of ${ago(plan.asOf)}` })]);
    } else {
      usage = el('div', { class: 'usage-empty muted' }, [el('span', { text: 'No usage data yet' })]);
    }

    const recent = (s.recent || []).slice(0, 3);
    const topModel = (s.models || [])[0];
    const node = el('article', {
      class: `acard${animate ? ' rise' : ''}`, style: `--acc:${v.color};${animate ? `animation-delay:${idx * 80}ms` : ''}`,
      // Looked up now, not when the card was built, so the dialog always shows the saved settings.
      oncontextmenu: (e) => { e.preventDefault(); const a = byId(v.id); if (a) openAccountDialog(a); },
    }, [
      el('header', { class: 'acard-head' }, [
        el('span', { class: 'dot' }),
        el('h3', { text: v.name }),
        v.main ? el('span', { class: 'tag', text: 'Main' }) : null,
        el('span', { class: 'spacer' }),
        r.needs,
        r.pill,
      ]),
      r.meta,
      usage,
      el('div', { class: 'minis' }, [
        mini(int(s.total), s.archived ? `sessions · ${int(s.archived)} archived` : 'sessions'),
        mini(int(s.active7d), 'active this week'),
        mini(count(s.turns), 'turns in total'),
        mini(count(v.activity.totals.prompts7d), 'prompts · 7 days'),
        mini(compact(v.activity.totals.outputTokens7d), 'output tokens · 7 days'),
        mini(s.lastActivityAt ? ago(s.lastActivityAt) : '—', 'last active'),
      ]),
      (s.topFolders || []).length ? el('div', { class: 'chips', 'aria-label': 'Top folders' }, s.topFolders.slice(0, 3).map((f) => el('span', { class: 'chip' }, [
        el('span', { text: f.name }), el('small', { text: String(f.sessions) }),
      ]))) : null,
      recent.length ? el('ul', { class: 'recent', 'aria-label': 'Recent sessions' }, recent.map((x) => el('li', {}, [
        el('div', { class: 'r1' }, [
          el('span', { class: 't', text: x.title || 'Untitled session' }),
          el('span', { class: 'ago', text: ago(x.lastActivityAt) }),
          // Carry the session on in another account (app.js; main checks the session id against its own index).
          x.sessionId && accounts.length > 1 ? el('button', {
            class: 'handoff-btn', type: 'button',
            'data-hint': 'Continue in another account', 'aria-label': `Continue “${x.title || 'Untitled session'}” in another account`,
            onclick: (e) => openHandoffMenu({ accountId: v.id, sessionId: x.sessionId, title: x.title || 'Untitled session' }, e.currentTarget),
          }, [handoffIcon()]) : null,
        ]),
        el('div', { class: 'r2', text: [x.folder, x.summary].filter(Boolean).join(' · ') || `${int(x.turns)} turns` }),
      ]))) : el('p', { class: 'recent-empty muted', text: 'No Claude Code sessions yet' }),
      el('footer', { class: 'acard-foot' }, [
        el('span', { class: 'muted', text: topModel ? `Mostly ${modelName(topModel.name)}` : '' }),
        el('span', { class: 'acard-btns' }, [r.chrome, r.action]),
      ]),
    ]);
    fillLive(r, v);
    cardRefs.set(v.id, r);
    return node;
  }

  function renderCards(list, animate) {
    cardRefs = new Map();
    if (!list.length) {
      refs.cards.replaceChildren(el('p', { class: 'muted loading', text: 'No accounts yet. Click + to add one.' }));
      return;
    }
    refs.cards.replaceChildren(...list.map((v, i) => card(v, i, animate)));
  }

  // ---------- needs you ----------

  const NEEDS_SHOWN = 6;
  const KIND_LABEL = { permission: 'Permission', question: 'Question', plan: 'Plan', input: 'Answer', quit: 'Interrupted' };

  // Every waiting session, newest first; a click shows its account (Claude's own sidebar then has the session).
  function renderNeeds() {
    if (!refs.needs) return;
    const rows = [];
    for (const a of accounts) {
      for (const it of ((sessions[a.id] || {}).items || [])) if (it.state === 'waiting') rows.push({ a, it });
    }
    rows.sort((x, y) => (y.it.at || 0) - (x.it.at || 0));
    refs.needs.hidden = !rows.length;
    if (!rows.length) { refs.needs.replaceChildren(); return; }
    const extra = rows.length - NEEDS_SHOWN;
    refs.needs.replaceChildren(
      el('div', { class: 'needs-head' }, [
        el('span', { class: 'needs-mark', 'aria-hidden': 'true' }),
        el('h2', { text: 'Needs you' }),
        el('span', { class: 'note', text: `${rows.length} session${rows.length === 1 ? ' is' : 's are'} waiting for your answer or permission` }),
      ]),
      el('ul', { class: 'needs-list' }, rows.slice(0, NEEDS_SHOWN).map(({ a, it }) => el('li', {}, [
        el('button', {
          class: 'needs-row', type: 'button', style: `--acc:${a.color}`,
          'aria-label': `${a.name}: ${it.title}. ${it.detail || ''} Show ${a.name}`,
          'data-hint': `Show ${a.name}; the session is in Claude's sidebar`,
          onclick: () => show(a.id),
        }, [
          el('span', { class: 'needs-acc' }, [el('i'), el('span', { text: a.name })]),
          el('span', { class: 'needs-kind', text: KIND_LABEL[it.kind] || 'Waiting' }),
          el('span', { class: 'needs-what' }, [
            el('span', { class: 'needs-title', text: it.title || 'Untitled session' }),
            it.detail ? el('span', { class: 'needs-detail', text: it.detail }) : null,
          ]),
          el('span', { class: 'needs-ago', text: ago(it.at) }),
        ]),
      ]))),
    );
    if (extra > 0) refs.needs.append(el('p', { class: 'needs-more muted', text: `and ${extra} more` }));
  }

  // ---------- charts ----------

  function niceScale(max, ticks = 4) {
    if (!(max > 0)) return { top: 4, step: 1 };
    const raw = max / ticks;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    // Counts are whole numbers, so a 2.5 step is only used where it gives whole ticks (25, 250…).
    const nice = (p >= 10 ? [1, 2, 2.5, 5, 10] : [1, 2, 5, 10]).find((s) => f <= s);
    const step = Math.max(1, nice * p);
    return { top: Math.ceil(max / step) * step, step };
  }

  const rectPath = (x, y, w, h) => `M${x},${y + h}V${y}H${x + w}V${y + h}Z`;
  // Rounded data-end on top, square at the baseline side.
  function roundTopPath(x, y, w, h, r) {
    r = Math.min(r, h, w / 2);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  function legend(list) {
    return el('div', { class: 'legend' }, list.map((v) => el('span', { class: 'lg' }, [el('i', { style: `--c:${v.color}` }), el('span', { text: v.name })])));
  }

  function barChart(host, list, days, animate) {
    const W = Math.max(300, Math.floor(host.clientWidth || 640));
    const TOP = 22, PLOT = 168, AXIS = 24, LEFT = 38;
    const H = TOP + PLOT + AXIS, baseY = TOP + PLOT;
    const n = days.length;
    const totals = days.map((_, i) => sum(list.map((v) => v.daily[i])));
    const { top, step } = niceScale(Math.max(0, ...totals));
    const hOf = (v) => (v / top) * PLOT;

    // Stack geometry first (vertical only), so we know which direct labels fit before laying out x.
    const stacks = days.map((_, i) => {
      let cum = 0;
      const segs = [];
      list.forEach((v) => {
        const val = v.daily[i];
        if (!val) return;
        const h = hOf(val);
        segs.push({ v, val, y0: baseY - cum - h, y1: baseY - cum - (segs.length ? GAP : 0) });
        cum += h;
      });
      return segs;
    });
    const labelled = list.length > 1 ? stacks[n - 1].filter((s) => s.y1 - s.y0 >= 13) : [];
    const RIGHT = labelled.length ? 86 : 12;
    const band = (W - LEFT - RIGHT) / n;
    const bw = Math.min(24, band * 0.62);

    const root = svg('svg', { class: 'chart bars', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Prompts per day over the last 14 days, stacked by account' });
    for (let v = 0; v <= top + 1e-9; v += step) {
      const y = Math.round(baseY - hOf(v)) + 0.5;
      root.append(
        svg('line', { class: v === 0 ? 'base' : 'grid', x1: LEFT, x2: W - RIGHT, y1: y, y2: y }),
        svg('text', { class: 'tick', x: LEFT - 8, y: y + 3.5, 'text-anchor': 'end', text: compact(v) }),
      );
    }

    const xStep = band < 26 ? 4 : 2;
    days.forEach((d, i) => {
      if ((n - 1 - i) % xStep) return;
      const label = i === n - 1 ? 'Today' : parseDay(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      root.append(svg('text', { class: 'tick', x: LEFT + band * (i + 0.5), y: baseY + 17, 'text-anchor': 'middle', text: label }));
    });

    const svgPoint = (x, y) => { const r = root.getBoundingClientRect(); return { x: r.left + x, y: r.top + y }; };
    stacks.forEach((segs, i) => {
      const cx = LEFT + band * (i + 0.5);
      const x = cx - bw / 2;
      const stackTop = segs.length ? segs[segs.length - 1].y0 : baseY;
      const date = parseDay(days[i]);
      const col = svg('g', {
        class: `col${animate ? ' grow' : ''}`, tabindex: '0',
        style: animate ? `transform-origin:0 ${baseY}px;animation-delay:${i * 40}ms` : null,
        'aria-label': `${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${int(totals[i])} prompts`,
      });
      segs.forEach((s, k) => {
        const h = s.y1 - s.y0;
        if (h < 0.5) return;
        col.append(svg('path', { class: 'seg', fill: s.v.color, d: k === segs.length - 1 ? roundTopPath(x, s.y0, bw, h, 4) : rectPath(x, s.y0, bw, h) }));
      });
      // The whole band is the hit target, not just the painted bar.
      col.append(svg('rect', { class: 'hit', x: LEFT + band * i, y: TOP, width: band, height: PLOT, fill: 'transparent' }));
      const enter = () => {
        col.classList.add('hover');
        tip.show(svgPoint(cx, Math.min(stackTop, baseY - 4)), [
          tipHead(i === n - 1 ? `Today · ${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}` : date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })),
          ...list.map((v) => tipRow(v.color, int(v.daily[i]), v.name)),
          list.length > 1 ? el('div', { class: 'tt-foot' }, [el('b', { text: int(totals[i]) }), el('span', { text: ' prompts in total' })]) : null,
        ].filter(Boolean));
      };
      const leave = () => { col.classList.remove('hover'); tip.hide(); };
      col.addEventListener('pointerenter', enter);
      col.addEventListener('pointerleave', leave);
      col.addEventListener('focus', enter);
      col.addEventListener('blur', leave);
      root.append(col);
    });

    const fade = animate ? 'fade' : null;
    // Label the extreme: the busiest day's total sits on its cap.
    const peak = totals.indexOf(Math.max(...totals));
    if (totals[peak] > 0) {
      const segs = stacks[peak];
      root.append(svg('text', { class: `val ${fade || ''}`, x: LEFT + band * (peak + 0.5), y: segs[segs.length - 1].y0 - 6, 'text-anchor': 'middle', text: int(totals[peak]) }));
    }
    // Direct labels name the series beside today's bar where a segment is tall enough; the legend covers the rest.
    labelled.forEach((s) => {
      root.append(svg('text', { class: `dlabel ${fade || ''}`, x: LEFT + band * (n - 0.5) + bw / 2 + 8, y: (s.y0 + s.y1) / 2 + 4, text: truncate(s.v.name, 12) }));
    });
    if (!totals.some(Boolean)) {
      root.append(svg('text', { class: 'empty', x: LEFT + (W - LEFT - RIGHT) / 2, y: TOP + PLOT / 2, 'text-anchor': 'middle', text: stats && stats.scanning ? 'Still counting…' : 'No prompts in the last 14 days' }));
    }
    return root;
  }

  function heatmap(host, list, animate) {
    const W = Math.max(280, Math.floor(host.clientWidth || 480));
    const LEFT = 34, AXIS = 20;
    const cw = (W - LEFT - GAP * 23) / 24;
    const ch = clamp(cw, 10, 22);
    const H = 7 * ch + 6 * GAP + AXIS;
    const at = (v, wd, h) => ((v.activity.hours[wd] || [])[h] || 0);
    const cell = (wd, h) => sum(list.map((v) => at(v, wd, h)));
    let max = 0, peak = null;
    WEEK_ORDER.forEach((wd) => { for (let h = 0; h < 24; h++) { const c = cell(wd, h); if (c > max) { max = c; peak = { wd, h }; } } });

    const root = svg('svg', { class: 'chart heat', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Prompts by weekday and hour over the last 4 weeks' });
    WEEK_ORDER.forEach((wd, row) => {
      const y = row * (ch + GAP);
      root.append(svg('text', { class: 'tick', x: LEFT - 8, y: y + ch / 2 + 4, 'text-anchor': 'end', text: DAY_NAMES[wd] }));
      for (let h = 0; h < 24; h++) {
        const c = cell(wd, h);
        // Six equal bins of one warm ink ramp; an empty hour stays on the surface step.
        const bin = c > 0 && max > 0 ? clamp(Math.ceil((c / max) * 6), 1, 6) : 0;
        const isPeak = peak && peak.wd === wd && peak.h === h;
        const x = LEFT + h * (cw + GAP);
        const rect = svg('rect', {
          class: `cell h${bin}${isPeak ? ' peak' : ''}${animate ? ' pop' : ''}`, x, y, width: cw, height: ch, rx: 3,
          style: animate ? `animation-delay:${h * 16 + row * 22}ms` : null,
        });
        rect.addEventListener('pointerenter', () => {
          const r = rect.getBoundingClientRect();
          const head = `${DAY_NAMES[wd]} ${String(h).padStart(2, '0')}:00 · ${int(c)} prompt${c === 1 ? '' : 's'}`;
          tip.show({ x: r.left + r.width / 2, y: r.top }, [
            tipHead(head),
            ...(list.length > 1 && c > 0 ? list.map((v) => tipRow(v.color, int(at(v, wd, h)), v.name)) : []),
          ]);
        });
        rect.addEventListener('pointerleave', () => tip.hide());
        root.append(rect);
      }
    });
    for (let h = 0; h < 24; h += 3) {
      root.append(svg('text', { class: 'tick', x: LEFT + h * (cw + GAP), y: H - 5, text: `${String(h).padStart(2, '0')}:00` }));
    }
    return { node: root, max, peak };
  }

  function donut(list, animate) {
    const S = 172, R = 66, SW = 20, C = 2 * Math.PI * R, c = S / 2;
    const vals = list.map((v) => v.activity.totals.outputTokens7d || 0);
    const total = sum(vals);
    const nonzero = vals.filter(Boolean).length;
    const sweep = animate && !reduced();
    const rows = [];

    const root = svg('svg', { class: 'chart donut', viewBox: `0 0 ${S} ${S}`, width: S, height: S, role: 'img', 'aria-label': 'Output tokens this week by account' }, [
      svg('circle', { class: 'donut-track', cx: c, cy: c, r: R, fill: 'none', 'stroke-width': SW }),
    ]);
    let start = 0;
    list.forEach((v, k) => {
      const val = vals[k];
      if (!val) return;
      const len = (val / total) * C;
      const dash = Math.max(0.01, len - (nonzero > 1 ? GAP : 0));
      const seg = svg('circle', {
        class: 'dseg', cx: c, cy: c, r: R, fill: 'none', stroke: v.color, 'stroke-width': SW,
        'stroke-dasharray': `${sweep ? 0 : dash} ${C}`, 'stroke-dashoffset': -start, transform: `rotate(-90 ${c} ${c})`,
      });
      if (sweep) {
        // One continuous sweep: each slice starts when the previous one finishes.
        seg.style.transition = `stroke-dasharray ${Math.max(60, (len / C) * 900)}ms linear ${(start / C) * 900}ms`;
        afterPaint(() => seg.setAttribute('stroke-dasharray', `${dash} ${C}`));
      }
      const mid = (start + len / 2) / C * 2 * Math.PI - Math.PI / 2;
      seg.addEventListener('pointerenter', () => {
        seg.classList.add('hover');
        if (rows[k]) rows[k].classList.add('hover');
        const r = root.getBoundingClientRect();
        tip.show({ x: r.left + c + Math.cos(mid) * R, y: r.top + c + Math.sin(mid) * R - SW / 2 }, [
          tipHead(v.name),
          tipRow(v.color, compact(val), `output tokens · ${Math.round((val / total) * 100)}%`),
        ]);
      });
      seg.addEventListener('pointerleave', () => { seg.classList.remove('hover'); if (rows[k]) rows[k].classList.remove('hover'); tip.hide(); });
      root.append(seg);
      start += len;
    });
    const centre = svg('text', { class: 'donut-total', x: c, y: c + 4, 'text-anchor': 'middle', text: compact(total) });
    root.append(centre, svg('text', { class: 'donut-sub', x: c, y: c + 22, 'text-anchor': 'middle', text: 'output tokens' }));
    if (sweep) countTo(centre, 0, total, compact, true);

    const pct = (val) => (total ? `${val / total < 0.1 && val ? (val / total * 100).toFixed(1) : Math.round(val / total * 100)}%` : '—');
    const legendList = el('ul', { class: 'dlegend' }, list.map((v, k) => {
      rows[k] = el('li', {}, [
        el('i', { style: `--c:${v.color}` }),
        el('span', { class: 'name', text: v.name }),
        el('b', { text: compact(vals[k]) }),
        el('span', { class: 'pct', text: pct(vals[k]) }),
      ]);
      return rows[k];
    }));
    return el('div', { class: 'donut-wrap' }, [el('div', { class: 'donut-box' }, [root]), legendList]);
  }

  function chartCard(title, sub, wide) {
    const body = el('div', { class: 'chart-body' });
    const subNode = el('p', { class: 'sub', text: sub });
    const node = el('div', { class: `chart-card${wide ? ' wide' : ''}` }, [el('h3', { text: title }), subNode, body]);
    return { node, body, subNode };
  }

  function table(head, rows) {
    return el('div', { class: 'table-scroll' }, [el('table', { class: 'dtable' }, [
      el('thead', {}, [el('tr', {}, head.map((h) => el('th', { text: h })))]),
      el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c, i) => el(i ? 'td' : 'th', { text: String(c), scope: i ? null : 'row' }))))),
    ])]);
  }

  function renderCharts(list, animate) {
    tip.hide();
    const days = chartDays();
    const host = refs.charts;
    chartsWidth = host.clientWidth;
    const bars = chartCard('Prompts per day', 'Last 14 days, stacked by account', true);
    const heat = chartCard('When you work', 'Prompts by weekday and hour, last 4 weeks, all accounts');
    const share = chartCard('Output tokens this week', 'Share by account, last 7 days');
    host.replaceChildren(bars.node, heat.node, share.node);

    if (tableView) {
      bars.body.append(table(['Day', ...list.map((v) => v.name), 'Total'], days.map((d, i) => [
        parseDay(d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
        ...list.map((v) => int(v.daily[i])), int(sum(list.map((v) => v.daily[i]))),
      ])));
      heat.body.append(table(['', ...Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'))], WEEK_ORDER.map((wd) => [
        DAY_NAMES[wd], ...Array.from({ length: 24 }, (_, h) => int(sum(list.map((v) => (v.activity.hours[wd] || [])[h] || 0)))),
      ])));
      const total = sum(list.map((v) => v.activity.totals.outputTokens7d));
      share.body.append(table(['Account', 'Output tokens', 'Share'], list.map((v) => [
        v.name, int(v.activity.totals.outputTokens7d), total ? `${Math.round(v.activity.totals.outputTokens7d / total * 100)}%` : '—',
      ])));
      return;
    }

    if (list.length > 1) bars.body.append(legend(list));
    bars.body.append(barChart(bars.body, list, days, animate));

    const hm = heatmap(heat.body, list, animate);
    heat.subNode.textContent = hm.max
      ? `Prompts by hour, last 4 weeks · busiest: ${DAY_NAMES[hm.peak.wd]} ${String(hm.peak.h).padStart(2, '0')}:00 (${int(hm.max)})`
      : 'Prompts by weekday and hour, last 4 weeks · nothing yet';
    heat.body.append(hm.node, el('div', { class: 'heat-scale', 'aria-hidden': 'true' }, [
      el('span', { text: 'Less' }),
      ...[0, 1, 2, 3, 4, 5, 6].map((b) => el('i', { class: `h${b}` })),
      el('span', { text: 'More' }),
    ]));

    share.body.append(donut(list, animate));
  }

  // ---------- painting ----------

  function paint(animate) {
    if (!root) return;
    tip.hide();
    const list = view();
    renderNeeds();
    renderHero(list, animate);
    renderCards(list, animate);
    renderCharts(list, animate);
    refs.scan.hidden = !(stats && stats.scanning);
    const sig = sigOf();
    if (sig !== skySig) { seedSky(list); skySig = sig; }
    builtKey = keyOf();
    builtSig = sig;
    if (animate && !reduced()) entranceUntil = performance.now() + 1800;
  }

  // Cheap path for onStatus: only the pills, meta lines, buttons and the "running" tile.
  function refreshLive() {
    const list = view();
    for (const v of list) {
      const r = cardRefs.get(v.id);
      if (r) fillLive(r, v);
    }
    renderHero(list, false);
  }

  // Everything a full repaint draws, minus the live numbers refreshLive() handles.
  const dataSig = (s) => JSON.stringify([s.scanning, (s.accounts || []).map(({ live, ...rest }) => rest)]);

  async function refresh() {
    if (!api.getStats) return;
    const seq = ++fetchSeq;
    let next = null;
    try { next = await api.getStats(); } catch { next = null; }
    if (seq !== fetchSeq) return;
    if (!next) {
      // Nothing new; still draw what we have if this show is waiting for its first paint.
      if (shown && stats && builtKey !== keyOf()) paint(true);
      return;
    }
    const firstData = !stats;
    // Usually only memory and uptime moved; then a full repaint would only lose focus, an open
    // tooltip and scroll positions, so just the live numbers are updated.
    const sameData = stats && dataSig(stats) === dataSig(next);
    stats = next;
    if (!shown) return;
    if (sameData && builtKey === keyOf() && builtSig === sigOf()) { refreshLive(); return; }
    const wait = entranceUntil - performance.now();
    if (wait > 0) { setTimeout(() => { if (shown && seq === fetchSeq) paint(builtKey !== keyOf()); }, wait); return; }
    // The first data of the session (or a new set of accounts) gets the entrance animations.
    paint(builtKey !== keyOf());
    // The constellation was seeded with equal weights before stats arrived; reseed with real activity once.
    if (firstData) seedSky(view());
  }

  function startTimer() {
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  }

  if (api.onStatsUpdated) api.onStatsUpdated(() => { if (shown) refresh(); });
  document.addEventListener('visibilitychange', () => { if (shown && !document.hidden) refresh(); });

  // ---------- public ----------

  return {
    // Called by renderPanes on every render while ui.home is true. Mounting is idempotent.
    show(box) {
      if (!root) build();
      if (root.parentNode !== box) box.replaceChildren(root);
      if (!shown) {
        shown = true;
        if (skySig !== sigOf()) { seedSky(view()); skySig = sigOf(); }
        sky.start();
        startTimer();
        // Show the last numbers at once while fresh ones load, so a removed account's card never
        // lingers; a changed set of accounts gets the entrance animation.
        if (stats) paint(builtKey !== keyOf()); else { renderNeeds(); renderHero(view(), false); }
        refresh();
        return;
      }
      if (!stats) { renderHero(view(), false); return; }
      if (sigOf() !== builtSig) paint(builtKey !== keyOf()); // an account was added, removed, renamed or recoloured
      else refreshLive();
    },
    // New "needs you" data from main: the strip, the cards' counts and meta lines (cheap, in place).
    attention() {
      if (!shown || !root) return;
      renderNeeds();
      if (stats) refreshLive();
    },
    // New Chrome profile links from main: the cards' Chrome buttons (cheap, in place).
    chrome() {
      if (shown && root && stats) refreshLive();
    },
    hide() {
      if (!shown) return;
      shown = false;
      clearInterval(timer);
      timer = 0;
      fetchSeq++; // drop any reply still in flight
      if (sky) sky.stop();
      tip.hide();
    },
  };
})();
