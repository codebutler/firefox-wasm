// Regression test for patch 0022: arguments objects and rest arrays must stage
// the GC-current actuals, not the raw wasm params. A minor GC in the entry
// block (the CallObject's out-of-line allocation) moves the object actuals
// before the arguments object or rest array is built from them.
// Expected: ARGSGC_ARGUMENTS=1650000 ARGSGC_REST=1050000.
// Before 0022 both halves came out short (a stale actual reads a wrong `v`).
function sink(x) { return x && x.v | 0; }
// Non-strict, capturing a local copy rather than the formal: no formal is
// forwarded, so the backend materializes `arguments` itself (a captured formal
// makes it bail to the interpreter instead).
function f(a) {
  var c = a;
  var g = function () { return c; };           // -> NewCallObject (may GC)
  var n = arguments.length;                     // -> CreateArgumentsObject
  return sink.apply(null, arguments) + n + (g() ? 0 : 1);
}
function r(...rest) {
  var h = function () { return rest; };        // -> NewCallObject (may GC)
  return sink.apply(null, rest) + h().length;   // rest built before the call
}
var sa = 0, sr = 0;
for (var i = 0; i < 300000; i++) sa += f({ v: i & 7 }, { w: i });
for (var i = 0; i < 300000; i++) sr += r({ v: i & 3 }, i);
print("ARGSGC_ARGUMENTS=" + sa);
print("ARGSGC_REST=" + sr);
