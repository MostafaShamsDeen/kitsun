// Kitsun's fox: a white kitsune wearing its mask markings (a crescent moon, flames, red around the eyes, cheek stripes),
// outlined in navy. It is the logo mark (the title bar's Home button), the app icon, and Home's mascot: the kitsune sitting
// with one tail per tab (up to nine, as the legend has it). Each tail's tip is its tab's colour and shows how that tab is
// doing: swaying while it runs, wagging while Claude works in it, glowing while it needs you, faded while it is closed.
// Plain SVG built here, so scripts/draw-icon.js can draw the same fox into the app icon.
window.KitsunFox = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const MAX_TAILS = 9;
  const NAVY = '#1f1a5c';
  const RED = '#ff3d5f';
  const SHADE = '#ddd0e2';

  function svg(tag, attrs = {}, children = []) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
    for (const c of children) if (c) n.append(c);
    return n;
  }
  const outline = (w) => ({ stroke: NAVY, 'stroke-width': w, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  const path = (d, attrs) => svg('path', { d, ...attrs });

  // The head on a 64 × 64 grid.
  function head() {
    return svg('g', { class: 'fox-head' }, [
      svg('g', { class: 'fox-ears' }, [
        path('M10.5 28 C 9.5 19 11 10.5 14 5.5 C 15 4 16.8 4 17.8 5 C 21.3 8.2 24.5 12 27 16', { fill: '#fff', ...outline(1.7) }),
        path('M53.5 28 C 54.5 19 53 10.5 50 5.5 C 49 4 47.2 4 46.2 5 C 42.7 8.2 39.5 12 37 16', { fill: '#fff', ...outline(1.7) }),
        path('M13.6 21 C 13.6 15 14.8 11 16.3 8.5 C 18.8 11 21.2 13.8 22.8 16.6 Z', { fill: RED }),
        path('M50.4 21 C 50.4 15 49.2 11 47.7 8.5 C 45.2 11 42.8 13.8 41.2 16.6 Z', { fill: RED }),
      ]),
      path('M32 13 C 44 13 52 20 53.5 30 C 55.2 31 57 32.4 58.8 33.6 C 56.8 34.4 55.4 35 54.2 35.6 C 53.6 44.5 47.5 51 39.5 54.6 L 32 58.6 L 24.5 54.6 C 16.5 51 10.4 44.5 9.8 35.6 C 8.6 35 7.2 34.4 5.2 33.6 C 7 32.4 8.8 31 10.5 30 C 12 20 20 13 32 13 Z', { fill: '#fff', ...outline(1.7) }),
      path('M10.5 36 C 12 45 18 51 25 54.4 L 32 58.4 L 39 54.4 C 46 51 52 45 53.5 36 C 50 44 44 49 32 50 C 20 49 14 44 10.5 36 Z', { fill: SHADE, opacity: '.7' }),
      // The mask: a crescent moon, a flame each side and one between the eyes, red around the eyes, cheek stripes.
      path('M25.6 19.6 A 6.4 6.4 0 0 0 38.4 19.6 A 6.4 3.4 0 0 1 25.6 19.6 Z', { fill: RED }),
      path('M23.8 25.5 C 20.8 23 20.4 19.8 22.4 17.2 C 22 20.2 23.5 22.8 26.2 24.4 Z', { fill: RED }),
      path('M40.2 25.5 C 43.2 23 43.6 19.8 41.6 17.2 C 42 20.2 40.5 22.8 37.8 24.4 Z', { fill: RED }),
      path('M32 26.5 C 33.6 28.4 33.6 30.6 32 32.4 C 30.4 30.6 30.4 28.4 32 26.5 Z', { fill: RED }),
      path('M14.6 30.4 C 18.8 27.6 24.6 28.2 28.2 31.6 C 26.6 35.2 22 36.6 17.8 35 C 16.2 33.8 15.2 32.4 14.6 30.4 Z', { fill: RED }),
      path('M49.4 30.4 C 45.2 27.6 39.4 28.2 35.8 31.6 C 37.4 35.2 42 36.6 46.2 35 C 47.8 33.8 48.8 32.4 49.4 30.4 Z', { fill: RED }),
      svg('g', { class: 'fox-eyes' }, [
        path('M17.4 31.4 C 20.6 29.9 24.2 30.3 26.4 32 C 24.9 34.2 21.6 34.8 19 34 C 18.2 33.4 17.7 32.5 17.4 31.4 Z', { fill: NAVY }),
        path('M46.6 31.4 C 43.4 29.9 39.8 30.3 37.6 32 C 39.1 34.2 42.4 34.8 45 34 C 45.8 33.4 46.3 32.5 46.6 31.4 Z', { fill: NAVY }),
      ]),
      path('M13.4 38.6 Q 16.4 37.4 19.2 39 M 14.6 42 Q 17.4 41 20 42.8 M50.6 38.6 Q 47.6 37.4 44.8 39 M 49.4 42 Q 46.6 41 44 42.8', { fill: 'none', stroke: RED, 'stroke-width': 2, 'stroke-linecap': 'round' }),
      path('M29.5 41 C 31 40 33 40 34.5 41 C 34 42.9 32.9 43.8 32 44 C 31.1 43.8 30 42.9 29.5 41 Z', { fill: NAVY }),
      svg('ellipse', { cx: 31.2, cy: 41.2, rx: 0.9, ry: 0.5, fill: '#fff' }),
      path('M32 44 L 32 45.4 M 27.4 46 C 28.8 47.6 30.8 47.6 32 45.4 C 33.2 47.6 35.2 47.6 36.6 46', { fill: 'none', ...outline(1.4) }),
    ]);
  }

  // The small mark: just the head.
  function mark({ size = 22 } = {}) {
    return svg('svg', { class: 'fox-mark', viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': 'true' }, [head()]);
  }

  // One tail, rising from its root at (0, 0) to a tip curled to the right 132 up: white fur, a lilac shade, the tip in
  // the tab's colour with a zigzag edge, and the navy outline on top. Its box spans x -23..18 (the root sits 56% across).
  const TAIL = 'M0 0 C -11 -14 -23 -40 -23 -70 C -23 -100 -8 -122 10 -132 C 5 -117 13 -101 15 -83 C 18 -50 10 -20 0 0 Z';
  const TIP = 'M-22.6 -80 L -16 -90 L -13 -80 L -7 -93 L -4 -82 L 2 -95 L 5 -85 L 10 -94 L 15.2 -84 C 13 -101 5 -117 10 -132 C -6 -122 -22 -104 -22.6 -80 Z';
  const TAIL_SHADE = 'M0 0 C 10 -20 18 -50 15.2 -84 L 9 -82 C 10 -52 6 -22 0 0 Z';
  // At an angle from straight up, 1.3 times as wide as drawn; the left ones mirrored so every tip curls outwards.
  const tailAt = (x, y, angle) => `translate(${x} ${y}) rotate(${angle.toFixed(1)}) scale(${angle < 0 ? -1.3 : 1.3} 1)`;
  const tailParts = () => [
    path(TAIL, { class: 'fox-tail-fur' }),
    path(TAIL_SHADE, { class: 'fox-tail-shade' }),
    path(TIP, { class: 'fox-tail-tip' }),
    path(TAIL, { class: 'fox-tail-line' }),
  ];

  // The sitting body in the mascot's 240 × 240 frame: chest with a fluffy collar, front legs with swirls, red paws.
  function body() {
    return svg('g', { class: 'fox-body' }, [
      svg('ellipse', { class: 'fox-shadow', cx: 120, cy: 229, rx: 62, ry: 5 }),
      path('M99 156 C 86 168 82 196 87 226 L 153 226 C 158 196 154 168 141 156 Z', { fill: '#fff', ...outline(2.6) }),
      path('M105 190 C 103 205 104 216 106 226 M 135 190 C 137 205 136 216 134 226', { fill: 'none', ...outline(2.4) }),
      path('M104 166 L 110 175 L 114 168 L 120 179 L 126 168 L 130 175 L 136 166', { fill: 'none', stroke: SHADE, 'stroke-width': 2.4, 'stroke-linejoin': 'round' }),
      path('M94 206 C 91 199 98 194 101 199 M 146 206 C 149 199 142 194 139 199', { fill: 'none', stroke: RED, 'stroke-width': 2.6, 'stroke-linecap': 'round' }),
      path('M93 230 C 93 222 100 219 106 220 C 112 221 115 225 115 230 Z', { fill: RED, ...outline(2.4) }),
      path('M125 230 C 125 225 128 221 134 220 C 140 219 147 222 147 230 Z', { fill: RED, ...outline(2.4) }),
    ]);
  }

  // Tail angles fanned behind: wider as there are more.
  function angles(n) {
    if (n <= 0) return [];
    if (n === 1) return [-40];
    const spread = Math.min(150, 80 + (n - 2) * 12);
    return Array.from({ length: n }, (_, i) => -spread / 2 + (i * spread) / (n - 1));
  }

  // The mascot: update(tabs) with [{ id, name, color, mood }], mood one of live | working | needs | starting | stopped |
  // frozen. onPick(id) runs when a tail is clicked.
  function mascot({ onPick = null } = {}) {
    const tails = svg('g', { class: 'fox-tails' });
    const root = svg('svg', { class: 'fox-mascot', viewBox: '0 0 240 240', role: 'img' }, [
      tails,
      body(),
      svg('g', { transform: 'translate(65.6 66.4) scale(1.7)' }, [head()]),
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
      // Outer tails first, so the middle ones lie on top, nearest the body.
      const order = shown.map((t, i) => ({ t, i, angle: a[i] })).sort((x, y) => Math.abs(y.angle) - Math.abs(x.angle));
      tails.replaceChildren(...order.map(({ t, i, angle }) => {
        const label = `${t.name}: ${MOOD_TEXT[t.mood] || t.mood}`;
        const g = svg('g', {
          class: `fox-tail ${t.mood}`, transform: tailAt(120, 176, angle),
          style: `--c:${t.color};--d:${(i * 0.37).toFixed(2)}s`, tabindex: onPick ? '0' : null, role: onPick ? 'button' : null, 'aria-label': label,
        }, [svg('title'), svg('g', { class: 'fox-sway' }, tailParts())]);
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

  // The app icon: the head on a soft lilac rounded tile, which stands out on a dark or a light taskbar alike.
  // scripts/draw-icon.js draws it into build/icon.png.
  function icon() {
    const bg = svg('linearGradient', { id: 'ic-bg', x1: '0', y1: '0', x2: '1', y2: '1' }, [
      svg('stop', { offset: '0', 'stop-color': '#f6ecff' }),
      svg('stop', { offset: '1', 'stop-color': '#dfcbf5' }),
    ]);
    return svg('svg', { xmlns: NS, viewBox: '0 0 256 256', width: 256, height: 256 }, [
      svg('defs', {}, [bg]),
      svg('rect', { x: 8, y: 8, width: 240, height: 240, rx: 56, fill: 'url(#ic-bg)' }),
      svg('g', { transform: 'translate(36 30) scale(2.88)' }, [head()]),
    ]);
  }

  return { mark, mascot, icon, MAX_TAILS };
})();
