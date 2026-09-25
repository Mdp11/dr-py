# Code Execution M2+M3 — ScriptColumn & ScriptStep — design

Date: 2026-07-19
Status: approved (brainstorming session)
Parent spec: `2026-07-17-code-execution-design.md` (§6, §14 M2/M3), updated here
against the M1-as-built runner and the multi-element `value(elements)` contract
(`2026-07-19-multi-element-value-snippets-design.md`).

## Goal

One execution delivering both embedding milestones:

- **M2 — `ScriptColumn`**: a table column whose cells are computed by a
  snippet's `value(elements)` entry point, with sorting/paging/export working
  unchanged.
- **M3 — `ScriptStep`**: a navigation step that advances the frontier via a
  snippet's `step(el)` entry point, composing with the existing chain engine.

They share one new mechanism — the runner **evaluation session** — which is why
they ship together.

## Baseline

The multi-element `value(elements)` contract (value takes a `list[Element]`,
wire field `element_ids`) is already merged to `main`
(`3cf94ff Merge feat/multi-element-value`). Everything below assumes that
contract; there is no prerequisite work.

## Decisions (from brainstorming)

1. **Per-row call shape**: the table engine calls `value(elements)` **once per
   row**, passing the row's full bound-element list in cell order (a 1-item
   list for a `RowSlot` source). No per-element fan-out.
2. **UI scope**: both **ref** (saved snippet artifact) and **inline** snippet
   definitions are editable in the ColumnManager and the nav step editor.
   Inline editing reuses the snippet tab's CodeMirror + lint setup via a shared
   component.
3. **Architecture**: **session mode** on the `ScriptRunner` protocol
   (`open_session` → repeated `call` → `close`), one warm guest instance per
   evaluation. Rejected: batch one-shot runs (doesn't fit the incrementally
   discovered navigation frontier); one `run()` per element (a full interpreter
   boot per row).

## 1. Runner session protocol

`core/script/runner.py` gains (console `run()` path unchanged):

```python
@dataclass
class CallResult:
    value: object | None          # decoded wire payload (tagged shape, §1a)
    error: ScriptError | None
    duration_ms: int

class SnippetSession(Protocol):
    boot_error: ScriptError | None    # facade+module exec failed at open
    def call(self, entry: Literal["value", "step"],
             element_ids: list[str]) -> CallResult: ...
    def close(self) -> None:          # idempotent; discards the instance
        ...

class ScriptRunner(Protocol):
    def run(...) -> RunResult: ...    # unchanged one-shot console path
    def open_session(self, model: Model, code: str, limits: RunLimits,
                     *, budget: ScriptBudget) -> SnippetSession: ...
```

`ScriptBudget` is a small deadline holder in `core/script/runner.py`
(`remaining() -> float`, `exhausted -> bool`), constructed once per top-level
request from `snippet_eval_budget_s` (§5) and threaded through everything that
does snippet work.

- **Guest protocol** (`WasmScriptRunner`): the start message gains
  `mode: "embedded"`. The guest execs `FACADE_SOURCE + code` once, then loops:
  read `{"call": {"entry", "element_ids"}}` → invoke the entry → reply one
  result frame; `{"close": true}` ends the loop. Module-level exceptions emit a
  boot-error frame → `boot_error`. The instance comes from the warm pool and is
  **discarded on close, never reused** (one-instance-per-run hygiene holds).
- **Read-only by construction**: sessions build their `BridgeDispatcher` with
  `record_ops=False`; a `dr` write raises `dr.ReadOnlyError` inside the snippet
  and surfaces as that call's `error` — a per-cell error, never a run abort.
- **Timeouts**: each `call` arms the epoch deadline at
  `min(limits.wall_timeout_s, budget.remaining())`. When the request budget
  expires the host also closes the bridge channel, so a guest blocked on a
  bridge read dies too (two-sided-deadline rule, unchanged).
- `tests/script/trusted_runner.py`'s `TrustedRunner` implements identical
  session semantics in-process (still never moves to `src/`).

### 1a. Return-value wire mapping

Guest serializes, host decodes into `CallResult.value`:

| snippet returns | wire shape | table cell |
|---|---|---|
| scalar (str/int/float/bool/None) | `{"kind":"scalar","value":...}` | `ValueCell` |
| list/tuple of scalars | `{"kind":"scalars","values":[...]}` | `ValuesCell` |
| `Element` | `{"kind":"element","id":...}` | `ElementCell` |
| list of `Element`s | `{"kind":"elements","ids":[...]}` | `ElementsCell` |
| anything else | per-call error | `ErrorCell` |

`step()` returns an iterable of `Element`s or id strings → `{"ids":[...]}`;
anything else is a per-call error. The "anything else" error message names the
four legal shapes.

## 2. Schemas

- **`SnippetSource`** (`core/script/schema.py`) — exact `NavigationSource`
  clone: at most one of `ref: str | None` (snippet artifact id) /
  `definition: SnippetDefinition | None`; `{}` is legal-unconfigured;
  `.is_empty` property.
- **`ScriptColumn`** — fourth arm of the `Column` union
  (`core/table/schema.py`): `kind="script"`, `source: ColumnSource`,
  `snippet: SnippetSource`, `mode: "collapse" | "expand"`, `keep_empty`,
  `header`, `hidden`, `width_px`.
  - `_source_arity`: a script column is **element-capable at runtime** — a
    `ColumnRef` against it is legal; if the actual cell holds scalars the
    downstream binding is empty (tolerant stance; the return type is not
    statically knowable). `step_index` refs remain illegal against it.
- **`ScriptStep`** — fourth arm of `StepItem` (`core/navigation/schema.py`):
  `kind="script"`, `snippet: SnippetSource`, `comment`. Contributes one chain
  column; its `step_types` entry is `comment or "script"`.
- **`ErrorCell`** — new `Cell` variant (`core/table/cells.py`):
  `{ message: str, traceback: str | None }`. Wired through
  `cells.py::evaluate_cells`, `tables.py::_cell_out`,
  `table_export.py::_cell_text`, `schemas.TableCellOut` (`kind: "error"`), and
  sorting (**errors sort with empties: last in both directions**).
- No Alembic migration: the `code_snippet` artifact kind exists since M1;
  `ScriptColumn`/`ScriptStep` live inside existing JSON payloads validated by
  `TABLE_ADAPTER`/`NAVIGATION_ADAPTER`.

## 3. Table evaluation (`ScriptColumn`)

- **Ref resolution at the route** (mirroring `_resolve_table_navigation_refs`):
  `core/table/resolve.py` gains a snippet-resolve pass that inlines a `ref`'s
  saved code into the resolved definition before evaluation. Dangling ref →
  every cell of that column is `ErrorCell("snippet not found")`; unconfigured
  (`{}`) → empty cells. Inlining also makes the **row-order cache fingerprint**
  correct for free: `table_fingerprint` hashes the resolved-definition JSON,
  which now contains the code, so editing a referenced snippet invalidates
  cached orders.
- **One session per script column per evaluation**, opened lazily at the first
  script cell, closed when the evaluation ends (route-level `finally`).
  `boot_error` → every cell of that column carries that error.
- **Per row**: `resolve_source_elements` → bound ids →
  `session.call("value", ids)` with the full list. Empty binding → empty cell,
  **no call** (property-column parity; `keep_empty=False` filters as usual).
- **Per-evaluation memo**: `(column, row-key) → cell`, so sorting by a script
  column and then rendering the page calls `value()` at most once per row.
- **Expand mode & sorting** evaluate the script for all base rows (that is how
  row building/ordering already works) — bounded by the request budget; rows
  past budget get `ErrorCell("evaluation budget exhausted")` and expansion
  degrades to a single error row.
- **Cache-poisoning guard**: the row order is stored in `TableOrderCache`
  **only** when the evaluation completed with zero script errors and the API
  `Session.model_rev` is unchanged across the evaluation. Errored, budget-
  truncated, or stale orders are served to the caller but never cached
  (neither key — code hash, `model_rev` — would change on retry, so a cached
  bad order would be served forever).
- **xlsx export** gains the same budget; past-budget cells are written as an
  error marker string and the workbook gets a final truncation-notice row.
  (Export currently has no time bound; the budget applies to script work only —
  non-script exports behave exactly as today.)

## 4. Navigation evaluation (`ScriptStep`)

- Core `evaluate()` gains optional script plumbing (runner + limits + budget —
  all `core`-legal types); one session per script step, opened lazily during
  the walk, closed by the caller.
- In `_walk`, a `ScriptStep` maps `current` → `session.call("step",
  [current_id])` → returned ids are validated against the model (unknown ids
  dropped, with a warning), deduped preserving order, `exclude_visited`
  applied — then the chain continues exactly like after a `RelationshipStep`.
  A `PropertyValue` frontier node prunes at a script step (script steps operate
  on elements only).
- **Errors prune, never abort**: a per-element call error prunes that chain and
  records a warning; `boot_error` prunes all chains through that step with one
  warning; budget exhaustion prunes the remainder with a warning. Warnings are
  deduplicated and capped at 20 per response.
- **New warnings channel**: `ChainResult.warnings: list[str]` (none exists
  today; missing-property stays a silent prune — the channel is new and used
  only by script steps for now). Surfaced as `warnings` on `ChainPageOut`, and
  aggregated onto `TablePageOut` when a table's navigation columns trigger
  script steps.

## 5. Budgets, concurrency, degraded modes

- **`snippet_eval_budget_s`** (default 30; `DATA_ROVER_SNIPPET_EVAL_BUDGET_S`):
  one budget object per top-level request (table evaluate, nav evaluate,
  export), shared by all snippet work it transitively triggers — a script step
  inside a navigation used by a table column draws from the same budget, never
  multiplies it. Per-call deadline = `min(wall_timeout_s, remaining)`, so one
  runaway cell costs ≤ `wall_timeout_s`, not the whole budget.
- **Concurrency**: an embedded evaluation acquires **one global slot** from the
  existing snippet concurrency guard for the session's lifetime (the per-user
  cap does not apply to embedded work). No slot free → fail fast as *degraded
  content*, not 429: script cells become `ErrorCell("snippet runner busy")`,
  script steps prune with a warning — the table/nav still renders.
- **Runner unavailable** (`get_runner()` → `None`, guest binary not fetched):
  same degraded rendering with "script runner unavailable". Routes stay 200.
- **Security stance unchanged**: sessions are read-only by construction;
  snippets run with the runner's privileges; viewers may evaluate (these routes
  are already in the read-only-POST allowlist). Determinism shims unchanged;
  incomplete evaluations are never cached.

## 6. Routes & API schemas

- `POST /tables/evaluate`, `/tables/export`, `/navigations/evaluate` gain
  `runner: ScriptRunner | None = Depends(get_runner)` — the seam
  `routes/snippets.py` already uses. No new routes, no auth changes.
- `schemas.py`: `TableCellOut` gains `kind: "error"` + `message` + optional
  `traceback`; `ChainPageOut` and `TablePageOut` gain
  `warnings: list[str] = []`.
- Artifact CRUD untouched; extended adapters validate the new payload variants
  automatically.

## 7. Frontend

- **Shared editor component**: extract the snippet tab's CodeMirror setup
  (Python mode, debounced `/snippets/lint` diagnostics gutter) into a reusable
  component; the snippet tab and both inline editors below consume it.
- **ScriptColumnEditor** (`ColumnManager` gains a "+ Script" button,
  `table-editor.svelte.ts` gains `newScriptColumn()`): source picker as in
  property/nav editors, then a ref/inline toggle — ref mode is an artifact
  picker filtered to `entry_points` containing `"value"`; inline mode embeds
  the shared code editor (lint warns when no `value()` is defined).
  Collapse/expand + keep_empty controls as sibling editors have.
- **ScriptStepRow** (nav `PathCard` insert menu gains "Script step"): same
  ref/inline pattern, picker filtered to `entry_points` containing `"step"`;
  inline editor in the row's expandable area, following existing step-row
  patterns.
- **Rendering**: error cells show a warning glyph + message (traceback in the
  tooltip/title); a warnings banner on table/nav results when `warnings` is
  non-empty.
- **Stale refs**: no live push in this milestone — edits to a referenced
  snippet take effect on the next evaluation (the inlined-code fingerprint
  guarantees the cache cannot serve pre-edit orders).

## 8. Testing (TDD, mirroring existing layout)

- **`tests/script/`** (TrustedRunner): session semantics — repeated calls on
  one session, boot error, per-call error, read-only enforcement (`dr` write →
  per-call error), wire mapping of all four return shapes + the invalid case.
- **`tests/table/`, `tests/navigation/`** (core, hermetic): script column cell
  mapping, collapse/expand, keep_empty, `ColumnRef` chaining off script columns
  (element and scalar cases), sorting + memo (snippet called at most once per
  row), budget exhaustion → error cells; script step frontier advance, dedup,
  `exclude_visited`, unknown-id drop, prune + warnings, `PropertyValue` prune.
- **`tests/api/`** (TrustedRunner injected): evaluate/export/nav routes
  end-to-end, cache-poisoning guard (no cache write on error/stale), dangling
  ref, runner-`None` and busy degraded modes, warnings passthrough, fingerprint
  invalidation on snippet edit.
- **`tests/api/test_snippets_wasm.py`** (integration-marked, real sandbox):
  session mode — repeated calls on one warm instance, per-call timeout kill
  mid-session, boot error, module globals surviving between calls within a
  session, determinism.
- **Frontend vitest**: both editors, pickers (entry-point filtering), error-cell
  rendering, warnings banner. **Playwright**: add a script column → computed
  cells + an error cell + sort; script step inside a navigation.

## Out of scope

- Live re-evaluation push when a referenced snippet changes (next-evaluation
  freshness only).
- A per-cell/value cache (only the existing row-order cache is touched).
- `call_many` chunked session calls (backwards-compatible optimization if
  profiling demands it).
- Real cancellation of embedded runs (M1's no-op cancel stance unchanged).
- M4 polish items (facade docs panel, example snippets, fairness tuning).
