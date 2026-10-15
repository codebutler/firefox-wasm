import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { Worker } from 'node:worker_threads';

const source = stripTypeScriptTypes(readFileSync(new URL('./js/picker-stream.ts', import.meta.url), 'utf8'));
const stream = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('picker metadata retains file identity but never serializes payloads', () => {
  const blob = new Blob([Uint8Array.of(0, 255, 1)]);
  const selection = stream.preparePickerStream({ directory: {
    name: 'Tree', files: [{ path: 'sub/波.bin', blob }],
  } }, 'picker-7');
  assert.deepEqual(selection.blobs, [blob]);
  assert.deepEqual(selection.metadata, { session: 'picker-7', directory: {
    name: 'Tree', files: [{ path: 'sub/波.bin', index: 0, size: 3 }],
  } });
  assert.ok(!JSON.stringify(selection.metadata).includes('255'));
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
    const reply = new Promise((resolve, reject) => {
      worker.once('message', resolve); worker.once('error', reject);
    });
    const first = bytes.slice(0, stream.PICKER_CHUNK_SIZE);
    worker.postMessage(first.buffer, [first.buffer]);
    const { base64 } = await reply;
    assert.deepEqual(Buffer.from(base64, 'base64'), Buffer.from(bytes.subarray(0, stream.PICKER_CHUNK_SIZE)));
    assert.equal(stream.preparePickerStream({ files: [{ name: 'empty', blob: new Blob() }] }, 'empty')
      .metadata.files[0].size, 0);
  } finally { await worker.terminate(); }
});
