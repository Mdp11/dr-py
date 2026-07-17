"""Criterion 5: fixed clock/random/hashseed => two runs produce identical output."""
from host import ROOT, run_python

PROG = "import time, random; print(time.time(), random.random(), hash('spike'))"
outs = []
for i in (1, 2):
    out = ROOT / f"s06_out{i}.txt"
    code, _ = run_python(["-c", PROG], deterministic=True, stdout_file=str(out))
    assert code == 0, "guest failed to boot with determinism shims - record as partial no-go"
    outs.append(out.read_text())
    print(f"[s06] run {i}: {outs[-1].strip()}")
assert outs[0] == outs[1], "outputs differ across runs"
print("[s06] PASS")
