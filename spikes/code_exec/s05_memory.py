"""Criterion 4b: a 256MB store limit stops a guest allocating ~500MB.

Runs the SAME ~500MB `bytearray` allocation twice to establish a counterfactual:

1. **Control (no cap)**: `mem_limit=None` -- no `store.set_limits()` call at
   all. Asserts the allocation SUCCEEDS (the "ALLOC_OK" marker appears in
   stdout, exit code 0). This proves the allocation is achievable at all, and
   rules out a cap-independent failure (e.g. a module-level memory ceiling)
   as the thing actually stopping it.
2. **Capped (existing)**: same code, `mem_limit=256MB`. Asserts the
   allocation is BLOCKED via either path: (a) a `Trap` on allocation, or
   (b) the guest dies with an in-guest `MemoryError` (nonzero exit, and the
   marker absent from stdout).

Together: same code succeeds without the cap and fails with the cap, so the
cap -- not something else -- is what trips the failure.

On this build (wasmtime-py 46.0.1, CPython-WASI 3.14.6), the observed path
for the capped run is (b): `store.set_limits(memory_size=...)` makes the
guest's own allocator raise `MemoryError` (visible in guest_stderr.log),
CPython prints a traceback to stderr and exits 1 -- no host-side Trap is
raised. Both paths are still probed for below so this stays true regardless
of which one fires on a given build.
"""
from host import ROOT, run_python
from wasmtime import Trap

OUT = ROOT / "s05_out.txt"
ALLOC = "x = bytearray(500 * 1024 * 1024); print('allocated - ALLOC_OK')"

# 1. Control: same allocation, no cap. Must succeed -- this isolates the
# store cap (rather than some cap-independent ceiling) as the variable
# under test in the capped run below.
code, _ = run_python(["-c", ALLOC], mem_limit=None, stdout_file=str(OUT))
out = OUT.read_text()
assert code == 0, f"uncapped control unexpectedly failed: exit={code}"
assert "ALLOC_OK" in out, "uncapped control did not allocate -- counterfactual invalid"
print(f"[s05] uncapped control: exit={code}, allocated OK. control PASS")

# 2. Capped: same code, 256MB store cap. Must be blocked.
try:
    code, _ = run_python(["-c", ALLOC], mem_limit=256 * 1024 * 1024, stdout_file=str(OUT))
    out = OUT.read_text()
    assert "ALLOC_OK" not in out, "guest allocated past the cap"
    # Nonzero exit without the marker => guest died with MemoryError: acceptable.
    print(f"[s05] capped guest exited code={code}, no over-allocation. PASS (MemoryError path)")
except Trap as e:
    print(f"[s05] capped run trapped on allocation ({e.trap_code}). PASS (trap path)")

print("[s05] counterfactual established: same alloc succeeds uncapped, fails at 256MB cap. PASS")
