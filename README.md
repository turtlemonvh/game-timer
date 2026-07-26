# Table Timer

A chess-clock-style turn timer for tabletop games. Static site, no backend,
no build step — plain HTML/CSS/JS, meant to run full-screen on a shared
tablet in the middle of the table.

Live at: https://turtlemonvh.github.io/game-timer/

## Modes

- **Total time** — each player gets one budget for the whole game; their
  clock runs only on their turn.
- **Per turn** — everyone gets the same fresh allowance every turn.
- **Total + increment** — like total time, but players gain a fixed amount
  of time back at the end of each turn (Fischer-style).

Running out doesn't stop anything — the clock keeps counting into negative
time and the display flips to a red overdraft state. This is for family
play: the point is gentle visibility, not elimination.

## Using it

- Tap a saved timer on the home screen to start a game.
- On the play screen, **tap anywhere** to end the current turn.
- Tap another player in the strip at the bottom to **jump to them** out of
  turn order (for interrupts, trades, robbers, etc.).
- **Long-press the top-right corner** for the admin screen (add/remove
  players, adjust time, reorder, end the game).
- The small buttons in the bottom corners are **pause** and **undo**.

## Running it locally

No build step needed — just open `index.html` directly in a browser, or
serve the folder with any static file server:

```
python3 -m http.server 8000
```

## Tests

A regression suite lives in `tests/` — engine unit tests plus a Puppeteer
browser suite. See `tests/README.md`. Quick start:

```
cd tests && npm install && npm test
```

## Files

```
index.html                 all screens, toggled by CSS class
styles.css                 design tokens + all styling
app.js                     state, timing engine, persistence, rendering
manifest.webmanifest       installable PWA manifest
sw.js                      cache-first service worker for offline use
icons/                     app icons (192 + 512)
tests/                     engine unit tests + Puppeteer browser regression suite
```

The timing engine (`app.js`, marked `ENGINE:START`/`ENGINE:END`) is pure —
it never decrements a running counter on a tick. Every displayed value is
computed fresh from an absolute timestamp, so the app survives tab
throttling, tablet sleep, and page reloads mid-turn without losing time.

## Data

Everything lives in `localStorage` on the device — there's no server, no
sync, no accounts. Three keys: `gt:profiles`, `gt:activeGame`,
`gt:lastProfileId`.

## Deploying

Pushed to `main`, served by GitHub Pages from the repo root.
