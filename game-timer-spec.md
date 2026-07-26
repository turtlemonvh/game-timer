# Family Game Timer — Build Spec

A chess-clock-style turn timer for multiplayer board games. Static site, no backend, no build step. Runs from GitHub Pages on a shared tablet in the middle of the table.

---

## 1. Constraints

- **Single shared device.** One tablet, one browser, one source of truth. No sync, no server, no accounts.
- **Static only.** Plain HTML/CSS/JS. No framework, no bundler, no npm install. Must run correctly when opened directly from `file://` as well as from GitHub Pages.
- **Offline.** Works with no network after first load.
- **Persistence:** `localStorage` only.
- **Touch-first**, but must be usable on a phone screen too.

---

## 2. Time modes

All three are supported; mode is chosen per profile.

| Mode | Behavior |
|---|---|
| `total` | Each player gets one budget for the whole game. Their clock runs only on their turn. |
| `per_turn` | Each player gets a fixed allowance that resets at the start of every turn. |
| `total_increment` | Like `total`, but a fixed increment is added to the player's remaining time when they end a turn (Fischer). |

**Running out does not stop anything.** When remaining time crosses zero, the clock keeps counting into the negative and the display flips to a red overdraft state showing `-M:SS`. Turn order continues unchanged. In `per_turn` mode the overdraft resets along with the allowance at the next turn, but total overdraft accumulates in the player's stats.

Rationale: this is for family play. The point is visibility and gentle pressure, not elimination.

---

## 3. Data model

Three localStorage keys, all JSON:

```
gt:profiles       -> { [profileId]: Profile }
gt:activeGame     -> GameState | null
gt:lastProfileId  -> string | null
```

```js
Profile = {
  id: string,            // crypto.randomUUID()
  name: string,          // "Sunday Catan", "Kids + Grandpa"
  createdAt: number,
  lastPlayedAt: number | null,
  mode: 'total' | 'per_turn' | 'total_increment',
  incrementMs: number,   // used by total_increment
  players: [
    {
      id: string,
      name: string,
      color: string,     // token key, not raw hex
      budgetMs: number   // per-player; may differ (handicaps for younger kids)
    }
  ],
  order: string[]        // player ids, defines turn order
}

GameState = {
  profileId: string,
  profileName: string,
  mode, incrementMs,
  players: {
    [id]: {
      id, name, color,
      budgetMs: number,
      committedRemainingMs: number,  // authoritative; only changes on turn end / admin edit
      turnsTaken: number,
      totalUsedMs: number,
      longestTurnMs: number,
      active: boolean                // false = sat out, skipped in rotation
    }
  },
  order: string[],
  currentIndex: number,
  turnStartedAt: number | null,      // epoch ms; null when paused or not started
  pausedAt: number | null,
  startedAt: number,
  undoStack: GameState[]             // capped at 20, excludes its own undoStack
}
```

Profiles and the active game are separate. Editing a profile mid-game must not alter the running game, and vice versa — the admin screen writes to `GameState`, with an explicit **Save back to profile** action.

---

## 4. Timing engine (get this right first)

**Never decrement a counter on a tick.** Ticks are for rendering only.

```js
// display value, computed fresh every frame
function remainingMs(state, playerId) {
  const p = state.players[playerId];
  const isCurrent = state.order[state.currentIndex] === playerId;
  if (!isCurrent || state.turnStartedAt === null) return p.committedRemainingMs;
  return p.committedRemainingMs - (Date.now() - state.turnStartedAt);
}

function endTurn(state) {
  const id = state.order[state.currentIndex];
  const elapsed = Date.now() - state.turnStartedAt;
  const p = state.players[id];
  p.committedRemainingMs -= elapsed;
  p.totalUsedMs += elapsed;
  p.longestTurnMs = Math.max(p.longestTurnMs, elapsed);
  p.turnsTaken += 1;
  if (state.mode === 'total_increment') p.committedRemainingMs += state.incrementMs;
  advanceToNextActivePlayer(state);
  if (state.mode === 'per_turn') {
    state.players[currentId(state)].committedRemainingMs =
      state.players[currentId(state)].budgetMs;
  }
  state.turnStartedAt = Date.now();
  persist(state);
}
```

Why it matters: `setInterval` is throttled in background tabs and stops entirely when a tablet sleeps. A decrementing counter silently loses time; a timestamp difference doesn't.

- Render loop: `requestAnimationFrame`, but only repaint the digits when the displayed second changes.
- Under 20 seconds remaining, show tenths.
- **Persist on every state transition** (turn end, pause, admin edit) — not on the tick. A reload mid-game must resume exactly where it left off, including the in-flight turn, since `turnStartedAt` is an absolute timestamp.
- On load, if `gt:activeGame` exists, offer **Resume** as the first thing on screen.

---

## 5. Screens

### 5.1 Home
- If a game is in progress: a **Resume** card at top showing profile name, current player, and elapsed game time.
- List of saved profiles, most recently played first. Each row: name, player count, mode, per-player budget, last played date.
- Tap a profile → confirm sheet showing the roster → **Start game**.
- **New profile** button.
- Long-press or edit icon on a row → Setup screen for that profile.
- Empty state: a single **Create your first timer** invitation, no chrome.

### 5.2 Setup / edit profile
- Profile name.
- Mode picker (three options, with a one-line plain-English explanation under each).
- Default budget, applied to all players, plus per-player override so a younger kid can get more time.
- Increment field, shown only in `total_increment` mode.
- Player list: add, rename, remove, drag to reorder, pick color.
- **Randomize order** button (useful for deciding who goes first).
- Save / Save as new / Delete profile (delete requires confirm).

### 5.3 Play — the main screen
This is the one that has to work at arm's length across a table.

- The **entire screen is the end-turn target**, except the small admin affordance.
- Dominant element: current player's name and remaining time, very large.
- Secondary: time taken *this turn*, counting up.
- A compact strip of all other players showing name + remaining, in turn order, with the next player marked. Tapping a player in the strip **jumps to them** out of order — Catan's robber, trades, and interrupts break strict rotation constantly, so this is a primary feature, not an escape hatch.
- Overdraft: the whole current-player panel goes to the alert state, digits show a leading minus.
- Pause button (visible, but small enough not to be hit by accident) — pauses all clocks, dims the screen, requires a deliberate tap to resume.
- Undo (single tap, reverts the last turn end and restores the previous player's clock).
- Admin entry: **long-press the top-right corner for 600ms.** Not a tap. Nothing on this screen should be one accidental touch away from changing the game.

**Alerts:** optional per profile — a soft tone at 60s remaining, another at 10s, and a distinct one at zero. Also `navigator.vibrate` on turn change if supported. Default alerts on, sound toggle accessible from the pause overlay.

**Wake lock:** request `navigator.wakeLock.screen` on game start; re-request on `visibilitychange` (the lock is dropped when the tab is backgrounded). Fall back gracefully — if unavailable, show a one-time hint to disable auto-lock in device settings.

### 5.4 Admin
Reached by long-press. Opaque overlay, clearly a different mode.

- Per-player rows with: **+1m / +5m / −1m / −5m** buttons and a direct-entry field for remaining time.
- Rename in place.
- Drag to reorder the remaining rotation.
- Add a player mid-game (with a starting budget) — for when someone joins late.
- Toggle a player inactive (skipped in rotation, clock frozen, stats retained).
- Set current player.
- **Save changes back to profile** — explicit, so a one-off adjustment doesn't permanently alter the saved roster.
- **End game** → Summary.
- **Close** returns to Play, unpaused as it was.

### 5.5 Summary
Shown on end game. Per player: total time used, turns taken, average turn, longest turn, overdraft if any. A **Play again with these settings** button and a **Back to home** button. Clears `gt:activeGame` on exit.

---

## 6. Edge cases to handle explicitly

- Reload / crash mid-turn → resume with correct elapsed time.
- Tablet sleeps for an hour mid-turn → time is correctly counted (this is a feature, not a bug; the admin screen exists to correct it).
- Someone forgets to end their turn and the next player starts playing → undo, or jump-to-player, or admin adjustment. Make at least one of these reachable in two taps.
- Last active player toggled inactive → block it, require at least one active player.
- Player removed mid-game → their stats stay in the summary, marked as withdrawn.
- Double-tap on the play surface → debounce 250ms so a fumbled tap doesn't burn two turns.
- All-zero or negative budgets in setup → clamp to a minimum of 10 seconds.

---

## 7. Visual direction

The subject is a wooden-component tabletop game viewed from three feet away in a lit room. That means: enormous type, real color separation between players, and almost no decorative chrome. Everything on screen should be readable by someone who isn't wearing their glasses.

**Palette** — ground it in felt and wooden game pieces rather than a generic dark UI:

```
--felt-deep:    #16241E   /* background, a green-black like a game mat */
--felt-raised:  #1F332B   /* panels, player strip */
--bone:         #F2EDE2   /* primary type */
--muted:        #8FA69A   /* labels, secondary */
--overdraft:    #C6483C   /* negative-time alert state */
```

Player colors drawn from classic wooden meeple stock, chosen for separation at distance and distinguishable for the common color-vision deficiencies:

```
#D9534F red · #3D7EA6 blue · #E8B33C amber · #6B8F3F green
#8E6BAF purple · #E07A3F orange · #4FA5A0 teal · #B5B5AD stone
```

Never identify a player by color alone — always pair with the name.

**Type:** the countdown digits are the one place to spend character. Use a tabular-numeral face with real weight — a condensed grotesque set very large and tight reads like a scoreboard, which is exactly right. Body and labels in a plain system stack. Critically: `font-variant-numeric: tabular-nums` everywhere digits appear, or the layout will jitter every second.

**Signature element:** the player strip along the bottom as a row of budget bars that visibly drain — each player's remaining time as a proportion of their starting budget, so the whole table's state is legible in one glance without reading any numbers. When a bar hits zero it inverts and grows in the overdraft color.

**Motion:** almost none. A 150ms crossfade on turn change so it's clear something happened, and nothing else. Respect `prefers-reduced-motion`.

---

## 8. Files

```
index.html                 # all screens, toggled by class
styles.css                 # tokens at :root
app.js                     # state, timing engine, persistence, render
manifest.webmanifest       # installable, display: fullscreen, landscape
sw.js                      # cache-first for the four static files
icons/                     # 192 + 512
README.md
```

- Use relative paths throughout so the site works from a GitHub Pages project subpath (`/user/repo/`) without a base tag.
- Service worker scope will be the repo subpath — register with `./sw.js`.
- Deploy: GitHub Pages from `main` branch root.
- Version the cache name in `sw.js` so updates actually land.

---

## 9. Build order

1. Timing engine + state module, with the mode logic and persistence. Verify against manual clock math before touching UI.
2. Play screen against a hardcoded 4-player game.
3. Persistence + resume.
4. Home / profiles CRUD.
5. Admin screen.
6. Summary.
7. Wake lock, sounds, haptics, PWA manifest and service worker.
8. Styling pass.

Steps 1–3 are the whole product. Everything after is convenience.
