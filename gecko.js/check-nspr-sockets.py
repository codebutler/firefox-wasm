#!/usr/bin/env python3
"""Exercise the pinned NSPR build through WasmFS, without building all of Gecko.

Run after make firefox/.wj-patched and make emsdk. Reads the real moz.build
source/define lists so this catches platform configuration errors, including
NSPR silently inserting its IPv6-to-IPv4 compatibility layer.
"""

import os
from collections import defaultdict
from pathlib import Path
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
SOURCE = Path(os.environ.get("GECKO_SOURCE", HERE.parent / "firefox"))
EMCC = Path(os.environ["EMSDK"]) / "upstream/emscripten/emcc"


class Exports:
    def __init__(self):
        self.nspr = self
        self.md = []
        self.private = []

    def __iadd__(self, unused):
        return self


def ignore(*unused):
    pass


# Evaluate the platform's build declarations, not a separately maintained list.
config = dict(
    CONFIG=defaultdict(list, OS_TARGET="EMSCRIPTEN"),
    DEFINES={},
    SOURCES=[],
    UNIFIED_SOURCES=[],
    OS_LIBS=[],
    LOCAL_INCLUDES=[],
    EXPORTS=Exports(),
    Library=ignore,
    SharedLibrary=ignore,
    AllowCompilerWarnings=ignore,
)
build_file = SOURCE / "config/external/nspr/pr/moz.build"
exec(compile(build_file.read_text(), str(build_file), "exec"), config)

with tempfile.TemporaryDirectory(prefix="nspr-sockets-") as directory:
    output = str(Path(directory) / "test.js")
    command = [str(EMCC), "-pthread", "-DXP_UNIX", "-Wno-error=implicit-function-declaration"]
    command += [
        "-D" + name + ("" if value is True else "=" + str(value))
        for name, value in config["DEFINES"].items()
        if value is not False
    ]
    command += ["-I" + str(SOURCE / path.lstrip("/")) for path in config["LOCAL_INCLUDES"]]
    command += [
        str(SOURCE / path.lstrip("/"))
        for path in config["SOURCES"] + config["UNIFIED_SOURCES"]
    ]
    command += [
        str(HERE / "nspr-socket.test.c"), "-o", output,
        "-sWASMFS=1", "-sPROXY_TO_PTHREAD=1", "-sEXIT_RUNTIME=1", "-sENVIRONMENT=node",
        "-sEXPORTED_FUNCTIONS=_main,_malloc,_free,_wisp_deliver,_wisp_set_connected,_wisp_set_eof,_wisp_set_error",
        "--js-library", str(HERE / "lib/wisp-net.js"),
        "--pre-js", str(HERE / "wisp-socket.pre.js"),
    ]
    subprocess.run(command, check=True)
    subprocess.run(["node", output], check=True, timeout=30)
