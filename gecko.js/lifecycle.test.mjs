import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const runtimeSource = readFileSync(new URL('./runtime-lifecycle.js', import.meta.url), 'utf8');
const source = stripTypeScriptTypes(readFileSync(new URL('./js/index.ts', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace('export class Gecko', 'class Gecko').replace('export default Gecko;', '')) + '\nglobalThis.Gecko = Gecko;';
const never = () => new Promise(() => {});
function wrapper(factory = never) {
  const revoked = [], warnings = [], frames = new Map();
  let nextFrame = 0;
  const context = vm.createContext({
    console: {...console, warn(...args) {warnings.push(args);}}, Blob, AbortController, DOMException, TextEncoder, TextDecoder,
    Uint8Array, Int32Array, Atomics, performance, setTimeout, clearTimeout,
    URL: { createObjectURL() { return 'blob:engine'; }, revokeObjectURL(url) { revoked.push(url); } },
    requestAnimationFrame(fn) { frames.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
    fetch: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }),
    geckoSource: '', geckoDataZst: '', assets: {},
    ZSTDDecoder: class { async init() {} },
  });
  vm.runInContext(source, context);
  context.factory = factory;
  vm.runInContext('loadEngine = async () => factory', context);
  const canvas = { width: 20, height: 20, getContext() { return {}; }, style: {} };
  return { g: new context.Gecko({canvas, wasm: {url: '/engine.wasm'}, forwardInput: false}), revoked, frames, warnings };
}

test('a runtime hook failure cannot interrupt wrapper resource release', () => {
  const {g, revoked, warnings} = wrapper();
  g.mod = {geckoDispose() {throw Error('bad runtime hook');}};
  g.engineUrl = 'blob:engine';
  g.destroy();
  assert.equal(g.mod, null);
  assert.equal(g.engineUrl, null);
  assert.deepEqual(revoked, ['blob:engine']);
  assert.equal(warnings.length, 1);
});

test('destroy during unresolved factory cancels init and releases early runtime', async () => {
  let module, stopped = 0, started;
  const reached = new Promise(r => started = r);
  const {g, revoked} = wrapper(options => {
    // The generated pthread loader uses this method to forward print handlers.
    assert.equal(options.propertyIsEnumerable('print'), true);
    module = options; options.geckoDispose = () => stopped++;
    started(); return never();
  });
  const pending = g.init();
  await reached;
  g.destroy(); g.destroy();
  await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(stopped, 1);
  assert.equal(g.mod, null); assert.equal(g.startingModule, null);
  assert.deepEqual(revoked, ['blob:engine']);
  await assert.rejects(g.init(), {name: 'AbortError'});
});

test('destroy after factory resolves but before READY cancels init', async () => {
  let stopped = 0, module;
  const {g} = wrapper(async options => { module = options; options.geckoDispose = () => stopped++; return options; });
  const pending = g.init();
  while (!g.mod) await new Promise(r => setTimeout(r, 0));
  g.destroy();
  await assert.rejects(pending, {name: 'AbortError'});
  module.print('READY cmd=64');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(stopped, 1); assert.equal(g.cmd, 0); assert.equal(g.mod, null);
});

test('destroy settles in-flight commands, coalesced commands, and paint wait', async () => {
  const {g} = wrapper();
  g.mod = { HEAP32: new Int32Array(new SharedArrayBuffer(100000)), HEAPU8: new Uint8Array(100000), geckoDispose() {} };
  g.cmd = 64;
  const evalResult = g.evalChrome('1+1');
  const first = g.sendMouse({evType: 0, x: 1, y: 1});
  const second = g.sendMouse({evType: 0, x: 2, y: 2});
  await first;
  g.destroy();
  await Promise.all([evalResult, second, g.firstPaint]);
  assert.equal(g.queue.length, 0); assert.equal(g.mod, null);
});

for (const initialized of [false, true]) for (const pthreads of [false, true]) test(`runtime cleanup owns only its resources, initialized=${initialized}, pthreads=${pthreads}`, () => {
  const calls = [];
  const context = { ENVIRONMENT_IS_PTHREAD: false, Module: {}, runtimeInitialized: initialized, ABORT: false,
    PThread: {pthreads: {}, unusedWorkers: [], terminateRuntime() {calls.push('runtime');}, terminateAllThreads() {calls.push('workers');}},
    WISP: {dispose() {calls.push('sockets');}}, JSEvents: {removeAllEventListeners() {calls.push('listeners');}},
    GL: {contexts: pthreads ? {1:{handle:1}} : [null,{handle:1}], deleteContext(h) {calls.push('gl'+h);}},
    specialHTMLTargets: {'#screen':{},screen:{}}, console: {warn() {calls.push('warning');}} };
  vm.runInNewContext(runtimeSource, context);
  context.Module.geckoCleanup.push(() => calls.push('timer'), () => {throw Error('bad cleanup');});
  context.Module.geckoDispose(); context.Module.geckoDispose();
  assert.equal(context.ABORT, true);
  assert.deepEqual(calls, [initialized ? 'runtime' : 'workers', 'warning','timer','sockets','listeners','gl1']);
  assert.deepEqual(Object.keys(context.specialHTMLTargets), []);
  assert.equal(context.Module.canvas, null);
});

test('coarse clock is owned per runtime and stops retaining each heap', () => {
  const timers = new Map(); let id = 0;
  function clock() {
    const library = {};
    const context = { LibraryManager: {library}, mergeInto: Object.assign, Module: {geckoCleanup:[]},
      wasmMemory: {buffer: new SharedArrayBuffer(24)}, _gecko_coarse_now_ptr: () => 8,
      _emscripten_get_now: () => 123, Atomics, BigInt64Array,
      setInterval(fn) {timers.set(++id,fn);return id;}, clearInterval(id) {timers.delete(id);} };
    vm.runInNewContext(readFileSync(new URL('./lib/coarse-clock.js', import.meta.url),'utf8'), context);
    library.gecko_coarse_clock_start(); return context;
  }
  const a=clock(), b=clock(); assert.equal(timers.size,2);
  a.Module.geckoCleanup[0](); assert.equal(timers.size,1);
  for(const tick of timers.values())tick();
  assert.equal(Atomics.load(new BigInt64Array(b.wasmMemory.buffer),1),123000000n);
  b.Module.geckoCleanup[0](); assert.equal(timers.size,0);
});

test('late native prompt/picker completion never allocates or wakes a terminated runtime', async () => {
  const cpp = readFileSync(new URL('./src/embed-chrome.cpp', import.meta.url), 'utf8');
  const body = cpp.slice(cpp.indexOf('  MAIN_THREAD_EM_ASM({') + '  MAIN_THREAD_EM_ASM({'.length,
    cpp.indexOf('  }, json.BeginReading()'));
  for (const rejects of [false, true]) {
    let resolve, reject;
    const pending = new Promise((a,b) => {resolve=a;reject=b;});
    const heap = new Int32Array(new SharedArrayBuffer(128));
    const module = {geckoOnPicker: () => pending, _malloc() {assert.fail('allocation after close');},
      _gecko_prompt_wake() {assert.fail('wake after close');}};
    vm.runInNewContext(body, {Module:module, $0:'{}', $1:0, $2:16, $3:'geckoOnPicker',
      UTF8ToString: value=>value, HEAP32:heap, HEAPU32:heap, HEAPU8:heap, Atomics, TextEncoder, Uint8Array});
    await new Promise(r=>setTimeout(r,0));
    module.geckoDisposed=true;
    if(rejects)reject(Error('cancelled'));else resolve({ok:true,value:'late'});
    await new Promise(r=>setTimeout(r,0));
    assert.equal(heap.some(value=>value!==0),false);
  }
});

test('frame commits continue after firstPaint and stop on disposal', async () => {
  const {g}=wrapper(); let frames=0;
  g.opts.onFrame=()=>frames++;
  g.loadSettled=true;
  g.onPresent(2); await g.firstPaint;
  g.onPresent(601); assert.equal(frames,2);
  g.destroy(); g.onPresent(602); assert.equal(frames,2);
});
test('a throwing frame consumer cannot stop the engine callback', () => {
  const {g}=wrapper();g.opts.onFrame=()=>{throw Error('consumer failed');};
  assert.doesNotThrow(()=>g.onPresent(601));
});
test('software commits follow a successful pixel upload, not empty paint results', () => {
  const {g}=wrapper();const events=[];
  const buffer=new ArrayBuffer(256);
  g.mod={HEAP32:new Int32Array(buffer),HEAPU8:new Uint8Array(buffer)};g.cmd=64;
  g.blitImg={};g.blitDst32=new Uint32Array(1);g.ctx={putImageData(){events.push('pixels');}};
  g.opts.onFrame=()=>events.push('commit');g.blit();assert.deepEqual(events,[]);
  g.mod.HEAP32[(64+12)>>2]=128;g.mod.HEAP32[(64+16)>>2]=4;
  g.blit();assert.deepEqual(events,['pixels','commit']);
});
