# Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine evaluates tables — row build, sort, every cell — over the working copy and the staged artifacts, and answers `evaluateTable` exactly as `POST /tables/evaluate` does, behind a `tables` surface switch that defaults to the engine; open tables re-page on a staged change; a table that reaches a script is read from the server behind a marker; the 112k-row table at M is measured against CN-3's 3 s. The plan also fixes two Python table bugs found while planning (on both sides, with fixtures) and folds in four small items the owner scheduled here: T-8, the `eval-rules.spec.ts` cleanup, the stalled plain sweep, and the browser bench's rules row.

**Architecture:** Plan 4 of 8 for sub-project C (`architecture/program.md`). Bottom-up: (1) the two Python bugs, fixed in the oracle first; (2) an engine port of the table evaluator, `src/table/` — the definition reader, ref resolution and script reach, row build and sort (with a generated `casefold`) — held to a golden family; (3) cells, NavMemo and the `evaluateTable` evaluation, held to the route by a second family; (4) the service: `ArtifactSet.version`, `artifacts_version` on `changed`, and the `TableOrderCache`; (5) the gate at M in Node and Chromium and the table's parity with the oracle, reported to the owner; (6) the shell: the `tables` surface, the marker, re-paging on `changed`; (7) the stalled sweep; (8) e2e and the documents.

**Tech Stack:** TypeScript 6 (`strict`, erasable syntax, `lib: ["ES2023"]`, no DOM or Node in `engine/src/`), vitest 3, Svelte 5 runes, zod, MSW, Playwright; Python 3.14 (FastAPI, pydantic v2, pytest, ruff); pixi for every command.

**Spec:** `docs/superpowers/specs/2026-09-25-eval-tables-design.md` (plan 4's design, approved 2026-09-25), which refines §4 of `docs/superpowers/specs/2026-09-24-evaluation-design.md`. Read first: `architecture/contracts.md` (CT-4, CT-5, CT-7), `architecture/decisions.md` (AD-21, AD-26, AD-31), `architecture/program.md` (MR-1…MR-4), `architecture/constraints.md` (CN-3, CN-4, CN-5), `architecture/conventions.md`. Then `src/data_rover/core/README.md` (tables), `src/data_rover/api/README.md` (tables), `engine/README.md` (`src/navigation/`, `src/artifacts/`, `src/service/`, golden fixtures, bench), `frontend/src/lib/engine/README.md` (surfaces, gates, fallbacks, shadow), `frontend/README.md` (before touching `frontend/src/lib/state/`), and plan 1 (`docs/superpowers/plans/2026-09-24-eval-artifacts-navigation-search.md`), whose navigation evaluation, 501 seam and marker this plan copies for tables.

**What kind of plan this is.** Direction with specifics, as plans 1–3: interfaces, signatures, the test cases and what each asserts, the order, and a full account of the mechanisms that are easy to get wrong. No full code. The expected results of the "see it fail" steps are reasoned from the code, not observed; if one does not appear, trust the run, read the step's intent, and say so in the hand-back. What WAS checked while planning is listed next.

## What planning found

Facts the plan rests on, checked against the code at `f82bf94` with tracers and throwaway probes (Python 3.14.5 through `pixi run -e core-dev`, `PYTHONPATH=src`; the probes are in the planning session's scratchpad, `probes/test_probe_tables.py`, `probes/core_probe.py`, `probes/casefold.py`).

1. **The evaluator.** `core/table/` evaluation is `evaluate.py` (1307 lines), `cells.py` (511), `schema.py` (476), `resolve.py` (127), `nav_memo.py` (78), `virtual_props.py` (62), `cell_text.py` (44); `script_inputs.py` (375) is script-only and not ported. The route is `api/routes/tables.py::evaluate_table` (`:235`); its order cache is `api/table_cache.py`.
2. **The schema** (`schema.py`). No model sets `model_config`: unknown keys are ignored, not refused. Discriminated by `kind`: row sources `scope {types = [], criteria = []}`, `navigation {navigation, step_index = None}`, `chains {navigation, unique = False}`; column sources `row {chain_index = 0, ≥ 0}`, `column {index ≥ 0, step_index = None}`; columns `element`, `property {name, mode, keep_empty = True}`, `navigation {navigation, step_index, mode, keep_empty, sort_mode = "value", cell_cap = 20 (≥ 1)}`, `script {snippet, inputs, mode, keep_empty}`, each with `source = row`, `header = ""`, `width_px = None`, `hidden = False`, `json_export = None`, `export = None`. `TableDefinition {schema_version = 1, row_source, columns (1..50), default_cell_mode, show_row_numbers, export_order, display_order, sort: [{column ≥ 0, direction = "asc"}], export_row_number, json_split, transform}`. `_validate_sources` (`:370-442`): a `ColumnRef` points strictly backward; `step_index` only on a navigation column's ref; `chain_index ≠ 0` only under a chains row source; element and navigation columns need an element-producing source, element columns a single-binding one; script inputs unique identifiers, backward, `value()` arity for inline code.
   - **Semantic fields:** `row_source`; each column's `kind`, `source`, `name`, `mode`, `keep_empty`, `navigation`, `step_index`, `snippet`, `inputs`, `cell_cap`, `sort_mode`; `sort`. **Presentation-only:** `header`, `width_px`, `hidden`, `json_export`, `export`, `show_row_numbers`, `export_order`, `display_order`, `export_row_number`, `json_split`, `transform`, `default_cell_mode`. `header` and `width_px` are echoed in the page's `columns`; `show_row_numbers` does not reach the page body.
3. **The route's answer** (`schemas.py:1736-1752`, `:1637-1661`): `TablePageOut {columns: [{kind, header, width_px}], rows: [{key, cells}], total, base_total, truncated, offset, model_rev, warnings, script_status}`; `TableCellOut` writes every field, nulls included, in the order `kind, item, ref_type, present, value, element_id, editable, items, values, total, truncated, message, traceback`; element ids go out as `TreeItem` (`_tree_item`, `tables.py:186-223`). *Probe:* a `PropertyValue` in a row key serializes as `{"value": …}` (e.g. `["b000000", 0, {"value": "x"}]`); an expand PROPERTY column puts the raw value in the key, unwrapped. Params: exactly one of `definition` / `artifact_id`, `offset ≥ 0` default 0, `limit` 1–500 default 100. `TableLimits()` is hard-coded (`tables.py:275`): 50,000 rows, 20 elements per cell.
4. **Errors.** A `LookupError` (dangling navigation ref) → 422 `unknown artifact <id>`; `NavigationResolveError` / `ValueError` → 422 `str(exc)` (`tables.py:496-499`). *Probe:* an inline definition failing pydantic answers FastAPI's list-shaped `detail` (`too_short`, `union_tag_invalid`, `value_error … column 0 sources column 1 (must be < 0)`); a stored payload failing answers `str(ValidationError)`, pydantic's multi-line text with a versioned URL. No fixture can hold those texts; the engine answers 422 in its own words, as `readNavigation` does (`engine/src/navigation/schema.ts:70-71`), and the dev shadow compares two errors by status alone (`frontend/src/lib/engine/shadow.ts:179-184`).
5. **Script reach** (`resolve.py:109-127`). `table_has_script` is true for any script column whose snippet is not EMPTY — `is_empty` is `ref is None and definition is None`, so a ref'd snippet (dangling included) and an inline `code: ""` both count — or any row-source or column navigation for which `navigation_has_script` holds. The route calls it on the RESOLVED definition (`:273`, `:291`), so a navigation referenced by id is seen through.
6. **Row build and order.**
   - Scope rows: `_scope_ids` over `element_descendants` of each type, `sorted` by Python `str` (code point). Navigation rows: projected element ids in first-seen order, deduped. Chains: whole chains, `unique` keeping the first per terminal.
   - Columns walk in declaration order: a collapse column with `keep_empty = False` filters; an expand column appends one slot per reached value (`None` when nothing and `keep_empty`); past `max_rows` the build slices, sets `truncated` and stops ALL further columns (`evaluate.py:628-635`).
   - `sort_keys` drops out-of-range and repeated columns (first wins). `order_rows` applies keys last to first, one stable pass each; each pass sorts the non-empty rows (`reverse=True` for desc, which keeps equal rows in input order) and appends the empties in their existing order — empties last in both directions.
   - Sort values (`_sort_value`, `:1007-1184`): element `(display_name.casefold(), id)`, empty `(1, "")`; collapse property: element-typed → `tuple(sorted(label.casefold()))` (no id tie-break), scalar → a tuple of atoms `(rank, float, str)` — numbers and bools rank 0 through `float()`, strings rank 1 casefolded, strings that are element ids rank 2 as `label.casefold() + "\0" + id`; expand property `(name, id)` or `(atom,)`; navigation `count` → `len`, `value` → sorted casefolded labels, a value terminal's label `str(value)` (Python `str`: `True`, `1.0`); expand navigation `(label, id)` / `(str(v).casefold(), "")`.
7. **Cells** (`cells.py`). One `NavMemo` per call (LRU 64, key `(id(col), tuple(roots))`, bypassed when the navigation has a script). Element column: the first resolved id. Property collapse, one element: `ValueCell` (`present` when the type declares the property, `editable = present and not virtual`), element-typed → editable `ElementCell` or `ElementsCell` for a list; over many elements: `ValuesCell` / `ElementsCell`, never capped. Navigation collapse: capped at `min(cell_cap, max_cell_elements)`, `total` the distinct count before the cap, `truncated = total > cap`; any value terminal makes it a `ValuesCell`. `_Stereotype` is the virtual property (the type name, declared on every type, not editable). Reached nodes dedupe elements by id, values by `(owner, PropertyValue)` with type-aware equality (`1`, `True`, `1.0` distinct).
8. **Bug A — `base_slots` after a capped build (CONFIRMED, reachable in production).** `order_rows` (`evaluate.py:1234-1237`), `evaluate_cells` (`cells.py:468-473`) and `api/script_sweep.py:458-461` recompute `base_slots = len(keys[0]) - expand_count`; when the cap stops the build before a later expand column, that is wrong (`RowBuild.base_slots` is right, `:554`, `:640`). *Probe:* 25,001 elements with two expand property columns, default limits → 422 `chain_index 0 out of range (row source has 0 slots)` in 2.2 s. Under a chains row source it gives WRONG CELLS with no error (a `tags` cell showing an element id). Export and JSON preview (`iter_export_rows` → `evaluate_cells`, `:1302-1307`) are hit too.
9. **Bug B — mixed sort shapes (CONFIRMED, 500).** The metamodel allows unrelated types to declare one property name with different datatypes (`check.py:124-135` refuses only an ancestor redeclaration). *Probe:* `Block.owner: Person`, `Gadget.owner: string`, sorted → `TypeError '<' not supported between instances of 'tuple' and 'str'` at `evaluate.py:1271`; the route answers 500. The expand form fails the same way (`(name, id)` vs `(atom,)`).
10. **`float()` in sort atoms.** An int past 2^53 rounds (half to even — `Number(bigint)` rounds the same way); past ≈ 1.8e308 `float()` raises `OverflowError` (a 500); `NaN` makes the sort order undefined. None is fixed here (D4).
11. **`casefold`** (Python 3.14.5, Unicode 16.0.0): 297 code points differ from `lower()` — 103 expand (ß → ss, ligatures, Greek iota-subscript forms), 194 map singly (Cherokee to uppercase, µ → μ, ſ → s, ς → σ, …). It is per code point, context-free (`'AΣ'.casefold()` is `'aσ'`). The engine has no casefold; `pyLower` is generated by `tests/golden/lower_tables.py`, listed in `tests/golden/driver.py:21-25` `GENERATED`, kept current by `test_fixtures_current.py`, ignored by `engine/.prettierignore`.
12. **The engine today.** `EvalContext = {model, artifacts, placements}` (`engine/src/evaluate/index.ts:10`); `EVALUATIONS` holds `searchModel`, `evaluateNavigation`; every key is a worker method run as a model-lane `scan` (`service.ts:342`, `:512-521`). `navigation/route.ts:102-148` is the template: params and ref resolution in `run()`, 501 `reaches a script` before any step, a `Meter` ticking nodes. Reusable: `evaluateSteps`, `evaluateNavigationCore`, `Meter` (`STEP_UNITS = 1024`, `Meter.sort` slicing past 1,024), `PropertyValue`, `resolveRefs`, `navigationFetch`, `navigationHasScript`, `displayName`, `treeItem`, `toWire`, `pyDumps`, `cmpCodePoint`, `sortedInSlices`.
13. **The scheduler.** A model-lane scan never interleaves with a model-lane transition: `rev` and `stagedVersion` cannot move while it runs. A control-lane transition (only while opening) or a close drops the generator (no `.return()`) and calls `run()` again later. A cancel drops it at its next unit. The artifact methods are `now`: they run between slices, so `ArtifactSet` CAN move mid-scan.
14. **`changed`.** `WireChanged = {event: 'changed', rev, staged_version, issues_version} & WireChanges` (`service/types.ts:44-49`). `moveArtifacts` (`service.ts:722-736`) posts nothing unless the compiled rule sources differ (and returns early with no issue store). So a staged table or navigation edit is invisible to the shell today. The shell types `changed` from the engine's type (`sync.ts:113`).
15. **The shell today.** `evaluateTable` (`api/tables.ts:10-25`) does not go through `route()`; its callers are `table-editor.svelte.ts` `_loadTablePage` (`:1208-1240`) and `fetchChunk` (`:1286-1320`). `_loadTablePage` keeps the rows while loading (`TableGrid.svelte:533` shows the skeleton only with no page) but clears the script-error recap and the error first, and an error replaces the grid (`:531`). `installPage` (`:1147-1163`) replaces the sparse cache; `mergePage` (`:1172-1185`) splices a chunk when `model_rev` and `total` match — on the engine a staged change moves neither. `bumpGeneration` (`:468-476`) drops in-flight chunks. The commit re-page is `handleTableModelRevChanged` (`:1579-1595`) from `onCommitEvent`. The busy hint is `data-testid="table-activity"` from `busy = loading || computing || exporting` (`TableView.svelte:216`, `:716-724`). Gates are installed in `replica.svelte.ts:229-239`; `followIssues` (`:312-320`) is the pattern for following `changed`. `surfaces.test.ts:19-31` and `:212-221` enumerate the surfaces.
16. **The gate's table.** CN-4's spike table (`spikes/client_engine/bench_engine.py:34-62`): scope rows over `Person, DataEntity, Microservice, APIEndpoint, IoTDevice, Service, Server, DataSchema, Database`; columns `element`, property `name`, a navigation `row → SystemContainsComponent (either)`; sort by column 1. *Measured:* over `benchmarks/large.model.json` (170,340 elements, 126,820 relationships, 30,600 `SystemContainsComponent`) the scope is 112,200 rows (descendants included), 336,600 cells. The route's 50,000-row cap truncates it.
17. **Bench and parity.** `engine/bench/run.ts`: `PASSES = 3`, `ROWS` order, `stepped(total, longest, steps, first?)` (`:129-146`), evaluation rows at `:536-537`. `engine/bench/parity-large.ts` applies the violation ops to the model before comparing issues (`:77`). `frontend/bench/main.ts`: `ping()` round trips measure the longest slice; `transitions()` ends with a deliberately bad delta (`:261`) — anything new goes before it; data routes in `bench/vite.config.ts:10-15`.
18. **The folded items.**
    - *Stalled plain sweep:* a plain sweep step that throws puts its ids back in `retry` and the scheduler sets `issuesOf.stalled` (`service.ts:692-697`), but only `settled()` re-drives and only when a rescan is queued (`:656-657`), so reads are answered from the partial store forever, `swept` stays false and tag scopes fall back to `origins()` on every call; only `validateModel` or a rules change restarts it.
    - *`eval-rules.spec.ts`:* strict mode on at `:226`, off at `:234`; a failure between leaves it on and `strict-mode.spec.ts:72` fails next (serial, one worker). Owner-only `PATCH projects/<id>/settings {strict_mode}` (`routes/settings.py:36-53`) through `peer(playwright)` (`e2e/helpers/api-client.ts:13-23`) resets it.
    - *T-8:* `script-embedding.spec.ts:205-213` waits for a header `Sort by` button that is gone; the dialog opens from `table-sort-button`, a column is added with `sort-toggle-{i}` (definition index; equal to `scriptColIndex` here), shows `sort-dir-{i}` (▲/▼), closes with `sort-done`.
    - *Browser rules row (R19):* serve `large.rules.json` from the bench's vite config, `setArtifacts`, and wait for the rescan through `getModelIssues`.

## Decisions

- **D1 — Refusals in the engine's own words.** Schema and param refusals are 422 with a path and a message, as `readNavigation`'s; the texts need not match pydantic's (fact 4). A dangling navigation ref is 422 `unknown artifact <id>`, the Python text.
- **D2 — Bug A, fixed on both sides.** `RowBuild.base_slots` is threaded to every consumer: `order_rows(…, base_slots)`, `evaluate_cells(…, base_slots)`, `iter_export_rows`, `api/script_sweep.py`, and the route's cache entry stores it (it already stores `base_total`). The engine never recomputes it.
- **D3 — Bug B, fixed on both sides.** A property sort value gains a leading shape tag: scalar values `(0, atoms)`, element-typed `(1, labels)`; expand likewise `(0, (atom,))` / `(1, (name, id))`. A column of one shape orders exactly as before (same tag); a mixed column puts scalar rows first ascending, element rows first descending. Only the property branches change.
- **D4 — `float()` edges are mirrored, not fixed.** The engine converts an int atom with `Number(bigint)` (the same rounding) and throws a plain `Error` (a 500, as Python's `OverflowError`) past `Number.MAX_VALUE`; `NaN` atoms are kept out of the fixtures. `K-69` records both on the backlog.
- **D5 — The cache key is the resolved definition's SEMANTIC text.** `pyDumps` of the resolved definition with the presentation-only fields of fact 2 removed (at the table level and per column). A resize, a rename, a hide or an export setting hits the cache; the page's `columns` are always built from the definition asked, not the cached entry.
- **D6 — The stamp is `(rev, staged_version)`; `artifacts_version` drives the shell, not the cache.** The key already contains the resolved closure (every navigation inlined), so a changed navigation changes the key; snippets never reach the engine's cache (script tables are refused). Stamping with `artifacts_version` too would evict every table on any unrelated artifact edit. *The design doc says so (amended while planning).*
- **D7 — The closure is resolved in `run()`; the stamp is read in `run()`.** `rev` and `staged_version` cannot move during a model-lane scan (fact 13); the artifacts can, but the scan reads only its resolved closure, so its order belongs to the stamp and key read at its start. A scan restarted by the scheduler resolves and reads again.
- **D8 — The cache stores a complete order only.** The entry is stored the moment build + sort complete, before the page's cells; a scan dropped before that stores nothing. An order is stored even when the page's cells then hold error cells (errors in cells do not change the order; the server's "nothing errored" condition concerns script contexts only).
- **D9 — `changed` on every artifact move.** `ArtifactSet.version` increments whenever `setCommitted`, `put` or `setStaged` adds, removes or replaces an entry. `moveArtifacts` posts `changed` (with `artifacts_version`) when the version moved and the service is ready, whether or not the rules changed; the rules recompile and rescan stay gated on `sameSources` exactly as now.
- **D10 — `tables` is not a read surface.** It joins `SURFACES` and `SURFACE_DEFAULTS` (`engine`), not `READ_SURFACES` (not forced by `staging: engine`). Its gate is `follower.loaded()`, as `navigation`'s.
- **D11 — Re-page on `changed`, one path per side.** `followTables` (in `replica.svelte.ts`) remembers the last `(rev, staged_version, artifacts_version)`; when it moves and `engineSide('tables') === 'engine'`, `scheduleTablesRepage()` (300 ms debounce, restarted by each move). `handleTableModelRevChanged` from the commit feed runs only when the side is `server`, so a peer's commit re-pages once.
- **D12 — A re-page keeps the rows.** `_loadTablePage(tabId, req, {background: true})` skips the up-front `clearScriptErrors` / `_errors.delete`; at install it clears them; on failure it keeps the page and sets `_errors` only when the tab has no page. Stale chunks are dropped by the generation bump alone; no stamp travels with the page (the engine posts `changed` after applying; a later request sees it).
- **D13 — Superseded calls are aborted.** `evaluateTable` takes an optional `signal`; `table-editor` keeps one `AbortController` per tab, aborted by `bumpGeneration`; an abort is silent. On the engine the signal becomes a CT-4 `cancel`; on the server it aborts the fetch.
- **D14 — The marker.** `TablePageSchema.fallback?: 'script' | 'pattern'`; `TableData` and `installPage` carry it; `TableView` renders `data-testid="table-fallback"`: "Reads committed state: this table runs a script" (`'pattern'`: "…: a search pattern needs the server").
- **D15 — The gate is measured on the core, the user path on the service.** The Node bench runs build + sort + every cell of the 112,200-row table with `max_rows` raised (CN-3's gate, as the spike did) through the exported `tableSteps(model, defn, limits)`; it also times `evaluateTable` as a user calls it (first page, 500 rows, capped at 50,000; then a cached page). The browser bench can only call the worker's methods, so it measures `evaluateTable` (capped) and its longest slice. The owner sees both.
- **D16 — Shared bench definition.** `engine/bench/big-table.json` holds the gate's definition; `scripts/table_large.py` and both benches read it.
- **D17 — Out of scope** (the design's §5): `K-65`, `K-66`, `K-68`, K-60's server half, `C-23`, `K-58`, `K-62`, `K-63`, `T-10`, and the sweep's step target (R13, reported only).

## Global Constraints

- Everything runs through pixi (`PATH=~/.pixi/bin:$PATH`). No global `node` or `python`.
- **Branch and commits.** Work on the session's branch (`claude/task-plpxhj`, standing in for `feat/eval-tables`), reset to `origin/engine-migration` plus this plan's docs commits. One commit per task, pushed to that branch only. `engine-migration` is fast-forwarded only with the owner's go-ahead (Task 8). Never touch `main`.
- **Freeze (MR-3).** `core/model`, `core/metamodel`, the model-op applier and plans 1–3's areas stay frozen. From Task 1 on, `core/table` evaluation (`evaluate`, `cells`, `nav_memo`, `virtual_props`, `cell_text`, `schema`, `resolve`) is frozen for features: only D2 and D3 change it, each with a Python test and, through Task 2/3's families, a fixture. `src/data_rover/` changes only in Task 1 (and Task 5's `scripts/table_large.py`, which is not `src/`). The Python core is the oracle: fix the engine, never a fixture; fixtures change only through `pixi run golden-fixtures`.
- **Engine `src/` rules:** no DOM, Node built-in, timer, clock, `Math.random`, `Intl` or locale comparison (RC-4, RC-5); erasable syntax, `.ts` specifiers, no `any` in an exported signature; strings compare by `cmpCodePoint`; casefold is `pyCasefold`; `str()` of a value is the existing `pyStrNumber` / `jsStr` helpers, never `String()`.
- Tests import the engine through `engine/src/index.ts`. Engine and frontend tests run the real engine, never a mock, without fake timers (the existing table-editor tests that use fake timers keep them; new tests do not). Every in-process link is `dispose()`d.
- A steps generator publishes nothing before its last step (the cache store at the end of the sort is internal, not a publication). Nothing live leaves the service: results go through `toWire`.
- **Lint and checks.** `pixi run engine-tidy` for `engine/`, `pixi run dr-tidy` for the rest; on every file under `tests/` and `scripts/`, `pixi run -e core-dev ruff check <files>` and `ruff format <files>`; `pixi run engine-check` and `pixi run frontend-check` pass.
- A "see it fail" step lists the tests it expects red. Any OTHER red test is a finding to report, not to silence.
- Comments and docstrings: concise, present-tense, only for what the code cannot say; no references to specs, plans or `architecture/` ids in code (RC-6).
- `architecture/`, the READMEs, `BACKLOG.md` and `BACKLOG-ENGINE.md` change in the commit of the code they describe (RC-10). `docs/superpowers/` is committed (RC-9); `benchmarks/` and `.superpowers/` are git-ignored.
- Commit subjects: one imperative sentence, capitalized, no prefix, no trailing period. The message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and nothing else.
- Ids: next free `AD-34`, `K-69`, `C-24`, `T-11`, `U-11` (grep before use; K ids are unique across both backlogs).
- **Baseline** at `f82bf94` (2026-09-25): core 2,588 passed / 34 deselected; frontend 3,049 tests in 284 files; engine 1,320 in 85 files; sandbox 14; e2e 64 passed, 2 failed (T-8, T-9), no `[shadow]` lines; `engine-parity-large` equal over 18,523 issues.
- **e2e in this environment:** `pixi run sandbox-build` first; then `PLAYWRIGHT_BROWSERS_PATH=<scratchpad>/pwb pixi run frontend-test-e2e` (the pinned Playwright wants Chromium 1223; `pwb` symlinks the installed 1194).

## Review Focus

The six conditions most likely to bite a user that the tasks' ordinary tests would not reach. Each has its test in the task named.

1. **Two states in one grid.** The user scrolls a large table while staging edits: chunks asked before a staged change must never splice into the grid after it, even with an equal `total`. *Task 6.*
2. **An artifact moving under a scan.** A navigation is re-staged while a table scan over it runs: the scan answers from the closure it resolved, the next call sees the new one, and the cache never serves the old order under the new definition. *Task 4.*
3. **Exact order.** Casefold (ß, ς, Cherokee), descending stability, empties last both ways, numbers vs strings vs element-id strings, ints past 2^53, a mixed-shape property (D3), a multi-key sort with repeated and out-of-range columns. *Tasks 2 and 3.*
4. **Script reach through a staged navigation.** Staging a navigation that gains a script step flips an open table to the server with the marker; unstaging it flips it back to the engine, without a reload. *Tasks 3 and 6.*
5. **The 50,000-row cap with expand columns** (bug A) and cell caps at the edge (`cell_cap` 1, exactly 20, 21 reached). *Tasks 1–3.*
6. **A re-page that fails or is aborted** never blanks the grid, never shows a stale error or recap, and never leaves the busy hint on. *Task 6.*

---

## File Structure

**Python (Task 1, 5)**
- Modify: `src/data_rover/core/table/evaluate.py` (D2, D3), `src/data_rover/core/table/cells.py` (D2), `src/data_rover/api/script_sweep.py` (D2), `src/data_rover/api/routes/tables.py` (thread `base_slots`; cache value), `src/data_rover/api/table_cache.py` (entry carries `base_slots`), `src/data_rover/api/routes/tables.py` json preview and `api/table_export_engine.py` wherever they call `order_rows` / `evaluate_cells` / `iter_export_rows`.
- Create: `tests/table/test_capped_expand.py`, `tests/table/test_mixed_sort.py` (place beside the existing table tests; match their directory).
- Create: `tests/golden/casefold_tables.py`, `tests/golden/scenarios/{table_rows,table_eval}.py`; modify `tests/golden/driver.py`, `tests/golden/model_steps.py`, `tests/golden/scenarios/__init__.py`.
- Create: `scripts/table_large.py`; modify `pixi.toml`.

**Engine**
- Create: `engine/src/value/casefold.ts`, `engine/src/value/casefold-tables.ts` (generated).
- Create: `engine/src/table/{schema,resolve,rows,sort,cells,nav-memo,virtual-props,cell-text,page,route,order-cache}.ts`.
- Modify: `engine/src/evaluate/index.ts`, `engine/src/artifacts/artifact-set.ts`, `engine/src/service/{service,types}.ts`, `engine/src/validation/live.ts` or `service.ts` (Task 7), `engine/src/index.ts`, `engine/.prettierignore`, `engine/README.md`.
- Tests: `engine/test/table/{schema,rows.golden,sort,table.golden,staged,cache,casefold}.test.ts`, `engine/test/service/{artifacts-version,tables}.test.ts`, `engine/test/golden/model-steps.ts`, `engine/test/service/issues.test.ts` (Task 7).
- Bench: `engine/bench/big-table.json`, `engine/bench/run.ts`, `engine/bench/parity-large.ts`.

**Frontend**
- Modify: `frontend/src/lib/api/{tables,types,engine-route}.ts`, `frontend/src/lib/engine/{surfaces,shadow}.ts`, `frontend/src/lib/state/{replica,table-editor}.svelte.ts`, `frontend/src/lib/components/Table/{TableView,TableGrid}.svelte`, `frontend/README.md`, `frontend/src/lib/engine/README.md`.
- Tests: `frontend/src/lib/api/__tests__/tables.test.ts`, `frontend/src/lib/engine/__tests__/surfaces.test.ts`, `frontend/src/lib/state/__tests__/table-editor-repage.test.ts`, `frontend/src/lib/components/Table/__tests__/TableView.test.ts`, `frontend/src/lib/engine/__tests__/sync-events.test.ts`.
- Bench: `frontend/bench/{main,run}.ts`, `frontend/bench/vite.config.ts`.
- e2e: create `frontend/e2e/eval-tables.spec.ts`; modify `frontend/e2e/script-embedding.spec.ts` (T-8), `frontend/e2e/eval-rules.spec.ts`.

**Documents:** `architecture/contracts.md` (CT-4), `architecture/program.md`, `BACKLOG.md`, `BACKLOG-ENGINE.md`, `src/data_rover/core/README.md`, `src/data_rover/api/README.md`.

## Mechanisms

**M1 — Reading a definition** (`table/schema.ts`). `readTableDefinition(raw: unknown, where: string): TableDefinition` checks the discriminated shapes of fact 2, fills every default, ignores unknown keys (pydantic's default), and runs `_validate_sources`' checks in its order, refusing with `ReadError(422, "<path>: <message>")`. Navigation fields go through the existing `readNavigation` path (inline) or stay a `{ref}`; snippets stay opaque (a script table is refused before they matter). The reader is used on inline definitions and on stored table payloads alike. The Python texts are reused where they are the core's own `ValueError` messages (`column 0 sources column 1 (must be < 0)`); elsewhere the engine's words.

**M2 — Resolution and reach** (`table/resolve.ts`). `resolveTableRefs(defn, fetch)` is a port of `resolve.py:159-184`: every row-source and column navigation is inlined through `resolveRefs` (dangling → `RefNotFoundError` → 422 `unknown artifact <id>`; cycles as navigation's), snippets left in place. `tableHasScript(resolved)`: any script column with a non-empty snippet source (fact 5) or any navigation for which `navigationHasScript` holds. `tableFetch(set)` resolves a table id through `ArtifactSet.resolve`, kind `table`, else `RefNotFoundError`. Order inside `run()`: params → source (`artifact_id` → fetch, read payload with M1; or `definition` → M1) → `resolveTableRefs` → `tableHasScript` → 501 `reaches a script` → criteria compile and everything else inside the generator.

**M3 — Rows** (`table/rows.ts`). `resolveSourceElements` and `buildRowsEx` rule for rule (fact 6), returning `RowBuild {keys: RowKey[], truncated, baseTotal, baseSlots}`; a `RowKey` is `readonly (string | number | bigint | PyFloat | boolean | null | PropertyValue)[]`. Scope ids sort by `cmpCodePoint` (Python `str` order is code point order). Every visited node and every row appended ticks the shared `Meter`; the build is a `Steps` generator (`buildRowsSteps`) that yields at `STEP_UNITS`.

**M4 — Order** (`table/sort.ts`). `sortKeys(defn)` and `orderRowsSteps(…, baseSlots)` port fact 6 with D3's tags. Each pass decorates once (one sort value per row, Schwartzian), sorts the non-empty rows with a stable merge sort in slices (`Meter.sort` / `sortedInSlices`), comparator `pyCompare` over the decorated values — tuples lexicographic, numbers by value (an int atom through `Number(bigint)`, D4), strings by `cmpCodePoint`, never mixing kinds except where Python would raise (D4) — and for `desc` the comparator is NEGATED, never the result reversed, so equal rows keep input order. Empties are appended after, in their existing order. `casefold` is `pyCasefold` (M-casefold below); `str(v)` of a value terminal is Python's `str` (`True`, `1.0`, `1e+16`, big ints exact).

**M-casefold** (`value/casefold.ts`). `tests/golden/casefold_tables.py::render()` emits, for every code point where `chr(cp).casefold() != chr(cp).lower()`, the pair `(cp, casefold)`, and the Unicode version; `pyCasefold(s)` maps each code point through that table, else through the existing per-code-point `lower` table WITHOUT `pyLower`'s final-sigma context (casefold has none). A test tabulates ß, ẞ, ς, Σ, µ, ſ, Cherokee Ꭰ / ꭰ, İ, ﬁ, and a string mixing them against fixture values generated by Python.

**M5 — Cells** (`table/cells.ts`, `table/nav-memo.ts`, `table/virtual-props.ts`, `table/cell-text.ts`). `evaluateCellsSteps(model, defn, keys, baseSlots, limits, memo)` ports fact 7; the memo is created per pass (build, order and cells each create their own, as Python does) and keyed by the column's index and the roots' ids joined, LRU 64. Cells are plain objects in `TableCellOut`'s field order with every field present. `cellText` is ported now, tested now, used by plan 5.

**M6 — The evaluation** (`table/route.ts`, `table/page.ts`). `evaluateTable(ctx, params): Steps<TablePageBody>`:
1. In `run()`: M2's order; then the key (D5) and the stamp `{rev: model.rev, staged: model.stagedVersion}` (D6, D7).
2. Generator: on a cache hit, slice `order[offset, offset + limit]`; on a miss, `buildRowsSteps` then `orderRowsSteps`, then store (D8) and slice.
3. `evaluateCellsSteps` over the slice.
4. Answer `{columns, rows, total, base_total, truncated, offset, model_rev: rev, warnings: [], script_status: null}` through `toWire`, row keys with `PropertyValue` as `{value}` (fact 3), element cells as `treeItem`.
`tableSteps(model, defn, limits)` (exported, bench and parity only) runs build + order + cells over ALL rows of an already-resolved definition, with no cache.

**M7 — The order cache** (`table/order-cache.ts`). `class TableOrderCache {get(key, stamp): CachedOrder | undefined; put(key, stamp, entry): void}` — 16 entries, LRU by `Map` re-insertion; a `get` under another stamp deletes and misses. `CachedOrder {keys, truncated, baseTotal, baseSlots}`. `EvalContext` gains optional `tableOrders?: TableOrderCache` (the golden harness omits it and runs uncached); `Service` owns one, cleared on `close` / a new `open`.

**M8 — `artifacts_version`.** `ArtifactSet.version: number` (starts 0) bumps in `setCommitted` / `put` / `setStaged` when anything changed (entries are replaced wholesale, so compare old and new maps by size and identity per id; `setStaged` with an identical buffer — same ids, each entry deep-equal by `pyDumps` — does not bump). `WireChanged` gains `artifacts_version`; `changed()` and `flushIssues()` fill it; `moveArtifacts` posts `changed` when the version moved and the state is `ready` (D9), then continues to its existing rules logic (which may post again with a moved `issues_version`; two posts are fine, the shell dedups by tuple).

**M9 — The shell.**
- `api/tables.ts::evaluateTable(args: EvaluateArgs & {signal?: AbortSignal}, cfg?)` → `route('tables', cfg, (call) => call('evaluateTable', asSent(body), signal).then(TablePageSchema.parse), () => apiFetch('/tables/evaluate', {method: 'POST', body, schema: TablePageSchema, ...signalOf(signal)}, cfg), {mark: (page, reason) => ({...page, fallback: reason})})`.
- `followTables(sync)` in `replica.svelte.ts` (own `_offTablesChanged` slot, stopped in `stopReplica` and `resetReplica`); `scheduleTablesRepage()` in `table-editor.svelte.ts` (300 ms, restarted per call) → `repageOpenTables()`: each open tab with a page and not suspended → `bumpGeneration` + `_loadTablePage(tab, visibleRequest(tab), {background: true})`; suspended → `_suspendedStale`.
- D11–D14 as stated.

**M10 — Gate and parity.** `engine/bench/big-table.json` = fact 16's definition. Node rows (after `navigationLongest`): `tableGate` / `tableGateLongest` (`stepped` over `tableSteps` with `max_rows: 1e9`, `max_cell_elements: 20`), `tableFirstPage` / `tableFirstPageLongest` (`evaluateTable`, `limit: 500`, a fresh `TableOrderCache`), `tableCachedPage` (`offset: 500`, same cache). Browser (`main.ts`, before the bad delta): `tableFirstPage`, `tableCachedPage` timed, a `ping` loop alongside for `tableLongestSlice`; `rulesRescan` + `rulesLongestSlice` (R19). Parity: `scripts/table_large.py` evaluates the same definition with `TableLimits(max_rows=10**9)` over the snapshot's model BEFORE any violation op, and writes `benchmarks/large.table.json` as JSON lines, one per row in order: `[key, cells]` in the route's cell shape; `parity-large.ts` runs `tableSteps` on the freshly opened model before applying the violation ops and compares line by line (first 20 differences, exit 1).

**M11 — The stalled sweep.** In `settled()`, when `issuesOf.stalled` and no rescan is queued, clear `stalled` and re-drive `this.sweep(live)` before answering (the read still answers the current store, as today). A step that throws again sets `stalled` again; no loop, since only a read re-drives and `version` does not move on a failed step.

---

### Task 1: Two table bugs in the oracle · `critical-implementer`
*Reason: changes the oracle's order and slot semantics that every later fixture freezes; D3 picks an ordering.*

**Files:** see File Structure, Python (Task 1 lines), plus `src/data_rover/core/README.md`, `BACKLOG-ENGINE.md`.

**Interfaces:**
- Produces: `order_rows(model, defn, keys, *, base_slots: int, …)`, `evaluate_cells(model, defn, keys, *, base_slots: int, …)` (keyword, required), `iter_export_rows` passing `build.base_slots`; the order cache entry `(rev, rows, truncated, base_total, base_slots)`.

- [ ] **Step 1: Write the failing tests.**
  - `test_capped_expand.py`: (a) through `evaluate_table` (route function, `Session` over a small model, `TableLimits` monkeypatched to `max_rows=3`): three elements, two expand property columns → 200, 3 rows, `truncated: true`, every cell the value of its own column (today 422); (b) chains row source with `chain_index 0` and `1`, `max_rows=1` → the cells equal those of the uncapped build's first row (today wrong cells / 422); (c) `order_rows` sorting on the second expand column under the cap does not raise; (d) the script sweep's cell pass under the same cap (call the function `script_sweep.py:458` sits in, as its existing tests do).
  - `test_mixed_sort.py`: metamodel with unrelated `Block.owner: Person` and `Gadget.owner: string`; collapse and expand property column `owner`, asc and desc → 200; asc lists every scalar row before every element row, desc the reverse; within each group the order equals the single-shape order (compare with a table filtered to one type); single-shape tables' order unchanged (a regression pin on an existing sort test is enough).
- [ ] **Step 2: See them fail** (`pixi run -e core-dev pytest tests/table/test_capped_expand.py tests/table/test_mixed_sort.py -q`): 422 / wrong cells / `TypeError`. Everything else green.
- [ ] **Step 3: Implement** D2 and D3. Grep every caller of `order_rows`, `evaluate_cells` and `iter_export_rows` (`routes/tables.py`, `api/table_export_engine.py`, `api/script_sweep.py`, tests) and pass `base_slots` from the `RowBuild` (or the cache entry). The old recomputation disappears everywhere.
- [ ] **Step 4: See them pass;** `pixi run core-test`, `pixi run dr-tidy`.
- [ ] **Step 5: Docs.** `core/README.md`'s table section: the sort's shape tag, one sentence. `BACKLOG-ENGINE.md`: `K-69` — `float()` in sort atoms (overflow → 500, `NaN` order undefined), open, both sides, with the fix direction (compare ints exactly; a `NaN` atom sorts last).
- [ ] **Step 6: Commit:** `Keep a capped build's slots and sort mixed property shapes`.

---

### Task 2: Definitions, rows and order in the engine · `critical-implementer`
*Reason: exact Python ordering semantics (casefold, float atoms, stable desc, empties) where a subtle mistake passes ordinary tests.*

**Files:** `engine/src/value/{casefold,casefold-tables}.ts`, `engine/src/table/{schema,resolve,rows,sort}.ts`, `tests/golden/casefold_tables.py`, `tests/golden/driver.py`, `tests/golden/scenarios/table_rows.py`, `tests/golden/model_steps.py`, `tests/golden/scenarios/__init__.py`, `engine/test/golden/model-steps.ts`, `engine/test/table/{casefold,schema,rows.golden,sort}.test.ts`, `engine/.prettierignore`, `engine/src/index.ts`, `engine/README.md`.

**Interfaces:**
- Consumes: Task 1's fixed oracle.
- Produces: `pyCasefold(s: string): string`; `readTableDefinition(raw, where): TableDefinition` and the definition types; `resolveTableRefs(defn, fetch): TableDefinition`, `tableHasScript(defn): boolean`, `tableFetch(set: ArtifactSet)`; `TableLimits {maxRows, maxCellElements}`, `DEFAULT_TABLE_LIMITS`; `RowKey`, `RowBuild {keys, truncated, baseTotal, baseSlots}`; `buildRowsSteps(model, defn, limits, meter, memo): Steps<RowBuild>`; `sortKeys(defn)`; `orderRowsSteps(model, defn, keys, baseSlots, meter, memo): Steps<RowKey[]>`.
- **Recorder** (`model_steps.py`): `{"do": "table_rows", "definition": {...}, "limits": {"max_rows", "max_cell_elements"}?}` resolves the definition against the recorder's artifacts (as the route does) and records `{has_script, keys, truncated, base_total, base_slots, order}` — `keys` and `order` serialized as the route serializes row keys (fact 3).

- [ ] **Step 1: Generator and scenario.** `casefold_tables.py` (M-casefold) in `GENERATED`; `table_rows.py` over a metamodel with an element chain, subtypes, every datatype, element-typed single and list properties, the D3 pair, and a relationship web (subtypes, both directions, self-loops): cases — every row source (scope with types and criteria; navigation with and without `step_index`; chains, `unique` both ways); every column kind × mode × `keep_empty`; `RowSlot` / `ColumnRef` with `step_index`; `max_rows` caps at 1, mid-first-expand, mid-second-expand; sort asc/desc, multi-key, repeated and out-of-range columns, `sort_mode` count/value, empties, numbers/bools/strings/element-id strings, ints past 2^53, names needing casefold (ß, ς, Cherokee, ﬁ), D3's mixed column; `has_script` for a ref'd snippet, an inline `code: ""`, `{}`, a navigation with a script step, one reached by id. Under 400 entities.
- [ ] **Step 2: Failing tests.** `casefold.test.ts` (tabulated, M-casefold); `schema.test.ts` (each `_validate_sources` refusal is 422 with a path; defaults filled; unknown keys ignored; a stored payload read the same way); `rows.golden.test.ts` replays `table_rows` (build and order through a drained `Steps`, compared by `JSON.stringify` after `toWire`, `has_script` against `tableHasScript`); `sort.test.ts`: desc keeps equal rows in build order; the comparator never reverses; an int past `Number.MAX_VALUE` throws.
- [ ] **Step 3: See them fail.** `pixi run golden-fixtures`, `pixi run engine-test`: the four new files red at import; the staleness test proves no existing fixture moved.
- [ ] **Step 4: Implement** M1–M4 and M-casefold.
- [ ] **Step 5: See them pass;** `pixi run -e core-dev pytest tests/golden -q`, `pixi run engine-check`, `pixi run engine-tidy`, ruff on the Python files.
- [ ] **Step 6: Docs.** `engine/README.md`: a `src/table/` bullet (the port, the reader's own words, rows and order, D3's tag, casefold); the golden bullet gains `table_rows` and `casefold-tables.ts`.
- [ ] **Step 7: Commit:** `Port table rows and order to the engine`.

---

### Task 3: Cells and `evaluateTable` · `critical-implementer`
*Reason: the wire body must match the route byte for byte (field order, nulls, `PropertyValue` keys, exact values) and the 501 seam decides where a table is read.*

**Files:** `engine/src/table/{cells,nav-memo,virtual-props,cell-text,page,route}.ts`, `engine/src/evaluate/index.ts`, `tests/golden/scenarios/table_eval.py`, `tests/golden/model_steps.py` (`_read` case `evaluateTable`), `engine/test/table/{table.golden,staged,cells}.test.ts`, `engine/src/index.ts`, `engine/README.md`.

**Interfaces:**
- Consumes: Task 2.
- Produces: `evaluateCellsSteps(model, defn, keys, baseSlots, limits, meter, memo)`, `NavMemo`, `cellText(model, cell)`, `TableCell` / `TablePageBody` types, `evaluateTable` in `EVALUATIONS`, `tableSteps(model, defn, limits)`. `EvalContext.tableOrders?` is added in Task 4; here the evaluation runs uncached.
- **Recorder:** `_read` gains `case "evaluateTable"` → `tables.evaluate_table(...)` with every argument passed and the stand-in artifact db, as `evaluateNavigation`'s; `{"do": "cell_text", "definition", "offset", "limit"}` records `cell_text` of each cell of the page.

- [ ] **Step 1: Scenario `table_eval`.** Reuses `table_rows`' model; `read` steps for: paging (offset 0, mid, past the end, `limit` 1 and 500); every column kind × mode; `cell_cap` 1 / 20 / 21 reached and `ignore` absent; values `1`, `1.0`, `True`, `2**60`, `-0.0`, strings with quotes and non-ASCII, lists, nested lists, dicts, absent vs `None` vs `[]`; `_Stereotype`; element cells as `TreeItem`s; truncated at the cap with expand columns (bug A's shape); the 422s (bad params, dangling navigation ref, `ValueError` from a navigation) — the fixture records status and the Python detail, and the engine test compares the STATUS and, for the core's own messages, the text; a table by id; `cell_text` of a page. Plus `staged` cases the engine replays with the artifacts in its staged layer (as `engine/test/navigation/staged.test.ts` does): a staged table by id, a staged navigation reached by a committed table, a staged delete hiding a navigation (→ 422).
- [ ] **Step 2: Failing tests.** `table.golden.test.ts` replays `table_eval` (bodies by `JSON.stringify` — key order included); `staged.test.ts` as above; `cells.test.ts`: NavMemo LRU (65 distinct roots evict the first; a hit returns the same nodes); a script table (ref'd snippet; inline `code: ""`; a navigation column reaching a script by id; a staged navigation GAINING a script step) answers 501 `reaches a script` with no step run, and the same table after unstaging answers 200.
- [ ] **Step 3: See them fail** (fixtures regenerated; the new files red).
- [ ] **Step 4: Implement** M5 and M6 (uncached).
- [ ] **Step 5: See them pass;** staleness, `engine-check`, `engine-tidy`, ruff.
- [ ] **Step 6: Docs.** `engine/README.md`: `evaluateTable` (answers, 501, refusals in its own words, `warnings: []` and `script_status: null` always), cells and NavMemo; golden bullet `table_eval`, `cell_text`.
- [ ] **Step 7: Commit:** `Evaluate tables in the engine`.

---

### Task 4: The order cache and `artifacts_version` · `critical-implementer`
*Reason: cache invalidation and a new wire field across the scheduler's interleavings (fact 13).*

**Files:** `engine/src/table/order-cache.ts`, `engine/src/table/route.ts`, `engine/src/evaluate/index.ts`, `engine/src/artifacts/artifact-set.ts`, `engine/src/service/{service,types}.ts`, `engine/test/table/cache.test.ts`, `engine/test/service/{artifacts-version,tables}.test.ts`, `engine/test/service/issues.test.ts` and `frontend/src/lib/engine/__tests__/sync-events.test.ts` (the `changed` literals), `architecture/contracts.md` (CT-4), `engine/README.md`.

**Interfaces:**
- Produces: `TableOrderCache`, `CachedOrder`, `EvalContext.tableOrders?`; `ArtifactSet.version`; `WireChanged.artifacts_version: number`.

- [ ] **Step 1: Failing tests.**
  - `cache.test.ts` (evaluation with a cache, no service): page 2 after page 1 runs no build (count `Meter` units, or spy on nothing — assert the second call's steps are O(page): fewer than a fixed bound); a stage (new `stagedVersion`) misses; a delta (new `rev`) misses; a header/width/hidden/`display_order`/export edit hits (D5); a sort or a column source edit misses; a navigation artifact change reached by the table misses (key moves) while an unrelated artifact change hits (D6); 17 distinct keys evict the least recent; a scan dropped before its sort completes stores nothing, one dropped during its cells stores the order (D8).
  - `tables.test.ts` (service over a link): `evaluateTable` answers the fixture's body; a `setStagedArtifacts` posted between two slices of a running table scan does not change that answer and the next call sees it (Review Focus 2); `{cancel}` while it runs answers nothing and a later call answers; a 409 before `ready`.
  - `artifacts-version.test.ts`: `setArtifacts`, `putArtifacts`, `setStagedArtifacts` with a table / navigation change post `changed` with `artifacts_version` moved and `issues_version` unchanged; an identical `setStagedArtifacts` posts nothing; a rules change posts with both moved; nothing posts before `ready`.
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement** M7, M8, D5–D9. Update every `changed` literal in tests.
- [ ] **Step 4: See them pass;** `pixi run engine-test`, `engine-check`, `engine-tidy`, `frontend-test` (the sync literal), `frontend-check`.
- [ ] **Step 5: Docs.** CT-4: `evaluateTable` and `artifacts_version` on `changed`. `engine/README.md`: the cache (key, stamp, when it stores), `ArtifactSet.version`.
- [ ] **Step 6: Commit:** `Cache table orders and announce artifact moves`.

---

### Task 5: The gate at M · `implementer`

**Files:** `engine/bench/big-table.json`, `engine/bench/run.ts`, `engine/bench/parity-large.ts`, `scripts/table_large.py`, `pixi.toml`, `frontend/bench/{main,run}.ts`, `frontend/bench/vite.config.ts`, `engine/README.md`, `CLAUDE.md` only if a command changes.

**Interfaces:** Consumes `tableSteps`, `evaluateTable`, `TableOrderCache` (Tasks 3–4).

- [ ] **Step 1: Parity first.** `scripts/table_large.py` per M10 (reads `benchmarks/large.snapshot.v2`'s model the way `scripts/issues_large.py` does, `engine/bench/big-table.json`, writes `benchmarks/large.table.json`); `pixi.toml`: `engine-parity-oracle` also runs it (or a new `engine-table-oracle` in `engine-parity-large`'s `depends-on`). `parity-large.ts` compares per M10 BEFORE applying the violation ops. Run `pixi run engine-parity-large`: expected equal for the issues AND the table. A mismatch is an engine bug: fix it (in `src/table/`, with a new `table_eval` case reproducing it), never the oracle.
- [ ] **Step 2: Node rows** per M10; run `pixi run engine-bench` once.
- [ ] **Step 3: Browser rows** per M10 (table rows and R19's rules rows, all before the bad delta); run `pixi run engine-bench-browser` once.
- [ ] **Step 4: Report** the medians of 3 to the orchestrator (who reports to the owner): gate total vs 3 s and its longest step vs 16 ms; first page and cached page (Node and Chromium) and the browser's longest slice; the rules rescan and its slice. Do NOT optimize. If the gate misses, stop here with the profile of where the time goes (build / order / cells split — add those three rows).
- [ ] **Step 5: Docs.** `engine/README.md` bench and parity bullets.
- [ ] **Step 6: Commit:** `Measure the table gate at M`.

---

### Task 6: Tables in the shell · `critical-implementer`
*Reason: the store's concurrency — generations, aborts, debounce, two sides — where stale pages can mix silently (Review Focus 1, 6).*

**Files:** see File Structure, Frontend (all but bench and e2e).

**Interfaces:**
- Consumes: `evaluateTable` (engine), `WireChanged.artifacts_version`.
- Produces: `'tables'` surface; `evaluateTable(args & {signal?}, cfg?)`; `TablePage.fallback?`; `scheduleTablesRepage()`, `repageOpenTables()`; `followTables(sync)`.

- [ ] **Step 1: Failing tests.**
  - `surfaces.test.ts`: `SURFACES` and `SURFACE_DEFAULTS` include `tables: 'engine'`; `staging: engine` does not force it (D10); the `allServer` object gains it.
  - `api/__tests__/tables.test.ts` (routing, modelled on `artifacts.test.ts:100-247`, the real `EVALUATIONS['evaluateTable']` over a small fixture model): engine side answers; by id; a script table is marked `fallback: 'script'` and answered by the MSW server; the server side; an aborted signal rejects with `AbortError` on both sides.
  - `table-editor-repage.test.ts` (real engine through an in-process link, no fake timers — wait for the debounce with `vi.waitFor`): a staged property edit re-pages an open tab once after ≥ 300 ms and the page shows the staged value; three edits within the window cause one re-page; the grid's rows stay installed while the re-page is in flight (`getTableData` never goes to `null` / placeholders) and are replaced at install; a chunk asked before a staged change and answered after it is dropped even with an equal `total` (Review Focus 1); a failing re-page keeps the page and sets no error; an abort sets nothing; a suspended tab is marked stale, not loaded; a never-evaluated tab is not loaded; a staged navigation edit (only `artifacts_version` moves) re-pages a table using it; with `tables` on `server`, `changed` re-pages nothing and the commit feed does, and on `engine` the feed does not.
  - `TableView.test.ts`: `table-fallback` renders with the script text when the page carries `fallback: 'script'`, not otherwise; the busy hint shows during a background re-page.
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement** M9 and D10–D14: the surface; `route()` in `evaluateTable`; the gate in `replica.svelte.ts`; `followTables`; the debounce, `repageOpenTables`, background loads, the per-tab `AbortController`; the side check on `handleTableModelRevChanged`; `fallback` through `TablePageSchema`, `TableData`, `installPage`; the marker in `TableView`; `TableGrid`'s error replaces the grid only with no page. The shadow needs no `present` branch if the engine's body equals the server's for a non-script table (Task 3's fixture proves it); add one only if a real difference shows, and report it.
- [ ] **Step 4: See them pass;** `pixi run frontend-test`, `frontend-check`, `dr-tidy`.
- [ ] **Step 5: Docs.** `frontend/src/lib/engine/README.md`: the `tables` surface, its gate, the marker, `artifacts_version`. `frontend/README.md`: the table store's re-page (debounce, background, aborts, one path per side).
- [ ] **Step 6: Commit:** `Serve tables from the engine`.

---

### Task 7: Re-drive a stalled sweep · `critical-implementer`
*Reason: the live store's liveness after a failure; a wrong fix loops or answers a half-swept store as complete.*

**Files:** `engine/src/service/service.ts` (and `engine/src/validation/live.ts` if the flag lives there), `engine/test/service/issues.test.ts`, `engine/README.md`, `BACKLOG-ENGINE.md` only if the item was filed.

- [ ] **Step 1: Failing test** (a spy with pass-through on the sweep's step, as plan 3's R22 tests inject faults): with no rules and no rescan queued, the first plain sweep step throws once; a later `getModelIssues` re-drives the sweep, which completes; the store equals a fresh sweep; `swept` is true afterwards (tag scopes stop calling `origins()` — assert through the existing hook the plan-3 tests use). A step that always throws: N reads cause at most N re-drives and no `changed` storm (`issues_version` unchanged).
- [ ] **Step 2: See it fail.**
- [ ] **Step 3: Implement** M11.
- [ ] **Step 4: See it pass;** `engine-test`, `engine-check`, `engine-tidy`.
- [ ] **Step 5: Docs.** `engine/README.md` (the live store's failure path, one sentence).
- [ ] **Step 6: Commit:** `Restart a sweep that stalled on a failed step`.

---

### Task 8: e2e and the documents · `implementer`

**Files:** `frontend/e2e/eval-tables.spec.ts` (create), `frontend/e2e/script-embedding.spec.ts`, `frontend/e2e/eval-rules.spec.ts`, `BACKLOG.md` (T-8 closed), `BACKLOG-ENGINE.md`, `architecture/program.md`, `src/data_rover/api/README.md` (the engine path for tables, one line).

- [ ] **Step 1: T-8.** Replace the header `Sort by` wait with the dialog (fact 18): `table-sort-button` → `sort-toggle-${scriptColIndex}` → expect `sort-dir-${scriptColIndex}` ▲ → `sort-done` → dialog hidden → `expect.poll` on the column's cells for the sorted order; flip with `sort-dir-…` for descending.
- [ ] **Step 2: `eval-rules.spec.ts` cleanup.** A `test.afterEach` that, through `peer(playwright)` and `projectIdByName`, PATCHes `strict_mode: false` and deletes a leftover rule set by name, then disposes the context; it runs whether the test passed or failed.
- [ ] **Step 3: `eval-tables.spec.ts`** (engine mode, shadow on, the standard fixtures): (a) a table over a STAGED navigation (created in the navigation editor, not committed) shows its rows before any commit; (b) an open table sorted by name re-sorts after a staged rename in the side panel, without a reload, and Discard restores the order; (c) a table with a script column shows `table-fallback` and its server-served cells (pending then values, as `script-embedding.spec.ts` waits for them); (d) staging a navigation edit that adds a script step to a table's navigation column flips it to the marker, unstaging flips it back (Review Focus 4).
- [ ] **Step 4: Full verification.** `pixi run dr-test`, `pixi run dr-tidy true`, `engine-check`, `frontend-check`, `sandbox-check`, `engine-parity-large`; `sandbox-build` then e2e: expected all green but T-9, and no `[shadow]` line in the output (grep). Report the counts against the baseline.
- [ ] **Step 5: Docs.** `program.md`: C's status (plan 4 built: tables in the engine, staged artifacts included; the gate's measured numbers with date and host), MR-3's text (`core/table` evaluation frozen from plan 4, features lift when `tables` defaults — which it now does — bugs both sides until F). `BACKLOG.md`: T-8 closed. `BACKLOG-ENGINE.md`: the design §9 item "on the server path an artifact-only commit that changes a referenced navigation does not re-page an open table" (engine mode fixes it), any item the build filed.
- [ ] **Step 6: Commit:** `Cover engine tables end to end and record the plan`.
- [ ] **Step 7: Owner's go-ahead** for the `engine-migration` fast-forward (the orchestrator asks; nothing is pushed there without it).

## After this plan

Plan 5 (exports) starts from here:
- `cellText`, `tableSteps` and `TableOrderCache` exist; exporters resolve their tables through the `ArtifactSet` (`tableFetch`), so staged tables are used;
- `core/table`'s writers freeze with plan 5; its evaluation froze here.

Open from this plan: `K-69`; still open from plans 2–3: `K-65`, `K-66`, `K-68`, K-60's server half, `C-23`, `K-58`, `K-62`, `K-63`, `T-10`, `T-9`.
