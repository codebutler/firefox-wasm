#!/usr/bin/env bash
# Compile a microbench through Porffor (JS -> C -> wasm via emcc) and run it.
# Usage: porf-bench.sh <microbenches-file.js> [iters]
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ALT="$ROOT/bench/alt"
BENCH_SRC="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; ITERS="${2:-30}"
OUT="$ALT/out"; mkdir -p "$OUT"
NAME=$(basename "$BENCH_SRC" .js)
export EMSDK="${EMSDK:-$ROOT/emsdk}"
export EM_CONFIG="$ROOT/em_config"
export PATH="$EMSDK/upstream/emscripten:$PATH"
cd "$ALT"

{ printf 'var print = console.log.bind(console);\n'
  printf 'globalThis.JS_ITERS=%s; globalThis.JS_WARM=3;\n' "$ITERS"
  cat "$BENCH_SRC"
  cat "$ROOT/bench/microbenches/micro-driver.js"
} > "$OUT/$NAME.combo.js"

npx porffor c "$OUT/$NAME.combo.js" -o "$OUT/$NAME.porf.c" 2>&1 | tail -2
emcc -O2 -D__wasi__ -sENVIRONMENT=node -sALLOW_MEMORY_GROWTH=1 \
  "$OUT/$NAME.porf.c" -o "$OUT/$NAME.porf.js" 2> "$OUT/$NAME.porf.err" || {
    echo "emcc failed:"; tail -10 "$OUT/$NAME.porf.err"; exit 1; }
echo ">> porf-wasm: $OUT/$NAME.porf.wasm ($(wc -c < "$OUT/$NAME.porf.wasm") bytes)"
node "$OUT/$NAME.porf.js"
