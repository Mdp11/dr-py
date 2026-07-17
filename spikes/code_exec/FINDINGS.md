# M0 spike findings

| # | Criterion (spec §12) | Threshold | Result | Verdict |
|---|---|---|---|---|
| 1 | CPython-WASI boots under wasmtime-py | runs a script, captures stdout | PASS — `python spikes/code_exec/s01_boot.py`: module compile 0.66s, run (boot+exec) 0.080s, exit=0, stdout=`guest-ok 3.14.6 (tags/v3.14.6-dirty:c63aec6, Jun 10 2026, ...) [Clang 18.1.2-wasi-sdk ...]`, `guest_stderr.log` empty | ✅ |
| 2 | Interactive blocking stdio round-trip | works; p50 RTT < 5 ms | PASS — **transport = FIFO in-process**. `timeout 90 python spikes/code_exec/s02_bridge.py` → EXIT=0: `[s02] guest ready`, 200 echo round-trips `p50=0.34ms p95=0.56ms`, `[s02] PASS`; `guest_stderr.log` empty | ✅ |
| 3 | GIL released during guest execution | host thread ≥ 50% solo rate | | |
| 4 | Epoch kill + memory cap | trap ≤ 500 ms after deadline; cap enforced | | |
| 5 | Determinism stubs | fixed clock/random/hashseed; 2 runs identical | | |
| 6 | Warm-pool console latency | ≤ 300 ms end-to-end | | |
| 7 | 50k-element batched benchmark | ≤ 30 s total | | |
| 8 | Packaging reproducible | hash-pinned fetch, re-runnable | fetch script hash-pinned + re-runnable; CI wiring deferred to M1 | |

Environment: wasmtime-py 46.0.1, CPython-WASI v3.14.6 (`brettcannon/cpython-wasi-build`), host Python 3.14.5, linux-64.

### Bundle source & pin (Task 2)

- Source repo: `brettcannon/cpython-wasi-build` (release feed is current — latest tag `v3.14.6`, published 2026-06-10; no need to fall back to the `python/cpython` Tools/wasm README source).
- Tag: `v3.14.6`
- Asset: `python-3.14.6-wasi_sdk-24.zip`
  (`browser_download_url`: `https://github.com/brettcannon/cpython-wasi-build/releases/download/v3.14.6/python-3.14.6-wasi_sdk-24.zip`; the release also publishes a `_build-python-3.14.6-wasi_sdk-24.zip` companion asset — build artifacts only, not needed for the runtime guest bundle)
- SHA-256 (pinned in `fetch_python_wasi.sh`): `73bf2e9774c4d8820d0877ec5db0b963df3a9611fc2a63838aeaee29dfd034e6`

### Bundle layout (`vendor/`, gitignored, populated by `fetch_python_wasi.sh`)

After unpack, `spikes/code_exec/vendor/` contains:

```
vendor/
├── LICENSE
├── python-3.14.6-wasi_sdk-24.zip   # downloaded archive (kept as cache; re-run skips download if present)
├── python.wasm                      # the guest binary — WebAssembly (wasm) binary module version 0x1 (MVP)
└── lib/
    └── python3.14/                  # full stdlib source tree, incl. encodings/, __phello__/, _pyrepl/, etc.
```

Paths Task 3's `host.py` should hardcode (relative to `spikes/code_exec/`):
- `PYTHON_WASM = "vendor/python.wasm"` (absolute on this machine: `/home/mdp/workspace/data-rover-py/spikes/code_exec/vendor/python.wasm`)
- `GUEST_LIB = "vendor/lib/python3.14"` (absolute on this machine: `/home/mdp/workspace/data-rover-py/spikes/code_exec/vendor/lib/python3.14`) — this is the directory containing `encodings/`, so mapping it as the guest's stdlib root (e.g. preopened as `/lib` with `sys.path` including it, per the standard CPython-WASI convention of setting `PYTHONPATH=/lib` inside the guest and preopening `vendor/lib/python3.14` to `/lib`) should satisfy the `encodings` import at boot.
- Note the version-specific segment: stdlib lives under `lib/python3.14/` (matches the CPython 3.14.6 release), not `python3.13/` — Task 3 must not hardcode `3.13`.

Reproducibility check (Step 4): `rm -rf spikes/code_exec/vendor && bash spikes/code_exec/fetch_python_wasi.sh` re-downloaded cleanly, the SHA-256 matched the pin (no mismatch error, exit 0), and unpack produced the identical layout (`vendor/python.wasm`, `vendor/lib/python3.14`).

### wasmtime-py 46.0.1 API notes (Task 3)

Checked against `help(wasmtime.Store)`, `help(wasmtime.WasiConfig)`, `help(wasmtime.Config)`, `help(wasmtime.ExitTrap)`, and `dir(wasmtime)` on the installed 46.0.1. Only one name from the task-3 brief's sketch has actually drifted:

- **`StoreLimits` does not exist** in 46.0.1 (`dir(wasmtime)` has no such name). `Store.set_limits(...)` takes the limit kwargs directly (`memory_size`, `table_elements`, `instances`, `tables`, `memories`, each defaulting to `-1` = unset) — call `store.set_limits(memory_size=mem_limit)`, not `store.set_limits(StoreLimits(memory_size=mem_limit))`. `host.py` adapted accordingly.
- Everything else in the brief's sketch matched the installed API verbatim: `wasi.stdin_file` / `wasi.stdout_file` / `wasi.stderr_file` (write-only attributes), `wasi.preopen_dir(path, guest_path)`, `Config.epoch_interruption`, `store.set_epoch_deadline(ticks_after_current)`, and `ExitTrap` (subclass of `WasmtimeError`, carries `.code`).
- `mem_limit`/`epoch` wiring in `run_python` is unexercised by s01 (no `mem_limit`/`epoch` args passed by the boot probe) — the `set_limits`/`set_epoch_deadline` call sites are implemented per the corrected API above but not yet proven end-to-end; that's Task 6's job.

### Criterion 2 — interactive bridge transport decision (Task 4)

- **Working transport = FIFO in-process.** The host opens both FIFOs `O_RDWR` (so opens never block and the pipe never sees a premature EOF while held), boots the guest on a worker thread with the FIFOs wired as `wasi.stdin_file` / `wasi.stdout_file`, then does a synchronous newline-JSON request/response loop. wasmtime-46 **streams** WASI stdio to/from the FIFO at runtime — it does not slurp-then-run or buffer-until-exit — so the guest's blocking `sys.stdin` read is served live and the `ready` handshake arrives before the guest exits.
- **Measured:** 200 `echo` round-trips, `p50=0.34ms`, `p95=0.56ms` (host Python 3.14, wasmtime-py 46.0.1, linux-64). Comfortably under the 5 ms gate — no reliance on Task 9 batching to clear the threshold.
- **Decision for Tasks 8/9:** reuse the **FIFO in-process** path and the newline-JSON bridge protocol (`{"id", "op", ...}` request / `{"id", ...}` response per line; ops `ping`/`echo`/`quit`, s08 adds `batch`). Shipping architecture stays **in-process** — spec §4's subprocess-runner fallback is NOT needed.
- **`s02b_subprocess.py` committed unrun** as the documented fallback only. It references an `inherit_stdio=True` kwarg that was deliberately **not** added to `host.py` (the PASS branch of the decision tree forbids touching `host.py`); if a future regression forces the subprocess path, add `inherit_stdio` to `run_python` (calling `wasi.inherit_stdin()`/`wasi.inherit_stdout()` instead of the `*_file` setters) and run the probe then.

## Verdict

(go / no-go / go-with-amendments — filled in Task 10)
