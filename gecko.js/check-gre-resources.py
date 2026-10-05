#!/usr/bin/env python3
"""Fail staging when an embedding module references an absent GRE resource."""
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
missing = []
for module in (root / 'modules').glob('Embed*.sys.mjs'):
    for uri in re.findall(r'[\"\']((?:resource://gre/|moz-src:///)[^\"\']+)[\"\']', module.read_text()):
        path = uri.replace('resource://gre/', '', 1) if uri.startswith('resource:') else 'moz-src/' + uri.removeprefix('moz-src:///')
        if not (root / path).is_file():
            missing.append(f'{module.name}: {uri}')
if missing:
    raise SystemExit('Missing embedding resources:\n' + '\n'.join(missing))
print('Embedding GRE resources verified')
