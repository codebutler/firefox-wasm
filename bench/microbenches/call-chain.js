// Deep hot caller->callee chains: step() calls 16 leaf fns per iteration.
// With GECKO_WJ_COHORT>=17 every edge in the chain resolves inside one
// wasm instance (same-instance call_indirect); solo mode = cross-instance.
class Benchmark {
  setup() { this.n = 120000; }
  runIteration() {
    let a = 1 | 0;
    for (let i = 0; i < this.n; i++) a = step(a) | 0;
    this.a = a | 0;
  }
  result() { return this.a | 0; }
}
function c0(a) { return (a ^ 7) + 3 | 0; }
function c1(a) { return (a ^ 11) + 5 | 0; }
function c2(a) { return (a ^ 13) + 7 | 0; }
function c3(a) { return (a ^ 17) + 11 | 0; }
function c4(a) { return (a ^ 19) + 13 | 0; }
function c5(a) { return (a ^ 23) + 17 | 0; }
function c6(a) { return (a ^ 29) + 19 | 0; }
function c7(a) { return (a ^ 31) + 23 | 0; }
function c8(a) { return (a ^ 37) + 29 | 0; }
function c9(a) { return (a ^ 41) + 31 | 0; }
function c10(a) { return (a ^ 43) + 37 | 0; }
function c11(a) { return (a ^ 47) + 41 | 0; }
function c12(a) { return (a ^ 53) + 43 | 0; }
function c13(a) { return (a ^ 59) + 47 | 0; }
function c14(a) { return (a ^ 61) + 53 | 0; }
function c15(a) { return (a ^ 67) + 59 | 0; }
function step(a) {
  return c15(c14(c13(c12(c11(c10(c9(c8(c7(c6(c5(c4(c3(c2(c1(c0(a)))))))))))))))) | 0;
}
