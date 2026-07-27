// Browser regression suite driven with Puppeteer. Covers the interaction
// paths that can't be verified by the pure engine unit tests: DOM wiring,
// tap targets, the 250ms end-turn debounce, admin overlay, overdraft
// styling, and persistence across a real page reload.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const puppeteer = require('puppeteer');
const { startServer } = require('./lib/static-server');

let server, baseUrl, browser;

before(async () => {
  server = await startServer(path.join(__dirname, '..'));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    // --no-sandbox is standard for running Chromium as root / in constrained
    // CI containers; the browser instance here is disposable and untrusted
    // content is never loaded.
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
});

after(async () => {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
});

async function newPage() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 600 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.assertNoErrors = () => assert.deepEqual(errors, [], `unexpected console/page errors: ${JSON.stringify(errors)}`);
  await page.goto(baseUrl + '/index.html');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  return page;
}

async function playSurfaceCenterBottom(page) {
  return page.$eval('#play-surface', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height - 40 };
  });
}

async function tapEndTurn(page) {
  const { x, y } = await playSurfaceCenterBottom(page);
  await page.mouse.click(x, y);
}

async function openAdminViaPause(page) {
  await page.click('#btn-pause');
  await page.waitForSelector('#overlay-pause:not(.hidden)');
  await page.click('#btn-open-admin');
  await page.waitForSelector('#overlay-admin:not(.hidden)', { timeout: 2000 });
}

async function currentName(page) {
  return page.$eval('#current-name', (el) => el.textContent);
}

async function adminRowByName(page, name) {
  const rows = await page.$$('.admin-player-row');
  for (const row of rows) {
    const val = await row.$eval('input[type="text"]', (el) => el.value);
    if (val === name) return row;
  }
  return null;
}

async function createProfile(page, { name, budgetMin = 10, budgetSec = 0, playerNames = ['Player 1', 'Player 2'] }) {
  await page.click('#btn-create-first, #btn-new-profile');
  await page.waitForSelector('#screen-setup:not(.hidden)');
  await page.type('#input-profile-name', name);
  await page.$eval('#input-default-min', (el, v) => { el.value = v; }, String(budgetMin));
  await page.$eval('#input-default-sec', (el, v) => { el.value = v; }, String(budgetSec));
  await page.click('#btn-apply-default-budget');

  // adjust player count to match playerNames.length
  let inputs = await page.$$('#player-setup-list input[type="text"]');
  while (inputs.length < playerNames.length) {
    await page.click('#btn-add-player');
    inputs = await page.$$('#player-setup-list input[type="text"]');
  }
  inputs = await page.$$('#player-setup-list input[type="text"]');
  for (let i = 0; i < playerNames.length; i++) {
    await inputs[i].click({ clickCount: 3 });
    await inputs[i].type(playerNames[i]);
  }
  await page.click('#btn-setup-save');
  await page.waitForSelector('#screen-home:not(.hidden)');
}

async function startFirstProfile(page) {
  await page.click('.profile-row-main');
  await page.waitForSelector('#sheet-confirm-start:not(.hidden)');
  await page.click('#btn-confirm-start');
  await page.waitForSelector('#screen-play:not(.hidden)');
}

// ---------------------------------------------------------------------

test('setup screen: mode radio toggles the increment field (regression for [hidden] vs .field{display:flex} CSS conflict)', async (t) => {
  const page = await newPage();
  await page.click('#btn-create-first');
  await page.waitForSelector('#screen-setup:not(.hidden)');

  await page.click('input[name="mode"][value="total_increment"]');
  const visibleWhenIncrement = await page.$eval('#increment-field-group', (el) => el.offsetParent !== null);
  assert.equal(visibleWhenIncrement, true, 'increment field must be visible in total_increment mode');

  await page.click('input[name="mode"][value="total"]');
  const visibleWhenTotal = await page.$eval('#increment-field-group', (el) => el.offsetParent !== null);
  assert.equal(visibleWhenTotal, false, 'increment field must be hidden again once mode leaves total_increment');

  page.assertNoErrors();
  await page.close();
});

test('setup screen: editing an existing profile pre-fills the form and does not create a duplicate', async (t) => {
  const page = await newPage();
  await createProfile(page, { name: 'Edit Me', playerNames: ['Solo'] });

  await page.click('.profile-row-edit');
  await page.waitForSelector('#screen-setup:not(.hidden)');
  assert.equal(await page.$eval('#setup-title', (el) => el.textContent), 'Edit timer');
  assert.equal(await page.$eval('#input-profile-name', (el) => el.value), 'Edit Me');

  await page.click('#btn-setup-cancel');
  await page.waitForSelector('#screen-home:not(.hidden)');
  const rowCount = await page.$$eval('.profile-row', (rows) => rows.length);
  assert.equal(rowCount, 1, 'cancelling an edit must not duplicate the profile');

  page.assertNoErrors();
  await page.close();
});

test('play screen: full turn-order flow (tap to end turn, debounce, jump, undo, pause/resume)', async (t) => {
  const page = await newPage();
  await createProfile(page, { name: 'Sunday Catan', budgetMin: 5, playerNames: ['Alice', 'Bob', 'Cy'] });
  await startFirstProfile(page);

  await t.test('the first player in rotation order starts as current', async () => {
    assert.equal(await currentName(page), 'Alice');
  });

  await t.test('tapping the play surface ends the current turn and advances rotation', async () => {
    await tapEndTurn(page);
    await new Promise((r) => setTimeout(r, 400)); // clear the 250ms tap debounce before the next subtest taps again
    assert.equal(await currentName(page), 'Bob');
  });

  await t.test('two taps fired back-to-back: only the first counts, the second is debounced', async () => {
    await tapEndTurn(page); // Bob -> Cy, legitimate
    await tapEndTurn(page); // fired immediately after — must be swallowed
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await currentName(page), 'Cy', 'exactly one turn should have advanced, not two');
  });

  await t.test('tapping a player in the strip jumps to them out of order', async () => {
    await new Promise((r) => setTimeout(r, 300)); // clear the debounce window
    const items = await page.$$('.strip-item');
    let aliceItem = null;
    for (const item of items) {
      const text = await item.evaluate((el) => el.textContent);
      if (text.includes('Alice')) aliceItem = item;
    }
    assert.ok(aliceItem, 'expected an Alice row in the player strip');
    await aliceItem.click();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await currentName(page), 'Alice');
  });

  await t.test('undo reverts the jump and restores the previous current player', async () => {
    await page.click('#btn-undo');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await currentName(page), 'Cy');
  });

  await t.test('pause dims the screen and blocks end-turn taps until resumed', async () => {
    await page.click('#btn-pause');
    await page.waitForSelector('#overlay-pause:not(.hidden)');
    // Click a corner outside the centered pause card (not tapEndTurn's usual
    // bottom-center point) — the pause overlay now stacks four buttons, and
    // clicking straight into one (e.g. Leave game) would pop a real confirm()
    // dialog and hang the test, rather than exercising the "taps are a no-op
    // while paused" behavior this subtest is actually about.
    await page.mouse.click(10, 10);
    await new Promise((r) => setTimeout(r, 100));
    await page.click('#btn-resume-game');
    await page.waitForSelector('#overlay-pause.hidden');
    assert.equal(await currentName(page), 'Cy', 'a tap-through while paused must not have ended the turn');
  });

  page.assertNoErrors();
  await page.close();
});

test('admin screen: entry via pause overlay, time adjustment, and deactivating the current player', async (t) => {
  const page = await newPage();
  await createProfile(page, { name: 'Admin Test', budgetMin: 5, playerNames: ['Alice', 'Bob', 'Cy'] });
  await startFirstProfile(page);

  await t.test('the Admin button on the pause overlay opens the admin overlay', async () => {
    const isVisibleBeforeHold = await page.$eval('#overlay-admin', (el) => !el.classList.contains('hidden'));
    assert.equal(isVisibleBeforeHold, false);
    await openAdminViaPause(page);
    assert.equal(await page.$eval('#overlay-admin', (el) => !el.classList.contains('hidden')), true);
    assert.equal(await page.$eval('#overlay-pause', (el) => el.classList.contains('hidden')), true,
      'the pause overlay should step aside while admin is open');
  });

  await t.test('Sound alerts now lives inside Admin, not on the pause overlay; Close and End game are two separate buttons', async () => {
    const closeInHeader = await page.$('.admin-header #btn-admin-close');
    assert.equal(closeInHeader, null, 'the redundant top-right Close button should be gone');
    const soundInAdmin = await page.$('#overlay-admin #chk-sound');
    assert.ok(soundInAdmin, 'sound alerts toggle should now be inside the admin overlay');
    const soundInPause = await page.$('#overlay-pause #chk-sound');
    assert.equal(soundInPause, null, 'sound alerts toggle should no longer be on the pause overlay');
    const rowButtons = await page.$$eval('.admin-actions-row .btn', (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(rowButtons, ['Close', 'End game']);
  });

  await t.test('the +5m button adds five minutes to that player\'s remaining time', async () => {
    const aliceRow = await adminRowByName(page, 'Alice');
    assert.ok(aliceRow);
    const before = await aliceRow.$eval('.admin-row-time input[type="text"]', (el) => el.value);
    const plus5 = await aliceRow.$$('button');
    let clicked = false;
    for (const btn of plus5) {
      const text = await btn.evaluate((el) => el.textContent.trim());
      if (text === '+5m') { await btn.click(); clicked = true; break; }
    }
    assert.ok(clicked, 'expected a +5m button in the row');
    await new Promise((r) => setTimeout(r, 100));
    const after = await (await adminRowByName(page, 'Alice')).$eval('.admin-row-time input[type="text"]', (el) => el.value);
    assert.notEqual(before, after);
  });

  await t.test('deactivating the CURRENT player auto-advances rotation while admin is still open', async () => {
    const before = await currentName(page);
    const currentRow = await adminRowByName(page, before);
    const checkbox = await currentRow.$('input[type="checkbox"]');
    await checkbox.click();
    await new Promise((r) => setTimeout(r, 100));
    assert.notEqual(await currentName(page), before, 'current player must change once deactivated');
  });

  await t.test('closing admin returns to the (still paused) pause overlay, not straight back into play', async () => {
    await page.click('#btn-admin-close');
    await page.waitForSelector('#overlay-admin.hidden');
    assert.equal(await page.$eval('#screen-play', (el) => !el.classList.contains('hidden')), true);
    assert.equal(await page.$eval('#overlay-pause', (el) => !el.classList.contains('hidden')), true,
      'closing admin must surface the pause overlay again, making it explicit the game is still paused');
    await page.click('#btn-resume-game');
    await page.waitForSelector('#overlay-pause.hidden');
  });

  page.assertNoErrors();
  await page.close();
});

test('overdraft: crossing zero flips the play screen into the alert state', async (t) => {
  const page = await newPage();
  await createProfile(page, { name: 'Overdraft Test', playerNames: ['Solo', 'Second'] });
  await startFirstProfile(page);

  // Setup clamps budgets to a 10s floor; admin direct-entry is intentionally
  // NOT clamped, so use it to force overdraft almost immediately.
  await openAdminViaPause(page);
  const row = await page.$('.admin-player-row');
  const [, timeField] = await row.$$('input[type="text"]');
  await timeField.click({ clickCount: 3 });
  await timeField.type('0:01');
  await timeField.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })));
  await new Promise((r) => setTimeout(r, 100));
  await page.click('#btn-admin-close');
  await page.waitForSelector('#overlay-admin.hidden');
  await page.click('#btn-resume-game'); // admin now always returns to the paused overlay; resume explicitly
  await page.waitForSelector('#overlay-pause.hidden');

  await new Promise((r) => setTimeout(r, 2500));

  const hasOverdraftClass = await page.$eval('#screen-play', (el) => el.classList.contains('overdraft'));
  const remainingText = await page.$eval('#current-remaining', (el) => el.textContent);
  const stripHasOverdraft = await page.$('.strip-item.is-overdraft') !== null;

  assert.equal(hasOverdraftClass, true, '#screen-play should carry the overdraft class once remaining < 0');
  assert.ok(remainingText.startsWith('−'), `remaining display should show a leading minus, got "${remainingText}"`);
  assert.equal(stripHasOverdraft, true, 'the player strip should also flag the overdrawn player');

  page.assertNoErrors();
  await page.close();
});

test('ending the game clears the active/resumable game (it becomes a history row instead, see the dedicated history test)', async (t) => {
  const page = await newPage();
  await createProfile(page, { name: 'End Game Test', playerNames: ['A', 'B'] });
  await startFirstProfile(page);

  await openAdminViaPause(page);
  page.once('dialog', (d) => d.accept());
  await page.click('#btn-admin-end-game');
  await page.waitForSelector('#screen-summary:not(.hidden)');

  const summaryRows = await page.$$eval('.summary-row', (rows) => rows.length);
  assert.equal(summaryRows, 2);

  await page.reload();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await page.$('.profile-row-active'), null, 'no game should be resumable once it has ended');

  page.assertNoErrors();
  await page.close();
});

test('reload mid-turn resumes with the correct elapsed time (not reset, not lost)', async (t) => {
  const page = await newPage();
  await createProfile(page, { name: 'Resume Test', playerNames: ['A', 'B'] });
  await startFirstProfile(page);

  await new Promise((r) => setTimeout(r, 2000)); // let ~2s of real turn time pass
  const remainingBeforeReload = await page.$eval('#current-remaining', (el) => el.textContent);

  await page.reload();
  await new Promise((r) => setTimeout(r, 200));
  const activeRow = await page.$('.profile-row-active');
  assert.ok(activeRow, 'an in-progress game must offer Resume after a reload');

  await page.click('.profile-row-active .profile-row-main');
  await page.waitForSelector('#screen-play:not(.hidden)');
  const remainingAfterResume = await page.$eval('#current-remaining', (el) => el.textContent);

  function toSeconds(s) {
    const neg = s.startsWith('−');
    const [m, sec] = s.replace('−', '').split(':');
    return (Number(m) * 60 + Number(sec)) * (neg ? -1 : 1);
  }
  const before = toSeconds(remainingBeforeReload);
  const after = toSeconds(remainingAfterResume);
  assert.ok(before - after < 5, `resumed remaining time (${after}) should be close to pre-reload value (${before}), not reset`);
  assert.ok(after < 598, 'remaining should not have snapped back to the full budget');

  page.assertNoErrors();
  await page.close();
});

function toSeconds(s) {
  const neg = s.startsWith('−');
  const [m, sec] = s.replace('−', '').split(':');
  return (Number(m) * 60 + Number(sec)) * (neg ? -1 : 1);
}

test('setup screen: per-player increment overrides apply independently in total_increment mode', async (t) => {
  const page = await newPage();
  await page.click('#btn-create-first');
  await page.waitForSelector('#screen-setup:not(.hidden)');
  await page.type('#input-profile-name', 'Increment Test');
  await page.click('input[name="mode"][value="total_increment"]');
  await page.waitForSelector('#increment-field-group:not([hidden])');

  await page.$eval('#input-default-min', (el) => { el.value = '1'; });
  await page.$eval('#input-default-sec', (el) => { el.value = '0'; });
  await page.click('#btn-apply-default-budget');

  const nameInputs = await page.$$('#player-setup-list input[type="text"]');
  await nameInputs[0].click({ clickCount: 3 });
  await nameInputs[0].type('Slow');
  await nameInputs[1].click({ clickCount: 3 });
  await nameInputs[1].type('Fast');

  const rows = await page.$$('#player-setup-list .player-setup-row');
  assert.equal(rows.length, 2);
  async function setIncrementSeconds(row, sec) {
    const [minIn, secIn] = await row.$$('.player-setup-row-increment input[type="number"]');
    await secIn.click({ clickCount: 3 });
    await secIn.type(String(sec));
    await secIn.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })));
  }
  await setIncrementSeconds(rows[0], 5);
  await setIncrementSeconds(rows[1], 20);

  await page.click('#btn-setup-save');
  await page.waitForSelector('#screen-home:not(.hidden)');
  await startFirstProfile(page);

  assert.equal(await currentName(page), 'Slow');
  await tapEndTurn(page); // Slow -> Fast, Slow gains its own +5s
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await currentName(page), 'Fast');

  await openAdminViaPause(page);
  const slowRemaining = toSeconds(await (await adminRowByName(page, 'Slow')).$eval('.admin-row-time input[type="text"]', (el) => el.value));
  await page.click('#btn-admin-close');
  await page.click('#btn-resume-game');
  await page.waitForSelector('#overlay-pause.hidden');

  await tapEndTurn(page); // Fast -> Slow, Fast gains its own +20s
  await new Promise((r) => setTimeout(r, 300));

  await openAdminViaPause(page);
  const fastRemaining = toSeconds(await (await adminRowByName(page, 'Fast')).$eval('.admin-row-time input[type="text"]', (el) => el.value));

  // Both started at 60s; Slow ended its turn almost instantly (+5s increment,
  // ~0s elapsed), Fast likewise (+20s increment). The ~15s gap between them
  // can only come from their own per-player increments, not a shared value.
  assert.ok(slowRemaining >= 63 && slowRemaining <= 65, `Slow's own +5s increment should apply, got ${slowRemaining}`);
  assert.ok(fastRemaining >= 78 && fastRemaining <= 80, `Fast's own +20s increment should apply, got ${fastRemaining}`);

  page.assertNoErrors();
  await page.close();
});

test('home screen: an in-progress game appears once under Recent games, its template stays under Game templates, and it can be deleted', async (t) => {
  const page = await newPage();
  await createProfile(page, { name: 'Quick Chess', playerNames: ['White', 'Black'] });
  await startFirstProfile(page);

  // Leave the game (paused, resumable) by going through the pause overlay.
  await page.click('#btn-pause');
  await page.waitForSelector('#overlay-pause:not(.hidden)');
  page.once('dialog', (d) => d.accept());
  await page.click('#btn-leave-game');
  await page.waitForSelector('#screen-home:not(.hidden)');

  await t.test('the template still appears under Game templates after being played', async () => {
    const templateNames = await page.$$eval('#profile-list-templates .profile-row-name', (els) => els.map((e) => e.textContent));
    assert.deepEqual(templateNames, ['Quick Chess']);
  });

  await t.test('the in-progress game appears exactly once, under Recent games', async () => {
    const recentRows = await page.$$('#profile-list-recent .profile-row-active');
    assert.equal(recentRows.length, 1);
    const badge = await page.$eval('.profile-row-active .profile-row-badge', (el) => el.textContent);
    assert.equal(badge, 'Game in progress');
  });

  await t.test('deleting the in-progress game removes it and hides the Recent games heading', async () => {
    page.once('dialog', (d) => d.accept());
    await page.click('.profile-row-active .profile-row-delete');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await page.$('.profile-row-active'), null);
    assert.equal(await page.$eval('#heading-recent', (el) => el.classList.contains('hidden')), true);
    // the template must survive deleting the in-progress game
    const templateNames = await page.$$eval('#profile-list-templates .profile-row-name', (els) => els.map((e) => e.textContent));
    assert.deepEqual(templateNames, ['Quick Chess']);
  });

  page.assertNoErrors();
  await page.close();
});

test('pause overlay: the Resume button itself now works (previously only the rest of the bar did), and End game is reachable without going through Admin', async (t) => {
  const page = await newPage();
  await createProfile(page, { name: 'Pause Buttons Test', playerNames: ['A', 'B'] });
  await startFirstProfile(page);

  await t.test('clicking the Resume button (not just the rest of the pause overlay) resumes the game', async () => {
    await page.click('#btn-pause');
    await page.waitForSelector('#overlay-pause:not(.hidden)');
    const resumeLabel = await page.$eval('#btn-resume-game', (el) => el.textContent.trim());
    assert.equal(resumeLabel, 'Resume', 'the button should just say "Resume", not "Tap to resume"');
    await page.click('#btn-resume-game');
    await page.waitForSelector('#overlay-pause.hidden');
    assert.equal(await page.$eval('#screen-play', (el) => !el.classList.contains('hidden')), true);
  });

  await t.test('the pause-overlay buttons render at the same width', async () => {
    await page.click('#btn-pause');
    await page.waitForSelector('#overlay-pause:not(.hidden)');
    const widths = await page.$$eval('.pause-content .btn', (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    assert.equal(widths.length, 4, 'expected Resume, Admin, End game, Leave game');
    assert.ok(widths.every((w) => w === widths[0]), `expected equal widths, got ${widths}`);
  });

  await t.test('End game is directly on the pause overlay and ends the game', async () => {
    page.once('dialog', (d) => d.accept());
    await page.click('#btn-pause-end-game');
    await page.waitForSelector('#screen-summary:not(.hidden)');
    const summaryRows = await page.$$eval('.summary-row', (rows) => rows.length);
    assert.equal(summaryRows, 2);
  });

  page.assertNoErrors();
  await page.close();
});

test('confirm-start sheet: game naming defaults to "<template>: <date>", and starting over an in-progress game requires an explicit OK', async (t) => {
  const page = await newPage();
  await createProfile(page, { name: 'Quick Chess', playerNames: ['White', 'Black'] });

  await t.test('the game name field defaults to "<template name>: <date>" and is editable', async () => {
    await page.click('.profile-row-main');
    await page.waitForSelector('#sheet-confirm-start:not(.hidden)');
    const defaultName = await page.$eval('#input-game-name', (el) => el.value);
    assert.ok(defaultName.startsWith('Quick Chess: '), `expected a "Quick Chess: <date>" default, got "${defaultName}"`);
    await page.$eval('#input-game-name', (el) => { el.value = ''; });
    await page.type('#input-game-name', 'My Custom Game');
    await page.click('#btn-confirm-start');
    await page.waitForSelector('#screen-play:not(.hidden)');
  });

  await t.test('the custom name is used as the game\'s display name', async () => {
    await page.click('#btn-pause');
    await page.waitForSelector('#overlay-pause:not(.hidden)');
    page.once('dialog', (d) => d.accept());
    await page.click('#btn-leave-game');
    await page.waitForSelector('#screen-home:not(.hidden)');
    const activeName = await page.$eval('.profile-row-active .profile-row-name', (el) => el.textContent);
    assert.equal(activeName, 'My Custom Game');
  });

  await t.test('starting the same template again warns that it will replace the in-progress game', async () => {
    await page.click('#profile-list-templates .profile-row-main');
    await page.waitForSelector('#sheet-confirm-start:not(.hidden)');

    let dialogMessage = null;
    page.once('dialog', (d) => { dialogMessage = d.message(); d.dismiss(); });
    await page.click('#btn-confirm-start');
    await new Promise((r) => setTimeout(r, 100));
    assert.match(dialogMessage || '', /replace your current in-progress game/i);
    // dismissing must leave the original in-progress game untouched
    assert.equal(await page.$eval('#sheet-confirm-start', (el) => !el.classList.contains('hidden')), true,
      'cancelling the warning should leave the confirm sheet open, not start the game');
    await page.click('#btn-confirm-cancel');
    await page.waitForSelector('#sheet-confirm-start.hidden');
    const activeNameAfterCancel = await page.$eval('.profile-row-active .profile-row-name', (el) => el.textContent);
    assert.equal(activeNameAfterCancel, 'My Custom Game', 'the original in-progress game must survive a cancelled overwrite');

    await page.click('#profile-list-templates .profile-row-main');
    await page.waitForSelector('#sheet-confirm-start:not(.hidden)');
    page.once('dialog', (d) => d.accept());
    await page.click('#btn-confirm-start');
    await page.waitForSelector('#screen-play:not(.hidden)');
  });

  page.assertNoErrors();
  await page.close();
});

test('ending a game adds it to game history on the home screen, viewable and persisted across a reload', async (t) => {
  const page = await newPage();
  await createProfile(page, { name: 'History Test', playerNames: ['A', 'B'] });
  await startFirstProfile(page);

  await openAdminViaPause(page);
  page.once('dialog', (d) => d.accept());
  await page.click('#btn-admin-end-game');
  await page.waitForSelector('#screen-summary:not(.hidden)');
  await page.click('#btn-summary-home');
  await page.waitForSelector('#screen-home:not(.hidden)');

  await t.test('the finished game appears under Recent games (no active game, so no in-progress row)', async () => {
    assert.equal(await page.$('.profile-row-active'), null);
    const recentHidden = await page.$eval('#heading-recent', (el) => el.classList.contains('hidden'));
    assert.equal(recentHidden, false);
    const rows = await page.$$('#profile-list-recent .profile-row');
    assert.equal(rows.length, 1);
  });

  await t.test('clicking the history row re-opens the summary with the same stats', async () => {
    await page.click('#profile-list-recent .profile-row-main');
    await page.waitForSelector('#screen-summary:not(.hidden)');
    const summaryRows = await page.$$eval('.summary-row', (rows) => rows.length);
    assert.equal(summaryRows, 2);
    await page.click('#btn-summary-home');
    await page.waitForSelector('#screen-home:not(.hidden)');
  });

  await t.test('the history entry survives a page reload', async () => {
    await page.reload();
    await new Promise((r) => setTimeout(r, 200));
    const rows = await page.$$('#profile-list-recent .profile-row');
    assert.equal(rows.length, 1);
  });

  page.assertNoErrors();
  await page.close();
});
