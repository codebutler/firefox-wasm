import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// An in-memory stand-in for the nsIFile, stream and resource:// services the
// asset store uses.
function fileSystem() {
  const files = new Map(), dirs = new Set(['/tmp/embed-theme']), substitutions = [], modes = [];
  const file = path => ({
    path,
    clone() { return file(this.path); },
    append(name) { this.path += '/' + name; },
    exists() { return dirs.has(this.path) || files.has(this.path); },
    createUnique(type, mode) {
      while (dirs.has(this.path)) this.path += '-1';
      dirs.add(this.path); modes.push(mode);
    },
    remove(recursive) {
      dirs.delete(this.path); files.delete(this.path);
      if (recursive) for (const key of [...files.keys()]) if (key.startsWith(this.path + '/')) files.delete(key);
    },
  });
  let target;
  const Cc = {
    '@mozilla.org/network/file-output-stream;1': { createInstance: () => ({
      init(f) { target = f.path; files.set(target, ''); },
      close() {},
    }) },
    '@mozilla.org/binaryoutputstream;1': { createInstance: () => ({
      setOutputStream() {},
      writeByteArray(bytes) { files.set(target, new TextDecoder().decode(bytes)); },
    }) },
  };
  const services = {
    dirsvc: { get: () => file('/tmp') },
    io: {
      newFileURI: f => 'file://' + f.path + '/',
      getProtocolHandler: () => ({ QueryInterface: () => ({
        setSubstitutionWithFlags: (...args) => substitutions.push(args),
      }) }),
    },
  };
  return { files, dirs, substitutions, modes, Cc, services };
}

function bridge() {
  const calls = [], preferences = [];
  let fail = false;
  const fs = fileSystem();
  const sheets = {
    AGENT_SHEET: 0,
    loadAndRegisterSheet(uri, origin) {
      if (fail) throw new Error('sheet load failed');
      calls.push(['load', uri, origin]);
    },
    unregisterSheet(uri, origin) { calls.push(['unload', uri, origin]); },
  };
  const context = vm.createContext({
    Cc: { '@mozilla.org/content/style-sheet-service;1': { getService: () => sheets }, ...fs.Cc },
    Ci: {
      nsIStyleSheetService: {}, nsIFile: { DIRECTORY_TYPE: 1 }, nsIResProtocolHandler: {},
      nsISubstitutingProtocolHandler: { ALLOW_CONTENT_ACCESS: 4 },
      nsIFileOutputStream: {}, nsIBinaryOutputStream: {},
    },
    TextEncoder, TextDecoder,
    Services: {
      dirsvc: fs.services.dirsvc,
      io: { newURI: uri => uri, ...fs.services.io },
      prefs: {
        setIntPref: (...args) => preferences.push(args),
        setCharPref: (...args) => preferences.push(args),
        clearUserPref: name => preferences.push([name]),
      },
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
    fail() { fail = true; }, calls, preferences, fs,
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

test('system selection colors update independently and clear when removed', () => {
  const b = bridge();
  b.set({ ...blue, selection: { background: '#ddeeff', text: '#223344' } });
  b.set({ ...blue, selection: { background: '#ddeeff', text: '#334455' } });
  assert.equal(b.calls.length, 1);
  assert.deepEqual(b.preferences.filter(([name]) => name === 'ui.selecteditemtext'),
    [['ui.selecteditemtext', '#223344'], ['ui.selecteditemtext', '#334455']]);
  assert.throws(() => b.set({ ...blue, selection: { background: 'bad', text: '#334455' } }), /Invalid embedding selection/);
  b.set(blue);
  assert.ok(b.preferences.some(([name, value]) => name === 'ui.selecteditem' && value === undefined));
});

const arrow = "<svg xmlns='http://www.w3.org/2000/svg'><path d='M 5 7 L 8 10'/></svg>";
const check = "<svg xmlns='http://www.w3.org/2000/svg'><path d='M 3 8 L 6 11'/></svg>";
const dir = '/tmp/embed-theme-1';
const withAssets = (theme, assets) => ({ ...theme, assets });

test('assets are served from a content-accessible resource:// host before the sheet loads', () => {
  const b = bridge();
  b.set(withAssets(blue, { 'arrow-1.svg': arrow }));
  // A fresh private directory: an existing path is left alone, never deleted.
  assert.ok(b.fs.dirs.has('/tmp/embed-theme'));
  assert.deepEqual(b.fs.modes, [0o700]);
  assert.equal(b.fs.files.get(dir + '/arrow-1.svg'), arrow);
  assert.deepEqual(b.fs.substitutions, [['embed-theme', 'file://' + dir + '/', 4]]);
  assert.equal(b.calls.length, 1);
});

test('a later theme adds new assets, removes omitted ones, and keeps the host', () => {
  const b = bridge();
  b.set(withAssets(blue, { 'arrow-1.svg': arrow }));
  b.set(withAssets(green, { 'check-1.svg': check }));
  assert.deepEqual([...b.fs.files.keys()], [dir + '/check-1.svg']);
  assert.equal(b.fs.substitutions.length, 1);
  b.set(green);
  assert.equal(b.fs.files.size, 0);
});

test('an assets-only change is applied without replacing the content sheet', () => {
  const b = bridge();
  b.set(withAssets(blue, { 'arrow-1.svg': arrow }));
  b.set(withAssets(blue, { 'arrow-1.svg': arrow }));
  assert.equal(b.fs.files.size, 1);
  b.set(withAssets(blue, { 'arrow-1.svg': arrow, 'check-1.svg': check }));
  assert.equal(b.fs.files.size, 2);
  assert.equal(b.calls.length, 1);
});

test('asset names are validated and immutable', () => {
  const b = bridge();
  b.set(withAssets(blue, { 'arrow-1.svg': arrow }));
  assert.throws(() => b.set(withAssets(green, { 'arrow-1.svg': check })), /immutable: arrow-1\.svg/);
  for (const name of ['../x.svg', 'Arrow.svg', 'a.png', '.svg', 'a/b.svg'])
    assert.throws(() => b.set(withAssets(green, { [name]: arrow })), /Invalid embedding theme asset/);
  assert.throws(() => b.set(withAssets(green, { 'a.svg': 1 })), /Invalid embedding theme asset/);
  assert.throws(() => b.set(withAssets(green, [])), /Invalid embedding theme assets/);
  assert.equal(b.calls.length, 1);
  assert.deepEqual([...b.fs.files.keys()], [dir + '/arrow-1.svg']);
});

test('a failed sheet replacement keeps the assets the working theme references', () => {
  const b = bridge();
  b.set(withAssets(blue, { 'arrow-1.svg': arrow }));
  b.fail();
  assert.throws(() => b.set(withAssets(green, { 'check-1.svg': check })), /sheet load failed/);
  assert.ok(b.fs.files.has(dir + '/arrow-1.svg'));
});
