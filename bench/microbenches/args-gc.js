// Regression test for patch 0022: arguments objects and rest arrays must stage
// the GC-current actuals, not the raw wasm params. Expected: ARGSGC=2700000.
function sink(x) { return x && x.v | 0; }
function f(a) {
  var g = function () { return a; };          // captured formal -> NewCallObject
  var n = arguments.length;                    // ArgumentsLength / CreateArgumentsObject
  return sink.apply(null, arguments) + n + (g() === a ? 0 : 1000000);
}
function r(...rest) { var h = function () { return rest; }; return sink.apply(null, rest) + h().length; }
var sum = 0;
for (var i = 0; i < 300000; i++) {
  sum += f({ v: i & 7 }, { w: i });
  sum += r({ v: i & 3 }, i);
}
print("ARGSGC=" + sum);
