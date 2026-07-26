// Loads the pure timing-engine block straight out of app.js (between the
// ENGINE:START / ENGINE:END markers) into an isolated vm context with a
// controllable clock, so engine math can be unit-tested without a browser.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadEngine() {
  const appJsPath = path.join(__dirname, '..', '..', 'app.js');
  const src = fs.readFileSync(appJsPath, 'utf8');
  const match = src.match(/\/\* ENGINE:START \*\/([\s\S]*?)\/\* ENGINE:END \*\//);
  if (!match) {
    throw new Error('Could not find ENGINE:START/ENGINE:END markers in app.js — did the engine get moved or renamed?');
  }

  let now = 1_000_000;
  const FakeDate = class extends Date {
    static now() { return now; }
  };

  const sandbox = { console, Date: FakeDate };
  vm.createContext(sandbox);
  vm.runInContext(match[1], sandbox, { filename: 'app.js (ENGINE block)' });

  return {
    Engine: sandbox.Engine,
    setNow(n) { now = n; },
    advance(ms) { now += ms; },
    getNow() { return now; }
  };
}

module.exports = { loadEngine };
