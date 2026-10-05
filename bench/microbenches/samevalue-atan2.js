// Object.is (MSameValue / MSameValueDouble), Math.atan2 (MAtan2), typed-array
// byteOffset (MArrayBufferViewByteOffset), IntPtr<->Double/Int64 conversions and
// the index guards -- all previously whole-function bails.
class Benchmark {
  setup() { this.n = 200000; this.ab = new ArrayBuffer(256); this.ta = new Uint8Array(this.ab, 32, 64); }
  runIteration() {
    let s = 0;
    const ta = this.ta;
    for (let i = 0; i < this.n; i++) {
      const a = i * 1e-3, b = (i & 7) * 0.5;
      s += Object.is(a, b) ? 1 : 0;           // SameValueDouble
      s += Object.is(ta, ta) ? 1 : 0;         // SameValue
      s += Math.atan2(a, b + 1) > 0 ? 2 : 0;  // Atan2
      s += ta.byteOffset;                     // ArrayBufferViewByteOffset
      s = (s + ta[i & 63]) | 0;               // typed array element access
      s = (s + (i & 1023)) | 0;               // IntPtr index arithmetic
    }
    this.s = s;
  }
  result() { return this.s | 0; }
}
