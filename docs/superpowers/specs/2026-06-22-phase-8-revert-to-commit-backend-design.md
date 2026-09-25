# Phase 8 (backend slice) — Revert-to-commit + durable commit history — Design

**Date:** 2026-06-22
**Status:** Design approved (pending spec review) → implementation planning
**Scope:** The **backend core** of Phase 8 ("History & revert") from the master
architecture spec: a durable **commit-history list** endpoint and a
**revert-to-commit** endpoint built on the existing compensating-commit
machinery. Backend-only. **Deferred:** strict-mode, metamodel-swap revert,
commit-history browser UI / any frontend, partial/subset revert.

Master architecture: `docs/superpowers/specs/2026-06-16-multi-user-collaborative-architecture-design.md`
(§7 History & revert, Phase 8 row). Reuses the Phase 3 durable journal and the
Phase 4 commit path.

---

## 1. Problem & framing

The model is a durable, append-only commit journal: each `POST /commits` (and
each `POST /model/undo`) appends a `Commit` row carrying `ops`, `inverse_ops`,
`id_map`, `message`, `author_id`, `validation_error_count`, `issues`, and the
`from_metamodel_id`/`to_metamodel_id` swap columns (6B/6C). `model_rev` equals
the latest commit's `rev`; hydration replays the commit tail in restore mode.

Two pieces of Phase 8 are missing:

1. **No durable history read.** `GET /model/changes` reports the in-memory
   `op_log`, which is capped at `OP_LOG_MAX` (1000 batches) and lost on eviction.
   There is no way to list the durable `commits` rows.
2. **No revert.** `ops.py:624` already notes "Phase 8 revert reuses this shape"
   (the undo compensating-commit pattern), but nothing consumes it, and the swap
   columns journaled for revert have no reader.

This spec adds both, backend-only, as the deliberately-bounded first slice of
Phase 8.

### Decisions taken in brainstorming

- **Scope: revert core + history list (backend only).** Strict-mode,
  metamodel-swap revert, and all frontend (history browser UI) are deferred.
- **Revert mechanism: inverse-replay / compensating commit (Approach A).** Apply
  the `inverse_ops` of every commit after the target, newest-first, in restore
  mode, recorded as **one new forward commit** — exactly the master spec's §7
  prescription and the proven `POST /model/undo` shape. (Rejected: snapshot-diff,
  too expensive + new machinery; pointer-reset, destroys the append-only journal.)
- **Revert across a metamodel swap → blocked.** If the range between the target
  commit and HEAD contains a rebind commit (`from/to_metamodel_id` set), revert
  returns **409** naming that commit. Swap-revert stays deferred; the columns stay
  ready.
- **Multi-user policy: refuse if peers hold locks.** Revert takes the
  `write_mutex` and **409s if any active lease (held by anyone) covers a resource
  the revert would touch**. The caller need not pre-acquire locks (there is no
  revert UI this cycle). This honors the master spec's "don't stomp concurrent
  editors" caveat (§7) without requiring lock acquisition.
- **Revert is full-tail only.** "commit == revision" (master §7): revert to N
  reverts the entire tail after N. No partial/subset revert.
- **Revert is itself a commit.** It bumps `model_rev`, appends a journal row, and
  is therefore itself revertible (revert-the-revert returns to HEAD).

---

## 2. Reuse — what already exists

Revert and history reuse the Phase 3/4 machinery verbatim; almost no new core
logic:

- **`routes/ops.py` module-private helpers** (already imported by the sibling
  `routes/commits.py`): `_apply_batch(model, ops, restore=...)` (atomic apply +
  inverse collection; 422 on mutation-boundary error, self-rolls-back),
  `_rollback(model, inverse_units)`, `_ensure_validation_seeded(session, model)`,
  `_persist_commit(db, project_id, *, rev, author_id, res, _commit_id, _message,
  _validation_error_count, _issues)`, `_maybe_periodic_snapshot(...)`.
- **`content.commits_after(db, project_id, rev)`** — already returns the commits
  with `rev > N` ascending (hydration's replay tail). The revert range is exactly
  this set.
- **Restore mode** — `Model.restore_element`/`restore_relationship` reinstate
  exact ids, so replaying inverses yields the precise prior state and the new
  commit's `id_map` is identity.
- **`session.lock_table.active_leases(now)`** — the live lease list for the
  peer-lock check.
- **Validation gate** — `default_pipeline().validate(model, res.dirty.to_scope())`
  + `IssueCategory.STRUCTURAL`/`CONFORMANCE`, and `state.replace(ids, scoped)` for
  the issue-store delta.
- **Feed** — `feed.commit_event(...)` + `session.hub.broadcast(...)`.
- **`session.record_batch(AppliedBatch(...))`** — in-memory op_log append.

The **only genuinely new** code is one content query, three Pydantic schemas, the
two route handlers, and a small affected-ids helper.

---

## 3. Components

### 3.1 `GET /commits` — durable commit-history list (`routes/commits.py`)

Distinct from `GET /model/changes` (capped in-memory op_log). Reads the durable
`commits` rows.

- **Query params:** `limit: int = 50` (clamped to `[1, 200]`), `before_rev: int |
  None = None` (cursor: return commits with `rev < before_rev`; omitted = newest).
- **Response** `CommitHistoryResponse { commits: list[CommitSummaryOut],
  has_more: bool }`, **rev-descending**. `has_more` is computed by fetching
  `limit + 1` and trimming.
- **`CommitSummaryOut`:** `rev`, `commit_id`, `author_id: str | None`, `ts`,
  `message`, `validation_error_count`, `op_count` (`len(commit.ops)`),
  `is_rebind` (`commit.from_metamodel_id is not None or commit.to_metamodel_id is
  not None`).
- **Authz:** GET → read → viewers allowed (no allowlist change).

### 3.2 `POST /commits/revert` — revert-to-commit (`routes/commits.py`)

- **Request** `RevertRequest { target_rev: int, base_rev: int, message: str | None
  = None }`.
- **Response** `CommitResponse` — the same shape `POST /commits` returns (full
  element/relationship delta + commit metadata), so a future UI feeds it through
  `applyDelta` unchanged.

Flow (mirrors `create_commit`'s structure):

1. **Stale-rev guard (before the mutex):** `base_rev != session.model_rev` →
   **409** `{detail: "stale base_rev", model_rev}`.
2. `state = _ensure_validation_seeded(session, model)` (before the bounds/no-op
   return so a no-op reports accurate counts — mirrors `apply_ops`).
3. **Target bounds:** `target_rev < 0` or `target_rev > session.model_rev` →
   **422** `{detail: "target_rev out of range"}`. `target_rev ==
   session.model_rev` → **200 no-op**: return a `CommitResponse` with **empty
   delta lists**, `model_rev = session.model_rev`, `issue_counts =
   state.counts()`, `validation_error_count = 0`, empty `commit_id`/`message` —
   **no** commit is applied or recorded (mirrors the empty-batch path in
   `apply_ops`, which returns the current state without bumping `model_rev`).
4. Under `session.write_mutex`:
   1. **Load range:** `commits = content.commits_after(db, project_id,
      target_rev)` (ascending; the commits to undo). The pre-mutex stale-rev
      guard plus the write-mutex (which serializes all writers) mean `model_rev`
      cannot move between the guard and here, so no re-check is needed.
   2. **Rebind-boundary check:** if any `c` in `commits` has
      `c.from_metamodel_id is not None or c.to_metamodel_id is not None` →
      **409** `{detail: "revert across a metamodel swap is not yet supported",
      rebind_rev: c.rev}`. No mutation has occurred.
   3. **Affected-resource lock check:** `affected = _affected_ids(commits)` (union
      of element/relationship ids named in each `c.ops`); if any lease in
      `session.lock_table.active_leases(time.monotonic())` has
      `resource_id in affected` → **409** `{detail: "resource locked by a peer",
      conflicts: [{resource_id, holder_id, mode}, ...]}`. No mutation yet.
   4. **Apply inverses newest-first:** build `combined = [op for c in
      reversed(commits) for op in c.inverse_ops]` (descending rev order) and
      `res = _apply_batch(model, combined, restore=True)`. Restore mode reinstates
      exact ids → `res.id_map` is identity, and the live model now equals the
      state at `target_rev`. A mutation-boundary error propagates as **422**
      (`_apply_batch` self-rolls-back; should not occur — these are
      previously-applied inverses).
   5. **Validation gate:** `scoped = default_pipeline().validate(model,
      res.dirty.to_scope())`; `structural = [STRUCTURAL]` → **422** + `_rollback`
      (should not occur — `target_rev` was itself a committed, structurally-sound
      state); `conformance = [CONFORMANCE]` counted; `delta =
      state.replace(res.dirty.ids, scoped)`.
   6. **Record:** `session.model_rev += 1`;
      `session.record_batch(AppliedBatch(ops=res.canonical_ops,
      inverse_ops=res.inverse_ops(), id_map=dict(res.id_map)))`. The new commit's
      `inverse_ops` re-apply the reverted range (a natural "redo").
   7. **Persist:** `_persist_commit(db, project_id, rev=session.model_rev,
      author_id=user.id, res=res, _commit_id=uuid, _message=(message or
      f"Revert to rev {target_rev}"), _validation_error_count=len(conformance),
      _issues=[IssueOut...])`. On failure: `_rollback(model, res.inverse_units)`;
      `session.model_rev -= 1`; `session.op_log.pop()`; `db.rollback()`; **500**
      (exact `create_commit` pattern).
   8. **Snapshot (best-effort):** `_maybe_periodic_snapshot(...)` wrapped in
      try/except-log — the commit is already durable; a snapshot failure logs a
      warning and proceeds (matches the post-commit snapshot fix on main).
   9. **Broadcast:** `session.hub.broadcast(commit_event(rev, commit_id,
      author_id, message, validation_error_count, changed_elements,
      changed_relationships, deleted_element_ids, deleted_relationship_ids))`
      inside the mutex (enqueue-order == rev-order). **No** `lock_event` — revert
      holds and releases no locks.
5. Return `CommitResponse` (full delta + `commit_id`/`message`/
   `validation_error_count`).

### 3.3 `content.list_commits` (`content.py`)

```
def list_commits(db, project_id, *, before_rev: int | None, limit: int) -> list[Commit]:
    q = select(Commit).where(Commit.project_id == project_id)
    if before_rev is not None:
        q = q.where(Commit.rev < before_rev)
    return list(db.execute(q.order_by(Commit.rev.desc()).limit(limit)).scalars())
```

The route fetches `limit + 1` to compute `has_more`, then trims to `limit`.

### 3.4 `schemas.py` additions

- `CommitSummaryOut` (§3.1 fields).
- `CommitHistoryResponse { commits: list[CommitSummaryOut], has_more: bool }`.
- `RevertRequest { target_rev: int, base_rev: int, message: str | None = None }`.

### 3.5 `_affected_ids` helper (`routes/commits.py`)

Collects the element/relationship ids named in the forward `ops` of the reverted
commits (forward ops name exactly the resources each commit touched). The op
dicts already carry the relevant id fields (`id`/`source`/`target` per op kind);
the helper walks them defensively (unknown keys ignored) and returns a `set[str]`.
The forward `ops` are used rather than parsing the restore-mode `inverse_ops`,
which are noisier.

### 3.6 Authorization

`POST /commits/revert` is a write by HTTP method → `require_membership` already
rejects a viewer with **403** (no read-only-POST allowlist entry). `GET /commits`
is a read → all members. No `authz.py` change.

### 3.7 No migration

Every column the feature reads or writes already exists on `commits`
(Alembic 0001–0003). No new Alembic revision.

---

## 4. Correctness notes

- **Collapsing N inverse batches into one commit is equivalent to N sequential
  undos.** Each stored `inverse_ops` batch was computed relative to the state
  immediately after its own commit. Applying them newest-first reproduces the
  stepwise undo HEAD→…→target_rev; collapsing them into one applied batch yields
  the same final model, and recording it as one commit row means hydration
  replays that single batch in restore mode and reaches `target_rev`. This is the
  exact invariant `POST /model/undo` relies on, generalized to a range.
- **Append-only is preserved.** Revert never deletes or rewrites commit rows;
  `model_rev` only moves forward. History after a revert shows the revert as the
  newest commit.
- **Hydration-safe.** Because the revert is an ordinary forward commit, a cold
  open (nearest snapshot + replay tail) reconstructs the post-revert state with no
  special-casing.

---

## 5. Error handling

| Case | Result |
|---|---|
| stale `base_rev` (≠ `model_rev`) | 409 `{detail, model_rev}` |
| `target_rev == model_rev` | 200 no-op (no new commit) |
| `target_rev < 0` or `> model_rev` | 422 `{detail: "target_rev out of range"}` |
| rebind commit in revert range | 409 `{detail, rebind_rev}` |
| active peer lease on an affected resource | 409 `{detail, conflicts[]}` |
| mutation-boundary error in `_apply_batch` | 422 (self-rolled-back; should not occur) |
| structural blocker after replay | 422 + `_rollback` (should not occur) |
| DB persist failure | 500 + full in-memory rollback |
| viewer | 403 (authz) |

---

## 6. Testing (`tests/api/`, in-memory SQLite per `conftest.py`)

Use the `client` fixture + `seed_default_project`/`AUTH_HEADERS`/`papi` helpers.
New file `tests/api/test_commits_revert.py` (+ history tests, either there or a
sibling `test_commit_history.py`).

**History list**
- Returns commits **rev-descending** with correct fields (`op_count`,
  `validation_error_count`, `author_id`, `ts`, `message`).
- `limit` clamps and `before_rev` cursor paginate; `has_more` is correct across a
  two-page walk.
- `is_rebind` is true exactly for a rebind commit (seed one via the
  metamodel_swap route).
- A viewer member can read the history (200).

**Revert**
- **Happy path:** commit a few batches, revert to an earlier rev → the live model
  equals the exact state at that rev; a new commit is appended; `model_rev`
  bumped by one; `CommitResponse` delta matches.
- **Journal correctness:** after a revert, **evict + rehydrate** the session →
  the rehydrated model still equals the target state (proves the revert commit
  replays correctly).
- **No-op:** `target_rev == HEAD` returns 200 with no new commit (history length
  unchanged).
- **Stale base_rev** → 409.
- **Across a rebind commit** → 409 naming the rebind rev (seed a swap first).
- **Peer lock** → acquire a lease on a resource an in-range commit touched (via
  `POST /locks`), then revert → 409 with the conflict; releasing the lease lets
  the revert succeed.
- **Conformance recorded:** a revert that lands conformance issues records the
  count + issue list on the new commit row (assert via the history list /
  response).
- **Revert-the-revert** returns to the pre-revert HEAD state.
- **Viewer** → 403.
- **DB-failure rollback:** monkeypatch `_persist_commit` (or the underlying
  `append_commit`) to raise → 500, and `model_rev` + the in-memory model are
  unchanged.
- **Feed broadcast:** a connected feed client receives a `commit` event for the
  revert (mirror the existing commit-broadcast test).

---

## 7. Out of scope (→ later Phase 8 slices / other phases)

- **Strict-mode** (promoting configurable conformance issues to hard rejects) —
  later Phase 8 slice.
- **Metamodel-swap revert** (restoring the prior metamodel when crossing a rebind
  commit; consuming `from_metamodel_id`) — blocked with 409 here; the columns
  stay ready.
- **Commit-history browser UI** and any frontend (revert button, history panel) —
  separate frontend slice.
- **Partial / subset revert** (reverting a single commit out of the middle, or a
  subset of objects) — full-tail only this cycle ("commit == revision").
