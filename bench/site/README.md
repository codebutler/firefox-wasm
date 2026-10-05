# bench/site — realistic web workload (thirdlf03.com content + real libraries)

thirdlf03.com is a static Astro build with no client JS, so "run the site's own
script" is not a workload. Instead these benches run **real libraries over the
site's real content** — the kind of JS a real page does: HTML parsing, DOM
querying, a client-side search index, framework SSR, and utility-heavy data
transforms.

```bash
bash bench/site/fetch.sh    # fetch the page ONCE into data/ (cached)
bash bench/site/build.sh    # npm i esbuild + libs, bundle entries/ -> build/
bash bench/site/run.sh      # JIT vs PBL per workload
```

`data/`, `build/`, `node_modules/` are git-ignored.

| workload | library | JIT vs PBL (typical) |
|---|---|---|
| `parse` | parse5 (HTML parse + tree walk) | ~20–34× |
| `dom` | htmlparser2 + css-select (parse + query) | ~11–13× |
| `search` | hand-written inverted index over the page text | ~7× |
| `lodash` | lodash (groupBy/uniq/orderBy/cloneDeep/merge) | ~4× |
| `ssr` | preact + preact-render-to-string | ~1.4× |

## What this workload found

* `MMapObjectSize` — `Map.prototype.size` bailed the whole function.
* `MObjectState` / `MArrayState` — Ion's recover-only object/array-literal
  summaries were unlowered, which blocked compiling **large** functions that
  build literals (e.g. preact's 5.7 KB `renderToString`).
* **`ssr` is the outlier (~1.4×).** Its hot function `renderToString` is 5707
  bytecode bytes, above the 4096 default `GECKO_WJ_MAXLEN`, so it was never
  compiled; raising `GECKO_WJ_MAXLEN=8192` then hit the for-in loop-head
  deopt-resume bail (an exception exit inside a try region, not a guard miss).
  The engine patch makes that error-resume case sound, after which
  `GECKO_WJ_MAXLEN=8192` gives `ssr` **1.80×** with an identical checksum.
  The default stays 4096 because raising it regresses octane/ubo (their large
  functions are net-negative to compile) — it is a per-deployment choice.

To see the `ssr` win:

```bash
GECKO_WJ_MAXLEN=8192 bash bench/site/run.sh
```

## Adding a workload

Drop an ESM entry in `entries/` that imports a library and sets
`globalThis.Benchmark = class { setup(); runIteration(); result() }`
(`result()` is a checksum, so `--ab` diffs JIT vs PBL). Add its name to the
loops in `build.sh` and `run.sh`.
