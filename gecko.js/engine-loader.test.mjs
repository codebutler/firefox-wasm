import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moduleGlue } from './module-glue.mjs';

const source = `
var calls = 0;
var createGecko = async function() {
  var ENVIRONMENT_IS_NODE = globalThis.process?.versions?.node && globalThis.process?.type != "renderer";
  return { calls: ++calls, node: ENVIRONMENT_IS_NODE, spawn(pthreadMainJs) { return new Worker(pthreadMainJs, { name: 'em-pthread-test' }); } };
};
var isPthread = globalThis.name?.startsWith('em-pthread');
isPthread && createGecko();
`;
const load = tag => import('data:text/javascript;base64,' + Buffer.from(moduleGlue(source)).toString('base64') + '#' + tag);

test('module factories remain independent and imports never start pthreads', async () => {
  const oldName = globalThis.name;
  globalThis.name = 'em-pthread-test';
  try {
    const [first, second] = await Promise.all([load('first'), load('second')]);
    const result = await first.default();
    assert.equal(result.calls, 1);
    assert.equal(result.node, false);
    assert.equal((await second.default()).calls, 1);
    assert.equal((await first.startPthread()).calls, 2);
    assert.equal(typeof globalThis.process.versions.node, 'string');
  } finally { globalThis.name = oldName; }
});

test('the generated worker constructor explicitly selects module workers', async () => {
  const Worker = globalThis.Worker;
  globalThis.Worker = class { constructor(url, options) { this.url = url; this.options = options; } };
  try {
    const module = await load('workers');
    const worker = (await module.default()).spawn('engine.mjs');
    assert.deepEqual(worker.options, { type: 'module', name: 'em-pthread-test' });
    assert.equal(worker.url, 'engine.mjs');
  } finally { globalThis.Worker = Worker; }
});

test('a changed linked runtime fails the conversion before publishing', () => {
  assert.throws(() => moduleGlue(source.replace('new Worker(pthreadMainJs, {', 'new Worker(other, {')), /worker constructor/);
});
