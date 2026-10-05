# JS→WASM JIT dev loop (JS-only SpiderMonkey embed, incl. macOS)

The full Gecko build (`make build` / `make libxul`) is Linux-only and huge
(~26 GB objdir). The JIT itself only needs the **JS-only** SpiderMonkey embed
(`bench/spidermonkey.js`), which is small (~130 MB objdir) and was verified to
configure and build on macOS/arm64 with the steps below. `fastjit.sh` then
rebuilds the JIT in ~15 s.

## One-time setup

```bash
# 1. repo-local emscripten 6.0.1 (macOS arm64 / linux x86_64 both fine)
git clone --depth 1 https://github.com/emscripten-core/emsdk.git emsdk
cd emsdk && ./emsdk install 6.0.1 && ./emsdk activate 6.0.1 && cd ..

# 2. rust target (the JS-only build sets --disable-js-shell, so the Rust crates
#    are NOT built, but configure still probes rustc for the wasm target)
rustup target add wasm32-unknown-emscripten

# 3. pinned engine fork
make firefox

# 4. patches (style-check skip + any JIT work; see patches/README.md)
git -C firefox apply ../patches/0000-build-skip-spidermonkey-style-checks.patch
git -C firefox apply ../patches/0001-wasmjit-date-ops.patch
```

`mozconfig.js.emscripten` was made host-portable (the `--disable-stdcxx-compat`
line is only defined for Linux hosts and is already the default, so it was
removed).

## Configure + first build (JS-only, ~1 min)

```bash
export ROOT=$PWD
export EMSDK=$ROOT/emsdk
export EM_CONFIG=$ROOT/em_config
export MOZCONFIG=$ROOT/mozconfig.js.emscripten
export MOZBUILD_STATE_PATH=$ROOT/.mozbuild
export PATH=$EMSDK/upstream/emscripten:$EMSDK:$PATH
export WJ_SKIP_STYLE_CHECKS=1
cd firefox && ./mach configure && ./mach build && cd ..
```

This produces `obj-js-emscripten/` (`js/src/build/libjs_static.a` + the mozglue
objects `bench/spidermonkey.js/build.sh` links).

## JIT iteration

```bash
bash bench/spidermonkey.js/fastjit.sh          # recompile WasmJit*.cpp + relink (~15 s)
node bench/main.ts octane richards --ab --bails
node bench/main.ts micro date-ops --ab
bash bench/spidermonkey.js/build.sh            # embedder-only relink (faster)
```

`fastjit.sh` honours `EMSDK` and recompiles `firefox/js/src/wasm/WasmJit*.cpp`
into the standalone objects in `obj-js-emscripten/js/src/wasm/` before
re-archiving `libjs_static.a`. Those files are `SOURCES` (not unified), so no
duplicate-symbol problem.

## Finding what bails (functions stuck in PBL)

```bash
GECKO_WJ_LOGBAIL=1 node bench/main.ts __exec /tmp/prelude.js <bench>.js <driver>.js
# -> [WJ-BAIL] fn=file:line reason=<reason|opname> op@=file:line(off=N)
```

`GECKO_WJ_BAILDBG=1` adds the MIRType to unsupported `Constant`/`Box`/return
bails. `GECKO_WJ_FAILONBAIL=1` aborts on any bail. `--bails` in `main.ts`
aggregates the `unsupported value/effect op` survey per bench.

## Measurement notes

* `bench/main.ts --ab` runs JIT and PBL back-to-back, so the **ratio** is the
  robust metric; absolute ms drift with background load (`dasd` on macOS can peg
  a core). For small effects use an interleaved A/B over two saved
  `build/embed.{js,wasm}` variants, or a purpose-built microbench.
* Benchmarks run node with `--no-liftoff` (TurboFan-only) so the JIT-emitted
  wasm's tiering doesn't add run-to-run variance.
* `GECKO_WJ_COMPILESTAT=1` reports snapshot/build/optimize/emit/host-compile ms
  per compile; `GECKO_WJ_WASMDUMP=<line>` writes the emitted wasm for that
  source line to `/tmp/wbjit_<line>.wasm`.
