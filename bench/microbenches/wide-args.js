// Regression test for patch 0023: an arguments object or rest array built for
// a call with more than 8 actuals (the JIT accepts up to kWJMaxArgs = 16) must
// hold every actual. Its bookkeeping (callee, environment, argc, numFormals)
// used to be staged into scratch slots 8-10, over actuals 8-10.
// Expected: WIDEARGS_ARGUMENTS, WIDEARGS_REST and WIDEARGS_FORMALS all 15600000,
// and the same three with 16 actuals (the most the JIT accepts) all 27200000.
// Before the patch the metadata showed up among the actuals (a TypeError when
// the environment object was added, or a wrong sum).
function total(list) { var s = 0; for (var k = 0; k < list.length; k++) s += list[k]; return s; }
function viaArguments() { return total(arguments); }
function viaRest(...rest) { return total(rest); }
function viaFormals(a, b, ...rest) { return a + b + total(rest); }
function run(name, fn, wide) {
  var s = 0;
  try {
    // 12 actuals, 1..12 (sum 78), or 16, 1..16 (sum 136): elements 8-10 are the
    // ones that were overwritten.
    if (wide) {
      for (var i = 0; i < 200000; i++)
        s += fn(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16);
    } else {
      for (var i = 0; i < 200000; i++) s += fn(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12);
    }
    print("WIDEARGS_" + name + "=" + s);
  } catch (e) {
    print("WIDEARGS_" + name + "=threw " + e);
  }
}
run("ARGUMENTS", viaArguments);
run("REST", viaRest);
run("FORMALS", viaFormals);
run("ARGUMENTS16", function () { return total(arguments); }, true);
run("REST16", function (...rest) { return total(rest); }, true);
run("FORMALS16", function (a, b, ...rest) { return a + b + total(rest); }, true);
