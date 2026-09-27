#!/usr/bin/env bash
# Run the site workloads through the wasm SpiderMonkey embed: JIT vs PBL ratio.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"
P=$(mktemp)
printf 'globalThis.JS_ITERS=20; globalThis.JS_WARM=3;\n' > "$P"
for b in parse search ssr dom lodash; do
  jit=$(node bench/main.ts __exec "$P" "$HERE/build/data.js" "$HERE/build/$b.js" bench/microbenches/micro-driver.js 2>/dev/null | grep -oE 'perIter=[0-9.]+' | cut -d= -f2)
  pbl=$(GECKO_NOWASMJIT=1 node bench/main.ts __exec "$P" "$HERE/build/data.js" "$HERE/build/$b.js" bench/microbenches/micro-driver.js 2>/dev/null | grep -oE 'perIter=[0-9.]+' | cut -d= -f2)
  printf '%-8s jit=%sms pbl=%sms\n' "$b" "$jit" "$pbl"
done
rm -f "$P"
