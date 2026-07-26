'use strict';

/* =========================================================================
   ENGINE — pure state functions. No DOM, no globals besides Date/Math/crypto.
   Mutates the state object it's given and also returns it, for convenience.
   ========================================================================= */
/* ENGINE:START */
var Engine = (function () {
  var MIN_BUDGET_MS = 10000;
  var UNDO_CAP = 20;

  function uid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function clampBudget(ms) {
    var n = Math.round(Number(ms));
    if (!isFinite(n) || n < MIN_BUDGET_MS) return MIN_BUDGET_MS;
    return n;
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  // ---- Profile -----------------------------------------------------------

  function newProfile() {
    var now = Date.now();
    return {
      id: uid(),
      name: '',
      createdAt: now,
      lastPlayedAt: null,
      mode: 'total',
      incrementMs: 30000,
      alertsEnabled: true,
      players: [],
      order: []
    };
  }

  function newProfilePlayer(name, color, budgetMs) {
    return { id: uid(), name: name || 'Player', color: color || 'red', budgetMs: clampBudget(budgetMs) };
  }

  // ---- GameState -----------------------------------------------------------

  function createGameState(profile) {
    var players = {};
    profile.order.forEach(function (id) {
      var src = profile.players.filter(function (p) { return p.id === id; })[0];
      if (!src) return;
      players[id] = {
        id: src.id,
        name: src.name,
        color: src.color,
        budgetMs: clampBudget(src.budgetMs),
        committedRemainingMs: clampBudget(src.budgetMs),
        turnsTaken: 0,
        totalUsedMs: 0,
        longestTurnMs: 0,
        overdraftMs: 0,
        active: true,
        removed: false
      };
    });
    var now = Date.now();
    return {
      profileId: profile.id,
      profileName: profile.name,
      mode: profile.mode,
      incrementMs: profile.incrementMs || 0,
      alertsEnabled: profile.alertsEnabled !== false,
      players: players,
      order: profile.order.slice(),
      currentIndex: 0,
      turnStartedAt: now,
      pausedAt: null,
      startedAt: now,
      undoStack: []
    };
  }

  // "now" respects an active pause so live values freeze while paused.
  function effectiveNow(state) {
    return state.pausedAt != null ? state.pausedAt : Date.now();
  }

  function currentPlayerId(state) {
    return state.order[state.currentIndex];
  }

  // Display value, computed fresh — never stored, never decremented on tick.
  function remainingMs(state, playerId) {
    var p = state.players[playerId];
    if (!p) return 0;
    var isCurrent = currentPlayerId(state) === playerId;
    if (!isCurrent || state.turnStartedAt === null) return p.committedRemainingMs;
    return p.committedRemainingMs - (effectiveNow(state) - state.turnStartedAt);
  }

  function turnElapsedMs(state) {
    if (state.turnStartedAt === null) return 0;
    return effectiveNow(state) - state.turnStartedAt;
  }

  function isPaused(state) {
    return state.pausedAt != null;
  }

  function isActivePlayer(state, playerId) {
    var p = state.players[playerId];
    return !!p && p.active && !p.removed;
  }

  function nextActiveIndex(state, fromIndex) {
    var n = state.order.length;
    for (var step = 1; step <= n; step++) {
      var idx = (fromIndex + step) % n;
      if (isActivePlayer(state, state.order[idx])) return idx;
    }
    return fromIndex;
  }

  function countActive(state) {
    return state.order.reduce(function (n, id) {
      return n + (isActivePlayer(state, id) ? 1 : 0);
    }, 0);
  }

  // Commits the CURRENT player's elapsed time into committedRemainingMs and
  // stats. Used by endTurn / jumpToPlayer / toggleActive(deactivating current).
  // Does not touch currentIndex or turnStartedAt.
  function commitCurrentPlayerTurn(state) {
    if (state.turnStartedAt === null) return;
    var id = currentPlayerId(state);
    var p = state.players[id];
    if (!p) return;
    var elapsed = effectiveNow(state) - state.turnStartedAt;
    var prevRemaining = p.committedRemainingMs;
    p.committedRemainingMs = prevRemaining - elapsed;
    p.totalUsedMs += elapsed;
    p.longestTurnMs = Math.max(p.longestTurnMs, elapsed);
    p.turnsTaken += 1;
    var overdraftDelta = Math.max(0, elapsed - Math.max(0, prevRemaining));
    p.overdraftMs += overdraftDelta;
    if (state.mode === 'total_increment') p.committedRemainingMs += state.incrementMs;
  }

  function resetAllowanceIfPerTurn(state, playerId) {
    if (state.mode !== 'per_turn') return;
    var p = state.players[playerId];
    if (p) p.committedRemainingMs = p.budgetMs;
  }

  function snapshot(state) {
    var copy = JSON.parse(JSON.stringify(state));
    delete copy.undoStack;
    return copy;
  }

  function pushUndo(state) {
    state.undoStack.push(snapshot(state));
    if (state.undoStack.length > UNDO_CAP) state.undoStack.shift();
  }

  function endTurn(state) {
    pushUndo(state);
    commitCurrentPlayerTurn(state);
    state.currentIndex = nextActiveIndex(state, state.currentIndex);
    resetAllowanceIfPerTurn(state, currentPlayerId(state));
    state.turnStartedAt = effectiveNow(state);
    return state;
  }

  function jumpToPlayer(state, targetId) {
    var idx = state.order.indexOf(targetId);
    if (idx === -1 || idx === state.currentIndex) return state;
    if (!isActivePlayer(state, targetId)) return state;
    pushUndo(state);
    commitCurrentPlayerTurn(state);
    state.currentIndex = idx;
    resetAllowanceIfPerTurn(state, targetId);
    state.turnStartedAt = effectiveNow(state);
    return state;
  }

  // Admin correction: like jumpToPlayer, but not part of the single-tap undo
  // stack (admin has its own explicit controls to fix mistakes).
  function adminSetCurrentPlayer(state, targetId) {
    var idx = state.order.indexOf(targetId);
    if (idx === -1 || idx === state.currentIndex) return state;
    commitCurrentPlayerTurn(state);
    state.currentIndex = idx;
    resetAllowanceIfPerTurn(state, targetId);
    state.turnStartedAt = effectiveNow(state);
    return state;
  }

  function undo(state) {
    if (!state.undoStack.length) return state;
    var stack = state.undoStack;
    var prev = stack[stack.length - 1];
    prev.undoStack = stack.slice(0, -1);
    return prev;
  }

  function pauseGame(state) {
    if (state.pausedAt != null) return state;
    state.pausedAt = Date.now();
    return state;
  }

  function resumeGame(state) {
    if (state.pausedAt == null) return state;
    if (state.turnStartedAt != null) {
      state.turnStartedAt += Date.now() - state.pausedAt;
    }
    state.pausedAt = null;
    return state;
  }

  function adjustRemaining(state, playerId, deltaMs) {
    var p = state.players[playerId];
    if (!p) return state;
    p.committedRemainingMs += deltaMs;
    return state;
  }

  function setRemaining(state, playerId, ms) {
    var p = state.players[playerId];
    if (!p) return state;
    p.committedRemainingMs = ms;
    return state;
  }

  function renamePlayer(state, playerId, name) {
    var p = state.players[playerId];
    if (p) p.name = name;
    return state;
  }

  function reorderPlayers(state, newOrder) {
    var currentId = currentPlayerId(state);
    state.order = newOrder.slice();
    var idx = state.order.indexOf(currentId);
    state.currentIndex = idx === -1 ? 0 : idx;
    return state;
  }

  function toggleActive(state, playerId) {
    var p = state.players[playerId];
    if (!p || p.removed) return { ok: false, reason: 'not-found' };
    if (p.active) {
      var others = state.order.some(function (id) {
        return id !== playerId && isActivePlayer(state, id);
      });
      if (!others) return { ok: false, reason: 'last-active' };
      p.active = false;
      if (currentPlayerId(state) === playerId) {
        commitCurrentPlayerTurn(state);
        state.currentIndex = nextActiveIndex(state, state.currentIndex);
        resetAllowanceIfPerTurn(state, currentPlayerId(state));
        state.turnStartedAt = effectiveNow(state);
      }
    } else {
      p.active = true;
    }
    return { ok: true };
  }

  // Removed players keep their stats (state.players[id]) but are spliced out
  // of the rotation entirely — unlike an inactive player, they never come back.
  function removePlayer(state, playerId) {
    var p = state.players[playerId];
    if (!p || p.removed) return { ok: false, reason: 'not-found' };
    var idx = state.order.indexOf(playerId);
    if (idx === -1) return { ok: false, reason: 'not-found' };
    var others = state.order.some(function (id) {
      return id !== playerId && isActivePlayer(state, id);
    });
    if (p.active && !others) return { ok: false, reason: 'last-active' };
    var wasCurrent = idx === state.currentIndex;
    if (wasCurrent) commitCurrentPlayerTurn(state);
    p.removed = true;
    p.active = false;
    state.order.splice(idx, 1);
    if (state.order.length === 0) {
      state.currentIndex = 0;
      return { ok: true };
    }
    if (idx < state.currentIndex) {
      state.currentIndex -= 1;
    } else if (wasCurrent) {
      var n = state.order.length;
      var searchFrom = ((idx - 1) % n + n) % n;
      state.currentIndex = nextActiveIndex(state, searchFrom);
      resetAllowanceIfPerTurn(state, currentPlayerId(state));
      state.turnStartedAt = effectiveNow(state);
    }
    return { ok: true };
  }

  function addPlayerMidGame(state, name, color, budgetMs) {
    var id = uid();
    var ms = clampBudget(budgetMs);
    state.players[id] = {
      id: id, name: name || 'Player', color: color || 'stone',
      budgetMs: ms, committedRemainingMs: ms,
      turnsTaken: 0, totalUsedMs: 0, longestTurnMs: 0, overdraftMs: 0,
      active: true, removed: false
    };
    var insertAt = state.currentIndex + 1;
    state.order.splice(insertAt, 0, id);
    if (insertAt <= state.currentIndex) state.currentIndex += 1;
    return id;
  }

  function saveGameToProfile(state, profile) {
    var players = state.order
      .filter(function (id) { return !state.players[id].removed; })
      .map(function (id) {
        var p = state.players[id];
        return { id: p.id, name: p.name, color: p.color, budgetMs: p.budgetMs };
      });
    profile.players = players;
    profile.order = players.map(function (p) { return p.id; });
    return profile;
  }

  return {
    MIN_BUDGET_MS: MIN_BUDGET_MS,
    uid: uid,
    clampBudget: clampBudget,
    shuffle: shuffle,
    newProfile: newProfile,
    newProfilePlayer: newProfilePlayer,
    createGameState: createGameState,
    remainingMs: remainingMs,
    turnElapsedMs: turnElapsedMs,
    isPaused: isPaused,
    isActivePlayer: isActivePlayer,
    currentPlayerId: currentPlayerId,
    countActive: countActive,
    endTurn: endTurn,
    jumpToPlayer: jumpToPlayer,
    adminSetCurrentPlayer: adminSetCurrentPlayer,
    undo: undo,
    pauseGame: pauseGame,
    resumeGame: resumeGame,
    adjustRemaining: adjustRemaining,
    setRemaining: setRemaining,
    renamePlayer: renamePlayer,
    reorderPlayers: reorderPlayers,
    toggleActive: toggleActive,
    removePlayer: removePlayer,
    addPlayerMidGame: addPlayerMidGame,
    saveGameToProfile: saveGameToProfile
  };
})();
/* ENGINE:END */

/* =========================================================================
   STORAGE — localStorage read/write, JSON in/out.
   ========================================================================= */
var Storage = (function () {
  var KEYS = { profiles: 'gt:profiles', activeGame: 'gt:activeGame', lastProfileId: 'gt:lastProfileId' };

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* storage unavailable/full — ignore */ }
  }
  function safeRemove(key) {
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  function loadProfiles() {
    var raw = safeGet(KEYS.profiles);
    if (!raw) return {};
    try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
  }
  function saveProfiles(profiles) { safeSet(KEYS.profiles, JSON.stringify(profiles)); }
  function saveProfile(profile) {
    var all = loadProfiles();
    all[profile.id] = profile;
    saveProfiles(all);
  }
  function deleteProfile(id) {
    var all = loadProfiles();
    delete all[id];
    saveProfiles(all);
  }
  function loadActiveGame() {
    var raw = safeGet(KEYS.activeGame);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  function saveActiveGame(state) { safeSet(KEYS.activeGame, JSON.stringify(state)); }
  function clearActiveGame() { safeRemove(KEYS.activeGame); }
  function getLastProfileId() { return safeGet(KEYS.lastProfileId); }
  function setLastProfileId(id) { safeSet(KEYS.lastProfileId, id); }

  return {
    loadProfiles: loadProfiles, saveProfiles: saveProfiles, saveProfile: saveProfile,
    deleteProfile: deleteProfile, loadActiveGame: loadActiveGame, saveActiveGame: saveActiveGame,
    clearActiveGame: clearActiveGame, getLastProfileId: getLastProfileId, setLastProfileId: setLastProfileId
  };
})();

/* =========================================================================
   PALETTE — player color tokens, matched to CSS custom properties.
   ========================================================================= */
var PALETTE = ['red', 'blue', 'amber', 'green', 'purple', 'orange', 'teal', 'stone', 'white', 'black'];

function colorVar(token) { return 'var(--c-' + (token || 'stone') + ')'; }

var MODE_LABEL = { total: 'Total time', per_turn: 'Per turn', total_increment: 'Total + increment' };

/* =========================================================================
   TIME FORMATTING
   ========================================================================= */
function formatClock(ms, showTenths) {
  var neg = ms < 0;
  var abs = Math.abs(ms);
  var m = Math.floor(abs / 60000);
  var s = Math.floor((abs % 60000) / 1000);
  var str = m + ':' + (s < 10 ? '0' : '') + s;
  if (showTenths) {
    var t = Math.floor((abs % 1000) / 100);
    str += '.' + t;
  }
  return (neg ? '−' : '') + str;
}
function formatClockPlain(ms) {
  // mm:ss for admin direct-entry fields; always non-negative display base, sign handled separately.
  return formatClock(ms, false);
}
function formatMinSec(min, sec) { return (min * 60 + sec) * 1000; }
function parseClockToMs(str) {
  str = String(str).trim();
  var neg = str.charAt(0) === '-' || str.charAt(0) === '−';
  if (neg) str = str.slice(1);
  var parts = str.split(':');
  var m = 0, s = 0;
  if (parts.length === 2) { m = parseInt(parts[0], 10) || 0; s = parseInt(parts[1], 10) || 0; }
  else { s = parseInt(parts[0], 10) || 0; }
  var ms = (m * 60 + s) * 1000;
  return neg ? -ms : ms;
}
function formatDuration(ms) {
  var abs = Math.round(Math.abs(ms) / 1000);
  var m = Math.floor(abs / 60), s = abs % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}
function formatDateShort(ts) {
  if (!ts) return 'never played';
  var d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* =========================================================================
   AUDIO — synthesized alert tones, no bundled assets. Created lazily on the
   first user gesture (Start game / Resume), per browser autoplay rules.
   ========================================================================= */
var AudioFx = (function () {
  var ctx = null;

  function ensureCtx() {
    if (ctx) return ctx;
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    return ctx;
  }

  function tone(freq, startAt, durationS, gainPeak, type) {
    if (!ctx) return;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(gainPeak, startAt + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationS);
    osc.connect(gain).connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + durationS + 0.02);
  }

  function unlock() {
    var c = ensureCtx();
    if (c && c.state === 'suspended') c.resume();
  }

  // gentle two-note chime
  function play60s() {
    var c = ensureCtx(); if (!c) return;
    var t = c.currentTime;
    tone(880, t, 0.16, 0.12);
    tone(660, t + 0.13, 0.2, 0.12);
  }
  // three quick ticks — more urgent
  function play10s() {
    var c = ensureCtx(); if (!c) return;
    var t = c.currentTime;
    tone(720, t, 0.09, 0.16, 'triangle');
    tone(720, t + 0.16, 0.09, 0.16, 'triangle');
    tone(720, t + 0.32, 0.09, 0.16, 'triangle');
  }
  // distinct low descending buzz at zero
  function playZero() {
    var c = ensureCtx(); if (!c) return;
    var t = c.currentTime;
    var osc = c.createOscillator();
    var gain = c.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(300, t);
    osc.frequency.exponentialRampToValueAtTime(120, t + 0.45);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.14, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.52);
  }

  function playThreshold(th) {
    if (th === 60000) play60s();
    else if (th === 10000) play10s();
    else if (th === 0) playZero();
  }

  return { unlock: unlock, playThreshold: playThreshold };
})();

/* =========================================================================
   WAKE LOCK
   ========================================================================= */
var WakeLockCtl = (function () {
  var sentinel = null;
  var wanted = false;
  var hintShown = false;

  function request() {
    wanted = true;
    if (!('wakeLock' in navigator)) {
      if (!hintShown) {
        hintShown = true;
        toast('Tip: disable auto-lock in device settings for uninterrupted play.');
      }
      return;
    }
    navigator.wakeLock.request('screen').then(function (s) {
      sentinel = s;
    }).catch(function () { /* ignore — will retry on visibilitychange */ });
  }
  function release() {
    wanted = false;
    if (sentinel) { sentinel.release().catch(function () {}); sentinel = null; }
  }
  document.addEventListener('visibilitychange', function () {
    if (wanted && document.visibilityState === 'visible') request();
  });

  return { request: request, release: release };
})();

/* =========================================================================
   DRAG REORDER — generic pointer-based list reordering, touch + mouse.
   Rows must have a `.drag-handle` child and a `data-id` attribute on the row.
   ========================================================================= */
function enableDragReorder(listEl, onReorder) {
  var dragging = null;
  var startY = 0;
  var rowHeight = 0;

  listEl.addEventListener('pointerdown', function (e) {
    var handle = e.target.closest('.drag-handle');
    if (!handle) return;
    var row = handle.closest('[data-id]');
    if (!row) return;
    dragging = row;
    startY = e.clientY;
    rowHeight = row.offsetHeight;
    row.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
  });

  listEl.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    var dy = e.clientY - startY;
    if (Math.abs(dy) < rowHeight / 2) return;
    var sibling = dy > 0 ? dragging.nextElementSibling : dragging.previousElementSibling;
    if (!sibling) return;
    if (dy > 0) listEl.insertBefore(sibling, dragging);
    else listEl.insertBefore(dragging, sibling);
    startY = e.clientY;
  });

  function finish() {
    if (!dragging) return;
    dragging.classList.remove('dragging');
    dragging = null;
    var ids = Array.prototype.map.call(listEl.querySelectorAll('[data-id]'), function (el) {
      return el.getAttribute('data-id');
    });
    onReorder(ids);
  }
  listEl.addEventListener('pointerup', finish);
  listEl.addEventListener('pointercancel', finish);
}

/* =========================================================================
   MISC UI HELPERS
   ========================================================================= */
var toastTimer = null;
function toast(msg) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 2200);
}

function debounce250() {
  var last = 0;
  return function () {
    var now = Date.now();
    if (now - last < 250) return false;
    last = now;
    return true;
  };
}

/* =========================================================================
   APP CONTROLLER
   ========================================================================= */
(function () {
  var currentGame = null;   // active GameState, or null
  var soundOn = true;
  var rafId = null;
  var stripEls = {};
  var prevDisplay = { current: null, elapsed: null };
  var alertFired = { key: null, thresholds: {} };
  var canEndTurn = debounce250();

  var setupState = null;
  var editingProfileId = null;
  var colorPickerTargetId = null;
  var pendingStartProfileId = null;
  var preAdminWasPaused = false;

  var longPressTimer = null;
  var longPressStartXY = null;

  // ---- screen switching -------------------------------------------------

  function showScreenRaw(name) {
    document.querySelectorAll('.screen').forEach(function (s) {
      s.classList.toggle('hidden', s.getAttribute('data-screen') !== name);
    });
    hideAllOverlaysAndSheets();
    if (name !== 'play') leavePlayScreen();
  }
  function hideAllOverlaysAndSheets() {
    document.getElementById('sheet-confirm-start').classList.add('hidden');
    document.getElementById('popover-color').classList.add('hidden');
    document.getElementById('overlay-pause').classList.add('hidden');
    document.getElementById('overlay-admin').classList.add('hidden');
  }

  function persist() {
    if (currentGame) Storage.saveActiveGame(currentGame);
  }

  // ---- HOME ---------------------------------------------------------------

  function buildProfileRow(profile) {
    var li = document.createElement('li');
    li.className = 'profile-row';

    var main = document.createElement('button');
    main.type = 'button';
    main.className = 'profile-row-main';
    var name = document.createElement('p');
    name.className = 'profile-row-name';
    name.textContent = profile.name || 'Untitled timer';
    var meta = document.createElement('p');
    meta.className = 'profile-row-meta';
    var firstBudget = profile.players[0] ? formatDuration(profile.players[0].budgetMs) : '';
    meta.textContent = profile.players.length + ' players · ' + (MODE_LABEL[profile.mode] || profile.mode) +
      ' · ' + firstBudget + ' · ' + formatDateShort(profile.lastPlayedAt);
    main.appendChild(name);
    main.appendChild(meta);
    main.addEventListener('click', function () { openConfirmStart(profile.id); });

    var editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'profile-row-edit';
    editBtn.setAttribute('aria-label', 'Edit ' + (profile.name || 'timer'));
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', function (e) { e.stopPropagation(); openSetupEdit(profile.id); });

    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'profile-row-delete';
    deleteBtn.setAttribute('aria-label', 'Delete ' + (profile.name || 'timer'));
    deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path d="M5 7h14M10 7V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2m-7 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13" ' +
      'stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    deleteBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!confirm('Delete "' + (profile.name || 'Untitled timer') + '"? This cannot be undone.')) return;
      Storage.deleteProfile(profile.id);
      renderHome();
    });

    li.appendChild(main);
    li.appendChild(editBtn);
    li.appendChild(deleteBtn);
    return li;
  }

  function renderHome() {
    var profiles = Storage.loadProfiles();
    var all = Object.keys(profiles).map(function (id) { return profiles[id]; });
    var recent = all.filter(function (p) { return !!p.lastPlayedAt; })
      .sort(function (a, b) { return b.lastPlayedAt - a.lastPlayedAt; });
    var templates = all.filter(function (p) { return !p.lastPlayedAt; })
      .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });

    var recentEl = document.getElementById('profile-list-recent');
    var templatesEl = document.getElementById('profile-list-templates');
    recentEl.innerHTML = '';
    templatesEl.innerHTML = '';
    recent.forEach(function (profile) { recentEl.appendChild(buildProfileRow(profile)); });
    templates.forEach(function (profile) { templatesEl.appendChild(buildProfileRow(profile)); });

    document.getElementById('heading-recent').classList.toggle('hidden', recent.length === 0);
    recentEl.classList.toggle('hidden', recent.length === 0);
    document.getElementById('heading-templates').classList.toggle('hidden', templates.length === 0);
    templatesEl.classList.toggle('hidden', templates.length === 0);

    document.getElementById('empty-state').classList.toggle('hidden', all.length > 0);

    var activeGame = Storage.loadActiveGame();
    var resumeCard = document.getElementById('resume-card');
    if (activeGame) {
      resumeCard.classList.remove('hidden');
      document.getElementById('resume-profile-name').textContent = activeGame.profileName;
      var curId = Engine.currentPlayerId(activeGame);
      var curName = (activeGame.players[curId] && activeGame.players[curId].name) || '';
      document.getElementById('resume-detail').textContent =
        curName + '’s turn · started ' + formatDateShort(activeGame.startedAt);
    } else {
      resumeCard.classList.add('hidden');
    }
  }

  document.getElementById('resume-card').addEventListener('click', function () {
    var activeGame = Storage.loadActiveGame();
    if (!activeGame) return;
    currentGame = activeGame;
    soundOn = currentGame.alertsEnabled !== false;
    AudioFx.unlock();
    showScreenRaw('play');
    enterPlayScreen();
  });
  document.getElementById('btn-new-profile').addEventListener('click', openSetupNew);
  document.getElementById('btn-create-first').addEventListener('click', openSetupNew);

  // ---- CONFIRM START SHEET -------------------------------------------------

  function openConfirmStart(profileId) {
    var profiles = Storage.loadProfiles();
    var profile = profiles[profileId];
    if (!profile) return;
    pendingStartProfileId = profileId;
    document.getElementById('confirm-profile-name').textContent = profile.name || 'Untitled timer';
    document.getElementById('confirm-meta').textContent = (MODE_LABEL[profile.mode] || profile.mode) +
      (profile.mode === 'total_increment' ? ' · +' + formatDuration(profile.incrementMs) + ' per turn' : '');
    var rosterEl = document.getElementById('confirm-roster');
    rosterEl.innerHTML = '';
    profile.order.forEach(function (id) {
      var p = profile.players.filter(function (pl) { return pl.id === id; })[0];
      if (!p) return;
      var li = document.createElement('li');
      li.className = 'roster-row';
      var dot = document.createElement('span');
      dot.className = 'color-dot';
      dot.style.background = colorVar(p.color);
      li.appendChild(dot);
      li.appendChild(document.createTextNode(p.name + ' — ' + formatDuration(p.budgetMs)));
      rosterEl.appendChild(li);
    });
    document.getElementById('sheet-confirm-start').classList.remove('hidden');
  }
  function closeConfirmStart() { document.getElementById('sheet-confirm-start').classList.add('hidden'); }

  document.getElementById('btn-confirm-cancel').addEventListener('click', closeConfirmStart);
  document.querySelector('[data-close="confirm-start"]').addEventListener('click', closeConfirmStart);
  document.getElementById('btn-confirm-start').addEventListener('click', function () {
    var profiles = Storage.loadProfiles();
    var profile = profiles[pendingStartProfileId];
    if (!profile) return;
    currentGame = Engine.createGameState(profile);
    soundOn = currentGame.alertsEnabled;
    profile.lastPlayedAt = Date.now();
    Storage.saveProfile(profile);
    Storage.setLastProfileId(profile.id);
    Storage.saveActiveGame(currentGame);
    AudioFx.unlock();
    closeConfirmStart();
    showScreenRaw('play');
    enterPlayScreen();
  });

  // ---- SETUP ---------------------------------------------------------------

  function makeDefaultSetup() {
    var defMs = formatMinSec(10, 0);
    return {
      id: null,
      name: '',
      mode: 'total',
      incrementMs: 30000,
      alertsEnabled: true,
      defaultMs: defMs,
      players: [
        { id: Engine.uid(), name: 'Player 1', color: 'red', budgetMs: defMs },
        { id: Engine.uid(), name: 'Player 2', color: 'blue', budgetMs: defMs }
      ]
    };
  }

  function openSetupNew() {
    editingProfileId = null;
    setupState = makeDefaultSetup();
    document.getElementById('setup-title').textContent = 'New timer';
    document.getElementById('setup-existing-actions').hidden = true;
    fillSetupForm();
    showScreenRaw('setup');
  }

  function openSetupEdit(profileId) {
    var profiles = Storage.loadProfiles();
    var profile = profiles[profileId];
    if (!profile) return;
    editingProfileId = profileId;
    setupState = {
      id: profile.id,
      name: profile.name,
      mode: profile.mode,
      incrementMs: profile.incrementMs || 30000,
      alertsEnabled: profile.alertsEnabled !== false,
      defaultMs: (profile.players[0] && profile.players[0].budgetMs) || formatMinSec(10, 0),
      players: profile.order.map(function (id) {
        var p = profile.players.filter(function (pl) { return pl.id === id; })[0];
        return { id: p.id, name: p.name, color: p.color, budgetMs: p.budgetMs };
      })
    };
    document.getElementById('setup-title').textContent = 'Edit timer';
    document.getElementById('setup-existing-actions').hidden = false;
    fillSetupForm();
    showScreenRaw('setup');
  }

  function fillSetupForm() {
    document.getElementById('input-profile-name').value = setupState.name;
    Array.prototype.forEach.call(document.querySelectorAll('input[name="mode"]'), function (r) {
      r.checked = r.value === setupState.mode;
    });
    document.getElementById('increment-field-group').hidden = setupState.mode !== 'total_increment';
    document.getElementById('input-increment-min').value = Math.floor(setupState.incrementMs / 60000);
    document.getElementById('input-increment-sec').value = Math.floor((setupState.incrementMs % 60000) / 1000);
    document.getElementById('input-default-min').value = Math.floor(setupState.defaultMs / 60000);
    document.getElementById('input-default-sec').value = Math.floor((setupState.defaultMs % 60000) / 1000);
    document.getElementById('chk-alerts-enabled').checked = setupState.alertsEnabled;
    renderSetupPlayerList();
  }

  function renderSetupPlayerList() {
    var listEl = document.getElementById('player-setup-list');
    listEl.innerHTML = '';
    setupState.players.forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'player-setup-row';
      li.setAttribute('data-id', p.id);

      var handle = document.createElement('span');
      handle.className = 'drag-handle';
      handle.textContent = '⠿';

      var colorBtn = document.createElement('button');
      colorBtn.type = 'button';
      colorBtn.className = 'color-swatch-btn';
      colorBtn.style.background = colorVar(p.color);
      colorBtn.style.width = '32px';
      colorBtn.style.height = '32px';
      colorBtn.setAttribute('aria-label', 'Choose color for ' + p.name);
      colorBtn.addEventListener('click', function () { openColorPicker(p.id); });

      var nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = p.name;
      nameInput.maxLength = 40;
      nameInput.addEventListener('input', function () { p.name = nameInput.value; });

      var timeWrap = document.createElement('div');
      timeWrap.className = 'time-input';
      var minIn = document.createElement('input');
      minIn.type = 'number'; minIn.min = 0; minIn.max = 180; minIn.inputMode = 'numeric';
      minIn.value = Math.floor(p.budgetMs / 60000);
      var mLbl = document.createElement('span'); mLbl.textContent = 'm';
      var secIn = document.createElement('input');
      secIn.type = 'number'; secIn.min = 0; secIn.max = 59; secIn.inputMode = 'numeric';
      secIn.value = Math.floor((p.budgetMs % 60000) / 1000);
      var sLbl = document.createElement('span'); sLbl.textContent = 's';
      function syncBudget() { p.budgetMs = formatMinSec(parseInt(minIn.value, 10) || 0, parseInt(secIn.value, 10) || 0); }
      minIn.addEventListener('change', syncBudget);
      secIn.addEventListener('change', syncBudget);
      timeWrap.appendChild(minIn); timeWrap.appendChild(mLbl);
      timeWrap.appendChild(secIn); timeWrap.appendChild(sLbl);

      var removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'row-remove-btn';
      removeBtn.textContent = '✕';
      removeBtn.setAttribute('aria-label', 'Remove ' + p.name);
      removeBtn.disabled = setupState.players.length <= 1;
      removeBtn.addEventListener('click', function () {
        setupState.players = setupState.players.filter(function (pl) { return pl.id !== p.id; });
        renderSetupPlayerList();
      });

      li.appendChild(handle);
      li.appendChild(colorBtn);
      li.appendChild(nameInput);
      li.appendChild(timeWrap);
      li.appendChild(removeBtn);
      listEl.appendChild(li);
    });
  }

  function openColorPicker(playerId) {
    colorPickerTargetId = playerId;
    var wrap = document.getElementById('color-swatch-list');
    wrap.innerHTML = '';
    var current = setupState.players.filter(function (p) { return p.id === playerId; })[0];
    PALETTE.forEach(function (token) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-swatch-btn' + (current && current.color === token ? ' selected' : '');
      btn.style.background = colorVar(token);
      btn.addEventListener('click', function () {
        if (current) current.color = token;
        document.getElementById('popover-color').classList.add('hidden');
        renderSetupPlayerList();
      });
      wrap.appendChild(btn);
    });
    document.getElementById('popover-color').classList.remove('hidden');
  }
  document.querySelector('[data-close="color"]').addEventListener('click', function () {
    document.getElementById('popover-color').classList.add('hidden');
  });

  document.getElementById('btn-add-player').addEventListener('click', function () {
    var usedColors = setupState.players.map(function (p) { return p.color; });
    var color = PALETTE.filter(function (c) { return usedColors.indexOf(c) === -1; })[0] ||
      PALETTE[setupState.players.length % PALETTE.length];
    setupState.players.push({
      id: Engine.uid(), name: 'Player ' + (setupState.players.length + 1), color: color, budgetMs: setupState.defaultMs
    });
    renderSetupPlayerList();
  });

  document.getElementById('btn-randomize-order').addEventListener('click', function () {
    setupState.players = Engine.shuffle(setupState.players);
    renderSetupPlayerList();
  });

  document.getElementById('btn-apply-default-budget').addEventListener('click', function () {
    var ms = formatMinSec(
      parseInt(document.getElementById('input-default-min').value, 10) || 0,
      parseInt(document.getElementById('input-default-sec').value, 10) || 0
    );
    setupState.defaultMs = ms;
    setupState.players.forEach(function (p) { p.budgetMs = ms; });
    renderSetupPlayerList();
  });

  Array.prototype.forEach.call(document.querySelectorAll('input[name="mode"]'), function (r) {
    r.addEventListener('change', function () {
      setupState.mode = r.value;
      document.getElementById('increment-field-group').hidden = r.value !== 'total_increment';
    });
  });

  function collectSetupFromForm() {
    setupState.name = document.getElementById('input-profile-name').value.trim();
    setupState.incrementMs = formatMinSec(
      parseInt(document.getElementById('input-increment-min').value, 10) || 0,
      parseInt(document.getElementById('input-increment-sec').value, 10) || 0
    );
    setupState.alertsEnabled = document.getElementById('chk-alerts-enabled').checked;
  }

  function buildProfileFromSetup(asNew) {
    collectSetupFromForm();
    var players = setupState.players.map(function (p) {
      return { id: p.id, name: (p.name || 'Player').trim() || 'Player', color: p.color, budgetMs: Engine.clampBudget(p.budgetMs) };
    });
    var now = Date.now();
    var existing = (editingProfileId && !asNew) ? Storage.loadProfiles()[editingProfileId] : null;
    return {
      id: asNew ? Engine.uid() : (setupState.id || Engine.uid()),
      name: setupState.name || 'Untitled timer',
      createdAt: existing ? existing.createdAt : now,
      lastPlayedAt: existing ? existing.lastPlayedAt : null,
      mode: setupState.mode,
      incrementMs: setupState.incrementMs,
      alertsEnabled: setupState.alertsEnabled,
      players: players,
      order: players.map(function (p) { return p.id; })
    };
  }

  document.getElementById('btn-setup-save').addEventListener('click', function () {
    if (!setupState.players.length) { toast('Add at least one player.'); return; }
    Storage.saveProfile(buildProfileFromSetup(false));
    toast('Saved.');
    showScreenRaw('home');
    renderHome();
  });
  document.getElementById('btn-setup-save-as-new').addEventListener('click', function () {
    if (!setupState.players.length) { toast('Add at least one player.'); return; }
    Storage.saveProfile(buildProfileFromSetup(true));
    toast('Saved as a new timer.');
    showScreenRaw('home');
    renderHome();
  });
  document.getElementById('btn-setup-delete').addEventListener('click', function () {
    if (!editingProfileId) return;
    if (!confirm('Delete this timer? This cannot be undone.')) return;
    Storage.deleteProfile(editingProfileId);
    showScreenRaw('home');
    renderHome();
  });
  document.getElementById('btn-setup-cancel').addEventListener('click', function () {
    showScreenRaw('home');
    renderHome();
  });

  // ---- PLAY ------------------------------------------------------------

  function buildStrip(state) {
    var el = document.getElementById('player-strip');
    el.innerHTML = '';
    stripEls = {};
    state.order.forEach(function (id) {
      var p = state.players[id];
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'strip-item';
      item.setAttribute('data-id', id);

      var bar = document.createElement('div'); bar.className = 'strip-bar';
      var inner = document.createElement('div'); inner.className = 'strip-item-inner';
      var nameEl = document.createElement('p'); nameEl.className = 'strip-name';
      var dot = document.createElement('span'); dot.className = 'color-dot'; dot.style.background = colorVar(p.color);
      nameEl.appendChild(dot);
      nameEl.appendChild(document.createTextNode(p.name));
      var timeEl = document.createElement('p'); timeEl.className = 'strip-time';

      inner.appendChild(nameEl);
      inner.appendChild(timeEl);
      item.appendChild(bar);
      item.appendChild(inner);
      el.appendChild(item);
      stripEls[id] = { root: item, bar: bar, time: timeEl };
    });
  }

  function findNextActiveId(state) {
    var n = state.order.length;
    for (var step = 1; step <= n; step++) {
      var idx = (state.currentIndex + step) % n;
      var id = state.order[idx];
      if (Engine.isActivePlayer(state, id)) return id;
    }
    return null;
  }

  function renderStrip(state) {
    var curId = Engine.currentPlayerId(state);
    var nextId = findNextActiveId(state);
    state.order.forEach(function (id) {
      var refs = stripEls[id];
      if (!refs) return;
      var p = state.players[id];
      var rem = Engine.remainingMs(state, id);
      var isCurrent = id === curId;
      var overdraft = rem < 0;
      var pct = Math.max(0, Math.min(100, (rem / p.budgetMs) * 100));
      var overPct = Math.max(0, Math.min(100, (Math.abs(rem) / p.budgetMs) * 100));
      refs.root.classList.toggle('is-current', isCurrent);
      refs.root.classList.toggle('is-next', id === nextId && !isCurrent);
      refs.root.classList.toggle('is-inactive', !p.active);
      refs.root.classList.toggle('is-overdraft', overdraft);
      refs.bar.classList.toggle('overdraft-fill', overdraft);
      refs.bar.style.width = (overdraft ? overPct : pct) + '%';
      var str = formatClock(rem, false);
      if (refs.time.textContent !== str) refs.time.textContent = str;
    });
  }

  function refreshStrip() {
    if (!currentGame) return;
    buildStrip(currentGame);
    renderStrip(currentGame);
  }

  document.getElementById('player-strip').addEventListener('click', function (e) {
    var item = e.target.closest('.strip-item');
    if (!item || !currentGame) return;
    var id = item.getAttribute('data-id');
    if (id === Engine.currentPlayerId(currentGame)) return;
    if (!Engine.isActivePlayer(currentGame, id)) { toast('That player is inactive.'); return; }
    Engine.jumpToPlayer(currentGame, id);
    onTurnChanged();
  });

  function flashCrossfade() {
    var panel = document.getElementById('current-panel');
    panel.classList.remove('crossfade');
    void panel.offsetWidth;
    panel.classList.add('crossfade');
  }

  function onTurnChanged() {
    persist();
    flashCrossfade();
    if (navigator.vibrate) navigator.vibrate(30);
    document.getElementById('btn-undo').disabled = !currentGame.undoStack.length;
    renderStrip(currentGame);
  }

  function checkAlerts(state) {
    if (!soundOn || !state.alertsEnabled) return;
    var curId = Engine.currentPlayerId(state);
    var key = state.currentIndex + ':' + state.turnStartedAt;
    if (alertFired.key !== key) { alertFired.key = key; alertFired.thresholds = {}; }
    var rem = Engine.remainingMs(state, curId);
    [60000, 10000, 0].forEach(function (th) {
      if (rem <= th && !alertFired.thresholds[th]) {
        alertFired.thresholds[th] = true;
        AudioFx.playThreshold(th);
      }
    });
  }

  function playTick() {
    if (!currentGame) { rafId = null; return; }
    var state = currentGame;
    var curId = Engine.currentPlayerId(state);
    var rem = Engine.remainingMs(state, curId);
    var showTenths = Math.abs(rem) < 20000;
    var str = formatClock(rem, showTenths);
    if (str !== prevDisplay.current) {
      document.getElementById('current-remaining').textContent = str;
      prevDisplay.current = str;
    }
    var nameEl = document.getElementById('current-name');
    var curName = state.players[curId].name;
    if (nameEl.textContent !== curName) nameEl.textContent = curName;

    var elapsedStr = 'turn: ' + formatDuration(Engine.turnElapsedMs(state));
    if (elapsedStr !== prevDisplay.elapsed) {
      document.getElementById('current-turn-elapsed').textContent = elapsedStr;
      prevDisplay.elapsed = elapsedStr;
    }

    document.getElementById('screen-play').classList.toggle('overdraft', rem < 0);

    renderStrip(state);
    if (!Engine.isPaused(state)) checkAlerts(state);

    rafId = requestAnimationFrame(playTick);
  }

  function enterPlayScreen() {
    prevDisplay = { current: null, elapsed: null };
    alertFired = { key: null, thresholds: {} };
    buildStrip(currentGame);
    document.getElementById('chk-sound').checked = soundOn;
    document.getElementById('btn-undo').disabled = !currentGame.undoStack.length;
    WakeLockCtl.request();
    if (!rafId) rafId = requestAnimationFrame(playTick);
    // A reload/crash can land here with the game already paused (e.g. tablet
    // was asleep or the tab was closed mid-pause) — surface that explicitly
    // instead of showing a silently frozen clock.
    if (Engine.isPaused(currentGame)) showPauseOverlay();
  }
  function leavePlayScreen() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    WakeLockCtl.release();
  }

  document.getElementById('play-surface').addEventListener('pointerup', function (e) {
    if (!currentGame || Engine.isPaused(currentGame)) return;
    if (e.target.closest('#admin-corner')) return;
    if (!canEndTurn()) return;
    Engine.endTurn(currentGame);
    onTurnChanged();
  });

  document.getElementById('btn-pause').addEventListener('click', function () {
    if (!currentGame) return;
    Engine.pauseGame(currentGame);
    persist();
    showPauseOverlay();
  });
  function showPauseOverlay() {
    document.getElementById('chk-sound').checked = soundOn;
    document.getElementById('pause-elapsed').textContent =
      'Game time: ' + formatDuration(Date.now() - currentGame.startedAt);
    document.getElementById('overlay-pause').classList.remove('hidden');
  }
  document.getElementById('btn-resume-game').addEventListener('click', function () {
    if (!currentGame) return;
    Engine.resumeGame(currentGame);
    persist();
    document.getElementById('overlay-pause').classList.add('hidden');
  });
  document.getElementById('chk-sound').addEventListener('change', function (e) {
    soundOn = e.target.checked;
    if (currentGame) { currentGame.alertsEnabled = soundOn; persist(); }
  });
  document.getElementById('btn-leave-game').addEventListener('click', function () {
    if (!confirm('Leave this game? It stays paused — resume it later from the home screen.')) return;
    document.getElementById('overlay-pause').classList.add('hidden');
    showScreenRaw('home');
    renderHome();
  });

  document.getElementById('btn-undo').addEventListener('click', function () {
    if (!currentGame || !currentGame.undoStack.length) return;
    currentGame = Engine.undo(currentGame);
    onTurnChanged();
  });

  var adminCorner = document.getElementById('admin-corner');
  function cancelLongPress() { clearTimeout(longPressTimer); longPressTimer = null; longPressStartXY = null; }
  adminCorner.addEventListener('pointerdown', function (e) {
    longPressStartXY = { x: e.clientX, y: e.clientY };
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(function () { cancelLongPress(); openAdmin(); }, 600);
  });
  adminCorner.addEventListener('pointerup', cancelLongPress);
  adminCorner.addEventListener('pointercancel', cancelLongPress);
  adminCorner.addEventListener('pointermove', function (e) {
    if (!longPressStartXY) return;
    var dx = e.clientX - longPressStartXY.x, dy = e.clientY - longPressStartXY.y;
    if (Math.sqrt(dx * dx + dy * dy) > 12) cancelLongPress();
  });

  // ---- ADMIN -------------------------------------------------------------

  function openAdmin() {
    if (!currentGame) return;
    preAdminWasPaused = Engine.isPaused(currentGame);
    if (!preAdminWasPaused) { Engine.pauseGame(currentGame); persist(); }
    document.getElementById('admin-add-player-form').hidden = true;
    renderAdmin();
    document.getElementById('overlay-admin').classList.remove('hidden');
  }
  function closeAdmin() {
    document.getElementById('overlay-admin').classList.add('hidden');
    if (!preAdminWasPaused && currentGame) { Engine.resumeGame(currentGame); persist(); }
  }
  document.getElementById('btn-admin-close').addEventListener('click', closeAdmin);

  function renderAdmin() {
    var state = currentGame;
    var curId = Engine.currentPlayerId(state);
    var listEl = document.getElementById('admin-player-list');
    listEl.innerHTML = '';

    state.order.forEach(function (id) {
      var p = state.players[id];
      var li = document.createElement('li');
      li.className = 'admin-player-row' + (id === curId ? ' is-current' : '');
      li.setAttribute('data-id', id);

      var top = document.createElement('div');
      top.className = 'admin-row-top';
      var handle = document.createElement('span'); handle.className = 'drag-handle'; handle.textContent = '⠿';
      var nameInput = document.createElement('input');
      nameInput.type = 'text'; nameInput.value = p.name; nameInput.maxLength = 40;
      nameInput.addEventListener('change', function () {
        Engine.renamePlayer(state, id, nameInput.value.trim() || 'Player');
        persist(); refreshStrip();
      });
      top.appendChild(handle);
      top.appendChild(nameInput);
      if (id === curId) {
        var badge = document.createElement('span'); badge.className = 'admin-row-badge'; badge.textContent = 'current';
        top.appendChild(badge);
      }

      var timeRow = document.createElement('div');
      timeRow.className = 'admin-row-time';
      [['−5m', -300000], ['−1m', -60000]].forEach(function (pair) {
        timeRow.appendChild(makeAdjustButton(state, id, pair[0], pair[1]));
      });
      var timeInput = document.createElement('input');
      timeInput.type = 'text';
      timeInput.value = formatClock(Engine.remainingMs(state, id), false);
      timeInput.addEventListener('change', function () {
        Engine.setRemaining(state, id, parseClockToMs(timeInput.value));
        persist(); renderAdmin(); refreshStrip();
      });
      timeRow.appendChild(timeInput);
      [['+1m', 60000], ['+5m', 300000]].forEach(function (pair) {
        timeRow.appendChild(makeAdjustButton(state, id, pair[0], pair[1]));
      });

      var actions = document.createElement('div');
      actions.className = 'admin-row-actions';

      var activeLabel = document.createElement('label');
      var activeChk = document.createElement('input');
      activeChk.type = 'checkbox'; activeChk.checked = p.active;
      activeChk.addEventListener('change', function () {
        var res = Engine.toggleActive(state, id);
        if (!res.ok) { activeChk.checked = true; toast('At least one player must stay active.'); return; }
        persist(); renderAdmin(); refreshStrip();
      });
      activeLabel.appendChild(activeChk);
      activeLabel.appendChild(document.createTextNode('Active'));

      var setCurrentBtn = document.createElement('button');
      setCurrentBtn.type = 'button'; setCurrentBtn.className = 'btn btn-ghost btn-small'; setCurrentBtn.textContent = 'Set current';
      setCurrentBtn.disabled = id === curId || !p.active;
      setCurrentBtn.addEventListener('click', function () {
        Engine.adminSetCurrentPlayer(state, id);
        persist(); renderAdmin(); refreshStrip();
      });

      var removeBtn = document.createElement('button');
      removeBtn.type = 'button'; removeBtn.className = 'btn btn-danger btn-small'; removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', function () {
        if (!confirm('Remove ' + p.name + ' from the game? Their stats stay in the summary.')) return;
        var res = Engine.removePlayer(state, id);
        if (!res.ok) { toast('At least one player must stay active.'); return; }
        persist(); renderAdmin(); refreshStrip();
      });

      actions.appendChild(activeLabel);
      actions.appendChild(setCurrentBtn);
      actions.appendChild(removeBtn);

      li.appendChild(top);
      li.appendChild(timeRow);
      li.appendChild(actions);
      listEl.appendChild(li);
    });
  }

  function makeAdjustButton(state, id, label, deltaMs) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-small';
    btn.textContent = label;
    btn.addEventListener('click', function () {
      Engine.adjustRemaining(state, id, deltaMs);
      persist(); renderAdmin(); refreshStrip();
    });
    return btn;
  }

  document.getElementById('btn-admin-add-player').addEventListener('click', function () {
    document.getElementById('admin-add-player-form').hidden = false;
  });
  document.getElementById('btn-admin-cancel-add').addEventListener('click', function () {
    document.getElementById('admin-add-player-form').hidden = true;
  });
  document.getElementById('btn-admin-confirm-add').addEventListener('click', function () {
    if (!currentGame) return;
    var name = document.getElementById('admin-new-player-name').value.trim() || 'Player';
    var ms = formatMinSec(
      parseInt(document.getElementById('admin-new-player-min').value, 10) || 0,
      parseInt(document.getElementById('admin-new-player-sec').value, 10) || 0
    );
    var usedColors = currentGame.order.map(function (id) { return currentGame.players[id].color; });
    var color = PALETTE.filter(function (c) { return usedColors.indexOf(c) === -1; })[0] ||
      PALETTE[currentGame.order.length % PALETTE.length];
    Engine.addPlayerMidGame(currentGame, name, color, ms);
    document.getElementById('admin-new-player-name').value = '';
    document.getElementById('admin-add-player-form').hidden = true;
    persist(); renderAdmin(); refreshStrip();
  });

  document.getElementById('btn-admin-save-profile').addEventListener('click', function () {
    if (!currentGame) return;
    var profiles = Storage.loadProfiles();
    var profile = profiles[currentGame.profileId];
    if (!profile) { toast('Original timer no longer exists.'); return; }
    Engine.saveGameToProfile(currentGame, profile);
    Storage.saveProfile(profile);
    toast('Saved to profile.');
  });

  document.getElementById('btn-admin-end-game').addEventListener('click', function () {
    if (!confirm('End the game and show the summary?')) return;
    document.getElementById('overlay-admin').classList.add('hidden');
    endGame();
  });

  // ---- SUMMARY -------------------------------------------------------------

  function endGame() {
    renderSummary(currentGame);
    Storage.clearActiveGame();
    showScreenRaw('summary');
  }

  function renderSummary(state) {
    document.getElementById('summary-profile-name').textContent = state.profileName;
    var listEl = document.getElementById('summary-list');
    listEl.innerHTML = '';
    var ids = Object.keys(state.players);
    var ordered = state.order.concat(ids.filter(function (id) { return state.order.indexOf(id) === -1; }));
    ordered.forEach(function (id) {
      var p = state.players[id];
      if (!p) return;
      var li = document.createElement('li');
      li.className = 'summary-row';

      var head = document.createElement('div'); head.className = 'summary-row-head';
      var dot = document.createElement('span'); dot.className = 'color-dot'; dot.style.background = colorVar(p.color);
      var h3 = document.createElement('h3'); h3.textContent = p.name;
      head.appendChild(dot); head.appendChild(h3);
      if (p.removed) {
        var tag = document.createElement('span'); tag.className = 'summary-withdrawn-tag'; tag.textContent = 'withdrawn';
        head.appendChild(tag);
      }

      var stats = document.createElement('div'); stats.className = 'summary-stats';
      function stat(label, value, cls) {
        var d = document.createElement('div');
        if (cls) d.className = cls;
        var lbl = document.createElement('span'); lbl.textContent = label + ': ';
        var b = document.createElement('b'); b.textContent = value;
        d.appendChild(lbl); d.appendChild(b);
        stats.appendChild(d);
      }
      var avg = p.turnsTaken ? Math.round(p.totalUsedMs / p.turnsTaken) : 0;
      stat('Total used', formatDuration(p.totalUsedMs));
      stat('Turns', String(p.turnsTaken));
      stat('Avg turn', formatDuration(avg));
      stat('Longest turn', formatDuration(p.longestTurnMs));
      if (p.overdraftMs > 0) stat('Overdraft', formatDuration(p.overdraftMs), 'overdraft-stat');

      li.appendChild(head);
      li.appendChild(stats);
      listEl.appendChild(li);
    });
  }

  document.getElementById('btn-summary-home').addEventListener('click', function () {
    currentGame = null;
    showScreenRaw('home');
    renderHome();
  });
  document.getElementById('btn-play-again').addEventListener('click', function () {
    if (!currentGame) { showScreenRaw('home'); renderHome(); return; }
    var profiles = Storage.loadProfiles();
    var profile = profiles[currentGame.profileId];
    currentGame = null;
    showScreenRaw('home');
    renderHome();
    if (profile) openConfirmStart(profile.id);
    else toast('Original timer no longer exists.');
  });

  // ---- DRAG REORDER WIRING -------------------------------------------------

  enableDragReorder(document.getElementById('player-setup-list'), function (ids) {
    setupState.players = ids.map(function (id) {
      return setupState.players.filter(function (p) { return p.id === id; })[0];
    }).filter(Boolean);
  });
  enableDragReorder(document.getElementById('admin-player-list'), function (ids) {
    if (!currentGame) return;
    Engine.reorderPlayers(currentGame, ids);
    persist();
    refreshStrip();
  });

  // ---- INIT ------------------------------------------------------------

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(function () { /* best-effort, offline-first */ });
    }
  }

  function init() {
    registerServiceWorker();
    renderHome();
  }

  init();
})();

