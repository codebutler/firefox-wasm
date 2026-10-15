import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

function bridge() {
  const factories = new Map(), actors = new Map(), observers = new Map();
  const calls = [], chunks = [], cancelled = [], sent = [], deferred = [], directories = [];
  const page = new EventTarget();
  page.Directory = class { constructor(path) { this.path = path; this.name = path.split('/').pop(); } };
  const disk = new Map([['/tmp', { directory: true }]]);
  const payloads = [];
  let duringWrite = null;
  class GuestDOMFile extends File {
    static async createFromFileName(path) {
      return new GuestDOMFile([Uint8Array.from(disk.get(path)?.bytes || [])], path.split('/').pop());
    }
  }
  page.File = GuestDOMFile;
  class GuestFile {
    constructor(path) { this.path = path; }
    clone() { return new GuestFile(this.path); }
    append(name) { this.path += `/${name}`; }
    exists() { return disk.has(this.path); }
    create(kind) { disk.set(this.path, { directory: kind === 1 }); }
    createUnique(kind) {
      const base = this.path;
      let suffix = 0;
      while (this.exists()) this.path = `${base}-${++suffix}`;
      this.create(kind);
    }
    remove() { for (const path of disk.keys()) if (path === this.path || path.startsWith(`${this.path}/`)) disk.delete(path); }
  }
  const context = { canOpenModalPicker: true, window: page };
  let reply = null, during;
  class JSWindowActorParent {
    browsingContext = context;
    sendAsyncMessage(name, data) { sent.push({ name, data }); }
  }
  class NativeDateTimePickerChild { openPickerImpl() { return {}; } }
  const global = vm.createContext({
    console, File: GuestDOMFile, Uint8Array, atob, JSWindowActorParent, NativeDateTimePickerChild, chooseSave: () => null,
    Cu: { importGlobalProperties() {} },
    Ci: { nsIFile: { DIRECTORY_TYPE: 1 }, nsIFilePicker: { returnOK: 0, returnCancel: 1, filterAll: 1 } },
    Cr: { NS_ERROR_FAILURE: 1 },
    Cc: { '@mozilla.org/supports-string;1': { createInstance() { return { data: '' }; } } },
    Components: { ID: value => value, manager: { QueryInterface() { return {
      registerFactory(_id, _name, contract, factory) { factories.set(contract, factory); },
    }; } } },
    ChromeUtils: { generateQI() { return function() { return this; }; }, unregisterWindowActor() {},
      registerWindowActor(name, value) { actors.set(name, value); } },
    Services: {
      tm: { dispatchToMainThread(fn) { deferred.push(fn); } }, prefs: { setBoolPref() {} },
      dirsvc: { get(name) { directories.push(name); return new GuestFile('/tmp'); } },
      obs: {
        addObserver(fn, name) { observers.set(name, fn); },
        notifyObservers(subject, topic, data) {
          if (topic.endsWith('-cancel')) { cancelled.push(data); return; }
          if (topic.endsWith('-close')) return;
          if (topic.endsWith('-chunk')) {
            const { index, offset } = JSON.parse(data);
            chunks.push({ index, offset });
            subject.data = JSON.stringify({ data: payloads[index].subarray(offset, offset + 65536).toString('base64') });
            return;
          }
          calls.push(JSON.parse(data)); during?.(); subject.data = JSON.stringify(reply);
        },
      },
    },
    IOUtils: { async write(path, bytes, options) {
      duringWrite?.(path, bytes);
      const previous = options?.mode === 'append' ? disk.get(path)?.bytes || [] : [];
      disk.set(path, { bytes: [...previous, ...bytes] });
    } },
  });
  const source = readFileSync(new URL('./chrome/EmbedPickers.sys.mjs', import.meta.url), 'utf8')
    .replace(/import \{ DateTimePickerChild[\s\S]*?;/, '')
    .replace(/import \{ chooseSave \}[^;]*;/, '')
    .replace(/export class (DateTimePickerChild|DateTimePickerParent)/g, 'globalThis.$1 = class $1');
  vm.runInContext(source, global);
  return { calls, chunks, cancelled, sent, directories, context, page, actors, observers, disk,
    onWrite(fn) { duringWrite = fn; },
    Child: global.DateTimePickerChild, Parent: global.DateTimePickerParent,
    picker(kind) { return factories.get(`@mozilla.org/${kind}picker;1`).createInstance(); },
    promptCollection() { return factories.get('@mozilla.org/embedcomp/prompt-collection;1').createInstance(); },
    reply(value, callback) {
      payloads.length = 0;
      const describe = file => {
        const bytes = Buffer.from(file.base64 || '', 'base64');
        const index = payloads.push(bytes) - 1;
        const { base64, ...metadata } = file;
        return { ...metadata, index, size: bytes.length };
      };
      reply = value?.directory ? { session: 'test-session', directory: {
        name: value.directory.name, files: value.directory.files.map(describe),
      } } : value?.files ? { session: 'test-session', files: value.files.map(describe) } : value;
      during = callback;
    },
    flush() { return Promise.all(deferred.splice(0).map(fn => fn())); },
  };
}

test('folder upload requires a separate host confirmation', () => {
  const b = bridge();
  b.reply({ confirmed: true });
  assert.equal(b.promptCollection().confirmFolderUpload(b.context, '日本語'), true);
  assert.deepEqual(b.calls[0], { kind: 'folder-confirm', name: '日本語', id: '1' });
  b.reply(null);
  assert.equal(b.promptCollection().confirmFolderUpload(b.context, 'cancelled'), false);
  b.reply({ confirmed: true }, () => b.page.dispatchEvent(new Event('pagehide')));
  assert.equal(b.promptCollection().confirmFolderUpload(b.context, 'navigating'), false);
  assert.equal(b.cancelled.length, 1);
});

test('directory mode stages a private guest tree and preserves relative hierarchy', async () => {
  const b = bridge(), picker = b.picker('file');
  picker.init(b.context, 'Upload folder', 2);
  assert.equal(await picker.isModeSupported(2), true);
  b.reply({ directory: { name: 'chosen', files: [
    { path: 'one/café.bin', base64: 'AP+AQQ==' },
    { path: 'two/café.bin', base64: 'AQID' },
    { path: 'empty.bin', base64: '' },
  ] } });
  let result;
  picker.open({ done(code) { result = code; } });
  await b.flush();
  assert.equal(result, 0);
  assert.deepEqual(b.directories, ['ProfD']);
  assert.equal(b.calls[0].directory, true);
  const root = picker.domFileOrDirectory;
  assert.equal(root.name, 'chosen');
  assert.deepEqual(b.disk.get(`${root.path}/one/café.bin`).bytes, [0, 255, 128, 65]);
  assert.deepEqual(b.disk.get(`${root.path}/two/café.bin`).bytes, [1, 2, 3]);
  assert.deepEqual(b.disk.get(`${root.path}/empty.bin`).bytes, []);
  b.page.dispatchEvent(new Event('pagehide'));
  assert.equal(b.disk.has(root.path), false);
});

test('invalid directory reply is cancelled and its partial guest tree removed', async () => {
  const b = bridge(), picker = b.picker('file');
  picker.init(b.context, '', 2);
  b.reply({ directory: { name: 'chosen', files: [
    { path: 'good.txt', base64: 'YQ==' }, { path: '../escape.txt', base64: 'Yg==' },
  ] } });
  let result;
  picker.open({ done(code) { result = code; } });
  await b.flush();
  assert.equal(result, 1);
  assert.equal(picker.domFileOrDirectory, null);
  assert.deepEqual([...b.disk.keys()], ['/tmp']);
});

test('navigation during directory staging cancels and removes late bytes', async () => {
  const b = bridge(), picker = b.picker('file');
  picker.init(b.context, '', 2);
  b.reply({ directory: { name: 'chosen', files: [
    { path: 'first.bin', base64: 'AA==' }, { path: 'second.bin', base64: 'AQ==' },
  ] } });
  b.onWrite(() => b.page.dispatchEvent(new Event('pagehide')));
  let result;
  picker.open({ done(code) { result = code; } });
  await b.flush();
  assert.equal(result, 1);
  assert.deepEqual([...b.disk.keys()], ['/tmp']);
});

test('native file picker returns binary DOM Files and preserves metadata, never paths', async () => {
  const b = bridge(), picker = b.picker('file');
  picker.init(b.context, 'Upload', 3);
  picker.appendRawFilter('.bin');
  picker.appendFilter('Binary files', '*.bin');
  b.reply({ files: [{ name: '/secret/private/payload.bin', type: 'application/octet-stream',
    lastModified: 1234, base64: 'AP+AQQ==' }, { name: 'empty.bin', type: '', lastModified: 0, base64: '' }] });
  const results = [];
  picker.open({ done: code => results.push(code) });
  assert.equal(b.calls.length, 0, 'open must finish before completion can run');
  await b.flush();
  assert.deepEqual(results, [0]);
  assert.equal(b.calls[0].accept, '.bin');
  const files = picker.domFileOrDirectoryEnumerator;
  const first = files.getNext(), second = files.getNext();
  assert.equal(first.name, 'payload.bin');
  assert.equal(first.type, 'application/octet-stream');
  assert.equal(first.lastModified, 1234);
  assert.deepEqual([...new Uint8Array(await first.arrayBuffer())], [0, 255, 128, 65]);
  assert.equal(second.size, 0);
  assert.equal(files.hasMoreElements(), false);
});

test('large uploads request bounded chunks in order and preserve all bytes', async () => {
  const b = bridge(), picker = b.picker('file');
  picker.init(b.context, 'Large file', 0);
  const bytes = Buffer.alloc(65536 * 3 + 17);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  b.reply({ files: [{ name: 'large.bin', type: 'application/octet-stream',
    lastModified: 101, base64: bytes.toString('base64') }] });
  let code;
  picker.open({ done(value) { code = value; } });
  await b.flush();
  assert.equal(code, 0);
  assert.deepEqual(b.chunks.map(chunk => chunk.offset), [0, 65536, 131072, 196608]);
  assert.deepEqual(Buffer.from(await picker.domFileOrDirectory.arrayBuffer()), bytes);
});

test('a later file read failure cancels the whole selection without partial files', async () => {
  const b = bridge(), picker = b.picker('file');
  picker.init(b.context, 'Files', 3);
  b.reply({ files: [
    { name: 'first.bin', base64: 'AQID' },
    { name: 'second.bin', base64: 'BAUG' },
  ] });
  b.onWrite(path => { if (path.endsWith('/1')) throw new Error('read denied'); });
  let code;
  picker.open({ done(value) { code = value; } });
  await b.flush();
  assert.equal(code, 1);
  assert.equal(picker.selected.length, 0);
  assert.deepEqual([...b.disk.keys()], ['/tmp']);
});

test('single-file mode restricts the result and cancellation cannot attach files', async () => {
  const b = bridge(), picker = b.picker('file');
  picker.init(b.context, 'Upload', 0);
  b.reply({ files: [{ name: 'one.txt', base64: 'YQ==' }, { name: 'two.txt', base64: 'Yg==' }] });
  picker.open({ done() {} }); await b.flush();
  assert.equal(picker.selected.length, 1);
  const cancelled = b.picker('file'); cancelled.init(b.context, '', 0);
  b.reply({ files: [{ name: 'late.txt', base64: 'YQ==' }] }, () => b.page.dispatchEvent(new Event('pagehide')));
  let result;
  cancelled.open({ done(code) { result = code; } }); await b.flush();
  assert.equal(result, 1);
  assert.equal(cancelled.domFileOrDirectory, null);
  assert.equal(b.cancelled.length, 1);
});

test('native color callback commits valid RGB and cancels invalid/missing values', () => {
  const b = bridge(), picker = b.picker('color'), results = [];
  picker.init(b.context, 'Color', '#000000', []);
  for (const value of [{ value: '#AA88FF' }, { value: 'invalid' }, null]) {
    b.reply(value); picker.open({ done: color => results.push(color) }); b.flush();
  }
  assert.deepEqual(results, ['#aa88ff', '', '']);
});

test('date actor cancellation and destruction suppress late values', () => {
  for (const destroy of [false, true]) {
    const b = bridge(), parent = new b.Parent();
    b.reply({ value: '2026-10-05' }, () => destroy ? parent.didDestroy() : parent.receiveMessage({ name: 'InputPicker:Close' }));
    parent.receiveMessage({ name: 'InputPicker:Open', data: { type: 'date', detail: { value: '' } } });
    assert.equal(b.cancelled.length, 1);
    assert.equal(b.sent.some(item => item.name === 'InputPicker:ValueChanged'), false);
    assert.equal(b.sent.length, destroy ? 0 : 1);
  }
});

test('date child uses Gecko user input and forwards raw HTML constraints', () => {
  const b = bridge(), child = new b.Child(), values = [];
  const input = { value: '2026-10-05', min: '2026-10-01', max: '', step: '2',
    getAttribute: () => '2026-10-03', setUserInput: value => values.push(value) };
  assert.equal(child.openPickerImpl(input).stepBase, '2026-10-03');
  child.pickerValueChangedImpl({ data: { value: '2026-10-07' } }, input);
  assert.deepEqual(values, ['2026-10-07']);
});

test('inactive browsing contexts cannot open date pickers', () => {
  const b = bridge(), parent = new b.Parent();
  b.context.canOpenModalPicker = false;
  parent.receiveMessage({ name: 'InputPicker:Open', data: { type: 'date', detail: {} } });
  assert.equal(b.calls.length, 0);
  assert.equal(b.sent[0].name, 'InputPicker:Closed');
});
