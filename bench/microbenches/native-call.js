// Generic native-builtin calls through MCall -> wjhelp(WJH_CALLNATIVE) /
// the WJH_CALL native fast path: Math.round, String/Number/Boolean conversions,
// Map/Set methods, toFixed, charCodeAt, RegExp.test, Array.isArray, parseInt,
// Array.prototype.sort (native that re-enters JS via the comparator).
class Benchmark {
  setup() {
    this.n = 120000;
    this.arr = [];
    this.re = /x(ab+)y/g;
    for (let i = 0; i < 256; i++) this.arr.push((i * 37) & 255);
    this.map = new Map();
    this.set = new Set();
    for (let i = 0; i < 512; i++) { this.map.set(i, i * 7); this.set.add(i & 127); }
    this.strs = ["xay", "xaby", "xabby", "nope", "xaaaabbbby"];
    this.nestArr = this.arr.slice(0, 64);
    this.getterObj = { y: 5, get x() { return Math.round(1.7) + this.y; } };
  }
  runIteration() {
    let s = 0;
    const n = this.n;
    for (let i = 0; i < n; i++) {
      s = (s + Math.round(i * 1.7)) | 0;                 // Math fn (maybe inlined)
      s = (s + String(i & 1023).length) | 0;             // String() conversion
      s = (s + Number("0x" + (i & 255).toString(16))) | 0;
      s = (s + (Boolean(i & 7) ? 1 : 0)) | 0;
      s = (s + parseInt("17") + parseFloat("0.5")) | 0;  // global natives
      s = (s + (Array.isArray(this.arr) ? 2 : 0)) | 0;
      s = (s + this.map.get(i & 511)) | 0;               // Map.get
      this.set.add(i & 255);                             // Set.add
      s = (s + (this.set.has(i & 127) ? 1 : 0)) | 0;
      s = (s + "abcdef".charCodeAt(i & 5)) | 0;          // string natives
      s = (s + "abcdef".indexOf("cd")) | 0;
      s = (s + (i * 0.13).toFixed(2).length) | 0;        // toFixed
      if (this.re.test(this.strs[i % 5])) s = (s + 3) | 0; // RegExpExecForTest
      s = (s + Math.max(i & 255, 100) + Math.min(i & 255, 50)) | 0;
    }
    // sort: native callee + a JS comparator (native->JS reentry)
    const c = this.arr.slice();
    c.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    s = (s + c[0] + c[c.length - 1]) | 0;
    s = (s + c.join(",").length) | 0;                    // join native
    // forEach: the callback is JIT'd and makes its own helper calls while the
    // outer native's call frame is still live (nested scratch staging)
    let acc = 0;
    this.nestArr.forEach((v) => {
      acc = (acc + Math.round(v * 1.3) + (this.map.get(v & 511) | 0)) | 0;
    });
    s = (s + acc + this.getterObj.x) | 0;                // getter -> JS reentry
    this.s = s | 0;
  }
  result() { return this.s | 0; }
}
