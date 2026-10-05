function r_tostring(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const o = { valueOf() { return i & 7; }, toString() { return "o" + (i & 3); } };
    s += o + 1; s += o * 2; s += "" + o; s += o < 5 ? 1 : 0;
    const sp = { [Symbol.toPrimitive](h) { return h === "number" ? (i & 3) : "p" + (i & 3); } };
    s += sp + 1; s += `${sp}`.length;
    s += Number(o) + String(o).length;
  }
  return s;
}
function r_getters(n) {
  let s = 0;
  const proto = { get g() { return 42; }, set g(v) { this._g = v; }, m() { return 7; } };
  for (let i = 0; i < n; i++) {
    const o = Object.create(proto);
    o.g = i & 7;
    s += o.g + o._g + o.m();
    const o2 = { get x() { return i & 3; } };
    s += o2.x;
  }
  return s;
}
function r_customiter(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const it = {
      [Symbol.iterator]() {
        let k = 0;
        return { next: () => k < 4 ? { value: k++, done: false } : { value: undefined, done: true },
                 return: () => ({ done: true }) };
      },
    };
    for (const v of it) { s += v; if (v === 2) break; }
    s += [...it].length;
    const [a, b] = it;
    s += a + b;
  }
  return s;
}
function r_hasinstance(n) {
  class Even {
    static [Symbol.hasInstance](x) { return x % 2 === 0; }
  }
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += (i % 4) instanceof Even ? 1 : 0;
    const o = { [Symbol.toStringTag]: "Custom" };
    s += Object.prototype.toString.call(o).length;
  }
  return s;
}
function r_spreadcall(n) {
  let s = 0;
  function add3(a, b, c) { return a + b + c; }
  for (let i = 0; i < n; i++) {
    const args = [1, 2, i & 3];
    s += add3(...args);
    s += Reflect.apply(add3, null, args);
    s += add3.apply(null, args);
    s += Math.max(...args);
    const { length } = args; s += length;
    s += [...args, 4].length;
    s += JSON.stringify({ ...{ a: 1 }, b: 2 }).length;
    const merged = Object.assign({}, ...args.map((x) => ({ ["k" + x]: x })));
    s += Object.keys(merged).length;
  }
  return s;
}
function r_es2023(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = [3, 1, 2, i & 3];
    s += a.toSorted((x, y) => x - y).length;
    s += a.toReversed().length;
    s += a.toSpliced(1, 2).length;
    s += a.with(0, 9).length;
    s += a.findLast((x) => x > 1) + 1;
    s += a.findLastIndex((x) => x > 1) + 1;
    s += [1, 2, 3, 4].group ? 0 : 0;
    s += Array.prototype.at.call(a, -1);
    const obj = { a: 1, b: 2, c: 3 };
    s += Object.entries(obj).length + Object.values(obj).length;
  }
  return s;
}
function r_regexp2(n) {
  let s = 0;
  const re = /(?<y>\d{4})-(?<m>\d{2})/;
  const sticky = /a/y;
  for (let i = 0; i < n; i++) {
    const str = "2020-01 abc";
    const m = re.exec(str);
    if (m) s += m.groups.y.length + m.groups.m.length;
    s += re.test(str) ? 1 : 0;
    sticky.lastIndex = 0;
    s += sticky.test(str) ? 1 : 0;
    s += str.split(re).length;
    s += "a1b2c3".replace(/\d/g, (d) => String.fromCharCode(64 + Number(d))).length;
    s += "aaa".matchAll(/a/g) ? 1 : 0;
  }
  return s;
}
function r_optchain(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const o = i % 2 ? { a: { b: { c: i } } } : null;
    s += o?.a?.b?.c ?? -1;
    s += o?.a?.b?.d ?? -2;
    const f = i % 2 ? { m() { return i; } } : null;
    s += f?.m?.() ?? -3;
    const arr = i % 2 ? [i] : null;
    s += arr?.[0] ?? -4;
    s += (o ?? {}).a?.b?.c ?? -5;
    let x = null;
    x ??= i & 7; s += x;
    let y = 0;
    y ||= i & 3; s += y;
    let z = 5;
    z &&= i & 1; s += z;
  }
  return s;
}
class Benchmark {
  setup() { this.n = 15000; }
  runIteration() {
    this.s = (r_tostring(this.n) + r_getters(this.n) + r_customiter(this.n) + r_hasinstance(this.n) +
              r_spreadcall(this.n) + r_es2023(this.n) + r_regexp2(this.n) + r_optchain(this.n)) | 0;
  }
  result() { return this.s | 0; }
}
