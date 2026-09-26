# Evaluation, plan 5: exports — design

Refines §5 of `2026-09-24-evaluation-design.md` (the binding program-level spec for C) for its
fifth plan. Where this document is silent, that spec holds. Approved in conversation with the
owner on 2026-09-26.

## Goal

`exportTable`, `previewTableJson`, `runExporter` and `runExporterDraft` are answered by the
replica by default, behind an `exports` surface switch with the server as fallback (MR-1) and
the dev shadow clean in e2e (MR-2). An export renders what the replica holds — staged model
edits, staged tables, navigations and the staged exporter itself — where today the server
exports committed state only. Fidelity is CT-7's: CSV, JSON, JSONL and `manifest.json` byte for
byte; xlsx by cell grid, widths and pane; zips by entry list. The 50,000-row export at M is
measured in Node and Chromium and reported to the owner before anything is optimized.

## Non-goals

- Script evaluation (D). An export that reaches a script — a script column or script step in
  any entry's table, an entry transform, or the table's own `transform` on `exportTable` — is
  refused with `501 reaches a script` and served by the server from committed state, behind a
  marker.
- `/exports/preview-transform` (always a script) and `GET /exports/run-by-name` (no UI caller):
  server only, outside the surface.
- The degraded path (`#ERROR: not computed` cells, the xlsx notice row, `degraded: true`): it
  arises only from script-cache misses, which the engine never has. Not ported; unreachable
  until D.
- Changing the manifest format. It stays byte-equal to the oracle (see §2, staged changes).
- Optimizing anything before the owner has seen the numbers.

## What the code says today

- **Python writers** (the oracle, frozen from this plan's start): `core/table/json_export.py`
  (602 lines), `export_layout.py` (183), `exporter.py` (164, mostly schema), `naming.py` (121),
  `split.py` (92), `csv_export.py` (75); `api/table_export.py` (xlsx, 163),
  `api/export_manifest.py` (100), `api/table_export_engine.py` (≈350 lines of logic), and the
  routes `routes/tables.py::export_table` / `json_preview` and `routes/exports.py::run_export` /
  `_execute_export`.
- **xlsx** is written by xlsxwriter 3.2 with `strings_to_urls` and `strings_to_formulas` off.
  Data cells go through `ws.write(cell_text(…))`, so the Python type picks the cell type
  (string, number, boolean, blank) — not "everything else as strings" as the program spec says;
  the oracle wins. The row-number column is `write_number`. `docProps/core.xml` carries the
  wall clock (`dcterms:created`), so the server's own xlsx is not byte-stable.
- **Bug (found while planning):** a list or dict value reaches `ws.write` raw, and xlsxwriter
  raises `TypeError`, so an xlsx export of a table with a multi-valued property column (smart-city's
  `tags`) answers 500. Fixed on both sides: the value is written as its `str()`, the text CSV
  already writes.
- **Zip:** stdlib `zipfile`, DEFLATE level 6, entries dated 1980-01-01, in order (manifest
  first, entries in definition order, partitions in row order). Its bytes depend on zlib and
  the host OS byte, so zips compare as entry lists.
- **Context:** `export_context_vars` reads `date` from the UTC clock (`%Y%m%d`), `rev` from
  the session, and `project` as the project **id** (not its display name). The frontend has
  the id (`getActiveProjectId()`) and the committed rev.
- **Exports use their own limits:** `max_rows` 50,000, `max_cell_elements` 10⁹,
  `ignore_cell_caps`.
- **Grouping and split buckets** use Python dict semantics: `1`, `1.0` and `True` land in one
  bucket.
- **Engine:** `tableSteps`, `TableOrderCache` (its key strips export-only fields, so an
  exporter entry shares the base table's order), `cellText`, `tableFetch`, `tableHasScript`,
  `pyDumps` (compact or `indent=2`) and a synchronous `sha256` exist. There is no zip library,
  no exporter reader, and `Call.answer` transfers nothing (only inbound chunks transfer today).
- **Frontend:** the four functions live in `lib/api/tables.ts` and `lib/api/exports.ts`,
  unrouted. `retryAndDownload` drives the 202 loop and returns `void`. Nothing reads
  `X-Table-*`. The shadow's `deepEqual` sees any two `ArrayBuffer`s or `Blob`s as equal. The
  exporter tab runs `runExporter(id)` when its draft is clean, so a saved-but-uncommitted
  exporter runs its committed payload on the server.

## 1. Engine — `engine/src/export/`

Ports of the frozen writers, pure functions with the oracle's texts and orders:

| File | Port of |
|---|---|
| `schema.ts` | `ExporterDefinition`, `ExporterEntry`, `OutputOptions`, `JsonDocumentOptions` (422 texts), `overridden_table` |
| `layout.ts` | `export_layout`: normalized order, row-number slot, headers, keys |
| `csv.ts` | `render_csv`: excel dialect, minimal quoting, CRLF, UTF-8 without BOM, non-strings through Python `str()` |
| `json.ts` | `render_json_ex` (keys, item keys, value modes, `single`, `$error`, grouping, `key_column`), `shape_json_docs`, JSONL, serialized with `pyDumps` |
| `xlsx.ts` | our own writer: fixed XML parts, one sheet, cell types by xlsxwriter's `write()` dispatch, autofit ported from xlsxwriter (width table, cap), header and data formats, freeze pane, autofilter |
| `naming.ts`, `split.ts` | tokens, `substitute`, `sanitize_stem` (120 code points), `folder_segments`, `_N` dedupe; bucketing on slot 0, labels, file names |
| `zip.ts` | `fflate` synchronous DEFLATE, entries dated 1980-01-01, in order |
| `manifest.ts` | the frozen field order, `indent=2`; inline transform as `inline:` + the first 12 hex digits of SHA-256 over the code's UTF-8 |
| `run.ts` | `_execute_export`: the 422 order, the reserved `manifest` stem, `_dedupe_path`'s three member shapes, `zip`/`bare` (bare with ≠ 1 file a 422), filenames, content types |

- **Python equality in buckets.** Grouping, `key_column` duplicates and split buckets key on the
  engine's Python-equality signatures (`1 == 1.0 == True`), not raw `Map` keys. An object
  document keyed by a numeric-looking column is written by a writer that keeps insertion order,
  never through a plain object (CT-7 "Order").
- **Methods:** four model-lane scans in `EVALUATIONS`.
  - Before the first yield:
    - Read the params: `date` (`YYYYMMDD`, required), `project` (required), `format`.
    - Resolve the exporter (for `runExporter`) and every entry's table through the
      `ArtifactSet` (`tableFetch`), so staged ones are used, and inline their navigations.
    - Answer `501 reaches a script` on any script reach (Non-goals).
  - Build rows with the export limits. Take the order from `TableOrderCache` when `orderKey`
    matches.
  - Evaluate cells and render in Meter-sliced steps. Publish bytes only at the final step, so
    requeue-on-transition stays safe.
- **Results:**

  | Method | Result |
  |---|---|
  | `exportTable`, `runExporter`, `runExporterDraft` | `{parts: ArrayBuffer[], filename, content_type, truncated, script_errors: 0}`; parts ≤ 4 MiB each |
  | `previewTableJson` | `{sample, truncated}` over the first 200 rows; the last document is dropped when truncated, as the oracle does |

- **Transfer (CT-4):** `Call.answer` takes a transfer list; the service transfers a result's
  `parts`. The receive side is unchanged.
- **Dependency:** `fflate` becomes the engine's first runtime dependency. It is pure JS, runs in
  a worker and in Node (RC-4), and its synchronous API spawns no workers (the CSP refuses blob
  workers).

## 2. Frontend

- **Surface:**
  - Add `exports` to `Surface`, `SURFACES` and `SURFACE_DEFAULTS`, gated on
    `follower.loaded()`.
  - It defaults to `server` until the plan's last task flips it to `engine`, once the shadow
    is clean.
- **`lib/api`:** all four functions go through `route('exports', …)`, keeping their names
  (tests spy on them).
  - The engine call:
    - passes `date`, the UTC `YYYYMMDD` at call time, and `project`, from
      `getActiveProjectId()`;
    - builds `new Blob(parts, {type: content_type})`;
    - answers `ExportResult` `{kind: 'ready', blob, filename, truncated}`.
  - The server call is today's, now also reading `X-Table-Truncated`.
  - `mark` adds `fallback: 'script'`.
  - `previewTableJson` gets the same routing and mark.
- **Download:**
  - `retryAndDownload` returns the final `ExportResult`, so callers see `fallback`.
  - In engine mode the first call is `ready` and the 202 loop never turns. A script fallback
    retries through the server as today.
- **Markers,** inline notes in the style of `TableView`'s `FALLBACK_NOTE`:
  - **"Exported from committed state: reaches a script"**:
    - by the table's Export control, where `downloadTable` returns the result;
    - by the exporter tab's Run button.
  - **Staged changes (owner's ruling):**
    - The manifest's `model_rev` and `${rev}` stay the committed rev, with the format unchanged.
    - The UI says it instead: the same two controls show "Includes staged changes" when the
      `exports` surface is `engine` and the replica holds staged model ops or staged artifacts.
- **Exporter tab:**
  - The `dirty`/real-id choice between `runExporter` and `runExporterDraft` is unchanged.
  - In engine mode a clean, staged exporter resolves its staged payload, as tables already do.
- **Shadow:** a `present()` case for `exports` compares `filename`, `content_type`, `truncated`
  and the bytes:
  - JSON, JSONL and CSV exactly;
  - a zip unpacked (`fflate` as a frontend dependency, dynamically imported by `shadow.ts`
    only) and compared by path, each entry exact except xlsx entries, which compare by path;
  - a single xlsx by the fields above only.

  A server 202 is skipped, not reported. The shadow already skips while anything is staged.
- **Flaky checks:** `table-editor-repage.test.ts`'s negative checks (`sleep(700)`,
  `≥ 299 ms`) wait on an awaited quiescence signal instead of wall time.

## 3. Oracle, tests, gate

- **Golden family `export_bytes`** (`tests/golden/scenarios/export_bytes.py`).
  - **Steps:** call the route functions (`export_table`, `json_preview`, `run_export`) on a
    `Session` with every argument passed. The driver pins the clock by patching
    `table_export_engine`'s `datetime`; no frozen route changes.
  - **Recorded:**
    - CSV, JSON, JSONL and manifest as exact text;
    - xlsx as the openpyxl cell grid (value and type), column widths, freeze pane,
      autofilter range and sheet title;
    - a zip as its entry list, with each entry's path and its text or xlsx grid;
    - filename, content type and truncated;
    - refusals as status and detail.
  - **Coverage:**
    - every format;
    - JSON value modes, `single`, grouping, item keys and `key_column`;
    - object and array shapes, pretty and compact, and `$error` cells;
    - `1`/`1.0`/`True` in group and split keys;
    - float repr and `str()` in CSV;
    - xlsx type dispatch (NaN, ints past 2^53, list and dict values: whatever the oracle does);
    - autofit over wide, astral and CJK text and the cap, and sheet-title sanitizing;
    - split with and without `split_folder`, tokens and dedupe, the reserved manifest stem;
    - `bare` with one and with several files;
    - `_execute_export`'s 422 order;
    - a truncated table;
    - a draft and a saved exporter.
  - Replayed over staged artifacts as well, as `table_rows` is.
  - A Python bug found while porting lands on both sides with its fixture.
- **Engine tests:**
  - the golden replays and each writer's edge cases;
  - the 501 on every script-reach path;
  - a cancelled export scan, and a requeue that publishes nothing partial;
  - `parts` detached on the sender after answering;
  - xlsx bytes identical over two runs in Node (CT-7: C holds xlsx cross-host identity in Node
    only; E's cross-host test closes it).
- **Frontend tests** (in-process engine, MSW for the server):
  - each function in engine mode yields a Blob from parts;
  - a 501 falls back and is marked;
  - the staged-changes note appears and clears;
  - the shadow catches a one-byte and a one-entry difference and ignores a 202.
- **Parity at M** (`engine-parity-large`): a new oracle task writes the 50k-row table's CSV and
  pretty-JSON export bytes to `benchmarks/`; `parity-large.ts` compares the engine's bytes
  exactly.
- **Bench** (`engine-bench`, `engine-bench-browser`, medians of 3): the 50k-row table as CSV,
  JSON and xlsx — total, longest step, peak heap of the parts. No budget; reported to the
  owner.
- **e2e** (engine mode, shadow on):
  - a table CSV export downloads and its bytes are checked;
  - an exporter run's zip entries and manifest are checked;
  - an export over a staged table holds the staged rows and shows "Includes staged changes";
  - a script table's export shows the committed-state marker.

## 4. Open items

Folded in:
- The MR-3 wording (§5).
- The flaky re-page checks (§2).

Left out, each recorded:

| Items | Reason |
|---|---|
| K-69, K-72 | Table sort and cell bugs that fail identically on both sides; exports inherit parity; a two-sided fix with fixtures belongs to a bug-fix pass |
| K-70 | Server-path table re-paging, not exports |
| K-71 | Rules install; the owner schedules it |
| K-73 | Table-tab perf, unrelated |
| K-65, K-66, K-68, K-60's server half, C-23, K-58, K-62, K-63, T-10, T-9, R13 | Rules, validation or sweep; not on the exports path |

## 5. Freeze and documents

- **Freeze during the build:**
  - The writers, `api/table_export*.py`, `api/export_manifest.py` and the export route
    functions are frozen for behaviour from this plan's start.
  - Plans 1–4's areas, `core/model`, `core/metamodel` and the applier stay frozen.
- **CT-4:** the four methods, the `date`/`project` params, byte results as transferred
  `ArrayBuffer` parts.
- **CT-7:** C holds xlsx cross-host identity in Node only.
- **MR-3 (`program.md`):**
  - `/tables/export`, `/tables/json-preview` and `routes/exports.py` read the Python evaluator
    only as the `exports` surface's server path.
  - The `core/table` evaluator's exports exception lifts when `exports` defaults to the engine.
  - `core/navigation`, `core/search`, `api/search.py` and their route functions leave the
    feature freeze then; bugs stay two-sided until F.
  - The script-table exception stays until D.
  - The writers are frozen from this plan's start and leave the feature freeze when `exports`
    defaults to the engine.
- **`program.md`:** C's plan 5 status.
- **READMEs:**
  - `engine/README.md`: `src/export/` and `fflate`.
  - `frontend/src/lib/engine/README.md`: the `exports` surface and its shadow.
  - `src/data_rover/api/README.md`: the writers as the oracle and the engine path.
- **`BACKLOG-ENGINE.md`** gains new items:
  - the degraded path is unreachable in the engine until D;
  - `/tables/export` does not sanitize its `Content-Disposition` name (pre-existing, server
    only).

  It also records the left-out items above.

## Done when

- `exports` defaults to the engine with the shadow clean in e2e; the server path works behind
  the switch.
- `export_bytes` passes; `engine-parity-large` shows the CSV and JSON exports at M byte-equal.
- `pixi run dr-test`, `dr-tidy true`, `engine-check`, `frontend-check`, `sandbox-check` and
  `engine-parity-large` are green; e2e shows no `[shadow]` lines and T-9 is the only failure.
- Bench numbers are reported to the owner.
- `architecture/`, the READMEs and the backlog say what is now true.
- `engine-migration` is fast-forwarded only with the owner's go-ahead.
