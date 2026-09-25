# Phase 6B — Metamodel Swap (sandbox diff + non-destructive rebind) — Design

**Date:** 2026-06-22
**Status:** Design approved → spec review → implementation planning
**Scope:** Backend only. Frontend UI (diff-review panel, rebind confirmation) deferred
to a follow-up spec.
**Parent design:** `docs/superpowers/specs/2026-06-16-multi-user-collaborative-architecture-design.md`
(§5 "Metamodel swap", §7 commit flow, §9 validation tiers, §12 phase table row 6, §13 open questions).

---

## 1. Problem & goal

Phase 6A delivered the metamodel-driven connection-rules picker (frontend). Phase 6B
delivers the **metamodel-swap** half of Phase 6: let a user test a *candidate* metamodel
against the live model, then adopt it — **without destroying the model or its history**.

Two capabilities:

1. **Read-only sandbox conformance diff.** Run a second validation pipeline bound to a
   candidate metamodel over the *same live in-memory model* — no copy of the ~80 MB
   payload, no resource lock, not journaled — and return a conformance diff
   (`now_failing[]`, `now_passing[]`, `unchanged_count`).
2. **Non-destructive journaled rebind.** Change the model's `metamodel_id` as a normal
   commit (in history, revertible later). The rebind **may land with outstanding
   conformance issues** — the engine "stays inspectable" (§9). This **supersedes** the
   current destructive `session.set_metamodel()` / `POST /metamodel`, which clears the
   model and wipes history (a single-user assumption; see the TODO in
   `routes/metamodel.py`).

Non-goals (explicitly out of scope, per §13/§14): editable sandbox branch, assisted
migration transforms, rename detection, project-wide lease machinery, strict mode,
revert-to-commit wiring (Phase 8), and any frontend.

---

## 2. Decisions (from brainstorming)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Backend only.** | Smallest testable unit; frontend is a separate spec. |
| 2 | **"Instance of unknown type" is a CONFORMANCE issue** (new check). | The headline use case is a candidate that removes/renames a type; treating that as STRUCTURAL would hard-block the very experiment rebind exists for. Reconciles §9's literal wording with §5's "stays inspectable". Currently *unimplemented* (such elements validate silently), so this is a free choice. |
| 3 | **Sandbox diff = no-copy `Model` view + `write_mutex`.** | Shares the element/relationship dicts by reference (never copies 80 MB); validators read `model.metamodel`, so the view reports the candidate. Held under the per-project `write_mutex` because the pipeline iterates the dicts and a concurrent commit would otherwise mutate them mid-iteration. |
| 4 | **Rebind journaled via dedicated commit columns** (`from_metamodel_id`/`to_metamodel_id`), empty `ops`. | Hydration already derives the metamodel from `ModelRow.metamodel_id` (not from replaying ops), and restore-mode replay is metamodel-independent — so no core/op-union/applier changes are needed. Revert (Phase 8) reads the columns. |
| 5 | **`POST /metamodel` becomes initial-bind-only.** | The destructive clear only ever mattered when a model existed — exactly rebind's case. On a non-empty model it 409s pointing at `/metamodel/rebind`; on an empty/contentless project it still performs the initial bind. |
| 6 | **Rebind is owner-only and refuses when any lease is active.** | A rebind re-types the whole model; it shouldn't silently invalidate a concurrent editor's open check-out. Treats rebind as a quiet-moment admin op without pulling forward §14's project-wide lease machinery. |

---

## 3. Architecture — units & boundaries

### 3.1 Core: no-copy rebind view (`core/model/model.py`)

New function `build_rebind_view(live_model: Model, candidate: Metamodel) -> Model`:

- Constructs `Model(candidate)`, then assigns `view.elements = live_model.elements` and
  `view.relationships = live_model.relationships` **by reference** (the heavy payload is
  never copied), and **rebuilds a fresh `IndexSet`** over them
  (`view.indexes = IndexSet(view); view.indexes.rebuild()`).
- **Why rebuild the index, not share it:** `IndexSet` is metamodel-derived — it
  precomputes per-type containment flags (`_is_containment`) and groups uniqueness keys
  from the metamodel's effective key specs. Sharing the live index would yield wrong
  containment/uniqueness diffs for any candidate that changes those. Rebuild is
  `O(elements + relationships)` and allocates only index structures (not the element
  payload).
- **Contract:** the returned view is **read-only**. It shares the live model's dicts;
  mutating it would corrupt the live model. Docstring states this in the load-bearing
  style of the surrounding code.

### 3.2 Core: "instance of unknown type" CONFORMANCE check (`validation/validators/type_conformance.py`)

In `TypeConformanceValidator`:
- `validate_element`: if `model.metamodel.element_type(el.type_name) is None` →
  `Issue(Severity.ERROR, "<id> is an instance of unknown type '<T>'", [el.id],
  IssueCategory.CONFORMANCE)` and skip the property checks for that element.
- `validate_relationship`: same against `relationship_type(rel.type_name)`.

Cannot arise in normal editing (the `Model` mutation boundary rejects unknown types at
create), so it adds **zero** issues to existing conforming models — it only surfaces under
a type-removing candidate (diff) or after a type-removing rebind. Abstract-instance
detection is **not** added (YAGNI; existing behaviour unchanged).

### 3.3 API: sandbox diff (`routes/metamodel_swap.py`)

`POST /api/v1/projects/{project_id}/metamodel/diff`
- Auth: `require_membership` (any role — read-only, mutates nothing).
- Body: candidate metamodel blob (YAML, or JSON via `content-type`), parsed exactly like
  `upload_metamodel` (`load_metamodel_str`; **422** on invalid metamodel).
- Under `session.write_mutex`:
  1. `current = _ensure_validation_seeded(session, model).all_issues()` — the seeded full
     baseline's issue set (current metamodel). `ValidationState.all_issues()` returns the
     complete stored list; `.counts()` feeds `RebindResponse.issue_counts`.
  2. `candidate_issues = default_pipeline().validate(build_rebind_view(model, candidate),
     Scope.all())`.
  3. Diff by a stable **issue key** =
     `(category, severity, message, tuple(sorted(target_ids)))`:
     - `now_failing` = keys in candidate but not current
     - `now_passing` = keys in current but not candidate
     - `unchanged_count` = size of the key intersection
- Returns `MetamodelDiffResponse`.

> **Issue identity note.** `Issue` carries no stable code, so the tuple above is the
> pragmatic identity. Messages embed ids/values, so an issue that merely *changes wording*
> for the same entity will read as one `now_passing` + one `now_failing`. Acceptable for a
> diagnostic diff; a structured issue code is a possible later refinement.

### 3.4 API: rebind (`routes/metamodel_swap.py`)

`POST /api/v1/projects/{project_id}/metamodel/rebind`
- Auth: `require_owner` (**403** for editor/viewer).
- Body: candidate metamodel blob. `base_rev` (int) and `message` (str, default "") as
  **query params** — the raw body is reserved for the blob, matching the upload
  convention; no JSON envelope.
- Stale `base_rev != session.model_rev` → **409** (before the mutex), mirroring
  preview/commit.
- Under `session.write_mutex`:
  1. **Refuse if locks active:** `session.lock_table.active_leases(time.monotonic())`
     non-empty → **409** `{"detail": "active locks; rebind requires a quiet project"}`.
  2. Parse candidate (`load_metamodel_str`; **422** on invalid).
  3. Persist a new `MetamodelRow` (`content.create_metamodel`, `version` = prior + 1 or 1).
  4. **Swap in memory:** `old_mm = session.metamodel`; `session.metamodel = candidate`;
     `session.model.metamodel = candidate`.
  5. **Full re-validation** (dirty set = whole model): rebuild the model's index against
     the new metamodel (`session.model.indexes.rebuild()` — containment/uniqueness change
     with the metamodel), then
     `state.set_full(default_pipeline().validate(model, Scope.all()))`; count CONFORMANCE
     issues.
  6. `session.model_rev += 1`.
  7. **Durable** (mirrors the commit route's 500-rollback pattern):
     `content.upsert_model_row(metamodel_id=new_id)`,
     `content.set_model_rev(rev)`,
     `content.append_commit(rev, commit_id, author_id, ops=[], inverse_ops=[], id_map={},
     from_metamodel_id=old_id, to_metamodel_id=new_id, message=message,
     validation_error_count=count, issues=conformance_json)`, `db.commit()`.
     On DB failure → restore `session.metamodel`/`model.metamodel`/`model_rev`/baseline
     and rebuild the index back, `db.rollback()`, **500**.
  8. **Force a snapshot** at the new rev (`write_snapshot`) so the replay tail never spans
     a rebind boundary and the project survives eviction.
  9. **Broadcast** `rebind_event(rev, from_metamodel_id, to_metamodel_id,
     validation_error_count)` (new fifth feed builder) inside the mutex — semantically
     "whole model retyped, reload."
- Returns `RebindResponse`.

> **`old_id` for the rollback / `from_metamodel_id`.** Read the prior `metamodel_id` from
> the `ModelRow` (or `session`'s prior MetamodelRow id) before step 4. A brand-new initial
> bind has no prior id → `from_metamodel_id = None`.

### 3.5 API: initial-bind guard (`routes/metamodel.py`)

`upload_metamodel` (`POST /metamodel`): if `session.model is not None and
session.model.elements` (model has content) → **409** `{"detail": "model not empty; use
/metamodel/rebind"}`. Otherwise initial-bind as today. `set_metamodel`'s destructive
semantics remain only for the genuinely-empty case (nothing to destroy). `clear_metamodel`
(`DELETE /metamodel`) is left unchanged (out of scope).

---

## 4. Data model & schema changes

### 4.1 Alembic 0004 — commit metadata columns

Add to `commits`:
- `from_metamodel_id VARCHAR NULL` FK → `metamodels.id` `ON DELETE SET NULL`
- `to_metamodel_id   VARCHAR NULL` FK → `metamodels.id` `ON DELETE SET NULL`

Update `db_models.Commit` (two nullable `mapped_column`s + relationships optional) and
`content.append_commit` (two new optional kwargs defaulting `None`; **existing callers
unaffected**).

### 4.2 Pydantic schemas (`schemas.py`)

```python
class MetamodelDiffResponse(BaseModel):
    now_failing: list[IssueOut]
    now_passing: list[IssueOut]
    unchanged_count: int
    current_error_count: int
    candidate_error_count: int

class RebindResponse(BaseModel):
    model_rev: int
    metamodel_id: str
    validation_error_count: int
    issue_counts: dict[str, int]
    issues: list[IssueOut]      # conformance issues on the rebound model
```

No `RebindRequest` / `DiffRequest` — metadata rides query params; the blob is the raw body.

### 4.3 Feed (`feed.py`)

New builder `rebind_event(rev, from_metamodel_id, to_metamodel_id,
validation_error_count) -> dict` (fifth alongside snapshot/commit/lock/presence). Plain
dict serialized by `ws.send_json`. Broadcast hook site: the rebind route, inside the
mutex (enqueue order == rev order).

---

## 5. Concurrency & correctness invariants

- **Diff and rebind both hold `write_mutex`** for the validation pass — prevents
  "dict changed size during iteration" against a concurrent commit; matches preview/commit.
- **Diff never mutates the live model.** It builds a read-only view sharing the dicts and
  rebuilding indexes; the live model and its baseline are untouched.
- **Rebind mutates the live model's metamodel pointer + index + baseline**, all under the
  mutex, with a full in-memory restore on durable-write failure.
- **Never share the live `IndexSet`** with the view (metamodel-derived containment +
  uniqueness). The diff view rebuilds its own; the rebind rebuilds the live index in place.
- **Hydration is unchanged** and correct across a rebind: it loads the metamodel from
  `ModelRow.metamodel_id` (latest) and replays the (empty-ops) rebind commit as a no-op;
  the forced snapshot means the tail never crosses a rebind boundary anyway.
  *(Footnote, Phase 6C: "unchanged" refers to hydration's replay/snapshot logic, not its
  strictness — hydration loads under `strict=False`, so it tolerates instances of unknown
  types introduced by a type-removing rebind rather than rejecting them. See Decision #2 /
  the unknown-type CONFORMANCE check.)*
- **Eviction guard** already refuses while leases are live or clients connected; the rebind
  forces a snapshot so an evicted-then-rehydrated project reflects the new metamodel.

---

## 6. Error responses (summary)

| Endpoint | Code | Condition |
|----------|------|-----------|
| `POST /metamodel/diff` | 422 | invalid candidate metamodel |
| `POST /metamodel/diff` | 403 | non-member |
| `POST /metamodel/rebind` | 403 | not owner |
| `POST /metamodel/rebind` | 409 | stale `base_rev` |
| `POST /metamodel/rebind` | 409 | active locks present |
| `POST /metamodel/rebind` | 422 | invalid candidate metamodel |
| `POST /metamodel/rebind` | 500 | durable-write failure (in-memory fully rolled back) |
| `POST /metamodel` | 409 | model not empty (use rebind) |

---

## 7. Testing (heaviest coverage — §12 mandate)

Mirror into `tests/<area>/`. API tests use the `client` fixture +
`seed_default_project`/`AUTH_HEADERS`/`papi` helpers (in-memory SQLite).

**Core — `tests/model/`, `tests/validation/`:**
- `build_rebind_view` shares element/relationship dicts (identity) and rebuilds a fresh
  index; validating the view leaves the live model + its index untouched.
- Unknown-type CONFORMANCE check: fires for an element whose type the metamodel omits;
  fires for a relationship likewise; silent when the type is present; never STRUCTURAL.

**Diff — `tests/api/`:**
- now_failing / now_passing / unchanged across candidates that: add a required property,
  tighten a facet, narrow a datatype, remove an element type, change a relationship's
  containment flag, change a uniqueness key.
- Identical metamodel → empty `now_failing`/`now_passing`, `unchanged_count` == issue count.
- `current_error_count` / `candidate_error_count` correct.
- 422 invalid candidate; 403 non-member.

**Rebind — `tests/api/`:**
- Happy path: `model_rev` bumps by 1; `ModelRow.metamodel_id` updated; new `MetamodelRow`
  created; `Commit` row has `from/to_metamodel_id`, empty ops, `validation_error_count`,
  issues JSON; snapshot written at new rev; baseline re-validated; `rebind_event` broadcast.
- Rebind that introduces conformance issues **succeeds** (does not block) and reports the
  count.
- 403 for editor and viewer; 409 on active lease; 409 on stale `base_rev`; 422 on invalid
  candidate.
- 500 + full in-memory rollback on simulated DB failure (metamodel pointer, model_rev,
  baseline, index all restored).
- **Eviction round-trip:** rebind → evict → hydrate; the rehydrated session loads the new
  metamodel and the model replays correctly.

**Initial-bind guard — `tests/api/`:**
- `POST /metamodel` → 409 on a non-empty model; still performs initial bind on an
  empty/contentless project.

---

## 8. Spec corrections to the parent design

§9's table lists "instance of unknown/abstract type" under **STRUCTURAL**. Decision #2
moves the *unknown-type* case to **CONFORMANCE** (abstract-instance remains unaddressed).
The parent spec's §9 should be footnoted accordingly when next touched; this spec is the
authority for Phase 6B.

---

## 9. File-change inventory (for the plan)

- `src/data_rover/core/model/model.py` — `build_rebind_view`.
- `src/data_rover/core/validation/validators/type_conformance.py` — unknown-type check.
- `src/data_rover/api/routes/metamodel_swap.py` — `diff` + `rebind` routes (new file).
- `src/data_rover/api/routes/metamodel.py` — initial-bind guard on `upload_metamodel`.
- `src/data_rover/api/routes/__init__.py` / app wiring — mount the new router.
- `src/data_rover/api/content.py` — `append_commit` from/to kwargs.
- `src/data_rover/api/db_models.py` — `Commit.from_metamodel_id`/`to_metamodel_id`.
- `src/data_rover/api/schemas.py` — `MetamodelDiffResponse`, `RebindResponse`.
- `src/data_rover/api/feed.py` — `rebind_event`.
- `alembic/versions/0004_*.py` — commit metadata columns.
- `tests/model/`, `tests/validation/`, `tests/api/` — coverage above.
</content>
</invoke>
