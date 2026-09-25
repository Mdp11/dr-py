# Stage 2 — Table System — Design Spec

Date: 2026-07-10
Status: Approved design. Implementation via two plans (backend, frontend).

Parent: `docs/superpowers/specs/2026-07-05-navigation-tables-diagrams-megaplan-design.md`
Builds on: Stage 1 (navigation engine + builder), merged at `2092a78`.

## Summary

Customizable, server-evaluated tables as a new artifact kind. Rows come from an
element scope, a navigation's element set, or a navigation's chains. Columns show
the row element, one of its properties, or the elements a navigation reaches from
it. A navigation column may be rooted at an *earlier column's* result rather than
at the row element, and any multi-valued column may either **collapse** its values
into one cell or **expand** them into one row per value. Property cells are
editable through the existing checkout/commit flow. The whole table exports to
`.xlsx`.

Stage 1's "open navigation as table" folds in as a table whose row source is that
navigation's chains — no separate chain viewer.

## Decisions

| Decision | Choice |
|---|---|
| Row identity | A tuple of **bindings**: row-source slots + one slot per expand column |
| Row source | `scope` \| `navigation` (element set) \| `chains` (one row per chain) |
| Row-rooted navigation | Explicit `{"kind":"row"}` start sentinel in the navigation schema |
| `RowStart` binding | Binds to a **set** of elements, not one — subsumes single and multi rooting |
| Column source | `{"kind":"row", chain_index}` or `{"kind":"column", index}` (earlier column) |
| Multi-value handling | Per-column `mode: collapse \| expand`, with a table-level `default_cell_mode` |
| Expandable columns | Navigation columns **and** multiplicity-`many` property columns |
| Empty expand | Per-column `keep_empty` (default `true` — outer join) |
| Nav column sort | Per-column `sort_mode: value \| count` |
| Paging | Stateless offset/limit + a per-session **row-order cache** keyed on `(resolved-definition fingerprint, sort, model_rev)` |
| Column state | `header` and `width_px` live in the artifact; per-datatype **formats deferred** |
| Cell editing | Property cells, editable iff single-element source and `mode != expand`; existing `editLock` → `emit` → `DiffDrawer` → `POST /commits` |
| Export | Server-side `.xlsx` via `openpyxl`, whole table, honouring the current sort |
| Storage | `project_artifacts` row, `kind='table'`, definition in the `payload` JSON column |
| View placement | Folders work already; **root placement is new** (`View.artifacts`) |
| Nav→table | `ref` when the navigation is saved, inline snapshot when it's a draft |

## Where the definition lives

A table definition is the `payload` JSON of a `project_artifacts` row with
`kind='table'`. It is **not** model content: never in `model.json`, never in the
op journal. It is project-shared DB state, role-gated (viewer reads, editor+
writes), survives session eviction, and is deleted with the project.

The only backend plumbing needed is registering the payload adapter:

```python
_PAYLOAD_ADAPTERS[ArtifactKind.table] = TABLE_ADAPTER   # artifacts.py
```

Everything else in the artifacts router is already kind-agnostic: the
`(project_id, kind, name)` uniqueness constraint, `artifact_rev` optimistic
concurrency (409 with `{"current_rev": n}`), the `artifact_event` feed broadcast,
and viewer/editor gating. `ArtifactKind.table` is already in the enum, and the
column is `SAEnum(..., native_enum=False)` whose CHECK already admits `'table'`
— **no Alembic migration is required.**

The DB is the source of truth. Each open table tab holds a draft copy of the
definition plus its `artifact_rev`, exactly as `navigation-editor.svelte.ts` does.

The xlsx export is a *data* export. It does not round-trip into a definition.

## Core schema changes

### `core/navigation/schema.py` — the `RowStart` sentinel

```python
class RowStart(BaseModel):
    """Start = the element(s) this navigation is rooted at by its caller.

    Only meaningful when evaluated with a row binding (table columns).
    `evaluate()` raises ValueError when a RowStart is reached with no binding."""
    kind: Literal["row"] = "row"

StartNode = Annotated[Union[Scope, SetExpression, RowStart], Field(discriminator="kind")]
```

`SCHEMA_VERSION` goes 2 → 3. Purely additive: existing stored payloads carry
`schema_version: 2` and remain valid, because the field is informational and no
validator compares it.

Why a sentinel rather than rewriting leaf starts, and rather than reusing Stage
1's "one element" start:

- Stage 1's element start is `{types: [], criteria: [{name_id, id, equals, <id>}]}`
  (`elementStartScope` in `frontend/src/lib/navigation/tree.ts`). `_scope_ids`
  (`core/navigation/evaluate.py:126`) resolves an empty-`types` scope by iterating
  **every element in the model**. A 50 000-row table with a row-rooted navigation
  column would be O(rows × model). `RowStart` is a direct dict lookup.
- A sentinel is a node in the tree, so rooting composes. This is expressible:

  ```json
  {"kind":"set_op","op":"intersection","operands":[
    {"definition":{"kind":"path","start":{"kind":"row"},"steps":[...]}},
    {"ref":"nav-safety-critical"}
  ]}
  ```

  i.e. *intersect what this row reaches with a saved global set*. Implicit
  leaf-start rewriting would clobber the ref's own start and make that
  inexpressible; it would also be invisible in the stored payload.

`evaluate()` gains `row_elements: Sequence[str] | None = None`. A `RowStart`
resolves to `sorted(row_elements)`. Binding a **set** rather than a single element
is what makes "source from another cell" fall out for free: a navigation column
sourced from an expanded column receives a singleton; one sourced from a collapsed
multi-element cell receives that cell's whole set and unions the results. Same
code path, no special case.

`POST /navigations/evaluate` gains an optional `row_element_id` so the Stage 1
builder can preview a row-rooted navigation against a sample element. Without a
binding, evaluating a `RowStart` definition is a 422.

### `core/view/schema.py` — root artifact placement

```python
class View(BaseModel):
    name: str
    folders: list[Folder] = Field(default_factory=list)
    artifacts: list[ArtifactRef] = Field(default_factory=list)   # NEW: root level
```

Stage 1 already ships `ArtifactRef {id, kind}` and `Folder.artifacts`, generic
across kinds, with DnD, multi-folder placement, delete-scrub
(`scrubArtifactFromView`), and the tolerate-dangling-refs rule. What is missing is
the **root**:

- `View` had no top-level `artifacts` list. Elements get an implicit root fallback
  ("elements in no folder render at the root"); artifacts had no equivalent, so an
  artifact was only visible in the tree once dropped into some folder.
- `findFolderByPath(view, [])` (`frontend/src/lib/state/view-ops.ts:29-32`) returns
  a **detached** throwaway `{name:'', folders: view.folders, elements: [], artifacts: []}`.
  `placeArtifactInView(view, [], ref)` therefore mutated an object that was
  discarded — a silent no-op.

Stage 2 adds the field and an explicit `path.length === 0` branch in the artifact
view-ops, and documents (or asserts against) the detached-virtual-root footgun.
Additive: old `view.json` files stay valid; `ViewRow` stores JSON, so no migration.

An artifact in neither `View.artifacts` nor any folder simply does not appear in
the tree. That is correct — the sidebar Artifacts section is its unplaced home —
and it keeps "remove from view" meaningful and root ordering representable.

### New `core/table/schema.py`

```python
SCHEMA_VERSION = 1
MAX_COLUMNS = 50

# exactly-one-of {ref, definition}; like navigation.Operand minus step_index
class NavigationSource(BaseModel):
    ref: str | None = None
    definition: NavigationDefinition | None = None

# ---- row source -------------------------------------------------------------
class ScopeRows(BaseModel):        # one binding slot
    kind: Literal["scope"] = "scope"
    types: list[str] = Field(default_factory=list)
    criteria: list[Criterion] = Field(default_factory=list)

class NavigationRows(BaseModel):   # one binding slot (deduped element set)
    kind: Literal["navigation"] = "navigation"
    navigation: NavigationSource
    step_index: int | None = None  # None → terminal step

class ChainRows(BaseModel):        # N binding slots (chain length)
    kind: Literal["chains"] = "chains"
    navigation: NavigationSource

RowSource = Annotated[Union[ScopeRows, NavigationRows, ChainRows], Field(discriminator="kind")]

# ---- column source ----------------------------------------------------------
class RowSlot(BaseModel):
    kind: Literal["row"] = "row"
    chain_index: int = 0

class ColumnRef(BaseModel):
    kind: Literal["column"] = "column"
    index: int                     # must be < this column's own index

ColumnSource = Annotated[Union[RowSlot, ColumnRef], Field(discriminator="kind")]

# ---- columns ----------------------------------------------------------------
# Every column carries: header: str = "", width_px: int | None = None.
# PropertyColumn and NavigationColumn additionally carry:
#     mode: Literal["collapse", "expand"], keep_empty: bool = True
# ElementColumn carries neither — an element binding is always singular, so it
# has nothing to collapse or expand. `keep_empty` is meaningful only when
# mode == "expand" and is ignored otherwise.
class ElementColumn(BaseModel):
    kind: Literal["element"] = "element"
    source: ColumnSource = RowSlot()

class PropertyColumn(BaseModel):
    kind: Literal["property"] = "property"
    source: ColumnSource = RowSlot()
    name: str

class NavigationColumn(BaseModel):
    kind: Literal["navigation"] = "navigation"
    source: ColumnSource = RowSlot()
    navigation: NavigationSource
    step_index: int | None = None                       # which hop to surface
    sort_mode: Literal["value", "count"] = "value"
    cell_cap: int = 20                                  # DISPLAY cap only

Column = Annotated[
    Union[ElementColumn, PropertyColumn, NavigationColumn], Field(discriminator="kind")
]

class TableDefinition(BaseModel):
    schema_version: int = SCHEMA_VERSION
    row_source: RowSource
    columns: list[Column] = Field(min_length=1, max_length=MAX_COLUMNS)
    default_cell_mode: Literal["collapse", "expand"] = "collapse"

TABLE_ADAPTER: TypeAdapter[TableDefinition]
```

`ElementColumn` has no `mode` (an element binding is always singular).

### Static validation

Enforced by pydantic model-validators on `TableDefinition`. All cheap, no model or
metamodel access. `ColumnRef.index < column_index` makes source cycles impossible
by construction.

| Rule | Rationale |
|---|---|
| `ColumnRef.index < column_index` | No cycles, no forward references |
| A navigation column's source must be element-producing (a row slot, an element column, or a navigation column) | You cannot navigate from a string |
| An element column's source must be a **single binding** (row slot or expand column) | Chips-in-a-cell is what a collapse column already is |
| An **expanded** property column's source must be a single binding | "One row per value" is undefined across many elements |
| `RowSlot.chain_index != 0` only when `row_source.kind == "chains"` | Only chains have >1 row slot |

Two rules need the metamodel or the resolved navigation, so they are checked
during evaluation and surface as **422**, not as schema errors:

| Rule | Why it cannot be static |
|---|---|
| A property column may set `mode="expand"` only when the property's multiplicity is `many` | Needs the metamodel; a scalar property would expand to itself |
| `RowSlot.chain_index` must be within the row navigation's chain length | Needs the resolved navigation's step count |

## The row model

A table has **binding slots**. The row source contributes one (`scope`,
`navigation`) or N (`chains`, one per chain column). Every `expand` column
contributes one more. **A row is a tuple of bindings.**

```python
Binding = str | int | float | bool | None   # element ids are str; expanded property values are scalars
RowKey  = tuple[Binding, ...]
```

Which slot holds an element and which holds a scalar is known statically from the
column that produced it, so there is no ambiguity at the value level. `RowKey` is
hashable and totally ordered, so it caches and pages soundly.

A `source` resolves to an **ordered set of elements**, and each column kind maps
over it:

| Column | Over a 1-element source | Over an n-element source |
|---|---|---|
| `element` | renders that element | *rejected by validation* |
| `property` | scalar cell (editable) | read-only list cell (`values`) |
| `navigation` | roots `RowStart` at it | roots `RowStart` at the whole set, unions results |

And `mode` decides what happens to the output:

- **`collapse`** — the values stay in one cell (chips for elements, a joined list
  for scalars).
- **`expand`** — the values become a new binding slot: one row per value.
  `keep_empty=true` (default, outer join) keeps a barren row with a blank cell;
  `keep_empty=false` (inner join) drops it.

Worked example — *"every Block, one row per part it owns, with each part's mass
and each part's suppliers in one cell"*:

```
row_source: {kind:"scope", types:["Block"]}
col 0  element     source=row(0)
col 1  navigation  source=row(0)     nav=owns-parts     mode=expand    → new binding slot 1
col 2  property    source=column(1)  name="mass"        mode=collapse  → editable
col 3  navigation  source=column(1)  nav=supplied-by    mode=collapse  → chips
```

**Semantic vs display truncation.** `cell_cap` truncates a collapsed navigation
cell **for the wire only**. A downstream column sourced from that cell sees the
full set (bounded by the navigation's own `EvalLimits`), never the capped 20. An
expand column is not capped by `cell_cap` at all — it is bounded by `max_rows`.

A chains table is not a special case bolted on beside this: it is a row source
whose slots arrive pre-expanded by the navigation evaluator.

### Editability, stated once

> A property cell is editable **iff its source resolves to exactly one element and
> its `mode` is not `expand`.**

So: a collapsed list of masses over many parts is read-only; an expanded
one-value-per-row property cell is read-only (`set_property` against one item of a
list-valued property has no well-defined target); an ordinary single-element cell
edits exactly as the Inspector does today, *including* multiplicity-`many`
properties, where `PropertyField` already replaces the whole list.

The server computes this arity fact and puts `element_id` + `editable` on the
cell. The client ANDs it with role and peer-lock state.

## Core evaluator — `core/table/evaluate.py`

Pure over `(metamodel, model)`, no session coupling, mirroring
`core/navigation/evaluate.py`. Deliberately three functions so the API layer can
cache the middle result.

```python
@dataclass(frozen=True)
class TableLimits:
    max_rows: int = 50_000          # ceiling on the fully expanded row set
    max_sort_rows: int = 20_000     # ceiling on sorting by a *collapsed* column
    max_cell_elements: int = 20     # default NavigationColumn.cell_cap
    nav_limits: EvalLimits = EvalLimits()

def build_rows(mm, model, defn, limits) -> tuple[list[RowKey], bool]      # + truncated
def order_rows(mm, model, defn, keys, sort, limits) -> list[RowKey]
def evaluate_cells(mm, model, defn, keys_slice, limits) -> list[Row]
def iter_export_rows(mm, model, defn, keys, limits) -> Iterator[Row]      # cell eval, chunked
```

- **`build_rows`** evaluates the row source *and every expand column*, across the
  whole table. Expansion determines `total`, so it cannot be page-local. Guarded
  by `max_rows` → `truncated: true`.
- **`order_rows`** sorts. A binding column (element, or any expand column) sorts
  straight off the `RowKey` — free. A **collapsed** column requires a full extra
  pass, guarded by `max_sort_rows` → 422 rather than a pinned worker.
- **`evaluate_cells`** runs only for the requested slice. Within one row, a
  collapsed column referenced as another column's source is memoized.

**Default order** (no sort) is the natural order from `build_rows`: row-source
order, with each expansion emitting children in the navigation evaluator's
existing deterministic order. Total and stable, so offset paging is sound.

**Sort comparators.**

| Column | Key |
|---|---|
| `element` | `(display_name.casefold(), id)` |
| `property` | Datatype-aware: numeric when *every* scoped type declaring the property gives it an integer/float datatype, else `casefold()`. Multi-valued compares as a tuple. |
| `navigation`, `sort_mode="value"` | Tuple of reached `display_name`s (cells are rendered name-sorted anyway) |
| `navigation`, `sort_mode="count"` | Cardinality |

**Missing and empty always sort last, in both directions** — not "nulls first on
descending". Ties break on the `RowKey`, so the order is total.

## API

### `POST /projects/{project_id}/tables/evaluate`

New `routes/tables.py`. Added to `authz._READ_ONLY_POST_SUFFIXES` so viewers can
read tables.

```
in : {artifact_id? | definition?,      # exactly one
      offset: int = 0,
      limit:  int = 100,               # max 500
      sort?:  {column: int, direction: "asc" | "desc"}}

out: {columns: [ColumnOut], rows: [{key: [Binding], cells: [Cell]}],
      total: int, truncated: bool, offset: int, model_rev: int}
```

`model_rev` lets the client detect a stale page and refetch.

```
{kind:"element",  item: TreeItem | null}
{kind:"value",    present: bool, value: JSON|null, element_id: str|null, editable: bool}
{kind:"values",   present: bool, values: [JSON], total: int, truncated: bool}   # read-only
{kind:"elements", items: [TreeItem], total: int, truncated: bool}
```

Cell kind is derived server-side from column kind × `mode` × source arity. The
client never has to work it out:

| Column | `mode` | Source arity | Cell kind |
|---|---|---|---|
| `element` | — | 1 | `element` |
| `property` | `collapse` | 1 | `value` (editable) |
| `property` | `collapse` | n | `values` (read-only) |
| `property` | `expand` | 1 | `value` (`editable: false`) |
| `navigation` | `collapse` | 1 or n | `elements` |
| `navigation` | `expand` | 1 or n | `element` |

An `expand` column's cell is always singular, because expansion has already put
each value on its own row.

`present: false` means **the source element's type does not declare this
property** — the cell renders greyed and is not editable. That is distinct from
`present: true, value: null` (declared but unset), which *is* editable. This is a
wire flag rather than a client-side derivation because the client would otherwise
have to resolve effective properties per row for heterogeneous chain/expand
sources, duplicating a metamodel cache the server already holds.

Errors: `LookupError` / `NavigationResolveError` / `ValueError` (bad
`chain_index`, `expand` on a scalar property, over `max_sort_rows`) → **422**.

### `POST /projects/{project_id}/tables/export`

```
in : {artifact_id? | definition?, sort?}
out: 200 application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
     Content-Disposition: attachment; filename="<table name>.xlsx"
     X-Table-Truncated: true          # when max_rows clipped the row set
```

Also a read-only POST. Exports **all** rows honouring `max_rows` and the requested
sort, not just a page — exporting what you happened to scroll to is a bug magnet.
Reuses the row-order cache.

Cell → cell rendering:

| Cell | xlsx |
|---|---|
| `element` | `display_name` |
| `value` | typed — numbers as numbers, bools as bools, else string |
| `values` | `"; "`-joined |
| `elements` | `"; "`-joined `display_name`s (**not** capped at `cell_cap`) |
| absent (`present: false`) | empty |

Header row bold and frozen; column widths from `width_px`; sheet named after the
table. Written with `openpyxl` in `write_only` mode into a `BytesIO` and returned
as a `Response`. At these caps (50 000 × 50) a truly incremental xlsx stream is
not worth the complexity.

`openpyxl = "3.1.*"` joins `[feature.api.dependencies]` in `pixi.toml`
(`core-dev` includes `api`, so tests get it). The workbook writer lives in
`api/table_export.py`, consuming `core/table/evaluate.iter_export_rows` — **core
stays dependency-light and knows nothing about xlsx.**

### Row-order cache

`Session` gains `table_order_cache`: a small LRU (cap 16) keyed by

```
(sha256(canonical JSON of the RESOLVED definition), sort spec)  ->  (model_rev, tuple[RowKey])
```

Fingerprinting the **resolved** definition (refs already inlined by
`resolve_refs`) means editing a referenced library navigation invalidates the
entry without needing a `model_rev` bump. A lookup whose stored `model_rev`
differs from the session's is a miss and is evicted; `Session.touch_model()`
clears the cache wholesale.

Guarded by its own small `threading.Lock` covering dict operations only.
Evaluation runs outside the lock; a lost race merely recomputes. Reads never take
`write_mutex`, consistent with every other read route.

Effect: the first page of a table pays full expansion + sort; subsequent pages
slice the cached order and evaluate cells for that slice alone.

## Frontend

Mirrors Stage 1's structure one-for-one.

| Stage 1 | Stage 2 |
|---|---|
| `lib/navigation/tree.ts` (pure) | `lib/table/columns.ts` (pure) |
| `state/navigation-editor.svelte.ts` | `state/table-editor.svelte.ts` |
| `components/Navigation/` | `components/Table/` |
| `api/artifacts.ts` | `api/tables.ts` |

`lib/table/columns.ts` is a separate pure module, not folded into the store, for
the same reason `tree.ts` is: positional edits (add / remove / reorder / retarget
a source / resize) are the part worth unit-testing without a reactive runtime, and
reordering columns has to **remap every `ColumnRef.index`** — exactly the kind of
index arithmetic that belongs behind a tested function. Removing a column that
another column sources from is rejected (or cascades, surfaced as a confirm).

`components/Table/`:

- `TableView.svelte` — tab root: name, Save / Save as…, Export, conflict banner.
- `TableGrid.svelte` — windowed rows reusing `Sidebar/windowing.ts`
  (`computeWindow` / `shouldLoadMore`); sticky header with sort toggles and
  drag-resize handles. Columns are few; no column virtualization.
- `ColumnManager.svelte` — add / remove / reorder / rename / set `mode`,
  `keep_empty`, `source`, `sort_mode`.
- `RowSourceEditor.svelte` — scope | navigation | chains; reuses Stage 1's
  `ScopeEditor.svelte`.
- `NavigationColumnEditor.svelte` — embeds Stage 1's `NavigationNode.svelte` with
  a `RowStart` start; `step_index`, `sort_mode`, `cell_cap`.
- `Cell/ElementCell.svelte`, `ValueCell.svelte`, `ValuesCell.svelte`,
  `ElementsCell.svelte`.

`state/table-editor.svelte.ts` keeps a per-tab `TableDraft {name, artifactId,
artifactRev, definition, dirty}` plus sparse page state and a sort spec —
`ensureDraft` / `saveDraft` / `saveAsDraft` / `reloadDraft` / `closeDraft` /
`updateDefinition` / `setSort` / `loadPage`, all named after their
`navigation-editor` counterparts. Any definition or sort change resets to page 0.
A resize marks the table dirty like any other column edit and is written on an
explicit Save, `artifact_rev` / 409 as usual.

**Cell editing** reuses the Inspector's exact path; no new mutation surface:

```
ValueCell (editable) → await editLock(elementId)     # edit-gate.ts → ensureCheckout
                     → emit({kind:'update_element', id, properties_patch})
                     → DiffDrawer → commitStaged() → POST /commits
```

The cell renderer overlays staged values from `getStagedOpsFor(id)` on top of the
server-fetched value, so an edit appears immediately without a refetch. On commit,
`model_rev` bumps and the visible page refetches. Peer commit events over the feed
mark the page stale and refetch, debounced. Peer-locked elements render read-only
via the same gate `PropertyForm` uses.

Note that in a chains or expand table one element may appear in several rows; a
staged edit shows in all of them, since the overlay is keyed by element id.

**Host surfaces**:

- `state/workspace.svelte.ts` — `DynamicTab.kind` becomes `'navigation' | 'table'`
  (id prefixes `nav:` / `tbl:`), `kind` joins the persisted tab record, and
  `openNavigationTab` generalizes to `openArtifactTab(kind, {artifactId, title})`.
- `Sidebar/ArtifactsSection.svelte` becomes kind-driven, rendering a Navigations
  section and a Tables section from one config.
- `Sidebar/TreeRow.svelte` currently hardcodes `openNavigationTab` on artifact
  double-click — it must dispatch on `artifactHeader.kind`. It also needs a table
  icon, and its `removeArtifactFromFolder(parentFolderPath, …)` call must handle a
  root path (`[]`) now that root placement exists.
- `state/view-ops.ts` / `view.svelte.ts` — root-level artifact place / move /
  remove against the new `View.artifacts`.
- `api/client.ts` — `apiFetch` gains a blob variant for the export download
  (`URL.createObjectURL` + anchor). CSRF (`X-Requested-With`) already applied.

**Open-as-table** is a button in the `NavigationBuilder` header. It opens a
`tbl:draft:<n>` tab whose definition is

```json
{"row_source": {"kind":"chains","navigation":{"ref":"<artifact_id>"}},
 "columns": [ /* one element column per chain step, chain_index 0..n */ ]}
```

— a `ref` when the navigation is saved (so edits to the navigation flow through to
the table, per the megaplan's consumption rule), an inline snapshot when it is an
unsaved draft. Save-as prompts for a name, POSTs the artifact, and
`bindTabToArtifact` re-keys the tab, exactly as `saveAsDraft` does today. Because
the transient table is a real table, you can add a property column to it before
saving.

## Testing

- `tests/navigation/` — extend for `RowStart`: schema round-trip, binding to one
  and many elements, `ValueError` with no binding, direct-lookup (no model scan).
- `tests/table/test_schema.py` — discriminated unions, the static validation
  table above, `MAX_COLUMNS`.
- `tests/table/test_build_rows.py` — scope / navigation / chains sources; expand
  cross-product; `keep_empty` true and false; `max_rows` truncation; determinism.
- `tests/table/test_cells.py` — `present: false` vs `value: null`; single vs
  multi-element source; `cell_cap` truncates display but **not** a downstream
  source; `chain_index` out of range → error; expanded property cell not editable.
- `tests/table/test_sort.py` — datatype-aware property sort, empty-last in both
  directions, `sort_mode` value vs count, binding-column sort off the `RowKey`,
  `max_sort_rows`.
- `tests/view/` — root `View.artifacts` place / move / remove; old view JSON loads.
- `tests/api/test_tables_routes.py` — CRUD via `kind='table'`; evaluate paging and
  sorting; order-cache hit, and invalidation on both `model_rev` bump and a
  referenced navigation's edit; viewer can evaluate but not create; the 422 paths.
- `tests/api/test_table_export.py` — xlsx bytes open in `openpyxl`, header row,
  cell coercions, `X-Table-Truncated`.
- vitest — `lib/table/columns.test.ts` (reorder remaps `ColumnRef.index`; removing
  a sourced column is rejected), `state/table-editor.test.ts` (draft lifecycle,
  sort reset, sparse page window, 409 conflict).
- e2e `frontend/e2e/table.spec.ts` — open a navigation as a table → add a property
  column → edit a cell → commit via `DiffDrawer` → value persists → Save as… →
  reopen from the sidebar → drop at the view root.

## Non-goals

- Per-datatype column formats (decimals, date style, boolean labels). `header` and
  `width_px` persist; formatting will want to be metamodel-datatype-driven.
- CSV export. `.xlsx` only.
- Bulk cell edit, relationship editing from tables, editing derived columns.
- Column virtualization.
- Cursor pagination (offset over a cached total order is sufficient and sound).
- Branching navigation (unchanged from Stage 1).

## Open items deferred to implementation

- Whether removing a column that another column sources from cascades or is
  rejected outright (spec says rejected; a confirm-and-cascade may test better).
- The exact debounce for feed-triggered page refetch.
- Whether `iter_export_rows` chunks at 1 000 or 5 000 rows.
