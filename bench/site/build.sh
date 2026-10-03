#!/usr/bin/env bash
# Bundle the site workloads (real libraries) into single IIFE files the wasm
# SpiderMonkey embed can load. Run fetch.sh first.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
mkdir -p build
if [ ! -d node_modules ]; then
  cat > package.json <<'PKG'
{ "name": "site-bench", "private": true, "version": "1.0.0" }
PKG
  npm install --no-audit --no-fund --silent \
    esbuild@0.24.0 parse5@7.1.2 preact@10.25.4 preact-render-to-string@6.5.13 \
    htmlparser2@9.1.0 css-select@5.1.0 domhandler@5.0.3 lodash@4.17.21 \
    acorn@8.14.0 three@0.170.0
fi
# Pre-convert the vibey app bundle to classic-script form (import.meta ->
# shimmed object) so `new Function(src)` can evaluate it in the embed.
if [ -f data/vibey-app.js ]; then
  npx esbuild data/vibey-app.js --format=iife --outfile=build/vibey-eval.js --log-level=warning
fi
# data-<site>.js: page HTML + extracted text/items as globals for the entries.
# vibey additionally exports SITE_JS (original bundle, for parser benches) and
# SITE_JS_EVAL (iife-converted, for the boot bench).
node -e '
const fs = require("fs"), parse5 = require("parse5");
for (const site of ["home", "wiki", "vibey"]) {
  const html = fs.readFileSync(`data/${site === "home" ? "home" : site}.html`, "utf8");
  const doc = parse5.parse(html);
  const text = [];
  (function walk(n){ if(n.nodeName==="#text"){const v=n.value.trim(); if(v) text.push(v); return;} const k=n.childNodes; if(k) for(const c of k) walk(c); })(doc);
  const full = text.join(" ");
  const items = [];
  for (let i = 0; i < text.length; i++) {
    const t = text[i];
    if (t.length > 3 && t.length < 60 && /^[^\d]/.test(t))
      items.push({ title: t, tags: [t.slice(0,4), "TypeScript", "AWS", "React"].slice(0, 1 + (i%3)), year: 2020 + (i%7) });
  }
  let out =
    "globalThis.SITE_HTML=" + JSON.stringify(html) + ";\n" +
    "globalThis.SITE_TEXT=" + JSON.stringify(full) + ";\n" +
    "globalThis.SITE_ITEMS=" + JSON.stringify(items.slice(0, 40)) + ";\n";
  if (site === "vibey") {
    if (fs.existsSync("data/vibey-app.js"))
      out += "globalThis.SITE_JS=" + JSON.stringify(fs.readFileSync("data/vibey-app.js", "utf8")) + ";\n";
    if (fs.existsSync("build/vibey-eval.js"))
      out += "globalThis.SITE_JS_EVAL=" + JSON.stringify(fs.readFileSync("build/vibey-eval.js", "utf8")) + ";\n";
  }
  fs.writeFileSync(`build/data-${site}.js`, out);
  console.log(`>> build/data-${site}.js`);
}
'
for e in parse search ssr dom lodash jsparse frame3d vibeyboot; do
  [ -f "entries/$e.js" ] || continue
  npx esbuild "entries/$e.js" --bundle --format=iife --outfile="build/$e.js" --log-level=warning
  echo ">> build/$e.js ($(wc -c < "build/$e.js") bytes)"
done
