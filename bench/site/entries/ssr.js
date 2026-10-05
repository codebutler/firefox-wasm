// Realistic SSR: render a component tree (built from the site's works/talks data)
// to an HTML string with preact-render-to-string.
import { h } from "preact";
import { renderToString } from "preact-render-to-string";

function Card({ title, tags, year }) {
  return h("article", { class: "card" }, [
    h("h3", null, title),
    h("ul", null, tags.map((t, i) => h("li", { key: i }, t))),
    h("time", null, String(year)),
  ]);
}
function List({ items }) {
  return h("section", null, items.map((it, i) => h(Card, { key: i, ...it })));
}

globalThis.Benchmark = class Benchmark {
  setup() {
    this.items = globalThis.SITE_ITEMS || [];
    this.n = 300;
  }
  runIteration() {
    let s = 0;
    for (let i = 0; i < this.n; i++) {
      const items = this.items.slice(0, 12);
      const html = renderToString(h(List, { items }));
      s = (s + html.length) | 0;
    }
    this.s = s;
  }
  result() { return this.s | 0; }
};
