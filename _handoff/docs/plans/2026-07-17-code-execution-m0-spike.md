# Code Execution — M0 Spike Implementation Plan (+ M1–M4 milestone outline)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove (or disprove) that CPython-WASI under `wasmtime-py` can power the server-side snippet sandbox — the go/no-go gate for the code-execution feature — and outline M1–M4.

**Architecture:** Per the approved spec (`docs/superpowers/specs/2026-07-17-code-execution-design.md`), snippets run in a CPython interpreter compiled to WASM/WASI, embedded in the API process via `wasmtime-py`, talking to the host over a blocking bridge channel. M0 is a throwaway-but-committed spike: nine numbered probe scripts under `spikes/code_exec/`, each answering one checklist item from spec §12, consolidated into a FINDINGS.md with a go/no-go verdict.

**Tech Stack:** Python 3.14 (host, via pixi), `wasmtime` (PyPI, new dep), CPython 3.13 WASI build (pinned binary artifact), bash + curl for fetching.

## Global Constraints

- Everything runs through pixi; there is no global `python`. Host-side spike commands use `pixi run -e core-dev python …` from the repo root.
- Spike code lives in `spikes/code_exec/` (new top-level dir). It is committed, but exempt from mypy/pyright (outside `src/`); keep it `ruff`-clean (`pixi run lint-core` must stay green — if ruff's config scopes to `src/`, no action needed; verify once in Task 1).
- The ~25 MB guest binary is **never committed**: `spikes/code_exec/vendor/` is gitignored; only the hash-pinned fetch script is committed.
- Spec §12 pass thresholds (copied verbatim into FINDINGS.md in Task 1): boot works; interactive round-trip works; GIL released; epoch kill + memory cap enforced; determinism stubs hold; warm console round-trip ≲ 300 ms; 50k-row batched benchmark ≤ 30 s; packaging reproducible.
- Branch: all M0 work on `feature/code-execution-spike`, branched from `main`.

---

## Task 1: Branch, wasmtime dependency, spike scaffold

**Files:**
- Modify: `pixi.toml` (add pypi-dependencies to `core-dev`)
- Create: `spikes/code_exec/README.md`
- Create: `spikes/code_exec/FINDINGS.md`
- Modify: `.gitignore` (vendor dir)

**Interfaces:**
- Produces: importable `wasmtime` in the `core-dev` env; `spikes/code_exec/` layout all later tasks write into; `FINDINGS.md` results table every later task fills one row of.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feature/code-execution-spike main
```

- [ ] **Step 2: Add the wasmtime PyPI dependency**

Append to `pixi.toml` (the file currently has no pypi-dependencies sections; pixi supports them per-feature):

```toml
[feature.core-dev.pypi-dependencies]
wasmtime = ">=30"
```

Run: `pixi install` (from repo root). Expected: solve succeeds, lockfile updates. If the solve fails on the loose pin, run `pixi run -e core-dev python -c "print(1)"` to confirm the env still works, then pin to the newest version shown at https://pypi.org/project/wasmtime/ (record the exact version — it goes in FINDINGS.md).

- [ ] **Step 3: Verify wasmtime imports**

Run: `pixi run -e core-dev python -c "import wasmtime; print(wasmtime.__version__)"`
Expected: prints a version ≥ 30. Record the exact version in FINDINGS.md (Task 1 row).

- [ ] **Step 4: Create the spike scaffold**

Create `spikes/code_exec/README.md`:

```markdown
# Code-execution M0 spike

Go/no-go probes for the WASM snippet sandbox
(spec: docs/superpowers/specs/2026-07-17-code-execution-design.md §12).

Run any probe from the repo root:

    pixi run -e core-dev python spikes/code_exec/s01_boot.py

Scripts are numbered by spec-§12 checklist item. Results live in FINDINGS.md.
`vendor/` (guest binary + stdlib) is gitignored; populate it with:

    bash spikes/code_exec/fetch_python_wasi.sh
```

Create `spikes/code_exec/FINDINGS.md`:

```markdown
# M0 spike findings

| # | Criterion (spec §12) | Threshold | Result | Verdict |
|---|---|---|---|---|
| 1 | CPython-WASI boots under wasmtime-py | runs a script, captures stdout | | |
| 2 | Interactive blocking stdio round-trip | works; p50 RTT < 5 ms | | |
| 3 | GIL released during guest execution | host thread ≥ 50% solo rate | | |
| 4 | Epoch kill + memory cap | trap ≤ 500 ms after deadline; cap enforced | | |
| 5 | Determinism stubs | fixed clock/random/hashseed; 2 runs identical | | |
| 6 | Warm-pool console latency | ≤ 300 ms end-to-end | | |
| 7 | 50k-element batched benchmark | ≤ 30 s total | | |
| 8 | Packaging reproducible | hash-pinned fetch, re-runnable | | |

Environment: wasmtime-py <version>, CPython-WASI <version/asset>, host Python 3.14, linux-64.

## Verdict

(go / no-go / go-with-amendments — filled in Task 10)
```

Append to `.gitignore`:

```
spikes/code_exec/vendor/
```

- [ ] **Step 5: Confirm ruff scope**

Run: `pixi run lint-core`
Expected: passes. If ruff picks up `spikes/` and complains, add `spikes` to ruff's exclude list in its config (wherever `lint-core` points) rather than fighting spike-style code.

- [ ] **Step 6: Commit**

```bash
git add pixi.toml pixi.lock .gitignore spikes/code_exec/README.md spikes/code_exec/FINDINGS.md
git commit -m "spike(m0): scaffold code-exec spike, add wasmtime dep"
```

---

## Task 2: Fetch and pin the CPython-WASI guest binary

**Files:**
- Create: `spikes/code_exec/fetch_python_wasi.sh`

**Interfaces:**
- Produces: `spikes/code_exec/vendor/python.wasm` + stdlib dir on disk; `PYTHON_WASM` / `GUEST_LIB` paths that `host.py` (Task 3) hardcodes; recorded bundle layout in FINDINGS.md.

- [ ] **Step 1: Discover the current release asset**

Run:

```bash
curl -s https://api.github.com/repos/brettcannon/cpython-wasi-build/releases/latest \
  | python3 -c "import json,sys; r=json.load(sys.stdin); print(r['tag_name']); [print(a['name'], a['browser_download_url']) for a in r['assets']]"
```

Expected: a tag like `v3.13.x` and one or more `.zip`/`.tar.*` assets. Record tag + chosen asset name in FINDINGS.md (row 8 notes). If this repo has gone stale, check `https://github.com/python/cpython/blob/main/Tools/wasm/README.md` for the currently blessed WASI build source and use that instead — the fetch script's URL is the only thing that changes.

- [ ] **Step 2: Write the fetch script (two-phase hash pinning)**

Create `spikes/code_exec/fetch_python_wasi.sh`:

```bash
#!/usr/bin/env bash
# Fetches the pinned CPython-WASI build into vendor/ (gitignored).
# Phase 1 (SHA256 empty): downloads and prints the hash to pin.
# Phase 2 (SHA256 set): verifies the pin, then unpacks.
set -euo pipefail
cd "$(dirname "$0")"

# --- pin (fill from Step 1 discovery + Step 3 hash) ---
URL=""      # asset browser_download_url from Step 1
SHA256=""   # pinned after first download
# ------------------------------------------------------

[ -n "$URL" ] || { echo "Set URL first (see plan Task 2)"; exit 1; }
mkdir -p vendor
archive="vendor/$(basename "$URL")"
[ -f "$archive" ] || curl -fL --retry 3 -o "$archive" "$URL"

actual=$(sha256sum "$archive" | cut -d' ' -f1)
if [ -z "$SHA256" ]; then
  echo "PIN THIS: SHA256=$actual"
elif [ "$actual" != "$SHA256" ]; then
  echo "HASH MISMATCH: expected $SHA256 got $actual" >&2; exit 1
fi

case "$archive" in
  *.zip) unzip -oq "$archive" -d vendor ;;
  *.tar.gz|*.tgz) tar -xzf "$archive" -C vendor ;;
  *.tar.zst) tar --zstd -xf "$archive" -C vendor ;;
esac
echo "Unpacked. Layout:"; find vendor -maxdepth 3 -name '*.wasm' -o -maxdepth 2 -type d | head -20
```

Fill `URL=` with the asset URL from Step 1.

- [ ] **Step 3: Run phase 1, pin the hash, run phase 2**

Run: `bash spikes/code_exec/fetch_python_wasi.sh`
Expected: `PIN THIS: SHA256=<hex>`. Paste that hex into `SHA256=` in the script, rerun.
Expected: `Unpacked. Layout:` followed by the `.wasm` path and the stdlib directory. Record both paths and the archive's exact layout (where `python.wasm` sits, where `lib/python3.13/` sits) in FINDINGS.md — Task 3's `host.py` constants come from here.

- [ ] **Step 4: Verify reproducibility (criterion 8, first half)**

Run: `rm -rf spikes/code_exec/vendor && bash spikes/code_exec/fetch_python_wasi.sh`
Expected: clean re-download, hash verifies, unpack succeeds. Fill FINDINGS.md row 8 result: "fetch script hash-pinned + re-runnable; CI wiring deferred to M1".

- [ ] **Step 5: Commit**

```bash
git add spikes/code_exec/fetch_python_wasi.sh spikes/code_exec/FINDINGS.md
git commit -m "spike(m0): hash-pinned fetch script for CPython-WASI guest"
```

---

## Task 3: Shared host helper + s01 boot probe (criterion 1)

**Files:**
- Create: `spikes/code_exec/host.py`
- Create: `spikes/code_exec/s01_boot.py`

**Interfaces:**
- Produces: `host.make_engine(epoch: bool = False) -> tuple[Engine, Module]` and `host.run_python(argv, *, stdin_file=None, stdout_file=None, env=(), preopens=(), epoch=False, mem_limit=None, engine_module=None) -> tuple[int, float]` (exit code, elapsed seconds). Every later probe imports these.

- [ ] **Step 1: Write the shared helper**

Create `spikes/code_exec/host.py` (adjust the two `VENDOR`-relative constants to the layout recorded in Task 2 — that is the only intended edit):

```python
"""Shared host-side helpers for the CPython-WASI spike probes.

Spike code: favors print-and-measure over abstraction. Not production.
"""
from __future__ import annotations

import pathlib
import time

from wasmtime import Config, Engine, ExitTrap, Linker, Module, Store, StoreLimits, Trap, WasiConfig

ROOT = pathlib.Path(__file__).parent
VENDOR = ROOT / "vendor"
PYTHON_WASM = VENDOR / "python.wasm"          # <- adjust to Task 2 layout
GUEST_LIB_HOST = VENDOR / "lib"               # <- adjust to Task 2 layout
GUEST_LIB_GUEST = "/lib"                       # where the guest sees the stdlib


def make_engine(epoch: bool = False) -> tuple[Engine, Module]:
    cfg = Config()
    if epoch:
        cfg.epoch_interruption = True
    engine = Engine(cfg)
    t0 = time.perf_counter()
    module = Module.from_file(engine, str(PYTHON_WASM))
    print(f"[host] module compile: {time.perf_counter() - t0:.2f}s")
    return engine, module


def run_python(
    argv: list[str],
    *,
    stdin_file: str | None = None,
    stdout_file: str | None = None,
    env: tuple[tuple[str, str], ...] = (),
    preopens: tuple[tuple[str, str], ...] = (),
    epoch: bool = False,
    mem_limit: int | None = None,
    engine_module: tuple[Engine, Module] | None = None,
) -> tuple[int, float]:
    """Boot the guest interpreter with argv, run to completion, return (exit_code, seconds)."""
    engine, module = engine_module or make_engine(epoch=epoch)
    linker = Linker(engine)
    linker.define_wasi()
    store = Store(engine)
    if mem_limit is not None:
        store.set_limits(StoreLimits(memory_size=mem_limit))
    if epoch:
        store.set_epoch_deadline(1)

    wasi = WasiConfig()
    wasi.argv = ["python"] + argv
    wasi.env = [("PYTHONHOME", GUEST_LIB_GUEST), ("PYTHONPATH", GUEST_LIB_GUEST)] + list(env)
    wasi.preopen_dir(str(GUEST_LIB_HOST), GUEST_LIB_GUEST)
    for host_path, guest_path in preopens:
        wasi.preopen_dir(host_path, guest_path)
    if stdin_file:
        wasi.stdin_file = stdin_file
    if stdout_file:
        wasi.stdout_file = stdout_file
    wasi.stderr_file = str(ROOT / "guest_stderr.log")
    store.set_wasi(wasi)

    instance = linker.instantiate(store, module)
    start = instance.exports(store)["_start"]
    t0 = time.perf_counter()
    try:
        start(store)
        code = 0
    except ExitTrap as e:
        code = e.code
    return code, time.perf_counter() - t0
```

Notes for the implementer: `wasmtime-py`'s exact spelling of `StoreLimits` / `set_limits` / `wasi.stdin_file` has drifted across majors. If an attribute is missing, `pixi run -e core-dev python -c "import wasmtime; help(wasmtime.Store)"` (and `help(wasmtime.WasiConfig)`) shows the current names — adapt `host.py` only, keep the function signatures above stable, and note the drift in FINDINGS.md.

- [ ] **Step 2: Write the boot probe**

Create `spikes/code_exec/s01_boot.py`:

```python
"""Criterion 1: guest boots, runs code, stdout is captured; measure boot cost."""
from host import ROOT, run_python

OUT = ROOT / "s01_out.txt"
code, secs = run_python(["-c", "import sys; print('guest-ok', sys.version)"], stdout_file=str(OUT))
print(f"[s01] exit={code} elapsed={secs:.3f}s stdout={OUT.read_text().strip()!r}")
assert code == 0 and "guest-ok" in OUT.read_text(), "boot FAILED — see guest_stderr.log"
print("[s01] PASS")
```

- [ ] **Step 3: Run it**

Run: `pixi run -e core-dev python spikes/code_exec/s01_boot.py`
Expected: `guest-ok 3.13.…` in captured stdout, `PASS`, and the two timings (module compile, run). If the interpreter can't find its stdlib (`ModuleNotFoundError: encodings` in `guest_stderr.log`), the `PYTHONHOME`/preopen mapping doesn't match the bundle layout — fix the two constants, not the plan. Record boot + compile timings in FINDINGS.md row 1.

- [ ] **Step 4: Commit**

```bash
git add spikes/code_exec/host.py spikes/code_exec/s01_boot.py spikes/code_exec/FINDINGS.md
git commit -m "spike(m0): s01 boot probe passes"
```

---

## Task 4: s02 interactive bridge probe — THE critical risk (criterion 2)

**Files:**
- Create: `spikes/code_exec/guest_harness.py` (runs *inside* the guest)
- Create: `spikes/code_exec/s02_bridge.py`
- Create: `spikes/code_exec/s02b_subprocess.py` (fallback probe)

**Interfaces:**
- Produces: the newline-JSON bridge protocol (`{"id": int, "op": str, ...}` per line, response `{"id": …, …}` per line) that s07/s08 reuse; `guest_harness.py` with ops `ping`, `echo`, `quit` (s08 adds `batch` later).

- [ ] **Step 1: Write the guest harness**

Create `spikes/code_exec/guest_harness.py`:

```python
"""Runs INSIDE CPython-WASI. Newline-JSON request/response loop over stdio."""
import json
import sys

sys.stdout.write(json.dumps({"id": 0, "ready": True}) + "\n")
sys.stdout.flush()

for line in sys.stdin:
    req = json.loads(line)
    op = req["op"]
    if op == "quit":
        break
    if op == "ping":
        resp = {"id": req["id"], "pong": True}
    elif op == "echo":
        resp = {"id": req["id"], "x": req["x"] * 2}
    else:
        resp = {"id": req["id"], "error": f"unknown op {op}"}
    sys.stdout.write(json.dumps(resp) + "\n")
    sys.stdout.flush()
```

- [ ] **Step 2: Write the FIFO bridge probe**

The in-process design needs the guest's blocking `stdin` read to be served by the host at runtime. File-backed stdio can't do that; named pipes (FIFOs) can. Host opens both FIFOs `O_RDWR` first so neither open blocks, then boots the guest with the FIFOs as `stdin_file`/`stdout_file` **in a worker thread** (the `_start` call blocks until the harness exits).

Create `spikes/code_exec/s02_bridge.py`:

```python
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
```

- [ ] **Step 3: Run it**

Run: `pixi run -e core-dev python spikes/code_exec/s02_bridge.py`
Expected: `guest ready`, then RTT stats with p50 < 5 ms, `PASS`. Failure modes and what they mean:
- Hang before "guest ready": wasmtime opened the FIFO in a mode that doesn't stream (e.g. buffered whole-file semantics) → **in-process stdio is a no-go**; run Step 4's fallback and record which path works.
- `wasi.stdin_file` rejects a FIFO path outright → same: fallback probe decides.
- Works but p50 ≥ 5 ms: record the number — batching (s08) may still carry the design; not an automatic no-go.

Record outcome in FINDINGS.md row 2.

- [ ] **Step 4: Write and (only if Step 3 failed) run the subprocess fallback**

This is spec §4's blessed fallback ("runner in a dedicated subprocess speaking the same protocol"): the guest inherits the *subprocess's* real stdio, and the parent talks to the subprocess over ordinary pipes.

Create `spikes/code_exec/s02b_subprocess.py`:

```python
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
```

If Step 3 failed: add the `inherit_stdio: bool = False` keyword to `host.run_python` (when true, call `wasi.inherit_stdin()`/`wasi.inherit_stdout()` and skip the `*_file` setters), run `pixi run -e core-dev python spikes/code_exec/s02b_subprocess.py` (note: `sys.executable` inside the pixi env is the env's python, so this stays pixi-only), and record in FINDINGS.md that the shipping architecture becomes **subprocess-runner** — same `ScriptRunner` protocol, same spec, one paragraph of §4 changes. If Step 3 passed, commit s02b unrun as the documented fallback (mark it "not needed" in FINDINGS.md).

- [ ] **Step 5: Commit**

```bash
git add spikes/code_exec/guest_harness.py spikes/code_exec/s02_bridge.py spikes/code_exec/s02b_subprocess.py spikes/code_exec/host.py spikes/code_exec/FINDINGS.md
git commit -m "spike(m0): s02 interactive bridge probe (+ subprocess fallback)"
```

---

## Task 5: s03 GIL-release probe (criterion 3)

**Files:**
- Create: `spikes/code_exec/s03_gil.py`

**Interfaces:**
- Consumes: `host.run_python`, `host.make_engine`.
- Produces: FINDINGS.md row 3 verdict — decides in-process vs subprocess for M1.

- [ ] **Step 1: Write the probe**

Create `spikes/code_exec/s03_gil.py`:

```python
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
```

- [ ] **Step 2: Run it**

Run: `pixi run -e core-dev python spikes/code_exec/s03_gil.py`
Expected: ratio ≥ 0.5 (two threads on a multi-core box should barely contend if the GIL is released) and `PASS`. If it fails, the M1 architecture is the subprocess runner from Task 4 Step 4 — record it in FINDINGS.md row 3 and continue the spike (all remaining probes are architecture-agnostic).

- [ ] **Step 3: Commit**

```bash
git add spikes/code_exec/s03_gil.py spikes/code_exec/FINDINGS.md
git commit -m "spike(m0): s03 GIL-release probe"
```

---

## Task 6: s04 epoch-kill + s05 memory-cap probes (criterion 4)

**Files:**
- Create: `spikes/code_exec/s04_epoch.py`
- Create: `spikes/code_exec/s05_memory.py`

**Interfaces:**
- Consumes: `host.run_python(epoch=True)`, `host.run_python(mem_limit=…)`.
- Produces: FINDINGS.md row 4; confirms both halves of the spec's limits table are implementable.

- [ ] **Step 1: Write the epoch probe**

Create `spikes/code_exec/s04_epoch.py`:

```python
"""Criterion 4a: epoch interruption kills `while True` within ~500ms of the deadline."""
import threading
import time

from host import make_engine, run_python
from wasmtime import Trap

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
except Trap:
    elapsed = time.perf_counter() - t0
    overshoot = elapsed - KILL_AFTER
    print(f"[s04] trapped after {elapsed:.2f}s (overshoot {overshoot*1000:.0f}ms)")
    assert overshoot < 0.5, "kill latency over threshold"
    print("[s04] PASS")
```

- [ ] **Step 2: Run the epoch probe**

Run: `pixi run -e core-dev python spikes/code_exec/s04_epoch.py`
Expected: trap ~2.0–2.5 s in, `PASS`. If `ExitTrap` is raised instead of `Trap`, inspect what wasmtime-py raises for epoch interruption (`help(wasmtime.Trap)`), adjust the except clause, and note it — the shipped runner must distinguish "timed out" from "guest exited".

- [ ] **Step 3: Write the memory probe**

Create `spikes/code_exec/s05_memory.py`:

```python
"""Criterion 4b: a 256MB store limit stops a guest allocating ~500MB."""
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
except Trap:
    print("[s05] trapped on allocation. PASS (trap path)")
```

- [ ] **Step 4: Run the memory probe**

Run: `pixi run -e core-dev python spikes/code_exec/s05_memory.py`
Expected: PASS via either path; record **which** path (trap vs in-guest MemoryError) in FINDINGS.md row 4 — the shipped runner's error mapping (§10 of the spec) depends on it.

- [ ] **Step 5: Commit**

```bash
git add spikes/code_exec/s04_epoch.py spikes/code_exec/s05_memory.py spikes/code_exec/FINDINGS.md
git commit -m "spike(m0): s04/s05 epoch-kill and memory-cap probes"
```

---

## Task 7: s06 determinism-stub probe (criterion 5)

**Files:**
- Create: `spikes/code_exec/s06_determinism.py`
- Modify: `spikes/code_exec/host.py` (add optional WASI shims)

**Interfaces:**
- Produces: FINDINGS.md row 5; a working (or refuted) recipe for shadowing `wasi_snapshot_preview1.clock_time_get` / `random_get` that M1's runner copies.

- [ ] **Step 1: Add shim support to host.py**

Add to `spikes/code_exec/host.py` a `deterministic: bool = False` keyword on `run_python`. When true, before `linker.define_wasi()` set `linker.allow_shadowing = True`, and after `define_wasi()` register two host functions that shadow the WASI ones (shadow-after relies on `allow_shadowing`; if wasmtime-py resolves first-wins instead, swap the order — that discovery is the point of this probe):

```python
from wasmtime import Func, FuncType, ValType

FIXED_NANOS = 1_750_000_000_000_000_000  # fixed wall-clock epoch

def _add_determinism_shims(linker: Linker, store: Store) -> None:
    i32, i64 = ValType.i32(), ValType.i64()

    def clock_time_get(caller, clock_id, precision, out_ptr):
        mem = caller.get("memory")
        # clock 0 = realtime -> fixed; others (monotonic) pass a counter so the interpreter can boot
        nanos = FIXED_NANOS if clock_id == 0 else int(time.perf_counter_ns())
        mem.write(caller, nanos.to_bytes(8, "little"), out_ptr)
        return 0

    def random_get(caller, buf, buf_len):
        mem = caller.get("memory")
        mem.write(caller, bytes([0x42]) * buf_len, buf)
        return 0

    linker.define_func("wasi_snapshot_preview1", "clock_time_get",
                       FuncType([i32, i64, i32], [i32]), clock_time_get, access_caller=True)
    linker.define_func("wasi_snapshot_preview1", "random_get",
                       FuncType([i32, i32], [i32]), random_get, access_caller=True)
```

Wire it into `run_python`, and when `deterministic=True` also append `("PYTHONHASHSEED", "0")` to the env.

- [ ] **Step 2: Write the probe**

Create `spikes/code_exec/s06_determinism.py`:

```python
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
```

- [ ] **Step 3: Run it**

Run: `pixi run -e core-dev python spikes/code_exec/s06_determinism.py`
Expected: identical lines twice, `PASS`. Known wrinkles to record rather than fight: if the interpreter won't boot with a fixed monotonic clock, keep monotonic real (as coded) — the spec only promises a fixed *wall* clock. If `define_func` shadowing is impossible in the installed wasmtime-py, record row 5 as **partial**: fallback is lint/import-hook blocking of `time`/`random` (weaker guarantee, spec §4 needs a one-line amendment) — not a spike no-go on its own.

- [ ] **Step 4: Commit**

```bash
git add spikes/code_exec/host.py spikes/code_exec/s06_determinism.py spikes/code_exec/FINDINGS.md
git commit -m "spike(m0): s06 determinism shims probe"
```

---

## Task 8: s07 warm-pool latency probe (criterion 6)

**Files:**
- Create: `spikes/code_exec/s07_pool.py`

**Interfaces:**
- Consumes: bridge protocol + FIFO mechanics from s02 (or the subprocess transport if s02 chose the fallback — use whichever s02 recorded as the working path).
- Produces: FINDINGS.md row 6; measured module-cache/instantiate/boot/handoff costs that size M1's pool.

- [ ] **Step 1: Write the probe**

Create `spikes/code_exec/s07_pool.py`:

```python
"""Criterion 6: with a pre-booted instance, request->response fits in 300ms.

Measures the three latency components separately:
  a) Module.deserialize from a disk cache (vs cold compile)
  b) instantiate + interpreter boot to 'ready' handshake
  c) handoff: first request -> response on an already-'ready' instance
"""
import json
import os
import statistics
import threading
import time

from host import PYTHON_WASM, ROOT, make_engine, run_python
from wasmtime import Engine, Module

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
```

- [ ] **Step 2: Run it**

Run: `pixi run -e core-dev python spikes/code_exec/s07_pool.py`
Expected: deserialize ≪ cold compile; warm handoff p50 well under 300 ms; boot-to-ready is the pool-refill cost (fine at hundreds of ms since it's off the request path). Record all three numbers in FINDINGS.md row 6.

- [ ] **Step 3: Commit**

```bash
git add spikes/code_exec/s07_pool.py spikes/code_exec/FINDINGS.md
git commit -m "spike(m0): s07 warm-pool latency probe"
```

---

## Task 9: s08 50k-element batched benchmark (criterion 7)

**Files:**
- Modify: `spikes/code_exec/guest_harness.py` (add `batch` op)
- Create: `spikes/code_exec/s08_bench50k.py`

**Interfaces:**
- Produces: FINDINGS.md row 7; the measured per-batch overhead that validates (or resizes) the spec's 500-element page default.

- [ ] **Step 1: Add the batch op to the guest harness**

In `spikes/code_exec/guest_harness.py`, add before the `else` clause:

```python
    elif op == "batch":
        # Simulates ScriptColumn evaluation: value(el) = len(el["name"]) per element.
        values = [len(el["name"]) for el in req["elements"]]
        resp = {"id": req["id"], "values": values}
```

- [ ] **Step 2: Write the benchmark**

Create `spikes/code_exec/s08_bench50k.py`:

```python
"""Criterion 7: a trivial value(el) over 50k elements, batches of 500, within 30s.

Also measures a 500-call single-element sample to document WHY batching is
load-bearing (spec section 4).
"""
import json
import os
import statistics
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
```

- [ ] **Step 3: Run it**

Run: `pixi run -e core-dev python spikes/code_exec/s08_bench50k.py`
Expected: batched well under 30 s; unbatched extrapolation dramatically worse. If batched exceeds 30 s, retry with `BATCH = 2000` and record the sweet spot — the spec's page-size default (§9 limits table) should be amended to the measured value. Record both numbers in FINDINGS.md row 7.

- [ ] **Step 4: Commit**

```bash
git add spikes/code_exec/guest_harness.py spikes/code_exec/s08_bench50k.py spikes/code_exec/FINDINGS.md
git commit -m "spike(m0): s08 50k-element batched benchmark"
```

---

## Task 10: Consolidate findings, go/no-go verdict, spec follow-ups

**Files:**
- Modify: `spikes/code_exec/FINDINGS.md`
- Modify: `docs/superpowers/specs/2026-07-17-code-execution-design.md` (only if findings require amendments; gitignored, no commit)

**Interfaces:**
- Consumes: all eight FINDINGS.md rows.
- Produces: the go/no-go decision that gates M1; the amendment list for the spec.

- [ ] **Step 1: Fill the verdict section**

In `FINDINGS.md`, complete every row (result + verdict), then write the Verdict section using exactly one of:
- **GO** — all rows pass (or pass-with-notes): proceed to M1 as specced (in-process WASM runner).
- **GO (subprocess variant)** — rows 2 or 3 forced the subprocess runner: proceed to M1 with the §4 architecture note amended; everything else in the spec stands.
- **GO (amendments)** — passes with spec deltas (e.g. determinism partial → lint-block `time`/`random`; page size resized from s08): list each delta as a bullet with the spec section it changes.
- **NO-GO** — a hard fail with no recorded fallback (e.g. neither FIFO nor subprocess transport works, or the benchmark is order-of-magnitude off): recommend spec §12's fallback (a) — restricted AST expression subset + Pyodide console — and stop; M1+ plans are void and get re-planned against the fallback.

- [ ] **Step 2: Apply spec amendments (if any)**

Edit the spec sections named in the verdict bullets. The spec is gitignored — no commit for it; FINDINGS.md is the committed record.

- [ ] **Step 3: Run the full probe suite once more, clean**

Run:

```bash
rm -rf spikes/code_exec/vendor && bash spikes/code_exec/fetch_python_wasi.sh
for s in s01_boot s02_bridge s03_gil s04_epoch s05_memory s06_determinism s07_pool s08_bench50k; do
  pixi run -e core-dev python spikes/code_exec/$s.py || echo "FAILED: $s"
done
```

Expected: every probe that FINDINGS.md marks PASS passes again from a clean vendor fetch (criterion 8, second half). Any flake → investigate before the verdict stands.

- [ ] **Step 4: Commit and present**

```bash
git add spikes/code_exec/FINDINGS.md
git commit -m "spike(m0): findings + go/no-go verdict"
```

Present the verdict to the user. **M1 planning does not start until the user accepts the verdict.**

---

# M1–M4 — milestone-level outline (expand into task plans after M0)

These are deliberately not task-level: M1's runner tasks depend on M0's verdict (in-process vs subprocess transport, determinism recipe, page-size default). Each milestone gets its own plan document when reached. Spec section references are authoritative for all details.

## M1 — Snippet artifacts, editor, lint, console (spec §3, §5, §7, §8, §9)

Standalone snippets fully usable end-to-end: create → edit with diagnostics → run → stage ops → commit.

- **Backend:** `ArtifactKind.code_snippet` + Alembic CHECK-widening migration; `core/script/schema.py` (`SnippetDefinition`, entry-point derivation); `core/script/runner.py` (`ScriptRunner` protocol, `RunResult`); `api/script_runner.py` (`WasmScriptRunner` per M0 findings: engine/module at startup, warm pool, bridge dispatcher, limits, determinism shims); guest-side `dr` facade (reads + op-recording writes per §5) and lint module (`ast.parse`, scope walk, import allowlist, signature checks); routes `POST /snippets/run|lint|cancel` (+ read-only-POST allowlist entry, owner-bound cancel, audit log line); settings for every §9 limit; `TrustedRunner` under `tests/` + production tripwire.
- **Frontend:** CodeMirror 6 dependency; snippet workspace tab (editor + diagnostics gutter + console panel with Run/Stop, stdout/result, ops-preview + "Stage ops" into the staged buffer); `createCodeSnippetArtifact` in `artifacts.svelte.ts`; sidebar listing with entry-point badges; view placement (should be free).
- **Exit criteria:** e2e Playwright: create snippet → lint shows syntax error → fix → run → stage ops → preview → commit. Integration-marked WASM tests: timeout kill, memory cap, import blocking, determinism, cross-run isolation.

## M2 — Table ScriptColumn (spec §3, §6)

- `ScriptColumn` + `SnippetSource` in `core/table/schema.py`; evaluator integration in `core/table/cells.py`/`evaluate.py` (one instance per evaluation, per-row `value(el)` calls, return-value → cell mapping, `ErrorCell` variant); resolved-code-hash in the row-order fingerprint; **truncated/stale evaluations bypass the order cache**; shared time budget; xlsx export under budget with truncation notice; runtime entry-point resolution for untrusted inline definitions; ColumnManager UI + snippet picker filtered by `entry_points`; error-cell rendering with traceback on hover.
- **Exit criteria:** sortable/exportable snippet column over the smart-city example; error cell on a raising row; cache-poisoning regression test (budget-truncated evaluation does not populate the order cache).

## M3 — Navigation ScriptStep (spec §3, §6)

- `ScriptStep` in `core/navigation/schema.py`; evaluator integration (frontier in, elements out, dedup, `exclude_visited`, chain column, `step_types` = union of observed); per-element errors prune-with-warning; shared budget accounting through nav-in-table nesting; nav editor UI step type + snippet picker; warnings surfaced in evaluation responses.
- **Exit criteria:** navigation mixing relationship/property/script steps evaluates and composes inside a table `NavigationColumn` under one budget; pruned-chain warning visible in the UI.

## M4 — Polish & operations (spec §7, §9, §11)

- Facade docs panel in the editor (generated from the `dr` API definitions); example snippets shipped with the smart-city project; audit-log review + per-user fairness tuning under real concurrency; CI wiring for the pinned guest-binary fetch; docs: what's absent under WASI, determinism guarantees, read-your-writes limitation.
- **Exit criteria:** a new user can author a working snippet from the docs panel alone; ops runbook section for the sandbox (pool sizing, limits, kill events).

---

## Self-review notes (resolved inline)

- Spec coverage: §12 items 1–8 map to Tasks 3–10 (item 8 split across Tasks 2 and 10); §4's GIL/transport risks map to Tasks 4–5; M1–M4 outline covers §3/§5–§9/§11 with spec-pointers rather than detail, per the agreed scope.
- Type consistency: `host.run_python` signature is defined once (Task 3) and extended twice (Task 4: `inherit_stdio`; Task 7: `deterministic`) — extensions are keyword-only additions, existing call sites unaffected.
- Placeholders: the two intentionally-empty values (`URL=`, `SHA256=` in Task 2) are filled by that task's own steps, not deferred work.
