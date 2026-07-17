"""Criterion 1: guest boots, runs code, stdout is captured; measure boot cost."""
from host import ROOT, run_python

OUT = ROOT / "s01_out.txt"
code, secs = run_python(["-c", "import sys; print('guest-ok', sys.version)"], stdout_file=str(OUT))
print(f"[s01] exit={code} elapsed={secs:.3f}s stdout={OUT.read_text().strip()!r}")
assert code == 0 and "guest-ok" in OUT.read_text(), "boot FAILED — see guest_stderr.log"
print("[s01] PASS")
