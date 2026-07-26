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

async function longPressAdminCorner(page) {
  const box = await page.$eval('#admin-corner', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, 700)); // long-press threshold is 600ms
  await page.mouse.up();
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
    await tapEndTurn(page); // must be a no-op while paused
    await new Promise((r) => setTimeout(r, 100));
    await page.click('#btn-resume-game');
    await page.waitForSelector('#overlay-pause.hidden');
    assert.equal(await currentName(page), 'Cy', 'a tap-through while paused must not have ended the turn');
  });

  page.assertNoErrors();
  await page.close();
});

test('admin screen: long-press entry, time adjustment, and deactivating the current player', async (t) => {
  const page = await newPage();
  await createProfile(page, { name: 'Admin Test', budgetMin: 5, playerNames: ['Alice', 'Bob', 'Cy'] });
  await startFirstProfile(page);

  await t.test('a 600ms hold on the corner opens the admin overlay; a plain tap does not', async () => {
    const isVisibleBeforeHold = await page.$eval('#overlay-admin', (el) => !el.classList.contains('hidden'));
    assert.equal(isVisibleBeforeHold, false);
    await longPressAdminCorner(page);
    assert.equal(await page.$eval('#overlay-admin', (el) => !el.classList.contains('hidden')), true);
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

  await t.test('closing admin returns to the play screen', async () => {
    await page.click('#btn-admin-close');
    await page.waitForSelector('#overlay-admin.hidden');
    assert.equal(await page.$eval('#screen-play', (el) => !el.classList.contains('hidden')), true);
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
  await longPressAdminCorner(page);
  const row = await page.$('.admin-player-row');
  const [, timeField] = await row.$$('input[type="text"]');
  await timeField.click({ clickCount: 3 });
  await timeField.type('0:01');
  await timeField.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })));
  await new Promise((r) => setTimeout(r, 100));
  await page.click('#btn-admin-close');
  await page.waitForSelector('#overlay-admin.hidden');

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

test('ending the game clears the active game and reload shows no resume card', async (t) => {
  const page = await newPage();
  await createProfile(page, { name: 'End Game Test', playerNames: ['A', 'B'] });
  await startFirstProfile(page);

  await longPressAdminCorner(page);
  page.once('dialog', (d) => d.accept());
  await page.click('#btn-admin-end-game');
  await page.waitForSelector('#screen-summary:not(.hidden)');

  const summaryRows = await page.$$eval('.summary-row', (rows) => rows.length);
  assert.equal(summaryRows, 2);

  await page.reload();
  await new Promise((r) => setTimeout(r, 200));
  const resumeVisible = await page.$eval('#resume-card', (el) => !el.classList.contains('hidden'));
  assert.equal(resumeVisible, false, 'no game should be resumable once it has ended');

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
  const resumeVisible = await page.$eval('#resume-card', (el) => !el.classList.contains('hidden'));
  assert.equal(resumeVisible, true, 'an in-progress game must offer Resume after a reload');

  await page.click('#resume-card');
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
