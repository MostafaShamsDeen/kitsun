// Kitsun's fox: the logo mark (the title bar's Home button, the app icon) and Home's mascot, a kitsune that has one
// tail per tab (up to nine, as the legend has it). Each tail is its tab's colour and shows how that tab is doing:
// swaying while it runs, wagging while Claude works in it, glowing while it needs you, faded while it is closed.
// Plain SVG built here, so scripts/draw-icon.js can draw the same fox into the app icon.
window.KitsunFox = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const MAX_TAILS = 9;

  function svg(tag, attrs = {}, children = []) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
    for (const c of children) if (c) n.append(c);
    return n;
  }

  const INK = '#1d0d06';
  // The head on a 64 × 64 grid: tall rounded ears with dark insides, a round head with cheek tufts in a warm fur gradient,
  // a cream mask rising into a point between the eyes, and a small nose. Two pairs of eyes: happy closed arcs (the
  // usual face, and the logo's), and open almond eyes with a glint, which the mascot shows when a tab needs you.
  // both: draw both pairs, for the mascot (styles.css shows one); otherwise just the happy pair.
  function head({ id = 'fx', both = false } = {}) {
    const fur = svg('linearGradient', { id: `${id}-fur`, x1: '0', y1: '0', x2: '0', y2: '1' }, [
      svg('stop', { offset: '0', 'stop-color': '#ffb06a' }),
      svg('stop', { offset: '.55', 'stop-color': '#ff7b3a' }),
      svg('stop', { offset: '1', 'stop-color': '#e2531c' }),
    ]);
    const cream = svg('linearGradient', { id: `${id}-cream`, x1: '0', y1: '0', x2: '0', y2: '1' }, [
      svg('stop', { offset: '0', 'stop-color': '#ffffff' }),
      svg('stop', { offset: '1', 'stop-color': '#f6e6d8' }),
    ]);
    const furFill = `url(#${id}-fur)`;
    const arc = (d) => svg('path', { d, fill: 'none', stroke: INK, 'stroke-width': '2.3', 'stroke-linecap': 'round' });
    return svg('g', { class: 'fox-head' }, [
      svg('defs', {}, [fur, cream]),
      svg('g', { class: 'fox-ears' }, [
        svg('path', { d: 'M9 31 C 8 21 9 11 14 4.5 C 15.5 3 17 3.4 18 4.6 C 22 9.5 26 15 28.5 21 Z', fill: furFill }),
        svg('path', { d: 'M55 31 C 56 21 55 11 50 4.5 C 48.5 3 47 3.4 46 4.6 C 42 9.5 38 15 35.5 21 Z', fill: furFill }),
        svg('path', { d: 'M13.5 25 C 13 18 14 12 16.2 8.4 C 19 12 21.8 16.5 23.6 20.5 Z', fill: '#3b160a' }),
        svg('path', { d: 'M50.5 25 C 51 18 50 12 47.8 8.4 C 45 12 42.2 16.5 40.4 20.5 Z', fill: '#3b160a' }),
      ]),
      svg('path', { d: 'M32 15 C 41.5 15 49.5 20.5 52.5 29 C 55.5 31.5 58.5 34.5 61 38.5 C 56 39.5 51.5 40.5 47.5 42.5 C 43.5 49 38 54.5 32 59 C 26 54.5 20.5 49 16.5 42.5 C 12.5 40.5 8 39.5 3 38.5 C 5.5 34.5 8.5 31.5 11.5 29 C 14.5 20.5 22.5 15 32 15 Z', fill: furFill }),
      svg('path', { d: 'M3 38.5 C 8 39.5 12.5 40.5 16.5 42.5 C 20.5 49 26 54.5 32 59 C 38 54.5 43.5 49 47.5 42.5 C 51.5 40.5 56 39.5 61 38.5 C 56.5 36 51 35.2 45.5 36.6 C 40.5 38 36 41.5 32 46.5 C 28 41.5 23.5 38 18.5 36.6 C 13 35.2 7.5 36 3 38.5 Z', fill: `url(#${id}-cream)` }),
      svg('g', { class: 'fox-eyes-happy' }, [arc('M20.5 32.5 Q 24 29 27.5 32.5'), arc('M43.5 32.5 Q 40 29 36.5 32.5')]),
      both && svg('g', { class: 'fox-eyes' }, [
        svg('path', { d: 'M20 32.5 C 21.5 30 25 29.4 27.5 31.6 C 25.6 34 22 34.2 20 32.5 Z', fill: INK }),
        svg('path', { d: 'M44 32.5 C 42.5 30 39 29.4 36.5 31.6 C 38.4 34 42 34.2 44 32.5 Z', fill: INK }),
        svg('circle', { cx: '24.4', cy: '31.3', r: '.9', fill: '#fff' }),
        svg('circle', { cx: '39.6', cy: '31.3', r: '.9', fill: '#fff' }),
      ]),
      svg('path', { d: 'M28.8 55.2 C 30.8 53.8 33.2 53.8 35.2 55.2 C 34.6 57.4 33.4 58.6 32 59 C 30.6 58.6 29.4 57.4 28.8 55.2 Z', fill: INK }),
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
    const face = svg('g', { transform: 'translate(67 68) scale(1.65)' }, [head({ id: 'fxh', both: true })]);
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

  // The app icon: the head alone on a night-ink rounded tile, with a soft fox-orange glow behind it (tails were too busy
  // at taskbar sizes). scripts/draw-icon.js draws it into build/icon.png.
  function icon() {
    const bg = svg('linearGradient', { id: 'ic-bg', x1: '0', y1: '0', x2: '1', y2: '1' }, [
      svg('stop', { offset: '0', 'stop-color': '#1f1c38' }),
      svg('stop', { offset: '1', 'stop-color': '#0c0e14' }),
    ]);
    const glow = svg('radialGradient', { id: 'ic-glow', cx: '.5', cy: '.55', r: '.5' }, [
      svg('stop', { offset: '0', 'stop-color': '#ff7b3a', 'stop-opacity': '.35' }),
      svg('stop', { offset: '1', 'stop-color': '#ff7b3a', 'stop-opacity': '0' }),
    ]);
    return svg('svg', { xmlns: NS, viewBox: '0 0 256 256', width: 256, height: 256 }, [
      svg('defs', {}, [bg, glow]),
      svg('rect', { x: 8, y: 8, width: 240, height: 240, rx: 56, fill: 'url(#ic-bg)' }),
      svg('circle', { cx: 128, cy: 140, r: 110, fill: 'url(#ic-glow)' }),
      svg('g', { transform: 'translate(36 34) scale(2.88)' }, [head({ id: 'ic' })]),
    ]);
  }

  return { mark, mascot, icon, MAX_TAILS };
})();
