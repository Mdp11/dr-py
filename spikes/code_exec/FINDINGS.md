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

## Verdict

(go / no-go / go-with-amendments — filled in Task 10)
