import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('./lib/provider-fs.js',import.meta.url),'utf8');
const cases=[
 ['stat',[1,1,0,16,20,24],{isDir:false,size:2}],
 ['read',[1,1,0,16,20,24],new Uint8Array([1,2])],
 ['write',[1,1,0,8,2,16],undefined],
 ['readdir',[1,1,0,32,16],['entry']],
 ['mkdir',[1,1,0,16],undefined],
 ['unlink',[1,1,0,16],undefined],
 ['rename',[1,1,0,4,16],undefined],
];
function fixture(){
 let resolve;
 const work=new Promise(r=>resolve=r),calls=[],heap=new Uint8Array(128);
 const provider=Object.fromEntries(['stat','readFile','writeFile','readdir','mkdir','unlink','rename'].map(name=>[name,()=>work]));
 const Module={geckoCleanup:[],geckoDisposed:false,geckoProviders:{1:provider}};
 const library={};
 const ctx=vm.createContext({Module,LibraryManager:{library},mergeInto:Object.assign,
  HEAPU8:heap,HEAP32:new Int32Array(heap.buffer),HEAPU32:new Uint32Array(heap.buffer),
  UTF8ToString:()=>'/entry',_malloc(){calls.push('malloc');return 64;},
  _emscripten_proxy_finish(){calls.push('finish');},_provider_record_entry(){calls.push('entry');},
  stackSave(){calls.push('stack');return 0;},stackRestore(){},stringToUTF8OnStack(){return 0;},
 });
 vm.runInContext(source,ctx);
 ctx.geckoProv=library.$geckoProv;
 ctx.geckoProviderAwait=library.$geckoProviderAwait;
 return {library,Module,heap,calls,resolve,close(){Module.geckoDisposed=true;for(const cleanup of Module.geckoCleanup.splice(0))cleanup();}};
}
for(const [name,args,reply] of cases)test(`pending provider ${name} settles on close and ignores its late reply`,async()=>{
 const f=fixture();let settled=false;
 const pending=f.library['provider_'+name](...args).finally(()=>settled=true);
 f.close();
 await new Promise(r=>setTimeout(r,0));
 const cancelled=settled;
 // Resolve even on the failing baseline, so the test never leaves dangling work.
 f.resolve(reply);await pending;
 assert.equal(cancelled,true,'teardown must settle without waiting for the provider');
 assert.deepEqual(f.calls,[]);
 assert.equal(f.heap.some(x=>x!==0),false);
});
test('an already closed provider request performs no native work',async()=>{
 const f=fixture();f.close();f.resolve(new Uint8Array([1,2]));
 await f.library.provider_read(1,1,0,16,20,24);
 assert.deepEqual(f.calls,[]);assert.equal(f.heap.some(x=>x!==0),false);
});
test('directory traversal stops while an entry stat is pending',async()=>{
 const f=fixture();f.Module.geckoProviders[1].readdir=async()=>['child'];
 let settled=false;
 const pending=f.library.provider_readdir(1,1,0,32,16).finally(()=>settled=true);
 await new Promise(r=>setTimeout(r,0));
 f.close();await new Promise(r=>setTimeout(r,0));
 const cancelled=settled;f.resolve({isDir:true});await pending;
 assert.equal(cancelled,true);assert.deepEqual(f.calls,[]);
 assert.equal(f.heap.some(x=>x!==0),false);
});
test('a live provider read preserves its result and removes the cancellation hook',async()=>{
 const f=fixture();f.resolve(new Uint8Array([1,2]));
 await f.library.provider_read(1,1,0,16,20,24);
 assert.deepEqual(f.calls,['malloc','finish']);
 assert.deepEqual(Array.from(f.heap.slice(64,66)),[1,2]);
 assert.equal(f.Module.geckoCleanup.length,0);
});
