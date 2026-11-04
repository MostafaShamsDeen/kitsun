// Fills the fox preview: the same mascot on the reference's lilac and on Home's dark background.
const q = new URLSearchParams(location.search);
const n = Math.max(0, Math.min(9, Number(q.get('n') ?? 9)));
const colors = ['#5b8def', '#d97757', '#3fb68b', '#c678dd', '#e5b84f', '#e06c9f', '#4fb8c9', '#ff3d5f', '#9b968c'];
const moods = ['live', 'working', 'needs', 'live', 'starting', 'live', 'stopped', 'working', 'live'];
const tabs = Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: `Tab ${i + 1}`, color: colors[i], mood: q.get('mood') || moods[i] }));
if (q.get('still')) document.documentElement.classList.add('fox-still');
for (const id of ['a', 'b']) {
  const m = KitsunFox.mascot({ onPick: (t) => console.log('picked', t) });
  m.update(tabs);
  document.getElementById(id).append(m.node);
  // ?lx=&ly= points the head as the pointer would (-1..1); ?pose=<class> holds a pose (fox-hop, fox-tilt, fox-alert...).
  const svgRoot = m.node.querySelector('svg');
  if (q.has('lx')) svgRoot.style.setProperty('--lx', q.get('lx'));
  if (q.has('ly')) svgRoot.style.setProperty('--ly', q.get('ly'));
  if (q.get('pose')) svgRoot.classList.add(q.get('pose'));
}
// ?at=<ms> stops every animation at that moment, so a screenshot shows it mid-move (headless capture shows frame 0).
if (q.has('at')) setTimeout(() => document.getAnimations().forEach((a) => { a.pause(); a.currentTime = Number(q.get('at')); }), 200);
