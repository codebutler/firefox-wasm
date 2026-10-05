#!/usr/bin/env bash
# check-embedder.sh -- compile-check (syntax only) the embedder C++ against a built
# engine objdir, WITHOUT linking.
#
# Why this exists: the embedder sources (gecko.js/src/embed-*.cpp) are compiled by
# gecko.js/build-lib.sh, which needs an engine objdir (dist/include + the relocatable
# .so). A full engine build is ~80 min on CI, so a typo like a Gecko API that does not
# exist at the pinned revision (e.g. ScrollContainerFrame::GetScrollableRect, which only
# exists on APZ's FrameMetrics) was previously only discovered by burning a whole CI run
# at the very last step. This runs the same CXXFLAGS as build-lib.sh with -fsyntax-only,
# so it reports exactly those errors in seconds.
#
# Usage:
#   gecko.js/check-embedder.sh                 # uses obj-full-emscripten[-release]
#   OBJ=/path/to/objdir gecko.js/check-embedder.sh
#   RELEASE=1 gecko.js/check-embedder.sh       # the release objdir (-O3 embedder flags)
#
# Needs: em++ ($EMSDK/upstream/emscripten, or on PATH), the engine objdir with
# dist/include, and the pinned firefox/ source checkout (for nsprpub headers).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

OBJ="${OBJ:-$ROOT/obj-full-emscripten$([ "${RELEASE:-}" = "1" ] && echo -release)}"
INC="$OBJ/dist/include"
EMXX="${EMSDK:+$EMSDK/upstream/emscripten/}em++"

for need in "$INC" "$ROOT/firefox/nsprpub/pr/include"; do
  [ -d "$need" ] || { echo "check-embedder: missing $need -- build the engine first" >&2; exit 2; }
done
command -v "$EMXX" >/dev/null 2>&1 || { echo "check-embedder: no em++ (set EMSDK)" >&2; exit 2; }

# Must match gecko.js/build-lib.sh's CXXFLAGS. The -O level is kept (not just for
# parity of warnings: gcc/clang define __OPTIMIZE__ at -O1+, and engine headers do
# branch on it), plus -fsyntax-only instead of codegen.
if [ "${RELEASE:-}" = "1" ]; then OPT=(-O3); else OPT=(-O0 -g0); fi

CXXFLAGS=(
  -std=gnu++20 -fno-exceptions -fno-rtti -fno-sized-deallocation -fno-aligned-new
  -DMOZILLA_INTERNAL_API -DMOZ_HAS_MOZGLUE -DNDEBUG=1
  -isystem "$INC" -isystem "$INC/nspr" -isystem "$ROOT/firefox/nsprpub/pr/include"
  -pthread "${OPT[@]}" -fsyntax-only
)

rc=0
for src in embed-xul embed-init embed-browser embed-paint embed-input embed-mirror; do
  f="$HERE/src/$src.cpp"
  printf '>> %s\n' "$src.cpp"
  if ! "$EMXX" "${CXXFLAGS[@]}" "$f"; then rc=1; fi
done
[ "$rc" = 0 ] && echo ">> check-embedder: all embedder sources parse against $(basename "$OBJ")" \
             || echo ">> check-embedder: FAILED" >&2
exit "$rc"
