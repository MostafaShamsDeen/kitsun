// A terminal tab's page: xterm.js drawing the pseudo console main runs for this tab (see "terminal tabs" in main.js).
// Ctrl+C copies when text is selected (else it goes to the program, as ^C); Ctrl+V pastes; right-click copies the
// selection, or pastes when nothing is selected, as in Windows Terminal. Links open in the default browser.
(async () => {
  const api = window.kitsunTerm;
  const term = new Terminal({
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 5000,
    allowTransparency: false,
    theme: {
      background: '#0d0f15', foreground: '#edf0f7', cursor: '#ff7b3a', cursorAccent: '#0d0f15',
      selectionBackground: 'rgba(255, 123, 58, 0.32)',
      black: '#1b202b', red: '#f87171', green: '#34d399', yellow: '#fbbf24', blue: '#5b9dff', magenta: '#c084fc', cyan: '#22d3ee', white: '#d4d8e2',
      brightBlack: '#5d667c', brightRed: '#fca5a5', brightGreen: '#6ee7b7', brightYellow: '#fde68a', brightBlue: '#93c0ff', brightMagenta: '#ddb6fe', brightCyan: '#67e8f9', brightWhite: '#ffffff',
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => api.openLink(uri)));
  const box = document.getElementById('term');
  term.open(box);

  const refit = () => {
    if (!box.clientWidth || !box.clientHeight) return; // hidden: keep the size it had
    try { fit.fit(); } catch { /* not laid out yet */ }
  };
  term.onResize(({ cols, rows }) => api.resize(cols, rows));
  new ResizeObserver(refit).observe(box);

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || e.altKey) return true;
    const k = e.key.toLowerCase();
    if (k === 'c' && term.hasSelection()) { api.copy(term.getSelection()); term.clearSelection(); return false; }
    if (k === 'v') { e.preventDefault(); api.paste().then((t) => { if (t) term.paste(t); }); return false; }
    return true;
  });
  box.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (term.hasSelection()) { api.copy(term.getSelection()); term.clearSelection(); } else api.paste().then((t) => { if (t) term.paste(t); });
  });

  api.onData((data) => term.write(data));
  term.onData((data) => api.write(data));

  const info = await api.ready();
  if (info && info.backlog) term.write(info.backlog);
  refit();
  api.resize(term.cols, term.rows);
  term.focus();
  window.addEventListener('focus', () => term.focus());
})();
