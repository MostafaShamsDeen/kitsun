// Kitsun's fox: a white kitsune wearing its mask markings (a crescent moon, flames, red around the eyes, cheek stripes),
// outlined in navy and shaded in lilac, drawn after the flat "cute kitsune" sticker style. It is the logo mark (the title
// bar's Home button), the app icon, and Home's mascot: the kitsune sitting with one red-tipped tail per tab (up to nine,
// as the legend has it). Each tab is a foxfire (kitsunebi) floating by its tail's tip, in the tab's colour: it flickers
// while the tab runs, flares while Claude works in it, blazes while it needs you, and is a faint ember while closed.
// The fox breathes, follows the pointer with its head, twitches its ears, flicks a tail now and then, hops when clicked,
// and sleeps when every tab is closed. Plain SVG built here, so scripts/draw-icon.js can draw the same fox into the icon.
window.KitsunFox = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const MAX_TAILS = 9;
  const NAVY = '#1f1a5c';
  const RED = '#ff3d5f';
  const RED_DEEP = '#d8345a';
  const SHADE = '#ddd0e2';
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let uid = 0;

  function svg(tag, attrs = {}, children = []) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
    for (const c of children) if (c) n.append(c);
    return n;
  }
  const line = (w) => ({ stroke: NAVY, 'stroke-width': w, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  const path = (d, attrs) => svg('path', { d, ...attrs });
  // Mirrors a path drawn on the left half across the head's centre line (x = 50) or the body's (x = 150).
  const mirror = (d, axis) => d.replace(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g, (_, x, y) => `${+(2 * axis - x).toFixed(2)} ${y}`);
  const pair = (d, axis, attrs) => [path(d, attrs), path(mirror(d, axis), attrs)];

  // ---------- the head, on a 100 × 100 grid ----------

  const EAR = 'M14 46 C 11 30 13 14 19 4 C 20.5 1.8 23 1.6 24.6 3.2 C 31 9.6 37 17 41 24 L 30 40 Z';
  const EAR_IN = 'M18.6 36 C 18 24 19.6 14 22.4 8.6 C 27.4 13.6 31.6 19 34.6 24.4 C 28 27 22 31 18.6 36 Z';
  const FLUFF = 'M15 49 L 3.5 50.5 L 10 55 L 1.5 59.5 L 11 61.5 L 5 67 L 16 66 Z';
  const FACE = 'M50 19 C 73 19 89 30 91 48 C 92.4 63 85 76 70 84.5 L 50 93.5 L 30 84.5 C 15 76 7.6 63 9 48 C 11 30 27 19 50 19 Z';
  const FACE_SHADE = 'M9.6 56 C 13 72 26 82 38 87 L 50 92.6 L 62 87 C 74 82 87 72 90.4 56 C 84 74 70 82 50 83 C 30 82 16 74 9.6 56 Z';
  const MOON = 'M41.5 31 A 8.5 8.5 0 0 0 58.5 31 A 7.4 5.6 0 0 1 41.5 31 Z';
  const SWOOSH = 'M36.5 27 C 30 31.5 29.4 41 34.6 47.6 C 37.6 51.2 40.8 52.4 42.6 55.4 C 43.2 50.4 40.6 46.6 38.4 43 C 35.8 38.6 35.4 32.6 36.5 27 Z';
  const DROP = 'M46.4 45 C 44.6 48 45.2 51 47.4 53.2 C 47.9 50.6 47.6 47.8 46.4 45 Z';
  const PATCH = 'M19.6 52.4 C 26 48.2 35.6 48.8 41.2 54.6 C 38.6 60.8 31 62.8 25 60.6 C 22.4 58.8 20.8 56.2 19.6 52.4 Z';
  const EYE = 'M23.2 53.8 C 28 51.4 34.6 51.8 38.2 55 C 36 58.6 31 59.8 27 58.6 C 25.4 57.6 24 56 23.2 53.8 Z';
  const EYE_HAPPY = 'M24 57.4 Q 31 51.4 38 57.4';
  const EYE_SLEEP = 'M24 55 Q 31 59.8 38 55';
  const CHEEK = 'M16.6 63.4 Q 21.6 61.2 26.4 63.6 M 18.4 68.4 Q 23.4 66.8 27.6 69.2';

  function head() {
    return svg('g', { class: 'fox-head' }, [
      svg('g', { class: 'fox-ear fox-ear-l' }, [path(EAR, { fill: '#fff', ...line(2) }), path(EAR_IN, { fill: RED })]),
      svg('g', { class: 'fox-ear fox-ear-r' }, [path(mirror(EAR, 50), { fill: '#fff', ...line(2) }), path(mirror(EAR_IN, 50), { fill: RED })]),
      // The mask's strap, peeking out between the ears.
      path('M27 23.6 C 39 16.4 61 16.4 73 23.6', { fill: 'none', stroke: NAVY, 'stroke-width': 5.2, 'stroke-linecap': 'round' }),
      path('M27 23.6 C 39 16.4 61 16.4 73 23.6', { fill: 'none', stroke: '#fff', 'stroke-width': 2.2, 'stroke-linecap': 'round' }),
      ...pair(FLUFF, 50, { fill: '#fff', ...line(2) }),
      path(FACE, { fill: '#fff', ...line(2.2) }),
      path(FACE_SHADE, { fill: SHADE, opacity: '.75' }),
      // The mask: a crescent moon framed by two flames, two drops between the eyes, red around the eyes, cheek stripes.
      path(MOON, { fill: RED }),
      ...pair(SWOOSH, 50, { fill: RED }),
      ...pair(DROP, 50, { fill: RED }),
      ...pair(PATCH, 50, { fill: RED }),
      svg('g', { class: 'fox-eyes' }, pair(EYE, 50, { fill: NAVY })),
      // Hidden by attribute, so the icon (drawn without the stylesheet) and the mark never show them; the mascot's CSS
      // swaps them in for a happy squint or sleep.
      svg('g', { class: 'fox-eyes-happy', display: 'none' }, pair(EYE_HAPPY, 50, { fill: 'none', ...line(2.6) })),
      svg('g', { class: 'fox-eyes-sleep', display: 'none' }, pair(EYE_SLEEP, 50, { fill: 'none', ...line(2.6) })),
      ...pair(CHEEK, 50, { fill: 'none', stroke: RED, 'stroke-width': 2.6, 'stroke-linecap': 'round' }),
      path('M45.4 64.6 C 48.4 63 51.6 63 54.6 64.6 C 53.8 67.6 51.8 69.4 50 69.8 C 48.2 69.4 46.2 67.6 45.4 64.6 Z', { fill: NAVY }),
      svg('ellipse', { cx: 48.4, cy: 65.2, rx: 1.4, ry: 0.7, fill: '#fff' }),
      path('M50 69.8 L 50 71.6 M 41.5 72.4 C 43.6 75.2 47.6 75.4 50 71.6 C 52.4 75.4 56.4 75.2 58.5 72.4', { fill: 'none', ...line(1.8) }),
    ]);
  }

  // The small mark: just the head.
  function mark({ size = 22 } = {}) {
    return svg('svg', { class: 'fox-mark', viewBox: '0 0 100 100', width: size, height: size, 'aria-hidden': 'true' }, [head()]);
  }

  // ---------- the body, in a 300 × 300 frame (the mascot shifts it to the middle of its wider frame) ----------

  const HAUNCH = 'M121 204 C 100 208 89 232 91 260 C 92 273 101 280 113 280 L 124 280 Z';
  const HAUNCH_SHADE = 'M91.4 254 C 93 270 101 279 113 279 L 121 279 L 119 263 C 108 267 98 263 91.4 254 Z';
  const HAUNCH_SWIRL = 'M106 246 C 100 246 97.6 240 101.6 236.8 C 105.6 233.6 111 237.6 109 241.8 M 113 224 C 106.6 225 104.6 219 108.6 216';
  const BACK_PAW = 'M92 280 C 92 271 99 267 106 268 C 112 269 115 274 115 280 Z';
  const LEG_SWIRL = 'M122 238 C 126 234 131.4 236 130.4 241 C 129.4 245.4 124 245.4 124 241 M 126.4 253 C 122.4 257 124 263 129.4 263';
  const PAW = 'M117 280 C 117 271 123 267 128 267 C 133 267 138 270 138 280 Z';

  function body() {
    return svg('g', { class: 'fox-body' }, [
      ...pair(HAUNCH, 150, { fill: '#fff', ...line(2.6) }),
      ...pair(HAUNCH_SHADE, 150, { fill: SHADE }),
      ...pair(HAUNCH_SWIRL, 150, { fill: 'none', stroke: RED, 'stroke-width': 3, 'stroke-linecap': 'round' }),
      ...pair(BACK_PAW, 150, { fill: RED, ...line(2.4) }),
      path('M118 166 C 111 192 112 236 116 280 L 184 280 C 188 236 189 192 182 166 Z', { fill: '#fff', ...line(2.6) }),
      path('M137 228 L 163 228 L 163 280 L 137 280 Z', { fill: SHADE, opacity: '.8' }),
      path('M136 214 C 135 240 135 262 136 280 M 164 214 C 165 240 165 262 164 280', { fill: 'none', ...line(2.4) }),
      ...pair(LEG_SWIRL, 150, { fill: 'none', stroke: RED, 'stroke-width': 2.8, 'stroke-linecap': 'round' }),
      // The fluffy bib under the chin.
      path('M113 172 C 120 159 180 159 187 172 L 182 183 L 176 177 L 172 193 L 164 185 L 158 203 L 150 191 L 142 203 L 136 185 L 128 193 L 124 177 L 118 183 Z', { fill: '#fff', ...line(2.4) }),
      path('M128 193 L 136 185 L 142 203 L 150 191 L 158 203 L 164 185 L 172 193 L 170 199 L 164 193 L 158 209 L 150 199 L 142 209 L 136 193 L 130 199 Z', { fill: SHADE }),
      svg('g', { class: 'fox-paws' }, [
        ...pair(PAW, 150, { fill: RED, ...line(2.4) }),
        path('M124 274.5 L 124 280 M 131 274.5 L 131 280 M 169 274.5 L 169 280 M 176 274.5 L 176 280', { fill: 'none', ...line(1.8) }),
      ]),
    ]);
  }

  // ---------- the tails ----------

  // One tail, rising from its root at (0, 0) to a tip curled to the right 162 up: plump white fur with a lilac shade on
  // its inner edge, a red flame tip (a zigzag edge, deeper red inside the curl), and the navy outline on top. The fill
  // shapes overshoot and are clipped to the tail, so they never poke past the outline.
  const TAIL = 'M0 0 C -24 -18 -40 -56 -38 -96 C -36 -130 -16 -152 10 -162 C 3 -146 12 -130 16 -112 C 22 -76 20 -34 0 0 Z';
  const TAIL_SHADE = 'M40 -104 L 12 -104 C 15 -66 9 -28 -6 0 L 40 0 Z';
  const TAIL_TIP = 'M-60 -94 L -30 -106 L -26 -94 L -18 -112 L -12 -98 L -4 -116 L 2 -100 L 9 -114 L 40 -102 L 40 -200 L -60 -200 Z';
  const TAIL_TIP_DEEP = 'M40 -200 L 6 -158 C -1 -140 6 -122 11 -106 L 40 -106 Z';
  const ROOT = { x: 190, y: 236 };
  const TIP_AT = { x: 4, y: -180 }; // where its foxfire floats, just past the tip

  // Fanned behind the fox, wider as there are more: a single tail curls off to one side; nine reach from flat on the
  // left round to flat on the right.
  function angles(n) {
    if (n <= 0) return [];
    if (n === 1) return [-34];
    const spread = Math.min(170, 56 + (n - 2) * 17);
    return Array.from({ length: n }, (_, i) => -spread / 2 + (i * spread) / (n - 1));
  }

  // A foxfire: a small flame in the tab's colour with a pale core.
  const WISP = 'M0 -15 C 5 -9 9.5 -3 9.5 3 C 9.5 9.5 5 13.5 0 13.5 C -5 13.5 -9.5 9.5 -9.5 3 C -9.5 -1 -7 -4.5 -4.5 -7 C -4 -3.5 -2 -2 -0.5 -1.5 C -2.5 -6 -1.5 -10.5 0 -15 Z';
  const WISP_CORE = 'M0 -1 C 3 2 4.4 4.6 4.4 7 C 4.4 9.8 2.4 11.2 0 11.2 C -2.4 11.2 -4.4 9.8 -4.4 7 C -4.4 4.6 -2.6 2.4 0 -1 Z';

  function tail(t, i, angle, clipId, onPick) {
    const k = 1.42 - 0.3 * (Math.abs(angle) / 90); // the middle ones rise high above the head; the flat outer ones are shorter
    const m = angle < 0 ? -1 : 1; // the left ones are mirrored, so every tip curls outwards
    const label = `${t.name}: ${MOOD_TEXT[t.mood] || t.mood}`;
    const clip = `url(#${clipId})`;
    // Undo the tail's turn and stretch, so the flame stands upright at its normal size.
    const wispAt = `translate(${TIP_AT.x} ${TIP_AT.y}) scale(${(1 / (m * k)).toFixed(3)} ${(1 / k).toFixed(3)}) rotate(${(-angle).toFixed(1)})`;
    const g = svg('g', {
      class: `fox-tail ${t.mood}`,
      transform: `translate(${ROOT.x} ${ROOT.y}) rotate(${angle.toFixed(1)}) scale(${m * k} ${k})`,
      style: `--c:${t.color};--d:${(i * 0.37).toFixed(2)}s`,
      tabindex: onPick ? '0' : null, role: onPick ? 'button' : null, 'aria-label': label,
    }, [svg('title'), svg('g', { class: 'fox-sway' }, [
      path(TAIL, { fill: '#fff' }),
      path(TAIL_SHADE, { fill: SHADE, 'clip-path': clip }),
      svg('g', { class: 'fox-tail-tip' }, [
        path(TAIL_TIP, { fill: RED, 'clip-path': clip }),
        path(TAIL_TIP_DEEP, { fill: RED_DEEP, 'clip-path': clip }),
      ]),
      path(TAIL, { class: 'fox-tail-line', fill: 'none', ...line(2.6) }),
      svg('g', { transform: wispAt }, [svg('g', { class: 'fox-wisp' }, [
        path(WISP, { class: 'fox-wisp-flame', fill: t.color, ...line(1.4) }),
        path(WISP_CORE, { fill: '#fff', opacity: '.78' }),
      ])]),
    ])]);
    g.firstChild.textContent = label;
    if (onPick) {
      g.addEventListener('click', (e) => { e.stopPropagation(); onPick(t.id); });
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(t.id); } });
    }
    return g;
  }

  // ---------- the mascot ----------

  // update(tabs) with [{ id, name, color, mood }], mood one of live | working | needs | starting | stopped | frozen.
  // onPick(id) runs when a tail is clicked.
  function mascot({ onPick = null } = {}) {
    const clipId = `fox-tail-clip-${++uid}`;
    const tails = svg('g', { class: 'fox-tails' });
    const zzz = svg('g', { class: 'fox-zzz', 'aria-hidden': 'true' }, [0, 1, 2].map((n) =>
      svg('text', { x: 236 + n * 9, y: 92 - n * 10, style: `--z:${n}`, 'font-size': 14 + n * 4 }, [document.createTextNode('z')])));
    // Taller than the body's frame: the middle tails and their foxfire rise up to 34 above it.
    const root = svg('svg', { class: 'fox-mascot', viewBox: '0 -34 380 334', role: 'img' }, [
      svg('defs', {}, [svg('clipPath', { id: clipId }, [path(TAIL)])]),
      svg('ellipse', { class: 'fox-shadow', cx: 190, cy: 284, rx: 150, ry: 8 }),
      svg('g', { class: 'fox-breath' }, [
        tails,
        svg('g', { transform: 'translate(40 0)' }, [body()]),
        // Two wrappers: the outer places the head, the inner moves it (follows the pointer, tilts, perks up).
        svg('g', { transform: 'translate(127.5 59) scale(1.25)' }, [svg('g', { class: 'fox-look' }, [svg('g', { class: 'fox-idle' }, [head()])])]),
      ]),
      zzz,
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
      tails.replaceChildren(...order.map(({ t, i, angle }) => tail(t, i, angle, clipId, onPick)));
      const needs = shown.filter((t) => t.mood === 'needs').length;
      const working = shown.filter((t) => t.mood === 'working').length;
      root.classList.toggle('fox-alert', needs > 0);
      root.classList.toggle('fox-busy', working > 0);
      root.classList.toggle('fox-asleep', shown.length > 0 && shown.every((t) => t.mood === 'stopped'));
      const more = tabs.length > MAX_TAILS ? ` and ${tabs.length - MAX_TAILS} more` : '';
      root.setAttribute('aria-label', !tabs.length ? 'Kitsun the fox, no tabs yet'
        : `Kitsun the fox with ${shown.length} tail${shown.length === 1 ? '' : 's'}, one per tab${more}${needs ? `; ${needs} need${needs === 1 ? 's' : ''} you` : ''}`);
    }

    // A short one-off move: the class is set, its CSS animation plays, and it is taken off again.
    function act(name, ms, target = root) {
      target.classList.remove(name);
      void target.getBoundingClientRect(); // restart the animation if it is already playing
      target.classList.add(name);
      setTimeout(() => target.classList.remove(name), ms);
    }

    // Now and then, while it is on screen and awake: a head tilt, an ear twitch, a tail flick or a double blink.
    const IDLE = [
      () => act('fox-tilt', 1600),
      () => act(Math.random() < 0.5 ? 'fox-twitch-l' : 'fox-twitch-r', 700),
      () => {
        const list = tails.querySelectorAll('.fox-tail:not(.stopped)');
        if (list.length) act('flick', 900, list[Math.floor(Math.random() * list.length)]);
      },
      () => act('fox-blink2', 900),
    ];
    let lastIdle = -1;
    (function idle() {
      setTimeout(() => {
        if (root.isConnected && !document.hidden && !motion.matches && !root.classList.contains('fox-asleep')) {
          let n = Math.floor(Math.random() * IDLE.length);
          if (n === lastIdle) n = (n + 1) % IDLE.length;
          lastIdle = n;
          IDLE[n]();
        }
        idle();
      }, 3500 + Math.random() * 4500);
    })();

    // The head follows the pointer a little, wherever it is in the window.
    let frame = 0;
    window.addEventListener('pointermove', (e) => {
      if (frame || motion.matches || !root.isConnected) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const r = root.getBoundingClientRect();
        if (!r.width) return;
        const lx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width * 1.6)));
        const ly = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height * 0.35)) / (r.height * 1.6)));
        root.style.setProperty('--lx', lx.toFixed(3));
        root.style.setProperty('--ly', ly.toFixed(3));
      });
    }, { passive: true });

    // Clicking the fox itself (not a tail) makes it hop for joy.
    root.addEventListener('click', () => { if (!motion.matches) act('fox-hop', 900); });

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
      svg('g', { transform: 'translate(18 22) scale(2.2)' }, [head()]),
    ]);
  }

  return { mark, mascot, icon, MAX_TAILS };
})();
