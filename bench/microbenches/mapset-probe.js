class Benchmark {
  setup() { this.n = 200000; }
  runIteration() {
    const m = new Map();
    const st = new Set();
    let s = 0;
    for (let i = 0; i < this.n; i++) {
      const k = i & 1023;
      m.set(k, i);
      if (m.has(k)) s = (s + m.get(k)) | 0;
      st.add(k);
      if (st.has(k)) s = (s + 1) | 0;
      if ((i & 8191) === 0) { m.delete(k); st.delete(k); }
      s = (s + m.size + st.size) | 0;
    }
    this.s = s;
  }
  result() { return this.s | 0; }
}
