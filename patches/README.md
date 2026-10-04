# patches/ — engine-side patches for the JS→WASM JIT

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
