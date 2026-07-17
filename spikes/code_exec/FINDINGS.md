# M0 spike findings

| # | Criterion (spec §12) | Threshold | Result | Verdict |
|---|---|---|---|---|
| 1 | CPython-WASI boots under wasmtime-py | runs a script, captures stdout | PASS — `python spikes/code_exec/s01_boot.py`: module compile 0.66s, run (boot+exec) 0.080s, exit=0, stdout=`guest-ok 3.14.6 (tags/v3.14.6-dirty:c63aec6, Jun 10 2026, ...) [Clang 18.1.2-wasi-sdk ...]`, `guest_stderr.log` empty | ✅ |
| 2 | Interactive blocking stdio round-trip | works; p50 RTT < 5 ms | PASS — **transport = FIFO in-process**. `timeout 90 python spikes/code_exec/s02_bridge.py` → EXIT=0: `[s02] guest ready`, 200 echo round-trips `p50=0.34ms p95=0.56ms`, `[s02] PASS`; `guest_stderr.log` empty | ✅ |
| 3 | GIL released during guest execution | host thread ≥ 50% solo rate | PASS — `timeout 60 python spikes/code_exec/s03_gil.py`, 3 runs (24-core host): solo/contended/ratio = 22413616/22387935/1.00, 21645636/21454599/0.99, 22644651/22073321/0.97. Ratio consistently ~0.97–1.00 (well above the 0.5 gate) → wasmtime-py releases the GIL during guest execution; in-process design stays viable, no fallback to the subprocess runner needed | ✅ |
| 4 | Epoch kill + memory cap | trap ≤ 500 ms after deadline; cap enforced | PASS — s04: `timeout 90 python spikes/code_exec/s04_epoch.py` → EXIT=0, epoch interruption raises `wasmtime.Trap` (not a distinct subclass) with `trap_code=TrapCode.INTERRUPT`; trapped 2.00s after start (overshoot ~1ms, repeatable across runs), well under the 500ms gate. s05: `timeout 90 python spikes/code_exec/s05_memory.py` → EXIT=0, `store.set_limits(memory_size=256*1024*1024)` stops the 500MB `bytearray` allocation via the **in-guest MemoryError path** (guest exit code=1, `guest_stderr.log` shows `MemoryError` raised by the guest's own allocator/traceback machinery — no host-side `Trap` occurs on this build), `s05_out.txt` is empty (`"CAP FAILED"` marker absent) confirming the allocation never completed | ✅ |
| 5 | Determinism stubs | fixed clock/random/hashseed; 2 runs identical | PASS — `timeout 60 python spikes/code_exec/s06_determinism.py` → EXIT=0. `wasi_snapshot_preview1.clock_time_get`/`random_get` shadowed via `linker.allow_shadowing = True` (set **before** `define_wasi()`) + `linker.define_func(...)` registered **after** `define_wasi()` — shadow-after-define is the order that takes effect (matches the brief's prediction, no swap needed). `PYTHONHASHSEED=0` forced via env. Both runs of `import time, random; print(time.time(), random.random(), hash('spike'))` printed byte-identical `1750000000.0 0.10486408342261755 -579511815`; `guest_stderr.log` empty both runs | ✅ |
| 6 | Warm-pool console latency | ≤ 300 ms end-to-end | PASS — `timeout 90 python spikes/code_exec/s07_pool.py` → EXIT=0. Module deserialize from `python.cwasm` disk cache: 35-37ms vs cold compile ~0.87-0.98s (~25x faster, two runs). Over 10 boot/handoff cycles on the FIFO in-process transport (reusing s02's mechanics + `guest_harness.py`'s ping/echo/quit ops): boot-to-ready p50=149-157ms max=154-171ms (off-request-path pool-refill cost, fine at hundreds of ms); **warm handoff p50=0.49-0.56ms max=0.79-0.90ms** — ~600x under the 300ms gate. `guest_stderr.log` empty both runs | ✅ |
| 7 | 50k-element batched benchmark | ≤ 30 s total | PASS — `timeout 120 python spikes/code_exec/s08_bench50k.py` → EXIT=0 (two runs). Batched (BATCH=500, the spec's default): **0.2s** for all 50k elements (100 round-trips of 500 elements each) — ~150x under the 30s gate, no need to bump BATCH. Unbatched sample (500 single-element round-trips, extrapolated to 50k): **17s** — ~85x slower than batched, but still nominally under 30s on its own; batching remains load-bearing because it removes per-call FIFO/JSON-parse/dispatch overhead that would otherwise eat most of the 30s budget and leave no room for actual `value()` computation cost at realistic column complexity. `guest_stderr.log` empty both runs | ✅ |
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

### Criterion 4 — epoch kill + memory cap error mapping (Task 6)

- **Epoch interruption exception class:** on wasmtime-py 46.0.1, tripping the epoch deadline (`store.set_epoch_deadline(1)` + a ticker thread calling `engine.increment_epoch()` after the deadline) raises **`wasmtime.Trap` itself** — not a distinct subclass, and not `ExitTrap` (which is a sibling class, `ExitTrap(WasmtimeError)`, unrelated to `Trap` in the MRO — confirmed via `Trap.__mro__` = `(Trap, Exception, BaseException, Managed, Generic, object)` vs `ExitTrap.__mro__` = `(ExitTrap, WasmtimeError, Exception, BaseException, Managed, Generic, object)`). The trap instance carries `.trap_code == wasmtime.TrapCode.INTERRUPT`, which is the reliable way to distinguish an epoch-kill trap from any other kind of guest trap (e.g. `UNREACHABLE`, `MEMORY_OUT_OF_BOUNDS`) — the shipped runner's §10 error mapping should branch on `trap_code`, not just on `isinstance(e, Trap)`. `host.py`'s `run_python` only catches `ExitTrap`, so the epoch `Trap` propagates out to the caller unchanged — no `host.py` change was needed.
- **Measured kill latency:** deadline set to trip 2.0s after start; guest (`while True: pass`) trapped at 2.00s elapsed, overshoot ~1ms, repeatable across 3 runs (1ms, 1ms, 1ms) — far under the 500ms gate.
- **Memory cap enforcement path:** `store.set_limits(memory_size=256*1024*1024)` against a guest allocating `bytearray(500 * 1024 * 1024)` does **not** raise a host-side `Trap` on this build — instead the guest's own allocator fails, CPython raises an in-guest `MemoryError`, prints a traceback to `guest_stderr.log`, and exits with code 1. `s05_out.txt` stays empty (the `"CAP FAILED"` print after the allocation line never runs), confirming the 500MB allocation never completed. This is the **MemoryError path**, not the Trap path — the shipped runner's error mapping for "guest exceeded its memory budget" should expect a nonzero WASI exit code + stderr traceback, not necessarily a host-side exception.

### Criterion 5 — determinism shims (Task 7)

- **Shim API on wasmtime-py 46.0.1 matched the brief verbatim** — no adaptation needed, confirmed via `help(wasmtime.Linker)`, `help(wasmtime.Caller)`, `help(wasmtime.Memory)`, `help(wasmtime.FuncType)`, `help(wasmtime.ValType)`:
  - `Linker.allow_shadowing` is a write-only property (`Configures whether definitions are allowed to shadow one another within this linker`); setting `linker.allow_shadowing = True` before `define_wasi()` and registering the two shim funcs via `linker.define_func(module, name, ty, func, access_caller=True)` **after** `define_wasi()` is the order that takes effect — i.e. shadow-after-define, last-registration-wins. No order swap was needed; the brief's predicted order worked first try.
  - `Linker.define_func(self, module: str, name: str, ty: FuncType, func: Callable, access_caller: bool = False) -> None` — exact signature match.
  - With `access_caller=True` the host callback's first positional arg is a `wasmtime.Caller`; `caller.get("memory")` returns the guest's exported `Memory` (`Caller.get(name) -> Optional[AsExtern]`, "may return None if the export isn't found, if it's not a memory (for now), or if the caller has gone away").
  - `Memory.write(self, store: Storelike, value: bytearray|bytes, start: int|None = None) -> int` — `Storelike = Store | Caller | StoreContext` (`wasmtime._store`), so passing the `Caller` itself as the store-like arg (`mem.write(caller, bytes, offset)`, per the brief) works with no conversion.
  - `FuncType(params: List[ValType], results: List[ValType])` and `ValType.i32()`/`ValType.i64()` class methods — exact match.
- **Run output (verbatim, two separate `run_python` invocations, fresh engine/module/store each time):**
  ```
  [s06] run 1: 1750000000.0 0.10486408342261755 -579511815
  [s06] run 2: 1750000000.0 0.10486408342261755 -579511815
  [s06] PASS
  ```
  `s06_out1.txt` and `s06_out2.txt` are byte-identical; `guest_stderr.log` empty after both runs.
- **What's deterministic:** all three probed sources — wall clock (`time.time()` fixed to the shimmed `FIXED_NANOS` epoch = `1750000000.0`), PRNG (`random.random()` deterministic because `random_get` always returns the same `0x42`-filled buffer, seeding CPython's Mersenne Twister identically both runs), and string hashing (`hash('spike')` deterministic via `PYTHONHASHSEED=0`, unrelated to the WASI shims). Monotonic clock (`clock_id != 0`) intentionally stays real (`time.perf_counter_ns()`) per the brief — not exercised by this probe's `PROG`, and the spec only promises a fixed *wall* clock.
- **Verdict: FULL PASS, not partial.** No fallback to lint/import-hook blocking was needed — `define_func` shadowing of WASI imports works cleanly on wasmtime-py 46.0.1. This is the recipe M1's runner should copy: `allow_shadowing=True` → `define_wasi()` → `define_func(...)` shims → `PYTHONHASHSEED=0` in env.

### Criterion 6 — warm-pool latency probe (Task 8)

- **`Module.serialize`/`Module.deserialize` matched the brief verbatim** on wasmtime-py 46.0.1 — confirmed via `inspect.signature`: `Module.serialize(self) -> bytearray` (instance method) and `Module.deserialize(engine: Engine, encoded: bytes | bytearray) -> Module` (classmethod, called as `Module.deserialize(engine, data)`). No adaptation needed; `Path.write_bytes` accepts the `bytearray` `serialize()` returns without conversion. `dir(wasmtime)` has no separate `__version__` attribute — version pin (46.0.1) is tracked via `pixi.toml`/lockfile, not introspectable at runtime.
- **Three latency components, two runs for stability:**
  - Module deserialize from disk cache (`python.cwasm`): **35-37ms**, vs cold `Module.from_file` compile **~0.87-0.98s** — roughly 25x faster, confirming the module cache avoids recompiling on every pool refill.
  - Boot-to-ready (instantiate + interpreter boot to the guest's `ready` handshake), 10 cycles: **p50=149-157ms, max=154-171ms**. This is off the request path (pool-refill cost) — hundreds of ms here is expected and fine per the spec.
  - Warm handoff (first `ping`→`pong` on an already-`ready` idle instance), 10 cycles: **p50=0.49-0.56ms, max=0.79-0.90ms** — ~600x under the 300ms gate. The FIFO in-process transport's near-zero RTT (confirmed at p50=0.34ms in Task 4) dominates; interpreter idle-to-serving latency adds negligible overhead once booted.
- **Verdict: clean PASS, no weakening of the gate.** `assert statistics.median(handoffs) < 300` stands as written in the brief. Console-latency budget (handoff + snippet execution time) has enormous headroom under 300ms; the real cost to manage for M1 is the boot-to-ready pool-refill time, which is why the architecture keeps a warm pool off the request path rather than booting per-request.

### Criterion 7 — 50k-element batched benchmark (Task 9)

- **Guest harness extended:** `guest_harness.py` gained a `batch` op (`values = [len(el["name"]) for el in req["elements"]]`, respond `{"id", "values"}`), added as another `elif` branch before the final `else`. The existing `ping`/`echo`/`quit` ops are unchanged — s02/s07 (which depend on them) are unaffected.
- **Batched (the shipping design, BATCH=500 — the spec's default page size, unchanged):** 100 round-trips of 500 elements each over the FIFO in-process transport, computing `len(name)` per element (simulating a trivial `ScriptColumn`). **0.2s total for all 50k elements**, reproducible across two separate runs — comfortably (~150x) under the 30s evaluation-budget gate. No need to retry at BATCH=2000; **no amendment to spec §9's page-size default is needed.**
- **Unbatched sample:** 500 single-element `batch` round-trips, extrapolated linearly to 50k elements: **~17s**. ~85x slower than the batched run for the same total element count, even though 17s alone would still nominally clear the 30s gate in isolation — the point of this sample is to document per-call overhead (FIFO round-trip + JSON encode/decode + dispatch), not to pass/fail a gate. At any nontrivial per-element compute cost (a real `value()` body, not just `len()`), or at higher element counts, the unbatched per-call overhead would blow through the budget; batching amortizes that fixed cost across up to 500 elements per round-trip and is therefore load-bearing for the design even though this particular trivial workload doesn't force the issue on its own.
- **Verdict: clean PASS, gate untouched.** `assert batched <= 30` stands as written, genuinely measured, not weakened. `guest_stderr.log` empty on both runs.

## Verdict

(go / no-go / go-with-amendments — filled in Task 10)
