# JS→WASM JIT optimization log (2026-09-27 session)

## Final result (interleaved A/B vs the pre-session build)

| bench | before | after | change |
|---|---|---|---|
| `micro mixed-arith` | 57.6 ms (1.24×) | 2.25 ms (33.2×) | **25.6× faster** (was invalid wasm → PBL) |
| `micro samevalue-atan2` | 289.9 ms (1.01×) | 31.1 ms (9.37×) | **9.3× faster** |
| `micro kitchen-sink` | 1104.7 ms (4.21×) | 957.0 ms (4.86×) | +15% |
| `octane earley` | ratio 6.47 | 8.46 | **+31%** (>8-arg fns now compile) |
| `octane richards` | ratio 23.2 | 24.2 | +5% |
| octane splay/gbemu/box2d | — | — | neutral (±1–2%) |

The seven new/updated self-checking microbenches (`date-ops`, `mixed-arith`,
`minmax-idx`, `samevalue-atan2`, `kitchen-sink{2,3,4}`, `mapset-probe`) all pass
with JIT == PBL checksums.

The JS-only SpiderMonkey embed now builds and benchmarks **on macOS/arm64**
(see `docs/wasmjit-dev-loop.md`), so JIT work no longer needs the Linux-only full
Gecko build. `fastjit.sh` gives a ~12–18 s edit→bench cycle.

Baseline (before this session) and the three engine patches in `patches/`:

| commit | change | measured |
|---|---|---|
| 2e5da97 | Date op family lowering + `MConstant` Int64/magic + `Box(Float32)` | `micro date-ops` 24.6→18.0 ms (~1.37×), 4 bails → 0 |
| d4727f8 | mixed Int32/Double arithmetic emitted **invalid wasm** (function silently in PBL) | `micro mixed-arith` 43.5→1.7 ms (~25×) |
| 59b0638 | `GuardHasAttachedArrayBuffer`, `ToIntegerIndex`, `MMinMax` IntPtr/Float32, IntPtr `Add/Sub/Mul`; `MTypedArraySubarray` staged off | `micro minmax-idx`; pdfjs bail chain shortened |
| (this session, 10th) | realistic site workload (`bench/site/`, thirdlf03.com + parse5/preact/lodash/...): `Map/Set` ops, `ObjectState`/`ArrayState`, sound for-in error-resume | `bench/site` parse ~20x, dom ~12x, ssr 1.4x (1.8x at MAXLEN=8192) |
| (this session, 9th) | `kWJMaxArgs` 8 -> 16 (functions with >8 args no longer stay in PBL) | octane earley 6.7x -> 9.0x; deltablue ~2% slower |
| (this session, 8th) | `SetFunName` (inferred function names) | `micro kitchen-sink4` (new) |
| (this session, 7th) | `IsTypedArrayConstructor`, `GuardFuse` (fuse check by index) | `micro kitchen-sink3` (new) |
| (this session, 6th) | class/object-definition + spread ops: `ObjectWithProto`, `NewClassBodyEnvironmentObject`, `MinMaxArray`, `NewPrivateName`, `FunctionWithProto`, `InitHomeObject`, `CheckClassHeritage` | `micro kitchen-sink2` (new) |
| (this session, 5th) | `Math.hypot`/`Math.sign`, object-literal accessor definitions (`InitProp/ElemGetterSetter`), typed-array resizability guards | `micro kitchen-sink` (new, 10 feature groups) |
| (this session, 4th) | conversions (`IntPtrToDouble`, `Int64<->IntPtr`, `ExtendInt32ToInt64`, `WrapInt64ToInt32`), `SameValue`/`SameValueDouble`, `Atan2`, `ArrayBufferViewByteOffset`, `NegativeToUndefined`, `LoadValueTag`, `IdToStringOrSymbol`, guards (`GuardIntPtrIsNonNegative`, `GuardInt32Range`, `GuardIsExtensible`), `Nop`/`Assert*` no-ops | `micro samevalue-atan2` 1.02× → 9.23× |

All engine changes are in `patches/0001-wasmjit-lowering-improvements.patch`
(the fork checkout in `firefox/` is git-ignored).

## How the wins were found

`GECKO_WJ_LOGBAIL=1` prints, per compile attempt, why a function stayed in PBL:

```
[WJ-BAIL] fn=... reason=<bail-reason|opname> op@=file:line(off=N)
```

That surfaced the Date family, `Constant`, `Box`, `LocalTimeToUTC`,
`GuardHasAttachedArrayBuffer`, `ToIntegerIndex`, `MinMax` and `Sub`.

A second class of bug is **invisible to `--bails`**: the backend emits a wasm
module V8 rejects (`host-compile-reject`), so the function silently falls to PBL.
Find it by running a bench through `__exec` and grepping stderr for
`[wasm-host] compile failed:` — that is how the mixed Int32/Double `f64.add`-on-
i32 bug (and the broken Int32 `MMinMax` `select` shape) were found. `--bails`
does not report these.

## Correctness gates used after every change

```bash
node bench/main.ts micro --ab        # checksums JIT vs PBL (now 14 benches)
node bench/main.ts realapp all --ab  # acorn / marked checksums
node bench/main.ts jetstream --ab    # each bench's validate()
node bench/main.ts wasm              # in-process wasm interpreter tests
node bench/main.ts disastest         # codegen FileCheck tests
```

Interleaved A/B between two saved `build/embed.{js,wasm}` variants (see
`/tmp/wjab.py` in the session) controls for the heavy background load on this
machine (`dasd` can peg a core); single-run ratios are noisy.

## Known issues / staged work

* **`MTypedArraySubarray` is staged off** (`GECKO_WJ_TASUB=1` to enable). The
  lowering itself is correct (`tasub-probe` passes with it on), but compiling
  pdf.js `FlateStream_readBlock` — which needs it — miscompiles (wrong value /
  OOB). That is a latent bug in that large function exposed by compiling it.
  Default keeps the function in PBL (correct).
* **for-in loop-head deopt-resume**: `EmitDeoptResumeInline` bails a function
  whose guard deopts at a `for-in` `LoopHead` with a live iterator
  (`forin-loophead-deopt`), because resuming re-runs `MoreIter`. `GECKO_WJ_NOFORINBAIL=1`
  makes acorn's parser compile and is correct on acorn (~6% faster) and on the
  full micro/realapp/jetstream gates, but the underlying resume is documented as
  unsound — do not flip the default without fixing the resume.
* **Functions with >8 args** (`kWJMaxArgs`) stay in PBL (octane earley, 2 fns).
  Raising the limit changes the per-call ABI for every function, so measure
  carefully before doing it.

## Next ideas (ranked)

1. **Load-time compile cost.** `GECKO_WJ_COMPILESTAT=1` splits a tier-up compile
   into snapshot/build/optimize/emit/host-compile ms. One-shot page loads compile
   many briefly-run functions; reducing emitted bytes or deferring more compiles
   is the main lever for "JIT slower to LOAD a real site".
2. **Fix the pdfjs `FlateStream_readBlock` miscompile** to enable
   `MTypedArraySubarray` and unlock the last pdfjs bail.
3. **Sound for-in loop-head resume** (see above) — for-in is everywhere.
4. **`try-catch` / `string-ops` microbenches sit at ~1.0×** even though they now
   compile: their cost is in the helper hop for the throw/`MConcat` path, not in
   ops that bail. Worth a profile (`GECKO_WJ_STATSJSON`, `node --prof`).
5. The weak octane benches (gbemu ~1.1×, box2d ~1.25×, splay ~1.9×) have **no
   bails** — they are limited by megamorphic dispatch / boxing / helper hops, so
   they need codegen or IC work, not coverage.

## GECKO_WJ_MAXLEN (default 4096) — measured trade-off

Interleaved A/B (same binary, env var only, medians of 3) of MAXLEN 4096 vs 8192:

| bench | 4096 | 8192 | delta |
|---|---|---|---|
| `bench/site` ssr (preact) | 157 ms | 98 ms | **+60%** (its 5.7 KB renderToString is never compiled at 4096) |
| octane box2d | 752 | 899 | **+19.5%** |
| octane richards/deltablue/splay/gbemu/regexp | — | — | ±1% |
| octane navier | 11518 | 9993 | **−13%** |
| octane earley | 6525 | 6388 | −2% |
| ubo | 1684 ms | 1917 ms | **−13%** |

So 8192 is a real win for workloads whose hot function is a large literal-builder
(preact SSR, box2d) and a real loss for others (navier, ubo). The 4096 default is
kept; the `GECKO_WJ_MAXLEN` knob is the per-deployment choice. `GECKO_WJ_SIZEWARMUP`
(scale the warmup threshold by bytecode length) can delay large-function compiles
but regresses medium-hot throughput.

## Heavy SPA workload (`bench/spa/spa.js`)

A ~2,200-line pure-ES2020 "SPA" (signals/computed/effects, keyed vdom diff +
serializer, router, redux-like store, memoized selectors, plugin host, JSON
persistence with migrations, i18n, todos/kanban/table/analytics/settings/
notifications/command-palette/undo-redo feature modules) driven by ~400
simulated interactions per iteration. Generated with `pi --provider opencode-go
--model deepseek-v4-flash`.

* **JIT 82.6 ms/iter vs PBL 342 ms/iter = 4.14x**, checksums identical, **no
  bails**, 85 functions compiled.
* Deopt rate ~10% (`GECKO_WJ_STATSJSON`); the hot functions deopt 84% of the
  time on `Unbox` (6.1k) and `Ursh` (3.1k). Putting those functions in PBL
  (`GECKO_WJ_NOCOMPILERANGE`) is *slower*, so the deopts are not worth chasing.
* **The cost is calls to builtins that aren't inlined.** `GECKO_WJ_CALLHIST=1`
  on 2.6M slow (wjhelp boundary) calls: `IsOptimizableRegExpObject` 910k,
  `RegExpSearcher` 455k, `Array.prototype.sort` 432k, `String()` 340k,
  `Set.prototype.add` 101k, `Math.round` 53k, `RegExpExecForTest` 50k,
  `Map.prototype.get` 46k, `toFixed` 21k. Those sites don't get a CacheIR
  specialization, so they take the generic `wjhelp(WJH_CALL)` -> `JS::Call` path.
* Knobs tried, none help: `GECKO_WJ_NUMARITH=1` (82.6 -> 222 ms, much worse),
  `GECKO_WJWARP_DELAY` 800 is best (50 -> 133 ms), `GECKO_WJ_MAXLEN` no change,
  `GECKO_WJ_OOBLOAD=1` neutral, `GECKO_WJ_NOFLAGCHECK=1` only +2.5% ceiling.

Next actionable step from this data: a fast **native-call** path for generic
`MCall`s whose callee is a native with `JSJitInfo` (Ion's `callNative` ABI),
instead of always routing through `JS::Call`; and/or more builtin inlining.

## Native-call fast path (`WJH_CALLNATIVE` + `WJH_CALL` runtime dispatch)

Implemented the step above. Two levels:

* `WJH_CALL` probes the boxed callee: `JSFunction` + `isNativeFun` + argc <= 60
  skips `JS::Call`/`InvokeArgs`/`FillArgumentsFromArraylike` entirely.
* `MCall` on a constant native `JSFunction` emits `WJH_CALLNATIVE` with the
  callee/`this`/args staged at scratch[0..argc+1] and `(argc<<32)|nativePtr`
  packed in the site f64 — no callee box/IC overhead. `ignoresReturnValue()`
  callees bake `ignoresReturnValueMethod`; a runtime identity/class check
  degrades a stale bake back to generic `WJH_CALL`.

Both funnel into `WJNativeCall`, which copies the staged values into a
per-call `JS::RootedValueArray<62>` (`vp=[callee,this,args]`) and replicates
`CallJSNative`: outerize global `this` when `needsOuterizedThisObject()`,
`AutoCheckRecursionLimit` held across the call, `DebugAPI::onNativeCall`,
`AutoRealm`, `NativeResumeMode::Override` handling. The rooted buffer is
required: natives re-enter JS (`sort` comparators, `forEach` callbacks,
getters) and a `vp` pointing into `gWJScratch` is clobbered by the nested
call's own staging (this bug initially broke lodash). `onNativeCall` can run
debugger JS -> GC, so `fun` is re-derived from the rooted `vp[0]` after it.

Escape hatch: `GECKO_WJ_NONATIVECALL=1` (runtime) / `GECKO_WJ_NONATIVEBE=1`
(backend emit). `[wb-calls]` stats line gains a `native=` counter.

Interleaved A/B medians (`GECKO_WJ_NONATIVECALL` off/on, identical checksums):

| bench | off | on | delta |
|---|---|---|---|
| micro native-call | 118.3 ms | 79.7 ms | **+33%** |
| spa.js | 84.8 ms | 77.9 ms | **+8%** |
| site search | 18.1 ms | 13.9 ms | **+23%** |
| site lodash | 298.1 ms | 282.1 ms | +5% |
| site dom | 150.9 ms | 141.0 ms | +7% |
| site parse / ssr | 167.4 / 89.9 ms | 164.1 / 88.6 ms | ~+2% |
| octane regexp | ~974 | ~1197 | **~+23%** |
| octane deltablue | ~2900 | ~3048 | ~+5% |
| octane splay | ~4684 | ~4710 | neutral |

On the SPA the `GECKO_WJ_CALLHIST` slow-call histogram no longer prints with
the fast path on — the ~1M+ slow `JS::Call` crossings per run (regexp helpers,
sort, String, Map/Set, Math.round) now bypass the boundary entirely.
`GECKO_WJ_CALLHIST` now takes a print modulus (`=10000` prints every 10k slow
calls; `=1`/empty keeps the old 200k default).

Post-change sweep (`CALLHIST=10000` + `CTFDBG` + `VALVEDBG` + `DEOPTHIST` on
spa.js): **every remaining slow call is a `J:` interpreted callee; zero `N:`**
natives remain. The top ones (`Signal.prototype.set` spa.js:122 ~54k/run,
`Computed.recompute` :157) are **valve-failed to PBL** — they storm ~10
deopts/call on `Unbox`/shape guards and even the forceMega recompile kept
storming, so the deopt-storm valve parked them in PBL (correct per the
deltablue-timeout history). The calls therefore must enter the interpreter
regardless; the residual boundary cost is `JS::Call` setup, not fixable by
another call-path specialization. The real remaining headroom is the storms
themselves: `Unbox` ~6.3k + `Ursh` 3.1k (the `rng` closure `t >>> 15` at
spa.js:22) dominate `DEOPTHIST` — i.e. type-speculation misses on
Value-of-double/uint32 reads, next lever is smarter retyping on recompile,
not more call plumbing.

Known unrelated failure: `micro native-call` under `--gczeal 14` throws
"calling a builtin typed array constructor without new" — identical with the
fast path disabled; a pre-existing GC/ctor staleness issue, not this change.
