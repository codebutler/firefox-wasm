import * as parse5 from "parse5";

function walk(node, out) {
  if (node.nodeName === "#text") {
    out.textLen += node.value.length;
    out.texts.push(node.value);
    return;
  }
  if (node.tagName) {
    out.tags[node.tagName] = (out.tags[node.tagName] || 0) + 1;
    if (node.tagName === "a") {
      const attrs = node.attrs || [];
      for (let i = 0; i < attrs.length; i++) {
        if (attrs[i].name === "href") out.links.push(attrs[i].value);
      }
    }
  }
  const kids = node.childNodes;
  if (kids) for (let i = 0; i < kids.length; i++) walk(kids[i], out);
}

globalThis.Benchmark = class Benchmark {
  setup() { this.html = globalThis.SITE_HTML; this.n = 20; }
  runIteration() {
    let s = 0;
    for (let i = 0; i < this.n; i++) {
      const doc = parse5.parse(this.html);
      const out = { textLen: 0, tags: Object.create(null), links: [], texts: [] };
      walk(doc, out);
      s = (s + out.textLen + out.links.length + Object.keys(out.tags).length) | 0;
    }
    this.s = s;
  }
  result() { return this.s | 0; }
};
