"""Fallback probe: wasmtime host in a child process, guest inherits child stdio."""
import json
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).parent
CHILD = r"""
import sys
sys.path.insert(0, sys.argv[1])
from host import run_python
run_python(["/spike/guest_harness.py"],
           inherit_stdio=True,
           preopens=((sys.argv[1], "/spike"),))
"""
# NOTE: requires adding an inherit_stdio flag to host.run_python that calls
# wasi.inherit_stdin() / wasi.inherit_stdout() instead of the *_file setters.

proc = subprocess.Popen(
    [sys.executable, "-c", CHILD, str(ROOT)],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1,
)
assert json.loads(proc.stdout.readline()).get("ready")
rtts = []
for i in range(1, 201):
    t0 = time.perf_counter()
    proc.stdin.write(json.dumps({"id": i, "op": "echo", "x": i}) + "\n")
    proc.stdin.flush()
    resp = json.loads(proc.stdout.readline())
    rtts.append(time.perf_counter() - t0)
    assert resp["x"] == i * 2
proc.stdin.write(json.dumps({"id": 999, "op": "quit"}) + "\n")
proc.stdin.flush()
proc.wait(timeout=10)
print(f"[s02b] p50={statistics.median(rtts)*1000:.2f}ms")
