// Regression test for patch 0025: a deopt resume must not read state a GC has
// made stale. Run with GECKO_WJ_RESUMEGC=1, which forces a minor GC inside every
// resume: once at entry and again before each frame's reads (in production a GC
// can run there: ensureHasJitScript, or an inner frame's interpreter run).
// Expected: RESUMEGC_ENV=0 RESUMEGC_ARGS=0 RESUMEGC_NESTED=0.
// Before the patch (the GC hook alone, without the snapshot) the run crashed with
// "memory access out of bounds": the frame's environment, callee and script were
// raw pointers copied from the deopt spill, and the GC had moved the nursery
// CallObject the environment pointed at.
// Each call makes a new lambda, so GuardSpecificFunction deopts on every call
// until its valve recompiles the function after 500 deopts.
function env(a) { var c = a; var g = function () { return c; }; return g() === a ? 0 : 1; }
function args(a) { var c = a; var g = function () { return c; }; var ar = arguments; return g() === a && ar[0] === a ? 0 : 1; }
// The resumed frame's interpreter run calls a second function that also deopts:
// a resume nested inside another (the outer resume's state must survive it).
function inner(b) { var d = b; var h = function () { return d; }; return h() === b ? 0 : 1; }
function nested(a) { var c = a; var g = function () { return c; }; var x = g(); return inner(x) + (x === a ? 0 : 1); }
function run(name, fn) {
  var bad = 0;
  for (var i = 0; i < 3000; i++) bad += fn({ id: i }, i);
  print("RESUMEGC_" + name + "=" + bad);
}
run("ENV", env);
run("ARGS", args);
run("NESTED", nested);
