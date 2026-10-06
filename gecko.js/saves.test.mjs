import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

function bridge() {
  const factories = new Map(), calls = [], deferred = [], removed = [], persistence = [];
  const window = new EventTarget();
  const context = { window };
  window.browsingContext = context;
  const document = window.document = { title: 'A page', documentURI: 'https://example.org/page',
    nodePrincipal: { origin: 'page' }, cookieJarSettings: { cookies: true }, referrerInfo: {} };
  let reply = { name: 'saved.bin' }, during;
  class File {
    constructor(path) { this.path = path; }
    append(name) { this.path += '/' + name; }
    createUnique() { this.path += '-' + calls.length; }
    clone() { return new File(this.path); }
    get parent() { return new File(this.path.slice(0, this.path.lastIndexOf('/'))); }
    remove() { removed.push(this.path); }
  }
  const uri = spec => ({ spec, fileName: 'file.bin', QueryInterface() { return this; } });
  const scope = vm.createContext({ console, Promise, Map, JSON, Services: {
    prefs: { setBoolPref() {} },
    tm: { dispatchToMainThread(fn) { deferred.push(fn); } },
    io: { newURI: uri },
    scriptSecurityManager: { checkLoadURIWithPrincipal(principal) { assert.equal(principal, document.nodePrincipal); } },
    dirsvc: { get() { return new File('/tmp'); } },
    obs: { notifyObservers(subject, topic, json) {
      calls.push({ topic, data: JSON.parse(json), subject });
      if (topic.endsWith('-choose')) { during?.(); subject.data = JSON.stringify(reply); }
    } },
  }, BrowsingContext: { get() { return context; } },
  Cr: { NS_BINDING_ABORTED: 99 }, Ci: { nsIFile: { DIRECTORY_TYPE: 1 },
    nsIWebProgressListener: { STATE_STOP: 1, STATE_IS_NETWORK: 2 },
    nsIWebBrowserPersist: {}, nsIContentPolicy: { TYPE_SAVEAS_DOWNLOAD: 7 },
    nsIScriptSecurityManager: { DISALLOW_SCRIPT: 1 } },
  Cc: {
    '@mozilla.org/supports-string;1': { createInstance() { return { data: '' }; } },
    '@mozilla.org/embedding/browser/nsWebBrowserPersist;1': { createInstance() {
      const persist = { saveURI(...args) { this.args = args; }, saveDocument(...args) { this.document = args; }, cancel() { this.cancelled = true; } };
      persistence.push(persist); return persist;
    } },
  }, ChromeUtils: { generateQI() { return function() { return this; }; } },
  Components: { ID: v => v, isSuccessCode: v => v === 0,
    manager: { QueryInterface() { return { registerFactory(_id, _name, contract, factory) { factories.set(contract, factory); } }; } } },
  });
  const source = readFileSync(new URL('./chrome/EmbedSaves.sys.mjs', import.meta.url), 'utf8')
    .replace(/export function /g, 'function ') + '\nglobalThis.api={chooseSave,saveURL,saves,byPath};';
  vm.runInContext(source, scope);
  return { ...scope.api, calls, removed, context, window, document, persistence,
    reply(value, callback) { reply = value; during = callback; },
    flush() { deferred.splice(0).forEach(fn => fn()); },
    component(name) { return factories.get('@mozilla.org/' + name + ';1').createInstance(); },
  };
}

test('save picker grants only a guest temporary filename, and cancellation grants none', () => {
  const b = bridge();
  b.reply({ name: '/host/private/renamed.bin' });
  const file = b.chooseSave(b.context, { name: '../../payload.bin' });
  assert.equal(b.calls[0].data.name, 'payload.bin');
  assert.match(file.path, /^\/tmp\/embed-save-\d+\/renamed.bin$/);
  assert.equal(b.saves.size, 1);
  b.window.dispatchEvent(new Event('pagehide'));
  assert.equal(b.saves.size, 0);
  assert.equal(b.byPath.size, 0);
  b.reply(null);
  assert.equal(b.chooseSave(b.context, { name: 'x' }), null);
});

test('navigation during destination selection rejects a late host reply', () => {
  const b = bridge();
  b.reply({ name: 'late.bin' }, () => b.window.dispatchEvent(new Event('pagehide')));
  assert.equal(b.chooseSave(b.context, { name: 'x' }), null);
  assert.equal(b.saves.size, 0);
});

test('helper launcher retains original download and completed transfer reaches host once', () => {
  const b = bridge(), dialog = b.component('helperapplauncherdialog');
  const launcher = { browsingContextId: 1, suggestedFileName: 'download.bin', MIMEInfo: { MIMEType: 'application/octet-stream' },
    source: { spec: 'https://example.org/original-response' },
    promptForSaveDestination() { dialog.promptForSaveToFileAsync(this, null, this.suggestedFileName, 'bin'); },
    saveDestinationAvailable(file) { this.file = file; }, cancel() { this.cancelled = true; } };
  dialog.show(launcher); b.flush();
  assert.ok(launcher.file);
  const transfer = b.component('transfer');
  transfer.initWithBrowsingContext(launcher.source, { QueryInterface() { return { file: launcher.file }; } }, '', null, 0, null, launcher);
  transfer.onStateChange(null, null, 1, 0);
  assert.equal(b.calls.filter(c => c.topic.endsWith('-finish')).length, 0);
  transfer.onStateChange(null, null, 3, 0);
  transfer.onStateChange(null, null, 3, 0);
  const finishes = b.calls.filter(c => c.topic.endsWith('-finish'));
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].subject, launcher.file);
  assert.equal(b.saves.size, 0);
  assert.equal(launcher.cancelled, undefined);
});

test('explicit resource saving keeps the content principal and cookie settings', () => {
  const b = bridge();
  b.saveURL(JSON.stringify({ url: 'https://example.org/file.bin' }), b.window); b.flush();
  const p = b.persistence[0];
  assert.equal(p.args[1], b.document.nodePrincipal);
  assert.equal(p.args[4], b.document.cookieJarSettings);
  b.window.dispatchEvent(new Event('pagehide'));
  assert.equal(p.cancelled, true);
  p.progressListener.onStateChange(null, null, 3, 0);
  assert.equal(b.calls.filter(c => c.topic.endsWith('-finish')).length, 0);
});

test('page save serializes the loaded document; failed transfers report an error without bytes', () => {
  const b = bridge();
  b.saveURL(JSON.stringify({ document: true }), b.window); b.flush();
  const p = b.persistence[0];
  assert.equal(p.document[0], b.document);
  assert.equal(p.document[2], null);
  assert.equal(p.document[3], 'text/html');
  p.progressListener.onStateChange(null, null, 3, 0x80004005);
  const finish = b.calls.find(c => c.topic.endsWith('-finish'));
  assert.match(finish.data.error, /Download failed/);
  assert.equal(finish.subject, null);
  assert.equal(b.saves.size, 0);
});
