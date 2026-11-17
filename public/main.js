// Screen + game loop. Wires simulator <-> harness <-> Kimi.
import { NODES, EDGES, MAP_NAME, label } from './map.js';
import { createRound, step, orderMove, timeLeft, fmtClock, mulberry32, STRATS } from './sim.js';
import { Perception, systemPrompt, briefing, callKimi, validate, fakeIGL, setupSummary, summarizeRound, randomHistory } from './harness.js';

const params = new URLSearchParams(location.search);
const FAKE = params.has('fake');
const SEED = Number(params.get('seed') || 7);
const SPEED = Number(params.get('speed') || 1);
const LIVE = (params.get('strats') || 'fake_B_hit_A,B_rush,A_split').split(',').filter((k) => STRATS[k]);
const HISTORY = 5;
const STEP = !params.has('auto');                  // presenter mode: freeze after every Kimi call until you click / press Space
const MAX_MID = Number(params.get('calls') || 3);  // mid-round Kimi calls per round (a bomb plant always gets one)
const MIN_GAP = 3;                                 // seconds of game time between mid-round calls

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SVG = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};

let game, s, perception, comms, calls, inFlight, pending, lastCallEnd, callCount, setupText, arrows, thinkStart;
let paused = false, thinking = false, goResolve = null;

// ------------------------------------------------------------------ map drawing
const svg = $('map');
const layers = {};
function drawMap() {
  svg.innerHTML = '';
  for (const name of ['floor', 'spots', 'fx', 'players', 'top']) layers[name] = el('g', {}, svg);
  for (const [a, b] of EDGES) el('line', { class: 'corr-edge', x1: NODES[a].x, y1: NODES[a].y, x2: NODES[b].x, y2: NODES[b].y }, layers.floor);
  for (const [a, b] of EDGES) el('line', { class: 'corr', x1: NODES[a].x, y1: NODES[a].y, x2: NODES[b].x, y2: NODES[b].y }, layers.floor);
  for (const [id, n] of Object.entries(NODES)) {
    el('circle', { class: 'spot' + (n.site ? ' site' : ''), cx: n.x, cy: n.y, r: n.site ? 88 : 46 }, layers.spots);
    if (n.site) { const t = el('text', { class: 'site-letter', x: n.x, y: n.y }, layers.spots); t.textContent = n.site; }
    const lt = el('text', { class: 'spot-label', x: n.x, y: n.y + (n.site ? 118 : 72) }, layers.spots);
    lt.textContent = n.label;
  }
  const mn = el('text', { class: 'map-name', x: 30, y: 975 }, layers.spots); mn.textContent = MAP_NAME.toUpperCase();
}

const OFFSETS = [[0, -22], [21, -7], [13, 18], [-13, 18], [-21, -7]];
const pEls = {};
function renderPlayers() {
  for (const p of s.players) {
    let g = pEls[p.id];
    if (!g) {
      g = el('g', {}, layers.players);
      el('circle', { r: 17 }, g);
      el('text', {}, g);
      el('rect', { class: 'bomb-carrier', x: 10, y: -24, width: 12, height: 12, rx: 2 }, g);
      pEls[p.id] = g;
    }
    const [ox, oy] = OFFSETS[p.idx];
    g.setAttribute('class', `pl ${p.team}${p.alive ? '' : ' dead'}`);
    g.setAttribute('transform', `translate(${p.x + ox},${p.y + oy})`);
    g.querySelector('text').textContent = p.alive ? p.id.replace(/\D/g, '') : '✖';
    g.querySelector('rect').style.display = p.alive && p.hasBomb ? '' : 'none';
  }
}

function renderFx() {
  layers.fx.innerHTML = '';
  layers.top.innerHTML = '';
  for (const [a, b] of s.shots) {
    const [ax, ay] = OFFSETS[a.idx], [bx, by] = OFFSETS[b.idx];
    el('line', { class: 'shot ' + a.team, x1: a.x + ax, y1: a.y + ay, x2: b.x + bx, y2: b.y + by }, layers.fx);
  }
  const now = performance.now();
  arrows = arrows.filter((a) => a.t0 === null || now - a.t0 < 2500);
  for (const a of arrows) {
    if (a.t0 === null) {   // planned order, not executed yet: follow the player, full opacity
      const p = s.players.find((q) => q.id === a.player);
      const [ox, oy] = OFFSETS[p.idx];
      Object.assign(a, { x1: p.x + ox, y1: p.y + oy, x2: NODES[a.to].x + ox, y2: NODES[a.to].y + oy });
    }
    const o = a.t0 === null ? 1 : 1 - (now - a.t0) / 2500;
    el('line', { class: 'order-arrow', x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, opacity: o.toFixed(2) }, layers.fx);
    el('circle', { cx: a.x2, cy: a.y2, r: 10, fill: '#5fd38d', opacity: o.toFixed(2) }, layers.fx);
  }
  for (const e of s.events.filter((e) => e.type === 'flash' && s.time - e.t < 0.6)) {
    el('circle', { class: 'flashfx', cx: NODES[e.at].x, cy: NODES[e.at].y, r: 90 }, layers.fx);
  }
  if (s.planted) {
    el('circle', { class: 'bomb-ring', cx: s.bomb.x, cy: s.bomb.y, r: 34 }, layers.top);
    const t = el('text', { class: 'prog', x: s.bomb.x, y: s.bomb.y - 48 }, layers.top);
    t.textContent = s.defuser ? `${s.defuser} defusing ${s.defuseProg.toFixed(1)}/4s` : `💣 ${Math.ceil(s.bombTimer)}s`;
  } else if (s.planter) {
    const p = s.players.find((q) => q.id === s.planter);
    const t = el('text', { class: 'prog', x: p.x, y: p.y - 44 }, layers.top);
    t.textContent = `${p.id} planting ${s.plantProg.toFixed(1)}/2s`;
  }
}

function renderHud() {
  $('round').textContent = `Round ${game.round}/${LIVE.length}`;
  const c = $('clock');
  c.textContent = fmtClock(timeLeft(s));
  c.classList.toggle('planted', s.planted);
  $('sct').textContent = game.score.CT;
  $('st').textContent = game.score.T;
  $('secret').textContent = `🔒 T plan (hidden from Kimi): ${s.strat.desc}`;
  if (thinking) $('kstatus').textContent = `thinking… ${((performance.now() - thinkStart) / 1000).toFixed(1)}s`;
}

function banner(html, cls = '') {
  const b = $('banner');
  b.className = 'banner ' + cls;
  b.innerHTML = html;
}
const hideBanner = () => { $('banner').className = 'banner hidden'; };

// ------------------------------------------------------------------ side panels
function renderNotebook() {
  $('notebook').innerHTML = game.notebook.map((n, i) =>
    `<li class="${i >= HISTORY ? 'live' : ''} ${/ WON /.test(n) ? 'won' : 'lost'}">${esc(n)}</li>`).join('');
}
function addComm(c) {
  const li = document.createElement('li');
  li.className = c.kind;
  li.innerHTML = `<b>${esc(c.clock)}</b>${esc(c.text)}`;
  $('comms').prepend(li);
}
function addCallRow(rec) {
  const li = document.createElement('li');
  const moves = rec.moves.map((m) => `${m.player}→${label(m.to)}`).join(', ') || 'hold';
  li.innerHTML = `<b>${esc(rec.time)}</b>${rec.err ? '⏱ ' : ''}“${esc(rec.callout || '…')}” <span style="color:var(--muted)">${esc(moves)}</span>`;
  $('calls').prepend(li);
}

const kimi = {
  start(reason, n) {
    $('kdot').className = 'dot thinking';
    $('kreason').textContent = `📡 Call ${n}: ${reason}`;
    $('kthink').className = 'kthink raw';
    $('kthink').textContent = '…';
    $('kcallout').textContent = '';
    $('korders').innerHTML = '';
    $('krejected').innerHTML = '';
  },
  stream({ reasoning, thinking }) {
    if (thinking) { $('kthink').className = 'kthink'; $('kthink').textContent = thinking; }
    else if (reasoning) { $('kthink').className = 'kthink raw'; $('kthink').textContent = '…' + reasoning.slice(-220); }
  },
  done(rec) {
    $('kdot').className = 'dot ' + (rec.err ? 'err' : 'ok');
    $('kstatus').textContent = rec.err ? `⏱ ${rec.err} — fallback` : `orders in ${(rec.ms / 1000).toFixed(1)}s`;
    $('kthink').className = 'kthink';
    $('kthink').textContent = rec.thinking || (rec.err ? 'No answer in time — team keeps its current plan.' : '');
    $('kcallout').textContent = rec.callout ? `“${rec.callout}”` : '';
    $('korders').innerHTML = rec.moves.length
      ? rec.moves.map((m) => `<li>${m.player} → ${esc(label(m.to))}</li>`).join('')
      : '<li>everyone holds</li>';
    $('krejected').innerHTML = rec.rejected.map((r) => `<li>⚠ rejected: ${esc(r)}</li>`).join('');
  },
};

// ------------------------------------------------------------------ IGL calls
function waitForGo(text) {
  const b = $('go');
  b.textContent = text;
  b.classList.remove('hidden');
  return new Promise((resolve) => {
    goResolve = () => { b.classList.add('hidden'); goResolve = null; resolve(); };
  });
}

async function askIGL(kind, reason) {
  inFlight = true; thinking = true; thinkStart = performance.now();
  if (STEP) paused = true;          // freeze the moment Kimi is reacting to
  callCount++;
  const roundAt = game.round;
  const time = s.phase === 'freeze' ? 'setup' : fmtClock(timeLeft(s));
  kimi.start(reason, callCount);

  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: briefing({ game, s, comms, calls, reason, rounds: LIVE.length }) },
  ];
  let res;
  if (FAKE) { await sleep(600); res = { args: fakeIGL(s, comms, kind), ms: 600, err: null }; }
  else res = await callKimi(messages, (u) => kimi.stream(u));

  if (game.round !== roundAt) return;                 // stale reply from a previous round
  thinking = false;
  if (s.phase === 'over') { inFlight = false; paused = false; return; }
  if (res.err) res.args = kind === 'setup' ? fakeIGL(s, comms, 'setup') : { thinking: '', callout: '', moves: [] };

  const v = validate(res.args, s);
  const rec = { time, reason, ...v, ms: res.ms, err: res.err, kind };
  calls.push(rec);
  kimi.done(rec);
  addCallRow(rec);
  for (const m of v.moves) arrows.push({ player: m.player, to: m.to, t0: null });   // show the plan on the map

  if (STEP) await waitForGo(kind === 'setup' ? '▶ Start the round   (Space)' : '▶ Execute orders   (Space)');
  if (game.round !== roundAt) return;

  for (const m of v.moves) orderMove(s, m.player, m.to);
  const now = performance.now();
  for (const a of arrows) if (a.t0 === null) a.t0 = now;
  if (kind === 'setup') setupText = setupSummary(s);
  inFlight = false; paused = false;
  lastCallEnd = s.time;
}

// ------------------------------------------------------------------ round flow
async function nextRound() {
  game.round++;
  s = createRound(LIVE[game.round - 1], SEED * 100 + game.round);
  for (const k of Object.keys(pEls)) { pEls[k].remove(); delete pEls[k]; }
  perception = new Perception();
  comms = []; calls = []; arrows = [];
  inFlight = false; pending = null; lastCallEnd = -99; callCount = 0; setupText = '';
  paused = false; thinking = false;
  $('comms').innerHTML = ''; $('calls').innerHTML = '';
  banner(`Round ${game.round} · freeze time<small>Kimi is setting up the CTs…</small>`);
  await askIGL('setup', 'Freeze time — set up your 5 players.');
  hideBanner();
  s.phase = 'live';
}

function onRoundEnd() {
  s.ended = true;
  game.score[s.winner]++;
  const line = summarizeRound(HISTORY + game.round, s, setupText || '?');
  game.notebook.push(line);
  renderNotebook();
  banner(`${s.winner === 'CT' ? 'CT' : 'T'} WIN — ${esc(s.reason)}<small>Ts did: ${esc(s.strat.desc)}</small>`, s.winner);
  const showFinal = () => {
    banner(`FINAL · CT ${game.score.CT} – ${game.score.T} T`, game.score.CT > game.score.T ? 'CT' : 'T');
    $('start').textContent = '↻ Run again';
    $('start').classList.remove('hidden');
  };
  const last = game.round >= LIVE.length;
  if (STEP) waitForGo(last ? '▶ Final score   (Space)' : '▶ Next round   (Space)').then(last ? showFinal : nextRound);
  else setTimeout(last ? showFinal : nextRound, 4500);
}

function startMatch() {
  $('start').classList.add('hidden');
  game = { round: 0, score: { CT: 0, T: 0 }, notebook: randomHistory(mulberry32(SEED), HISTORY) };
  renderNotebook();
  nextRound();
}

function tick() {
  if (!s) return;
  if (s.phase === 'live' && !paused) {
    step(s, 0.05 * SPEED);
    for (const c of perception.update(s)) {
      comms.push(c); addComm(c);
      if (c.trigger) pending = c;
    }
    // Harness safety rule: bomb down and no T left -> nearest CT goes to defuse.
    if (s.planted && !s.autopilot && !s.players.some((p) => p.team === 'T' && p.alive)) {
      const cts = s.players.filter((p) => p.team === 'CT' && p.alive);
      const near = cts.sort((a, b) => Math.hypot(a.x - s.bomb.x, a.y - s.bomb.y) - Math.hypot(b.x - s.bomb.x, b.y - s.bomb.y))[0];
      if (near) { orderMove(s, near.id, s.bomb.node); s.autopilot = true; addComm({ clock: fmtClock(timeLeft(s)), kind: 'note', text: `🤖 harness: ${near.id} sent to defuse` }); }
    }
    const urgent = pending && pending.kind === 'plant';
    if (pending && !inFlight && (urgent || (s.time - lastCallEnd >= MIN_GAP && callCount < 1 + MAX_MID))) {
      const r = pending; pending = null;
      askIGL('mid', r.text);
    }
    if (s.phase === 'over' && !s.ended) onRoundEnd();
  }
  renderPlayers(); renderFx(); renderHud();
}

// ------------------------------------------------------------------ boot
drawMap();
game = { round: 0, score: { CT: 0, T: 0 }, notebook: randomHistory(mulberry32(SEED), HISTORY) };
s = createRound(LIVE[0], SEED * 100 + 1);
perception = new Perception(); comms = []; calls = []; arrows = [];
renderNotebook();
$('start').onclick = startMatch;
$('go').onclick = () => goResolve?.();
for (const b of [$('start'), $('go')]) b.addEventListener('mousedown', (e) => e.preventDefault());   // no focus -> no double trigger with Space
document.addEventListener('keydown', (e) => {
  if (!['Space', 'Enter', 'ArrowRight'].includes(e.code)) return;
  e.preventDefault();
  if (e.repeat) return;
  if (goResolve) goResolve();
  else if (!$('start').classList.contains('hidden')) $('start').click();
});
fetch('/api/config').then((r) => r.json()).then((c) => {
  $('model').textContent = FAKE ? 'Fake IGL (offline, no AI)' : `${c.model} · effort ${c.effort} · via ai&`;
}).catch(() => { $('model').textContent = FAKE ? 'Fake IGL (offline)' : 'server not reachable'; });
setInterval(tick, 50);
