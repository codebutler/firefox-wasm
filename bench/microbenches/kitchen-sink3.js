function q_arrmethods(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = [5, 3, 8, 1, 9, 2, i & 7];
    a.sort((x, y) => x - y);
    s += a[0] + a[a.length - 1];
    s += a.findIndex((x) => x > 4) + a.indexOf(3);
    s += a.concat([1, 2]).length + a.slice(1, 3).length;
    s += a.fill(0, 1, 2).length; a.fill(i & 3);
    s += a.copyWithin(0, 2, 4).length;
    s += a.splice(0, 2).length; a.splice(0, 0, i & 3);
    s += a.reduceRight((x, y) => x + y, 0);
    s += [1, [2, [3]]].flat(2).length + [1, 2].flatMap((x) => [x, x]).length;
    s += Array.of(1, 2, 3).length + Array.from({ length: 3 }, (_, k) => k).length;
    s += a.includes(5) ? 1 : 0;
    s += a.lastIndexOf(2) + 1;
    s += a.reverse().length; a.reverse();
  }
  return s;
}
function q_strmethods(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const str = "Hello World " + (i & 7);
    s += str.charCodeAt(0) + str.codePointAt(1);
    s += str.slice(-3).length + str.substr(1, 3).length;
    s += str.indexOf("o", 5) + str.lastIndexOf("o");
    s += str.split(" ", 2).length + str.split("").length;
    s += str.replace(/o/g, "0").length + str.replaceAll("l", "L").length;
    s += str.trimEnd().length + str.trimStart().length;
    s += str.at(-1).length + str.padStart(20, "*").length;
    s += str.startsWith("He") + str.endsWith("7") + str.includes("World");
    s += "ABC".toLowerCase().length;
    s += str.repeat(2).length + String.fromCharCode(65 + (i & 3));
    s += String.raw`a\nb`.length;
  }
  return s;
}
function q_math2(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const x = (i & 255) / 17;
    s += Math.clz32(i) + Math.imul(i, 7);
    s += Math.expm1(x) + Math.log1p(x) + Math.log2(x + 1) + Math.log10(x + 1);
    s += Math.sinh(x) + Math.cosh(x) + Math.tanh(x);
    s += Math.asinh(x) + Math.acosh(x + 1) + Math.atanh(x / 300);
    s += Math.hypot(x, 1, 2);
    s += Math.pow(x, 2) + x ** 3;
  }
  return s;
}
function q_date2(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = new Date(1600000000000 + (i & 1023) * 86400000);
    s += d.getTime() + d.getFullYear() + d.getMonth() + d.getDate();
    s += d.getDay() + d.getHours() + d.getMinutes() + d.getSeconds();
    s += d.getMilliseconds() + d.getTimezoneOffset();
    s += Date.UTC(2020, i & 11, (i & 27) + 1);
    s += Date.parse("2020-01-01T00:00:00Z");
    const d2 = new Date(); d2.setTime(1600000000000 + i);
    s += d2.getFullYear();
  }
  return s;
}
function q_typed2(n) {
  let s = 0;
  const a = new Float64Array(128);
  const b = new Int32Array(128);
  for (let i = 0; i < n; i++) {
    const j = i & 127;
    a[j] = i * 0.5; b[j] = i;
    s += a[j] + b[j];
    s += a.subarray(0, 16).length;
    s += a.slice(0, 8).length;
    s += a.indexOf(i * 0.5) + 1;
    s += a.includes(1.5) ? 1 : 0;
    a.fill(0, 0, 4);
    a.copyWithin(0, 8, 16);
    s += b.reduce((x, y) => x + y, 0) > 0 ? 1 : 0;
    s += Float64Array.from([1, 2, 3]).length;
    s += Float64Array.of(1, 2).length;
    const c = new Uint8Array(8); c.set([1, 2, 3], 2); s += c[2];
    s += new Int16Array(a.buffer, 0, 4).length;
  }
  return s;
}
function q_dataview(n) {
  let s = 0;
  const buf = new ArrayBuffer(64);
  const dv = new DataView(buf);
  for (let i = 0; i < n; i++) {
    dv.setInt32(0, i, true);
    dv.setFloat64(8, i * 0.5, true);
    dv.setUint8(16, i & 255);
    s += dv.getInt32(0, true) + Math.round(dv.getFloat64(8, true)) + dv.getUint8(16);
    s += dv.byteLength + dv.byteOffset;
  }
  return s;
}
function q_reflect(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const o = { a: i };
    Object.defineProperty(o, "b", { value: i * 2, enumerable: true, writable: true });
    Object.defineProperty(o, "c", { get() { return i & 3; }, configurable: true });
    s += o.a + o.b + o.c;
    s += Reflect.get(o, "a") + Reflect.has(o, "b");
    Reflect.set(o, "d", i & 7); s += o.d;
    s += Object.getOwnPropertyNames(o).length;
    s += Object.getOwnPropertyDescriptor(o, "a").value;
    s += Object.getOwnPropertySymbols(o).length;
    s += Reflect.ownKeys(o).length;
    const frozen = Object.freeze({ x: i }); s += frozen.x;
    s += Object.isFrozen(frozen) ? 1 : 0;
    s += Object.seal({ y: 1 }).y;
    s += Object.preventExtensions({ z: 1 }).z;
    s += Object.create(null) ? 1 : 0;
  }
  return s;
}
function q_tagged(n) {
  function tag(strings, ...vals) { return strings.raw.join("|").length + vals.length; }
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += tag`a${i}b${i * 2}c`;
    s += `${i}-${i * 2}`.length;
    s += String(i) + i;
    s += `x${i > 3 ? "big" : "small"}y`.length;
  }
  return s;
}
function q_newtarget(n) {
  function F(v) { this.v = v; this.isNew = new.target !== undefined; }
  let s = 0;
  for (let i = 0; i < n; i++) {
    const f = new F(i);
    s += f.v + (f.isNew ? 1 : 0);
    s += F.call({}, i) === undefined ? 1 : 0;
  }
  return s;
}
class Benchmark {
  setup() { this.n = 15000; }
  runIteration() {
    this.s = (q_arrmethods(this.n) + q_strmethods(this.n) + q_math2(this.n) + q_date2(this.n) +
              q_typed2(this.n) + q_dataview(this.n) + q_reflect(this.n) + q_tagged(this.n) +
              q_newtarget(this.n)) | 0;
  }
  result() { return this.s | 0; }
}
