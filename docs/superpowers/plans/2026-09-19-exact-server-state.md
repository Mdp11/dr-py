# Exact Server State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the current server's model state exact enough for a replica to follow: a batch that is applied and taken back leaves no trace (`K-30`), a commit delta names the entities it created again (`K-31`), and every landed batch carries `prev_rev` and the state digest, which the session keeps in O(batch) and the journal records.

**Architecture:** Plan 1 of 6 for sub-project B (`architecture/program.md`). The Python rollback becomes a port of the engine's `rewind`: `_rollback(model, res)` puts every touched entity back from its first-touch before-image — properties, `rev`, place in insertion order — through three new committed-state methods on `Model` (`insert_element`, `insert_relationship`, `overwrite`), a `relationship_order` twin of `IndexSet.element_order`, and `Model.settle_order()`, which puts the entity dicts back in order by REPLACING them. `_BatchResult` and the engine's `BatchResult` gain `recreated_*` sets, which travel on every delta carrier and in `Commit.entity_states`; the engine's type-or-ends heuristic goes, and an unnamed change of type or ends sets `diverged`. `Session` holds the CT-3 digest as an integer, folded per landed batch; `OpsResponse` / `CommitResponse` / `commit_event` gain `prev_rev`, `state_digest` and `recreated_*`, and `Commit` gains a nullable `state_digest` column.

**Tech Stack:** Python 3.14 (FastAPI, pydantic 2, SQLAlchemy 2, Alembic, pytest, ruff, mypy, pyright); TypeScript 6 (strict, erasable syntax only), vitest 3, eslint 10, prettier 3; pixi for every command.

**Spec:** `docs/superpowers/specs/2026-09-19-replica-and-frontend-seam-design.md` — §1 is this plan's whole scope; §9 names its tests, §10 the `architecture/` and backlog edits that ride with the code. Read `architecture/README.md`, `architecture/contracts.md` (CT-2, CT-3, CT-5), `architecture/decisions.md` (AD-12), `architecture/program.md` (B, MR-3), `architecture/conventions.md` and `BACKLOG-ENGINE.md` (`K-30`, `K-31`) first. `engine/src/ops/rewind.ts` is the operation Task 2 ports.

**Provenance:** every code block below comes from a build of this plan that was made and run before the plan was written, in a scratch clone of `d086ff7` against the real Python core and the repository's own pixi environments; the blocks were generated from that build's four task-shaped commits, not retyped, and a script checked that, applied in order to a clean clone, they give that build's tree byte for byte. **What was observed.** At the end state: 2,465 Python tests (34 deselected), 272 engine tests in 39 files, ruff, mypy, pyright, eslint, `tsc` (both projects) and prettier clean, fixtures current; the one frontend test file the plan touches passes. Replayed from the plan's text: Task 1 whole, and Task 2 through its Step 8 — each failing step failed as stated, each passing step passed, and the three bite checks of Task 2 and the one of Task 3 were seen to bite. **What was not.** Tasks 3 and 4 were not replayed step by step: the failures their "see them fail" steps name are reasoned from the code, the full-suite counts inside Tasks 2 and 3 are sums of the tests added, and the three bite checks of Task 4 were never run. The owner stopped the verification there, on purpose: running an implementation's tests is the implementer's work, and from the next plan on a plan is written as a plan — direction and specifics, no full build behind it. If a step's expected result does not appear, trust the run, read the step's intent, and say so in the hand-back.

## What building it taught this plan

Review these before executing; each is a choice the spec left open, or a fact the code gave up only when run.

1. **Removing the recorder's deep copy changes no existing fixture.** With the exact rollback, every refused batch of `ops_batches` and `ops_churn` runs on the recorder's live model and `pixi run golden-fixtures` rewrites them byte for byte. That is the strongest proof the plan has, and Task 2 checks it. The recorder now FAILS the run when a refused batch leaves a trace (state lines, index dump or digest), so the oracle is held to the contract instead of being shielded from it. One thing it still hands back: the ids a refused batch drew. The generator is the recorder's own (`_Ids`, the same `id-N` sequence), not `core/model/ids.py`'s, so nothing under the freeze changes for it. The alternative — let a refused batch burn ids, as the real `Uuid7Generator` does — would make a fixture see that the engine calls `idFor` before the type check and the core mints after it.
2. **A relationship put back must re-enter `containment_parents` by its number.** `on_relationship_created` appended; a rollback that restores the FIRST containment parent of a child would have left it second, and `container_of`, the uniqueness owner and the index dump with it. The hook now inserts by `relationship_order`, as the engine's does by `ord`. `ops_refused` step 5 is built for it, and the bite check shows `containment_parents, _containment_rel_ids` inconsistent without it.
3. **The order repair replaces the dict, and costs what building a dict costs.** Read routes and table evaluation iterate `model.elements` without `write_mutex`; an in-place `clear()` + `update()` would show them an empty dict. `settle_order()` builds the ordered dict and rebinds the attribute, so a lock-free reader holds either dict whole. The only long-lived alias in `src/` is `build_rebind_view`, used under `write_mutex` for the length of one request. It runs only after a rollback that re-inserted something behind a larger number (`_lands_out_of_place` looks at the dict's last entity, so putting back what WAS last costs nothing). *Measured at M (170,340 elements, 126,820 relationships, Python 3.14, medians of 5):* a rollback of 1,000 updates 5.7 ms; of one deleted element 70 ms (element dict repaired); of one deleted element with relationships 106 ms (both dicts). A synthetic dict of the same size splits the cost as 12 ms sort + 23 ms dict build, so there is little left above the O(n) floor. Reported to the owner before approval, as the spec asks.
4. **Sequence numbers ride beside the before-images, not in them.** `_BatchResult.before_elements` holds `ElementOut`s that go out on the wire (`Commit.entity_states`, the recorder's fixtures); the numbers live in `before_element_orders` / `before_relationship_orders`, and `note_*_before` takes the model to read them.
5. **`restore_element` / `restore_relationship` delegate to the new inserts.** Same checks in the same order with the same texts, then `insert_*(…, {}, 0)`. Frozen behaviour (MR-3) is unchanged, and Task 1 proves it the cheap way: the fixtures do not move.
6. **`recreated` is the spec's rule taken literally:** an id that sits in the deleted set when a create op lands; a later delete takes it out again. It therefore also names an entity created under an id hint, deleted and created again within one batch — a replica does not hold it, skips the removal and appends, which is right. `entity_states` always carries the `recreated` key on new rows; rows without it load as "none named".
7. **In the engine an unnamed change of type or ends throws inside `commit`,** as a `ModelError`, which `applyDelta` already turns into `diverged` — no new path. `readDelta` refuses a delta whose id lists are not lists (`recreated_element_ids: must be a list`) before anything moves, which is what a server older than the lists would send.
8. **The digest advances where the rev bumps, and goes back with it.** `/model/ops` and `/model/undo` restore `state_digest_value` inline on a persist failure; `_CommitUnwind` restores `prior_digest` under `rev_bumped`. Before the bump nothing is needed — that is the point of an exact rollback. The first landed batch after a hydration, `set_model` or `touch_model` pays one full pass under `write_mutex`: *286 ms at M, measured*. Every later batch folds in O(batch); a test forbids the full pass once the value is known.
9. **`prev_rev` and `state_digest` are `null` on a response that applied nothing** (the empty-batch early returns): there is no delta, and computing a digest there could cost the full pass for nothing.
10. **The frontend needs no change.** `OpsResponseSchema` is a plain `z.object`, which strips unknown keys, and feed events are a cast union. A vitest case pins the tolerance; the fields get their schema when plan 4 reads them.
11. **One neighbour of `K-30` is logged, not fixed:** the staged branch of `POST /model/validate` rolls back exactly now, but never calls `session.invalidate_derived_caches()` as preview does, so a lock-free `/tables/evaluate` can keep rows computed mid-validation. It is outside §1; Task 2 logs it as `K-33` in `BACKLOG.md`, because deleting `K-30` would drop its only record.
12. **No block of this plan holds a 4-digit unicode escape,** so the blocks can be typed or extracted alike.

## Global Constraints

- Everything runs through pixi. There is no global `python` or `node`: use `pixi run <task>`, `pixi run -e core-dev ...`, `pixi run -e frontend ...`.
- Work on branch `feat/exact-server-state`, cut from `engine-migration` (Task 1 cuts it) and fast-forwarded back into it when the plan is done (Task 5). Never touch `main`. Commit only with the owner's go-ahead for this plan's execution.
- **Freeze rule (MR-3):** `core/model`, `core/metamodel` and the model-op applier are frozen for behaviour changes. `K-30` and `K-31` are bugs fixed during a port: they land on BOTH sides with a golden fixture, in one commit each. Nothing else in those areas changes behaviour; Task 1's fixtures-do-not-move check is how that is known.
- The Python core is the oracle. When a golden test fails, the engine is wrong — never edit a fixture by hand, never loosen a scenario. Fixtures change only through `pixi run golden-fixtures`.
- `Model` is the one mutation boundary of the Python store (RC-8): a before-image enters the model only through `insert_element`, `insert_relationship` and `overwrite`.
- Never refill `model.elements` / `model.relationships` in place, and never keep a reference to either across `settle_order()`.
- `engine/src/` uses no DOM API and no Node built-in, is erasable syntax only, imports with `.ts` specifiers, and uses no `Date.now`, `Math.random` or `Intl`. No `any` in an exported signature.
- Delta fields keep the wire's snake_case names (`recreated_element_ids`); everything else in the engine is camelCase.
- `/model/ops` and `/model/undo` stay silent on the feed. `prev_rev` is not stored on `Commit`. `recreated_*` are lists of their own, never ids repeated in `deleted_*` — the legacy store must be able to ignore them.
- Performance: do not optimize. The order repair was measured (finding 3); if a number looks wrong during execution, report it, do not tune.
- Formatting: Python is ruff-formatted; `pixi run dr-tidy` lints neither `tests/` nor `alembic/`: run ruff on the files a task adds there by hand, as the steps say. The engine is prettier-formatted (tabs, single quotes, no trailing commas, width 100) through `pixi run engine-tidy`.
- **Applying the blocks.** "`path` (create):" is a whole new file; "In `path`, replace:" / "with:" is an exact string that occurs once; "In `path`, delete:" removes one. A block that edits a prose file (`CLAUDE.md`, `architecture/`, the backlogs) may be a FRAGMENT of a long line: match the text, not the line. `docs/superpowers/plans/2026-09-19-exact-server-state.apply.py` applies them mechanically — `pixi run -e core-dev python docs/superpowers/plans/2026-09-19-exact-server-state.apply.py docs/superpowers/plans/2026-09-19-exact-server-state.md . <task> [--from "Step 5"] [--upto "Step 6"]` applies the blocks of the steps from the first named up to, not including, the second — and refuses a block that does not occur exactly once.
- Comments and docstrings are concise and present-tense, only for what the code cannot say. No references to specs, plans, phases or `architecture/` ids in code.
- `architecture/`, `CLAUDE.md`, `BACKLOG.md` and `BACKLOG-ENGINE.md` are tracked and change in the same commit as the code they describe (RC-10); `docs/` and `benchmarks/` are git-ignored — never `git add -f`.
- Commit subjects: one imperative sentence, capitalized, no prefix, no trailing period; end the message with the session's `Co-Authored-By` line.

## File Structure

```
src/data_rover/core/model/indexes.py        + relationship_order; create hooks take an order; parents placed by number
src/data_rover/core/model/model.py          + insert_element, insert_relationship, overwrite, settle_order
src/data_rover/api/routes/ops.py            _BatchResult: before orders, recreated sets; _rollback(model, res);
                                            prev_rev / digest through /model/ops and /model/undo
src/data_rover/api/routes/commits.py        _rollback callers; _CommitUnwind.prior_digest; delta fields on
                                            POST /commits and /commits/revert, response and feed
src/data_rover/api/routes/validation.py     _rollback caller
src/data_rover/api/commit_states.py         entity_states gains "recreated"
src/data_rover/api/state_digest.py          + digest_value, fold_batch
src/data_rover/api/session.py               + state_digest_value, state_digest(), advance_state_digest()
src/data_rover/api/schemas.py               OpsResponse: recreated_*, prev_rev, state_digest
src/data_rover/api/feed.py                  commit_event: prev_rev, state_digest, recreated_*
src/data_rover/api/db_models.py             Commit.state_digest
src/data_rover/api/content.py               append_commit(state_digest=)
alembic/versions/0015_commit_state_digest.py

tests/model/test_model_committed.py         the committed-state methods and place in order
tests/model/test_indexes.py                 + relationship_order
tests/api/test_exact_rollback.py            one test per path that rolls a batch back
tests/api/test_commit_states.py             + recreated
tests/api/test_commit_delta.py              the session digest and the delta fields on every carrier
tests/api/test_state_digest.py              + fold_batch
tests/api/test_feed_hub.py, test_alembic.py the event's shape, the migration
tests/golden/model_steps.py                 batches run on the live model; outcome gains recreated_*
tests/golden/scenarios/ops_refused.py       a refusal after every kind of touch

engine/src/ops/result.ts, apply.ts          recreated sets
engine/src/working/delta.ts                 recreated_* on Delta and CommittedChange
engine/src/working/working-copy.ts          commit(): named ids out first; an unnamed change does not fit
engine/bench/run.ts                         the bench delta names none
engine/test/ops/refused.golden.test.ts      the engine replays ops_refused
engine/test/golden/model-steps.ts           outcome gains recreated_*
engine/test/working/*.ts                    Server names them; ops_recreate and ops_refused join the replica test
engine/fixtures/golden/ops_*.json           generated — never edited by hand

frontend/src/lib/api/__tests__/types.checkout.test.ts   the response schema tolerates the new fields

CLAUDE.md, architecture/contracts.md, architecture/program.md, BACKLOG-ENGINE.md, BACKLOG.md
```

---

### Task 1: Committed-state methods and a relationship order in the core

The rollback of Task 2 needs to put an entity back exactly: under its id, with its properties and `rev` as they were, in its old place, whatever its type. `Model` gains the three methods the engine's `Model` already has, plus `settle_order()`; `IndexSet` gains `relationship_order` and create hooks that take a sequence number. Nothing calls them yet, and nothing existing changes behaviour — which the unchanged fixtures show.

**Files:**
- Create: `tests/model/test_model_committed.py`
- Modify: `tests/model/test_indexes.py`, `src/data_rover/core/model/indexes.py`, `src/data_rover/core/model/model.py`, `CLAUDE.md`

**Interfaces:**
- Consumes: nothing from this plan.
- Produces, on `Model`: `insert_element(element_id: str, type_name: str, properties: dict[str, Any], rev: int, order: int | None = None) -> Element`; `insert_relationship(rel_id: str, rel_type: str, source_id: str, target_id: str, properties: dict[str, Any], rev: int, order: int | None = None) -> Relationship`; `overwrite(target: Element | Relationship, properties: dict[str, Any], rev: int) -> None`; `settle_order() -> None`. All three writers take over `properties`. `insert_*` raise `ValueError("Id 'x' is already in use")`, `insert_relationship` also `KeyError("No source element 'x'")` / `KeyError("No target element 'x'")`; `overwrite` raises `KeyError("Entity 'x' is not part of this model")`. On `IndexSet`: `relationship_order: dict[str, int]`, `on_element_created(element, order=None)`, `on_relationship_created(rel, order=None)`.

- [ ] **Step 1: Cut the branch**

```bash
git switch engine-migration
git switch -c feat/exact-server-state
```

- [ ] **Step 2: Write the failing tests**

`tests/model/test_model_committed.py` (create):

```python
"""Tests for the committed-state methods of the mutation boundary:
``Model.insert_element``, ``Model.insert_relationship``, ``Model.overwrite``
and ``Model.settle_order``. They put an entity back exactly as it was — type
unchecked, ``rev`` given, place in insertion order included — and fire the
same index hooks as the methods that create one.
"""

import pytest

from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Item",
                key=["name"],
                properties=[
                    PropertyDef(name="name", datatype="string"),
                    PropertyDef(name="ref", datatype="Item"),
                ],
            ),
        ],
        relationships=[
            RelationshipType(
                name="Holds", containment=True, source="Item", target="Item"
            ),
            RelationshipType(
                name="Link",
                source="Item",
                target="Item",
                properties=[PropertyDef(name="label", datatype="string")],
            ),
        ],
    )


def _items(model: Model, *names: str) -> list[str]:
    ids = []
    for name in names:
        element = model.create_element("Item")
        model.set_property(element, "name", name)
        ids.append(element.id)
    return ids


# ---------------------------------------------------------------------------
# insert_element
# ---------------------------------------------------------------------------


def test_insert_element_takes_properties_and_rev_as_given():
    model = Model(_mm())
    props = {"name": "a"}
    element = model.insert_element("e1", "Item", props, 7)
    assert model.elements["e1"] is element
    assert element.properties is props
    assert element.rev == 7
    assert model.indexes.roots_page(0, 10) == ["e1"]
    model.indexes.verify_consistent()


def test_insert_element_checks_no_type():
    model = Model(_mm())
    element = model.insert_element("e1", "Gone", {"anything": 1}, 3)
    assert element.type_name == "Gone"
    model.indexes.verify_consistent()


def test_insert_element_refuses_an_id_in_use():
    model = Model(_mm())
    a, b = _items(model, "a", "b")
    rel = model.connect("Link", a, b)
    with pytest.raises(ValueError, match="already in use"):
        model.insert_element(a, "Item", {}, 0)
    with pytest.raises(ValueError, match="already in use"):
        model.insert_element(rel.id, "Item", {}, 0)


def test_restore_element_still_guards_the_type():
    model = Model(_mm())
    with pytest.raises(KeyError, match="Unknown element type"):
        model.restore_element("e1", "Gone")
    restored = model.restore_element("e1", "Item")
    assert (restored.properties, restored.rev) == ({}, 0)


# ---------------------------------------------------------------------------
# insert_relationship
# ---------------------------------------------------------------------------


def test_insert_relationship_takes_properties_and_rev_as_given():
    model = Model(_mm())
    a, b = _items(model, "a", "b")
    rel = model.insert_relationship("r1", "Link", a, b, {"label": "x"}, 4)
    assert model.relationships["r1"] is rel
    assert (rel.properties, rel.rev) == ({"label": "x"}, 4)
    assert model.indexes.outgoing_ids(a) == {"r1"}
    model.indexes.verify_consistent()


def test_insert_relationship_checks_ends_and_id_but_no_type():
    model = Model(_mm())
    a, b = _items(model, "a", "b")
    with pytest.raises(KeyError, match="No source element"):
        model.insert_relationship("r1", "Link", "ghost", b, {}, 0)
    with pytest.raises(KeyError, match="No target element"):
        model.insert_relationship("r1", "Link", a, "ghost", {}, 0)
    with pytest.raises(ValueError, match="already in use"):
        model.insert_relationship(a, "Link", a, b, {}, 0)
    assert model.insert_relationship("r1", "Gone", a, b, {}, 0).type_name == "Gone"
    model.indexes.verify_consistent()


# ---------------------------------------------------------------------------
# overwrite
# ---------------------------------------------------------------------------


def test_overwrite_replaces_properties_and_rev_and_reindexes():
    model = Model(_mm())
    a, b = _items(model, "a", "b")
    element = model.elements[a]
    model.set_property(element, "ref", b)
    assert model.indexes.ref_targets == {b: {a}}

    props = {"name": "z"}
    model.overwrite(element, props, 1)
    assert element.properties is props
    assert element.rev == 1
    assert model.indexes.ref_targets == {}
    assert model.indexes.roots_page(0, 10) == [b, a]  # "b" < "z"
    model.indexes.verify_consistent()


def test_overwrite_refuses_a_detached_entity():
    model = Model(_mm())
    (a,) = _items(model, "a")
    element = model.elements[a]
    model.delete_element(a)
    with pytest.raises(KeyError, match="not part of this model"):
        model.overwrite(element, {}, 0)


# ---------------------------------------------------------------------------
# place in insertion order
# ---------------------------------------------------------------------------


def test_an_element_put_back_under_its_number_returns_to_its_place():
    model = Model(_mm())
    a, b, c = _items(model, "a", "b", "c")
    number = model.indexes.element_order[b]
    model.delete_element(b)

    model.insert_element(b, "Item", {"name": "b"}, 1, number)
    assert list(model.elements) == [a, c, b]  # last, until the order is settled
    before = model.elements
    model.settle_order()
    assert list(model.elements) == [a, b, c]
    assert model.elements is not before  # replaced, never refilled in place
    assert list(before) == [a, c, b]
    assert model.indexes.element_order[b] == number
    model.indexes.verify_consistent()

    # a new element still goes last, past every number handed out so far
    (d,) = _items(model, "d")
    assert list(model.elements) == [a, b, c, d]
    model.indexes.verify_consistent()


def test_settle_order_leaves_a_dict_in_order_alone():
    model = Model(_mm())
    a, b = _items(model, "a", "b")
    number = model.indexes.element_order[b]
    model.delete_element(b)
    model.insert_element(b, "Item", {"name": "b"}, 1, number)  # was last, is last
    elements, relationships = model.elements, model.relationships
    model.settle_order()
    assert model.elements is elements
    assert model.relationships is relationships
    assert list(model.elements) == [a, b]
    model.indexes.verify_consistent()


def test_a_relationship_put_back_under_its_number_returns_to_its_place():
    model = Model(_mm())
    a, b = _items(model, "a", "b")
    r1 = model.connect("Link", a, b).id
    r2 = model.connect("Link", b, a).id
    number = model.indexes.relationship_order[r1]
    model.disconnect(r1)

    model.insert_relationship(r1, "Link", a, b, {}, 0, number)
    assert list(model.relationships) == [r2, r1]
    model.settle_order()
    assert list(model.relationships) == [r1, r2]
    model.indexes.verify_consistent()


def test_a_containment_relationship_put_back_is_the_first_parent_again():
    model = Model(_mm())
    p1, p2, child = _items(model, "p1", "p2", "child")
    h1 = model.connect("Holds", p1, child).id
    model.connect("Holds", p2, child)
    assert model.container_of(child) == p1
    number = model.indexes.relationship_order[h1]
    model.disconnect(h1)
    assert model.container_of(child) == p2

    model.insert_relationship(h1, "Holds", p1, child, {}, 0, number)
    model.settle_order()
    assert model.container_of(child) == p1
    assert model.indexes.containment_parents[child] == [p1, p2]
    model.indexes.verify_consistent()
```

In `tests/model/test_indexes.py`, replace:

```python
        model.indexes.verify_consistent()


def test_verify_consistent_detects_element_order_missing_key():
    model = Model(_mm())
    a = model.create_element("Doc")
```

with:

```python
        model.indexes.verify_consistent()


def test_relationship_order_tracks_insertion_through_churn():
    model = Model(_mm())
    a = model.create_element("Doc")
    b = model.create_element("Doc")
    r1 = model.connect("Links", a.id, b.id)
    r2 = model.connect("Links", b.id, a.id)
    order = model.indexes.relationship_order
    assert order[r1.id] < order[r2.id]

    model.disconnect(r1.id)
    assert r1.id not in model.indexes.relationship_order

    # a re-inserted id lands LAST in the dict and gets a fresh, larger number
    model.restore_relationship(r1.id, "Links", a.id, b.id)
    assert list(model.relationships) == [r2.id, r1.id]
    assert order[r1.id] > order[r2.id]
    model.indexes.verify_consistent()

    # a cascade takes the numbers of the relationships it removes
    model.delete_element(a.id)
    assert model.indexes.relationship_order == {}
    model.indexes.verify_consistent()


def test_relationship_order_rebuilt_from_dict_order():
    model = Model(_mm())
    a = model.create_element("Doc")
    b = model.create_element("Doc")
    r1 = model.connect("Links", a.id, b.id)
    r2 = model.connect("Links", b.id, a.id)
    model.disconnect(r1.id)
    model.restore_relationship(r1.id, "Links", a.id, b.id)

    model.indexes.rebuild()
    assert model.indexes.relationship_order == {r2.id: 0, r1.id: 1}
    # the counter continues past the rebuilt numbers
    r3 = model.connect("Links", a.id, a.id)
    assert model.indexes.relationship_order[r3.id] == 2
    model.indexes.verify_consistent()


def test_verify_consistent_detects_relationship_order_drift():
    model = Model(_mm())
    a = model.create_element("Doc")
    b = model.create_element("Doc")
    r1 = model.connect("Links", a.id, b.id)
    r2 = model.connect("Links", b.id, a.id)
    order = model.indexes.relationship_order
    order[r1.id], order[r2.id] = order[r2.id], order[r1.id]
    with pytest.raises(AssertionError, match="relationship_order"):
        model.indexes.verify_consistent()


def test_verify_consistent_detects_element_order_missing_key():
    model = Model(_mm())
    a = model.create_element("Doc")
```

- [ ] **Step 3: Run them to see them fail**

Run: `pixi run -e core-dev pytest tests/model/test_model_committed.py tests/model/test_indexes.py -q`
Expected: `14 failed, 37 passed` — every failure an `AttributeError` (`'Model' object has no attribute 'insert_element'` / `'overwrite'`, `'IndexSet' object has no attribute 'relationship_order'`).

- [ ] **Step 4: Give the index set a relationship order and ordered create hooks**

In `src/data_rover/core/model/indexes.py`, replace:

```python
carries the same obligations: ``rebuild()`` recomputes it from scratch, and
any direct writer of ``entity.properties`` must go through
``on_properties_changed`` so a root's display-name reposition is not missed.
The element insertion-order index (``element_order``) is maintained by the
two element hooks alone — an element never moves within ``model.elements``,
so property and relationship changes leave it untouched — and re-derived by
``rebuild()``.
The trigram search index (``search_postings`` / ``_trigrams_of``) is
maintained at that same boundary with the same obligations; it feeds
``search_candidates`` (the fuzzy-search candidate generator) and, like the
```

with:

```python
carries the same obligations: ``rebuild()`` recomputes it from scratch, and
any direct writer of ``entity.properties`` must go through
``on_properties_changed`` so a root's display-name reposition is not missed.
The insertion-order indexes (``element_order``, ``relationship_order``) are
maintained by the create and delete hooks alone — an entity never moves within
its dict, so property changes leave them untouched — and re-derived by
``rebuild()``. A create hook handed an ``order`` puts the entity back under
the number it had (``Model.insert_element`` / ``insert_relationship``).
The trigram search index (``search_postings`` / ``_trigrams_of``) is
maintained at that same boundary with the same obligations; it feeds
``search_candidates`` (the fuzzy-search candidate generator) and, like the
```

In `src/data_rover/core/model/indexes.py`, replace:

```python
        #: uniqueness validator pick a duplicate group's insertion-first
        #: primary without enumerating the model. Numbers are sparse after
        #: churn; only their ORDER is meaningful. Replaced wholesale by
        #: ``rebuild()``: never cache the dict across one.
        self.element_order: dict[str, int] = {}
        self._next_order: int = 0
        #: lowercased trigram -> ids of elements whose searchable text
        #: contains it. The searchable text is exactly the fields the fuzzy
        #: element search scores (routes/read.py _search_score): the id, the
```

with:

```python
        #: uniqueness validator pick a duplicate group's insertion-first
        #: primary without enumerating the model. Numbers are sparse after
        #: churn; only their ORDER is meaningful. Replaced wholesale by
        #: ``rebuild()``: never cache the dict across one. The one exception
        #: to "lands last": an entity inserted WITH its old number
        #: (``Model.insert_element``) sits last in the dict until
        #: ``Model.settle_order`` moves it back, and the invariant holds
        #: again from there.
        self.element_order: dict[str, int] = {}
        self._next_order: int = 0
        #: relationship id -> insertion sequence number; the twin of
        #: ``element_order`` over ``model.relationships``, with its own counter.
        self.relationship_order: dict[str, int] = {}
        self._next_relationship_order: int = 0
        #: lowercased trigram -> ids of elements whose searchable text
        #: contains it. The searchable text is exactly the fields the fuzzy
        #: element search scores (routes/read.py _search_score): the id, the
```

In `src/data_rover/core/model/indexes.py`, replace:

```python

    # -- mutation hooks (called from the Model mutation boundary) ----------

    def on_element_created(self, element: Element) -> None:
        self.element_order[element.id] = self._next_order
        self._next_order += 1
        self.elements_by_type.setdefault(element.type_name, set()).add(element.id)
        self._add_to_group(element)
        self._update_refs(element.id, self._element_refs(element))
```

with:

```python

    # -- mutation hooks (called from the Model mutation boundary) ----------

    def on_element_created(self, element: Element, order: int | None = None) -> None:
        """``order`` is the sequence number of an element put back where it
        was; absent, the element is new and takes the next one."""
        if order is None:
            order = self._next_order
        self.element_order[element.id] = order
        self._next_order = max(self._next_order, order + 1)
        self.elements_by_type.setdefault(element.type_name, set()).add(element.id)
        self._add_to_group(element)
        self._update_refs(element.id, self._element_refs(element))
```

In `src/data_rover/core/model/indexes.py`, replace:

```python
        self._trigrams_of.pop(element.id, None)
        self.element_order.pop(element.id, None)

    def on_relationship_created(self, rel: Relationship) -> None:
        self.out_rels.setdefault(rel.source_id, set()).add(rel.id)
        self.in_rels.setdefault(rel.target_id, set()).add(rel.id)
        self.out_count[(rel.source_id, rel.type_name)] += 1
        self.in_count[(rel.target_id, rel.type_name)] += 1
        self._update_refs(rel.id, self._relationship_refs(rel))
        if self._containment(rel.type_name):
            self.containment_parents.setdefault(rel.target_id, []).append(rel.source_id)
            self._containment_rel_ids.setdefault(rel.target_id, []).append(rel.id)
            if len(self.containment_parents[rel.target_id]) == 1:
                # first containment parent: the target stops being a root
                self._roots_remove(rel.target_id)
            self._rekey_if_present(rel.target_id)
        self._rekey_key_rel_endpoints(rel)

    def on_relationship_deleted(self, rel: Relationship) -> None:
        outs = self.out_rels.get(rel.source_id)
        if outs is not None:
            outs.discard(rel.id)
```

with:

```python
        self._trigrams_of.pop(element.id, None)
        self.element_order.pop(element.id, None)

    def on_relationship_created(
        self, rel: Relationship, order: int | None = None
    ) -> None:
        """``order`` as in :meth:`on_element_created`."""
        if order is None:
            order = self._next_relationship_order
        self.relationship_order[rel.id] = order
        self._next_relationship_order = max(self._next_relationship_order, order + 1)
        self.out_rels.setdefault(rel.source_id, set()).add(rel.id)
        self.in_rels.setdefault(rel.target_id, set()).add(rel.id)
        self.out_count[(rel.source_id, rel.type_name)] += 1
        self.in_count[(rel.target_id, rel.type_name)] += 1
        self._update_refs(rel.id, self._relationship_refs(rel))
        if self._containment(rel.type_name):
            parents = self.containment_parents.setdefault(rel.target_id, [])
            rel_ids = self._containment_rel_ids.setdefault(rel.target_id, [])
            # relationship insertion order: a new relationship goes last, one
            # put back under its old number goes back among its siblings
            at = len(rel_ids)
            while at > 0 and self.relationship_order[rel_ids[at - 1]] > order:
                at -= 1
            parents.insert(at, rel.source_id)
            rel_ids.insert(at, rel.id)
            if len(parents) == 1:
                # first containment parent: the target stops being a root
                self._roots_remove(rel.target_id)
            self._rekey_if_present(rel.target_id)
        self._rekey_key_rel_endpoints(rel)

    def on_relationship_deleted(self, rel: Relationship) -> None:
        self.relationship_order.pop(rel.id, None)
        outs = self.out_rels.get(rel.source_id)
        if outs is not None:
            outs.discard(rel.id)
```

In `src/data_rover/core/model/indexes.py`, replace:

```python
            self._rebuild_gen += 1

        # relationships first so containment parents are known before grouping
        for rel in self._model.relationships.values():
            self.out_rels.setdefault(rel.source_id, set()).add(rel.id)
            self.in_rels.setdefault(rel.target_id, set()).add(rel.id)
            self.out_count[(rel.source_id, rel.type_name)] += 1
```

with:

```python
            self._rebuild_gen += 1

        # relationships first so containment parents are known before grouping
        rel_order: dict[str, int] = {}
        for i, rel in enumerate(self._model.relationships.values()):
            rel_order[rel.id] = i
            self.out_rels.setdefault(rel.source_id, set()).add(rel.id)
            self.in_rels.setdefault(rel.target_id, set()).add(rel.id)
            self.out_count[(rel.source_id, rel.type_name)] += 1
```

In `src/data_rover/core/model/indexes.py`, replace:

```python
                self._root_key_of[element.id] = (display_name(element), element.id)
        self.element_order = order
        self._next_order = len(order)
        # bulk-construct in one O(n log n) pass instead of n incremental adds
        self.roots_order = SortedPairs(self._root_key_of.values())

```

with:

```python
                self._root_key_of[element.id] = (display_name(element), element.id)
        self.element_order = order
        self._next_order = len(order)
        self.relationship_order = rel_order
        self._next_relationship_order = len(rel_order)
        # bulk-construct in one O(n log n) pass instead of n incremental adds
        self.roots_order = SortedPairs(self._root_key_of.values())

```

In `src/data_rover/core/model/indexes.py`, replace:

```python
            )
            if _norm(name, getattr(self, name)) != _norm(name, getattr(fresh, name))
        ]
        # element_order carries sparse numbers after churn (a rebuild's are
        # dense), so compare the ORDER it induces, never the numbers; the
        # numbers must also be distinct, since a stable sort hides a duplicate
        order = self.element_order
        ids = list(self._model.elements)
        if (
            set(order) != set(ids)
            or len(set(order.values())) != len(order)
            or sorted(ids, key=order.__getitem__) != ids
        ):
            mismatched.append("element_order")
        if mismatched:
            raise AssertionError(
                "IndexSet inconsistent with a fresh rebuild in: "
```

with:

```python
            )
            if _norm(name, getattr(self, name)) != _norm(name, getattr(fresh, name))
        ]
        # the order indexes carry sparse numbers after churn (a rebuild's are
        # dense), so compare the ORDER they induce, never the numbers; the
        # numbers must also be distinct, since a stable sort hides a duplicate
        for name, order, ids in (
            ("element_order", self.element_order, list(self._model.elements)),
            (
                "relationship_order",
                self.relationship_order,
                list(self._model.relationships),
            ),
        ):
            if (
                set(order) != set(ids)
                or len(set(order.values())) != len(order)
                or sorted(ids, key=order.__getitem__) != ids
            ):
                mismatched.append(name)
        if mismatched:
            raise AssertionError(
                "IndexSet inconsistent with a fresh rebuild in: "
```

- [ ] **Step 5: Give the model the committed-state methods**

In `src/data_rover/core/model/model.py`, replace:

```python
from __future__ import annotations

from ..metamodel.schema import Metamodel
from .element import Element
```

with:

```python
from __future__ import annotations

from typing import Any

from ..metamodel.schema import Metamodel
from .element import Element
```

In `src/data_rover/core/model/model.py`, replace:

```python
        self.elements: dict[str, Element] = {}
        self.relationships: dict[str, Relationship] = {}
        self.indexes = IndexSet(self)

    # --- mutation boundary: elements ---
    def create_element(self, type_name: str) -> Element:
```

with:

```python
        self.elements: dict[str, Element] = {}
        self.relationships: dict[str, Relationship] = {}
        self.indexes = IndexSet(self)
        # set when an entity came back under an old sequence number: its dict
        # is out of order until settle_order() puts it right
        self._elements_unsettled = False
        self._relationships_unsettled = False

    # --- mutation boundary: elements ---
    def create_element(self, type_name: str) -> Element:
```

In `src/data_rover/core/model/model.py`, replace:

```python
            raise KeyError(f"Unknown element type {type_name!r}")
        if et.abstract:
            raise ValueError(f"Cannot instantiate abstract type {type_name!r}")
        if element_id in self.elements or element_id in self.relationships:
            raise ValueError(f"Id {element_id!r} is already in use")
        element = Element(id=element_id, type_name=type_name)
        self.elements[element.id] = element
        self.indexes.on_element_created(element)
        return element

    # --- queries ---
    def get_element(self, element_id: str) -> Element:
```

with:

```python
            raise KeyError(f"Unknown element type {type_name!r}")
        if et.abstract:
            raise ValueError(f"Cannot instantiate abstract type {type_name!r}")
        return self.insert_element(element_id, type_name, {}, 0)

    # --- queries ---
    def get_element(self, element_id: str) -> Element:
```

In `src/data_rover/core/model/model.py`, replace:

```python
            raise KeyError(f"No source element {source_id!r}")
        if target_id not in self.elements:
            raise KeyError(f"No target element {target_id!r}")
        if rel_id in self.relationships or rel_id in self.elements:
            raise ValueError(f"Id {rel_id!r} is already in use")
        rel = Relationship(
```

with:

```python
            raise KeyError(f"No source element {source_id!r}")
        if target_id not in self.elements:
            raise KeyError(f"No target element {target_id!r}")
        return self.insert_relationship(rel_id, rel_type, source_id, target_id, {}, 0)

    def disconnect(self, rel_id: str) -> None:
        if rel_id not in self.relationships:
            raise KeyError(f"No relationship with id {rel_id!r}")
        rel = self.relationships.pop(rel_id)
        self.indexes.on_relationship_deleted(rel)

    # --- committed state ---
    #
    # An entity put back as it was arrives whole: its type is not checked (a
    # model may hold one its metamodel no longer has) and its ``rev`` is
    # given, not counted. ``order`` is the sequence number it had
    # (``IndexSet.element_order`` / ``relationship_order``); the entity then
    # sits last in its dict until :meth:`settle_order`.

    def insert_element(
        self,
        element_id: str,
        type_name: str,
        properties: dict[str, Any],
        rev: int,
        order: int | None = None,
    ) -> Element:
        """Insert an element as it is. Takes over ``properties``."""
        if element_id in self.elements or element_id in self.relationships:
            raise ValueError(f"Id {element_id!r} is already in use")
        element = Element(
            id=element_id, type_name=type_name, properties=properties, rev=rev
        )
        if _lands_out_of_place(self.elements, self.indexes.element_order, order):
            self._elements_unsettled = True
        self.elements[element.id] = element
        self.indexes.on_element_created(element, order)
        return element

    def insert_relationship(
        self,
        rel_id: str,
        rel_type: str,
        source_id: str,
        target_id: str,
        properties: dict[str, Any],
        rev: int,
        order: int | None = None,
    ) -> Relationship:
        """Insert a relationship as it is. Takes over ``properties``."""
        if source_id not in self.elements:
            raise KeyError(f"No source element {source_id!r}")
        if target_id not in self.elements:
            raise KeyError(f"No target element {target_id!r}")
        if rel_id in self.relationships or rel_id in self.elements:
            raise ValueError(f"Id {rel_id!r} is already in use")
        rel = Relationship(
```

In `src/data_rover/core/model/model.py`, replace:

```python
            type_name=rel_type,
            source_id=source_id,
            target_id=target_id,
        )
        self.relationships[rel.id] = rel
        self.indexes.on_relationship_created(rel)
        return rel

    def disconnect(self, rel_id: str) -> None:
        if rel_id not in self.relationships:
            raise KeyError(f"No relationship with id {rel_id!r}")
        rel = self.relationships.pop(rel_id)
        self.indexes.on_relationship_deleted(rel)

    # The index-backed helpers below return relationships in unspecified set
    # iteration order; no caller depends on the order.
```

with:

```python
            type_name=rel_type,
            source_id=source_id,
            target_id=target_id,
            properties=properties,
            rev=rev,
        )
        if _lands_out_of_place(
            self.relationships, self.indexes.relationship_order, order
        ):
            self._relationships_unsettled = True
        self.relationships[rel.id] = rel
        self.indexes.on_relationship_created(rel, order)
        return rel

    def overwrite(
        self, target: Element | Relationship, properties: dict[str, Any], rev: int
    ) -> None:
        """Replace an attached entity's properties and ``rev`` whole. Takes
        over ``properties``."""
        if (
            self.elements.get(target.id) is not target
            and self.relationships.get(target.id) is not target
        ):
            raise KeyError(f"Entity {target.id!r} is not part of this model")
        target.properties = properties
        target.rev = rev
        self.indexes.on_properties_changed(target)

    def settle_order(self) -> None:
        """Put ``elements`` / ``relationships`` back in sequence order after
        an insert under an old number. O(n) per dict that needs it, nothing
        otherwise.

        The ordered dict REPLACES the attribute instead of being refilled in
        place: read paths iterate these dicts without the session's write
        mutex, and a rebind shows them either dict whole, never an empty one.
        Do not keep a reference to either dict across this call.
        """
        if self._elements_unsettled:
            order = self.indexes.element_order
            elements = self.elements
            self.elements = {
                eid: elements[eid] for eid in sorted(elements, key=order.__getitem__)
            }
            self._elements_unsettled = False
        if self._relationships_unsettled:
            order = self.indexes.relationship_order
            relationships = self.relationships
            self.relationships = {
                rid: relationships[rid]
                for rid in sorted(relationships, key=order.__getitem__)
            }
            self._relationships_unsettled = False

    # The index-backed helpers below return relationships in unspecified set
    # iteration order; no caller depends on the order.
```

In `src/data_rover/core/model/model.py`, replace:

```python
        self.indexes.on_element_deleted(element)


def build_rebind_view(live_model: Model, candidate: Metamodel) -> Model:
    """A READ-ONLY ``Model`` bound to ``candidate`` over ``live_model``'s data.

```

with:

```python
        self.indexes.on_element_deleted(element)


def _lands_out_of_place(
    entities: dict[str, Any], numbers: dict[str, int], order: int | None
) -> bool:
    """Whether an entity appended to ``entities`` under sequence number
    ``order`` sits behind one with a larger number."""
    if order is None or not entities:
        return False
    return numbers[next(reversed(entities))] > order


def build_rebind_view(live_model: Model, candidate: Metamodel) -> Model:
    """A READ-ONLY ``Model`` bound to ``candidate`` over ``live_model``'s data.

```

- [ ] **Step 6: Run the tests**

Run: `pixi run -e core-dev pytest tests/model tests/golden -q`
Expected: `163 passed`.

- [ ] **Step 7: Check that no fixture moved**

`restore_element` and `restore_relationship` now go through the new inserts; the fixtures say whether they still behave.

```bash
pixi run golden-fixtures
git status --short engine/fixtures
```

Expected: `git status` prints nothing.

- [ ] **Step 8: Say it in `CLAUDE.md`**

In `CLAUDE.md`, replace:

```markdown
`verify_consistent` checks it as an order invariant, never by comparing numbers to a fresh rebuild. `set_property`/`delete_property` check
```

with:

```markdown
`verify_consistent` checks it as an order invariant, never by comparing numbers to a fresh rebuild. `relationship_order` is its twin over `model.relationships`, with its own counter, and is what keeps `containment_parents` in relationship insertion order when a relationship comes back under an old number. `set_property`/`delete_property` check
```

In `CLAUDE.md`, replace:

```markdown
`delete_element` cascades through containment children. Property values are **replaced wholesale, never mutated in place**
```

with:

```markdown
`delete_element` cascades through containment children. `insert_element` / `insert_relationship` / `overwrite` are the committed-state methods, the only way an entity is put back as it was: they check no type (a model may hold one its metamodel no longer has), take `rev` as given and fire the same hooks; handed the entity's old sequence number they give it its place back, and `settle_order()` then puts the dicts in that order by REPLACING them — read routes iterate them without `write_mutex`, so never refill one in place and never keep a reference to one across that call. Property values are **replaced wholesale, never mutated in place**
```

- [ ] **Step 9: Lint**

```bash
pixi run core-lint
pixi run -e core-dev ruff check tests/model/test_model_committed.py tests/model/test_indexes.py
pixi run -e core-dev ruff format --check tests/model/test_model_committed.py
```

Expected: ruff `All checks passed!`, mypy `Success: no issues found`, pyright `0 errors`, `1 file already formatted`.

- [ ] **Step 10: Commit**

```bash
git add tests/model/test_model_committed.py tests/model/test_indexes.py src/data_rover/core/model/indexes.py src/data_rover/core/model/model.py CLAUDE.md
git commit -m "Give the model the committed-state methods and a relationship order"
```

---

### Task 2: An exact rollback (`K-30`)

`_rollback` stops replaying inverse ops and becomes the engine's `rewind`, pass for pass: relationships out, elements out, elements in, relationships in, then `settle_order()`. A survivor is told from an entity created again under its id by its sequence number, noted with the before-image. `_rollback` takes the `_BatchResult`, and every caller — the applier itself, preview, staged validation, `_CommitUnwind`, the persist failures of `/model/ops` and `/model/undo` — moves to it, so one change fixes them all. The golden recorder drops its deep copy and holds the oracle to "no trace"; `ops_refused` refuses after every kind of touch.

**Files:**
- Create: `tests/api/test_exact_rollback.py`, `tests/golden/scenarios/ops_refused.py`, `engine/test/ops/refused.golden.test.ts`
- Modify: `tests/golden/model_steps.py`, `tests/golden/scenarios/__init__.py`, `src/data_rover/api/routes/ops.py`, `src/data_rover/api/routes/commits.py`, `src/data_rover/api/routes/validation.py`, `CLAUDE.md`, `architecture/contracts.md`, `BACKLOG-ENGINE.md`, `BACKLOG.md`
- Generated: `engine/fixtures/golden/ops_refused.json`

**Interfaces:**
- Consumes: Task 1's `Model.insert_element`, `insert_relationship`, `overwrite`, `settle_order`; `IndexSet.element_order`, `relationship_order`.
- Produces: `_rollback(model: Model, res: _BatchResult) -> None` (was `_rollback(model, inverse_units)`); `_BatchResult.before_element_orders: dict[str, int]`, `before_relationship_orders: dict[str, int]`; `_BatchResult.note_element_before(model, element_id, element)` and `note_relationship_before(model, rel_id, rel)` (both gained `model`).

- [ ] **Step 1: Write the failing tests, one per path that rolls a batch back**

`tests/api/test_exact_rollback.py` (create):

```python
"""A batch applied and then taken back leaves no trace on the live model:
every ``rev``, every place in insertion order, every index and the state
digest as they were. One test per path that rolls a model batch back."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.routes._snapshot import build_model_from_dicts
from data_rover.api.routes.ops import _apply_batch, _rollback
from data_rover.api.schemas import ModelOpIn
from data_rover.api.serialize import iter_entity_lines
from data_rover.api.session import get_session
from data_rover.api.state_digest import model_digest
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model
from pydantic import TypeAdapter

from .conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Node
    properties:
      - {name: name, datatype: string}
      - {name: note, datatype: string}
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
  - name: Link
    source: Node
    target: Node
    properties:
      - {name: label, datatype: string}
"""

_OPS: TypeAdapter[list[ModelOpIn]] = TypeAdapter(list[ModelOpIn])


def _node(temp_id: str, name: str) -> dict[str, Any]:
    return {
        "kind": "create_element",
        "temp_id": temp_id,
        "type_name": "Node",
        "properties": {"name": name},
    }


def _rel(temp_id: str, kind: str, source: str, target: str) -> dict[str, Any]:
    return {
        "kind": "create_relationship",
        "temp_id": temp_id,
        "type_name": kind,
        "source_id": source,
        "target_id": target,
        "properties": {},
    }


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(
        papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"}
    )
    assert res.status_code == 200, res.text
    res = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert res.status_code == 200, res.text
    return c


def _live() -> Model:
    model = get_session().model
    assert model is not None
    return model


def _seed(client: TestClient) -> dict[str, str]:
    """a contains b contains c, a links c; then revs moved apart."""
    res = client.post(
        papi("/model/ops"),
        json={
            "base_rev": get_session().model_rev,
            "ops": [
                _node("tmp_a", "a"),
                _node("tmp_b", "b"),
                _node("tmp_c", "c"),
                _rel("tmp_ab", "Contains", "tmp_a", "tmp_b"),
                _rel("tmp_bc", "Contains", "tmp_b", "tmp_c"),
                _rel("tmp_ac", "Link", "tmp_a", "tmp_c"),
            ],
        },
    )
    assert res.status_code == 200, res.text
    ids: dict[str, str] = res.json()["id_map"]
    res = client.post(
        papi("/model/ops"),
        json={
            "base_rev": get_session().model_rev,
            "ops": [
                {
                    "kind": "update_element",
                    "id": ids["tmp_b"],
                    "properties_patch": {"note": "n"},
                },
                {
                    "kind": "update_relationship",
                    "id": ids["tmp_ac"],
                    "properties_patch": {"label": "x"},
                },
            ],
        },
    )
    assert res.status_code == 200, res.text
    return ids


def _observed(model: Model) -> tuple[list[str], str]:
    model.indexes.verify_consistent()
    return list(iter_entity_lines(model)), model_digest(model)


def _touching(ids: dict[str, str]) -> list[dict[str, Any]]:
    """Every kind of touch: an update of an element that stays and of one
    that goes, a cascade (so that what it takes must come back ahead of what
    was behind it), a create."""
    return [
        {
            "kind": "update_element",
            "id": ids["tmp_a"],
            "properties_patch": {"note": "kept"},
        },
        {
            "kind": "update_element",
            "id": ids["tmp_c"],
            "properties_patch": {"name": "c2", "note": "new"},
        },
        {"kind": "delete_element", "id": ids["tmp_b"]},
        _node("tmp_d", "d"),
        _rel("tmp_ad", "Link", ids["tmp_a"], "tmp_d"),
    ]


def test_a_refused_batch_leaves_no_trace(client: TestClient) -> None:
    ids = _seed(client)
    before = _observed(_live())
    rev = get_session().model_rev
    ghost = {"kind": "update_element", "id": "ghost", "properties_patch": {}}
    res = client.post(
        papi("/model/ops"), json={"base_rev": rev, "ops": [*_touching(ids), ghost]}
    )
    assert res.status_code == 422, res.text
    assert _observed(_live()) == before
    assert get_session().model_rev == rev


def test_a_preview_leaves_no_trace(client: TestClient) -> None:
    ids = _seed(client)
    before = _observed(_live())
    res = client.post(
        papi("/commits/preview"),
        json={"base_rev": get_session().model_rev, "ops": _touching(ids)},
    )
    assert res.status_code == 200, res.text
    assert _observed(_live()) == before


def test_a_staged_validation_leaves_no_trace(client: TestClient) -> None:
    ids = _seed(client)
    before = _observed(_live())
    res = client.post(
        papi("/model/validate"),
        json={"base_rev": get_session().model_rev, "ops": _touching(ids)},
    )
    assert res.status_code == 200, res.text
    assert _observed(_live()) == before


def test_a_commit_refused_for_a_structural_blocker_leaves_no_trace(
    client: TestClient,
) -> None:
    ids = _seed(client)
    before = _observed(_live())
    lock = client.post(
        papi("/locks"),
        json={
            # a connect edits its source and pins its target
            "targets": [
                {"resource_id": ids["tmp_c"], "mode": "exclusive"},
                {"resource_id": ids["tmp_a"], "mode": "shared"},
            ],
            "intent": "edit",
        },
    )
    assert lock.status_code == 200, lock.text
    res = client.post(
        papi("/commits"),
        json={
            "base_rev": get_session().model_rev,
            "ops": [
                {
                    "kind": "update_element",
                    "id": ids["tmp_c"],
                    "properties_patch": {"note": "new"},
                },
                # c already sits under b, which sits under a: a cycle
                _rel("tmp_ca", "Contains", ids["tmp_c"], ids["tmp_a"]),
            ],
            "lock_tokens": [lock.json()["token"]],
            "message": "cycle",
        },
    )
    assert res.status_code == 422, res.text
    assert res.json()["structural_blockers"]
    assert _observed(_live()) == before


def test_a_batch_that_could_not_be_persisted_leaves_no_trace(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    ids = _seed(client)
    before = _observed(_live())
    rev = get_session().model_rev

    def _boom(*args: Any, **kwargs: Any) -> bool:
        raise RuntimeError("no database")

    monkeypatch.setattr("data_rover.api.routes.ops._persist_commit", _boom)
    res = client.post(papi("/model/ops"), json={"base_rev": rev, "ops": _touching(ids)})
    assert res.status_code == 500, res.text
    assert _observed(_live()) == before
    assert get_session().model_rev == rev


def test_rollback_puts_back_an_entity_whose_type_the_metamodel_lacks() -> None:
    metamodel = load_metamodel_str(_MM)
    raw = {
        "elements": [
            {"id": "e1", "type_name": "Gone", "properties": {"x": 1}, "rev": 4},
            {"id": "e2", "type_name": "Node", "properties": {"name": "n"}, "rev": 1},
        ],
        "relationships": [
            {
                "id": "r1",
                "type_name": "GoneToo",
                "source_id": "e1",
                "target_id": "e2",
                "properties": {},
                "rev": 2,
            }
        ],
    }
    model = build_model_from_dicts(metamodel, raw, strict=False)
    before = _observed(model)
    ops = _OPS.validate_python([{"kind": "delete_element", "id": "e1"}])
    res = _apply_batch(model, ops, restore=False)
    assert list(model.elements) == ["e2"]

    _rollback(model, res)
    assert _observed(model) == before
```

- [ ] **Step 2: Run them to see them fail**

Run: `pixi run -e core-dev pytest tests/api/test_exact_rollback.py -q`
Expected: `6 failed`. Five fail on `assert _observed(...) == before` — `rev`s counted up, restored entities last; the sixth on `TypeError: '_BatchResult' object is not reversible`, its call being the new signature.

- [ ] **Step 3: Run the recorder's batches on the live model, and add the scenario**

In `tests/golden/model_steps.py`, replace:

```python
step that changed nothing says ``"unchanged": true`` instead. The engine's
golden runner replays the same steps and compares all of it.

A batch is applied to a deep copy of the model, and the copy is kept only when
the batch lands. The applier's own rollback replays inverse ops, which leaves
``rev`` counters bumped and restored entities at the end of their dict; the
engine's contract is that a refused batch leaves no trace at all, so none of
that may enter a fixture. The detail text of the refusal is still the oracle's.
"""

from __future__ import annotations

import copy
import hashlib
import json
from collections.abc import Iterable
```

with:

```python
step that changed nothing says ``"unchanged": true`` instead. The engine's
golden runner replays the same steps and compares all of it.

A batch runs on the recorder's own model, as it does on a session's. A refused
batch leaves no trace — the applier puts every touched entity back, ``rev``
and place in insertion order included — and the recorder holds the oracle to
it: a refusal that changed the state, the index dump or the digest fails the
run instead of entering a fixture. The ids a refused batch drew go back to the
generator, which is the recorder's scaffolding and no part of the state.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
```

In `tests/golden/model_steps.py`, replace:

```python
from data_rover.api.state_digest import model_digest
from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.element import Element
from data_rover.core.model.ids import SequentialIdGenerator
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship

```

with:

```python
from data_rover.api.state_digest import model_digest
from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship

```

In `tests/golden/model_steps.py`, replace:

```python
    }


class Recorder:
    """One scenario in the making: a model with sequential ids, and its log."""

    def __init__(self, metamodel: Metamodel, *, full_every: int = 5) -> None:
        self.metamodel = metamodel
        self.model = Model(metamodel, SequentialIdGenerator())
        self._full_every = full_every
        self._steps: list[dict[str, Any]] = []
        self._last: dict[str, Any] | None = None
```

with:

```python
    }


class _Ids:
    """``id-1``, ``id-2``, … with a counter the recorder can put back."""

    def __init__(self) -> None:
        self.drawn = 0

    def new_id(self) -> str:
        self.drawn += 1
        return f"id-{self.drawn}"


class Recorder:
    """One scenario in the making: a model with sequential ids, and its log."""

    def __init__(self, metamodel: Metamodel, *, full_every: int = 5) -> None:
        self.metamodel = metamodel
        self._ids = _Ids()
        self.model = Model(metamodel, self._ids)
        self._full_every = full_every
        self._steps: list[dict[str, Any]] = []
        self._last: dict[str, Any] | None = None
```

In `tests/golden/model_steps.py`, replace:

```python
        return entity

    def _batch(self, ops: list[ModelOpIn], *, restore: bool) -> dict[str, Any]:
        # The metamodel is immutable: share it instead of copying it.
        trial = copy.deepcopy(self.model, {id(self.metamodel): self.metamodel})
        res = _apply_batch(trial, ops, restore=restore)
        self.model = trial
        self._landed[len(self._steps)] = res
        return _outcome(trial, res)

    def _apply(self, step: dict[str, Any]) -> Any:
        model = self.model
```

with:

```python
        return entity

    def _batch(self, ops: list[ModelOpIn], *, restore: bool) -> dict[str, Any]:
        drawn = self._ids.drawn
        try:
            res = _apply_batch(self.model, ops, restore=restore)
        except HTTPException:
            self._ids.drawn = drawn
            raise
        self._landed[len(self._steps)] = res
        return _outcome(self.model, res)

    def _apply(self, step: dict[str, Any]) -> Any:
        model = self.model
```

In `tests/golden/model_steps.py`, replace:

```python
            entry["result"] = None
            entry["error"] = {"status": exc.status_code, "detail": exc.detail}
        seen = observe(self.model)
        if seen == self._last:
            entry["unchanged"] = True
        else:
```

with:

```python
            entry["result"] = None
            entry["error"] = {"status": exc.status_code, "detail": exc.detail}
        seen = observe(self.model)
        if entry["error"] is not None and "status" in entry["error"]:
            before = self._last or observe(Model(self.metamodel))
            if seen != before:
                raise AssertionError(
                    f"step {len(self._steps)}: a refused batch left a trace"
                )
        if seen == self._last:
            entry["unchanged"] = True
        else:
```

`tests/golden/scenarios/ops_refused.py` (create):

```python
"""Batches refused midway, after each kind of touch: an update, a cascade,
a create left half made, an entity created again under its id, a rewire, a
restore-mode batch. The recorder fails the run when one leaves a trace, so
what the fixture holds is that none does — every ``rev``, every place in
insertion order and every index as it was — with landed batches in between to
show the state carries on from there."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import batch, run_steps

_METAMODEL = {
    "elements": [
        {
            "name": "Node",
            "key": ["name"],
            "properties": [
                {"name": "name", "datatype": "string"},
                {"name": "note", "datatype": "string"},
                {"name": "peer", "datatype": "Node"},
            ],
        }
    ],
    "relationships": [
        {"name": "Holds", "containment": True, "source": "Node", "target": "Node"},
        {
            "name": "Link",
            "source": "Node",
            "target": "Node",
            "properties": [{"name": "label", "datatype": "string"}],
        },
    ],
}


def _node(temp_id: str, name: str, **extra: Any) -> dict[str, Any]:
    properties = {"name": name, **extra.pop("properties", {})}
    return {
        "kind": "create_element",
        "temp_id": temp_id,
        "type_name": "Node",
        "properties": properties,
        **extra,
    }


def _rel(
    temp_id: str, kind: str, source: str, target: str, **extra: Any
) -> dict[str, Any]:
    return {
        "kind": "create_relationship",
        "temp_id": temp_id,
        "type_name": kind,
        "source_id": source,
        "target_id": target,
        **extra,
    }


def _update(entity_id: str, **patch: Any) -> dict[str, Any]:
    return {"kind": "update_element", "id": entity_id, "properties_patch": patch}


def _update_rel(rel_id: str, **patch: Any) -> dict[str, Any]:
    return {"kind": "update_relationship", "id": rel_id, "properties_patch": patch}


def _delete(entity_id: str) -> dict[str, Any]:
    return {"kind": "delete_element", "id": entity_id}


def _disconnect(rel_id: str) -> dict[str, Any]:
    return {"kind": "delete_relationship", "id": rel_id}


#: the op every refused batch ends on
_GHOST = _update("ghost", note="never")

_STEPS: list[dict[str, Any]] = [
    # id-1 a, id-2 b, id-3 c, id-4 d (peer: c); id-5 a holds c, id-6 b holds c
    # (c's first parent is a), id-7 c links d, id-8 d links a
    batch(
        [
            _node("tmp_a", "a"),
            _node("tmp_b", "b"),
            _node("tmp_c", "c"),
            _node("tmp_d", "d", properties={"peer": "tmp_c"}),
            _rel("tmp_h1", "Holds", "tmp_a", "tmp_c"),
            _rel("tmp_h2", "Holds", "tmp_b", "tmp_c"),
            _rel("tmp_l1", "Link", "tmp_c", "tmp_d", properties={"label": "x"}),
            _rel("tmp_l2", "Link", "tmp_d", "tmp_a"),
        ]
    ),
    # revs apart from one another, so a rev put back wrong shows
    batch([_update("id-2", note="n"), _update_rel("id-7", label="y")]),
    # updates: properties and rev go back, a key removed comes back
    batch(
        [
            _update("id-3", name="c2", note="new"),
            _update("id-2", note=None),
            _update_rel("id-7", label="z"),
            _GHOST,
        ]
    ),
    # an update that made a duplicate of a, and moved a root
    batch([_update("id-2", name="a"), _GHOST]),
    # a cascade: a takes c with it, and with them every relationship there is
    batch([_delete("id-1"), _GHOST]),
    # the relationship that makes a the FIRST parent of c, alone
    batch([_disconnect("id-5"), _GHOST]),
    # new entities, one of them holding an old one; then a create that fails
    # on its second property, its element already made
    batch(
        [
            _node("tmp_x", "x"),
            _rel("tmp_hx", "Holds", "tmp_x", "id-4"),
            _rel("tmp_lx", "Link", "tmp_x", "id-1", properties={"label": "new"}),
            _node("tmp_y", "y", properties={"nope": 1}),
        ]
    ),
    # b takes c with it; both are created again under their ids, and so is
    # the relationship between them
    batch(
        [
            _delete("id-2"),
            _node("tmp_b2", "b again", id="id-2"),
            _node("tmp_c2", "c again", id="id-3"),
            _rel("tmp_h3", "Holds", "tmp_b2", "tmp_c2", id="id-6"),
            _GHOST,
        ]
    ),
    # a rewire: the relationship created again under its id, at other ends
    batch(
        [
            _disconnect("id-7"),
            _rel("tmp_l3", "Link", "id-4", "id-3", id="id-7"),
            _GHOST,
        ]
    ),
    # refused for a value, not a key
    batch(
        [
            _update("id-1", note="gone again"),
            {"kind": "create_element", "temp_id": "bare", "type_name": "Node"},
        ]
    ),
    # a restore-mode batch reinstates an exact id, then fails
    batch(
        [
            {"kind": "create_element", "temp_id": "id-40", "type_name": "Node"},
            _delete("id-4"),
            _GHOST,
        ],
        restore=True,
    ),
    # the state carries on: id-9 is the next id, and goes last
    batch([_node("tmp_e", "e"), _rel("tmp_le", "Link", "tmp_e", "id-2")]),
    batch([_delete("id-2")]),
    {"do": "undo", "of": 12},
    # an undone delete left b and its relationships last; refuse over that
    batch([_update("id-2", note="m"), _delete("id-3"), _delete("id-9"), _GHOST]),
]


@scenario("ops_refused")
def ops_refused() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS, full_every=1)
```

In `tests/golden/scenarios/__init__.py`, replace:

```python
    ops_batches,
    ops_churn,
    ops_recreate,
    py_repr,
    smart_city,
    snapshot_v2,
```

with:

```python
    ops_batches,
    ops_churn,
    ops_recreate,
    ops_refused,
    py_repr,
    smart_city,
    snapshot_v2,
```

- [ ] **Step 4: Run the recorder to see the oracle fail its own contract**

Run: `pixi run golden-fixtures`
Expected: `AssertionError: step 29: a refused batch left a trace` (from `ops_batches`, the first scenario with a refused batch). No fixture is written by the failing scenario; if `git status --short engine/fixtures` shows anything, restore it with `git checkout engine/fixtures`.

- [ ] **Step 5: Make the rollback exact, and move every caller to it**

In `src/data_rover/api/routes/ops.py`, replace:

```python
Atomicity without deep copies
-----------------------------
Batches are atomic, but the model is NOT deep-copied per request (it can be
~80 MB): ops are applied directly to the live session model while inverse
ops are collected per completed mutation. If an op fails mid-batch, the
collected inverses are applied in reverse to roll the live model back to its
pre-batch state, and the request fails with 422. This trades a tiny rollback
path for O(batch) request cost instead of O(model).

Validation seeding
------------------
```

with:

```python
Atomicity without deep copies
-----------------------------
Batches are atomic, but the model is NOT deep-copied per request (it can be
~80 MB): ops are applied directly to the live session model while the state
of every entity is noted before its first touch. If an op fails mid-batch,
``_rollback`` puts each touched entity back from that before-image —
properties, ``rev`` and place in insertion order — and the request fails with
422. Every other path that applies a batch and takes it back (a preview, a
staged validation, a commit refused or not persisted) rolls back the same way,
so none of them leaves a trace. This trades a small rollback path for O(batch)
request cost instead of O(model).

Validation seeding
------------------
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
    before_relationships: dict[str, RelationshipOut | None] = field(
        default_factory=dict
    )

    def mark_element_changed(self, element_id: str) -> None:
        self.changed_element_ids[element_id] = None
```

with:

```python
    before_relationships: dict[str, RelationshipOut | None] = field(
        default_factory=dict
    )
    #: insertion sequence number of every before-image that is not None
    #: (``IndexSet.element_order`` / ``relationship_order``): where a rollback
    #: puts the entity back, and how it tells a survivor from an entity
    #: created again under the same id
    before_element_orders: dict[str, int] = field(default_factory=dict)
    before_relationship_orders: dict[str, int] = field(default_factory=dict)

    def mark_element_changed(self, element_id: str) -> None:
        self.changed_element_ids[element_id] = None
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
        self.deleted_relationship_ids[rel_id] = None
        self.changed_relationship_ids.pop(rel_id, None)

    def note_element_before(self, element_id: str, element: Element | None) -> None:
        """Record ``element``'s current state as its pre-batch state unless an
        earlier op in this batch already did. Call BEFORE mutating it."""
        if element_id not in self.before_elements:
            self.before_elements[element_id] = (
                ElementOut.from_core(element) if element is not None else None
            )

    def note_relationship_before(self, rel_id: str, rel: Relationship | None) -> None:
        if rel_id not in self.before_relationships:
            self.before_relationships[rel_id] = (
                RelationshipOut.from_core(rel) if rel is not None else None
            )

    def inverse_ops(self) -> list[ModelOpIn]:
        """Flat inverse batch: applying it front-to-back undoes this batch."""
```

with:

```python
        self.deleted_relationship_ids[rel_id] = None
        self.changed_relationship_ids.pop(rel_id, None)

    def note_element_before(
        self, model: Model, element_id: str, element: Element | None
    ) -> None:
        """Record ``element``'s current state as its pre-batch state unless an
        earlier op in this batch already did. Call BEFORE mutating it."""
        if element_id in self.before_elements:
            return
        if element is None:
            self.before_elements[element_id] = None
            return
        self.before_elements[element_id] = ElementOut.from_core(element)
        self.before_element_orders[element_id] = model.indexes.element_order[element_id]

    def note_relationship_before(
        self, model: Model, rel_id: str, rel: Relationship | None
    ) -> None:
        if rel_id in self.before_relationships:
            return
        if rel is None:
            self.before_relationships[rel_id] = None
            return
        self.before_relationships[rel_id] = RelationshipOut.from_core(rel)
        self.before_relationship_orders[rel_id] = model.indexes.relationship_order[
            rel_id
        ]

    def inverse_ops(self) -> list[ModelOpIn]:
        """Flat inverse batch: applying it front-to-back undoes this batch."""
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
                f"create_element temp_id {op.temp_id!r} must start with "
                f"{TEMP_ID_PREFIX!r}"
            )
        res.note_element_before(element.id, None)
        # inverse recorded BEFORE the property sets: if one of them fails,
        # rollback must delete the half-initialized element
        res.inverse_units.append(
            [DeleteElementOp(kind="delete_element", id=element.id)]
        )
```

with:

```python
                f"create_element temp_id {op.temp_id!r} must start with "
                f"{TEMP_ID_PREFIX!r}"
            )
        res.note_element_before(model, element.id, None)
        # inverse recorded BEFORE the property sets, so the unit list never
        # lags a mutation that happened
        res.inverse_units.append(
            [DeleteElementOp(kind="delete_element", id=element.id)]
        )
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
    if isinstance(op, UpdateElementOp):
        eid = res.id_map.get(op.id, op.id)
        element = model.get_element(eid)
        res.note_element_before(eid, element)
        patch = _resolve_props(op.properties_patch, res.id_map)
        _check_patch_keys(model, element.type_name, element=True, patch=patch)
        # mergePatch semantics (frontend apply.ts): None deletes the key,
```

with:

```python
    if isinstance(op, UpdateElementOp):
        eid = res.id_map.get(op.id, op.id)
        element = model.get_element(eid)
        res.note_element_before(model, eid, element)
        patch = _resolve_props(op.properties_patch, res.id_map)
        _check_patch_keys(model, element.type_name, element=True, patch=patch)
        # mergePatch semantics (frontend apply.ts): None deletes the key,
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
        unit: list[ModelOpIn] = []
        for ce in closure:
            e = model.elements[ce]
            res.note_element_before(ce, e)
            unit.append(
                CreateElementOp(
                    kind="create_element",
```

with:

```python
        unit: list[ModelOpIn] = []
        for ce in closure:
            e = model.elements[ce]
            res.note_element_before(model, ce, e)
            unit.append(
                CreateElementOp(
                    kind="create_element",
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
            )
        for rid in removed_rel_ids:
            r = model.relationships[rid]
            res.note_relationship_before(rid, r)
            unit.append(
                CreateRelationshipOp(
                    kind="create_relationship",
```

with:

```python
            )
        for rid in removed_rel_ids:
            r = model.relationships[rid]
            res.note_relationship_before(model, rid, r)
            unit.append(
                CreateRelationshipOp(
                    kind="create_relationship",
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
                f"create_relationship temp_id {op.temp_id!r} must start with "
                f"{TEMP_ID_PREFIX!r}"
            )
        res.note_relationship_before(rel.id, None)
        res.inverse_units.append(
            [DeleteRelationshipOp(kind="delete_relationship", id=rel.id)]
        )
```

with:

```python
                f"create_relationship temp_id {op.temp_id!r} must start with "
                f"{TEMP_ID_PREFIX!r}"
            )
        res.note_relationship_before(model, rel.id, None)
        res.inverse_units.append(
            [DeleteRelationshipOp(kind="delete_relationship", id=rel.id)]
        )
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
    if isinstance(op, UpdateRelationshipOp):
        rid = res.id_map.get(op.id, op.id)
        rel = model.get_relationship(rid)
        res.note_relationship_before(rid, rel)
        patch = _resolve_props(op.properties_patch, res.id_map)
        _check_patch_keys(model, rel.type_name, element=False, patch=patch)
        inverse_patch = {
```

with:

```python
    if isinstance(op, UpdateRelationshipOp):
        rid = res.id_map.get(op.id, op.id)
        rel = model.get_relationship(rid)
        res.note_relationship_before(model, rid, rel)
        patch = _resolve_props(op.properties_patch, res.id_map)
        _check_patch_keys(model, rel.type_name, element=False, patch=patch)
        inverse_patch = {
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
    if isinstance(op, DeleteRelationshipOp):
        rid = res.id_map.get(op.id, op.id)
        rel = model.get_relationship(rid)
        res.note_relationship_before(rid, rel)
        unit = [
            CreateRelationshipOp(
                kind="create_relationship",
```

with:

```python
    if isinstance(op, DeleteRelationshipOp):
        rid = res.id_map.get(op.id, op.id)
        rel = model.get_relationship(rid)
        res.note_relationship_before(model, rid, rel)
        unit = [
            CreateRelationshipOp(
                kind="create_relationship",
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
    assert_never(op)  # a new OpIn variant without a branch fails type-checking


def _rollback(model: Model, inverse_units: list[list[ModelOpIn]]) -> None:
    """Undo the completed mutations of a failed batch on the live model.

    Applies the recorded inverse units newest-first (preserving each unit's
    internal order) in restore mode. The dirty/delta bookkeeping is thrown
    away — the request fails, so no validation or response delta is built.
    """
    scratch = _BatchResult()
    for unit in reversed(inverse_units):
        for op in unit:
            _apply_one(model, op, scratch, restore=True)


def _error_detail(exc: BaseException) -> str:
```

with:

```python
    assert_never(op)  # a new OpIn variant without a branch fails type-checking


def _rollback(model: Model, res: _BatchResult) -> None:
    """Put every entity the batch touched back exactly as its before-image
    has it: properties, ``rev`` and place in insertion order. ``res`` may be
    the result of a batch that failed midway; the batch must be the newest
    change still applied to the model.

    An entity that outlived the batch still carries the sequence number of
    its image — one created again under the same id never does, creation
    always takes a new number — and is rewritten where it is. Whatever else
    the batch left under a touched id goes, relationships first, so that no
    element delete cascades into anything the batch did not touch; then what
    is missing comes back, elements first, because a relationship needs its
    ends. Replaying inverse ops instead would count ``rev`` up again and
    leave every restored entity last in its dict.
    """
    indexes = model.indexes
    for rid, rel_image in res.before_relationships.items():
        rel = model.relationships.get(rid)
        if rel is None:
            continue
        if (
            rel_image is not None
            and indexes.relationship_order[rid] == res.before_relationship_orders[rid]
        ):
            model.overwrite(rel, dict(rel_image.properties), rel_image.rev)
        else:
            model.disconnect(rid)
    for eid, image in res.before_elements.items():
        element = model.elements.get(eid)
        if element is None:
            continue
        if (
            image is not None
            and indexes.element_order[eid] == res.before_element_orders[eid]
        ):
            model.overwrite(element, dict(image.properties), image.rev)
        else:
            model.delete_element(eid)
    for eid, image in res.before_elements.items():
        if image is not None and eid not in model.elements:
            model.insert_element(
                eid,
                image.type_name,
                dict(image.properties),
                image.rev,
                res.before_element_orders[eid],
            )
    for rid, rel_image in res.before_relationships.items():
        if rel_image is not None and rid not in model.relationships:
            model.insert_relationship(
                rid,
                rel_image.type_name,
                rel_image.source_id,
                rel_image.target_id,
                dict(rel_image.properties),
                rel_image.rev,
                res.before_relationship_orders[rid],
            )
    model.settle_order()


def _error_detail(exc: BaseException) -> str:
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
def _apply_batch(model: Model, ops: list[ModelOpIn], *, restore: bool) -> _BatchResult:
    """Apply *ops* atomically to the live model.

    On ANY op failure the completed mutations are rolled back via their
    recorded inverses — the model, its indexes, and the validation store are
    left exactly as before the batch. The expected validation failures
    (KeyError/ValueError from the mutation boundary) become a 422; anything
    else is a bug and propagates (as a 500) AFTER the rollback, so even an
```

with:

```python
def _apply_batch(model: Model, ops: list[ModelOpIn], *, restore: bool) -> _BatchResult:
    """Apply *ops* atomically to the live model.

    On ANY op failure every touched entity is put back from its before-image
    (``_rollback``) — the model, its indexes, and the validation store are
    left exactly as before the batch. The expected validation failures
    (KeyError/ValueError from the mutation boundary) become a 422; anything
    else is a bug and propagates (as a 500) AFTER the rollback, so even an
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
        for op in ops:
            _apply_one(model, op, res, restore=restore)
    except Exception as exc:
        _rollback(model, res.inverse_units)
        if isinstance(exc, (KeyError, ValueError)):
            raise HTTPException(status_code=422, detail=_error_detail(exc)) from exc
        raise
```

with:

```python
        for op in ops:
            _apply_one(model, op, res, restore=restore)
    except Exception as exc:
        _rollback(model, res)
        if isinstance(exc, (KeyError, ValueError)):
            raise HTTPException(status_code=422, detail=_error_detail(exc)) from exc
        raise
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
                _entity_states=capture_entity_states(model, res),
            )
        except Exception as exc:
            _rollback(model, res.inverse_units)  # undo the in-memory mutation
            session.model_rev -= 1
            # The rev moves BACKWARDS here. A concurrent lock-free
            # /tables/evaluate may already have stamped the script cell cache
```

with:

```python
                _entity_states=capture_entity_states(model, res),
            )
        except Exception as exc:
            _rollback(model, res)  # undo the in-memory mutation
            session.model_rev -= 1
            # The rev moves BACKWARDS here. A concurrent lock-free
            # /tables/evaluate may already have stamped the script cell cache
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
            # renamed the row this undo wants back), but an UNforeseen error
            # must not be the one case that leaves the model half-undone.
            # Undo BOTH halves and re-push the batch so undo history survives.
            _rollback(model, res.inverse_units)
            session.invalidate_derived_caches()  # rolled back in place
            session.op_log.append(batch)
            db.rollback()  # discard staged artifact rows
```

with:

```python
            # renamed the row this undo wants back), but an UNforeseen error
            # must not be the one case that leaves the model half-undone.
            # Undo BOTH halves and re-push the batch so undo history survives.
            _rollback(model, res)
            session.invalidate_derived_caches()  # rolled back in place
            session.op_log.append(batch)
            db.rollback()  # discard staged artifact rows
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
                # docstring), so there is no separate rollback_view call here
                # — only a failure raised AFTER it succeeded needs one (the
                # persist-failure branch below).
                _rollback(model, res.inverse_units)
                session.invalidate_derived_caches()
                for _vid, done_view, done_res in reversed(view_results):
                    rollback_view(done_view, done_res.inverse_units)
```

with:

```python
                # docstring), so there is no separate rollback_view call here
                # — only a failure raised AFTER it succeeded needs one (the
                # persist-failure branch below).
                _rollback(model, res)
                session.invalidate_derived_caches()
                for _vid, done_view, done_res in reversed(view_results):
                    rollback_view(done_view, done_res.inverse_units)
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
            try:
                mm_res = apply_metamodel_ops(db, project_id, session, metamodel_inv)
            except Exception:
                _rollback(model, res.inverse_units)
                session.invalidate_derived_caches()
                for _vid, done_view, done_res in reversed(view_results):
                    rollback_view(done_view, done_res.inverse_units)
```

with:

```python
            try:
                mm_res = apply_metamodel_ops(db, project_id, session, metamodel_inv)
            except Exception:
                _rollback(model, res)
                session.invalidate_derived_caches()
                for _vid, done_view, done_res in reversed(view_results):
                    rollback_view(done_view, done_res.inverse_units)
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
                entity_states=capture_entity_states(model, res),
            )
        except Exception as exc:
            _rollback(model, res.inverse_units)  # undo the in-memory mutation
            session.model_rev -= 1
            session.invalidate_derived_caches()  # rev moved BACK; see apply_ops
            for _vid, done_view, done_res in reversed(view_results):
```

with:

```python
                entity_states=capture_entity_states(model, res),
            )
        except Exception as exc:
            _rollback(model, res)  # undo the in-memory mutation
            session.model_rev -= 1
            session.invalidate_derived_caches()  # rev moved BACK; see apply_ops
            for _vid, done_view, done_res in reversed(view_results):
```

In `src/data_rover/api/routes/commits.py`, replace:

```python

    def unwind(self) -> None:
        if self.model_res is not None:
            _rollback(self.model, self.model_res.inverse_units)
        if self.prior_metamodel is not None:
            # Reverse of apply order: the swap went in first, so it unwinds
            # after the model ops that were applied on top of it. See the
```

with:

```python

    def unwind(self) -> None:
        if self.model_res is not None:
            _rollback(self.model, self.model_res)
        if self.prior_metamodel is not None:
            # Reverse of apply order: the swap went in first, so it unwinds
            # after the model ops that were applied on top of it. See the
```

In `src/data_rover/api/routes/commits.py`, replace:

```python
                        model, res.dirty.to_scope()
                    )
            finally:
                _rollback(model, res.inverse_units)  # always restore the model
        finally:
            # Unconditional across every exit from the try above — the happy
            # path, a validation-pipeline exception, and an `_apply_batch`
```

with:

```python
                        model, res.dirty.to_scope()
                    )
            finally:
                _rollback(model, res)  # always restore the model
        finally:
            # Unconditional across every exit from the try above — the happy
            # path, a validation-pipeline exception, and an `_apply_batch`
```

In `src/data_rover/api/routes/validation.py`, replace:

```python
                    current, res.dirty.to_scope()
                )
            finally:
                _rollback(current, res.inverse_units)
        dirty_ids = set(res.dirty.ids)
        # working full set = committed issues OUTSIDE the dirty scope ∪ the fresh
        # dirty-scope issues (what state.replace would yield, computed purely).
```

with:

```python
                    current, res.dirty.to_scope()
                )
            finally:
                _rollback(current, res)
        dirty_ids = set(res.dirty.ids)
        # working full set = committed issues OUTSIDE the dirty scope ∪ the fresh
        # dirty-scope issues (what state.replace would yield, computed purely).
```

- [ ] **Step 6: Run the tests, and write the fixture**

```bash
pixi run -e core-dev pytest tests/api/test_exact_rollback.py -q
pixi run golden-fixtures
git status --short engine/fixtures
```

Expected: `6 passed`; then `git status` shows exactly one line, `?? engine/fixtures/golden/ops_refused.json`. Every existing fixture is rewritten byte for byte although its refused batches now run on the live model (finding 1).

- [ ] **Step 7: Have the engine replay the scenario**

`engine/test/ops/refused.golden.test.ts` (create):

```ts
import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('a refused batch leaves no trace, on the oracle as in the engine', () => {
	const fixture = loadFixture<StepsFixture>('ops_refused');

	it('step by step: refusal texts, state, indexes, digest', () => {
		replaySteps(fixture);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(fixture, { hashKey: () => 0 });
	});
});
```

Run: `pixi run engine-test test/ops`
Expected: `Test Files  6 passed (6)`, `Tests  22 passed (22)`. It passes at once: the engine's `rewind` was exact already, and the fixture now says the oracle's is too.

- [ ] **Step 8: See the tests bite**

Each of these is a temporary edit: make it, run the command, see the failure, and reverse the edit by hand before the next.

1. In `src/data_rover/core/model/model.py`, make `settle_order` return at once (`return` as its first statement). `pixi run golden-fixtures` fails with `IndexSet inconsistent with a fresh rebuild in: element_order, relationship_order`.
2. In `src/data_rover/api/routes/ops.py`, in `_rollback`, pass `element.rev` instead of `image.rev` to the elements' `model.overwrite(...)`. `pixi run golden-fixtures` fails with `a refused batch left a trace`, and `pixi run -e core-dev pytest tests/api/test_exact_rollback.py -q` fails five tests.
3. In `src/data_rover/core/model/indexes.py`, in `on_relationship_created`, replace the `while` loop's condition with `False`, so a parent is always appended. `pixi run golden-fixtures` fails with `IndexSet inconsistent with a fresh rebuild in: containment_parents, _containment_rel_ids`.

Finish with `git status --short src` listing this task's three route files and nothing else.

- [ ] **Step 9: Say it in the docs, close `K-30`, log `K-33`**

In `CLAUDE.md`, replace:

```markdown
Ops are applied **in place** to the live model while inverse ops are collected; a mid-batch failure rolls back by applying inverses in reverse and returns **422**.
```

with:

```markdown
Ops are applied **in place** to the live model while inverse ops and first-touch before-images are collected; a mid-batch failure returns **422** after `_rollback(model, res)` has put every touched entity back from its before-image — properties, `rev` and place in insertion order — in the four passes of the engine's `rewind` (relationships out, elements out, elements in, relationships in), closed by `Model.settle_order()`. Every path that applies a batch and takes it back goes through it — `POST /commits/preview`, `POST /model/validate` with staged ops, `_CommitUnwind`, the persist failures of `/model/ops` and `/model/undo` — so none leaves a trace in any `rev`, in entity order or in the state digest.
```

In `CLAUDE.md`, replace:

```markdown
Two deliberate differences from the server: an op carrying an array-index property key at any depth is refused, and a refused batch leaves NO trace — `rewind(model, result)` puts every touched entity back from its first-touch before-image (properties, `rev`, `ord`), where the server's `_rollback` replays inverse ops and leaves `rev` bumped and restored entities last (`K-30`).
```

with:

```markdown
One deliberate difference from the server: an op carrying an array-index property key at any depth is refused. A refused batch leaves NO trace on either side — `rewind(model, result)` puts every touched entity back from its first-touch before-image (properties, `rev`, `ord`), and the server's `_rollback` is its port.
```

In `CLAUDE.md`, replace:

```markdown
A `batch` step runs an op batch through `routes/ops.py::_apply_batch` on a deep copy of the oracle's model, kept only when the batch lands — the server's own rollback is not exact (`K-30`), and none of its drift may enter a fixture — and records the outcome,
```

with:

```markdown
A `batch` step runs an op batch through `routes/ops.py::_apply_batch` on the recorder's own model, as a session does — a refused batch must leave no trace, the recorder fails the run when one does, and `ops_refused` refuses after every kind of touch — and records the outcome,
```

In `architecture/contracts.md`, replace:

```markdown
touched, so committed reads need no rewind. A refused batch leaves no trace, and a rewind
   is exact: every touched entity goes back to its before-image — properties, `rev` and place
   in state order — which replaying inverse ops, as the server's rollback does, cannot give
   (`BACKLOG-ENGINE.md`, `K-30`).
```

with:

```markdown
touched, so committed reads need no rewind. A refused batch leaves no trace, and a rewind
   is exact: every touched entity goes back to its before-image — properties, `rev` and place
   in state order — which replaying inverse ops cannot give. The server's rollback
   (`routes/ops.py::_rollback`) is the same operation, pass for pass.
```

In `BACKLOG-ENGINE.md`, delete:

```markdown
### K-30 · The op applier's rollback is not exact: `rev` drifts and restored entities move last · `open` · *2026-09-18*
`routes/ops.py::_rollback` replays inverse ops in restore mode, so a refused batch — and
every `POST /commits/preview`, which rolls back the same way — leaves each updated entity's
`rev` two higher and each deleted-then-restored entity at the end of its dict with `rev`
counted again from zero. Observed on the core: `[update id-3, delete id-1, update ghost]` →
422, `id-3` at `rev` 3 instead of 1, `id-1` and `id-2` behind it, state digest
`d2499a403aeabae2` → `6b1333ccfa35d720`, no commit. Harmless while nothing reads `rev`; once
the server serves the CT-3 digest and v2 snapshots (sub-project B) a single preview would make
every replica report divergence at the next delta, and entity order (state, CT-1) would
differ between the server and its replicas. The engine's applier restores before-images
exactly, and the golden recorder runs each batch on a copy of the oracle's model so the
drift never enters a fixture. Fix, in B: make the server's rollback exact (put `rev` and
dict position back) or run previews on a copy; the applier is under the MR-3 freeze.

```

In `BACKLOG-ENGINE.md`, replace:

```markdown
and inherits `K-30`, `K-31` and `K-32`.
```

with:

```markdown
and inherits `K-31` and `K-32`.
```

In `BACKLOG.md`, replace:

```markdown
The client-engine program's issues (`K-29` → `K-32`) are in `BACKLOG-ENGINE.md`.
```

with:

```markdown
### K-33 · `POST /model/validate` with staged ops leaves derived caches standing · `open` · *2026-09-19*
The staged branch of `routes/validation.py` applies the ops to the live model, validates and
rolls back under `write_mutex`, as `POST /commits/preview` does — but never calls
`session.invalidate_derived_caches()`, which preview does for this very case. Table routes
take no mutex, so a `/tables/evaluate` that reads the model mid-validation can cache a row
order and script cells computed against the discarded state under an unchanged
`(fingerprint, rev)`, and nothing evicts them before the next commit. The rollback itself is
exact. Fix: invalidate in the `finally` that rolls back, as preview's does.

The client-engine program's issues (`K-29` → `K-32`) are in `BACKLOG-ENGINE.md`.
```

- [ ] **Step 10: Run everything Python, and lint**

```bash
pixi run core-test
pixi run backend-lint
pixi run -e core-dev ruff check tests/golden tests/api/test_exact_rollback.py
pixi run -e core-dev ruff format --check tests/golden tests/api/test_exact_rollback.py
pixi run engine-tidy
```

Expected: `2450 passed, 34 deselected` (2,429 before this plan, 15 from Task 1, 6 here); ruff, mypy and pyright clean; every file already formatted; eslint, `tsc` and prettier clean.

- [ ] **Step 11: Commit**

```bash
git add tests/api/test_exact_rollback.py tests/golden/model_steps.py tests/golden/scenarios/__init__.py tests/golden/scenarios/ops_refused.py engine/test/ops/refused.golden.test.ts engine/fixtures/golden/ops_refused.json src/data_rover/api/routes/ops.py src/data_rover/api/routes/commits.py src/data_rover/api/routes/validation.py CLAUDE.md architecture/contracts.md BACKLOG-ENGINE.md BACKLOG.md
git commit -m "Make the op applier's rollback exact (K-30)"
```

---

### Task 3: Name the entities a batch created again (`K-31`)

Within one batch, `delete X` followed by a create with `id: X` leaves X as a NEW entity, last in its dict, while the delta lists it only as changed. `_BatchResult` and the engine's `BatchResult` record such ids; they travel in `Commit.entity_states` under `recreated` and in the recorder's outcome, which is the delta the replica test feeds. The engine's `Delta` gains the two lists, `commit()` takes the named ids out first, and the type-or-ends heuristic goes: an unnamed change of type or ends does not fit the replica. `ops_recreate` — the case no delta could express — joins the replica test. The HTTP carriers gain the lists in Task 4, with the rest of the delta fields.

**Files:**
- Modify: `tests/api/test_commit_states.py`, `src/data_rover/api/routes/ops.py`, `src/data_rover/api/commit_states.py`, `tests/golden/model_steps.py`
- Modify: `engine/test/golden/model-steps.ts`, `engine/test/working/helpers.ts`, `engine/test/working/replica.golden.test.ts`, `engine/test/working/working-copy.test.ts`, `engine/src/ops/result.ts`, `engine/src/ops/apply.ts`, `engine/src/working/delta.ts`, `engine/src/working/working-copy.ts`, `engine/bench/run.ts`
- Modify: `CLAUDE.md`, `architecture/contracts.md`, `BACKLOG-ENGINE.md`
- Generated: `engine/fixtures/golden/ops_batches.json`, `ops_churn.json`, `ops_recreate.json`, `ops_refused.json`

**Interfaces:**
- Consumes: Task 2's `_BatchResult`.
- Produces, Python: `_BatchResult.recreated_element_ids: dict[str, None]`, `recreated_relationship_ids: dict[str, None]` (ordered sets, like the other four); `mark_element_created(element_id)`, `mark_relationship_created(rel_id)`; `capture_entity_states(...)["recreated"] == {"elements": [id…], "relationships": [id…]}`; `EntityStates.recreated_element_ids: list[str]`, `recreated_relationship_ids: list[str]`; the recorder's outcome keys `recreated_element_ids`, `recreated_relationship_ids`.
- Produces, engine: `BatchResult.recreatedElementIds`, `recreatedRelationshipIds: Set<string>`; `markElementCreated(id)`, `markRelationshipCreated(id)`; `Delta.recreated_element_ids`, `recreated_relationship_ids: readonly string[]` (required); `CommittedChange.recreatedElementIds`, `recreatedRelationshipIds`.

- [ ] **Step 1: Write the failing Python tests**

In `tests/api/test_commit_states.py`, replace:

```python
    assert states["relationships"][r]["after"] is None


def test_over_cap_batch_captures_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(commit_states, "ENTITY_STATES_MAX", 1)
    m = _model()
```

with:

```python
    assert states["relationships"][r]["after"] is None


def _recreating_batch(m: Model) -> tuple[str, str, str]:
    """p contains c; one batch deletes c and creates it, and the relationship
    its cascade took, again under their ids."""
    setup = _apply_batch(
        m,
        [
            _create("tmp_p"),
            _create("tmp_c", label="c"),
            CreateRelationshipOp(
                kind="create_relationship",
                temp_id="tmp_r",
                type_name="Contains",
                source_id="tmp_p",
                target_id="tmp_c",
            ),
        ],
        restore=False,
    )
    p, c, r = (setup.id_map[k] for k in ("tmp_p", "tmp_c", "tmp_r"))
    return p, c, r


def test_an_entity_created_again_under_its_id_is_named_recreated() -> None:
    m = _model()
    p, c, r = _recreating_batch(m)
    res = _apply_batch(
        m,
        [
            UpdateElementOp(kind="update_element", id=p, properties_patch={"label": "p"}),
            DeleteElementOp(kind="delete_element", id=c),
            CreateElementOp(
                kind="create_element", temp_id="tmp_c2", type_name="Node", id=c
            ),
            CreateRelationshipOp(
                kind="create_relationship",
                temp_id="tmp_r2",
                type_name="Contains",
                source_id=p,
                target_id="tmp_c2",
                id=r,
            ),
        ],
        restore=False,
    )
    # changed, not deleted — and named, because each is a NEW entity now last
    assert list(res.changed_element_ids) == [p, c]
    assert list(res.deleted_element_ids) == []
    assert list(res.recreated_element_ids) == [c]
    assert list(res.recreated_relationship_ids) == [r]
    assert list(m.elements) == [p, c]

    states = capture_entity_states(m, res)
    assert states is not None
    assert states["recreated"] == {"elements": [c], "relationships": [r]}
    loaded = load_entity_states(states)
    assert loaded.recreated_element_ids == [c]
    assert loaded.recreated_relationship_ids == [r]


def test_an_entity_deleted_once_more_is_recreated_no_longer() -> None:
    m = _model()
    _p, c, r = _recreating_batch(m)
    res = _apply_batch(
        m,
        [
            DeleteElementOp(kind="delete_element", id=c),
            CreateElementOp(
                kind="create_element", temp_id="tmp_c2", type_name="Node", id=c
            ),
            DeleteElementOp(kind="delete_element", id="tmp_c2"),
        ],
        restore=False,
    )
    assert list(res.recreated_element_ids) == []
    assert list(res.deleted_element_ids) == [c]
    assert list(res.deleted_relationship_ids) == [r]


def test_a_row_without_the_recreated_key_loads_with_none_named() -> None:
    loaded = load_entity_states({"elements": {}, "relationships": {}})
    assert loaded.recreated_element_ids == []
    assert loaded.recreated_relationship_ids == []


def test_over_cap_batch_captures_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(commit_states, "ENTITY_STATES_MAX", 1)
    m = _model()
```

In `tests/api/test_commit_states.py`, replace:

```python
                        "code": "def value(el):\n    return 1\n"},
        }],
    )
    assert _states_at(body["model_rev"]) == {"elements": {}, "relationships": {}}


def test_legacy_ops_and_undo_persist_states(client: TestClient) -> None:
```

with:

```python
                        "code": "def value(el):\n    return 1\n"},
        }],
    )
    assert _states_at(body["model_rev"]) == {
        "elements": {},
        "relationships": {},
        "recreated": {"elements": [], "relationships": []},
    }


def test_legacy_ops_and_undo_persist_states(client: TestClient) -> None:
```

- [ ] **Step 2: Run them to see them fail**

Run: `pixi run -e core-dev pytest tests/api/test_commit_states.py -q`
Expected: `4 failed, 12 passed` — the three new tests (`AttributeError: '_BatchResult' object has no attribute 'recreated_element_ids'`, `'EntityStates' object has no attribute 'recreated_element_ids'`) and the artifact-only commit, whose states lack the `recreated` key.

- [ ] **Step 3: Record the ids in the batch result and in `entity_states`**

In `src/data_rover/api/routes/ops.py`, replace:

```python
    The four id dicts are ordered sets (dict-of-None idiom) in first-touch op
    application order; deleting an entity removes it from the changed set and
    re-creating it removes it from the deleted set, so the two are disjoint.
    """

    canonical_ops: list[ModelOpIn] = field(default_factory=list)
```

with:

```python
    The four id dicts are ordered sets (dict-of-None idiom) in first-touch op
    application order; deleting an entity removes it from the changed set and
    re-creating it removes it from the deleted set, so the two are disjoint.
    The two ``recreated_*`` sets name, among the changed ids, the ones the
    batch deleted and then created again: such an entity is a new one at the
    END of its dict, which its changed state alone cannot say.
    """

    canonical_ops: list[ModelOpIn] = field(default_factory=list)
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
    changed_relationship_ids: dict[str, None] = field(default_factory=dict)
    deleted_element_ids: dict[str, None] = field(default_factory=dict)
    deleted_relationship_ids: dict[str, None] = field(default_factory=dict)
    #: pre-batch state per touched id, captured on FIRST touch (None = did
    #: not exist). Later touches in the same batch never overwrite, so an
    #: entity created-then-updated stays None and one deleted-then-restored
```

with:

```python
    changed_relationship_ids: dict[str, None] = field(default_factory=dict)
    deleted_element_ids: dict[str, None] = field(default_factory=dict)
    deleted_relationship_ids: dict[str, None] = field(default_factory=dict)
    recreated_element_ids: dict[str, None] = field(default_factory=dict)
    recreated_relationship_ids: dict[str, None] = field(default_factory=dict)
    #: pre-batch state per touched id, captured on FIRST touch (None = did
    #: not exist). Later touches in the same batch never overwrite, so an
    #: entity created-then-updated stays None and one deleted-then-restored
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
        self.changed_relationship_ids[rel_id] = None
        self.deleted_relationship_ids.pop(rel_id, None)

    def mark_element_deleted(self, element_id: str) -> None:
        self.deleted_element_ids[element_id] = None
        self.changed_element_ids.pop(element_id, None)

    def mark_relationship_deleted(self, rel_id: str) -> None:
        self.deleted_relationship_ids[rel_id] = None
        self.changed_relationship_ids.pop(rel_id, None)

    def note_element_before(
        self, model: Model, element_id: str, element: Element | None
```

with:

```python
        self.changed_relationship_ids[rel_id] = None
        self.deleted_relationship_ids.pop(rel_id, None)

    def mark_element_created(self, element_id: str) -> None:
        if element_id in self.deleted_element_ids:
            self.recreated_element_ids[element_id] = None
        self.mark_element_changed(element_id)

    def mark_relationship_created(self, rel_id: str) -> None:
        if rel_id in self.deleted_relationship_ids:
            self.recreated_relationship_ids[rel_id] = None
        self.mark_relationship_changed(rel_id)

    def mark_element_deleted(self, element_id: str) -> None:
        self.deleted_element_ids[element_id] = None
        self.changed_element_ids.pop(element_id, None)
        self.recreated_element_ids.pop(element_id, None)

    def mark_relationship_deleted(self, rel_id: str) -> None:
        self.deleted_relationship_ids[rel_id] = None
        self.changed_relationship_ids.pop(rel_id, None)
        self.recreated_relationship_ids.pop(rel_id, None)

    def note_element_before(
        self, model: Model, element_id: str, element: Element | None
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
                update={"temp_id": element.id, "properties": props, "id": None}
            )
        )
        res.mark_element_changed(element.id)
        return

    if isinstance(op, UpdateElementOp):
```

with:

```python
                update={"temp_id": element.id, "properties": props, "id": None}
            )
        )
        res.mark_element_created(element.id)
        return

    if isinstance(op, UpdateElementOp):
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
                }
            )
        )
        res.mark_relationship_changed(rel.id)
        return

    if isinstance(op, UpdateRelationshipOp):
```

with:

```python
                }
            )
        )
        res.mark_relationship_created(rel.id)
        return

    if isinstance(op, UpdateRelationshipOp):
```

In `src/data_rover/api/commit_states.py`, replace:

```python
Column shape::

    {"elements":      {id: {"before": ElementOut | null, "after": ElementOut | null}},
     "relationships": {id: {"before": RelationshipOut | null, "after": RelationshipOut | null}}}

``before: null`` = did not exist before the commit; ``after: null`` = does
not exist after it. A batch touching more than ``ENTITY_STATES_MAX`` entities
stores NULL instead (the row would otherwise grow with the batch — a subtree
delete can touch a large share of the model), and NULL means "reconstruct".
"""
```

with:

```python
Column shape::

    {"elements":      {id: {"before": ElementOut | null, "after": ElementOut | null}},
     "relationships": {id: {"before": RelationshipOut | null, "after": RelationshipOut | null}},
     "recreated":     {"elements": [id, ...], "relationships": [id, ...]}}

``before: null`` = did not exist before the commit; ``after: null`` = does
not exist after it. ``recreated`` names the ids the commit deleted and then
created again — new entities at the end of their dict, which a before/after
pair cannot say — and is absent from rows older than the key. A batch touching more than ``ENTITY_STATES_MAX`` entities
stores NULL instead (the row would otherwise grow with the batch — a subtree
delete can touch a large share of the model), and NULL means "reconstruct".
"""
```

In `src/data_rover/api/commit_states.py`, replace:

```python
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from data_rover.core.model.model import Model
```

with:

```python
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from data_rover.core.model.model import Model
```

In `src/data_rover/api/commit_states.py`, replace:

```python

    elements: dict[str, ElementPair]
    relationships: dict[str, RelationshipPair]


def _dump(out: ElementOut | RelationshipOut | None) -> dict[str, Any] | None:
```

with:

```python

    elements: dict[str, ElementPair]
    relationships: dict[str, RelationshipPair]
    recreated_element_ids: list[str] = field(default_factory=list)
    recreated_relationship_ids: list[str] = field(default_factory=list)


def _dump(out: ElementOut | RelationshipOut | None) -> dict[str, Any] | None:
```

In `src/data_rover/api/commit_states.py`, replace:

```python
            "before": _dump(res.before_relationships[rid]),
            "after": None,
        }
    return {"elements": elements, "relationships": relationships}


def load_entity_states(raw: Mapping[str, Any]) -> EntityStates:
```

with:

```python
            "before": _dump(res.before_relationships[rid]),
            "after": None,
        }
    return {
        "elements": elements,
        "relationships": relationships,
        "recreated": {
            "elements": list(res.recreated_element_ids),
            "relationships": list(res.recreated_relationship_ids),
        },
    }


def load_entity_states(raw: Mapping[str, Any]) -> EntityStates:
```

In `src/data_rover/api/commit_states.py`, replace:

```python
    def rel(v: Any) -> RelationshipOut | None:
        return RelationshipOut.model_validate(v) if v is not None else None

    return EntityStates(
        elements={
            eid: (el(entry.get("before")), el(entry.get("after")))
```

with:

```python
    def rel(v: Any) -> RelationshipOut | None:
        return RelationshipOut.model_validate(v) if v is not None else None

    recreated = raw.get("recreated", {})
    return EntityStates(
        elements={
            eid: (el(entry.get("before")), el(entry.get("after")))
```

In `src/data_rover/api/commit_states.py`, replace:

```python
            rid: (rel(entry.get("before")), rel(entry.get("after")))
            for rid, entry in raw.get("relationships", {}).items()
        },
    )
```

with:

```python
            rid: (rel(entry.get("before")), rel(entry.get("after")))
            for rid, entry in raw.get("relationships", {}).items()
        },
        recreated_element_ids=list(recreated.get("elements", [])),
        recreated_relationship_ids=list(recreated.get("relationships", [])),
    )
```

- [ ] **Step 4: Run the tests**

Run: `pixi run -e core-dev pytest tests/api/test_commit_states.py tests/api/test_commit_diff.py -q`
Expected: `40 passed` (16 and 24).

- [ ] **Step 5: Put the lists in the recorder's outcome and regenerate**

In `tests/golden/model_steps.py`, replace:

```python
        "changed_relationship_ids": list(res.changed_relationship_ids),
        "deleted_element_ids": list(res.deleted_element_ids),
        "deleted_relationship_ids": list(res.deleted_relationship_ids),
        "before_elements": [
            [eid, None if before is None else _line(before)]
            for eid, before in res.before_elements.items()
```

with:

```python
        "changed_relationship_ids": list(res.changed_relationship_ids),
        "deleted_element_ids": list(res.deleted_element_ids),
        "deleted_relationship_ids": list(res.deleted_relationship_ids),
        "recreated_element_ids": list(res.recreated_element_ids),
        "recreated_relationship_ids": list(res.recreated_relationship_ids),
        "before_elements": [
            [eid, None if before is None else _line(before)]
            for eid, before in res.before_elements.items()
```

```bash
pixi run golden-fixtures
git status --short engine/fixtures
```

Expected: four fixtures modified — `ops_batches.json`, `ops_churn.json`, `ops_recreate.json`, `ops_refused.json` — each landed batch's `result` gaining the two lists; `ops_recreate` names `id-2` and `id-5` at its step 1, `id-6` at step 2.

- [ ] **Step 6: Make the engine's tests expect them**

In `engine/test/golden/model-steps.ts`, replace:

```ts
	changed_relationship_ids: string[];
	deleted_element_ids: string[];
	deleted_relationship_ids: string[];
	before_elements: [string, string | null][];
	before_relationships: [string, string | null][];
	inverse_ops: string[];
```

with:

```ts
	changed_relationship_ids: string[];
	deleted_element_ids: string[];
	deleted_relationship_ids: string[];
	recreated_element_ids: string[];
	recreated_relationship_ids: string[];
	before_elements: [string, string | null][];
	before_relationships: [string, string | null][];
	inverse_ops: string[];
```

In `engine/test/golden/model-steps.ts`, replace:

```ts
		changed_relationship_ids: [...res.changedRelationshipIds],
		deleted_element_ids: [...res.deletedElementIds],
		deleted_relationship_ids: [...res.deletedRelationshipIds],
		before_elements: [...res.beforeElements].map(([id, image]) => [
			id,
			image === null ? null : elementImageLine(image)
```

with:

```ts
		changed_relationship_ids: [...res.changedRelationshipIds],
		deleted_element_ids: [...res.deletedElementIds],
		deleted_relationship_ids: [...res.deletedRelationshipIds],
		recreated_element_ids: [...res.recreatedElementIds],
		recreated_relationship_ids: [...res.recreatedRelationshipIds],
		before_elements: [...res.beforeElements].map(([id, image]) => [
			id,
			image === null ? null : elementImageLine(image)
```

In `engine/test/working/helpers.ts`, replace:

```ts
				parseJson(relationshipLine(model.getRelationship(id)))
			),
			deleted_element_ids: [...result.deletedElementIds],
			deleted_relationship_ids: [...result.deletedRelationshipIds]
		};
		this.rev += 1;
		return { delta, result };
```

with:

```ts
				parseJson(relationshipLine(model.getRelationship(id)))
			),
			deleted_element_ids: [...result.deletedElementIds],
			deleted_relationship_ids: [...result.deletedRelationshipIds],
			recreated_element_ids: [...result.recreatedElementIds],
			recreated_relationship_ids: [...result.recreatedRelationshipIds]
		};
		this.rev += 1;
		return { delta, result };
```

In `engine/test/working/replica.golden.test.ts`, replace:

```ts

/**
 * A replica that starts empty and is told of each landed batch only what a
 * commit delta says (whole changed entities, deleted ids, the digest) must
 * stand where the oracle stands, entity order included.
 */
function follow(name: string): void {
	const fixture = loadFixture<StepsFixture>(name);
```

with:

```ts

/**
 * A replica that starts empty and is told of each landed batch only what a
 * commit delta says (whole changed entities, deleted ids, the ids created
 * again, the digest) must stand where the oracle stands, entity order included.
 */
function follow(name: string): void {
	const fixture = loadFixture<StepsFixture>(name);
```

In `engine/test/working/replica.golden.test.ts`, replace:

```ts
			changed_elements: landed.changed_elements.map(parseJson),
			changed_relationships: landed.changed_relationships.map(parseJson),
			deleted_element_ids: landed.deleted_element_ids,
			deleted_relationship_ids: landed.deleted_relationship_ids
		});
		expect(status, label).toBe('applied');
		expect(replica.diverged, label).toBe(false);
```

with:

```ts
			changed_elements: landed.changed_elements.map(parseJson),
			changed_relationships: landed.changed_relationships.map(parseJson),
			deleted_element_ids: landed.deleted_element_ids,
			deleted_relationship_ids: landed.deleted_relationship_ids,
			recreated_element_ids: landed.recreated_element_ids,
			recreated_relationship_ids: landed.recreated_relationship_ids
		});
		expect(status, label).toBe('applied');
		expect(replica.diverged, label).toBe(false);
```

In `engine/test/working/replica.golden.test.ts`, replace:

```ts
	it('through a random walk of batches', () => {
		follow('ops_churn');
	});
});
```

with:

```ts
	it('through a random walk of batches', () => {
		follow('ops_churn');
	});

	it('through entities created again under their ids, unchanged in type and ends', () => {
		follow('ops_recreate');
	});

	it('through the batches that land between refused ones', () => {
		follow('ops_refused');
	});
});
```

In `engine/test/working/working-copy.test.ts`, replace:

```ts
		expect(wc.diverged).toBe(false);
	});

	it('puts an entity that comes back under other ends or another type last, as the server did', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
```

with:

```ts
		expect(wc.diverged).toBe(false);
	});

	it('puts an entity the delta names as created again last, as the server did', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
```

In `engine/test/working/working-copy.test.ts`, replace:

```ts
		expect(wc.model.containerOf('b')).toBe('c');
		verifyConsistent(wc.model);
	});
});

describe('divergence', () => {
```

with:

```ts
		expect(wc.model.containerOf('b')).toBe('c');
		verifyConsistent(wc.model);
	});

	it('also when it comes back as it was, which only the name can tell from an update', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		const { delta } = server.commit([
			{ kind: 'delete_element', id: 'c' },
			{ kind: 'create_element', temp_id: 'tmp_c', type_name: 'Node', id: 'c' },
			refers('tmp_r', 'a', 'tmp_c')
		]);
		expect(delta.recreated_element_ids).toEqual(['c']);
		expect(delta.deleted_relationship_ids).toEqual(['a-c']);
		wc.applyDelta(delta);
		expect(wc.diverged).toBe(false);
		expect(observe(wc.model)).toEqual(observe(server.model));
		expect([...wc.model.elements()].map((e) => e.id)).toEqual(['a', 'b', 'd', 'c']);
		verifyConsistent(wc.model);
	});
});

describe('divergence', () => {
```

In `engine/test/working/working-copy.test.ts`, replace:

```ts
			changed_elements: [],
			changed_relationships: [orphan],
			deleted_element_ids: [],
			deleted_relationship_ids: []
		});
		expect(wc.diverged).toBe(true);
		expect(wc.staged().map((batch) => batch.id)).toEqual([1]);
		expect(wc.model.getElement('a').props).toEqual({ name: 'mine' });
	});

	it('a delta the replica cannot hold throws before anything moves', () => {
```

with:

```ts
			changed_elements: [],
			changed_relationships: [orphan],
			deleted_element_ids: [],
			deleted_relationship_ids: [],
			recreated_element_ids: [],
			recreated_relationship_ids: []
		});
		expect(wc.diverged).toBe(true);
		expect(wc.staged().map((batch) => batch.id)).toEqual([1]);
		expect(wc.model.getElement('a').props).toEqual({ name: 'mine' });
	});

	it('is set by a record that changes its ends or its type without being named as created again', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const rewired = workingCopy(committed);
		const { delta } = server.commit([
			{ kind: 'delete_relationship', id: 'a-b' },
			{
				kind: 'create_relationship',
				temp_id: 'tmp_r',
				type_name: 'Contains',
				source_id: 'c',
				target_id: 'b',
				id: 'a-b'
			}
		]);
		rewired.applyDelta({ ...delta, recreated_relationship_ids: [] });
		expect(rewired.diverged).toBe(true);

		const retyped = workingCopy(family());
		retyped.applyDelta({
			rev: 1,
			prev_rev: 0,
			state_digest: retyped.digest,
			changed_elements: [parseJson('{"id":"c","type_name":"Other","properties":{},"rev":0}')],
			changed_relationships: [],
			deleted_element_ids: [],
			deleted_relationship_ids: [],
			recreated_element_ids: [],
			recreated_relationship_ids: []
		});
		expect(retyped.diverged).toBe(true);
	});

	it('a delta the replica cannot hold throws before anything moves', () => {
```

In `engine/test/working/working-copy.test.ts`, replace:

```ts
				],
				changed_relationships: [],
				deleted_element_ids: [],
				deleted_relationship_ids: []
			})
		);
		expect(error).toBeInstanceOf(SnapshotError);
```

with:

```ts
				],
				changed_relationships: [],
				deleted_element_ids: [],
				deleted_relationship_ids: [],
				recreated_element_ids: [],
				recreated_relationship_ids: []
			})
		);
		expect(error).toBeInstanceOf(SnapshotError);
```

- [ ] **Step 7: Run them to see them fail**

Run: `pixi run engine-test`
Expected: failures in `test/ops/*.golden.test.ts` (the engine's outcome lacks the two lists), in `test/working/replica.golden.test.ts` at `ops_recreate` step 1, and in the two new `working-copy` tests. `pixi run engine-check` fails too: `Delta` has no `recreated_element_ids`.

- [ ] **Step 8: Record the ids in the engine, and apply a delta by them**

In `engine/src/ops/result.ts`, replace:

```ts
 * Everything one batch application produced. The four id sets are in
 * first-touch order and the changed and deleted ones stay disjoint: deleting
 * an entity takes it out of the changed set, creating it again takes it out of
 * the deleted set.
 */
export class BatchResult {
	/** Temp id → the id the entity was created under. */
```

with:

```ts
 * Everything one batch application produced. The four id sets are in
 * first-touch order and the changed and deleted ones stay disjoint: deleting
 * an entity takes it out of the changed set, creating it again takes it out of
 * the deleted set. The two recreated sets name, among the changed ids, the ones
 * the batch deleted and then created again: such an entity is a new one, last
 * in state order, which its changed state alone cannot say.
 */
export class BatchResult {
	/** Temp id → the id the entity was created under. */
```

In `engine/src/ops/result.ts`, replace:

```ts
	readonly changedRelationshipIds = new Set<string>();
	readonly deletedElementIds = new Set<string>();
	readonly deletedRelationshipIds = new Set<string>();
	/**
	 * The state of every touched entity before its FIRST touch; `null` when it
	 * did not exist. Every id in the four sets has an entry.
```

with:

```ts
	readonly changedRelationshipIds = new Set<string>();
	readonly deletedElementIds = new Set<string>();
	readonly deletedRelationshipIds = new Set<string>();
	readonly recreatedElementIds = new Set<string>();
	readonly recreatedRelationshipIds = new Set<string>();
	/**
	 * The state of every touched entity before its FIRST touch; `null` when it
	 * did not exist. Every id in the four sets has an entry.
```

In `engine/src/ops/result.ts`, replace:

```ts
		this.deletedRelationshipIds.delete(id);
	}

	markElementDeleted(id: string): void {
		this.deletedElementIds.add(id);
		this.changedElementIds.delete(id);
	}

	markRelationshipDeleted(id: string): void {
		this.deletedRelationshipIds.add(id);
		this.changedRelationshipIds.delete(id);
	}

	/** Call BEFORE mutating; a later touch never overwrites the first image. */
```

with:

```ts
		this.deletedRelationshipIds.delete(id);
	}

	markElementCreated(id: string): void {
		if (this.deletedElementIds.has(id)) this.recreatedElementIds.add(id);
		this.markElementChanged(id);
	}

	markRelationshipCreated(id: string): void {
		if (this.deletedRelationshipIds.has(id)) this.recreatedRelationshipIds.add(id);
		this.markRelationshipChanged(id);
	}

	markElementDeleted(id: string): void {
		this.deletedElementIds.add(id);
		this.changedElementIds.delete(id);
		this.recreatedElementIds.delete(id);
	}

	markRelationshipDeleted(id: string): void {
		this.deletedRelationshipIds.add(id);
		this.changedRelationshipIds.delete(id);
		this.recreatedRelationshipIds.delete(id);
	}

	/** Call BEFORE mutating; a later touch never overwrites the first image. */
```

In `engine/src/ops/apply.ts`, replace:

```ts
			res.noteElementBefore(element.id, null);
			res.inverseUnits.push([{ kind: 'delete_element', id: element.id }]);
			for (const key of Object.keys(props)) model.setProperty(element, key, getProp(props, key)!);
			res.markElementChanged(element.id);
			return;
		}
		case 'update_element': {
```

with:

```ts
			res.noteElementBefore(element.id, null);
			res.inverseUnits.push([{ kind: 'delete_element', id: element.id }]);
			for (const key of Object.keys(props)) model.setProperty(element, key, getProp(props, key)!);
			res.markElementCreated(element.id);
			return;
		}
		case 'update_element': {
```

In `engine/src/ops/apply.ts`, replace:

```ts
			res.noteRelationshipBefore(rel.id, null);
			res.inverseUnits.push([{ kind: 'delete_relationship', id: rel.id }]);
			for (const key of Object.keys(props)) model.setProperty(rel, key, getProp(props, key)!);
			res.markRelationshipChanged(rel.id);
			return;
		}
		case 'update_relationship': {
```

with:

```ts
			res.noteRelationshipBefore(rel.id, null);
			res.inverseUnits.push([{ kind: 'delete_relationship', id: rel.id }]);
			for (const key of Object.keys(props)) model.setProperty(rel, key, getProp(props, key)!);
			res.markRelationshipCreated(rel.id);
			return;
		}
		case 'update_relationship': {
```

In `engine/src/working/delta.ts`, replace:

```ts
/**
 * What a replica reads of a commit delta, in the wire's names. `changed_*`
 * hold whole entities as committed, in first-touch order; `deleted_*` name
 * every entity the commit removed, cascades included.
 */
export type Delta = {
	rev: number;
```

with:

```ts
/**
 * What a replica reads of a commit delta, in the wire's names. `changed_*`
 * hold whole entities as committed, in first-touch order; `deleted_*` name
 * every entity the commit removed, cascades included; `recreated_*` name the
 * changed entities the commit deleted and created again under their ids.
 */
export type Delta = {
	rev: number;
```

In `engine/src/working/delta.ts`, replace:

```ts
	changed_relationships: readonly Value[];
	deleted_element_ids: readonly string[];
	deleted_relationship_ids: readonly string[];
};

export type CommittedElement = { id: string; typeName: string; props: Props; rev: number };
```

with:

```ts
	changed_relationships: readonly Value[];
	deleted_element_ids: readonly string[];
	deleted_relationship_ids: readonly string[];
	recreated_element_ids: readonly string[];
	recreated_relationship_ids: readonly string[];
};

export type CommittedElement = { id: string; typeName: string; props: Props; rev: number };
```

In `engine/src/working/delta.ts`, replace:

```ts
	relationships: CommittedRel[];
	deletedElementIds: readonly string[];
	deletedRelationshipIds: readonly string[];
};

function readElement(doc: Value, where: string): CommittedElement {
```

with:

```ts
	relationships: CommittedRel[];
	deletedElementIds: readonly string[];
	deletedRelationshipIds: readonly string[];
	recreatedElementIds: readonly string[];
	recreatedRelationshipIds: readonly string[];
};

function readElement(doc: Value, where: string): CommittedElement {
```

In `engine/src/working/delta.ts`, replace:

```ts
}

function readIds(ids: readonly string[], where: string): readonly string[] {
	ids.forEach((id, i) => {
		if (typeof id !== 'string') throw new SnapshotError(`${where}[${i}]: must be a string`);
	});
```

with:

```ts
}

function readIds(ids: readonly string[], where: string): readonly string[] {
	if (!Array.isArray(ids)) throw new SnapshotError(`${where}: must be a list`);
	ids.forEach((id, i) => {
		if (typeof id !== 'string') throw new SnapshotError(`${where}[${i}]: must be a string`);
	});
```

In `engine/src/working/delta.ts`, replace:

```ts
			};
		}),
		deletedElementIds: readIds(delta.deleted_element_ids, 'deleted_element_ids'),
		deletedRelationshipIds: readIds(delta.deleted_relationship_ids, 'deleted_relationship_ids')
	};
}
```

with:

```ts
			};
		}),
		deletedElementIds: readIds(delta.deleted_element_ids, 'deleted_element_ids'),
		deletedRelationshipIds: readIds(delta.deleted_relationship_ids, 'deleted_relationship_ids'),
		recreatedElementIds: readIds(delta.recreated_element_ids, 'recreated_element_ids'),
		recreatedRelationshipIds: readIds(
			delta.recreated_relationship_ids,
			'recreated_relationship_ids'
		)
	};
}
```

In `engine/src/working/working-copy.ts`, replace:

```ts
import { ModelError } from '../model/errors.ts';
import type { Model } from '../model/model.ts';
import { applyBatch } from '../ops/apply.ts';
import { OpError } from '../ops/errors.ts';
```

with:

```ts
import { ModelError } from '../model/errors.ts';
import { pyRepr } from '../value/repr.ts';
import type { Model } from '../model/model.ts';
import { applyBatch } from '../ops/apply.ts';
import { OpError } from '../ops/errors.ts';
```

In `engine/src/working/working-copy.ts`, replace:

```ts
	/**
	 * Writes committed state, the staged batches being rewound: relationships
	 * out, elements out, elements in, relationships in. A record keeps its
	 * identity and its place; a new entity goes last. An entity that comes back
	 * under another type or other ends was deleted and created again within the
	 * commit, which put it last on the server: so it is here.
	 */
	private commit(change: CommittedChange, touched: Touched): void {
		const model = this.model;
```

with:

```ts
	/**
	 * Writes committed state, the staged batches being rewound: relationships
	 * out, elements out, elements in, relationships in. A record keeps its
	 * identity and its place; a new entity goes last, and so does one the delta
	 * names as created again, which goes out first. A record that would have to
	 * change its type or its ends without being named does not fit the replica.
	 */
	private commit(change: CommittedChange, touched: Touched): void {
		const model = this.model;
```

In `engine/src/working/working-copy.ts`, replace:

```ts
			touched.elements.add(id);
		};
		for (const id of change.deletedRelationshipIds) dropRelationship(id);
		for (const id of change.deletedElementIds) dropElement(id);
		for (const next of change.elements) {
			const element = model.findElement(next.id);
			touched.elements.add(next.id);
			if (element !== undefined && element.typeName === next.typeName) {
				fold(next.id, element.rev);
				model.overwrite(element, next.props, next.rev);
			} else {
				if (element !== undefined) {
					for (const rel of [...element.out, ...element.in]) dropRelationship(rel.id);
					dropElement(next.id);
				}
				model.insertElement(next.id, next.typeName, next.props, next.rev);
			}
			fold(next.id, next.rev);
		}
		for (const next of change.relationships) {
			const rel = model.findRelationship(next.id);
			touched.relationships.add(next.id);
			const same =
				rel !== undefined &&
				rel.typeName === next.typeName &&
				rel.source.id === next.sourceId &&
				rel.target.id === next.targetId;
			if (same) {
				fold(next.id, rel.rev);
				model.overwrite(rel, next.props, next.rev);
			} else {
				dropRelationship(next.id);
				model.insertRelationship(
					next.id,
					next.typeName,
```

with:

```ts
			touched.elements.add(id);
		};
		for (const id of change.deletedRelationshipIds) dropRelationship(id);
		for (const id of change.recreatedRelationshipIds) dropRelationship(id);
		for (const id of change.deletedElementIds) dropElement(id);
		for (const id of change.recreatedElementIds) dropElement(id);
		for (const next of change.elements) {
			const element = model.findElement(next.id);
			touched.elements.add(next.id);
			if (element === undefined) {
				model.insertElement(next.id, next.typeName, next.props, next.rev);
			} else {
				if (element.typeName !== next.typeName) {
					throw new ModelError(
						'value',
						`Element ${pyRepr(next.id)} changes its type without being named as created again`
					);
				}
				fold(next.id, element.rev);
				model.overwrite(element, next.props, next.rev);
			}
			fold(next.id, next.rev);
		}
		for (const next of change.relationships) {
			const rel = model.findRelationship(next.id);
			touched.relationships.add(next.id);
			if (rel !== undefined) {
				const same =
					rel.typeName === next.typeName &&
					rel.source.id === next.sourceId &&
					rel.target.id === next.targetId;
				if (!same) {
					throw new ModelError(
						'value',
						`Relationship ${pyRepr(next.id)} changes its type or its ends ` +
							'without being named as created again'
					);
				}
				fold(next.id, rel.rev);
				model.overwrite(rel, next.props, next.rev);
			} else {
				model.insertRelationship(
					next.id,
					next.typeName,
```

In `engine/bench/run.ts`, replace:

```ts
		],
		changed_relationships: relationships,
		deleted_element_ids: [],
		deleted_relationship_ids: deleted.map((rel) => rel.id)
	};
}

```

with:

```ts
		],
		changed_relationships: relationships,
		deleted_element_ids: [],
		deleted_relationship_ids: deleted.map((rel) => rel.id),
		recreated_element_ids: [],
		recreated_relationship_ids: []
	};
}

```

- [ ] **Step 9: Run the engine's tests and checks**

```bash
pixi run engine-test
pixi run engine-tidy
```

Expected: `Test Files  39 passed (39)`, `Tests  272 passed (272)`; eslint, `tsc` (both projects) and prettier clean.

- [ ] **Step 10: See the replica test bite**

In `engine/test/working/replica.golden.test.ts`, pass `recreated_element_ids: []` and `recreated_relationship_ids: []` instead of the oracle's lists. `pixi run engine-test test/working/replica.golden.test.ts` fails `ops_batches` at `step 24` (`diverged`: the rewire arrives unnamed) and `ops_recreate` at `step 1` (`id-2` kept its place, so the state differs). Put the oracle's lists back by hand and see the file pass again.

- [ ] **Step 11: Say it in the docs, close `K-31`**

In `CLAUDE.md`, replace:

```markdown
first-touch changed/deleted sets kept disjoint, inverse units and `inverseOps()`.
```

with:

```markdown
first-touch changed/deleted sets kept disjoint, the `recreated` sets (the changed ids the batch deleted and created again), inverse units and `inverseOps()`.
```

In `CLAUDE.md`, replace:

```markdown
writes them through the committed-state methods (an entity arriving under another type or other ends is removed and appended, as the server's dict did), folds the digest per entity
```

with:

```markdown
writes them through the committed-state methods (the ids the delta names in `recreated_*` go out first and are appended, as the server's dict did; a record that would change its type or its ends WITHOUT being named does not fit), folds the digest per entity
```

In `CLAUDE.md`, replace:

```markdown
expects the oracle's state, entity order included; `ops_recreate` (an entity created again under its id, unchanged in type and ends) is kept out of it, because no delta can express that (`K-31`).
```

with:

```markdown
expects the oracle's state, entity order included — through `ops_recreate` too (an entity created again under its id, unchanged in type and ends), which only the delta's `recreated_*` lists can express.
```

In `CLAUDE.md`, replace:

```markdown
the applier
  snapshots each entity on first touch (`_BatchResult.before_*`), the post-state is read off the
  live model right before `_persist_commit`.
```

with:

```markdown
the applier
  snapshots each entity on first touch (`_BatchResult.before_*`), the post-state is read off the
  live model right before `_persist_commit`, and a `recreated` key names the ids the batch deleted
  and created again (`_BatchResult.recreated_*`; absent from older rows).
```

In `architecture/contracts.md`, replace:

````markdown
 "validation_error_count","changed_elements","changed_relationships",
 "deleted_element_ids","deleted_relationship_ids"}
```

- Today's feed `commit_event` plus `prev_rev` and `state_digest`. `changed_*` hold full
  post-commit entities in first-touch order; `deleted_*` include cascade deletions.
````

with:

````markdown
 "validation_error_count","changed_elements","changed_relationships",
 "deleted_element_ids","deleted_relationship_ids",
 "recreated_element_ids","recreated_relationship_ids"}
```

- The feed's `commit_event`. `changed_*` hold full post-commit entities in first-touch order;
  `deleted_*` include cascade deletions; `recreated_*` name the changed ids the commit
  deleted and created again under the same id — an apply-CR rewire does that — each a new
  entity, which the server's dict holds last.
````

In `architecture/contracts.md`, replace:

```markdown
- **Entities in a delta.** Apply in this order: relationships out, elements out, elements in,
  relationships in. A deleted id the replica does not hold is skipped (an entity created and
  deleted within one commit). A changed entity the replica holds keeps its record and its
  place; one it does not hold is appended. One that arrives under another type, or other ends,
  than the replica's record was deleted and created again within the commit — an apply-CR
  rewire does that — which put it last on the server: the replica removes it and appends it.
  A re-creation that changes neither cannot be told from an update and keeps its place
  (`BACKLOG-ENGINE.md`, `K-31`).
```

with:

```markdown
- **Entities in a delta.** Apply in this order: relationships out, elements out, elements in,
  relationships in. What goes out is every `deleted_*` and every `recreated_*` id; one the
  replica does not hold is skipped (an entity created and deleted within one commit). A
  changed entity the replica holds keeps its record and its place; one it does not hold — a
  recreated one, by then — is appended. A changed entity that arrives under another type, or
  other ends, than the replica's record WITHOUT being named in `recreated_*` does not fit the
  replica, which is then diverged (AD-12).
```

In `BACKLOG-ENGINE.md`, delete:

```markdown
### K-31 · A commit delta cannot say "deleted and created again under the same id" · `open` · *2026-09-18*
Within one batch, `delete X` followed by a create with `id: X` moves X to the end of the
server's dict, while the delta (CT-2) lists X only under `changed_*`.
`change_request_ops.ops_for_change` emits exactly that for a relationship rewire, and any
hand-written batch may do it for an element. The engine tells the case apart when the type
or the ends changed and then removes and appends (fixture `ops_batches`, the rewire and the
type-change steps, followed by `engine/test/working/replica.golden.test.ts`); when neither
changed (fixture `ops_recreate`) the replica keeps X's place, and its entity order differs
from the server's until the next snapshot. The digest cannot see it: a re-created entity
that ends at its old `rev` hashes to the same `(id, rev)` pair. Fix, in B: name such ids in
both `deleted_*` and `changed_*`, or add a `recreated_*` list to the delta.

```

In `BACKLOG-ENGINE.md`, replace:

```markdown
and inherits `K-31` and `K-32`.
```

with:

```markdown
and inherits `K-32`.
```

- [ ] **Step 12: Run everything, and lint**

```bash
pixi run core-test
pixi run backend-lint
pixi run -e core-dev ruff check tests/golden tests/api/test_commit_states.py
```

Expected: `2453 passed, 34 deselected`; ruff, mypy and pyright clean.

- [ ] **Step 13: Commit**

```bash
git add tests/api/test_commit_states.py src/data_rover/api/routes/ops.py src/data_rover/api/commit_states.py tests/golden/model_steps.py engine/fixtures/golden engine/test/golden/model-steps.ts engine/test/working engine/src/ops/result.ts engine/src/ops/apply.ts engine/src/working engine/bench/run.ts CLAUDE.md architecture/contracts.md BACKLOG-ENGINE.md
git commit -m "Name the entities a commit created again (K-31)"
```

---

### Task 4: The state digest and `prev_rev` on every commit delta

`Session` holds the CT-3 digest as an integer. A landed batch folds into it in O(batch) — every before-image out, whatever the batch left behind in; `set_model`, `touch_model` and a fresh or hydrated session leave it unknown, and the next reader recomputes. All four journal writers answer with `prev_rev`, `state_digest` and `recreated_*`, the feed's `commit_event` carries the same, and `Commit.state_digest` records the digest. A path that takes a LANDED batch back restores the value from before it.

**Files:**
- Create: `tests/api/test_commit_delta.py`, `alembic/versions/0015_commit_state_digest.py`
- Modify: `tests/api/test_state_digest.py`, `tests/api/test_feed_hub.py`, `tests/api/test_alembic.py`, `frontend/src/lib/api/__tests__/types.checkout.test.ts`
- Modify: `src/data_rover/api/state_digest.py`, `src/data_rover/api/session.py`, `src/data_rover/api/schemas.py`, `src/data_rover/api/feed.py`, `src/data_rover/api/db_models.py`, `src/data_rover/api/content.py`, `src/data_rover/api/routes/ops.py`, `src/data_rover/api/routes/commits.py`
- Modify: `CLAUDE.md`, `architecture/program.md`, `BACKLOG-ENGINE.md`

**Interfaces:**
- Consumes: Task 2's exact `_rollback`; Task 3's `_BatchResult.recreated_*`.
- Produces: `state_digest.digest_value(model) -> int`, `fold_batch(value: int, model: Model, res: _BatchResult) -> int`; `Session.state_digest_value: int | None`, `Session.state_digest() -> str`, `Session.advance_state_digest(res: _BatchResult) -> str`; `OpsResponse.prev_rev: int | None`, `state_digest: str | None`, `recreated_element_ids: list[str]`, `recreated_relationship_ids: list[str]` (inherited by `CommitResponse`); `feed.commit_event(*, rev, prev_rev, state_digest, scope, …, recreated_element_ids, recreated_relationship_ids)` — all required; `Commit.state_digest: str | None`; `content.append_commit(..., state_digest=None)`; `_persist_commit(..., _state_digest=None)`, `_persist_undo_commit(..., state_digest=None)`; `_finalize(session, state, model, res, *, prev_rev, state_digest)`; `_CommitUnwind.prior_digest: int | None`.

- [ ] **Step 1: Write the failing tests**

`tests/api/test_commit_delta.py` (create):

```python
"""What a replica follows a commit by: ``prev_rev``, ``state_digest`` and the
``recreated_*`` lists on every carrier, and the session digest behind them —
kept up per batch, true to a full recomputation, put back with a batch that
is taken back, and unknown after whatever moves the model around it."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db
from data_rover.api.feed import reset_loop
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID, get_registry, get_session
from data_rover.api.state_digest import model_digest

from .conftest import AUTH_HEADERS, feed_url, papi, seed_default_project

_MM = """
elements:
  - name: Node
    properties:
      - {name: label, datatype: string}
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    reset_loop()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(
        papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"}
    )
    assert res.status_code == 200, res.text
    res = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert res.status_code == 200, res.text
    return c


def _node(temp_id: str, label: str, **extra: Any) -> dict[str, Any]:
    return {
        "kind": "create_element",
        "temp_id": temp_id,
        "type_name": "Node",
        "properties": {"label": label},
        **extra,
    }


def _contains(temp_id: str, source: str, target: str, **extra: Any) -> dict[str, Any]:
    return {
        "kind": "create_relationship",
        "temp_id": temp_id,
        "type_name": "Contains",
        "source_id": source,
        "target_id": target,
        "properties": {},
        **extra,
    }


def _ops(client: TestClient, ops: list[dict[str, Any]]) -> dict[str, Any]:
    res = client.post(
        papi("/model/ops"), json={"base_rev": get_session().model_rev, "ops": ops}
    )
    assert res.status_code == 200, res.text
    return res.json()


def _true_digest() -> str:
    model = get_session().model
    assert model is not None
    return model_digest(model)


def _journal_digest(rev: int) -> str | None:
    with db.db_session() as s:
        row = content.get_commit(s, DEFAULT_PROJECT_ID, rev)
        assert row is not None
        return row.state_digest


# ---------------------------------------------------------------------------
# the session digest
# ---------------------------------------------------------------------------


def test_the_digest_is_kept_up_per_batch_and_stays_true(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = get_session()
    assert session.state_digest_value is None  # a model just installed: unknown

    first = _ops(client, [_node("tmp_a", "a"), _node("tmp_b", "b")])
    a, b = first["id_map"]["tmp_a"], first["id_map"]["tmp_b"]
    assert first["state_digest"] == _true_digest()
    assert session.state_digest_value is not None  # known from here on

    def _no_full_pass(model: object) -> int:
        raise AssertionError("the session recomputed a digest it knew")

    # every kind of touch, folded in without another pass over the model
    monkeypatch.setattr("data_rover.api.session.digest_value", _no_full_pass)
    batches: list[list[dict[str, Any]]] = [
        [_contains("tmp_r", a, b)],
        [{"kind": "update_element", "id": b, "properties_patch": {"label": "b2"}}],
        [{"kind": "update_element", "id": b, "properties_patch": {"label": None}}],
        [_node("tmp_c", "c"), {"kind": "delete_element", "id": "tmp_c"}],
        [{"kind": "delete_element", "id": b}, _node("tmp_b2", "again", id=b)],
        [{"kind": "delete_element", "id": a}],
    ]
    for ops in batches:
        body = _ops(client, ops)
        assert body["state_digest"] == _true_digest(), ops
        assert body["state_digest"] == session.state_digest()


def test_whatever_moves_the_model_around_the_digest_leaves_it_unknown(
    client: TestClient,
) -> None:
    session = get_session()
    _ops(client, [_node("tmp_a", "a")])
    assert session.state_digest_value is not None

    # a legacy direct route mutates behind the op protocol
    res = client.post(papi("/model/elements"), json={"type": "Node", "properties": {}})
    assert res.status_code in (200, 201), res.text
    assert session.state_digest_value is None
    assert _ops(client, [_node("tmp_b", "b")])["state_digest"] == _true_digest()

    # a model replaced whole
    res = client.post(papi("/model"), json={"elements": [], "relationships": []})
    assert res.status_code == 200, res.text
    assert session.state_digest_value is None
    assert session.state_digest() == "0" * 16


def test_a_batch_taken_back_takes_the_digest_back(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = get_session()
    known = _ops(client, [_node("tmp_a", "a")])["state_digest"]

    def _boom(*args: Any, **kwargs: Any) -> bool:
        raise RuntimeError("no database")

    monkeypatch.setattr("data_rover.api.routes.ops._persist_commit", _boom)
    res = client.post(
        papi("/model/ops"),
        json={"base_rev": session.model_rev, "ops": [_node("tmp_b", "b")]},
    )
    assert res.status_code == 500, res.text
    assert session.state_digest() == known == _true_digest()


def test_a_rehydrated_session_reaches_the_same_digest(client: TestClient) -> None:
    body = _ops(client, [_node("tmp_a", "a"), _node("tmp_b", "b")])
    a = body["id_map"]["tmp_a"]
    live = _ops(
        client,
        [{"kind": "update_element", "id": a, "properties_patch": {"label": "a2"}}],
    )["state_digest"]

    get_registry().evict(DEFAULT_PROJECT_ID)  # snapshot, then drop
    session = get_registry().get(DEFAULT_PROJECT_ID)
    assert session.state_digest_value is None  # hydrated: unknown until read
    with session.write_mutex:
        assert session.state_digest() == live


# ---------------------------------------------------------------------------
# the carriers
# ---------------------------------------------------------------------------


def test_ops_response_carries_the_delta_fields(client: TestClient) -> None:
    rev = get_session().model_rev
    body = _ops(client, [_node("tmp_a", "a"), _node("tmp_b", "b")])
    a, b = body["id_map"]["tmp_a"], body["id_map"]["tmp_b"]
    assert body["prev_rev"] == rev
    assert body["model_rev"] == rev + 1
    assert body["state_digest"] == _true_digest() == _journal_digest(rev + 1)
    assert body["recreated_element_ids"] == []
    assert body["recreated_relationship_ids"] == []

    rel = _ops(client, [_contains("tmp_r", a, b)])["id_map"]["tmp_r"]
    body = _ops(
        client,
        [
            {"kind": "delete_element", "id": b},
            _node("tmp_b2", "again", id=b),
            _contains("tmp_r2", a, "tmp_b2", id=rel),
        ],
    )
    assert body["recreated_element_ids"] == [b]
    assert body["recreated_relationship_ids"] == [rel]
    assert body["deleted_element_ids"] == []


def test_a_response_that_applied_nothing_carries_no_delta(client: TestClient) -> None:
    res = client.post(
        papi("/model/ops"), json={"base_rev": get_session().model_rev, "ops": []}
    )
    assert res.status_code == 200, res.text
    assert res.json()["prev_rev"] is None
    assert res.json()["state_digest"] is None


def test_undo_carries_the_delta_fields(client: TestClient) -> None:
    _ops(client, [_node("tmp_a", "a")])
    rev = get_session().model_rev
    res = client.post(papi("/model/undo"))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["prev_rev"] == rev
    assert body["state_digest"] == _true_digest() == _journal_digest(rev + 1)
    assert body["state_digest"] == "0" * 16  # the model is empty again


def test_commit_response_and_feed_event_carry_the_delta_fields(
    client: TestClient,
) -> None:
    with client.websocket_connect(feed_url()) as ws:
        ws.receive_json()  # snapshot
        rev = get_session().model_rev
        res = client.post(
            papi("/commits"),
            json={
                "base_rev": rev,
                "ops": [_node("tmp_a", "a")],
                "lock_tokens": [],
                "message": "create",
            },
        )
        assert res.status_code == 200, res.text
        body = res.json()
        event = ws.receive_json()
        while event["type"] != "commit":
            event = ws.receive_json()
    for carrier in (body, event):
        assert carrier["prev_rev"] == rev
        assert carrier["state_digest"] == _true_digest()
        assert carrier["recreated_element_ids"] == []
        assert carrier["recreated_relationship_ids"] == []
    assert event["rev"] == body["model_rev"] == rev + 1
    assert _journal_digest(rev + 1) == body["state_digest"]


def test_revert_carries_the_delta_fields(client: TestClient) -> None:
    _ops(client, [_node("tmp_a", "a")])
    target = get_session().model_rev
    _ops(client, [_node("tmp_b", "b")])
    with client.websocket_connect(feed_url()) as ws:
        ws.receive_json()  # snapshot
        rev = get_session().model_rev
        res = client.post(
            papi("/commits/revert"), json={"target_rev": target, "base_rev": rev}
        )
        assert res.status_code == 200, res.text
        body = res.json()
        event = ws.receive_json()
        while event["type"] != "commit":
            event = ws.receive_json()
    for carrier in (body, event):
        assert carrier["prev_rev"] == rev
        assert carrier["state_digest"] == _true_digest()
    assert _journal_digest(rev + 1) == body["state_digest"]


def test_a_commit_that_could_not_be_persisted_takes_the_digest_back(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = get_session()
    known = _ops(client, [_node("tmp_a", "a")])["state_digest"]

    def _boom(*args: Any, **kwargs: Any) -> bool:
        raise RuntimeError("no database")

    monkeypatch.setattr("data_rover.api.routes.commits._persist_commit", _boom)
    res = client.post(
        papi("/commits"),
        json={
            "base_rev": session.model_rev,
            "ops": [_node("tmp_b", "b")],
            "lock_tokens": [],
            "message": "lost",
        },
    )
    assert res.status_code == 500, res.text
    assert session.state_digest() == known == _true_digest()
```

In `tests/api/test_state_digest.py`, replace:

```python

import zlib

from data_rover.api.state_digest import entity_hash, format_digest, model_digest
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.ids import SequentialIdGenerator
from data_rover.core.model.model import Model

MM_YAML = """
elements:
```

with:

```python

import zlib

from data_rover.api.routes.ops import _apply_batch
from data_rover.api.schemas import ModelOpIn
from data_rover.api.state_digest import (
    digest_value,
    entity_hash,
    fold_batch,
    format_digest,
    model_digest,
)
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.ids import SequentialIdGenerator
from data_rover.core.model.model import Model
from pydantic import TypeAdapter

MM_YAML = """
elements:
```

In `tests/api/test_state_digest.py`, replace:

```python
        return zlib.crc32(entity_id.encode() + b"\x00" + str(rev).encode())

    assert crc("a", 1) ^ crc("b", 2) == crc("a", 2) ^ crc("b", 1)
```

with:

```python
        return zlib.crc32(entity_id.encode() + b"\x00" + str(rev).encode())

    assert crc("a", 1) ^ crc("b", 2) == crc("a", 2) ^ crc("b", 1)


def test_a_landed_batch_folds_into_the_digest() -> None:
    model = _model()
    ops = TypeAdapter(list[ModelOpIn]).validate_python(
        [
            {"kind": "update_element", "id": "id-1", "properties_patch": {"name": "Z"}},
            {"kind": "delete_element", "id": "id-2"},
            {"kind": "create_element", "temp_id": "tmp_n", "type_name": "Node"},
            # created and deleted within the batch: in neither digest
            {"kind": "create_element", "temp_id": "tmp_gone", "type_name": "Node"},
            {"kind": "delete_element", "id": "tmp_gone"},
        ]
    )
    before = digest_value(model)
    res = _apply_batch(model, ops, restore=False)
    assert "id-3" in res.before_relationships  # the cascade took the link
    assert format_digest(fold_batch(before, model, res)) == model_digest(model)
```

In `tests/api/test_feed_hub.py`, replace:

```python
    assert snap["type"] == "snapshot" and snap["model_rev"] == 3
    commit = feed.commit_event(
        rev=4,
        scope=["model"],
        commit_id="c1",
        author_id="bob",
```

with:

```python
    assert snap["type"] == "snapshot" and snap["model_rev"] == 3
    commit = feed.commit_event(
        rev=4,
        prev_rev=3,
        state_digest="00000000000000ff",
        scope=["model"],
        commit_id="c1",
        author_id="bob",
```

In `tests/api/test_feed_hub.py`, replace:

```python
        changed_relationships=[],
        deleted_element_ids=[],
        deleted_relationship_ids=[],
    )
    assert commit["type"] == "commit" and commit["rev"] == 4
    assert commit["scope"] == ["model"]
    assert commit["changed_elements"] == [{"id": "e1"}]
```

with:

```python
        changed_relationships=[],
        deleted_element_ids=[],
        deleted_relationship_ids=[],
        recreated_element_ids=["e1"],
        recreated_relationship_ids=[],
    )
    assert commit["type"] == "commit" and commit["rev"] == 4
    assert (commit["prev_rev"], commit["state_digest"]) == (3, "00000000000000ff")
    assert commit["recreated_element_ids"] == ["e1"]
    assert commit["recreated_relationship_ids"] == []
    assert commit["scope"] == ["model"]
    assert commit["changed_elements"] == [{"id": "e1"}]
```

In `tests/api/test_alembic.py`, replace:

```python
    command.downgrade(cfg, "0012")
    cols = {c["name"] for c in inspect(engine).get_columns("commits")}
    assert "entity_states" not in cols
```

with:

```python
    command.downgrade(cfg, "0012")
    cols = {c["name"] for c in inspect(engine).get_columns("commits")}
    assert "entity_states" not in cols


def test_migration_0015_adds_commit_state_digest(tmp_path: Path) -> None:
    db_path = tmp_path / "t6.db"
    url = f"sqlite:///{db_path}"
    cfg = Config(str(REPO_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO_ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)

    command.upgrade(cfg, "head")
    engine = create_engine(url)
    cols = {c["name"]: c for c in inspect(engine).get_columns("commits")}
    assert "state_digest" in cols
    assert cols["state_digest"]["nullable"] is True

    command.downgrade(cfg, "0014")
    cols = {c["name"] for c in inspect(engine).get_columns("commits")}
    assert "state_digest" not in cols
```

- [ ] **Step 2: Run them to see them fail**

Run: `pixi run -e core-dev pytest tests/api/test_commit_delta.py tests/api/test_state_digest.py tests/api/test_feed_hub.py tests/api/test_alembic.py -q`
Expected: the run stops at collection — `tests/api/test_state_digest.py` cannot import `digest_value`. Add `--continue-on-collection-errors` to see the rest fail: the ten tests of `test_commit_delta.py` (`'Session' object has no attribute 'state_digest_value'`, `KeyError: 'state_digest'` / `'prev_rev'`), `test_event_builders_shapes` (`commit_event() got an unexpected keyword argument 'prev_rev'`) and `test_migration_0015_adds_commit_state_digest`.

- [ ] **Step 3: The fold, and the session's digest**

In `src/data_rover/api/state_digest.py`, replace:

```python
from __future__ import annotations

import hashlib

from data_rover.core.model.model import Model


def entity_hash(entity_id: str, rev: int) -> int:
```

with:

```python
from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING

from data_rover.core.model.model import Model

if TYPE_CHECKING:
    from .routes.ops import _BatchResult


def entity_hash(entity_id: str, rev: int) -> int:
```

In `src/data_rover/api/state_digest.py`, replace:

```python
    return f"{value:016x}"


def model_digest(model: Model) -> str:
    """The digest of every element and relationship, by full recomputation."""
    value = 0
    for element in model.elements.values():
        value ^= entity_hash(element.id, element.rev)
    for rel in model.relationships.values():
        value ^= entity_hash(rel.id, rel.rev)
    return format_digest(value)
```

with:

```python
    return f"{value:016x}"


def digest_value(model: Model) -> int:
    """The digest of ``model`` as an integer: one pass over every entity."""
    value = 0
    for element in model.elements.values():
        value ^= entity_hash(element.id, element.rev)
    for rel in model.relationships.values():
        value ^= entity_hash(rel.id, rel.rev)
    return value


def model_digest(model: Model) -> str:
    """The digest of every element and relationship, by full recomputation."""
    return format_digest(digest_value(model))


def fold_batch(value: int, model: Model, res: _BatchResult) -> int:
    """The digest after a landed batch, from the digest before it, in
    O(batch): every before-image goes out, every touched entity the batch
    left in ``model`` comes in."""
    for eid, before in res.before_elements.items():
        if before is not None:
            value ^= entity_hash(eid, before.rev)
        element = model.elements.get(eid)
        if element is not None:
            value ^= entity_hash(eid, element.rev)
    for rid, rel_before in res.before_relationships.items():
        if rel_before is not None:
            value ^= entity_hash(rid, rel_before.rev)
        rel = model.relationships.get(rid)
        if rel is not None:
            value ^= entity_hash(rid, rel.rev)
    return value
```

In `src/data_rover/api/session.py`, replace:

```python
from .locking import LockTable
from .script_sweep import ScriptSweepRegistry
from .settings import get_settings
from .table_cache import TableOrderCache

if TYPE_CHECKING:
    from .schemas import OpIn
    from .search_index_build import SearchIndexProgress
    from .snapshot_job import SnapshotJob
```

with:

```python
from .locking import LockTable
from .script_sweep import ScriptSweepRegistry
from .settings import get_settings
from .state_digest import digest_value, fold_batch, format_digest
from .table_cache import TableOrderCache

if TYPE_CHECKING:
    from .routes.ops import _BatchResult
    from .schemas import OpIn
    from .search_index_build import SearchIndexProgress
    from .snapshot_job import SnapshotJob
```

In `src/data_rover/api/session.py`, replace:

```python
    script_sweeps: ScriptSweepRegistry = field(
        default_factory=ScriptSweepRegistry, repr=False
    )

    def invalidate_derived_caches(self) -> None:
        """Drop every model-derived cache and re-stamp the cell cache to the
```

with:

```python
    script_sweeps: ScriptSweepRegistry = field(
        default_factory=ScriptSweepRegistry, repr=False
    )
    #: the state digest of ``model`` (``state_digest.py``) as an integer, or
    #: None while it is not known: on a fresh or hydrated session, and after
    #: ``set_model`` / ``touch_model``. A landed batch folds into it in
    #: O(batch); a batch that is rolled back needs nothing, the rollback being
    #: exact. Read and written under ``write_mutex``.
    state_digest_value: int | None = field(default=None, repr=False)

    def state_digest(self) -> str:
        """The digest as the wire carries it, recomputed in one O(model) pass
        when it is not known. Call under ``write_mutex``."""
        if self.state_digest_value is None:
            self.state_digest_value = (
                digest_value(self.model) if self.model is not None else 0
            )
        return format_digest(self.state_digest_value)

    def advance_state_digest(self, res: _BatchResult) -> str:
        """Take a batch that has just landed on ``model`` into the digest and
        return it. A caller that may still take the batch back keeps
        ``state_digest_value`` from before the call and restores it then."""
        if self.state_digest_value is not None and self.model is not None:
            self.state_digest_value = fold_batch(
                self.state_digest_value, self.model, res
            )
        return self.state_digest()

    def invalidate_derived_caches(self) -> None:
        """Drop every model-derived cache and re-stamp the cell cache to the
```

In `src/data_rover/api/session.py`, replace:

```python
        self.op_log.clear()  # recorded inverses no longer apply to this model
        self.op_log_dropped = 0
        self.model_rev += 1
        self.invalidate_derived_caches()

    def touch_model(self) -> None:
```

with:

```python
        self.op_log.clear()  # recorded inverses no longer apply to this model
        self.op_log_dropped = 0
        self.model_rev += 1
        self.state_digest_value = None
        self.invalidate_derived_caches()

    def touch_model(self) -> None:
```

In `src/data_rover/api/session.py`, replace:

```python
        self.op_log.clear()
        self.op_log_dropped = 0
        self.validation = None
        self.invalidate_derived_caches()

    def set_metamodel(self, metamodel: Metamodel | None) -> None:
```

with:

```python
        self.op_log.clear()
        self.op_log_dropped = 0
        self.validation = None
        self.state_digest_value = None
        self.invalidate_derived_caches()

    def set_metamodel(self, metamodel: Metamodel | None) -> None:
```

- [ ] **Step 4: The fields on the response, the event and the journal row**

In `src/data_rover/api/schemas.py`, replace:

```python
    #: deletions (cascade order: containment closure walk / sorted rel ids)
    deleted_element_ids: list[str] = Field(default_factory=list)
    deleted_relationship_ids: list[str] = Field(default_factory=list)
    #: issue-store delta of the scoped re-validation (see ValidationState)
    issues_removed_owner_ids: list[str] = Field(default_factory=list)
    issues_added: list[IssueOut] = Field(default_factory=list)
```

with:

```python
    #: deletions (cascade order: containment closure walk / sorted rel ids)
    deleted_element_ids: list[str] = Field(default_factory=list)
    deleted_relationship_ids: list[str] = Field(default_factory=list)
    #: the changed ids the batch deleted and then created again: each is a
    #: new entity at the END of the model's insertion order, which its
    #: changed state alone cannot say
    recreated_element_ids: list[str] = Field(default_factory=list)
    recreated_relationship_ids: list[str] = Field(default_factory=list)
    #: ``model_rev`` before this batch bumped it, and the state digest
    #: (``api/state_digest.py``) of the model after it: what a replica needs
    #: to tell that it missed nothing and stands where the server stands.
    #: None on a response that applied nothing.
    prev_rev: int | None = None
    state_digest: str | None = None
    #: issue-store delta of the scoped re-validation (see ValidationState)
    issues_removed_owner_ids: list[str] = Field(default_factory=list)
    issues_added: list[IssueOut] = Field(default_factory=list)
```

In `src/data_rover/api/feed.py`, replace:

```python
def commit_event(
    *,
    rev: int,
    scope: list[str],
    commit_id: str,
    author_id: str,
```

with:

```python
def commit_event(
    *,
    rev: int,
    prev_rev: int,
    state_digest: str,
    scope: list[str],
    commit_id: str,
    author_id: str,
```

In `src/data_rover/api/feed.py`, replace:

```python
    changed_relationships: list[dict[str, Any]],
    deleted_element_ids: list[str],
    deleted_relationship_ids: list[str],
) -> dict[str, Any]:
    """``scope`` says which content families the commit touched (``model`` /
    ``artifact`` / ``view`` / ``metamodel-layout``) so clients refresh only
    what moved: a commit that only renamed a saved table must not make every
    peer refetch model pages. It is a REQUIRED keyword rather than a defaulted
```

with:

```python
    changed_relationships: list[dict[str, Any]],
    deleted_element_ids: list[str],
    deleted_relationship_ids: list[str],
    recreated_element_ids: list[str],
    recreated_relationship_ids: list[str],
) -> dict[str, Any]:
    """The commit delta a replica follows: ``prev_rev`` is the revision it
    continues from, ``state_digest`` the digest of the model after it, and
    ``recreated_*`` the changed ids the commit deleted and created again.

    ``scope`` says which content families the commit touched (``model`` /
    ``artifact`` / ``view`` / ``metamodel-layout``) so clients refresh only
    what moved: a commit that only renamed a saved table must not make every
    peer refetch model pages. It is a REQUIRED keyword rather than a defaulted
```

In `src/data_rover/api/feed.py`, replace:

```python
    return {
        "type": "commit",
        "rev": rev,
        "scope": scope,
        "commit_id": commit_id,
        "author_id": author_id,
```

with:

```python
    return {
        "type": "commit",
        "rev": rev,
        "prev_rev": prev_rev,
        "state_digest": state_digest,
        "scope": scope,
        "commit_id": commit_id,
        "author_id": author_id,
```

In `src/data_rover/api/feed.py`, replace:

```python
        "changed_relationships": changed_relationships,
        "deleted_element_ids": deleted_element_ids,
        "deleted_relationship_ids": deleted_relationship_ids,
    }


```

with:

```python
        "changed_relationships": changed_relationships,
        "deleted_element_ids": deleted_element_ids,
        "deleted_relationship_ids": deleted_relationship_ids,
        "recreated_element_ids": recreated_element_ids,
        "recreated_relationship_ids": recreated_relationship_ids,
    }


```

In `src/data_rover/api/db_models.py`, replace:

```python
    #: ``ENTITY_STATES_MAX`` entities — the diff reader reconstructs the model
    #: instead. Never backfilled.
    entity_states: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    #: Declared so the ORM unit-of-work can order INSERTs correctly.
    project: Mapped[Project] = relationship()
```

with:

```python
    #: ``ENTITY_STATES_MAX`` entities — the diff reader reconstructs the model
    #: instead. Never backfilled.
    entity_states: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    #: State digest (``state_digest.py``) of the model after this commit, 16
    #: hex digits. NULL on rows written before the column existed and on the
    #: baseline markers, which carry no batch.
    state_digest: Mapped[str | None] = mapped_column(String(16), nullable=True)

    #: Declared so the ORM unit-of-work can order INSERTs correctly.
    project: Mapped[Project] = relationship()
```

In `src/data_rover/api/content.py`, replace:

```python
    from_metamodel_id: str | None = None,
    to_metamodel_id: str | None = None,
    entity_states: dict[str, Any] | None = None,
) -> Commit:
    row = Commit(
        project_id=project_id,
```

with:

```python
    from_metamodel_id: str | None = None,
    to_metamodel_id: str | None = None,
    entity_states: dict[str, Any] | None = None,
    state_digest: str | None = None,
) -> Commit:
    row = Commit(
        project_id=project_id,
```

In `src/data_rover/api/content.py`, replace:

```python
        from_metamodel_id=from_metamodel_id,
        to_metamodel_id=to_metamodel_id,
        entity_states=entity_states,
    )
    db.add(row)
    db.flush()
```

with:

```python
        from_metamodel_id=from_metamodel_id,
        to_metamodel_id=to_metamodel_id,
        entity_states=entity_states,
        state_digest=state_digest,
    )
    db.add(row)
    db.flush()
```

`alembic/versions/0015_commit_state_digest.py` (create):

```python
"""commits.state_digest — the state digest of the model after each commit

Revision ID: 0015
Revises: 0014
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("commits", sa.Column("state_digest", sa.String(16), nullable=True))


def downgrade() -> None:
    op.drop_column("commits", "state_digest")
```

- [ ] **Step 5: Thread them through the four journal writers**

In `src/data_rover/api/routes/ops.py`, replace:

```python
does (a staging failure must not escape with ``model_rev`` already bumped and
the batch already off the op_log).

Undo restores entity STATE (ids, types, endpoints, properties) but per-entity
``rev`` counters continue forward: nothing uses ``rev`` for conflict detection
(CR matching explicitly ignores it, see ``core/model/change_request.py``), it
is only a change ticker.
"""

from __future__ import annotations
```

with:

```python
does (a staging failure must not escape with ``model_rev`` already bumped and
the batch already off the op_log).

Undo restores entity STATE (ids, types, endpoints, properties) but not the
per-entity ``rev`` counters: an entity it reinstates starts counting again.
Nothing uses ``rev`` for conflict detection (CR matching explicitly ignores
it, see ``core/model/change_request.py``); it is a change ticker, and with the
id one half of every pair the state digest folds (``api/state_digest.py``).

The delta a replica follows
---------------------------
Every landed batch answers with the revision it continues from (``prev_rev``),
the ids it deleted and created again (``recreated_*``) and the state digest of
the model after it, which the session keeps up in O(batch)
(``Session.advance_state_digest``) and the journal row records. A path that
takes a landed batch back puts the digest back with it.
"""

from __future__ import annotations
```

In `src/data_rover/api/routes/ops.py`, replace:

```python


def _finalize(
    session: Session, state: ValidationState, model: Model, res: _BatchResult
) -> OpsResponse:
    """Scoped re-validation + issue-store splice + response assembly.

```

with:

```python


def _finalize(
    session: Session,
    state: ValidationState,
    model: Model,
    res: _BatchResult,
    *,
    prev_rev: int,
    state_digest: str,
) -> OpsResponse:
    """Scoped re-validation + issue-store splice + response assembly.

```

In `src/data_rover/api/routes/ops.py`, replace:

```python
        ],
        deleted_element_ids=list(res.deleted_element_ids),
        deleted_relationship_ids=list(res.deleted_relationship_ids),
        issues_removed_owner_ids=delta.removed_owner_ids,
        issues_added=[IssueOut.from_core(i) for i in delta.added],
        issue_counts=state.counts(),
```

with:

```python
        ],
        deleted_element_ids=list(res.deleted_element_ids),
        deleted_relationship_ids=list(res.deleted_relationship_ids),
        recreated_element_ids=list(res.recreated_element_ids),
        recreated_relationship_ids=list(res.recreated_relationship_ids),
        prev_rev=prev_rev,
        state_digest=state_digest,
        issues_removed_owner_ids=delta.removed_owner_ids,
        issues_added=[IssueOut.from_core(i) for i in delta.added],
        issue_counts=state.counts(),
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
    _from_metamodel_id: str | None = None,
    _to_metamodel_id: str | None = None,
    _entity_states: dict[str, Any] | None = None,
) -> bool:
    """Append the accepted batch to the durable journal and advance model_rev.

```

with:

```python
    _from_metamodel_id: str | None = None,
    _to_metamodel_id: str | None = None,
    _entity_states: dict[str, Any] | None = None,
    _state_digest: str | None = None,
) -> bool:
    """Append the accepted batch to the durable journal and advance model_rev.

```

In `src/data_rover/api/routes/ops.py`, replace:

```python
    ``_entity_states`` is ``capture_entity_states(model, res)`` for the
    applied batch — the diff reader's journal-only input; None (over-cap or
    a writer that has no model batch) means the reader reconstructs.

    Returns True if a durable row existed and the commit was persisted,
    False when the project has no model row (in-memory-only session)."""
```

with:

```python
    ``_entity_states`` is ``capture_entity_states(model, res)`` for the
    applied batch — the diff reader's journal-only input; None (over-cap or
    a writer that has no model batch) means the reader reconstructs.
    ``_state_digest`` is the session's state digest after the batch.

    Returns True if a durable row existed and the commit was persisted,
    False when the project has no model row (in-memory-only session)."""
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
        from_metamodel_id=_from_metamodel_id,
        to_metamodel_id=_to_metamodel_id,
        entity_states=_entity_states,
    )
    content.set_model_rev(db, project_id, rev)
    db.commit()
```

with:

```python
        from_metamodel_id=_from_metamodel_id,
        to_metamodel_id=_to_metamodel_id,
        entity_states=_entity_states,
        state_digest=_state_digest,
    )
    content.set_model_rev(db, project_id, rev)
    db.commit()
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
    inverse_ops: Sequence[OpIn],
    id_map: dict[str, str],
    entity_states: dict[str, Any] | None = None,
) -> bool:
    """Record an undo as a forward compensating commit (append-only journal).

```

with:

```python
    inverse_ops: Sequence[OpIn],
    id_map: dict[str, str],
    entity_states: dict[str, Any] | None = None,
    state_digest: str | None = None,
) -> bool:
    """Record an undo as a forward compensating commit (append-only journal).

```

In `src/data_rover/api/routes/ops.py`, replace:

```python
        inverse_ops=serialize_ops(inverse_ops),
        id_map=dict(id_map),
        entity_states=entity_states,
    )
    content.set_model_rev(db, project_id, rev)
    db.commit()
```

with:

```python
        inverse_ops=serialize_ops(inverse_ops),
        id_map=dict(id_map),
        entity_states=entity_states,
        state_digest=state_digest,
    )
    content.set_model_rev(db, project_id, rev)
    db.commit()
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
        return OpsResponse(model_rev=session.model_rev, issue_counts=state.counts())
    with session.write_mutex:
        res = _apply_batch(model, model_ops, restore=False)
        session.model_rev += 1
        if get_settings().snippet_incremental_invalidation:
            session.evict_touched_caches(touched_keys(model, model.metamodel, res))
        # no else: pre-branch /model/ops relied on the rev-stamp mismatch alone
```

with:

```python
        return OpsResponse(model_rev=session.model_rev, issue_counts=state.counts())
    with session.write_mutex:
        res = _apply_batch(model, model_ops, restore=False)
        prev_rev = session.model_rev
        prior_digest = session.state_digest_value
        session.model_rev += 1
        state_digest = session.advance_state_digest(res)
        if get_settings().snippet_incremental_invalidation:
            session.evict_touched_caches(touched_keys(model, model.metamodel, res))
        # no else: pre-branch /model/ops relied on the rev-stamp mismatch alone
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
                inverse_ops=res.inverse_ops(),
                id_map=dict(res.id_map),
                _entity_states=capture_entity_states(model, res),
            )
        except Exception as exc:
            _rollback(model, res)  # undo the in-memory mutation
            session.model_rev -= 1
            # The rev moves BACKWARDS here. A concurrent lock-free
            # /tables/evaluate may already have stamped the script cell cache
            # at the higher rev (it only self-clears on a FORWARD stamp move),
```

with:

```python
                inverse_ops=res.inverse_ops(),
                id_map=dict(res.id_map),
                _entity_states=capture_entity_states(model, res),
                _state_digest=state_digest,
            )
        except Exception as exc:
            _rollback(model, res)  # undo the in-memory mutation
            session.model_rev -= 1
            session.state_digest_value = prior_digest
            # The rev moves BACKWARDS here. A concurrent lock-free
            # /tables/evaluate may already have stamped the script cell cache
            # at the higher rev (it only self-clears on a FORWARD stamp move),
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
            ) from exc
        if persisted:
            _maybe_periodic_snapshot(db, project_id, session, session.model_rev)
        return _finalize(session, state, model, res)


@router.post("/model/undo", response_model=None)
```

with:

```python
            ) from exc
        if persisted:
            _maybe_periodic_snapshot(db, project_id, session, session.model_rev)
        return _finalize(
            session, state, model, res, prev_rev=prev_rev, state_digest=state_digest
        )


@router.post("/model/undo", response_model=None)
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
                session.op_log.append(batch)
                db.rollback()
                raise
        session.model_rev += 1
        if get_settings().snippet_incremental_invalidation:
            session.evict_touched_caches(touched_keys(model, model.metamodel, res))
        # no else: pre-branch /model/ops relied on the rev-stamp mismatch alone
```

with:

```python
                session.op_log.append(batch)
                db.rollback()
                raise
        prev_rev = session.model_rev
        prior_digest = session.state_digest_value
        session.model_rev += 1
        state_digest = session.advance_state_digest(res)
        if get_settings().snippet_incremental_invalidation:
            session.evict_touched_caches(touched_keys(model, model.metamodel, res))
        # no else: pre-branch /model/ops relied on the rev-stamp mismatch alone
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
                inverse_ops=inverse_ops,
                id_map=merged_id_map,
                entity_states=capture_entity_states(model, res),
            )
        except Exception as exc:
            _rollback(model, res)  # undo the in-memory mutation
            session.model_rev -= 1
            session.invalidate_derived_caches()  # rev moved BACK; see apply_ops
            for _vid, done_view, done_res in reversed(view_results):
                rollback_view(done_view, done_res.inverse_units)
```

with:

```python
                inverse_ops=inverse_ops,
                id_map=merged_id_map,
                entity_states=capture_entity_states(model, res),
                state_digest=state_digest,
            )
        except Exception as exc:
            _rollback(model, res)  # undo the in-memory mutation
            session.model_rev -= 1
            session.state_digest_value = prior_digest
            session.invalidate_derived_caches()  # rev moved BACK; see apply_ops
            for _vid, done_view, done_res in reversed(view_results):
                rollback_view(done_view, done_res.inverse_units)
```

In `src/data_rover/api/routes/ops.py`, replace:

```python
            res.dirty.update(
                applies_population(model, prior_compiled, session.compiled_rules)
            )
        return _finalize(session, state, model, res)
```

with:

```python
            res.dirty.update(
                applies_population(model, prior_compiled, session.compiled_rules)
            )
        return _finalize(
            session, state, model, res, prev_rev=prev_rev, state_digest=state_digest
        )
```

In `src/data_rover/api/routes/commits.py`, replace:

```python
    - ``op_log.pop()`` and the ``session.validation`` null only when
      ``rev_bumped``: the batch enters the op log — and the issue store gets
      its irreversible splice — at the same instant the rev bumps (step d),
      never earlier.
    - ``db.rollback()`` last, and only once ``db_staged`` — the paths
      before any staging (missing-lock 409, model-apply failure) never
      rolled the request transaction back and still must not.
```

with:

```python
    - ``op_log.pop()`` and the ``session.validation`` null only when
      ``rev_bumped``: the batch enters the op log — and the issue store gets
      its irreversible splice — at the same instant the rev bumps (step d),
      never earlier. The state digest advances at that instant too, so the
      same flag puts ``prior_digest`` back; before it, the exact model
      rollback leaves the digest true as it stands.
    - ``db.rollback()`` last, and only once ``db_staged`` — the paths
      before any staging (missing-lock 409, model-apply failure) never
      rolled the request transaction back and still must not.
```

In `src/data_rover/api/routes/commits.py`, replace:

```python
    #: instant of the swap, like ``prior_metamodel``; None whenever the batch
    #: left ``session.compiled_rules`` alone (the common case).
    prior_compiled: CompiledRules | None = None
    db_staged: bool = False
    rev_bumped: bool = False

```

with:

```python
    #: instant of the swap, like ``prior_metamodel``; None whenever the batch
    #: left ``session.compiled_rules`` alone (the common case).
    prior_compiled: CompiledRules | None = None
    #: ``session.state_digest_value`` from before the batch was folded into
    #: it (None = it was not known then either). Meaningful once ``rev_bumped``.
    prior_digest: int | None = None
    db_staged: bool = False
    rev_bumped: bool = False

```

In `src/data_rover/api/routes/commits.py`, replace:

```python
            # nothing.
            self.session.validation = None
            self.session.model_rev -= 1
        if self.model_res is not None or self.prior_metamodel is not None:
            # Runs AFTER the rev decrement by the invariant above. The
            # metamodel arm matters as much as the model one: every derived
```

with:

```python
            # nothing.
            self.session.validation = None
            self.session.model_rev -= 1
            self.session.state_digest_value = self.prior_digest
        if self.model_res is not None or self.prior_metamodel is not None:
            # Runs AFTER the rev decrement by the invariant above. The
            # metamodel arm matters as much as the model one: every derived
```

In `src/data_rover/api/routes/commits.py`, replace:

```python
            delta = state.replace(res.dirty.ids, scoped)
            issues_removed = delta.removed_owner_ids
            issues_added = [IssueOut.from_core(i) for i in delta.added]
        session.model_rev += 1
        if rebound:
            # Mirrors the standalone rebind route: EVERY derived row order and
            # script cell value was computed against the old schema, so
```

with:

```python
            delta = state.replace(res.dirty.ids, scoped)
            issues_removed = delta.removed_owner_ids
            issues_added = [IssueOut.from_core(i) for i in delta.added]
        prev_rev = session.model_rev
        unwind.prior_digest = session.state_digest_value
        session.model_rev += 1
        state_digest = session.advance_state_digest(res)
        if rebound:
            # Mirrors the standalone rebind route: EVERY derived row order and
            # script cell value was computed against the old schema, so
```

In `src/data_rover/api/routes/commits.py`, replace:

```python
                _from_metamodel_id=mm_res.from_metamodel_id if mm_res else None,
                _to_metamodel_id=mm_res.to_metamodel_id if mm_res else None,
                _entity_states=capture_entity_states(model, res),
            )
        except Exception as exc:
            # undo every live half — see _CommitUnwind. By this point that is
```

with:

```python
                _from_metamodel_id=mm_res.from_metamodel_id if mm_res else None,
                _to_metamodel_id=mm_res.to_metamodel_id if mm_res else None,
                _entity_states=capture_entity_states(model, res),
                _state_digest=state_digest,
            )
        except Exception as exc:
            # undo every live half — see _CommitUnwind. By this point that is
```

In `src/data_rover/api/routes/commits.py`, replace:

```python
            session.hub.broadcast(
                commit_event(
                    rev=session.model_rev,
                    commit_id=commit_id,
                    author_id=user.id,
                    message=payload.message,
```

with:

```python
            session.hub.broadcast(
                commit_event(
                    rev=session.model_rev,
                    prev_rev=prev_rev,
                    state_digest=state_digest,
                    commit_id=commit_id,
                    author_id=user.id,
                    message=payload.message,
```

In `src/data_rover/api/routes/commits.py`, replace:

```python
                    changed_relationships=changed_relationships,
                    deleted_element_ids=list(res.deleted_element_ids),
                    deleted_relationship_ids=list(res.deleted_relationship_ids),
                )
            )
        broadcast_artifact_events(
```

with:

```python
                    changed_relationships=changed_relationships,
                    deleted_element_ids=list(res.deleted_element_ids),
                    deleted_relationship_ids=list(res.deleted_relationship_ids),
                    recreated_element_ids=list(res.recreated_element_ids),
                    recreated_relationship_ids=list(res.recreated_relationship_ids),
                )
            )
        broadcast_artifact_events(
```

In `src/data_rover/api/routes/commits.py`, replace:

```python
        ],
        deleted_element_ids=list(res.deleted_element_ids),
        deleted_relationship_ids=list(res.deleted_relationship_ids),
        issues_removed_owner_ids=issues_removed,
        issues_added=issues_added,
        issue_counts=state.counts(),
```

with:

```python
        ],
        deleted_element_ids=list(res.deleted_element_ids),
        deleted_relationship_ids=list(res.deleted_relationship_ids),
        recreated_element_ids=list(res.recreated_element_ids),
        recreated_relationship_ids=list(res.recreated_relationship_ids),
        prev_rev=prev_rev,
        state_digest=state_digest,
        issues_removed_owner_ids=issues_removed,
        issues_added=issues_added,
        issue_counts=state.counts(),
```

In `src/data_rover/api/routes/commits.py`, replace:

```python
            )
        conformance = [i for i in scoped if i.category is IssueCategory.CONFORMANCE]
        delta = state.replace(res.dirty.ids, scoped)
        session.model_rev += 1
        session.invalidate_derived_caches()  # mirrors touch_model
        session.record_batch(
            AppliedBatch(
```

with:

```python
            )
        conformance = [i for i in scoped if i.category is IssueCategory.CONFORMANCE]
        delta = state.replace(res.dirty.ids, scoped)
        prev_rev = session.model_rev
        unwind.prior_digest = session.state_digest_value
        session.model_rev += 1
        state_digest = session.advance_state_digest(res)
        session.invalidate_derived_caches()  # mirrors touch_model
        session.record_batch(
            AppliedBatch(
```

In `src/data_rover/api/routes/commits.py`, replace:

```python
                _validation_error_count=len(conformance),
                _issues=issues_json,
                _entity_states=capture_entity_states(model, res),
            )
        except Exception as exc:
            unwind.unwind()  # undo every live half — see _CommitUnwind
```

with:

```python
                _validation_error_count=len(conformance),
                _issues=issues_json,
                _entity_states=capture_entity_states(model, res),
                _state_digest=state_digest,
            )
        except Exception as exc:
            unwind.unwind()  # undo every live half — see _CommitUnwind
```

In `src/data_rover/api/routes/commits.py`, replace:

```python
        session.hub.broadcast(
            commit_event(
                rev=session.model_rev,
                commit_id=commit_id,
                author_id=user.id,
                message=message,
```

with:

```python
        session.hub.broadcast(
            commit_event(
                rev=session.model_rev,
                prev_rev=prev_rev,
                state_digest=state_digest,
                commit_id=commit_id,
                author_id=user.id,
                message=message,
```

In `src/data_rover/api/routes/commits.py`, replace:

```python
                changed_relationships=changed_relationships,
                deleted_element_ids=list(res.deleted_element_ids),
                deleted_relationship_ids=list(res.deleted_relationship_ids),
            )
        )
    return CommitResponse(
```

with:

```python
                changed_relationships=changed_relationships,
                deleted_element_ids=list(res.deleted_element_ids),
                deleted_relationship_ids=list(res.deleted_relationship_ids),
                recreated_element_ids=list(res.recreated_element_ids),
                recreated_relationship_ids=list(res.recreated_relationship_ids),
            )
        )
    return CommitResponse(
```

In `src/data_rover/api/routes/commits.py`, replace:

```python
        ],
        deleted_element_ids=list(res.deleted_element_ids),
        deleted_relationship_ids=list(res.deleted_relationship_ids),
        issues_removed_owner_ids=delta.removed_owner_ids,
        issues_added=[IssueOut.from_core(i) for i in delta.added],
        issue_counts=state.counts(),
```

with:

```python
        ],
        deleted_element_ids=list(res.deleted_element_ids),
        deleted_relationship_ids=list(res.deleted_relationship_ids),
        recreated_element_ids=list(res.recreated_element_ids),
        recreated_relationship_ids=list(res.recreated_relationship_ids),
        prev_rev=prev_rev,
        state_digest=state_digest,
        issues_removed_owner_ids=delta.removed_owner_ids,
        issues_added=[IssueOut.from_core(i) for i in delta.added],
        issue_counts=state.counts(),
```

- [ ] **Step 6: Run the tests**

Run: `pixi run -e core-dev pytest tests/api/test_commit_delta.py tests/api/test_state_digest.py tests/api/test_feed_hub.py tests/api/test_alembic.py -q`
Expected: `30 passed`.

- [ ] **Step 7: Pin the frontend's tolerance of the new fields**

Nothing in the frontend reads them before plan 4; its response schema must keep parsing a response that carries them.

In `frontend/src/lib/api/__tests__/types.checkout.test.ts`, replace:

```ts
		expect(v.model_rev).toBe(4);
	});

	it('parses a commit response carrying the artifact delta', () => {
		const res = CommitResponseSchema.parse({
			model_rev: 3,
```

with:

```ts
		expect(v.model_rev).toBe(4);
	});

	it('parses a commit response carrying what a replica follows it by', () => {
		const v = CommitResponseSchema.parse({
			model_rev: 5,
			commit_id: 'c2',
			prev_rev: 4,
			state_digest: '00000000000000ff',
			recreated_element_ids: ['e1'],
			recreated_relationship_ids: []
		});
		expect(v.model_rev).toBe(5);
		expect(v.changed_elements).toEqual([]);
	});

	it('parses a commit response carrying the artifact delta', () => {
		const res = CommitResponseSchema.parse({
			model_rev: 3,
```

Run: `pixi run frontend-test src/lib/api/__tests__/types.checkout.test.ts`
Expected: `Tests  8 passed (8)`. It passes at once: `OpsResponseSchema` is a plain `z.object`, which strips what it does not know.

- [ ] **Step 8: See the digest tests bite**

Each is a temporary edit: make it, run the command, see the failure, and reverse the edit by hand before the next.

1. In `src/data_rover/api/session.py`, make `advance_state_digest` recompute always (`self.state_digest_value = None` as its first statement). `pixi run -e core-dev pytest tests/api/test_commit_delta.py -q -k kept_up` fails with `the session recomputed a digest it knew`.
2. In `src/data_rover/api/routes/ops.py`, in `apply_ops`' `except`, drop `session.state_digest_value = prior_digest`. `-k taken_back` fails: the digest names a batch that is gone.
3. In `src/data_rover/api/state_digest.py`, in `fold_batch`, drop the relationships' loop. `pixi run -e core-dev pytest tests/api/test_state_digest.py -q` fails `test_a_landed_batch_folds_into_the_digest`.

- [ ] **Step 9: Say it in the docs**

In `CLAUDE.md`, replace:

```markdown
- **Rev conflicts**: clients echo `model_rev` as `base_rev`; a stale batch gets **409** and the client must reload.
```

with:

```markdown
- **Rev conflicts**: clients echo `model_rev` as `base_rev`; a stale batch gets **409** and the client must reload.
- **The commit delta (CT-2)**: every landed batch — `POST /commits`, `/commits/revert`, `/model/ops`, `/model/undo` — answers with `prev_rev` (the `model_rev` before the bump), `state_digest` and `recreated_element_ids` / `recreated_relationship_ids` on `OpsResponse` / `CommitResponse` (`prev_rev` and `state_digest` are `null` on a response that applied nothing); `commit_event` carries the same four, and `Commit.state_digest` (nullable, Alembic `0015`) records the digest on the journal row. `Session.state_digest_value` is the CT-3 digest as an integer: `advance_state_digest(res)` folds a landed batch into it in O(batch) (`state_digest.fold_batch`: every before-image out, whatever the batch left behind in), and it is `None` — recomputed in one O(model) pass by the next `Session.state_digest()` — on a fresh or hydrated session and after `set_model` / `touch_model`. A rolled-back batch needs nothing, the rollback being exact; a path that takes a LANDED batch back (a persist failure, `_CommitUnwind` once `rev_bumped`) restores the value from before it. `/model/ops` and `/model/undo` stay silent on the feed: a replica sees the `prev_rev` gap at the next delta. The frontend's zod schemas strip the new fields; nothing reads them yet.
```

In `architecture/program.md`, replace:

```markdown
| B | Replica and frontend seam | designed 2026-09-19, six plans — none built |
```

with:

```markdown
| B | Replica and frontend seam | designed 2026-09-19, six plans — plan 1 built (exact server state: `K-30` and `K-31` closed, digest and `prev_rev` on every delta carrier) |
```

In `BACKLOG-ENGINE.md`, replace:

```markdown
six plans, listed in `architecture/program.md`, none built —
and inherits `K-32`.
```

with:

```markdown
six plans, listed in `architecture/program.md`, the first built
(exact server state) — and inherits `K-32`.
```

- [ ] **Step 10: Run everything, and lint**

```bash
pixi run core-test
pixi run backend-lint
pixi run -e core-dev ruff check tests/api/test_commit_delta.py tests/api/test_state_digest.py tests/api/test_feed_hub.py tests/api/test_alembic.py alembic/versions/0015_commit_state_digest.py
pixi run -e core-dev ruff format --check tests/api/test_commit_delta.py alembic/versions/0015_commit_state_digest.py
```

Expected: `2465 passed, 34 deselected`; ruff, mypy and pyright clean; both files already formatted.

- [ ] **Step 11: Commit**

```bash
git add tests/api/test_commit_delta.py tests/api/test_state_digest.py tests/api/test_feed_hub.py tests/api/test_alembic.py alembic/versions/0015_commit_state_digest.py frontend/src/lib/api/__tests__/types.checkout.test.ts src/data_rover/api/state_digest.py src/data_rover/api/session.py src/data_rover/api/schemas.py src/data_rover/api/feed.py src/data_rover/api/db_models.py src/data_rover/api/content.py src/data_rover/api/routes/ops.py src/data_rover/api/routes/commits.py CLAUDE.md architecture/program.md BACKLOG-ENGINE.md
git commit -m "Carry the state digest and prev_rev on every commit delta"
```

---

### Task 5: Verify the whole, and bring the branch home

**Files:** none changed.

- [ ] **Step 1: Every suite, every linter**

```bash
pixi run dr-test
pixi run dr-tidy check_only=true
pixi run golden-fixtures
git status --short
```

Expected: core pytest `2465 passed, 34 deselected`; frontend vitest green with one test more than before (`types.checkout.test.ts`); engine vitest `272 passed` in 39 files; every formatter and linter clean; `git status` prints nothing — the fixtures are current and nothing is left uncommitted.

- [ ] **Step 2: Check the migration against a database that has rows**

```bash
pixi run -e core-dev pytest tests/api/test_alembic.py -q
```

Expected: all pass, `test_migration_0015_adds_commit_state_digest` among them. On a deployed Postgres the column arrives with `pixi run db-upgrade`; rows written before it keep `NULL`, which plan 2's tail route reads as "not expressible as a delta".

- [ ] **Step 3: Bring the branch home**

```bash
git switch engine-migration
git merge --ff-only feat/exact-server-state
```

---

## After this plan

Plan 2 (v2 snapshot writers, `Snapshot.format`, the descriptor, blob and tail routes, `X-Metamodel-Id`) is written once this one has landed. What it inherits:

- `Session.state_digest()` is the header digest of a v2 snapshot and the descriptor's `state_digest`; it must be read under `write_mutex`, and costs one full pass when the session has just been hydrated.
- The tail route rebuilds a delta from a `Commit` row: `entity_states` (its `recreated` key included; absent on rows older than this plan, which then name none), `Commit.state_digest` (`NULL` on older rows and on baseline markers → `complete: false`), and `prev_rev` from the row before.
- `K-33` (staged validation leaves derived caches standing) is open in `BACKLOG.md`. `K-32` is B's plan 3.
