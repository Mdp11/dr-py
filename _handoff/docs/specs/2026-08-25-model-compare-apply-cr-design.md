# Model compare / Replace / Create CR / Apply CR — design

Date: 2026-08-25. Closes BACKLOG P-23 and adds Replace + Create CR to Compare.

## 1. Goal

Two Model-menu flows that today live on different surfaces with different
semantics become one "server proposes, client stages" pipeline:

- **Compare…** — pick another model JSON; the server diffs the session model
  against it. From the diff the user can **Preview diff**, **Create CR** (save
  a `datarover.cr/v1` file, in either direction via a Swap toggle), or
  **Replace** (stage every edit that makes the session model equal the file).
- **Apply CR…** — pick one or more CR files in a chosen order; the server
  applies them sequentially and transiently against the session model and
  proposes the resulting op batch. The user can **Preview diff** or **Stage
  edits**.

Nothing is applied server-side by either flow. Staged edits land in the
client's ordinary staged buffer and go through `POST /commits/preview` /
`POST /commits` exactly like manual edits (locks, journal, DiffDrawer, undo).

No preview runs automatically: every network call sits behind an explicit
button.

## 2. Protocol changes

### 2.1 `id` hint on create ops

`CreateElementOp` and `CreateRelationshipOp` (`api/schemas.py`, mirrored in
`frontend/src/lib/state/ops.ts`) gain `id: str | None = None`. `temp_id`
stays mandatory: it is how the batch refers to the entity and how the
client keys its local cache. `id` is a request for the final id.

Applier (`routes/ops.py`): `id is None` → `create_element` (minting path,
unchanged); `id` set → `Model.restore_element(id, type_name)` /
`restore_relationship`, whose "already in use" `ValueError` maps to the
batch's normal 422 + rollback. `id_map[temp_id] = id` in both cases, so
`POST /commits`, `/commits/preview`, `/model/ops`, undo inverses, hydration
replay and the commit diff work unchanged — they only read `id_map`.
Restore-mode replay keeps ignoring `id` (it uses the journalled `id_map`).

A create needs no lease before and after this change; a clash is caught at
apply. The manual UI never sets `id`; only proposed batches carry it.

Why: CR files and model files carry real ids for added entities. Minting
fresh ids on stage would break CR chains applied across separate commits
(CR2 modifies what CR1 added) and make a re-compare after Replace report the
just-added entities as deleted+added.

### 2.2 CR → ops translation

`api/change_request_ops.py`: `ops_for_change(base: Model, final: Model, cr:
ChangeRequest) -> list[ModelOpIn]`, pure. Fixed phase order:

1. `create_element{id, type_name, properties}` for added elements.
2. `create_relationship{id, ...}` for added relationships (endpoints are
   real ids).
3. `update_element{properties_patch}` / `update_relationship` for modified
   entities: JSON merge patch before→after, `null` for removed keys.
4. `delete_relationship` for deleted relationships; then, per *rewired*
   relationship (source/target changed — `update_relationship` cannot),
   `delete_relationship` immediately followed by `create_relationship{id:
   same id}`.
5. `delete_element` for deleted elements. Every incident relationship is
   gone by phase 4 (the existing `_gate_cr_result` guarantees the CR deleted
   them), so `delete_element`'s containment cascade can never over-delete.

Refused with 422 naming the element: an element whose `type_name` differs
between before and after. There is no retype op and delete+create would
cascade through containment children. Only a hand-edited JSON can produce
this from the repo's own CR producers.

## 3. Backend routes (`routes/change_request.py`)

Neither route mutates the session or takes `write_mutex` for a write. Both
read `session.model` and stamp the `model_rev` they saw (the
`POST /snippets/run` precedent); the client refuses to stage on a moved rev.

### 3.1 `POST /model/compare`

Body: the raw other-model JSON (raw-body handling as `POST /model/upload`,
no whole-document pydantic model). Parsed into `Element`/`Relationship`
**without** the metamodel gate — comparing against a file with an unknown
type is fine; only staging it is not.

Computes `diff_models(session.model, other)` (new pure function in
`core/model/change_request.py`, the Python twin of `diff.ts`: `rev`
ignored, deep property equality, endpoint change = modified).

Response: `ChangesOut`-shaped CR (direction session → other, `baseline`
from the session) plus `model_rev`, `other_element_count`,
`other_relationship_count` (for the "N unchanged hidden" count). Direction
swap is client-side.

In `authz._READ_ONLY_POST_SUFFIXES`: a viewer may compare and Create CR.

### 3.2 `POST /model/apply-cr`

Body: `{crs: list[ChangeRequestIn]}`, ≥ 1, ordered. Steps:

1. `base = session.model`; fold `apply_change_request` over `crs` in order
   (pure; each step is a fresh copy). The first `CRConflictError` stops the
   run → **409** `{cr_index, conflicts, model_rev}`. Conflicts are checked
   against the model as left by the preceding CRs (sequential semantics).
2. `_gate_cr_result` on the combined delta (unknown/abstract types,
   dangling endpoints, non-cascaded deletes) and the retype guard → 422.
3. `ops_for_change(base, final, combined_cr)`.

Response: `{model_rev, cr, ops}` where `cr = diff_models(base, final)` —
the net effect, for preview. Session untouched, nothing journalled.

Not in the read-only allowlist: editor+ (its only consumer is staging).

The inline mode (`ApplyCrRequest.model`, `ApplyCrResponse`,
`_apply_cr_inline`) and the session-replace mode (`_apply_cr_session`) are
deleted.

Replace is not a route: the client posts the compare CR as `{crs: [cr]}`.

### 3.3 Core additions

- `diff_models(base, other) -> ChangeRequest`.
- `invert_change_request(cr) -> ChangeRequest` (swap added↔deleted, flip
  before/after). Used by tests to pin agreement with the client's inversion;
  the runtime swap is client-side.

## 4. Frontend

### 4.1 Top bar

The flat **Apply CR** button is removed. Model menu: **History · Compare… ·
Apply CR… · Export**. `TopBar.test.ts` order test updated. The
`/p/[projectId]/compare` route is deleted.

### 4.2 `components/ModelChangeDialog.svelte`

One dialog, `mode: 'compare' | 'apply-cr'`, `max-w-4xl`, scrollable body.
Each mode owns its *source* strip; the rest is the shared
`ProposalPreview.svelte` (counts header, `CompareDiff` split/unified viewer,
conflicts block, 422 message). No request fires on file selection.

**Compare mode**: `Choose model…` → From/To labels + **⇄ Swap** → buttons
**Preview diff** · **Create CR** · **Replace**.
- Preview: `POST /model/compare`, result cached per (file, `model_rev`);
  rendered inverted when swapped.
- Create CR: saves the (possibly inverted) CR through `saveJsonToFile` +
  `composeCrFilename`. Uses the cached compare result or fetches it.
- Replace: session → file by definition, so disabled while swapped (tooltip).
  `POST /model/apply-cr` with `[cr]`, then `stageProposedOps`.

**Apply CR mode**: ordered list — add one or many files (multi-select
input, each checked for `format === 'datarover.cr/v1'`), ↑/↓ reorder,
remove — then **Preview diff** · **Stage edits**. Both call
`POST /model/apply-cr` with the list in display order. 409 renders
"CR #k conflicts" with the conflict rows; preview renders the combined `cr`.
Stage reuses the proposal if `model_rev` is unchanged, else re-proposes.

**Gates on Replace / Stage edits**: `canEdit()` and an empty model staged
buffer (`!hasStagedOps()`). The proposal is computed against the committed
model, so pre-existing staged edits would surface as conflicts or double
edits. The dialog says "Commit or discard your staged edits first" and
disables the button. Snippet staging keeps its current looser rule.

After a successful stage: close the dialog, status-bar message "N edits
staged — review with Ctrl+S".

### 4.3 Shared modules

- `state/stage-proposed.ts` — `stageProposedOps(ops, modelRev, prestate?)`,
  extracted from `snippet-stage.ts` (which becomes a thin wrapper). The
  temp-id remap preserves an op's `id` hint. Optional `prestate`
  (`{elements, relationships}`) seeds `seedElements`/`seedRelationships`
  from the proposal's own `cr` (`modified[].before`, `deleted[]`) so a big
  Replace does not fetch every update/delete target one by one; the
  snippet path passes nothing and keeps fetching. Lock derivation
  (edit/connect/delete intent groups, one `POST /locks` per group) is
  unchanged.
- `state/cr.ts` — `invertChangeRequest`, `crToDiff` (inverse of
  `buildChangeRequest`'s partition). `buildChangeRequest` and `diff.ts`
  stay (the `Diff` type feeds `CompareDiff` and the DiffDrawer).
- `api/changeRequest.ts` — `compareModel(file)` (raw body), `proposeCr(crs)`
  returning `{ok: true, modelRev, cr, ops} | {ok: false, crIndex,
  conflicts}`; zod schemas in `api/types.ts`.

## 5. Removed

`ApplyCrDialog.svelte`; the `/compare` page; `state/compare.ts` and its
test (`comparePair` is subsumed by `invertChangeRequest`); the inline and
session apply-cr modes and their schemas; the `authz.py` comment on
apply-cr's dual-mode exemption. `GET /model`, `GET /model/changes` and
save-with-CR are untouched.

## 6. Docs

- `CLAUDE.md`: the op-shape note gains the `id` hint; the rules-blind
  sentence drops `_apply_cr_inline`; a short "Compare / Apply CR" paragraph
  under the delta protocol.
- `frontend/README.md`: the State-model section gains the propose→stage
  path beside snippets; "Where to find things" entries.
- `BACKLOG.md`: P-23 marked done with a two-line note that also records
  Replace/Create CR.

## 7. Tests

Backend:
- `tests/model/test_change_request.py`: `diff_models` (added / modified /
  deleted / rewired / unchanged; `rev` ignored); `invert_change_request`
  round-trips with `apply_change_request`.
- `tests/api/test_change_request_ops.py`: phase order (parent+child+Owns
  deletion has no cascade victim; rewire → delete+create same id; removed
  keys → `null` patches); retype → 422 naming the element.
- ops/commit tests: `create_element{id}` lands with that id via `/commits`
  and `/model/ops`; taken id → 422 with full rollback; undo of an id-hinted
  create; hydration replay of a commit carrying one.
- `tests/api/test_apply_cr_route.py` (rewritten): returns ops + combined
  cr, `model_rev`/session untouched; sequential semantics (CR2 modifies
  CR1's addition → ok; conflicting CR2 → 409 `cr_index: 1`); gate 422s;
  viewer 403.
- `tests/api/test_compare_route.py`: viewer allowed; unknown-type file
  compares; counts.
- `tests/api/test_rules_callsites.py`: drop the `_apply_cr_inline`
  rules-blind assertion.

Frontend (vitest):
- `cr.test.ts`: `invertChangeRequest`, `crToDiff`.
- `stage-proposed.test.ts`: moved from the snippet-stage tests, plus id-hint
  preservation and prestate seeding.
- `ModelChangeDialog.test.ts`: no request on file pick; Preview fires
  compare/propose; Replace disabled while swapped / while the buffer is
  dirty / for viewers; list reorder changes request order; 409 renders
  `CR #2`.
- `TopBar.test.ts`: menu order.

E2E stays out (T-7 backlog list).

## 8. Out of scope

Retype via CR (guarded, see §2.2); applying a CR on top of a dirty staged
buffer; the full CR authoring/review workflow (§10 deferred list); history
diff (F-9/K-6).
