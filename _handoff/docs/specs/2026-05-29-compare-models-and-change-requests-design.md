# Compare Models & Change Requests — Design

Date: 2026-05-29
Status: Approved (pending implementation plan)

## Summary

Add the ability to compare two models and act on the difference. Three capabilities:

1. **Compare** the currently-loaded model against another model file, shown as a
   GitHub-style diff.
2. **Generate a Change Request (CR)** from that comparison, in either direction,
   using the existing `datarover.cr/v1` format.
3. **Apply a CR** to a model file, producing a new model file. Strict: aborts on
   any precondition conflict.

The work reuses the existing diff (`frontend/src/lib/state/diff.ts`) and CR
generation (`frontend/src/lib/state/cr.ts`) code as-is. The only net-new
computation is CR application, which runs on the backend so it can use the
metamodel validation pipeline.

## Domain recap

- **Model** = a graph of `Element`s and `Relationship`s. Both carry
  `id`, `type_name`, `properties`, `rev`. Defined in
  `src/data_rover/core/model/` (Python) and mirrored in
  `frontend/src/lib/api/types.ts` (`ModelOut = { elements, relationships }`).
- **CR** (`datarover.cr/v1`) = `frontend/src/lib/state/cr.ts`. Shape:
  `ops.elements` and `ops.relationships`, each with `added` / `modified` /
  `deleted`. Modified entries are `{ id, before, after }` full snapshots. A
  `baseline` block records the "from" model's filename and counts.
- **Diff** = `computeDiff(from, to)` in `diff.ts`. Returns only `added` /
  `modified` / `deleted` entities (unchanged are filtered out) plus
  `modifiedFields`.

## Decisions

| Topic | Decision |
|-------|----------|
| Source of the 2nd model | Load a model JSON file from disk; compared against the currently-loaded model. |
| Compare/CR-gen compute | Frontend, reusing `computeDiff` + `buildChangeRequest`. |
| Apply compute | New backend endpoint, so metamodel validation runs. |
| Apply output | A new model file. No session mutation. |
| Apply strictness | Strict — abort on any precondition conflict, report all conflicts. |
| Metamodel issues after apply | Returned as non-blocking warnings alongside the new model (consistent with `/model/validate`). Only precondition conflicts abort. |
| "Other" model validation for compare | None — parsed purely client-side; a diff doesn't need metamodel conformance. |
| Entry points | A dedicated `/compare` screen + a separate Apply-CR action/dialog. |
| Diff view layout | "A+B mix" (see below). |

## Diff view layout (the "A+B mix")

- **Header**: change counts (`+N added`, `~N modified`, `−N deleted`), a
  "N unchanged hidden" note, and a **Split / Unified** toggle.
- **Sections**: `Elements` and `Relationships`, each listing only changed
  entities (unchanged omitted — free, since `computeDiff` already filters them).
- **Per-entity card**: header row with a `+`/`~`/`−` badge, `type_name`, and
  `id`. Body is a **side-by-side before/after**:
  - Modified → changed property rows red on the left (before), green on the
    right (after); unchanged rows shown muted for context.
  - Added → only the right column populated; left shows "— not present —".
  - Deleted → only the left column populated; right shows "— removed —".
- **Split / Unified toggle** flips all cards between the two-column split and a
  single-column unified (`+`/`−` lines) rendering.

## Compare flow

1. Loaded model is the **left/"from"** side by default.
2. User picks the **other** model JSON file. It is parsed client-side into the
   `ModelOut` shape (`{ elements, relationships }`). No backend call, no
   metamodel check.
3. A **Swap (⇄)** control flips which model is "from" vs "to". This also
   determines CR generation direction.
4. `computeDiff(from, to)` feeds the A+B mixed diff view.

## Generate CR flow

- An **Export CR** action calls the existing
  `buildChangeRequest(from, to, fromFilename)` with the two compared models in
  the currently-selected direction, then `composeCrFilename` + `saveFile`
  (existing helpers in `cr.ts` / `util/fileSave.ts`).
- Direction follows the Swap state, so A→B or B→A both come for free with no new
  CR logic.
- Output format and filename convention are identical to today's save-time CR
  export.

## Apply CR flow

### Endpoint

`POST /api/v1/model/apply-cr`

Request: `{ model: InlineModel, cr: ChangeRequestIn }`
Response (200): `{ model: ModelOut, issues: IssueOut[] }`
Response (409): `{ conflicts: CRConflict[] }`

- Uses the session's loaded metamodel via `require_metamodel`.
- Does **not** modify `session.model`.

### Strict precondition checks (abort-all on any conflict)

For each op, before applying anything:

- **added**: target must NOT already contain the id → else conflict
  `id_exists`.
- **modified**: target MUST contain the id AND its current state must deep-equal
  the CR's `before` snapshot → else conflict `missing` or `before_mismatch`.
- **deleted**: target MUST contain the id AND deep-equal the `before` snapshot →
  else conflict `missing` or `before_mismatch`.
- Same rules for relationships.

If any conflict exists, apply nothing and return 409 with the full conflict
list (each: kind, entity type, id, reason).

### On success

- Apply all ops to produce the new entity set.
- Build the resulting `Model` via `_build_model_from_payload` (metamodel-typed).
- Run `default_pipeline().validate(model, Scope.all())`.
- Return `{ model: ModelOut.from_core(model), issues }`. Issues are
  **non-blocking** — surfaced as warnings; they do not fail the apply.

### Frontend

- An **Apply CR** dialog loads a model file + a CR file, POSTs to the endpoint.
- On 200: write the returned model to a new file via `saveFile`; surface any
  `issues` as warnings.
- On 409: show the conflict list; no file written.
- Applying a CR "in reverse" simply means applying a CR that was generated in
  the reverse direction — the endpoint is direction-agnostic.

## Code organization

### Frontend (new)

- `lib/state/applyCr.ts` — pure: apply a parsed CR's ops to a `ModelOut`,
  returning the new `ModelOut` or a conflict list. Mirrors the backend logic so
  it can also drive an optimistic client-side check and is unit-testable without
  the backend.
- `lib/state/compare.svelte.ts` — compare screen state (other model, swap
  direction, derived diff).
- `routes/compare/+page.svelte` — the Compare screen.
- `lib/components/CompareDiff.svelte` — counts header + Split/Unified toggle +
  sections.
- `lib/components/CompareEntityCard.svelte` — the per-entity A+B card.
- `lib/components/ApplyCrDialog.svelte` — load model + CR, call endpoint, handle
  result.
- `lib/api/changeRequest.ts` — typed client for `POST /model/apply-cr`.

### Backend (new)

- `core/model/change_request.py` — pure CR-apply logic: takes a `Model` + parsed
  CR, returns a new `Model` or raises `CRConflict` (carrying the conflict list).
- `api/routes/change_request.py` — the `apply-cr` route; wired into
  `api/main.py`.
- `api/schemas.py` additions — `ChangeRequestIn` (Pydantic mirror of
  `datarover.cr/v1`), `CRConflict`, and the apply response model.

The `datarover.cr/v1` shape currently exists only in TypeScript; this adds the
backend Pydantic mirror. Keep the two definitions in sync (the format string
`datarover.cr/v1` guards version drift).

## Error handling

- Missing metamodel on the backend → existing `require_metamodel` 4xx behavior.
- Malformed model/CR JSON on upload → client-side parse error surfaced in the
  relevant dialog; backend returns 422 via Pydantic validation if it reaches the
  endpoint.
- Apply preconditions failed → 409 with full conflict list; nothing applied,
  nothing written.
- Metamodel validation issues after a successful apply → returned as warnings,
  non-blocking.

## Testing

- **Backend (pytest)**: `core/model/change_request.py` — clean apply, each
  conflict kind (id_exists, missing, before_mismatch) for elements and
  relationships, abort-all semantics, metamodel-issue passthrough. Plus a route
  test for 200 and 409 shapes.
- **Frontend (vitest)**: `applyCr.ts` (parity with backend rules, conflict
  reporting), compare direction/swap logic. Follow the existing `diff.test.ts` /
  `cr.test.ts` patterns.
- **E2E (Playwright, optional)**: a compare → export-CR → apply-CR happy path.

## Out of scope

- Granular field-level CR ops (the format stays full-snapshot, as today).
- Three-way merge / conflict resolution UI (apply is strict abort-only).
- Comparing arbitrary two files where neither is the loaded model (the loaded
  model is always one side of the compare).
