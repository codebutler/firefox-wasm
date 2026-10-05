import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

function bridge() {
  const calls = [], preferences = [];
  let fail = false;
  const sheets = {
    AGENT_SHEET: 0,
    loadAndRegisterSheet(uri, origin) {
      if (fail) throw new Error('sheet load failed');
      calls.push(['load', uri, origin]);
    },
    unregisterSheet(uri, origin) { calls.push(['unload', uri, origin]); },
  };
  const context = vm.createContext({
    Cc: { '@mozilla.org/content/style-sheet-service;1': { getService: () => sheets } },
    Ci: { nsIStyleSheetService: {} },
    Services: {
      io: { newURI: uri => uri },
      prefs: { setIntPref: (...args) => preferences.push(args) },
    },
  });
  vm.runInContext(readFileSync(new URL('./chrome/EmbedTheme.sys.mjs', import.meta.url), 'utf8')
    .replaceAll('export function', 'function'), context);
  const styles = [];
  return {
    set: theme => context.setTheme(JSON.stringify(theme)),
    open() {
      context.registerChromeDocument({
        createElementNS: () => ({}), head: { appendChild: style => styles.push(style) },
      });
      return styles.at(-1);
    },
    fail() { fail = true; }, calls, preferences,
  };
}
const blue = { contentCss: 'input { color: blue; }', popupCss: 'menuitem { color: blue; }', dark: false };
const green = { contentCss: 'input { color: green; }', popupCss: 'menuitem { color: green; }', dark: true };

test('theme defaults use the UA cascade and update existing and future popup documents', () => {
  const b = bridge();
  b.set(blue);
  const popup = b.open();
  assert.equal(popup.textContent, blue.popupCss);
  b.set(green);
  assert.equal(popup.textContent, green.popupCss);
  assert.equal(b.open().textContent, green.popupCss);
  assert.deepEqual(b.calls.map(([action, , origin]) => [action, origin]), [['load', 0], ['load', 0], ['unload', 0]]);
  assert.equal(decodeURIComponent(b.calls[1][1].split(',')[1]), green.contentCss);
  assert.deepEqual(b.preferences, [['ui.systemUsesDarkTheme', 0], ['ui.systemUsesDarkTheme', 1]]);
});

test('identical themes are idempotent and popup-only updates do not replace the content sheet', () => {
  const b = bridge(); b.set(blue); b.set(blue);
  assert.equal(b.calls.length, 1);
  const popup = b.open();
  b.set({ ...blue, popupCss: green.popupCss });
  assert.equal(b.calls.length, 1);
  assert.equal(popup.textContent, green.popupCss);
});

test('invalid or failed replacements preserve the existing sheet and popup', () => {
  const b = bridge(); b.set(blue); const popup = b.open();
  assert.throws(() => b.set({ ...green, dark: 'yes' }), /Invalid embedding theme/);
  b.fail();
  assert.throws(() => b.set(green), /sheet load failed/);
  assert.equal(b.calls.length, 1);
  assert.equal(popup.textContent, blue.popupCss);
  assert.equal(b.preferences.length, 1);
});
