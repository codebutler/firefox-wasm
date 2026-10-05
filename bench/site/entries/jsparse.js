import * as acorn from "acorn";
import * as parse5 from "parse5";

function collectScripts(html) {
  const doc = parse5.parse(html);
  const out = [];
  (function walk(n) {
    if (n.tagName === "script") {
      const kids = n.childNodes || [];
      const src = kids.map((c) => c.value || "").join("");
      if (src.trim().length > 0) out.push(src);
      return;
    }
    const k = n.childNodes;
    if (k) for (const c of k) walk(c);
  })(doc);
  return out;
}

function countNodes(ast) {
  let n = 0;
  const stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    n++;
    for (const key in node) {
      const v = node[key];
      if (v && typeof v === "object") {
        if (Array.isArray(v)) {
          for (let j = 0; j < v.length; j++)
            if (v[j] && typeof v[j] === "object") stack.push(v[j]);
        } else if (typeof v.type === "string") stack.push(v);
      }
    }
  }
  return n;
}

globalThis.Benchmark = class Benchmark {
  setup() {
    this.srcs = [];
    if (typeof globalThis.SITE_JS === "string" && globalThis.SITE_JS.length)
      this.srcs.push(globalThis.SITE_JS);
    for (const s of collectScripts(globalThis.SITE_HTML)) this.srcs.push(s);
    this.opts = { ecmaVersion: "latest", sourceType: "module", allowHashBang: true };
    this.n = 0;
  }
  runIteration() {
    let total = 0;
    for (const src of this.srcs) {
      let ast = null;
      try { ast = acorn.parse(src, this.opts); } catch (e) {
        try { ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script" }); }
        catch (e2) { total += 1; continue; }
      }
      total += countNodes(ast);
    }
    this.n = total | 0;
  }
  result() { return this.n | 0; }
};
