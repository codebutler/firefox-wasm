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
