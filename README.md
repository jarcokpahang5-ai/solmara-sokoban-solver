# Solmara Sokoban solver

A push-based A* Sokoban solver for make.fun's `sokoban-solver-01-run-20261121` bounty
("Build the best Sokoban solver, 21 November 2026"). One run of `node main.ts` answers a
whole set of 5 instances, writing `/output/<id>/solution.txt` for each.

## How it works

Every level the competition draws is a hallway with one to four small rooms off it (three or
four boxes each), and a box pushed out of a room through its door can never be pushed back, so
the rooms are independent problems joined only by the player's walk: the level's push-optimal
count is the sum of its rooms' optima. The solver therefore:

1. cuts the hallway's dead squares (a box standing there reaches no goal) out of the floor and
   takes each remaining part that holds boxes as one room — its squares, boxes and goals;
2. solves each room on its own with an A\* over pushes (a state is the boxes' squares and the
   player's reachable region, named by its lowest square), the other rooms' boxes standing as
   walls, and stitches the rooms' move strings together with the walks between them;
3. falls back to one A\* over the whole level when a level is no set of rooms, and to an empty
   (valid, unscored) answer when a search gives up, so every instance is always answered.

The A\* is push-optimal. Its estimate is the cheapest assignment of boxes to goals (Hungarian,
by brute force over at most 4! pairings) under the shortest push distances on the box graph (a
box moves one square per push, and only along an edge whose far side a player can stand on):
a lower bound on the pushes still needed, which never grows by more than one per push, so the
first solved state the search pops is optimal. It prunes two deadlocks a box can never leave:
a dead square (no push, ignoring the other boxes, brings a box from there to any goal) and a
frozen box (one no push can ever move, by a fixed point over walls and boxes already frozen)
standing off its goal. A transposition table keeps the cheapest pushes for every state seen.

Determinism: every budget is a count of states, never the clock (the program reads no clock and
no randomness); ties in the open list break by deeper first, then by arrival order, and walks
break ties by the direction order u, d, l, r, so two runs on one set write the same bytes.

## Results (practice set, kit's own checker)

| instance | P\* | pushes | points |
|----------|----|--------|--------|
| i001     | 13 | 13     | 1,000  |
| i002     | 16 | 16     | 1,000  |
| i003     | 29 | 29     | 1,000  |
| i004     | 47 | 47     | 1,000  |
| i005     | 60 | 60     | 1,000  |

Score **1,000,000 of 1,000,000**, in about 0.3 s for the whole set (wall budget: 60 s). The
house baseline (plain-astar 1.0.0) scores 200,000 on the same set — it solves only i001.
The solver was also checked on seven further sets drawn from the kit's own generator with
fresh random seeds: 1,000,000 on every one.

## Run it locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Plain JavaScript in a `.ts` file (Node 22 type-stripping), Node built-in modules only, no
installs, no network, no native code.

## License

MIT — see `LICENSE`.
