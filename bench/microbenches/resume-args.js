// Regression test for patch 0024: a deopt resumed in the interpreter past
// JSOp::Arguments must hand the frame its arguments object. In a non-strict
// function whose arguments object aliases the formals, every read of a formal
// goes through that object. Each call makes a new lambda, so the JIT's
// GuardSpecificFunction deopts on every call until its valve (500 deopts)
// recompiles; those 500 calls resume in the interpreter.
// Expected: every RESUMEARGS_* line prints 0.
// Before the patch SAME, FIELD and LATE printed 500: every resumed call read the
// formals of the first resumed call (a stale link left in reused frame memory).
// WRITE and STRICT are controls that printed 0 before the patch too. WRITE
// assigns a formal (JSOp::SetArg): no such function was seen to deopt-resume
// (GECKO_WJ_RESUMEDBG logs none), so the stale SetArg path is not reached
// today; the line catches it if that changes. STRICT: a strict function's
// arguments object does not alias its formals.
function same(a) { var c = a; var g = function () { return c; }; var ar = arguments; return g() === a ? 0 : 1; }
function field(a) { var c = a; var g = function () { return c; }; var ar = arguments; return g().id === a.id ? 0 : 1; }
function late(a) { var ar = arguments; var c = a; var g = function () { return c; }; return g() === a ? 0 : 1; }
// JSOp::SetArg after the deopting call: the write must land in this call's
// arguments object.
function write(a) { var c = a; var g = function () { return c; }; var ar = arguments; var x = g(); a = { id: -1 }; return ar[0] === a ? 0 : 1; }
function strict(a) { "use strict"; var c = a; var g = function () { return c; }; var ar = arguments; return g() === a && ar[0] === a ? 0 : 1; }
function run(name, fn) {
  var bad = 0;
  for (var i = 0; i < 300000; i++) bad += fn({ id: i }, i);
  print("RESUMEARGS_" + name + "=" + bad);
}
run("SAME", same);
run("FIELD", field);
run("LATE", late);
run("WRITE", write);
run("STRICT", strict);
