// Realistic client-side search: tokenize the page text, build an inverted index,
// then run many queries (prefix + AND + ranking). Pure JS over real content.
function tokens(text) {
  const out = [];
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) cur += text[i];
    else if (cur) { out.push(cur); cur = ""; }
  }
  if (cur) out.push(cur);
  return out;
}

globalThis.Benchmark = class Benchmark {
  setup() {
    this.text = globalThis.SITE_TEXT || "";
    this.words = tokens(this.text);
    this.n = 300;
  }
  runIteration() {
    // build index
    const idx = new Map();
    for (let i = 0; i < this.words.length; i++) {
      const w = this.words[i];
      let post = idx.get(w);
      if (!post) { post = []; idx.set(w, post); }
      post.push(i);
    }
    let s = idx.size;
    // query
    for (let q = 0; q < this.n; q++) {
      const w = this.words[(q * 7) % this.words.length];
      const post = idx.get(w);
      if (post) s += post.length;
      const pref = w.slice(0, 2);
      let hits = 0;
      for (const k of idx.keys()) if (k.startsWith(pref)) hits += idx.get(k).length;
      s += hits;
    }
    this.s = s;
  }
  result() { return this.s | 0; }
};
