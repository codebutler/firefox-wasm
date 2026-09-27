# bench/spa — heavy single-page-application workload

`app.js` is a ~2–3k line pure-ES2020 "SPA": a mini framework (signals/computed/
effects with batching, keyed virtual-DOM diff + serializer, function/class
components with lifecycle, router, redux-like store with middleware, memoized
selectors, event bus, plugin host, JSON persistence with schema migrations, i18n,
command palette) plus feature modules (todos, kanban, sortable/filterable/
paginated virtual-scrolled table, markdown-ish renderer, typed-array analytics,
validated settings form, notification queue, undo/redo). It defines
`globalThis.Benchmark` with `setup()` / `runIteration()` (≈350–500 simulated
user interactions through the full reactive pipeline) / `result()` (a
deterministic checksum), so the harness can diff JIT vs interpreter.

```bash
bash bench/spa/run.sh

Measured: **JIT ~83 ms/iter vs PBL ~342 ms/iter = 4.14x**, checksums identical.

GECKO_WJ_LOGBAIL=1 node bench/main.ts __exec <prelude> bench/spa/app.js bench/microbenches/micro-driver.js
GECKO_WJ_DEOPTHIST=1 ...   # per-MIR-op deopt histogram
GECKO_WJ_STATSJSON=1 ...   # compiled/failed/deopts/recompiles
```

It is written to be DOM-free / Promise-free / Intl-free so it runs in the bare
JS shell embed.
