#!/usr/bin/env bash
# Compile the same WasmFS socket regression used by check-wisp-sockets.sh for
# a cross-origin-isolated browser page. Requires the pinned patched emsdk.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:?output directory required}"
mkdir -p "$OUT"
EMXX="${EMSDK:+$EMSDK/upstream/emscripten/}em++"
"$EMXX" "$HERE/wisp-socket.test.cpp" -o "$OUT/socket-fixture.js" \
  -pthread -sWASMFS=1 -sPROXY_TO_PTHREAD=1 -sEXIT_RUNTIME=1 -sENVIRONMENT=web \
  -sEXPORTED_FUNCTIONS=_main,_malloc,_free,_wisp_deliver,_wisp_set_connected,_wisp_set_eof,_wisp_set_error,_wisp_errno_econnrefused,_wisp_errno_eopnotsupp,_wisp_errno_enodev,_wisp_errno_einval \
  --js-library "$HERE/lib/wisp-net.js" --pre-js "$HERE/wisp-socket.pre.js"
cp "$HERE/wisp-socket.browser.html" "$OUT/index.html"
