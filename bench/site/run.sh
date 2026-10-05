#!/usr/bin/env bash
# Run the site workloads through the wasm SpiderMonkey embed: JIT vs PBL ratio.
# Usage: run.sh [site ...]   (site = home | wiki | vibey; default: all)
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"
P=$(mktemp)
printf 'globalThis.JS_ITERS=20; globalThis.JS_WARM=3;\n' > "$P"

bench_site() { # site workloads...
  local site=$1; shift
  echo "== $site =="
  for b in "$@"; do
    jit=$(node bench/main.ts __exec "$P" "$HERE/build/data-$site.js" "$HERE/build/$b.js" bench/microbenches/micro-driver.js 2>/dev/null | grep -oE 'perIter=[0-9.]+' | cut -d= -f2)
    pbl=$(GECKO_NOWASMJIT=1 node bench/main.ts __exec "$P" "$HERE/build/data-$site.js" "$HERE/build/$b.js" bench/microbenches/micro-driver.js 2>/dev/null | grep -oE 'perIter=[0-9.]+' | cut -d= -f2)
    printf '  %-10s jit=%sms pbl=%sms\n' "$b" "$jit" "$pbl"
  done
}

SITES="${*:-home wiki vibey}"
for s in $SITES; do
  case "$s" in
    home|wiki) bench_site "$s" parse search ssr dom lodash jsparse ;;
    vibey)     bench_site "$s" jsparse frame3d vibeyboot parse dom search ;;
    *)         echo "unknown site: $s" >&2 ;;
  esac
done
rm -f "$P"
