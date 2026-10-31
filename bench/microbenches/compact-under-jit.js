// Patch 0026: no compacting GC while wasm-JIT frames are live. `hot` holds a
// tenured object (`x`) across a call to `churn`, which drops half the objects,
// runs gc("shrinking") under hot's frame, and refills the arenas a compaction
// would release. Expected: COMPACT_BAD=0 and, with GECKO_WJ_COMPACTDBG, no
// `[wj-compact] relocated ... jitLive=1` line. GECKO_WJ_COMPACTUNDERJIT=1 lets
// those GCs compact (every one relocates arenas); it also prints 0, because the
// JIT keeps values live across calls in traced, relocated roots.
var keep = [];
for (var i = 0; i < 40000; i++) keep.push({ a: { b: i, c: i * 2 } });
gc();
// Drops half the objects and refills, so the shrinking GC has arenas to
// compact, then reports whether it ran under a JIT frame.
var gcInJit = 0;
function churn() {
  for (var j = 0; j < keep.length; j += 2) keep[j] = null;
  for (var j = 0; j < 20000; j++) keep.push({ a: { b: j, c: j * 2 } });
  gc("shrinking");
  if (inWasmJit()) gcInJit++;
  // Refill the arenas a compaction would have released, so a stale pointer
  // reads someone else's object instead of the moved one's old bytes.
  for (var j = 0; j < 60000; j++) junk.push({ b: -7, c: 3 });
}
var junk = [];
function hot(o, i) {
  var x = o.a;
  if (i % 4000 === 3999) churn();
  return x.c - x.b * 2;
}
function run() {
  var bad = 0;
  for (var r = 0; r < 40000; r++) {
    var o = keep[(r * 7 + 1) % keep.length] || keep[1];
    bad += hot(o, r) === 0 ? 0 : 1;
  }
  return bad;
}
print("COMPACT_BAD=" + run() + " GC_UNDER_JIT=" + gcInJit);
