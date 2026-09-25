# Code Execution (Python Snippets) — Design Spec

Date: 2026-07-17
Status: Approved design, pending Milestone 0 spike (go/no-go)

## 1. Overview

Users write Python snippets in the browser to query and edit the model. Snippets
are stored **artifacts** (like saved tables/navigations, placeable in view
folders) and usable three ways:

1. **Standalone scripts** run from a console (query the model, print results,
   propose edits).
2. **Computed columns** in tables (`ScriptColumn`) — sortable, pageable,
   exportable like normal columns.
3. **Steps** in navigation chains (`ScriptStep`) — compose like normal steps.

Edits proposed by a snippet always flow through the existing staged-review-commit
pipeline; a snippet can never mutate the model directly.

### Goals

- Full Python (not an expression subset) for queries and edit-proposals.
- Real isolation: any editor-role user may author snippets; a malicious or
  buggy snippet must not be able to read other projects, the DB, the
  filesystem, or the network, nor take down the API process.
- First-class integration with the existing server-side table/navigation
  evaluators (sorting, paging, xlsx export, per-revision caching all keep
  working).
- Syntax-error and unknown-name linting in the editor; a console to
  run/debug/preview.

### Non-goals (v1)

- Third-party packages (numpy/pandas/networkx). Pure Python + stdlib allowlist
  + the `dr` facade only.
- Read-your-own-writes inside a run (reads always reflect the committed model;
  recorded ops are write-only).
- Streaming console output (buffered-then-returned in v1; streaming via the
  existing WS feed is a later nicety).
- Browser-side execution (Pyodide). The facade is specified so a client
  runtime could be added later without changing snippet code.
- Snippets invoking table/navigation evaluation from inside `dr` (no
  `dr.navigate(...)` in v1 — prevents recursive evaluation).
- Any admin-console surface for snippets; they are ordinary artifacts
  governed by ordinary project roles.

## 2. Decisions already made (with rationale)

| Decision | Choice | Why |
|---|---|---|
| Trust model | Semi-trusted users, defense in depth | Authenticated members, but real isolation required |
| Write semantics | Snippets emit **staged ops**, never direct mutations | Reuses preview/validation/locks/commit; nothing bypasses review |
| API surface | Curated `dr` facade only | Stable contract, lintable, sandboxable; core internals stay private |
| Libraries | Pure Python + stdlib allowlist | Simplest/safest sandbox; covers query/edit use cases |
| Embedded call shape | Per-element functions `value(el)` / `step(el)` | Natural to write; engine controls batching, caps, ordering |
| Infra budget | WASM runtime in-process (no Docker/root) | pixi-installable, strong isolation by construction |
| Architecture | **A: server-side WASM runner** (vs. browser Pyodide, vs. hybrid) | Embedding lives inside the server-side evaluators; data locality for ~80 MB models |

Alternatives considered and rejected:

1. **Pyodide in the browser** — perfect isolation and a true local REPL, but
   snippet columns can't be server-sorted/exported, nav steps don't compose
   into server-side evaluation, and facade reads become chatty HTTP paging.
2. **Two-tier "Excel pattern"** — a safe AST-interpreted expression subset
   server-side for columns/steps + full Pyodide console client-side. Solid
   **fallback** if the spike fails, but a permanent two-dialect seam and a
   security-critical hand-rolled interpreter.
3. **Container/OS-level isolation** — strongest isolation but heavy ops for a
   self-hosted single-process app, and the in-memory model would need an IPC
   bridge anyway.
4. **Unsandboxed in-process `exec` for "trusted" deployments** — RCE by
   design; rejected outright.

## 3. Artifact schema & storage

A snippet is a new artifact kind, reusing the entire existing artifact
machinery (CRUD routes, optimistic `artifact_rev`, feed events, view placement,
workspace tabs).

- `ArtifactKind.code_snippet` added to the enum in
  `src/data_rover/api/db_models.py`; a `SNIPPET_ADAPTER` entry added to
  `_PAYLOAD_ADAPTERS` in `src/data_rover/api/routes/artifacts.py`.
- Payload schema `SnippetDefinition` in a new `src/data_rover/core/script/schema.py`
  (mirroring `core/table/schema.py`):

  ```
  SnippetDefinition {
    schema_version: 1,
    language: "python",          # fixed in v1
    code: str,                   # max length: settings.snippet_max_code_bytes (default 64 KiB)
    entry_points: list[str],     # derived: subset of ["script", "value", "step"]
  }
  ```

- **A snippet is just code; its roles are determined by which entry points it
  defines.** `def value(el)` ⇒ usable as a table column; `def step(el)` ⇒
  usable as a navigation step; every snippet is runnable standalone
  (`"script"` is always present). One snippet may define both functions.
- `entry_points` is **derived metadata**: the artifact create/update routes
  recompute it from the AST (`ast.parse` + top-level `def` scan + arity check)
  on every write, so pickers (ColumnManager, nav step editor) can filter
  artifact listings without fetching payloads. Client-supplied values are
  ignored/overwritten.
- **`entry_points` is advisory, never trusted at evaluation time.** For saved
  artifacts it is server-derived; for **inline** definitions
  (`SnippetSource.definition` arriving inside a table/nav payload) it is
  client-supplied shape-validated data whose `code` may not even parse. The
  evaluator always resolves the entry function at runtime and treats a
  missing/broken entry as an error cell / pruned chain (dangling-ref-style
  graceful degradation), regardless of what `entry_points` claims.
- Adding the enum member requires a small **Alembic migration** widening the
  `ArtifactKind` CHECK constraint (`native_enum=False` VARCHAR+CHECK; follow
  the existing migration precedent).
- Snippets referenced from views render as ordinary `'artifact'` nodes in the
  view tree; `scrubArtifactFromView` handles deletion — no new view code.

### Table integration (schema)

New `Column` variant in `core/table/schema.py`:

```
ScriptColumn {
  kind: "script",
  source: ColumnSource,          # RowSlot | ColumnRef, same as other columns
  snippet: SnippetSource,        # { ref? | definition? } — at most one, {} legal-unconfigured
  mode: collapse | expand,
  keep_empty, header, hidden, width_px   # same as sibling columns
}
```

`SnippetSource` copies the `NavigationSource` ref-or-inline pattern exactly
(`ref` = saved snippet artifact id; `definition` = inline `SnippetDefinition`).

### Navigation integration (schema)

New `StepItem` variant in `core/navigation/schema.py`:

```
ScriptStep { kind: "script", snippet: SnippetSource, comment? }
```

Behaves like `RelationshipStep`: consumes the frontier, produces the next
frontier, contributes **one chain column**. `exclude_visited` applies.

## 4. Execution architecture

### Runtime

CPython compiled to WebAssembly/WASI (official CPython-WASI build, pinned by
version + SHA-256), executed by the `wasmtime` Python package **inside the
existing API process**. The guest has no filesystem, no network, no
environment, no host-memory access; its only capability is the bridge channel
we provide. Users supply Python **source text**, never WASM — the only
compiled module is our CPython build, so untrusted input never reaches
wasmtime's compiler (escape surface is limited to runtime memory-safety bugs
in a Rust codebase).

### Layering seam: the `ScriptRunner` protocol

`core/` must stay free of the wasmtime dependency, yet the table/nav
evaluators (core) must invoke snippets. Therefore:

- `src/data_rover/core/script/runner.py` defines the **protocol**:

  ```
  class ScriptRunner(Protocol):
      def run(code, entry, inputs, limits, bridge) -> RunResult: ...
      # plus an EvaluationHandle for repeated value(el)/step(el) calls
      # within one instance lifetime (one per table/nav evaluation)
  ```

  `RunResult { stdout, result_repr, ops, error, duration_ms, truncated }`.
- `src/data_rover/api/script_runner.py` implements `WasmScriptRunner`
  (wasmtime + CPython-WASI + pool). Routes inject it into `tables/evaluate`,
  `navigations/evaluate`, and the snippet run route.
- Tests inject a `TrustedRunner` (plain in-process `exec` against the same
  bridge interface) for fast hermetic tests — the same seam pattern as
  `MemorySnapshotStore` vs `GcsSnapshotStore`. A few `integration`-marked
  tests exercise the real WASM runtime.
- **Production tripwire**: `TrustedRunner` lives under `tests/` (not in the
  shipped package), and if runner selection is ever exposed as a setting, a
  boot-time guard refuses `trusted` unless `dev_seed` is on — the
  `_guard_prod_secret` pattern. A one-line misconfiguration must not be an
  RCE.
- The seam doubles as the **runtime swap point**: if wasmtime-py disappoints,
  a Pyodide-in-Node sidecar speaking the same protocol is a drop-in
  replacement, not a redesign.

### Worker lifecycle

- A small pool (default 2) of **pre-booted** WASM interpreter instances hides
  the ~100–300 ms interpreter boot. The pool refills from a background thread,
  never on the request path. The pool is deliberately smaller than the
  concurrency cap (§9): under burst, runs beyond the warm supply pay the
  cold-boot latency — accepted, since keeping `semaphore`-many resident
  interpreters costs real memory for a rare win.
- **One instance per run, discarded afterwards** — zero cross-run state.
- "One run" granularity: for a table/nav evaluation, the module executes once,
  then the engine calls the entry point per row/frontier element over the
  bridge within that same instance. Never one boot per cell.
- The compiled module and wasmtime `Engine` are created once at startup and
  shared; only the `Store`/instance is per-run.
- Runs execute on **worker threads**, never the event loop (the host side of
  the bridge blocks). The Milestone 0 spike must verify wasmtime-py releases
  the GIL during guest execution; if it does not, that is a no-go for the
  in-process design (fallback: runner in a dedicated subprocess speaking the
  same protocol).

### The bridge

Length-prefixed JSON-RPC over the guest's stdin/stdout (or, if wasmtime-py's
stdio plumbing cannot do interactive blocking round-trips — a spike question —
an equivalent host-mediated channel).

- Guest-side `dr` facade serializes calls; the host dispatcher answers
  **read-only** from the session's live `Model`/`IndexSet` (µs-to-ms per call,
  in-process).
- **Reads are batched/paged by design** (default 500 elements per frame):
  guest-side Python under WASM is 2–5× slower than native and each round-trip
  costs real time, so `dr.elements()` etc. must page — this is load-bearing
  for the 50k-row target, not an optimization.
- The dispatcher enforces frame-size and page-size caps (protects **host**
  memory) and never waits on anything that could wait on the run (deadlock
  discipline). User `print()` output is captured guest-side into a buffer and
  returned in the protocol, never interleaved with protocol frames.

### Concurrency & consistency

- A semaphore caps simultaneous runs (default 4) with a bounded queue; when
  the queue is full, the API returns 429. A per-user cap (default 2) prevents
  one user monopolizing all slots.
- Snippet runs are read-only server-side and take no locks and never touch
  `write_mutex` (same stance as `tables/evaluate`).
- **Torn-read stance**: a run records `model_rev` at start and end; a mismatch
  marks the result `stale` (console shows a warning; table/nav evaluation
  retries once, then serves with the stale flag).
- **Eviction during a run**: the dispatcher holds direct references to the
  `Model` object, so an eviction mid-run cannot dangle (refcount keeps the
  object alive); a run does **not** block eviction (unlike live locks or feed
  clients). The run completes against the pre-eviction object; its `stale`
  flag covers the semantics.

### Determinism (design guarantee, spike-verified)

**Same code + same `model_rev` ⇒ same output.** This makes per-revision
caching sound by construction and is actively enforced, not assumed:

- WASI `clock_time_get` stubbed to a fixed wall-clock epoch (monotonic clock
  may advance if the interpreter needs it to boot); `datetime` stays in the
  import allowlist for parsing/arithmetic, and `datetime.now()`/`time.time()`
  return the fixed epoch — documented.
- WASI `random_get` backed by a fixed seed; `PYTHONHASHSEED` pinned.
- No network/filesystem exists to smuggle nondeterminism in.

## 5. The `dr` facade

A guest-side pure-Python module injected into the sandbox — the **only**
documented API, versioned independently of core internals
(`dr.__api_version__`).

### Reads (served over the bridge; batched/paged transparently)

- `dr.element(id) -> Element | None`
- `dr.elements(type=None) -> Iterator[Element]` — lazy, paged; `type` matches
  subtypes via the metamodel caches.
- `Element` handle: `.id`, `.type`, `.name`, `el["prop"]` / `.get(prop, default)`,
  `.props() -> dict`, `.out(rel_type=None)` / `.in_(rel_type=None)` →
  `list[Element]`, `.rels(direction=None, type=None)` → `list[Relationship]`,
  `.parent() -> Element | None`, `.children() -> list[Element]`.
- `Relationship` handle: `.id`, `.type`, `.source`, `.target`, `.props()`,
  `r["prop"]`.
- Metamodel introspection: `dr.types() -> list[str]`,
  `dr.type(name) -> TypeInfo` (effective properties, so scripts can be
  metamodel-generic).

### Writes — always dry-run

- `dr.create(type, props=None) -> Element` (temp-id handle),
  `el.set(prop, value)`, `el.delete()`,
  `dr.connect(rel_type, source, target) -> Relationship`,
  `dr.disconnect(rel)`.
- No `parent=` convenience on `dr.create` in v1: containment is a
  relationship in this metamodel, and auto-resolving *which* containment
  relationship type applies is ambiguous. Users connect explicitly:
  `dr.connect("Owns", parent, child)`.
- These **record ops in the `ops.ts` wire format** and never touch the model.
  Temp ids follow the same temp-id convention the staged buffer already uses.
- Reads do **not** see pending writes (explicit v1 limitation, documented in
  the facade docs).
- In embedded contexts (column/step) the write functions raise
  `dr.ReadOnlyError` immediately.

### Entry points & output

- Standalone: the module body runs top-to-bottom; `print()` → captured stdout;
  optional `result = ...` is repr'd back to the console.
- Column: `def value(el): ...` returns a scalar, a list of scalars, an
  `Element`, or a list of `Element`s.
- Step: `def step(el): ...` returns an iterable of `Element`s (or ids).

## 6. Embedding semantics

### Table `ScriptColumn`

- The engine calls `value(el)` per row binding within one instance per
  evaluation. Return-value mapping: scalar → `ValueCell`; list of scalars →
  `ValuesCell` (collapse/expand modes apply as for property columns);
  `Element`(s) → `ElementCell`/`ElementsCell` (chainable via `ColumnRef` like
  navigation columns).
- **Cache-poisoning guard**: budget-truncated or stale-flagged evaluations
  **never populate the row-order cache** — only complete, non-stale
  evaluations are cached. (Sorting by a script column orders on computed
  values; caching a partially-errored order under `(code hash, model_rev)`
  would serve a garbage order indefinitely, since neither key changes on
  retry.)
- **Per-cell errors**: an exception in `value(el)` becomes an **error cell**
  (new `ErrorCell` variant in the cell schema: `{ kind: "error", message }`,
  full traceback available on hover via the cell payload). The evaluation
  continues; the table renders.
- **Sorting/paging/export work unchanged** because values are computed
  server-side. The row-order cache fingerprint gains the **SHA-256 of the
  resolved snippet code** (refs inlined first, mirroring
  `_resolve_table_navigation_refs`) alongside `model_rev`. Hash-of-code, not
  `artifact_rev`: inline definitions have no rev, and a rev bump without a
  semantic change (rename) must not invalidate the cache.
- **xlsx export** includes script columns under the same total-time budget;
  cells past budget are written as error markers and the workbook carries a
  truncation notice. Export never runs unbudgeted.

### Navigation `ScriptStep`

- `step(el)` returns elements/ids; the engine validates existence, dedups,
  applies `exclude_visited`, and contributes one chain column. The column's
  `step_types` is the union of observed result types.
- **Per-element errors prune that chain with a warning** (mirroring how a
  property step treats a missing property); they do not abort the navigation.
  Warnings are surfaced in the evaluation response.

### Budgets

- One **total time budget per top-level request** (default 30 s), shared by
  all snippet work it transitively triggers — a `ScriptStep` inside a
  navigation used by a `NavigationColumn` inside a table draws from the same
  budget, never multiplies it. Budget exhaustion errors the remaining
  cells/chains, not the request.

## 7. Console, routes & run flow

### Routes (project-scoped, under `/api/v1/projects/{project_id}`)

- `POST /snippets/run` — `{ run_id, code | ref, entry?: "script"|"value"|"step",
  element_id? }` → `{ run_id, stdout, result_repr, ops[], error?, duration_ms,
  model_rev, stale, truncated }`. `run_id` is a **client-generated** UUID so
  the Stop button can reference the run while the request is still in flight. `element_id` binds `el` for `value`/`step`
  test runs (mirrors the navigation editor's per-node preview). Read-only
  server-side ⇒ added to the `authz` read-only-POST allowlist; viewers may
  run (their staged ops simply cannot commit — role check at commit as today).
- `POST /snippets/lint` — `{ code }` → `{ diagnostics: [{line, col, severity,
  message}], entry_points }`.
- `POST /snippets/cancel` — `{ run_id }`. Cancels by setting the run's store
  epoch deadline to zero (the engine-wide ticker thread traps it within one
  tick) **and** closing the bridge channel (a guest blocked on a bridge read
  is not executing WASM and cannot see the epoch trap). **Cancellation is
  bound to the run's owner**: only the user who started the run may cancel
  it; anyone else gets 404 (run ids are client-generated and must not be a
  kill capability for other members' runs).

### Frontend

- **Snippet workspace tab**: CodeMirror 6 editor (new dependency; Python
  language mode, diagnostics gutter fed by the debounced ~300 ms lint
  endpoint) above a console panel.
- **Console panel**: Run (Ctrl+Enter) / Stop buttons, stdout + `result` pane,
  error pane with traceback mapped to editor lines, and an **ops preview
  list** with a "Stage ops" button that pushes the returned batch into the
  existing staged-edits buffer — from there it is the normal
  review/preview/commit flow, indistinguishable from manual edits (including
  client-side undo and lock acquisition).
- **Element-context picker** for testing `value`/`step` against a chosen
  element.
- `artifacts.svelte.ts` gains `createCodeSnippetArtifact`; the sidebar library
  lists snippets with entry-point badges; ColumnManager and the nav step
  editor offer snippet pickers filtered by `entry_points`.
- **No one-click execution of someone else's code**: the only run affordance
  is inside the editor tab, which shows the code. View-tree and library rows
  open the editor; they never run directly. (Deliberate; see §9.)

## 8. Linting

Server-side, single source of truth, so diagnostics match the executor
exactly:

1. `ast.parse` → syntax errors with line/col.
2. Scope-aware name-resolution walk → "unknown name" for anything not in
   (builtins allowlist ∪ `dr` API ∪ names defined in the module). Severity:
   **warning**, never blocking save or run — Python scope analysis has honest
   false positives (conditionally-defined names, comprehension scoping).
   Syntax errors are the only blocking diagnostics.
3. **Import allowlist**: `re, math, itertools, collections, functools, json,
   statistics, datetime, string`. Anything else → "not available in the
   sandbox" diagnostic, **and** blocked at runtime by a guest-side import
   hook (lint and runtime agree by construction). Docs state what is absent
   under WASI regardless of allowlist: `threading`, `socket`, `subprocess`,
   file I/O.
4. Entry-point signature checks (`value`/`step` must take exactly one
   positional argument).

The same pass computes `entry_points` on artifact save (§3).

## 9. Security model

- **Capability model, not wall-building**: the guest's only capability is the
  bridge; there is no filesystem, network, or syscall surface to harden.
- **Stored-code trust**: a snippet written by user A executes when user B
  opens a table containing it, or runs it from the console. Snippets always
  run with the **runner's** privileges and project scope, never the author's;
  proposed ops commit as the runner through the runner's role check.
  Column/step execution is read-only by construction; standalone execution
  requires opening the editor (code visible) — no one-click execution of
  others' scripts.
- **Limits** (all settings-configurable, defaults shown):

  | Limit | Default | Mechanism |
  |---|---|---|
  | Console run timeout | 10 s | epoch interruption + host-side deadline that closes the channel |
  | Per-request evaluation budget | 30 s | shared budget (§6) |
  | Guest memory | 256 MB | wasmtime store limits |
  | stdout | 256 KB | guest-side buffer cap |
  | `result_repr` | 64 KB | guest-side cap when repr'ing `result` (a huge materialized list must not blow past the stdout cap via repr) |
  | Recorded ops | 1000 ops / 1 MB | host dispatcher |
  | Bridge frame / page size | 1 MB / 500 elements | host dispatcher |
  | Concurrency | 4 total, 2 per user | semaphore, bounded queue → 429 |
  | Snippet code size | 64 KiB | artifact route validation |

- **Two-sided deadlines everywhere**: epoch traps only fire while WASM
  executes; every timeout/cancel path also closes the bridge channel so a
  guest blocked on a read dies too.
- **Audit trail**: one structured log line per run — user, project, snippet
  ref/hash, duration, op count, outcome. (A `snippet_runs` DB table is
  deliberately deferred; the log is grep-able the day someone stages a
  10k-op edit.)

## 10. Error handling summary

| Failure | Behavior |
|---|---|
| Syntax error | Lint diagnostic; run returns structured error without booting sandbox |
| Runtime exception (standalone) | Traceback stripped to guest frames, file `<snippet>`, lines map to editor |
| Runtime exception (column cell) | Error cell; evaluation continues |
| Runtime exception (nav step) | Chain pruned with warning; navigation continues |
| Timeout / cancel | Epoch trap + channel close; structured "timed out"/"cancelled" error |
| Budget exhausted (table/nav/export) | Remaining cells/chains error-marked; response carries truncation notice |
| Queue full | 429 with retry hint |
| Dangling `SnippetSource.ref` | Mirrors dangling navigation refs: column errors gracefully / step prunes; view refs render as missing artifact nodes; `scrubArtifactFromView` on delete |
| Shared snippet edited | Referencing tables/navs recompute on next evaluation (code-hash fingerprint invalidates cache); artifact feed event prompts open editors/tables to refetch |
| Concurrent commit during run | `stale` flag (§4 torn-read stance) |
| Mid-batch op failure at commit | Unchanged: existing preview/commit flow owns validation and rollback |

## 11. Packaging & operations

- **Guest binary**: official CPython-WASI build, pinned version + SHA-256,
  fetched at build time into the pixi environment (vendoring in-repo is the
  fallback if fetch-at-build proves awkward). Stdlib bundle pruned to the
  allowlist + interpreter essentials. License: PSF, redistributable.
- **wasmtime** rides in via pip-inside-pixi (spike verifies).
- New settings (all in the existing settings module, `DATA_ROVER_*` env):
  pool size, semaphore/queue sizes, per-user cap, all limits in §9,
  `snippet_max_code_bytes`.
- Sandbox boot, pool refill, run outcomes, and kill events are logged.

## 12. Milestone 0 — go/no-go spike (2–4 days)

Prove, in order:

1. CPython-WASI boots under `wasmtime-py` (pixi-installed) and runs a script.
2. **Interactive blocking stdio round-trip** guest↔host works (the single
   highest technical risk; wasmtime-py stdio has historically been
   file/inherit-oriented).
3. **GIL released** during guest execution (else: subprocess runner fallback).
4. Epoch interruption kills `while True` cleanly; store memory cap enforced.
5. Determinism stubs work (fixed clock/random/hashseed) and the interpreter
   still boots.
6. Warm-pool run latency acceptable (~≤300 ms console round-trip).
7. 50k-element batched-read benchmark: a trivial `value(el)` column over 50k
   rows within the 30 s budget.
8. Packaging: pinned CPython-WASI artifact + stdlib bundle reproducible in CI.

**Fallbacks if no-go**: (a) restricted AST-interpreted expression subset for
columns/steps + Pyodide console client-side (the "Excel pattern"); (b)
Pyodide-in-Node sidecar implementing the same `ScriptRunner` protocol. The
artifact schema, facade spec, lint, and frontend work survive either fallback.

## 13. Testing strategy

- **Core**: `SnippetDefinition`/`ScriptColumn`/`ScriptStep` schema validation;
  facade↔bridge protocol units; table/nav evaluation with script
  columns/steps via `TrustedRunner` (hermetic, fast); budget, error-cell, and
  chain-prune semantics; fingerprint invalidation on code change.
- **API**: run/lint/cancel route tests with `TrustedRunner` injected
  (hermetic, in-memory SQLite as today); authz (viewer can run, cannot
  commit); ops-cap and 429 paths; `entry_points` recomputation on artifact
  save.
- **Integration-marked** (opt-in, like the GCS emulator test): real WASM
  runtime — timeout kill, memory cap, import blocking, determinism stubs,
  cross-run isolation.
- **Frontend**: vitest + MSW — editor diagnostics rendering, console
  run/stop, ops preview + "Stage ops" into the staged buffer; picker
  filtering by `entry_points`.
- **E2E (Playwright)**: create snippet → lint → run → stage ops → preview →
  commit; add a snippet column to a table and see computed cells, an error
  cell, and sorting; snippet step inside a navigation.

## 14. Milestones

- **M0** — spike (§12), go/no-go.
- **M1** — artifact kind + payload adapter + editor tab (CodeMirror) + lint
  endpoint + console run/cancel with op recording + "Stage ops" integration.
  Standalone snippets fully usable.
- **M2** — `ScriptColumn`: schema, evaluator integration, error cells,
  fingerprint, export budget, ColumnManager UI.
- **M3** — `ScriptStep`: schema, evaluator integration, chain-prune
  semantics, nav editor UI.
- **M4** — polish: facade docs panel in the editor, example snippets, audit
  log review, per-user fairness tuning.
