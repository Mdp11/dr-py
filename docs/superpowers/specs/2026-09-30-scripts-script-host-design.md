# Scripts, plan 2: script host — design

Refines `2026-09-30-scripts-in-the-browser-design.md` §1 for its second plan: one harness, one
worker pool for both hosts, per-batch isolation, determinism, limits and stop, the parity corpus,
the runaway and isolation tests, and the budget re-measured on the pool. Builds on
`2026-09-30-scripts-bridge-foundation-design.md` (P1–P15).

Folds in `K-100` (re-measure; contingency rule), `K-101` (boot contract, stuck run), `K-103(6)`
and `K-103(8)` (input projection, per-call `BaseException`), `K-105` (isolation).

Out of this plan, in plan 3: the cell cache and eviction, discarding a run in flight when a
transition lands, evaluation, the budget gate. In plan 4: `runSnippet`, the console UI, removals.

## What the code says (at `cc1278d5`)

1. Three harnesses exist. `_GUEST_BOOTSTRAP_SOURCE` (`src/data_rover/api/script_runner.py:249-497`)
   owns stdout cap, traceback filter, `result` pickup, `repr` truncation, arity binding and the
   console `script` entry; `tests/script/trusted_runner.py` hand-copies it; `GUEST_BOOTSTRAP`
   (`engine/src/script/guest.ts:22-56`) is a third, with no cap, no traceback, no `repr`, no
   `script` entry and `Type: msg` errors.
2. The server discards every interpreter after one run or one session
   (`script_runner.py:976-980,1373-1382`) and pins determinism in its WASI shims: realtime clock
   `1.75e18` ns, `random_get` filled with `0x42`, `PYTHONHASHSEED=0` (`:184,565-574,807`). The
   Pyodide hosts pin nothing.
3. Limits (`core/script/runner.py:104-111`): wall 10 s per call, embedded budget 30 s
   (`api/settings.py:206`), stdout 256 KiB and `repr` 64 KiB (characters), 1,000 ops of at most
   1 MiB, page 500, memory 256 MiB (host-enforced; Pyodide has none). A call timeout kills the
   server session; later calls fail fast (`script_runner.py:1329-1335`).
4. The service serializes runs through one `runs` chain and one `runEpoch` slot
   (`engine/src/service/service.ts:592-609,819-862`); `trips` is per host. The shared bridge
   dispatcher is read-only (`recordOps=false`) and safe for concurrent reads. `{cancel}` only
   drops the answer (`:668-671`).
5. The browser host keeps one worker (`sandbox/src/script-host.ts:57-62`); the Node host runs
   Pyodide in-process with a memoized boot that keeps a rejection (`engine/node/script-host.ts:48-52`).
   No interrupt buffer exists.
6. Pyodide 314.0.7, measured in Node 22: cold boot about 1.75 s; `_loadSnapshot` boot about
   150 ms from a 30 MB snapshot (`_makeSnapshot`, `makeMemorySnapshot`, `_loadSnapshot` are
   private, `pyodide.d.ts:1913,2119-2124`); about 45 MB per interpreter. `setInterruptBuffer`
   stops `while True`, regex and big-int work, but not `time.sleep`, `sum(range(10**10))`, a
   `except BaseException` loop or `signal.signal(SIGINT, SIG_IGN)`. `env: {PYTHONHASHSEED: '0'}`
   makes `hash` stable. `time.time` reads `Date.now()`; `os.urandom` and `random`'s initial seed
   read `crypto.getRandomValues`; a snapshot freezes `random`'s state. There is no reset API.
7. Python 3.14 on both sides: CPython 3.14 (core, trusted runner) and Pyodide 314.

## Decisions

**S1 · One pool, two ports.** `engine/src/script/pool.ts` is the only pool, written against a
`WorkerPort` the host hands in: spawn a worker with its reply and interrupt buffers, post, receive,
terminate. The browser (`sandbox/src/`) hands it Web Workers; `engine/node/` hands it
`worker_threads`. Both use the P7 reply buffer and the same worker body around `guest.ts`. The
Node host's in-process direct call goes; E inherits a real hard stop.

**S2 · One worker, one batch.** A worker boots, waits as a spare, runs exactly one batch and is
terminated. It never runs a second batch, so no Python or JS state from one script reaches
another (K-105). Worker messages stay untrusted; a forged message can affect only its own batch.

**S3 · Snapshot boot.** Once per pool, a dedicated worker boots cold with `_makeSnapshot`, runs
the bootstrap to the point before user code (stdlib imports, harness and facade compiled, no
transport bound), takes `makeMemorySnapshot()`, posts it back and is terminated; it never runs
user code. Every later worker receives its own copy (never shared memory: a script could
otherwise poison later workers) and boots with `_loadSnapshot`, then binds its transport. If
making or loading the snapshot fails, the pool boots cold and says so (S9). A test fails when
the private API breaks on the pinned version. *Rejected:* a build-time snapshot asset (30 MB
shipped; a Node-made snapshot may not restore in a browser).

**S4 · Size and prewarm.** Cap `max(1, min(4, hardwareConcurrency − 2))` (program decision 4).
The pool keeps one spare when idle and grows spares toward the cap while batches queue; spares
beyond one are terminated after 30 s without a queue. `prewarm()` makes the snapshot and one
spare; the service calls it when a replica opens with a non-empty snippets family. Concurrent
batches run in parallel, one per worker; a batch is never split.

**S5 · One harness.** The run harness moves from `_GUEST_BOOTSTRAP_SOURCE` to
`src/data_rover/core/script/harness_src.py` (`HARNESS_SOURCE`), beside `FACADE_SOURCE`: capped
stdout, traceback filter, `result` pickup, `repr` truncation, arity binding, the `script` entry,
per-call dispatch through `_dr_call_entry`. The server guest, `trusted_runner.py` and `guest.ts`
run that one copy; the engine embeds it as `engine/src/script/harness.generated.ts`, registered
in the golden driver's `GENERATED`. It is a move (MR-3), except S6.

**S6 · Per-call `BaseException`.** Each call catches `BaseException`. A `KeyboardInterrupt`
while the host's interrupt is raised for that call is a `timeout` error; `MemoryError` is
re-raised, as on the server; any other `BaseException` is that call's `runtime` error and the
batch continues (K-103(8)). The server guest gets the same rule through the shared harness.

**S7 · The `script` entry.** `scriptCalls` accepts `entry: 'script'` with exactly one call and
answers `{stdout, result_repr, ops, error, truncated}`. Its run gets its own dispatcher with
`recordOps=true`; embedded entries keep the shared read-only one. `runSnippet` stays in plan 4.

**S8 · Determinism.** The worker body, before Pyodide loads, pins `Date.now` to `1.75e12` ms
(`time.time`, `datetime.now`; the monotonic clock stays real, as on the server), replaces
`crypto.getRandomValues` with a `0x42` fill, and boots with `env: {PYTHONHASHSEED: '0'}`. After
every snapshot restore it runs `random.seed()`, which re-seeds from the pinned bytes. The trusted
runner applies the same pins in Python for the determinism cases.

**S9 · Results carry their boot.** Each run reports `boot_ms` and `boot: 'snapshot' | 'cold'`
of the worker that ran it, besides `trips` and `ms`, counted per run.

**S10 · Limits are the server's.** 10 s wall per call and 30 s per batch (a call's deadline is
`min(10 s, what remains of the batch's 30 s)`, as `script_runner.py:1215,1276`), stdout 256 KiB and
`repr` 64 KiB (characters, in the harness), ops and page caps in the dispatcher. The pool times
calls from the host side: the worker posts `call-start` and `call-end`. There is no per-worker
memory limit.

**S11 · Soft stop.** At a call's deadline, or on cancel, the pool stores 2 in that worker's
interrupt buffer; the harness answers `timeout` ("execution exceeded the wall timeout of 10s")
and the batch moves to its next call in the same worker. The buffer is cleared before each call.

**S12 · Hard stop.** A call not ended 1.5 s after its soft stop (the server's grace) ends its
worker by `terminate`: a swallowed or ignored interrupt, a long C loop, or a worker blocked in
`Atomics.wait`. The batch's remaining calls fail fast with the same `timeout` error, as a dead
server session does; they are not re-queued (the program spec said re-queue; this bounds a
runaway script's cost). A crashed worker fails its remaining calls with `memory` on
out-of-memory, else `runtime`. A spare replaces every ended worker. The replica takes no part.

**S13 · Cancel stops the run.** `{cancel: id}` on `scriptCalls` soft-stops, then hard-stops,
that run's worker, and the call answers as cancelled.

**S14 · The service runs batches concurrently.** The `runs` chain goes; each run holds its own
epoch pin. `ScriptHost.run(batch, bridge)` takes a bridge per run, built by the service pinned to
the run's epoch: after a replacement its trips answer `BridgeError: replica is not ready`. The
roots projection includes input elements (`inputs.e.ids`), as `trusted_runner.py` does
(K-103(6)), written once in the pool, not per host.

**S15 · The boot contract is on the type** and held by one test over both hosts: `boot()` is
idempotent on a live pool and retried after a rejection (never memoized); `dispose()` ends every
worker and rejects every pending boot and run (K-101).

**S16 · The parity corpus.** A golden family `script_parity`: cases `(code, model, entry, ids,
inputs) → output bytes` over `value`, `step`, `transform` and `script`, errors, tracebacks, caps,
truncation (`repr` included), determinism. The bytes come from the oracle, `trusted_runner.py`
over `HARNESS_SOURCE` on CPython 3.14. Node runs it in vitest over the real pool; Chromium runs
it through a Playwright spec against the built sandbox, driven like the bench page. Both equal
the committed bytes; on a mismatch the engine is fixed, never the fixture.

**S17 · Runaway and isolation tests,** in Node over real `worker_threads` and in Chromium:
`while True: pass` ends by soft stop and the batch continues; `except BaseException` in a loop,
`SIG_IGN` and `sum(range(10**10))` end by hard stop; after each, the replica answers a read with
an unchanged stamp. The K-105 reproduction (batch 1 hijacks `_dr_run` and `json` and replaces
`self.postMessage`) leaves batch 2's results honest. A script cannot write a later worker's
snapshot.

**S18 · Measurement and the contingency rule.** The `engine-bench-browser` row runs the ten
scripts concurrently on the pool and reports wall time, boot mode and snapshot boot time, a
per-worker split and the engine worker's dispatch busy time. Expected, reasoned not measured:
about 0.8 s of dispatch serialized on the engine worker and about 0.6 s of Python per worker
over four, so 1.2 to 1.5 s. If the median still misses 2 s, the plan stops and reports the
split; fewer trips or a binary layout then gets its own design with the owner. It stays a row,
not a gate (plan 3's).

## Interfaces

```ts
// engine/src/script/host.ts
export type ScriptEntry = 'value' | 'step' | 'transform' | 'script';
export type ScriptBatch = { readonly code: string; readonly entry: ScriptEntry; readonly calls: readonly ScriptCall[] };
export type RawScriptResult = { readonly text: string | null; readonly error: string | null };
export type ScriptRun = {
	readonly results: readonly RawScriptResult[];
	readonly trips: number;
	readonly ms: number;
	readonly bootMs: number;
	readonly boot: 'snapshot' | 'cold';
};
/**
 * `boot()` is idempotent on a live host and retried after a rejection; `dispose()` ends every
 * worker and rejects every pending boot and run.
 */
export type ScriptHost = {
	boot(): Promise<{ ms: number }>;
	prewarm(): void;
	run(batch: ScriptBatch, bridge: Bridge, signal?: AbortSignal): Promise<ScriptRun>;
	dispose(): void;
};
export type ScriptHostFactory = () => ScriptHost;

// engine/src/script/pool.ts
export type WorkerPort = {
	post(message: unknown): void;
	onMessage(handler: (message: unknown) => void): void;
	onError(handler: (message: string) => void): void;
	terminate(): void;
};
export type WorkerSpawner = (buffers: { reply: SharedArrayBuffer; interrupt: SharedArrayBuffer }) => WorkerPort;
export type PoolOptions = { cap: number; spareIdleMs?: number; limits?: Partial<RunLimits> };
export function createPool(spawn: WorkerSpawner, options: PoolOptions): ScriptHost;
```

The exact message set between pool and worker (`init`, `snapshot`, `ready`, `run`, `call-start`,
`call-end`, `bridge`, `more`, `done`, `failed`, `csp-violation`) is the plan's; CT-6 records it.

## Documents

CT-6 (per-batch workers, snapshot boot, interrupt and hard stop, the pool on both hosts), CN-4
(Pyodide's private snapshot API is pinned with the version), `program.md` (D plan 2), the
READMEs of `engine/`, `sandbox/` and `src/data_rover/core/script/`, and the backlog: close
`K-101`, `K-103(6)`, `K-103(8)`, `K-105`; update `K-100` with the new figure; add what the plan
leaves open.

## Known limits of this plan

- A transition during a run is still not detected; plan 3 adds the discard.
- `time.sleep(n)` holds its worker for `n` seconds up to the hard stop; the interrupt cannot wake it.
- The snapshot relies on private Pyodide API; moving the pin needs the snapshot test green.
- Memory: at the cap, four workers plus one 30 MB snapshot copy per spare, about 300 MB outside
  the engine heap while busy; one spare (about 75 MB) when idle.
