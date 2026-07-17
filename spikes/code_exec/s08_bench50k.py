"""Criterion 7: a trivial value(el) over 50k elements, batches of 500, within 30s.

Also measures a 500-call single-element sample to document WHY batching is
load-bearing (spec section 4).
"""
import json
import os
import threading
import time

from host import ROOT, make_engine, run_python

N, BATCH = 50_000, 500
ELEMENTS = [{"id": f"e{i}", "name": f"Element {i}", "type": "Building"} for i in range(N)]

in_fifo, out_fifo = str(ROOT / "s08_in.fifo"), str(ROOT / "s08_out.fifo")
for p in (in_fifo, out_fifo):
    if os.path.exists(p):
        os.unlink(p)
    os.mkfifo(p)
hin = os.fdopen(os.open(in_fifo, os.O_RDWR), "w", buffering=1)
hout = os.fdopen(os.open(out_fifo, os.O_RDWR), "r", buffering=1)

em = make_engine()
threading.Thread(
    target=run_python,
    args=(["/spike/guest_harness.py"],),
    kwargs=dict(stdin_file=in_fifo, stdout_file=out_fifo,
                preopens=((str(ROOT), "/spike"),), engine_module=em),
    daemon=True,
).start()
assert json.loads(hout.readline()).get("ready")

# Batched: the shipping design.
t0 = time.perf_counter()
total = 0
for i in range(0, N, BATCH):
    hin.write(json.dumps({"id": i, "op": "batch", "elements": ELEMENTS[i:i+BATCH]}) + "\n")
    total += len(json.loads(hout.readline())["values"])
batched = time.perf_counter() - t0
assert total == N

# Unbatched sample: 500 single-element calls, extrapolated.
t0 = time.perf_counter()
for i in range(500):
    hin.write(json.dumps({"id": i, "op": "batch", "elements": [ELEMENTS[i]]}) + "\n")
    json.loads(hout.readline())
unbatched_extrapolated = (time.perf_counter() - t0) / 500 * N

hin.write(json.dumps({"id": -1, "op": "quit"}) + "\n")
print(f"[s08] batched 50k (batch={BATCH}): {batched:.1f}s")
print(f"[s08] unbatched extrapolated:      {unbatched_extrapolated:.0f}s  <- why batching is load-bearing")
assert batched <= 30, "over the 30s evaluation budget"
print("[s08] PASS")
