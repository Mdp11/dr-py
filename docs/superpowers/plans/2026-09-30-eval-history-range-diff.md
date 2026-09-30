# History Range Diff (Plan 8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The HistoryDrawer's two-revision Compare is answered by one server route, `GET /commits/diff?from=a&to=b`, which folds the journal's `entity_states` over the commits in `(a, b]`; a range the journal cannot answer is reconstructed and diffed on the server behind the same body. The drawer stops downloading models.

**Architecture:** Plan 8, the last, of sub-project C (`architecture/program.md`). Server only. Bottom-up:
1. Python: the fold, the reconstruction path and their shared renderer in a route-free module, held equal over randomized histories.
2. Python: the route, its bounds and its fallback triggers.
3. Frontend: the client function, the drawer swap, the removal of `modelAt`.
4. Documents, backlogs, the full verification.

**Tech Stack:** Python 3.14 (FastAPI, pydantic 2, SQLAlchemy 2, pytest, ruff, mypy, pyright); Svelte 5 runes, zod, vitest, Playwright; pixi for every command.

**Spec:** `docs/superpowers/specs/2026-09-30-eval-history-range-diff-design.md` (approved 2026-09-30), decisions D1–D8. It refines §6 "History range diff" of `docs/superpowers/specs/2026-09-24-evaluation-design.md`.

Read these first:
- `CLAUDE.md`, `architecture/conventions.md` (RC-6 comments, RC-10 docs with the code).
- `src/data_rover/api/README.md`: the `Commit.entity_states` paragraph and the replica tail paragraph.
- `src/data_rover/api/commit_states.py` and `src/data_rover/api/commit_diff.py` whole; they set the style of the new module.
- `frontend/README.md` before touching `frontend/src/lib/state/`.

**What kind of plan this is.** Like C's earlier plans, it gives direction with specifics: interfaces and signatures, the test cases and what each asserts, the order of the work, and the mechanisms that are easy to get wrong. It gives little full code. The expected results of "see it fail" steps are reasoned from the code, not observed. If one does not appear, trust the run, read the step's intent, and say so in the hand-back.

## What planning found

Checked against the code at `4408e0c6`. Paths without a prefix are under `src/data_rover/`.

1. **`Commit.entity_states`** (`api/db_models.py:272`, nullable JSON): `{"elements": {id: {"before": E|null, "after": E|null}}, "relationships": {id: {...}}, "recreated": {...}}`, E the JSON-mode dump of `ElementOut` (`{id, type_name, properties, rev}`) or `RelationshipOut` (plus `source_id`, `target_id`) (`api/commit_states.py:10-23`, `api/schemas.py:40-79`). `capture_entity_states` answers `None` over `ENTITY_STATES_MAX` = 5000 touched entities (`commit_states.py:39,70`). Baseline rows and rows older than the column hold none.
2. **Absent is two things in SQL.** A Python `None` in a JSON column is stored as JSON `null`, not SQL NULL. `content.commit_tail_marks` (`api/content.py:175-199`) tests `Commit.entity_states.is_not(None)` AND `cast(Commit.entity_states, String) != "null"`, and reads `(rev, flag)` as scalars without loading a JSON body.
3. **The per-commit renderer** (`api/commit_diff.py:231-254`): `_element_diffs(states)` / `_relationship_diffs(states)` over `{id: (before, after)}` of pydantic objects, iterating `sorted(states)`, into `CrElementOps` / `CrRelationshipOps` (`schemas.py:727-748`). Its `modified` test is `bo != ao`, which includes `rev`. This plan does not change it.
4. **Reconstruction** (`api/hydration.py:166-219`): `reconstruct_model_at(project_id, rev) -> Model | None`, opening its own `db_session`, `None` for a project with no `ModelRow`. `model_at_rev` (`api/routes/commits.py:695-719`) reads `head` from `content.get_model_row(db, project_id).model_rev` (0 when there is no row) and answers `JSONResponse(422, {"detail": "rev out of range", "model_rev": head})` outside `[0, head]`.
5. **Routes.** `commits.py`'s router declares `GET /commits` (`:653`), `GET /commits/{rev}/model` (`:695`), `GET /commits/{rev}/diff` (`:722`). `/commits/diff` has two segments and `/commits/{rev}/…` three, so they cannot collide today; the new route is still declared before them and a test pins it. Read routes depend on `get_request_session` (membership) and `get_db`; they take no lock and do not touch the live model.
6. **Holes.** `Session.touch_model()` bumps `model_rev` with no journal row; the legacy `POST /model/elements` and `PATCH /model/elements/{id}` call it (`api/routes/elements.py:32,58`). Reconstruction replays the journal only, so what it answers across a hole is what it answers today; this plan does not change that.
7. **Rebind rows** have `from_metamodel_id` or `to_metamodel_id` set (`commits.py:1305-1308`). `tests/api/test_commits_metamodel_ops.py` has the helpers that land one (`_acquire_mm`, `test_migration_batch_lands_atomically`).
8. **Tests to copy from.** `tests/api/test_commit_diff.py`: the `client` fixture (`:108`), `_rev`, `_lock`, `_null_states(rev)` (`:904`), `_three_commits` (`:918`), the `boom` monkeypatch of `reconstruct_model_at` (`:965-972`), the `ENTITY_STATES_MAX` monkeypatch (`:1012`). `tests/api/test_commit_model_at.py:70` shows a viewer membership. `tests/api/conftest.py`: `papi`, `AUTH_HEADERS`, `seed_default_project`, `model_rev`, `commit_create`.
9. **The drawer.** `HistoryDrawer.svelte:61-69` (`showRangeDiff`) awaits `modelAt(lo)` and `modelAt(hi)` and runs `computeDiff`; `showCommitDiff` (`:49-57`) maps `getCommitDiff`'s answer with `crToDiff({ops: {elements, relationships}})` (`state/cr.ts:261`). `modelAt` and `_modelCache` live in `state/history.svelte.ts:15,51-60,66`; `getModelAtRev` in `api/history.ts:29-32`. Nothing else in `frontend/src` calls either. `CommitDiffSchema` (`api/types.ts:894-901`) builds its two halves from `CrOpsSchema.shape`.
10. **Frontend tests.** `components/__tests__/HistoryDrawer.test.ts` mocks `$lib/state/history.svelte` (with `modelAt`, `:32`) and `$lib/api/history`; its case "the two-revision Compare still reconstructs both sides" (`:134-161`) drives Compare → Select B. `api/__tests__/history.test.ts:28-35` tests `getModelAtRev`; `state/__tests__/history.test.ts:57-62` tests the `modelAt` cache. `frontend/e2e/history.spec.ts` clicks the per-commit Diff only.
11. **Backlog.** `F-9` ("HistoryDrawer doesn't consume `GET /commits/{rev}/diff`", `BACKLOG.md:708`) is still `open` though `K-6` (`BACKLOG.md:881`) switched the drawer to it; `K-6`'s entry says "The two-revision Compare still reconstructs (O(model), deferred by design)".

## Decisions

The spec's D1–D8 hold. Planning adds:

- **P1 · The fold works on raw dicts.** It keeps, per id, the first row's raw `before` and the last row's raw `after`, and validates only the surviving pairs into `ElementOut` / `RelationshipOut`. A range that touches one entity 1,000 times validates it once.
- **P2 · One equality function serves both paths,** over pydantic objects: `type_name` and `properties` with Python `==`, plus `source_id` and `target_id` for a relationship. `rev` and `id` are not compared (D5).
- **P3 · The renderer is the new module's own,** not `commit_diff._element_diffs`: same output shape and id order, P2's equality. `commit_diff.py` is not edited.
- **P4 · The reconstruction path builds pairs only for ids that differ or exist on one side,** comparing core entities before any `ElementOut` is built, so an 80 MB model with three changes builds three pairs.
- **P5 · `can_fold` is decided from the scalar marks alone;** the JSON bodies are read only after it says yes. A row whose stored states turn out unreadable is not handled: every writer goes through `capture_entity_states`.

## Global Constraints

- Server only: nothing under `engine/`, `sandbox/` or `frontend/src/lib/engine/` changes; no golden fixture changes (`tests/golden/test_fixtures_current.py` stays green untouched).
- `GET /commits/{rev}/diff`, `GET /commits/{rev}/model`, `commit_diff.py` and `commit_states.py` keep their behaviour. Do not edit the last two.
- The fold never loads a model and never touches the live `Session`; the route takes no lock.
- `RANGE_DIFF_MAX_REVS = 1000`; the 422 body is `{"detail": "rev out of range", "model_rev": head}`; `source` is `"journal"` or `"reconstruction"`. These values are exact.
- Comments and docstrings: concise, present tense, no plan, spec or phase references, no history (RC-6). READMEs change in the commit that changes the behaviour (RC-10).
- `pixi run dr-tidy` (ruff, mypy and pyright) passes before every commit. Everything runs through pixi.
- Commit trailers name the model that wrote the commit. Never push. Fix rounds are new commits.
- Hand-backs paste real command output.

## Review Focus

1. **A range where an id is deleted and later created again** (undo of a delete restores the id). Expected: one `modified` entry, or none when it returns to the same state; never an `added` and a `deleted` for one id. Pinned in Task 1's randomized test and a named case.
2. **Values that read differently on the two paths.** The fold compares journal JSON; reconstruction compares replayed core values. `1` against `1.0`, an integer past 2^53, a nested list or dict, a property removed (`null` patch). Expected: equal answers. Pinned in Task 1's history generator, which must emit these values.
3. **A range starting at rev 0 on a project whose baseline row has no states.** `(0, b]` excludes row 0, so it folds when rows `1…b` do. Expected: `source: "journal"`. Pinned in Task 2.
4. **`from` or `to` given as text, empty or missing.** Expected: FastAPI's 422, never a 500, and never a match on `/commits/{rev}/…`. Pinned in Task 2.
5. **A failed request in the drawer.** Expected: the diff pane shows the error text and Back works, as for the per-commit diff. Pinned in Task 3.

## File Structure

| File | Change |
|---|---|
| `src/data_rover/api/range_diff.py` | Create. The fold, the reconstruction path, the renderer, `diff_range`. Route-free. |
| `src/data_rover/api/content.py` | Add `commit_range_marks`, `commit_states_between`; share the "has states" SQL expression with `commit_tail_marks`. |
| `src/data_rover/api/schemas.py` | Add `RangeDiffOut` after `CommitDiffOut`. |
| `src/data_rover/api/routes/commits.py` | Add `GET /commits/diff` above `GET /commits/{rev}/model`. |
| `src/data_rover/api/README.md` | The route; the `entity_states` paragraph's last sentence. |
| `tests/api/test_range_diff.py` | Create. Fold vs reconstruction, and the route. |
| `frontend/src/lib/api/types.ts` | Add `RangeDiffSchema`, `RangeDiff`. |
| `frontend/src/lib/api/history.ts` | Add `getCommitsDiff`; remove `getModelAtRev`. |
| `frontend/src/lib/state/history.svelte.ts` | Remove `modelAt`, `_modelCache`. |
| `frontend/src/lib/components/HistoryDrawer.svelte` | `showRangeDiff` makes one call. |
| `frontend/src/lib/{api,state,components}/__tests__/…history…` | Follow the above. |
| `frontend/e2e/history.spec.ts` | One Compare step. |
| `frontend/README.md` | The `api/history.ts` and `history.svelte.ts` listings. |
| `architecture/program.md`, `BACKLOG.md`, `BACKLOG-ENGINE.md` | C done; `F-9`, `K-6` wording; anything found. |

## Dependency order

Task 1 → Task 2 → Task 3 → Task 4. Task 3 touches no file of Tasks 1–2 but its e2e step needs the route, so it runs after Task 2. No task is suited to a separate worktree.

---

### Task 1: The fold, the reconstruction path and their equality · `critical-implementer`
*Reason: the answer's correctness rests on a fold that a plausible mistake (last `before`, a dropped recreate, `rev` in the equality) passes simple tests with; the randomized test is the oracle and must be written to catch them.*

**Files:**
- Create: `src/data_rover/api/range_diff.py`, `tests/api/test_range_diff.py`
- Modify: `src/data_rover/api/content.py` (beside `commit_tail_marks`, `:175`), `src/data_rover/api/schemas.py` (after `CommitDiffOut`, `:1190`)

**Interfaces:**
- Produces, in `content.py`:
  - `commit_range_marks(db: Session, project_id: str, *, after_rev: int, max_rev: int) -> list[tuple[int, bool, bool]]`: `(rev, has_states, is_rebind)` for `after_rev < rev <= max_rev`, ascending, scalars only.
  - `commit_states_between(db: Session, project_id: str, *, after_rev: int, max_rev: int) -> Iterator[dict[str, Any]]`: each row's raw `entity_states`, ascending by rev, selecting that column only, streamed (`execution_options(yield_per=100)`).
- Produces, in `schemas.py`:
  ```python
  class RangeDiffOut(BaseModel):
      from_rev: int
      to_rev: int
      source: Literal["journal", "reconstruction"]
      elements: CrElementOps = Field(default_factory=CrElementOps)
      relationships: CrRelationshipOps = Field(default_factory=CrRelationshipOps)
  ```
- Produces, in `range_diff.py`:
  - `RANGE_DIFF_MAX_REVS = 1000`
  - `can_fold(marks: Sequence[tuple[int, bool, bool]], from_rev: int, to_rev: int) -> bool`
  - `fold_range(db: DbSession, project_id: str, from_rev: int, to_rev: int) -> EntityStates`
  - `reconstruct_range(project_id: str, from_rev: int, to_rev: int) -> EntityStates`
  - `render_range(states: EntityStates, from_rev: int, to_rev: int, source: Literal["journal", "reconstruction"]) -> RangeDiffOut`
  - `diff_range(db: DbSession, project_id: str, from_rev: int, to_rev: int) -> RangeDiffOut`: `can_fold` over `commit_range_marks`, then the fold or the reconstruction, then `render_range`. It assumes `0 <= from_rev <= to_rev <= head`; the route checks.
  - `EntityStates` is `commit_states.EntityStates`, imported, its `recreated_*` lists left empty.

- [ ] **Step 1: The test module's scaffold.** In `tests/api/test_range_diff.py`: the `_MM` metamodel and `client` fixture as `test_commit_diff.py:26-40,108` have them, but give `Node` three properties (`label: string`, `n: integer`, `x: float`) so Review Focus 2's values are expressible; read `examples/smart-city.metamodel.yaml` for the datatype names. Helpers: `_rev(client)`, `_ops(client, ops)` posting `/model/ops` with `base_rev` and answering the response JSON, `_undo(client)`. Use `/model/ops` for every mutation: it takes no locks and journals states like `POST /commits`.
- [ ] **Step 2: Named fold cases, failing.** Each builds a short history, then calls `fold_range` and `render_range` directly (open a DB session as `_null_states` does, `test_commit_diff.py:904`). See them fail on the missing module.
  - create at r1, update at r2, update at r3, range `(0, 3]`: one `added`, its body the r3 state.
  - the same, range `(1, 3]`: one `modified`, `before` the r1 state, `after` the r3 state.
  - update then update back, range over both: empty (D5; the bodies differ in `rev` only).
  - create and delete inside the range: empty.
  - delete at r2, undo at r3 (the id returns), range `(1, 3]`: empty; then an update at r4, range `(1, 4]`: one `modified` (Review Focus 1).
  - a relationship rewired (`source_id` changed by delete and recreate under the undo path, or by an `update_relationship` if the applier offers one; read `api/routes/ops.py` for which): `modified`.
  - an element delete that cascades to a relationship: both `deleted`, each in its family.
  - `from == to`: empty, and no row read.
  - order: three adds whose ids sort differently from creation order answer in id order.
- [ ] **Step 3: `content.py`.** Lift `commit_tail_marks`'s two-clause "has states" test into a module-level expression and use it in both functions, leaving `commit_tail_marks`'s result unchanged (`tests/api/test_replica_tail.py` holds it). `commit_states_between` yields the raw value; it is called only over ranges `can_fold` accepted.
- [ ] **Step 4: `range_diff.py`, the fold.** Module docstring in `commit_diff.py`'s manner: what the fold is, when it applies, what the other path costs.
  - `can_fold`: true when `to_rev - from_rev <= RANGE_DIFF_MAX_REVS`, the marks' revs are exactly `from_rev + 1 … to_rev` in order, every `has_states` is true and no `is_rebind` is. An empty range (`from_rev == to_rev`, no marks) is true.
  - `fold_range`: two dicts per family, `first_before` and `last_after`, raw. For each row, for each id: `first_before.setdefault(id, entry["before"])`; `last_after[id] = entry["after"]`. Use `setdefault`, never assignment, for the before side: a `None` first `before` (created in range) must survive a later non-null one. Then build `EntityStates` validating only pairs where a side is non-null (P1). `recreated` is not read.
  - The mistake to avoid: deciding "created in range" from the last row. It is the FIRST row's `before` being null.
- [ ] **Step 5: The renderer.** `_same_element(b, a)` and `_same_relationship(b, a)` per P2; `render_range` iterates `sorted(states.elements)` and `sorted(states.relationships)`: both null → skip; `before` null → `added` (the `after`); `after` null → `deleted` (the `before`); both present and not same → `ModifiedElementOut` / `ModifiedRelationshipOut`. Run Step 2's cases: pass.
- [ ] **Step 6: The reconstruction path, test first.** Add cases that call `reconstruct_range` + `render_range` over Step 2's histories and expect the same `elements` and `relationships` as the fold. Then implement: `reconstruct_model_at` twice (`None` → no entities); over the union of ids per family, compare the core entities field by field with P2's fields and build a pair only when one side is missing or they differ (P4). Read `core/model/model.py` for the entity dataclasses' field names; `ElementOut.from_core` / `RelationshipOut.from_core` build the bodies.
- [ ] **Step 7: The randomized equality test.** `test_fold_equals_reconstruction_over_random_histories`, parametrized over 20 seeds with `random.Random(seed)`, 40 batches each through `/model/ops` and `/model/undo`:
  - each batch is 1–4 ops drawn from: create element (properties drawn from `label` strings, `n` in `{1, 2**53 + 1, -7}`, `x` in `{1.0, 0.5, 2.0}`), update element (a patch setting, changing or removing (`null`) one to three properties, sometimes back to an earlier value), delete element, create relationship between live elements, delete relationship; one batch in six is an undo instead;
  - then, for 15 sampled pairs `from <= to` (always including `(0, head)`, `(head, head)` and one adjacent pair): `render_range(fold_range(...))` and `render_range(reconstruct_range(...))` dumped with `model_dump(mode="json")` are equal in `elements` and `relationships`.
  - Assert per seed that the history produced at least one delete, one undo and one property removal, so a generator change cannot hollow the test.
  - If the two differ ONLY in an entity body's `rev`, stop: do not mask it. Report the seed and the pair in the hand-back; that is a finding about replay, to be logged in Task 4, and the owner decides whether the comparison may exclude `rev`.
- [ ] **Step 8: `diff_range` and its two cases.** A foldable range answers `source == "journal"` with `commit_diff`-style `boom` patched onto `range_diff.reconstruct_model_at` (import the name into the module so the patch target exists); a range whose middle row had its states nulled (`_null_states`) answers `source == "reconstruction"` and the same halves the fold gave before the nulling.
- [ ] **Step 9: Verify.** Run `pixi run -e core-dev pytest tests/api/test_range_diff.py tests/api/test_replica_tail.py tests/api/test_commit_diff.py -q` and `pixi run dr-tidy`. Expected: all pass, tidy clean. Paste both outputs in the hand-back.
- [ ] **Step 10: Commit** with the message `Fold a revision range's entity states into one diff`.

### Task 2: The route · `implementer`

**Files:**
- Modify: `src/data_rover/api/routes/commits.py` (insert above `model_at_rev`, `:695`; imports at `:51`, `:93`), `src/data_rover/api/README.md`
- Test: `tests/api/test_range_diff.py`

**Interfaces:**
- Consumes: `range_diff.diff_range(db, project_id, from_rev, to_rev) -> RangeDiffOut`; `range_diff.RANGE_DIFF_MAX_REVS`; `schemas.RangeDiffOut`.
- Produces: `GET /commits/diff?from=<int>&to=<int>` → 200 `RangeDiffOut` JSON, or 422.

- [ ] **Step 1: Route tests, failing** (404 or 405 until the route exists). Through `client.get(papi("/commits/diff"), params={"from": a, "to": b})`:
  - a foldable range: 200, `from_rev`, `to_rev`, `source == "journal"`, the expected halves; `reconstruct_model_at` patched to raise is never called.
  - `(0, b]` on a project whose rev-0 row has no states: `source == "journal"` (Review Focus 3). Check what the fixture's `POST /model` leaves at rev 0 and say so in the hand-back.
  - each fallback trigger answers 200 with `source == "reconstruction"` and halves equal to `render_range(reconstruct_range(...))` called directly:
    - a row's states nulled (`_null_states`);
    - an over-cap batch (`monkeypatch.setattr(commit_states, "ENTITY_STATES_MAX", 1)` before a two-create batch, as `test_commit_diff.py:1012`);
    - a hole: a legacy `POST /model/elements` between two `/model/ops` batches (read `routes/elements.py:20-33` for its body); assert first that `commit_range_marks` shows the missing rev;
    - a rebind in range, landed as `tests/api/test_commits_metamodel_ops.py::test_migration_batch_lands_atomically` does (import its helpers as `test_commit_diff.py:24` does);
    - a range over the cap: `monkeypatch.setattr(range_diff, "RANGE_DIFF_MAX_REVS", 2)` and a range of three revs.
  - `from == to`: 200, both halves empty, `source == "journal"`.
  - 422 with `{"detail": "rev out of range", "model_rev": head}` for `from > to`, `from < 0`, `to > head`.
  - FastAPI's 422 for a missing `from`, a missing `to`, `from=abc`, `to=` (Review Focus 4).
  - a viewer member reads it (copy the membership setup of `tests/api/test_commit_model_at.py:70`); a non-member does not (the status the sibling history routes give).
  - `GET /commits/diff` with valid params is not answered by `/commits/{rev}/diff` or `/commits/{rev}/model`: the body has `source`.
- [ ] **Step 2: The route.**
  ```python
  @router.get("/commits/diff", response_model=None)
  def commits_range_diff(
      project_id: str,
      from_rev: int = Query(alias="from"),
      to_rev: int = Query(alias="to"),
      session: Session = Depends(get_request_session),
      db: DbSession = Depends(get_db),
  ) -> RangeDiffOut | JSONResponse:
  ```
  Read `head` as `model_at_rev` does; refuse unless `0 <= from_rev <= to_rev <= head` with its body; else `return diff_range(db, project_id, from_rev, to_rev)`. Docstring: a read for any member; O(entities touched) when the journal answers, two reconstructions otherwise; no lock. Import `Query` from `fastapi`.
- [ ] **Step 3: Run** `pixi run -e core-dev pytest tests/api/test_range_diff.py -q`. Expected: all pass.
- [ ] **Step 4: README** (`src/data_rover/api/README.md`). In the `Commit.entity_states` paragraph, replace the last sentence ("The frontend's per-commit Diff calls this route; its two-revision Compare still uses `GET /commits/{rev}/model`, which stays O(model) by design.") with the current behaviour: the per-commit Diff calls `GET /commits/{rev}/diff`; the two-revision Compare calls `GET /commits/diff?from=&to=`, which folds the states of the rows in `(from, to]` (`api/range_diff.py`: first `before`, last `after`, equality ignoring `rev`, id order) and reconstructs both revisions on the server when a row in range has no states, is a rebind, is missing, or the range exceeds `RANGE_DIFF_MAX_REVS` = 1,000; `source` says which; `GET /commits/{rev}/model` remains, with no frontend caller.
- [ ] **Step 5: Tidy, run** `pixi run core-test`, paste the tail, **commit** with the message `Answer a history range diff from the journal`.

### Task 3: The drawer · `implementer`

**Files:**
- Modify: `frontend/src/lib/api/types.ts` (after `CommitDiffSchema`, `:902`), `frontend/src/lib/api/history.ts`, `frontend/src/lib/state/history.svelte.ts`, `frontend/src/lib/components/HistoryDrawer.svelte:1-69`, `frontend/README.md:3164-3167,3230-3232`
- Test: `frontend/src/lib/api/__tests__/history.test.ts`, `frontend/src/lib/state/__tests__/history.test.ts`, `frontend/src/lib/components/__tests__/HistoryDrawer.test.ts`, `frontend/e2e/history.spec.ts`

**Interfaces:**
- Consumes: `GET /commits/diff?from=&to=` → `{from_rev, to_rev, source, elements, relationships}`.
- Produces:
  ```ts
  export const RangeDiffSchema = z.object({
  	from_rev: z.number().int(),
  	to_rev: z.number().int(),
  	source: z.enum(['journal', 'reconstruction']),
  	elements: CrOpsSchema.shape.elements,
  	relationships: CrOpsSchema.shape.relationships
  });
  export type RangeDiff = z.infer<typeof RangeDiffSchema>;
  ```
  and `getCommitsDiff(fromRev: number, toRev: number, cfg?: ClientConfig): Promise<RangeDiff>` in `api/history.ts`, calling `apiFetch('/commits/diff', { method: 'GET', query: { from: fromRev, to: toRev }, schema: RangeDiffSchema }, cfg)`.

- [ ] **Step 1: Client test, failing.** In `api/__tests__/history.test.ts` replace the `getModelAtRev` case with `getCommitsDiff hits /commits/diff with from and to`: the captured path contains `/commits/diff`, `from=1` and `to=4`; the parsed answer's `elements.added` ids and `source` are as given; a body with `source: 'other'` rejects.
- [ ] **Step 2: Implement** the schema and `getCommitsDiff`; delete `getModelAtRev` and its `ModelOutSchema` / `ModelOut` imports if nothing else in the file uses them. Run `pixi run frontend-test -- src/lib/api/__tests__/history.test.ts` (if the task rejects the path argument, run `pixi run frontend-test` and read that file's lines). Expected: pass.
- [ ] **Step 3: Drawer test, failing.** In `HistoryDrawer.test.ts`: add `getCommitsDiff: vi.fn()` to the `$lib/api/history` mock, remove `modelAt` from the `$lib/state/history.svelte` mock and from the import (`:57`), drop the `expect(modelAt).not.toHaveBeenCalled()` line (`:129`). Rewrite the Compare case as `the two-revision Compare asks the server for the range`: `getCommitsDiff` resolves `{from_rev: 1, to_rev: 2, source: 'journal', elements: {added: [e1], modified: [], deleted: []}, relationships: {…empty}}`; after Compare → Select B, `getCommitsDiff` was called once with `(1, 2)`, `getCommitDiff` not at all, and the page shows `+1 added`. Add `a failed range diff shows its error`: `getCommitsDiff` rejects with `new Error('boom')`; the page shows `boom` and the Back button returns to the list (Review Focus 5).
- [ ] **Step 4: The drawer.** `showRangeDiff` becomes:
  ```ts
  // Two revisions: the server folds the journal over the range, or
  // reconstructs both sides itself when the journal cannot answer.
  async function showRangeDiff(fromRev: number, toRev: number): Promise<void> {
  	beginDiff(`r${fromRev} → r${toRev}`, spanCrossesRebind(fromRev, toRev));
  	try {
  		const d = await getCommitsDiff(fromRev, toRev);
  		diff = crToDiff({ ops: { elements: d.elements, relationships: d.relationships } });
  	} catch (e) {
  		diffError = e instanceof Error ? e.message : 'Failed to load diff';
  	}
  }
  ```
  Remove the `modelAt` and `computeDiff` imports (keep `type Diff`). `computeDiff` itself stays in `state/diff.ts`.
- [ ] **Step 5: The store.** In `state/history.svelte.ts` remove `modelAt`, `_modelCache`, its `clear()` in `resetHistory`, the `SvelteMap`, `getModelAtRev` and `ModelOut` imports, and the cache clause of the header comment. In `state/__tests__/history.test.ts` remove the `modelAt` case and the `getModelAtRev` mock and imports. Confirm nothing else uses them: `grep -rn "modelAt\|getModelAtRev" frontend/src frontend/e2e` answers nothing.
- [ ] **Step 6: e2e.** In `frontend/e2e/history.spec.ts`, after the step that returns to the list, add: click `Compare` on the newest row, `Select B` on an older one, and expect the drawer to show `/added|modified|deleted/i`; assert through `page.waitForResponse` that one `GET …/commits/diff?` answered 200 and that no request to `/commits/\d+/model` was made (collect with `page.on('request')`). Read the spec's earlier steps for its locators and the button labels in `HistoryDrawer.svelte`.
- [ ] **Step 7: README** (`frontend/README.md`): `api/history.ts` lists `getCommitHistory`, `getCommitDiff` (`GET /commits/{rev}/diff`), `getCommitsDiff` (`GET /commits/diff`) and `revertToCommit`; `history.svelte.ts` is the commit-list store with `resetHistory/loadFirstPage/loadMore`, no reconstruction cache.
- [ ] **Step 8: Verify.** Run `pixi run frontend-test`, `pixi run frontend-check`, `pixi run dr-tidy`, then `pixi run frontend-test-e2e` (stop any stale sandbox `vite preview` first). Expected: vitest green but for the known `K-91` timeout if it appears (it passes alone); e2e green but for the known `T-9`. Paste the tails.
- [ ] **Step 9: Commit** with the message `Ask the server for the history drawer's range diff`.

### Task 4: Documents, backlogs, the full run · `implementer`

**Files:**
- Modify: `architecture/program.md:14`, `BACKLOG.md` (`F-9` at `:708`, `K-6` at `:881`, the `R-2` text if it names the range diff), `BACKLOG-ENGINE.md` (the `R-3` status lines that say "plan 8 remains")

- [ ] **Step 1: `architecture/program.md`.** C's row: status `done — eight plans built`; replace the closing "plan 8 remains" with plan 8's clause in the row's own manner: the history drawer's two-revision Compare is answered by `GET /commits/diff`, a fold of the journal's entity states over `(from, to]` in O(entities touched), reconstructed on the server when a row has no states, is a rebind, is missing, or the range exceeds 1,000 revs; held equal to the diff of two reconstructions over randomized histories; server only, no engine surface. No measurement is claimed: none was taken.
- [ ] **Step 2: Backlogs.** Grep for the next free ids first (`grep -n "K-9[0-9]\|T-1[0-9]" BACKLOG.md BACKLOG-ENGINE.md`; K ids are unique across both files).
  - `F-9` → `done`, closed by `K-6` (the per-commit Diff) and this plan (Compare), dated today.
  - `K-6`'s "The two-revision Compare still reconstructs" sentence gains its ending: Compare now folds the journal (`GET /commits/diff`).
  - `grep -n "plan 8" BACKLOG.md BACKLOG-ENGINE.md architecture/*.md` and bring each hit to the present.
  - Log, with a new id each, anything Tasks 1–3 reported and did not fix: a `rev` mismatch between the fold and replay (Task 1 Step 7), what reconstruction answers across a `touch_model` hole if Task 2 showed it surprising.
- [ ] **Step 3: README check.** Re-read the two README edits of Tasks 2 and 3 against the merged code; fix drift. `grep -rn "commits/{rev}/model" src/data_rover/api/README.md frontend/README.md` leaves no sentence saying the frontend calls it.
- [ ] **Step 4: The full run.** `pixi run dr-test`, `pixi run dr-tidy`, `pixi run frontend-test-e2e`. Expected: pytest, engine and sandbox green; frontend green but for `K-91` if it appears; e2e green but for `T-9`; `T-4` may flake. Any other failure is this plan's: fix it or report it, do not dismiss it. Paste each tail in the hand-back.
- [ ] **Step 5: Commit** with the message `Close sub-project C with the history range diff`.

## After the last task

One `branch-reviewer` over `engine-migration..feat/eval-history-range-diff`, then the owner decides the merge. Nothing is pushed or fast-forwarded without the owner's word.
