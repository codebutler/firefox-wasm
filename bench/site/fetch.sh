#!/usr/bin/env bash
# Fetch each measured site ONCE (politely) and cache it under data/.
#  - thirdlf03.com: static Astro build (no client JS) -> real libraries over content
#  - ja.wikipedia.org: main page (~160 KB, real wikimedia markup)
#  - vibey-clover (workers.dev): 3D game; shell html + the REAL app bundle
#    (vite+three.js, ~860 KB) which is the actual JS this site executes.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HERE/data"
UA="Mozilla/5.0 (compatible; jit-bench/1.0)"
fetch() { # url dest
  if [ ! -f "$HERE/data/$2" ]; then
    curl -sS -A "$UA" --max-time 60 -L "$1" -o "$HERE/data/$2"
    echo ">> fetched data/$2 ($(wc -c < "$HERE/data/$2") bytes)"
  else
    echo ">> data/$2 already cached"
  fi
}
fetch "https://thirdlf03.com/"                                          home.html
fetch "https://ja.wikipedia.org/wiki/"                                  wiki.html
fetch "https://vibey-clover.krz-tech.workers.dev/"                      vibey.html
# The bundle name is content-hashed; discover it from the shell html.
if [ ! -f "$HERE/data/vibey-app.js" ]; then
  ASSET=$(grep -oE 'src="\./assets/[^"]+\.js"' "$HERE/data/vibey.html" | head -1 | sed -E 's/src="\.\/(.*)"/\1/')
  [ -n "$ASSET" ] && fetch "https://vibey-clover.krz-tech.workers.dev/$ASSET" vibey-app.js
fi
