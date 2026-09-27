#!/usr/bin/env bash
# Fetch thirdlf03.com ONCE (politely) and cache it under data/. The site is a
# static Astro build (no client JS), so the realistic workload is real libraries
# running over its real content (HTML parse, DOM query, search index, SSR, lodash).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HERE/data"
UA="Mozilla/5.0 (compatible; jit-bench/1.0)"
if [ ! -f "$HERE/data/home.html" ]; then
  curl -sS -A "$UA" --max-time 30 https://thirdlf03.com/ -o "$HERE/data/home.html"
  echo ">> fetched data/home.html ($(wc -c < "$HERE/data/home.html") bytes)"
else
  echo ">> data/home.html already cached"
fi
