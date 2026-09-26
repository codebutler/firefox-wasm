# JS→WASM JIT optimization log (2026-09-27 session)

The JS-only SpiderMonkey embed now builds and benchmarks **on macOS/arm64**
(see `docs/wasmjit-dev-loop.md`), so JIT work no longer needs the Linux-only full
Gecko build. `fastjit.sh` gives a ~12–18 s edit→bench cycle.

Baseline (before this session) and the three engine patches in `patches/`:

| commit | change | measured |
|---|---|---|
| 2e5da97 | Date op family lowering + `MConstant` Int64/magic + `Box(Float32)` | `micro date-ops` 24.6→18.0 ms (~1.37×), 4 bails → 0 |
| d4727f8 | mixed Int32/Double arithmetic emitted **invalid wasm** (function silently in PBL) | `micro mixed-arith` 43.5→1.7 ms (~25×) |
| 59b0638 | `GuardHasAttachedArrayBuffer`, `ToIntegerIndex`, `MMinMax` IntPtr/Float32, IntPtr `Add/Sub/Mul`; `MTypedArraySubarray` staged off | `micro minmax-idx`; pdfjs bail chain shortened |

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
