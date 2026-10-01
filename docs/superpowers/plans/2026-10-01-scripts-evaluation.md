# Scripts: Evaluation (Plan 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine evaluates tables, navigations and exports that reach a script, over the working copy, by collect-fill-re-run on the script pool, with a cell cache evicted by read-set; the app stays unchanged, and 10,000 script cells through an export meet CN-3's 3 s prewarmed.

**Architecture:**
1. A pass reads scripts through a `ScriptReader` on `EvalContext`: memo, then cell cache; a miss is recorded and reads as the oracle's `pending`. A pass that recorded a miss is discarded.
2. `engine/src/evaluate/fill.ts` loops: run the pass, run the misses as one batch per `(code, entry)` on a `BatchRunner`, record the results, run the pass again. The service drives it with scheduler scans and the pool; the golden replays drive it with `drain` and the Node host.
3. The cell cache lives in the service. Each transition's touched read keys, read on the pre- and post-state, evict it; results of a batch that spanned a transition are not kept.
4. The script sites are ported from the Python oracle: inputs, cells, row build, sort, the navigation step, the export transform, the script-error recap and the transform preview.
5. The `open` option `scripts: 'evaluate'` lifts the `reaches a script` refusals for one replica; only tests and the bench send it.

**Tech Stack:** TypeScript (engine, Node 22), Pyodide 314.0.7, Python 3.14 (oracle, golden scenarios), vitest, Playwright (bench).

**Spec:** `docs/superpowers/specs/2026-10-01-scripts-evaluation-design.md` (decisions `E1`…`E14`), refining `docs/superpowers/specs/2026-09-30-scripts-in-the-browser-design.md` §2, §3 and §10. Plan 2's `S1`…`S18` still hold.

**Read these first:** `CLAUDE.md`; the two specs; `architecture/contracts.md` CT-4 and CT-6; `architecture/conventions.md` (RC-4, RC-6, RC-8, RC-10); `engine/src/service/service.ts:280-1000,1250-1610`; `engine/src/service/scheduler.ts`; `engine/src/evaluate/index.ts`; `engine/src/validation/live.ts:120-160,340-430`; `engine/src/script/host.ts`, `host-error.ts`; `src/data_rover/core/script/embed.py`, `runner.py:280-470`; `src/data_rover/core/table/script_inputs.py`; `src/data_rover/api/invalidation.py`; `tests/golden/scenarios/script_parity.py`; `tests/golden/model_steps.py`; `engine/test/golden/model-steps.ts`; `engine/test/script/parity.ts`.

**What kind of plan this is.** Steps state behaviour, signatures and tests precisely; they do not paste finished code, because the oracle is the specification. Expected results are reasoned from the code at `b5499090`, not observed. Where a step says "confirm", the fact is inferred and the implementer checks it before relying on it.

## What planning found

Checked against the code at `b5499090` by reading; nothing was run.

1. Every refusal sits before an evaluation's first step: `table/route.ts:127`, `navigation/route.ts:107`, `export/route.ts:334,374`, `export/run.ts:130,164`. `scriptCell` throws a plain `Error` for a configured snippet (`table/cells.ts:259-269`). The `snippet.ref !== null` branches in `rows.ts` are reached only by `table_rows` goldens calling row functions directly.
2. `Service.evaluate` (`service.ts:758-783`) submits one model-lane scan whose `run()` rebuilds `EvalContext` on every start; `submit` (`:719-730`) answers from the outcome. A loop needs `scheduler.submit` with its own `done`, as `applyTail` does (`:1516-1545`). `cancel` (`:706-712`) sets `call.cancelled` and runs `call.onCancel` only for calls in `awaiting` (`answerLater`, `:714-717`).
3. After ready, `stage`, `unstage`, `applyDelta` and `applyTail` are model-lane jobs that queue behind a running scan (`service.ts:797-799,1513,1563`; `scheduler.ts:50-60`); only `discard`, `diverge` and opening's control-lane work interrupt one. So transitions land between passes, during a fill. A resubmitted pass joins the model lane's tail.
4. `runScripts` (`service.ts:870-918`) pins `wc` and the epoch, builds a bridge with `bridgeOf(epoch, wc, sharedDispatcher(wc))` (`:825-852`), awaits `host.boot()` and `host.run`, and checks `stillReady` (`:810-815`) after each. `nextEpoch` (`:818-822`) runs only on `discard` and `diverge`; an ordinary transition does not move it.
5. No `BatchResult` reaches `Service.changed` (`:1352-1371`): `stage` returns a `ChangeSet` (`working-copy.ts:419-433`), unstage rewinds and replays (`:815-848`), and a delta's committed part is written by `commit()` without one (`:688-759`). `LiveIssues` captures the pre-state over `wc.touchedIds()` plus the delta's ids (`validation/live.ts:127-159,426-430`) at `moving(wc)` (`service.ts:986`).
6. `Metamodel.elementAncestors(name)` returns the type first, then its ancestors (`metamodel/metamodel.ts:208-210`); `isContainment` is at `:251-253`; containment parents are `ElementRec.parents` (`model/records.ts:22`).
7. Snippet refs are never resolved in the engine (`table/resolve.ts:1-5`, `navigation/resolve.ts:57-65`); `SNIPPET_KIND = 'code_snippet'` is read only by prewarm (`service.ts:296,967-969`) through `artifacts.resolve(id)` (staged first). `tableFetch` (`table/resolve.ts:25-31`) is the pattern. The oracle keeps a dangling ref in place (`core/table/resolve.py:67-79`); a transform source resolves strictly (`api/routes/tables.py:140+`).
8. `progress()` (`service.ts:1332-1339`) holds reports until a slice ends (`:652-656,1341-1346`); a fill runs outside the pump, so it must emit directly. `frontend/src/lib/state/open-journey.ts:33` hard-codes the `ProgressTask` union.
9. Host results are raw `{payload, error, reads, stdout}` texts (`script/host.ts:20-25`). Payloads per entry are validated by `decode_call_payload` (`core/script/runner.py:372-421`), reads by `decode_reads` (`:436-463`); reads are sorted `[tag, id|null]` pairs or `null`. The guest's `json.dumps` allows `NaN` and `Infinity`, so the parse is `parseExact(text, {floatConstants: true})` (AD-26).
10. The arity check is AST-based (`core/script/lint.py:79-88`): the first top-level `FunctionDef` named `value`, positional-only plus positional parameters; `async def` ignored.
11. `script_errors` has no Python count: `table_export_engine.py:855-862` sets a boolean, sent as `X-Table-Script-Errors: true`. The recap (`api/routes/tables.py:773-1040`) caps at `SCRIPT_ERRORS_CAP = 200`; preview-transform (`api/routes/exports.py:613-735`) caps at `PREVIEW_MAX_FILES = 200` and reports a non-deterministic `duration_ms`.
12. Golden: `replaySteps` (`engine/test/golden/model-steps.ts:924-1000`) is synchronous over `drain(EVALUATIONS[m](ctx, params))`. The Python Recorder calls routes with `runner=None` (`tests/golden/model_steps.py:637-772`). `pin_determinism` (`tests/script/trusted_runner.py:55-67`) replaces `datetime.datetime` irreversibly, so scripted oracle runs go in a child process like `script_parity._outcomes` (`:458-484`). `stale()` re-runs every scenario inside pytest. `engine/test/export/reach.test.ts:40` asserts 15 reach cases and `run.golden.test.ts:15` 41 run cases.
13. The server's routes answer a scripted table complete only after their sweep (`api/routes/tables.py:319-470`; sync with `Settings.snippet_sweep_sync=True`, `settings.py:233`). The expand-cell re-derive is a forced cache-only call (`core/table/cells.py:381-400`), so one live context must span build and cells.
14. Bench: `MAX_PAGE_LIMIT = 500` (`read/params.ts:7`). `exportTable` evaluates every cell of its scope in one call. Open is `client.call('open', {project_id, metamodel})` (`frontend/bench/main.ts:144`); `transitions()` diverges the replica last (`main.ts:410-434`), so the new row runs between `scripts()` and `transitions()` (`run.ts:216-219`). `SCRIPT_BODIES` and the 1,000 ids are at `main.ts:441-470`.

## Global Constraints

- The Python core is the oracle: on a mismatch fix the engine, never the fixture. `core/` behaviour does not change (MR-3); golden scenarios and generators may.
- `engine/src/` has no DOM and no Node built-in (RC-4); `.ts` specifiers; `import type` where only types are used; no enums, no parameter properties.
- Wire and result texts are parsed with `parseExact` (with `floatConstants` for harness results), never `JSON.parse` (AD-26).
- Fresh worker per batch stays (S2). One batch per `(code, entry)` per round; a batch is never split.
- Cell cache bounds: 50,000 entries, 32 MB of result text (UTF-16 length × 2 is acceptable as the measure), a result over 64 KiB not stored, a read-set over 128 keys stored as `null`. Cached: values, `runtime` and `syntax` errors. Not cached: `timeout`, `cancelled`, `memory`, `unavailable`, `pending`, `limit`.
- The app does not send `scripts: 'evaluate'`; without it every `reaches a script` refusal answers as today. Prewarm stays off in the sandbox; K-108 is not touched.
- Every evaluation slice stays ≤ 16 ms (CN-3); a fill never runs inside a slice.
- Tests run the real engine and real Pyodide (Node host), no mocks, no fake timers; every pool, host and link is disposed.
- Comments: concise, present tense, no spec, plan or phase references (RC-6). The README and contract that own a behaviour change in the same commit (RC-10).
- Commit messages: imperative sentence, no prefix, ending with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JJkcDfpDCr7rkuG1gy2kUr
  ```

## Review Focus

1. **A snippet edited (staged) while a table using it by `ref` is open.** Expected: the next page re-fills with the new code (new cache key) and the order cache misses (new `orderKey`); no stale value or order. Pinned in Task 7.
2. **An edit staged while a fill runs.** Expected: that round's results enter neither cache nor memo; the evaluation runs again and its answer reflects the staged edit. Pinned in Task 6.
3. **A script that times out on some rows.** Expected: those cells publish as `timeout` errors; the cache keeps none of them; the next evaluation runs them again. Pinned in Task 4 (loop) and Task 7 (cells).
4. **A script column whose input column errors.** Expected: the cell is the synthetic `input 'x': …` error, the guest is never called for it, and nothing is cached for it. Pinned in Task 7.
5. **Cancel, or a replica closed, mid-fill.** Expected: the batches stop (soft, then hard), the call is never answered (cancel) or answers `409 replica closed` (close), the cache gains nothing, and the next evaluation succeeds. Pinned in Task 6.

## File Structure

| File | Responsibility |
|---|---|
| `engine/src/script/result.ts` (create) | `ScriptResult`, `ReadKey`; `parseScriptResult` (ports `decode_call_payload`, `decode_reads`) |
| `engine/src/script/snippets.ts` (create) | snippet fetch from `code_snippet` artifacts; strict transform-source resolution |
| `engine/src/script/arity.ts` (create) | `entryArity(code)` |
| `engine/src/script/cell-cache.ts` (create) | `CellCache`, `cellKey` |
| `engine/src/script/touched.ts` (create) | `touchedKeys` on one state |
| `engine/src/evaluate/fill.ts` (create) | `ScriptReader`, `evaluateFilled`, `BatchRunner` |
| `engine/src/evaluate/index.ts` (modify) | `EvalContext.scripts`, new evaluations |
| `engine/src/service/service.ts`, `types.ts` (modify) | `open`'s `scripts`, cache ownership and eviction, fill driving, `scripts` progress |
| `engine/src/table/{resolve,cells,rows,sort,route}.ts`, `engine/src/table/script-inputs.ts` (create), `script-errors.ts` (create) | table script sites |
| `engine/src/navigation/{resolve,evaluate,route}.ts` (modify) | `_hop_script` |
| `engine/src/export/{route,run,schema}.ts`, `engine/src/export/transform.ts` (create), `preview-transform.ts` (create) | transform, `script_errors`, preview |
| `tests/golden/scripted.py` (create) | the child-process oracle runner for scripted steps |
| `tests/golden/scenarios/{script_decode,script_arity,script_touched}.py` (create); `table_eval.py`, `nav_eval.py`, `export_bytes.py` (modify) | oracle fixtures |
| `engine/test/golden/scripted-steps.ts` (create) | async replay of scripted steps on the Node host |
| `frontend/bench/main.ts`, `run.ts` (modify) | the gate row |

## Dependency order

Tasks 1, 2 and 3 are independent of each other (at most one in a parallel worktree). Task 4 needs 1 and 3. Task 5 needs 4. Task 6 needs 5. Task 7 needs 2 and 6. Tasks 8 and 9 need 7. Task 10 needs 8. Task 11 is last.

---

### Task 1: Parsed results and snippet resolution · `critical-implementer`

**Files:** create `engine/src/script/result.ts`, `engine/src/script/snippets.ts`, `tests/golden/scenarios/script_decode.py`, `engine/test/script/result.golden.test.ts`, `engine/test/script/snippets.test.ts`; modify `engine/src/table/resolve.ts`, `engine/src/navigation/resolve.ts`, `engine/src/export/schema.ts` (or wherever an entry's transform is read), `tests/golden/scenarios/__init__.py`.

**Interfaces — produces:**
```ts
// engine/src/script/result.ts
export type EmbeddedEntry = 'value' | 'step' | 'transform';
export type ReadTag = 'el' | 'out' | 'in' | 'children' | 'parent' | 'scan';
export type ReadKey = readonly [ReadTag, string | null];
export type ScriptErrorKind = 'syntax' | 'runtime' | 'timeout' | 'cancelled' | 'memory' | 'unavailable' | 'pending' | 'limit';
export type ScriptError = { readonly kind: ScriptErrorKind; readonly message: string; readonly traceback: string | null };
export type ValuePayload =
  | { kind: 'scalar'; value: Value } | { kind: 'scalars'; values: Value[] }
  | { kind: 'element'; id: string } | { kind: 'elements'; ids: string[] };
export type StepPayload = { nodes: Value[] };
export type TransformPayload = { kind: 'json'; value: Value };
export type ScriptResult = {
  readonly payload: ValuePayload | StepPayload | TransformPayload | null;
  readonly error: ScriptError | null;
  readonly reads: readonly ReadKey[] | null;
  readonly stdout: string;
};
export function parseScriptResult(text: string, entry: EmbeddedEntry): ScriptResult;
export const PENDING: ScriptResult; // error {kind:'pending', message:'not computed', traceback:null}, reads null
// engine/src/script/snippets.ts
export function snippetFetch(artifacts: ArtifactSet): (ref: string) => { code: string } | null;
export function resolveTransformSource(artifacts: ArtifactSet, transform: EntryTransform, label: string): string; // throws ReadError(422, …)
```
(`Value` is the engine's exact value type from `engine/src/value/`.)

- [ ] **Step 1:** Add a `script_decode` scenario: for every embedded result text in the `script_parity` fixture plus hand-written malformed texts (wrong `kind`, missing `ids`, `reads` with a bad tag, `reads` not a list, a `NaN` scalar), record `{text, entry, decoded}` where `decoded` is `decode_call_payload` and `decode_reads` applied as `_TrustedSession.call` does (`trusted_runner.py:231-265`), a malformed payload becoming the `runtime` "malformed … payload" error. Register it; run `pixi run golden-fixtures`.
- [ ] **Step 2:** Write `result.golden.test.ts`: `parseScriptResult(text, entry)` equals `decoded` for every case (compare through the engine's `pyDumps`). Run `pixi run engine-test` — expected FAIL (module missing).
- [ ] **Step 3:** Implement `result.ts`. Run — expected PASS.
- [ ] **Step 4:** Write `snippets.test.ts` against the oracle's rules (`core/table/resolve.py:67-79`; `api/routes/tables.py:127-200`): a table column's `{ref}` resolves to `{ref: null, definition}` from a committed snippet and from a staged one (staged wins); a dangling ref and a ref to a non-snippet artifact stay as `{ref}`; a navigation script step resolves the same way, inside set-op operands too; `resolveTransformSource` answers the code, and a 422 whose detail is the oracle's text for each failure (missing, wrong kind, empty, unresolvable entry). Confirm `orderKey` (`table/order-cache.ts:51-57`) of a resolved table now differs when the snippet's code differs — assert it.
- [ ] **Step 5:** Implement `snippets.ts` and the resolution in `table/resolve.ts` and `navigation/resolve.ts` (rewrite the header comment that says refs are left in place). `tableHasScript` and `navigationHasScript` keep answering true for a resolved definition. Run `pixi run engine-test` — expected PASS, and every existing golden family still PASS (refs to absent snippets stay; the gates are unchanged).
- [ ] **Step 6:** `pixi run engine-check`, `pixi run dr-tidy`. Commit: "Parse script results and resolve snippet refs in the engine".

### Task 2: The arity scanner · `implementer`

**Files:** create `engine/src/script/arity.ts`, `tests/golden/scenarios/script_arity.py`, `engine/test/script/arity.golden.test.ts`.

**Interfaces — produces:** `export function entryArity(code: string, name?: string): number | null` (default `name` `'value'`), answering exactly what `core/script/lint.py:79-88` `entry_arity` answers, `null` where it answers `None` (no such function, a syntax error).

- [ ] **Step 1:** Add `script_arity`: a corpus of ~40 code strings, each recorded with `entry_arity(code)`: zero to three parameters; defaults holding commas, parentheses, brackets, strings with `)` and `#`; type annotations; `/` and `*` markers; `*args`, `**kw`; a multi-line signature; decorators; a nested `def value` inside a class or another function (not top level); a second top-level `def value` (the first wins); `async def value`; `def value` inside a triple-quoted string; a comment line `# def value(a, b)`; tabs; a syntax error elsewhere in the file; CRLF line endings; non-ASCII names. Register; regenerate.
- [ ] **Step 2:** Write `arity.golden.test.ts` — every case equal. Run — expected FAIL.
- [ ] **Step 3:** Implement a scanner: a tokenizer that skips comments and every string form (single, triple, prefixed), tracks bracket depth and indentation at line starts, finds the first `def <name>(` at column 0 outside strings, and counts parameters before `*`, `**` or a bare `*` (positional-only ones before `/` included). Where the oracle answers `None` because the file does not parse, the scanner cannot tell in general: for the corpus's syntax-error cases, confirm what the oracle answers and make the scanner agree on them, then record in the file's doc comment that a file that does not parse may be answered differently and that the call itself then fails with the guest's `syntax` error. Run — expected PASS.
- [ ] **Step 4:** `pixi run engine-check`, `dr-tidy`. Commit: "Scan a snippet's entry arity, held to the oracle".

### Task 3: The cell cache and touched read keys · `critical-implementer` · `critical-reviewer`

**Files:** create `engine/src/script/cell-cache.ts`, `engine/src/script/touched.ts`, `tests/golden/scenarios/script_touched.py`, `engine/test/script/cell-cache.test.ts`, `engine/test/script/touched.golden.test.ts`.

**Interfaces — consumes:** `ScriptResult`, `ReadKey` (Task 1). **Produces:**
```ts
// cell-cache.ts
export type CellKey = string; // pyDumps([code, entry, elementIds, inputsText, docText])
export function cellKey(code: string, entry: EmbeddedEntry, elementIds: readonly string[], inputsText: string | null, docText: string | null): CellKey;
export function readKeyText(key: ReadKey): string; // 'tag\u0000id', null id as 'tag\u0001'
export type CellCacheLimits = { entries: number; bytes: number; entryBytes: number; reads: number };
export const CELL_CACHE_LIMITS: CellCacheLimits; // 50_000, 32 MiB, 64 KiB, 128
export class CellCache {
  constructor(limits?: CellCacheLimits);
  get(key: CellKey): ScriptResult | undefined;   // marks recently used
  put(key: CellKey, result: ScriptResult, text: string): void; // applies the cacheable-kind, size and reads rules
  evict(touched: ReadonlySet<string>): number;   // entries whose reads intersect, or are null
  clear(): void;
  get size(): number; get bytes(): number;
}
// touched.ts
export type TouchedIds = { elementIds: Iterable<string>; relationshipIds: Iterable<string> };
/** `touched_keys`'s rules over one state, for the ids present in it; absent ids add nothing. */
export function touchedKeys(model: Model, metamodel: Metamodel, ids: TouchedIds, into?: Set<string>): Set<string>;
```

- [ ] **Step 1:** Add `script_touched`: on a small model with an inheritance chain and a containment relationship type, apply batches through `_apply_batch` (as `Recorder._batch`, `model_steps.py:891-916`) and record each batch's ops, the ids it touched, and `touched_keys` sorted with a key that orders `None` first. Cases: a property update; an element create; an element delete with incident relationships; a relationship create, update and delete, containment and not; a re-parent (containment delete plus create); a batch mixing them. Register; regenerate.
- [ ] **Step 2:** Write `touched.golden.test.ts`: for each case, compute `touchedKeys` on the model before the batch over the batch's touched ids, apply the batch with the engine's `applyBatch`, compute again on the after model, union. Assert the union ⊇ the oracle's keys, and equal where the case moves no containment. Run — expected FAIL.
- [ ] **Step 3:** Implement `touched.ts` per `api/invalidation.py:47-111`: an element present touches `el`, `children` of each containment parent (`ElementRec.parents`), and `scan` for `None` and every name in `elementAncestors(type)`; a relationship present touches `out` source and `in` target, plus `children` source and `parent` target when `isContainment(type)`. An id absent in the state touches only `el` (elements) or nothing (relationships): its metadata comes from the other state. Run — expected PASS.
- [ ] **Step 4:** Write `cell-cache.test.ts`: LRU order on `get`; the entry cap and the byte cap each evict least recent first; a result over `entryBytes` is not stored; a `timeout`, `cancelled` and `pending` result is not stored, a `runtime` and `syntax` one is; reads over 128 keys are stored as `null` and evicted by any non-empty `evict`; `evict` removes exactly the intersecting entries and every `null` one and returns the count; `clear` empties `size` and `bytes`. Implement; run — expected PASS.
- [ ] **Step 5:** `engine-check`, `dr-tidy`. Commit: "Add the script cell cache and the touched read keys of a transition".

### Task 4: The fill loop · `critical-implementer`

**Files:** create `engine/src/evaluate/fill.ts`, `engine/test/evaluate/fill.test.ts`; modify `engine/src/evaluate/index.ts`, every refusal site in "What planning found" 1, `engine/src/table/cells.ts` (`scriptCell`'s plain `Error`).

**Interfaces — consumes:** Tasks 1 and 3. **Produces:**
```ts
// engine/src/evaluate/fill.ts
export type ScriptCall = { code: string; entry: EmbeddedEntry; elementIds: readonly string[]; inputsText: string | null; docText: string | null };
export type ScriptReader = { read(call: ScriptCall): ScriptResult }; // memo, cache, else records the miss and answers PENDING
export type BatchRunner = (batch: ScriptBatch, signal: AbortSignal) => Promise<readonly string[]>; // one result text per call
export type FillOptions = {
  runner: BatchRunner;
  signal: AbortSignal;
  cache?: CellCache;
  transitions?: () => number;              // a counter that moves on every transition
  onProgress?: (done: number, total: number) => void;
};
export type FillStats = { rounds: number; calls: number };
/** Runs `pass` until a pass records no miss; answers that pass's result. */
export function evaluateFilled<T>(pass: (scripts: ScriptReader) => Promise<T>, options: FillOptions): Promise<{ value: T; stats: FillStats }>;
// engine/src/evaluate/index.ts
export type EvalContext = { …existing; scripts?: ScriptReader };
```

Behaviour:
- `evaluateFilled` keeps a memo stamped with `transitions()`. Before each pass, a moved stamp clears the memo. After a pass with misses, it groups them by `(code, entry)` into `ScriptBatch`es (call order = first-miss order, duplicates once), runs them concurrently, parses each text with `parseScriptResult`, and — only if `transitions()` has not moved since the round began — puts every result in the memo and each cacheable one in the cache. Then the next pass. An aborted `signal` rejects with the abort reason and runs no further pass. `onProgress` reports `(done, total)` in calls as batches finish.
- With no misses on a pass, the answer is that pass's value.
- The gates: every refusal in "What planning found" 1 is skipped when `ctx.scripts` is set. `scriptCell` without a reader answers the route's existing 501, never a plain `Error`.

- [ ] **Step 1:** Write `fill.test.ts` with a toy pass (a generator reading `scripts.read` for a list of calls, then a second list fed by the first's values, so it chains) and a `BatchRunner` over the Node host (`nodeScriptHost()`, a `recording()` bridge as in `engine/test/script/pool.test.ts:13-21`). Cases: a chain of two levels takes 3 passes and 2 rounds; duplicate calls run once; a second `evaluateFilled` with the same cache runs 0 rounds; a `while True` call with a 300 ms call limit (pool limits option) publishes `timeout`, and a second evaluation runs it again (Review Focus 3); a `transitions` counter bumped inside the runner leaves the cache empty and costs one extra round; an abort mid-batch rejects and the pool ends the worker. Without `ctx.scripts`, each gated evaluation still answers `501 reaches a script`. Run — expected FAIL.
- [ ] **Step 2:** Implement `fill.ts`, `EvalContext.scripts` and the gate lift; run `pixi run engine-test` — expected PASS, every golden family unchanged.
- [ ] **Step 3:** `engine-check`, `dr-tidy`. Commit: "Fill script misses and run the pass again".

### Task 5: The navigation script step and the scripted oracle · `critical-implementer`

**Files:** create `tests/golden/scripted.py`, `engine/test/golden/scripted-steps.ts`, `engine/test/navigation/nav.scripted.golden.test.ts`; modify `engine/src/navigation/evaluate.ts`, `tests/golden/scenarios/nav_eval.py`, `tests/golden/model_steps.py`.

**Interfaces — produces:**
- `tests/golden/scripted.py`: `run_scripted(metamodel, steps) -> list[dict]`, which runs `run_steps` in a child (`sys.executable -c`, `PYTHONHASHSEED=0`, `TZ=UTC`, `PYTHONPATH=src:ROOT`, steps on stdin, outcomes on stdout, a non-zero exit raising) with the Recorder given `runner=TrustedRunner(deterministic=True)`, `Settings(snippet_sweep_sync=True)` and a session `ScriptCellCache`. A scripted read step calls its route until the answer holds no pending cell (at most three times, then raises) and records that answer. `script_status` and any `duration_ms` are dropped from the record.
- `engine/test/golden/scripted-steps.ts`: `replayScripted(fixture, host: ScriptHost): Promise<void>`, the async twin of `replaySteps`, running each read through `evaluateFilled` with `pass = (scripts) => Promise.resolve(drain(EVALUATIONS[m]({...ctx, scripts}, params)))` and a `BatchRunner` over `host` with a bridge over the step's model (confirm how `parity.ts` builds one and reuse it).

- [ ] **Step 1:** Write `scripted.py`; confirm in the child that `pin_determinism`'s `datetime` swap does not break the Recorder (run one existing `nav_eval` step through it and compare with the in-process answer).
- [ ] **Step 2:** Add scripted `nav_eval` steps through `run_scripted`: an inline step hopping to related ids; a step returning non-id strings (terminal values), a non-finite float, duplicates across `(type, value)`; a raising step (`NAV_STEP_FAILED`, pruned); a dangling ref (`NAV_SNIPPET_NOT_FOUND`); a ref to a staged snippet; a step inside a set-op operand; two script steps chained. Regenerate.
- [ ] **Step 3:** Write `nav.scripted.golden.test.ts` replaying them on `nodeScriptHost()`. Run — expected FAIL.
- [ ] **Step 4:** Port `_hop_script` (`core/navigation/evaluate.py:395-449`) into `walk()` reading `ctx.scripts` with entry `step`; keep `NavMemo.scripted` bypassing the memo. Run — expected PASS; existing `nav.golden.test.ts` PASS.
- [ ] **Step 5:** `engine-check`, `dr-tidy`. Commit: "Evaluate a navigation's script step in the engine, held to the oracle".

### Task 6: The service: the option, the cache, eviction and progress · `critical-implementer` · `critical-reviewer`

**Files:** create `engine/test/service/script-eval.test.ts`; modify `engine/src/service/service.ts`, `engine/src/service/types.ts`, `engine/src/index.ts`, `engine/test/service/helpers.ts` (`openReplica` takes `scripts`), `frontend/src/lib/state/open-journey.ts` (widen the union), `architecture/contracts.md` (CT-4 `open` and `progress`, CT-6 cache and discard), `engine/README.md`.

**Interfaces — consumes:** Tasks 3, 4, 5. **Produces:**
```ts
// engine/src/service/types.ts
export type OpenParams = { project_id: string; metamodel: unknown; scripts?: 'evaluate' };
export type ProgressTask = 'parse' | 'index' | 'tail' | 'verify' | 'sweep' | 'scripts';
```

Behaviour:
- `open` reads `scripts` (any other value is a 422 before `discard`); the flag lives with the replica. With it, `evaluate` registers the call with `answerLater`, builds a `ScriptReader` per pass inside the scan's `run()` (so a restarted scan gets a fresh one), and drives `evaluateFilled` with a `pass` that submits the scan through `scheduler.submit` and resolves on its `done`; the `BatchRunner` is `runScripts`'s body taking a prepared batch, sharing one `abortable()` per evaluation set as `call.onCancel`. Without the flag, `evaluate` is unchanged.
- The cache: one `CellCache` made at open, cleared at `discard`, `diverge` and close. A `transitions` counter increments in `changed`. At `moving(wc)`, the pre-state keys are computed over `wc.touchedIds()` and the delta's ids (the sets `LiveIssues` reads, `validation/live.ts:127-159`); in `changed`, the post-state keys over the `ChangeSet`; the union evicts.
- Progress: a `scripts` counter summed over every fill in flight, emitted with `this.emit` at each batch result (not `progress()`, which holds until a slice ends), ending `done === total` when the last fill ends.

- [ ] **Step 1:** Write `script-eval.test.ts` over the real service (`connect(host, portPair(), {scripts: nodeScriptHost})`), using `evaluateNavigation` with a script step (Task 5): (a) without `scripts: 'evaluate'` it answers `501 reaches a script`; (b) `open` with `scripts: 'bogus'` is a 422 and the open replica is untouched; (c) a cancel during the fill is never answered and the call's workers end (Review Focus 5); (d) `close` during the fill answers `409 replica closed`, and a new replica evaluates (Review Focus 5); (e) a `stage` sent during the fill lands, the evaluation answers after it with the staged state, and the cache holds nothing from the spanning round (Review Focus 2); (f) `progress {task:'scripts'}` events arrive and end `done === total`; (g) after two evaluations whose calls read different elements, a delta touching one evicts exactly the entries that read it (the next evaluation runs only those calls; count batches through a wrapping factory); (h) a stage and an unstage each do the same. Run — expected FAIL.
- [ ] **Step 2:** Implement; update CT-4, CT-6 and `engine/README.md` (evaluation with scripts, the cache, the option). Run `pixi run engine-test`, `pixi run frontend-check` — expected PASS.
- [ ] **Step 3:** `engine-check`, `dr-tidy`. Commit: "Evaluate scripts in the service behind the open option, with a cell cache evicted by read-set".

### Task 7: Table script columns · `critical-implementer` · `critical-reviewer`

**Files:** create `engine/src/table/script-inputs.ts`, `engine/test/table/table.scripted.golden.test.ts`; modify `engine/src/table/{cells,rows,sort,route}.ts`, `tests/golden/scenarios/table_eval.py`, `engine/test/service/script-eval.test.ts`.

**Interfaces — consumes:** `ScriptReader` (Task 4), `entryArity` (Task 2), resolved snippets (Task 1), the service (Task 6). **Produces:** `resolveScriptInputs` and `evaluateScriptColumn` (ports of `script_inputs.py`'s functions of the same names, same argument order), used by cells and rows.

- [ ] **Step 1:** Add scripted `table_eval` steps through `run_scripted` (one `evaluateTable` page each, plus `previewTableJson` for two): scalar, scalars over the element cap, element, dangling element, elements deduped; a raising cell; a syntax error; inputs of every referenced kind (`script_inputs.py:_resolve_one`), an input whose column errors, an arity mismatch; a chain (script column input from a script column); an expand column (an error giving one `None` row); keep-empty over script values and errors; a sort on a script column; a script row source; a ref to a staged snippet, and the same table after the snippet is staged again with different code (Review Focus 1). Regenerate.
- [ ] **Step 2:** Write the replay test. Run — expected FAIL.
- [ ] **Step 3:** Port `script_inputs.py`, `_script_cell` (`cells.py:338-449`) and the script sites of `core/table/evaluate.py` (`:320-347`, `:663-700`, `:716-753`, `:870-937`, `:1102-1150`) into `script-inputs.ts`, `cells.ts`, `rows.ts`, `sort.ts`. A miss reads `PENDING`, so the oracle's pending paths (sort falling back to build order, the expand re-derive) are what the discarded passes take. Run — expected PASS; `table.golden.test.ts` and `table_rows` PASS.
- [ ] **Step 4:** In `script-eval.test.ts`, over the service: a script table with an edit staged on a row element shows the edited value (working copy); a `timeout` cell is not cached (Review Focus 3); the input-error cell never reaches the host (count batches; Review Focus 4); a sorted-by-script table fills the whole scope and a plain one only its page (count calls). Run — expected PASS.
- [ ] **Step 5:** `engine-check`, `dr-tidy`. Commit: "Evaluate table script columns in the engine, held to the oracle".

### Task 8: Export transforms, `script_errors` and the transform preview · `critical-implementer`

**Files:** create `engine/src/export/transform.ts`, `engine/src/export/preview-transform.ts`, `engine/test/export/scripted.golden.test.ts`; modify `engine/src/export/{route,run}.ts`, `engine/src/evaluate/index.ts` (register `previewTransform`), `tests/golden/scenarios/export_bytes.py`, `engine/test/export/reach.test.ts`, `engine/test/export/run.golden.test.ts`, `architecture/contracts.md` (CT-4).

**Interfaces — produces:** `ExportFileResult.script_errors: boolean`; evaluation `previewTransform {entry}` answering `/exports/preview-transform`'s body minus `duration_ms`.

- [ ] **Step 1:** Add scripted `export_bytes` cases through `run_scripted` (new case-name prefix `script_`, so the `reach_` and run counts stay; if a count still moves, update `reach.test.ts:40` / `run.golden.test.ts:15` to the new totals): CSV and xlsx of a script table, values and errors (`script_errors` true; false when clean); a JSON entry with a transform, jsonl with a transform returning a list and one returning a dict (the error), a raising transform, an over-cap document, a split export with a transform per file; `previewTransform` unsplit and split, its 422s (non-JSON format, none configured, unresolvable, missing table), a failing file among good ones, more than 200 files. Record the server's header as `script_errors`. Regenerate.
- [ ] **Step 2:** Write the replay test. Run — expected FAIL.
- [ ] **Step 3:** Port the transform (`TransformHost`, `table_export_engine.py:134-250`, `_transformed` `:913-924`; size caps as compact `json.dumps` UTF-8 bytes; the error texts) over `ctx.scripts` with entry `transform` and `docText`; set `script_errors`; port preview-transform (`api/routes/exports.py:613-735`). Run — expected PASS.
- [ ] **Step 4:** `engine-check`, `dr-tidy`. Commit: "Run export transforms and the transform preview in the engine".

### Task 9: The script-error recap · `implementer`

**Files:** create `engine/src/table/script-errors.ts`, `engine/test/table/script-errors.golden.test.ts`; modify `engine/src/evaluate/index.ts` (register `tableScriptErrors`), `tests/golden/scenarios/table_eval.py`, `architecture/contracts.md` (CT-4).

- [ ] **Step 1:** Add `tableScriptErrors` steps through `run_scripted` calling `/tables/script-errors`: a clean table (empty), errors in two columns with a script sort (row indexes in the sorted order), more than 200 errors (cap), an expand column error, `offset`/`limit` sent and ignored. Regenerate; write the replay test. Run — expected FAIL.
- [ ] **Step 2:** Port the collector and route body (`api/routes/tables.py:773-1040`): `column_label = header or kind`, `row_eid` the row key's first slot when a string, `SCRIPT_ERRORS_CAP = 200`; no 202 (the fill precedes the answer). Run — expected PASS.
- [ ] **Step 3:** `engine-check`, `dr-tidy`. Commit: "Answer a table's script-error recap from the engine".

### Task 10: The budget gate · `implementer`

**Files:** modify `frontend/bench/main.ts`, `frontend/bench/run.ts`, `BACKLOG-ENGINE.md` (K-100's record gains the row).

- [ ] **Step 1:** In `main.ts`, open with `scripts: 'evaluate'`. Add `scriptTable()`, run between `scripts()` and `transitions()`: an inline table definition, row source `scope` over `['Microservice']` with criteria `[{type:'any_of', criteria: ids.map(id => ({type:'name_id', field:'id', op:'equals', value:id}))}]` (the same 1,000 ids; confirm the criteria reader accepts 1,000 leaves, else report it and stop), ten `script` columns whose inline definitions are `SCRIPT_BODIES` wrapped as the `scripts()` row wraps them, sort by name. Await `scriptWarm`; time `client.call('exportTable', {definition, format:'csv'})` → label `'script table export (10,000 cells)'`; parse the CSV and throw if any cell holds an error text. Then, not gated, report `'script table export (cached)'` (the same call again) and `'script table first page (cached)'` (`evaluateTable`, offset 0, limit 500, after the exports, so its cells are cache hits). Count the `scripts` progress events' fills to report the rounds.
- [ ] **Step 2:** In `run.ts`, add `SCRIPT_TABLE_BUDGET_MS = 3000`, gate the export label, print it on the summary line.
- [ ] **Step 3:** `pixi run sandbox-build`, stop any sandbox preview, `pixi run engine-bench-browser`. Expected: the gated row ≤ 3,000 ms (reasoned: ten batches of 1,000 as in the 2,234 ms `scriptCalls` row, plus two export passes over 1,000 rows). Record the three medians in K-100. If the gate misses, stop and report the split (fill, passes, rounds) to the owner; do not tune.
- [ ] **Step 4:** `pixi run frontend-check`, `dr-tidy`. Commit: "Gate 10,000 script cells through an engine export in the browser bench".

### Task 11: Documents and close · `chores`

**Files:** `architecture/decisions.md` (or wherever `AD-33` lives: add `AD-34`, collect-fill-re-run in the service loop, the gate option until plan 4), `architecture/program.md` (D: plan 3 built, the gate figure), `BACKLOG-ENGINE.md` (note K-108's flood and prewarm as plan 4's; add what this plan leaves open, e.g. the arity scanner on files that do not parse, round passes that fill a page the script sort then moves away from), the program spec's §9 line for plan 3 if it names anything this plan narrowed.

- [ ] **Step 1:** Write the documents from the merged code, not from this plan.
- [ ] **Step 2:** `pixi run dr-test`, `pixi run dr-tidy`, `pixi run engine-scripts-browser` — all PASS. Commit: "Record plan 3 of scripts in the browser".

## After the last task

- `branch-reviewer` over the whole branch (fill loop, eviction, service concurrency, the gate).
- `pixi run frontend-test-e2e` once: the app is unchanged, so failures beyond T-9, T-11, T-12 and T-15 are this branch's.
- The owner decides the merge; nothing is pushed without asking.
