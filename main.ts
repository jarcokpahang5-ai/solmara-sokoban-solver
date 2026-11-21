// Solmara Sokoban solver — a push-based A* solver, one run over a whole set of instances.
//
// How it works
// ------------
// Every level this competition draws is a hallway with one to four small rooms off it (three or four
// boxes each), and a box pushed out of a room through its door can never be pushed back, so the rooms
// are independent problems joined only by the player's walk: the level's push-optimal count is the sum
// of its rooms' optima. The solver therefore
//
//   1. cuts the hallway's dead squares (a box standing there reaches no goal) out of the floor and
//      takes each remaining part that holds boxes as one room, its squares, boxes and goals;
//   2. solves each room on its own with an A* over pushes (a state is the boxes' squares and the
//      player's reachable region, named by its lowest square), the other rooms' boxes standing as
//      walls, and stitches the rooms' move strings together with the walks between them;
//   3. falls back to one A* over the whole level when a level is no set of rooms, and to an empty
//      (valid, unscored) answer when a search gives up, so every instance is always answered.
//
// The A* is push-optimal: its estimate is the cheapest assignment of boxes to goals (Hungarian, by
// brute force over at most 4! pairings) under the shortest push distances on the box graph (a box
// moves one square per push, and only along an edge whose far side a player can stand on), which is a
// lower bound on the pushes still needed, and it never grows by more than one per push, so the first
// solved state the search pops is optimal. It prunes two deadlocks a box can never leave: a dead
// square (no push, ignoring the other boxes, brings a box from there to any goal) and a frozen box
// (one no push can ever move, by a fixed point over walls and boxes already frozen) standing off its
// goal. A transposition table keeps the cheapest pushes for every state seen.
//
// Determinism: every budget is a count of states, never the clock (the program reads no clock and no
// randomness); ties in the open list break by deeper first, then by arrival order, and walks break
// ties by the direction order u, d, l, r, so two runs on one set write the same bytes.
//
// The whole set shares one wall budget of 60 seconds on the grader, so the work is capped in states:
// each room's search keeps at most ROOM_MAX_STATES states (a second, larger try when the first gives
// up), the whole-level fallback at most GLOBAL_MAX_STATES, and the run as a whole at most
// RUN_MAX_STATES; past that, the remaining instances get empty answers rather than no answer at all.
//
// Node 22 runs this file as it is (erasable TypeScript only: plain JavaScript, Node built-ins alone,
// no installs, no network, no native code). Reads /input (or MAKEFUN_INPUT_DIR), writes
// /output/<id>/solution.txt (or MAKEFUN_OUTPUT_DIR), creating each /output/<id>/ itself.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The four directions: [dx, dy, the step's letter, the push's letter]. */
const DIRS = Object.freeze([
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
]);

/** Work budgets, in states kept (never the clock): a room's first try, its retry, the whole level, the run. */
const ROOM_MAX_STATES = 300_000;
const ROOM_MAX_STATES_RETRY = 1_000_000;
const GLOBAL_MAX_STATES = 600_000;
const RUN_MAX_STATES = 2_500_000;
let runStates = 0;

/**
 * A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a
 * goal), one row a line: its width and height, walls (1 a wall, short rows and squares outside padded
 * as walls), goals, boxes and player.
 */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // A square on the outermost frame is a wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals: goals.sort((a, b) => a - b), boxes: boxes.sort((a, b) => a - b), player };
}

/** The squares from which a box alone can be pushed onto some goal (pulled back from the goals over open floor). */
function liveSquares(level) {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a box there reaches no
 * goal) out of the floor, and each part left that holds a box is a room, its squares, boxes and
 * goals. Null when some part holds more or fewer boxes than goals, or a box starts in the hallway:
 * then the level is no set of rooms.
 */
function roomsOf(level) {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The box graph's shortest push distances: dist[from][to] is the fewest pushes moving one box alone
 * from `from` to `to` (a box steps to a neighbouring square only when the square behind it is open
 * floor for the player to stand on), or -1 when no such walk exists. The graph is directed, so the
 * distances come from a breadth-first search out of every floor square.
 */
function boxDistances(level) {
  const { w, wall } = level;
  const size = wall.length;
  const dist = new Array(size);
  const queue = new Int32Array(size);
  for (let s = 0; s < size; s++) {
    if (wall[s]) continue;
    const d = new Int32Array(size).fill(-1);
    d[s] = 0;
    let qh = 0;
    let qt = 0;
    queue[qt++] = s;
    while (qh < qt) {
      const b = queue[qh++];
      for (const [dx, dy] of DIRS) {
        const step = dy * w + dx;
        const t = b + step;
        if (wall[t] || wall[b - step] || d[t] >= 0) continue;
        d[t] = d[b] + 1;
        queue[qt++] = t;
      }
    }
    dist[s] = d;
  }
  return dist;
}

/** The cheapest assignment of boxes to goals under the push distances: Infinity when some box reaches no goal. */
function assignmentCost(boxes, goals, dist) {
  const n = boxes.length;
  if (n === 0) return 0;
  // Brute force over the pairings (at most 4! = 24): the boxes are few, and the cost is a lower bound
  // on the pushes still needed, since one push moves one box by one square along the box graph.
  const used = new Array(n).fill(false);
  let best = Infinity;
  const walk = (i, cost) => {
    if (cost >= best) return;
    if (i === n) {
      best = cost;
      return;
    }
    const d = dist[boxes[i]];
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      const c = d[goals[j]];
      if (c < 0) continue;
      used[j] = true;
      walk(i + 1, cost + c);
      used[j] = false;
    }
  };
  walk(0, 0);
  return best;
}

/**
 * Whether some box of `boxes` is frozen off its goal: a box is frozen when no push can ever move it,
 * decided by a fixed point — a box whose every push is blocked by a wall or a box already frozen
 * never moves, and only walls and frozen boxes ever block a push (a box that can still move may step
 * out of the way). A frozen box on its goal is no deadlock; one off it is.
 */
function frozenDeadlock(w, boxes, wall, goal, occupied) {
  const n = boxes.length;
  const frozen = new Uint8Array(n);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < n; i++) {
      if (frozen[i]) continue;
      const b = boxes[i];
      let stuck = true;
      for (const [dx, dy] of DIRS) {
        const step = dy * w + dx;
        const ahead = b + step;
        const behind = b - step;
        const blockedAhead = wall[ahead] || (occupied[ahead] && frozen[boxes.indexOf(ahead)]);
        const blockedBehind = wall[behind] || (occupied[behind] && frozen[boxes.indexOf(behind)]);
        if (!blockedAhead && !blockedBehind) {
          stuck = false;
          break;
        }
      }
      if (stuck) {
        frozen[i] = 1;
        changed = true;
      }
    }
  }
  for (let i = 0; i < n; i++) if (frozen[i] && !goal[boxes[i]]) return true;
  return false;
}

/** A state's key: the region's lowest square and the boxes' squares, as digits in base `size`. */
function keyOf(boxes, low, size) {
  let k = low;
  for (const b of boxes) k = k * size + b;
  return k;
}

/** The boxes of a key (sorted, as encoded), and the region's lowest square. */
function decodeKey(key, n, size) {
  const boxes = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    boxes[i] = key % size;
    key = Math.floor(key / size);
  }
  return { boxes, low: key };
}

/**
 * The squares the player reaches from `from` with `occupied` (a box mask) in the way, marked in
 * `seen` with `stamp`; the lowest square of the region. `stack` is scratch space.
 */
function reach(level, occupied, from, seen, stamp, stack) {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (the first direction first on ties). */
function walkTo(level, occupied, from, to) {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, the case aside) from `from` on a board `w` wide. */
function endOf(w, from, moves) {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * The push-optimal solution of `level`, searching at most `maxStates` states: {pushes, moves} (moves
 * in LURD: a lower letter a step, an upper one a push), or null when the search gives up (or the
 * level has no solution). An A* over pushes: a state is the boxes' squares and the player's reachable
 * region; the estimate is the cheapest box-to-goal assignment under the box graph's distances, which
 * is admissible and consistent, so the first solved state popped is optimal. Dead squares and frozen
 * boxes prune states no push can save. The search keeps at most `maxStates` states, counted in work,
 * never the clock, so it answers alike on every run.
 */
function solvePushOptimal(level, maxStates) {
  const { w, wall, goals } = level;
  const size = wall.length;
  const n = level.boxes.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const dist = boxDistances(level);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  if (level.boxes.some((b) => !live[b])) return null;
  const occ0 = new Uint8Array(size);
  for (const b of level.boxes) occ0[b] = 1;
  if (frozenDeadlock(w, level.boxes, wall, goal, occ0)) return null;
  const solved = (boxes) => boxes.every((b) => goal[b]);

  // The states in the order found: their key, pushes so far, parent and the push that made them, and
  // the player's square after the push. The open list is a heap on (pushes + estimate, deeper first,
  // then arrival order): fully deterministic, no clock, no randomness.
  const keys = [];
  const gs = [];
  const parent = [];
  const pushFrom = [];
  const pushTo = [];
  const playerAt = [];
  const best = new Map();
  const heap = [];
  const heapLess = (a, b) =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e) => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i], heap[p])) break;
      const t = heap[i];
      heap[i] = heap[p];
      heap[p] = t;
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1], heap[c])) c++;
        if (!heapLess(heap[c], heap[i])) break;
        const t = heap[i];
        heap[i] = heap[c];
        heap[c] = t;
        i = c;
      }
    }
    return top;
  };

  for (const b of level.boxes) occupied[b] = 1;
  const rootLow = reach(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  const rootKey = keyOf(level.boxes, rootLow, size);
  keys.push(rootKey);
  gs.push(0);
  parent.push(-1);
  pushFrom.push(-1);
  pushTo.push(-1);
  playerAt.push(level.player);
  best.set(rootKey, 0);
  let seq = 0;
  heapPush([assignmentCost(level.boxes, goals, dist), 0, seq++, 0]);
  if (solved(level.boxes)) return { pushes: 0, moves: '' };

  let found = -1;
  while (heap.length > 0) {
    const [, negG, , s] = heapPop();
    const g = -negG;
    if (g !== gs[s]) continue; // a stale entry: a cheaper path to this state was found since
    if (best.get(keys[s]) !== s) continue; // orphaned: a cheaper path to this state now lives elsewhere
    if (solved(decodeKey(keys[s], n, size).boxes)) {
      found = s;
      break;
    }
    const { boxes } = decodeKey(keys[s], n, size);
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    reach(level, occupied, playerAt[s], seen, here, stack);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const stand = b - d;
        const t = b + d;
        if (seen[stand] !== here || wall[t] || occupied[t] || !live[t]) continue;
        const next = boxes.slice();
        next[bi] = t;
        next.sort((a, b) => a - b);
        occupied[b] = 0;
        occupied[t] = 1;
        const dead = frozenDeadlock(w, next, wall, goal, occupied);
        let key = -1;
        if (!dead) {
          const low = reach(level, occupied, b, mark, ++stamp, stack);
          key = keyOf(next, low, size);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (dead) continue;
        const seenIdx = best.get(key);
        if (seenIdx !== undefined && gs[seenIdx] <= g + 1) continue;
        if (keys.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          runStates += keys.length;
          return null;
        }
        const idx = keys.length;
        keys.push(key);
        gs.push(g + 1);
        parent.push(s);
        pushFrom.push(b);
        pushTo.push(t);
        playerAt.push(b);
        best.set(key, idx);
        const h = assignmentCost(next, goals, dist);
        if (h === Infinity) {
          // No box reaches a goal from here: dead, though the live-square check missed it.
          keys.pop();
          gs.pop();
          parent.pop();
          pushFrom.pop();
          pushTo.pop();
          playerAt.pop();
          best.delete(key);
          continue;
        }
        heapPush([g + 1 + h, -(g + 1), seq++, idx]);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) {
    runStates += keys.length;
    return null;
  }
  // The path of states, then the moves: walk to each push's square, then push.
  const path = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const from = pushFrom[s];
    const to = pushTo[s];
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d);
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = boxes.map((b) => (b === from ? to : b)).sort((a, b) => a - b);
  }
  runStates += keys.length;
  return { pushes: path.length, moves };
}

/**
 * The level solved room by room: each room's push-optimal solution in turn, the other rooms' boxes
 * standing as walls (on their goals once their room is done), the player walking on from where the
 * last room left it. A box never leaves its room (a push through a door lands it in the hallway,
 * where it reaches no goal), so the rooms' optima add up to the level's: {pushes, moves}, or null
 * when a room's search gives up, or the level is no set of rooms and the search over the whole level
 * gives up.
 */
function solveByRooms(level) {
  const rooms = roomsOf(level);
  if (rooms === null) {
    return solvePushOptimal(level, GLOBAL_MAX_STATES);
  }
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    let solved = solvePushOptimal(sub, ROOM_MAX_STATES);
    if (solved === null && runStates < RUN_MAX_STATES) {
      solved = solvePushOptimal(sub, ROOM_MAX_STATES_RETRY);
    }
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** The moves for a level in XSB: a string of u, d, l and r (an upper letter marks a push; case is not checked). */
function solve(text) {
  try {
    const level = parseLevel(text);
    if (level.boxes.length === 0) return '';
    const byRooms = solveByRooms(level);
    if (byRooms !== null) return byRooms.moves;
    const whole = solvePushOptimal(level, GLOBAL_MAX_STATES);
    if (whole !== null) return whole.moves;
  } catch {
    // Any failure still answers the instance, with an empty (valid, unscored) solution.
  }
  return '';
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    if (!statSync(join(I, id)).isDirectory()) continue;
    if (runStates < RUN_MAX_STATES) moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
