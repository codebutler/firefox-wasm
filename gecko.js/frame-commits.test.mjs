import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('./lib/gl-present.js',import.meta.url),'utf8').replaceAll('{{{ CMD_CALL_HANDLER }}}',JSON.stringify('callHandler'));
function renderer(continuous){
 const library={},tasks=[],messages=[];
 const context={LibraryManager:{library},mergeInto:Object.assign,Module:{},
   setTimeout(fn){tasks.push(fn);},postMessage(message){messages.push(message);},
   _getenv(name){assert.equal(name,'GECKO_FRAME_COMMITS');return continuous?1:0;},
   stringToUTF8OnStack:s=>s,stackSave:()=>0,stackRestore(){}};
 vm.runInNewContext(source,context);
 return {module:context.Module,messages,async present(){const p=library.gl_present_yield();assert.equal(tasks.length,1);tasks.shift()();await p;}};
}
test('ordinary embedders stop sending present messages after startup',async()=>{
 const r=renderer(false);r.module.__geckoPresentCount=599;
 await r.present();await r.present();assert.equal(r.messages.length,1);assert.equal(r.messages[0].args[0],600);
});
test('compositing embedders receive real commits beyond the startup cap',async()=>{
 const r=renderer(true);r.module.__geckoPresentCount=599;
 await r.present();await r.present();assert.equal(r.messages.length,2);assert.equal(r.messages[1].args[0],601);
});
test('present counts and subscriptions are isolated between renderers',async()=>{
 const a=renderer(true),b=renderer(false);a.module.__geckoPresentCount=600;b.module.__geckoPresentCount=600;
 await a.present();await b.present();assert.equal(a.messages.length,1);assert.equal(b.messages.length,0);
});
