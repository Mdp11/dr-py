# Program

Six sub-projects, built in order. Each gets its own spec → plan → build cycle, chained by
handoff. Specs and plans live under `docs/superpowers/` (RC-9); decisions that outlive a sub-project
are promoted into this directory.

## Status

| # | Sub-project | Status |
|---|---|---|
| — | Program design (this directory) | approved 2026-09-18 |
| A | Engine foundation | done — every golden fixture passes in Node; at M the engine opens a snapshot in 2.3 s of CN-3's 3 s and one open replica holds 231 MB of heap *(measured, Node 22, `pixi run engine-bench`, 2026-09-18)* |
| B | Replica and frontend seam | done — six plans built (exact server state: `K-30` and `K-31` closed, digest and `prev_rev` on every delta carrier; v2 snapshot writers, the snapshot descriptor, blob and tail routes, `X-Metamodel-Id`; the engine service: CT-4 dispatcher and scheduler, the index build and the digest check in steps, the five read surfaces ported and held to the read routes by fixture — at M the open is 2.4 s, the longest step 12 ms *(measured, Node 22, 2026-09-21)*; the sandbox site and the shell: the replica opens from the cache or the network and follows by delta, tail and re-bootstrap, with a status-bar indicator as its only face; the transport swap: the five read surfaces default to the engine, each behind its own `dr.surfaces` switch with the server as fallback, the workspace waits for `ready` behind an honest progress bar, a tab whose engine could not start shows a dismissible fallback notice and reads from the server, a replica that cannot be rebuilt blocks the workspace behind a `Retry` overlay that keeps uncommitted edits, and shadow comparison holds the engine to the server in dev and in every e2e spec; in the browser (`engine-bench-browser`) the cold open is 1.84 s, the worker's heap 115 MB, the longest slice bounded from outside 51 ms (27 ms once parsing runs), `stage` of 1,000 ops 58 ms and `unstage` 52 ms through the port *(measured, Chromium 148, WSL2, 2026-09-22)*; the forked store: the model store forks into `model-legacy.svelte.ts` and `model-engine.svelte.ts` over a shared half, `staging` defaults to `engine`, the user's edits stage in the replica's working copy and mirror for the synchronous readers, the legacy store stays reachable behind `staging: legacy`, the DiffDrawer gains a conflicts section, and a divergence-recovery test is green) |
| C | Evaluation | in progress — plan 3 of 8 built (custom rules evaluated in the engine, staged rule sets included) |
| D | Scripts in the browser | not started |
| E | Headless host | not started |
| F | Thin server and deploy | not started |

`BACKLOG-ENGINE.md` tracks the program as `R-3`, with its open items.

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
elements, fuzzy search, incident relationships, containment tree, summary counts.
`frontend/src/lib/state/model.svelte.ts` becomes a view over the engine (AD-24). Criteria
search is C's; neighborhoods have no caller today and move when one exists.
**Depends on.** A.
**Built as six plans**, each leaving the branch green: (1) exact server state — exact
rollback, recreated entities, digest and `prev_rev` on every delta carrier; (2) v2 snapshot
writers and the snapshot descriptor, blob and tail routes; (3) the engine service — CT-4
dispatcher, scheduler, sliced index build and digest check, the reads; (4) sandbox and shell,
the replica opening and following in the background, seen through an indicator; (5) the
transport swap, surface by surface, with shadow comparison and the browser benchmark, with the
wait for `ready`, the open-journey slices, the boot-fallback notice and the re-bootstrap
banner; (6) the forked store.
**Done when.** Those surfaces and staging are served by the engine by default; cold open and
heap meet budget; divergence recovery is exercised by a test.

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
land in TypeScript only. A bug fixed during a port lands on both sides, with a fixture, and so
does a bug found after the default flips, for as long as the server path lives (MR-1, until F).
`routes/read.py`'s route functions and `routes/elements.py::get_element` left the freeze for
features with B's fifth plan, when the five read surfaces defaulted to the engine; `core/model`,
`core/metamodel` and the model-op applier stay frozen. `core/navigation`, `core/search`,
`api/search.py` and the `search_model` and `evaluate_navigation` route functions stay frozen
too, past C's first plan flipping navigation and criteria search to the engine: `core/table`'s
evaluator (`core/table/{evaluate,cells,nav_memo,resolve,schema}.py`) and
`api/routes/{tables,exports}.py` still read them for tables and exports, which stay on the
server until C's plans 4–5; `api/search.py` and the route functions are also the 501
fallback's server side from C's first plan on (AD-31) — a script or an unsupported pattern
reads them whatever plan C is on; and `api/artifact_kinds.py` validates every committed
navigation payload with `NAVIGATION_ADAPTER`. The freeze lifts for FEATURES once tables and
exports default to the engine; a bug found in any of them lands on both sides, with a
fixture, until F (MR-1), whether or not the feature freeze has lifted.
`core/table/resolve.py` (ref resolution and script reach) is frozen from C's plan 1 on.
`core/validation` minus `rules/`, `api/validation_sweep.py` and the preview's conformance half
(`routes/commits.py::preview_commit`'s model half, `api/rules.py::attributable_issues`) are
frozen for behaviour from C's plan 2 on, and are the exception to the rule above: they stay
frozen past that plan's flip of `issues` to the engine, and until F a feature there lands on
both sides with a fixture step, as a bug does, since the server pipeline still decides strict
commits (`attributable_issues`) and `validation_error_count`, and answers every fallback: an
unreadable rule set, an unsupported pattern, `staging: legacy` and the window before the replica's
first sweep. Two bugs landed on both sides under this rule during C's plan 2: `value_conforms`'s
float branch, which raised `TypeError` on an unhashable value and now answers `False`, and the
dirty hooks, which missed a key relationship's endpoints' uniqueness groups on connect,
disconnect and cascade delete until 6b3cdb6. The second widens strict mode's `base_dirty`:
connecting, disconnecting or cascading away a relationship named in a key now makes the keyed
ends' old and new group members attributable, so a strict commit that used to land can get a
422, as a key-property edit already could. `core/validation/rules` and `api/rules.py` are frozen
from C's plan 3 on, which ports them: a bug or a feature there lands on both sides with a fixture
until F. Areas not yet being ported carry on as normal.

**MR-4 · Tests follow the surface.** A migrated read surface is tested by running the real
engine on a small fixture model. The route-level mock tests of its server path stay while
that path does (MR-1) and are deleted with it in F. Tests of write and tenancy routes stay.
Python tests of a dropped area are deleted in F with the code.

**MR-5 · Spike code is throwaway.** Nothing under `spikes/` is promoted into the engine,
`frontend/` or `src/`.

## Non-goals

Offline use · optimistic multi-writer sync · more than one `api` instance before ≈ 500 users ·
a `SharedWorker` replica · Rust or wasm kernels absent profiling evidence · JavaScript user
scripts · server-side strict-mode verification · changes to op shapes or lock semantics · a
mobile client.
