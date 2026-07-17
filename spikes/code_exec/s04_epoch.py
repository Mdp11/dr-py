"""Criterion 4a: epoch interruption kills `while True: pass` within ~500ms of the deadline.

wasmtime-py 46.0.1 note: epoch interruption raises `wasmtime.Trap` itself (not a
distinct subclass) — confirmed via `type(e)` at the raise site. `Trap` carries a
`.trap_code` property (`wasmtime.TrapCode`), and an epoch-tripped trap reports
`TrapCode.INTERRUPT`. Catching bare `Trap` (as the brief sketch does) is
therefore correct, but a generic `except Trap` alone can't tell "epoch kill"
apart from any other kind of guest trap (out-of-bounds, unreachable, ...), so
this probe additionally asserts `trap_code is TrapCode.INTERRUPT` to make the
distinction explicit — this is the check the shipped runner's error mapping
needs (see FINDINGS.md row 4).
"""
import threading
import time

from host import make_engine, run_python
from wasmtime import Trap, TrapCode

em = make_engine(epoch=True)
engine = em[0]

KILL_AFTER = 2.0
t0 = time.perf_counter()


def ticker():
    time.sleep(KILL_AFTER)
    engine.increment_epoch()  # store deadline is 1 tick -> this trips it


threading.Thread(target=ticker, daemon=True).start()

try:
    code, secs = run_python(["-c", "while True: pass"], epoch=True, engine_module=em)
    raise AssertionError(f"guest exited normally (code={code}) - epoch kill FAILED")
except Trap as e:
    elapsed = time.perf_counter() - t0
    overshoot = elapsed - KILL_AFTER
    print(f"[s04] raised {type(e).__module__}.{type(e).__qualname__}, trap_code={e.trap_code}")
    assert e.trap_code is TrapCode.INTERRUPT, (
        f"trapped for a reason other than epoch interruption: {e.trap_code!r}"
    )
    print(f"[s04] trapped after {elapsed:.2f}s (overshoot {overshoot*1000:.0f}ms)")
    assert overshoot < 0.5, "kill latency over threshold"
    print("[s04] PASS")
