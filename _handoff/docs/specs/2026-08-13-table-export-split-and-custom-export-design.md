# Per-element JSON export splitting (P-13) + custom export artefact (P-14)

Date: 2026-08-13 · Status: approved design, pre-implementation
Backlog: P-13, P-14 (BACKLOG.md §2) · Folds in cleanup C-6.
Related specs: `2026-07-25-table-json-export-design.md`,
`2026-07-28-table-export-settings-design.md`,
`2026-07-29-artefacts-revamp-design.md`.

## 1. What is being built

Two features that share one export engine:

- **P-13 — per-element JSON split.** A table's JSON export can emit one file
  per base element of the scope instead of one combined document, named by a
  user-supplied filename template (`DataFor${name}Element`), delivered as one
  zip.
- **P-14 — custom export artefact.** A new artifact kind `custom_export`: a
  named collection of table exports whose export settings live in the
  artefact. One artefact says "export tables A, B, C, each with *these*
  columns, *these* names, *this* layout" without any of it leaking into how
  A, B, C export standalone — in either direction. Running it downloads one
  zip.

## 2. Decisions made during brainstorming

| Question | Decision |
|---|---|
| P-13 delivery of N files | **One zip response** from `POST /tables/export` |
| Where split config lives | **Stored on the table definition** (presentation field), editable in the export dialog; P-14 entries carry their own copy |
| Filename strictness | **Template without `${name}` is rejected** (422 at export; dialog blocks saving one). Name collisions auto-suffix `_2`, `_3` in row order. Unsafe characters sanitized. |
| Split file content shape | **Always an array** (same shape as the unsplit export); concatenating the files' arrays reproduces the single-file export |
| P-14 override shape | **Full override set per entry**, initialized by copying the table's current settings when the entry is added; later edits to the table's standalone settings never change the artefact's output |
| P-14 scope / output | **Tables only** (navigations have no export pipeline); running produces **one zip**; format (`xlsx`/`json`) chosen per entry, mixed freely |
| Architecture | **Approach A: shared server-side export engine + server-side zip** (over client-composed loops and background-job designs) |

P-14 is a full artefact: sidebar-listed, tab-openable, `art:<id>`-lockable,
edited via `create/update/delete_artifact` ops through `POST /commits`
(journaled, undoable, feed-visible), and it travels through artifact bundles
with its referenced tables pulled in by the deps closure. The *run* is a
read-only POST.

## 3. Core layer (`src/data_rover/core/table/`)

### 3.1 `json_split` on `TableDefinition` (P-13 config)

```python
class JsonSplitOptions(BaseModel):
    enabled: bool = False
    filename_template: str = ""   # "${name}" substituted per base element

class TableDefinition(...):
    ...
    json_split: JsonSplitOptions | None = None
```

Presentation-only, exactly like `export_order` / `ColumnExportOptions`:
never consulted by `build_rows` / `order_rows` / script evaluation, so no
migration, no cache impact, and existing tables export byte-identically
until someone turns it on. Stored permissively — schema validation never
rejects a template; the 422 happens at export time and the dialog blocks
saving a bad one (belt and suspenders, strictness per decision above).

### 3.2 New module `core/table/split.py`

Pure, like `json_export.py`. Three pieces:

- `split_partitions(row_keys, rows) -> list[tuple[object, list[_Pair]]]` —
  partitions the `(RowKey, cells)` pairs by **slot 0** (for scope/navigation
  sources `base_slots == 1`, so slot 0 IS the base element; for chain
  sources slot 0 is the chain origin, which is the honest generalization).
  First-appearance order preserved, so the requested sort survives. Each
  partition is rendered through the existing `render_json` **unchanged** —
  the renderer stays per-document, the split sits above it (the placement
  the backlog item already identified).
- `validate_template(template) -> None` — raises `ValueError` when
  `"${name}"` is absent (routes map `ValueError` → 422 already). Exposed
  separately so the API validates before any evaluation and the frontend
  mirrors the same predicate.
- `render_filenames(template, items: list[tuple[str, str]]) -> list[str]` —
  takes `(element_id, display_name)` per partition, substitutes `${name}`
  with the display name, sanitizes
  (`/ \ : * ? " < > |` and control chars → `_`, length cap ~120 chars,
  empty result falls back to the element id), then deduplicates collisions
  with `_2`, `_3`, ... in row order — deterministic, in the spirit of
  `resolve_json_keys`'s collision loop (a produced `_2` can itself collide
  with a literal name; loop until free). Extension (`.json`) is appended by
  the caller after dedup so `a` and `a_2` never merge.

### 3.3 New module `core/table/custom_export.py` (P-14 payload)

```python
class ColumnOverride(BaseModel):
    index: int                                  # definition column index
    export: ColumnExportOptions | None = None   # reused from schema.py
    json_export: JsonColumnOptions | None = None

class ExportEntry(BaseModel):
    source: TableRef                            # {"ref": "<table artifact id>"}
    name: str                                   # output base name in the zip
    format: Literal["xlsx", "json"] = "xlsx"
    columns: list[ColumnOverride] = []
    export_order: list[int] = []
    show_row_numbers: bool = False
    export_row_number: RowNumberExportOptions | None = None
    json_split: JsonSplitOptions | None = None

class CustomExportDefinition(BaseModel):
    schema_version: Literal[1] = 1
    entries: list[ExportEntry] = []

CUSTOM_EXPORT_ADAPTER = TypeAdapter(CustomExportDefinition)
```

`TableRef` is a one-field model whose serialized form is a dict under the
literal key `"ref"` — the shape `artifact_kinds.py`'s generic walk already
understands, so `extract_deps` / `rewrite_refs` work with **zero** new
per-kind code and the contract tests just gain fixtures.

### 3.4 `overridden_table(defn, entry) -> TableDefinition`

Lives in `custom_export.py`. A copy of the table's definition with ONLY
presentation fields replaced from the entry:

- per-column `export` / `json_export` from `ColumnOverride`s, matched by
  definition index; out-of-range indices **dropped** (drift-normalized, the
  `normalized_order` stance — a stale override left behind by a column
  remove must not block an export); duplicate indices: first wins
- `export_order`, `show_row_numbers`, `export_row_number`, `json_split`
  taken wholesale from the entry

Columns the entry does not mention get **default** presentation
(`export=None` → include follows `hidden`; `json_export=None`) —
deliberately NOT the table's own standalone settings, so the two config
sets never bleed into each other in either direction. Structural fields
(sources, modes, filters, row source, `hidden` itself) are untouched — an
entry restates how a table *renders*, never what it *computes*.

**RENDER ONLY**, same boundary as `export_definition`: the overridden copy
feeds `export_layout` / `export_header` / `export_definition` /
`render_json` and nothing else. `build_rows_ex` / `order_rows` /
`iter_export_rows` / the script context always receive the ORIGINAL
definition, so cell values, row order and every script cache key are
independent of the artefact's presentation.

## 4. API layer (`src/data_rover/api/`)

### 4.1 Engine extraction — new `api/table_export_engine.py`

The body of `export_table` (cache-only script context → build/order →
completeness probe → kick/join sweep → the 202-vs-ship decision table →
render) moves into:

```python
@dataclass
class ExportPending:
    status: ScriptStatusOut          # caller answers 202 + Retry-After: 1

@dataclass
class ExportFiles:
    files: list[tuple[str, bytes]]   # (filename, blob); 1 file, or N when split
    truncated: bool
    degraded: bool                   # drives X-Table-Script-Errors

def run_table_export(
    session, db, settings, runner,
    defn,                # ORIGINAL definition — evaluation
    render_defn,         # presentation-effective definition — layout/render
                         #   (same object for a standalone table export;
                         #    overridden_table(...) output for a P-14 entry)
    name, format, sort,
) -> ExportPending | ExportFiles
```

The decision-table comments (FIX A / FIX B, the probe rationale) move
verbatim — they are load-bearing. Split rendering happens inside the
engine's JSON branch: when `render_defn.json_split.enabled`, validate the
template (`ValueError` → 422 before any evaluation), partition via
`split_partitions`, render each partition through `render_json` with the
same layout arguments, name via `render_filenames`. Split with
`format: "xlsx"` is ignored like a stale `group` flag (the setting lives
under JSON options; the dialog never offers it for xlsx).

`export_table` becomes a thin wrapper: `ExportPending` → 202 exactly as
today; one file → the same single-file response as today (byte-identical
for every existing table); N files → `application/zip` named
`{table_name}.zip`, files at the zip root.

### 4.2 Zip building

Stdlib `zipfile` into `BytesIO`, one shared helper in the engine module.
Fixed entry timestamps (epoch constant) so identical content zips
byte-identically — the determinism stance the WASM runner already takes,
and what makes zip-content tests exact.

### 4.3 P-14 run route — `POST /exports/run`

Under the project prefix, body `{"artifact_id": "<custom_export id>"}`.
(The id travels in the body rather than the path because
`authz._READ_ONLY_POST_SUFFIXES` matches fixed path suffixes — a
path-parameter route could not be allowlisted as viewer-callable.)
Added to `authz._READ_ONLY_POST_SUFFIXES` like `/tables/export`. Flow:

1. Load artifact; 404 when missing / wrong project / kind is not
   `custom_export`. Empty `entries` → 422 (nothing to export).
2. Resolve every entry's table ref up front; ANY dangling ref → **422
   listing the missing entries by name**. An export artefact with a hole
   fails loudly rather than shipping a partial zip that looks complete —
   deliberate divergence from the bundle's tolerant-dangler stance, because
   here the output is the deliverable, not bookkeeping.
3. Per entry, in order: resolve refs (`resolve_table_refs`, as
   `_resolve_table` does), build `overridden_table(defn, entry)`, call
   `run_table_export(defn, render_defn=…, name=entry.name,
   format=entry.format, sort=None)`.
4. Any entry `ExportPending` → run ALL entries first (kicking every pending
   table's sweep so they fill concurrently), then answer ONE aggregate 202:
   `ScriptStatusOut` with summed `done`/`total`, `state="computing"` if any
   entry computes, else `"failed"` (mirroring the per-table FIX B stance:
   a dead job whose data filled in anyway reports `computing`). The
   existing frontend retry-on-202 loop works unchanged.
5. All `ExportFiles` → one zip named `{artifact_name}.zip`. Single-file
   entries land at the root as their engine-produced filename (base:
   `entry.name`); split entries land under a folder `{entry_name}/`.
   Cross-entry collisions on the root names dedupe `_2` in entry order.
   `X-Table-Truncated` / `X-Table-Script-Errors` are OR-ed across entries.

No new background-job or storage surface: the sweep + 202 pattern already
covers the only slow part; zip assembly from a warm cache is fast.

### 4.4 Kind registration + persistence

- `db_models.py`: `ArtifactKind.custom_export = "custom_export"`.
- Alembic migration `0010`: **widen `project_artifacts.kind`**. The column
  is a plain VARCHAR sized to the longest enum member at `0008` time
  (`native_enum=False` with no `create_constraint` emits no CHECK), i.e.
  VARCHAR(12) — and `custom_export` is 13 characters, so Postgres would
  reject writes without the widen (to VARCHAR(32), headroom for future
  kinds). SQLite tests regenerate via `create_all` and need nothing.
- `artifact_kinds.py`: one registry entry —
  `ArtifactKindSpec(kind=custom_export, adapter=CUSTOM_EXPORT_ADAPTER)`.
  Default deps walk finds `entries[].source.ref`; default rewrite remaps
  them. `diagram` / `diagram_kind` stay unregistered.
- Everything else is generic and free: artifact ops through
  `POST /commits` with `art:<id>` lease verification, preview
  dry-validation, feed events with `artifact` scope, journal-only commit
  diff, `/commits/revert` 409 across artifact ops, bundle export closure
  (a bundle containing a custom export pulls its tables in), import id
  remap on all three from-outside paths plus verbatim clone.

## 5. Frontend

### 5.1 P-13 — ExportDialog

`Table/ExportDialog.svelte`'s JSON settings gain a "one file per element"
section: enable toggle + filename template input. Inline validation mirrors
`validate_template` (save blocked while `${name}` is missing; the server
422 stays as backstop). Persists `json_split` on the staged definition
through the same table-editor → commit path as every other export setting.
The download handler gains the zip media-type/filename case; the 202 retry
loop is untouched.

### 5.2 P-14 — the custom export surface

`custom_export` joins the artifact unions end-to-end: `api/types.ts`,
`state/artifacts.svelte.ts`, sidebar `ArtifactsSection`, dynamic workspace
tabs, checkout/lease layer — all pattern-following. Because this touches
exactly the duplicated kind-selector sites, **C-6 is folded in**: extract
the shared registered-kind selector (SECTION_KINDS / ICONS / state unions)
instead of adding a fifth copy.

New tab (`components/Export/` + `state/custom-export-editor.svelte.ts`,
mirroring the snippet/table editor pattern):

- entry list: add-table picker over committed table artifacts, remove,
  reorder; per-entry name + format select
- "Edit layout" per entry opens the same export-settings editing components
  the table dialog uses, bound to the entry's override set. The set is
  initialized by copying the table's current export settings at add time —
  the ONE moment the two config sets touch, by decision
- Export button → `POST /exports/{id}` with the shared 202 polling helper,
  saves the zip; editing goes through the standard checkout flow (lease,
  staged buffer, commit)

### 5.3 JSON preview

`POST /tables/json-preview` keeps working for the dialog. For a P-14
entry's layout editor the same preview route is called with the
entry-overridden presentation — requires the preview payload to accept the
presentation fields inline, which it already does via `definition`-bearing
requests (`EvaluateTableIn.definition`); the client sends
`overridden_table` equivalent built client-side from the entry (mirror in
`table/export-layout.ts` extended accordingly).

## 6. Testing

- **Core** (`tests/table/`): partition order + array shape (concatenation
  == unsplit export, byte-for-byte over rendered docs); template
  validation; sanitize/dedupe (shared names, `${name}`-less rejection,
  `a`/`a_2` pre-collision, unsafe chars, id fallback); `overridden_table`
  drift normalization (out-of-range dropped, unmentioned columns default,
  structural fields untouched, original defn never mutated); schema
  round-trip.
- **API** (`tests/api/`): split export (zip contents deterministic, 422
  template, collision suffixing, xlsx ignores split, 202 passthrough with
  script columns reusing the existing scaffolding, truncation/degradation
  headers on zip responses); `/exports/{id}` (mixed-format zip, folder
  layout for split entries, aggregate 202 incl. the FIX-B analogue,
  dangling-ref 422 with names, empty-entries 422, wrong-kind/foreign 404,
  viewer authz allowed, non-member 403); registry contract tests (deps
  walk over `entries[].source.ref`, rewrite, bundle closure round-trip:
  export a custom export → its tables ride along → import remaps);
  artifact CRUD + commit ops + lease honoring for the new kind (parametrize
  existing suites where they enumerate kinds).
- **Migration**: `0010` upgrade path exercised per the existing Alembic
  test pattern; `create_all` covers SQLite.
- **Frontend**: dialog split section (validation gating, persistence);
  custom-export editor (add/remove/reorder, override isolation from the
  table's own settings, copy-at-add semantics, export flow with 202
  retry, zip download); shared kind selector (C-6) regression across its
  former call sites.
- Gates: `core-test`, `frontend-test`, `dr-tidy` clean before and after.

## 7. Non-goals

- Navigation exports (no pipeline exists; separate feature).
- Split for xlsx (sheets already exist; setting is JSON-scoped).
- Sparse/inheriting overrides (rejected — full set per entry).
- Background export jobs / stored result blobs (sweep + 202 suffices).
- Per-element split keyed on anything other than RowKey slot 0.
- Stable column ids (overrides drift-normalize by index like
  `export_order`; introducing ids is a separate design).
- New concurrency machinery: the run route draws script work from the
  same embedded-evaluation guard as `/tables/export` today.

## Amendments

- 2026-08-19 (Exporter v2, F-10): §5.1's "an invalid `${name}` template
  blocks Save" is retracted. Shipped behavior — block **Export** with a 422,
  never Save — is the intended contract: a stored-but-invalid presentation
  setting must never block saving or evaluating (the stance
  `JsonSplitOptions`' docstring already states), and Exporter v2 §4 extends
  export-time strictness to every template uniformly.
