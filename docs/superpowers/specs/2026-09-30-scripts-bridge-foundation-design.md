# Scripts, plan 1: bridge foundation — design

Refines `2026-09-30-scripts-in-the-browser-design.md` §1 for its first plan: the dispatcher
port, the guest that runs the facade in Pyodide, a Node host and a one-worker browser host, and
the measurement the rest of D depends on — 10,000 script cells across workers.

Out of this plan, in plan 2: the run harness and console entry (`script`), determinism shims,
typed result decoding and error kinds, pool, prewarm, interrupt, timeout, hard stop, warm
sessions across batches. In plan 3: the cell cache and evaluation.

## What the code says (at `d6076fa1`)

1. `BridgeDispatcher` (`src/data_rover/core/script/bridge.py:203`) holds a model, the ops list
   and three caps. It holds no read-set and no temp-id counter: both are the facade's. One
   `_transport` call carries one op; trip-collapse is reply-side (`elements` on a hop, children
   projections, the roots handed to `_dr_call_entry`).
2. The server writes a reply with a bare `json.dumps(resp)` and caps ops by
   `len(json.dumps(op))`: Python's default style (`", "`, `": "`, `ensure_ascii=True`). The
   engine's `pyDumps` (`engine/src/value/serialize.ts:68`) has no such mode.
3. The engine has every read the dispatcher needs (`Model.getElement`, `relationshipsFrom`,
   `relationshipsTo`, `containerOf`, `elements()`, `Metamodel.elementDescendants`,
   `isContainment`, `nameOf`, `cmpCodePoint`, `pyRepr`). `WorkingCopy.model` includes staged
   edits.
4. `Service.receive` runs synchronously in the host turn, between scheduler slices, where
   engine state is consistent (`engine/src/service/scheduler.ts:61-63`).
5. `engine/src` takes no DOM or Node dependency; the sandbox's `createHost()` hands in
   `ServiceDeps`. No test creates a real `Worker`; no package depends on `pyodide`.
6. The sandbox has no static-asset convention; its three headers come from `vite.config.ts`.
   CSP violations are counted for the page only, not for workers.
7. The spike never ran a nested worker, nor a bridge across workers (`FINDINGS.md:99`).
8. The session path of `tests/script/trusted_runner.py:226-320` — exec the facade, exec the
   code, call `_dr_call_entry` per call — is the model for the guest.

## Decisions

**P1 · The dispatcher is a pure function of the model plus an ops recorder.**
`engine/src/script/bridge.ts`, a port of `bridge.py` op for op, error text included. It takes
request text and returns reply text: requests are parsed with `parseExact`, replies written in
Python's default `json.dumps` style, so a reply is byte-identical to the server's and Python's
`json.loads` in the guest keeps `1` and `1.0` apart (AD-26).

**P2 · `pyDumps` gains the default style**: `{ ascii?: boolean; spaced?: boolean }`, covered by
the existing `json_dumps` golden family.

**P3 · A `script_bridge` golden family.** A Python scenario builds a model with fixed ids
(`restore_relationship`, never `connect`), sends request texts through
`BridgeDispatcher.dispatch` and records each reply's `json.dumps` text. The engine test
compares texts, not parsed values.

**P4 · One guest, two hosts.** `engine/src/script/guest.ts` holds everything that talks to
Pyodide, written against a small structural `Interpreter` type, with the transport handed in as
`(requestText: string) => string`. The Python side of the guest is one bootstrap source: it
defines `_transport` over that function, opens a session (facade, then code) and calls
`_dr_call_entry` per call, catching per call.
- Node host, `engine/node/script-host.ts`: Pyodide in-process, the transport a direct call to
  the dispatcher.
- Browser host, `sandbox/src/`: a script worker running the same guest, the transport blocking
  on shared memory.

**P5 · The facade is embedded as a generated source**, `engine/src/script/facade.generated.ts`,
registered in the golden driver's `GENERATED` so the staleness test covers it.

**P6 · The script worker uses its own worker channel**, not an extra `MessagePort`: a nested
worker's `postMessage` pair is already private to the engine worker. (Program spec §1 said "a
private `MessagePort`"; this is that, without a second channel.)

**P7 · Reply buffer.** One `SharedArrayBuffer` of 1 MiB per worker. `Int32` header: `[0]`
state (0 waiting, 1 chunk ready), `[1]` bytes in this chunk, `[2]` bytes still to come. Payload
is UTF-8 from byte 16. A reply longer than one chunk crosses in turns: the worker copies the
chunk, resets the state, posts `{type:'more'}` and waits again.

**P8 · Bridge requests are answered inside the message handler**, synchronously, with no
scheduler job: a blocked worker waits at most for the running slice or transition. With no
ready replica the reply is `{"id":…, "error":"BridgeError: replica is not ready"}`.

**P9 · `ServiceDeps.scripts`**, an optional factory `(bridge) => ScriptHost`. The service
creates the host on first use and disposes it on `close`. Without it a script call is refused
`501 scripts are not available`.

**P10 · One engine method, `scriptCalls`**: `{code, entry, calls}` → one raw result per call.
It is what the bench and the tests drive now and what plan 3's fill calls from inside the
engine. Whether it stays on the wire is plan 4's decision. It refuses `entry: 'script'`
(plan 2).

**P11 · Roots travel with the batch.** The engine projects each call's roots when it sends the
batch (`project_roots`), so a script that reads only its row makes no trip.

**P12 · Pyodide is a dev dependency of `engine/` (Node host, tests) and `sandbox/` (assets)**,
pinned to `314.0.7` exactly. A Vite plugin in the sandbox copies `pyodide.mjs`,
`pyodide.asm.mjs`, `pyodide.asm.wasm`, `python_stdlib.zip` and `pyodide-lock.json` to
`dist/pyodide/` on build and serves them from `node_modules` in dev, with the three headers.

**P13 · Workers report CSP violations.** The engine worker and the script worker listen for
`securitypolicyviolation` and relay it to the page, which counts it with its own.

**P14 · The measurement is a bench row, not a gate, in this plan.** `engine-bench-browser`
gains "10,000 script cells": the spike's ten scripts × 1,000 `Microservice` ids on one warm
worker, Pyodide boot reported apart, with the trip count and the time per trip. The gate is
plan 3's, over the evaluation path.

**P15 · If JSON misses 2 s, the plan stops and reports.** The hand-back carries the split —
Python-side JSON, post, wake, dispatch — and the contingency (a binary layout, or fewer trips)
gets its own design. (Program spec §9 placed the binary layout inside plan 1; it cannot be
designed before the split is known.)

## Interfaces

```ts
// engine/src/script/bridge.ts
export type BridgeLimits = { maxOps: number; maxOpBytes: number; pageLimit: number; maxInlineFarEndpoints: number };
export const BRIDGE_LIMITS: BridgeLimits; // 1000, 1048576, 500, 2048
export class BridgeDispatcher {
	constructor(model: Model, recordOps: boolean, limits?: Partial<BridgeLimits>);
	readonly ops: Value[];
	dispatch(requestText: string): string;
}
export function projectRoots(model: Model, ids: readonly string[]): Value[];

// engine/src/script/host.ts
export type ScriptEntry = 'value' | 'step' | 'transform';
export type ScriptCall = { readonly elementIds: readonly string[]; readonly inputs?: Value; readonly doc?: Value };
export type ScriptBatch = { readonly code: string; readonly entry: ScriptEntry; readonly calls: readonly ScriptCall[] };
/** One per call: `_dr_call_entry`'s `{payload, reads}` as JSON text, or the error. */
export type RawScriptResult = { readonly text: string | null; readonly error: string | null };
export type ScriptRun = { readonly results: readonly RawScriptResult[]; readonly trips: number; readonly ms: number };
export type Bridge = { dispatch(requestText: string): string; roots(ids: readonly string[]): string };
export type ScriptHost = { boot(): Promise<{ ms: number }>; run(batch: ScriptBatch): Promise<ScriptRun>; dispose(): void };
export type ScriptHostFactory = (bridge: Bridge) => ScriptHost;

// engine/src/script/guest.ts
export type Interpreter = { runPython(code: string): unknown; globals: { set(name: string, value: unknown): void; get(name: string): unknown } };
export type Guest = { run(batch: ScriptBatch, roots: readonly string[]): RawScriptResult[] };
export function createGuest(py: Interpreter, transport: (requestText: string) => string, readMemoMax?: number): Guest;
```

## Known limits of this plan

- One worker, no timeout and no interrupt: a runaway script in a `scriptCalls` run is stopped
  only by closing the frame. Nothing user-facing calls `scriptCalls` yet.
- A transition during a run is not detected; plan 3 adds the discard.
- Error text from user code is `ExcName: message`, without a traceback (plan 2).
