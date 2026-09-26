function k_strings(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const str = "abc" + (i & 255) + "-def";
    s += str.length + str.indexOf("d") + str.includes("a") * 2;
    s += str.slice(1, 4).length + str.substring(0, 3).length;
    s += str.toUpperCase().length + str.toLowerCase().length;
    s += str.replace("a", "z").length + str.split("-").length;
    s += str.trim().length + str.padStart(10, "0").length;
    s += str.repeat(2).length + str.charCodeAt(1) + str.at(0).length;
    s += str.startsWith("a") + str.endsWith("f") * 2;
  }
  return s;
}
function k_arrays(n) {
  let s = 0;
  const a = [];
  for (let i = 0; i < n; i++) {
    a.push(i & 63);
    if (a.length > 32) a.pop();
    s += a.indexOf(i & 31) + a.includes(i & 15) * 2;
    s += a.join(",").length + a.slice(0, 4).length;
    s += a.filter((x) => x > 10).length + a.map((x) => x + 1).length;
    s += a.reduce((x, y) => x + y, 0);
    s += a.reverse().length; a.reverse();
    s += a.find((x) => x === 5) ? 1 : 0;
    s += a.some((x) => x > 30) ? 1 : 0;
    s += a.every((x) => x < 64) ? 1 : 0;
  }
  return s;
}
function k_object(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const o = { a: i, b: i * 2, c: i & 7 };
    s += o.a + o.b + o.c;
    s += Object.keys(o).length + Object.values(o).length;
    s += Object.entries(o).length + Object.assign({}, o).a;
    s += Object.getPrototypeOf(o) === Object.prototype ? 1 : 0;
    s += "a" in o ? 1 : 0;
    s += o.hasOwnProperty("b") ? 1 : 0;
    s += JSON.stringify(o).length;
    s += Object.is(o.a, i) ? 1 : 0;
  }
  return s;
}
function k_math(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const x = i * 1e-4;
    s += Math.floor(x) + Math.ceil(x) + Math.round(x);
    s += Math.abs(x) + Math.sqrt(x) + Math.cbrt(x + 1);
    s += Math.min(x, 1) + Math.max(x, 1) + Math.atan2(x, 1);
    s += Math.hypot(x, 1) + Math.imul(i, 3);
    s += Math.trunc(x) + Math.sign(x) + Math.fround(x);
    s += Number.parseInt("" + (i & 255), 16) + Number.isInteger(x);
    s += Number.isFinite(x) + Number.isNaN(x);
  }
  return s;
}
function k_regexp(n) {
  let s = 0;
  const re = /(\d+)-(\w+)/;
  const re2 = /a/g;
  for (let i = 0; i < n; i++) {
    const str = "x" + (i & 255) + "-abc";
    const m = re.exec(str);
    if (m) s += m[1].length + m[2].length;
    s += re.test(str) ? 1 : 0;
    s += str.replace(re2, "z").length;
    s += str.match(re) ? 1 : 0;
    s += str.search(/a/) + 1;
  }
  return s;
}
function k_class(n) {
  class Point {
    constructor(x, y) { this.x = x; this.y = y; }
    get norm() { return this.x + this.y; }
    set norm(v) { this.x = v; this.y = v; }
    dist() { return this.x - this.y; }
  }
  let s = 0;
  for (let i = 0; i < n; i++) {
    const p = new Point(i, i * 2);
    s += p.norm + p.dist();
    p.norm = i & 7;
    s += p.x + p.y;
  }
  return s;
}
function k_iter(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const arr = [1, 2, 3, 4, 5];
    for (const v of arr) s += v;
    for (const k in { a: 1, b: 2 }) s += k.length;
    const obj = { x: 1, y: 2 };
    const { x, y } = obj;
    s += x + y;
    const [p, q] = arr;
    s += p + q;
    s += [...arr].length;
    s += JSON.parse('{"n":' + (i & 7) + '}').n;
  }
  return s;
}
function k_typed(n) {
  let s = 0;
  const a = new Float64Array(64);
  const b = new Int32Array(64);
  for (let i = 0; i < n; i++) {
    const j = i & 63;
    a[j] = i * 0.5;
    b[j] = i;
    s += a[j] + b[j];
    s += a.subarray(0, 8).length + b.byteOffset;
    s += a.byteLength + b.length;
    const c = new Uint8Array(16); c.set([1,2,3]);
    s += c[0] + c[1] + c[2];
    s += Array.from(b.slice(0, 4)).length;
  }
  return s;
}
function k_misc(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += (i & 3) ** 2;
    s += ~~(i / 7) + (i >>> 1) + (i << 2) + (i ^ 5) + (i & 15) + (i | 8);
    s += Math.abs(-i) + (+"123") + (-"45");
    s += String(i).length + (i + "").length;
    s += true && false ? 1 : 0;
    s += (i % 3 === 0) ? 2 : 1;
    let t = i;
    t += 1; t -= 1; t *= 2; t /= 2; t %= 100;
    s += t;
    s += i?.toString().length ?? 0;
  }
  return s;
}
function k_try(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    try { if ((i & 1023) === 0) throw new Error("x"); s += i & 7; }
    catch (e) { s += 1; }
    finally { s += 1; }
  }
  return s;
}
class Benchmark {
  setup() { this.n = 30000; }
  runIteration() {
    this.s = (k_strings(this.n) + k_arrays(this.n) + k_object(this.n) + k_math(this.n) +
              k_regexp(this.n) + k_class(this.n) + k_iter(this.n) + k_typed(this.n) +
              k_misc(this.n) + k_try(this.n)) | 0;
  }
  result() { return this.s | 0; }
}
