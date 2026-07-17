"""Criterion 6: with a pre-booted instance, request->response fits in 300ms.

Measures the three latency components separately:
  a) Module.deserialize from a disk cache (vs cold compile)
  b) instantiate + interpreter boot to 'ready' handshake
  c) handoff: first request -> response on an already-'ready' instance

wasmtime-py 46.0.1 API note: `Module.serialize()` / `Module.deserialize(engine,
bytes)` match this probe's calls verbatim — no drift from the brief. Verified
via `inspect.signature`: `serialize(self) -> bytearray` and
`deserialize(engine: Engine, encoded: bytes | bytearray) -> Module` (a
classmethod). `Path.write_bytes` accepts the `bytearray` serialize() returns
without conversion.

Trimmed two unused imports from the brief's sketch (`PYTHON_WASM`, `Engine`)
to keep `ruff check` clean, matching every other committed spike probe;
neither is referenced by this script's body.
"""
import json
import os
import statistics
import threading
import time

from host import ROOT, make_engine, run_python
from wasmtime import Module

# a) module cache
engine, module = make_engine()
cache = ROOT / "python.cwasm"
cache.write_bytes(module.serialize())
t0 = time.perf_counter()
Module.deserialize(engine, cache.read_bytes())
print(f"[s07] module deserialize: {(time.perf_counter()-t0)*1000:.0f}ms (vs cold compile above)")

# b+c) boot-to-ready and handoff, 10 iterations over the s02 transport
def one_cycle() -> tuple[float, float]:
    in_fifo, out_fifo = str(ROOT / "s07_in.fifo"), str(ROOT / "s07_out.fifo")
    for p in (in_fifo, out_fifo):
        if os.path.exists(p):
            os.unlink(p)
        os.mkfifo(p)
    hin = os.fdopen(os.open(in_fifo, os.O_RDWR), "w", buffering=1)
    hout = os.fdopen(os.open(out_fifo, os.O_RDWR), "r", buffering=1)
    t_boot = time.perf_counter()
    th = threading.Thread(
        target=run_python,
        args=(["/spike/guest_harness.py"],),
        kwargs=dict(stdin_file=in_fifo, stdout_file=out_fifo,
                    preopens=((str(ROOT), "/spike"),), engine_module=(engine, module)),
        daemon=True,
    )
    th.start()
    assert json.loads(hout.readline()).get("ready")
    boot = time.perf_counter() - t_boot
    t_req = time.perf_counter()          # <- the "warm pool" moment: instance is ready and idle
    hin.write(json.dumps({"id": 1, "op": "ping"}) + "\n")
    assert json.loads(hout.readline()).get("pong")
    handoff = time.perf_counter() - t_req
    hin.write(json.dumps({"id": 2, "op": "quit"}) + "\n")
    th.join(timeout=10)
    return boot, handoff

cycles = [one_cycle() for _ in range(10)]
boots = [b * 1000 for b, _ in cycles]
handoffs = [h * 1000 for _, h in cycles]
print(f"[s07] boot-to-ready: p50={statistics.median(boots):.0f}ms max={max(boots):.0f}ms")
print(f"[s07] warm handoff:  p50={statistics.median(handoffs):.2f}ms max={max(handoffs):.2f}ms")
assert statistics.median(handoffs) < 300, "warm handoff over 300ms"
print("[s07] PASS  (pool refill cost = boot-to-ready; console latency = handoff + snippet runtime)")
