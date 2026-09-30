# Evaluation, plan 8: history range diff — design

Refines §6 "History range diff — plan 8 (server only)" of `2026-09-24-evaluation-design.md`
(the binding program-level spec for C) for its eighth and last plan. Where this document is
silent, that spec holds. Approved in conversation with the owner on 2026-09-30.

## Goal

The HistoryDrawer's two-revision Compare is answered by one server route,
`GET /commits/diff?from=a&to=b`, which folds the journal's `entity_states` over the commits in
`(a, b]` in O(entities touched). The drawer no longer downloads a model: a range the journal
cannot answer is reconstructed and diffed on the server, behind the same route and the same
body.

## Non-goals

- Any engine work: no port, no golden family, no surface switch, no shadow (owner's decision;
  the replica holds no journal).
- Artifacts, views, metamodel and layout in the range answer. The range diff is the model half
  only, as `computeDiff` over two models is today.
- Paging the answer. It is unpaged, as today's diff is.
- Changing `GET /commits/{rev}/diff`, its equality included.
- Removing `GET /commits/{rev}/model`. The route stays; only its frontend callers go.
- Making the reconstruction path cheaper.

## What the code says today

- **Journal states.** `Commit.entity_states` (`api/db_models.py:272`) is
  `{elements: {id: {before, after}}, relationships: {...}, recreated: {...}}`, full `ElementOut`
  / `RelationshipOut` on each side, `null` for "did not exist" (`api/commit_states.py:10-23`).
  Every journal writer captures it (`POST /commits`, `/commits/revert`, `/model/ops`,
  `/model/undo`). It is absent on rows older than the column, on baseline rows, and on a batch
  touching more than `ENTITY_STATES_MAX` = 5,000 entities (`commit_states.py:39,70`). A Python
  `None` is stored as JSON `null`, not SQL NULL, so "absent" is
  `IS NULL OR CAST(... AS VARCHAR) = 'null'` (`api/content.py:175-199`).
- **One commit's diff.** `GET /commits/{rev}/diff` (`api/routes/commits.py:722`) calls
  `commit_diff.diff_commit` (`api/commit_diff.py:476`), which loads the row's states
  (`load_entity_states`) or reconstructs rev-1 and rev, and renders both through
  `_element_diffs` / `_relationship_diffs` (`commit_diff.py:231-254`): `CrElementOps` /
  `CrRelationshipOps`, each of `added`, `modified`, `deleted` in id order. There, `modified` is
  `before != after` on the whole pydantic object, `rev` included.
- **A model at a revision.** `GET /commits/{rev}/model` (`commits.py:695`) answers 422
  `{"detail": "rev out of range", "model_rev": head}` outside `[0, head]`, else
  `reconstruct_model_at` (`api/hydration.py:166`): the latest snapshot at or below `rev` plus a
  replay of the tail, under the metamodel effective at `rev`, `strict=False`. O(model); it reads
  durable content only and takes no session lock.
- **Revisions.** A revision is the project's integer `model_rev`; the journal is linear, one row
  per rev (`Commit` PK `(project_id, rev)`). `touch_model` / `set_model` advance `model_rev`
  with no journal row, so a range can hold a rev with no row. A rebind row has
  `from_metamodel_id` or `to_metamodel_id` set.
- **The replica tail's pre-check.** `content.commit_tail_marks` reads `(rev, expressible)` for a
  range as scalar SQL, no JSON body loaded; `replica.TAIL_MAX_REVS` = 1,000
  (`api/replica.py:25`).
- **The drawer.** `HistoryDrawer.showRangeDiff` (`frontend/src/lib/components/HistoryDrawer.svelte:61-69`)
  awaits `modelAt(lo)` and `modelAt(hi)` (`state/history.svelte.ts:53`, a per-rev cache over
  `getModelAtRev`, `api/history.ts:30`) and runs `computeDiff` (`state/diff.ts:26`). The
  per-commit path, `showCommitDiff`, already maps a server answer with `crToDiff`
  (`state/cr.ts:261`), which derives `modifiedFields` itself. `pickCompare` always calls with
  `lo < hi`. Nothing else in the frontend calls `modelAt` or `getModelAtRev`.
- **`computeDiff`'s equality.** An entity is `modified` when its properties differ (deep
  equality), or, for a relationship, its `source_id` or `target_id`. `rev` and `type_name` are
  not compared. Its order is the newer model's order, then the deleted ones.

## Decisions

- **D1 · Fallback on the server.** A range the journal cannot answer is reconstructed and
  diffed by the route itself; the body is the same and the status 200. The drawer has one path.
- **D2 · A rebind in range reconstructs.** A row in `(from, to]` with either metamodel column
  set sends the range to reconstruction; the fold is never held equal to reconstruction across
  a schema swap.
- **D3 · The fold is capped at 1,000 revs.** `to - from > 1000` reconstructs. The bound is the
  replica tail's; the fold gets its own constant, `RANGE_DIFF_MAX_REVS`.
- **D4 · Server only.** See Non-goals.
- **D5 · Equality ignores `rev`.** A pair is `modified` when `type_name` or `properties`
  differ, or, for a relationship, `source_id` or `target_id`. An entity edited and edited back
  inside the range drops out, as under `computeDiff`. The per-commit route keeps its own
  equality.
- **D6 · Order is the per-commit diff's:** `added`, `modified`, `deleted`, each sorted by id.
  The drawer's range rows change order (today: model order, which the journal cannot give).
- **D7 · Bounds.** `0 <= from <= to <= head`, else 422 with `model_at_rev`'s body. `from == to`
  is an empty diff. Both parameters are required integers.
- **D8 · Any member may read it,** as every history read.

## The route

`GET /commits/diff?from=a&to=b`, on the router of `api/routes/commits.py` beside the other
history routes, declared before the `/commits/{rev}/...` routes so that `diff` is never parsed as a rev. The
query names are `from` and `to` (aliases; `from` is a Python keyword). Dependencies are
`get_request_session` and `get_db`, as `commit_diff_endpoint` has. `head` is the model row's
`model_rev` read from the database, as `model_at_rev` reads it; the live session is not
touched and no lock is taken.

Answer, `RangeDiffOut` in `api/schemas.py`:

```
{from_rev: int, to_rev: int,
 source: "journal" | "reconstruction",
 elements: CrElementOps, relationships: CrRelationshipOps}
```

`source` says which path answered. The drawer does not show it; tests and a later reader of a
slow request do.

## The fold — `api/range_diff.py`

Route-free, as `commit_diff.py` is: functions over a `DbSession`, a project id and two revs.

1. **Pre-check**, scalar SQL over `(from, to]`, no JSON body loaded: a query beside
   `commit_tail_marks` in `content.py` answering `(rev, has_states, is_rebind)` per row. The
   range folds when `to - from <= RANGE_DIFF_MAX_REVS`, the rows are exactly the revs
   `from+1 … to` (no hole), every row has states, and none is a rebind. `from == to` folds
   trivially to the empty answer.
2. **Fold.** Read `(rev, entity_states)` only, ascending, in chunks of rows (the query yields
   per chunk; the whole range's JSON is never held at once beyond what the fold keeps). Per
   family, per id: keep the `before` of the first row that names the id and the `after` of the
   last. Raw dicts are folded; only the surviving pairs are validated into `ElementOut` /
   `RelationshipOut`.
3. **Render.** A pair with both sides null drops out (created and deleted inside the range).
   `before` null → `added`; `after` null → `deleted`; both present → `modified` when D5's
   equality says they differ, else dropped. Id order (D6).

`recreated` is not read: a delete-then-create of one id inside a range is a first `before` and
a last `after` like any other.

**Reconstruction path.** `reconstruct_model_at(project_id, from)` and `(..., to)`, a `None`
model read as empty. The two are compared id by id with D5's equality and only differing pairs
are built into `ElementOut` / `RelationshipOut`, then rendered by the same step 3. Cost and
heap are `GET /commits/{rev}/model`'s, twice, as the drawer causes today; nothing is
serialized whole.

Both paths share one renderer, so their bodies differ only in `source`.

## Frontend

- `api/types.ts`: `RangeDiffSchema` (`from_rev`, `to_rev`, `source`, `elements`,
  `relationships`, the last two from `CrOpsSchema.shape`).
- `api/history.ts`: `getCommitsDiff(fromRev, toRev, cfg?)`; `getModelAtRev` is removed.
- `state/history.svelte.ts`: `modelAt` and `_modelCache` are removed.
- `HistoryDrawer.showRangeDiff`: one `getCommitsDiff(lo, hi)`, mapped with `crToDiff`, as
  `showCommitDiff` does. Title, rebind notice and error state are unchanged. `computeDiff`
  stays in `state/diff.ts` for its other callers; the drawer stops importing it.

## Tests

- **Python, fold vs reconstruction** (`tests/api/test_range_diff.py`, `client` fixture):
  seeded random histories through the real routes (creates, updates, deletes of elements and
  relationships, an edit-and-edit-back, a create-and-delete inside the range, a
  delete-then-recreate of one id, `/model/ops` and `/model/undo` rows among the commits); for
  sampled `(from, to)` pairs the fold's answer equals the reconstruction path's, `source`
  aside. The test calls both functions directly, so a range that would fold is also
  reconstructed.
- **Python, route:** each fallback trigger answers `source: "reconstruction"` with the right
  diff — a row with null states, an over-cap batch, a rev with no row (`touch_model`), a
  rebind in range, a range over the cap (the constant monkeypatched low); a foldable range
  answers `source: "journal"` and calls no reconstruction; `from == to` is empty; the four
  bound violations and a missing parameter are 422; a viewer may read; `/commits/diff` is not
  routed to `/commits/{rev}/...`.
- **Frontend:** `api/__tests__/history.test.ts` gains `getCommitsDiff` and loses
  `getModelAtRev`; `state/__tests__/history.test.ts` loses the `modelAt` cache case;
  `HistoryDrawer.test.ts`'s range case asserts one `getCommitsDiff(lo, hi)` and the rendered
  rows.
- **e2e:** the existing history spec stays green; no new spec.

No benchmark gate: the fold reads rows the per-commit diff already reads, and the
reconstruction path is today's cost.

## Documents

In the same commits as the behaviour (RC-10): `src/data_rover/api/README.md` (the
`entity_states` paragraph: Compare now uses the range route; the route itself),
`frontend/README.md` (the history API and state listings), `architecture/program.md` (C:
plans 1–8 of 8 built, done), `BACKLOG.md` / `BACKLOG-ENGINE.md` (close what this closes; log
anything found and not fixed, next free ids grepped first).

## Done when

- The drawer's two-revision Compare makes one request and no `GET /commits/{rev}/model`.
- The fold equals reconstruction over the randomized histories.
- Every fallback trigger is answered by reconstruction behind the same body.
- `pixi run dr-test` and `pixi run dr-tidy` are green, the known flakes (K-91, T-4) aside; the
  e2e history spec is green.
