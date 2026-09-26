// Math.min/max over integer indices (MMinMax with Int32/IntPtr operands): was
// emitted as invalid wasm (select with 1 stack value) -> V8 rejected the whole
// module -> function silently stayed in PBL. Also exercises the IntPtr Add/Sub
// (index arithmetic) path.
class Benchmark {
  setup() { this.n = 300000; this.arr = new Int32Array(1024); for (let i = 0; i < 1024; i++) this.arr[i] = (i * 37) & 1023; }
  runIteration() {
    let s = 0;
    for (let i = 0; i < this.n; i++) {
      const a = Math.min(i & 1023, (i * 7) & 1023);
      const b = Math.max(i & 1023, (i * 13) & 1023);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      s = (s + this.arr[lo] + this.arr[hi] + (hi - lo)) | 0;
    }
    this.s = s;
  }
  result() { return this.s | 0; }
}
