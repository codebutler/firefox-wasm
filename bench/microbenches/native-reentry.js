// Recursion that re-enters the interpreter through a native at every level
// (patch 0021): Function.prototype.apply, an accessor, a Proxy trap, toJSON,
// an Array.prototype.sort comparator. Each level is a new interpreter
// activation whose frames sit on the host (V8) stack, while the linear-memory
// stack that SpiderMonkey's recursion quota watches moves by an amount that
// depends on the build. With the JIT off this overflowed V8's stack with an
// uncatchable RangeError that killed the process; the nesting cap ends each
// recursion in a catchable InternalError (MICROSUM=8005).
//
//   GECKO_NOWASMJIT=1 GECKO_PBL_STACKKB=65536 node --stack-size=1968 \
//     bench/main.ts __exec bench/microbenches/native-reentry.js \
//     bench/microbenches/micro-driver.js
//
// The embed is built at -O1, so its frames are larger than the optimized
// engine's and node's default 984 KB stack holds fewer than the cap's 320
// levels: hence --stack-size=1968. PBL's default 4 MB heap stack also fills
// first in this harness, which hides the host overflow; GECKO_PBL_STACKKB
// takes it out of the way. With GECKO_HOST_NESTCAP=0 the run then crashes.
class Benchmark {
  setup() {
    this.depth = 100000;
    this.r = 0;
  }
  runIteration() {
    function viaApply(n) {
      return n <= 0 ? 0 : 1 + viaApply.apply(null, [n - 1]);
    }
    const o = {};
    Object.defineProperty(o, "g", {
      get() {
        return viaGetter(o.n - 1);
      },
    });
    function viaGetter(n) {
      if (n <= 0) return 0;
      o.n = n;
      return 1 + o.g;
    }
    const p = new Proxy({}, { get: (t, k) => viaProxy(Number(k)) });
    function viaProxy(n) {
      return n <= 0 ? 0 : 1 + p[n - 1];
    }
    function viaToJSON(n) {
      if (n <= 0) return 0;
      return 1 + Number(JSON.stringify({ toJSON: () => viaToJSON(n - 1) }));
    }
    function viaSort(n) {
      if (n <= 0) return 0;
      let r = 0;
      [1, 2].sort((a, b) => {
        r = viaSort(n - 1);
        return a - b;
      });
      return 1 + r;
    }
    let r = 0;
    for (const f of [viaApply, viaGetter, viaProxy, viaToJSON, viaSort]) {
      for (let i = 0; i < 200; i++) r = (r + f(8)) | 0; // warm
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
