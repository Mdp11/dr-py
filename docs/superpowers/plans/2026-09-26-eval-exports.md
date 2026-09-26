# Exports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine renders table exports and exporter runs — CSV, JSON, JSONL, xlsx, split, naming, zip and the manifest — from the working copy and the staged artifacts, and answers `exportTable`, `previewTableJson`, `runExporter` and `runExporterDraft` as the Python routes do (CT-7: text byte for byte, xlsx by cell grid, zips by entry list), behind an `exports` surface switch that ends the plan defaulting to the engine. An export that reaches a script is served by the server from committed state behind a marker. Bytes cross the port as transferred `ArrayBuffer`s. The 50,000-row export at M is measured in Node and Chromium and reported to the owner. The plan also fixes one Python bug found while planning (on both sides, with fixtures) and makes the re-page tests' negative checks deterministic.

**Architecture:** Plan 5 of 8 for sub-project C (`architecture/program.md`). Bottom-up:
1. The xlsx bug is fixed in the oracle, and the `export_bytes` golden family is recorded.
2. An engine port of the writers, `src/export/`: layout, CSV and JSON first, then naming, split and zip, then xlsx, then exporters and the manifest. Each is held to the family.
3. The service transfers byte results.
4. The gate and parity at M.
5. The shell: the `exports` surface, markers and the shadow's byte comparison.
6. The deterministic re-page checks.
7. e2e, the flip to `engine`, and the documents.

**Tech Stack:** TypeScript 6 (`strict`, erasable syntax, `lib: ["ES2023"]`, no DOM or Node in `engine/src/`), `fflate` 0.8.3 (new, engine and frontend), vitest 3, Svelte 5 runes, zod, MSW, Playwright; Python 3.14 (FastAPI, pydantic v2, xlsxwriter 3.2, openpyxl, pytest, ruff); pixi for every command.

**Spec:** `docs/superpowers/specs/2026-09-26-eval-exports-design.md` (plan 5's design, approved 2026-09-26), which refines §5 of `docs/superpowers/specs/2026-09-24-evaluation-design.md`.

Read these first:
- `architecture/contracts.md` (CT-4, CT-7), `architecture/decisions.md` (AD-21, AD-26, AD-31), `architecture/program.md` (MR-1…MR-4), `architecture/conventions.md` (RC-4, RC-5).
- `src/data_rover/api/README.md` ("Code execution, tables and exports").
- `engine/README.md` (`src/table/`, `src/artifacts/`, `src/service/`, golden fixtures, bench, parity).
- `frontend/src/lib/engine/README.md` (surfaces, gates, fallbacks, shadow), and `frontend/README.md` before touching `frontend/src/lib/state/`.
- Plan 4 (`docs/superpowers/plans/2026-09-25-eval-tables.md`), whose table evaluation, order cache, 501 seam and marker this plan builds on.

**What kind of plan this is.** Direction with specifics, as plans 1–4. It gives interfaces, signatures, the test cases and what each asserts, the order, and a full account of the mechanisms that are easy to get wrong. It gives no full code. The expected results of the "see it fail" steps are reasoned from the code, not observed. If one does not appear, trust the run, read the step's intent, and say so in the hand-back. What WAS checked while planning is listed next.

## What planning found

These facts were checked against the code at `6ef4018` with tracers and throwaway probes. The probes ran under Python 3.14 through `pixi run -e core-dev`, with `PYTHONPATH=src`; they are in the planning session's scratchpad (`probes/xlsx_probe.py`).

1. **The writers.**

   | Module | Lines |
   |---|---|
   | `core/table/json_export.py` | 602 |
   | `core/table/export_layout.py` | 183 |
   | `core/table/exporter.py` | 164, mostly schema |
   | `core/table/naming.py` | 121 |
   | `core/table/split.py` | 92 |
   | `core/table/csv_export.py` | 75 |
   | `core/table/cell_text.py` | 44, ported in plan 4 as `cellText` |
   | `api/table_export.py` (xlsx) | 163 |
   | `api/export_manifest.py` | 100 |
   | `api/table_export_engine.py` | ≈350 lines of logic |

   The routes are `routes/tables.py::export_table` (`:544`) and `json_preview` (`:657`), and `routes/exports.py::run_export` (`:145`) → `_execute_export` (`:231`).
   - All three are plain `def (payload, project_id, session, db, runner, settings)`.
   - `export_table` and `run_export` return a FastAPI `Response` (the whole body in `.body`) or a 202 `JSONResponse`. `json_preview` returns `JsonPreviewOut{sample, truncated}`.
   - `/exports/preview-transform` and `GET /exports/run-by-name` are outside the surface.
2. **Export limits.**
   - `TableLimits(max_cell_elements=10**9, ignore_cell_caps=True)` is used at `table_export_engine.py:359`, `:635` and `tables.py:698`. Default `max_rows` is 50,000.
   - `ignore_cell_caps` is read only at `cells.py:316-320`: the cap is `max_cell_elements` instead of `min(col.cell_cap, max_cell_elements)`.
   - The engine's `TableLimits` (`engine/src/table/rows.ts:32`) has no such flag. Its one cap site is `cells.ts:243`.
   - Rows and order read only `maxRows`, so an export's order equals the grid's.
3. **`/tables/export`** (`tables.py:543-645`).
   - The body is `EvaluateTableIn` plus `format` (xlsx|json|csv|jsonl, default xlsx); `offset` and `limit` are ignored.
   - The name is the table artifact's name, or `"table"`. The table's own `transform` applies here only, and a non-JSON format with a transform is a 422.
   - It answers a single file with its `MEDIA_TYPES` content type (`table_export_engine.py:481-486`), or `application/zip` `{name}.zip` for a split.
   - `Content-Disposition: attachment; filename="…"` is unsanitized. `X-Table-Truncated: true` and `X-Table-Script-Errors: true` are sent only when true.
   - `LookupError`, `ValueError` and `NavigationResolveError` become a 422.
4. **`/tables/json-preview`** (`:657-752`).
   - `render_json` with the table's own layout: no `json_doc` shape, no split, no transform.
   - A 200-row window (`PREVIEW_MAX_ROWS`). When truncated with more than one document, the last one is dropped.
   - `sample = json.dumps(docs, ensure_ascii=False, indent=2)`. It never answers 202.
5. **`/exports/run`** (`exports.py:144-590`).
   - Exactly one of `artifact_id` and `definition`, else 422. An unknown id, one in another project, or one of another kind is a 404. A draft's name is `name or "export"` with `artifact_id = None`.
   - `_execute_export` runs in this order:
     1. No entries → 422.
     2. `ctx = export_context_vars` once per request: `rev` = `session.model_rev`, `date` = UTC `%Y%m%d` from `datetime.now(UTC)`, `project` = the project **id**.
     3. The output filename's tokens are checked (422 `output filename: …`).
     4. One pass over the entries collects three 422 lists, raised in this order: missing tables, bad templates, bad transforms. A transform on xlsx or csv counts as a bad transform.
     5. The transform host is opened.
     6. Each entry is run with `render_defn = overridden_table(defn, entry)`.
   - **Assembly** (`:429-560`):
     - `"manifest"` is reserved when `output.manifest and mode == "zip"`.
     - `_dedupe_path` adds `_2`, `_3`, … over extension-less `prefix + stem`.
     - There are three member shapes: a split with `split_folder = false` (each file deduped), a split (`{prefix}{dedup(sanitize_stem(out_name) or "export")}/{fn}`, every path reserved), and a single file (`{prefix}{dedup(sanitize_stem(stem) or "export")}.{ext}`).
     - The zip stem is `sanitize_stem(substitute(filename, {name: run_name, **ctx})) or sanitize_stem(run_name) or "export"`.
     - `bare` with ≠ 1 file (manifest counted) is 422 `bare output requires a single file (this run produced N)`. Otherwise it ships the file under its last path segment, with the `X-Table-*` headers.
6. **The pipeline per entry** (`table_export_engine.py:899-982`).
   - The steps are render → `on_error` check → shape (`jsonl` is always the list; `json` is `dict(zip(keys, docs))` for the object shape, else the list) → transform → serialize.
   - Pretty is `indent=2` and compact is `(",", ":")`. Both use `ensure_ascii=False` and no trailing newline. `pretty` defaults to true, also when `json_doc` is None.
   - JSONL is compact with a `\n` after every line.
7. **`render_json_ex`** (`json_export.py:365`) consumes RowKeys plus cells.
   - Keys: `json_export.key`, else the header, else `"{kind}_{i}"`, with a global `_N` dedupe.
   - Value modes are `name`, `id` and `object` (`{id, name, type}`). `single` collapses a list, and more than one value raises `ValueError` → 422.
   - Errors become `{"$error": msg}`, and a dangling element becomes `{"$error": "unknown element …"}`.
   - Grouping buckets by the row key minus the grouped slots, in a dict in first-appearance order. In a grouped array a `None` slot is dropped and a lone childless member is unwrapped.
   - `key_column` must be a non-empty scalar with no duplicates. Keys sort by `(rank, def index)`, with the row-number slot `-1` breaking ties.
8. **Buckets use Python dict semantics.** `1`, `1.0` and `True` share a bucket in grouping (`json_export.py:417-430`, `:586-591`), in `key_column` duplicate detection and in split (`split.py:284-292`, bucketing on `rk[0]`).
9. **Naming and split.**
   - `TOKEN_RE = \$\{([^}]*)\}`. `validate_tokens` lists unknown tokens sorted. `substitute` leaves unknown tokens as they are.
   - `sanitize_stem` replaces `/\:*?"<>|` and control characters < 32 with `_`, strips, cuts to 120 **code points**, and strips again. An all-dots stem becomes that many `_`.
   - `folder_segments` rejects a leading `/` or `\` and any empty segment.
   - `NAME_TOKENS = {rev, date, project, name}`; `SPLIT_TOKENS` adds `id`. A split template must hold `${name}`.
   - `partition_label` returns `(id, display_name)`, or the id for a dangling element. `render_filenames` substitutes, sanitizes, falls back to the id and then `"element"`, and dedupes with `_N`.
10. **CSV** (*probe*). `csv.writer(dialect="excel")` with minimal quoting and `\r\n`; the output is `.encode("utf-8")` with no BOM.
    - A field is quoted when it contains `,`, `"`, `\r` or `\n`, and a `"` inside is doubled. A leading space is not quoted.
    - A row made of ONE empty field writes `""`, while `["", ""]` writes `,`.
    - Non-strings go through `str()`: `1.0`, `True`, `1152921504606846976`, `1e+16`, `[1, 'a']` (quoted, since it holds a comma), `{'a': 1}`.
    - The row number is 1-based.
11. **xlsx** (*probe*). xlsxwriter 3.2.9 with `strings_to_urls` and `strings_to_formulas` off.
    - **Cell types.** Data cells are `ws.write(r, c, cell_text(…), cell_fmt)`, so the Python type picks the cell type:
      - `str` → shared string (`=1+1` and `http://x` stay strings);
      - `""` or `None` → a formatted blank;
      - `bool` → boolean;
      - `int`/`float` → number (`2**60` reads back as `1.152921504606847e+18`, `-0.0` as `0`);
      - NaN/Inf → `TypeError`. It is unreachable: the engine's parser loads bare `NaN` as a string, and neither side's JSON parse yields a float NaN from wire text.
      - **`list`/`dict` → `TypeError Unsupported type` (fact 12).**
    - **Row number and header.** The row number is `write_number`. The header is bold with `border: 1`, `bottom: 2`. Data cells have `border: 1`.
    - **Sheet.** `freeze_panes(1, 0)`, and an autofilter over `(0, 0, last_row, ncols − 1)`.
    - **Autofit** runs before the notice. For each column, width = max over cells of:
      - a string: `xl_pixel_width` (`CHAR_WIDTHS` per character, default 8, the widest line of a multi-line string);
      - a number: `7 × len(str(n))`;
      - a boolean: 31/36 px;
      - plus 16 px for a header cell inside the autofilter.

      The column width is then `_pixels_to_width(max + 7)`, where `_pixels_to_width(p) = p / 12` if `p ≤ 12`, else `(p − 5) / 7`, capped at `_pixels_to_width(xlsx_autofit_max_px = 600)` and 255. Blanks do not count. The XML width is written by `_write_col_info`; port its formula, not the probe's readback.
    - **Sheet title.** `_sheet_title` replaces `[]:*?/\` with `_`, cuts to 31 code points, strips `'`, and falls back to `"Table"`.
    - **Not deterministic.** `docProps/core.xml` carries `dcterms:created` from the wall clock, so the server's xlsx is not byte-stable.
    - Its source is under `.pixi/envs/core-dev/lib/python3.14/site-packages/xlsxwriter/` (`worksheet.py`, `utility.py::xl_pixel_width` and `CHAR_WIDTHS`).
12. **Bug C — xlsx over a list or dict value (CONFIRMED, 500, reachable in the examples).**
    - `cell_text` returns a `ValueCell`'s raw value, and a multi-valued property (smart-city's `tags: string 0..*`) in a collapse column over one element yields a list.
    - `build_workbook(None, ["H"], "S", [[ValueCell(True, ["a","b"], "e1", True)]])` raises `TypeError: Unsupported type <class 'list'> in write()`. The route catches only `LookupError` and `ValueError`, so an xlsx export of a smart-city table with a `tags` column answers 500.
    - CSV of the same cell writes `"['a', 'b']"`.
13. **Zip** (`table_export_engine.py:489-503`). `zipfile.ZIP_DEFLATED` (zlib level 6), every `date_time` `(1980, 1, 1, 0, 0, 0)`, members in the order given: the manifest first, then entries in definition order, then partitions in row order.
    - Its bytes depend on zlib and on the host OS byte, so zips compare by entry list.
    - `fflate` 0.8.3 is on npm. Its sync `zipSync` spawns no workers. It converts a `Date` `mtime` with LOCAL getters, so `new Date(1980, 0, 1)` gives the DOS date 1980-01-01 00:00 in every time zone, while a string or epoch number would shift with the zone.
14. **Manifest** (`export_manifest.py:78-99`).
    - Fields in order: `manifest_version: 1`, `project_id`, `artifact_id` (null for a draft), `artifact_name`, `model_rev`, `truncated` and `degraded` (each OR'd over entries), `entries`.
    - Each entry is `{name, table_ref, table_name, format, truncated, degraded, files, transform}`.
    - It is serialized with `indent=2` and `ensure_ascii=False`, no trailing newline, and no clock.
    - `transform` is the snippet ref id, `"inline:" + sha256(code.encode()).hexdigest()[:12]`, or `null`.
15. **Script reach.**
    - `table_has_script` covers the table's own columns and navigations. An exporter entry also reaches a script through a non-empty `transform: SnippetSource` (ref or inline Python code; empty means `ref is None and definition is None`), and `/tables/export` through the table's own `transform`.
    - There is no Python `exporter_has_script`.
    - The engine's `tableHasScript` is in `engine/src/table/resolve.ts:75-93`. `schema.ts` parses `TableDefinition.transform` but does not check it.
16. **The engine today.**
    - `engine/src/table/route.ts:78-138`:
      - `sourceOf` and `resolved` are private (`:31-54`);
      - `tableHasScript` gives a 501 (`:82`);
      - the order is taken from the cache or built, then put (`:97-116`), inline — there is no reusable "ordered rows" helper;
      - `tableSteps` (`:147`) is uncached and bench-only.
    - `cellText` (`cell-text.ts:14-27`) returns a raw `Value` for a value cell and joins multi-values with `pyStr` and `'; '`.
    - `pyReprValue` / `pyStr` (`value/repr.ts:33-47`) give Python `repr`/`str` for every value, lists and dicts included. `jsStr` is NOT Python `str` and must not be used.
    - `pyDumps(value, indent?, {allowNan?})` (`value/serialize.ts:68`) lists array-index-like keys of a plain object first (CT-7 Order). `sha256(Uint8Array)` is synchronous (`snapshot/sha256.ts:88`).
17. **The service.**
    - `Call.answer = (result) => post({id, ok: true, result})`, which calls `port.post(message)` with no transfer list (`service.ts:459-473`). `Port.post(message, transfer?)` exists (`types.ts:7-10`) and the sandbox forwards it (`sandbox/src/host.ts:90-93`).
    - Results never pass through `toWire`, and `toWire` would turn an `ArrayBuffer` into `{}` (`read/wire.ts:32-51`).
    - A control-lane transition or a close drops a running scan and runs `run()` again later. Artifact methods are `now` and can move the `ArtifactSet` between slices.
18. **The golden harness.**
    - `Recorder._apply` builds a fresh `Session` per read (`model_rev` 0), and `_read` passes every route argument (`model_steps.py:427-504`). `_ArtifactDb.get` returns `SimpleNamespace(project_id="p", kind, payload)` with no `name` or `id`, both of which the export routes read. The engine replay names every artifact `name: id` (`engine/test/golden/model-steps.ts:375-389`).
    - `staged.test.ts` replays a family with its artifacts staged.
    - The clock patch point is `data_rover.api.table_export_engine.datetime` (imported by name, `:23`, used `:516`).
19. **The shell.**
    - The four functions are in `frontend/src/lib/api/tables.ts:103-154` and `exports.ts:10-60`, unrouted.
    - `exportTable` and `run*` return `ExportResult = {kind: 'ready', blob, filename} | {kind: 'preparing', done, total}` (`tables.ts:80-82`). The filename comes from `Content-Disposition`. Nothing reads `X-Table-*`.
    - `retryAndDownload(run, …)` (`lib/util/export-download.ts:41-65`) loops on `preparing` (1 s, 120 attempts) and returns `void`. Its callers are:
      - `table-editor.svelte.ts:1736-1748` (`downloadTable`, from `TableView.svelte:535-553`; progress at `:640-651`);
      - `ExporterTab.svelte:194-223` (`runExport`: `runExporter(id)` when the draft is clean with a real id, else `runExporterDraft`).
    - Markers today are `TableView`'s `FALLBACK_NOTE` (`:103-106`, `:734-738`).
    - The shadow (`lib/engine/shadow.ts`) is async and compares `present(surface, value)` with `deepEqual`. For `ArrayBuffer` or `Blob`, `Object.keys` is empty, so any two compare equal. It skips while `deps.staged()`.
    - `getActiveProjectId()` (`state/active-project.svelte.ts:5`) is the project id. Tests spy on `exportTable`, `runExporter` and `runExporterDraft` as module exports (`table-editor-script-status.test.ts:205`, `ExporterTab.test.ts:307,625,663`).
    - e2e `frontend/e2e/exporter.spec.ts` already exists. `smoke.spec.ts:66-100` shows the download-capture pattern.
20. **Parity and bench.** `scripts/table_large.py` → `benchmarks/large.table.json` and its meta. `engine-parity-large` depends on `engine-parity-oracle` and `engine-table-oracle` (`pixi.toml:127-135`, `:308-315`), and `engine/bench/parity-large.ts:99-150` compares the table before applying the violation ops. `engine/bench/run.ts` has the `ROWS` order, `stepped` and `timed`; `frontend/bench/main.ts` has the `ping` loop and puts everything before the bad delta.

## Decisions

- **D1 — Bug C, fixed on both sides.** `build_workbook` writes a `list` or `dict` value as `str(value)`, the exact text CSV writes for it. Only that branch changes. The engine writes `pyStr(value)` there. NaN/Inf stays unreachable and is not fixtured.
- **D2 — The fixture shape.**
  - The recorder step is `{"do": "export", "method": "exportTable"|"runExporter"|"runExporterDraft", "body": {...}, "date": "YYYYMMDD"}`. The method maps to `export_table` or `run_export`, called with every argument; the clock is pinned to the step's `date` by patching `table_export_engine.datetime`.
  - It records `{status, filename, content_type, truncated, file}`. A 4xx or 5xx records `{status, detail}` instead.
  - `file` is one of:
    - `{"text": str}` for CSV, JSON, JSONL and the manifest (UTF-8 decoded);
    - `{"xlsx": grid}`, where grid is `{title, rows: [[{v, t}]], widths: {letter: width}, pane, autofilter}`, read with openpyxl;
    - `{"zip": [{"path", ...file}]}` in member order.
  - `previewTableJson` is a `_read` case recording `JsonPreviewOut`.
  - `_ArtifactDb` rows gain `name = id` and `id = id`, matching the engine replay.
  - The engine replay calls `EVALUATIONS[method]` with `{...body, date, project: 'p'}` and renders its parts into the same shape: text decoded, zips unpacked with `fflate.unzipSync`, xlsx read by the test reader of M-xlsx.
- **D3 — Engine refusals.** Schema, template and param refusals are 422 with the Python text where it is the core's own `ValueError` message (naming, split, `_execute_export`'s lists, `bare`). Pydantic-shaped texts are the engine's own words, as plan 4's D1; the shadow compares errors by status.
- **D4 — Reach before anything else.**
  - An export answers `501 reaches a script` as soon as the reach is known, before any other check that could differ, and the server then decides everything about that export. The reaches are:
    - any entry's `transform` non-empty (checked before tables are resolved);
    - any resolved entry table, or the `exportTable` source, for which `tableHasScript` holds;
    - `exportTable`'s table `transform` non-empty.
  - `previewTableJson` checks `tableHasScript` only, since the preview applies no transform.
  - A missing-table 422 found while resolving is still collected into `_execute_export`'s list. An entry that is both missing and beside a transform is a 501, so the server answers its 422.
- **D5 — Order from the cache; cells uncapped.**
  - `route.ts`'s inline block is factored into `orderedRows(ctx, defn, meter): Steps<CachedOrder>` (cache get → build + order → put). `evaluateTable` and every export use it.
  - Exports evaluate cells with `EXPORT_TABLE_LIMITS = {maxRows: 50_000, maxCellElements: 1_000_000_000, ignoreCellCaps: true}`. `TableLimits` gains an optional `ignoreCellCaps`, read at `cells.ts:243` as Python reads it.
  - The order cache's key already strips export-only fields, so an exporter entry reuses an open table's order.
- **D6 — Bytes, never through `toWire`.**
  - Writers produce strings or `Uint8Array`s. Text is encoded once with `TextEncoder` (available in a worker and in Node).
  - A method's result is `{parts: ArrayBuffer[], filename, content_type, truncated, script_errors: 0}`, with parts sliced to ≤ 4 MiB (copies of the encoded buffer's ranges, each an own `ArrayBuffer`).
  - Nothing is published before the last step.
  - `content_type` and `filename` equal the oracle's `Content-Disposition` filename and media type exactly.
- **D7 — Transfer.**
  - `Call.answer(result, transfer?: readonly ArrayBuffer[])`, threaded into `post`.
  - `Service.evaluate` answers with `transferOf(result)`: `result.parts` when it is an array of `ArrayBuffer`s, else none.
  - `ReplicaSync.call` needs no change: transfer happens on the sender.
- **D8 — Context as params.** `date` (required, `^\d{8}$`, else 422 `date must be YYYYMMDD`) and `project` (required, non-empty string). `${rev}` and the manifest's `model_rev` are `ctx.working?.rev ?? 0`, the committed rev. The engine reads no clock (RC-5); `new Date(1980, 0, 1)` in `zip.ts` is a constant, not a clock read.
- **D9 — Never degraded.** Every `degraded` is `false`, there is no notice row, and `script_errors` is `0`. The degraded path is recorded on the backlog as unreachable until D.
- **D10 — xlsx identity.**
  - The writer's bytes are a pure function of the grid (fixed XML parts, no timestamps, fixed zip dates), and are held identical over two runs in Node.
  - The truth check against a real reader: the engine commits `engine/fixtures/xlsx/sample.xlsx` (the engine's output for the `export_bytes` case `xlsx_types`). An engine test fails if the engine's bytes for that case differ from the file (regenerated by `npm run xlsx-sample`). A Python test opens the file with openpyxl and asserts its grid equals the fixture's recorded grid.
- **D11 — `fflate`** is pinned exactly (`0.8.3`) in `engine/package.json` `dependencies` (the engine's first runtime dependency; pure JS, worker and Node, RC-4) and in `frontend/package.json` `dependencies` (the shadow's unzip, dynamically imported).
- **D12 — Staged changes in the UI (owner's ruling A).** The manifest keeps `model_rev` = the committed rev, with the format unchanged. The table's Export control and the exporter tab's Run button show `data-testid="export-staged-note"`, "Includes staged changes", when `engineSide('exports') === 'engine'` and the replica holds staged model ops or staged artifacts.
- **D13 — The shadow compares digests.**
  - `route()` gains an option `digest?: (value: T) => Promise<unknown>`, carried on the probe. The shadow awaits it for each ok outcome before `same()`.
  - The exports digest is `{filename, content_type, truncated, body}`, where `body` is:
    - the decoded text for JSON, JSONL and CSV;
    - for a zip, the entry list `[[path, text | 'xlsx']]` (unzipped with `fflate`, dynamically imported);
    - omitted for a single xlsx.
  - A `preparing` result digests to the sentinel `SKIP`, and a comparison with a `SKIP` on either side ends without a report.
  - `previewTableJson` needs no digest.
- **D14 — The switch.** `exports` joins `Surface`, `SURFACES` and `SURFACE_DEFAULTS` as `server` (Task 8), not `READ_SURFACES`. Its gate is `follower.loaded()`. It flips to `engine` in Task 10, after e2e shows no `[shadow]` line with the switch forced to `engine`.
- **D15 — Out of scope,** each recorded (the design's §4): `K-65`, `K-66`, `K-68`, `K-69`, `K-70`, `K-71`, `K-72`, `K-73`, K-60's server half, `C-23`, `K-58`, `K-62`, `K-63`, `T-9`, `T-10`, R13.

## Global Constraints

- Everything runs through pixi (`PATH=~/.pixi/bin:$PATH`). There is no global `node` or `python`.
- **Branch and commits.** Work on the session's branch (`claude/task-plpxhj`, standing in for `feat/eval-exports`), at `origin/engine-migration` (`6ef4018`) plus this plan's docs commits. One commit per task, pushed to that branch only. `engine-migration` is fast-forwarded only with the owner's go-ahead (Task 10). Never touch `main`.
- **Freeze (MR-3).**
  - `core/model`, `core/metamodel`, the model-op applier and plans 1–4's areas stay frozen.
  - From Task 1 on, the writers (`core/table/{csv_export,json_export,export_layout,exporter,naming,split,cell_text}.py`), `api/table_export*.py`, `api/export_manifest.py` and the export route functions are frozen for behaviour. Only D1 changes them, with a Python test and a fixture.
  - `src/data_rover/` changes only in Task 1. Task 7's `scripts/export_large.py` is not `src/`.
  - The Python core is the oracle: fix the engine, never a fixture. Fixtures change only through `pixi run golden-fixtures`.
- **Engine `src/` rules.**
  - No DOM, Node built-in, timer, clock, `Math.random`, `Intl` or locale comparison (RC-4, RC-5).
  - Erasable syntax, `.ts` specifiers, no `any` in an exported signature.
  - Strings compare by `cmpCodePoint`. Python `str()` is `pyStr` / `pyReprValue`, never `String()` or `jsStr`. Lengths and cuts that Python measures (`sanitize_stem` 120, the sheet title 31) count code points.
  - Buckets and duplicate checks key on Python equality (`1 == 1.0 == True`) through the engine's existing equality signature (the one uniqueness uses — find it with `searcher`), never on raw `Map` identity.
- Tests import the engine through `engine/src/index.ts`. Engine and frontend tests run the real engine, never a mock, and without fake timers. Every in-process link is `dispose()`d.
- A steps generator publishes nothing before its last step. Bytes never pass through `toWire`.
- **Lint and checks.**
  - `pixi run engine-tidy` for `engine/`, `pixi run dr-tidy` for the rest.
  - For every file under `tests/` and `scripts/`: `pixi run -e core-dev ruff check <files>` and `ruff format <files>`.
  - `pixi run engine-check`, `pixi run frontend-check` and `pixi run sandbox-check` pass.
- A "see it fail" step lists the tests it expects red. Any OTHER red test is a finding to report, not to silence.
- Comments and docstrings are concise and present-tense, only for what the code cannot say. No references to specs, plans or `architecture/` ids in code (RC-6).
- `architecture/`, the READMEs, `BACKLOG.md` and `BACKLOG-ENGINE.md` change in the commit of the code they describe (RC-10). `docs/superpowers/` is committed (RC-9). `benchmarks/` and `.superpowers/` are git-ignored; never `git add -f`.
- Commit subjects: one imperative sentence, capitalized, no prefix, no trailing period. The message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and nothing else.
- Ids: the next free are `AD-34`, `K-74`, `C-24`, `T-11`, `U-11`. Grep before use; K ids are unique across both backlogs.
- **Baseline** at `6ef4018` (2026-09-25):

  | Suite | Result |
  |---|---|
  | core | 2,600 passed / 34 deselected |
  | frontend | 3,081 in 285 files |
  | engine | 1,426 in 95 files |
  | sandbox | 14 |
  | e2e | 69 passed / 1 failed (T-9), no `[shadow]` lines |
  | `engine-parity-large` | equal (50,000 table rows, 18,523 issues) |

- **e2e in this environment.**
  - Run `pixi run sandbox-build` first.
  - Stop a stale `vite preview` in its own command, never `pkill -f "vite preview"` inside a compound command, which kills its own shell.
  - Then run `PLAYWRIGHT_BROWSERS_PATH=<scratchpad>/pwb pixi run frontend-test-e2e`.

## Review Focus

The six conditions most likely to bite a user that the tasks' ordinary tests would not reach. Each has its test in the task named.

1. **A staged exporter over a staged table.** The user saves (stages) an exporter and edits one of its tables without committing. The run holds the staged table's rows and the staged exporter's entries; the manifest's `model_rev` is the committed rev. *Task 5.*
2. **Python equality in buckets.** Rows whose split or group slot holds `1`, `1.0` and `True` land in ONE file or group, while `"1"` lands in another. The same holds for a `key_column` duplicate. *Tasks 2, 3.*
3. **Script reach anywhere in a run.** One entry of five has a transform, or a staged navigation gains a script step under one entry's table. The whole run is served by the server behind the marker. Unstaging returns it to the engine without a reload. *Tasks 5, 8.*
4. **Non-ASCII names.** A table named with astral and CJK characters and `/:*?` exercises `sanitize_stem`'s 120-code-point cut, zip entry paths in UTF-8, and the 31-code-point sheet title. *Tasks 3, 4.*
5. **A transition mid-export.** A staged edit posted while a long export runs: the export restarts, answers the state it finally ran on, and never emits a partial file. *Task 6.*
6. **The shadow on a real download.** No false mismatch from a server 202, from xlsx bytes, or from a zip's DEFLATE bytes; one differing CSV byte IS reported. *Task 8.*

---

## File Structure

**Python (Task 1, Task 7)**
- Modify: `src/data_rover/api/table_export.py` (D1).
- Create: `tests/api/test_table_export_values.py` (D1).
- Create: `tests/golden/scenarios/export_bytes.py`, `tests/golden/xlsx_widths.py` (generator). Modify: `tests/golden/model_steps.py` (`export` step, `_read` case, `_ArtifactDb` name/id), `tests/golden/driver.py` (`GENERATED`), `tests/golden/scenarios/__init__.py`.
- Create: `tests/golden/test_engine_xlsx.py` (Task 4, D10).
- Create: `scripts/export_large.py`; modify `pixi.toml` (Task 7).

**Engine**
- Create: `engine/src/export/{layout,csv,json,naming,split,zip,xlsx,xlsx-widths,schema,manifest,run,route}.ts`. `xlsx-widths.ts` is generated.
- Modify:
  - `engine/src/table/{route,rows,cells}.ts` (D5);
  - `engine/src/evaluate/index.ts`;
  - `engine/src/service/{service,types}.ts` (D7);
  - `engine/src/index.ts`, `engine/package.json`, `engine/package-lock.json`, `engine/.prettierignore`, `engine/README.md`.
- Tests:
  - `engine/test/export/{text.golden,split.golden,xlsx.golden,run.golden,staged,layout,csv,json,naming,zip,xlsx,reach}.test.ts`;
  - `engine/test/export/xlsx-reader.ts` (test-only reader);
  - `engine/test/golden/model-steps.ts`;
  - `engine/test/service/exports.test.ts`;
  - `engine/fixtures/xlsx/sample.xlsx`, with `engine/scripts/xlsx-sample.ts` and an npm script.
- Bench: `engine/bench/run.ts`, `engine/bench/parity-large.ts`.

**Frontend**
- Modify:
  - `frontend/src/lib/api/{tables,exports,engine-route,types}.ts`;
  - `frontend/src/lib/engine/{surfaces,shadow,seam}.ts`;
  - `frontend/src/lib/state/{replica,table-editor}.svelte.ts`;
  - `frontend/src/lib/util/export-download.ts`;
  - `frontend/src/lib/components/Table/TableView.svelte`, `frontend/src/lib/components/Export/ExporterTab.svelte`;
  - `frontend/package.json`, `frontend/package-lock.json`;
  - `frontend/README.md`, `frontend/src/lib/engine/README.md`.
- Tests:
  - `frontend/src/lib/api/__tests__/exports-route.test.ts`;
  - `frontend/src/lib/engine/__tests__/{surfaces,shadow}.test.ts`;
  - `frontend/src/lib/util/__tests__/export-download.test.ts`;
  - `frontend/src/lib/components/Table/__tests__/TableView.test.ts`, `frontend/src/lib/components/Export/__tests__/ExporterTab.test.ts`;
  - `frontend/src/lib/state/__tests__/table-editor-repage.test.ts` (Task 9).
- Bench: `frontend/bench/main.ts`, `frontend/bench/run.ts`.
- e2e: create `frontend/e2e/eval-exports.spec.ts`.

**Documents:** `architecture/contracts.md` (CT-4, CT-7), `architecture/program.md`, `BACKLOG-ENGINE.md`, `src/data_rover/api/README.md`, `src/data_rover/core/README.md` (only if D1 is worth a line there).

## Mechanisms

**M1 — Layout** (`export/layout.ts`). A port of `export_layout(defn)`:
- `normalizedOrder` works through `export_order`, drops invalid entries, puts the row number first if it was not placed, then appends the rest in `normalized_display_order`.
- `exportHeader` takes the override, then the header, then the kind. The defaults are `"#"` and `"row_number"`.
- `export_definition` restates `include` as `hidden`.
- It returns `ExportLayout {order: number[], rank, rowNumberAt: number | null, headers: string[], keys}`, in the oracle's field meanings.

**M2 — Rows for an export** (`export/route.ts`). `exportRowsSteps(ctx, defn, meter)`:
1. `orderedRows(ctx, defn, meter)` (D5).
2. `evaluateCellsSteps` over ALL ordered keys with `EXPORT_TABLE_LIMITS`, yielding `{keys, cells, truncated, baseSlots}`.

The preview runs the same, then evaluates cells for the first 200 keys only.

**M3 — CSV** (`export/csv.ts`). `renderCsv(model, headers, rows, rowNumberAt): string` implements fact 10 exactly:
- `field(v)` = `pyStr(v)` for non-strings, and `''` for `null`.
- Quote when the field matches `/[",\r\n]/`, doubling `"`.
- A one-field row whose field is `''` writes `""`.
- Rows end with `\r\n`.

**M4 — JSON** (`export/json.ts`). `renderJsonEx(model, defn, keys, cells, baseSlots, layout, rowNumber, keyColumn)` ports fact 7 rule for rule:
- Documents are `Value`s built with `Map`-backed objects wherever keys come from data (object shape, grouping). They are serialized by a writer that prints a `Map` in insertion order in `pyDumps`'s exact layout (compact or `indent=2`), reusing `pyDumps` for scalars.
- `shapeJsonDocs`, `jsonlText` (compact, `\n` per line) and `jsonText(docs, pretty)` (no trailing newline) follow fact 6. The `on_error` check is `containsErrorMarker`.

**M5 — Naming and split** (`export/naming.ts`, `export/split.ts`). Ports of fact 9:
- `validateTokens(template, allowed): string | null`, returning the oracle's message;
- `substitute(template, vars)`;
- `sanitizeStem(s)`, with code-point slicing through `Array.from`;
- `folderSegments(s)`;
- `splitPartitions(keys)`, bucketing on slot 0 by Python-equality signature, in first-appearance order;
- `partitionLabel(model, v)`;
- `renderFilenames(template, partitions, vars)`.

**M6 — Zip** (`export/zip.ts`). `zipEntries(files: {path: string, bytes: Uint8Array}[]): Uint8Array` calls `fflate.zipSync` with every entry `{level: 6, mtime: new Date(1980, 0, 1)}`, in the given order.
- `zipSync` takes a plain object keyed by path, and JS lists integer-like keys first. Every path carries an extension, so none is integer-like; `zipEntries` throws if one is, rather than reorder silently.

**M-xlsx — The writer** (`export/xlsx.ts`, `export/xlsx-widths.ts`). `buildWorkbook(model, headers, sheetName, rows, rowNumberAt): Uint8Array`:
- **Parts** (fixed text): `[Content_Types].xml`, `_rels/.rels`, `docProps/app.xml`, `docProps/core.xml` (no dates), `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/styles.xml`, `xl/sharedStrings.xml`, `xl/worksheets/sheet1.xml`.
- **Styles.** Three `cellXfs`: default; header (bold font, thin border all round, medium bottom); data (thin border all round).
- **Sheet.** `<sheetViews>` with a frozen pane `ySplit="1" topLeftCell="A2"`; `<cols>` with the autofit widths (`customWidth="1"`); `<sheetData>`; `<autoFilter ref="A1:{lastCol}{lastRow}">`; and the `_xlnm._FilterDatabase` defined name in `workbook.xml`, as xlsxwriter writes it.
- **Cells** follow fact 11's dispatch:
  - a string (after D1: `pyStr` for a list or dict) → shared string `t="s"`, with XML-escaped text (xlsxwriter's escaping; `xml:space="preserve"` for leading or trailing whitespace);
  - `''` / `null` → `<c r s/>`;
  - a boolean → `t="b"`;
  - a number → `<v>` in xlsxwriter's number text (read `_write_number`'s formatting and port it; `2**60` must read back as the float `1.152921504606847e+18`, `-0.0` as `0`);
  - the row number → a number.
- **Autofit** is fact 11's algorithm, with widths written with `_write_col_info`'s formula.
- **Sheet title** is `_sheet_title`.
- **Generated table.** `tests/golden/xlsx_widths.py::render()` emits `CHAR_WIDTHS` as `xlsx-widths.ts` (in `GENERATED`, ignored by prettier) and pins xlsxwriter's version in a comment.
- **Test reader.** `engine/test/export/xlsx-reader.ts` (test-only) unzips with fflate and reads `sharedStrings`, `sheet1` and `workbook` into D2's grid shape, as openpyxl would read them: a number with `.` or `E` is a float, else an int; `t="b"` is a bool; a blank has no value. It is held honest by D10.

**M7 — Exporters** (`export/schema.ts`, `export/run.ts`, `export/manifest.ts`).
- `readExporterDefinition(raw, where)` checks `schema_version = 1`, `output {mode zip|bare, filename = "", manifest = true}` and `entries` (≤ 50), each `{source: {ref}, name, folder, split_folder = true, format = xlsx, columns?, export_order?, show_row_numbers?, export_row_number?, json_split?, json_doc?, transform?}`, with the oracle's defaults.
- `overriddenTable(defn, entry)` drops out-of-range and duplicated overrides (first wins). Columns not mentioned get `export` / `json_export` = null. The entry's transform replaces the table's.
- `runExportSteps(ctx, def, {artifactId, name, date, project})` is fact 5's `_execute_export`, in its order, with D4's reach first. Each entry renders through M2–M4 / M-xlsx and M5; assembly and packaging follow fact 5; the manifest is written first when included (fact 14, `sha256` over `TextEncoder().encode(code)`).
- `runExporter` reads `artifact_id` through the `ArtifactSet` (kind `exporter`, else 404 with the oracle's text; the name is the artifact's name).
- `runExporterDraft` reads `{definition, name}`, with the name defaulting to `"export"`.

**M8 — The methods** (`export/route.ts`, in `EVALUATIONS`).

| Method | Params | Answer |
|---|---|---|
| `exportTable` | `{definition? \| artifact_id?, format = "xlsx", date, project}` | D6 |
| `previewTableJson` | `{definition? \| artifact_id?}` | `{sample, truncated}` |
| `runExporter` | `{artifact_id, date, project}` | D6 |
| `runExporterDraft` | `{definition, name = "", date, project}` | D6 |

- `run()` reads the params and resolves the source (reusing `route.ts`'s `sourceOf` / `resolved`, now exported from the table module) and D4's reach. The generator does the rest.
- `exportTable`'s name is the table artifact's name, or `"table"` for an inline definition.

**M9 — The shell.**
- `exportTable(args & {signal?}, cfg?)` becomes `route('exports', cfg, (call) => call('exportTable', {...asSent(body), date: utcDate(), project: getActiveProjectId()}, signal).then(toReady), () => <today's server call, now also reading X-Table-Truncated>, {mark: (r, reason) => ({...r, fallback: reason}), digest: exportDigest})`.
- `toReady` wraps `new Blob(parts, {type: content_type})` into `{kind: 'ready', blob, filename, truncated}`.
- `runExporter`, `runExporterDraft` and `previewTableJson` are routed the same way (the preview without `digest`).
- `utcDate()` lives in `lib/util/` (`YYYYMMDD` from `new Date()`'s UTC getters).
- `retryAndDownload` returns the final `ExportResult`. `downloadTable` returns it, and `TableView` and `ExporterTab` keep the last result's `fallback` for their marker.

---

### Task 1: Bug C and the `export_bytes` family · `critical-implementer`
*Reason: fixes the oracle and freezes the recorded shape every later engine task replays; pins the clock.*

**Files:** Python (Task 1) in File Structure.

**Interfaces:**
- Produces: the `export` recorder step and `previewTableJson` `_read` case (D2); `_ArtifactDb` rows with `name` / `id`; the fixture `engine/fixtures/golden/export_bytes.json`; the generated `engine/src/export/xlsx-widths.ts`.

- [ ] **Step 1: Failing test for D1.** `tests/api/test_table_export_values.py`, through `POST /tables/export` on the `client` fixture (copy the setup style of `test_table_export_formats.py`):
  - A table over a type with `tags: string 0..*`, one element holding `tags: ["a", "b"]`, exported as xlsx → 200, and openpyxl reads `"['a', 'b']"` as a string cell.
  - The same table's CSV has the identical text.
  - The dict branch: a direct `build_workbook` call with `ValueCell(True, {"k": 1}, "e1", True)` reads back `"{'k': 1}"`.
- [ ] **Step 2: See it fail** (500 / `TypeError`). Everything else stays green.
- [ ] **Step 3: Implement D1** in `build_workbook`: one branch before `ws.write`.
- [ ] **Step 4: The recorder.**
  - `model_steps.py`: `_ArtifactDb` rows get `name` and `id`; the `export` step per D2, with a small reader turning a response into `file` (UTF-8 text by content type; `zipfile` entries; openpyxl grid: `title`, `rows` of `{v, t}` over `ws.iter_rows()`, `widths` from `column_dimensions` (only set ones), `pane` = `ws.freeze_panes`, `autofilter` = `ws.auto_filter.ref`).
  - Pin the clock with `unittest.mock.patch.object(table_export_engine, "datetime", _Fixed)`, where `_Fixed.now(tz)` returns the step's date at 00:00 UTC.
  - `_read` gains `previewTableJson` → `tables.json_preview(...)`.
  - `tests/golden/xlsx_widths.py` goes into `GENERATED`.
- [ ] **Step 5: The scenario** (`export_bytes.py`). It reuses `table_rows`' metamodel and model, importing its builder, and adds the `tags` property and a `score` holding ints, floats, `True`, `2**60`, `-0.0` and `1e16` across elements if the model lacks them. Artifacts: tables (committed), navigations, exporters.

  **Cases**, named because later tasks replay them by name prefix:
  - **`text_*`**
    - `exportTable` in csv, json and jsonl over: the element, property (collapse over lists) and navigation columns; row numbers placed first and mid; `export_order` with an invalid entry; hidden columns; headers with `,"` and newlines; values from fact 10's probe list.
    - **`text_json_*`** — every JSON option from fact 7: `key`, `item_key`, value modes `name` / `id` / `object`, `single` (ok and >1 → 422), grouping with `None` slots and a lone childless member, `$error` cells (a dangling element).
    - **`text_preview_*`** — `previewTableJson` with more than 200 rows, where truncated drops the last document.
  - **`split_*`**
    - `exportTable` json with the table's own `json_split`: partitions by element, a dangling partition element, slot 0 holding `1`, `1.0`, `True` and `"1"`, filename templates with `${id}` / `${name}`, collisions needing `_2`, stems with `/:*?"<>|`, astral and CJK characters and more than 120 code points, all-dots.
    - The same as `jsonl`.
  - **`xlsx_*`**
    - **`xlsx_types`** — every value kind of fact 11 (post-D1), the row number, multi-line strings, CJK and astral text, `=1+1`, `http://x`, leading spaces.
    - **`xlsx_autofit_cap`** — a 200-character column over the 600 px cap.
    - **`xlsx_title`** — a table named `a[b]:c*d?e/f\g'` + 40 characters.
    - **`xlsx_empty`** — no rows.
    - **`xlsx_split`** — an xlsx export of a table that carries a `json_split`: the case records what the oracle ships (the split is JSON-family; expect one workbook).
  - **`run_*`** — `runExporter` and `runExporterDraft`:
    - zip with a manifest (entries in several formats, a folder template, `split_folder` false and true, name collisions with each other and with `manifest`);
    - `bare` with one file and with two (422);
    - `output.filename` with `${rev}`, `${date}` and `${project}`, and an unknown token (422);
    - `_execute_export`'s three 422 lists together, in order;
    - no entries (422); an unknown id (404); an id of kind `table` (404);
    - column overrides out of range and duplicated; entry `export_order`.
  - **`reach_*`**
    - An entry with an inline transform, one with a ref'd transform, a table with a script column, a table with the table-level `transform` via `exportTable`. The oracle records what it answers (a 503 with no runner, or a 422); the ENGINE asserts 501 instead, in Task 5's `reach.test.ts`. These cases exist to prove the engine never silently renders them.

  Keep it under 400 entities.
- [ ] **Step 6: Regenerate and check.**
  - `pixi run golden-fixtures`.
  - `pixi run -e core-dev pytest tests/golden tests/api/test_table_export_values.py -q`.
  - `pixi run core-test`, `pixi run dr-tidy`, ruff on the new files.
  - The staleness test proves no existing fixture moved.
- [ ] **Step 7: Docs.** `src/data_rover/api/README.md`: xlsx writes a list or dict value as its `str()`, one clause.
- [ ] **Step 8: Commit:** `Write list values as text in xlsx exports and record export fixtures`.

---

### Task 2: Export rows, CSV and JSON in the engine · `critical-implementer`
*Reason: byte-exact text (quoting, float repr, `json.dumps` layout, Map key order) and Python-equality buckets, where a subtle mistake passes ordinary tests.*

**Files:**
- `engine/src/export/{layout,csv,json,route}.ts`
- `engine/src/table/{route,rows,cells}.ts` (D5)
- `engine/src/evaluate/index.ts`, `engine/src/index.ts`
- `engine/test/golden/model-steps.ts` (the `export` step: D2 replay for text files)
- `engine/test/export/{layout,csv,json,text.golden}.test.ts`
- `engine/README.md`

**Interfaces:**
- Consumes: Task 1's fixture; `tableFetch`, `resolveTableRefs`, `tableHasScript`, `TableOrderCache`, `evaluateCellsSteps`, `cellText`, `pyStr`, `pyDumps`.
- Produces:
  - `orderedRows(ctx, defn, meter): Steps<CachedOrder>`, and exported `sourceOf` / `resolved` from `table/route.ts`;
  - `TableLimits.ignoreCellCaps?`, `EXPORT_TABLE_LIMITS`;
  - `exportLayout(defn): ExportLayout`, `renderCsv(...)`, `renderJsonEx(...)`, `shapeJsonDocs(...)`, `jsonText(docs, pretty)`, `jsonlText(docs)`;
  - `exportRowsSteps(ctx, defn, meter)`;
  - `ExportFileResult {parts: ArrayBuffer[], filename, content_type, truncated, script_errors: 0}`, and `toParts(bytes: Uint8Array): ArrayBuffer[]` (≤ 4 MiB);
  - `exportTable` and `previewTableJson` in `EVALUATIONS`, for single-file csv/json/jsonl. A `json_split` answers 422 `split not supported yet` until Task 3; no fixture case asks for it before then.

- [ ] **Step 1: Failing tests.**
  - `text.golden.test.ts` replays every `text_*` case, comparing `JSON.stringify` of the rendered D2 shape (the whole record: status, filename, content_type, truncated, file).
  - `csv.test.ts`: fact 10's table, row by row.
  - `json.test.ts`:
    - an object shape keyed by `"0"`, `"10"` and `"2"` keeps insertion order;
    - a group over `1`, `1.0` and `True` is one group, and `"1"` another (Review Focus 2);
    - a `key_column` duplicate `1` vs `1.0` → 422.
  - `layout.test.ts`: `export_order` normalisation cases.
  - `table.golden.test.ts` and `cache.test.ts` (plan 4) still pass after D5's refactor.
  - An export after a page of the same table reuses its order: the build steps run are fewer than a fixed bound.
- [ ] **Step 2: See them fail** (the new files red at import).
- [ ] **Step 3: Implement** D5, D6, M1–M4, M2 and M8 for `exportTable` / `previewTableJson` (text formats).
- [ ] **Step 4: See them pass;** `engine-test`, `engine-check`, `engine-tidy`.
- [ ] **Step 5: Docs.** `engine/README.md`: an `src/export/` bullet (a port of the writers, bytes as parts never through `toWire`, export limits, order reuse); the golden bullet gains `export_bytes`.
- [ ] **Step 6: Commit:** `Render CSV and JSON exports in the engine`.

---

### Task 3: Naming, split and zip · `implementer`

**Files:**
- `engine/src/export/{naming,split,zip}.ts`, `engine/src/export/route.ts`
- `engine/package.json` and `package-lock.json` (`fflate` 0.8.3 exact, D11, via `pixi run -e frontend npm install --save-exact fflate@0.8.3` in `engine/`)
- `engine/test/export/{naming,zip,split.golden}.test.ts`, `engine/test/golden/model-steps.ts` (zip rendering)
- `engine/README.md`

**Interfaces:**
- Consumes: Task 2.
- Produces: `validateTokens`, `substitute`, `sanitizeStem`, `folderSegments`, `NAME_TOKENS`, `SPLIT_TOKENS`, `splitPartitions`, `partitionLabel`, `renderFilenames`, `zipEntries(files)`; `exportTable` with `json_split` (zip `application/zip`, `{name}.zip`).

- [ ] **Step 1: Failing tests.**
  - `split.golden.test.ts` replays every `split_*` case.
  - `naming.test.ts`: `sanitizeStem` on 121 astral characters cuts at 120 code points, not UTF-16 units; all dots; control characters; `validateTokens` sorts unknown tokens; `substitute` leaves unknown tokens as they are.
  - `zip.test.ts`:
    - entries come back in order through `unzipSync`;
    - every entry's DOS date and time is 1980-01-01 00:00, read from the central directory bytes;
    - the same input twice gives identical bytes;
    - Node reads `TZ` only at start-up, so zone independence is checked by hand: run `zip.test.ts` once more with `TZ=Pacific/Kiritimati` and once with `TZ=America/Los_Angeles` in the environment, and report both. They are not CI tests.
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement** M5 and M6, and split in `exportTable`.
- [ ] **Step 4: See them pass;** `engine-test`, `engine-check`, `engine-tidy`, `sandbox-check`, and `sandbox-build` (it bundles the engine with its new dependency).
- [ ] **Step 5: Docs.** `engine/README.md`: naming, split, zip, `fflate` (the engine's one runtime dependency, sync API only).
- [ ] **Step 6: Commit:** `Split and zip exports in the engine`.

---

### Task 4: The xlsx writer · `critical-implementer`
*Reason: a file Excel must open, autofit arithmetic ported exactly, and cross-host byte identity (CT-7).*

**Files:**
- `engine/src/export/{xlsx,xlsx-widths}.ts`, `engine/src/export/route.ts`
- `engine/test/export/{xlsx,xlsx.golden}.test.ts`, `engine/test/export/xlsx-reader.ts`, `engine/test/golden/model-steps.ts` (xlsx rendering)
- `engine/scripts/xlsx-sample.ts` and the `xlsx-sample` npm script
- `engine/fixtures/xlsx/sample.xlsx`
- `tests/golden/test_engine_xlsx.py`
- `engine/README.md`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `buildWorkbook(model, headers, sheetName, rows, rowNumberAt): Uint8Array`, `sheetTitle(s)`; `exportTable` in format `xlsx` (the default).

- [ ] **Step 1: Failing tests.**
  - `xlsx.golden.test.ts` replays every `xlsx_*` case through the test reader.
  - `xlsx.test.ts`:
    - two builds are byte-identical;
    - `docProps/core.xml` holds no date;
    - the widths of fact 11's probe list, from a one-cell sheet without a header: `'s'` → 1.85546875 as read back, `'x' × 40` → 41, `日本語テキスト` → 9, `True` → 5.42578125;
    - the title cases.
  - `test_engine_xlsx.py`: openpyxl opens `engine/fixtures/xlsx/sample.xlsx`, and its grid (D2 reader) equals `export_bytes.json`'s `xlsx_types` record. Red until the sample exists.
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement M-xlsx.** Read xlsxwriter's `worksheet.py` (`_write_cell`, `_write_number`, `_write_col_info`, `autofit`, `_write_sheet_views`, `_write_auto_filter`), `workbook.py` (defined names) and `styles.py` for the XML each part needs. Generate the sample with `npm run xlsx-sample`. The engine test asserting the built bytes equal the committed sample goes in `xlsx.test.ts`, and its failure message names the npm script.
- [ ] **Step 4: See them pass;** `engine-test`, `engine-check`, `engine-tidy`, `pixi run -e core-dev pytest tests/golden -q`. Open the sample once with openpyxl AND with LibreOffice if `soffice` exists in the environment (`soffice --headless --convert-to csv`), and report the result. Neither is a test.
- [ ] **Step 5: Docs.** `engine/README.md`: the xlsx writer (fixed parts, xlsxwriter's dispatch and autofit, no timestamps), the sample and its two checks, `xlsx-widths.ts` generated.
- [ ] **Step 6: Commit:** `Write xlsx exports in the engine`.

---

### Task 5: Exporters and the manifest · `critical-implementer`
*Reason: the 422 order, three dedupe shapes, and the script-reach seam decide which side answers a run.*

**Files:**
- `engine/src/export/{schema,run,manifest,route}.ts`, `engine/src/evaluate/index.ts`, `engine/src/index.ts`
- `engine/test/export/{run.golden,staged,reach}.test.ts`
- `engine/README.md`

**Interfaces:**
- Consumes: Tasks 2–4; `ArtifactSet.resolve`; `sha256`.
- Produces: `readExporterDefinition`, `overriddenTable`, `runExportSteps`, `renderManifest`; `runExporter` and `runExporterDraft` in `EVALUATIONS`; the reach check `exportReachesScript(entries, resolvedTables)`.

- [ ] **Step 1: Failing tests.**
  - `run.golden.test.ts` replays every `run_*` case.
  - `reach.test.ts`: every `reach_*` case answers `501 reaches a script` with no step run. So does:
    - an exporter whose one-of-five entry has an inline transform;
    - a committed table under a STAGED navigation that gains a script step;
    - the same after unstaging, which answers 200 (Review Focus 3).
  - `staged.test.ts` replays `export_bytes`' `run_*` and `text_*` cases with the artifacts staged. It also checks a staged exporter over a staged table edit: the output holds the staged column, the manifest's `model_rev` is the committed rev, and `artifact_name` is the staged name (Review Focus 1).
  - The manifest's inline transform marker for a known code string equals Python's (compute the expected value in the test from a literal produced by `hashlib` while writing the test, and cite it as a literal).
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement M7, M8 (the two run methods) and D4.**
- [ ] **Step 4: See them pass;** `engine-test`, `engine-check`, `engine-tidy`.
- [ ] **Step 5: Docs.** `engine/README.md`: `runExporter` / `runExporterDraft` (staged exporter and tables, the manifest, reach over entries and transforms, never degraded).
- [ ] **Step 6: Commit:** `Run exporters in the engine`.

---

### Task 6: Bytes over the port · `critical-implementer`
*Reason: a change to the answer path every method shares, and the scheduler's restart semantics around a long byte-producing scan.*

**Files:**
- `engine/src/service/{service,types}.ts`
- `engine/test/service/exports.test.ts`, `engine/test/service/helpers.ts` (if `portPair` must record transfer lists)
- `architecture/contracts.md` (CT-4, CT-7)
- `engine/README.md`

**Interfaces:**
- Produces: `Call.answer(result, transfer?)`; `transferOf(result)`.

- [ ] **Step 1: Failing tests** (`exports.test.ts`, service over a link):
  - `exportTable` answers D6's shape, and the link's recorded transfer list holds exactly the result's `parts`. With a real `MessageChannel` in Node, the sender's buffers are detached (`byteLength === 0`) after the answer.
  - A non-byte method (`evaluateTable`) answers with no transfer list.
  - A staged edit posted between two slices of a running CSV export over a mid-size table restarts it; the answer equals a fresh export of the new state, and no second answer arrives (Review Focus 5).
  - `{cancel}` mid-export answers nothing, and a later call answers.
  - `date: "2026-9-1"` → 422; a missing `project` → 422.
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement D7.**
- [ ] **Step 4: See them pass;** `engine-test`, `engine-check`, `engine-tidy`, `sandbox-test`, `sandbox-check`.
- [ ] **Step 5: Docs.**
  - CT-4: `exportTable`, `previewTableJson`, `runExporter` and `runExporterDraft`; `date` / `project` params; byte results as transferred `ArrayBuffer` parts.
  - CT-7: C holds xlsx cross-host identity in Node only; E's cross-host test closes it.
  - `engine/README.md`: the answer path's transfer.
- [ ] **Step 6: Commit:** `Transfer export bytes across the port`.

---

### Task 7: The export gate and parity at M · `implementer`

**Files:** `scripts/export_large.py`, `pixi.toml`, `engine/bench/{run,parity-large}.ts`, `frontend/bench/{main,run}.ts`, `engine/README.md`.

**Interfaces:** Consumes the four methods and `EXPORT_TABLE_LIMITS`.

- [ ] **Step 1: Parity.**
  - `scripts/export_large.py` calls `routes/tables.py::export_table` on a `Session` over M, as the golden recorder calls it (reuse its `_ArtifactDb`), with `engine/bench/big-table.json` inline, in csv and in json. It writes `benchmarks/large.export.csv`, `benchmarks/large.export.json` and `benchmarks/large.export.meta.json` (`{filename, content_type, truncated}` for each).
  - `pixi.toml`: a new `engine-export-oracle` task in `engine-parity-large`'s `depends-on`.
  - `parity-large.ts` runs `exportTable` (drained, before the violation ops) for both formats, compares the concatenated parts byte for byte with the files (report the first differing offset with 80 bytes of context each side), then compares the meta.
  - Run `pixi run engine-parity-large`. Equal is expected. A mismatch is an engine bug: fix it in `src/export/` with a new `export_bytes` case reproducing it, never the oracle.
- [ ] **Step 2: Node rows** after `tableCachedPage`: `exportCsv`, `exportJson` and `exportXlsx` (each `stepped` over the drained method with a fresh `TableOrderCache`: total, longest step, bytes out, and peak `heapUsed` above the pre-call baseline, sampled per step). Also `exportCsvWarm`, with the order already cached. Run `pixi run engine-bench` once.
- [ ] **Step 3: Browser rows**, before the bad delta: `exportCsv` and `exportXlsx` timed through the worker, with a `ping` loop alongside for `exportLongestSlice`. Run `pixi run engine-bench-browser` once.
- [ ] **Step 4: Report** the medians of 3 to the orchestrator, who reports to the owner. Do NOT optimize. If an export exceeds 3 s or a step exceeds 16 ms, stop there, with the split between rows+cells and render+encode+zip.
- [ ] **Step 5: Docs.** `engine/README.md` bench and parity bullets.
- [ ] **Step 6: Commit:** `Measure exports at M and hold them to the oracle`.

---

### Task 8: Exports in the shell · `critical-implementer`
*Reason: routing, fallback marks and the shadow's comparison decide what the user downloads and what dev mode reports (Review Focus 3, 6).*

**Files:** Frontend in File Structure (all but bench, e2e and the re-page test).

**Interfaces:**
- Consumes: the four engine methods (D6).
- Produces:
  - `'exports'` surface (default `server`);
  - routed `exportTable`, `previewTableJson`, `runExporter` and `runExporterDraft` (names unchanged);
  - `ExportResult.ready {blob, filename, truncated?, fallback?}`;
  - `retryAndDownload(...) → Promise<ExportResult>`;
  - `route()`'s `digest` option; `exportDigest`; `utcDate()`.

- [ ] **Step 1: Failing tests.**
  - `surfaces.test.ts`: `SURFACES` and `SURFACE_DEFAULTS` include `exports: 'server'`; `staging: engine` does not force it; the gate is `follower.loaded()`.
  - `exports-route.test.ts` (real `EVALUATIONS` over a small fixture model through an in-process link, MSW for the server, modelled on plan 4's `api/__tests__/tables.test.ts`), with `exports` forced to `engine`:
    - each function answers a Blob whose bytes equal the engine's parts, with filename, content type and `truncated`;
    - `date` and `project` reach the engine;
    - a script table is marked `fallback: 'script'` and answered by MSW;
    - on `server`, today's behaviour, plus `truncated` from `X-Table-Truncated`.
  - `shadow.test.ts`:
    - a CSV differing by one byte is reported;
    - a zip differing in one entry's text is reported;
    - two zips with different DEFLATE bytes and equal entries are not;
    - an xlsx with different bytes is not;
    - a server `preparing` is not (Review Focus 6).
  - `export-download.test.ts`: `retryAndDownload` returns the final result.
  - `TableView.test.ts` and `ExporterTab.test.ts`:
    - the committed-state marker (`data-testid="export-fallback"`, "Exported from committed state: reaches a script") shows after a marked result;
    - `export-staged-note` shows with `exports` on `engine` and anything staged, and not on `server` or with nothing staged.
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement** M9, D12–D14, and `fflate` in the frontend (D11).
  - Check that `deps.staged()` (the shadow's skip) counts staged ARTIFACT ops, not just model ops. If it does not, make it, since a staged table would otherwise mismatch the server by design.
- [ ] **Step 4: See them pass;** `frontend-test`, `frontend-check`, `dr-tidy`.
- [ ] **Step 5: Docs.**
  - `frontend/src/lib/engine/README.md`: the `exports` surface, gate, markers, the `digest` option.
  - `frontend/README.md`: `retryAndDownload` returns its result; the staged note.
- [ ] **Step 6: Commit:** `Route exports through the engine`.

---

### Task 9: Deterministic re-page checks · `implementer`

**Files:** `frontend/src/lib/state/__tests__/table-editor-repage.test.ts` (and a test-only hook in `table-editor.svelte.ts` only if no observable signal exists).

- [ ] **Step 1: Find the timing checks:** the `sleep(700)` negatives and `≥ 299 ms` assertions. For each, name the event it really waits for (the debounce firing, the re-page settling).
- [ ] **Step 2: Replace each with an awaited signal.** A negative ("no re-page happened") awaits the debounce's settled promise, or an explicit flush of the scheduled re-page (`scheduleTablesRepage`'s timer, exposed for tests only if nothing observable exists), then asserts the count. A debounce-length check asserts ordering (no re-page before the last move's timer fired), not wall time. Fake timers stay out.
- [ ] **Step 3: Run the file 20 times** (`for i in $(seq 20); do pixi run frontend-test -- table-editor-repage || break; done`). All pass. Then run `frontend-test` and `frontend-check`.
- [ ] **Step 4: Commit:** `Wait on re-page signals instead of wall time in tests`.

---

### Task 10: e2e, the flip and the documents · `implementer`

**Files:**
- `frontend/e2e/eval-exports.spec.ts` (create)
- `frontend/src/lib/engine/surfaces.ts` (`exports: 'engine'`) and `surfaces.test.ts`
- `architecture/program.md`, `BACKLOG-ENGINE.md`
- `src/data_rover/api/README.md`, `frontend/src/lib/engine/README.md`

- [ ] **Step 1: `eval-exports.spec.ts`** (engine mode, shadow on, `exports` forced to `engine` through `dr.surfaces`, the standard fixtures, downloads captured as in `smoke.spec.ts:66-100`):
  - (a) A table's CSV export downloads, and its text equals the server's `/tables/export` bytes for the same definition, fetched through the page's API client.
  - (b) An exporter with two entries (json, csv) and a manifest downloads a zip. Its entries (unzipped in the test with `fflate`) match the paths expected, and the manifest's `model_rev` equals the committed rev.
  - (c) With a staged property edit, the table's CSV holds the staged value and `export-staged-note` is visible.
  - (d) A table with a script column exports through the server and shows `export-fallback`.
- [ ] **Step 2: Flip** `exports` to `engine` in `SURFACE_DEFAULTS` and its test.
- [ ] **Step 3: Full verification.**
  - Run `pixi run dr-test`, `pixi run dr-tidy true`, `engine-check`, `frontend-check`, `sandbox-check` and `engine-parity-large`.
  - Then run `sandbox-build` and e2e. All green is expected except T-9, with no `[shadow]` line in the output (grep).
  - Report the counts against the baseline.
- [ ] **Step 4: Docs.**
  - `program.md`:
    - C's status: plan 5 built, exports in the engine with staged artifacts, the measured numbers with date and host.
    - MR-3's text:
      - `/tables/export`, `/tables/json-preview` and `routes/exports.py` read the Python evaluator only as the `exports` surface's server path;
      - `core/table`'s exports exception lifts now that `exports` defaults to the engine;
      - `core/navigation`, `core/search`, `api/search.py` and the route functions leave the feature freeze;
      - the writers, `api/table_export*.py` and `api/export_manifest.py` froze at this plan's start and leave the feature freeze now;
      - bugs stay two-sided until F;
      - the script-table exception stays until D.
  - `BACKLOG-ENGINE.md`:
    - `K-74`: the degraded path (notice row, `#ERROR: not computed`, `degraded: true`) is unreachable in the engine until D.
    - `K-75`: `/tables/export` sends its `Content-Disposition` name unsanitized (server only, pre-existing).
    - The left-out items of D15, recorded as considered and deferred, with reasons.
  - `src/data_rover/api/README.md`: the writers are the engine's oracle; the engine path serves exports by default.
  - `frontend/src/lib/engine/README.md`: `exports` defaults to the engine.
- [ ] **Step 5: Commit:** `Serve exports from the engine and record the plan`.
- [ ] **Step 6: Owner's go-ahead** for the `engine-migration` fast-forward. The orchestrator asks; nothing is pushed there without it.

## After this plan

Plan 6 (compare, apply-CR, download, view warnings) starts from here:
- byte results cross the port as transferred parts (`transferOf`), and the download reuses `toParts`, `zip.ts` and the shadow's `digest`;
- `core/table` is out of the feature freeze except for script tables (until D).

Open from this plan: `K-74`, `K-75`. Still open: `K-65`, `K-66`, `K-68`, `K-69`, `K-70`, `K-71`, `K-72`, `K-73`, K-60's server half, `C-23`, `K-58`, `K-62`, `K-63`, `T-9`, `T-10`.
