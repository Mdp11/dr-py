# Evaluation, plan 4: tables — design

Refines §4 of `2026-09-24-evaluation-design.md` (the binding program-level spec for C) for its
fourth plan. Where this document is silent, that spec holds. Approved in conversation with the
owner on 2026-09-25.

## Goal

`evaluateTable` is answered by the replica by default, behind a `tables` surface switch with
the server as fallback (MR-1) and the dev shadow clean in e2e (MR-2). Table pages see staged
model edits and staged artifacts (tables, navigations), which today they never do: the server
reads committed state only and nothing re-pages on a staged edit. CN-3's table budget — the
112k-row table at M, build + sort + every cell ≤ 3 s — is measured in Node and in Chromium and
reported to the owner before anything is optimized.

## Non-goals

- Exports and every writer (`exportTable`, `previewTableJson`, `runExporter*`): plan 5.
- Script evaluation in the engine (D). A table that reaches a script is refused and read from
  the server, from committed state, behind a marker.
- An incrementally maintained table (rows updated per transition). A table is re-evaluated as
  a scan; nothing needs finer grain yet.
- Optimizing anything that meets its budget.

## What the code says today

- The Python evaluator is ≈ 2.6k lines to port: `core/table/{evaluate,cells,schema,resolve,
  nav_memo,virtual_props,cell_text}.py`; `script_inputs.py` (375) is not ported. The route is
  `api/routes/tables.py::evaluate_table`; its order cache is `api/table_cache.py` (per session,
  16 entries, keyed by the resolved definition's JSON, stamped by `rev`, stored only when
  nothing errored and nothing is pending).
- The engine already has navigation evaluation (`evaluateSteps`, `Meter`, `PropertyValue`),
  ref resolution through the `ArtifactSet` (`resolveRefs`, `navigationFetch`,
  `navigationHasScript`), the exact value layer (`PyFloat`, `bigint`, `pyKey`, `pyDumps`,
  `displayName`, `treeItem`) and stepped sorting (`Meter.sort`, `sortedInSlices`). It has no
  NavMemo, no `table_has_script`, no `cell_text` and no `casefold` (`pyLower` differs, e.g. ß).
- The `ArtifactSet` has no version stamp; the service posts `changed` on an artifact move only
  when the rule sources differ, so a staged table or navigation edit is invisible to the
  frontend.
- Every table warning (`ScriptWarningCode`) comes from scripts; the engine, which never
  evaluates a script table, always answers `warnings: []` and `script_status: null`.
- The frontend calls `evaluateTable` from `state/table-editor.svelte.ts` only (`_loadTablePage`,
  `fetchChunk`), without `route()`. Pages re-load on a definition edit, on scroll (100-row
  chunks, merged when `model_rev` and `total` match) and on a model-scoped commit.
- Two suspected Python bugs, not yet confirmed by a test:
  1. `order_rows` and `evaluate_cells` derive `base_slots` as `len(keys[0]) − expand_count`,
     which `RowBuild.base_slots`' docstring says is wrong when `max_rows` stops the build
     before a later expand column: two or more expand columns and a mid-build cap should give
     a 422 (`chain_index … out of range`) or a 500.
  2. A property column element-typed on some row types and scalar on others sorts a tuple of
     labels against a tuple of atoms: `TypeError`, a 500.

## 1. Engine — `engine/src/table/`

A port of the evaluation modules rule for rule, Python names in camelCase:

| File | Port of |
|---|---|
| `schema.ts` | the definition reader and its static checks (`schema.py:370-473`); refusals are 422 in the engine's own words, as B's `ReadError` |
| `resolve.ts` | `resolve_table_refs` (inlines every navigation source and column navigation; dangling navigation → 422 `unknown artifact <id>`; dangling snippet left in place), `table_has_script` |
| `rows.ts` | `resolve_source_elements`, `build_rows_ex` (three row sources; collapse filters; expand slots; `TableLimits` 50k rows) |
| `sort.ts` | `sort_keys`, `order_rows`, `_sort_value` (one stable pass per key, last to first; empties last in both directions; desc keeps equal rows in build order) |
| `cells.ts` | `evaluate_cells` and the cell kinds `element`, `value`, `values`, `elements`, `error` (`pending` never occurs: script tables do not reach the engine); cell cap `min(cell_cap, 20)` |
| `nav-memo.ts` | `NavMemo`: per pass, LRU 64, keyed by the column and its roots; bypassed by a scripted navigation (unreachable here, kept for parity) |
| `virtual-props.ts`, `cell-text.ts` | `_Stereotype`; `cell_text` (used by plan 5's writers, held by fixture now) |
| `value/casefold.ts` | Python's `str.casefold`, a table generated from CPython like `lower-tables.ts` |

**`evaluateTable {definition | artifact_id, offset, limit}`**, a new `EVALUATIONS` entry run as
a model-lane `scan`, answers `TablePageOut` with the server's key order: `columns`, `rows`
(`{key, cells}`, every cell field present, nulls included, in `TableCellOut`'s order),
`total`, `base_total`, `truncated`, `offset`, `model_rev` (the committed `rev`), `warnings: []`,
`script_status: null`. Params as the route: exactly one of `definition` / `artifact_id`
(422 otherwise), `offset ≥ 0`, `limit` 1–500 default 100. Values leave through `toWire`, so
`1`, `1.0` and `True` stay apart and ints past 2^53 stay exact.

- **Closure first.** Before its first step the method resolves the table's whole closure
  through the `ArtifactSet` — the table itself when by id, row-source navigations, column
  navigations, snippet refs. The artifact methods are `now` and run between slices; a scan
  that resolved lazily could see a change halfway. The work before the generator stays small
  (params and ref resolution); criteria compilation runs inside the first step.
- **Script seam.** `tableHasScript` true → 501 `reaches a script`, before any work (spec §2).
- **One scan per call.** Row build, sort and the page's cells run as one `Steps` generator
  sharing one `Meter` (navigation nodes, rows, sort comparisons), so the scheduler slices it
  at its 8 ms target. A `cancel` drops it at its next unit, as today.
- **`TableOrderCache`** on the service: 16 entries, LRU. Key: the canonical text (`pyDumps`)
  of the resolved definition with presentation-only fields removed — `header`, `width_px`,
  `hidden`, `json_export`, `export`, `display_order`, `export_order`, `show_row_numbers`,
  `json_split`, `transform` — so a column resize or rename does not re-sort. Value: the ordered
  keys, `truncated`, `base_total`. Stamp: `(rev, staged_version, artifacts_version)`; a lookup
  under another stamp evicts and misses. Stored whenever the build and sort completed
  and were not cancelled (the server's "nothing errored" condition concerns script contexts,
  which never reach the engine). A hit evaluates only the page's cells:
  later pages are O(page). A scan restarted by the scheduler builds again from nothing; no
  memo outlives one `run()`.
- **Errors** as the route: `NavKeyError`/`NavValueError`/`ValueError` paths → 422 with the
  Python text; an unknown artifact → 422 `unknown artifact <id>`; no replica → 409
  `replica is not ready` (the shell falls back).

## 2. `artifacts_version` and `changed`

- `ArtifactSet.version`: bumped by `setCommitted`, `put` and `setStaged` whenever an entry is
  added, removed or replaced. Entries are replaced, never mutated, so identity decides.
- `moveArtifacts` posts `changed` whenever the version moved, carrying `artifacts_version`
  beside `rev`, `staged_version` and `issues_version`. It still recompiles and rescans only
  when the rule sources differ: a table or navigation edit never re-probes issues (plan 3,
  D10), and `rulesVersion` stays internal to the live store.
- CT-4 gains `artifacts_version` on `changed` and the `evaluateTable` method.

## 3. Frontend

**Surface.** `'tables'` joins `SURFACES`, `SURFACE_DEFAULTS` (default `engine`) and the
`Surface` union. Its gate is `follower.loaded()`, as `navigation`'s: a table cannot be resolved
before the committed artifacts are known. `lib/api/tables.ts::evaluateTable` goes through
`route('tables', cfg, call => call('evaluateTable', asSent(body), signal)…, serverFetch,
{mark: (page, reason) => ({...page, fallback: reason})})`; `TablePageSchema` gains an
optional `fallback: 'script' | 'pattern'`. Export, JSON preview and script errors stay server
calls.

**Re-paging on staged change** (`table-editor.svelte.ts`, fed from `replica.svelte.ts` the way
`followIssues` feeds issues):

- On `changed` with `rev`, `staged_version` or `artifacts_version` moved, and the `tables`
  surface effectively on the engine, a 300 ms debounce (re)starts. When it fires, every open,
  already-evaluated tab bumps its generation and re-loads its visible range; a tab with
  evaluation suspended by the settings dialog is only marked stale, as a commit marks it.
- The grid keeps its current rows and scroll position while the scan runs, with the existing
  busy hint in the header; the new pages replace the old ones in one install. It never drops
  to placeholders on a staged edit.
- The generation bump drops every answer and chunk asked before the change. That suffices: the
  engine posts `changed` after it applied the change, and a request posted later on the same
  port sees it; no stamp travels with the page. The superseded engine call is aborted through
  its `AbortSignal`, which the link turns into a CT-4 `cancel`.
- The commit re-page (`onCommitEvent`) stays: it serves the server path and the commit.
- Inline-vs-id (`_evaluateSource`) is unchanged; the engine resolves a staged table by id
  through the `ArtifactSet`. `ValueCell`'s staged-patch overlay stays (idempotent over an
  engine cell that already shows the staged value).

**Script tables.** The 501 falls back to the server, from committed state, and the page carries
`fallback: 'script'`. `TableData` and `installPage` carry `fallback`; `TableView` renders a muted
note `data-testid="table-fallback"`, "Reads committed state: this table runs a script". Pending
cells, the status poll and the error recap are unchanged and server-served.

**Shadow.** Table pages compare structurally, as B's reads, only while nothing is staged (model
or artifact buffer); a 501-refused call is never compared.

## 4. Oracle, tests, gate

- **Golden family `table_eval`** (`tests/golden/scenarios/table_eval.py`): the real
  `evaluate_table` route function on a `Session` with every argument passed, as `nav_eval`
  does, replayed by the engine through `model-steps.ts`. Cases: paging; the three row sources;
  every column kind × mode, `keep_empty`, cell caps; sort asc/desc, multi-key, empties, mixed
  numbers/strings/element ids, casefold (ß, Turkish I, Greek sigma); exact values (`1`, `1.0`,
  `True`, ints past 2^53); `TableLimits` truncation (rows and cell elements); every 422 of the
  schema checks; dangling navigation and snippet refs; a staged table by id, a staged
  navigation reached by a table, a staged delete hiding a committed navigation.
- **The two suspected Python bugs** each get a failing Python test first. A confirmed one is
  fixed on both sides with a fixture (MR-3); an unconfirmed one is dropped from the plan.
- **Engine tests** (real engine): cache hit; a miss for each stamp component; a presentation
  edit hits; a cancelled scan stores nothing; an artifact change posted between slices is not
  seen by the scan in flight and is seen by the next call; the 501 refusal; `changed` carries
  `artifacts_version` and a table edit does not move `issues_version`.
- **Frontend tests:** a routing test modelled on `api/__tests__/artifacts.test.ts` with the real
  `EVALUATIONS['evaluateTable']` (engine, by id, `script` mark, server side); store tests for the
  debounced re-page, old rows kept until the install, a stale chunk dropped, the suspended tab
  marked stale, the marker.
- **e2e** `eval-tables.spec.ts`, engine mode with shadow on: a table over a staged navigation
  shows the staged rows before any commit; a staged property edit re-sorts an open table; a
  script table shows the marker and its server-served cells.
- **Gate.** `engine-bench-data` also writes a 112k-row table definition over `large.model.json`
  shaped as CN-4's spike row (`spikes/client_engine/bench_engine.py:35-62`: scope rows over the
  nine big types; element, property `name`, a navigation column over `SystemContainsComponent`;
  sorted by name). `engine-bench` and `engine-bench-browser` gain a table row — total (build +
  sort + every cell ≤ 3 s), first page, a cached page, the longest step against the 16 ms
  chunk; the browser also a rules row (R19). `engine-parity-large` compares the table's cells
  with the oracle's (`scripts/` writes `large.table.json`). Medians of 3 (CN-5), reported to
  the owner before any optimization.

## 5. Open items

Folded in: `T-8` (`script-embedding.spec.ts` sorts through `ColumnSortDialog`); cleanup in
`eval-rules.spec.ts` so a mid-test failure cannot leave strict mode on for
`strict-mode.spec.ts`; the stalled plain sweep after a throwing step with no rescan queued; the
browser bench's rules row (R19).

Left out, each with its reason recorded in the plan:

| Item | Why not here |
|---|---|
| `K-65`, `K-66`, `K-68` | Rules, on both sides of the wire; an issues/rules hardening pass |
| `K-60` (server half) | `core/validation` stays frozen (MR-3) |
| `C-23` | Decided with the metamodel candidate (plan 7), as the item says |
| `K-58` | Dead code in a frozen area; the hardening pass |
| `K-62`, `K-63`, `T-10` | The issue store; the hardening pass |
| R13 (sweep step 10–14 ms vs 8 ms) | A number to report, not scheduled work |

## 6. Freeze and documents

- MR-3: `core/table` evaluation (`evaluate`, `cells`, `nav_memo`, `virtual_props`, `cell_text`,
  `schema`) freezes from this plan on, until the `tables` surface defaults to the engine; its
  writers freeze with plan 5. A bug found in either lands on both sides with a fixture until F.
- In the commit of the code they describe (RC-10): CT-4 (`evaluateTable`, `artifacts_version`);
  `program.md` (C's status, MR-3's text); `engine/README.md` (`src/table/`, the order cache);
  `frontend/src/lib/engine/README.md` (the `tables` surface, its gate); `frontend/README.md`
  (the table store's re-page); `BACKLOG-ENGINE.md` for what stays open.

## Done when

- `tables` defaults to the engine; the server path works behind the switch; shadow clean in e2e
  (no `[shadow]` line; `T-9` the only known e2e failure once `T-8` is fixed).
- A staged model edit, a staged table and a staged navigation are visible in an open table
  without a commit.
- The table gate is reported at M in Node and Chromium; `engine-parity-large` equal.
- `pixi run dr-test`, `dr-tidy true`, `engine-check`, `frontend-check`, `sandbox-check` green.
