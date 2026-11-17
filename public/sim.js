// Simulator: plain code, no AI. Movement, T playbook, duels, bomb, win conditions.
import { NODES, shortestPath, pathLength, dist, nearestNode } from './map.js';

export const RUN = 80, WALK = 45;          // map units per second
export const VISION = 180, HEAR = 320;     // how far players see / hear running
export const TUNE = { base: 1.3, hold: 2.4, moving: 0.6, busy: 0.3 };
export const ROUND_TIME = 25, BOMB_TIME = 15, PLANT_TIME = 2, DEFUSE_TIME = 4;

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- T playbook -----------------------------------------------------------
const go = (to, mode = 'run') => ({ go: to, mode });
const wait = (until) => ({ wait: until });
const flash = (at) => ({ flash: at });
const all = (script) => [0, 1, 2, 3, 4].map(() => script.slice());

export const STRATS = {
  B_rush: {
    site: 'B', weight: 0.2, desc: 'B rush: all 5 ran through tunnels',
    build: () => all([go('B_tunnels_lower'), go('B_site')]),
  },
  A_long: {
    site: 'A', weight: 0.1, desc: 'A long take: 4 through long, 1 late through short',
    build: () => [
      [go('long_doors'), go('A_site')], [go('long_doors'), go('A_site')],
      [go('long_doors'), go('A_site')], [go('long_doors'), go('A_site')],
      [go('mid', 'walk'), wait(8), go('A_short'), go('A_site')],
    ],
  },
  A_split: {
    site: 'A', weight: 0.15, desc: 'A split: 3 through long + 2 through short, hit together',
    build: () => [
      [go('long_doors', 'walk'), wait(8), go('A_site')],
      [go('long_doors', 'walk'), wait(8), go('A_site')],
      [go('long_doors', 'walk'), wait(8), go('A_site')],
      [go('mid', 'walk'), wait(9), go('A_site')],
      [go('mid', 'walk'), wait(9), go('A_site')],
    ],
  },
  fake_B_hit_A: {
    site: 'A', weight: 0.3, desc: 'Fake B (2 made noise + flash in tunnels), real hit A long with 3',
    build: () => [
      [go('long_doors', 'walk'), wait(9), go('A_site')],
      [go('long_doors', 'walk'), wait(9), go('A_site')],
      [go('long_doors', 'walk'), wait(9), go('A_site')],
      [go('B_tunnels_upper'), flash('B_site'), wait(12), go('A_short')],
      [go('B_tunnels_upper'), wait(12), go('A_short')],
    ],
  },
  mid_to_B: {
    site: 'B', weight: 0.15, desc: 'B split: 3 through tunnels + 2 through mid doors and window',
    build: () => [
      [go('B_tunnels_lower', 'walk'), wait(9), go('B_site')],
      [go('B_tunnels_lower', 'walk'), wait(9), go('B_site')],
      [go('B_tunnels_lower', 'walk'), wait(9), go('B_site')],
      [go('mid', 'walk'), wait(8), go('mid_doors'), go('B_window'), go('B_site')],
      [go('mid', 'walk'), wait(8), go('mid_doors'), go('B_window'), go('B_site')],
    ],
  },
  fake_A_hit_B: {
    site: 'B', weight: 0.1, desc: 'Fake A (2 made noise + flash at long), real hit B tunnels with 3',
    build: () => [
      [go('B_tunnels_lower', 'walk'), wait(9), go('B_site')],
      [go('B_tunnels_lower', 'walk'), wait(9), go('B_site')],
      [go('B_tunnels_lower', 'walk'), wait(9), go('B_site')],
      [go('long_doors'), flash('A_long'), wait(13), go('A_long')],
      [go('long_doors'), wait(13), go('A_long')],
    ],
  },
};

export function pickStrat(rng) {
  let r = rng() * Object.values(STRATS).reduce((s, x) => s + x.weight, 0);
  for (const [k, v] of Object.entries(STRATS)) { r -= v.weight; if (r <= 0) return k; }
  return 'B_rush';
}

// ---- round ------------------------------------------------------------------
function mkPlayer(id, team, node, idx) {
  const n = NODES[node];
  return { id, team, idx, x: n.x, y: n.y, node, path: [], mode: 'run', moving: false, alive: true, hasBomb: false, busy: false };
}

export function createRound(stratKey, seed) {
  const strat = STRATS[stratKey];
  const scripts = strat.build();
  const players = [];
  for (let i = 0; i < 5; i++) players.push(mkPlayer('CT' + (i + 1), 'CT', 'CT_spawn', i));
  for (let i = 0; i < 5; i++) {
    const p = mkPlayer('T' + (i + 1), 'T', 'T_spawn', i);
    p.script = scripts[i]; p.si = 0; p.routed = false;
    players.push(p);
  }
  players.find((p) => p.id === 'T1').hasBomb = true;
  return {
    rng: mulberry32(seed), stratKey, strat, players, time: 0, phase: 'freeze', events: [], shots: [],
    planted: false, bomb: null, bombTimer: 0, plantProg: 0, defuseProg: 0, defuser: null, planter: null,
    winner: null, reason: null,
  };
}

export function route(p, target, mode = 'run') {
  const cands = [p.node];
  if (p.path.length && p.path[0] !== p.node) cands.push(p.path[0]);
  let best = null, bd = Infinity;
  for (const c of cands) {
    const sp = shortestPath(c, target);
    const d = dist(p, NODES[c]) + pathLength(sp);
    if (d < bd) { bd = d; best = sp; }
  }
  p.path = best;
  p.mode = mode;
}

export function orderMove(s, id, to) {
  const p = s.players.find((q) => q.id === id);
  if (p && p.alive && NODES[to]) route(p, to, 'run');
}

export function step(s, dt) {
  if (s.phase !== 'live') return;
  s.time += dt;
  for (const p of s.players) if (p.alive && p.team === 'T') runScript(s, p);
  for (const p of s.players) if (p.alive) move(p, dt);
  for (const p of s.players) p.busy = false;
  bomb(s, dt);
  combat(s, dt);
  checkEnd(s);
}

function runScript(s, p) {
  for (let guard = 0; guard < 5 && p.si < p.script.length; guard++) {
    const st = p.script[p.si];
    if (st.go) {
      if (!p.routed) { route(p, st.go, st.mode); p.routed = true; }
      if (p.path.length === 0 && p.node === st.go) { p.si++; p.routed = false; continue; }
      break;
    }
    if (st.wait !== undefined) { if (s.time >= st.wait) { p.si++; continue; } break; }
    if (st.flash) { s.events.push({ t: s.time, type: 'flash', at: st.flash }); p.si++; continue; }
  }
}

function move(p, dt) {
  const had = p.path.length > 0;
  let budget = (p.mode === 'walk' ? WALK : RUN) * dt;
  while (budget > 0 && p.path.length) {
    const n = NODES[p.path[0]];
    const dx = n.x - p.x, dy = n.y - p.y, d = Math.hypot(dx, dy);
    if (d <= budget) { p.x = n.x; p.y = n.y; p.node = p.path.shift(); budget -= d; }
    else { p.x += (dx / d) * budget; p.y += (dy / d) * budget; budget = 0; }
  }
  p.moving = had;
}

function combat(s, dt) {
  const alive = s.players.filter((p) => p.alive);
  const kills = [];
  s.shots = [];
  for (const p of alive) {
    let target = null, bd = Infinity;
    for (const q of alive) {
      if (q.team === p.team) continue;
      const d = dist(p, q);
      if (d < VISION && d < bd) { bd = d; target = q; }
    }
    if (!target) continue;
    s.shots.push([p, target]);
    let rate = TUNE.base * (p.moving ? TUNE.moving : TUNE.hold);   // holding an angle beats running in
    if (p.busy) rate *= TUNE.busy;                                   // planting / defusing = can't fight back well
    if (s.rng() < 1 - Math.exp(-rate * dt)) kills.push([p, target]);
  }
  for (const [k, v] of kills) {
    if (!v.alive) continue;
    v.alive = false; v.path = [];
    s.events.push({ t: s.time, type: 'kill', killer: k.id, victim: v.id, victimTeam: v.team, at: nearestNode(v.x, v.y) });
    if (v.hasBomb) { v.hasBomb = false; passBomb(s, v); }
  }
}

function passBomb(s, dead) {
  if (s.planted) return;
  let best = null, bd = Infinity;
  for (const t of s.players) {
    if (t.team !== 'T' || !t.alive) continue;
    const d = dist(t, dead);
    if (d < bd) { bd = d; best = t; }
  }
  if (!best) return;
  best.hasBomb = true;
  best.script = [go(s.strat.site + '_site')]; best.si = 0; best.routed = false;
}

function bomb(s, dt) {
  if (!s.planted) {
    const c = s.players.find((p) => p.alive && p.hasBomb);
    const sn = c && ['A_site', 'B_site'].find((n) => dist(c, NODES[n]) < 30);
    if (c && sn && !c.moving) {
      c.busy = true; s.planter = c.id; s.plantProg += dt;
      if (s.plantProg >= PLANT_TIME) {
        s.planted = true; s.planter = null; c.hasBomb = false;
        s.bomb = { site: NODES[sn].site, node: sn, x: c.x, y: c.y };
        s.bombTimer = BOMB_TIME;
        s.events.push({ t: s.time, type: 'plant', site: NODES[sn].site, at: sn });
        for (const t of s.players) if (t.alive && t.team === 'T') { t.script = [go(sn)]; t.si = 0; t.routed = false; }
      }
    } else { s.plantProg = 0; s.planter = null; }
  } else {
    s.bombTimer -= dt;
    const ts = s.players.filter((p) => p.alive && p.team === 'T');
    const d = s.players.find((p) => p.alive && p.team === 'CT' && dist(p, s.bomb) < 30 && !p.moving && !ts.some((t) => dist(t, p) < VISION));
    if (d) {
      d.busy = true; s.defuser = d.id; s.defuseProg += dt;
      if (s.defuseProg >= DEFUSE_TIME) return end(s, 'CT', 'Bomb defused');
    } else { s.defuseProg = 0; s.defuser = null; }
    if (s.bombTimer <= 0) return end(s, 'T', 'Bomb exploded');
  }
}

function checkEnd(s) {
  if (s.winner) return;
  const ct = s.players.some((p) => p.team === 'CT' && p.alive);
  const t = s.players.some((p) => p.team === 'T' && p.alive);
  if (!ct) return end(s, 'T', 'CTs eliminated');
  if (!t && !s.planted) return end(s, 'CT', 'Ts eliminated');
  if (!s.planted && s.time >= ROUND_TIME) return end(s, 'CT', 'Time ran out');
}

function end(s, winner, reason) {
  if (s.winner) return;
  s.winner = winner; s.reason = reason; s.phase = 'over';
  s.events.push({ t: s.time, type: 'end', winner, reason });
}

export function timeLeft(s) {
  if (s.phase === 'freeze') return ROUND_TIME;
  return Math.max(0, s.planted ? s.bombTimer : ROUND_TIME - s.time);
}
export const fmtClock = (sec) => `0:${String(Math.ceil(sec)).padStart(2, '0')}`;
