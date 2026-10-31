// Patch 0026: the JIT's per-script tables are keyed by JSScript*. A script that
// dies, or moves under a compacting GC, must not leave its entry where a new
// script at the same address finds it. Compiles many distinct functions, drops
// most, runs a shrinking GC with no JIT frame live, then makes new functions
// that return different values and checks every result. Expected:
// SCRIPTKEYS_BAD=0. GECKO_WJ_NOWEAKSWEEP=1 leaves the tables unswept (A/B).
function make(i, k) { return eval("(function f" + i + "_" + k + "(x) { return x + " + (i * 10 + k) + "; })"); }
function warm(fs, k) {
  var bad = 0;
  for (var r = 0; r < 300; r++)
    for (var i = 0; i < fs.length; i++)
      if (fs[i] && fs[i](r) !== r + i * 10 + k) bad++;
  return bad;
}
var bad = 0, N = 600;
for (var round = 1; round <= 6; round++) {
  var fs = [];
  for (var i = 0; i < N; i++) fs.push(make(i, round));
  bad += warm(fs, round);
  for (var i = 0; i < N; i++) if (i % 3) fs[i] = null;
  gc("shrinking");
  bad += warm(fs, round);
}
print("SCRIPTKEYS_BAD=" + bad);
