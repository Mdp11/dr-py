# Metamodel lease + structural diff (artefacts revamp, Phase 4)

**Date:** 2026-08-10
**Status:** approved (brainstorm 2026-08-10; supersedes the Phase 4 sketch in
`2026-07-29-artefacts-revamp-design.md`)

## Context

The last phase of the artefacts-revamp program. Two features, one theme —
making metamodel changes first-class citizens of the collaboration model:

1. **`mm` lease**: the EXCLUSIVE metamodel lease actually gates metamodel
   writers, and peers see *who* holds it instead of a bare 409.
2. **Structural metamodel diff**: a typed, per-facet diff of two metamodel
   documents, computed by ONE core differ and rendered on TWO surfaces —
   `POST /metamodel/diff` (pre-rebind review) and `GET /commits/{rev}/diff`
   (post-hoc history of rebind commits).

### What already exists (do not rebuild)

- `locking.py` defines `METAMODEL_RESOURCE = "mm"`; `routes/locks.py`
  canonicalizes `LockTargetIn.type: "metamodel"` → `"mm"`; the frontend's
  `checkout.svelte.ts` maps the type and `quiet.ts` counts an `mm` lease
  toward "project not quiet". **Acquisition is fully plumbed; nothing honors
  or verifies the lease yet.**
- `POST /metamodel/rebind` (Phase 6B) is the journaled, owner-only,
  non-destructive metamodel swap. It refuses (409) while any *model* lease is
  live (quiescence) but ignores the `mm` lease entirely.
- `POST /metamodel/diff` returns only the validation-impact diff
  (`now_failing` / `now_passing` / counts) via `build_rebind_view`.
- `Commit` rows carry `from_metamodel_id` / `to_metamodel_id`; `commit_diff.py`
  flags rebind commits (`is_rebind`) but renders nothing about the metamodel
  change itself. Metamodel versions are immutable `MetamodelRow` YAML blobs.

### Forward constraint (Phase 5, agreed 2026-08-10)

The next phase is **live metamodel editing** (raw YAML + UI-assisted), which
**drops the SwapMetamodelDrawer** — users will paste a new YAML directly into
the editor. Phase 4 therefore:

- keeps ALL lease and diff logic out of drawer internals (reusable state
  module + standalone component; the drawer is just today's host);
- adds nothing drawer-specific server-side — `POST /metamodel/diff` is the
  editor's future preview call, rebind its landing path, honor-don't-require
  its lease contract;
- invests minimally in drawer styling.

## Decisions (brainstorm outcomes)

1. **Lease lifecycle — held by the metamodel-editing surface from review
   step.** The drawer acquires EXCLUSIVE `mm` when the user uploads a
   candidate and enters the diff/review step, heartbeat-renews like other
   check-outs, releases on close/cancel/after-success. A peer entering review
   gets the conflict immediately and sees "Metamodel locked by <email>".
2. **Enforcement — honor peers, don't require.** Rebind proceeds when `mm` is
   free or held by the caller; 409 with holder email when a peer holds it.
   Matches the artifact-lease precedent ("every other writer HONORS leases")
   and stays backward-compatible for direct API callers on a quiet project.
   The existing model-lease quiescence check stays unchanged.
3. **Diff wire shape — typed nested tree** mirroring the metamodel document
   (see schema below). Adds/removes carry full definitions; "changed" nests
   to per-facet `{field, from, to}`.
4. **History surface is backend-only.** `GET /commits/{rev}/diff` gains the
   `metamodel` section, API-tested; no HistoryDrawer UI (that consumption
   remains parked).
5. **Recompute, never store** (inherited from the program spec): diffs are
   computed on demand from immutable `MetamodelRow` blobs.

## Core differ — `src/data_rover/core/metamodel/diff.py`

One pure function plus its pydantic result models (style-matched to
`schema.py`):

```python
def diff_metamodels(old: Metamodel, new: Metamodel) -> MetamodelStructuralDiff
```

### Result schema

Wire keys `from` / `to` (python `from_` via serialization alias).

```
FieldChange              {field: str, from: Any, to: Any}

EnumEntry                {name: str, literals: list[str]}
EnumChange               {name: str, added: list[str], removed: list[str]}   # literal-level
EnumsDiff                {added: [EnumEntry], removed: [EnumEntry], changed: [EnumChange]}

PropertyChange           {name: str, fields: [FieldChange]}
PropertiesDiff           {added: [PropertyDef], removed: [PropertyDef], changed: [PropertyChange]}

ElementTypeChange        {name: str, attributes: [FieldChange], properties: PropertiesDiff}
ElementTypesDiff         {added: [ElementType], removed: [ElementType], changed: [ElementTypeChange]}

MappingsDiff             {added: [Mapping], removed: [Mapping]}              # (source, target) pairs; no identity beyond the pair, so no "changed"
RelationshipTypeChange   {name: str, attributes: [FieldChange], properties: PropertiesDiff, mappings: MappingsDiff}
RelationshipTypesDiff    {added: [RelationshipType], removed: [RelationshipType], changed: [RelationshipTypeChange]}

MetamodelStructuralDiff  {enums: EnumsDiff, element_types: ElementTypesDiff,
                          relationship_types: RelationshipTypesDiff}
                         + `is_empty` python @property (NOT serialized —
                           clients derive emptiness from the arrays)
```

### Rules

- **Identity is the name** everywhere (types, properties, enums). A rename is
  remove+add. No rename detection (nothing downstream needs it).
- **Raw document, not effective definitions.** The diff mirrors what the
  author wrote — `extends` chains are NOT flattened, inherited properties do
  NOT appear on subtypes. Inherited-property *impact* is the job of the
  existing validation-impact section.
- Element-type `attributes` fields: `abstract`, `extends`, `key`.
  Relationship-type `attributes` fields: `abstract`, `extends`, `containment`,
  `source_multiplicity`, `target_multiplicity`. **NOT `source`/`target`**: a
  model validator keeps them mirroring `mappings[0]`, so diffing them would
  duplicate every mappings change — the mappings diff is authoritative for
  endpoints. All compare by equality; `key` (a `list[str] | None`) is one such
  attribute, reported with raw from/to values.
- Property facet fields: `datatype`, `multiplicity`, `min`, `max`, `pattern`,
  `max_length`.
- Enum literal comparison is set-based; pure reordering of literals is not a
  change. Type/property ORDER changes in the document are likewise not
  changes (the model is order-insensitive).
- A `changed` entry is only emitted when it contains at least one actual
  change (non-empty attributes/properties/mappings delta).
- Output lists are sorted by name for deterministic responses.

## API changes

### `POST /metamodel/diff` (`routes/metamodel_swap.py`)

`MetamodelDiffResponse` gains `structural: MetamodelStructuralDiff`, computed
from `session.metamodel` vs the parsed candidate. Core diff models are
returned directly (same stance as `GET /metamodel` returning `Metamodel` — no
`*Out` mirror layer). The compare runs OUTSIDE the write-mutex: both objects
are immutable, and the mutex section stays validation-only.

### `GET /commits/{rev}/diff` (`commit_diff.py`)

`CommitDiffOut` gains `metamodel: MetamodelStructuralDiff | None = None`,
non-None only for rebind commits: load both blobs via
`content.get_metamodel_row(from_metamodel_id / to_metamodel_id)`, parse with
`load_metamodel_str`, diff. **Degraded, never failed**: a missing row, a
`None` `from_metamodel_id`, or an unparseable blob yields `metamodel: null`
while the rest of the commit diff renders normally.

### `POST /metamodel/rebind` — honor the `mm` lease

Under the write-mutex, alongside the existing model-lease quiescence check: a
peer lease on `"mm"` (via `lock_table.peer_leases([METAMODEL_RESOURCE],
holder=user.id, now=time.monotonic())`) → 409 with structured detail:

```json
{"detail": "metamodel locked", "holder_email": "<email>"}
```

The caller's own lease never blocks. No lock token on the request — rebind
honors, it does not verify — so the server does NOT release the caller's
lease on success; the client surface releases its own lease when it closes
(TTL + sweeper cover crashes).

### `POST /metamodel` + `DELETE /metamodel` — consistency fold-in

The destructive initial-bind upload and the clear route honor the peer `mm`
lease the same way (same 409 shape). They are writers to the same resource; a
lease is only a guarantee if every writer honors it.

## Frontend changes

Scope: the swap drawer's flow only (history side is backend-only). All logic
lands in reusable modules per the Phase 5 constraint.

- **`frontend/src/lib/state/metamodel-lease.svelte.ts`** (new) — acquire /
  renew / release of the `mm` lease keyed to a host surface's lifecycle,
  reusing the checkout store's token + heartbeat machinery. Generation-guarded
  async per house dialog rules. Exposes the conflict's `held_by_email` when
  acquisition fails. Consumers: SwapMetamodelDrawer today, the Phase 5 editor
  later.
- **`frontend/src/lib/components/MetamodelStructuralDiff.svelte`** (new) —
  standalone renderer taking the structural diff as a prop: counts summary
  line + grouped added/removed/changed lists per section, per-facet from→to
  rows for changed entries, "no structural changes" empty state. Minimal
  styling.
- **`SwapMetamodelDrawer.svelte`** — on entering the review step (candidate
  parsed) it acquires the lease FIRST, and only fires the diff request once
  the grant lands; on conflict it stays on the pick step showing "Metamodel
  locked by <email>" without running the diff; releases on
  close/cancel/after-success. Hosts the structural component beside the
  validation impact. The rebind 409 handling replaces the current
  `detail.includes('lock')` string-match with the structured detail: distinct
  copy for locked-by-peer (with email) vs not-quiet vs stale-rev.
- **`api/types.ts`** — zod schemas for the structural section (extending
  `MetamodelDiffSchema`). No commit-diff typing: the client has no commit-diff
  schema at all today (HistoryDrawer consumption is parked), so there is
  nothing to extend.
- **Lease acquisition is owner-gated in the drawer**: only owners can rebind,
  so only owners take the lock — an editor reviewing the read-only diff must
  not lock the owner out.
- **Quiet-predicate fix** — `realtime.svelte.ts`'s `hasModelLocks()` must
  EXCLUDE the `"mm"` resource, mirroring the backend's `is_model_resource`
  (which rebind's quiescence check uses and which already excludes `mm`).
  Today the frontend counts it, which would make the drawer's own lease
  disable its own Rebind button and flip peers' quiet-gated surfaces. The
  `mm` lease still rides the existing lock broadcast for badges/visibility.

## Error handling

House stance. Candidate parse failures stay 422 (existing). Lease conflicts
are 409 with structured holder detail. Stored-blob problems on the history
surface degrade to `metamodel: null`. The structural diff cannot block the
validation-impact section (same parsed inputs, no extra failure modes).

## Testing

- **Core** (`tests/metamodel/`): differ unit suite — identity → empty diff;
  each section (enums, element types, relationship types); add/remove carry
  full definitions; per-facet property changes; attribute changes incl. `key`
  and multiplicities; mappings add/remove; rename-as-remove+add; literal
  reordering is not a change; deterministic ordering.
- **API** (`tests/api/`, hermetic SQLite): `POST /metamodel/diff` returns the
  structural section; rebind 409-with-email on a peer `mm` lease, proceeds on
  own-or-free (quiescence check unchanged); destructive upload/clear honor
  the lease; `GET /commits/{rev}/diff` renders `metamodel` for a real rebind
  commit and `null` on the degraded paths.
- **Frontend** (vitest): lease module lifecycle (acquire on review entry,
  release on close, generation guard); locked-by rendering;
  `MetamodelStructuralDiff` component rendering incl. empty state; the
  three-way rebind-409 branch.
- No new e2e (consistent with the rest of the program).

## Out of scope

- Live metamodel editing (raw YAML + UI-assisted) — Phase 5; this spec only
  keeps its seams clean.
- Rename detection in the differ.
- Rebind revert (Phase 8, via the from/to metamodel commit columns).
- HistoryDrawer consumption of `GET /commits/{rev}/diff` (stays parked).
- Redis-mirrored locks (Phase 7).
