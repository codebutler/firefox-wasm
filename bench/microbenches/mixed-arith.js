// Mixed int/double arithmetic over loop-carried Int32 phis. `s + h` (both Int32
// phis) makes Warp materialize a *Double* MAdd over the raw Int32 operands (the
// same shape string-ops hits); the backend used to emit f64.add on the i32 local
// -- INVALID wasm that V8 rejects for the WHOLE module, silently dropping the
// function to PBL. Now the Int32 operand is converted (f64.convert_i32_s).
class Benchmark {
  setup() { this.n = 200000; }
  runIteration() {
    let s = 0;
    let h = 0;
    for (let i = 0; i < this.n; i++) {
      h = (h * 31 + (i & 255)) | 0;
      s = (s + h + (s < h ? 1 : 0)) | 0;
    }
    this.s = s;
    this.h = h;
  }
  result() { return (this.s ^ this.h) | 0; }
}
