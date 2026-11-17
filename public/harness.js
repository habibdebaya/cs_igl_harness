// THE HARNESS — everything between the game and Kimi.
//   Eyes:   Perception  -> turns the true game state into what CTs could actually see/hear (fog of war)
//   Brief:  briefing()  -> builds a fresh, short context for every call (no ever-growing chat)
//   Hands:  TOOLS       -> the one `orders` tool Kimi can use
//   Rules:  validate()  -> rejects impossible orders (dead player, unknown spot, duplicates)
//   Memory: notebook    -> how this enemy played in earlier rounds
//   Safety: callKimi()  -> streaming + timeout; fakeIGL() as fallback / offline mode
import { NODES, SPOTS, neighbors, label, areaOf, dist, nearestNode } from './map.js';
import { STRATS, RUN, VISION, HEAR, ROUND_TIME, BOMB_TIME, timeLeft, fmtClock, pickStrat } from './sim.js';

// ---------------------------------------------------------------- Hands
export const TOOLS = [{
  type: 'function',
  function: {
    name: 'orders',
    description: 'Give orders to your CT players. Players you do not mention keep doing what they were doing.',
    parameters: {
      type: 'object',
      properties: {
        thinking: { type: 'string', description: '1-2 short sentences: your read of what the Ts are doing and why you make this call.' },
        callout: { type: 'string', description: 'Short comms to the team, max 8 words.' },
        moves: {
          type: 'array',
          description: 'Players to move. Empty array = everyone holds.',
          items: {
            type: 'object',
            properties: {
              player: { type: 'string', enum: ['CT1', 'CT2', 'CT3', 'CT4', 'CT5'] },
              to: { type: 'string', enum: SPOTS },
            },
            required: ['player', 'to'],
          },
        },
      },
      required: ['thinking', 'callout', 'moves'],
    },
  },
}];

// ---------------------------------------------------------------- System prompt
function mapText() {
  return SPOTS.map((n) => {
    const nb = neighbors(n).map(({ node, d }) => `${node} ${(d / RUN).toFixed(1)}s`).join(', ');
    return `- ${n} (${label(n)}): connects to ${nb}`;
  }).join('\n');
}

export function systemPrompt() {
  return `You are the in-game leader (IGL) of the CT (defending) team in a live 5v5 round of a tactical shooter. You command CT1-CT5 by calling the \`orders\` tool.

Rules of this game:
- Ts must plant the bomb at A_site or B_site within ${ROUND_TIME} seconds. Planting takes 2s. After a plant the bomb explodes in ${BOMB_TIME}s; a CT standing on the bomb with no T in sight defuses it in 4s.
- A player holding still wins most duels against a player who is moving. Numbers matter: 2 CTs together beat 1 T most of the time.
- You do NOT see the enemy. You only know what your team saw or heard (below). Running Ts make footsteps; walking Ts are silent. Teams fake: noise + utility at one site, real hit at the other.
- Rotating from A_site to B_site takes about 8 seconds. Rotating too early on a fake loses the round; rotating too late on a real hit loses it too.

Map spots (travel time when running):
${mapText()}

How to play:
- Read the situation like a pro IGL: use the notebook (how this enemy played earlier), the timing, and the comms. Say what you think the Ts are doing.
- Be decisive. Only move players whose position should change; everyone else keeps holding.
- Always respond by calling \`orders\` exactly once.
- \`thinking\`: 1-2 short sentences in plain English explaining your read. \`callout\`: max 8 words, like real comms.`;
}

// ---------------------------------------------------------------- Eyes (fog of war)
export class Perception {
  constructor() { this.last = {}; this.seenEvents = 0; }

  update(s) {
    const out = [];
    const cts = s.players.filter((p) => p.alive && p.team === 'CT');
    const ts = s.players.filter((p) => p.alive && p.team === 'T');
    const clock = fmtClock(timeLeft(s));
    const push = (c) => out.push({ time: s.time, clock, ...c });

    // Sightings: Ts within vision of any alive CT.
    const seen = {}, visible = new Set();
    for (const t of ts) {
      if (cts.some((c) => dist(c, t) < VISION)) { visible.add(t); const n = nearestNode(t.x, t.y); seen[n] = (seen[n] || 0) + 1; }
    }
    for (const [n, cnt] of Object.entries(seen)) {
      const key = 'see:' + n, prev = this.last[key];
      if (!prev || cnt > prev.n || s.time - prev.t > 5) {
        push({ kind: 'see', at: n, n: cnt, trigger: !prev || cnt > prev.n, text: `👁 ${cnt} T spotted at ${label(n)}` });
        this.last[key] = { n: cnt, t: s.time };
      }
    }

    // Footsteps: running Ts within hearing range, not already visible. Walking = silent.
    const heard = {};
    for (const t of ts) {
      if (visible.has(t) || !t.moving || t.mode !== 'run') continue;
      if (cts.some((c) => dist(c, t) < HEAR)) { const n = nearestNode(t.x, t.y); heard[n] = (heard[n] || 0) + 1; }
    }
    for (const [n, cnt] of Object.entries(heard)) {
      const rank = cnt >= 4 ? 3 : cnt >= 2 ? 2 : 1;
      const bucket = ['', '1', '2-3', '4+'][rank];
      const key = 'hear:' + n, prev = this.last[key];
      if (!prev || rank > prev.n || s.time - prev.t > 5) {
        push({ kind: 'hear', at: n, n: cnt, trigger: !prev || rank > prev.n, text: `👂 Footsteps: ${bucket} running near ${label(n)}` });
        this.last[key] = { n: rank, t: s.time };
      }
    }

    // Public / nearby events since last update.
    for (const e of s.events.slice(this.seenEvents)) {
      if (e.type === 'flash' && cts.some((c) => dist(c, NODES[e.at]) < 450))
        push({ kind: 'util', at: e.at, n: 2, trigger: true, text: `💥 Flash popped over ${label(e.at)}` });
      if (e.type === 'kill' && e.victimTeam === 'CT')
        push({ kind: 'death', at: e.at, n: 1, trigger: true, text: `☠ ${e.victim} died at ${label(e.at)}` });
      if (e.type === 'kill' && e.victimTeam === 'T')
        push({ kind: 'kill', at: e.at, n: 1, trigger: true, text: `🎯 ${e.killer} killed a T at ${label(e.at)}` });
      if (e.type === 'plant')
        push({ kind: 'plant', at: e.at, n: 5, trigger: true, text: `💣 BOMB PLANTED at ${e.site}!` });
    }
    this.seenEvents = s.events.length;
    return out;
  }
}

// ---------------------------------------------------------------- Briefing (fresh context per call)
export function briefing({ game, s, comms, calls, reason, rounds }) {
  const lines = [];
  lines.push(`LIVE ROUND ${game.round} of ${rounds} · Score CT ${game.score.CT} - ${game.score.T} T`);
  if (s.phase === 'freeze') lines.push('Freeze time: the round has not started. Set up your 5 players (all start at CT_spawn).');
  else if (s.planted) lines.push(`BOMB PLANTED at ${s.bomb.node} — explodes in ${s.bombTimer.toFixed(0)}s. You must retake and defuse.`);
  else lines.push(`Time left to stop a plant: ${timeLeft(s).toFixed(0)}s`);
  lines.push(`Why you are being called now: ${reason}`);
  lines.push('');
  lines.push('Your players:');
  for (const p of s.players.filter((q) => q.team === 'CT')) {
    if (!p.alive) { lines.push(`- ${p.id}: DEAD`); continue; }
    const dest = p.path.length ? p.path[p.path.length - 1] : null;
    lines.push(dest && dest !== p.node
      ? `- ${p.id}: moving to ${dest} (now near ${nearestNode(p.x, p.y)})`
      : `- ${p.id}: holding ${p.node}`);
  }
  lines.push('');
  lines.push('What your team saw/heard this round (oldest first):');
  const recent = comms.slice(-14);
  lines.push(recent.length ? recent.map((c) => `- ${c.clock} ${c.text}`).join('\n') : '- nothing yet');
  if (calls.length) {
    lines.push('');
    lines.push('Your earlier calls this round:');
    for (const c of calls) lines.push(`- ${c.time}: "${c.callout}" -> ${c.moves.map((m) => `${m.player}→${m.to}`).join(', ') || 'hold'}`);
  }
  lines.push('');
  lines.push('Notebook — how this enemy played in earlier rounds:');
  lines.push(game.notebook.map((n) => '- ' + n).join('\n'));
  return lines.join('\n');
}

// ---------------------------------------------------------------- Rules (validate orders)
export function validate(args, s) {
  const moves = [], rejected = [], seen = new Set();
  const list = Array.isArray(args?.moves) ? args.moves : [];
  for (const m of list) {
    const p = s.players.find((q) => q.id === m?.player && q.team === 'CT');
    if (!p) rejected.push(`${m?.player} → ${m?.to}: no such player`);
    else if (!p.alive) rejected.push(`${p.id} → ${m.to}: ${p.id} is dead`);
    else if (!SPOTS.includes(m.to)) rejected.push(`${p.id} → ${m.to}: unknown spot`);
    else if (seen.has(p.id)) rejected.push(`${p.id}: ordered twice`);
    else { seen.add(p.id); moves.push({ player: p.id, to: m.to }); }
  }
  return {
    moves, rejected,
    thinking: String(args?.thinking || '').slice(0, 400),
    callout: String(args?.callout || '').slice(0, 80),
  };
}

// ---------------------------------------------------------------- Calling Kimi (streaming + timeout)
function partialField(s, key) {
  const m = s.match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)'));
  if (!m) return '';
  return m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\\/g, '\\');
}

export async function callKimi(messages, onUpdate, { url = '/api/igl', timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  let reasoning = '', content = '', err = null;
  const argsByIdx = {};
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, tools: TOOLS }), signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('server ' + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.t === 'r') reasoning += ev.d;
        else if (ev.t === 'a') argsByIdx[ev.i || 0] = (argsByIdx[ev.i || 0] || '') + ev.d;
        else if (ev.t === 'c') content += ev.d;
        else if (ev.t === 'err') err = ev.d;
        onUpdate?.({ reasoning, thinking: partialField(argsByIdx[0] || '', 'thinking') });
      }
    }
  } catch (e) {
    err = ctrl.signal.aborted ? 'timeout' : String(e.message || e);
  } finally { clearTimeout(timer); }

  let args = null;
  for (const k of Object.keys(argsByIdx).sort()) {
    try {
      const a = JSON.parse(argsByIdx[k]);
      if (!args) args = a; else args.moves = [...(args.moves || []), ...(a.moves || [])];
    } catch { /* partial / broken JSON */ }
  }
  if (!args && content) { const m = content.match(/\{[\s\S]*\}/); if (m) try { args = JSON.parse(m[0]); } catch { /* ignore */ } }
  if (!args && !err) err = 'no orders in reply';
  return { args, ms: performance.now() - t0, err, reasoning };
}

// ---------------------------------------------------------------- Fake IGL (offline / fallback)
export function fakeIGL(s, comms, kind) {
  if (kind === 'setup') return {
    thinking: 'Standard setup: two A, one mid doors, two B. Play for info.',
    callout: 'Default 2-1-2, call what you see.',
    moves: [
      { player: 'CT1', to: 'A_site' }, { player: 'CT2', to: 'A_long' }, { player: 'CT3', to: 'mid_doors' },
      { player: 'CT4', to: 'B_site' }, { player: 'CT5', to: 'B_window' },
    ],
  };
  const alive = s.players.filter((p) => p.team === 'CT' && p.alive);
  if (s.planted) return { thinking: `Bomb is down at ${s.bomb.node}. Everyone retake.`, callout: 'All retake!', moves: alive.map((p) => ({ player: p.id, to: s.bomb.node })) };
  let a = 0, b = 0;
  for (const c of comms.filter((c) => c.at && s.time - c.time < 6)) {
    if (areaOf(c.at) === 'A') a += c.n || 1;
    if (areaOf(c.at) === 'B') b += c.n || 1;
  }
  const flex = alive.find((p) => p.id === 'CT3') || alive[0];
  if (flex && b >= 3 && b > a) return { thinking: 'Lots of noise at B. Rotate the mid player to B.', callout: 'Rotate B!', moves: [{ player: flex.id, to: 'B_site' }] };
  if (flex && a >= 3 && a > b) return { thinking: 'Lots of noise at A. Rotate the mid player to A.', callout: 'Rotate A!', moves: [{ player: flex.id, to: 'A_site' }] };
  return { thinking: 'Not enough info yet. Hold.', callout: 'Hold your angles.', moves: [] };
}

// ---------------------------------------------------------------- Memory (notebook)
export function setupSummary(s) {
  const count = { A: 0, mid: 0, B: 0, spawn: 0 };
  for (const p of s.players.filter((q) => q.team === 'CT')) {
    const dest = p.path.length ? p.path[p.path.length - 1] : p.node;
    count[areaOf(dest)]++;
  }
  return ['A', 'mid', 'B', 'spawn'].filter((k) => count[k]).map((k) => `${count[k]} ${k}`).join(' · ');
}

export function summarizeRound(roundNo, s, setup) {
  const won = s.winner === 'CT';
  return `R${roundNo} — ${s.strat.desc}. Our setup: ${setup}. ${won ? 'WON' : 'LOST'} (${s.reason.toLowerCase()}).`;
}

const SETUPS = ['2 A · 1 mid · 2 B', '3 A · 2 B', '2 A · 3 B', '1 A · 1 mid · 3 B', '3 A · 1 mid · 1 B', '2 A · 2 mid · 1 B'];
export function randomHistory(rng, n = 5) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const k = pickStrat(rng), st = STRATS[k];
    const setup = SETUPS[Math.floor(rng() * SETUPS.length)];
    const onSite = Number((setup.match(new RegExp('(\\d) ' + st.site)) || [0, 0])[1]);
    const won = rng() < (onSite >= 3 ? 0.65 : onSite === 2 ? 0.45 : 0.25);
    const isFake = k.startsWith('fake');
    const reason = won ? ['Ts eliminated', 'bomb defused', 'time ran out'][Math.floor(rng() * 3)]
      : ['bomb exploded', 'CTs eliminated'][Math.floor(rng() * 2)];
    out.push(`R${i} — ${st.desc}. Our setup: ${setup}.${isFake && !won ? ' We rotated to the fake.' : ''} ${won ? 'WON' : 'LOST'} (${reason}).`);
  }
  return out;
}
