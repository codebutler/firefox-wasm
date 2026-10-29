// Deep recursion that alternates wasm-JIT frames with PBL re-entry
// (patch 0015). Each level leaves the JIT through a helper into a native
// (Function.prototype.call, Array.prototype.map) that calls back into JS, so
// the host stack holds JIT frames, glue frames and a PBL activation per level
// while the linear-memory stack -- what SpiderMonkey's recursion quota
// watches -- barely moves. Before 0015 the JIT's depth budget charged only the
// JIT frames, and this overflowed V8's stack with an uncatchable RangeError
// that killed the process. Now it must end in a catchable InternalError (or
// complete), the same in JIT and PBL modes.
class Benchmark {
  setup() {
    this.depth = 200000;
    this.r = 0;
  }
  runIteration() {
    function viaCall(n) {
      return n <= 0 ? 0 : 1 + viaCall.call(null, n - 1);
    }
    function viaMap(n) {
      return n <= 0 ? 0 : 1 + [n - 1].map(viaMap)[0];
    }
    let r = 0;
    for (const f of [viaCall, viaMap]) {
      for (let i = 0; i < 200; i++) r = (r + f(8)) | 0; // warm: compile f
      try {
        r = (r + f(this.depth)) | 0;
      } catch (e) {
        r = (r + (e instanceof InternalError ? 1 : 1000)) | 0;
      }
    }
    this.r = r;
  }
  result() {
    return this.r;
  }
}
