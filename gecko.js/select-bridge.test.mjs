import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// Run the actual embedding module, replacing only its privileged Mozilla import
// and globals. Native layout/input remains covered by the real Surf probe.
function bridge() {
  let onLoaded;
  let closed = false;
  const received = [], sent = [], actors = [];
  const window = { screen: { width: 1280, height: 900 }, document: {} };
  const popup = { hidden: false };
  window.document.getElementById = () => popup;
  const helper = { _actor: null, hide() { popup.hidden = true; } };
  class DesktopSelectParent {
    receiveMessage(message) { received.push(message.name); helper._actor = this; }
    sendAsyncMessage(name) { sent.push(name); }
    get _menulist() { return this._document.getElementById('ContentSelectDropdown'); }
  }
  const base = { setPositionAndSize(...args) { this.size = args; } };
  const context = vm.createContext({
    DesktopSelectParent, SelectParentHelper: helper, console,
    Ci: { nsIBaseWindow: { eRepaint: 1 } },
    ChromeUtils: { unregisterWindowActor() {}, registerWindowActor(name, actor) { actors.push({ name, actor }); } },
    Services: {
      appShell: { createWindowlessBrowser() { return {
        docShell: {
          chromeEventHandler: {
            addEventListener(name, callback) { onLoaded = callback; },
            removeEventListener() {},
          },
          QueryInterface() { return base; },
        },
        loadURI() {}, close() { closed = true; },
      }; } },
      io: { newURI(uri) { return uri; } },
      scriptSecurityManager: { getSystemPrincipal() { return {}; } },
    },
  });
  const source = readFileSync(new URL('./chrome/EmbedSelect.sys.mjs', import.meta.url), 'utf8')
    .replace(/import \{[\s\S]*?\} from "resource:\/\/gre\/actors\/SelectParent.sys.mjs";/, '')
    .replace('export class SelectParent', 'globalThis.SelectParent = class SelectParent');
  vm.runInContext(source, context);
  return {
    Parent: context.SelectParent, received, sent, actors, popup, base,
    loaded() { onLoaded({ target: { documentURI: 'chrome://geckoembed/content/select.xhtml', defaultView: window } }); },
    get closed() { return closed; },
  };
}

test('select messages stay ordered while the chrome popup document loads', async () => {
  const b = bridge(), parent = new b.Parent();
  parent.receiveMessage({ name: 'Forms:ShowDropDown' });
  parent.receiveMessage({ name: 'Forms:UpdateDropDown' });
  parent.receiveMessage({ name: 'Forms:HideDropDown' });
  await Promise.resolve();
  assert.deepEqual(b.received, []);
  b.loaded();
  await parent._pending;
  assert.deepEqual(b.received, ['Forms:ShowDropDown', 'Forms:UpdateDropDown', 'Forms:HideDropDown']);
  assert.deepEqual(b.base.size, [0, 0, 1280, 900, 1]);
  assert.equal(b.base.visibility, true);
  assert.equal(b.actors[0].name, 'Select');
  assert.equal(b.actors[0].actor.child.esModuleURI, 'resource://gre/actors/SelectChild.sys.mjs');
});

test('navigation while chrome loads cannot reopen a destroyed select actor', async () => {
  const b = bridge(), parent = new b.Parent();
  parent.receiveMessage({ name: 'Forms:ShowDropDown' });
  await Promise.resolve();
  parent.didDestroy();
  b.loaded();
  await parent._pending;
  parent.sendAsyncMessage('Forms:DismissedDropDown', {});
  assert.deepEqual(b.received, []);
  assert.deepEqual(b.sent, []);
});

test('destroying an old actor preserves a newer actor popup', async () => {
  const b = bridge(), old = new b.Parent(), next = new b.Parent();
  old.receiveMessage({ name: 'Forms:ShowDropDown' });
  await Promise.resolve(); b.loaded(); await old._pending;
  next.receiveMessage({ name: 'Forms:ShowDropDown' }); await next._pending;
  old.didDestroy(); assert.equal(b.popup.hidden, false);
  next.didDestroy(); assert.equal(b.popup.hidden, true);
});
