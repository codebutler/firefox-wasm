import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { Worker } from 'node:worker_threads';
import vm from 'node:vm';
const source = stripTypeScriptTypes(readFileSync(new URL('./js/save-assembly.ts', import.meta.url), 'utf8'));
const { SAVE_ASSEMBLER_SOURCE } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('save assembly transfers large binary chunks and returns an exact typed Blob, including empty files', async () => {
  const worker = new Worker(`const {parentPort}=require('node:worker_threads');
    globalThis.self={postMessage:(...args)=>parentPort.postMessage(...args)};
    ${SAVE_ASSEMBLER_SOURCE}
    parentPort.on('message',data=>self.onmessage({data}));`, {eval: true});
  try {
    for (const size of [0, 8 * 1024 * 1024]) {
      const expected = Uint8Array.from({length: size}, (_, i) => i % 256);
      const chunks = [];
      for (let offset = 0; offset < size; offset += 65536) chunks.push(expected.slice(offset, offset + 65536));
      const result = new Promise((resolve, reject) => {worker.once('message', resolve); worker.once('error', reject);});
      worker.postMessage({chunks, type: 'application/octet-stream'}, chunks.map(chunk => chunk.buffer));
      assert.ok(chunks.every(chunk => chunk.byteLength === 0));
      const {blob} = await result;
      assert.equal(blob.type, 'application/octet-stream');
      assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), expected);
    }
  } finally {await worker.terminate();}
});

test('aborting assembly releases worker resources and never returns a late payload', async () => {
  let terminated = 0, revoked = 0, worker;
  class PendingWorker {constructor() {worker = this;} postMessage() {} terminate() {terminated++;}}
  const context = vm.createContext({Worker: PendingWorker, Blob,
    URL: {createObjectURL() {return 'blob:save';}, revokeObjectURL() {revoked++;}}});
  vm.runInContext(source.replace(/export /g, ''), context);
  const controller = new AbortController();
  const pending = context.assembleSave([new Uint8Array([1])], '', controller.signal);
  controller.abort(new Error('navigated'));
  await assert.rejects(pending, /navigated/);
  assert.equal(terminated, 1); assert.equal(revoked, 1);
  worker.onmessage({data: {blob: new Blob(['late'])}});
  await assert.rejects(pending, /navigated/);
});
