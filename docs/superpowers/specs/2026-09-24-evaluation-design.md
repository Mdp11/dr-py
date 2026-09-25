# Evaluation (sub-project C) — design

The third piece of the client-engine program (`architecture/program.md`): every evaluation over
the model — navigation, criteria search, validation and issues, custom rules, tables, exports,
compare / apply-CR, download, view warnings, the candidate-metamodel check — moves into the
engine and reads the working copy, staged model edits and staged artifacts included. History's
two-revision Compare becomes a server range diff that loads no model. The current server stays
the oracle and the fallback (MR-1); each Python area is frozen from the start of its plan until
its surface defaults to the engine (MR-3).

Contracts this design touches: CT-4 (new methods, a refusal status, an event field), CT-5.4
(`committed: true`, first built here), CT-5.5 (the artifact family), CT-7 (export fidelity). It
implements the Commit flow's "engine validates the working copy locally" and the Browser export
flow of `architecture/system.md`, and AD-8's client-side conformance.

## Goals

- The engine holds the artifact family: committed payloads handed in by the shell, staged
  entries mirrored from the frontend's artifact buffer; every `ref` resolves against it.
- Ports, rule for rule, of `core/navigation`, `core/search`, `core/validation` (six validators,
  pipeline, dirty expansion, rules: compile, reach, evaluation), `core/table` (evaluation and
  every writer), `api/export_manifest.py`, `core/model/change_request.py` with
  `api/change_request_ops.py`, `core/view/validation.py`, the save writer of `api/serialize.py`.
- One live issue store over the working copy: background sweep, incremental per transition,
  origins on demand; the Issues panel and the model half of the commit preview served locally.
- Tables and exports within the CN-3 table budget at M; exports faithful per CT-7, with an
  xlsx writer and zip of our own over `fflate`.
- Nine surface switches, each defaulting to the engine once its shadow is clean.
- `GET /commits/diff?from&to`: History's Compare with no model loaded.

## Non-goals

- Scripts in the browser (D). Before D a call whose definition reaches a script goes to the
  server whole (decision 2); `previewTransform`, `fetchScriptErrors` and `runSnippet` stay
  server calls.
- Server-side strict enforcement and the server's `validation_error_count` stay until F
  (AD-8's switch-over is F's, with the thin server).
- The artifact and view half of the commit preview (kind-adapter and view dry-validation) stays
  a server call until F.
- `POST /model/save` (no caller), `POST /model/validate`'s `inline` branch, `GET
  /exports/run-by-name` (E).
- The structural metamodel diff (`diff_metamodels`): it reads no model and stays a server route.
- A streaming reader of the save format (only if compare at M misses its heap; see Known limits).
- Optimizing anything that meets its budget.

## Decisions taken with the owner (2026-09-24)

1. **The frontend owns the staged artifact buffer; the engine mirrors it.** `artifact-edits`
   stays the owner and checkout is unchanged. The engine's artifact layer is committed payloads
   plus a staged overlay — no rewind or replay: an artifact entry replaces its payload whole
   and interacts with no model op, and payload checks (kind adapters) stay on the server.
   Rejected: the engine owning it (a second store fork, no correctness gained), the caller
   sending the artifact closure per call (the resolver duplicated in the frontend).
2. **Before D, a call that reaches a script routes whole to the server.** The engine resolves
   the definition and runs its `*_has_script`; if true it refuses with 501 and `route()` sends
   the call to the server, which behaves exactly as today (committed state, `pending` cells,
   202s, polling). The UI marks such tables. Rejected: forwarding script calls through the shell
   (one table would mix committed and working state; a bridge D throws away), placeholder cells
   (a regression).
3. **One live issue store in the engine, over the working copy.** Background sweep once
   `ready`, incremental revalidation inside every transition, origins by a rewind probe; the
   panel reads it live. Validate becomes "re-sweep now". Rejected: engine overlay on server
   issues (two sources joined in the UI), validation on demand only (no full list).
4. **Rules reach the engine as validated JSON, parsed by the server.** AD-22's rule extended to
   rules: YAML, the grammar and its caps stay on the server; the engine ports compile, reach and
   evaluation. Rejected: a YAML parser in the engine (PyYAML 1.1 quirks, a second grammar), a
   server compile (per candidate metamodel).
5. **Our own xlsx writer plus `fflate` (synchronous API only) for deflate and zip.** Rejected:
   ExcelJS (heavy, Node-stream polyfills, wall-clock zip stamps), SheetJS CE (no cell styles,
   stale npm release), host `CompressionStream` (async, host-dependent bytes).
6. **History's Compare is a server range diff composed from the journal's `entity_states`.**
   O(entities touched in the range); the engine is not involved. Rejected: the engine rewinding
   its replica from before-images (same data, more work), leaving it for F.
7. **Compare and apply-CR read the working copy; download reads committed state.** Apply-CR's
   ops are staged on top of the working copy, so its conflicts are checked there; download stays
   byte-identical to `GET /model/download`.
8. **Eight plans** (§11), in the order: artifacts + navigation + criteria search, validation
   core, rules, tables, exports, compare/apply-CR/download/view warnings, metamodel candidate,
   history range diff.

Settled without a choice: **`C-20` is unobservable.** `check_metamodel`
(`core/metamodel/check.py:124-135`) refuses a property that redeclares an ancestor's, and the
engine only receives validated metamodels (AD-22), so ancestor-wins and closer-wins never
disagree. The code and the engine's mirror stay; the comment at `core/metamodel/schema.py:203`
is reworded (no behaviour change, MR-3 holds); `C-20` closes.

## 1. The artifact family

### Engine — `engine/src/artifacts/`

- `ArtifactSet`: committed artifacts `{id, kind, name, payload, artifact_rev}` by id, and a
  staged overlay, one entry per id: `{op: 'create', kind, name, payload}` (under its `tmp_` id),
  `{op: 'update', name?, payload?}`, `{op: 'delete'}` — the shapes
  `artifact-edits.svelte.ts` keeps.
- `resolve(id)` answers the working view: a staged entry wins, a staged delete hides the
  committed artifact, a `tmp_` id resolves to its staged create. `resolve(id, {committed:
  true})` reads the committed layer alone. An unresolved ref stays tolerantly dangling, as on
  the server (a dangling snippet ref degrades to an error cell).
- A `validation_rules` artifact carries `rules`, the server's parse of its YAML (the body of
  `POST /rules/parse`, `{ok, document, errors}`): `document` is the rule set as JSON TEXT, which
  the shell never parses and the engine reads with its exact parser; the engine never reads the
  YAML. A committed one carries `RulesParse | null`, a staged create or update with a payload
  `RulesParse | 'pending'`. *(Settled in plan 3, D6–D7.)*
- `artifacts_version` moves to plan 4, which needs it to stamp the table order cache (§4). Plan 3
  does not add it: only rules reach the issue store, and a table edit must not re-probe; the
  rules compile has its own stamp, `rules_version` (§3 "Origins").

### Wire — CT-4 additions

All three are context methods (`now`), like the view placements: answered at once in any
state, never queued in the model lane. The shell keeps what it sent and sends it again to
every new worker, before any held read. This is sound because every evaluation resolves its
whole artifact closure before its first step, so a later change cannot reach a scan in
flight; a read asked after one of them is posted after it on the same port and sees it. They
change no model entity and never touch the digest check. (Plan 1 settled this against an
earlier draft that made them model-lane transitions.)

- `setArtifacts {artifacts}` — the whole committed set. Sent at open and to every new worker,
  before any held read; the engine keeps it across `close` and `open`.
- `putArtifacts {changed, deleted_ids, staged?}` — committed changes after an artifact feed
  event or an own commit's response; `staged`, when present, replaces the staged overlay in the
  same call, so an artifact the commit landed is never missing between "staged cleared" and
  "committed installed".
- `setStagedArtifacts {entries}` — the full staged buffer, after every change to it (small; no
  diff protocol).
- A call that changes the effective rule set (a rules artifact staged, committed or deleted)
  recompiles in place and schedules the revalidation of the affected population as a
  background scan (§3). The three methods stay `now` (plan 3, D9): a `now` method never
  interleaves with a transition, and every sweep or rescan step reads the compile afresh.

### Server

- `GET /artifacts/payloads` (read-only, viewer-callable): every artifact of the project with
  its payload and `artifact_rev`; each item carries `rules` — the parse of a `validation_rules`
  row's YAML, `null` for any other kind.
- `POST /rules/parse {yaml}` → `{ok, document, errors}`, `document` the rule set as text (§3).

### Shell and store

- `frontend/src/lib/engine/artifacts.ts` keeps the committed set, re-sends it to every new link
  before any held read (as view placements are), and follows artifact feed events and own
  commit responses by `artifact_rev`, fetching only what moved.
- `artifact-edits.svelte.ts` stays the owner; one subscriber pushes `setStagedArtifacts` on
  every change. A staged rules entry is parsed through `/rules/parse` before it is pushed; until
  it has been, it is pushed with `rules: 'pending'` and the rule set keeps the last parse the
  engine received for it (a create with none contributes nothing yet).
- Editor drafts that are not staged still go inline as `definition`, as today.
- Checkout, `id_map` handling and `clearStagedArtifacts` are unchanged; the post-commit clear
  reaches the engine through `putArtifacts {…, staged}`.

## 2. Evaluation layer, surfaces, the script seam, shadow

### Engine layout

One directory per ported area, each a port of its Python package rule for rule, Python names in
camelCase: `src/navigation/`, `src/search/`, `src/validation/`, `src/rules/`, `src/table/`,
`src/export/`, `src/cr/`, `src/view/`. `src/read/` gains the new `READS` entries; the service's
method table gains the new kinds.

- Every whole-model operation exists once, as a `Steps` generator, run as a `scan`: a
  navigation over an untyped scope, row build, sort, the export render, the validation sweep,
  the candidate validation, compare, the committed download.
- A method answers the Python route's HTTP response body, as B's reads do.
- Byte results cross as transferred `ArrayBuffer`s (CT-4).

### Surfaces and switches (MR-1)

Nine, added to `SURFACES` / `SURFACE_DEFAULTS`, each defaulting to `engine` in the plan that
makes its shadow clean:

| Switch | `lib/api` functions | Plan |
|---|---|---|
| `navigation` | `evaluateNavigation` | 1 |
| `criteria` | `searchModel` | 1 |
| `issues` | `getModelIssues`, `validateModel`, `previewCommit` (model half) | 2 |
| `tables` | `evaluateTable` | 4 |
| `exports` | `exportTable`, `previewTableJson`, `runExporter`, `runExporterDraft` | 5 |
| `compare` | `compareModel`, `proposeCr` | 6 |
| `download` | `downloadModel` | 6 |
| `views` | view warnings (`validateView`) | 6 |
| `metamodel` | `diffMetamodel` (model half) | 7 |

The commit stays a server POST.

### The script seam (decision 2)

- Before evaluating, the engine resolves the definition through the `ArtifactSet` and runs its
  ports of `table_has_script` / `navigation_has_script` (and, for an exporter, over every entry
  and its transform).
- True → the engine answers `{status: 501, detail: 'reaches a script'}`. `route()` treats 501
  like `gone`: the server answers, from committed state, with today's behaviour. A result so
  served is marked by `route()`'s `mark` option, not by either side's schema: plan 1 adds
  `fallback: 'script' | 'pattern'` to the page rather than `source: 'server'`, since a criterion
  pattern the regex translator cannot vouch for (`reaches an unsupported pattern`) falls back
  the same way; the navigation results dock renders it as a small marker ("Reads committed
  state: …"), and the table editor and the exporter tab follow in their plans.
- D deletes the refusal, the 501 branch and the marker together.

### Shadow (MR-2)

- As in B, nothing is compared while the model OR the artifact buffer holds a staged entry —
  the server would be answering another question.
- Structured answers (navigation, criteria, table pages, compare, apply-CR) compare as B's do.
  Issues compare as a multiset keyed `(severity, category, check, message, target_ids)`, and
  only once the engine's sweep is complete.
- `previewCommit`'s model half is the exception: the server can answer with staged model ops,
  so it is compared WITH them (`would_block`, counts, the issue multiset).
- Exports: JSON, JSONL, CSV and `manifest.json` compare byte for byte; zips by entry list. xlsx
  is skipped in dev shadow; fixtures and e2e cover it.
- 501-refused calls are never compared (the server alone answers).

## 3. Validation, issues, rules

### Port — `src/validation/`

- The six validators in the pipeline's order (`type_conformance`, `multiplicity`, `facets`,
  `endpoint_typing`, `containment`, `uniqueness`), their per-type memos keyed to the metamodel
  instance, `Scope` (full and scoped runs, ids walked in insertion order, unknown ids skipped),
  `validate_global`, `_stamped`.
- `Issue {severity, message, target_ids, category, check}`; messages built with `pyRepr` where
  Python formats `{x!r}`; STRUCTURAL only for dangling references and containment, as today.
- `DirtyCollector`'s expansion per mutation kind, fed by the working copy's change sets
  (before/after images are what the rules need); `change_request_dirty_ids` is not needed
  (apply-CR stages ordinary ops).

### The store

- `IssueStore`: issues by owner (`target_ids[0]`), `replace(dirty, new)`, `set_full`, counts —
  `ValidationState`'s operations.
- **Sweep.** Once the replica is `ready`, a background task validates an id snapshot (elements,
  then relationships) in steps sized to the 8 ms slice. It is RESUMABLE, not restarted: each
  step looks its ids up afresh and skips deleted ones; entities created meanwhile are covered by
  the transition that created them. The scheduler gains a resumable background kind beside the
  restartable one the digest check uses. Until the sweep completes the store reports `progress
  {task: 'sweep', done, total}`.
- **Incremental.** Every transition — stage, unstage, delta, rebase, adopt — validates its
  expanded dirty set, scoped, before it answers: O(batch), inside the transition budget (AD-23).
  A delta's rebase validates the union of the delta's and the staged batches' dirty sets.
- **Event.** The open journey is unchanged (D12): the workspace still opens at `ready` (AD-25),
  and the sweep's `progress` feeds the `issues` surface's gate, not `/model/status`'s progress
  bar — the gate alone covers the seeding gap between `ready` and the sweep's end. `changed`
  gains `issues_version`, moved whenever the store changes (also by the sweep, at most once per
  slice). The model store's shared half re-reads `getModelIssues` from the engine when it moves;
  in engine mode the server refetch triggers (`scheduleIssuesRefetch`, the open-progress
  refetch) stand down.

### Origins

- S = the dirty expansion of every id the staged batches touch (rule reach included). Outside S
  committed and working issues are equal by construction.
- The *origin probe* is a transition: rewind the staged batches, validate S on committed state,
  replay, emit no `changed`, leave the state exactly as it was (entity lines, index dump,
  digest — a test holds it). O(staged).
- Cached per `(rev, staged_version, rules_version)` — `rules_version` moves whenever the
  working or the committed compile changes; `artifacts_version` is not part of the key, since
  only rules reach the store and a table edit must not re-probe (plan 3, D10). Requested lazily
  by the issues read and the preview, never per keystroke.
- Tags as today: `uncommitted` (working only), `resolved` (committed only), `on_server` (both).

### Surface `issues`

- `getModelIssues` → `IssueListOut` over the working copy, origins included, the 5,000 cap,
  `truncated` and `rules_status` as today; `model_rev` is the committed `rev`.
- `validateModel` (no `inline`) → re-sweep from scratch; answers when the sweep completes, with
  the list `POST /model/validate` answers today.
- `previewCommit` splits: the engine answers the model half — conformance count, structural
  blockers from the validators, issues all tagged `on_server` (D7: the preview is the oracle,
  so it is never `uncommitted` or `resolved`), `would_block` = strict flag ∧ non-empty
  `attributable_issues(conformance, S)`. If artifact or view ops are staged, the server's
  preview still runs with THOSE ops only, and the two halves are merged (blockers concatenated).
  A staged `metamodel.rebind` sends the whole preview to the server until plan 7.
- Strict mode stays server-enforced at commit; shadow holds the engine's `would_block` to the
  server's.

### Rules — `src/rules/`

- **Server:** `POST /rules/parse {yaml}` → `{ok, document | errors}` — lint's parser and caps
  (64 KiB, 200 rules, depth 8, no aliases, unique names), `document` = the normalized rule set
  as a STRING: `json.dumps(defn.model_dump(mode="python", by_alias=True, exclude_unset=True),
  ensure_ascii=False, separators=(",", ":"))`, `null` when `ok` is false (plan 3, D6 —
  `model_dump(mode="json")` writes `in_` / `not_` and every unset test as `null`, and does not
  re-validate); reads no model; the lint route's 403 for viewers. `GET /artifacts/payloads`
  carries the same parse in `rules`.
- **Compile:** disabled rules dropped; the drift check against the metamodel (a skipped rule →
  `rules_status.skipped` `{artifact_id, set_name, rule, reason}`); `applies_types` =
  `element_descendants(applies_to)`; `check` = `rule:<name>`; `rules_by_type` dispatch.
- **Reach:** `derive_paths`, `expand_scope` (backwards through adjacency, no far-type filter,
  kept where the type is in `applies_types`), joined to the dirty expansion.
- **Evaluation:** every semantic of `validator.py` — `_eq` keeps `True ≠ 1`, a missing value
  (None or `[]`) fails every test but `exists`, a list matches if any item does, `contains` on a
  list is membership, relationship atoms count over type descendants with `to` and a recursive
  `where`, a dangling far end is skipped; exceptions count `eval_errors`, merged once per run.
- **A rule set change** recompiles inside the artifact method (a `now` method); revalidating
  `applies_population(old ∪ new)` is a background scan. The issue reads (`getModelIssues`,
  `validateModel`, `previewCommit`) wait for it to end, so there is no `rules_status.applying`
  field (plan 3, D2).
- **The preview uses the committed rules**, as the server's preview does: a staged rule set
  shows in the Issues panel and in Validate, not in the preview (plan 3, D1; the server's gap is
  `K-65`).
- Rule issues are always attributable in strict mode, as `attributable_issues` has it.

## 4. Tables — `src/table/`

- Port: resolve (refs through the `ArtifactSet`), `resolve_source_elements`, `build_rows_ex`,
  `order_rows` and `sort_keys`, `evaluate_cells` and the six cell kinds, `NavMemo` (per pass,
  LRU 64, bypassed by a scripted navigation), `TableLimits` (50k rows, 20 elements per cell),
  virtual properties, `cell_text`.
- An inline `definition` gets a shape check refusing with 422 in the engine's own words (the
  server's texts are pydantic's, which no fixture can hold), as B's `ReadError` does.
- **Paging.** The first page runs build + sort as one scan and stores the order in an engine
  `TableOrderCache`: 16 entries, keyed by the canonical text of the resolved definition,
  stamped `(rev, staged_version, artifacts_version)`, evicted when the stamp moves; stored only
  when nothing errored, as today. Later pages are O(page).
- **Staged edits.** The table store re-pages open tables on `changed` (and on an artifact
  mirror change), debounced 300 ms, cancelling the superseded scan (CT-4 `cancel`): a large
  table rebuilds when the user pauses, never per keystroke, and never delays the caret.
- `evaluateTable` for a script table answers 501 (§2); `fetchScriptErrors` stays a server call.
- **Budget gate:** CN-3's 112k-row table at M — build, sort and every cell ≤ 3 s — in
  `engine-bench` and `engine-bench-browser`, with the longest step against the 16 ms chunk. The
  bench input is a table definition over `large.model.json` shaped like CN-4's spike row
  (generated by `engine-bench-data`).

## 5. Exports — `src/export/`

- **CSV:** the excel dialect, UTF-8, no BOM, no formula escaping, `cell_text` shared with xlsx.
- **JSON / JSONL:** `render_json_ex` with its column options (key, item_key, value mode
  name/id/object, group, single), `{"$error": …}` cells, `shape_json_docs` (array, or object
  keyed by a column), pretty or compact through `pyDumps` (`indent=2` added to it, CT-7).
- **xlsx:** our own writer, fixed XML parts, one sheet: title sanitized to 31 characters; header
  bold, border 1, bottom 2; data cells border 1; `freeze_panes(1,0)`; autofilter over the data;
  autofit ported from xlsxwriter (its width table, the `xlsx_autofit_max_px` cap); the
  row-number column as numbers, everything else as strings; the trailing notice row after
  autofit, outside the filter. No formulas, no hyperlinks.
- **Zip:** `fflate` synchronous DEFLATE (its async API spawns blob workers, which the CSP
  refuses), entries dated 1980-01-01, in the server's order; `zip` or `bare`, `bare` with more
  than one file a 422.
- **Split and naming:** bucketing by `RowKey` slot 0; `validate_tokens`, `substitute`,
  `sanitize_stem` (120), `folder_segments`, `_2`/`_3` dedupe; exporter paths deduped as
  `_dedupe_path`.
- **Manifest:** `manifest_version: 1`, `indent=2`, no wall clock, transform as an id or
  `inline:<sha12>` (the engine's SHA-256).
- **Context the engine cannot know:** `${date}` (the run's UTC date) and `${project}` arrive as
  params (`date: "YYYYMMDD"`, `project`) — no clock in the engine (RC-5), and E's request will
  carry them the same way. `${rev}` is the replica's committed `rev`.
- **Methods:** `exportTable`, `runExporter`, `runExporterDraft` → `{parts: ArrayBuffer[],
  filename, content_type, truncated, script_errors: 0}`, which the `lib/api` function turns into
  the result it builds from today's response (the `X-Table-*` headers become fields); the UI's
  download helper makes the Blob. `previewTableJson` → `{sample, truncated}` over the first 200
  rows. No 202 and no `retryAndDownload` loop in engine mode.
- An exporter's tables resolve through the `ArtifactSet`, so staged tables are used — today only
  the exporter draft itself is live.

## 6. Compare, apply-CR, download, view warnings, metamodel candidate, history

### Compare and apply-CR — `src/cr/` (working copy, decision 7)

- **Compare:** the uploaded file crosses as a transferred `ArrayBuffer`, is parsed with the
  exact parser (bare `Infinity`/`NaN` literals as strings, as `parse_model_json`), checked with
  `build_model_from_dicts(strict=False)`'s refusals (422, its texts), and kept as plain per-id
  maps — no second `Model`, no indexes. `diff_models(workingCopy, other)`: identity by id,
  matching on type, properties (Python equality) and ends, `rev` ignored; added and modified in
  the file's order, deleted in the working copy's state order. → `CompareResponse`, `model_rev`
  the committed `rev`, the `datarover.cr/v1` document as `_changes_out` writes it.
- **Apply-CR:** the CRs in turn over an overlay of the entities they name, incident
  relationships read from the working copy — O(CR + incident), not a model copy per CR. Phase A
  collects every conflict (`id_exists`, `missing`, `before_mismatch`) → 409 `{cr_index,
  conflicts, model_rev}`; `_gate_cr_result`'s 422s; `UnsupportedChangeError` → 422;
  `ops_for_change`'s seven-step order with id hints and `tmp_` ids, a rewire as delete + create
  under the same id. `stageProposedOps` stays as B left it.

### Download (committed, decision 7)

- `committed: true`, first built: a committed iteration in state order — staged-touched
  entities read from their committed images, staged creates left out, staged deletes put back
  at their `ord`. A read-only addition to `WorkingCopy`; no applier behaviour changes.
- The save JSON, `indent=2`, byte-equal to `GET /model/download`; a scan answering 4 MiB
  `ArrayBuffer` parts.

### View warnings — `src/view/`

- `validateView {view}`: a port of `validate_view` over the view document the view store holds
  NOW (staged view ops applied, as `_view` already is); known artifact ids from the working
  `ArtifactSet`. Called after a view load and after each staged view op, debounced; in engine
  mode `GET /views/{id}`'s `warnings` are ignored. Staged views get warnings for the first time.

### Metamodel candidate — plan 7

- **Server:** `POST /metamodel/lint` answers, when `ok`, the validated candidate as the
  `GET /metamodel` document. `POST /metamodel/diff` keeps its structural half
  (`diff_metamodels`) and its server-path shape.
- **Engine:** `candidateIssues {metamodel}` builds the candidate `Metamodel`, compiles the rule
  set under it (drift re-checked), and derives the metamodel-dependent index views for it —
  uniqueness groups under its key specs, containment parents under its containment flags;
  by-type and adjacency are shared — then validates the whole working copy as a scan and diffs
  against the live store by `(category, severity, check, message, sorted target_ids)` (the diff
  route's key): `now_failing`, `now_passing`, `unchanged_count`, `current_error_count`,
  `candidate_error_count`. `diffMetamodel` in engine mode joins the server's structural half
  with this.
- In the local preview, a staged `metamodel.rebind` takes this path: `would_block` false
  (rebinds are exempt), structural blockers from the candidate's validators.
- **Gate at M:** total, longest step, extra heap of the candidate index views.

### History range diff — plan 8 (server only)

- `GET /commits/diff?from=a&to=b`: fold the `entity_states` of the commits in (a, b] — per
  entity the before-state at its first touch and the after-state at its last; entities created
  and deleted inside the range drop out. O(entities touched).
- Any row in range without `entity_states` (old rows, batches over 5,000) → today's two
  reconstructions.
- `HistoryDrawer` maps the answer to the shape `computeDiff` gives today; the two
  `GET /commits/{rev}/model` fetches leave the drawer.
- A Python test holds the fold equal to a diff of two reconstructions over randomized
  histories.

## 7. Oracle, fixtures, tests, benchmarks

### Golden families

Generated by the oracle through `pixi run golden-fixtures`; on a mismatch fix the engine; kept
current by `test_fixtures_current.py`. Where a route function is the unit, the family calls it on
a `Session` with every argument passed, as B's `read` steps do, so the fixture holds the body
and its key order.

| Plan | Families |
|---|---|
| 1 | `nav_eval` (definitions × row elements × paging, limits, warnings); `search_criteria` (criteria × targets); `artifact_refs` (the resolvers over a dict-backed fetch, dangling refs included); `script_reach` |
| 2 | `validation_kinds` (every violation kind, `test_pipeline_differential`'s cases, full and scoped); `validation_dirty` (expansion per mutation kind); `validation_steps` — the `model_steps` recorder records, after every batch, the session's store as `_finalize` leaves it, and `/commits/preview` bodies with staged ops |
| 3 | `rules_compile` (drift, diagnostics); `rules_eval`; `rules_reach`; rules in `validation_steps` |
| 4 | `table_eval` (pages, sort, cells, limits, truncation, warnings) |
| 5 | `export_bytes` (CSV, JSON, JSONL, manifest as exact text; xlsx as the openpyxl cell grid + widths + pane; zips as entry lists) |
| 6 | `cr_compare`, `cr_apply` (conflicts, gates), `model_download`, `view_warnings` |
| 7 | `metamodel_candidate` |

- The engine's incremental store is held to PYTHON'S incremental store, not to a full
  revalidation: they may differ legitimately (a cycle's representative issue goes stale,
  `dirty.py:61-68`), and the engine mirrors the oracle.
- **Large-model parity** under `benchmarks/`, generated locally, never committed (RC-13): the
  sweep at M as an issue multiset, the 112k-row table's cells, one export.
  `pixi run engine-parity-large` compares engine and oracle; run per plan before approval, not
  in CI.

### Tests

- **Engine** (real engine, small fixture models, RC-14): the resumable sweep across transitions;
  the origin probe leaves no trace; 501 refusals; the artifact overlay (`tmp_` creates, deletes
  hiding committed payloads); cancelled table scans; seeded invariants — random
  stage/unstage/delta sequences keep the incremental store equal to the oracle-shaped result.
- **Python:** `/rules/parse`, `/artifacts/payloads`, the lint route's candidate document, the
  range diff (fold vs reconstructions), each with the `client` fixture.
- **Frontend** (vitest, in-process engine, MSW for server paths): the artifact mirror's order (a
  read after `stageArtifactUpdate` sees it); the panel fed by `changed`; debounced re-paging;
  downloads from `ArrayBuffer` parts; the `source: 'server'` marker; the split preview.
- **e2e** in engine mode with shadow on, plus: a staged edit's issue appears live and Discard
  removes it; a table over a STAGED navigation shows the staged rows before any commit; an
  export downloads and its bytes are checked; a script table shows the marker and its
  server-sourced pending cells; compare then apply-CR stages ops on top of a staged edit.

### Benchmark gates

Node and browser, medians of 3 in one pass (CN-5), reported to the owner before anything is
optimized: the sweep at M; the 112k-row table ≤ 3 s; the origin probe and the incremental
revalidation within the transition budget; the candidate validation and its heap; compare's
heap; the download at M.

## 8. Freeze (MR-3)

Each area freezes when its plan starts and leaves the freeze for features when its surface
defaults to the engine; a bug lands on both sides with a fixture until F.

| Plan | Frozen |
|---|---|
| 1 | `core/navigation`, `core/search`, `api/search.py`, `core/table/resolve.py` (ref resolution and script reach) |
| 2 | `core/validation` minus `rules/`, `api/validation_sweep.py`, the preview's conformance half |
| 3 | `core/validation/rules`, `api/rules.py` |
| 4 | `core/table` evaluation (`evaluate`, `cells`, `nav_memo`, `virtual_props`, `cell_text`, `schema`; `script_inputs` is not ported — script columns route to the server) |
| 5 | `core/table` writers (`csv_export`, `json_export`, `export_layout`, `exporter`, `naming`, `split`), `api/table_export*.py`, `api/export_manifest.py` |
| 6 | `core/model/change_request.py`, `api/change_request_ops.py`, `api/serialize.py`'s save writer, `core/view/validation.py` |
| 7 | the diff route's model half, `build_rebind_view` (`diff_metamodels` stays server-only, not frozen) |

`core/model`, `core/metamodel` and the model-op applier stay frozen throughout.

## 9. Changes to `architecture/` and the backlog

Each in the commit of the code it describes (RC-10).

- **CT-4:** the artifact methods; `getModelIssues` / `validateModel` / `previewCommit` /
  `candidateIssues` / `validateView` / export / compare / download methods; the 501 `reaches a
  script` refusal; `issues_version` on `changed`; `date` and `project` export params; byte
  results as `ArrayBuffer` parts.
- **CT-5:** item 4 built; item 5 — the artifact family is the committed payloads the shell
  hands in plus the staged entries mirrored from the frontend's buffer.
- **CT-7:** C holds xlsx cross-host identity in Node only; E's cross-host test closes it.
- **New ADs:** rules reach the engine as validated JSON (AD-22 extended); the staged artifact
  buffer stays in the frontend and the engine mirrors it; before D a call that reaches a script
  routes whole to the server; one live issue store over the working copy, origins by rewind
  probe.
- **`system.md`:** Current → target gains the history range diff (server) and rules parse
  (server).
- **`program.md`:** C's scope (history as a server range diff), its eight plans, status.
- **`BACKLOG-ENGINE.md`:** `C-20` closes; new items — F needs `entity_states` on every journal
  row; a streaming save-format reader if compare at M misses its heap; on the server path an
  artifact-only commit that changes a referenced navigation does not re-page an open table
  (engine mode fixes it: the stamp moves).
- **READMEs:** `engine/README.md` for each new directory; `frontend/src/lib/engine/README.md`
  for the artifact shell and the new surfaces; `src/data_rover/api/README.md` for the new
  routes; `CLAUDE.md` only if a command changes (`engine-parity-large`).

## 10. Risks

- **Sweep at M.** 11 s under Pyodide (CN-4); the engine is *estimated* at 1–2 s spread over
  slices. Measured in plan 2 before approval.
- **Table budget.** 112k rows with navigations per cell; the spike's bare replica did it in
  0.3 s, the engine carries NavMemo, cell kinds and exact values. Measured in plan 4.
- **Compare heap.** The parsed file (*estimated* 150–250 MB transient) beside the 115 MB
  replica, against CN-3's 400 MB.
- **Transition budget.** Incremental revalidation and the origin probe add to stage/unstage/
  delta; K-32's re-sort already takes most of an unstage's 100 ms at M in Node.

## 11. Plans

Eight, written one at a time, each pre-verified in a scratch clone and leaving the branch green;
each flips its switch once its shadow is clean.

1. **Artifacts, navigation, criteria search** — §1, §2 (seam, switches, shadow), `src/navigation/`,
   `src/search/`; surfaces `navigation`, `criteria`.
2. **Validation core** — §3 minus rules; surface `issues`; the sweep gate.
3. **Rules** — §3's rules; `/rules/parse`, payloads' `document`.
4. **Tables** — §4; surface `tables`; the table gate.
5. **Exports** — §5; surface `exports`.
6. **Compare, apply-CR, download, view warnings** — §6; surfaces `compare`, `download`, `views`.
7. **Metamodel candidate** — §6; surface `metamodel`; the rebind preview local.
8. **History range diff** — §6; server only; independent, may run in parallel.

## 12. Done when

- `navigation`, `criteria`, `issues`, `tables`, `exports`, `compare`, `download`, `views` and
  `metamodel` default to the engine with shadow clean in e2e; the server path works behind each
  switch.
- Evaluation sees staged model edits and staged artifacts.
- CN-3's table budget is met at M in Chromium; the sweep and candidate gates are reported.
- The export families pass per CT-7.
- The drawer's Compare is served by the range diff.
- `dr-test` and `dr-tidy` are green; `architecture/`, the READMEs and the backlog say what is
  now true.

## Known limits

- Until D, script-reaching tables, navigations and exports read committed state, from the
  server, behind the marker.
- The preview's artifact and view half stays a server call; the server enforces strict mode and
  computes `validation_error_count` until F.
- Compare's heap at M is unproven (§10).
- The range diff falls back to reconstruction for rows without `entity_states`.
- B's open items (`K-41`, `K-42`, `K-45`…`K-48`) are untouched by C.
