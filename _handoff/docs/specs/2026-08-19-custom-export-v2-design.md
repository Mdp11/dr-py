# Exporter v2 — customizable, automatable exports

Date: 2026-08-19
Status: approved (design dialogue 2026-08-19; amended same day: rename to
"Exporter", transform hook on standalone table exports)
Supersedes/extends: `2026-08-13-table-export-split-and-custom-export-design.md`
(the P-13/P-14 spec). Backlog items addressed: P-15.1, P-15.2, P-15.3, P-16,
F-10, F-11.

## 1. Context and goals

The `custom_export` artifact (P-14) shipped as a named collection of table
exports with per-entry presentation overrides, run via `POST /exports/run`
into one zip. The owner wants it **very customizable**, and the primary
consumers are **downstream tools/scripts and automated/repeated runs** — not
humans reading xlsx. That priority drives every decision here: naming
contracts, reproducibility, loud failures over silent degradation, and API
ergonomics for CI.

**Clean-slate stance.** The product is not live. The owner has explicitly
waived backwards compatibility: the database will be wiped and re-imported.
Therefore this design restructures the payload freely, `schema_version`
stays 1, there is **no migration, no old-payload byte-identity obligation,
and no legacy window**. Zip *determinism* (same rev → same bytes) is kept —
it is a feature for machine consumers, not a compat artifact.

## 2. Scope

In scope:

1. **Export manifest** — `manifest.json` at the zip root.
2. **Template engine** — `${name}`/`${id}`/`${rev}`/`${date}`/`${project}`
   across zip name, entry names, folder paths, split filenames (subsumes
   P-15.2 and P-15.3).
3. **New formats** — CSV and JSONL, on both `/exports/run` and the
   standalone `POST /tables/export`.
4. **JSON document shape controls** — array vs keyed object, pretty vs
   compact, error-cell policy.
5. **Bare (unzipped) single-file output mode.**
6. **Draft runs (P-16, custom-export half)** — run a staged, uncommitted
   custom-export definition.
7. **Run-by-name** — a GET route for CI `curl`.
8. **Snippet transform hook** — per-entry `transform(doc)` post-processor.
9. **P-15.1** — searchable add-table picker; **F-11** — allow duplicate
   table entries; **F-10** — resolved by amending the P-13/P-14 spec.
10. **Bundle-draft export (P-16, bundle half)** — lowest priority, phased
    last.
11. **Rename: `custom_export` → `exporter`** (owner amendment). A full
    rename, not a label: `ArtifactKind.custom_export` becomes
    `ArtifactKind.exporter` (VARCHAR+CHECK — one Alembic revision updates
    the constraint's value list; dev/test `create_all` picks it up
    automatically), the `artifact_kinds.py` registry key, the wire
    `kind` strings, and the code identifiers — `core/table/custom_export.py`
    → `core/table/exporter.py`, `CustomExportDefinition` →
    `ExporterDefinition`, `CUSTOM_EXPORT_ADAPTER` → `EXPORTER_ADAPTER`,
    `CustomExportTab.svelte` → `ExporterTab.svelte`,
    `custom-export-editor.svelte.ts` → `exporter-editor.svelte.ts`,
    `frontend/src/lib/artifacts/kinds.ts` labels/icons, testids, and the
    staged-family selectors. UI label: **Exporter**. Routes are already
    kind-neutral (`/exports/run`) and don't move. The clean-slate stance
    (§1) is what makes this a sweep rather than a migration: no stored
    rows or bundles carrying the old string survive the wipe. Bonus: C-10's
    `ExportEntry` wire-type name collision resolves itself (`ExporterEntry`
    vs the layout row).
12. **Transform hook on standalone table exports** (owner amendment) —
    see §8.

Explicitly deferred (decided in the brainstorm, re-ask before starting):

- **Per-entry row-filter overrides / run-time parameters** — breaks the
  RENDER ONLY boundary (filters change evaluation → cache keys, sweeps, row
  order fork per entry). The expensive one.
- **Delta exports** ("only what changed since rev N") — R-2/K-6 territory.
- **Non-table entries** (navigations, issue lists, metamodel YAML).
- **Whole-export snippet hook** (file-map manipulation) and
  **arbitrary-text transform output** — the per-entry JSON-doc contract was
  chosen deliberately; these two loosen it.

## 3. Payload schema (`core/table/exporter.py`, renamed per §2.11)

Clean restructure; every field below is the schema, not a delta.

```python
class OutputOptions(BaseModel):
    mode: Literal["zip", "bare"] = "zip"
    #: Zip filename template; "" = the artifact's name. Tokens: ${name}
    #: (artifact name), ${rev}, ${date}, ${project}.
    filename: str = ""
    manifest: bool = True

class JsonDocumentOptions(BaseModel):
    shape: Literal["array", "object"] = "array"
    #: Definition column index whose rendered value keys each member when
    #: shape == "object". Strict: out-of-range → 422 at export.
    key_column: int | None = None
    pretty: bool = True      # indent=2 vs compact
    on_error: Literal["emit", "fail"] = "emit"

class ExporterEntry(BaseModel):
    source: TableRef
    #: Output base-name template; "" = the table's name. Tokens: ${name}
    #: (table name), ${rev}, ${date}, ${project}.
    name: str = ""
    #: Folder path template inside the zip; "" = archive root. Same tokens
    #: as `name`. Multi-segment ("a/b/c").
    folder: str = ""
    format: Literal["xlsx", "json", "csv", "jsonl"] = "xlsx"
    columns: list[ColumnOverride] = Field(default_factory=list)
    export_order: list[int] = Field(default_factory=list)
    show_row_numbers: bool = False
    export_row_number: RowNumberExportOptions | None = None
    json_split: JsonSplitOptions | None = None
    json_doc: JsonDocumentOptions | None = None
    #: A code_snippet artifact ref. Under the literal "ref" key (TableRef)
    #: so the bundle's generic extract_deps/rewrite_refs walk carries it —
    #: same zero-per-kind-code trick as table refs.
    transform: TableRef | None = None

class ExporterDefinition(BaseModel):
    schema_version: int = 1
    output: OutputOptions = Field(default_factory=OutputOptions)
    entries: list[ExporterEntry] = Field(default_factory=list)
```

`ColumnOverride`, `overridden_table`, and the RENDER ONLY rule are
unchanged: an entry restates how a table renders, never what it computes.
Evaluation, row order and script cache keys stay off the original
definition.

## 4. Template engine (`core/table/naming.py`, new)

One vocabulary, four contexts:

| Token | zip filename | entry name | folder path | split filename |
|---|---|---|---|---|
| `${name}` | artifact name | table name | table name | element display name (required, as today) |
| `${id}` | — | — | — | element id |
| `${rev}` | ✓ | ✓ | ✓ | ✓ |
| `${date}` | ✓ | ✓ | ✓ | ✓ |
| `${project}` | ✓ | ✓ | ✓ | ✓ |

- `${rev}` = `session.model_rev` at run time. `${project}` = the project
  **id** (stable, machine-oriented — not the display name). `${date}` = UTC
  `YYYYMMDD`; using it is the user opting out of byte-identical runs, which
  is their call to make.
- **Unknown `${...}` tokens 422 at export time, naming the entry.** A typo
  silently shipped verbatim into a filename contract is worse than a loud
  failure. Validation happens up front with the existing missing-table
  check, before any evaluation.
- `validate_template`/token substitution generalize out of
  `core/table/split.py` into `naming.py`; `split.py` delegates. The split
  template keeps its `${name}`-required rule (uniqueness of split files);
  no other context requires any particular token.
- **Sanitization stays at the existing boundary**: templates render first,
  then pass through `sanitize_stem`. Folder paths render, then: reject
  absolute paths and empty segments (422, naming the entry), then sanitize
  each segment independently (`sanitize_stem` already neutralizes all-dots
  segments, so `..` cannot survive it). The zip-slip guard commentary in
  `routes/exports.py` moves with the logic.
- Filename dedup (`_dedupe`) keys on the **full member path**, so two
  entries in different folders never force a suffix on each other, and two
  colliding names inside one folder still dedupe `_2`, `_3`, … (P-15.3's
  "dedupe within a folder rather than globally").

## 5. Manifest

When `output.manifest` is true (the default), a reserved `manifest.json`
lands at the zip root. User files dedupe against it (the name is seeded
into the taken set before any entry writes).

```json
{
  "manifest_version": 1,
  "project_id": "...",
  "artifact_id": "... | null (draft runs)",
  "artifact_name": "...",
  "model_rev": 42,
  "truncated": false,
  "degraded": false,
  "entries": [
    {
      "name": "rendered entry name",
      "table_ref": "...", "table_name": "...",
      "format": "json",
      "transform": "snippet id | null",
      "truncated": false, "degraded": false,
      "files": ["folder/name.json", "..."]
    }
  ]
}
```

- **No wall-clock timestamp, deliberately.** `model_rev` is the
  reproducible identity; a timestamp would break the byte-determinism
  `build_zip`'s pinned `ZIP_DATE_TIME` exists to provide. Consumers that
  want a download time have the HTTP `Date` header.
- Per-entry `truncated`/`degraded` come from each entry's `ExportFiles`
  flags — data the route already has and today collapses into two HTTP
  headers. The `X-Table-Truncated`/`X-Table-Script-Errors` headers stay.
- Serialized deterministically (sorted keys not required — field order is
  fixed by the builder; `ensure_ascii=False`, `indent=2`).
- In `bare` mode the manifest is **ignored** (documented): bare's whole
  point is exactly one file.

## 6. New formats: CSV and JSONL

`format` widens to four values on `ExporterEntry` **and** on the standalone
`POST /tables/export` body (the engine branch in
`table_export_engine.run_table_export` is shared; extending both is nearly
free). `TableDefinition` grows `transform` (see §8) but NOT `json_doc` —
document shaping stays exporter-entry-only.

- **CSV** — `core/table/csv_export.py`, pure. Column selection/order by
  `export_layout` exactly like the xlsx branch (slice rows by
  `layout.order`, same headers, row-number pseudo-column honored). Cell
  text via a display-formatting helper **extracted from the xlsx writer**
  (`api/table_export.py`) into core, so the two formats cannot drift.
  UTF-8, **no BOM** (machine consumers, not Excel), stdlib `csv` dialect
  (RFC-4180 quoting). Error/pending cells render `#ERROR: ...` text like
  xlsx; `degraded` flag set the same way. No split, no `json_doc`.
- **JSONL** — in `core/table/json_export.py`: the same `render_json` doc
  list, serialized one compact object per line (`\n`-terminated). Split
  works (same partition logic as `json`). `json_doc.shape`/`pretty` are
  **ignored with tolerance** (a stream of objects is inherently compact and
  array-like); `on_error` applies.

## 7. JSON document shape controls (`JsonDocumentOptions`)

Applied in the `json` branch (and `on_error` in `jsonl`), after
`render_json`, before serialization:

- `shape: "object"` + `key_column`: the document becomes
  `{key: row_doc, ...}` where each key is the named column's rendered value
  coerced to string. Strict rules, all 422-at-export naming the entry:
  `key_column` missing or out of range; a key that renders null/empty; a
  **duplicate key** (silently suffixing data keys corrupts the contract —
  filenames dedupe, data keys never do). `key_column` is independent of the
  column's include/hidden state (it is data, not presentation of the member
  list; `render_json` sees unfiltered rows already).
- `pretty: false` → compact separators; `true` → today's `indent=2`.
- `on_error: "fail"` → any cell that would ship as `{"$error": ...}`
  (including cache-only pending after a terminal sweep) turns the export
  into a 422 naming the entry. A script consumer can demand a clean
  document or nothing; the default `"emit"` keeps today's
  degraded-not-failed stance.

## 8. Snippet transform hook

`transform(doc)` — the customizability escape hatch: every future "can the
export also…" becomes a user-side snippet instead of a schema change. It
attaches in **two places** with one contract:

- **Exporter entries**: `ExporterEntry.transform` (§3).
- **Standalone table exports** (owner amendment): `TableDefinition` gains
  `transform: TableRef | None` beside `json_split` — presentation-family
  (never consulted during evaluation; cell values, row order and script
  cache keys are unaffected, since the transform runs after rendering).
  It applies to `POST /tables/export` in JSON-family formats. Under the
  standard `"ref"` key, so the table kind's bundle deps walk carries the
  snippet automatically. **No-bleed rule holds in both directions**: a
  table's own `transform` applies only to its standalone export; an
  exporter entry applies only its entry-level `transform` (entry
  `transform: None` means "no transform", never "inherit the table's") —
  exactly how `overridden_table` already treats every other presentation
  field.

- **Contract.** JSON-family formats only (`json`, `jsonl`). Pipeline order:
  render → shape (§7) → **transform** → serialize. The snippet sees exactly
  what would ship and returns the replacement document (any JSON value).
  Split entries: called once per file with that file's document. JSONL:
  called with the row-object array, before line-serialization. `transform`
  set on an `xlsx`/`csv` entry → 422 at export (silently skipping a
  transform ships untransformed data — a functional contract, not a
  presentation preference, so it does not get the tolerate-and-ignore
  treatment). Never blocks Save.
- **Entry point derivation.** `transform` joins `_ENTRY_NAMES` in
  `core/script/lint.py`: a one-arg top-level `def transform(doc)` adds
  `"transform"` to the server-derived `entry_points`, exactly like
  `value`/`step`. The run route 422s if the referenced snippet's committed
  payload lacks the entry point (checked up front with the missing-table
  pass — the ref must be a `code_snippet` in this project).
- **Execution.** Identical on both surfaces (the shared engine
  `run_table_export` hosts the call, so `/tables/export` and `/exports/run`
  cannot drift). Reuses `ScriptRunner.open_session` (one warm guest per
  distinct transform code per export run, shared across entries/files using
  the same snippet). Requires **one new core/script capability**: a bridge
  call frame that passes an arbitrary JSON value instead of element
  projections, and returns the entry point's JSON result. This is the
  design's largest single piece of new machinery — a contained extension to
  the bridge protocol, the guest shim, and `RunRequest`/session call
  vocabulary; the facade itself is unchanged (the snippet may still call
  `dr.*` reads normally).
- **Limits.** Existing wall-timeout/memory caps apply per call. New setting
  `snippet_transform_max_bytes` (default 8 MiB,
  `DATA_ROVER_SNIPPET_TRANSFORM_MAX_BYTES`) caps both the document sent to
  the guest and the document received back; over-cap → 422 naming the
  entry.
- **Failure = failure.** A transform that raises, times out, or returns
  something unserializable 422s the whole export naming the entry — unlike
  cell degradation, a machine consumer must never receive a half-transformed
  document at 200.
- **Security.** Read-only: op proposals are ignored (`record_ops` off).
  Sandboxed in the same WASM guest as every other snippet run. Concurrency:
  one global slot from the interactive guard (`api/snippet_concurrency.py`)
  per export run, same as embedded evaluate/export today. Viewer-callable,
  consistent with `/snippets/run`.

## 9. Run route: draft runs and run-by-name

### 9.1 `POST /exports/run` (extended) — P-16, exporter half

```python
class RunExportIn(BaseModel):
    artifact_id: str | None = None
    definition: ExporterDefinition | None = None   # a staged draft
    name: str = ""   # feeds ${name} for draft runs; "" → "export"
```

Exactly one of `artifact_id`/`definition` required (422 otherwise). A
`definition` run validates through `EXPORTER_ADAPTER` and flows
through the identical guards: entry refs must resolve to this project's
committed tables (the existing missing-table 422 already enforces project
scoping), templates validate up front, transforms resolve to committed
snippets. **Referenced tables always evaluate from their committed
definitions** — the clean line: presentation drafts export live; evaluation
drafts still require commit. Stays in `authz._READ_ONLY_POST_SUFFIXES`
(a draft definition is render-only client input, no more trusted than a
committed one — and it is validated exactly the same way).

Manifest for a draft run: `artifact_id: null`, `artifact_name` = the
request's `name`.

### 9.2 `GET /exports/run-by-name?name=...`

CI ergonomics: run a committed exporter by name with one `curl`. Query
parameter, not a path segment (artifact names are free-form text). Unknown
name → 404. **Ambiguous name (several `exporter` rows sharing it) →
409 listing the candidate ids.** Response contract identical to the POST:
zip (or bare file) on completion, aggregate `202 + Retry-After: 1` while
sweeps fill. GET is read-only by `authz`'s method-based detection, so
membership auth works unchanged (header provider or cookie).

### 9.3 Response assembly changes

- `output.mode == "bare"`: if the run produced exactly one file, ship it
  directly (its own media type + `Content-Disposition`); otherwise **422**
  ("bare output requires a single file") — loud beats a silent
  content-type change for scripts. Never blocks Save.
- Zip filename: `output.filename` template rendered, `sanitize_stem`'d,
  falling back to the artifact name.
- Member paths: `folder` rendered per entry (§4); a split entry's files
  nest under `folder/entry_name/` (the existing per-entry folder for split
  survives, now beneath the user folder).

## 10. Bundle-draft export — P-16, bundle half (phased last)

`POST /artifacts/export` (and `/export/preview`) gain optional
`drafts: list[DraftArtifactIn]` (`{id: str | None, kind, name, payload}`),
merged over the committed selection by id (a draft with a committed id
replaces that row's payload in the bundle; a temp/None id adds a new
artifact). Every draft is held to exactly the **untrusted-import bar**:
registered kind, adapter-valid payload, re-derived `entry_points` — the
same bar `importer.trust_artifacts=False` applies, so a draft can never
smuggle in what a normal write would reject. Read-only, viewer-callable as
today.

## 11. Frontend

- **P-15.1 picker.** Replace the exporter tab's bare `<select>`
  with a searchable typeahead (mirror `Sidebar/Search.svelte`'s pattern,
  `ExportArtifactsDialog`'s visual treatment). **F-11**: drop the
  `usedRefs` filter — duplicate entries are legal server-side and now
  genuinely useful ("table A as wide xlsx AND as split JSON").
- **Artifact-level settings** (header row or small settings popover): zip
  filename template, output mode, manifest toggle.
- **Entry row**: format select (4 values), folder field, transform snippet
  picker (same typeahead, filtered to `code_snippet`).
- **Standalone table export settings** (`ExportSettingsPanel`/
  `ExportDialog`): a transform snippet picker for the table's own
  `transform` (§8), shown for JSON-family formats.
- **Rename sweep** (§2.11): "Exporter" label everywhere the UI says
  "Custom export" — `kinds.ts`, tab titles, staged-family section labels,
  testids.
- **`EntryLayoutDialog`** gains the `json_doc` options (shape, key column,
  pretty, on-error).
- **Export button**: loses its `dirty`/temp-id gating — a dirty or
  never-committed draft exports by sending `definition` inline (§9.1).
  Tooltip updated accordingly.
- New drafts initialize with the schema defaults (`manifest: true` comes
  from the schema now — no client special-casing).

## 12. F-10 resolution

Keep the shipped behavior — an invalid `${name}` split template blocks
**Export**, never Save — and record this as an Amendment on the P-13/P-14
spec (§5.1 said block Save). The codebase's own docstrings already state
the governing principle ("a stored bad template must never block saving or
evaluating"), and §4's export-time strictness extends that stance
uniformly to every template. F-10 closes spec-amended, not code-changed.

## 13. Error-handling summary

All of these are export-time 422s naming the offending entry; **none block
Save** (presentation settings persist freely; the run is where contracts
are enforced):

| Condition | Response |
|---|---|
| Missing/foreign/wrong-kind table or transform ref | 422 (existing stance) |
| Unknown `${...}` token in any template | 422 |
| Split template without `${name}` | 422 (existing) |
| Folder path absolute / empty segment | 422 |
| `bare` with ≠ 1 output file | 422 |
| `json_doc.key_column` out of range / null key / duplicate key | 422 |
| `on_error: "fail"` and an error cell would ship | 422 |
| `transform` on an xlsx/csv entry or table export | 422 |
| Transform raises / times out / over `snippet_transform_max_bytes` | 422 |
| Both or neither of `artifact_id`/`definition` | 422 |
| run-by-name: unknown / ambiguous | 404 / 409 with candidate ids |

Degraded-not-failed is unchanged where the user didn't opt into strictness:
error cells still ship as `#ERROR`/`{"$error": ...}` at 200 with the
`degraded` flag (headers + manifest) under the default `on_error: "emit"`.
The aggregate `202 + Retry-After` completeness probe is untouched.

## 14. Settings

One new knob: `snippet_transform_max_bytes` (default `8_388_608`,
`DATA_ROVER_SNIPPET_TRANSFORM_MAX_BYTES`). Everything else reuses existing
snippet limits and the interactive concurrency guard.

## 15. Testing

- **Core, pure**: `naming.py` (token substitution, unknown-token rejection,
  per-context vocabularies); `csv_export.py` (layout slicing, quoting,
  error cells); JSONL rendering (+ split); `JsonDocumentOptions` shaping
  (object shape, duplicate-key rejection, compact); manifest builder.
- **API**: folder-path zip-slip attempts (`../`, absolute, empty segments,
  all-dots after templating); per-folder dedup; bare-mode single/multi;
  manifest content incl. per-entry flags and the reserved-name dedupe;
  draft runs (validation parity with committed runs, project scoping);
  run-by-name 200/404/409; `on_error: "fail"`; transform end-to-end via
  `tests/script/trusted_runner.TrustedRunner` on BOTH surfaces (an exporter
  entry and a standalone `POST /tables/export`), plus **one
  `integration`-marked WASM test** for the new bridge frame; determinism
  (two runs at one rev, no `${date}` → byte-identical zips); the no-bleed
  rule (a table's `transform` never leaks into an exporter entry and vice
  versa).
- **Frontend**: picker search + duplicate add; new entry controls;
  `json_doc` dialog; draft-export path (MSW); manifest/output settings.

## 16. Implementation phases

1. **Naming & structure** — the `custom_export` → `exporter` rename sweep
   (§2.11, incl. the Alembic CHECK-constraint revision), new payload
   schema, `naming.py`, folders, zip filename, bare mode, manifest; F-11
   (drop the UI filter), F-10 (spec amendment). DB wipe happens here.
2. **Formats & shape** — CSV, JSONL, `JsonDocumentOptions`, on both routes.
3. **Automation surface** — draft runs (`RunExportIn.definition`),
   run-by-name; frontend picker (P-15.1) + new entry/artifact controls +
   ungated Export button.
4. **Transform hook** — bridge frame, entry-point derivation, integration
   on both surfaces (exporter entries + `TableDefinition.transform` on
   `POST /tables/export`), limits, frontend pickers.
5. **Bundle-draft export** — §10. Lowest priority; re-confirm before
   starting.

Each phase lands green (`dr-tidy` + `core-test` + `frontend-test`) and is
independently shippable.

## 17. Amendments

### 2026-08-21 — Phase 4 brainstorm decisions (owner-approved)

1. **`ExporterDefinition.entries` is capped at 50** (`Field(max_length=50)`).
   Closes the Phase-3 review finding (a viewer-callable draft run could chain
   N whole-table exports in one synchronous request). This is a schema bound
   in the tradition of `SNIPPET_MAX_CODE_BYTES` — a structural limit enforced
   at validation (so it does reject at artifact save), NOT an export-time
   strictness rule; the never-block-Save rule governs strictness only
   export-time rendering can detect, which this is not.
2. **Runner missing / no concurrency slot on a transform-bearing export**
   fails fast: **503** when no runner is constructed, **429** when no global
   slot is free — the snippet-console routes' precedent. Silently skipping a
   transform ships untransformed data (forbidden by §8's functional-contract
   stance), and 422 would mislabel a transient condition as a definition
   error. This is the ONE exception to the export engine's degraded-not-failed
   stance, and it exists for the same reason the xlsx/csv 422 does.
3. **`jsonl` return contract**: the transform receives the row-object array
   and must return a **list** (each item = one line); any other return is a
   422 naming the entry. A non-list has no honest line serialization.
4. **`on_error: "fail"` is checked BEFORE the transform runs**, on the
   rendered documents — a transform cannot launder error markers past the
   check. (Pipeline order as implemented: render → [on_error check, on the
   rendered documents] → shape → transform → serialize — the check runs
   pre-shape, which is equivalent for marker detection and keeps it clearly
   pre-transform.)
