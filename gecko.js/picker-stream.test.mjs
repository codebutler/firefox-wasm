import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { Worker } from 'node:worker_threads';
import vm from 'node:vm';

const source = stripTypeScriptTypes(readFileSync(new URL('./js/picker-stream.ts', import.meta.url), 'utf8'));
const stream = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('picker metadata retains file identity but never serializes payloads', () => {
  const blob = new Blob([Uint8Array.of(0, 255, 1)]);
  const selection = stream.preparePickerStream({ directory: {
    name: 'Tree', files: [{ path: 'sub/波.bin', source: blob }],
  } }, 'picker-7');
  assert.deepEqual(selection.sources, [blob]);
  assert.deepEqual(selection.metadata, { session: 'picker-7', directory: {
    name: 'Tree', files: [{ path: 'sub/波.bin', index: 0, size: 3 }],
  } });
  assert.ok(!JSON.stringify(selection.metadata).includes('255'));
});

test('invalid later metadata closes range sources already selected', async () => {
  let closes = 0;
  const reader = { size: 3, async read() { return Uint8Array.of(1, 2, 3); },
    async close() { closes++; } };
  assert.throws(() => stream.preparePickerStream({ files: [
    { name: 'first', source: reader }, { name: 'invalid', source: { size: -1 } },
  ] }, 'picker-invalid'), /not a readable source/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes, 1);
});

test('worker encodes only the requested chunk, including binary and an empty file', async () => {
  const worker = new Worker(`const {parentPort}=require('node:worker_threads');
    globalThis.self={postMessage:(...args)=>parentPort.postMessage(...args)};
    ${stream.PICKER_CHUNK_ENCODER_SOURCE}
    parentPort.on('message',data=>self.onmessage({data}));`, { eval: true });
  try {
    const bytes = new Uint8Array(stream.PICKER_CHUNK_SIZE + 2);
    bytes[0] = 0; bytes[1] = 255;
    bytes[bytes.length - 1] = 129;
    worker.postMessage({ kind: 'init', blobs: [new Blob([bytes]), new Blob()] });
    const reply = new Promise((resolve, reject) => {
      worker.once('message', resolve); worker.once('error', reject);
    });
    worker.postMessage({ kind: 'read', index: 0, offset: 0 });
    const { bytes: encoded } = await reply;
    const { data } = JSON.parse(new TextDecoder().decode(encoded));
    assert.deepEqual(Buffer.from(data, 'base64'), Buffer.from(bytes.subarray(0, stream.PICKER_CHUNK_SIZE)));
    const second = new Promise((resolve, reject) => {
      worker.once('message', resolve); worker.once('error', reject);
    });
    worker.postMessage({ kind: 'read', index: 0, offset: stream.PICKER_CHUNK_SIZE });
    assert.deepEqual(Buffer.from(JSON.parse(new TextDecoder().decode((await second).bytes)).data, 'base64'),
      Buffer.from(bytes.subarray(stream.PICKER_CHUNK_SIZE)));
    const empty = new Promise((resolve, reject) => {
      worker.once('message', resolve); worker.once('error', reject);
    });
    worker.postMessage({ kind: 'read', index: 1, offset: 0 });
    assert.equal(JSON.parse(new TextDecoder().decode((await empty).bytes)).data, '');
    assert.equal(stream.preparePickerStream({ files: [{ name: 'empty', source: new Blob() }] }, 'empty')
      .metadata.files[0].size, 0);
  } finally { await worker.terminate(); }
});

test('picker cancellation terminates its worker and rejects an in-flight read', async () => {
  let terminated = 0, revoked = 0;
  class PendingWorker {
    postMessage() {}
    terminate() { terminated++; }
  }
  const context = vm.createContext({ Blob, Worker: PendingWorker,
    URL: { createObjectURL() { return 'blob:picker'; }, revokeObjectURL() { revoked++; } } });
  vm.runInContext(`${source.replace(/export /g, '')}\nglobalThis.PickerChunkEncoder = PickerChunkEncoder;`, context);
  const controller = new AbortController();
  const encoder = new context.PickerChunkEncoder([new Blob([Uint8Array.of(1)])], controller.signal);
  const pending = encoder.read(0, 0);
  await assert.rejects(encoder.read(0, 0), /busy/);
  controller.abort(new Error('navigated'));
  await assert.rejects(pending, /navigated/);
  assert.equal(terminated, 1);
  assert.equal(revoked, 1);
  assert.throws(() => encoder.read(0, 0), /navigated/);
});

test('range-backed files read one bounded chunk and close their source', async () => {
  const requests = [];
  let closes = 0;
  class EncodingWorker {
    postMessage(message) {
      if (message.kind !== 'encode') return;
      queueMicrotask(() => this.onmessage({ data: {
        bytes: new TextEncoder().encode(JSON.stringify({ data: Buffer.from(message.bytes).toString('base64') })),
      } }));
    }
    terminate() {}
  }
  const context = vm.createContext({ Blob, Uint8Array, Worker: EncodingWorker,
    URL: { createObjectURL() { return 'blob:picker'; }, revokeObjectURL() {} } });
  vm.runInContext(`${source.replace(/export /g, '')}\nglobalThis.PickerChunkEncoder = PickerChunkEncoder;`, context);
  const reader = {
    size: 1_000_000_000,
    async read(offset, length) { requests.push({ offset, length }); return Uint8Array.of(0, 255, 7); },
    async close() { closes++; },
  };
  const encoder = new context.PickerChunkEncoder([reader], new AbortController().signal);
  const encoded = await encoder.read(0, 900_000_000);
  assert.deepEqual(Buffer.from(JSON.parse(new TextDecoder().decode(encoded)).data, 'base64'),
    Buffer.from([0, 255, 7]));
  assert.deepEqual(requests, [{ offset: 900_000_000, length: stream.PICKER_CHUNK_SIZE }]);
  encoder.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes, 1);
});

test('two picker sessions keep workers and cancellation independent', async () => {
  let workers = 0, terminations = 0;
  class SessionWorker {
    constructor() { this.id = ++workers; }
    postMessage(message) {
      if (message.kind !== 'read') return;
      queueMicrotask(() => this.onmessage({ data: {
        bytes: new TextEncoder().encode(JSON.stringify({ data: Buffer.from([this.id]).toString('base64') })),
      } }));
    }
    terminate() { terminations++; }
  }
  const context = vm.createContext({ Blob, Worker: SessionWorker,
    URL: { createObjectURL() { return 'blob:picker'; }, revokeObjectURL() {} } });
  vm.runInContext(`${source.replace(/export /g, '')}\nglobalThis.PickerChunkEncoder = PickerChunkEncoder;`, context);
  const firstAbort = new AbortController(), secondAbort = new AbortController();
  const first = new context.PickerChunkEncoder([new Blob([Uint8Array.of(1)])], firstAbort.signal);
  const second = new context.PickerChunkEncoder([new Blob([Uint8Array.of(2)])], secondAbort.signal);
  firstAbort.abort(new Error('first window closed'));
  const response = await second.read(0, 0);
  assert.deepEqual(Buffer.from(JSON.parse(new TextDecoder().decode(response)).data, 'base64'), Buffer.from([2]));
  second.close();
  assert.equal(terminations, 2);
});

test('failed worker initialization releases the session', async () => {
  let terminated = 0, revoked = 0, closes = 0;
  class InitFailureWorker {
    postMessage() { throw new Error('clone failed'); }
    terminate() { terminated++; }
  }
  const context = vm.createContext({ Blob, Worker: InitFailureWorker,
    URL: { createObjectURL() { return 'blob:picker'; }, revokeObjectURL() { revoked++; } } });
  vm.runInContext(`${source.replace(/export /g, '')}\nglobalThis.PickerChunkEncoder = PickerChunkEncoder;`, context);
  const reader = { size: 1, async read() { return Uint8Array.of(1); },
    async close() { closes++; } };
  assert.throws(() => new context.PickerChunkEncoder([reader], new AbortController().signal), /clone failed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(terminated, 1);
  assert.equal(revoked, 1);
  assert.equal(closes, 1);
});

test('synchronous range-reader failure rejects the read and permits cleanup', async () => {
  let terminated = 0, closes = 0;
  class IdleWorker {
    postMessage() {}
    terminate() { terminated++; }
  }
  const context = vm.createContext({ Blob, Worker: IdleWorker,
    URL: { createObjectURL() { return 'blob:picker'; }, revokeObjectURL() {} } });
  vm.runInContext(`${source.replace(/export /g, '')}\nglobalThis.PickerChunkEncoder = PickerChunkEncoder;`, context);
  const reader = { size: 1, read() { throw new Error('I/O failed'); },
    async close() { closes++; } };
  const encoder = new context.PickerChunkEncoder([reader], new AbortController().signal);
  await assert.rejects(encoder.read(0, 0), /I\/O failed/);
  encoder.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(terminated, 1);
  assert.equal(closes, 1);
});
