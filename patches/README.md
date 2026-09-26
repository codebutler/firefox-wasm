# patches/ — engine-side patches for the JS→WASM JIT

The JS→WASM JIT itself lives in the pinned Gecko engine fork
(`HeyPuter/firefox`, fetched by `make firefox` into `firefox/`, which is
git-ignored). Any JIT work therefore lands in `firefox/js/src/wasm/WasmJit*.{h,cpp}`
and is kept here as a patch so it is versioned with this repo.

Apply after `make firefox`:

```bash
git -C firefox apply ../patches/0000-build-skip-spidermonkey-style-checks.patch
git -C firefox apply ../patches/0001-wasmjit-date-ops.patch
git -C firefox apply ../patches/0002-wasmjit-f64-arith-operands.patch
```

## 0000-build-skip-spidermonkey-style-checks.patch

Makes `config/run_spidermonkey_checks.py` a no-op when `WJ_SKIP_STYLE_CHECKS=1`.
`--enable-project=js` implies `JS_STANDALONE`, so the standalone SpiderMonkey
style checker runs as part of `mach build`; the fork's added files
(`WasmJit*.cpp`, `WasmInterp.h`) have include-ordering violations that make the
check fail and abort the build. The env gate lets the JS-only dev build proceed
without touching the fork's style. Never affects a production build (the variable
is unset by default).

## 0001-wasmjit-date-ops.patch

Lowers the whole `Date` MIR op family in the MIR→wasm backend instead of bailing
the containing function to PBL. Before this patch, **every** function that used
`Date.now()`, `Date.parse()`, `new Date(ms)`, or a Date getter stayed in the
interpreter (`--bails` reported `DateNow` / `Constant` / `LocalTimeToUTC` /
`Box`). New `wjhelp` kinds (`WasmJitBackend.h`), runtime implementations
(`WasmJitRuntime.cpp`), and backend lowering (`WasmJitBackend.cpp`):

| MIR op | helper | notes |
|---|---|---|
| `MDateNow` | `WJH_DATENOW` | `js::jit::DateNow(cx)` |
| `MDateParse` | `WJH_DATEPARSE` | `js::jit::DateParse(cx, str)` (flattens the rope first) |
| `MTimeClip` | `WJH_TIMECLIP` | `JS::TimeClip` (NaN if \|t\| > 8.64e15, else trunc) |
| `MNewDateObject` | `WJH_NEWDATEOBJECT` | `js::NewDateObjectMsec(cx, JS::TimeClip(t))` |
| `MDateFillLocalTimeSlots` | `WJH_DATEFILLLOCALTIMESLOTS` | effect op |
| `MDate{Hours,Minutes,Seconds}FromSecondsIntoYear` | `WJH_DATE{...}FROMSECONDS` | integer reduction of the cached slot |
| `M{Year,Month,Date}FromTime` | `WJH_{...}FROMTIME` | `js::jit::Date{Year,Month,Date}FromTime` |
| `MLocalTimeToUTC` | `WJH_LOCALTIMETOUTC` | `js::jit::DateLocalTimeToUTC`; Int64 operand staged in the untraced `gWJHelpI64` |

Plus two general backend fixes the Date work surfaced:

* `MConstant` of type `Int64` and of the magic types (`MagicOptimizedOut`,
  `MagicHole`, `MagicIsConstructing`, `MagicUninitializedLexical`) now emit a
  constant instead of bailing.
* `EmitBoxFromStack` now boxes `Float32` (held as f64 in this backend's repr).

Measured on `node bench/main.ts micro date-ops --ab`: JIT 24.6 ms → 18.0 ms
(~1.37×) with `bails: -` (was 4 distinct bails), checksum identical to PBL.

## 0002-wasmjit-f64-arith-operands.patch

Fixes invalid wasm for mixed Int32/Double arithmetic. Warp's
`emitDoubleBinaryArithResult` builds `MAdd/MSub/MMul/MDiv(lhs, rhs, Double)` from
`NumberOperandId`s whose defs can be **Int32 phis** (no `MToDouble` inserted). The
backend emitted `f64.add`/`f64.div` directly on the i32 local; V8 rejects the
whole module (`f64.add expected f64, found local.get i32`), so the function
silently stayed in PBL (`host-compile-reject`, which `--bails` does not even
report). Now an Int32-repr operand is converted with `f64.convert_i32_s` (the
exact numeric value); i64/Value operands still bail cleanly.

This is a general coverage fix: any function that accumulates int loop counters
into a double, hashes with mixed types, etc. was dropped to the interpreter.

Measured on the new `micro mixed-arith` bench: JIT 43.5 ms → 1.7 ms (~25×) with
an identical checksum; `micro string-ops` also stops bailing (was
`host-compile-reject`).
