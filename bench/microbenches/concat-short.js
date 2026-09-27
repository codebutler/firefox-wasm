class Benchmark {
  setup() { this.n = 200000; }
  runIteration() {
    let s = 0;
    let str = "";
    for (let i = 0; i < this.n; i++) {
      str = "ab" + (i & 7) + "cdef" + (i & 3);
      s = (s + str.length) | 0;
    }
    this.s = s;
  }
  result() { return this.s | 0; }
}
