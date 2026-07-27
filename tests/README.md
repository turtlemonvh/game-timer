# Game Timer test suite

Two independent suites, both run by Node's built-in test runner (no test
framework dependency beyond Puppeteer for the browser suite):

- `engine.test.js` — pure unit tests for the timing engine in `app.js`
  (between the `ENGINE:START`/`ENGINE:END` markers). Runs in an isolated
  `vm` context with a controllable clock, no browser involved. This is the
  suite that matters most: it locks down the turn-order, overdraft, pause,
  undo, and per-player increment math.
- `e2e.test.js` — Puppeteer browser tests covering DOM wiring: tap-to-end-turn
  and its debounce, jump-to-player, the admin overlay (reachable only from
  the pause menu — time edits, deactivating the current player), overdraft
  styling, the home screen's in-progress/history/template rows, the
  overwrite-warning dialog when starting a game over another, and — the one
  that matters most for a shared-tablet app — that a reload mid-turn resumes
  with the correct elapsed time instead of losing or resetting it.

## Running

```
cd tests
npm install
npm test
```

`npm install` downloads Puppeteer's own bundled Chromium on a normal
machine — nothing else is required. If you already have a Chrome/Chromium
binary you'd rather use (e.g. in a sandboxed CI image where downloading a
browser isn't practical), point `PUPPETEER_EXECUTABLE_PATH` at it:

```
PUPPETEER_EXECUTABLE_PATH=/path/to/chrome npm test
```

To run just the fast unit suite (no browser needed):

```
node --test engine.test.js
```
