// Patch 0027: a JIT-compiled sloppy function that has a CallObject (a closure
// captures a local) and uses `arguments` builds a mapped arguments object whose
// MAYBE_CALL_SLOT must hold that CallObject. The JIT staged the env it was
// called with instead (the enclosing scope), so the slot held
// ObjectValue(nullptr), and the first full GC to mark a surviving arguments
// object read through it ("memory access out of bounds"). Keeps the objects
// alive across full GCs. Expected: ARGSCALLOBJ_BAD=0.
function f(a, b) {
  var c = a;
  var g = function () { return c; };
  var ar = arguments;
  return g() === a && ar[1] === b ? ar : null;
}
function run() {
  var kept = [], bad = 0;
  for (var i = 0; i < 20000; i++) {
    var ar = f({ id: i }, i);
    if (!ar) bad++;
    else if (i % 50 === 0) kept.push(ar);
    if (i % 5000 === 4999) gc();
  }
  for (var j = 0; j < kept.length; j++) if (kept[j][1] !== j * 50) bad++;
  return bad;
}
print("ARGSCALLOBJ_BAD=" + run());
