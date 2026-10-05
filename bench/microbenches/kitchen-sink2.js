function p_generators(n) {
  function* gen(k) { for (let i = 0; i < k; i++) yield i * 2; }
  let s = 0;
  for (let i = 0; i < n; i++) {
    for (const v of gen(5)) s += v;
    const it = gen(3); let r;
    while (!(r = it.next()).done) s += r.value;
  }
  return s;
}
function p_async(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    Promise.resolve(i & 7).then((v) => { s += v; });
    const p = Promise.all([Promise.resolve(1), Promise.resolve(2)]);
    p.then((a) => { s += a[0] + a[1]; });
  }
  return s;
}
function p_proto(n) {
  function Base(x) { this.x = x; }
  Base.prototype.getX = function () { return this.x; };
  function Derived(x, y) { Base.call(this, x); this.y = y; }
  Derived.prototype = Object.create(Base.prototype);
  Derived.prototype.getY = function () { return this.y; };
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = new Derived(i, i * 2);
    s += d.getX() + d.getY();
    s += d instanceof Base ? 1 : 0;
    s += "x" in d ? 1 : 0;
  }
  return s;
}
function p_class2(n) {
  class A {
    #priv = 1;
    static s = 5;
    constructor(v) { this.v = v; }
    get val() { return this.v + this.#priv; }
    set val(x) { this.v = x; }
    static make(v) { return new A(v); }
  }
  class B extends A {
    constructor(v) { super(v); }
    get val() { return super.val * 2; }
  }
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = new A(i); s += a.val; a.val = i & 7; s += a.v;
    const b = new B(i); s += b.val;
    s += A.s + A.make(i).v;
  }
  return s;
}
function p_symbol(n) {
  let s = 0;
  const sym = Symbol("k");
  for (let i = 0; i < n; i++) {
    const o = { [sym]: i, normal: i * 2 };
    s += o[sym] + o.normal;
    s += Symbol.keyFor(Symbol.for("g" + (i & 3))) ? 1 : 0;
    const arr = [1, 2, 3];
    s += arr[Symbol.iterator] ? 1 : 0;
    s += typeof sym === "symbol" ? 1 : 0;
  }
  return s;
}
function p_bigint(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = BigInt(i & 255);
    const b = a * 3n + 7n;
    s += Number(b & 0xfn) + Number(b >> 2n);
    s += a < b ? 1 : 0;
    s += BigInt.asIntN(8, b) === b ? 0 : 1;
    s += Number(a ** 2n % 100n);
  }
  return s;
}
function p_args(n) {
  function f() { let s = 0; for (let i = 0; i < arguments.length; i++) s += arguments[i]; return s; }
  function g(a, b, ...rest) { return a + b + rest.length; }
  function h(a, b, c) { return a + b + c; }
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += f(1, 2, 3, i & 7);
    s += g(1, 2, 3, 4, 5);
    s += h.apply(null, [1, 2, i & 3]);
    const bound = h.bind(null, 1, 2);
    s += bound(3);
    s += Math.max(...[1, 2, 3, i & 7]);
    const [x, y = 9, ...z] = [1, undefined, 3, 4];
    s += x + y + z.length;
    const { p = 1, q: qq = 2 } = { p: i & 3 };
    s += p + qq;
  }
  return s;
}
function p_numstr(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const x = i * 0.123456;
    s += x.toFixed(2).length + x.toPrecision(3).length;
    s += (i & 255).toString(16).length + (i & 255).toString(2).length;
    s += Number.parseFloat(x.toFixed(3)) > 0 ? 1 : 0;
    s += "abc".localeCompare("abd") + 1;
    s += "\u00e9".normalize("NFD").length;
    s += "a-b-c".split("-").length + "a-b-c".replaceAll("-", "+").length;
    s += "hello".padEnd(10, ".").length + "  x  ".trimStart().length;
    s += String.fromCharCode(65 + (i & 25));
    s += "abc".codePointAt(1);
    s += [..."ab\u{1F600}"].length;
  }
  return s;
}
function p_switch(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    switch (i & 7) {
      case 0: s += 1; break;
      case 1: case 2: s += 2; break;
      default: s += 3;
    }
    let j = 0;
    do { s += j; j++; } while (j < 3);
    outer: for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) { if (b === 1) continue outer; s += b; }
      if (a === 2) break;
    }
  }
  return s;
}
function p_errors(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    try { throw new TypeError("x" + (i & 3)); }
    catch (e) { s += e.message.length + (e instanceof TypeError ? 1 : 0); }
    const o = { toString() { return "o"; }, valueOf() { return i & 7; } };
    s += "" + o + (o + 1);
    const p = new Proxy({ a: 1 }, { get(t, k) { return t[k]; } });
    s += p.a;
  }
  return s;
}
function p_json(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const o = { a: i, b: [1, 2, 3], c: { d: true } };
    const j = JSON.stringify(o);
    const back = JSON.parse(j);
    s += back.a + back.b.length + (back.c.d ? 1 : 0) + j.length;
    s += JSON.stringify(o, (k, v) => typeof v === "number" ? v + 1 : v).length;
    s += JSON.parse('{"x":1}', (k, v) => typeof v === "number" ? v * 2 : v).x;
  }
  return s;
}
class Benchmark {
  setup() { this.n = 20000; }
  runIteration() {
    this.s = (p_generators(this.n) + p_proto(this.n) + p_class2(this.n) +
              p_symbol(this.n) + p_bigint(this.n) + p_args(this.n) +
              p_switch(this.n) + p_errors(this.n) + p_json(this.n)) | 0;
  }
  result() { return this.s | 0; }
}
