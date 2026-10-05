import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { Worker } from 'node:worker_threads';
import vm from 'node:vm';
const source = stripTypeScriptTypes(readFileSync(new URL('./js/picker-encoding.ts', import.meta.url), 'utf8'));
const { PICKER_ENCODER_SOURCE } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('picker reply serialization retains Unicode metadata and large binary payloads off-thread', async () => {
  const worker = new Worker(`const {parentPort}=require('node:worker_threads');
    globalThis.self={postMessage:(...args)=>parentPort.postMessage(...args)};
    ${PICKER_ENCODER_SOURCE}
    parentPort.on('message',data=>self.onmessage({data}));`, { eval: true });
  const value = { files: [{ name: 'café-波.txt', base64: 'AAEC'.repeat(1024 * 1024) }] };
  try {
    const result = new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    worker.postMessage(value);
    const { bytes } = await result;
    assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)), value);
  } finally { await worker.terminate(); }
});

test('aborting a pending encoder terminates its worker and releases the Blob URL', async () => {
  let terminated = 0, revoked = 0;
  class PendingWorker { postMessage() {} terminate() { terminated++; } }
  const context = vm.createContext({ Worker: PendingWorker, Blob,
    URL: { createObjectURL() { return 'blob:encoder'; }, revokeObjectURL() { revoked++; } } });
  vm.runInContext(source.replace(/export /g, ''), context);
  const controller = new AbortController();
  const pending = context.encodePickerReply({ files: [] }, controller.signal);
  controller.abort(new Error('navigated'));
  await assert.rejects(pending, /navigated/);
  assert.equal(terminated, 1); assert.equal(revoked, 1);
});
