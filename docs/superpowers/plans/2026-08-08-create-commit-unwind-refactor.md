# create_commit Unwind-Ledger Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `create_commit`'s (and `revert_commit`'s) hand-maintained, near-identical failure-unwind blocks in `src/data_rover/api/routes/commits.py` into one progressive rollback ledger, with **zero behavior change**.

**Architecture:** A module-private `_CommitUnwind` dataclass in `routes/commits.py` acts as a ledger: each stage of the commit flow *registers* what became live (model batch applied, DB staging begun, view auto-created, view batch applied, rev bumped + batch recorded) immediately after it goes live; every rejection/failure path calls `unwind()` exactly once, which undoes exactly what was registered, in the same canonical order the current persist-failure block uses. The success path never calls it. `revert_commit` reuses the same ledger for its two (model-only) unwind sites.

**Tech Stack:** Python 3.14, FastAPI, pytest via pixi (`core-dev` env). No new dependencies.

## Global Constraints

- **Behavior-preserving**: every failure path must produce byte-identical wire responses and identical session/DB state to today. No new status codes, no reordered side effects — the ledger's `unwind()` order was derived so that, for each site's registered subset of fields, it emits exactly the statement order that site's inline block uses today (verified site-by-site while writing this plan; re-verify while rewiring).
- **Order is load-bearing**: `session.model_rev -= 1` must run BEFORE `session.invalidate_derived_caches()` — that method re-stamps the cell cache to the *current* `model_rev` (see its docstring in `api/session.py:148`).
- **Preserve the dense invariant comments** in `commits.py`; move them onto the ledger/its call sites rather than deleting them, extend in the same voice. The final-review findings they cite (Finding 1/A/B/C, round 2/3) must stay traceable.
- **Do NOT touch** `preview_commit` (its `try/finally` always-rollback is a different, correct shape), `routes/ops.py::undo` (its unwind re-pushes a popped op_log batch — different contract; out of scope per the handoff), or any wire schema.
- **Leases are NOT released on failure** — release only happens after a durable commit (step g). The ledger must not touch the lock table.
- Lint gates that must pass: `pixi run dr-tidy` (format+lint), `pixi run backend-lint` (ruff+mypy+pyright on the api package), `pixi run core-test`.
- Work on branch `refactor/commit-unwind` off `main`. Do not push.

---

### Task 1: Characterization pin — `create_commit` persist-failure (500) unwind

The persist-failure block is the richest unwind (model rollback + rev decrement + view rollback + auto-create unwind + `op_log.pop()` + `db.rollback()` + locks kept) and is the ONLY `create_commit` failure branch with no route-level test today (`tests/api/test_ops_persistence.py::test_apply_ops_rolls_back_in_memory_on_persist_failure` covers `/model/ops` only). Pin it before moving the wall.

**Files:**
- Modify: `tests/api/test_commits_view_ops.py` (append one test at end of file)

**Interfaces:**
- Consumes: existing fixtures/helpers in that file — `client` fixture (seeds `_MM` Node/Contains metamodel + empty model into project `default`), `papi`, `_rev`. Monkeypatch target: `data_rover.api.content.append_commit` (same seam `test_apply_ops_rolls_back_in_memory_on_persist_failure` uses — `_persist_commit` in `routes/ops.py` resolves it via module attribute, so `monkeypatch.setattr(_content, "append_commit", _boom)` intercepts it).
- Produces: nothing later tasks call; this is a pin.

- [ ] **Step 1: Write the characterization test**

Append to `tests/api/test_commits_view_ops.py`:

```python
def test_persist_failure_rolls_back_all_halves_and_keeps_leases(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Characterization pin for create_commit's persist-failure (500) unwind —
    the richest failure block: model rollback, rev decrement, view rollback,
    auto-create unwind (project had no view), op_log pop, db rollback — and
    the caller's leases must NOT be released (release is step g, strictly
    after a durable commit). Mirrors test_apply_ops_rolls_back_in_memory_
    on_persist_failure (tests/api/test_ops_persistence.py), which pins the
    same seam for /model/ops."""
    from data_rover.api import content as _content

    assert client.get(papi("/view")).json()["view"] is None
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": "root", "mode": "exclusive", "type": "folder"}],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text
    token = r.json()["token"]
    base = _rev(client)
    session = get_session()
    op_log_before = len(session.op_log)
    elems_before = client.get(papi("/model/elements")).json()["total"]

    def _boom(*_a: object, **_kw: object) -> None:
        raise RuntimeError("simulated DB failure")

    monkeypatch.setattr(_content, "append_commit", _boom)
    ops = [
        # model half (a create needs no lock) + view half (auto-creates the
        # view — there is none yet), so BOTH in-place halves are live when
        # the persist step blows up.
        {"kind": "create_element", "temp_id": "tmp_e", "type_name": "Node",
         "properties": {}},
        {"kind": "create_folder", "temp_id": "tmp_c", "parent_id": "root",
         "name": "A"},
    ]
    r = client.post(
        papi("/commits"),
        json={"base_rev": base, "ops": ops, "message": "m", "lock_tokens": [token]},
    )
    assert r.status_code == 500

    # rev + undo history rolled back in-memory
    assert session.model_rev == base
    assert len(session.op_log) == op_log_before
    # the auto-created view unwound to None, not a materialized empty view
    assert session.view is None

    monkeypatch.undo()  # restore append_commit so the probe requests work
    assert client.get(papi("/view")).json()["view"] is None
    assert client.get(papi("/model/elements")).json()["total"] == elems_before
    assert _rev(client) == base
    # leases survive a failed commit — release only follows a durable commit
    held = {le["resource_id"] for le in client.get(papi("/locks")).json()["leases"]}
    assert "folder:root" in held
```

- [ ] **Step 2: Run it — expected PASS (it pins current behavior)**

Run: `pixi run -e core-dev pytest tests/api/test_commits_view_ops.py::test_persist_failure_rolls_back_all_halves_and_keeps_leases -v`
Expected: PASS. (This is a characterization test of existing behavior, not red-green TDD — it must pass before AND after the refactor. If it FAILS, stop: either the test is wrong — fix it — or you found a live bug; report it before proceeding.)

- [ ] **Step 3: Run the whole file to confirm no fixture interference**

Run: `pixi run -e core-dev pytest tests/api/test_commits_view_ops.py -v`
Expected: all pass (10 tests).

- [ ] **Step 4: Commit**

```bash
git add tests/api/test_commits_view_ops.py
git commit -m "test(api): pin create_commit's persist-failure unwind end-to-end"
```

---

### Task 2: Introduce `_CommitUnwind` and rewire `create_commit`

**Files:**
- Modify: `src/data_rover/api/routes/commits.py` (add ledger class after `_conflict_response`, ~line 312; rewire `create_commit`, lines ~497-1055)

**Interfaces:**
- Consumes: `_rollback`, `_BatchResult` (add to the existing `from .ops import` block — the module docstring already blesses importing the ops package's module-private helpers), `rollback_view`, `ViewBatchResult` (both already imported), `Session` (from `..deps`, already imported), `DbSession`, `Model`.
- Produces: `_CommitUnwind` dataclass with fields `session: Session`, `db: DbSession`, `model: Model`, `model_res: _BatchResult | None = None`, `view_res: ViewBatchResult | None = None`, `created_view: bool = False`, `db_staged: bool = False`, `rev_bumped: bool = False`, and method `unwind() -> None`. Task 3 reuses it verbatim.

- [ ] **Step 1: Add the ledger class**

Add `from dataclasses import dataclass` to the stdlib import block, `_BatchResult` to the `from .ops import` list, then after `_conflict_response` insert:

```python
@dataclass
class _CommitUnwind:
    """Progressive unwind ledger for ``create_commit``'s/``revert_commit``'s
    failure paths.

    A commit batch can span three content families living in three places
    (see ``create_commit``'s "Mixed-batch atomicity" docstring): the model is
    mutated IN PLACE, artifact rows are staged on this request's DB
    transaction, and the view is mutated IN PLACE plus staged as a blob on
    that same transaction. Every rejection/failure path therefore has to
    undo *however many halves are live at that point* — which used to be
    five hand-maintained, near-identical inline blocks whose contents had
    to grow in lockstep with the flow (each new stage meant revisiting
    every later block; the strict-mode gate and the Phase-2 view half both
    did exactly that).

    The ledger inverts the maintenance direction: each stage REGISTERS what
    just went live, immediately after it goes live (``model_res`` after the
    model apply, ``db_staged`` once DB staging begins, ``created_view`` when
    this request materializes ``session.view`` from ``None``, ``view_res``
    after the view apply, ``rev_bumped`` after the rev bump +
    ``record_batch``), and every failure path calls ``unwind()`` exactly
    once and then returns/raises. A new stage now touches ONE registration
    site instead of every downstream block.

    ``unwind()`` runs under ``session.write_mutex`` — every caller already
    holds it (the sole pre-mutex failure paths register nothing and return
    plain 409s without a ledger). Field-order invariants, preserved from the
    inline blocks this replaces:

    - ``model_res`` rollback first (restores the in-place model), then the
      rev decrement, THEN ``invalidate_derived_caches()`` — that method
      re-stamps the cell cache to the CURRENT ``model_rev`` (see its
      docstring), so decrementing after it would stamp the wrong rev.
      Invalidation is tied to ``model_res``: it exists because the in-place
      apply-then-rollback leaves the model rev-identical but momentarily
      different, so a lock-free concurrent ``/tables/evaluate`` could have
      cached rows computed mid-flight (final-review A1/I1).
    - ``view_res`` rollback needs ``session.view`` non-None: the view half
      only ever applies to a resolved view, and nothing can null it
      mid-request anymore (the retired ``DELETE /view`` was the last thing
      that could — see the defensive-fallback comment at the b3 site).
    - ``created_view`` reset LAST among the view steps: a rejected request
      must be externally invisible, so the auto-create unwinds to the
      genuinely-empty ``None``, not a materialized empty view with no
      ViewRow behind it (final-review Finding 1 / round 2 A+B).
    - ``op_log.pop()`` only when ``rev_bumped``: the batch enters the op
      log at the same instant the rev bumps (step d), never earlier.
    - ``db.rollback()`` last, and only once ``db_staged`` — the paths
      before any staging (missing-lock 409, model-apply failure) never
      rolled the request transaction back and still must not.

    NOT part of the ledger, on purpose: lock release (leases survive a
    failed commit — release is step g, strictly after a durable commit) and
    the op-log/`model_rev` bookkeeping of ``routes/ops.py::undo`` (its
    unwind must re-PUSH a batch popped at entry — a different contract).
    """

    session: Session
    db: DbSession
    model: Model
    model_res: _BatchResult | None = None
    view_res: ViewBatchResult | None = None
    created_view: bool = False
    db_staged: bool = False
    rev_bumped: bool = False

    def unwind(self) -> None:
        if self.model_res is not None:
            _rollback(self.model, self.model_res.inverse_units)
        if self.rev_bumped:
            self.session.model_rev -= 1
        if self.model_res is not None:
            self.session.invalidate_derived_caches()
        if self.view_res is not None:
            assert self.session.view is not None
            rollback_view(self.session.view, self.view_res.inverse_units)
        if self.created_view:
            self.session.view = None
        if self.rev_bumped:
            self.session.op_log.pop()
        if self.db_staged:
            self.db.rollback()
```

- [ ] **Step 2: Rewire `create_commit`'s failure sites**

Precise mapping, in flow order. The big `created_view` comment block above the staleness checks (lines ~579-602, "True iff THIS request...", including the round-3 INVARIANT paragraph) moves wholesale onto the ledger instantiation; trim only what the ledger docstring now states, keep the final-review breadcrumbs.

1. Replace `created_view = False` (line ~603) with `unwind = _CommitUnwind(session, db, model)` carrying the relocated comment. (Pre-mutex staleness 409s register nothing and stay exactly as they are — plain `_conflict_response` returns, no ledger call.)
2. View resolve inside the mutex (line ~710-712): `session.view = load_or_create_view(db, project_id)` then `unwind.created_view = True` (replaces `created_view = True`). Keep the surrounding comment.
3. Missing-lock 409 (lines ~721-727): replace the `if created_view: session.view = None` block (keep its comment, condensed to a pointer at the ledger) with `unwind.unwind()` before the `return JSONResponse(status_code=409, ...)`.
4. Model apply (lines ~744-749) becomes:

```python
        try:
            res = _apply_batch(model, model_ops, restore=False)
        except Exception:
            unwind.unwind()  # created_view may already be set (resolve above)
            raise
        unwind.model_res = res
```

5. Artifact apply (lines ~754-773): keep the b2 comment; before the call add `unwind.db_staged = True` (with a one-line comment: staging begins here — a partial `apply_artifact_ops` flush must be discarded even though `art_res` never got assigned); the `except Exception:` body becomes `unwind.unwind()` + `raise` (delete the four inline undo lines, fold their comments into the ledger call: `# undo every live half — see _CommitUnwind`).
6. View apply (lines ~780-816): defensive fallback sets `unwind.created_view = True` (keep its full comment); the `except Exception:` body becomes `unwind.unwind()` + `raise`, keeping the "apply_view_ops_atomic already rolled its own prefix back" comment (which is exactly why `view_res` is still unregistered there). After success: `unwind.view_res = view_res`.
7. Structural 422 (lines ~822-839) and strict-mode 422 (lines ~846-863): each replaces its five undo lines with one `unwind.unwind()` before the existing `return JSONResponse(status_code=422, ...)`.
8. After `session.model_rev += 1` ... `session.record_batch(...)` (lines ~865-900): add `unwind.rev_bumped = True`.
9. Persist failure (lines ~938-951): the `except Exception as exc:` body becomes `unwind.unwind()` + the existing `raise HTTPException(status_code=500, detail="failed to persist commit") from exc`.
10. Update the "Mixed-batch atomicity" section of `create_commit`'s docstring (lines ~559-575): keep the three-families explanation, but state that per-path undo is now the `_CommitUnwind` ledger's job and point at its docstring for the order invariants; keep the sentences about `apply_artifact_ops` having no internal rollback and `apply_view_ops_atomic` rolling back its own prefix (both are what make the ledger's field semantics correct).

Nothing else in the function changes: success path, broadcasts, lock release, response assembly all stay byte-identical.

- [ ] **Step 3: Run the commit-path test files**

Run: `pixi run -e core-dev pytest tests/api/test_commits_route.py tests/api/test_commits_view_ops.py tests/api/test_commits_artifact_ops.py tests/api/test_strict_mode.py tests/api/test_commit_conflict_backstop.py tests/api/test_undo_view_ops.py -v`
Expected: all pass (67 tests), including Task 1's pin.

- [ ] **Step 4: Run the full api test package**

Run: `pixi run -e core-dev pytest tests/api/`
Expected: all pass, 0 failures. (Note: `tests/model/test_search_index.py::test_string_properties_indexed_non_strings_ignored` is a known ~0.8% flake — unrelated, re-run if it trips in later full runs.)

- [ ] **Step 5: Lint/typecheck**

Run: `pixi run backend-lint`
Expected: ruff, mypy, pyright all clean.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/routes/commits.py
git commit -m "refactor(api): extract create_commit's unwind blocks into a _CommitUnwind ledger"
```

---

### Task 3: Adopt the ledger in `revert_commit`

`revert_commit`'s two unwind sites are the model-only subset of the same pattern; leaving them hand-rolled next to the ledger would be exactly the drift hazard the ledger removes.

**Files:**
- Modify: `src/data_rover/api/routes/commits.py` (`revert_commit`, lines ~1189-1244 pre-Task-2 numbering)

**Interfaces:**
- Consumes: `_CommitUnwind` from Task 2, exactly as defined there (only `model_res`, `rev_bumped`, `db_staged` are used; `view_res`/`created_view` stay at their defaults — revert 409s away any batch containing view or artifact ops before applying).
- Produces: nothing new.

- [ ] **Step 1: Rewire the two sites**

After `res = _apply_batch(model, combined, restore=True)` add:

```python
        unwind = _CommitUnwind(session, db, model, model_res=res)
```

(A comment on that line: revert refuses artifact/view batches above, so only the model-half fields are ever registered.)

1. Structural 422 (currently `_rollback(model, res.inverse_units)` + `session.invalidate_derived_caches()`): replace both lines with `unwind.unwind()`. (`db_staged` is still False — today's block calls no `db.rollback()` either.)
2. After `session.model_rev += 1` ... `session.record_batch(...)`: add `unwind.rev_bumped = True`. Immediately before the `persisted = _persist_commit(...)` try block add `unwind.db_staged = True` (today's persist-failure block DOES call `db.rollback()`).
3. Persist failure `except Exception as exc:` body (five undo lines): replace with `unwind.unwind()`, keep the `raise HTTPException(...) from exc`.

Note the one intra-block order difference vs. today's revert persist block (`_rollback` → `rev -= 1` → `invalidate` → `op_log.pop()` → `db.rollback()`): none — the ledger emits exactly this order when only these fields are set.

- [ ] **Step 2: Run the revert + commit tests**

Run: `pixi run -e core-dev pytest tests/api/test_commits_revert.py tests/api/test_commits_route.py tests/api/test_commits_view_ops.py -v`
Expected: all pass.

- [ ] **Step 3: Lint/typecheck**

Run: `pixi run backend-lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/data_rover/api/routes/commits.py
git commit -m "refactor(api): reuse the _CommitUnwind ledger in revert_commit"
```

---

### Task 4: Full verification gates

**Files:** none new — verification only (plus any mechanical fixes `dr-tidy` makes).

- [ ] **Step 1: Full backend + frontend unit suites**

Run: `pixi run dr-test`
Expected: backend ~1638 passed (1637 + Task 1's pin), 26 deselected; frontend 1763 passed (untouched). Re-run once if only the known `test_search_index` flake trips.

- [ ] **Step 2: Format + lint everything**

Run: `pixi run dr-tidy`
Expected: no diffs beyond what it auto-fixes; if it reformats `commits.py` or the test file, re-run Step 1's affected files and amend the relevant commit (`git add -u && git commit --amend --no-edit` on the task commit that introduced the file being reformatted, or a small `style:` commit if history is cleaner that way).

- [ ] **Step 3: Verify zero behavior drift claim**

Run: `git diff main -- src/ | grep -c "^+.*status_code"` and eyeball `git diff main -- src/data_rover/api/routes/commits.py`
Expected: every status-code line in the diff is a relocation, not a change; the diff contains no edits outside `commits.py` and the one test file.

- [ ] **Step 4: Final commit if anything moved in Step 2**

```bash
git status --short   # expect clean; commit stragglers if any
```
