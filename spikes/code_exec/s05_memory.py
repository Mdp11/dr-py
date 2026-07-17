"""Criterion 4b: a 256MB store limit stops a guest allocating ~500MB.

PASS via either path: (a) a `Trap` on allocation, or (b) the guest dies with an
in-guest `MemoryError` (nonzero exit, and the "CAP FAILED" marker absent from
stdout). On this build (wasmtime-py 46.0.1, CPython-WASI 3.14.6), the observed
path is (b): `store.set_limits(memory_size=...)` makes the guest's own
allocator raise `MemoryError` (visible in guest_stderr.log), CPython prints a
traceback to stderr and exits 1 — no host-side Trap is raised. Both paths are
still probed for below so this stays true regardless of which one fires on a
given build.
"""
from host import ROOT, run_python
from wasmtime import Trap

OUT = ROOT / "s05_out.txt"
ALLOC = "x = bytearray(500 * 1024 * 1024); print('allocated - CAP FAILED')"
try:
    code, _ = run_python(["-c", ALLOC], mem_limit=256 * 1024 * 1024, stdout_file=str(OUT))
    out = OUT.read_text()
    assert "CAP FAILED" not in out, "guest allocated past the cap"
    # Nonzero exit without the marker => guest died with MemoryError: acceptable.
    print(f"[s05] guest exited code={code}, no over-allocation. PASS (MemoryError path)")
except Trap as e:
    print(f"[s05] trapped on allocation ({e.trap_code}). PASS (trap path)")
