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

Environment: wasmtime-py 46.0.1, CPython-WASI <version/asset>, host Python 3.14.5, linux-64.

## Verdict

(go / no-go / go-with-amendments — filled in Task 10)
