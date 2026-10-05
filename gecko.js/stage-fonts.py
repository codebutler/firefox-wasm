#!/usr/bin/env python3
"""Stage the mandatory offline fonts, verifying pinned content before use."""
import hashlib
import json
import pathlib
import sys
import urllib.request


def stage(destination):
    destination.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(pathlib.Path(__file__).with_name("fonts.json").read_text())
    for entry in manifest["files"]:
        target = destination / entry["file"]
        if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == entry["sha256"]:
            continue
        with urllib.request.urlopen(entry["url"], timeout=120) as response:
            data = response.read()
        if len(data) != entry["bytes"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise RuntimeError(f"Font integrity check failed: {entry['file']}")
        temporary = target.with_suffix(target.suffix + ".download")
        temporary.write_bytes(data)
        temporary.replace(target)
        print(f"staged {entry['file']} ({len(data)} bytes)", flush=True)
    # Remove obsolete fonts from a reused GRE directory. A stale subset must not
    # shadow its replacement with the same family name and narrower coverage.
    expected = {entry["file"] for entry in manifest["files"]}
    for old in destination.glob("Noto*"):
        if old.name not in expected:
            old.unlink()


if __name__ == "__main__":
    stage(pathlib.Path(sys.argv[1]))
