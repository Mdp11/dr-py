"""Criterion 3: does the host make progress while the guest burns CPU?

If wasmtime-py holds the GIL during guest execution, a 10s snippet stalls the
whole (sync, threadpool-served) API process - a no-go for in-process running.
wasmtime-py binds via ctypes, which releases the GIL around foreign calls, so
this SHOULD pass - but it is load-bearing, so we measure.
"""
import threading
import time

from host import make_engine, run_python

def count_for(seconds: float) -> int:
    n = 0
    deadline = time.perf_counter() + seconds
    while time.perf_counter() < deadline:
        n += 1
    return n

# Baseline: counter thread alone.
solo = count_for(2.0)

# Contended: counter thread while the guest busy-loops for ~4s in another thread.
em = make_engine()
contended = {}

def spin_host():
    contended["n"] = count_for(2.0)

guest = threading.Thread(
    target=run_python,
    args=(["-c", "t=__import__('time').monotonic()\nwhile __import__('time').monotonic()-t<4: pass"],),
    kwargs={"engine_module": em},
    daemon=True,
)
guest.start()
time.sleep(0.5)  # let the guest reach its busy loop
counter = threading.Thread(target=spin_host)
counter.start()
counter.join()
guest.join(timeout=15)

ratio = contended["n"] / solo
print(f"[s03] solo={solo} contended={contended['n']} ratio={ratio:.2f}")
assert ratio >= 0.5, "GIL appears held during guest execution - in-process NO-GO, use subprocess runner"
print("[s03] PASS")
