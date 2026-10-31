// Regression test for patch 0024: a deopt resumed in the interpreter past
// JSOp::Arguments must hand the frame its arguments object. In a non-strict
// function whose arguments object aliases the formals, every read of a formal
// goes through that object. Each call makes a new lambda, so the JIT's
// GuardSpecificFunction deopts on every call until its valve (500 deopts)
// recompiles; those 500 calls resume in the interpreter.
// Expected: RESUMEARGS_SAME=0 RESUMEARGS_FIELD=0 RESUMEARGS_LATE=0.
// Before the patch each printed 500: every resumed call read the formals of the
// first resumed call (a stale arguments-object link left in reused frame memory).
function same(a) { var c = a; var g = function () { return c; }; var ar = arguments; return g() === a ? 0 : 1; }
function field(a) { var c = a; var g = function () { return c; }; var ar = arguments; return g().id === a.id ? 0 : 1; }
function late(a) { var ar = arguments; var c = a; var g = function () { return c; }; return g() === a ? 0 : 1; }
function run(name, fn) {
  var bad = 0;
  for (var i = 0; i < 300000; i++) bad += fn({ id: i }, i);
  print("RESUMEARGS_" + name + "=" + bad);
}
run("SAME", same);
run("FIELD", field);
run("LATE", late);
