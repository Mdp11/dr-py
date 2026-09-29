# Evaluation, plan 6: compare, apply-CR, download, view warnings — design

Refines §6 "Compare and apply-CR", "Download" and "View warnings" of
`2026-09-24-evaluation-design.md` (the binding program-level spec for C) for its sixth plan.
Where this document is silent, that spec holds. Approved in conversation with the owner on
2026-09-29. Plan 6 is built as two plans from this one spec: **6a** (download, view warnings)
and **6b** (compare, apply-CR). They share no code; 6a lands first.

## Goal

The model download, a view's warnings, and the Compare/Change-request dialog's compare and
apply-CR are answered by the replica, each behind its own surface switch (`download`, `views`,
`compare`) with the server as fallback (MR-1) and the dev shadow clean in e2e (MR-2). Download
reads committed state and stays byte-identical to `GET /model/download`; view warnings, compare
and apply-CR read the working copy, staged model edits and staged artifacts included (decision
7). Compare's parse, its heap at M and download's scan are measured and reported to the owner
before anything is optimized.

## Non-goals

- Plan 8 (history range diff).
- The frontend's placement winner order (`elementHomeFolderId`), which differs from
  `validate_view`'s: logged as `K-88`, not changed.
- Matching the server's failures that are not answers: CPython's JSON error texts, its 500s on
  over-4,300-digit integers or deep nesting, the mid-stream break of a download that holds a
  lone surrogate.
- Checking a CR's endpoint-mapping legality or property keys before staging: the applier and
  the commit preview do that, as today.
- Optimizing anything before the owner has seen the numbers.

## What the code says today

- **`GET /model/download`** (`api/routes/model.py:349`): `iter_model_json(session.model)`
  (`api/serialize.py:102`) — committed state; `{"elements": [...], "relationships": [...]}`
  only; entities in dict order, elements `id, type_name, properties, rev`, relationships `id,
  type_name, source_id, target_id, properties, rev`; each entity `json.dumps(indent=2,
  ensure_ascii=False, allow_nan=False)` re-indented by four spaces, framed as a whole-document
  `indent=2` dump, no trailing newline. `application/json`, `attachment; filename="model.json"`.
  The UI (`TopBar.svelte` `onExport`) ignores the header and names the file itself.
- **`validate_view(view, model, known_artifact_ids)`** (`core/view/validation.py`): one pass,
  six `WARNING`s with `check="view"`, category `conformance`: A unknown artifact (`[]`), B
  duplicate child folder (`[]`), C unknown element (`[id]`), D element with a containment parent
  (`[id]`), E element in several folders (`[id]`), F duplicate top-level folder (`[]`), every
  quoted value `!r`. Order: per top-level folder F or `visit`; `visit` = the folder's artifact
  refs, then each child folder (B, or recurse), then its own elements, each C, D, E stopping at
  the first that fires; root artifact refs last. A skipped folder's subtree yields nothing. No
  dedup; `placed` is view-wide and only C/D-passing elements join it. Served by `GET
  /views/{id}` alone, over the committed view, model and artifact ids. The view store replays
  staged view ops on the committed document but shows the committed warnings, refetched only on
  a view change — a model-only or artifact-only commit leaves them stale.
- **`POST /model/compare`** (`api/routes/change_request.py:215`): the raw file, 512 MiB cap
  (413), `parse_model_json` (bare `NaN`/`Infinity`/`-Infinity` kept as strings; a decode or
  JSON error is 422 `Request body is not valid JSON: …`), `build_model_from_dicts(strict=False)`
  (a full second `Model`), `diff_models(session.model, other)` — committed state; added and
  modified in the file's order, deleted in the session's order, elements first, `rev` ignored,
  equality Python `==`. `CompareResponse {model_rev, cr, other_element_count,
  other_relationship_count}`, `cr` the `datarover.cr/v1` document (`_changes_out`) with a
  wall-clock `createdAt`. Viewers may call it. Serialized by pydantic: a non-finite float is
  `null`.
- **`POST /model/apply-cr`** (`routes/change_request.py:180`): 1–20 CRs over committed state.
  Per CR, `apply_change_request` checks every conflict (six buckets: elements added `id_exists`,
  modified and deleted `missing`/`before_mismatch`, then relationships the same) against the
  model before that CR and, if any, answers 409 `{cr_index, conflicts, model_rev}` (no `detail`);
  otherwise copies the whole model and applies the CR. Then `diff_models(base, current)`,
  `_gate_cr_result` (first error only), `ops_for_change` (`UnsupportedChangeError` → 422). The
  server changes nothing. A duplicate id in one CR's `deleted` list raises `KeyError` → 404
  `{"error": id}` (a bug).
- **Frontend:** `ModelChangeDialog.svelte` allows Preview while edits are staged and disables
  Replace (its ops were computed on committed state and would double-apply);
  `stageProposedOps` (`state/stage-proposed.ts`) remaps temp ids, seeds the prestate from the
  CR's `before` images, takes locks and stages one batch.
- **Engine:** no committed iterator in state order (`WorkingCopy` keeps first before-images per
  touched id in `committedElements`/`committedRelationships`, `null` for a staged create); no
  view documents (only `ViewPlacements`); no Python `==` (`pyKey` equates a dict with its pair
  list; `pyRuleEq` separates bool from int); `parseExact` keeps bare constants as strings but
  accepts raw control characters; the loader carries two refusals the server's non-strict build
  lacks and none of its top-level checks; engine errors carry `detail` only. No `download`,
  `views` or `compare` surface; no golden family for any of the four.

## Plan 6a

### Download — `engine/src/download/`

- **`WorkingCopy.committedSteps()`**, read-only: elements, then relationships, each the merge
  by `ord` of (a) live records whose id is not in the committed map and (b) the non-null
  committed images. Staged deletes come back at their place, staged creates are left out, a
  staged recreate under a committed id is emitted from its image at its old `ord`, a
  relationship's ends are the image's `sourceId`/`targetId`. Resumable across scan steps (a
  model-lane transition cannot run between them; a control-lane one restarts the scan).
- **`downloadModel {}`**, a model-lane scan: each entity as `pyDumps(entity, 2)` with every
  `\n` turned into `\n` plus four spaces, in `iter_model_json`'s framing. Text is encoded as it
  is written into parts of at most 4 MiB (`PART_BYTES`), never joined into one string; a lone
  surrogate is refused 422 with `utf8.ts`'s wording. Answers `{parts, filename: "model.json",
  content_type: "application/json"}`, the parts transferred.
- **Frontend:** surface `download` (defaults `server` until the plan's last task flips it). Not
  staged-only: committed state is comparable while edits are staged. `downloadModel()` routes;
  the engine answer becomes `new Response(new Blob(parts, {type}))` for `saveResponseToFile`.
  Shadow `always`; the digest is `{filename, content_type, byte length, SHA-256}` of the body.

### View warnings — `engine/src/view/`

- **`validateView(view, model, known)`**, a port of `validate_view`: the six texts through
  `pyRepr`, the empty path rendered `'/'`, paths joined by `/` over folder names; the traversal
  iterative with the recursive order above; exact name comparison. Issues in `IssueOut` shape,
  `origin: "on_server"`.
- **`validateView {view}`** (CT-4): a new read job on the model lane that receives the working
  `ArtifactSet`. An artifact id is known when `resolve(id)` answers (staged creates known,
  staged deletes not); elements and containment parents are the working copy's.
- **Frontend:** surface `views`, gated as `issues` (engine staging, seeded, follower loaded). In
  engine mode the view store ignores `GET /views/{id}`'s `warnings` and asks the engine,
  debounced, after a view load, after each staged view op and on the replica's `changed`
  (model or `artifacts_version`). Shadow `unstaged`, exact order; the shadow's `staged()` gains
  the staged view-op depth. Staged views get warnings for the first time.

## Plan 6b

### Python equality — `engine/src/value/eq.ts`

- **`pyEq(a, b)`**: Python `==` over `Value`. Dicts equal as key sets with equal values,
  whatever the order; lists element-wise; `true == 1 == 1.0`; an int against a float exact
  (`2**53 + 1` differs from its float); a bigint against a float exact; strings by code units;
  `null` equals only `null`; a dict never equals a list; a float NaN equals nothing.

### Compare — `engine/src/cr/`

- **`compareModel {file, created_at}`**, `file` a transferred `ArrayBuffer`. The UTF-8 decode is
  fatal with a BOM stripped; `parseExact` runs with raw control characters refused. A decode or
  parse failure is **501 `reaches an unreadable file`** (a new `engine-route.ts` fallback), so
  the server answers with its own wording.
- The shape checks, as plain per-id maps (no second `Model`, no indexes), in
  `build_model_from_dicts(strict=False)`'s order and texts, each a 422: not an object;
  `elements` then `relationships` not a list (absent is `[]`, `null` refused) before any
  entity; per element: not an object, `id` then `type_name` not a string, the reserved `tmp_`
  prefix, a known abstract type, a duplicate id, then `properties`, then `rev`; per
  relationship: not an object, `id`, `type_name`, `source_id`, `target_id` not strings, the
  prefix, unknown source then target, a duplicate id, then `properties`, then `rev`. Unknown
  types, extra keys, an id shared between an element and a relationship and array-index
  property keys are tolerated.
- **`diffModels(working, other)`**: identity by id per kind; modified when `type_name`,
  `properties` (`pyEq`) or, for relationships, the ends differ; `rev` ignored; added and
  modified in the file's order, deleted in the working copy's state order, elements first.
  Steps of 2,048 entities.
- **Answer:** `{model_rev, cr, other_element_count, other_relationship_count}`: `model_rev` the
  committed `rev`, `cr` as `_changes_out` writes it with `baseline` counts from the working
  copy and `createdAt` the `created_at` param (no clock in the engine). A non-finite float is
  `null` on the wire, as pydantic writes it.

### Apply-CR — `engine/src/cr/`

- **`proposeCr {crs, created_at}`**, a model-lane scan over an **overlay** of the working copy:
  `id → entity | deleted` per kind, with an insertion sequence so that iteration equals the
  Python dict after the same edits (a modify keeps its place; a delete then re-add goes last;
  adds append in apply order). O(CR + incident); no model copy.
- **Per CR, Phase A:** every conflict against the overlay as it stood before that CR, in the
  six-bucket order, with the reason texts (`Element 'x' already exists in the model`, `… does
  not exist in the model`, `… does not match the before snapshot`, `… does not match the
  deleted snapshot`, and the same for `Relationship`), equality `pyEq` on `type_name`,
  `properties` and ends, `rev` ignored. The first CR with a conflict ends the request: the
  engine answers `{conflict: {cr_index, conflicts, model_rev}}`, and `proposeCr` in `lib/api`
  throws the same 409 `ApiError` the server path throws.
- **Phase B:** the CR's effects into the overlay: a modified entity's `rev` is its current
  `rev + 1`, an added one keeps the file's; duplicate adds and modifies, last wins; a modify and
  a delete of one id, the delete wins; duplicate deletes, one delete.
- **Result:** the combined diff over the touched ids only (deleted in the working copy's `ord`);
  `_gate_cr_result` — added then modified elements (unknown type, abstract type), added then
  modified relationships (unknown type, unknown source, unknown target), then per deleted
  element its working-copy incident relationships sorted by code point that still exist, source
  then target — the first error only, 422; the retype 422 (`Element 'a' changes type ('A' ->
  'B'); element type changes are not supported — delete and re-create it in the CR`);
  `ops_for_change`'s order (create elements, create relationships with endpoints on created
  elements as their temp ids, update elements, update relationships that are not rewires,
  delete relationships, each rewire as delete + create under the same id, delete elements),
  one shared `tmp_` counter, patches with changed keys in `after` order then removed keys as
  `null`, an empty patch skipped.
- **Answer:** `{model_rev, cr, ops}`, `model_rev` the committed `rev`. The ops stage through the
  engine's applier, which refuses what the server's commit would (unknown property keys, the
  shared id space, a `tmp_` id hint) with the same texts, as today.
- **The duplicate-delete bug is fixed on both sides** (MR-3): Python's Phase B deletes with
  `pop(id, None)`, so duplicate ids in `deleted` are one delete; a fixture holds it.

### Frontend

- Surface `compare` routes `compareModel` and `proposeCr`; gated as `issues`. Shadow
  `unstaged`, the digest masking `createdAt`.
- `ModelChangeDialog`, in engine mode: Replace is enabled while edits are staged (the ops now
  stage on top of the working copy); Preview shows "Includes staged changes" while the replica
  holds staged model ops; the file goes to the engine as an `ArrayBuffer`; `created_at` is the
  client's `new Date().toISOString()` with milliseconds. The server path keeps today's rules.
- `stageProposedOps` is unchanged; its prestate seeds from the CR's `before`, which in engine
  mode are working-copy images.

## Oracle, tests, gate

- **Golden families** (`tests/golden/scenarios/`), each replayed with staged model ops (and,
  where it reads them, staged artifacts), the oracle a Python model with the same ops applied:
  - `model_download` (6a): a churned model — deletes, same-id recreates, floats `1.0`, `1e-07`,
    `-0.0`, `1e16`, a bigint, non-ASCII, `\x7f`, U+2028, empty properties, no relationships;
    the committed bytes, which staged ops on top must not change.
  - `view_warnings` (6a): a `view_step` carrying folder and root artifacts; all six kinds, the
    order cases (artifacts before children before elements, root last, F skipping a subtree,
    B nested, C/D/E precedence, E with the same path twice), repr with `'`, the empty path,
    known and unknown artifacts.
  - `py_eq` (6b): the equality table (bool/int/float, bigints and floats around 2**53,
    nested dicts in other orders, dict vs list, the bare-constant strings, `1e400`).
  - `change_request` (6b): compare — every shape refusal, the equality edge cases, ordering,
    tolerated inputs; apply-CR — several CRs, conflicts across the six buckets, a re-add
    moving to the end, delete + identical re-add vanishing, a rewire, patch nulls, temp ids,
    each gate error, the retype, duplicate deletes.
- **Engine tests:** `committedSteps` against a rewind of the working copy, over each staged
  shape; parts at the 4 MiB boundary and a multi-byte character across it; the iterative
  traversal on a 2,000-deep folder chain; the overlay's order against a `Map` with Python dict
  semantics; the 501 fallback; a cancelled and a restarted scan.
- **Frontend tests** (in-process engine, MSW for the server): each routed function in engine
  and server mode; the download Blob; view warnings recomputed on a staged view op and on a
  model change; the 409 conflict path through `proposeCr`; Replace enabled while dirty in engine
  mode only; each shadow catching a one-field difference.
- **Parity at M** (`engine-parity-large`): the download byte-equal to the server's; a compare of
  a file derived from M (edits, deletes, adds written by the bench-data script) and the
  apply-CR of its CR equal to the oracle.
- **Bench** (`engine-bench`, `engine-bench-browser`, medians of 3, host and date): download
  total, longest step and heap; compare's parse block, diff total, longest step and the parsed
  file's heap beside the replica (CN-3's 400 MB); apply-CR of the whole-model CR. No budget;
  reported to the owner.
- **e2e** (shadow on): download; a view with a staged op showing a warning; the dialog's Preview
  and Replace, once with nothing staged and once after staging an edit.

## Freeze and documents

- **Freeze** (MR-3), from each plan's start until its surface defaults to the engine:
  6a — `iter_model_json`, the download route, `core/view/validation.py`, `GET /views/{id}`;
  6b — `core/model/change_request.py`, `api/change_request_ops.py`,
  `routes/change_request.py`, `build_model_from_dicts`, except the duplicate-delete fix.
- **CT-4:** `downloadModel`, `validateView`, `compareModel`, `proposeCr`.
- **`program.md`:** C's status per plan; MR-3 gains the rows above.
- **READMEs:** `engine/README.md` (`committedSteps`, download, view warnings, `pyEq`, `src/cr/`);
  `frontend/src/lib/engine/README.md` (the three surfaces, the `unreadable file` fallback);
  `frontend/README.md` (the view store's warnings); `src/data_rover/api/README.md` (the
  duplicate-delete fix).
- **Backlog:** `K-88` (placement winner order); measurements that miss a budget get their own
  entries.

## Done when

- `download`, `views` and `compare` default to the engine with the shadow clean in e2e; the
  server path works behind each switch.
- `model_download`, `view_warnings`, `py_eq` and `change_request` pass; `engine-parity-large`
  shows download, compare and apply-CR equal at M.
- `pixi run dr-test`, `dr-tidy`, `engine-check`, `frontend-check`, `sandbox-check` and
  `engine-parity-large` are green; e2e shows no `[shadow]` lines.
- Bench numbers are reported to the owner.
- `architecture/`, the READMEs and the backlog say what is now true.
- `engine-migration` is fast-forwarded only with the owner's go-ahead.
