"""Criterion 2: interactive blocking stdio round-trip via FIFOs; measure RTT."""
import json
import os
import statistics
import threading
import time

from host import ROOT, make_engine, run_python

IN_FIFO = str(ROOT / "s02_in.fifo")    # host -> guest stdin
OUT_FIFO = str(ROOT / "s02_out.fifo")  # guest stdout -> host

for p in (IN_FIFO, OUT_FIFO):
    if os.path.exists(p):
        os.unlink(p)
    os.mkfifo(p)

# O_RDWR so opens never block and the FIFO never sees EOF while we hold it.
host_in = os.fdopen(os.open(IN_FIFO, os.O_RDWR), "w", buffering=1)
host_out = os.fdopen(os.open(OUT_FIFO, os.O_RDWR), "r", buffering=1)

em = make_engine()
guest_dir_preopen = (str(ROOT), "/spike")
result: dict = {}

def guest():
    result["rc"] = run_python(
        ["/spike/guest_harness.py"],
        stdin_file=IN_FIFO,
        stdout_file=OUT_FIFO,
        preopens=(guest_dir_preopen,),
        engine_module=em,
    )

t = threading.Thread(target=guest, daemon=True)
t.start()

ready = json.loads(host_out.readline())
assert ready.get("ready"), f"no ready handshake: {ready}"
print("[s02] guest ready")

rtts = []
for i in range(1, 201):
    t0 = time.perf_counter()
    host_in.write(json.dumps({"id": i, "op": "echo", "x": i}) + "\n")
    resp = json.loads(host_out.readline())
    rtts.append(time.perf_counter() - t0)
    assert resp["x"] == i * 2

host_in.write(json.dumps({"id": 999, "op": "quit"}) + "\n")
t.join(timeout=10)
p50 = statistics.median(rtts) * 1000
p95 = statistics.quantiles(rtts, n=20)[18] * 1000
print(f"[s02] 200 round-trips: p50={p50:.2f}ms p95={p95:.2f}ms")
assert p50 < 5, "RTT over threshold"
print("[s02] PASS")
