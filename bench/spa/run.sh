#!/usr/bin/env bash
# Run the heavy SPA workload (bench/spa/app.js) through the wasm SpiderMonkey
# embed: JIT vs PBL per-iteration time + checksum diff.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"
P=$(mktemp)
printf 'globalThis.JS_ITERS=10; globalThis.JS_WARM=2;\n' > "$P"
run() { # tag, env...
  local tag="$1"; shift
  env "$@" node bench/main.ts __exec "$P" "$HERE/app.js" bench/microbenches/micro-driver.js 2>/dev/null \
    | grep -E 'perIter|MICROSUM' | tr '\n' ' '
}
echo "JIT: $(run jit)"
echo "PBL: $(run pbl GECKO_NOWASMJIT=1)"
rm -f "$P"
