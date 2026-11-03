// Kitsun's fox: the logo mark (the title bar's Home button, the app icon) and Home's mascot, a kitsune that has one
// tail per tab (up to nine, as the legend has it). Each tail is its tab's colour and shows how that tab is doing:
// swaying while it runs, wagging while Claude works in it, glowing while it needs you, faded while it is closed.
// Plain SVG built here, so scripts/make-icon.js can draw the same mark into the app icon.
window.KitsunFox = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const MAX_TAILS = 9;

  function svg(tag, attrs = {}, children = []) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
    for (const c of children) if (c) n.append(c);
    return n;
  }

  // The head on a 64 × 64 grid: two-tone faceted fur, dark inner ears, a cream mask, almond eyes and a nose.
  function head({ id = 'fx' } = {}) {
    const grad = svg('linearGradient', { id: `${id}-fur`, x1: '0', y1: '0', x2: '0', y2: '1' }, [
      svg('stop', { offset: '0', 'stop-color': '#ff9a4d' }),
      svg('stop', { offset: '1', 'stop-color': '#f2622b' }),
    ]);
    return svg('g', { class: 'fox-head' }, [
      svg('defs', {}, [grad, SHEEN('ic-sheen')]),
      svg('g', { class: 'fox-ears' }, [
        svg('path', { d: 'M8 5 L28 21 L13 31 Z', fill: `url(#${id}-fur)` }),
        svg('path', { d: 'M56 5 L36 21 L51 31 Z', fill: `url(#${id}-fur)` }),
        svg('path', { d: 'M12.5 12 L23.5 21 L15.5 27 Z', fill: '#3b1a0d' }),
        svg('path', { d: 'M51.5 12 L40.5 21 L48.5 27 Z', fill: '#3b1a0d' }),
      ]),
      svg('path', { d: 'M13 19 L32 23 L51 19 L56 34 L32 59 L8 34 Z', fill: `url(#${id}-fur)` }),
      svg('path', { d: 'M32 23 L51 19 L56 34 L32 59 Z', fill: '#c94a1c', opacity: '.28' }),
      svg('path', { d: 'M8 34 L21 35.5 L32 47 L43 35.5 L56 34 L32 59 Z', fill: '#fff3e6' }),
      svg('g', { class: 'fox-eyes' }, [
        svg('path', { d: 'M19.5 30.5 Q24 26.5 28.5 31 Q24 33.5 19.5 30.5 Z', fill: '#1b0e08' }),
        svg('path', { d: 'M44.5 30.5 Q40 26.5 35.5 31 Q40 33.5 44.5 30.5 Z', fill: '#1b0e08' }),
      ]),
      svg('path', { d: 'M28.6 52.2 Q32 50.6 35.4 52.2 L32 56.4 Z', fill: '#1b0e08' }),
    ]);
  }

  // The small mark: just the head.
  function mark({ size = 22, id = 'fxm' } = {}) {
    return svg('svg', { class: 'fox-mark', viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': 'true' }, [head({ id })]);
  }

  // One tail, rising from its root at (0, 0) to a tip curled to the right 132 up, narrow at the root and full in the
  // middle like a plume, with the white tip of a kitsune's tail. Its box spans x -23..18 (the root sits 56% across).
  const TAIL = 'M0 0 C -11 -14 -23 -40 -23 -70 C -23 -100 -8 -122 10 -132 C 5 -117 13 -101 15 -83 C 18 -50 10 -20 0 0 Z';
  const TIP = 'M-17 -105 C -13 -118 -3 -127 10 -132 C 6 -120 9 -111 11 -104 C 3 -109 -8 -109 -17 -105 Z';
  // A soft light-to-shadow sheen laid over each tail's colour, so the fan has some depth.
  const SHEEN = (id) => svg('linearGradient', { id, x1: '0', y1: '0', x2: '1', y2: '0' }, [
    svg('stop', { offset: '0', 'stop-color': '#fff', 'stop-opacity': '.22' }),
    svg('stop', { offset: '.55', 'stop-color': '#fff', 'stop-opacity': '0' }),
    svg('stop', { offset: '1', 'stop-color': '#000', 'stop-opacity': '.22' }),
  ]);
  // A tail at an angle from straight up; the left ones are mirrored so every tip curls outwards.
  const tailAt = (x, y, angle, scale = 1) => `translate(${x} ${y}) rotate(${angle.toFixed(1)}) scale(${angle < 0 ? -scale : scale} ${scale})`;

  // Tail angles fanned behind the head: wider as there are more, and never straight up (the head would hide it).
  function angles(n) {
    if (n <= 0) return [];
    if (n === 1) return [-38];
    const spread = Math.min(140, 70 + (n - 2) * 12);
    return Array.from({ length: n }, (_, i) => -spread / 2 + (i * spread) / (n - 1));
  }

  // The mascot: update(tabs) with [{ id, name, color, mood }], mood one of live | working | needs | starting | stopped |
  // frozen. onPick(id) runs when a tail is clicked.
  function mascot({ onPick = null } = {}) {
    const tails = svg('g', { class: 'fox-tails' });
    const face = svg('g', { transform: 'translate(72 76) scale(1.5)' }, [head({ id: 'fxh' })]);
    const root = svg('svg', { class: 'fox-mascot', viewBox: '0 0 240 180', role: 'img' }, [
      svg('defs', {}, [SHEEN('fx-sheen')]),
      svg('ellipse', { class: 'fox-shadow', cx: 120, cy: 172, rx: 50, ry: 5 }),
      tails,
      face,
    ]);
    const box = document.createElement('div');
    box.className = 'fox-box';
    box.append(root);
    let sig = '';

    function update(tabs) {
      const shown = tabs.slice(0, MAX_TAILS);
      const next = shown.map((t) => `${t.id}:${t.color}:${t.mood}:${t.name}`).join('|');
      if (next === sig) return;
      sig = next;
      const a = angles(shown.length);
      // Outer tails first, so the middle ones lie on top, nearest the head.
      const order = shown.map((t, i) => ({ t, i, angle: a[i] })).sort((x, y) => Math.abs(y.angle) - Math.abs(x.angle));
      tails.replaceChildren(...order.map(({ t, i, angle }) => {
        const label = `${t.name}: ${MOOD_TEXT[t.mood] || t.mood}`;
        const g = svg('g', {
          class: `fox-tail ${t.mood}`, transform: tailAt(120, 146, angle),
          style: `--c:${t.color};--d:${(i * 0.37).toFixed(2)}s`, tabindex: onPick ? '0' : null, role: onPick ? 'button' : null, 'aria-label': label,
        }, [
          svg('title', {}, []),
          svg('g', { class: 'fox-sway' }, [
            svg('path', { class: 'fox-tail-fur', d: TAIL }),
            svg('path', { class: 'fox-tail-sheen', d: TAIL, fill: 'url(#fx-sheen)' }),
            svg('path', { class: 'fox-tail-tip', d: TIP }),
          ]),
        ]);
        g.firstChild.textContent = label;
        if (onPick) {
          g.addEventListener('click', () => onPick(t.id));
          g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(t.id); } });
        }
        return g;
      }));
      const needs = shown.filter((t) => t.mood === 'needs').length;
      const working = shown.filter((t) => t.mood === 'working').length;
      root.classList.toggle('fox-alert', needs > 0);
      root.classList.toggle('fox-busy', working > 0);
      root.classList.toggle('fox-asleep', shown.length > 0 && shown.every((t) => t.mood === 'stopped'));
      const more = tabs.length > MAX_TAILS ? ` and ${tabs.length - MAX_TAILS} more` : '';
      root.setAttribute('aria-label', !tabs.length ? 'Kitsun the fox, no tabs yet'
        : `Kitsun the fox with ${shown.length} tail${shown.length === 1 ? '' : 's'}, one per tab${more}${needs ? `; ${needs} need${needs === 1 ? 's' : ''} you` : ''}`);
    }

    return { node: box, update };
  }

  const MOOD_TEXT = { live: 'open', working: 'working', needs: 'needs you', starting: 'starting', stopped: 'closed', frozen: 'not responding' };

  // The app icon: the head over three fanned tails on a night-ink rounded square (scripts/make-icon.js draws it).
  function icon() {
    const grad = svg('linearGradient', { id: 'ic-bg', x1: '0', y1: '0', x2: '1', y2: '1' }, [
      svg('stop', { offset: '0', 'stop-color': '#1d1b33' }),
      svg('stop', { offset: '1', 'stop-color': '#0c0e14' }),
    ]);
    const tail = (angle, color) => svg('g', { transform: tailAt(128, 170, angle, 1) }, [
      svg('path', { d: TAIL, fill: color }),
      svg('path', { d: TAIL, fill: 'url(#ic-sheen)' }),
      svg('path', { d: TIP, fill: '#fff3e6' }),
    ]);
    return svg('svg', { xmlns: NS, viewBox: '0 0 256 256', width: 256, height: 256 }, [
      svg('defs', {}, [grad]),
      svg('rect', { x: 8, y: 8, width: 240, height: 240, rx: 56, fill: 'url(#ic-bg)' }),
      tail(-46, '#8b7bff'), tail(46, '#ffb547'), tail(-14, '#ff7b3a'), tail(14, '#ff9a4d'),
      svg('g', { transform: 'translate(64 92) scale(2)' }, [head({ id: 'ic' })]),
    ]);
  }

  return { mark, mascot, icon, MAX_TAILS };
})();
