// Regression test for patch 0025: the enclosing environment a deopt resume hands
// to the interpreter must be GC-current. Run with GECKO_WJ_RESUMEGC=1 (a minor GC
// inside every resume). Expected: RESUMEENV=0.
// `inner` closes over `x`, a `let` in a fresh outer call object (a nursery
// object) per call, and reads it only in a branch that is cold when `inner`
// is compiled: the read runs in the interpreter after a type-guard deopt, through
// the enclosing environment the resume supplied. Before the patch the run crashed
// with "memory access out of bounds" (0024 with only the GC hook). Warp still
// emits a FunctionEnvironment for `inner` (its bytecode reads the environment),
// so this exercises the rooted path, not a function without an env root.
var bad = 0;
for (var c = 0; c < 60; c++) {
  // A separate script per round, so each round compiles and deopts afresh.
  var outer = new Function(`
    return function outer(i, a) {
      let x = { v: i };
      function inner(a) {
        var r = a.v + 1;
        if (a.flag) return x.v;
        return r;
      }
      return inner(a);
    };`)();
  for (var i = 0; i < 6000; i++) {
    var flip = i >= 4000 && (i % 50) === 49;
    var a = flip ? { v: "s", flag: true } : { v: i & 7, flag: false };
    var r = outer(i, a);
    if (r !== (flip ? i : (i & 7) + 1)) bad++;
  }
}
print("RESUMEENV=" + bad);
