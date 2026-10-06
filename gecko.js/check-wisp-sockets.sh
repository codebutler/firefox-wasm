#!/usr/bin/env bash
# Requires the pinned, patched emsdk (make emsdk).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
EMXX="${EMSDK:+$EMSDK/upstream/emscripten/}em++"
SOCKET_TEST_DIR=$(mktemp -d)
trap 'rm -rf "$SOCKET_TEST_DIR"' EXIT
"$EMXX" "$HERE/wisp-socket.test.cpp" -o "$SOCKET_TEST_DIR/test.js" \
  -pthread -sWASMFS=1 -sPROXY_TO_PTHREAD=1 -sEXIT_RUNTIME=1 -sENVIRONMENT=node \
  -sEXPORTED_FUNCTIONS=_main,_malloc,_free,_wisp_deliver,_wisp_set_connected,_wisp_set_eof,_wisp_set_error \
  --js-library "$HERE/lib/wisp-net.js" --pre-js "$HERE/wisp-socket.pre.js"
node "$SOCKET_TEST_DIR/test.js"
