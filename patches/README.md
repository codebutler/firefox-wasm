# patches/ — engine-side patches for the JS→WASM JIT

## Puter engine synchronization (2026-10-05)

The engine pin is `HeyPuter/firefox@f08e4aa189eb02015568aea1085dab77a187c330`,
four commits after `2e1e835a5da5907e5ceef19aade58a7493f1e34d`. This follows
Puter's engine `main`; Puter's wrapper still selects the older pin. The wrapper
already contains `HeyPuter/firefox-wasm@bc69aaa5e2c5388bcf93a43b975b490bb940f4c0`.
This is a Puter update, not a rebase onto a new Mozilla release.

The existing pthread configuration remains enabled. Puter's single-thread
scheduler is conditional on building without Emscripten pthreads. Its JIT GC
fixes also affect the threaded build, so the community patches were replayed
against the new pin with these resolutions:

- 0002 keeps Puter's compile-time GC suppression around the complete
  `WJWarpCompile` operation, including member construction and emission, after
  the community patch splits those into helper functions.
- 0003 retains Puter's guarded root tracing and the community call cache's
  `JSScript` type (the old cache stored a `JSObject`).
- 0005 and 0007 retain host-calibrated recursion budgets and suspend-watermark
  fallback to the portable interpreter, superseding Puter's fixed budget and
  flag-2 fallback. The existing host calibration export remains compatible.
- 0008 uses the rooted runtime callee for shared-family scripts and Puter's
  traced script pool for ordinary/inlined scripts. Both paths survive script
  relocation instead of emitting a stale compile-time pointer.

All 23 patches (0020 and 0021 are reserved for a parallel change) apply in
order and reverse back to the pristine selected source files. The WebGL patches and native stack quota patch apply unchanged. A full
Linux build and Surf runtime validation are required for each new artifact.

The JS→WASM JIT itself lives in the pinned Gecko engine fork
(`HeyPuter/firefox`, fetched by `make firefox` into `firefox/`, which is
git-ignored). Any JIT work therefore lands in `firefox/js/src/wasm/WasmJit*.{h,cpp}`
and is kept here as a patch so it is versioned with this repo.

Apply after `make firefox`:

```bash
git -C firefox apply ../patches/0000-build-skip-spidermonkey-style-checks.patch
git -C firefox apply ../patches/0001-wasmjit-lowering-improvements.patch
```

**The full engine build applies (and verifies) these automatically** — apply them by hand
only for the JS-only dev loop, which uses `make firefox` + `mach` directly and never runs
`make build`. `make build` / `make configure` depend on `firefox/.wj-patched`
(the `$(PATCH_STAMP)` target in the Makefile), which:

1. applies each `patches/*.patch` in file-name order, skipping any that is already
   applied (so a dev tree with WIP edits is never clobbered);
2. then **verifies** the tree is exactly `pinned revision + patches` (every patch
   reverse-applies). If it is not, make **fails** instead of building — because a release
   built without these patches ships the fork's baseline JIT, which measured *identical*
   to the pre-JIT upstream release (`v0.0.1`) and bails on every op that `0001` lowers
   (6 bail sites -> 0, 1.59x on the object/class/accessor family).

Escape hatches: `FORCE_PATCH=1` resets `firefox/` to the pin and re-applies cleanly;
`PATCH_STRICT=0` downgrades the verification failure to a warning (dev tree with WIP
edits). When the patch list or the application logic changes, bump the `patches1` salt in
the CI engine-cache key — hashing `patches/**` cannot distinguish an objdir built with the
patches from one built without.

## 0000-build-skip-spidermonkey-style-checks.patch

Makes `config/run_spidermonkey_checks.py` a no-op when `WJ_SKIP_STYLE_CHECKS=1`.
`--enable-project=js` implies `JS_STANDALONE`, so the standalone SpiderMonkey
style checker runs as part of `mach build`; the fork's added files
(`WasmJit*.cpp`, `WasmInterp.h`) have include-ordering violations that make the
check fail and abort the build. The env gate lets the JS-only dev build proceed
without touching the fork's style. Never affects a production build (the variable
is unset by default).

## 0001-wasmjit-lowering-improvements.patch

Backend/helper lowering work in `WasmJitBackend.{h,cpp}` + `WasmJitRuntime.cpp`.
Each item below was found by `GECKO_WJ_LOGBAIL=1` (whole functions silently
staying in PBL) and is gated by a new microbench where possible.

### 1. Date op family (bailed every Date-using function)

`Date.now()`, `Date.parse()`, `new Date(ms)` and the Date getters used to bail
the containing function. New `wjhelp` kinds + backend lowering:
`MDateNow`, `MDateParse`, `MTimeClip`, `MNewDateObject`,
`MDateFillLocalTimeSlots`, `MDate{Hours,Minutes,Seconds}FromSecondsIntoYear`,
`M{Year,Month,Date}FromTime`, `MLocalTimeToUTC` (Int64 operand staged in the
untraced `gWJHelpI64`). Plus two general gaps the work surfaced: `MConstant` of
`Int64` and of the magic types, and `EmitBoxFromStack(Float32)`.

`micro date-ops`: jit 24.6 ms → 18.0 ms (~1.37×), `bails: -` (was 4 distinct).

### 2. Mixed Int32/Double arithmetic produced INVALID wasm

Warp's `emitDoubleBinaryArithResult` builds `MAdd/MSub/MMul/MDiv(lhs, rhs,
Double)` from `NumberOperandId`s whose defs can be **Int32 phis** (no
`MToDouble`). The backend emitted `f64.add`/`f64.div` straight onto the i32
local; V8 rejects the whole module (`f64.add expected f64, found local.get
i32`) and the function silently stays in PBL (`host-compile-reject`, which
`--bails` does not even report). An Int32-repr operand is now converted with
`f64.convert_i32_s`; i64/Value operands still bail cleanly.

`micro mixed-arith`: jit 43.5 ms → 1.7 ms (~25×), identical checksum.
`micro string-ops` also stops bailing.

### 3. Other missing/invalid lowerings

* **`MGuardHasAttachedArrayBuffer`** — inline port of
  `MacroAssembler::branchIfHasDetachedArrayBuffer` (shared-memory elements,
  non-object buffer slot, then the ArrayBuffer `DETACHED` flag → deopt).
* **`MToIntegerIndex`** — relative-index normalization (`(i<0) ? max(0,i+len) :
  min(i,len)`) for `subarray`/`copyWithin`/`fill`.
* **`MMinMax`** — add the `IntPtr`/`Float32` cases (IntPtr uses the same
  compare+`select` as Int32; Float32 is held as f64) and repr-guard the
  Double path. The old Int32 `select` sequence pushed only one value on the
  stack in some shapes → invalid wasm.
* **IntPtr `MAdd`/`MSub`/`MMul`** — plain i32 ops with no overflow snapshot
  (matching Ion's `LAddIntPtr`/`LSubIntPtr`/`LMulIntPtr`).
* **`MTypedArraySubarray`** — implemented (`js::TypedArraySubarrayWithLength`)
  but **staged OFF by default** (`GECKO_WJ_TASUB=1` enables it): compiling
  pdf.js's `FlateStream_readBlock`, which needs it, miscompiles (wrong value /
  OOB). That is a latent bug in that large function exposed by compiling it, not
  in this op (the `typed-subarray` probe passes with the op enabled). With the
  default bail the function stays in PBL, which is correct.

`micro minmax-idx` covers Math.min/max over indices + IntPtr index arithmetic.

### 4. Conversions, small guards, `Object.is`, `Math.atan2`, typed-array offset

More whole-function bails found by `GECKO_WJ_LOGBAIL` on a probe that uses them
(`micro samevalue-atan2`: 1.02× → 9.23×):

* `MIntPtrToDouble`, `MIntPtrToInt64`, `MInt64ToIntPtr`, `MExtendInt32ToInt64`,
  `MWrapInt64ToInt32` — pointer/int64 conversions (wasm i32/i64 ops).
* `MSameValueDouble` — `a == b || (a != a && b != b)` (Object.is on numbers).
* `MSameValue` — `js::SameValue` helper (Object.is on values).
* `MAtan2` — `js::ecmaAtan2` helper (Math.atan2).
* `MNegativeToUndefined`, `MLoadValueTag`, `MIdToStringOrSymbol` (passthrough).
* `MGuardIntPtrIsNonNegative`, `MGuardInt32Range`, `MGuardIsExtensible`
  (deopt on miss, passthrough on hit).
* `MArrayBufferViewByteOffset` — inline `byteOffset` PrivateValue slot read.
* `MNop`, `MAssertFloat32`, `MAssertCanElidePostWriteBarrier` — no-ops.

### 5. `Math.hypot`/`Math.sign`, object-literal accessors, typed-array resizability

Found by a broad kitchen-sink probe (`micro kitchen-sink`, 10 feature groups):
`MHypot` (2-4 args -> `ecmaHypot`/`hypot3`/`hypot4`), `MInitPropGetterSetter` /
`MInitElemGetterSetter` (object-literal `get x(){}` -> the VM operations, name
atom interned in the traced pool), `MGuardIsResizableTypedArray` /
`MGuardIsNonResizableTypedArray` (class-range check), and `MSign` (all four
Int32/Double combinations, incl. the NaN bailout for Double->Int32).

### 6. Class/object-definition and spread ops

Second kitchen-sink probe (`micro kitchen-sink2`: generators, prototypes, classes,
symbols, BigInt, arguments/spread/rest/destructuring, switch/labels, errors/Proxy,
JSON): `MObjectWithProto` (`Object.create`/`__proto__`),
`MNewClassBodyEnvironmentObject`, `MMinMaxArray` (`Math.max/min(...arr)`,
dense-number fast path with a deopt flag), `MNewPrivateName` (`#priv`),
`MFunctionWithProto`, `MInitHomeObject`, `MCheckClassHeritage`.

Generators still bail (`entry-alwaysBails`); async/Promise and a couple of string
methods are unsupported by the minimal embed itself (fail in PBL too).

### 7. Array/string/math/typed-array/DataView/Reflect probe

Third probe (`micro kitchen-sink3`): `MIsTypedArrayConstructor` (pure class
check) and `MGuardFuse` (deopt if the realm fuse popped; looked up by index in
the runtime, no per-script dependency registration). Everything else in the
probe (Array/String/Math/Date/TypedArray/DataView/Reflect/Object methods, tagged
templates) already compiled. `new.target` (`MNewTarget`) still bails: the JIT
entry does not plumb new.target, so it is left to PBL. `localeCompare` traps in
the minimal embed itself (intl disabled).

### 8. Inferred function names

Fourth probe (`micro kitchen-sink4`: Symbol.toPrimitive, prototype accessors,
custom iterators, Symbol.hasInstance/toStringTag, spread/apply/Reflect.apply,
ES2023 array methods, named-group regexps, optional chaining/nullish): only
`MSetFunName` bailed -> `js::SetFunctionName` helper (inferred `f.name` for
arrow/method definitions).

### 9. kWJMaxArgs 8 -> 16

Functions with more than 8 actual args stayed in PBL (`too-many-args`), and an
arg-count-related `Call` bail also disappeared. octane earley (9-arg
`deriv_trees`): 6.7x -> 9.0x, no bails. The cost is 8 extra wasm params per JIT
call: interleaved A/B shows octane deltablue ~2% slower (7.44 -> 7.15 ratio) and
richards/splay neutral. Net clearly positive.

### 10. Realistic site workload (thirdlf03.com + real libraries)

`bench/site/` runs parse5 / htmlparser2+css-select / a hand-written search index /
preact-render-to-string / lodash over the real page content. It found:

* `MMapObjectSize` / `MSetObjectSize` (+ the whole Map/Set get/has/set/delete/add
  group) via the `js::jit::MapObject*` / `SetObject*` VM helpers.
* `MObjectState` / `MArrayState` — Ion's recover-only literal summaries (Ion
  never lowers them). A passthrough of the summarized object/array. This was
  blocking compilation of *large* functions that build object/array literals
  (preact's 5.7 KB `renderToString`).
* **for-in loop-head deopt-resume**: the bail was also firing for an *exception
  exit* inside a try region (`EmitExceptionExit` -> `EmitDeoptResume`), where the
  resume is in error mode and PBL `goto error` -> `HandleException` (it does NOT
  re-run `MoreIter`). Skipping the bail for error resumes is sound and unblocks
  such functions. The genuine guard-miss case (a GuardShape deopt at a for-in
  LoopHead, e.g. acorn) still bails.

With `GECKO_WJ_MAXLEN=8192` the preact SSR bench goes 90 ms -> 50 ms (1.80x,
identical checksum). The 4096 default is kept: raising it regresses octane
(richards 7975 -> 6358) and ubo (999 -> 1132 ms) because their large functions
are net-negative to compile.

### 11. Native-call fast path (`WJH_CALLNATIVE`)

The SPA spends ~2.6M calls/run in `wjhelp(WJH_CALL)` -> `JS::Call` for
non-inlined natives (regexp helpers, `Array.prototype.sort`, `String`,
Map/Set ops, `Math.round`, `toFixed`). Two-level fix, both funneling into a
shared `WJNativeCall` that replicates `CallJSNative` semantics
(recursion-limit RAII, `DebugAPI::onNativeCall`, `AutoRealm`, global-`this`
outerization, `NativeResumeMode::Override`):

* `WJH_CALL` probes the boxed callee for `JSFunction` + `isNativeFun` and
  calls `fun->native()` directly, skipping `InvokeArgs`/`JS::Call`.
* `MCall` on a constant native callee emits `WJH_CALLNATIVE` with
  `vp=[callee,this,args]` staged at scratch[0..argc+1] and
  `(argc<<32)|nativeFnPtr` packed into the site f64. A stale baked identity
  degrades back to generic `WJH_CALL`.

Reentrancy safety: the `vp` lives in a per-call `JS::RootedValueArray<62>`
on the C++ stack, NOT `gWJScratch` — natives re-enter JS (sort comparators,
getters) whose own helper staging would otherwise clobber the outer call's
args. `fun` is re-derived from rooted `vp[0]` after `onNativeCall` (debug JS
can GC/move the callee).

Interleaved A/B medians: `micro native-call` 118 -> 80 ms (+33%), spa.js
85 -> 78 ms (+8%), site search +23%, octane regexp +23%. `GECKO_WJ_NONATIVECALL`
/ `GECKO_WJ_NONATIVEBE` disable each level. `[wb-calls]` gains `native=`.

## 0002-wasmjit-cohort-and-pbl-work.patch

Delta between `pin + 0000 + 0001` and the current engine work tree. Two bodies of
work, plus supporting files that were previously uncommitted.

### A. WasmJit "cohort" module fusion (Hotpack)

Baseline WJ topology is 1 JIT function = 1 wasm module = 1 instance, so every
JIT->JIT call goes through a `call_indirect` on the shared table into a *foreign*
instance, which V8 cannot speculatively inline. A standalone probe
(`browser-in-browser/verify/cohort-probe.mjs`) measured same-instance
`call_indirect` at 2.4-2.7x faster than cross-instance in Chrome for small
callees.

`GECKO_WJ_COHORT=N` (off by default) batches up to N compiled functions into one
module/instance:

- Solo compile caches the emitted body bytes in `WJEntry::jitBody`; cohort
  assembly (`WJWarpCompileCohort` -> `AssembleBodiesAndInstall`) is a pure byte
  copy into a shared module - no second Warp/MIR run.
- Call-IC fill records observed caller->callee edges (`gWJCallEdges`); drain
  packs edge endpoints first, expands transitively. Packing is edge-only by
  default (`GECKO_WJ_COHORTPAD=1` restores padding with unrelated pending
  seeds) -- on real site workloads padding packed ~all compiled functions and
  regressed 1.1-1.6x at cap16.
- Members keep their existing shared-table slots (caller IC caches stay valid);
  trampolines are exported as `f`/`f1..`, register-ABI bodies as `m`/`m1..`;
  host dispatch selects the member via `wasmhost_call(handle, memberIdx)`.
- Constructor cache entries are repointed handle+member on cohort install;
  invalidate-all clears jitBody/pending/edges; all script pointers are
  GC-traced in `WJTraceRoots`.
- `wasmhost_jit_table_set(handle, slot, member)` gains a member arg (both
  `gecko.js/lib/` and `bench/spidermonkey.js/` bridges updated).
- Drain fires on pending>=cap, on the `WasmJitDrainDeferred` idle boundary, and
  on IC-fill edge recording when pending>=min(8,cap).
- stats: `cohorts` / `cohortMembers` / `cohortEdgePulls`; `GECKO_WJ_COHORTDBG=1`
  traces installs.

Measured (embed shell, interleaved runs, noisy machine): `micro call-chain`
(16-callee chain) ~15-30% faster at cap>=17; octane/micro results identical
(all sums match); jit-test basic+osr ~1500 tests: failure set identical to
solo (all pre-existing minimal-embed shell gaps, zero cohort regressions).

### B. PBL weval/wizer plumbing (previous session work, unpatch till now)

- `--enable-pbl-weval` configure option + `ENABLE_JS_PBL_WEVAL` (default off);
  `js/src/vm/Weval.h`, `PortableBaselineInterpret-{defs,weval-defs}.h`,
  `third_party/weval`, `third_party/wizer` vendored headers.
- `js/src/shell/wizer.cpp` (Wizer preinit entry for the js shell) - compiled
  unconditionally, the weval bits are config-gated.
- `PortableBaselineInterpret.cpp` interpreter work the above builds on;
  `JSScript.{h,cpp}` + `CacheIRCompiler.*` + `BaselineCacheIRCompiler.cpp`
  supporting changes.
- `mozglue` small fixes (xxhash/SSE/PerfStats build fixes for the wasm target).

### C. Type-storm generic-compare recompile (deopt storm fix)

Lodash `compareAscending` (sort comparator, mixed number/string args)
specialized `value > other` to `Compare_String`; its operand Unbox
tag-guards deopted on ~46% of calls (~1.1M deopts measured).

- `shapeDeoptDom` is now a true majority (shape-family sites > 50% of the
  fn's deopt sites) -- an incidental `GuardSpecificFunction` (lodash's
  `isSymbol`) no longer blocks the count-gate recompile of an
  Unbox-dominated fn. `GuardGlobalGeneration` sites moved to their own
  counter (`hasGggDeopts`) and remain an ABSOLUTE count-gate block
  (respec re-bakes stale globals: the acorn misparse hazard).
- A count-gate storm that survives its fresh recompile gets one extra
  attempt with `e.forceGenericCmp`: fallible MUnboxes consumed only by
  genericable compares drop their tag guards (their typed locals are dead);
  numeric compares emit "both-number -> inline f64 cmp, else WJH_COMPARE";
  String/Symbol/BigInt compares stage the unbox INPUTS into WJH_COMPARE
  with no refinement guards. Cannot deopt; correct for all type pairs.
- `GECKO_WJ_GENERICCMP=1` forces the mode for testing.

Measured (embed, wiki:lodash A/B, NORECOMPILEN=1 as pre-fix): perIter
319.2 -> 303.5ms, deopts @2056 unbounded -> 3000 total then 0.
A storm-threshold PBL fallback alternative was measured ~10% SLOWER and
rejected.

### D. GSF call-guard attribution + genericCall recompile

css-select `combine` closures (dom.js:4181, `a(elem) || b(elem)` over
per-instance upvalue callees) stormed ~200k GuardSpecificFunction deopts/run
that were INVISIBLE to the valve: the deopts happen inside JIT->JIT fast
calls (PIC call_indirect / WJH_CALL's direct wasm call), so no host entry
runs and `e.deopts` stayed ~0 (entry showed 2 while site-hist saw 199k).

- WJH_RESUME attributes GSF deopts to the deopting module's own entry
  (`gWJResumeScriptPtr[nframes-1]`, `WJEntry::gsfDeopts`). Past
  `GECKO_WJ_GSFGATE` (default 1500) -> Cold + `forceGenericCall`; a second
  storm -> Failed (PBL). `GECKO_WJ_NOGSFVALVE` reverts; `GECKO_WJ_GENCALL=1`
  forces the flag for testing.
- Under `be.forceGenericCall`, a GSF whose uses are all call callees (the
  GuardFunctionScript `allCallCallee` precedent) becomes a passthrough --
  the PIC already dispatches polymorphically; a non-callee use (inlined
  region / identity consumer) keeps the guard.
- Measured: synthetic 8-closure repro 7463 -> 972ms (7.7x, SINK identical,
  sitehist silent); wiki:dom 3803 -> 2135ms/iter (1.78x, MICROSUM OK);
  micro --ab all OK; octane deltablue/richards/splay healthy.

## 0003-wasmjit-storm-and-callback-fixes.patch

Delta between `pin + 0000 + 0001 + 0002` and the work tree: the site-workload
deopt-storm fixes and the remaining megamorphic/inline-cache work (see
artifacts/results.md for full measurements; wiki:lodash ~336 -> ~230ms,
wiki:dom ~1020 -> ~971ms, all MICROSUM-verified).

### A. Deopt-storm attribution + PIC invalidation

- Contained (JIT->JIT callee) deopts were charged to the CALLER entry:
  callers of lodash's `compareAscending` stormed -> Failed -> 482k calls/run
  stayed PBL forever (~28% of profile). Deopts are now attributed to the
  outermost resume frame's script (`gWJResumeScriptPtr[nframes-1]`), and the
  storm decision runs on that entry.
- `WJPurgeCallICs(e)` on every Cold/Failed transition (storm valve AND gsf
  valve -- its absence there let stale PIC ways drive a hidden 27.5k-event
  GuardSpecificFunction storm on wiki:dom). Without the purge, callers keep
  invoking the dead module forever.
- Result: lodash deopts 4200 -> 300, failed 2 -> 0, perIter ~336 -> ~274ms.

### B. Native->JS RunScript observation hook + interpreter-only gate

- `js::RunScript` observes interpreted callees and routes them through
  `WasmJitRunCall` once compiled -- native callbacks (array_sort comparator)
  no longer stay PBL forever. `GECKO_WJ_NONATIVEOBS=1` disables.
- `WasmJitObserveCall`/`WasmJitPreCall` now reject `hasForceInterpreterOp()`,
  `isGenerator()`, `isAsync()` scripts: WJ-compiling self-hosted
  `InterpretGeneratorResume` caused infinite wasm<->host recursion
  (V8 stack overflow) via its JSOp::Resume -> jit::InterpretResume ->
  CallSelfHostedFunction -> hook loop.

### C. Megamorphic probes + inline cache work

- Store-side `EmitByValMegaStoreProbe`: dense in-bounds writes, SetPropCache
  atom-key hits, add-prop (newCapacity==0, no incremental marking), array
  extension append; site5 fills via `SetElementMegamorphic<true>`.
  SETPROP helpers 2.4M -> ~100k/run.
- Nursery bump-alloc for WJH_NEWCALLOBJ + WJH_LAMBDA (3.1M -> 253, 1.7M -> 88).
- Bounded (K=8) string-equality inline compare: COMPARE helpers 8M -> ~1.
- Script-keyed call IC + wasm-side fun_call unwrap: closures sharing a
  JSScript hit the same PIC way (megamorphic iteratee sites 0 hits ->
  ~1-2M hits/run); lodash ~2.4x, wiki:dom ~1.3x on top of prior work.
- WJTryNativeFast: Set/Map iterator intrinsics inline via jitInfo().

### D. Misc

- V8 `--perf-basic-prof` names wasm by function index (ignores the name
  section) -- the experimented name-section emit was reverted.
- gczeal=2/7/11 MICROSUM-consistent; the earlier zeal=14 storm-recompile
  crash no longer reproduces after the PIC purge.

### E. wj-nobs debug-map dangling JSScript* (browser crash fix)

The RunScript-hook debug map (`[wj-nobs]`, active unless GECKO_WJ_NOBSDBG)
kept raw JSScript* keys and dereferenced them (`filename()`/`lineno()`) in
the every-500k-calls fprintf. Scripts are GC'd between evals, so on
multi-workload pages (site suite running search+dom+lodash in one engine)
the print walked freed memory -> "memory access out of bounds" trap in
BOTH arms (PBL arm included: hooks still run, entries just never compile).
Reproduced on the v0.0.6 release gecko.js; absent with GECKO_WJ_NOBSDBG=1.
Fix: resolve filename/line/name eagerly at insertion; the print reads only
the stored string. (Also explains the earlier embed sighting of the same
trap shape.)

## 0004-wasmjit-vibey-shape-fold.patch

Delta between `pin + 0000 + 0001 + 0002 + 0003` and the work tree: the
vibey-clover (three.js game bundle) deopt-storm fixes. All verified on the
site bench suite (bench/site, `run.sh vibey`/`wiki`); every vibey workload
now beats PBL (vibeyboot 0.37x -> 1.31x, jsparse 1.28x, frame3d 9.4x).

### A. Unsigned-right-shift result typing (mulberry32/LCG PRNG storm)

`x >>> 0` (or any shift whose count can be 0 mod 32) can produce a bit31-set
result whose true JS value is a Double, but MIR typed MUrsh Int32 and the
deopt->resume path never updates the IC -- so the function deopted on ~every
call forever (three.js's PRNG runs every frame). Post-OptimizeMIR MIR pass
flips such MUrsh to Double (dblUrsh path: i32.shr_u -> f64.convert_i32_u)
and wraps non-Int32 bitop operands in MTruncateToInt32 (Ion lowers these at
the LIR operand-policy layer, which WJ does not have).

### B. Proxy ops (GuardIsProxy / GuardIsNotDOMProxy / ProxyGet / ProxySet)

GuardIsProxy: inline clasp->JSCLASS_IS_PROXY check. GuardIsNotDOMProxy:
ProxyData handler -> BaseProxyHandler::mFamily vs baked
GetDOMProxyHandlerFamily(). MProxyGet[ByValue] -> WJH helpers calling
js::ProxyGetProperty[ByValue]; MProxySet[ByValue] likewise (site bit0 =
strict). vibeyboot now compiles clean: failed=0, zero unsupported ops.

### C. Compile-time cold stub folding (acorn Parser lazy-prop storm)

Acorn's Parser adds `inTemplateElement` lazily mid-parse (one-way shape
transition S3->S4). Compiled methods bake whichever shape is firstStub, but
the IC's older stub keeps enteredCount=0 after the attach reset, so
TryFoldingStubs (numActive==0 gate) never folds and the transpiler bakes a
single shape -> perpetual oscillating storm as each parse() creates a fresh
S3 parser. `TryFoldingStubs{,Locked}` gains a `foldCold` flag (default off);
maybeInlineIC passes true (GECKO_WJ_NOCOLDFOLD kills). Folds zero-entered
stubs whose chain differs only in a WeakShape field -> GuardMultipleShapes
-> MGuardShapeList (already lowered). Coverage superset, always safe.

### D. Diagnostics (all env-gated)

GECKO_WJ_ICDBG2=<line>: per-stub dump at compile time (stub shapes + last
prop key). GECKO_WJ_GSRT/THISDBG/GSDUMP: expected-vs-actual shape on
GuardShape deopts; guarded-operand MIR op + expected-shape keys at emit.

Measured: vibey:jsparse 11787 -> ~5250ms/iter (fold; ~2.2x, PBL 9-10s);
vibeyboot 8406 -> ~350-675ms/iter vs PBL ~340-880. MICROSUM/JSSCORE
identical; micro suite + wiki trio no regressions.

## 0005-wasmjit-depth-limit-calibration.patch

JIT'd JS recursion killed the engine on x.com: gWJJitDepth's guard existed but
its 2.5MB byte limit was baked ABOVE V8's real ~1MB wasm call stack, so deep
recursion hit the host's uncatchable RangeError (`wasm-function[1]` self-call
loop) instead of the catchable ReportOverRecursed throw, killing the app
pthread outright (probe: JIT f(3000) dead; PBL f(500000) throws InternalError
and survives).

- gWJJitDepthLimit becomes a runtime-mutable global (default 480000 -> <=600
  frames of any guarded fn even uncalibrated). EmitDepthCheck loads it per
  entry instead of baking the const; GECKO_WJ_DEPTHLIMIT still bakes an
  override and disables calibration.
- Per-frame charge gets a floor: fb = max(frameBytesEst, 800). The estimate
  misses operand-stack slots, so real V8 Liftoff frames run ~700B+ even for
  tiny fns; without the floor thin fns under-charge and the guard fires late.
- wj_set_depth_limit export; wasm-host-bridge probes the real host stack once
  per worker realm at first wasmhost_instantiate: a wasm fn with a fat frame
  (96 f64 locals, ~860B real > thin JIT frames) recurses until the host
  RangeErrors, then sets limit = depth * 800 * 0.6 clamped [200000, 2800000].

## 0006-windowless-window-provider.patch

`WebBrowserChrome2Stub` gains `nsIWindowProvider`: `_blank` links and
`window.open` in the windowless browser hit `nsIWindowWatcher` with no
provider and no `mWindowCreator` -> `NS_ERROR_FAILURE` before the
`browser.link.open_newwindow` pref is ever consulted. The provider returns
the browser's own docshell with `aWindowIsNew=false`, so the load lands in
the current window (no opener assertion, no resize path). Combined with
`browser.link.open_newwindow=1` + `browser.link.open_newwindow.restriction=0`
in embed-init prefs.

## 0007-wasmjit-depth-suspend.patch

Fixes two recursion-guard bugs and turns depth overflow into a delegated
PBL subtree instead of a throw.

- **Placement bug (the real x.com crasher)**: EmitDepthCheck was invoked in
  EmitBlockBody "at the first block", but the dispatch-loop emitter walks
  MIR blocks in REVERSE RPO (`bi = n-1-ri`), so the guard landed in a
  terminal return pad and never ran on entry. Verified: `DEPTHLIMIT=0`
  still recursed to the host stack limit inside `wasm-function[1]`.
  EmitDepthCheck now runs in the straight-line PROLOGUE (after the GGG/argc
  entry checks, before the env-root push), covering single-block, relooper
  and dispatch bodies plus the OSR trampoline re-entry. The refusal arms no
  longer pop env roots (nothing is pushed yet at that point).
- **Suspend latch**: overflow no longer throws or returns flag 2.0 (GGG
  accounting would misfire). It restores gWJJitDepth, min-updates
  `gWJSuspendWatermark`, and returns a dedicated flag 3.0. Every JS->WJ edge
  (PreCall, ObserveCall, RunCall, WJH_CALL fast path, OSR resume, ctor
  caches) refuses while `gWJJitDepth >= watermark`, so the delegated subtree
  runs entirely in PBL; the latch self-clears when the delegating wasm
  frames unwind (EmitDepthPop drops below the watermark) and RunCall clears
  it at depth 0. Callsite flag compares became `flag < 2.0` so 2 and 3 both
  take the slow path; flag 3 never increments gggDeopts.
- `GECKO_WJ_DEPTHLIMIT` now tests env PRESENCE (0 previously fell back to
  the default, masking refusal paths in tests). `GECKO_WJ_DEPTHTHROW` keeps
  the old throw mode. New env-gated diagnostic helper kind 253
  (`GECKO_WJ_SUSDBG`, prints refusals); kind 250 was already WJH_TRACE's.

Verified locally (embed build): try/finally self-recursion and plain
recursion both delegate and complete (fin(2600), f(3000)-4500); truly
excessive recursion throws catchable InternalError (PBL quota) and the
process survives. Octane richards 4092 vs 4254 unguarded (~4% worst-case
entry cost); earley/splay/deltablue unchanged-correct.

## 0008-wasmjit-fresh-script-family.patch

Same-source fresh scripts (every `new Function("x","return x*2+1")` call
makes a new JSScript) used to each pay the full warmup + compile cost --
or never compiled at all, when each clone died before the per-script
threshold. SM already dedups bytecode+atoms into a shared
`SharedImmutableScriptData` (verified: 50 clones -> identical sd pointer),
so that sd is a zero-cost family key. One shared compile now serves the
whole family.

### A. Family records (WasmJitRuntime.cpp)

- `gFamilies`: `SharedImmutableScriptData* -> WJFamily`, realm-confined
  (baked GGG/global cells are realm-specific). The sd key is AddRef'd --
  `SweepScriptDataTable` frees interned data with no live scripts, and the
  family record is long-lived.
- `WasmJitFamilyObserve(script)` counts aggregate cold calls; at
  `GECKO_WJ_FAMWARM` (default 64) it arms `compilePending` and the caller
  routes through the normal ObserveCall path. `refCount() >= 3` gate keeps
  one-off interned-but-never-cloned scripts out of the map.
- The next eligible member (has jitScript -- Warp needs BaselineIC
  feedback; not eval/module/generator/async) gets the shared compile
  (`gWJSharedCompile`); on success the artifact metadata (handle, tblSlot,
  directIdx, jitBody, osrTargets, ...) publishes onto the family and the
  representative entry links to it.
- Later siblings alias-install (`WJAliasInstall`) instead of compiling --
  creating their jitScript first, since a deopt resume requires it and the
  alias path skips the compile that would have made it.

### B. Member compatibility (the load-bearing check)

gcthings live in per-script `PrivateScriptData`, NOT in the shared sd --
each clone measured its own body-Scope cell. The shared artifact bakes the
representative's cells, so a member may run it iff every gcthing actually
REFERENCED by a bytecode immediate is pointer-identical:
`WJMemberCompatible` scans the representative's bytecode for JOF_GCTHING /
OBJECT / REGEXP / SCOPE / BIGINT / STRING / SHAPE / ATOM ops (all read
GCThingIndex at pc+1; atoms share cells realm-wide so they pass naturally)
and compares `GCCellPtr::asCell()`. Unreferenced slots (the outermost
scope every function carries) may differ. Verified: lambda/object-template
clones correctly FAIL (`gcmp FAIL kind=0`, per-clone template cells) and
fall back to per-script compile; the inner same-source lambdas form their
own compatible family.

### C. Runtime-bound resume (WasmJitBackend)

The artifact can no longer bake `info.script()` into
`gWJResumeScriptPtr[outermost]` -- an alias must resume its OWN script.
In shared mode the emit loads it at runtime: `gWJCallRoots[envRootIdx+1]`
(the rooted runtime callee) -> `JSFunction::offsetOfJitInfoOrScript`.
Shared compiles force `usesCallee`/`useEnvRoot` and bail on inlined
frames (`shared-inline`) -- inline frames would bake the representative's
callee scripts. pcOff/nargs/nlocals stay baked: the bytecode is identical
across the family.

### D. Call-edge coverage + lifecycle

- FamilyObserve runs BEFORE the per-script warmup gates on all four call
  edges: PBL fast path (pre-jitScript block and the warmUpCount>=10 gate),
  the direct `Interpret` Call-op dispatch (which bypasses RunScript), and
  the RunScript invoke path (native->JS callbacks).
- The rep script is rooted in `WJTraceRoots` (it owns both the
  member-compat reference cells and every baked gcthing).
- `WJStormDecision` detaches aliases (fresh tblSlot, charge family deopts)
  only INSIDE the transition -- detach-before-check previously left a
  Compiled entry with tblSlot=-1 on the below-threshold return. Family
  artifacts accumulate deopts across members; >=1000 fails the family so
  no NEW sibling aliases (existing aliases keep their own valves).
- Shared artifacts are excluded from cohort fusion (fusion rewrites
  tblSlot; sibling aliases would keep the stale slot).
- `WasmJitInvalidateAll` resets Compiled families to Warming (rep/slots/
  counters cleared) and unlinks `entry.family` everywhere.

`GECKO_WJ_NOFAMILY=1` disables; `GECKO_WJ_FAMDBG`/`GECKO_WJ_SDDBG` trace.

Measured (embed shell): 50-clone `new Function` bench does ONE shared
compile + 49 alias installs (~52 compiles -> 3 total in the run),
acc=72000000 correct. 200-clone perf probe: family ~288ms vs per-script
WJ (NOFAMILY) ~500ms vs PBL-only ~670ms. Deopt through an alias on a
changed arg type resumes the member's own script (fresh str/num correct).
Env/global reads, deep-recursion suspend delegation, and invalidate-all
all verified. Octane + realapp suites: no family ever activates there (no
refCount>=3 sd), results unchanged. jit-test function/eval/arguments
subset: 36 failures, ALL identical with GECKO_WJ_NOFAMILY=1 (pre-existing
embed gaps -- no decompileFunction/drainJobQueue/Debugger/module loader).

## 0009-wasmjit-pbl-deeper-stack.patch

x.com verification of the 0007 suspend latch showed delegation WORKS
(`[wj-sus]` fires, watermark latches, engine survives -- the old failure was
an uncatchable V8 RangeError killing the app pthread) but the delegated
sentry-filter recursion then hits PBL's own quota and the React onboarding
still doesn't mount. Root cause of that quota: `PortableBaselineStack` is a
fixed 512KB heap region; each delegated frame costs ~120B of StackVal, so a
delegated subtree dies at ~4359 frames even though PBL frames are heap, not
native stack.

- `DEFAULT_SIZE` 512KB -> 4MB. Measured (embed, NOWASMJIT): plain-recursion
  quota 4359 -> 34943 frames; host-boundary recursion (nested
  `Array.prototype.map` callbacks) 1167 -> 9359 levels -- the shadow stack is
  per-runtime shared, so nested PBL entries accumulate on it too.
- `GECKO_PBL_STACKKB=<kb>` overrides the size at JSRuntime init for tests
  (512 -> 4359 frames, 8192 -> 69895; linear).
- WJ path verified end-to-end: suspend watermark delegates at the depth cap
  and the PBL subtree now completes 20000-deep recursion (was ~4300).
  Over-quota still throws catchable InternalError; family tests all pass.

Cost: js_calloc commits the 4MB inside wasm linear memory per JSRuntime --
bounded and trivial next to the engine heap.

## 0010-emscripten-native-stack-quota.patch

x.com verification after 0007+0009 showed suspend delegation works and the
PBL shadow stack is no longer the wall, but `sentry-filter` still dies with a
catchable `InternalError: too much recursion` before React mounts. Root cause:
`XPCJSContext::Initialize` falls into the catch-all quota branch because
`canonical_os` for wasm targets is `EMSCRIPTEN`, not `XP_LINUX`. That sets
`kUncappedStackQuota = kDefaultStackQuota` = 512KB on wasm32, so untrusted
content JS gets only ~452KB of the 64MB linear-memory stack -- measured
~9469 host-boundary recursion levels before the quota error. The pref cap
(2MB) cannot help since it only lowers the quota.

- New `#elif defined(__EMSCRIPTEN__)` branch derives the uncapped quota from
  the real region: `(emscripten_stack_get_base - emscripten_stack_get_end)/2`
  (32MB with `STACK_SIZE=64MB`), floored at `kDefaultStackQuota`.
  `GECKO_NATIVE_QUOTAMB=<mb>` overrides at runtime.
- `kTrustedScriptBuffer` = 1MB so untrusted script keeps ~31MB.
- `kStackQuota`: the 2MB web-compat cap assumes 1-8MB native stacks; on
  emscripten it becomes `max(uncapped, cap)` so the pref can only raise the
  quota, never squeeze it below the derived value.
- `StaticPrefList.yaml` is NOT conditional on `EMSCRIPTEN` (the define never
  reaches `ALLDEFINES`); the cap handling lives in C++ instead.

Expected effect: untrusted recursion budget ~452KB -> ~31MB (~60x), i.e.
~620k host-boundary levels. Still catchable: quota < real stack, so
over-quota throws `InternalError` before a real wasm stack overflow.

## 0015-wasmjit-host-stack-charge.patch

With the wasm JIT on, YouTube killed the app pthread in every trial: an
uncatchable V8 `RangeError: Maximum call stack size exceeded` a few seconds
after the home page loaded. The overflowing stack (named on a `wasm-opt -g`
build) is BotGuard's nested-eval VM recursing through JIT and PBL in turn:

```text
JIT fn → hostImports/_wjhelp (JS) → wjhelp → wjhelpImpl
  → PortableBaselineInterpret → ICInterpretOps → ICCallFallback
  → InternalCallOrConstruct → RunScript → Interpret → MaybeEnterJit
  → PortableBaselineInterpret → … → WasmJitRunCall → JIT fn → …
```

The 0005/0007 depth guard charges only emitted JIT frames. Everything else in
that cycle stays on the host (V8) stack and never moves the linear-memory
stack that SpiderMonkey's recursion quota watches (0010 widened that quota to
~31 MB, so it cannot fire first). In four identical 1357-frame overflows there
were 214 JIT frames, 67 PBL→JIT crossings and 129 PBL activations, and the
guard had charged 151584 of its 298080 limit: the host stack ran out at about
half the budget, before the suspend latch could fire. PBL alone overflows too:
with the JIT off, a page recursing through `Function.prototype.apply` killed
the thread at 469 levels. This patch does not fix that JIT-off case in a JSPI
embedding (see the headroom check below).

- **PBL→JIT edge charge.** `WasmJitRunCall` adds a fixed cost to
  `gWJJitDepth` for the duration of the JIT call (default 12288,
  `GECKO_WJ_HOSTCHARGE`). Past the limit it refuses and latches the suspend
  watermark, so the callee's subtree runs on PBL's heap stack exactly as if
  the callee's prologue guard had refused; a callee's own flag-3 refusal
  re-latches at the caller's depth. A crossing costs about four times a PBL
  level on the host stack, so the large charge latches a mixed recursion at
  roughly a fifth of the stack and leaves the PBL tail the rest — BotGuard's
  recursion then completes, as it does with the JIT off.
- **PBL activation charge.** Every `PortableBaselineInterpret` activation on
  the JIT's runtime charges `GECKO_WJ_PBLCHARGE` (default 1792) for its
  lifetime, so the JIT does not start a deep recursion on top of a deep PBL
  one.
- **The charges are tuning, not safety.** 12288 and 1792 come from one machine
  and one Chromium build (114 vs 469 apply levels at limit 298080). They are in
  the limit's byte-like units, so they do not scale with the calibrated limit.
  They decide only when the JIT latches: a wrong value costs speed, not a
  crash. The headroom check is the safety net; do not retune the charges
  expecting them to prevent an overflow.
- **Host-stack headroom check.** A PBL activation nested more than 24 deep on
  the JIT's thread, and at least 8 levels deeper than the last probe that
  passed, asks the host whether 256 more frames of a probe module fit
  (`wasmhost_stack_headroom`, in both `wasm-host-bridge.js` files). Each probe
  frame keeps 64 `f64`s loaded from memory that deeper frames overwrite live
  across its call, so it costs ~580 B under Liftoff and TurboFan alike (~145 KB
  in all). A first probe whose values could be recomputed after the call shrank
  more than 2× once TurboFan compiled it, and the JIT-off path still overflowed
  between checks in Surf. If the probe does not fit, the activation
  reports a catchable `InternalError: too much recursion` instead of letting
  V8's stack overflow. Only probe frames unwind on the probe's `RangeError`,
  inside the host's try/catch. This measures instead of estimating: a PBL
  level's real cost varies several-fold with V8's tier for the interpreter, so
  no fixed charge both stops before the limit and lets recursion that fits
  finish. One passing probe vouches for ~145 KB, about 30 JIT↔PBL crossings at
  the measured ~4.4 KB each, hence the 8-level step.
  `GECKO_PBL_HEADROOM=0` disables it; `GECKO_PBL_HEADROOMFRAMES=<n>` sizes it.
- **JIT-off / JSPI gap.** The probe is a JS import, so it measures the host's
  central stack, which a JIT↔PBL recursion fills through the JS shims. In an
  embedding that runs threads under JSPI, a JIT-off recursion stays in wasm on
  the secondary stack, which this JS-hosted probe cannot measure; that case can
  still overflow. The probe therefore runs only where the JIT does (it would
  cost a 145 KB recursion per check and never fire). In the JS-only shell
  (no JSPI) it would cover JIT-off recursion too, but it is skipped there as
  well.
- **Stackless over-recursion error (superseded by 0018; now opt-in with
  `GECKO_WJ_OVERSTACKLESS=1`).** The headroom `InternalError` is built by
  `JSContext::onOverRecursedStackless`: `message` is `"too much recursion"`,
  `instanceof InternalError` holds and the exception status is `OverRecursed`
  as for `ReportOverRecursed` (so wasm `catch` and `Debugger` treat it the
  same), but it carries no captured stack: `e.stack === ""` (a string, so
  `e.stack.split()` is safe, but `if (e.stack)` takes the other branch),
  `fileName` is `""`, `lineNumber` 0, `columnNumber` 1. If building it fails,
  the OOM stays pending. The capture walks at most `MAX_REPORTED_STACK_DEPTH`
  (128) frames, yet at this point in Surf it read past linear memory in 5 of
  10 JIT-on YouTube loads, while reports without it never crashed (0 of 7,
  then 0 of 12): a frame link near the top of a deep JIT↔PBL stack is
  sometimes unwalkable. Dropping this capture avoids one walker of that
  chain; the root cause is open. Other full walks at that depth (page
  `new Error().stack`, `console.trace`, the embedder's caller lookups, GC
  tracing of JIT activations) may still hit it — likely the same family as the
  GC stale-pointer crashes still seen with the JIT on.
  `GECKO_WJ_OVERCAPTURE=1` captured a stack anyway (A/B). The crashing walk
  turned out to be 0017's re-raise; 0018 captures a normal stack again.
- **Diagnostics.** `GECKO_WJ_FRAMEDBG` walks every JIT activation's frame
  chain with bounds checks before a headroom report and prints the first bad
  link (`[wj-frames]`). It follows `jsExitFP → callerFramePtr`, not
  `JSJitFrameIter`'s stepping, so finding no bad link does not prove the chain
  a capture reads is intact. `GECKO_WJ_CALLDBG` names any value from another
  compartment or zone before `wjhelp` calls `JS::Call` (the generic call, the
  `apply` fast path, class field initializers) and flags an `apply` arguments
  object that is not an `ArrayObject` (`[wj-calldbg]`): a mismatched value there
  is a `js::ContextChecks` crash (`unreachable`).
- **Watermark reset.** PBL activations keep the charged depth above 0, so
  `RunCall` now clears a stale watermark whenever it runs below it (nothing
  below the watermark is inside a delegated subtree), not only at depth 0.
- **The JIT runs on the main runtime only.** `WasmJitPreCall`,
  `WasmJitObserveCall`, `WasmJitFamilyObserve` and `WasmJitRunCall` now refuse
  on worker runtimes (`parentRuntime` set; cached per thread), so DOM workers
  run on PBL alone. Before, a worker's PBL could compile and enter JIT code,
  and its prologues and epilogues saved and restored the same process-global
  `gWJJitDepth`, `gWJSuspendWatermark`, `gWJScratch` and `gWJCallRoots` the
  main thread used, with no synchronization (`gEntries`, an
  `std::unordered_map` keyed by `JSScript*`, too). Interleaved save/restore
  pairs leave the depth drifted, and the activation charges above would have
  widened that window to the main thread's whole script lifetime. The race
  may be related to the GC stale-pointer crashes seen with the JIT on. This
  covers JIT *execution* only: worker GCs, worker fuse pops and worker
  calibration still reached the main runtime's JIT state until 0016.

`GECKO_WJ_HOSTCHARGE=0` turns the charges off and makes `WasmJitRunCall` the
original code exactly (A/B opt-out for the JIT overflow; add
`GECKO_PBL_HEADROOM=0` for the whole patch off). They are off with
`GECKO_NOWASMJIT` and on worker runtimes. `GECKO_WJ_SUSDBG` adds
`[wj-hostsus]` (edge refusals) and `[wj-hostcap]` (headroom refusals).

Regression probe: `node bench/main.ts micro host-reentry` recurses 200000
levels through `Function.prototype.call` and `Array.prototype.map` callbacks.
With 0015 and the JIT on, both recursions end in a catchable `InternalError`
and the run prints `MICROSUM=3202` (node's default stack). With
`GECKO_PBL_HEADROOM=0` the embed dies with V8's `RangeError`, and
`GECKO_WJ_HOSTCHARGE=0` alone still lets a JIT↔native recursion
(`f.apply` at depth 2000) overflow. With `GECKO_NOWASMJIT` the probe does not
run and the embed dies as it did before 0015 (the JIT-off gap above). Octane richards/deltablue/earley/raytrace
and the call-chain/native-call/try-catch/kitchen-sink micros keep their `--ab`
checksums; earley no longer latches at any charge and moves by run-to-run noise
(12587 at the default charge vs 13295 with charges off).

## 0016-wasmjit-worker-routes.patch

0015 keeps worker runtimes from running the wasm JIT, but four routes still
reached the main runtime's JIT state, or other unsynchronized statics, from a
DOM worker's thread:

- **GC roots.** `GCRuntime::traceRuntimeForMajorGC`/`ForMinorGC` called
  `WJTraceRoots` for every runtime. A worker's major GC asked the main
  runtime's zones whether to mark the cells in `gWJScratch`, `gWJCallRoots` and
  the shape and constant pools, and could mark and traverse the main heap from
  the worker thread while the main thread's marker and mutator ran (the
  runtime-ownership check is debug-only). Now only the main runtime traces
  them; `GECKO_WJ_WORKERTRACE=1` restores tracing from every runtime (A/B).
  Not proven to be the cause of the parallel-mark crashes seen with the JIT
  on, but it is a route to them.
- **Fuse pops.** `WasmJitInvalidateAll` ran on every realm's fuse pop and
  cleared `gEntries`, `gFamilies` and the call tables from the worker thread.
  A worker's fuse never guards JIT code, so it now returns on worker runtimes.
  `GECKO_WJ_WORKERFUSE=1` lets worker fuse pops invalidate again (A/B). The
  main thread's compiled code now survives a page load, so a deep JIT↔PBL
  recursion carries more JIT frames; that made the 0017 crash below about
  three times as frequent until 0017 fixed it.
- **Calibration.** Every pthread realm's first wasm instantiation called
  `wj_set_depth_limit`; the last thread to calibrate set the JIT's limit. Worker
  runtimes' calls are ignored.
- **Native-callback observe block in `js::Interpret`.** It ran on every thread,
  with the JIT off too, bumping unsynchronized static counters and inserting
  into a static `std::unordered_map<JSScript*, …>` on every native→JS
  callback. It now runs only where the JIT does, and the per-function table
  (unbounded, with dangling keys) is opt-in: `GECKO_WJ_NOBSFN=1`.

`WasmJitInWasm` (the decompiler's "inside JIT code" check) also answers false
off the JIT's thread. A thread with no `JSContext` is treated as the main
runtime's for the fuse and calibration routes, so nothing the main runtime
used to do is skipped.

## 0017-pbl-unwind-reraise.patch

With the JIT on, YouTube still lost the app thread in some trials to a
`memory access out of bounds`, a few log lines after the 0015 headroom
reports. A `wasm-opt -g` build named the stack:

```text
js::jit::JSJitFrameIter::operator++
  ← js::FrameIter::settleOnActivation ← js::FrameIter::FrameIter
  ← js::SavedStacks::saveCurrentStack ← JS::CaptureCurrentStack
  ← js::CaptureStack ← JSContext::setPendingException(v, ShouldCaptureStack)
  ← PortableBaselineInterpret (cross-activation unwind re-raise)
```

When `HandleException` finds a catch or finally in an outer PBL activation, the
inner activation returns `Unwind`/`UnwindError` and first re-raises the
in-flight exception so every boundary sees one pending (`gPBLUnwindExc`). That
re-raise had three faults:

- It called `setPendingException(v, ShouldCaptureStack::Maybe)`, which captures
  a stack for a realm's first 50 throws, and on every throw in a debuggee realm
  or one with the trusted (chrome) principals
  (`Realm::shouldCaptureStackForThrow`), so chrome code met this on every
  cross-activation unwind. By then the exit frame
  `HandleException` ran under had been popped, so the walk started from a stale
  exit FP in unwound PBL stack, and under a deep recursion it read past linear
  memory.
- For a `Catch`, `HandleException` leaves the exception pending and fills
  `rfe.exception` only for a `Finally`. So the re-raise replaced the real
  exception with `undefined` in every cross-activation catch: all 320 re-raises
  logged in one session were `pending=1 saved=undefined`.
- When the catch resumed inside the same activation, `gPBLUnwindHaveExc` stayed
  set over an untraced exception `Value`, which a later cross-activation unwind
  could re-raise after a GC had moved or freed it.

`PBLReraiseUnwindException` now keeps a pending exception as it is, and
otherwise re-raises the saved value with the stack saved when it was thrown.
It never captures. The flag is cleared when the target is in this activation.
`GECKO_PBL_OLDREUNWIND=1` restores the old re-raise (A/B), and
`GECKO_PBL_REUNWINDDBG=1` logs each re-raise (`[pbl-reunwind]`).

On the named diagnostic build, with JIT-on YouTube watch→home:

| Arm | Trials | App-thread deaths |
|---|---|---|
| 0017 | 12 | 0 (headroom reports in 10) |
| `GECKO_PBL_OLDREUNWIND=1` | 8 | 2, both the stack above ending in the re-raise |
| JIT off | 5 | 0 |

The stack-capture crash that 0015 attributed to its over-recursion report has
the same chain. It was likely this re-raise; 0018 drops the stackless default.

## 0018-pbl-unwind-carry.patch

Follow-ups to 0017 from its review, plus 0015's report:

- **The unwind carry is per thread.** `gPBLUnwinding`, `gPBLUnwindFP`,
  `gPBLUnwindSP`, `gPBLUnwindExc`, `gPBLUnwindExcStack` and
  `gPBLUnwindHaveExc` are `static thread_local`. PBL runs on every thread,
  so a DOM worker catching an exception wrote the same process-wide carry the
  main thread could be between saving and re-raising: with 0017 only the
  cross-activation Finally read it, but a worker could clear the flag (the
  finally then ended with nothing pending) or swap in a value from its own
  runtime.
- **The carried values are cleared with the flag** (`PBLClearUnwindException`),
  so no GC pointer stays behind in an untraced global, and the re-raise roots
  them before clearing.
- **A cross-compartment stack survives the re-raise.** `HandleException` wraps
  the saved stack into the current compartment, so it can be a wrapper; the
  re-raise unwraps it with `maybeUnwrapIf<SavedFrame>()`, as
  `ThrowWithStackOperation` does, instead of dropping it.
- **The headroom over-recursion report has a stack again.** 0015 reported it
  without one after its capture crashed in 5 of 10 JIT-on YouTube loads; that
  crash was 0017's re-raise. On the 0016+0017 candidate, with
  `GECKO_WJ_OVERCAPTURE=1`, 12 JIT-on loads had 13 headroom reports and no
  deaths, and the recursion page ended in catchable errors as before. So the
  report is `js::ReportOverRecursed` again: `e.stack`, `fileName` and
  `lineNumber` are normal. `GECKO_WJ_OVERSTACKLESS` set to any value but `0`
  keeps the stackless form (and `GECKO_WJ_OVERCAPTURE` is gone). On the 0018
  build, 24 JIT-on YouTube loads made 45 captured reports in 19 of them, none
  fatal; with the 13 above, 58 captured reports and no crash.
- `RootMarking.cpp`'s comment no longer says `WJTraceRoots` is registered as an
  extra-roots tracer: both GC paths call it directly.
- `GECKO_WJ_CALLDBG` reports more on the `apply` fast path (`WJH_APPLYARRAY`).
  When an argument or the array itself is from another compartment than the
  context, it prints the context's, the array's, the callee's and `this`'s
  compartments, and each object element's compartment, class and wrapper
  flag. A JIT-on YouTube run hit a `js::ContextChecks` crash
  (`unreachable`) there: one element of a packed `ArrayObject` belonged to
  another compartment, while `this` and the callee did not.

## 0019-cache-workerref-remove-actor.patch

`CacheWorkerRef::RemoveActor` (dom/cache) removed the actor from its list
inside the assertion on non-release builds:

```cpp
#if defined(RELEASE_OR_BETA)
  mActorList.RemoveElement(&aActor);
#else
  MOZ_DIAGNOSTIC_ASSERT(mActorList.RemoveElement(&aActor));
#endif
```

This build's configuration leaves `MOZ_DIAGNOSTIC_ASSERT` disabled while
`RELEASE_OR_BETA` is undefined, so the macro, and the removal with it, compile
to nothing. Why: `moz.configure` defines `MOZ_DIAGNOSTIC_ASSERT_ENABLED` only
for debug builds or when `milestone.is_early_beta_or_earlier`, and on a
non-`--as-milestone` build that comes from `build/defines.sh`. The pinned
source's `build/defines.sh` sets `EARLY_BETA_OR_EARLIER=` (empty) on purpose:
its comment says "Unset for this embedding", because live diagnostic asserts
cost time in the hot paths PBL runs and turn benign nightly-only assertions
into engine-killing crashes on real sites. On this `--disable-debug` build with
milestone `153.0a1` it is therefore false: not a release or beta build, yet no
diagnostic asserts either. That combination is a known hazard for future
patches. Any code that relies on `!RELEASE_OR_BETA` implying live diagnostic
asserts, such as a side effect inside `MOZ_DIAGNOSTIC_ASSERT`, silently loses
it here. This patch leaves the configuration as it is. The extracted `RemoveActor` in the shipped `gecko.wasm` has no
`RemoveElement` code. Every DOM Cache actor therefore stayed in its worker
ref's list after it was destroyed. When the worker shut down,
`CacheWorkerRef::Notify()` called the virtual `StartDestroy()` on each freed
actor. A garbage vtable word ended the worker with `null function`. Memory
reused by another object ended it with `function signature mismatch`, or called
into that object and wrote to the heap every thread shares. The list never
emptied, so no `CacheWorkerRef` or its `StrongWorkerRef` was ever freed.

A trace of one load showed the sequence. An actor was added to a ref (`n=1`),
removed from it (`contained=1 n=1`) and destroyed. At shutdown that ref still
listed the actor, its vtable word `0x20021`, and the worker died calling it.
Across two loads there were 132 removals and no `CacheWorkerRef` destructor
call. Every worker death in these runs had this stack:
`CacheWorkerRef::Create`'s lambda ← `WorkerRef::Notify` ←
`WorkerPrivate::NotifyWorkerRefs`.

The patch removes the element unconditionally and asserts on the result. A
search of the tree for the same shape (`#if RELEASE_OR_BETA` with a side effect
inside the `MOZ_DIAGNOSTIC_ASSERT` branch) finds only this site.

## 0022-wasmjit-current-actuals.patch

The wasm JIT staged a function's actual arguments for `arguments` objects
(`CreateArgumentsObject`) and rest arrays (`Rest`) from the raw wasm params
(`kWJArg0Param + i`). Raw params are never spilled or reloaded across a GC. When
a minor GC ran earlier in the same function, for example in the out-of-line
path of an inline allocation that found the nursery full, an object argument
had moved but the raw param still held its old address. The `arguments` object
or rest array then captured that stale pointer. A later `apply` or copy built an
array around it, and the next GC or property read hit garbage. In the browser
it showed up as an `apply` element whose class word was garbage (a forwarded
nursery cell), and as GC-time out-of-bounds reads. The deopt-resume actuals
graft had the same bug earlier and was fixed to read the traced arg-root slots;
these two staging paths were not.

The patch adds `EmitCurrentActual(i)`, which pushes the actual as it is now:
- the traced arg-root shadow slot when the function roots its actuals
  (`needsArgRoots`, which every staging op sets for its own script);
- else the formal's GC-rooted copy local;
- else the raw param.

Every read of a raw arg param now goes through it or is proven safe:

| Site | Status |
|---|---|
| `CreateArgumentsObject` staging | fixed (was the raw param) |
| `Rest` staging | fixed (was the raw param) |
| deopt-resume actuals graft | uses the helper (same behaviour as before) |
| `GetFrameArgument` | uses the helper (same behaviour as before) |
| `Parameter` value emission, formals | uses the helper (1) |
| `Parameter` value emission, `this` | safe: entry-block order (2) |
| `GetOp` / spill fallback, formals | uses the helper (3) |
| `GetOp` / spill fallback, `this` | safe: `this` always has a copy local |
| prologue copy of each param into its copy local | safe: runs at entry, before any GC point |
| prologue push of the actuals into the arg-root slots | safe: runs at entry, before any GC point |

1. The entry block's Parameters precede its GC points today, but the read no
   longer depends on that order.
2. The `THIS_SLOT` branch still reads `kWJThisParam` raw. `this` has no
   arg-root shadow slot; the read is safe because the entry block's
   Parameters precede its GC points.
3. Every value-typed Parameter gets a copy local, so the fallback is not
   expected to run.

`bench/microbenches/args-gc.js` reproduces it in the shell, one half per
staging op. Each half allocates a call object (a minor GC can run in its
out-of-line path), then builds `arguments` or a rest array and passes it
through `apply`. The `arguments` half captures a local copy, not the formal:
a captured formal in a non-strict function makes the backend bail to the
interpreter, so it would never reach the fixed staging. Expected output:
`ARGSGC_ARGUMENTS=1650000` and `ARGSGC_REST=1050000`. Before the patch two
runs printed 1649822/1049837 and 1649865/1049753; after it, both printed the
expected values, as does the interpreter (`GECKO_NOWASMJIT=1`).

## 0023-wasmjit-args-metadata-slots.patch

`CreateArgumentsObject` and `Rest` stage every actual into
`scratch[0..kWJMaxArgs-1]` and then their bookkeeping for the helper:
the callee, environment and argc for an `arguments` object, numFormals and
argc for a rest array. The bookkeeping went to fixed slots 8, 9 and 10. That
was correct when the JIT took at most 8 actuals, but 0001 raised `kWJMaxArgs`
to 16 and the entry guard admits up to 16. A call with 9 to 16 actuals had
actuals 8-10 overwritten by the bookkeeping. The `arguments` object then held
the callee and the environment object as elements, and a rest array was
built from the same corrupted slots.

The patch adds `kWJArgsMetaSlot = kWJMaxArgs` and moves the bookkeeping
there, in the backend and in both helpers. A `static_assert` keeps it below
the construct slots (`kWJCalleeSlot`). The slots stay inside the traced
scratch range, so the callee and environment are still updated by a moving
GC.

`bench/microbenches/wide-args.js` calls three functions, with 12 actuals and
again with 16 (the most the JIT accepts): one reads `arguments`, one a rest
array, one two formals plus a rest array. Each sums its actuals 200000 times;
the 12-actual cases should print 15600000 and the 16-actual cases 27200000.
Before the patch the `arguments` cases threw `TypeError: can't convert ({})
to primitive type` (the environment object among the actuals) and the rest
cases came out short (for example 11815181 and 23401900). After it, every
case printed the expected value, matching the interpreter
(`GECKO_NOWASMJIT=1`).

## 0024-wasmjit-resume-args-object.patch

A JIT deopt resumes the function in the interpreter at the deopt's bytecode
offset. When that offset is past `JSOp::Arguments`, the interpreter never runs
the op, so it never attached the frame's arguments object: the resumed
`BaselineFrame` is fresh (its flags are reset) but its `argsObj_` field is
whatever the reused stack memory held. In a non-strict function whose
arguments object aliases its formals, every `JSOp::GetArg` reads
`frame->argsObj().arg(i)` and every `JSOp::SetArg` writes through it, so the
resumed code read (and could write) another call's arguments object. That
object is untraced through this frame, so it may also have been moved or
freed by a GC.

The deopt spill now stores each frame's arguments object, taken from the
resume point's args-object slot (`CompileInfo::argsObjSlot()`), as a boxed
Value in `gWJResumeArgsObj[f]`. It is 0 only when the script has no arguments
object or the slot is still Undefined (the deopt is before `JSOp::Arguments`,
and the interpreter creates the object itself). A slot of any other kind that
the backend cannot read fails the compile, and a spilled value that is neither
Undefined nor an `ArgumentsObject` crashes the resume: quietly writing 0 there
would bring the stale read back. The slots are traced
while a resume is active. The resume passes the object to the interpreter,
whose prologue attaches it with `initArgsObj` before anything can GC; from
then on the frame traces it.

`bench/microbenches/resume-args.js` reproduces it. Each call makes a new
lambda, so the JIT's `GuardSpecificFunction` deopts on every call until its
valve recompiles the function after 500 deopts; those 500 calls resume in the
interpreter. Three shapes compare a formal with a captured copy of it and
count mismatches; each should print 0. Before the patch each printed 500 (in
two runs): every resumed call read the formals of the first resumed call.
After it, two runs printed 0 for all three, matching the interpreter
(`GECKO_NOWASMJIT=1`). Two controls print 0 on both shells: a strict-mode
shape (its arguments object does not alias the formals) and a shape that
assigns a formal (no such function was seen to deopt-resume, so the stale
`SetArg` path is not reached today).

## 0025-wasmjit-resume-snapshot.patch

A deopt resume (`WJH_RESUME`) read the state the emitted spill left in the
`gWJResume*` globals frame by frame, after earlier work that can run a GC or
another resume:

- the script, environment, enclosing environment and runtime callee were raw
  pointers that no GC updated, read after `ensureHasJitScript` (which can
  allocate) and, for an outer frame, after the inner frames' whole interpreter
  runs;
- a resume nested inside an inner frame's interpreter run overwrote every
  global, and its exit cleared `gWJResumeActive`, so an outer frame read the
  nested resume's state from untraced storage.

`WJH_RESUME` now copies the whole spill (values, per-frame layout, and the
script, environment, enclosing environment, callee and arguments object of
each frame) into a snapshot of its own at entry, before anything can
allocate, and the frame loop reads only that copy. Snapshots form a chain,
one per nesting depth, from a reused pool, and `WJTraceRoots` traces every
snapshot in the chain, so their pointers stay current across a GC. The OSR
fast path reads the snapshot too.

Every compile now roots its environment (`useEnvRoot` is always set). The
outer frame's enclosing environment used to come from `envLocal` when the
function had no `FunctionEnvironment`; `envLocal` is not a GC root, so a minor
GC between entry and the deopt (for example in a function that closes over a
fresh nursery call object but only reads it in a cold branch) left it stale,
and the snapshot would then have traced a stale pointer. With the env always
rooted, the spill reads the persistent root slot, which a moving GC keeps
current; the `envLocal` spill path is gone (a compile that would need it
fails). One visible change: when the resume point's own environment
operand cannot be read, a function that used to have no env root spilled 0 for
the frame's environment (the interpreter then used the canonical function's
environment); it now gets the closure's environment from the root slot.

No test can show the old `envLocal` hole in practice. Warp emits a
`FunctionEnvironment` in the entry block whenever the script's bytecode uses its
environment chain (`ScriptUsesEnvironmentChain`), cold branches included, and
that already set `useEnvRoot`. Without one, the environment is either unused
(`NoEnvironment`) or a compile-time constant object, which cannot be a fresh
nursery call object. Always rooting closes the hole by construction rather than
relying on that.

`GECKO_WJ_RESUMEGC=1` (test only) forces a minor GC inside every resume, at
entry and before each frame's reads. `bench/microbenches/resume-env.js` covers
the enclosing environment (a closure over a fresh outer `let`, read only after
a deopt); with only the GC hook it crashed with "memory access out of bounds",
and with the patch it prints 0. `bench/microbenches/resume-gc.js`, run
with it, resumes 2000 frames (500 per shape), including resumes nested inside
another resume's interpreter run; each line should print 0. With only the GC
hook (no snapshot) the run crashed with "memory access out of bounds" in two of
two runs; with the patch both runs printed 0, matching the interpreter.

Not covered by the test: a resume with inlined frames (several frames in one
resume), where the outer frames are read after the inner ones run. No shape
tried here, and nothing in Octane or cdjs, produced such a resume, so the
"nested resume clobbers an outer frame" case is fixed by construction but not
exercised. A forced shrinking (compacting) GC at the same point still crashes,
before any frame is read; that is a different question (compaction while JIT
frames are live) and is not addressed here.

The JIT, and so `WJH_RESUME`, runs only on the main runtime's thread (0015,
0016), so the snapshot chain and pool need no thread-local storage. Cost on
cdjs, which resumes about four million times: 370.4 ms → 375.7 ms (+1.4%),
two runs each.

## Surf integration refresh

The community windowless-window-provider patch (0006) and the embedding
prefs that redirect all new windows into the current docshell are excluded.
This fork keeps its host-owned new-window callback.

0011 resets WebRender's shader swizzle when binding an external texture.
The original port sets the uniform for texture-cache images but leaves it
unchanged for external images, causing content WebGL canvases to inherit
a previous image's BGRA swap. Guest readPixels and 2D canvas copies retain
the expected color; only the composited page swaps red and blue.

The Emscripten WebGL source patch scopes version/extension string caches
to each context. A WebGL1-then-WebGL2 page otherwise reports the ES2
features for both contexts, while reversing the order breaks WebGL1.
