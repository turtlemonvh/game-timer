# CLAUDE.md

Guidance for working in this repo. Read this before README.md if you're
about to change code — README.md is the user-facing feature doc, this is
the implementation contract.

## What this is

"Game Timer" is a static PWA — zero build step, zero framework, zero CI.
`index.html` + `styles.css` + `app.js` + `manifest.webmanifest` + `sw.js`,
served straight from the repo root by GitHub Pages off `main`. See
`README.md` for what it does and how it's used.

## Hard invariants

These break tests or ship a broken install if violated. In rough order of
how expensive a mistake is:

1. **The `ENGINE:START`/`ENGINE:END` markers are a literal contract.**
   `app.js` has a block delimited by the exact comments `/* ENGINE:START */`
   and `/* ENGINE:END */`. `tests/lib/engine-harness.js` regexes that block
   out of the file text and runs it in a `node:vm` sandbox. Rename, move, or
   split the markers and the entire unit suite breaks immediately.

2. **Engine code may reference only `Date`, `Math`, `crypto`.** The vm
   sandbox provides `console` and a fake, settable `Date` — nothing else. No
   `window`, `document`, or `localStorage` inside the ENGINE block.

3. **Engine state must stay JSON-round-trippable.** It's persisted verbatim
   to `gt:activeGame` and reloaded. New fields need a load-time fallback for
   old saved data — the established pattern, used everywhere already
   (`incrementMs`, `warningMs`, ...), is `saved.field != null ? saved.field
   : default`. Follow it for any new persisted field; there's no schema
   version to migrate against.

4. **Time is never decremented on a tick.** Every displayed value is derived
   fresh from `turnStartedAt` + `committedRemainingMs` + `effectiveNow(state)`
   — never a stored countdown. This is what makes reload-mid-turn and tablet
   sleep survive correctly. A naive `remaining -= delta` would pass a naive
   unit test while silently breaking both.

5. **`app.js` is ES5, non-module, and must run from `file://`.** No
   `const`/`let`/arrow functions/`import`/template literals in it — it's
   plain `var` and function expressions throughout (verified: 277 `var`,
   zero `const`/`let`/arrows). This isn't a style preference: `index.html`
   loads it as a plain `<script src="./app.js">`, not `type="module"`, and
   there's no bundler in the repo, so it has to work opened directly as a
   local file, not just served over HTTP. The test files are normal modern
   Node — different rules apply there.

6. **Bump `CACHE_NAME` in `sw.js` in the same commit as any change to
   `index.html`/`app.js`/`styles.css`/`manifest.webmanifest`/`icons/`.** It's
   the only thing that makes an already-installed PWA pick up the update —
   otherwise the service worker keeps serving the old cached files forever.
   This is the single easiest thing to forget; it has zero visible effect
   until a user's installed app silently fails to update.

## Commands

```
python3 -m http.server 8000     # serve locally; file:// also works but the
                                 # service worker won't register there
```

```
cd tests
npm install && npm test                                  # full suite
PUPPETEER_EXECUTABLE_PATH=/path/to/chrome npm test        # reuse an existing browser
node --test engine.test.js                                # fast, no browser
```

Expected runtimes: the engine suite is near-instant; the full suite
(engine + Puppeteer e2e) takes roughly 45–90 seconds. Don't kill it early
thinking it's hung — see the hang diagnostic under Testing conventions for
what an actual hang looks like.

## If `node` or a Chromium binary isn't on PATH

Some sandboxes have no `node` on PATH and no sudo to install one. Before
assuming you need to install from scratch:
- Look for an already-resolved Node binary from a prior session's scratchpad
  directory.
- Glob for an already-downloaded Puppeteer Chromium:
  `~/.cache/ms-playwright/*/chrome-linux*/chrome` (don't pin a specific
  version directory — it changes between environments).
- Missing shared libs with no sudo may need `LD_LIBRARY_PATH` pointed at an
  extracted set of `.deb` libs.

Once resolved, pass the concrete paths explicitly into any subagent's prompt
— it has no memory of this session and will otherwise re-run the same hunt.

## Code map

`app.js` is organized into banner-commented sections, in this order: ENGINE,
STORAGE, PALETTE, TIME FORMATTING, AUDIO, WAKE LOCK, DRAG REORDER, MISC UI
HELPERS, then APP CONTROLLER — one large IIFE running to end of file that
owns all DOM wiring, event listeners, and render functions. Don't cite line
numbers for any of this when leaving notes for later — they've drifted in
every commit so far; grep the banner comment text instead.

- `index.html` — every screen lives in this one file, toggled via the
  `.hidden` class (not the `hidden` attribute directly — there's a
  documented CSS specificity conflict between `[hidden]` and
  `.field { display: flex }`, already covered by a regression test; use
  `.hidden`).
- Storage keys (`gt:` prefixed, all in `Storage`'s `KEYS` object):
  `gt:profiles` (saved templates), `gt:activeGame` (the one in-progress
  game, if any), `gt:lastProfileId`, `gt:history` (capped at 30, most
  recent first), `gt:seededDefault` (fires the first-launch quick-start
  template exactly once — see the seeding trap below).
- Colors are palette **tokens** (`'red'`, `'stone'`, ...), never raw hex, in
  both `app.js` and storage. Resolve via `colorVar(token)` →
  `var(--c-<token>)`, defined in `styles.css`'s `:root`.
- The play screen is driven by a `requestAnimationFrame` loop (`playTick`,
  started in `enterPlayScreen`, cancelled in `leavePlayScreen`). New
  per-frame visual behavior hooks in there — not a `setInterval`.

## Feature edit order

The sequence that worked across several rounds of live feedback: engine
(pure logic, new state fields) → controller (event listeners, render
functions) → `index.html` (markup/ids) → `styles.css` (classes) → engine
tests → e2e tests → `sw.js` cache bump.

## Testing conventions

Pure math and state transitions go in `engine.test.js`; anything
DOM-visible goes in `e2e.test.js`. Running the engine suite alone is fine
for fast iteration on engine logic, but never consider a UI-visible change
done on engine tests alone — run the combined suite before calling it
finished.

e2e-specific rules:

- **The seeding trap.** `newPage()` in `e2e.test.js` does
  `localStorage.clear()` *and* explicitly sets `gt:seededDefault = '1'`
  before reload, to suppress the first-launch "Quick Chess" template for
  every test. New tests should go through `newPage()`, not
  `browser.newPage()` directly, or they'll nondeterministically see an
  extra template row. The one exception is the dedicated seeding test,
  which intentionally bypasses `newPage()` to test the real first-launch
  path.
- Reuse the existing helpers by name instead of re-deriving flows:
  `newPage`, `createProfile`, `startFirstProfile`, `openAdminViaPause`,
  `tapEndTurn`, `adminRowByName`, `currentName`, `computedColorVarRgb`. When
  a new assertion pattern gets used a third time, factor it into a shared
  helper the way `computedColorVarRgb` already does.
- Assert colors against resolved palette variables
  (`computedColorVarRgb(page, cssProp, token)`), never hardcoded hex —
  matches the token-not-hex rule above.
- The e2e static server serves the repo root directly, not a fixture copy —
  a broken `index.html` fails every e2e test at once, not just the one you'd
  expect.
- `--no-sandbox` in the Puppeteer launch args is intentional (standard for
  running Chromium without a real sandbox in a constrained/root
  environment) — not something to "fix."
- **Hang diagnostic.** A test that runs to the full timeout almost always
  means a tap landed on a control whose handler calls a native, unhandled
  `confirm()`, which freezes the renderer and hangs Puppeteer's CDP call.
  Diagnose with a standalone `page.evaluate(() =>
  document.elementFromPoint(x, y))` repro to see what's actually at that
  coordinate — don't guess and retry blindly.

## Visual verification

For anything about color, layout, or animation, a CSS/DOM diff is not
sufficient evidence that it looks right. Write a small throwaway Puppeteer
screenshot script into the scratchpad directory, take the screenshot, Read
the actual PNG, then delete the script. This is what catches things a
markup review misses — e.g. confirming a color actually reads as a visible
ring around an element, or that a pulse animation actually fires and is
visible mid-transition, not just that the CSS rule exists.

## Deploy

Push to `main` **is** the production deploy — there's no CI, no
`.github/` directory at all. Treat this checklist as the CI:

1. Full test suite green.
2. `CACHE_NAME` bumped in `sw.js` if any cached file changed.
3. Push.
4. Poll `gh api repos/:owner/:repo/pages/builds/latest` until `status:
   "built"` (there's a several-second lag after push before the build even
   starts).
5. `curl` a changed file on the live site and confirm the new value is
   actually there (e.g. the live `CACHE_NAME`, or a changed manifest field)
   — don't assume push + green build means the content is live.

Approval to push does not carry forward to the next round of changes — each
push needs its own explicit ask in that message, even later in the same
session.

## Asking vs. deciding

Ask before implementing when a fork is hard to reverse and would reshape
the interaction model — e.g. "should a new alert system replace the old one
or run alongside it," "should this state silence or stack with that one,"
"is this setting per-game or per-player." Getting one of these wrong means
redoing a chunk of the feature, not tweaking a value. Don't ask about copy
wording, exact pixel sizes, or other easily-reversible details — just make
a reasonable call.

## Delegating to subagents

Decision rule: delegate when the task has an acceptance check a fresh
process can run entirely on its own — an exit code, a file that exists or
doesn't, an HTTP response — and needs nothing from this conversation beyond
what fits in the prompt. Do it inline when success is judged by "is this
what was actually asked for."

Good candidates, each with the constraint that makes it actually work:

- **Run the full test suite and report back.** Give it the resolved
  node/Chromium paths (see above) so it doesn't re-hunt. Require it to
  return failing test names and raw assertion output verbatim — never a
  summary. A summarized failure is worse than no delegation, because you
  end up re-running it yourself to see what actually broke.
- **Write one engine test against an already-decided spec.** State the
  exact Engine function, inputs, and expected output; it should touch
  `tests/engine.test.js` only.
- **Write one e2e test against an already-decided spec.** Same, plus: point
  it at the Testing conventions section above by name, and require it reuse
  the existing helpers rather than inventing its own page setup.
- **Regenerate README screenshots.** Throwaway Puppeteer script → PNG →
  report the file path. It should not judge whether the result looks
  right — that visual check stays with the primary session (see Visual
  verification above).
- **Verify a deploy.** Poll the Pages build API until it completes, then
  curl-check the live file. Long-latency polling, zero design context,
  binary answer.

Do it inline, not as a subagent:

- **Any full feature round.** It fans out across the engine, controller,
  markup, CSS, and `sw.js`, and the two easiest misses — the ES5 constraint
  and the cache-name bump — are exactly the kind of thing a subagent
  without the full picture has no reason to check.
- **Deciding what to build**, or anything that traces back to something the
  user said earlier in the conversation.
- **Locating code.** `grep -n` on this file is cheaper than a subagent
  round-trip.
- **Judging anything visual.** Delegate producing the screenshot; never
  delegate evaluating it.

## Docs to keep in sync

Update `README.md` (feature descriptions, including the storage-keys list)
and `tests/README.md` alongside behavior changes.
