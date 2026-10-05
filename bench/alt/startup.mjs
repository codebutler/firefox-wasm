// Measure embed startup breakdown: wasm fetch/compile, instantiate+JS_Init,
// self-hosted code init, first script eval. This isolates the "page load"
// cost that snapshots (Wizer-style) would attack.
import { createRequire } from 'module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const EMBED_DIR = path.join(ROOT, 'bench/spidermonkey.js/build');

const ROUNDS = parseInt(process.env.STARTUP_ROUNDS || '10', 10);
const results = [];
for (let i = 0; i < ROUNDS; i++) {
  const t0 = performance.now();
  const createEmbed = require(path.join(EMBED_DIR, 'embed.js'));
  const tReq = performance.now();
  const M = await createEmbed({ noInitialRun: true, print: () => {}, printErr: () => {} });
  const tInit = performance.now();
  // callMain with a tiny script -> engine + context + first eval path warm
  M.callMain([path.join(ROOT, 'bench/alt/startup-probe.js')]);
  const tEval = performance.now();
  results.push({ req: tReq - t0, init: tInit - tReq, eval: tEval - tInit, total: tEval - t0 });
}
const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
console.log(`rounds=${ROUNDS}`);
console.log(`round0 (cold): init=${results[0].init.toFixed(1)}ms eval=${results[0].eval.toFixed(1)}ms total=${results[0].total.toFixed(1)}ms`);
console.log(`require(embed.js) median=${med(results.map(r => r.req)).toFixed(1)}ms`);
console.log(`createEmbed (wasm compile+instantiate+JS_Init) median=${med(results.map(r => r.init)).toFixed(1)}ms`);
console.log(`callMain(first eval) median=${med(results.map(r => r.eval)).toFixed(1)}ms`);
console.log(`total median=${med(results.map(r => r.total)).toFixed(1)}ms`);
const wasmSize = fs.statSync(path.join(EMBED_DIR, 'embed.wasm')).size;
console.log(`embed.wasm=${(wasmSize / 1e6).toFixed(1)}MB`);
