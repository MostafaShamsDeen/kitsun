// Kitsun window: a tab per AI. Claude tabs are real Claude app windows and website tabs are pages, both laid over the
// pane bodies by the main process, which needs to know where those bodies are.

const api = window.kitsun;

const COLORS = ['#d97757', '#5b8def', '#3fb68b', '#c678dd', '#e5b84f', '#e06c9f', '#4fb8c9', '#9b968c'];

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) if (c != null) node.append(c);
  return node;
}

const $ = (sel) => document.querySelector(sel);

let accounts = [];
// From main (state.ui): layout 'single' | 'split' | 'triple', the account in each of up to three panes, the active
// pane, and where the dividers sit (splitRatio: the left pane's share; tripleRatios: each column's share).
let ui = { layout: 'single', panes: [null, null, null], split: false, focused: 0, home: false, splitRatio: 0.5, tripleRatios: [1 / 3, 1 / 3, 1 / 3] };
let status = {};
// Per account, from main's attention watcher: { waiting, unseen, working, items: [{ sessionId, title, folder, state,
// kind, detail, at }], usage: { fiveHour, weekly, asOf } | null }. state: 'waiting' | 'unseen' | 'working'.
let sessions = {};
// From main (lib/chrome.js): { installed, profiles: [{ dir, name, email }], accounts: { [id]: { auto: { dir, name, how } | null,
// chosen, missing, link: { dir, name, manual } | null } } }. link is the Chrome profile the account's Chrome button opens.
let chromeInfo = { installed: false, profiles: [], accounts: {} };
const restarting = new Set(); // accounts whose "Restart it here" is in progress

const byId = (id) => accounts.find((a) => a.id === id);
// Claude-only features (usage, needs-you, sessions, handoff, Chrome profiles) only ever look at Claude tabs.
const claudeAccounts = () => accounts.filter((a) => a.kind === 'claude');
const KIND_NAMES = { claude: 'Claude app', web: 'Website', app: 'Desktop app', terminal: 'Terminal' };
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const PANES_IN = { single: 1, split: 2, triple: 3 };
const currentLayout = () => (PANES_IN[ui.layout] ? ui.layout : ui.split ? 'split' : 'single');
const paneCount = () => PANES_IN[currentLayout()];
const visiblePanes = () => [...Array(paneCount()).keys()];

// ---------- title bar ----------

function renderTabs() {
  const multi = paneCount() > 1;
  $('#tabs').replaceChildren(...accounts.map((a, idx) => {
    const pane = visiblePanes().find((p) => ui.panes[p] === a.id);
    // On the home screen no account is showing, so no tab is selected.
    const selected = !ui.home && pane !== undefined && (!multi || pane === ui.focused);
    const st = status[a.id] || {};
    const s = st.status || 'stopped';
    // Frozen outranks everything; a copy waiting to be reopened pulses like one starting.
    const dot = st.frozen ? 'frozen' : s === 'stopped' && st.exit && st.exit.reopening ? 'starting' : s;
    const att = sessions[a.id] || {};
    const u = att.usage;
    return el('button', {
      class: 'tab', role: 'tab', type: 'button', style: `--acc:${a.color}`,
      'aria-selected': String(selected),
      'data-hint': tabHint(a, idx, att),
      onclick: () => show(a.id),
      oncontextmenu: (e) => { e.preventDefault(); openAccountDialog(a); },
    }, [
      // With plan data, the dot sits in a thin ring filled to its 5-hour usage.
      el('span', { class: `dot${u ? ' ring' : ''}`, style: u ? `--p:${Math.min(100, Math.max(0, Math.round(u.fiveHour)))}` : null }),
      el('span', { class: 'name', text: a.name }),
      // Which pane it shows in, counted from the left.
      multi && !ui.home && pane !== undefined ? el('span', { class: 'pane-no', text: String(pane + 1) }) : null,
      // A number for sessions waiting for the person; a plain dot for turns that finished while nobody looked.
      att.waiting ? el('span', { class: 'badge', text: String(att.waiting), 'aria-label': `${att.waiting} waiting for you` })
        : att.unseen ? el('span', { class: 'badge unseen', 'aria-label': 'finished while you were away' }) : null,
      dot === 'docked' ? null : el('span', { class: `state ${dot}` }),
    ]);
  }));
  renderAlerts();
  // The layout button shows the current layout; it opens the layout menu.
  const split = $('#split');
  const choice = LAYOUT_CHOICES.find((c) => c.name === currentLayout());
  split.replaceChildren(layoutIcon(choice.name));
  split.classList.toggle('on', paneCount() > 1);
  split.dataset.hint = accounts.length < 2 ? 'Add a second tab to show two side by side' : `Layout: ${choice.label}`;
  split.setAttribute('aria-label', `Layout: ${choice.label}`);
  split.disabled = accounts.length < 2;
  // Home is a place, not an on/off switch.
  if (ui.home) $('#home').setAttribute('aria-current', 'page'); else $('#home').removeAttribute('aria-current');
}

// "Work · 5-hour 64% · weekly 71% · 1 needs you · Ctrl+Alt+1". The edit tip only fits without the usage.
function tabHint(a, idx, att) {
  const u = att.usage;
  return [
    a.name,
    u ? `5-hour ${Math.round(u.fiveHour)}% · weekly ${Math.round(u.weekly)}%` : null,
    att.waiting ? `${att.waiting} need${att.waiting === 1 ? 's' : ''} you` : att.unseen ? `${att.unseen} finished unseen` : null,
    att.working ? `${att.working} working` : null,
    idx < 9 ? `Ctrl+Alt+${idx + 1}` : null,
    u ? null : 'right-click to edit',
  ].filter(Boolean).join(' · ');
}

async function show(id) {
  ui = await api.showAccount(id);
  render();
}

$('#home').addEventListener('click', async () => {
  if (!api.goHome) return;
  ui = await api.goHome();
  render();
});

// ---------- layout menu (one account, two side by side, three columns) ----------

// need: accounts it takes. cmd: how the quick switcher words it.
const LAYOUT_CHOICES = [
  { name: 'single', label: 'Single', sub: 'One tab at a time', cmd: 'Show one tab at a time', need: 1 },
  { name: 'split', label: 'Side by side', sub: 'Two tabs', cmd: 'Show two tabs side by side', need: 2 },
  { name: 'triple', label: 'Three columns', sub: 'Three tabs', cmd: 'Show three tabs in columns', need: 3 },
];

// The layout as a row of window shapes, drawn like the title bar's other icons.
function layoutIcon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 20 14');
  s.setAttribute('aria-hidden', 'true');
  const cols = { single: [[1, 18]], split: [[1, 8], [11, 8]], triple: [[1, 5], [7.5, 5], [14, 5]] }[name] || [[1, 18]];
  for (const [x, w] of cols) {
    const r = document.createElementNS(ns, 'rect');
    for (const [k, v] of Object.entries({ x, y: 1, width: w, height: 12, rx: 1.5 })) r.setAttribute(k, String(v));
    s.append(r);
  }
  return s;
}

const layoutMenu = $('#layout-menu');

function renderLayoutMenu() {
  $('#layout-list').replaceChildren(...LAYOUT_CHOICES.map((c) => {
    const ok = accounts.length >= c.need;
    const on = c.name === currentLayout();
    // aria-disabled rather than disabled, so it can still be hovered for its hint and reached with the arrow keys.
    return el('button', {
      class: 'menu-item', type: 'button', role: 'menuitemradio', 'aria-checked': String(on), 'aria-disabled': ok ? null : 'true',
      'data-hint': ok ? null : `${c.label} needs ${c.need} tabs · add one with +`,
      onclick: () => { if (ok) chooseLayout(c.name); },
    }, [
      el('span', { class: 'menu-icon' }, [layoutIcon(c.name)]),
      el('span', { class: 'menu-text' }, [
        el('span', { class: 'menu-label', text: c.label }),
        el('small', { class: 'menu-sub', text: ok ? c.sub : `Needs ${c.need} tabs` }),
      ]),
      el('span', { class: 'menu-check', 'aria-hidden': 'true' }),
    ]);
  }));
}

// A menu over the panes: the Claude windows are hidden while it is open (openModal), or they would cover it.
function openLayoutMenu() {
  renderLayoutMenu();
  if (!openModal(layoutMenu)) return;
  // Under the layout button, right-aligned with it, and inside the window.
  const b = $('#split').getBoundingClientRect();
  const w = layoutMenu.offsetWidth;
  layoutMenu.style.left = `${Math.max(8, Math.min(b.right - w, innerWidth - w - 8))}px`;
  layoutMenu.style.top = `${b.bottom + 6}px`;
  $('#split').setAttribute('aria-expanded', 'true');
  const items = [...layoutMenu.querySelectorAll('.menu-item')];
  (items.find((n) => n.getAttribute('aria-checked') === 'true') || items[0]).focus();
}

// The new panes' rects go to main before the menu closes, so each Claude window shows straight in its new place.
async function chooseLayout(name) {
  if (name !== currentLayout()) {
    ui = api.setLayout ? await api.setLayout(name) : await api.setSplit(name !== 'single');
    render();
    sendRects();
  }
  if (layoutMenu.open) layoutMenu.close();
}

$('#split').addEventListener('click', () => { if (!layoutMenu.open) openLayoutMenu(); });
layoutMenu.addEventListener('close', () => $('#split').setAttribute('aria-expanded', 'false'));
layoutMenu.addEventListener('keydown', (e) => {
  const items = [...layoutMenu.querySelectorAll('.menu-item:not([aria-disabled="true"])')];
  const at = items.indexOf(document.activeElement);
  const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[e.key];
  if (to === undefined || !items.length) return;
  e.preventDefault();
  items[(to + items.length) % items.length].focus();
});
// A click outside the menu closes it, as Esc does.
layoutMenu.addEventListener('mousedown', (e) => {
  const r = layoutMenu.getBoundingClientRect();
  if (e.target === layoutMenu && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) layoutMenu.close();
});

// Frozen accounts are flagged in the title bar: a frozen Claude window can't be hidden or moved, so it
// covers anything drawn in its pane, but never the title bar.
function renderAlerts() {
  const frozen = accounts.filter((a) => (status[a.id] || {}).frozen);
  $('#alerts').replaceChildren(...frozen.map((a) => el('div', { class: 'alert', role: 'alert', style: `--acc:${a.color}` }, [
    el('span', { class: 'alert-dot' }),
    el('span', { class: 'alert-text', text: `${a.name} isn't responding`, 'data-hint': `${a.name}'s Claude window has stopped responding` }),
    ...frozenButtons(a, true),
  ])));
  fitAlerts();
}

// The alert gives up its text when it would cut tab names short (the tab's red dot still says which account),
// and then the search button (Ctrl+Alt+K still opens the switcher). Each pass measures from the roomiest layout.
function fitAlerts() {
  const box = $('#alerts');
  const bar = $('.titlebar');
  box.classList.remove('compact');
  bar.classList.remove('tight');
  // Only a squeezed tab counts: a long name is cut at the tab's own max-width (220px) on any window.
  const cut = () => [...document.querySelectorAll('#tabs .name')].some((n) => n.scrollWidth > n.clientWidth + 1 && n.parentElement.offsetWidth < 219);
  if (box.children.length && cut()) box.classList.add('compact');
  if (cut()) bar.classList.add('tight');
}
window.addEventListener('resize', () => requestAnimationFrame(fitAlerts));

// ---------- panes ----------

// Why a copy closed (status.exit.reason from main) -> what its pane says. reopening: Kitsun is
// about to start it again; gaveUp: it closed too often for that.
// short: the one-line form for the home screen's account card, which already shows the name.
function closedText(account, exit) {
  const n = account.name;
  const r = exit ? exit.reason : null;
  const soon = exit && exit.reopening ? ' · reopening…' : '';
  if (r === 'update') {
    return { title: `${n} closed for a Claude update`, short: `Closed for a Claude update${soon}`, text: exit.reopening ? 'Reopening it once the update is installed…' : exit.gaveUp ? 'It closed several times in a few minutes, so it wasn\'t reopened.' : '' };
  }
  if (r === 'crash') {
    if (exit.gaveUp) return { title: `${n}'s Claude keeps closing`, short: 'Keeps closing · not reopened', text: 'It closed several times in a few minutes, so Kitsun stopped reopening it. Start it when you\'re ready.' };
    return { title: `${n}'s Claude closed unexpectedly`, short: `Closed unexpectedly${soon}`, text: exit.reopening ? 'Reopening it in a moment…' : '' };
  }
  if (r === 'user') return { title: `You quit ${n} from Claude's menu`, short: 'Quit from Claude\'s menu', text: '' };
  if (r === 'shutdown') return { title: `Windows closed ${n}'s Claude`, short: 'Closed by Windows', text: 'Windows was signing out or shutting down.' };
  if (r === 'stopped') return { title: `You stopped ${n}`, short: 'Stopped by you', text: 'It stays closed until you start it.' };
  if (r) return { title: `${n}'s Claude closed`, short: 'Closed', text: '' };
  return { title: `${n} isn't running`, short: 'Not running', text: '' };
}

function frozenNotice(account) {
  return el('div', { class: 'notice' }, [
    el('h2', { text: `${account.name} isn't responding` }),
    el('p', { text: 'Its Claude window has stopped responding. It may recover by itself; restarting it ends everything running in it.' }),
    el('div', { class: 'notice-actions' }, frozenButtons(account)),
  ]);
}

// small: the title-bar version, short enough to leave the tabs their room (the account is named in its hint).
function frozenButtons(account, small = false) {
  return [
    el('button', {
      class: `btn ghost${small ? ' small' : ''}`, type: 'button', text: 'Wait', 'aria-label': `Wait for ${account.name}`,
      'data-hint': small ? `Keep waiting for ${account.name}` : null, onclick: () => api.waitForAccount(account.id),
    }),
    el('button', {
      class: `btn primary${small ? ' small' : ''}`, type: 'button', text: small ? 'Restart' : `Restart ${account.name}`, 'aria-label': `Restart ${account.name}`,
      'data-hint': small ? `Restart ${account.name}: ends everything running in it` : null, onclick: () => restartFrozen(account),
    }),
  ];
}

// Main asks for confirmation itself, in a native dialog: one drawn in this page would sit under the frozen window.
async function restartFrozen(account) {
  const r = await api.restartFrozen(account.id).catch((err) => ({ ok: false, error: err.message }));
  if (r && !r.ok && !r.cancelled && r.error) toast(r.error);
}

function webNotice(account, s) {
  if (s.status === 'docked') return null;
  return el('div', { class: 'notice' }, [
    el('h2', { text: s.exit && s.exit.reason === 'stopped' ? `You closed ${account.name}` : `${account.name} isn't open` }),
    el('p', { text: `Open it again to load ${hostOf(account.url) || 'the page'}. You stay signed in.` }),
    s.error ? el('p', { text: s.error }) : null,
    el('button', { class: 'btn primary', type: 'button', text: `Open ${account.name}`, onclick: () => api.startAccount(account.id) }),
  ]);
}

function notice(account) {
  const s = status[account.id] || { status: 'stopped' };
  if (account.kind === 'web') return webNotice(account, s);
  if (s.frozen) return frozenNotice(account);
  if (s.status === 'docked') return null;
  if (s.status === 'starting') {
    const why = s.exit && s.exit.reason === 'update' ? 'after the Claude update' : s.exit && s.exit.reason === 'crash' ? 'after it closed unexpectedly' : null;
    return el('div', { class: 'notice' }, [
      el('div', { class: 'spinner' }),
      el('p', { text: !s.exit ? `Starting Claude for ${account.name}…` : why ? `Reopening ${account.name} ${why}…` : `Reopening ${account.name}…` }),
    ]);
  }
  if (s.status === 'stopping') {
    return el('div', { class: 'notice' }, [
      el('div', { class: 'spinner' }),
      el('p', { text: `Stopping ${account.name}…` }),
    ]);
  }
  if (s.status === 'external' && account.main) {
    return el('div', { class: 'notice' }, [
      el('h2', { text: `Your ${account.name} Claude is open in its own window` }),
      el('p', { text: 'To bring it in here, quit that window once. It reopens here automatically, signed in and with all its chats.' }),
      el('ol', {}, [
        el('li', { html: 'In that Claude window, open the menu <b>≡</b> (top left) and choose <b>File → Exit</b>.' }),
        el('li', { html: 'Or right-click the Claude icon by the clock and choose <b>Quit</b>.' }),
      ]),
    ]);
  }
  if (s.status === 'external') {
    return el('div', { class: 'notice' }, [
      el('h2', { text: `${account.name} is open in its own window` }),
      el('p', { text: 'Restart it here to bring it into this tab. Anything Claude is in the middle of in that window will stop.' }),
      el('button', { class: 'btn primary', type: 'button', text: restarting.has(account.id) ? 'Restarting…' : 'Restart it here', disabled: restarting.has(account.id), onclick: async () => {
        restarting.add(account.id);
        render();
        const r = await api.restartHere(account.id);
        if (r && r.error) { restarting.delete(account.id); render(); toast(r.error); }
      } }),
    ]);
  }
  const { title, text } = closedText(account, s.exit);
  const reopening = Boolean(s.exit && s.exit.reopening);
  return el('div', { class: 'notice' }, [
    reopening ? el('div', { class: 'spinner' }) : null,
    el('h2', { text: title }),
    text ? el('p', { text }) : null,
    s.error ? el('p', { text: s.error }) : null,
    // While a reopen is on its way, starting it now is still possible but no longer the main action.
    el('button', { class: `btn ${reopening ? 'ghost' : 'primary'}`, type: 'button', text: reopening ? 'Start it now' : `Start ${account.name}`, onclick: () => api.startAccount(account.id) }),
  ]);
}

function renderPanes() {
  const box = $('#panes');
  // Rebuilding mid-drag would drop the divider being dragged (and its pointer capture); it is redrawn when the drag ends.
  if (drag) { panesStale = true; return; }
  if (ui.home) {
    // The home screen replaces the panes; with no .pane-body left, sendRects sends [] once.
    box.classList.remove('multi');
    box.classList.add('home-mode');
    box.style.gridTemplateColumns = '';
    Home.show(box);
    observePanes();
    return;
  }
  if (box.classList.contains('home-mode')) {
    box.classList.remove('home-mode');
    Home.hide();
    // Always send the pane rects again on the way back, even if they match what was sent before home.
    lastRects = '';
  }
  const multi = paneCount() > 1;
  box.classList.toggle('multi', multi);
  const nodes = [];
  for (const p of visiblePanes()) {
    if (p > 0) nodes.push(dividerNode(p - 1));
    const account = byId(ui.panes[p]);
    nodes.push(el('section', {
      class: `pane${multi && p === ui.focused ? ' focused' : ''}`,
      style: account ? `--acc:${account.color}` : null,
      onmousedown: async () => { if (multi && ui.focused !== p) { ui = await api.focusPane(p); render(); } },
    }, [
      el('div', { class: 'pane-head' }, account ? [
        el('span', { class: 'dot' }),
        el('span', { class: 'name', text: account.name }),
        el('span', { text: multi && p === ui.focused ? '· tabs open here' : '' }),
      ] : [el('span', { text: 'Empty' })]),
      el('div', { class: 'pane-body', 'data-pane': p }, account ? notice(account) : el('div', { class: 'notice' }, [el('p', { text: 'Pick a tab to show it here.' })])),
    ]));
  }
  box.replaceChildren(...nodes);
  applyColumns();
  observePanes();
}

// ---------- pane dividers ----------

// Panes sit in grid columns with a divider column between each two. The divider is the gap no Claude window covers
// (they cover only the pane bodies), so it can always be grabbed. Widths come from ui.splitRatio / ui.tripleRatios,
// but on screen no pane is narrower than MIN_PANE (or than an equal share, in a window too narrow for that).
const DIVIDER_W = 8;
const MIN_PANE = 360;
let drag = null; // { k, n, x, avail, start, cur, id, node } while a divider is being dragged
let panesStale = false; // a render came in during the drag

const sum = (xs) => xs.reduce((s, x) => s + x, 0);

// The saved shares, each column's fraction of the room (adding up to 1).
function savedFractions(n) {
  if (n === 2) {
    const r = Number.isFinite(ui.splitRatio) ? Math.min(0.8, Math.max(0.2, ui.splitRatio)) : 0.5;
    return [r, 1 - r];
  }
  const t = ui.tripleRatios;
  if (n === 3 && Array.isArray(t) && t.length === 3 && t.every((x) => Number.isFinite(x) && x > 0)) return t.map((x) => x / sum(t));
  return Array(n).fill(1 / n);
}

// The room the panes share, in CSS px: the panes area less its padding and the dividers.
function availWidth(n) {
  const box = $('#panes');
  const cs = getComputedStyle(box);
  return Math.max(1, box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - (n - 1) * DIVIDER_W);
}

// Smallest share a pane may have: 20% of two, 10% of three, and MIN_PANE on screen; an equal share when even that won't fit.
const minFraction = (n, avail) => Math.min(1 / n, Math.max(n === 2 ? 0.2 : 0.1, MIN_PANE / avail));

// Raises any share below the minimum to it, taking the difference from the others in proportion to what they have above it.
function fitFractions(f, min) {
  if (min * f.length >= 1) return f.map(() => 1 / f.length);
  const need = sum(f.map((x) => Math.max(0, min - x)));
  if (!need) return f;
  const spare = sum(f.map((x) => Math.max(0, x - min)));
  return f.map((x) => (x < min ? min : x - ((x - min) / spare) * need));
}

function columnFractions() {
  const n = paneCount();
  return n < 2 ? [1] : fitFractions(savedFractions(n), minFraction(n, availWidth(n)));
}

function applyColumns(fr) {
  const box = $('#panes');
  if (ui.home || paneCount() < 2) { box.style.gridTemplateColumns = ''; return; }
  fr = fr || columnFractions();
  // minmax(0, …): a pane's content never widens its column. Shares are scaled up so rounding stays fine-grained.
  box.style.gridTemplateColumns = fr.map((f) => `minmax(0, ${(f * 1000).toFixed(2)}fr)`).join(` ${DIVIDER_W}px `);
  box.querySelectorAll('.divider').forEach((d, k) => d.setAttribute('aria-valuenow', String(Math.round(sum(fr.slice(0, k + 1)) * 100))));
}

// k: the divider between pane k and pane k + 1.
function dividerNode(k) {
  const reset = paneCount() === 2 ? '50/50' : 'equal columns';
  return el('div', {
    class: 'divider', role: 'separator', 'aria-orientation': 'vertical', tabindex: '0',
    'aria-label': `Resize panes ${k + 1} and ${k + 2}`, 'aria-valuemin': '0', 'aria-valuemax': '100',
    'data-hint': `Drag to resize · double-click for ${reset}`,
    onpointerdown: (e) => startDrag(e, k),
    ondblclick: resetColumns,
    onkeydown: (e) => nudgeDivider(e, k),
  }, [el('span', { class: 'grip' })]);
}

// Divider k moved to `left` (pane k's share); pane k + 1 gets what pane k gave up, the others stay.
function moveDivider(fr, k, left, min) {
  const pair = fr[k] + fr[k + 1];
  const l = Math.min(pair - min, Math.max(min, left));
  return fr.map((f, i) => (i === k ? l : i === k + 1 ? pair - l : f));
}

function saveColumns(n, fr) {
  const change = n === 2 ? { splitRatio: fr[0] } : { tripleRatios: fr };
  Object.assign(ui, change);
  if (api.setPaneRatios) api.setPaneRatios(change).catch(() => {});
}

function resetColumns() {
  const n = paneCount();
  if (n < 2 || drag) return;
  saveColumns(n, Array(n).fill(1 / n));
  applyColumns();
  scheduleRects();
}

// The capture keeps the pointer's events on this page while it crosses a Claude window (which sits above the page).
function startDrag(e, k) {
  if (e.button !== 0 || drag) return;
  e.preventDefault();
  const n = paneCount();
  const avail = availWidth(n);
  const start = columnFractions();
  drag = { k, n, x: e.clientX, avail, start, cur: start, id: e.pointerId, node: e.currentTarget };
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* the pointer is already up */ }
  e.currentTarget.classList.add('dragging');
  document.body.classList.add('resizing');
}

function endDrag(e) {
  if (!drag || (e && e.pointerId !== drag.id)) return;
  const { n, start, cur, node } = drag;
  drag = null;
  node.classList.remove('dragging');
  document.body.classList.remove('resizing');
  // A plain click (or each half of a double-click) moves nothing and saves nothing.
  if (cur.some((f, i) => Math.abs(f - start[i]) > 0.0005)) saveColumns(n, cur);
  if (panesStale) { panesStale = false; renderPanes(); }
  scheduleRects();
}

window.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  // The button came up somewhere this page didn't hear about.
  if (!(e.buttons & 1)) { endDrag(e); return; }
  drag.cur = moveDivider(drag.start, drag.k, drag.start[drag.k] + (e.clientX - drag.x) / drag.avail, minFraction(drag.n, drag.avail));
  applyColumns(drag.cur);
  // At most one rect message per frame: the Claude windows follow the panes as they move.
  scheduleRects();
});
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);
window.addEventListener('lostpointercapture', endDrag);

// ← → move a focused divider by 24 px; Enter evens the panes out, like a double-click.
function nudgeDivider(e, k) {
  if (e.key === 'Enter') { e.preventDefault(); resetColumns(); return; }
  const step = { ArrowLeft: -24, ArrowRight: 24 }[e.key];
  if (!step || drag) return;
  e.preventDefault();
  const n = paneCount();
  const avail = availWidth(n);
  const fr = columnFractions();
  saveColumns(n, moveDivider(fr, k, fr[k] + step / avail, minFraction(n, avail)));
  applyColumns();
  scheduleRects();
}

function render() {
  renderTabs();
  renderPanes();
}

// Tell the main process where each pane body is, so it can place the Claude windows exactly there.
let lastRects = '';
function sendRects() {
  const rects = [...document.querySelectorAll('.pane-body')].map((b) => {
    const r = b.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  const key = JSON.stringify(rects);
  if (key === lastRects) return;
  lastRects = key;
  api.sendPaneRects(rects);
}

// One send per animation frame however many changes come in (a divider drag moves the panes on every pointer move).
let rectsFrame = 0;
function scheduleRects() {
  if (!rectsFrame) rectsFrame = requestAnimationFrame(() => { rectsFrame = 0; sendRects(); });
}

const resizeObserver = new ResizeObserver(scheduleRects);
function observePanes() {
  resizeObserver.disconnect();
  document.querySelectorAll('.pane-body').forEach((b) => resizeObserver.observe(b));
  scheduleRects();
}
// A narrower window may push a pane under its minimum width, so the columns are worked out again.
window.addEventListener('resize', () => { if (!drag) applyColumns(); scheduleRects(); });

// ---------- dialogs (the Claude windows are hidden while one is open, or they would cover it) ----------

// A frozen Claude window can't be hidden, so a dialog opened while one is on screen would sit underneath it, and
// (being modal) would make the title bar's Wait / Restart alert inert. The account in a shown pane counts; on Home too,
// since its window may not have been hidden before it froze.
function frozenOnScreen() {
  return visiblePanes().map((p) => byId(ui.panes[p])).find((a) => a && (status[a.id] || {}).frozen) || null;
}

// Returns false (and says why) instead of opening a dialog that would be hidden under a frozen window.
function openModal(d) {
  if (!d.open) {
    const stuck = frozenOnScreen();
    if (stuck) {
      toast(`${stuck.name} isn't responding; use Wait or Restart in the title bar.`);
      return false;
    }
  }
  api.setOverlay(true);
  d.showModal();
  return true;
}

document.querySelectorAll('dialog').forEach((d) => d.addEventListener('close', () => {
  if (![...document.querySelectorAll('dialog')].some((x) => x.open)) api.setOverlay(false);
}));

const manageDialog = $('#manage-dialog');

function renderManageList() {
  $('#manage-list').replaceChildren(...accounts.map((a) => el('li', { style: `--acc:${a.color}` }, [
    el('span', { class: 'name', text: a.name }),
    el('span', { class: 'tag', text: a.kind === 'web' ? `Website · ${hostOf(a.url)}` : a.main ? 'Your normal Claude app' : 'Separate Claude copy' }),
    el('button', { class: 'btn ghost', type: 'button', text: 'Edit', onclick: () => openAccountDialog(a) }),
  ])));
}

$('#manage').addEventListener('click', () => { renderManageList(); openModal(manageDialog); });
$('#manage-close').addEventListener('click', () => manageDialog.close());
$('#manage-add').addEventListener('click', () => { if (manageDialog.open) manageDialog.close(); openPicker(); });
$('#add-tab').addEventListener('click', () => openPicker());

const dialog = $('#account-dialog');
let editing = null;
// The kind of tab the dialog adds or edits, and the catalogue entry a new one comes from (null: a plain Claude account).
let dialogKind = 'claude';
let dialogEntry = null;
let chosenColor = COLORS[0];

function renderSwatches() {
  $('#f-colors').replaceChildren(...COLORS.map((c) => el('button', {
    type: 'button', role: 'radio', 'aria-checked': String(c === chosenColor), 'aria-label': c, style: `--c:${c}`,
    onclick: () => { chosenColor = c; renderSwatches(); },
  })));
}

// account: the tab to edit, or null to add one. kind / entry (for a new one): what the picker chose.
function openAccountDialog(account, { kind = 'claude', entry = null } = {}) {
  editing = account;
  dialogKind = account ? account.kind || 'claude' : kind;
  dialogEntry = account ? null : entry;
  const web = dialogKind === 'web';
  const named = entry && !entry.custom ? entry.name : '';
  $('#account-dialog-title').textContent = account ? `Edit ${account.name}`
    : web ? (named ? `Add ${named}` : 'Add a website') : 'Add a Claude account';
  // A second ChatGPT tab is "ChatGPT 2", and so on.
  let suggested = named;
  for (let n = 2; suggested && accounts.some((a) => a.name === suggested); n++) suggested = `${named} ${n}`;
  $('#f-name').value = account ? account.name : web ? suggested : '';
  $('#f-name').placeholder = web ? 'e.g. ChatGPT, Gemini (work)' : 'e.g. Personal, Work, Client X';
  $('#f-url-box').hidden = !web;
  $('#f-url').required = web;
  $('#f-url').value = account ? account.url || '' : entry && entry.url ? entry.url : '';
  $('#f-share-row').hidden = web;
  const used = new Set(accounts.map((a) => a.color));
  chosenColor = account ? account.color : entry && entry.color && !used.has(entry.color) && COLORS.includes(entry.color) ? entry.color : (COLORS.find((c) => !used.has(c)) || COLORS[0]);
  renderSwatches();
  const share = $('#f-share');
  share.checked = account ? account.shareCode : true;
  share.disabled = Boolean(account && account.main);
  $('#f-share-hint').textContent = account && account.main
    ? 'This is the main account; it always uses your usual Claude Code folder.'
    : 'On: its Code tab sees your usual Claude Code settings, memory and past sessions. Off: a completely separate Claude Code setup, which also hides the sessions it already has. Usage is separate either way.';
  $('#f-link-box').hidden = !account || account.main || web;
  $('#f-link-box').open = false;
  $('#f-link').value = '';
  $('#f-delete').hidden = !account || account.main;
  $('#f-delete').textContent = web ? 'Remove tab' : 'Remove account';
  const s = account ? status[account.id] || {} : {};
  $('#f-stop').hidden = !account || !s.running || s.status === 'external' || s.status === 'stopping';
  $('#f-error').textContent = '';
  chromeTouched = false;
  renderChromeChoice();
  if (!openModal(dialog)) return;
  if (web && !$('#f-url').value) $('#f-url').focus(); else $('#f-name').focus();
  // The list on hand may be half a minute old (a new profile, a fresh sign-in); refresh it unless already changed.
  if (api.getChrome && !web) {
    api.getChrome().then((c) => {
      if (!c || !dialog.open || editing !== account) return;
      chromeInfo = c;
      if (!chromeTouched) renderChromeChoice();
    }).catch(() => {});
  }
}

// ---------- Chrome profile per account ----------

let chromeTouched = false; // the person changed the Chrome select in the open dialog

// "Automatic (Studio Labs)" first, then every Chrome profile. Hidden without Chrome or its profiles.
function renderChromeChoice() {
  const box = $('#f-chrome-box');
  const select = $('#f-chrome');
  box.hidden = dialogKind !== 'claude' || !chromeInfo.installed || !chromeInfo.profiles.length;
  if (box.hidden) return;
  const info = (editing && chromeInfo.accounts[editing.id]) || {};
  const auto = info.auto;
  const profiles = chromeInfo.profiles;
  select.replaceChildren(
    el('option', { value: '', text: auto ? `Automatic (${auto.name})` : 'Automatic (none found yet)' }),
    ...profiles.map((p) => el('option', { value: p.dir, text: p.email ? `${p.name} · ${p.email}` : p.name })),
  );
  const chosen = editing && editing.chromeProfile;
  select.value = chosen && profiles.some((p) => p.dir === chosen) ? chosen : '';
  chromeHint();
}

function chromeHint() {
  const info = (editing && chromeInfo.accounts[editing.id]) || {};
  const auto = info.auto;
  const manual = $('#f-chrome').value;
  const who = editing ? editing.name : 'this account';
  const gone = info.missing ? 'The profile picked before is no longer in Chrome. ' : '';
  $('#f-chrome-hint').textContent = manual
    ? `The Chrome button opens this profile for ${who}.`
    : auto && auto.how === 'signed-in' ? `${gone}The profile whose Claude in Chrome is signed in to ${who}.`
      : auto ? `${gone}Claude in Chrome was last signed in to ${who} in this profile (signed out now).`
        : `${gone}Sign in to Claude in Chrome as ${who} in one of your Chrome profiles, or pick one here.`;
}

$('#f-chrome').addEventListener('change', () => { chromeTouched = true; chromeHint(); });

// The account's Chrome button (Home, the switcher, the tray): main finds the profile and starts Chrome.
async function openChrome(account) {
  if (!api.openChrome) return;
  const r = await api.openChrome(account.id).catch((err) => ({ ok: false, error: err.message }));
  if (r && r.ok) { toast(`Opening Chrome · ${r.profile}`); return; }
  const a = byId(account.id);
  // Not linked yet: offer the account's settings, where a profile can be picked.
  toast((r && r.error) || 'Couldn\'t open Chrome.', r && r.unlinked && a ? { label: 'Choose', onClick: () => openAccountDialog(a) } : null);
}

function newAccountId(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'account';
  let id;
  do id = `${slug}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`; while (byId(id));
  return id;
}

$('#account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#f-name').value.trim();
  if (!name) return;
  const isNew = !editing;
  const id = editing ? editing.id : newAccountId(name);
  const web = dialogKind === 'web';
  const input = { id, name, color: chosenColor };
  if (web) {
    // "chatgpt.com" is taken as https://chatgpt.com.
    let url = $('#f-url').value.trim();
    if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
    input.url = url;
  } else input.shareCode = $('#f-share').checked;
  if (isNew) {
    input.kind = dialogKind;
    if (dialogEntry) input.catalogId = dialogEntry.id;
  }
  // Only sent when the choice is on screen, so a dialog opened without Chrome's list never clears it.
  if (!$('#f-chrome-box').hidden) input.chromeProfile = $('#f-chrome').value || null;
  const saved = await api.saveAccount(input);
  if (!saved) { $('#f-error').textContent = web ? 'That address can\'t be used. It has to start with https://.' : 'Couldn\'t save the account.'; return; }
  accounts = saved;
  dialog.close();
  if (manageDialog.open) renderManageList();
  render();
  if (isNew) {
    if (manageDialog.open) manageDialog.close();
    await show(id);
    toast(web ? `Opening ${name}… Sign in inside the tab; it's separate from your browser.` : `Starting ${name}… Sign in when its Claude window appears.`);
  }
});

$('#f-cancel').addEventListener('click', () => dialog.close());

$('#f-link-go').addEventListener('click', async () => {
  if (!editing) return;
  const r = await api.finishSignIn(editing.id, $('#f-link').value).catch((err) => ({ ok: false, error: err.message }));
  if (!r.ok) { $('#f-error').textContent = r.error || 'That didn\'t work.'; return; }
  dialog.close();
  toast(`Sent the sign-in to ${editing.name}.`);
});

$('#f-delete').addEventListener('click', async () => {
  const account = editing;
  if (!account) return;
  const ok = await confirmDialog(`Remove ${account.name}?`, account.kind === 'web'
    ? `This closes ${account.name} and deletes its sign-in, cookies and saved data on this PC. Your account on ${hostOf(account.url) || 'the site'} isn't affected.`
    : `This deletes ${account.name}'s Claude copy from this PC: its sign-in, settings and local sessions. Chats saved to the account stay on claude.ai, and your project folders are not touched.`, 'Remove');
  if (!ok) return;
  const r = await api.removeAccount(account.id).catch((err) => ({ ok: false, error: err.message }));
  if (!r.ok) { $('#f-error').textContent = r.error || 'Couldn\'t remove the account.'; return; }
  dialog.close();
  accounts = r.accounts;
  ui = r.ui;
  if (manageDialog.open) renderManageList();
  render();
  toast(`${account.name} removed.`);
});

$('#f-stop').addEventListener('click', () => { if (editing) stopAccount(editing); });

// The question after a Stop that didn't end it: it was asked and is still running after 20 s (stillRunning), or it
// couldn't be asked at all (notAsked: no window yet, or not responding), so forcing it is the only way.
function forcePrompt(account, r) {
  const all = account.main ? ' For your main Claude app, that includes every Claude Code session in it.' : '';
  if (r.notAsked) {
    const why = r.reason === 'no window' ? 'has no window yet' : 'isn\'t responding';
    return [`${account.name} couldn't be asked to quit`, `Its Claude ${why}, so it couldn't be asked to quit cleanly. Force it to stop? Everything running in it ends at once.${all}`];
  }
  return [`${account.name} didn't quit`, `Its Claude is still running after 20 seconds. Force it to stop? Anything it is in the middle of ends at once.${all}`];
}

// Asks Claude to quit cleanly; if it is still running after 20 s (or can't be asked), offers to force it.
async function stopAccount(account) {
  // Not responding: main asks in a native dialog, since one drawn here would sit under the frozen window.
  if ((status[account.id] || {}).frozen && api.stopFrozen) {
    if (dialog.open && editing && editing.id === account.id) dialog.close();
    const f = await api.stopFrozen(account.id).catch((err) => ({ ok: false, error: err.message }));
    if (f && f.cancelled) return;
    toast(f && f.ok ? `${account.name} stopped.` : (f && f.error) || `Couldn't stop ${account.name}.`);
    return;
  }
  if (account.kind === 'web') {
    const close = await confirmDialog(`Close ${account.name}?`, 'This closes the page to free its memory. You stay signed in, and can open it again from its tab.', 'Close', { primary: true });
    if (!close) return;
    if (dialog.open && editing && editing.id === account.id) dialog.close();
    const w = await api.stopAccount(account.id, false).catch((err) => ({ ok: false, error: err.message }));
    toast(w && w.ok ? `${account.name} closed.` : (w && w.error) || `Couldn't close ${account.name}.`);
    return;
  }
  const what = account.main ? 'This quits your main Claude app.' : `This quits ${account.name}'s Claude.`;
  const ok = await confirmDialog(`Stop ${account.name}?`,
    `${what} Anything it is doing stops, including any Claude Code session working in it. It stays closed until you start it again.`, 'Stop');
  if (!ok) return;
  if (dialog.open && editing && editing.id === account.id) dialog.close();
  toast(`Stopping ${account.name}…`);
  let r = await api.stopAccount(account.id, false).catch((err) => ({ ok: false, error: err.message }));
  if (r && (r.stillRunning || r.notAsked)) {
    const force = await confirmDialog(...forcePrompt(account, r), 'Force stop');
    if (!force) { toast(`${account.name} is still running.`); return; }
    r = await api.stopAccount(account.id, true).catch((err) => ({ ok: false, error: err.message }));
  }
  toast(r && r.ok ? `${account.name} stopped.` : (r && r.error) || `Couldn't stop ${account.name}.`);
}

// The tray menu's Stop items.
if (api.onRequestStop) api.onRequestStop((id) => { const a = byId(id); if (a) stopAccount(a); });

// One confirmation at a time: the dialog answers only the request it is showing. A second request while one is open
// (the tray's Stop while another confirmation is up) would otherwise rewrite the text under the first and be answered
// by the same click, so the request it replaces is answered "no" (never confirmed). One that was just closed but whose
// close event hasn't come yet keeps the answer it was given.
const confirmBox = $('#confirm-dialog');
let confirmWait = null; // the resolve of the request the dialog is showing
function settleConfirm(value) {
  const resolve = confirmWait;
  confirmWait = null;
  if (resolve) resolve(value);
}
// The close event comes a moment after close(); by then a newer request may have opened it again, and is left alone.
confirmBox.addEventListener('close', () => { if (!confirmBox.open) settleConfirm(confirmBox.returnValue === 'ok'); });

// primary: the OK button is the main action (not a destructive one); tag: a small label after the title (e.g. "Beta").
function confirmDialog(title, text, okLabel, { primary = false, tag = null } = {}) {
  settleConfirm(confirmBox.open ? false : confirmBox.returnValue === 'ok');
  $('#confirm-title').replaceChildren(...[title, tag ? el('span', { class: 'beta', text: tag }) : null].filter(Boolean));
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  $('#confirm-ok').className = `btn ${primary ? 'primary' : 'danger'}`;
  confirmBox.returnValue = '';
  const answer = new Promise((resolve) => { confirmWait = resolve; });
  if (!openModal(confirmBox)) settleConfirm(false); // a frozen window is on screen (openModal says so)
  return answer;
}

// ---------- settings ----------

// The Settings dialog is built from this list: one line per setting, shown under its group in this order.
// The keys, types and defaults live in main.js (DEFAULT_SETTINGS). installedOnly: greyed out when run from source.
const SETTINGS = [
  { key: 'startWithWindows', group: 'Startup', label: 'Start with Windows', hint: 'Opens in the tray when you sign in, with every account running.', installedOnly: true },
  { key: 'startHidden', group: 'Startup', label: 'Start in the tray', hint: 'Every account still starts. Click the tray icon to open the window.' },
  { key: 'closeToTray', group: 'Window', label: 'Close to the tray', hint: 'The close button hides Kitsun and your accounts keep running. Quit from the tray icon\'s menu.' },
  { key: 'autoRestart', group: 'Keeping accounts running', label: 'Restart an account if its Claude quits', hint: 'If an account\'s Claude closes for a Claude update or crashes, it starts again in its tab (up to 3 times in 10 minutes). Never after you quit or stop it yourself.' },
  { key: 'notifyNeedsYou', group: 'Notifications', label: 'When an account needs you', hint: 'A Claude Code session in a tab you aren\'t looking at asks for permission, asks a question, or stops to wait for your answer.' },
  { key: 'notifyLimits', group: 'Notifications', label: 'When an account nears its usage limit', hint: 'It reaches 90% of its 5-hour or weekly plan limit (with the account that has the most left), or its 5-hour limit resets.' },
  { key: 'notifyRestarts', group: 'Notifications', label: 'When Claude updates or an account freezes', hint: 'While Kitsun is in the background: which accounts were reopened after a Claude update or crash, and any that stopped responding.' },
];

const settingsDialog = $('#settings-dialog');
let settings = {};
let canStartWithWindows = false;

function settingRow(s) {
  const unavailable = Boolean(s.installedOnly && !canStartWithWindows);
  const id = `setting-${s.key}`;
  return el('label', { class: `setting${unavailable ? ' disabled' : ''}`, for: id }, [
    el('span', { class: 'setting-text' }, [
      el('span', { class: 'setting-label', text: s.label }),
      el('small', { class: 'muted', text: unavailable ? `${s.hint} Only in the installed app (not a run from source or the dist build).` : s.hint }),
    ]),
    el('input', {
      type: 'checkbox', role: 'switch', class: 'switch', id,
      checked: settings[s.key] === true, disabled: unavailable,
      onchange: (e) => changeSetting(s.key, e.target.checked),
    }),
  ]);
}

function renderSettings() {
  const groups = [...new Set(SETTINGS.map((s) => s.group))];
  $('#settings-list').replaceChildren(...groups.map((g) => el('section', { class: 'settings-group' }, [
    el('h3', { text: g }),
    ...SETTINGS.filter((s) => s.group === g).map(settingRow),
  ])));
}

async function changeSetting(key, value) {
  $('#settings-error').textContent = '';
  const r = await api.setSettings({ [key]: value }).catch((err) => ({ ok: false, error: err.message }));
  if (r && r.settings) settings = r.settings;
  // On failure, redraw so the switch shows the value that was actually kept.
  if (!r || !r.ok) {
    $('#settings-error').textContent = (r && r.error) || 'Couldn\'t save that setting.';
    renderSettings();
  }
}

async function openSettings() {
  const r = api.getSettings ? await api.getSettings().catch(() => null) : null;
  if (!r) { toast('Couldn\'t load the settings.'); return; }
  settings = r.settings;
  canStartWithWindows = r.canStartWithWindows === true;
  $('#settings-error').textContent = '';
  renderSettings();
  if (!settingsDialog.open) openModal(settingsDialog);
}

$('#settings').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', () => settingsDialog.close());
// The tray menu's "Settings…" item.
if (api.onOpenSettings) api.onOpenSettings(openSettings);

// ---------- quick switcher (Ctrl+Alt+K, the search button, Home's search box) ----------

// One list for everything: places to go, actions, and sessions from every account (main's search index, as you type).
const switcher = $('#switcher');
const swInput = $('#sw-input');
const SW_DEBOUNCE = 120;
let swItems = []; // rows in order: { key, group, label, sub, dot, icon, right, kbd, run, opensDialog, plain }
let swActiveKey = null;
let swResults = null; // null while the first answer for the current text is on its way
let swTimer = null;
let swSeq = 0;

function agoText(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const swTokens = (text) => text.toLowerCase().split(/\s+/).filter(Boolean);

// Text with every occurrence of the typed words marked (as text nodes, never markup).
function marked(text, tokens) {
  const lower = text.toLowerCase();
  const hits = new Array(text.length).fill(false);
  for (const t of tokens) for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + 1)) hits.fill(true, i, i + t.length);
  const out = [];
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && hits[j] === hits[i]) j++;
    out.push(hits[i] ? el('mark', { text: text.slice(i, j) }) : text.slice(i, j));
    i = j;
  }
  return out;
}

function accountState(a) {
  const s = status[a.id] || {};
  if (s.frozen) return 'Not responding';
  if (s.status === 'docked') return a.kind === 'web' ? 'Open' : 'Running';
  if (s.status === 'starting') return 'Starting…';
  if (s.status === 'stopping') return 'Stopping…';
  if (s.status === 'external') return 'Open in its own window';
  return closedText(a, s.exit).short;
}

// Places and actions. words: extra terms each one is also found by.
function switcherCommands() {
  const cmds = [{ key: 'home', group: 'Go to', icon: 'home', label: 'Home', sub: 'Every tab at a glance', kbd: 'Ctrl+Alt+0', words: 'dashboard stats usage', run: async () => { ui = await api.goHome(); render(); } }];
  accounts.forEach((a, idx) => {
    const att = sessions[a.id] || {};
    const extra = att.waiting ? ` · ${att.waiting} need${att.waiting === 1 ? 's' : ''} you` : '';
    cmds.push({ key: `go:${a.id}`, group: 'Go to', dot: a.color, label: a.name, sub: `${a.kind === 'web' ? `${hostOf(a.url)} · ` : ''}${accountState(a)}${extra}`, kbd: idx < 9 ? `Ctrl+Alt+${idx + 1}` : null, words: 'account tab switch', run: () => show(a.id) });
  });
  cmds.push(
    { key: 'settings', group: 'Actions', icon: 'settings', label: 'Settings', words: 'preferences options tray notifications startup', opensDialog: true, run: openSettings },
    { key: 'add', group: 'Actions', icon: 'add', label: 'Add an AI…', words: 'new tab account website app chatgpt gemini perplexity picker', opensDialog: true, run: () => openPicker() },
    { key: 'manage', group: 'Actions', icon: 'manage', label: 'Manage tabs', words: 'accounts add edit rename colour color remove', opensDialog: true, run: () => { renderManageList(); openModal(manageDialog); } },
  );
  // The other layouts there are enough accounts for. Run before the switcher closes, so the Claude windows show only
  // once the new panes are in place.
  for (const c of LAYOUT_CHOICES) {
    if (c.name === currentLayout() || accounts.length < c.need || accounts.length < 2) continue;
    cmds.push({ key: `layout:${c.name}`, group: 'Actions', icon: c.name, label: c.cmd, words: 'layout split view side by side panes columns single one two three', whileHidden: true, run: () => chooseLayout(c.name) });
  }
  for (const a of accounts) {
    const s = status[a.id] || {};
    // A frozen account's Stop goes through main's own dialog (see stopAccount); the switcher leaves it to the title
    // bar's Wait / Restart.
    if (s.frozen) continue;
    if (s.status === 'stopped') {
      cmds.push({ key: `start:${a.id}`, group: 'Actions', icon: 'start', dot: a.color, label: `${a.kind === 'web' ? 'Open' : 'Start'} ${a.name}`, words: 'run open launch', run: () => { api.startAccount(a.id); toast(`Starting ${a.name}…`); } });
    } else if (s.running && s.status !== 'external' && s.status !== 'stopping') {
      // Not awaited: stopAccount opens its confirmation at once and waits on it.
      cmds.push({ key: `stop:${a.id}`, group: 'Actions', icon: 'stop', dot: a.color, label: `${a.kind === 'web' ? 'Close' : 'Stop'} ${a.name}…`, words: 'quit close end', opensDialog: true, run: () => { stopAccount(a); } });
    }
  }
  // Each account's linked Chrome profile (only those that have one).
  for (const a of chromeInfo.installed ? claudeAccounts() : []) {
    const link = (chromeInfo.accounts[a.id] || {}).link;
    if (link) cmds.push({ key: `chrome:${a.id}`, group: 'Actions', icon: 'chrome', dot: a.color, label: `Open Chrome for ${a.name}`, sub: link.name, words: 'chrome browser profile extension', run: () => { openChrome(a); } });
  }
  return cmds;
}

function buildSwitcherItems() {
  const text = swInput.value.trim();
  const tokens = swTokens(text);
  let cmds = switcherCommands();
  if (tokens.length) {
    cmds = cmds.filter((c) => { const hay = `${c.label} ${c.words || ''}`.toLowerCase(); return tokens.every((t) => hay.includes(t)); }).slice(0, 6);
  }
  const found = [];
  const results = swResults || [];
  const group = tokens.length ? 'Sessions' : 'Recent sessions';
  for (const r of results) {
    const a = byId(r.accountId);
    if (!a) continue;
    found.push({
      key: `s:${r.accountId}:${r.sessionId}`, group, dot: a.color, label: r.title, sub: r.snippet || r.folder || '',
      right: [a.name, r.archived ? 'archived' : null, agoText(r.at)].filter(Boolean).join(' · '),
      run: () => openFound(r),
      handoff: { accountId: r.accountId, sessionId: r.sessionId, title: r.title },
    });
  }
  // Plain rows say what is going on; they can't be chosen.
  if (tokens.length && swResults === null) found.push({ key: 'busy', group, plain: true, label: 'Searching every account…' });
  else if (tokens.length && !found.length) found.push({ key: 'none', group, plain: true, label: cmds.length ? 'No sessions match' : `Nothing matches “${text}”` });
  // Typed: matching places and actions, then sessions. Empty: places, the latest sessions, then actions.
  const items = tokens.length ? [...cmds, ...found] : [...cmds.filter((c) => c.group === 'Go to'), ...found, ...cmds.filter((c) => c.group !== 'Go to')];
  return { items, tokens };
}

const SW_ICONS = {
  home: 'M4 11l8-7 8 7M6 9.5V20h12V9.5',
  settings: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1',
  manage: 'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M21 19v-1a4 4 0 0 0-3-3.9M15.5 3.6a3.5 3.5 0 0 1 0 6.8',
  single: 'M3 5h18v14H3z',
  split: 'M3 5h7v14H3zM14 5h7v14h-7z',
  triple: 'M2 5h5.5v14H2zM9.25 5h5.5v14h-5.5zM16.5 5H22v14h-5.5z',
  start: 'M8 5l11 7-11 7z',
  stop: 'M6 6h12v12H6z',
  // A browser window: frame, tab strip and a dot for the address bar.
  chrome: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5zM3 9h18M6 7h.01M8.5 7h.01',
  add: 'M12 5v14M5 12h14',
  // Continue in another account: an arrow leaving one box for another.
  handoff: 'M4 5h7v14H4zM14 12h7M18 8.5l3.5 3.5-3.5 3.5',
};

// An action's icon (Start / Stop take their account's colour), or an account's colour dot.
function swIcon(it) {
  if (it.icon && SW_ICONS[it.icon]) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', SW_ICONS[it.icon]);
    s.append(p);
    return el('span', { class: `sw-icon${it.dot ? ' tinted' : ''}`, style: it.dot ? `--acc:${it.dot}` : null }, [s]);
  }
  return el('span', { class: 'sw-icon' }, [it.dot ? el('i', { class: 'sw-dot', style: `--acc:${it.dot}` }) : null]);
}

function renderSwitcher() {
  const { items, tokens } = buildSwitcherItems();
  swItems = items;
  const choosable = items.filter((it) => !it.plain);
  if (!choosable.some((it) => it.key === swActiveKey)) swActiveKey = choosable.length ? choosable[0].key : null;
  const rows = [];
  let lastGroup = null;
  items.forEach((it, n) => {
    if (it.group !== lastGroup) { lastGroup = it.group; rows.push(el('div', { class: 'sw-group', role: 'presentation', text: it.group })); }
    if (it.plain) { rows.push(el('div', { class: 'sw-plain', role: 'presentation', text: it.label })); return; }
    const active = it.key === swActiveKey;
    rows.push(el('div', {
      class: `sw-item${active ? ' active' : ''}`, role: 'option', id: `sw-opt-${n}`, 'aria-selected': String(active),
      onmousemove: () => { if (swActiveKey !== it.key) setSwitcherActive(it.key); },
      onclick: () => runSwitcherItem(it),
    }, [
      swIcon(it),
      el('span', { class: 'sw-main' }, [
        el('span', { class: 'sw-label' }, marked(it.label, tokens)),
        it.sub ? el('span', { class: 'sw-sub' }, marked(it.sub, tokens)) : null,
      ]),
      it.right ? el('span', { class: 'sw-right', text: it.right }) : null,
      it.kbd ? el('kbd', { class: 'sw-kbd', text: it.kbd }) : null,
      // A session can be carried on in another account (shown on the chosen or hovered row; Ctrl+Enter does it too).
      it.handoff && claudeAccounts().length > 1 ? el('button', {
        class: 'sw-handoff', type: 'button', tabindex: '-1',
        'data-hint': 'Continue in another account · Ctrl+Enter', 'aria-label': `Continue “${it.label}” in another account`,
        onclick: (e) => { e.stopPropagation(); handoffFromSwitcher(it, e.currentTarget); },
      }, [handoffIcon(), el('span', { text: 'Continue in…' })]) : null,
    ]));
  });
  $('#sw-list').replaceChildren(...rows);
  syncSwitcherActive();
}

function setSwitcherActive(key) {
  swActiveKey = key;
  for (const node of document.querySelectorAll('#sw-list .sw-item')) {
    const it = swItems[Number(node.id.slice(7))];
    const on = Boolean(it && it.key === key);
    node.classList.toggle('active', on);
    node.setAttribute('aria-selected', String(on));
  }
  syncSwitcherActive();
}

function syncSwitcherActive() {
  const n = swItems.findIndex((it) => it.key === swActiveKey);
  const node = n >= 0 ? document.getElementById(`sw-opt-${n}`) : null;
  if (node) { swInput.setAttribute('aria-activedescendant', node.id); node.scrollIntoView({ block: 'nearest' }); } else swInput.removeAttribute('aria-activedescendant');
}

function moveSwitcher(step) {
  const choosable = swItems.filter((it) => !it.plain);
  if (!choosable.length) return;
  const at = choosable.findIndex((it) => it.key === swActiveKey);
  setSwitcherActive(choosable[(at + step + choosable.length) % choosable.length].key);
}

// One that opens another dialog (or changes the layout: whileHidden) runs first, so the Claude windows stay hidden in
// between; the rest after closing.
async function runSwitcherItem(it) {
  if (!it || it.plain) return;
  if (it.opensDialog || it.whileHidden) {
    await it.run();
    switcher.close();
    return;
  }
  switcher.close();
  it.run();
}

async function openFound(r) {
  const a = byId(r.accountId);
  if (!a || !api.openSession) return;
  const res = await api.openSession(a.id, r.sessionId).catch((err) => ({ ok: false, error: err.message }));
  if (!res || !res.ok) { toast((res && res.error) || `Couldn't open “${r.title}”.`); return; }
  // Claude only opens sessions that aren't archived; for those, its tab is shown and the person picks it there.
  if (!res.opened) toast(`Open “${r.title}” from Claude's sidebar${r.archived ? ' (it is archived)' : ''}`);
}

// Answers for the current text, a moment after typing stops; an older answer arriving late is dropped.
function querySwitcher(now = false) {
  clearTimeout(swTimer);
  const run = async () => {
    const seq = ++swSeq;
    const text = swInput.value.trim();
    const r = api.searchSessions ? await api.searchSessions(text).catch(() => []) : [];
    if (seq !== swSeq || !switcher.open) return;
    swResults = Array.isArray(r) ? r : [];
    renderSwitcher();
  };
  if (now) run(); else swTimer = setTimeout(run, SW_DEBOUNCE);
}

// text: what to start with (Home's search box hands over what was typed there).
function openSwitcher(text = '') {
  swInput.value = String(text).slice(0, 200);
  swResults = null;
  swActiveKey = null;
  if (!switcher.open && !openModal(switcher)) return;
  swInput.focus();
  swInput.setSelectionRange(swInput.value.length, swInput.value.length);
  renderSwitcher();
  querySwitcher(true);
}

swInput.addEventListener('input', () => {
  swResults = null;
  swActiveKey = null; // typing starts again from the best match
  renderSwitcher();
  querySwitcher();
});
swInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveSwitcher(e.key === 'ArrowDown' ? 1 : -1); return; }
  if (e.key === 'Enter' && e.ctrlKey) {
    e.preventDefault();
    const it = swItems.find((x) => x.key === swActiveKey);
    const n = swItems.indexOf(it);
    if (it && it.handoff && claudeAccounts().length > 1) handoffFromSwitcher(it, document.getElementById(`sw-opt-${n}`));
    return;
  }
  if (e.key === 'Enter') { e.preventDefault(); runSwitcherItem(swItems.find((it) => it.key === swActiveKey)); }
});
// The close event comes a moment after close(); by then the switcher may be open again (and querying), so only a
// switcher that is still closed drops its pending query. A late answer for a closed one is dropped in querySwitcher.
switcher.addEventListener('close', () => { if (!switcher.open) clearTimeout(swTimer); });
// A click on the dimmed backdrop (outside the box) closes it, as Esc does.
switcher.addEventListener('mousedown', (e) => {
  const r = switcher.getBoundingClientRect();
  if (e.target === switcher && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) switcher.close();
});

$('#search').addEventListener('click', () => openSwitcher());
// Ctrl+Alt+K (a global shortcut in main while Kitsun is in front) and the tray's "Search…": opens, or closes again.
if (api.onOpenSwitcher) api.onOpenSwitcher(() => { if (switcher.open) switcher.close(); else openSwitcher(); });

// ---------- continue a session in another account (beta) ----------

// When one account has used up its plan, another can carry a Claude Code session on: main copies the conversation
// into a NEW session in that account (lib/handoff.js) and never changes the original. The page only names the
// accounts and the session. Only accounts sharing the usual Claude Code folder can read each other's conversations.
const handoffMenu = $('#handoff-menu');
let handoffFor = null; // { accountId, sessionId, title } the open menu is for

function handoffIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', SW_ICONS.handoff);
  s.append(p);
  return s;
}

// The other accounts. ok: it can read this session's conversation. The one with the most 5-hour usage left is marked.
function handoffTargets(fromId) {
  const from = byId(fromId);
  const list = claudeAccounts().filter((a) => a.id !== fromId).map((a) => {
    const ok = Boolean(from && from.shareCode && a.shareCode);
    const u = (sessions[a.id] || {}).usage;
    const s = status[a.id] || {};
    const state = s.status === 'stopped' ? 'not running' : s.status === 'external' ? 'in its own window' : null;
    return { a, ok, u, state };
  });
  const best = list.filter((t) => t.ok && t.u).sort((x, y) => x.u.fiveHour - y.u.fiveHour)[0];
  return list.map((t) => ({
    ...t,
    sub: !t.ok ? 'Uses its own Claude Code folder'
      : [t.u ? `5-hour ${Math.round(t.u.fiveHour)}% · weekly ${Math.round(t.u.weekly)}%` : 'No usage data yet', t === best ? 'most left' : null, t.state].filter(Boolean).join(' · '),
  }));
}

function renderHandoffMenu() {
  const s = handoffFor;
  $('#handoff-head').replaceChildren(
    el('div', { class: 'menu-head' }, [el('span', { text: 'Continue in…' }), el('span', { class: 'beta', text: 'Beta' })]),
    el('div', { class: 'menu-head-sub', text: s.title }),
  );
  $('#handoff-list').replaceChildren(...handoffTargets(s.accountId).map((t) => el('button', {
    class: 'menu-item', type: 'button', role: 'menuitem', style: `--acc:${t.a.color}`, 'aria-disabled': t.ok ? null : 'true',
    'data-hint': t.ok ? null : `${t.a.name} has its own Claude Code folder, so it can't read this conversation`,
    onclick: () => { if (t.ok) chooseHandoffTarget(t.a); },
  }, [
    el('span', { class: 'menu-icon' }, [el('i', { class: 'menu-dot' })]),
    el('span', { class: 'menu-text' }, [
      el('span', { class: 'menu-label', text: t.a.name }),
      el('small', { class: 'menu-sub', text: t.sub }),
    ]),
  ])));
}

// session: { accountId, sessionId, title }; anchor: what was clicked (the menu opens beside it, inside the window).
function openHandoffMenu(session, anchor) {
  if (!api.startHandoff || !session || !session.sessionId || accounts.length < 2) return;
  handoffFor = session;
  renderHandoffMenu();
  anchor.scrollIntoView({ block: 'nearest' });
  const b = anchor.getBoundingClientRect();
  if (!openModal(handoffMenu)) return;
  const w = handoffMenu.offsetWidth;
  const h = handoffMenu.offsetHeight;
  // Below what was clicked, or above it when there is no room below; never outside the window.
  const top = b.bottom + 6 + h > innerHeight - 8 ? b.top - h - 6 : b.bottom + 6;
  handoffMenu.style.left = `${Math.max(8, Math.min(b.right - w, innerWidth - w - 8))}px`;
  handoffMenu.style.top = `${Math.max(8, Math.min(top, innerHeight - h - 8))}px`;
  const first = handoffMenu.querySelector('.menu-item:not([aria-disabled="true"])');
  if (first) first.focus();
}

// From the switcher: the menu opens over it first, so the Claude windows stay hidden while the switcher closes.
function handoffFromSwitcher(it, anchor) {
  openHandoffMenu(it.handoff, anchor || swInput);
  if (handoffMenu.open) switcher.close();
}

handoffMenu.addEventListener('keydown', (e) => {
  const items = [...handoffMenu.querySelectorAll('.menu-item:not([aria-disabled="true"])')];
  const at = items.indexOf(document.activeElement);
  const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[e.key];
  if (to === undefined || !items.length) return;
  e.preventDefault();
  items[(to + items.length) % items.length].focus();
});
handoffMenu.addEventListener('mousedown', (e) => {
  const r = handoffMenu.getBoundingClientRect();
  if (e.target === handoffMenu && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) handoffMenu.close();
});

async function chooseHandoffTarget(a) {
  const s = handoffFor;
  const from = byId(s.accountId);
  if (!from) return;
  const st = status[a.id] || {};
  const after = st.status === 'stopped' ? `${a.name} isn't running; it starts with the new session open.`
    : `${a.name}'s Claude lists the new session after a restart; you'll be asked first.`;
  // Opened before the menu closes, so the Claude windows stay hidden in between.
  const answer = confirmDialog(`Continue “${s.title}” in ${a.name}?`,
    `Kitsun copies this conversation into a new session in ${a.name}, so you can carry on with ${a.name}'s usage. `
    + `The original stays in ${from.name} as it is, and the two don't sync. The new one starts with ${a.name}'s own model, permission mode and connectors. ${after}`,
    'Continue', { primary: true, tag: 'Beta' });
  handoffMenu.close();
  if (!(await answer)) return;
  toast(`Copying “${s.title}” to ${a.name}…`);
  const r = await api.startHandoff({ sessionId: s.sessionId, fromAccountId: from.id, toAccountId: a.id }).catch((err) => ({ ok: false, error: err.message }));
  if (!r || !r.ok) { toast((r && r.error) || `Couldn't continue “${s.title}” in ${a.name}.`); return; }
  if (r.needsRestart && r.canRestart) { offerHandoffRestart(a, r); return; }
  if (r.needsRestart) { toast(`“${r.title}” is ready in ${a.name}. Quit ${a.name}'s own Claude window (File > Exit) to see it here.`); return; }
  if (!r.started) { toast(`“${r.title}” is ready in ${a.name}, but it didn't start: ${r.error || 'try Start'}.`); return; }
  toast(r.opened ? `Continuing “${r.title}” in ${a.name}` : `“${r.title}” is in ${a.name}; open it from Claude's sidebar.`);
}

// The target's Claude is running: it lists the new session only after it restarts (a clean quit, as Stop does).
async function offerHandoffRestart(a, r) {
  const later = () => toast(`“${r.title}” is ready in ${a.name}. It shows after ${a.name} restarts.`, { label: 'Restart', onClick: () => offerHandoffRestart(a, r) });
  const working = (sessions[a.id] || {}).working || 0;
  const what = a.main ? 'This quits your main Claude app and opens it again' : `This quits ${a.name}'s Claude and starts it again`;
  const busy = working ? `${working} Claude Code session${working === 1 ? ' is' : 's are'} working in it now and will stop.` : 'Anything running in it stops, including any Claude Code session working there.';
  const ok = await confirmDialog(`Restart ${a.name} to show it?`,
    `${a.name}'s Claude reads its list of sessions when it starts. ${what}, with “${r.title}” open. ${busy}`, `Restart ${a.name}`);
  if (!ok) { later(); return; }
  toast(`Restarting ${a.name}…`);
  let res = await api.restartForHandoff(a.id, r.sessionId).catch((err) => ({ ok: false, error: err.message }));
  if (res && (res.stillRunning || res.notAsked)) {
    const force = await confirmDialog(...forcePrompt(a, res), 'Force stop');
    if (!force) { later(); return; }
    const s = await api.stopAccount(a.id, true).catch((err) => ({ ok: false, error: err.message }));
    if (!s || !s.ok) { toast((s && s.error) || `Couldn't stop ${a.name}.`); return; }
    res = await api.restartForHandoff(a.id, r.sessionId).catch((err) => ({ ok: false, error: err.message }));
  }
  if (!res || !res.ok) { toast((res && res.error) || `Couldn't restart ${a.name}.`); return; }
  toast(res.opened ? `Continuing “${r.title}” in ${a.name}` : `“${r.title}” is in ${a.name}; open it from Claude's sidebar.`);
}

// ---------- add an AI (the picker) ----------

// main (lib/catalog.js) lists what can be added and which of it is on this PC; the page only names entries by id.
// Choosing a Claude or website entry opens the tab dialog for it. A kind that can't be added yet says so, and anything
// not installed has "Get it" (its download page, opened by main in the default browser).
const picker = $('#picker');
let catalogData = null;
let pickerGroup = 'All';
let fetchedSince = false; // "Get it" was used: look at the PC again next time, the app may be installed by then

async function openPicker() {
  if (!picker.open && !openModal(picker)) return;
  $('#pk-search').value = '';
  pickerGroup = 'All';
  renderPicker();
  $('#pk-search').focus();
  if (!api.getCatalog) return;
  const c = await api.getCatalog(fetchedSince).catch(() => null);
  fetchedSince = false;
  if (c) { catalogData = c; if (picker.open) renderPicker(); }
}

function pickerInitials(name) {
  const words = name.replace(/\(.*\)/, '').trim().split(/\s+/);
  return (words.length > 1 && words[1][0] === words[1][0].toUpperCase() ? words[0][0] + words[1][0] : name.slice(0, 1)).toUpperCase();
}

function renderPicker() {
  const typed = $('#pk-search').value.trim();
  const tokens = typed.toLowerCase().split(/\s+/).filter(Boolean);
  if (!catalogData) {
    $('#pk-groups').replaceChildren();
    $('#pk-list').replaceChildren(el('p', { class: 'muted pk-empty', text: 'Looking at what\'s on this PC…' }));
    return;
  }
  // While searching, every group is searched.
  $('#pk-groups').replaceChildren(...['All', ...catalogData.groups].map((g) => el('button', {
    class: 'pk-chip', type: 'button', role: 'tab', 'aria-selected': String(!tokens.length && g === pickerGroup), text: g,
    onclick: () => { pickerGroup = g; $('#pk-search').value = ''; renderPicker(); },
  })));
  const match = (e) => {
    const hay = `${e.name} ${e.by} ${e.blurb} ${e.group} ${KIND_NAMES[e.kind]} ${e.url ? hostOf(e.url) : ''}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  };
  const shown = catalogData.entries.filter((e) => (tokens.length || pickerGroup === 'All' || e.group === pickerGroup) && match(e));
  const sections = catalogData.groups.map((g) => {
    const list = shown.filter((e) => e.group === g);
    return list.length ? el('section', { class: 'pk-section' }, [el('h3', { text: g }), el('div', { class: 'pk-grid' }, list.map(pickerCard))]) : null;
  }).filter(Boolean);
  $('#pk-list').replaceChildren(...(sections.length ? sections
    : [el('p', { class: 'muted pk-empty', text: `Nothing matches “${typed}”. Add it by its address with “Any website” (under Your own).` })]));
  const found = catalogData.entries.filter((e) => e.installed === true).length;
  $('#pk-note').textContent = `${found} found on this PC · each website tab has its own sign-in`;
}

function pickerCard(e) {
  const added = accounts.filter((a) => a.catalogId === e.id).length;
  const state = e.soon ? ['soon', e.installed ? 'On this PC · coming soon' : 'Coming soon']
    : e.installed === true ? ['ok', 'On this PC']
      : e.installed === false ? ['missing', 'Not installed'] : null;
  return el('div', { class: `pk-card${e.soon ? ' soon' : ''}`, style: `--acc:${e.color}` }, [
    el('button', {
      class: 'pk-main', type: 'button',
      'aria-label': `${e.name}${e.by ? ` by ${e.by}` : ''}, ${KIND_NAMES[e.kind]}${state ? `, ${state[1]}` : ''}`,
      onclick: () => choosePickerEntry(e),
    }, [
      el('span', { class: 'pk-logo', 'aria-hidden': 'true', text: e.custom ? '+' : pickerInitials(e.name) }),
      el('span', { class: 'pk-text' }, [
        el('span', { class: 'pk-name' }, [el('span', { text: e.name }), added ? el('span', { class: 'pk-added', text: added === 1 ? 'Added' : `${added} added` }) : null]),
        el('small', { class: 'pk-by', text: [e.by, KIND_NAMES[e.kind]].filter(Boolean).join(' · ') }),
        el('span', { class: 'pk-blurb', text: e.blurb }),
      ]),
    ]),
    el('div', { class: 'pk-foot' }, [
      state ? el('span', { class: `pk-state ${state[0]}`, text: state[1] }) : el('span', { class: 'pk-state web', text: e.url ? hostOf(e.url) : '' }),
      e.canGet && e.installed === false ? el('button', { class: 'btn ghost small', type: 'button', text: 'Get it', onclick: () => getIt(e) }) : null,
    ]),
  ]);
}

async function getIt(e) {
  if (!api.getIt) return;
  fetchedSince = true;
  const ok = await api.getIt(e.id).catch(() => false);
  toast(ok ? `Opening ${e.name}'s download page in your browser. Add it here once it's installed.` : `Couldn't open ${e.name}'s download page.`);
}

function choosePickerEntry(e) {
  if (e.soon) {
    toast(`${KIND_NAMES[e.kind]} tabs come in the next Kitsun update.${e.installed === false && e.canGet ? ' You can get it already.' : ''}`,
      e.installed === false && e.canGet ? { label: 'Get it', onClick: () => getIt(e) } : null);
    return;
  }
  if (e.kind === 'claude' && e.installed === false) {
    toast('The Claude desktop app isn\'t installed yet.', { label: 'Get it', onClick: () => getIt(e) });
    return;
  }
  // The tab dialog opens over the picker before it closes, so the panes don't flash in between.
  openAccountDialog(null, { kind: e.kind, entry: e });
  if (dialog.open) picker.close();
}

$('#pk-search').addEventListener('input', renderPicker);
$('#pk-search').addEventListener('keydown', (e) => {
  // Enter adds the first match.
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const first = picker.querySelector('.pk-card:not(.soon) .pk-main');
  if (first) first.click();
});
$('#pk-close').addEventListener('click', () => picker.close());
picker.addEventListener('mousedown', (e) => {
  const r = picker.getBoundingClientRect();
  if (e.target === picker && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) picker.close();
});

// ---------- title-bar hints ----------

// Windows' own tooltips get stuck when the mouse moves from the title bar straight onto a docked
// Claude window (another program), so hints are shown as text in the title bar instead.
const hint = $('#hint');
let hintTimer = null;
const clearHint = () => { hint.textContent = ''; };
document.addEventListener('mouseover', (e) => {
  const target = e.target.closest && e.target.closest('[data-hint]');
  hint.textContent = target ? target.dataset.hint : '';
  // The page may never hear that the mouse left (it went onto a Claude window), so hints also fade on their own.
  clearTimeout(hintTimer);
  if (target) hintTimer = setTimeout(clearHint, 4000);
});
document.documentElement.addEventListener('mouseleave', clearHint);
window.addEventListener('blur', clearHint);

// ---------- misc ----------

// action: { label, onClick } adds a button (e.g. "Switch"); such a toast stays longer, and while the mouse is on it.
let toastTimer = null;
let toastMs = 5000;
function toast(message, action = null) {
  const t = $('#toast');
  // replaceChildren() would show a null as the text "null", so the button is only passed when there is one.
  t.replaceChildren(...[
    el('span', { class: 'toast-text', text: message }),
    action ? el('button', { class: 'toast-action', type: 'button', text: action.label, onclick: () => { t.classList.remove('show'); action.onClick(); } }) : null,
  ].filter(Boolean));
  t.classList.toggle('has-action', Boolean(action));
  t.classList.add('show');
  toastMs = action ? 10000 : 5000;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), toastMs);
}
$('#toast').addEventListener('mouseenter', () => clearTimeout(toastTimer));
$('#toast').addEventListener('mouseleave', () => {
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3000);
});

api.onStatus((s) => {
  status = s;
  for (const id of restarting) if ((s[id] || {}).status !== 'external') restarting.delete(id);
  render();
  if (switcher.open) renderSwitcher(); // its Start / Stop actions follow the accounts' state
});
api.onUi((next) => { ui = next; render(); });
// Claude updated, an account was reopened, froze or recovered (main also notifies Windows when we're in the background).
// A session needs you, or an account nears its plan limit: those carry a button that shows an account.
if (api.onNotice) {
  api.onNotice((n) => {
    if (!n || typeof n.text !== 'string') return;
    const target = n.action && byId(n.action.id);
    toast(n.text, target ? { label: String(n.action.label || 'Show'), onClick: () => show(target.id) } : null);
  });
}
// "Needs you" badges and usage rings (main polls every few seconds and sends only changes).
if (api.onSessions) {
  api.onSessions((s) => {
    sessions = s && typeof s === 'object' ? s : {};
    renderTabs();
    if (ui.home) Home.attention();
  });
}
// Which Chrome profile each account's Chrome button opens (main re-checks every half minute and sends only changes).
if (api.onChrome) {
  api.onChrome((c) => {
    if (!c || typeof c !== 'object') return;
    chromeInfo = c;
    if (ui.home) Home.chrome();
    if (switcher.open) renderSwitcher();
  });
}

async function init() {
  const state = await api.getState();
  accounts = state.accounts;
  ui = state.ui;
  status = state.status;
  if (api.getSessions) sessions = (await api.getSessions().catch(() => null)) || {};
  render();
  // Reading Chrome's profiles takes a moment the first time; the window doesn't wait for it.
  if (api.getChrome) {
    api.getChrome().then((c) => {
      if (!c) return;
      chromeInfo = c;
      if (ui.home) Home.chrome();
    }).catch(() => {});
  }
  if (!accounts.length) openPicker();
  else if (!state.claudeInstalled && claudeAccounts().length) toast('The Claude desktop app isn\'t installed. Get it from claude.ai/download.');
}
// home.js loads after this file and render() needs it, so start once every script has run.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
