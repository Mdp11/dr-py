# Client-engine spike (THROWAWAY)

Answers one question: can the existing Python core run **in the browser** fast
enough on the normal 80 MB model (`benchmarks/large.model.json`, 170k elements /
127k relationships), or does the engine have to be rewritten in TypeScript?

Nothing here is production code. Findings are in `FINDINGS.md`.

## What it measures

Python core, unmodified, under Pyodide in a worker inside a **cross-origin,
CSP-locked iframe** (the script sandbox the real design needs):

| Threshold | Limit |
|---|---|
| Open the project (boot ∥ fetch, gunzip, parse, build, index) | ≤ 8 s |
| 10,000 script cells (1000 rows × 10 distinct snippets) | ≤ 2 s |
| 100k-row table, build + sort + every cell | ≤ 10 s |
| Engine wasm heap, peak | ≤ 600 MB |

Plus: full validation sweep, index-free search scan, interrupting a runaway
script without losing the loaded model, and a minimal JavaScript replica running
like-for-like workloads for comparison.

## Run it

Needs the Pyodide runtime and wheels on disk (defaults point at the research
scratch dir; override with `PYODIDE_DIR` / `WHEEL_DIR`):

```sh
mkdir -p /tmp/pyodide-bench && cd /tmp/pyodide-bench && npm init -y && npm i pyodide@314.0.7
# wheels: pydantic, pydantic_core, pyyaml, sortedcontainers, annotated_types,
# typing_extensions, typing_inspection from the Pyodide 314.0.7 lock file -> pkgcache/
```

The Rust replica needs building once (no Rust install required; the target dir is
the gitignored `benchmarks/`):

```sh
cd spikes/client_engine/rust_replica
CARGO_TARGET_DIR=../../../benchmarks/spike-rust-target \
  pixi exec --spec rust --spec rust-std-wasm32-unknown-unknown -- \
  cargo build --release --target wasm32-unknown-unknown
```

Headless (Playwright's Chromium, writes `results.json` or `$OUT`). `RUNS` picks the
passes: `cold` (Python, plain load + JS replica), `warm` (same, warm HTTP cache),
`gc` (Python, tuned load), `orjson` (tuned load + orjson; needs the orjson wheel in
`WHEEL_DIR`), `stores` (JS and Rust stores, each also read by Python user scripts):

```sh
pixi run -e frontend node spikes/client_engine/run.mjs                   # every pass
RUNS=gc,stores pixi run -e frontend node spikes/client_engine/run.mjs    # the three-way comparison
```

In your own browser:

```sh
pixi run -e frontend node spikes/client_engine/serve.mjs
# then open http://localhost:8801/               Python, plain load + JS replica
#           http://localhost:8801/?fast=gc       Python, tuned load
#           http://localhost:8801/?mode=stores   JS and Rust stores
```

Native baseline of the same workloads:

```sh
PYTHONPATH=src:tests/script:spikes/client_engine pixi run -e core-dev python -c \
  "import bench_engine as b; d=open('benchmarks/large.model.json','rb').read(); \
   mm=open('examples/smart-city.metamodel.yaml').read(); \
   print(b.open_snapshot(d,mm,False), b.big_table(), b.script_table(), b.search_scan(), b.validate_all())"
```

## Layout

- `serve.mjs` — two static origins: APP `localhost:8801`, SANDBOX `127.0.0.1:8802` (CSP, COEP/CORP).
- `app.html` / `app.js` — trusted shell: fetches the snapshot, boots the sandbox, scores thresholds.
- `sandbox.html` / `sandbox.js` — relay page on the sandbox origin; owns the interrupt byte.
- `engine-worker.mjs` — Pyodide + `data_rover.core` + `bench_engine.py`.
- `bench_engine.py` — the workloads (also runs natively).
- `js-replica*.mjs`, `jsmem.html` — minimal JS replica for context numbers.
- `rust_replica/` — minimal Rust replica (raw C ABI, no wasm-bindgen).
- `store-worker.mjs` + `script_host.py` — both replicas in one worker, each also read
  by unmodified Python user scripts through the facade's bridge ops.
- `run.mjs` — Playwright runner. `results/` — the recorded runs.

Generated fixtures (`spike.snapshot.json.gz`, `spike.core_src.tar.gz`) land in the
gitignored `benchmarks/`.
