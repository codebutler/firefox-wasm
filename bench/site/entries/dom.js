import { parseDocument } from "htmlparser2";
import * as cssSelect from "css-select";

globalThis.Benchmark = class Benchmark {
  setup() { this.html = globalThis.SITE_HTML; this.n = 30; }
  runIteration() {
    let s = 0;
    for (let i = 0; i < this.n; i++) {
      const doc = parseDocument(this.html);
      const links = cssSelect.selectAll("a[href]", doc);
      const headings = cssSelect.selectAll("h1, h2, h3", doc);
      const divs = cssSelect.selectAll("div", doc);
      s = (s + links.length * 3 + headings.length + divs.length) | 0;
    }
    this.s = s;
  }
  result() { return this.s | 0; }
};
