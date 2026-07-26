// Unit tests for the pure timing engine in app.js. No browser involved —
// these run against an isolated vm context with a controllable clock, so
// they're fast and deterministic. This is the most important suite in this
// repo: the engine is the one piece the spec insists on getting exactly
// right (see app.js, "Never decrement a counter on a tick").
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('./lib/engine-harness');

function freshGame(Engine, mode, playerSpecs, incrementMs) {
  const profile = Engine.newProfile();
  profile.mode = mode;
  if (incrementMs != null) profile.incrementMs = incrementMs;
  const players = playerSpecs.map(([name, color, budgetMs]) => Engine.newProfilePlayer(name, color, budgetMs));
  profile.players = players;
  profile.order = players.map((p) => p.id);
  const state = Engine.createGameState(profile);
  return { state, players };
}

test('total mode', async (t) => {
  const { Engine, advance } = loadEngine();
  const { state, players } = freshGame(Engine, 'total', [
    ['Alice', 'red', 300000],
    ['Bob', 'blue', 300000]
  ]);
  const [alice, bob] = players;

  await t.test('initial remaining equals budget', () => {
    assert.equal(Engine.remainingMs(state, alice.id), 300000);
  });

  await t.test('live countdown reflects elapsed time for the current player only', () => {
    advance(30000);
    assert.equal(Engine.remainingMs(state, alice.id), 270000);
    assert.equal(Engine.remainingMs(state, bob.id), 300000, "non-current player's clock must not move");
  });

  await t.test('endTurn commits elapsed time and stats, advances rotation', () => {
    Engine.endTurn(state);
    assert.equal(state.players[alice.id].committedRemainingMs, 270000);
    assert.equal(state.players[alice.id].totalUsedMs, 30000);
    assert.equal(state.players[alice.id].turnsTaken, 1);
    assert.equal(state.players[alice.id].longestTurnMs, 30000);
    assert.equal(state.players[alice.id].overdraftMs, 0);
    assert.equal(Engine.currentPlayerId(state), bob.id);
  });

  await t.test('running past budget produces a negative committed value and records overdraft', () => {
    advance(320000); // Bob had 300000
    assert.equal(Engine.remainingMs(state, bob.id), -20000);
    Engine.endTurn(state);
    assert.equal(state.players[bob.id].committedRemainingMs, -20000);
    assert.equal(state.players[bob.id].overdraftMs, 20000);
    assert.equal(Engine.currentPlayerId(state), alice.id, 'rotation wraps back to Alice');
  });

  await t.test('overdraft accumulates correctly turn over turn, in and out of the red', () => {
    // Alice was at 270000; goes 280000 over -> lands at -10000, overdraft delta 10000.
    advance(280000);
    Engine.endTurn(state);
    assert.equal(state.players[alice.id].committedRemainingMs, -10000);
    assert.equal(state.players[alice.id].overdraftMs, 10000);

    // Bob starts this turn already at -20000 (fully in the red already) —
    // every millisecond of this turn is overdraft.
    advance(5000);
    assert.equal(Engine.remainingMs(state, bob.id), -25000);
    Engine.endTurn(state);
    assert.equal(state.players[bob.id].overdraftMs, 20000 + 5000);
  });
});

test('undo', async (t) => {
  const { Engine, advance } = loadEngine();
  let { state, players } = freshGame(Engine, 'total', [
    ['A', 'red', 600000],
    ['B', 'blue', 600000]
  ]);
  const [a] = players;

  const before = JSON.parse(JSON.stringify(state));
  advance(10000);
  Engine.endTurn(state);
  state = Engine.undo(state);

  await t.test('restores the previous current player', () => {
    assert.equal(Engine.currentPlayerId(state), before.order[before.currentIndex]);
  });
  await t.test('restores the previous committed remaining time', () => {
    assert.equal(state.players[a.id].committedRemainingMs, before.players[a.id].committedRemainingMs);
  });
});

test('pause / resume', async (t) => {
  const { Engine, advance } = loadEngine();
  const { state, players } = freshGame(Engine, 'total', [
    ['Q1', 'red', 600000],
    ['Q2', 'blue', 600000]
  ]);
  const [q1] = players;

  advance(15000);
  const beforePause = Engine.remainingMs(state, q1.id);
  Engine.pauseGame(state);
  advance(999999); // a huge amount of real time passes while paused

  await t.test('remaining time is frozen while paused, no matter how long real time passes', () => {
    assert.equal(Engine.remainingMs(state, q1.id), beforePause);
  });

  Engine.resumeGame(state);
  await t.test('remaining time is unchanged the instant it resumes', () => {
    assert.equal(Engine.remainingMs(state, q1.id), beforePause);
  });

  advance(1000);
  await t.test('countdown continues normally after resume', () => {
    assert.equal(Engine.remainingMs(state, q1.id), beforePause - 1000);
  });
});

test('per_turn mode resets the allowance every turn', async (t) => {
  const { Engine, advance } = loadEngine();
  const { state, players } = freshGame(Engine, 'per_turn', [
    ['T1', 'red', 60000],
    ['T2', 'blue', 90000]
  ]);
  const [t1, t2] = players;

  advance(60000); // T1 uses exactly their allowance
  Engine.endTurn(state);
  await t.test("next player starts fresh at their OWN budget, not the previous player's", () => {
    assert.equal(Engine.remainingMs(state, t2.id), 90000);
  });

  advance(100000); // T2 blows way past their 90s allowance
  Engine.endTurn(state);
  await t.test('allowance resets again on the turn after that', () => {
    assert.equal(Engine.remainingMs(state, t1.id), 60000);
  });
  await t.test('overdraft is still tracked even though the live value resets', () => {
    assert.equal(state.players[t2.id].overdraftMs, 10000); // 100000 - 90000
    assert.equal(state.players[t2.id].committedRemainingMs, 90000 - 100000);
  });
});

test('total_increment mode adds time back after subtracting elapsed', () => {
  const { Engine, advance } = loadEngine();
  const { state, players } = freshGame(Engine, 'total_increment', [
    ['U1', 'red', 60000],
    ['U2', 'blue', 60000]
  ], 5000);
  const [u1] = players;

  advance(10000);
  Engine.endTurn(state);
  assert.equal(state.players[u1.id].committedRemainingMs, 60000 - 10000 + 5000);
});

test('jumpToPlayer', async (t) => {
  const { Engine, advance } = loadEngine();
  const { state, players } = freshGame(Engine, 'total', [
    ['J1', 'red', 100000],
    ['J2', 'blue', 100000],
    ['J3', 'amber', 100000]
  ]);
  const [j1, , j3] = players;

  advance(20000);
  Engine.jumpToPlayer(state, j3.id);

  await t.test('commits elapsed time to the player being jumped away from', () => {
    assert.equal(state.players[j1.id].committedRemainingMs, 80000);
    assert.equal(state.players[j1.id].turnsTaken, 1);
  });
  await t.test('current becomes the jump target directly, skipping the in-between player', () => {
    assert.equal(Engine.currentPlayerId(state), j3.id);
  });
});

test('toggleActive', async (t) => {
  const { Engine, advance } = loadEngine();

  await t.test('blocks deactivating the last active player', () => {
    const { state, players } = freshGame(Engine, 'total', [
      ['K1', 'red', 100000],
      ['K2', 'blue', 100000]
    ]);
    Engine.toggleActive(state, players[1].id);
    assert.equal(state.players[players[1].id].active, false);
    const res = Engine.toggleActive(state, players[0].id);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'last-active');
  });

  await t.test('deactivating the CURRENT player commits their time and auto-advances rotation', () => {
    const { state, players } = freshGame(Engine, 'total', [
      ['M1', 'red', 100000],
      ['M2', 'blue', 100000],
      ['M3', 'amber', 100000]
    ]);
    advance(5000);
    Engine.toggleActive(state, players[0].id);
    assert.equal(state.players[players[0].id].committedRemainingMs, 95000);
    assert.equal(Engine.currentPlayerId(state), players[1].id);

    advance(1000);
    Engine.endTurn(state);
    assert.equal(Engine.currentPlayerId(state), players[2].id, 'rotation must skip the now-inactive M1');
  });
});

test('removePlayer', async (t) => {
  const { Engine, advance } = loadEngine();

  await t.test('marks the player removed and keeps their stats around for the summary', () => {
    const { state, players } = freshGame(Engine, 'total', [
      ['N1', 'red', 100000],
      ['N2', 'blue', 100000]
    ]);
    Engine.removePlayer(state, players[1].id);
    assert.equal(state.players[players[1].id].removed, true);
    assert.equal(typeof state.players[players[1].id].turnsTaken, 'number');
  });

  await t.test('splices out of rotation and fixes currentIndex around every position', () => {
    const { state, players } = freshGame(Engine, 'total', [
      ['X1', 'red', 100000],
      ['X2', 'blue', 100000],
      ['X3', 'amber', 100000],
      ['X4', 'green', 100000]
    ]);
    const [x1, x2, x3, x4] = players;
    Engine.endTurn(state); // current -> X2
    assert.equal(Engine.currentPlayerId(state), x2.id);

    // remove a player BEFORE current — current identity must not change
    Engine.removePlayer(state, x1.id);
    assert.equal(state.order.length, 3);
    assert.equal(Engine.currentPlayerId(state), x2.id);
    assert.equal(state.order.includes(x1.id), false);

    // remove the CURRENT player from the middle of the array
    advance(1000);
    Engine.removePlayer(state, x2.id);
    assert.equal(Engine.currentPlayerId(state), x3.id, 'advances to the next active player');

    // remove a player AFTER current — trivial case
    Engine.removePlayer(state, x4.id);
    assert.equal(Engine.currentPlayerId(state), x3.id);
    assert.equal(state.order.length, 1);

    // removing the sole remaining active player is blocked
    const res = Engine.removePlayer(state, x3.id);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'last-active');
  });

  await t.test('removing the CURRENT player when they are the LAST array element wraps around', () => {
    const { state, players } = freshGame(Engine, 'total', [
      ['Y1', 'red', 100000],
      ['Y2', 'blue', 100000],
      ['Y3', 'amber', 100000]
    ]);
    const [y1, , y3] = players;
    Engine.endTurn(state);
    Engine.endTurn(state); // current -> Y3 (last index)
    assert.equal(Engine.currentPlayerId(state), y3.id);
    Engine.removePlayer(state, y3.id);
    assert.equal(Engine.currentPlayerId(state), y1.id, 'wraps to the front of the shortened order');
  });
});

test('addPlayerMidGame gives the newcomer their own budget and a rotation slot', () => {
  const { Engine } = loadEngine();
  const { state } = freshGame(Engine, 'total', [
    ['O1', 'red', 100000],
    ['O2', 'blue', 100000]
  ]);
  const newId = Engine.addPlayerMidGame(state, 'Newcomer', 'green', 45000);
  assert.notEqual(state.order.indexOf(newId), -1);
  assert.equal(state.players[newId].budgetMs, 45000);
});

test('reorderPlayers preserves current-player identity across a shuffle', () => {
  const { Engine } = loadEngine();
  const { state, players } = freshGame(Engine, 'total', [
    ['W1', 'red', 100000],
    ['W2', 'blue', 100000],
    ['W3', 'amber', 100000]
  ]);
  const [w1, w2, w3] = players;
  Engine.endTurn(state); // current -> W2
  Engine.reorderPlayers(state, [w3.id, w1.id, w2.id]);
  assert.equal(Engine.currentPlayerId(state), w2.id);
});

test('clampBudget enforces the 10s floor from the spec', () => {
  const { Engine } = loadEngine();
  assert.equal(Engine.clampBudget(-500), Engine.MIN_BUDGET_MS);
  assert.equal(Engine.clampBudget(0), Engine.MIN_BUDGET_MS);
  assert.equal(Engine.clampBudget(NaN), Engine.MIN_BUDGET_MS);
  assert.equal(Engine.clampBudget(120000), 120000);
});
