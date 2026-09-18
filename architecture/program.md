# Program

Six sub-projects, built in order. Each gets its own spec → plan → build cycle, chained by
handoff. Specs and plans are local working files (RC-9); decisions that outlive a sub-project
are promoted into this directory.

## Status

| # | Sub-project | Status |
|---|---|---|
| — | Program design (this directory) | approved 2026-09-18 |
| A | Engine foundation | not started |
| B | Replica and frontend seam | not started |
| C | Evaluation | not started |
| D | Scripts in the browser | not started |
| E | Headless host | not started |
| F | Thin server and deploy | not started |

`BACKLOG.md` gets one roadmap entry for the program in sub-project A's plan.

## Sub-projects

Budgets are CN-3, at model M.

### A · Engine foundation
**Scope.** The engine package: value model with exact JSON parse and serialize (AD-21),
metamodel caches (AD-22), record-graph store and indexes (AD-20), op applier with inverses,
working copy for the model family (CT-5), snapshot open (CT-1), delta apply (CT-2), digest
(CT-3). The golden-fixture harness (CT-7). The Python snapshot v2 codec and digest.
**Replaces.** `core/model` (without `change_request.py`) and the lookup half of
`core/metamodel` (≈ 2.5k lines of Python), plus the model-op applier in `api/routes/ops.py`.
**Built as four plans**, each leaving `main` green: (1) package, value layer and the
golden-fixture pipeline; (2) Python snapshot v2 and digest, metamodel, store, indexes and
mutation boundary; (3) op applier and working copy; (4) snapshot reader, digest, benchmarks.
**Done when.** Fixtures for model, metamodel, ops, inverses and working copy pass in Node;
open meets budget (CN-3).

### B · Replica and frontend seam
**Scope.** Sandbox page and engine worker; shell (snapshot descriptor route, tail route, feed
buffering, IndexedDB cache, re-bootstrap); `prev_rev` and digest on the current server; the
server's snapshot writers switch to v2; engine client behind `lib/api`; the read surfaces —
element pages, tree, search, neighborhoods, summary. `frontend/src/lib/state/model.svelte.ts`
becomes a view over the engine.
**Depends on.** A.
**Done when.** Those surfaces are served by the engine by default; cold open and heap meet
budget; divergence recovery is exercised by a test.

### C · Evaluation
**Scope.** Navigation, search criteria, tables (evaluate, sort, layouts, JSON/CSV/JSONL/xlsx,
split, naming, manifest), the six validators, custom rules and their reach analysis, issues,
compare / apply-CR, save / download, metamodel diff and rebind preview (validate the working
copy under a candidate metamodel), history Compare, view placement warnings
(`validate_view`). Artifacts enter the working copy.
**Replaces.** `core/table`, `core/validation`, `core/navigation`, `core/search`,
`core/model/change_request.py`, `core/metamodel/diff.py`, `core/view/validation.py`
(≈ 8.5k lines).
**Depends on.** B.
**Done when.** Evaluation sees staged edits and staged artifacts; the table budget is met;
export fidelity per CT-7.

### D · Scripts in the browser
**Scope.** Script worker pool, facade, bridge (CT-6), interrupt and timeout, determinism shims,
engine cell cache with read-set eviction, snippet console `run`, Pyodide prewarm. Snippet
`lint` and `format` read no model and stay server routes. Removes `pending` cells, status
polling and 202 retries from the frontend.
**Depends on.** C.
**Done when.** The script-cell budget is met; a runaway script is stopped with the replica
intact; identical code gives byte-identical output in both hosts' test runs.

### E · Headless host
**Scope.** Node service (engine + Pyodide), request contract, isolation (CN-20), the server
route that gathers inputs and proxies `GET /exports/run-by-name` and `POST /exports/run`.
**Depends on.** D.
**Done when.** CI exports are served by the headless host; the cross-host test (one export in
Node and in Chromium, bytes compared) is green.

### F · Thin server and deploy
**Scope.** Head tables, `entity_refs`, partial-model commit check, revert and undo on it,
snapshot job, streamed import, set-based structural checks, removal of `Session` hydration and
every model-reading route, deletion of the dropped Python core and its tests, removal of
surface switches and shadow comparison, GCP deployment ([system.md](system.md), CN-9…CN-13),
re-import of projects (AD-17).
**Depends on.** E.
**Done when.** No server code path loads a model; the deployed bill matches CN-7.

**Why this order.** Each step ships user-visible value while the current server keeps working
as fallback and oracle. The GCP bill drops only at F: the server cannot stop loading models
until evaluation (C), scripts (D) and CI exports (E) no longer need it.

## Migration rules

**MR-1 · `main` stays shippable.** Every migrated surface has a switch between engine and
server. It defaults to the engine once the surface passes; the server route stays until F.

**MR-2 · Shadow comparison.** In development and e2e runs a migrated `lib/api` function can
call both sides and log any difference. Removed in F.

**MR-3 · Freeze rule.** An area of the Python core is frozen for behaviour changes from the
start of its port until its surface defaults to the engine. After that, features for the area
land in TypeScript only. A bug fixed during a port lands on both sides, with a fixture. Areas
not yet being ported carry on as normal.

**MR-4 · Tests follow the surface.** Route-level mock tests of a migrated read surface are
replaced by tests that run the real engine on a small fixture model. Tests of write and
tenancy routes stay. Python tests of a dropped area are deleted in F with the code.

**MR-5 · Spike code is throwaway.** Nothing under `spikes/` is promoted into the engine,
`frontend/` or `src/`.

## Non-goals

Offline use · optimistic multi-writer sync · more than one `api` instance before ≈ 500 users ·
a `SharedWorker` replica · Rust or wasm kernels absent profiling evidence · JavaScript user
scripts · server-side strict-mode verification · changes to op shapes or lock semantics · a
mobile client.
