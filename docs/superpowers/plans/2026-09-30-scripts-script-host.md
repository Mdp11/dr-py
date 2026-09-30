# Scripts: Script Host (Plan 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scripts run in a pool of Pyodide workers, one fresh worker per batch, booted from a memory snapshot, deterministic, under the server's limits with a soft and a hard stop, on the same pool code in Node and in Chromium, with output byte-identical to the Python oracle; and 10,000 script cells are measured again on the pool.

**Architecture:**
1. The run harness leaves the server's guest bootstrap for one Python source, `HARNESS_SOURCE`, which the server guest, the trusted runner and the engine's guest all run; a `script_parity` golden family records the oracle's output bytes.
2. `engine/src/script/pool.ts` is the one pool, written against a `WorkerPort`; `engine/src/script/worker-main.ts` is the one worker body. Node hands the pool `worker_threads`; the sandbox hands it Web Workers. The reply buffer and the wire move from `sandbox/src/` into `engine/src/script/`.
3. Each worker runs one batch and is terminated. Workers boot from a snapshot the pool makes once; determinism is pinned in the worker before Pyodide loads.
4. The pool times each call from the host side: interrupt at the deadline, terminate 1.5 s later.
5. The service runs batches concurrently, one bridge per run pinned to its epoch, and gains the `script` entry, cancel and prewarm.

**Tech Stack:** TypeScript (engine, sandbox, Node 22 `worker_threads`), Pyodide 314.0.7 (CPython 3.14), Python 3.14 (core, golden scenarios), vitest, Playwright (Chromium runs), Vite 8.

**Spec:** `docs/superpowers/specs/2026-09-30-scripts-script-host-design.md` (decisions `S1`…`S18`, the interfaces), refining `docs/superpowers/specs/2026-09-30-scripts-in-the-browser-design.md`; plan 1's decisions `P1`…`P15` in `docs/superpowers/specs/2026-09-30-scripts-bridge-foundation-design.md` still hold where S does not replace them.

**Read these first:** `CLAUDE.md`; the three specs; `architecture/contracts.md` CT-6; `architecture/conventions.md` (RC-4, RC-6, RC-8, RC-10); `src/data_rover/api/script_runner.py:180-500` and `:900-1400`; `src/data_rover/core/script/facade_src.py:23-120,699-840`; `tests/script/trusted_runner.py`; `engine/src/script/`; `engine/node/script-host.ts`; `sandbox/src/script-*.ts`, `sandbox/src/bridge-buffer.ts`; `engine/README.md` and `sandbox/README.md` (the scripts parts); `BACKLOG-ENGINE.md` K-100 to K-105.

**What kind of plan this is.** Steps state behaviour, signatures and tests precisely; they do not paste finished code, because the oracle (the harness, the trusted runner, the golden fixtures) is the specification. Expected results are reasoned from the code at `17888fa2` and from measurements in Node (Pyodide boot, snapshot, interrupt), not observed in Chromium. Where a step says "confirm", the fact is inferred and the implementer checks it before relying on it.

## What planning found

Checked against the code at `17888fa2`, and by scratch runs of Pyodide 314.0.7 in Node 22.

1. Three harnesses: `_GUEST_BOOTSTRAP_SOURCE` (`script_runner.py:249-497`), its hand copy in `trusted_runner.py` (`:54-120,153-195,226-320`), and `GUEST_BOOTSTRAP` (`engine/src/script/guest.ts:22-56`), which has no stdout cap, traceback, `repr`, `script` entry or arity rule and answers errors as `Type: msg`.
2. The server's run mode handles the `script` entry and every console run itself (`:350-412`) and does not use `_dr_call_entry`; the embedded mode (`:415-484`) execs facade and module once, carries module-level stdout to the first call only, and answers `{"call_result": {payload, error, reads, stdout}}`. `MemoryError` is re-raised on purpose (`:384-391`). The console arity rule (`_wants_inputs`, `co_argcount >= 2`) and the embedded rule (`inputs is not None`, `facade_src.py:699-768`) differ, and both are kept.
3. Stdout and `repr` caps count characters; the cut write gets `"..."` and sets `truncated` (`:275-304`, `:401-407`). No test covers `repr` truncation.
4. Server determinism: realtime clock pinned to `1.75e18` ns, `random_get` filled with `0x42`, `PYTHONHASHSEED=0` (`:184,565-574,807`), covered by `test_wasm_determinism` (`tests/api/test_snippets_wasm.py:275`). A call timeout kills the session; later calls fail fast with the stored error (`:1329-1335`). Limits live in `RunLimits` (`core/script/runner.py:104-111`), the batch budget in `Settings.snippet_eval_budget_s` = 30 (`api/settings.py:206`).
5. The service serializes runs (`engine/src/service/service.ts:819-862`: one `runs` chain, one `runEpoch` slot); `trips` is per host; `{cancel}` only drops the answer (`:668-671`); `SCRIPT_ENTRIES` is `['value','step','transform']` (`:286`). The shared dispatcher is read-only and safe for concurrent reads. The bridge reads the live `wc.model`, staged edits included.
6. The browser host keeps one worker (`sandbox/src/script-host.ts:57-62`); the Node host runs in-process with a boot memo that keeps a rejection (`engine/node/script-host.ts:48-52`, K-101). `sandbox/test/script-host.test.ts` drives the host over `worker_threads` stubs (`test/fixtures/script-stub.ts`). `bridge-buffer.ts` and `script-wire.ts` use only `SharedArrayBuffer`, `Atomics`, `TextEncoder`/`TextDecoder` and typed arrays, all shared by browsers and Node 22.
7. Pyodide 314.0.7 in Node: cold `loadPyodide` about 1.75 s; `_makeSnapshot: true` boot 2.5 s, `makeMemorySnapshot()` 30 ms and 30 MB; `_loadSnapshot` boot about 150 ms (`pyodide.d.ts:1913,2119-2124`, private). A second `loadPyodide` in one thread is an independent interpreter. `setInterruptBuffer` (`:1893`) interrupts `while True`, `re` and big-int work; it does not wake `time.sleep` or stop `sum(range(10**10))`; `except BaseException` and `signal.signal(SIGINT, SIG_IGN)` defeat it; a flag left set fires in the next code. `env` reaches `os.environ`; `PYTHONHASHSEED: '0'` makes `hash` stable. `time.time` reads `Date.now()`; `os.urandom` and `random`'s initial seed read `crypto.getRandomValues`; a snapshot freezes `random`'s state. No option takes a precompiled `WebAssembly.Module`.
8. The bench page (`frontend/bench/main.ts`) drives the built sandbox from the app origin through `connectFrame`; `frontend/bench/run.ts` runs it in Playwright Chromium; its data files are served by `frontend/bench/vite.config.ts`. It runs the ten scripts sequentially (`main.ts:443-490`).
9. **Refinement of S6.** Only the host knows it raised the interrupt for call `i`, and the worker's report is untrusted. So the harness answers any `BaseException` but `MemoryError` as that call's `runtime` error, `KeyboardInterrupt` included; the pool replaces the result of every call it soft- or hard-stopped with the `timeout` error. The spec's outcome (an interrupted call is `timeout`, the batch continues) is unchanged.

## Global Constraints

- Pyodide stays pinned to `314.0.7` exactly in `engine/` and `sandbox/`.
- `engine/src/` has no DOM and no Node built-in (RC-4): `pool.ts` and `worker-main.ts` take everything host-specific (spawning, `loadPyodide`, the global scope to pin) as parameters. Imports use `.ts` specifiers and `import type` where only types are used; no enums, no parameter properties.
- The Python core is the oracle: on a mismatch fix the engine, never the fixture. `core/script` behaviour changes only by S6 (per-call `BaseException`); everything else in the harness hoist is a move.
- Limits, verbatim from the spec: 10 s wall per call; 30 s per batch, a call's deadline `min(10 s, what remains of the batch's 30 s)`; stdout 256 KiB and `repr` 64 KiB, in characters; 1,000 ops of at most 1 MiB; page 500; a hard stop 1.5 s after the soft stop.
- Pool cap `max(1, min(4, hardwareConcurrency − 2))`; one spare when idle; spares beyond one terminated after 30 s without a queue.
- Determinism, both hosts: `Date.now` pinned to `1750000000000`; `crypto.getRandomValues` fills `0x42`; `PYTHONHASHSEED=0`; `random.seed()` after every snapshot restore.
- One worker runs one batch, then is terminated. A worker message is never trusted beyond its own batch. The snapshot reaches each worker as its own copy, never shared memory.
- Sandbox CSP string unchanged: `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'; frame-ancestors <app origin>`. No `'unsafe-eval'`.
- Request and reply cross as text and are never re-serialized through `JSON.parse` / `JSON.stringify` (AD-26). Result texts are Python's default `json.dumps` style.
- Tests run the real engine and real Pyodide, no mocks, no fake timers; every pool, worker and link is disposed.
- Comments: concise, present tense, no spec, plan or phase references (RC-6). READMEs change with the behaviour, in the same commit (RC-10).
- Commit messages: imperative sentence, no prefix, ending with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JX9BcKbyEjprio7YPQi4n3
  ```

## Review Focus

1. **A call that blocks in `time.sleep(60)`** (the interrupt cannot wake it). Expected: its worker is terminated 11.5 s after the call starts; that call and the rest of its batch answer `timeout`; the next batch runs on a fresh worker. Pinned in Task 6.
2. **The replica is replaced while two runs are in flight on two workers.** Expected: both runs' trips answer `BridgeError: replica is not ready`, both calls answer `409`, no worker stays alive after its batch, and the next call on the new replica succeeds. Pinned in Task 7.
3. **Pyodide cannot boot at all** (a bad `indexURL`, a missing asset). Expected: the run answers the boot error; the pool does not respawn spares in a loop; the next run tries one boot again. Pinned in Task 4.
4. **The snapshot cannot be made or restored.** Expected: the pool boots cold, results are unchanged, and each run reports `boot: 'cold'`. Pinned in Task 5.
5. **A cancel for a run still queued behind the cap.** Expected: the run leaves the queue, answers as cancelled, and no worker is spawned or consumed for it. Pinned in Task 6.

## File Structure

| File | Responsibility |
|---|---|
| `src/data_rover/core/script/harness_src.py` (create) | `HARNESS_SOURCE`: the run harness |
| `src/data_rover/api/script_runner.py` (modify) | guest bootstrap keeps framing and limits, runs `HARNESS_SOURCE` |
| `tests/script/trusted_runner.py` (modify) | runs `HARNESS_SOURCE` in-process |
| `tests/golden/scenarios/script_harness.py` (create) | renders `harness.generated.ts` |
| `tests/golden/scenarios/script_parity.py` (create) | the parity corpus and its oracle bytes |
| `engine/src/script/harness.generated.ts` (generated) | `HARNESS_SOURCE` as a string |
| `engine/src/script/host.ts` (modify) | host types, the boot contract |
| `engine/src/script/guest.ts` (modify) | Pyodide-side runner over `HARNESS_SOURCE` |
| `engine/src/script/bridge-buffer.ts`, `wire.ts` (moved from `sandbox/src/`) | reply buffer; batch wire |
| `engine/src/script/worker-main.ts` (create) | the one worker body: pins, boot, snapshot, one batch |
| `engine/src/script/pool.ts` (create) | the one pool |
| `engine/node/script-host.ts`, `engine/node/script-worker.ts` (modify, create) | `worker_threads` port and entry |
| `engine/src/service/service.ts`, `types.ts` (modify) | concurrent runs, per-run bridge, `script` entry, cancel, prewarm |
| `sandbox/src/script-host.ts`, `script-worker.ts` (modify) | Web Worker port and entry |
| `frontend/bench/main.ts`, `run.ts`, `vite.config.ts`, `frontend/bench/scripts.ts` (modify, create) | Chromium parity and runaway run; the pool bench row |

## Dependency order

Task 1 is `independent`. Then 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Tasks 4 to 6 edit `pool.ts` in turn; Task 7 consumes the pool's final interface, and Task 8 both.

Every untagged task is reviewed by `task-reviewer`. Tasks 4, 6 and 8 carry `critical-reviewer`.

---

### Task 1: One harness · `critical-implementer`

*Reason: it changes the server's production snippet runner (a move plus S6), and the split between harness, framing and facade is a judgment the spec leaves open.*

**Depends on:** independent.

**Files:**
- Create: `src/data_rover/core/script/harness_src.py`, `tests/golden/scenarios/script_harness.py`, `engine/src/script/harness.generated.ts` (generated), `tests/script/test_harness.py`
- Modify: `src/data_rover/api/script_runner.py`, `tests/script/trusted_runner.py`, `tests/golden/driver.py` (`GENERATED`), `src/data_rover/core/script/README.md`

**Interfaces:**
- Produces: `HARNESS_SOURCE: str` in `harness_src.py`, a module exec'd into a namespace that already holds `_transport` and `_read_memo_max`. It defines:
  - `_dr_run(spec: dict) -> dict`: one console run. `spec` holds what the server's run-mode start message holds today (`code`, `facade`, `entry`, `element_ids`, `inputs`, `limits` with `stdout_bytes` and `result_repr_bytes`); it answers `{"stdout", "result_repr", "truncated", "error"}` exactly as the `fin` message's fields (`script_runner.py:409-412`), `error` absent when none.
  - `_dr_open(facade: str, code: str, limits: dict) -> dict`: execs facade then module into a fresh namespace; answers `{"namespace", "carry", "error"}`, `carry` the module-level stdout, `error` the boot error dict or `None`.
  - `_dr_call(session: dict, call: dict, limits: dict) -> dict`: one embedded call through `_dr_call_entry`, answering `{"payload", "error", "reads", "stdout"}` as `call_result` does today; `carry` goes to the first call only.
  - Confirm these shapes against `script_runner.py:350-484` and keep them byte-for-byte; rename only if the existing code already names them.
- `FACADE_SOURCE` is unchanged. `engine/src/script/harness.generated.ts` exports `HARNESS_SOURCE: string`.

- [ ] **Step 1: Failing tests for S6.** `tests/script/test_harness.py`, over the trusted runner (session and run paths): a call raising `KeyboardInterrupt`, `SystemExit(3)` and a custom `class E(BaseException)` each answers a `runtime` error for that call (message `KeyboardInterrupt: `, `SystemExit: 3`, `E: …` in the existing `"TypeName: msg"` form, filtered traceback) and the next call of the session succeeds; `MemoryError` still escapes the harness. Add a `repr`-truncation case: a result whose `repr` exceeds `result_repr_bytes` answers `result_repr` cut to the cap plus `"..."` and `truncated: True`. Run `pixi run -e core-dev pytest tests/script/test_harness.py -v`; expected: the S6 cases fail (the trusted runner catches `Exception`), the truncation case passes or fails as the hand copy does.
- [ ] **Step 2: Hoist.** Move `_CappedStdout`, the traceback filter, `_wants_inputs`, `_bind_inputs`, the run body and the session boot and call out of `_GUEST_BOOTSTRAP_SOURCE` into `HARNESS_SOURCE` as the three functions above. The bootstrap keeps its stdin/stdout framing, `_transport` over `_real_stdout`, the handshake and the `MemoryError` path, and execs `HARNESS_SOURCE` (sent in the start message beside `FACADE_SOURCE`, or preopened with the bootstrap: pick the one that leaves the host's framing unchanged). Per-call catch: `except MemoryError: raise`, then `except BaseException` → the call's `runtime` error.
- [ ] **Step 3: Trusted runner.** Replace the hand copies with an exec of `HARNESS_SOURCE`; keep its in-process decode. It keeps `redirect_stdout` only if the harness no longer assigns `sys.stdout` itself; otherwise the harness's own capture is the one.
- [ ] **Step 4: Generated source.** `script_harness.render()` returns a TypeScript module exporting `HARNESS_SOURCE` as a JSON-escaped string literal under the header the other generated files use (copy `tests/golden/scenarios/script_facade.py`). Register it in `GENERATED`; `pixi run golden-fixtures`.
- [ ] **Step 5: Green.** `pixi run core-test`; `pixi run -e core-dev pytest tests/api/test_snippets_wasm.py tests/script tests/golden -v` (the WASM guest is fetched by the pixi hook; if it is absent say so, do not skip silently). Expected: all green, `test_wasm_determinism` included, and the new S6 cases pass on the server guest too: add one of them (`KeyboardInterrupt` per call) to `test_snippets_wasm.py`'s session tests.
- [ ] **Step 6:** `pixi run dr-tidy`. `src/data_rover/core/script/README.md`: the harness, who runs it, the per-call rule; fix its stale line on embedded stdout. **Commit** `Run one script harness on the server, the trusted runner and the engine`.

---

### Task 2: The `script_parity` golden family · `implementer`

**Depends on:** Task 1.

**Files:**
- Create: `tests/golden/scenarios/script_parity.py`, `engine/fixtures/golden/script_parity.json` (generated)
- Modify: `tests/golden/driver.py` (register the scenario), `tests/script/trusted_runner.py` (determinism pins, opt-in)

**Interfaces:**
- Consumes: `HARNESS_SOURCE`, the trusted runner (Task 1).
- Produces: `script_parity.json`: `{"model": <the model as the script_bridge fixture holds one>, "cases": [{"name", "code", "entry", "calls": [{"element_ids", "inputs_text"?, "doc_text"?}], "results": [<text>…], "ops"?: <text>}]}`. Each `results[i]` is the Python default-style `json.dumps` of the call's `call_result` dict (embedded entries) or of `_dr_run`'s dict (`script`); `ops` is the `json.dumps` of the dispatcher's ops for `script` cases.

- [ ] **Step 1: The scenario runs in a child process** with `PYTHONHASHSEED=0` and `TZ=UTC` (set ordering and `datetime` depend on both), launched by the scenario itself with `sys.executable`, reading its output as text. The model is built with fixed ids as `script_bridge.py` builds one (`restore_relationship`, never `connect`); reuse its builder.
- [ ] **Step 2: Determinism pins in the trusted runner**, opt-in by a keyword the scenario passes: before user code, `time.time` returns `1750000000.0` (and `time.time_ns` `1750000000000000000`); `os.urandom` returns `b"\x42" * n`; `random.seed(int.from_bytes(b"\x42" * 2496, "little"))`, which gives the key CPython's urandom path builds from 624 words of `0x42424242` (confirm by comparing `random.random()` with the server guest's value in `test_wasm_determinism`, or record in the hand-back that it could not be compared).
- [ ] **Step 3: Cases**, at least one each, named:
  - `value` scalar, list, element, elements, `None`; `value` with inputs by the embedded rule; `step` returning `{nodes}`; `transform` returning JSON;
  - `script`: `print` then `result = …`; a `value` console run with arity-bound inputs (two parameters) and without (one); an op-proposing script (`create_element`, `update_element`) with `ops`;
  - errors: syntax error, module-level raise, missing entry, `ValueError` per call then a good call, `NotFoundError`, `ReadOnlyError` on an embedded write, a traceback through a helper function (line numbers are the author's), `KeyboardInterrupt` and `SystemExit` per call (S6);
  - caps: stdout over 256 KiB, `repr` over 64 KiB, 1,001 ops, one op over 1 MiB;
  - fidelity: `1.0`, `1`, `2**60`, astral text through a property;
  - determinism: `time.time()`, `datetime.datetime.now().isoformat()`, `random.random()`, `hash("abc")`, `repr({"b", "a", "c"})`, `os.urandom(4).hex()`.
- [ ] **Step 4:** `pixi run golden-fixtures`; `pixi run -e core-dev pytest tests/golden -q` green; confirm only the new fixture changed. **Commit** `Record the script harness's output as a golden family`.

---

### Task 3: The guest over the shared harness · `critical-implementer`

*Reason: the Pyodide call boundary changes shape (sessions, per-call stdout, the `script` entry), and both hosts inherit it.*

**Depends on:** Task 2.

**Files:**
- Modify: `engine/src/script/guest.ts`, `engine/src/script/host.ts`, `engine/src/index.ts`, `engine/test/script/guest.test.ts`
- Create: `engine/test/script/parity.ts` (the corpus reader and comparer, shared by later tests)

**Interfaces:**
- Consumes: `HARNESS_SOURCE`, `FACADE_SOURCE`, `script_parity.json`.
- Produces:
  - `ScriptEntry = 'value' | 'step' | 'transform' | 'script'`.
  - `RawScriptResult = { readonly text: string }`: the harness's result dict as default-style JSON text, one per call (for `script`, the `_dr_run` dict). Host-made errors use the same shape (Tasks 4, 6).
  - `Guest = { run(batch: ScriptBatch, roots: readonly string[], hooks?: GuestHooks): RawScriptResult[] }`, `GuestHooks = { callStart?(i: number): void; callEnd?(i: number): void }`.
  - `createGuest(py: Interpreter, transport: (requestText: string) => string, limits?: HarnessLimits)`; `HarnessLimits = { stdoutChars: number; reprChars: number; readMemoMax: number }`, defaults `262144`, `65536`, `4096`.
  - `parity.ts`: `loadParity(): ParityCase[]`, `parityModel()`, `expectParity(c: ParityCase, results: readonly RawScriptResult[], ops?: string)`.

- [ ] **Step 1: Failing tests.** `guest.test.ts` keeps one in-process Pyodide (`loadPyodide` from the `pyodide` package, as `engine/node/script-host.ts` does today) and runs every `script_parity` case except the determinism group through `createGuest` over a `BridgeDispatcher` on `parityModel()` (`recordOps` true for `script` cases), comparing texts with `expectParity`. Keep the existing cases that are not covered by the corpus (proxy destruction, fresh globals). Add: `callStart(i)`/`callEnd(i)` fire once per call in order. Run `pixi run engine-test -- guest`; expected: fails (the old bootstrap).
- [ ] **Step 2: Bootstrap.** `GUEST_BOOTSTRAP` becomes: exec `HARNESS_SOURCE` once into the guest's module; `_transport` over `_dr_transport_text`; `_dr_batch(code, entry, calls_text, roots_texts)` calls `_dr_run` for `script` (one call) or `_dr_open` then `_dr_call` per call, calling the JS hooks `_dr_call_start(i)`/`_dr_call_end(i)` around each. Results are `json.dumps` of the harness dicts. No `except` in the bootstrap beyond what the harness does; a `MemoryError` escapes to JS as it would on the server.
- [ ] **Step 3: `createGuest`.** Sets the globals, runs the bootstrap once, destroys every proxy it makes. `transform` still sends `'[]'` roots, written once here.
- [ ] **Step 4:** `pixi run engine-test`, `pixi run engine-check`, `pixi run dr-tidy`. The service and the Node host still compile against the new `RawScriptResult` (adjust `service.ts`'s shape check to `typeof one.text === 'string'`, and `frontend/bench/main.ts`'s failure check to parse `text` and look at `error`); `pixi run frontend-check`. **Commit** `Run the shared harness in the engine's guest`.

---

### Task 4: The pool, over `worker_threads` · `critical-implementer` · `critical-reviewer`

*Reason: concurrency, a new worker protocol and the isolation that closes K-105.*
*Critical review: a defect here lets one script falsify another's results or stalls every later run.*

**Depends on:** Task 3.

**Files:**
- Create: `engine/src/script/pool.ts`, `engine/src/script/worker-main.ts`, `engine/node/script-worker.ts`, `engine/test/script/pool.test.ts`, `engine/test/script/fixtures/` (as needed)
- Move: `sandbox/src/bridge-buffer.ts` → `engine/src/script/bridge-buffer.ts`, `sandbox/src/script-wire.ts` → `engine/src/script/wire.ts`, their tests `sandbox/test/bridge-buffer.test.ts`, `script-wire.test.ts` (and `fixtures/buffer-reader.ts`) → `engine/test/script/`
- Modify: `engine/src/script/host.ts`, `engine/node/script-host.ts`, `engine/src/index.ts`, `engine/tsconfig*.json`, `sandbox/src/*` imports (the sandbox host keeps working over the moved files until Task 8), `engine/README.md`

**Interfaces:**
- Consumes: `createGuest`, `GuestHooks`, `RawScriptResult` (Task 3).
- Produces (the spec's Interfaces block, with):
  - `ScriptRun = { results; trips; ms; bootMs: number; boot: 'snapshot' | 'cold' }`.
  - `ScriptHost = { boot(): Promise<{ ms: number }>; prewarm(): void; run(batch: ScriptBatch, bridge: Bridge, signal?: AbortSignal): Promise<ScriptRun>; dispose(): void }`, the boot contract in its doc comment; `ScriptHostFactory = () => ScriptHost`.
  - `WorkerPort`, `WorkerSpawner`, `PoolOptions = { cap: number; spareIdleMs?: number; limits?: Partial<RunLimits>; now(): number }`, `createPool(spawn, options): ScriptHost`, `RunLimits = { callMs: number; batchMs: number; graceMs: number } & HarnessLimits`.
  - `runWorker(scope: WorkerScope, loadPyodide: (options: object) => Promise<unknown>)` in `worker-main.ts`; `WorkerScope = { post(message: unknown): void; onMessage(handler: (message: unknown) => void): void; globals: typeof globalThis }`.
  - Messages, pool → worker: `init {reply, interrupt}`, `run {batch: WireBatch, roots}`; worker → pool: `ready {ms, boot}`, `failed {message}`, `bridge {text}`, `more`, `call-start {i}`, `call-end {i}`, `done {results, trips, ms}`, `csp-violation {directive, blocked}`. There is no run id: a worker has one batch.
  - `nodeScriptHost: ScriptHostFactory` spawns `engine/node/script-worker.ts` as a `worker_threads` `Worker`.

- [ ] **Step 1: Move** the buffer and wire with their tests; `pixi run engine-test`, `pixi run sandbox-test` green before anything else changes.
- [ ] **Step 2: Failing tests** (`pool.test.ts`, real Pyodide over real `worker_threads`, cold boots in this task, one pool per `describe` with `dispose()` in `afterAll`, test timeout 60 s):
  - Isolation (K-105): batch 1 runs `import __main__, json; __main__._dr_batch = None; json.loads = lambda s: {"payload": "FORGED"}` and replaces `js.postMessage` (or the Node scope's equivalent reachable through `js`); batch 2, `def transform(doc): return 42`, answers the honest parity text. Two batches never share a worker (count spawns through a wrapping spawner).
  - Concurrency: four `run`s at once on `cap: 2` → at most two workers alive at a time, all four results right, each run's `trips` its own.
  - Boot contract (K-101): a spawner whose first worker fails boot → the first `run` rejects with the boot error, the second `run` boots again and succeeds; `boot()` on a live pool answers at once; `dispose()` during a run and during a boot rejects both, and no worker stays alive (count terminations).
  - Forged messages: a worker posting `done` with the wrong count, a `done` before `run`, an unknown type, or a second `done` → that batch fails (`runtime` error per call, the pool's text shape), the worker is terminated, the next run is right.
  - Review Focus 3: a spawner whose workers always fail boot → each `run` rejects; no spawn happens between runs (no respawn loop).
  - Spares: after a run, one spare is alive; `prewarm()` on an empty pool starts one boot; with `spareIdleMs: 50`, spares above one are gone after the queue empties.
  - The parity corpus (non-determinism groups) through `nodeScriptHost`, results compared with `expectParity`.
  Run `pixi run engine-test -- pool`; expected: fails on the missing modules.
- [ ] **Step 3: `worker-main.ts`.** On `init`: the transport of the old `sandbox/src/script-worker.ts` (arm, post `bridge`, `readReply`), `loadPyodide`, `createGuest` with the hooks posting `call-start`/`call-end`, post `ready`. On `run`: count trips, time `guest.run` with the scope's `performance.now`, post `done`; a second `run` is refused `failed`. Everything the worker posts is built from its own locals captured at start (`const post = scope.post`), which is hygiene, not the boundary: the boundary is one batch per worker.
- [ ] **Step 4: `pool.ts`.** A FIFO of waiting runs; spawn up to `cap`; each run takes a ready spare or waits for one; on `done`, validate shape (`results.length === calls.length`, every text a string) and terminate the worker; on `failed`, an error event or a bad message, terminate and fail that run's calls. `run` computes each call's roots through `bridge.roots` (including input element ids from `inputs.e.ids`, as `trusted_runner.py` does: K-103(6)); `bridge.dispatch` answers `bridge` messages synchronously in the handler, per worker, over that run's bridge. Spares: keep one when idle, spawn toward `cap` while runs wait, drop extras after `spareIdleMs` (default 30,000) with no waiting run; never spawn after a boot failure until a run asks. `boot()` resolves when one spare is ready (never memoized past a rejection). `dispose()` terminates everything and rejects every pending run and boot.
- [ ] **Step 5: Node port.** `engine/node/script-host.ts` becomes the `worker_threads` spawner and `nodeScriptHost`; `nodeScriptHost`'s cap is the spec's formula over `os.availableParallelism()`. `engine/node/script-worker.ts` calls `runWorker` with `parentPort` and the `pyodide` package's `loadPyodide`. Confirm how vitest runs a `.ts` worker entry (execArgv `--experimental-strip-types` is Node 22's; the engine already imports `.ts` specifiers).
- [ ] **Step 6:** `pixi run engine-test`, `pixi run engine-check`, `pixi run sandbox-test`, `pixi run sandbox-check`, `pixi run dr-tidy`. `engine/README.md`: the pool, the worker body, one batch per worker, the port. **Commit** `Run each script batch in a fresh worker from one pool`.

---

### Task 5: Snapshot boot and determinism · `critical-implementer`

*Reason: it relies on Pyodide's private snapshot API and on overriding globals inside the worker before Pyodide loads.*

**Depends on:** Task 4.

**Files:**
- Modify: `engine/src/script/worker-main.ts`, `engine/src/script/pool.ts`, `engine/test/script/pool.test.ts`, `engine/README.md`, `architecture/constraints.md` (CN-4)
- Create: `engine/test/script/snapshot.test.ts`

**Interfaces:**
- Consumes: the pool and worker protocol (Task 4).
- Produces: `PoolOptions.onWarning?: (message: string) => void`; messages pool → worker `init {reply, interrupt, snapshot?: ArrayBuffer, make?: true}`, worker → pool `snapshot {bytes: ArrayBuffer}`; `ScriptRun.boot` set truthfully.

- [ ] **Step 1: Failing tests.**
  - `snapshot.test.ts`: with the private API present, the second and later runs report `boot: 'snapshot'` and `bootMs` under 1,000 ms (a loose bound; log the figure); the determinism group of `script_parity` equals the committed texts on both a snapshot-booted and a cold-booted worker.
  - Review Focus 4: a pool whose `loadPyodide` wrapper throws on `_makeSnapshot` (or on `_loadSnapshot`) boots cold, answers the same results and reports `boot: 'cold'`.
  - Poisoning: batch 1 writes into every `ArrayBuffer` it can reach through `js` and the snapshot copy's bytes it was booted from; batch 2's worker boots from an unmodified snapshot (its results equal the corpus).
  - The snapshot maker never runs user code: the pool never sends `run` to the worker it sent `make`.
  Run `pixi run engine-test -- snapshot`; expected: fails.
- [ ] **Step 2: Pins in `worker-main.ts`,** before `loadPyodide`, on `scope.globals`: `Date.now = () => 1750000000000`; `crypto.getRandomValues = (a) => a.fill(0x42)` on the array's bytes (a `Uint8Array` view over the argument's buffer range, returning the argument); `loadPyodide({ env: { PYTHONHASHSEED: '0' }, … })`. Confirm `datetime.now()` in Pyodide is UTC; if not, set `TZ: 'UTC'` in `env` as well.
- [ ] **Step 3: Snapshot.** The pool's first boot spawns a maker (`make: true`): cold boot with `_makeSnapshot: true`, the bootstrap up to (not including) binding the transport, `makeMemorySnapshot()`, post `snapshot` transferring the bytes, then the pool terminates it. The pool keeps the bytes and gives each new worker a fresh copy (`bytes.slice(0)`, transferred). A worker booted with `_loadSnapshot` binds its transport and hooks, runs `random.seed()`, posts `ready {boot: 'snapshot'}`. A failure to make or load falls back to cold boots for the pool's life, logged once through the pool's `onWarning` option (default none). Confirm what `_makeSnapshot` requires of `jsglobals` and what the snapshot may not reference (bind JS functions only after restore).
- [ ] **Step 4:** `pixi run engine-test`, `pixi run dr-tidy`. CN-4: Pyodide's private snapshot API is pinned with the version; moving the pin needs `snapshot.test.ts` green. `engine/README.md`: the snapshot and the pins. **Commit** `Boot script workers from a snapshot, deterministically`.

---

### Task 6: Limits and stops · `critical-implementer` · `critical-reviewer`

*Reason: timers racing worker messages and termination, over shared buffers.*
*Critical review: a missed stop holds a worker forever or leaves a run unanswered; a wrong one falsifies a result.*

**Depends on:** Task 5.

**Files:**
- Modify: `engine/src/script/pool.ts`, `engine/src/script/worker-main.ts`, `engine/README.md`
- Create: `engine/test/script/runaway.test.ts`

**Interfaces:**
- Consumes: `call-start {i}` / `call-end {i}`, the interrupt buffer (Task 4).
- Produces: host-made results in the harness's call-error shape: `timeout` with message `execution exceeded the wall timeout of 10s` (the server's text, `script_runner.py:1087-1091`, with the configured seconds), `cancelled`, `memory` (`guest exceeded its memory budget`), `runtime` for a crash; `RunLimits` defaults `callMs: 10000`, `batchMs: 30000`, `graceMs: 1500`.

- [ ] **Step 1: Failing tests** (`runaway.test.ts`, real Pyodide, `callMs` lowered to 500 and `batchMs` to 2,000 where the default would make a test slow; each asserts that a following batch on the same pool answers the parity text for a simple case):
  - `while True: pass` in call 0 of 3 → call 0 `timeout`, calls 1 and 2 right, one worker used (soft stop).
  - `except BaseException` in a loop; `signal.signal(signal.SIGINT, signal.SIG_IGN)` then a loop; `sum(range(10**10))` → call 0 `timeout` after `callMs + graceMs`, calls 1 and 2 `timeout` too, the worker terminated (hard stop).
  - Review Focus 1: `time.sleep(60)` with defaults lowered → hard stop at `callMs + graceMs`.
  - Batch budget: three calls each sleeping `0.8 × callMs` with `batchMs` below their sum → the call that crosses the budget answers `timeout`.
  - Cancel: `run(…, signal)` aborted during call 0 → the run answers every call not yet ended as `cancelled`, the worker is soft- then hard-stopped. Review Focus 5: a run aborted while queued behind `cap: 1` never spawns a worker and answers `cancelled`.
  - Memory: `b = bytearray(2**31)` (or a loop appending to a list until it fails) → that call answers `memory`, or the worker crashes and the rest answer `memory`; the next batch is right.
  - A `KeyboardInterrupt` the script raises itself (no stop) stays the harness's `runtime` error: the pool only rewrites calls it stopped.
  Run `pixi run engine-test -- runaway`; expected: fails.
- [ ] **Step 2: Timing.** On `call-start {i}` the pool clears the interrupt buffer's slot 0 and arms a deadline `min(callMs, batchMs − elapsed)`; on `call-end {i}` it disarms. At the deadline: store 2 with `Atomics.store` on the interrupt buffer, mark call `i` stopped, arm the grace timer; on `call-end {i}` before grace, disarm; at grace, terminate the worker. The worker clears slot 0 before each call too (a flag left set fires in the next code).
- [ ] **Step 3: Results.** On `done`, calls the pool stopped become `timeout` (or `cancelled`) whatever the worker said. On a hard stop, every call not ended gets the same error and the run resolves. On a crash, `memory` if the worker's last message or error text names `MemoryError` or an out-of-memory, else `runtime`. A `cancel` of a queued run removes it from the queue.
- [ ] **Step 4:** `pixi run engine-test`, `pixi run dr-tidy`. `engine/README.md`: limits, soft and hard stop, what each answers, why a hard stop fails the rest of the batch. **Commit** `Stop runaway scripts softly, then by ending their worker`.

---

### Task 7: The service over the pool · `critical-implementer`

*Reason: removing run serialization changes the epoch pin and the refusal paths every script call goes through.*

**Depends on:** Task 6.

**Files:**
- Modify: `engine/src/service/service.ts`, `engine/src/service/types.ts`, `engine/test/service/scripts.test.ts`, `engine/README.md`

**Interfaces:**
- Consumes: `ScriptHost.run(batch, bridge, signal)`, `prewarm()`, `ScriptRun` (Tasks 4 to 6).
- Produces:
  - `scriptCalls` accepts `entry: 'script'` with exactly one call (422 otherwise); its result carries `ops: string` (the recording dispatcher's ops as default-style JSON text).
  - `ScriptCallsResult = { results: { text: string }[]; trips: number; ms: number; boot_ms: number; boot: 'snapshot' | 'cold'; ops?: string }`.
  - `{cancel: id}` on a `scriptCalls` aborts its run's signal.

- [ ] **Step 1: Failing tests** in `scripts.test.ts` (real Node pool):
  - Two `scriptCalls` at once both answer, and overlap (the second's start precedes the first's end: log both).
  - Review Focus 2: two runs in flight when `open` replaces the replica → both answer `409`, and a third call on the new replica answers right.
  - `entry: 'script'` with an op-proposing script → `ops` holds the ops; two `script` calls at once do not share ops; `entry: 'script'` with two calls → 422.
  - `{cancel}` during a `while True` run → the worker is stopped (the next call is answered within `callMs + graceMs`, not after the loop).
  - Prewarm: `setArtifacts` with a snippet artifact starts a boot before any `scriptCalls` (observe through a wrapping `ScriptHostFactory` counting `prewarm()`); with no snippet it does not.
  - Keep the existing refusals (501, 409, 422) and adapt the shape checks to `text`.
  Run `pixi run engine-test -- service/scripts`; expected: fails.
- [ ] **Step 2: Runs.** Drop `runs` and the single `runEpoch`; each run captures its epoch and gets a `Bridge` whose `dispatch` answers `BridgeError: replica is not ready` once `this.epoch` moved past it, and whose dispatcher is the shared read-only one, or its own `BridgeDispatcher(wc.model, true)` for `script`. `stillReady(epoch)` before and after, as now. `boot_ms` and `boot` come from the run.
- [ ] **Step 3: Cancel and prewarm.** The `later` call's cancel aborts an `AbortController` handed to `host.run`. After `moveArtifacts`, when `deps.scripts` exists and the resolved artifacts hold one whose kind is the snippets kind (confirm the string the server sends, in `src/data_rover/api` and `frontend/src/lib`), call `scriptHost().prewarm()` once per replica.
- [ ] **Step 4:** `pixi run engine-test`, `pixi run engine-check`, `pixi run dr-tidy`, `pixi run frontend-check`. `engine/README.md`: `scriptCalls` (entries, result shape, cancel, concurrency, prewarm). **Commit** `Run script calls concurrently on the pool`.

---

### Task 8: The browser port and the Chromium runs · `critical-implementer` · `critical-reviewer`

*Reason: the mechanism of the Chromium parity and runaway run is left open, and the sandbox worker is the security boundary.*
*Critical review: the sandbox is the boundary; a CSP loosening or a script reaching the engine worker's scope is a security hole.*

**Depends on:** Task 7.

**Files:**
- Modify: `sandbox/src/script-host.ts` (the Web Worker spawner and `browserScriptHost`), `sandbox/src/script-worker.ts` (calls `runWorker`), `sandbox/src/engine-worker.ts`, `sandbox/tsconfig*.json`, `sandbox/test/script-host.test.ts` (delete what the engine's pool tests now cover; keep what is sandbox-specific), `sandbox/test/fixtures/script-stub.ts` (delete if unused), `sandbox/README.md`
- Modify/Create: `frontend/bench/scripts.ts` (the corpus and runaway page functions), `frontend/bench/main.ts` (`window.bench.parity()`, `window.bench.runaway()`), `frontend/bench/vite.config.ts` (serve the corpus model and cases), `frontend/bench/scripts-run.ts` (Playwright driver), `frontend/package.json` and `pixi.toml` (task `engine-scripts-browser`)

**Interfaces:**
- Consumes: `createPool`, `runWorker`, `scriptCalls` (Tasks 4 to 7).
- Produces: `browserScriptHost: ScriptHostFactory` with `cap` from `navigator.hardwareConcurrency`; `pixi run engine-scripts-browser`, which builds the sandbox and exits non-zero on any parity mismatch or failed runaway case (a test, not a bench).

- [ ] **Step 1: Port.** The spawner creates `new Worker(new URL('./script-worker.ts', import.meta.url), {type: 'module'})`, posts the buffers, relays `csp-violation` as today (the engine worker re-posts a validated one to the page) and calls `preventDefault()` on the worker's `error` so it never reaches the page as `worker-error`. `script-worker.ts` checks `self.crossOriginIsolated` (else `failed`), imports `/pyodide/pyodide.mjs` as today and calls `runWorker(scope, loadPyodide)` with `indexURL: '/pyodide/'`.
- [ ] **Step 2: The Chromium run.** The corpus model reaches the page as the bench's model does (a v2 snapshot the page opens through `connectFrame` and `open`: write it from `parityModel()` with `scripts/snapshot_v2.py` into a git-ignored `benchmarks/` file in the task's pre-step, or open it by the lightest path the engine offers; confirm which). `window.bench.parity()` runs every case through `scriptCalls` and returns the texts; `scripts-run.ts` compares them with the fixture's and prints each mismatch. `window.bench.runaway()` runs the Task 6 soft-stop, hard-stop (`except BaseException`, `sum(range(10**10))`) and cancel cases with the default limits and, after each, reads an element and checks the replica's stamp is unchanged.
- [ ] **Step 3: Tests.** `pixi run sandbox-test`, `pixi run sandbox-check`, `pixi run sandbox-build`; stop any running sandbox preview; `pixi run engine-scripts-browser`. Expected: every parity case equal, every runaway case passing, zero CSP violations (the page's count). Paste the tail.
- [ ] **Step 4:** `pixi run dr-tidy`; `pixi run frontend-check`. `sandbox/README.md`: the script worker's section rewritten for the pool (one batch per worker, snapshot, stops) and the trust paragraph: a script can reach its own worker's globals, which affects only its own batch. **Commit** `Run the script pool in the sandbox and prove it in Chromium`.

---

### Task 9: The pool bench row, the measurement, documents · `implementer`

**Depends on:** Task 8.

**Files:**
- Modify: `frontend/bench/main.ts`, `frontend/bench/run.ts`, `architecture/contracts.md` (CT-6), `architecture/constraints.md` (CN-4), `architecture/program.md`, `BACKLOG-ENGINE.md`

**Interfaces:**
- Consumes: `scriptCalls`, `ScriptCallsResult.boot`.
- Produces: bench labels `script boot (cold)`, `script boot (snapshot)`, `10,000 script cells`, `script bridge trips`, `script µs per trip`, `script workers`, `script dispatch busy`.

- [ ] **Step 1: `scripts()`.** After the warm-up, run the ten scripts' `scriptCalls` concurrently (`Promise.all`), not in sequence; `10,000 script cells` is the wall time of all ten. Report the first call's boot as cold and the median `boot_ms` of the ten as snapshot boot when their `boot` is `snapshot`; `script workers` is the pool's cap as the page sees it (`navigator.hardwareConcurrency`, same formula); `script dispatch busy` is the engine worker's summed dispatch time if the service exposes it cheaply, otherwise omit the label and say so in the hand-back.
- [ ] **Step 2: Measure.** `pixi run engine-bench-data` if `benchmarks/large.snapshot.v2` is absent; stop any sandbox preview; `pixi run engine-bench-browser`. Paste the script rows of the three passes and the medians.
- [ ] **Step 3: The verdict (S18).** At or under 2,000 ms: record it. Over: do not tune. Report the split per the labels above, state the miss, and complete Steps 4 and 5; fewer trips or a binary layout gets its own design with the owner.
- [ ] **Step 4: Documents.** CT-6: per-batch workers, snapshot boot, the pool on both hosts, the interrupt and hard stop, the pinned determinism, the message set. CN-4: the new measurement beside the old. `program.md`: D plan 2 built, with the figure. `BACKLOG-ENGINE.md`: close `K-101`, `K-105`, and `K-103` items (6) and (8); update `K-100` with the new figure and verdict; log under new ids (grep the next free `K-`/`T-` across both backlog files) anything Tasks 1 to 8 reported and did not fix.
- [ ] **Step 5: The full run.** `pixi run dr-test`, `pixi run dr-tidy`, `pixi run frontend-test-e2e`, `pixi run engine-scripts-browser`. Expected: pytest, engine and sandbox green; frontend green but for `K-91` if it appears; e2e green but for `T-9`, and `T-11`, `T-12` may flake. Any other failure is this plan's: fix it or report it. Paste each tail.
- [ ] **Step 6: Commit** `Measure script cells on the pool`.

---

## After the last task

One `branch-reviewer` pass over the branch against the three specs, with this plan's Review Focus. Its findings are fixed or logged. The hand-back leads with the measurement and its verdict, then the snapshot boot figure in Chromium, then what the plan left open. The owner decides the merge into `engine-migration`; nothing is pushed.
