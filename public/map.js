// Map: an original two-site desert map ("Sandline"). Spots + corridors between them.
// Coordinates are on a 1000 x 1000 board (top = CT side, bottom = T side).

export const MAP_NAME = 'Sandline';

export const NODES = {
  T_spawn:         { x: 500, y: 920, label: 'T Spawn' },
  long_doors:      { x: 790, y: 760, label: 'Long Doors' },
  A_long:          { x: 850, y: 500, label: 'A Long' },
  A_site:          { x: 790, y: 190, label: 'A Site', site: 'A' },
  A_short:         { x: 640, y: 370, label: 'A Short' },
  mid:             { x: 500, y: 560, label: 'Mid' },
  mid_doors:       { x: 500, y: 340, label: 'Mid Doors' },
  CT_spawn:        { x: 560, y: 150, label: 'CT Spawn' },
  B_window:        { x: 350, y: 250, label: 'B Window' },
  B_site:          { x: 190, y: 200, label: 'B Site', site: 'B' },
  B_tunnels_upper: { x: 170, y: 500, label: 'Upper Tunnels' },
  B_tunnels_lower: { x: 230, y: 760, label: 'Lower Tunnels' },
};

export const EDGES = [
  ['T_spawn', 'long_doors'], ['long_doors', 'A_long'], ['A_long', 'A_site'],
  ['T_spawn', 'mid'], ['mid', 'A_short'], ['A_short', 'A_site'],
  ['mid', 'mid_doors'], ['mid_doors', 'CT_spawn'], ['mid_doors', 'B_window'],
  ['T_spawn', 'B_tunnels_lower'], ['B_tunnels_lower', 'B_tunnels_upper'], ['B_tunnels_upper', 'B_site'],
  ['B_tunnels_lower', 'mid'],
  ['CT_spawn', 'A_site'], ['CT_spawn', 'B_window'], ['B_window', 'B_site'],
];

// Spots CTs may be ordered to (everything except the T spawn).
export const SPOTS = Object.keys(NODES).filter((n) => n !== 'T_spawn');

const AREA = {
  A_site: 'A', A_long: 'A', A_short: 'A', long_doors: 'A',
  B_site: 'B', B_window: 'B', B_tunnels_upper: 'B', B_tunnels_lower: 'B',
  mid: 'mid', mid_doors: 'mid', CT_spawn: 'spawn', T_spawn: 'spawn',
};
export const areaOf = (node) => AREA[node] || 'spawn';

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const label = (node) => NODES[node]?.label || node;

const ADJ = {};
for (const n of Object.keys(NODES)) ADJ[n] = [];
for (const [a, b] of EDGES) {
  const d = dist(NODES[a], NODES[b]);
  ADJ[a].push([b, d]);
  ADJ[b].push([a, d]);
}
export const neighbors = (n) => ADJ[n].map(([m, d]) => ({ node: m, d }));

// Dijkstra. Returns [from, ..., to].
export function shortestPath(from, to) {
  if (from === to) return [from];
  const D = {}, prev = {}, todo = new Set(Object.keys(NODES));
  for (const n of todo) D[n] = Infinity;
  D[from] = 0;
  while (todo.size) {
    let u = null;
    for (const n of todo) if (u === null || D[n] < D[u]) u = n;
    todo.delete(u);
    if (u === to) break;
    for (const [v, w] of ADJ[u]) if (D[u] + w < D[v]) { D[v] = D[u] + w; prev[v] = u; }
  }
  const path = [to];
  while (path[0] !== from) path.unshift(prev[path[0]]);
  return path;
}

export function pathLength(path) {
  let s = 0;
  for (let i = 1; i < path.length; i++) s += dist(NODES[path[i - 1]], NODES[path[i]]);
  return s;
}

export function nearestNode(x, y) {
  let best = null, bd = Infinity;
  for (const [n, p] of Object.entries(NODES)) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}
