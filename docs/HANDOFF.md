# HANDOFF — JS→WASM JIT work (session 2026-09-27)

For whoever picks this up next. Read `docs/wasmjit-dev-loop.md` (build/bench
loop), `docs/wasmjit-optimizations.md` (the session log + measured trade-offs),
and `patches/README.md` (every engine change, op by op).

**Nothing was pushed.** All work is in local commits on `master` of this fork
(`thirdlf03/firefox-wasm`). The engine-side changes live in
`patches/*.patch` (the `firefox/` checkout is git-ignored).

---

## 0. TL;DR

* The JS-only SpiderMonkey **emscripten build works on macOS/arm64** (~130 MB
  objdir, ~1 min first build, `fastjit.sh` ~12–20 s iteration). No Linux/Docker
  needed for JIT work.
* ~60 MIR ops were lowered into the MIR→wasm backend, plus a fix for a class of
  **invalid-wasm** bugs that silently dropped whole functions to the interpreter.
* Heavy/realistic workloads now exist: `bench/site/` (real libraries over real
  page content) and `bench/spa/` (a ~2.2 k-line SPA).
* The top bottleneck (2.6 M slow `wjhelp(WJH_CALL)` crossings on the SPA for
  non-inlined builtins) is now addressed by a **native-call fast path**
  (`WJH_CALLNATIVE` + runtime dispatch in `WJH_CALL`, replicating Ion's
  `callNative` semantics): micro native-call +33 %, spa.js +8 %, octane
  regexp +23 %, identical checksums. See `docs/wasmjit-optimizations.md`.

---

## 1. Architecture recap (what you are working on)

`JS_CODEGEN_NONE` build: no in-process native codegen. Instead, hot JS functions
are lowered to a **guest WebAssembly module** that the *host* (V8 in node, the
browser in production) compiles to native code.

* Front-end: `firefox/js/src/wasm/WasmJitWarp.cpp` — WarpOracle + WarpBuilder +
  OptimizeMIR (reuses Ion's MIR pipeline on a real `JSScript`).
* Back-end: `firefox/js/src/wasm/WasmJitBackend.cpp` (~15 k lines) — optimized
  MIR → wasm bytes. `EmitValue` = per-op lowering; `EmitEffect` = void/effect
  ops; `EmitDeoptResume*` = guard-miss resume into PBL.
* Runtime: `firefox/js/src/wasm/WasmJitRuntime.cpp` — trigger/warmup, host
  compile/instantiate, call routing, arg marshalling, the `wjhelp` helper
  dispatch (huge `if (kind == WJH_…)` chain), deopt-storm valves, GC roots.
* Header: `firefox/js/src/wasm/WasmJitBackend.h` — the `WJH_*` helper enum,
  scratch layout, call/prop/name/ctor IC arrays, resume buffers, `kWJMaxArgs`.
* Host bridge: `bench/spidermonkey.js/wasm-host-bridge.js` — routes guest
  `WebAssembly` to the host engine, bridges memory/exports/imports.

A **bail** (unsupported node / bad resume) makes the whole function stay in PBL
(the portable baseline interpreter). Coverage work = lowering more nodes.
**Invalid wasm** (`host-compile-reject`) is worse: V8 rejects the module and the
function silently stays in PBL with no `--bails` signal.

---

## 2. Environment (macOS, verified)

```bash
# one-time
git clone --depth 1 https://github.com/emscripten-core/emsdk.git emsdk
cd emsdk && ./emsdk install 6.0.1 && ./emsdk activate 6.0.1 && cd ..
rustup target add wasm32-unknown-emscripten
make firefox                                   # pinned Gecko fork, depth 1 (~5.5 GB)
# NOTE: `make build` (the full engine) applies patches/*.patch itself and FAILS if the
# result is not `pin + patches`. This JS-only loop runs `mach` directly, so apply by hand:
git -C firefox apply ../patches/0000-build-skip-spidermonkey-style-checks.patch
git -C firefox apply ../patches/0001-wasmjit-lowering-improvements.patch

# configure + first JS-only build (~1 min, objdir obj-js-emscripten/ ~130 MB)
export ROOT=$PWD
export EMSDK=$ROOT/emsdk EM_CONFIG=$ROOT/em_config
export MOZCONFIG=$ROOT/mozconfig.js.emscripten MOZBUILD_STATE_PATH=$ROOT/.mozbuild
export PATH=$EMSDK/upstream/emscripten:$EMSDK:$PATH
export WJ_SKIP_STYLE_CHECKS=1
cd firefox && ./mach configure && ./mach build && cd ..
bash bench/spidermonkey.js/build.sh            # -> bench/spidermonkey.js/build/embed.{js,wasm}
```

`mozconfig.js.emscripten` was made host-portable (the `--disable-stdcxx-compat`
line is Linux-only and already the default → removed). `.mozbuild/` is ignored.

The **full Gecko build** (`make build` / `make libxul`) is still Linux-only and
huge (~26 GB objdir) — only needed for the browser demo, not for JIT work.

---

## 3. Iterate

```bash
bash bench/spidermonkey.js/fastjit.sh          # recompile WasmJit*.cpp + relink (~12-20 s)
node bench/main.ts micro --ab                  # fast, self-checking (checksums)
node bench/main.ts octane --ab --bails
bash bench/spidermonkey.js/build.sh            # embedder-only relink
```

`fastjit.sh` recompiles `firefox/js/src/wasm/WasmJit*.cpp` (they are standalone
`SOURCES`, not unified) and re-archives `obj-js-emscripten/js/src/build/libjs_static.a`.

After an engine change, **regenerate the patch** and re-verify it applies:

```bash
git -C firefox diff -- js/src/wasm > patches/0001-wasmjit-lowering-improvements.patch
git -C firefox stash -q; git -C firefox checkout -q -- config/run_spidermonkey_checks.py
git -C firefox apply patches/0000-*.patch && git -C firefox apply patches/0001-*.patch && echo OK
git -C firefox checkout -q -- .; git -C firefox stash pop -q
```

---

## 4. Running benchmarks

`bench/main.ts` suites: `octane`, `jetstream`, `micro`, `realapp` (acorn/marked),
`ubo`, `wasm` (in-process wasm interp tests), `disastest` (codegen FileCheck),
`jittest`, `list`. Flags: `--ab` (JIT vs PBL ratio), `--bails` (unsupported-op
survey), `--iters/--warm`, `--gczeal`, `--nursery-mb`, `--timeout`. Any
`GECKO_*` env var is forwarded to the embed.

Extra workloads added this session:

```bash
bash bench/site/fetch.sh && bash bench/site/build.sh && bash bench/site/run.sh   # real libs over thirdlf03.com content
bash bench/spa/run.sh                                                            # heavy SPA (bench/spa/spa.js)
```

### Diagnostics you will use constantly

| goal | how |
|---|---|
| why a function stayed in PBL | `GECKO_WJ_LOGBAIL=1` → `[WJ-BAIL] fn=… reason=<reason\|opname> op@=file:line` |
| unsupported-op survey per bench | `node bench/main.ts <suite> --ab --bails` |
| **invalid wasm** (invisible to --bails) | run via `__exec` and grep stderr for `[wasm-host] compile failed:` / `host-compile-reject` |
| unsupported `Constant`/`Box`/return type | `GECKO_WJ_BAILDBG=1` |
| per-MIR-op deopt histogram | `GECKO_WJ_DEOPTHIST=1` (also `SITEHIST`) |
| compiled/failed/deopts/recompiles | `GECKO_WJ_STATSJSON=1` |
| slow (boundary-crossing) call counts | `GECKO_WJ_CALLPROF=1`, `GECKO_WJ_CALLHIST=N` (top callees, print every N; `=1`→200k) |
| emitted wasm for a source line | `GECKO_WJ_WASMDUMP=<line>` → `/tmp/wbjit_<line>.wasm`, then `$EMSDK/upstream/bin/wasm-dis` |
| force PBL for one function | `GECKO_WJ_NOCOMPILERANGE=lo,hi` |
| deopt-resume failure detail | `GECKO_WJ_DEOPTRESUMEDBG=1` |

---

## 5. What changed (this session)

15 commits on `master`; the three engine commits (plus follow-ups) are in
`patches/0001-wasmjit-lowering-improvements.patch` (1407 lines). Highlights:

1. **Date op family** (`MDateNow/DateParse/TimeClip/NewDateObject/
   FillLocalTimeSlots/Hours·Minutes·Seconds/Year·Month·DateFromTime/
   LocalTimeToUTC`) + `MConstant(Int64/magic)` + `Box(Float32)`.
   Before: every `Date.now()`/`new Date()`/Date-getter function was 100 % PBL.
2. **Invalid wasm for mixed Int32/Double arithmetic.** Warp's
   `emitDoubleBinaryArithResult` builds `MAdd/Sub/Mul/Div(lhs, rhs, Double)`
   from `NumberOperandId`s whose defs can be Int32 phis; the backend emitted
   `f64.add` on an i32 local → V8 rejected the whole module → function silently
   in PBL. Now Int32 operands are converted (`f64.convert_i32_s`).
   (`micro mixed-arith`: 43.5 → 1.7 ms.)
3. ~55 more MIR ops: conversions, guards, `Math.hypot/sign/atan2`, `Object.is`,
   class/object-definition ops (`ObjectWithProto`, `NewClassBodyEnvironmentObject`,
   `NewPrivateName`, `FunctionWithProto`, `InitHomeObject`, `CheckClassHeritage`,
   `InitProp/ElemGetterSetter`, `SetFunName`), `GuardFuse`,
   `IsTypedArrayConstructor`, `MinMaxArray`, Map/Set ops, `ObjectState`/
   `ArrayState`, typed-array resizability guards, `GuardHasAttachedArrayBuffer`,
   `ToIntegerIndex`, `MinMax` IntPtr/Float32, IntPtr arithmetic.
4. **`kWJMaxArgs` 8 → 16** (functions with >8 args no longer stay in PBL;
   octane earley 6.7× → 9.0×; deltablue ~2 % slower from the extra params).
5. **Sound for-in error-resume**: the `forin-loophead-deopt` bail also fired for
   an *exception exit* inside a try region, where the resume is error-mode (PBL
   `goto error` → `HandleException`, no `MoreIter` re-run) → skipping the bail is
   sound. The genuine guard-miss case (acorn's `GuardShape`) still bails.
6. `MTypedArraySubarray` implemented but **staged OFF** (`GECKO_WJ_TASUB=1`):
   compiling pdf.js `FlateStream_readBlock` (which needs it) miscompiles.
7. Workloads: `bench/site/` (parse5 / htmlparser2+css-select / search index /
   preact SSR / lodash over real page content) and `bench/spa/` (heavy SPA);
   plus 8 new self-checking microbenches.
8. **Native-call fast path** (session 2): `WJH_CALL` native dispatch +
   `WJH_CALLNATIVE` for constant native callees, sharing `WJNativeCall` (per-call
   `JS::RootedValueArray<62>` vp — required for re-entrant natives like `sort`
   comparators; `gWJScratch` vp is clobbered by nested calls). Escape hatches
   `GECKO_WJ_NONATIVECALL` / `GECKO_WJ_NONATIVEBE`. New probe
   `bench/microbenches/native-call.js`.

`patches/README.md` documents every op and the measured effect.

---

## 6. Measured results (this session)

| workload | before | after |
|---|---|---|
| `micro mixed-arith` | 57.6 ms (1.24×) | 2.25 ms (33×) |
| `micro samevalue-atan2` | 289.9 ms (1.01×) | 31.1 ms (9.4×) |
| `micro date-ops` | 24.6 ms | 18.0 ms |
| octane earley | ratio 6.5 | 8.5–9.0 |
| octane richards | ratio 23 | 24 |
| splay/gbemu/box2d | — | neutral (±1–2 %) |
| `bench/site` parse | — | ~20–34× (JIT vs PBL) |
| `bench/site` dom | — | ~12× |
| `bench/site` ssr (preact) | 1.4× | **1.8× with `GECKO_WJ_MAXLEN=8192`** |
| `bench/spa` | — | **4.1×** (82.8 ms vs 339 ms/iter) |
| `micro native-call` (session 2) | 118.3 ms | 79.7 ms (**+33 %** vs `GECKO_WJ_NONATIVECALL`) |
| `bench/spa` (session 2) | 84.8 ms | 77.9 ms/iter |
| octane regexp (session 2) | ~974 | ~1197 |

Correctness gates run after every change (all green): `micro --ab` (19 benches,
JIT-vs-PBL checksums), `realapp all --ab`, `jetstream --ab` (validate()),
`wasm` (5/5), `disastest` (4/4). The site/SPA workloads also diff checksums.

---

## 7. Open issues / prioritized next steps

1. ~~Native-call fast path~~ **DONE** (session 2). `WJH_CALL` runtime dispatch +
   `WJH_CALLNATIVE` for constant natives. Post-change `CALLHIST`/`CTFDBG` sweep:
   zero natives remain on the slow path; the top slow callees are valve-failed
   PBL functions (`Signal.set` ~54k/run storming ~10 deopts/call on Unbox/
   shape guards; forceMega recompile did not heal). Residual headroom is the
   deopt storms (Unbox/Ursh type-speculation misses), not call plumbing —
   next lever is smarter retype-on-recompile (e.g. speculating Value-of-double
   reads as Double instead of Int32, or the `Ursh`-as-uint32 closure case at
   spa.js:22).
2. **pdf.js `FlateStream_readBlock` miscompile** (blocks `MTypedArraySubarray`).
   The lowering is correct (`typed-subarray` probe passes with `GECKO_WJ_TASUB=1`)
   but compiling that ~5.7 KB function produces wrong values / OOB. Bisect it
   with `GECKO_WJ_NOCOMPILERANGE` / `FORCEDEOPTLINE` / `WASMDUMP`; likely a
   latent bug in the big function exposed by compiling it. pdfjs is the weakest
   octane bench (~1.25×).
3. **`GECKO_WJ_MAXLEN` policy.** Default 4096. 8192 helps preact SSR (+60 %) and
   box2d (+19.5 %) but hurts navier (−13 %) and ubo (−13 %). A *policy* (compile
   >4096-byte functions only when much hotter, or a per-process budget) could get
   both. `GECKO_WJ_SIZEWARMUP` scales the threshold by length but regresses
   medium-hot throughput.
4. **for-in loop-head guard-miss resume** (acorn's parser). The genuine
   unsound case: a `GuardShape` deopts with a resume point at a `for-in`
   `LoopHead`; resuming re-runs `MoreIter` and loses the in-flight key. Needs a
   sound resume (rewind the iterator, or resume at the body pc with the key) —
   don't flip `GECKO_WJ_NOFORINBAIL` (unsound).
5. **Deopt storms are NOT worth chasing** on the SPA (10 % overall; hot
   functions deopt 84 % on `Unbox`/`Ursh`) — putting those functions in PBL is
   *slower*. `GECKO_WJ_NUMARITH=1` (de-speculate) is much worse (83 → 222 ms).
6. **Generators** still bail (`entry-alwaysBails`). `new.target`
   (`MNewTarget`) still bails (the JIT entry doesn't plumb it).
7. **Load-time compile cost**: `GECKO_WJ_COMPILESTAT=1` splits a tier-up compile
   into snapshot/build/optimize/emit/host-compile; emit is ~55 %. One-shot page
   loads are the stated "not usable on many websites" pain.

---

## 8. Gotchas / methodology

* **Measurement noise.** This Mac's `dasd` can peg a core; single-run ratios
  swing ±25 %. Always A/B **interleaved** (alternate variants per round, take
  medians). For env-var knobs, alternate the env var with the *same* binary —
  cleanest. `bench/main.ts --ab` runs JIT/PBL back-to-back, so its *ratio* is the
  robust metric.
* Benchmarks run node with `--no-liftoff` (TurboFan-only) to avoid tiering noise.
* `--bails` does **not** report invalid-wasm (`host-compile-reject`); sweep with
  `__exec` + grep for `compile failed` when auditing coverage.
* The engine checkout is git-ignored → **always keep `patches/` in sync**. `make build`
  now applies them itself and **fails** if the result does not match `pin + patches`
  (`$(PATCH_STAMP)` in the Makefile), so a stale patch can no longer silently ship a
  baseline-JIT artifact; `FORCE_PATCH=1` resets `firefox/` and re-applies cleanly.
* `git -C firefox stash pop` can conflict on `config/run_spidermonkey_checks.py`;
  if it does, `git -C firefox checkout -- config/run_spidermonkey_checks.py`
  then `git -C firefox stash pop`.
* `bench/spa/app.js` is an **unfinished** file from a separate pi+deepseek agent
  (untracked). The working SPA is `bench/spa/spa.js`.

---

## 9. File map (what to read first)

```
docs/wasmjit-dev-loop.md        build + bench loop (start here)
docs/wasmjit-optimizations.md   session log: findings, results, MAXLEN trade-off
docs/HANDOFF.md                 this file
patches/README.md               every engine change (op by op) + measured effect
patches/0000-*.patch            JS-only build: skip the standalone style checker
patches/0001-*.patch            all WasmJit* lowering/codegen changes
bench/README.md                 bench harness docs (suites, flags, disas, jittest)
bench/main.ts                   the unified runner
bench/spidermonkey.js/          embed sources (embed.cpp, wasm-host-bridge.js, build.sh, fastjit.sh)
bench/microbenches/             focused, self-checking probes (20)
bench/site/                     real libs over thirdlf03.com content (+ README)
bench/spa/                      heavy SPA workload (+ README)
firefox/js/src/wasm/WasmJit*.{h,cpp}   THE code you edit (git-ignored checkout)
```

Engine-side "where do I add an op?" cheat sheet:
`WasmJitBackend.h` (add a `WJH_*` kind) → `WasmJitRuntime.cpp` (implement it in
the `wjhelp` chain) → `WasmJitBackend.cpp` (`EmitValue`/`EmitEffect` case:
stage operands with `EmitStageScratch`/`EmitStageConstBoxed`, call
`EmitHelperCallResult`, then `EmitHelperResultAsType`). Guards use
`EmitDeopt` inside an `if` (bump `be.deoptExtraNest` for extra nesting); pure
runtime checks can return the guard outcome as the helper's f64 *call flag*
(0 = pass, 1 = deopt) and use a raw `Op::Call` instead.
