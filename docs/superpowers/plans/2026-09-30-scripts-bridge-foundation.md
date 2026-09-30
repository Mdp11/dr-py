# Scripts: Bridge Foundation (Plan 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user script's facade runs in Pyodide, in Node and in a browser script worker, reading the engine's working copy through a byte-faithful port of the Python bridge; and the cost of 10,000 script cells across workers is measured.

**Architecture:**
1. `pyDumps` learns Python's default `json.dumps` style; a `script_bridge` golden family records the oracle's replies as text.
2. `engine/src/script/bridge.ts` ports `BridgeDispatcher` and `project_roots`: request text in, reply text out.
3. `engine/src/script/guest.ts` runs the embedded facade and the user's code in any Pyodide, over a transport handed in. A Node host calls the dispatcher directly.
4. The service takes an optional script host, serves bridge requests inside its message handler, and exposes `scriptCalls`.
5. The sandbox ships Pyodide from its own origin; a script worker, spawned by the engine worker, blocks on shared memory for each bridge reply.
6. `engine-bench-browser` measures ten scripts × 1,000 ids on one warm worker.

**Tech Stack:** TypeScript (engine, sandbox, Node 22), Pyodide 314.0.7 (CPython 3.14), Vite 8, vitest, Playwright (bench), Python 3.14 (golden scenarios).

**Spec:** `docs/superpowers/specs/2026-09-30-scripts-bridge-foundation-design.md` (decisions `P1`…`P15`, the interfaces), refining `docs/superpowers/specs/2026-09-30-scripts-in-the-browser-design.md`.

**Read these first:** `CLAUDE.md`; both specs; `architecture/contracts.md` CT-6 and CT-7; `architecture/conventions.md` (RC-4, RC-6, RC-8, RC-10); `src/data_rover/core/script/bridge.py` and `facade_src.py`; `tests/script/trusted_runner.py:226-320`; `engine/README.md`; `sandbox/README.md`.

**What kind of plan this is.** Steps state behaviour, signatures and tests precisely; they do not paste finished code, because the oracle (`bridge.py`, the golden fixture) is the specification and the implementer ports from it. Expected results are reasoned from the code at `d6076fa1`, not observed. Where a step says "confirm", the fact is inferred and the implementer checks it before relying on it.

## What planning found

Checked against the code at `d6076fa1`.

1. `BridgeDispatcher` holds no read-set and no temp-id counter; both are the facade's (`facade_src.py:86-88`, `:243-272`). One `_transport` call carries one op.
2. The dispatcher's error reply is `{"id": req_id, "error": "<ExcClassName>: <str(exc)>"}` (`bridge.py:275`); the facade maps by prefix (`facade_src.py:91-99`), so `KeyError: ` and `ReadOnlyError: ` are contract. `str(KeyError(msg))` is `repr(msg)`.
3. `elements_page` is unsorted: `model.elements` insertion order, filtered, then offset and limit (`bridge.py:305-323`). Hop replies sort relationship ids and list far endpoints in first-appearance order, or `[]` past 2048 (`bridge.py:86`, `:350-384`). `children` sorts target ids without dedup (`bridge.py:401`).
4. The ops byte cap is `len(json.dumps(op))`, characters of the default style, cumulative (`bridge.py:435-445`).
5. `pyDumps` (`engine/src/value/serialize.ts:68`) is compact and `ensure_ascii=False` only.
6. Engine reads available: `Model.getElement`, `findElement`, `relationshipsFrom`, `relationshipsTo`, `containerOf`, `elements()` (`engine/src/model/model.ts:79-129`); `Metamodel.elementType`, `relationshipType`, `elementDescendants`, `relationshipDescendants`, `isContainment` (`engine/src/metamodel/metamodel.ts:195-265`); `nameOf` (`engine/src/model/naming.ts:17`); `getProp` (`engine/src/model/records.ts:79`); `cmpCodePoint` (`engine/src/value/compare.ts:9`); `pyRepr` (`engine/src/value/repr.ts:12`). A relationship's name is the raw `name` property, not `nameOf`.
7. A restored record returns to its old `ord` in the engine where Python appends (`engine/README.md:10`), so `elements_page` order can differ from the oracle after churn. The golden scenario loads a model and does not churn it.
8. `Method = (service, call) => void`; `later` answers a promise (`engine/src/service/service.ts:290-301`). `Service.receive` runs in the host turn (`:542`). `ready()` refuses `409 replica is not ready`.
9. `connect` mints a time-based id (`src/data_rover/core/model/model.py:130`); fixtures use `restore_relationship` (`:139`).
10. Generated engine sources register in `GENERATED` (`tests/golden/driver.py:28`); `tests/golden/test_fixtures_current.py` fails on a stale one.
11. `sandbox/tsconfig.worker.json` includes only `src/engine-worker.ts` and `src/host.ts`; `sandbox/tsconfig.test.json` lists what tests import. `sandbox/vite.config.ts` has no plugins; `emptyOutDir` wipes `dist/` each build.
12. `frontend/bench/run.ts:135-138` expects exactly one `worker` target whose URL includes `engine-worker`. Whether a nested worker is listed as a target is unknown.
13. `pyodide` is a dependency nowhere. `pyodide@314.0.7` ships `pyodide.mjs`, `pyodide.asm.mjs`, `pyodide.asm.wasm`, `python_stdlib.zip`, `pyodide-lock.json`.
14. `frontend/e2e/isolation.spec.ts` pins the sandbox headers for `/` only.

## Global Constraints

- Pyodide is pinned to `314.0.7` exactly (no `^`), the same version in `engine/` and `sandbox/`.
- `engine/src/` has no DOM and no Node built-in (RC-4); imports use `.ts` specifiers and `import type` where only types are used; no enums, no parameter properties.
- The Python core is the oracle: on a mismatch fix the engine, never the fixture. `core/script` behaviour does not change in this plan.
- Bridge replies and the ops cap use Python's default `json.dumps` style; ids sort by code point (`cmpCodePoint`), never `localeCompare` or a bare `.sort()`.
- Request and reply cross as text and are never re-serialized through `JSON.parse` / `JSON.stringify` (AD-26).
- Sandbox CSP string unchanged: `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'; frame-ancestors <app origin>`. No `'unsafe-eval'`. Every response carries COEP `require-corp` and CORP `cross-origin`.
- Nothing under `spikes/` is copied (MR-5).
- Tests run the real engine and real Pyodide, no mocks, no fake timers; every host, worker and link is disposed.
- Comments: concise, present tense, no spec, plan or phase references (RC-6). READMEs change with the behaviour, in the same commit (RC-10).
- Commit messages: imperative sentence, no prefix, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A multi-byte character split across reply chunks.** Expected: the reply decodes exactly; chunks are concatenated as bytes and decoded once. Pinned in Task 7.
2. **A reply larger than the 1 MiB buffer** (a hop with 2,048 far endpoints carrying long properties). Expected: it crosses in continuation chunks and the script sees every relationship. Pinned in Task 7.
3. **User code that fails before any call** (syntax error, raise at module level, entry function missing). Expected: every call of the batch gets that error, and the same host runs the next batch correctly. Pinned in Task 4.
4. **The replica closes or is replaced while a script is mid-run.** Expected: bridge requests get `BridgeError: replica is not ready`, the run ends with errors, nothing deadlocks, and the engine keeps answering. Pinned in Task 5 (Node host) and Task 7 (blocked worker).
5. **Number fidelity through the bridge**: a property holding `1.0`, `1`, an integer past 2^53, non-ASCII and astral text. Expected: the script sees a Python `float`, `int`, exact `int`, and the same string. Pinned in Task 3 (reply bytes) and Task 4 (seen from Python).

## File Structure

| File | Responsibility |
|---|---|
| `engine/src/value/serialize.ts` (modify) | `pyDumps` default style |
| `tests/golden/scenarios/json_dumps.py` (modify) | default-style cases |
| `tests/golden/scenarios/script_bridge.py` (create) | oracle request and reply texts |
| `tests/golden/scenarios/script_facade.py` (create) | renders `facade.generated.ts` |
| `engine/src/script/bridge.ts` (create) | dispatcher and `projectRoots` |
| `engine/src/script/host.ts` (create) | host types |
| `engine/src/script/facade.generated.ts` (generated) | `FACADE_SOURCE` as a string |
| `engine/src/script/guest.ts` (create) | Pyodide-side runner and its Python bootstrap |
| `engine/node/script-host.ts` (create) | Node host |
| `engine/src/service/service.ts`, `types.ts` (modify) | `scripts` dep, bridge serving, `scriptCalls` |
| `sandbox/vite.config.ts` (modify) | Pyodide assets plugin |
| `sandbox/src/bridge-buffer.ts` (create) | reply buffer layout, write and blocking read |
| `sandbox/src/script-worker.ts` (create) | nested worker: Pyodide, guest, blocking transport |
| `sandbox/src/script-host.ts` (create) | engine-worker side of the script worker |
| `sandbox/src/engine-worker.ts`, `host.ts`, `page.ts`, `handshake.ts` (modify) | wiring, CSP relay |
| `frontend/bench/main.ts`, `run.ts` (modify) | the script-cells row |

## Dependency order

Tasks 1, 2 and 6 are `independent`: each may run beside the main sequence in its own worktree. Task 3 depends on 1 and 2. Then 3 → 4 → 5. Task 7 depends on 5 and 6. Task 8 depends on 7.

Every untagged task is reviewed by `task-reviewer`. Task 7 alone carries `critical-reviewer`.

---

### Task 1: `pyDumps` in Python's default style · `implementer`

**Depends on:** independent.

**Files:**
- Modify: `engine/src/value/serialize.ts`, `tests/golden/scenarios/json_dumps.py`
- Regenerate: `engine/fixtures/golden/json_dumps.json`
- Test: `engine/test/value/serialize.golden.test.ts`

**Interfaces:**
- Produces: `pyDumps(value: Value, indent?: number, options?: { allowNan?: boolean; ascii?: boolean; spaced?: boolean }): string`. `ascii` is `ensure_ascii=True`; `spaced` selects the separators `", "` and `": "` when `indent` is omitted. `pyDumps(v, undefined, { ascii: true, spaced: true, allowNan: true })` equals Python's `json.dumps(v)`.

- [ ] **Step 1: Oracle cases.** In `json_dumps.py`, add a group of cases written with bare `json.dumps(value)`: nested dict and list, empty dict and list, `1`, `1.0`, `1e22`, `2**60`, `True`, `None`, `"é"`, `" "`, an astral character (`"😀"`, which Python writes as two `\u` escapes), control characters `"\x00\x1f\x7f"`, `"\""` and `"\\"`, `float("nan")` and `float("inf")`. Follow the file's existing case shape and `tag()` use.
- [ ] **Step 2:** `pixi run golden-fixtures`; confirm only `json_dumps.json` changed.
- [ ] **Step 3: Failing test.** Extend `serialize.golden.test.ts` to run the new group through `pyDumps(untag(value), undefined, { ascii: true, spaced: true, allowNan: true })` and compare text. Run `pixi run engine-test -- serialize.golden`; expected: the new cases fail.
- [ ] **Step 4: Implement.** `ascii`: every UTF-16 code unit above `0x7f` is written `\uXXXX` lowercase hex, four digits, surrogates as two escapes; existing escapes are unchanged. `spaced`: item separator `", "`, key separator `": "`. Defaults keep today's output byte for byte.
- [ ] **Step 5:** `pixi run engine-test -- serialize` green; `pixi run dr-tidy`.
- [ ] **Step 6: Commit** `Write JSON in Python's default style`.

---

### Task 2: The `script_bridge` golden family · `implementer`

**Depends on:** independent.

**Files:**
- Create: `tests/golden/scenarios/script_bridge.py`
- Modify: `tests/golden/scenarios/__init__.py`
- Generate: `engine/fixtures/golden/script_bridge.json`
- Test: `tests/golden/test_fixtures_current.py` (existing)

**Interfaces:**
- Produces the fixture document:
  ```json
  {
    "metamodel": <metamodel doc, as the model-backed families write it>,
    "elements": ["<element json line>", …],
    "relationships": ["<relationship json line>", …],
    "groups": [
      { "name": "reads", "record_ops": false, "limits": {},
        "exchanges": [ { "request": "<json text>", "reply": "<json.dumps(resp) text>" }, … ],
        "ops": ["<json.dumps(op) text>", …] }
    ],
    "roots": [ { "ids": ["a", "missing", "b"], "projection": "<json.dumps(project_roots(...)) text>" } ]
  }
  ```
  `limits` holds any of `max_ops`, `max_op_bytes`, `page_limit`, `max_inline_far_endpoints` that differ from the defaults. Model lines follow `tests/golden/scenarios/read_pages.py` so `loadLines` reads them.

- [ ] **Step 1: The model.** Element types `Node` (property `name: string`), `Leaf` extending `Node`, `Other`; relationship types `Owns` (containment, `Node`→`Node`), `Links` (`Node`→`Node`, property `name: string`). Build with `restore_element` and `restore_relationship` only, fixed ids. Elements, in this order: `n1`, `n2`, `l1` (`Leaf`), `o1` (`Other`), `z😀` (astral id), `é1`, `n3`. Properties to cover: `name` exact; a key `Name` with no `name`; a `name` list whose first non-empty string is second; no name at all; values `1`, `1.0`, `2**60`, `"é"`, `"😀"`, a nested dict and list. Relationships: `Owns` `n1→n2`, `n1→l1`, and a second `Owns` `n1→n2` (duplicate child); `Links` `n2→n1` with `name`, `n1→o1`, `n1→z😀`; ids chosen so code-point order differs from UTF-16 order (one id starting `￿`, one astral).
- [ ] **Step 2: Group `reads`** (`record_ops=False`), requests as text exactly as the facade would send them (`{"id": n, "op": …, …}`): `element` hit and miss (`nope`, and an id containing `'`); `outgoing`, `incoming` on `n1` and on a leaf; `parent` with and without a parent; `children` of `n1` (duplicate kept) and of a leaf; `descendants` for `element`/`Node`, `relationship`/`Owns`, an unknown name of each kind, and `kind: "bogus"`; `elements_page` with `type: null`, `["Node"]` (includes `Leaf`), `[]`, `"Leaf"` (a str), `["Nope"]`, `offset`/`limit` combinations: defaults, `limit: 2` walking every page to `next_offset: null`, `limit: 0`, `limit: -1`, `limit: 9999`, `offset: "2"`, `offset: 2.9`, `offset: []`; a request without `id`; without `element_id`; `element_id: ["x"]`; `op: "bogus"`; `op: null`; a write dict (refused `ReadOnlyError`).
- [ ] **Step 3: Group `far_cap`** with `max_inline_far_endpoints: 2` (monkeypatch `_MAX_INLINE_FAR_ENDPOINTS` for the group, restored after): `outgoing` on `n1` (over the cap, `elements: []`) and on `n2` (under it).
- [ ] **Step 4: Group `writes`** (`record_ops=True`): the five write dicts of `facade_src.py:464-678` verbatim, one with a `1.0` and a non-ASCII property; record `dispatcher.ops` as default-style texts. **Group `op_cap`** (`max_ops: 2`): three writes. **Group `byte_cap`** (`max_op_bytes` set to the first op's `len(json.dumps(op))` plus one): two writes, the second holding `"é"` so the character count of the escaped form is what decides.
- [ ] **Step 5: `roots`.** `project_roots` for `[]`, `["n1"]`, `["n2", "missing", "n1", "n2"]`.
- [ ] **Step 6:** Register the scenario in `__init__.py`; `pixi run golden-fixtures`; `pixi run -e core-dev pytest tests/golden -q` green. Read the fixture once: every error text present, no time-based id.
- [ ] **Step 7:** `pixi run core-lint`. **Commit** `Record the script bridge's replies as a golden family`.

---

### Task 3: The dispatcher port · `critical-implementer`

*Reason: a wire protocol ported byte for byte; error text, ordering and number formatting all reach user scripts.*

**Depends on:** Tasks 1 and 2.

**Files:**
- Create: `engine/src/script/bridge.ts`, `engine/test/script/bridge.golden.test.ts`
- Modify: `engine/src/index.ts` (exports)

**Interfaces:**
- Consumes: `pyDumps` default style (Task 1); `script_bridge.json` (Task 2); `parseExact`, `loadFixture`, `loadLines`.
- Produces:
  ```ts
  export type BridgeLimits = { maxOps: number; maxOpBytes: number; pageLimit: number; maxInlineFarEndpoints: number };
  export const BRIDGE_LIMITS: BridgeLimits; // 1000, 1048576, 500, 2048
  export class BridgeDispatcher {
  	constructor(model: Model, recordOps: boolean, limits?: Partial<BridgeLimits>);
  	readonly ops: Value[];
  	dispatch(requestText: string): string;
  }
  export function projectRoots(model: Model, ids: readonly string[]): Value[];
  export function dumpDefault(value: Value): string; // pyDumps(value, undefined, { ascii: true, spaced: true, allowNan: true })
  ```

- [ ] **Step 1: Failing test.** `bridge.golden.test.ts`: load the fixture, build the model with `loadLines`; for each group create one `BridgeDispatcher(model, group.record_ops, limits)` and assert, exchange by exchange in order, `dispatch(request) === reply` as strings; then `ops.map(dumpDefault)` equals `group.ops`. For each `roots` entry, `dumpDefault(projectRoots(model, ids)) === projection`. Run `pixi run engine-test -- bridge.golden`; expected: fails on the missing module.
- [ ] **Step 2: Projections.** Element `{id, type, name, properties}` with `nameOf`; relationship `{id, type, name, properties, source_id, target_id}` with `getProp(props, 'name') ?? null`. Key order as listed. `properties` is the record's `props` (no copy is needed: nothing mutates it).
- [ ] **Step 3: `dispatch`.** Parse with `parseExact`; the reply is the handler's object with `id` assigned last, or `{id, error}`; serialize with `dumpDefault`. `id` is echoed whatever its type, `null` when absent. A dict `op` is a write and is tested before a string `op`. Port each handler of `bridge.py` in its own function, in the oracle's order: `element`, `elements_page`, `outgoing`, `incoming`, `parent`, `children`, `descendants`, the write path. A request that is not valid JSON answers `{"id": null, "error": "ValueError: …"}` (the oracle never sees one; the text is ours).
- [ ] **Step 4: Errors.** One internal error type carrying the Python class name and message. `ModelError` `key` → `KeyError: ` + `pyRepr(message)`; a missing request key → `KeyError: ` + `pyRepr(key)`; the oracle's `ValueError`, `TypeError`, `ReadOnlyError`, `BridgeLimitError` texts verbatim from `bridge.py` and the fixture. Nothing escapes `dispatch`: any other throw becomes `{id, error: "RuntimeError: " + message}`.
- [ ] **Step 5: Ordering and caps.** Relationship ids and child ids sorted with `cmpCodePoint`; far endpoints in first-appearance order over the sorted relationships, all or nothing at `maxInlineFarEndpoints`; `elements_page` iterates `model.elements()`; `offset` and `limit` coerced as `bridge.py:291-303` does (`int()` of a JSON float truncates; a list is `TypeError`; the fixture has the texts). Op cap: count before append; byte cap: cumulative `dumpDefault(op).length`, a refused op not appended.
- [ ] **Step 6:** Run the golden test until every exchange matches. On a mismatch read the oracle; never edit the fixture. If a reply cannot be matched because the oracle's behaviour is unportable, stop and report it.
- [ ] **Step 7:** `pixi run engine-test`, `pixi run engine-check`, `pixi run dr-tidy`. **Commit** `Port the script bridge dispatcher`.

---

### Task 4: The guest and the Node host · `critical-implementer`

*Reason: the Pyodide call boundary is undecided in detail (proxies, string passing, error capture) and both hosts inherit whatever is chosen here.*

**Depends on:** Task 3.

**Files:**
- Create: `tests/golden/scenarios/script_facade.py`, `engine/src/script/facade.generated.ts` (generated), `engine/src/script/host.ts`, `engine/src/script/guest.ts`, `engine/node/script-host.ts`, `engine/tsconfig.node.json`, `engine/test/script/guest.test.ts`
- Modify: `tests/golden/driver.py` (`GENERATED`), `engine/package.json` (devDependency `pyodide: "314.0.7"`, the `check` script also type-checks `tsconfig.node.json`), `engine/package-lock.json`, `engine/src/index.ts`, `engine/README.md`

**Interfaces:**
- Consumes: `BridgeDispatcher`, `projectRoots`, `dumpDefault` (Task 3).
- Produces (all in the refining design's Interfaces block): `ScriptEntry`, `ScriptCall`, `ScriptBatch`, `RawScriptResult`, `ScriptRun`, `Bridge`, `ScriptHost`, `ScriptHostFactory` in `host.ts`; `Interpreter`, `Guest`, `createGuest(py, transport, readMemoMax = 4096)` and `GUEST_BOOTSTRAP: string` in `guest.ts`; `FACADE_SOURCE: string` in `facade.generated.ts`; `nodeScriptHost: ScriptHostFactory` in `engine/node/script-host.ts`.
- `RawScriptResult.text` is `json.dumps` of `_dr_call_entry`'s return (`{"payload": …, "reads": …}`); `error` is `"<ExcClassName>: <message>"`. Exactly one is non-null.

- [ ] **Step 1: Embed the facade.** `script_facade.render()` returns a TypeScript module exporting `FACADE_SOURCE` as a JSON-escaped string literal under the header comment the other generated files use. Register it in `GENERATED`; `pixi run golden-fixtures`; `pixi run -e core-dev pytest tests/golden -q` green.
- [ ] **Step 2: Dependency.** Add `pyodide` `314.0.7` to `engine/` devDependencies; `pixi run engine-install`.
- [ ] **Step 3: Failing tests.** `guest.test.ts` boots one Node host in `beforeAll` (timeout 60 s), disposes it in `afterAll`, over a model built from `script_bridge.json` and a `Bridge` made from a `BridgeDispatcher(model, false)`. Cases, each asserting the parsed `text` or the `error`:
  - `def value(els): return els[0].name` over `[n1]`, `[n2]` → scalars; `trips === 0` (roots are piggybacked).
  - `def value(els): return len(els[0].outgoing())` → the fixture's count; `trips` ≥ 1.
  - `def value(els): return [r.destination().name for r in els[0].outgoing()]` → names in sorted relationship-id order.
  - `def step(el): return el.children()` with `entry: 'step'` → `{"nodes": […]}`.
  - `def transform(doc): …` with `entry: 'transform'` and a `doc` → `{"kind":"json",…}`; no roots sent.
  - Number fidelity: a script returning `[type(els[0]["f"]).__name__, type(els[0]["i"]).__name__, els[0]["big"] == 2**60, els[0]["s"]]` for the element holding `1.0`, `1`, `2**60`, `"😀"` → `["float","int",true,"😀"]`.
  - `reads` of a call that read `outgoing` lists `["out", id]` and `["el", id]`.
  - A call raising `ValueError("x")` → `error: "ValueError: x"`; the next call of the same batch succeeds.
  - Syntax error; `raise` at module level; entry function missing → every call of the batch carries the error; a following batch on the same host succeeds.
  - A missing element id → that call's error starts `NotFoundError`.
  - Two batches with different code do not see each other's globals.
  Run `pixi run engine-test -- guest`; expected: fails on the missing modules.
- [ ] **Step 4: `GUEST_BOOTSTRAP`.** One Python source, run once per interpreter. It defines:
  ```python
  import json

  def _transport(req):
      return json.loads(_dr_transport_text(json.dumps(req)))

  def _dr_run(code, entry, calls_text, roots_texts):
      calls = json.loads(calls_text)
      try:
          ns = {"_transport": _transport, "_read_memo_max": _dr_read_memo_max}
          exec(compile(_dr_facade, "<facade>", "exec"), ns)
          exec(compile(code, "<snippet>", "exec"), ns)
          call_entry = ns["_dr_call_entry"]
      except BaseException as exc:
          failed = {"error": type(exc).__name__ + ": " + str(exc)}
          return json.dumps([failed for _ in calls])
      out = []
      for call, roots_text in zip(calls, roots_texts):
          try:
              result = call_entry(entry, call["element_ids"], json.loads(roots_text), call.get("doc"), call.get("inputs"))
              out.append({"text": json.dumps(result)})
          except Exception as exc:
              out.append({"error": type(exc).__name__ + ": " + str(exc)})
      return json.dumps(out)
  ```
  Read `facade_src.py:699-770` and `trusted_runner.py:226-320` first: keep `_dr_call_entry`'s own handling (what it returns for a user exception, how a missing entry surfaces) and adjust the wrapper so the result above holds. `_dr_transport_text`, `_dr_facade` and `_dr_read_memo_max` are globals the guest sets. Stdout is left alone in this plan.
- [ ] **Step 5: `createGuest`.** Sets the three globals (the transport wrapped to count trips), runs `GUEST_BOOTSTRAP`, and `run(batch, roots)` calls `_dr_run` with `calls` serialized by `dumpDefault` (`element_ids`, and `inputs` / `doc` when present), returning the parsed list as `RawScriptResult[]`. `transform` passes `"[]"` for every root text. Confirm how a JS array of strings and a returned Python `str` cross in Pyodide 314, and destroy any proxy created. `engine/src/script/guest.ts` names no Pyodide type: `Interpreter` is structural.
- [ ] **Step 6: Node host.** `nodeScriptHost(bridge)`: `boot()` loads Pyodide from the `pyodide` package once and creates the guest with `bridge.dispatch` as transport; `run(batch)` computes `bridge.roots(call.elementIds)` per call, times the run with `performance.now()`, returns `{results, trips, ms}`; `dispose()` drops the interpreter. `engine/tsconfig.node.json` includes `node/**/*.ts` with Node types.
- [ ] **Step 7:** Tests green. `pixi run engine-test`, `pixi run engine-check`, `pixi run dr-tidy`. Note the Pyodide boot time the test run shows.
- [ ] **Step 8: README.** `engine/README.md`: a "Scripts" section — dispatcher, guest, the Node host, what is generated. **Commit** `Run the script facade in Pyodide over the ported bridge`.

---

### Task 5: The service's script host and `scriptCalls` · `critical-implementer`

*Reason: it serves reads outside the scheduler and must stay correct while the replica opens, closes or is replaced mid-run.*

**Depends on:** Task 4.

**Files:**
- Modify: `engine/src/service/types.ts`, `engine/src/service/service.ts`, `engine/test/service/helpers.ts`, `engine/README.md`, `architecture/contracts.md` (CT-4's method list)
- Test: `engine/test/service/scripts.test.ts`

**Interfaces:**
- Consumes: `ScriptHostFactory`, `Bridge`, `BridgeDispatcher`, `projectRoots`, `dumpDefault`, `nodeScriptHost`.
- Produces: `ServiceDeps.scripts?: ScriptHostFactory`. Method `scriptCalls`, params `{ code: string, entry: 'value' | 'step' | 'transform', calls: [{ element_ids: string[], inputs_text?: string, doc_text?: string }] }`, result `{ results: [{ text: string | null, error: string | null }], trips: number, ms: number, boot_ms: number }`. `inputs_text` and `doc_text` are JSON text, parsed with `parseExact`.

- [ ] **Step 1: Failing tests.** Extend `connect` in `helpers.ts` to pass extra deps. `scripts.test.ts`, with `nodeScriptHost` and a replica opened from the `script_bridge` model (use the helpers the other service tests use to open one), 60 s `beforeAll`:
  - `scriptCalls` with `def value(els): return els[0].name` returns one result per call, in call order.
  - After `stage` renames `n1`, the same call returns the staged name; after `unstage`, the committed one.
  - Without `deps.scripts`: refused `501 scripts are not available`.
  - Before a replica is ready: refused `409 replica is not ready`.
  - `entry: 'script'`, a non-string `code`, a `calls` that is not an array, `element_ids` not strings: refused `422`.
  - Replica closed mid-run: a host test double is not allowed, so drive it for real — a script whose first call succeeds, then `close` is sent, then a second `scriptCalls`: refused `409`; and unit-test the bridge function directly: with no ready replica `dispatch('{"id": 7, "op": "element", "element_id": "n1"}')` returns `{"id": 7, "error": "BridgeError: replica is not ready"}`.
  - `close` disposes the host (assert through the factory's returned object); a later `open` and `scriptCalls` boots a new one.
  Run `pixi run engine-test -- service/scripts`; expected: fails.
- [ ] **Step 2: Bridge.** A private `Service.bridge: Bridge`. `dispatch(text)`: when `state` is ready and `wc` is set, answer from a `BridgeDispatcher(wc.model, false)` cached per working-copy object; otherwise the not-ready reply, echoing the request's `id` when the text parses. `roots(ids)`: `dumpDefault(projectRoots(wc.model, ids))`. Neither submits a scheduler job.
- [ ] **Step 3: `scriptCalls`.** Validate params at arrival (422). Then, through `later`: require a ready replica (409), create the host on first use, `await host.boot()` once, `await host.run(batch)`, answer. A rejected run refuses `500` with the message. Drop the cached dispatcher wherever the replica is dropped or replaced (`discard`, the assignment of a new working copy). Dispose the host in `close`.
- [ ] **Step 4:** Tests green; the whole `engine-test` suite green and the worker exits (no leaked interpreter).
- [ ] **Step 5: Docs.** `engine/README.md`: `scriptCalls`, the bridge being served in the message handler, `deps.scripts`. `architecture/contracts.md` CT-4: add `scriptCalls` beside the other methods, in that list's manner. `pixi run dr-tidy`. **Commit** `Serve script calls and bridge reads from the engine service`.

---

### Task 6: Pyodide in the sandbox build, and workers' CSP reports · `critical-implementer`

*Reason: it changes what the security boundary serves; the Vite behaviour it relies on is inferred, not observed.*

**Depends on:** independent.

**Files:**
- Modify: `sandbox/package.json` (devDependency `pyodide: "314.0.7"`), `sandbox/package-lock.json`, `sandbox/vite.config.ts`, `sandbox/src/engine-worker.ts`, `sandbox/src/page.ts`, `sandbox/README.md`, `frontend/e2e/isolation.spec.ts`
- Test: `sandbox/test/pyodide-assets.test.ts`, `frontend/e2e/isolation.spec.ts`

**Interfaces:**
- Produces: `GET /pyodide/{pyodide.mjs, pyodide.asm.mjs, pyodide.asm.wasm, python_stdlib.zip, pyodide-lock.json}` on the sandbox origin, in `vite dev` and in `dist/`, each with the three headers. An exported `PYODIDE_FILES: readonly string[]` in `vite.config.ts` (or a module beside it) naming the five files. The engine worker posts `{type: 'csp-violation', directive, blocked}` to the page for a violation in its own scope; the page forwards it to the parent as it does its own.

- [ ] **Step 1:** Add the dependency; `pixi run sandbox-install`.
- [ ] **Step 2: Failing test.** `pyodide-assets.test.ts`: run `vite build` programmatically into a temp `outDir` (or assert on `dist/` after `pixi run sandbox-build` if the config cannot be parameterized: choose one and say which), and assert the five files exist under `pyodide/`, byte-equal in size to `node_modules/pyodide/`'s; no other file from the package is copied. Expected: fails.
- [ ] **Step 3: The plugin.** Inline in `vite.config.ts`: on build, copy the five files to `<outDir>/pyodide/` after the bundle is written, on every build including `--watch`; in dev, a middleware serving `/pyodide/<file>` for those five names only from `node_modules/pyodide/`, setting the CSP, COEP and CORP headers and the right `Content-Type` (`application/wasm` for the wasm), 404 for anything else under `/pyodide/`. Confirm `vite preview` serves `dist/pyodide/*` with `preview.headers`.
- [ ] **Step 4: Headers proof.** Add to `isolation.spec.ts`: `GET http://localhost:5174/pyodide/pyodide.asm.wasm` and `/pyodide/pyodide.mjs` answer 200 with COEP `require-corp`, CORP `cross-origin` and the pinned CSP; `/pyodide/package.json` answers 404.
- [ ] **Step 5: CSP relay.** In `engine-worker.ts`, a `securitypolicyviolation` listener on `self` posts the violation to the page; in `page.ts`, the worker's `message` of that type is forwarded to the parent exactly as the page's own violation is. Update the comment at `frontend/e2e/replica.spec.ts:79`, which says workers' violations are not reported.
- [ ] **Step 6:** `pixi run sandbox-test`, `pixi run sandbox-check`, `pixi run sandbox-build`; stop any running sandbox preview, then `pixi run frontend-test-e2e -- isolation replica`; all green. `pixi run dr-tidy`.
- [ ] **Step 7: README.** `sandbox/README.md`: the `/pyodide/` assets, where they come from, the relay. **Commit** `Serve Pyodide from the sandbox origin`.

---

### Task 7: The browser script host · `critical-implementer` · `critical-reviewer`

*Implementer reason: a blocking shared-memory protocol between two threads, with chunking.*
*Reviewer reason: a race or a lost wake here deadlocks a worker or hands a script a truncated reply, and the tests of this plan cannot exhaust the interleavings.*

**Depends on:** Tasks 5 and 6.

**Files:**
- Create: `sandbox/src/bridge-buffer.ts`, `sandbox/src/script-worker.ts`, `sandbox/src/script-host.ts`, `sandbox/test/bridge-buffer.test.ts`, `sandbox/test/fixtures/buffer-reader.ts` (a `worker_threads` reader for the test)
- Modify: `sandbox/src/engine-worker.ts`, `sandbox/src/host.ts` only if `createHost` must carry the factory, `sandbox/tsconfig.worker.json`, `sandbox/tsconfig.test.json`, `sandbox/README.md`

**Interfaces:**
- Consumes: `ScriptHostFactory`, `Bridge`, `createGuest` (Task 4); `ServiceDeps.scripts` (Task 5); `/pyodide/` (Task 6).
- Produces:
  ```ts
  // bridge-buffer.ts
  export const REPLY_BUFFER_BYTES = 1 << 20;
  export const HEADER_BYTES = 16;
  export function createReplyBuffer(): SharedArrayBuffer;
  /** Engine side: holds a reply and writes it one chunk at a time. */
  export class ReplyWriter { constructor(buffer: SharedArrayBuffer); begin(bytes: Uint8Array): void; more(): void; }
  /** Worker side: blocks until the whole reply has crossed; `askMore` requests the next chunk. */
  export function readReply(buffer: SharedArrayBuffer, askMore: () => void): Uint8Array;
  /** Worker side: call before posting a request. */
  export function armReply(buffer: SharedArrayBuffer): void;

  // script-host.ts
  export const browserScriptHost: ScriptHostFactory;
  ```
  Worker messages. Engine → worker: `{type:'init', reply: SharedArrayBuffer}`, `{type:'run', run: number, batch: ScriptBatch, roots: string[]}`. Worker → engine: `{type:'ready', ms: number}`, `{type:'failed', message: string}`, `{type:'bridge', text: string}`, `{type:'more'}`, `{type:'done', run: number, results: RawScriptResult[], trips: number, ms: number}`, `{type:'csp-violation', directive: string, blocked: string}`.

- [ ] **Step 1: Failing buffer tests.** `bridge-buffer.test.ts` with a real `node:worker_threads` worker (`buffer-reader.ts`) that arms, posts `bridge`, calls `readReply` and posts back the bytes; terminate it in `afterEach`.
  - A short reply arrives intact.
  - An empty reply (zero bytes) arrives as zero bytes and does not hang.
  - A reply of exactly `REPLY_BUFFER_BYTES - HEADER_BYTES` bytes takes one chunk; one byte more takes two.
  - A 3.5 MiB reply of multi-byte text (`"😀é"` repeated) arrives byte-identical: chunk edges fall inside characters.
  - The writer answering before the reader waits (reply written synchronously on receipt) does not lose the wake.
  - 2,000 request and reply rounds in a row on one buffer all arrive intact.
  Expected: fails on the missing module.
- [ ] **Step 2: `bridge-buffer.ts`.** Layout per `P7`: `Int32Array` header `[0]` state, `[1]` chunk bytes, `[2]` bytes still to come; payload from byte 16. `armReply` stores state 0. `ReplyWriter.begin` keeps the bytes and writes the first chunk; `more` writes the next; each write sets `[1]`, `[2]`, copies the payload, stores state 1 and calls `Atomics.notify`. `readReply` loops: `Atomics.wait(header, 0, 0)`; copy the chunk out to a non-shared array; if `[2] > 0`, store state 0, `askMore()`, continue; else return the concatenation. No timeout: the engine always answers. Decoding is the caller's, once, on the whole reply.
- [ ] **Step 3: `script-worker.ts`.** On `init`: refuse with `failed` when `self.crossOriginIsolated` is false; otherwise `const { loadPyodide } = await import(/* @vite-ignore */ new URL('/pyodide/pyodide.mjs', self.location.origin).href)`, `loadPyodide({ indexURL: '/pyodide/' })`, create the guest with a transport that arms the buffer, posts `bridge`, and returns the decoded `readReply`; post `ready` with the boot time. On `run`: run the batch and post `done`. A `securitypolicyviolation` listener posts `csp-violation`. Types come from `import type` of `pyodide`. Confirm the built chunk loads `/pyodide/pyodide.asm.mjs` from the same origin with no CSP violation; if the dynamic import is rewritten or blocked by the build, report what worked instead.
- [ ] **Step 4: `script-host.ts`.** `browserScriptHost(bridge)`: `boot()` creates the worker (`new Worker(new URL('./script-worker.ts', import.meta.url), { type: 'module' })`) and its reply buffer, sends `init`, resolves on `ready`, rejects on `failed` or the worker's `error` event. On `bridge`: `writer.begin(encode(bridge.dispatch(text)))`; on `more`: `writer.more()`. `run(batch)`: one run at a time (a second call queues behind the first); sends `run` with `bridge.roots(call.elementIds)` per call; resolves on `done`. The worker's `error` event rejects the pending run and marks the host dead so the next `boot()` starts a new worker; it never reaches the page's `worker-error`. `csp-violation` from the script worker is re-posted by the engine worker to the page. `dispose()` terminates the worker.
- [ ] **Step 5: Wiring.** `engine-worker.ts` passes `scripts: browserScriptHost` in the deps handed to `createService`. Add the new files to `tsconfig.worker.json` and `tsconfig.test.json`. The script worker's chunk name must not contain `engine-worker`.
- [ ] **Step 6: Browser proof.** `pixi run sandbox-build`, stop any running sandbox preview, then with the bench page of Task 8 not yet present, prove it by hand through Playwright in a scratch script under the session scratchpad (not committed): open the bench page, open the replica, `client.call('scriptCalls', …)` for `def value(els): return len(els[0].outgoing())` over ten ids; assert ten results without error, `boot_ms` reported, zero CSP violations, `crossOriginIsolated` true. Then a script whose hop reply exceeds 1 MiB if the bench model has such an element, else skip and say so. Paste the output in the hand-back.
- [ ] **Step 7:** `pixi run sandbox-test`, `pixi run sandbox-check`, `pixi run dr-tidy`. **README:** `sandbox/README.md` — the script worker, the reply buffer layout, who owns which handle, what a script worker's crash does. **Commit** `Run scripts in a sandbox worker over a shared-memory bridge`.

---

### Task 8: The script-cells bench row, the measurement, documents · `implementer`

**Depends on:** Task 7.

**Files:**
- Modify: `frontend/bench/main.ts`, `frontend/bench/run.ts`, `architecture/constraints.md` (CN-4), `architecture/contracts.md` (CT-6), `architecture/program.md` (D's status), `BACKLOG-ENGINE.md` (`R-3`), `frontend/src/lib/engine/README.md` if it lists engine methods

**Interfaces:**
- Consumes: `scriptCalls` through the real frame and client.
- Produces: `window.bench.scripts(): Promise<Measures>` with labels `script boot`, `10,000 script cells`, `script bridge trips`, `script µs per trip`; budget constant `SCRIPT_CELLS_BUDGET_MS = 2000` in `run.ts`.

- [ ] **Step 1: `scripts()` in `main.ts`.** Collect the first 1,000 element ids of type `Microservice` in page order through the engine's `listElementsPage` (read `engine/src/read/elements.ts` for its params); fail with a clear message when there are fewer. One warm-up `scriptCalls` of one call (its `boot_ms` is `script boot`). Then ten `scriptCalls`, one per script, each with 1,000 one-id calls and `entry: 'value'`; `10,000 script cells` is the wall time of the ten, `script bridge trips` the sum of `trips`, `script µs per trip` the summed `ms` over the trips. Any result with an `error` fails the pass with that error. The ten scripts, each `def value(els):` with this body:
  ```python
  return els[0].name.upper()
  return len(els[0].outgoing())
  return len(els[0].incoming())
  p = els[0].parent(); return p.name if p else None
  return [r.destination().name for r in els[0].outgoing()][:5]
  return sum(len(r.destination().outgoing()) for r in els[0].outgoing())
  return els[0].get('status')
  return ', '.join(sorted(els[0].get('tags') or []))
  e = els[0]; return f'{e.stereotype}:{e.id}'
  return len(els[0].children())
  ```
- [ ] **Step 2: `run.ts`.** Call and `record` `scripts()` in the pass loop before `transitions()`; print the four labels; add the budget verdict for `10,000 script cells` in the manner of the others (printed, never an exit status). If the worker-heap probe no longer finds exactly one `engine-worker` target, make it select by URL and say what the target list showed.
- [ ] **Step 3: Measure.** `pixi run engine-bench-data` if `benchmarks/large.snapshot.v2` is absent; stop any running sandbox preview; `pixi run engine-bench-browser`. Paste the script rows of all three passes and the medians.
- [ ] **Step 4: The verdict.** At or under 2,000 ms: record it and go on. Over: do not tune and do not start a binary layout. Add timing of the split — Python-side `json` (time `_dr_run` with a transport that returns a canned reply), post and wake (trips × a no-op dispatch), dispatch (the Node host's time for the same batch) — report it, and still complete Steps 5–7 with the miss stated.
- [ ] **Step 5: Architecture.** CN-4: a row or note for the cross-worker measurement (setup, date, median, µs per trip), beside the in-worker 2.7 s. CT-6: replace "one trip carries one batched payload" with what holds (one op per trip; replies piggyback projections), and add the reply buffer and the nested-worker ownership. `program.md`: D in progress, plan 1 built, with the measured figure. `BACKLOG-ENGINE.md` `R-3`: the same, and log under a new id each (grep the next free `K-`/`T-` id across both backlog files first) anything Tasks 1–7 reported and did not fix.
- [ ] **Step 6: The full run.** `pixi run dr-test`, `pixi run dr-tidy`, `pixi run frontend-test-e2e`. Expected: pytest, engine and sandbox green; frontend green but for `K-91` if it appears; e2e green but for `T-9`, and `T-11` may flake. Any other failure is this plan's: fix it or report it. Paste each tail.
- [ ] **Step 7: Commit** `Measure script cells across workers`.

---

## After the last task

One `branch-reviewer` pass over the branch against both specs, with this plan's Review Focus. Its findings are fixed or logged. The hand-back leads with the measurement and its verdict, then what the plan left open. The owner decides the merge into `engine-migration`; nothing is pushed.
