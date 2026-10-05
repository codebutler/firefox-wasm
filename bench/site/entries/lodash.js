import _ from "lodash";

globalThis.Benchmark = class Benchmark {
  setup() {
    this.words = (globalThis.SITE_TEXT || "").split(" ").filter(Boolean);
    this.items = globalThis.SITE_ITEMS || [];
    this.n = 400;
  }
  runIteration() {
    let s = 0;
    for (let i = 0; i < this.n; i++) {
      const g = _.groupBy(this.words, (w) => w.length % 7);
      s += Object.keys(g).length;
      s += _.uniq(this.words).length;
      s += _.chunk(this.items, 5).length;
      s += _.orderBy(this.items, ["year", "title"], ["desc", "asc"]).length;
      s += _.sumBy(this.items, (it) => it.year) | 0;
      s += _.map(this.items, "title").length;
      s += _.filter(this.items, (it) => it.year > 2022).length;
      s += _.cloneDeep(this.items).length;
      s += _.isEqual(this.items[0], this.items[0]) ? 1 : 0;
      s += _.merge({}, ...this.items.slice(0, 5).map((it) => ({ ...it }))).title.length;
    }
    this.s = s;
  }
  result() { return this.s | 0; }
};
