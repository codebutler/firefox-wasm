// Script-keyed call IC: fresh closures sharing a JSScript, megamorphic sites,
// .call unwrap, bound fns.
class Benchmark {
  setup() { this.n = 20000; }
  runIteration() {
    let sum = 0;
    function mk(a) { return function (x) { return x + a }; }
    for (let i = 0; i < this.n; i++) {
      const f1 = mk(10), f2 = mk(20), f3 = mk(30);
      sum += f1(1) + f2(2) + f3(3);
      const obj = { v: 7 };
      function get() { return this.v }
      sum += get.call(obj);
      const fns = [mk(1), mk(2), mk(3), mk(4), mk(5), mk(6), mk(7), mk(8), mk(9), mk(10)];
      for (let j = 0; j < 10; j++) sum += fns[j](j);
      const b = get.bind(obj); sum += b();
      function two(a, b) { return (a | 0) + (b | 0) }
      sum += two.call(null, 3);
      sum += two.call(null, 1, 2, 3);
      function st() { return this }
      sum += st.call(5) === 5 ? 1 : 0;
    }
    this.sum = sum;
  }
  result() { return this.sum; }
}
