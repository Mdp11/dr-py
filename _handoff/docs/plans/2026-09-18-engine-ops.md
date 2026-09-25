# Engine Ops: Op Applier and Working Copy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the TypeScript engine the server's op applier — same semantics, same refusal texts, with a rollback that is exact — and the working copy that stages op batches over a replica and rebases them over commit deltas, each proven against the real Python core through golden fixtures or, where no oracle exists, through seeded invariants.

**Architecture:** Plan 3 of 4 for sub-project A (`architecture/program.md`). No file under `src/` changes on the Python side: the golden recorder (`tests/golden/model_steps.py`) learns two step kinds, `batch` (an op batch through `routes/ops.py::_apply_batch`) and `undo` (an earlier batch's inverse ops in restore mode), and records with each landed batch the delta a replica would be sent. The engine gains `src/ops/` (`applyBatch`, `BatchResult` with first-touch before-images, `rewind`, `OpError`), three committed-state methods on `Model` (`insertElement`, `insertRelationship`, `overwrite`) and `src/working/` (`WorkingCopy`: stage, unstage, `applyDelta`, conflicts, committed reads). One mechanism serves a refused batch, an unstage and a delta: put touched entities back from their before-images, change what is underneath, replay.

**Tech Stack:** Python 3.14 (pytest, ruff; pydantic and FastAPI only as the recorder's imports); TypeScript 6 (strict, erasable syntax only), vitest 3, eslint 10, prettier 3; pixi for every command.

**Spec:** `docs/superpowers/specs/2026-09-18-engine-foundation-design.md` — §5 Ops, §6 Working copy, and the op-batch scenarios and working-copy invariants of §8 and §9. Read `architecture/README.md`, `architecture/contracts.md` (CT-2, CT-3, CT-5, CT-7), `architecture/decisions.md` (AD-12, AD-14, AD-20), `architecture/program.md` (MR-3) and `architecture/conventions.md` first. Plan 2 (`docs/superpowers/plans/2026-09-18-engine-store.md`) built the store this plan writes to.

**Provenance:** every code block below was built and run before this plan was written, in a scratch copy of `fe9cf18` against the real Python core and the repository's own pixi environments; the blocks were then generated from those files, not retyped, and the partial edits are the exact strings a script applied. The tasks were replayed in order in a second clean copy: each failing step failed as stated, each passing step passed, `tsc` (both projects), eslint, prettier and ruff were clean at every task boundary, and the final tree was identical to the scratch copy. End state: 209 engine tests in 34 files, 2,429 Python tests (34 deselected), fixtures current; the three new fixtures weigh 67 KB, 13 KB and 279 KB. The tests were also seen to bite: a queue instead of a stack in the containment closure fails `ops_batches`; a rewind that keeps the current `rev`, or appends instead of restoring `ord`, fails `ops_batches` and `ops_churn`; a rewired relationship kept in its old place fails the replica test at the rewire step; an own commit that does not rewrite temp ids, a rewind oldest-first, a delete left out of the digest and a silently dropped conflict each fail between 8 and 35 working-copy tests. If a step's expected result does not appear, suspect the environment before the code.

## What the oracle taught this plan

Each of these refines the spec; the spec file was updated to match. The first two were put to the owner and decided on 2026-09-18. Review them before executing.

1. **The oracle's rollback is not exact; the engine's is.** `_rollback` replays inverse ops in restore mode, so after a refused batch every updated entity's `rev` is two higher and every deleted-then-restored entity sits at the end of its dict with `rev` counted again from zero. Observed: `[update id-3, delete id-1, update ghost]` → 422, `id-3` at `rev` 3 instead of 1, `id-1` and `id-2` behind it, state digest `d2499a403aeabae2` → `6b1333ccfa35d720`, no commit. `POST /commits/preview` rolls back the same way. A working copy cannot live with that — a refused `stage()` would leave committed entities at `rev`s the server never had, and the next delta's digest check would call the replica diverged — so `applyBatch` puts every touched entity back from its first-touch before-image: properties, `rev`, place in state order. The spec said "rollback newest unit first in restore mode". In the fixtures the recorder applies every batch to a deep copy of the oracle's model and keeps the copy only when the batch lands, so none of the drift enters a fixture; the refusal texts are still the oracle's. Logged as `K-30` for sub-project B, where the server starts serving the digest.
2. **A delta cannot say "deleted and created again under the same id".** An apply-CR rewire is `delete_relationship` + `create_relationship` with the same `id` hint; the server's dict moves the relationship last, and the delta lists it only as changed. Entity order is state (CT-1), so `applyDelta` treats an entity that arrives under another type or other ends than the replica's record as removed and appended, which matches the server for every rewire — `engine/test/working/replica.golden.test.ts` follows the oracle through one, order included. A re-creation that changes neither cannot be told from an update: scenario `ops_recreate` shows the applier's bookkeeping for it and is kept out of the replica test (seen to fail there at its step 1). The digest cannot see it either: steps 23–25 of `ops_batches` share one digest, because a re-created entity that ends at its old `rev` hashes to the same pair. Logged as `K-31`; CT-2 gains the apply order and this rule in Task 4.
3. **A refusal's detail loses the quotes at its ends.** `_error_detail` strips `'` and `"` from both ends of `str(KeyError)`, which is the `repr` of the message: `No element with id 'ghost`, `City' has no property 'nope`, and, when the id holds both kinds of quote, the `repr`'s backslashes stay (`No element with id \'it\\\'s "both"\`). `ValueError` texts pass through whole. The engine reproduces it with `pyRepr` plus the same strip; `ops_batches` holds every text.
4. **The containment closure is walked from a stack**, children by sorted relationship id, each element listed when it is first seen; per closure element the cascade lists its outgoing then its incoming relationship ids, each sorted. Step 21–22 of `ops_batches` is built so that a queue gives another order.
5. **A rewind needs inserts that check no type.** Bulk load is non-strict, so a model may hold an element whose type its metamodel lacks; a staged delete of it must be rewindable, and `restoreElement(…, ord)` refuses the type. `Model` therefore gains `insertElement` / `insertRelationship` (unchecked, `rev` and optional `ord` given) and `overwrite` (properties and `rev` replaced whole); `restoreElement` / `restoreRelationship` validate and delegate to them. The same three methods are how `applyDelta` writes committed state, which "bypasses the mutation boundary and takes the server's `rev`" (spec §6).
6. **A record that outlived its batch is told by its `ord`.** Creation always takes a new `ord`, so a record created again under a touched id never carries the `ord` of the before-image. `rewind` rewrites a survivor where it is — identity, adjacency and place untouched — removes whatever else sits under a touched id, relationships first, and inserts what is missing at its old `ord`, elements first.
7. **A refused batch consumes no ids in a fixture**, because the copy it ran on is dropped, generator included. The golden runner's `idFor` counts up per call and the counter is put back when a step is refused. `applyBatch` calls `idFor` once per minted entity, in op order, never for a hinted or a reinstated one; it calls it before the type check, which no fixture can see.
8. **Ops travel through fixtures as lines of JSON text**, not tagged values: the recorder writes ops, before-images, inverse ops and changed entities with the server's compact `json.dumps`; the engine reads them with `parseJson` and renders its own with `pyDumps`, so every comparison is byte for byte — which also pins the key order of the inverse ops the engine builds (`kind, temp_id, type_name, [source_id, target_id,] properties, id`).
9. **The digest's hash is injected.** `applyDelta` must fold `(id, rev)` pairs, and the pure-TypeScript SHA-256 belongs to plan 4. `WorkingCopy` takes `entityHash: (id, rev) => bigint` as an option; the tests pass the `node:crypto` one from `engine/test/golden/digest.ts`. Plan 4 gives the option a default.
10. **An op carrying an array-index property key is refused like any other bad op** — a 422 with its own text, the batch rewound — at any depth of `properties` or `properties_patch`. A delta carrying one throws `SnapshotError` from `applyDelta` before anything moves, with the bulk loader's text and the entry's position (`changed_elements[0]: …`).
11. **`unstage` mirrors the frontend's two reverts.** `{entity}` drops the staged ops that target the entity (`revertStagedFor`); with `incident: true` also every staged relationship op with the entity at one end (`revertStagedForElement`), the ends read from the working model or from a staged batch's before-image. A batch left empty disappears; the rest replays, and what no longer applies is parked. A parked batch is not retried; `{batch}` and `'all'` dismiss it.
12. **No file of this plan holds a 4-digit unicode escape.** Python sources use the 8-digit form and TypeScript the braced one, which tooling does not rewrite, so the blocks can be typed or extracted alike. The ASCII check still applies.

## Global Constraints

- Everything runs through pixi. There is no global `python` or `node`: use `pixi run <task>`, `pixi run -e core-dev ...`, `pixi run -e frontend ...`. The system `node` is too old for the tooling.
- Work on branch `feat/engine-ops`, cut from `engine-migration` (Task 1 cuts it) and fast-forwarded back into it when the plan is done (Task 6). Do not touch `main`.
- **Freeze rule (MR-3):** no behaviour change in `src/data_rover/core/model`, `src/data_rover/core/metamodel` or the model-op applier (`routes/ops.py`). This plan changes no file under `src/`. If the port exposes an oracle bug, stop and raise it: a fix lands on both sides with a fixture, never on one.
- The Python core is the oracle. When a golden test fails, the engine is wrong — never edit a fixture by hand, never loosen a scenario to make a test pass. Fixtures change only through `pixi run golden-fixtures`. The one place the engine differs on purpose is finding 1, and no fixture records the oracle's side of it.
- `engine/src/` uses no DOM API and no Node built-in (`lib: ["ES2023"]`, `types: []`). Tests may import `node:*`.
- TypeScript is erasable syntax only: no parameter properties, no enums, no namespaces. Import specifiers end in `.ts`. No `any` in an exported signature. No `Date.now`, `Math.random`, `Intl` or locale comparison in `src/`.
- Adjacency arrays and sets have no specified order. Anything observable sorts, by code point (`cmpCodePoint`), never with a bare `.sort()` on text that may hold non-ASCII.
- Read a property with `getProp` / `Object.hasOwn` and write one with `setProp`, never `props[name]` for a name that comes from data: `constructor` and `__proto__` are legal property names.
- Property values are replaced whole, never mutated in place: before-images and inverse ops alias them. A property BAG is copied (`{ ...props }`) wherever two owners would otherwise share it.
- Op types keep the wire's snake_case names (`temp_id`, `properties_patch`, `source_id`): they are the shapes of `src/data_rover/api/schemas.py` (CT-5.2). Everything else in the engine is camelCase.
- Performance is plan 4's subject. Do not optimize here; a rewind that restores an old `ord` re-sorts the entity map once, and that is accepted.
- Formatting: tabs, single quotes, no trailing commas, width 100 (prettier, run through `pixi run engine-tidy`); Python is ruff-formatted. `pixi run dr-tidy` does not lint `tests/`: run ruff on `tests/golden` by hand, as the steps say.
- Comments and docstrings are concise and present-tense, only for what the code cannot say. No references to specs, plans, phases or `architecture/` ids in code.
- Check with `LC_ALL=C grep -rnP '[^[:ascii:]]' tests/golden engine/test`: only `café` in `engine/test/value/serialize.test.ts` may show.
- `architecture/` is tracked and changes in the same commit as the code it describes; `docs/` is git-ignored — never `git add -f`.
- Commit subjects: one imperative sentence, capitalized, no prefix, no trailing period; end the message with the session's `Co-Authored-By` line.

## File Structure

```
tests/golden/model_steps.py               + batch, undo steps; _outcome; batches run on a copy
tests/golden/scenarios/ops_batches.py     every op kind, temp ids, hints, restore, undo, every refusal text
tests/golden/scenarios/ops_recreate.py    an entity created again under its id, unchanged
tests/golden/scenarios/ops_churn.py       a seeded random walk of batches and undos

engine/src/model/model.ts                 + insertElement, insertRelationship, overwrite
engine/src/model/load.ts                  findArrayIndexKey exported
engine/src/ops/types.ts                   the six model ops, in the wire's shapes
engine/src/ops/errors.ts                  OpError
engine/src/ops/result.ts                  BatchResult, ElementImage, RelImage
engine/src/ops/resolve.ts                 resolveValue, resolveProps
engine/src/ops/rewind.ts                  rewind: before-images put back
engine/src/ops/apply.ts                   applyBatch, ApplyOptions
engine/src/ops/remap.ts                   remapOp: temp ids rewritten in a staged op
engine/src/working/delta.ts               Delta, readDelta
engine/src/working/working-copy.ts        WorkingCopy and its types

engine/test/golden/model-steps.ts         + batch, undo in the replay; outcome, parseOps
engine/test/golden/digest.ts              entityHash exported
engine/test/model/fixtures.ts             + family()
engine/test/model/committed.test.ts       the three committed-state methods
engine/test/ops/*.golden.test.ts          batches, recreate, churn
engine/test/ops/apply.test.ts             ids, property bags, a refused batch leaves no trace
engine/test/ops/rewind.test.ts            rewinding landed batches
engine/test/working/helpers.ts            clone, workingCopy, Server
engine/test/working/working-copy.test.ts  staging, unstaging, deltas, divergence
engine/test/working/replica.golden.test.ts  a replica fed only the oracle's deltas
engine/test/working/random-ops.ts         RandomOps
engine/test/working/invariants.test.ts    four invariants, eight seeds each
engine/fixtures/golden/ops_*.json         generated — never edited by hand
```

---

### Task 1: Record op batches through the server's applier

The recorder already speaks in steps. A `batch` step validates raw op dicts as the ops route does and runs them through `_apply_batch`; an `undo` step runs the inverse ops of an earlier landed batch in restore mode. Both run on a deep copy of the model that replaces the model only when the batch lands (finding 1). A landed batch records its outcome and, as lines of the server's JSON text, the ops, the first-touch before-images, the inverse ops and the changed entities — the last two lists are the delta Task 4's replica follows.

**Files:**
- Modify: `tests/golden/model_steps.py` (whole file below)
- Create: `tests/golden/scenarios/ops_batches.py`, `tests/golden/scenarios/ops_recreate.py`, `tests/golden/scenarios/ops_churn.py`
- Modify: `tests/golden/scenarios/__init__.py`
- Generated: `engine/fixtures/golden/ops_batches.json`, `ops_recreate.json`, `ops_churn.json`

**Interfaces:**
- Consumes: `data_rover.api.routes.ops._apply_batch(model, ops, *, restore) -> _BatchResult` and `_BatchResult.inverse_ops()`; `data_rover.api.schemas.ModelOpIn`, `ElementOut`, `RelationshipOut`.
- Produces: `batch(ops: list[dict], **extra) -> dict` (a step; `restore=True` is the only extra) and the step `{"do": "undo", "of": <step index>}`. A landed step's `result` is `{id_map: [[temp, id]…], changed_element_ids, changed_relationship_ids, deleted_element_ids, deleted_relationship_ids, before_elements: [[id, line | null]…], before_relationships, inverse_ops: [line…], changed_elements: [line…], changed_relationships: [line…]}`; its entry also carries `ops: [line…]`. A refused step's `error` is `{status: 422, detail}`.

- [ ] **Step 1: Cut the branch**

```bash
git switch engine-migration
git switch -c feat/engine-ops
```

- [ ] **Step 2: Teach the recorder the two steps**

`tests/golden/model_steps.py` (replace the whole file):

```python
"""Runs steps against a real ``Model`` and records what happened.

A step is a JSON-ready dict: ``do`` names a method of the mutation boundary,
the other keys are its arguments (property values tagged, see ``tagged.py``);
``batch`` runs an op batch through the server's applier and ``undo`` runs the
inverse ops of an earlier batch in restore mode. After every step the recorder adds the outcome (``result`` or ``error``) and
what the step left behind: the state digest and a fingerprint of the entity
lines plus the index dump. Every ``full_every``-th step, and the last, carries
the lines and the dump themselves, so a mismatch can be read, not just seen. A
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
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, TypeAdapter

from data_rover.api.routes.ops import _apply_batch, _BatchResult
from data_rover.api.schemas import ElementOut, ModelOpIn, RelationshipOut
from data_rover.api.serialize import iter_entity_lines
from data_rover.api.state_digest import model_digest
from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.element import Element
from data_rover.core.model.ids import SequentialIdGenerator
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship

from .index_dump import dump_indexes
from .tagged import tag


_MODEL_OPS: TypeAdapter[list[ModelOpIn]] = TypeAdapter(list[ModelOpIn])


def _line(doc: BaseModel) -> str:
    """One op or entity as the compact JSON text the server writes."""
    return json.dumps(
        doc.model_dump(), separators=(",", ":"), ensure_ascii=False, allow_nan=False
    )


def fingerprint(state: list[str], indexes: str) -> str:
    """16 hex digits over the entity lines and the index dump text."""
    text = "\n".join(state) + "\n" + indexes
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def observe(model: Model) -> dict[str, Any]:
    """The state, index dump and digest of a model the oracle agrees with.

    The dump travels as compact JSON text: indented, its id lists would take
    a line per id and dwarf everything else in the fixture.
    """
    model.indexes.verify_consistent()
    state = list(iter_entity_lines(model))
    indexes = json.dumps(dump_indexes(model), separators=(",", ":"), ensure_ascii=False)
    return {
        "digest": model_digest(model),
        "fingerprint": fingerprint(state, indexes),
        "state": state,
        "indexes": indexes,
    }


def set_property(entity_id: str, prop: str, value: Any, **extra: Any) -> dict[str, Any]:
    """A ``set_property`` step. The raw value rides along under ``_value``;
    the recorder applies it and writes its tagged form."""
    return {
        "do": "set_property",
        "id": entity_id,
        "prop": prop,
        "_value": value,
        **extra,
    }


def batch(ops: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    """A ``batch`` step. The raw ops ride along under ``_ops``; the recorder
    validates them as the ops route does and writes each as one line of text."""
    return {"do": "batch", "_ops": ops, **extra}


def _outcome(model: Model, res: _BatchResult) -> dict[str, Any]:
    """What a landed batch reports, and the delta a replica would be sent."""
    return {
        "id_map": [[temp, real] for temp, real in res.id_map.items()],
        "changed_element_ids": list(res.changed_element_ids),
        "changed_relationship_ids": list(res.changed_relationship_ids),
        "deleted_element_ids": list(res.deleted_element_ids),
        "deleted_relationship_ids": list(res.deleted_relationship_ids),
        "before_elements": [
            [eid, None if before is None else _line(before)]
            for eid, before in res.before_elements.items()
        ],
        "before_relationships": [
            [rid, None if before is None else _line(before)]
            for rid, before in res.before_relationships.items()
        ],
        "inverse_ops": [_line(op) for op in res.inverse_ops()],
        "changed_elements": [
            _line(ElementOut.from_core(model.elements[eid]))
            for eid in res.changed_element_ids
        ],
        "changed_relationships": [
            _line(RelationshipOut.from_core(model.relationships[rid]))
            for rid in res.changed_relationship_ids
        ],
    }


class Recorder:
    """One scenario in the making: a model with sequential ids, and its log."""

    def __init__(self, metamodel: Metamodel, *, full_every: int = 5) -> None:
        self.metamodel = metamodel
        self.model = Model(metamodel, SequentialIdGenerator())
        self._full_every = full_every
        self._steps: list[dict[str, Any]] = []
        self._last: dict[str, Any] | None = None
        self._landed: dict[int, _BatchResult] = {}

    def _entity(self, step: dict[str, Any]) -> Element | Relationship:
        detached = step.get("detached")
        if detached == "element":
            return Element(id=step["id"], type_name=step["type"])
        if detached == "relationship":
            return Relationship(
                id=step["id"], type_name=step["type"], source_id="", target_id=""
            )
        model = self.model
        entity = model.elements.get(step["id"]) or model.relationships.get(step["id"])
        if entity is None:
            raise AssertionError(f"scenario names an unknown entity {step['id']!r}")
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
        match step["do"]:
            case "batch":
                ops = _MODEL_OPS.validate_python(step["_ops"])
                return self._batch(ops, restore=bool(step.get("restore", False)))
            case "undo":
                return self._batch(self._landed[step["of"]].inverse_ops(), restore=True)
            case "create_element":
                return model.create_element(step["type"]).id
            case "restore_element":
                return model.restore_element(step["id"], step["type"]).id
            case "get_element":
                return model.get_element(step["id"]).id
            case "get_relationship":
                return model.get_relationship(step["id"]).id
            case "set_property":
                model.set_property(self._entity(step), step["prop"], step["_value"])
                return None
            case "delete_property":
                model.delete_property(self._entity(step), step["prop"])
                return None
            case "connect":
                return model.connect(step["type"], step["source"], step["target"]).id
            case "restore_relationship":
                return model.restore_relationship(
                    step["id"], step["type"], step["source"], step["target"]
                ).id
            case "disconnect":
                model.disconnect(step["id"])
                return None
            case "delete_element":
                model.delete_element(step["id"])
                return None
            case "container_of":
                return model.container_of(step["id"])
            case "relationships_from":
                return sorted(r.id for r in model.relationships_from(step["id"]))
            case "relationships_to":
                return sorted(r.id for r in model.relationships_to(step["id"]))
        raise AssertionError(f"unknown step {step['do']!r}")

    def run(self, step: dict[str, Any]) -> Any:
        """Apply one step, log it, and return its result (``None`` on an error)."""
        entry = {key: item for key, item in step.items() if not key.startswith("_")}
        if "_value" in step:
            entry["value"] = tag(step["_value"])
        if "_ops" in step:
            entry["ops"] = [
                _line(op) for op in _MODEL_OPS.validate_python(step["_ops"])
            ]
        try:
            entry["result"] = self._apply(step)
            entry["error"] = None
        except (KeyError, ValueError) as exc:
            entry["result"] = None
            entry["error"] = {
                "kind": "key" if isinstance(exc, KeyError) else "value",
                "message": exc.args[0],
            }
        except HTTPException as exc:
            entry["result"] = None
            entry["error"] = {"status": exc.status_code, "detail": exc.detail}
        seen = observe(self.model)
        if seen == self._last:
            entry["unchanged"] = True
        else:
            entry["digest"] = seen["digest"]
            entry["fingerprint"] = seen["fingerprint"]
            if len(self._steps) % self._full_every == 0:
                entry.update(seen)
        self._steps.append(entry)
        self._last = seen
        return entry["result"]

    def document(self) -> dict[str, Any]:
        """The scenario document: the metamodel as ``GET /metamodel`` serves
        it, then every step with its outcome and what it left behind."""
        # The last step that changed anything always carries the full state.
        for entry in reversed(self._steps):
            if "unchanged" not in entry:
                assert self._last is not None
                entry.update(self._last)
                break
        return {
            "metamodel": self.metamodel.model_dump(mode="json"),
            "steps": self._steps,
        }


def run_steps(
    metamodel: Metamodel, steps: Iterable[dict[str, Any]], *, full_every: int = 5
) -> dict[str, Any]:
    recorder = Recorder(metamodel, full_every=full_every)
    for step in steps:
        recorder.run(step)
    return recorder.document()
```

- [ ] **Step 3: Write the scenarios and register them**

`tests/golden/scenarios/ops_batches.py`:

```python
"""Op batches through the server's applier: every op kind, temp ids, id
hints, restore mode, undo, and the detail text of every refusal."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import batch, run_steps

_METAMODEL = {
    "elements": [
        {
            "name": "Thing",
            "abstract": True,
            "properties": [{"name": "name", "datatype": "string"}],
        },
        {
            "name": "City",
            "extends": "Thing",
            "properties": [
                {"name": "population", "datatype": "integer"},
                {"name": "area", "datatype": "float"},
                {"name": "mayor", "datatype": "Person"},
                {"name": "twins", "datatype": "City", "multiplicity": "0..*"},
                {"name": "extra", "datatype": "string"},
            ],
        },
        {"name": "District", "extends": "Thing"},
        {"name": "Person", "extends": "Thing"},
    ],
    "relationships": [
        {"name": "Owns", "containment": True, "source": "Thing", "target": "Thing"},
        {
            "name": "Knows",
            "source": "Person",
            "target": "Person",
            "properties": [
                {"name": "since", "datatype": "integer"},
                {"name": "via", "datatype": "Person"},
            ],
        },
    ],
}


def _element(temp_id: str, type_name: str, **properties: Any) -> dict[str, Any]:
    return {
        "kind": "create_element",
        "temp_id": temp_id,
        "type_name": type_name,
        "properties": properties,
    }


def _rel(
    temp_id: str, type_name: str, source: str, target: str, **properties: Any
) -> dict[str, Any]:
    return {
        "kind": "create_relationship",
        "temp_id": temp_id,
        "type_name": type_name,
        "source_id": source,
        "target_id": target,
        "properties": properties,
    }


def _update(entity_id: str, **patch: Any) -> dict[str, Any]:
    return {"kind": "update_element", "id": entity_id, "properties_patch": patch}


def _update_rel(rel_id: str, **patch: Any) -> dict[str, Any]:
    return {"kind": "update_relationship", "id": rel_id, "properties_patch": patch}


def _delete(entity_id: str) -> dict[str, Any]:
    return {"kind": "delete_element", "id": entity_id}


def _delete_rel(rel_id: str) -> dict[str, Any]:
    return {"kind": "delete_relationship", "id": rel_id}


_STEPS: list[dict[str, Any]] = [
    # 0: temp ids resolve in endpoints and in property values (a string, a
    # list, a nested list); an unknown temp id passes through; a dict does not
    # resolve. id-1 Rome, id-2 Ann, id-3 Bob, id-4 Owns, id-5 Knows.
    batch(
        [
            _element(
                "tmp_rome", "City", name="Rome", population=2_800_000, area=1285.0
            ),
            _element("tmp_ann", "Person", name="Ann"),
            _element("tmp_bob", "Person", name="Bob"),
            _update(
                "tmp_rome",
                mayor="tmp_ann",
                twins=["tmp_rome", "tmp_nowhere", ["tmp_ann"]],
                extra={"who": "tmp_ann"},
            ),
            _rel("tmp_owns", "Owns", "tmp_rome", "tmp_ann"),
            _rel("tmp_k", "Knows", "tmp_ann", "tmp_bob", since=2020, via="tmp_bob"),
        ]
    ),
    # 1: a temp id means nothing in a later batch
    batch([_update("tmp_rome", name="x")]),
    # 2: merge patch: replace, the same value again, null deletes, null for an
    # absent key, a new key; the inverse restores each prior value
    batch([_update("id-1", name="Roma", population=2_800_000, area=None, extra=None)]),
    batch([_update("id-2", name=None), _update("id-2", name=None)]),
    batch(
        [_update_rel("id-5", since=None, via="id-2"), _update_rel("id-5", since=1999)]
    ),
    # 5: an empty patch touches the entity and changes nothing
    batch([_update("id-3"), _update_rel("id-5")]),
    # 6: an empty batch
    batch([]),
    # 7: values keep their kind: bool, int, float, big int, negative zero
    batch(
        [
            _update("id-1", population=True),
            _update("id-1", area=-0.0),
            _update("id-1", population=2**70, area=1e22),
            _update("id-1", twins=[1, 1.0, True, None, "id-1", {"k": [1.5]}]),
        ]
    ),
    # 8: first-touch order; an entity deleted after a change leaves the changed
    # set; created and deleted in one batch, it never existed before
    batch(
        [
            _update("id-3", name="Bobby"),
            _update("id-2", name="Annie"),
            _update("id-3", name="Bob"),
            _element("tmp_d", "District", name="Centro"),
            _rel("tmp_o", "Owns", "id-1", "tmp_d"),
            _update("tmp_d", name="Centro storico"),
            _delete("tmp_d"),
            _delete_rel("id-5"),
        ]
    ),
    # 9: undo the batch above, then the first one's update of Rome
    {"do": "undo", "of": 8},
    {"do": "undo", "of": 2},
    # 11: id hints, on elements and relationships
    batch(
        [
            _element("tmp_m", "City", name="Milan") | {"id": "city-milan"},
            _rel("tmp_t", "Owns", "tmp_m", "id-3") | {"id": "owns-milan-bob"},
            _update("tmp_m", mayor="tmp_t"),
        ]
    ),
    batch([_element("tmp_x", "City") | {"id": "city-milan"}]),
    batch([_element("tmp_x", "City") | {"id": "owns-milan-bob"}]),
    batch([_rel("tmp_x", "Knows", "id-2", "id-3") | {"id": "city-milan"}]),
    batch([_element("tmp_x", "City") | {"id": "tmp_taken"}]),
    batch([_rel("tmp_x", "Knows", "id-2", "id-3") | {"id": "tmp_taken"}]),
    # 17: a temp id without the prefix is refused, and is an exact id in
    # restore mode
    batch([_element("plain", "City")]),
    batch([_rel("plain", "Knows", "id-2", "id-3")]),
    batch(
        [
            _element("plain", "City", name="Plain"),
            _rel("plain-knows", "Knows", "id-2", "id-3", since=1),
            _element("tmp_still", "Person", name="Minted"),
        ],
        restore=True,
    ),
    batch([_element("plain", "City")], restore=True),
    # 21: a cascade: Rome owns Ann (id-4), who owns a child, and a district
    # that owns a person who knows herself. The closure is walked from a
    # stack; the inverse recreates elements first, then relationships.
    batch(
        [
            _element("tmp_d", "District", name="Trastevere"),
            _rel("tmp_o1", "Owns", "id-1", "tmp_d"),
            _element("tmp_p", "Person", name="Eve"),
            _rel("tmp_o2", "Owns", "tmp_d", "tmp_p"),
            _rel("tmp_self", "Knows", "tmp_p", "tmp_p"),
            _rel("tmp_in", "Knows", "id-3", "tmp_p", since=5),
            _element("tmp_kid", "Person", name="Kid"),
            _rel("tmp_o3", "Owns", "id-2", "tmp_kid"),
            _update("city-milan", twins=["id-1"]),
        ]
    ),
    batch([_delete("id-1")]),
    {"do": "undo", "of": 22},
    # 24: a rewire keeps the id and changes the ends
    batch(
        [
            _delete_rel("plain-knows"),
            _rel("tmp_r", "Knows", "id-3", "id-2", since=2) | {"id": "plain-knows"},
        ]
    ),
    # 25: the same id under another type
    batch(
        [_delete("plain"), _element("tmp_r", "Person", name="Plain") | {"id": "plain"}]
    ),
    # 26: refusals; each leaves no trace. A create fails at its third property.
    batch([_element("tmp_a", "City", name="a"), _element("tmp_b", "Nope")]),
    batch([_element("tmp_a", "Thing")]),
    batch([_element("tmp_a", "City", name="a", population=1, nope=2)]),
    batch([_update("id-3", name="kept?"), _update("id-3", nope=1)]),
    batch([_delete("id-3"), _update("ghost")]),
    batch([_delete("ghost")]),
    batch([_delete_rel("ghost")]),
    batch([_update_rel("ghost")]),
    batch([_update_rel("plain-knows", nope=1)]),
    batch([_update("plain-knows")]),
    batch([_delete("plain-knows")]),
    batch([_delete_rel("id-3")]),
    batch([_rel("tmp_x", "Nope", "id-2", "id-3")]),
    batch([_rel("tmp_x", "Knows", "ghost", "id-3")]),
    batch([_rel("tmp_x", "Knows", "id-2", "ghost")]),
    batch([_rel("tmp_x", "Knows", "id-2", "id-3", since=1, nope=2)]),
    # the detail of a missing key loses the quotes at its ends, whichever they are
    batch([_delete("it's")]),
    batch([_delete('say "hi"')]),
    batch([_delete('it\'s "both"')]),
    batch([_delete("'")]),
    # an undo across a type change, and one whose entities are gone
    {"do": "undo", "of": 25},
    {"do": "undo", "of": 21},
    {"do": "undo", "of": 21},
]


@scenario("ops_batches")
def ops_batches() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS)
```

`tests/golden/scenarios/ops_recreate.py`:

```python
"""An entity deleted and created again under its own id, unchanged in type
and ends, within one batch. The applier's bookkeeping is what is on show: the
first before-image stays, the id leaves the deleted set, and the entity moves
to the end of the state order. No delta can say so, which is why this scenario
is kept apart from the ones a replica follows."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import batch, run_steps

_METAMODEL = {
    "elements": [
        {"name": "Node", "properties": [{"name": "name", "datatype": "string"}]}
    ],
    "relationships": [
        {"name": "Holds", "containment": True, "source": "Node", "target": "Node"},
        {"name": "Link", "source": "Node", "target": "Node"},
    ],
}


def _node(temp_id: str, name: str, **extra: Any) -> dict[str, Any]:
    return {
        "kind": "create_element",
        "temp_id": temp_id,
        "type_name": "Node",
        "properties": {"name": name},
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


_STEPS: list[dict[str, Any]] = [
    # id-1 a, id-2 b, id-3 c, id-4 a holds b, id-5 b links c, id-6 a links c
    batch(
        [
            _node("tmp_a", "a"),
            _node("tmp_b", "b"),
            _node("tmp_c", "c"),
            _rel("tmp_h", "Holds", "tmp_a", "tmp_b"),
            _rel("tmp_l", "Link", "tmp_b", "tmp_c"),
            _rel("tmp_m", "Link", "tmp_a", "tmp_c"),
        ]
    ),
    # the element, and with it the relationship its cascade took
    batch(
        [
            {"kind": "delete_element", "id": "id-2"},
            _node("tmp_x", "b", id="id-2"),
            _rel("tmp_y", "Link", "tmp_x", "id-3", id="id-5"),
        ]
    ),
    # the relationship alone
    batch(
        [
            {"kind": "delete_relationship", "id": "id-6"},
            _rel("tmp_z", "Link", "id-1", "id-3", id="id-6"),
        ]
    ),
    {"do": "undo", "of": 1},
]


@scenario("ops_recreate")
def ops_recreate() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS)
```

`tests/golden/scenarios/ops_churn.py`:

```python
"""A seeded random walk of op batches: a few ops each, temp ids woven through
endpoints and reference values, refusals from stale ids and undeclared
properties, and undos of earlier batches that may themselves be refused."""

from __future__ import annotations

import random
from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import Recorder, batch

_SEED = 20260919
_STEPS = 160

_METAMODEL = {
    "elements": [
        {
            "name": "Part",
            "properties": [
                {"name": "name", "datatype": "string"},
                {"name": "size", "datatype": "float"},
                {"name": "peers", "datatype": "Part", "multiplicity": "0..*"},
            ],
        },
        {
            "name": "Slot",
            "properties": [
                {"name": "name", "datatype": "string"},
                {"name": "code", "datatype": "integer"},
                {"name": "holder", "datatype": "Part"},
            ],
            "key": ["code", "out:Feeds", "in:Feeds"],
        },
    ],
    "relationships": [
        {"name": "Owns", "containment": True, "source": "Part", "target": "Part"},
        {"name": "Seats", "extends": "Owns", "source": "Part", "target": "Slot"},
        {
            "name": "Feeds",
            "source": "Slot",
            "target": "Slot",
            "properties": [{"name": "via", "datatype": "Part"}],
        },
    ],
}

_NAMES = ["", "a", "b", "B", "\U000000e9", "\U0001f600", "\U0000ffff"]
_NUMBERS = [0, 1, 1.0, True, False, -0.0, 2, 2.5]


class _Walk:
    def __init__(self) -> None:
        self.rng = random.Random(_SEED)
        self.recorder = Recorder(Metamodel.model_validate(_METAMODEL), full_every=40)
        self.temps = 0
        self.count = 0
        self.landed: list[int] = []

    def pick(self, items: list[Any]) -> Any:
        # rng.random() alone: its stream is stable across Python versions.
        return items[int(self.rng.random() * len(items))]

    def temp(self) -> str:
        self.temps += 1
        return f"tmp_{self.temps}"

    def ops(self) -> list[dict[str, Any]]:
        model = self.recorder.model
        parts = [e.id for e in model.elements.values() if e.type_name == "Part"]
        slots = [e.id for e in model.elements.values() if e.type_name == "Slot"]
        feeds = [r.id for r in model.relationships.values() if r.type_name == "Feeds"]
        rels = list(model.relationships)
        out: list[dict[str, Any]] = []
        for _ in range(1 + int(self.rng.random() * 4)):
            match self.pick(["create"] * 4 + ["update"] * 6 + ["connect"] * 5
                            + ["update_rel", "delete_rel", "delete", "stale", "undeclared"]):  # fmt: skip
                case "create":
                    temp = self.temp()
                    kind = self.pick(["Part", "Part", "Slot"])
                    (parts if kind == "Part" else slots).append(temp)
                    out.append(
                        {
                            "kind": "create_element",
                            "temp_id": temp,
                            "type_name": kind,
                            "properties": {"name": self.pick(_NAMES)},
                        }
                    )
                case "update" if parts or slots:
                    target = self.pick([*parts, *slots])
                    some = self.pick([*parts, *slots, "dangling"])
                    patch: dict[str, Any] = {"name": self.pick([*_NAMES, None])}
                    if target in slots:
                        patch["code"] = self.pick([*_NUMBERS, None])
                        patch["holder"] = some
                    else:
                        patch["size"] = self.pick([*_NUMBERS, None])
                        patch["peers"] = [some, self.pick([*parts, "dangling"])]
                    out.append(
                        {
                            "kind": "update_element",
                            "id": target,
                            "properties_patch": patch,
                        }
                    )
                case "connect" if parts:
                    kind = self.pick(["Owns", "Seats", "Feeds"])
                    sources, targets = {
                        "Owns": (parts, parts),
                        "Seats": (parts, slots),
                        "Feeds": (slots, slots),
                    }[kind]
                    if not sources or not targets:
                        continue
                    temp = self.temp()
                    op: dict[str, Any] = {
                        "kind": "create_relationship",
                        "temp_id": temp,
                        "type_name": kind,
                        "source_id": self.pick(sources),
                        "target_id": self.pick(targets),
                    }
                    if kind == "Feeds":
                        op["properties"] = {"via": self.pick([*parts, "dangling"])}
                        feeds.append(temp)
                    rels.append(temp)
                    out.append(op)
                case "update_rel" if feeds:
                    out.append(
                        {
                            "kind": "update_relationship",
                            "id": self.pick(feeds),
                            "properties_patch": {"via": self.pick([*parts, None])},
                        }
                    )
                case "delete_rel" if rels:
                    out.append({"kind": "delete_relationship", "id": self.pick(rels)})
                case "delete" if parts or slots:
                    out.append(
                        {"kind": "delete_element", "id": self.pick([*parts, *slots])}
                    )
                case "stale":
                    out.append({"kind": "delete_element", "id": "gone"})
                case "undeclared" if parts:
                    out.append(
                        {
                            "kind": "update_element",
                            "id": self.pick(parts),
                            "properties_patch": {"name": "x", "code": 1},
                        }
                    )
        return out

    def step(self) -> None:
        """One more step: mostly a batch, now and then the undo of a landed one."""
        if self.landed and self.rng.random() < 0.15:
            step: dict[str, Any] = {"do": "undo", "of": self.pick(self.landed)}
        else:
            step = batch(self.ops())
        if self.recorder.run(step) is not None:
            self.landed.append(self.count)
        self.count += 1


@scenario("ops_churn")
def ops_churn() -> Any:
    walk = _Walk()
    for _ in range(_STEPS):
        walk.step()
    return walk.recorder.document()
```

In `tests/golden/scenarios/__init__.py`, replace:

```python
    model_mutations,
    py_repr,
```

with:

```python
    model_mutations,
    ops_batches,
    ops_churn,
    ops_recreate,
    py_repr,
```

- [ ] **Step 4: See the drift guard fail**

Run: `pixi run -e core-dev pytest tests/golden -q`
Expected: FAIL — `test_committed_golden_fixtures_are_current`: ``run `pixi run golden-fixtures` and commit the result``, `Left contains 3 more items, first extra item: 'ops_batches.json'`.

- [ ] **Step 5: Generate the fixtures**

Run: `pixi run golden-fixtures`
Expected: `wrote golden fixtures to …/engine/fixtures/golden`.

Run: `git status --short engine/fixtures`
Expected: exactly three lines, `?? engine/fixtures/golden/ops_batches.json`, `ops_churn.json`, `ops_recreate.json` — no existing fixture moved, so the recorder still records the old steps as it did.

Run: `pixi run -e core-dev pytest tests/golden -q`
Expected: PASS — 1 passed.

- [ ] **Step 6: Read what the oracle said**

Open `engine/fixtures/golden/ops_batches.json` and check three things against the findings: step 1's `error` is `{"status": 422, "detail": "No element with id 'tmp_rome"}` and the step says `"unchanged": true`; step 22's `deleted_element_ids` is `["id-1", "id-9", "id-2", "id-15", "id-11"]` (the stack walk: Ann's child `id-15` before the district's `id-11`; a queue would swap them); steps 23, 24 and 25 carry the same `digest` and three different `fingerprint`s.

- [ ] **Step 7: Lint and commit**

Run: `pixi run -e core-dev ruff format tests/golden && pixi run -e core-dev ruff check tests/golden`
Expected: `25 files left unchanged`, `All checks passed!`.

```bash
git add tests/golden engine/fixtures/golden
git commit -m "Record op batches through the server's applier"
```

---

### Task 2: Insert and overwrite committed state in the store

Committed state arrives whole: the server's delta carries an entity's properties and `rev`, and a rewind puts back an entity exactly as it was, under a type the metamodel may no longer have (finding 5). The mutation boundary's `restore*` methods check the type and start `rev` at zero, so the store gains three methods that check nothing and count nothing, and `restore*` delegate to them.

**Files:**
- Modify: `engine/src/model/model.ts`
- Test: `engine/test/model/committed.test.ts`

**Interfaces:**
- Consumes: `Model`, `ElementRec`, `RelRec`, `Props`, `IndexSet`'s hooks (plan 2).
- Produces, on `Model`:
  - `insertElement(id: string, typeName: string, props: Props, rev: number, ord?: number): ElementRec` — refuses only an id in use (`Id 'x' is already in use`).
  - `insertRelationship(id: string, relType: string, sourceId: string, targetId: string, props: Props, rev: number, ord?: number): RelRec` — refuses a missing end (`No source element 'x'` / `No target element 'x'`), then an id in use.
  - `overwrite(target: ElementRec | RelRec, props: Props, rev: number): void`.
  All three take over the `props` object they are given.

- [ ] **Step 1: Write the failing test**

`engine/test/model/committed.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { dumpIndexes, Model, modelLines, verifyConsistent } from '../../src/index.ts';
import { nodeMetamodel } from './fixtures.ts';

describe('committed state enters unchecked and uncounted', () => {
	it('inserts an element of a type the metamodel does not have, with its properties and rev', () => {
		const model = new Model(nodeMetamodel());
		model.insertElement('x', 'Gone', { anything: 1 }, 7);
		expect(modelLines(model)).toEqual([
			'{"id":"x","type_name":"Gone","properties":{"anything":1},"rev":7}'
		]);
		expect(dumpIndexes(model).roots).toEqual([['x', 'x']]);
		verifyConsistent(model);
	});

	it('indexes what the properties say at once: references and the root name', () => {
		const model = new Model(nodeMetamodel());
		model.insertElement('b', 'Node', { name: 'B', peer: 'a' }, 2);
		model.insertElement('a', 'Node', { name: 'A' }, 1);
		expect([...model.indexes.referencersOf('a')]).toEqual(['b']);
		expect(dumpIndexes(model).roots).toEqual([
			['A', 'a'],
			['B', 'b']
		]);
		verifyConsistent(model);
	});

	it('inserts a relationship with its rev, and refuses missing ends and a taken id', () => {
		const model = new Model(nodeMetamodel());
		model.insertElement('a', 'Node', {}, 0);
		model.insertElement('b', 'Node', {}, 0);
		model.insertRelationship('r', 'NoSuchType', 'a', 'b', {}, 3);
		expect(model.getRelationship('r').rev).toBe(3);
		expect(() => model.insertRelationship('s', 'Refers', 'ghost', 'b', {}, 0)).toThrow(
			"No source element 'ghost'"
		);
		expect(() => model.insertRelationship('s', 'Refers', 'a', 'ghost', {}, 0)).toThrow(
			"No target element 'ghost'"
		);
		expect(() => model.insertRelationship('a', 'Refers', 'a', 'b', {}, 0)).toThrow(
			"Id 'a' is already in use"
		);
		expect(() => model.insertElement('r', 'Node', {}, 0)).toThrow("Id 'r' is already in use");
		verifyConsistent(model);
	});

	it('puts a record back at its old place when given its ord', () => {
		const model = new Model(nodeMetamodel());
		const first = model.insertElement('first', 'Node', {}, 0);
		model.insertElement('second', 'Node', {}, 0);
		model.deleteElement('first');
		model.insertElement('first', 'Node', { name: 'back' }, 9, first.ord);
		expect([...model.elements()].map((e) => e.id)).toEqual(['first', 'second']);
		verifyConsistent(model);
	});

	it('overwrites properties and rev whole, checking no name and counting nothing', () => {
		const model = new Model(nodeMetamodel());
		const a = model.insertElement('a', 'Node', { name: 'A', peer: 'x' }, 4);
		model.overwrite(a, { undeclared: true, name: 'Z' }, 2);
		expect(modelLines(model)).toEqual([
			'{"id":"a","type_name":"Node","properties":{"undeclared":true,"name":"Z"},"rev":2}'
		]);
		expect([...model.indexes.referencersOf('x')]).toEqual([]);
		verifyConsistent(model);
	});
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pixi run engine-test`
Expected: FAIL — the five tests of `test/model/committed.test.ts` fail with `model.insertElement is not a function`; the other 135 pass.

- [ ] **Step 3: Add the three methods**

In `engine/src/model/model.ts`, replace:

```ts
import { ElementRec, RelRec, setProp } from './records.ts';
```

with:

```ts
import { ElementRec, RelRec, setProp, type Props } from './records.ts';
```

In `engine/src/model/model.ts`, replace:

```ts
		this.requireFreeId(id);
		if (ord !== undefined && ord < this.nextOrd) this.elementsShuffled = true;
		const element = new ElementRec(id, typeName, {}, 0, this.takeOrd(ord));
		this.elementMap.set(id, element);
		this.indexes.onElementCreated(element);
		return element;
	}

	/** Contained children go first
```

with:

```ts
		return this.insertElement(id, typeName, {}, 0, ord);
	}

	/** Contained children go first
```

In `engine/src/model/model.ts`, replace:

```ts
			throw new ModelError('key', `Unknown relationship type ${pyRepr(relType)}`);
		}
		const source = this.elementMap.get(sourceId);
		if (source === undefined) {
			throw new ModelError('key', `No source element ${pyRepr(sourceId)}`);
		}
		const target = this.elementMap.get(targetId);
		if (target === undefined) {
			throw new ModelError('key', `No target element ${pyRepr(targetId)}`);
		}
		this.requireFreeId(id);
		if (ord !== undefined && ord < this.nextOrd) this.relationshipsShuffled = true;
		const rel = new RelRec(id, relType, source, target, {}, 0, this.takeOrd(ord));
		this.relationshipMap.set(id, rel);
		this.indexes.onRelationshipCreated(rel);
		return rel;
	}
```

with:

```ts
			throw new ModelError('key', `Unknown relationship type ${pyRepr(relType)}`);
		}
		return this.insertRelationship(id, relType, sourceId, targetId, {}, 0, ord);
	}
```

In `engine/src/model/model.ts`, replace:

```ts
	private requireFreeId(id: string): void {
```

with:

```ts
	// -- committed state -----------------------------------------------------
	//
	// What the server committed, and what a rewind puts back, arrives whole:
	// its types are not checked (a model may hold a type its metamodel no
	// longer has) and its `rev` is given, not counted.

	/** Inserts an element as it is, at its old place when `ord` is given. Takes over `props`. */
	insertElement(id: string, typeName: string, props: Props, rev: number, ord?: number): ElementRec {
		this.requireFreeId(id);
		if (ord !== undefined && ord < this.nextOrd) this.elementsShuffled = true;
		const element = new ElementRec(id, typeName, props, rev, this.takeOrd(ord));
		this.elementMap.set(id, element);
		this.indexes.onElementCreated(element);
		return element;
	}

	/** Inserts a relationship as it is, at its old place when `ord` is given. Takes over `props`. */
	insertRelationship(
		id: string,
		relType: string,
		sourceId: string,
		targetId: string,
		props: Props,
		rev: number,
		ord?: number
	): RelRec {
		const source = this.elementMap.get(sourceId);
		if (source === undefined) {
			throw new ModelError('key', `No source element ${pyRepr(sourceId)}`);
		}
		const target = this.elementMap.get(targetId);
		if (target === undefined) {
			throw new ModelError('key', `No target element ${pyRepr(targetId)}`);
		}
		this.requireFreeId(id);
		if (ord !== undefined && ord < this.nextOrd) this.relationshipsShuffled = true;
		const rel = new RelRec(id, relType, source, target, props, rev, this.takeOrd(ord));
		this.relationshipMap.set(id, rel);
		this.indexes.onRelationshipCreated(rel);
		return rel;
	}

	/** Replaces an attached entity's properties and `rev` whole. Takes over `props`. */
	overwrite(target: ElementRec | RelRec, props: Props, rev: number): void {
		target.props = props;
		target.rev = rev;
		this.indexes.onPropertyChanged(target);
	}

	private requireFreeId(id: string): void {
```

- [ ] **Step 4: Run the tests**

Run: `pixi run engine-test`
Expected: PASS — 140 tests in 26 files.

- [ ] **Step 5: Tidy and commit**

Run: `pixi run engine-tidy`
Expected: nothing reformatted, no diagnostics.

```bash
git add engine
git commit -m "Insert and overwrite committed state in the engine's store"
```

---

### Task 3: The op applier, with an exact rollback

`applyBatch` is `_apply_batch` for the six model ops: the same order of checks, the same texts, the same bookkeeping (findings 3, 4, 7, 8). What differs is what happens to a refused batch (finding 1): `rewind` puts every touched entity back from its before-image (finding 6), and the same function will rewind landed batches for the working copy. The golden runner grows the `batch` and `undo` steps; three fixtures replay through it, each a second time with every uniqueness key in one bucket.

**Files:**
- Create: `engine/src/ops/types.ts`, `engine/src/ops/errors.ts`, `engine/src/ops/result.ts`, `engine/src/ops/resolve.ts`, `engine/src/ops/rewind.ts`, `engine/src/ops/apply.ts`
- Modify: `engine/src/model/load.ts`, `engine/src/index.ts`
- Modify: `engine/test/golden/model-steps.ts` (whole file below), `engine/test/model/fixtures.ts`
- Test: `engine/test/ops/batches.golden.test.ts`, `engine/test/ops/recreate.golden.test.ts`, `engine/test/ops/churn.golden.test.ts`, `engine/test/ops/apply.test.ts`, `engine/test/ops/rewind.test.ts`

**Interfaces:**
- Consumes: Task 1's fixtures; Task 2's `insertElement` / `insertRelationship` / `overwrite`; `Model`'s mutation boundary, `ModelError`, `pyRepr`, `cmpCodePoint`, `getProp` / `setProp`, `TEMP_ID_PREFIX`, `parseJson`, `pyDumps` (plans 1–2).
- Produces:
  - `type ModelOp = CreateElementOp | UpdateElementOp | DeleteElementOp | CreateRelationshipOp | UpdateRelationshipOp | DeleteRelationshipOp` — `{kind, temp_id, type_name, properties?, id?}`, `{kind, id, properties_patch}`, `{kind, id}`, `{kind, temp_id, type_name, source_id, target_id, properties?, id?}`, `{kind, id, properties_patch}`, `{kind, id}`.
  - `applyBatch(model: Model, ops: readonly ModelOp[], options?: ApplyOptions): BatchResult`, `type ApplyOptions = { restore?: boolean; idFor?: (tempId: string) => string }`. Throws `OpError` after rewinding; anything else propagates after the same rewind.
  - `class OpError extends Error { readonly status: number; readonly detail: string }`.
  - `class BatchResult { idMap: Map<string, string>; inverseUnits: ModelOp[][]; changedElementIds, changedRelationshipIds, deletedElementIds, deletedRelationshipIds: Set<string>; beforeElements: Map<string, ElementImage | null>; beforeRelationships: Map<string, RelImage | null>; inverseOps(): ModelOp[] }`.
  - `type ElementImage = { id; typeName; props; rev; ord }`, `type RelImage = ElementImage & { sourceId; targetId }`, `elementImage(element)`, `relImage(rel)` (the last two from `ops/result.ts`, not from the package index).
  - `rewind(model: Model, result: BatchResult): void`.
  - `resolveValue(value, idMap)`, `resolveProps(props | undefined, idMap): Props` (from `ops/resolve.ts`).
  - In tests: `family(): Model` (`test/model/fixtures.ts`); `parseOps(lines)`, `outcome(model, res): BatchOutcome`, `type BatchOutcome`, `type StepError` (`test/golden/model-steps.ts`).

- [ ] **Step 1: Grow the golden runner and the shared fixture**

`engine/test/golden/model-steps.ts` (replace the whole file):

```ts
import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import {
	applyBatch,
	cmpCodePoint,
	dumpIndexes,
	elementLine,
	ElementRec,
	Metamodel,
	Model,
	ModelError,
	modelLines,
	OpError,
	parseJson,
	pyDumps,
	relationshipLine,
	RelRec,
	shuffleAdjacency,
	verifyConsistent,
	type BatchResult,
	type ElementImage,
	type MetamodelDoc,
	type ModelOp,
	type ModelOptions,
	type RelImage,
	type Value
} from '../../src/index.ts';
import { stateDigest } from './digest.ts';
import { untag, type Tagged } from './load.ts';

/**
 * What `tests/golden/model_steps.py` records of the model after a step: always
 * the digest and a fingerprint of lines plus index dump; at a checkpoint the
 * lines and the dump too.
 */
export type Observed = { digest: string; fingerprint: string; state?: string[]; indexes?: string };

/**
 * What a landed batch reports: ops, images and entities as lines of the
 * server's JSON text, and with them the delta a replica would be sent.
 */
export type BatchOutcome = {
	id_map: [string, string][];
	changed_element_ids: string[];
	changed_relationship_ids: string[];
	deleted_element_ids: string[];
	deleted_relationship_ids: string[];
	before_elements: [string, string | null][];
	before_relationships: [string, string | null][];
	inverse_ops: string[];
	changed_elements: string[];
	changed_relationships: string[];
};

export type StepError =
	{ kind: 'key' | 'value'; message: string } | { status: number; detail: string };

export type Step = Partial<Observed> & {
	do: string;
	id?: string;
	type?: string;
	prop?: string;
	source?: string;
	target?: string;
	value?: Tagged;
	detached?: 'element' | 'relationship';
	/** `batch`: the ops, one line of JSON text each; `restore` reinstates exact ids. */
	ops?: string[];
	restore?: boolean;
	/** `undo`: the index of the landed batch whose inverse ops to run. */
	of?: number;
	result: string | string[] | BatchOutcome | null;
	error: StepError | null;
	unchanged?: true;
};

export type StepsFixture = { metamodel: MetamodelDoc; steps: Step[] };

/** A small seeded generator (mulberry32): test runs must be repeatable. */
export function seededRandom(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function fingerprint(state: readonly string[], indexes: string): string {
	const text = state.join('\n') + '\n' + indexes;
	return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** The engine's side of `Observed`, the index dump as the oracle's compact JSON text. */
export function observe(model: Model): Required<Observed> {
	const state = modelLines(model);
	const indexes = pyDumps(dumpIndexes(model));
	return { digest: stateDigest(model), fingerprint: fingerprint(state, indexes), state, indexes };
}

const sortedIds = (rels: readonly RelRec[]) => rels.map((rel) => rel.id).sort(cmpCodePoint);

function entityOf(model: Model, step: Step): ElementRec | RelRec {
	if (step.detached === 'element') return new ElementRec(step.id!, step.type!, {}, 0, -1);
	if (step.detached === 'relationship') {
		const nowhere = new ElementRec('', '', {}, 0, -1);
		return new RelRec(step.id!, step.type!, nowhere, nowhere, {}, 0, -1);
	}
	return model.findElement(step.id!) ?? model.getRelationship(step.id!);
}

export const parseOps = (lines: readonly string[]) =>
	lines.map((line) => parseJson(line) as unknown as ModelOp);

const elementImageLine = (image: ElementImage) =>
	pyDumps({ id: image.id, type_name: image.typeName, properties: image.props, rev: image.rev });

const relImageLine = (image: RelImage) =>
	pyDumps({
		id: image.id,
		type_name: image.typeName,
		source_id: image.sourceId,
		target_id: image.targetId,
		properties: image.props,
		rev: image.rev
	});

/** The engine's side of `BatchOutcome`, every line rendered by the engine's own serializer. */
export function outcome(model: Model, res: BatchResult): BatchOutcome {
	return {
		id_map: [...res.idMap],
		changed_element_ids: [...res.changedElementIds],
		changed_relationship_ids: [...res.changedRelationshipIds],
		deleted_element_ids: [...res.deletedElementIds],
		deleted_relationship_ids: [...res.deletedRelationshipIds],
		before_elements: [...res.beforeElements].map(([id, image]) => [
			id,
			image === null ? null : elementImageLine(image)
		]),
		before_relationships: [...res.beforeRelationships].map(([id, image]) => [
			id,
			image === null ? null : relImageLine(image)
		]),
		inverse_ops: res.inverseOps().map((op) => pyDumps(op as unknown as Value)),
		changed_elements: [...res.changedElementIds].map((id) => elementLine(model.getElement(id))),
		changed_relationships: [...res.changedRelationshipIds].map((id) =>
			relationshipLine(model.getRelationship(id))
		)
	};
}

/** What a replay carries from step to step: the batches that landed, by step index. */
type Landed = Map<number, BatchResult>;

/**
 * `mint` stands in for the oracle's `SequentialIdGenerator`. A failed call
 * consumes no id, and neither does a refused batch: the oracle runs each on a
 * copy of its model and drops the copy, generator included.
 */
function apply(
	model: Model,
	step: Step,
	index: number,
	mint: () => string,
	landed: Landed
): Step['result'] {
	switch (step.do) {
		case 'batch':
		case 'undo': {
			const ops = step.do === 'batch' ? parseOps(step.ops!) : landed.get(step.of!)!.inverseOps();
			const restore = step.do === 'undo' || step.restore === true;
			const res = applyBatch(model, ops, { restore, idFor: mint });
			landed.set(index, res);
			return outcome(model, res);
		}
		case 'create_element':
			return model.createElement(step.type!, mint()).id;
		case 'restore_element':
			return model.restoreElement(step.id!, step.type!).id;
		case 'get_element':
			return model.getElement(step.id!).id;
		case 'get_relationship':
			return model.getRelationship(step.id!).id;
		case 'set_property':
			model.setProperty(entityOf(model, step), step.prop!, untag(step.value!));
			return null;
		case 'delete_property':
			model.deleteProperty(entityOf(model, step), step.prop!);
			return null;
		case 'connect':
			return model.connect(step.type!, step.source!, step.target!, mint()).id;
		case 'restore_relationship':
			return model.restoreRelationship(step.id!, step.type!, step.source!, step.target!).id;
		case 'disconnect':
			model.disconnect(step.id!);
			return null;
		case 'delete_element':
			model.deleteElement(step.id!);
			return null;
		case 'container_of':
			return model.containerOf(step.id!);
		case 'relationships_from':
			return sortedIds(model.relationshipsFrom(step.id!));
		case 'relationships_to':
			return sortedIds(model.relationshipsTo(step.id!));
	}
	throw new Error(`unknown step ${step.do}`);
}

/**
 * Replays a recorded scenario through the engine, comparing every outcome and
 * the whole observable state after every step. Adjacency is shuffled before
 * each step and the indexes are checked against a rebuild after it.
 */
export function replaySteps(fixture: StepsFixture, options: ModelOptions = {}): void {
	const model = new Model(Metamodel.fromJSON(fixture.metamodel), options);
	const random = seededRandom(20260918);
	const landed: Landed = new Map();
	let minted = 0;
	let last = observe(model);
	fixture.steps.forEach((step, index) => {
		const label = `step ${index}: ${step.do}`;
		shuffleAdjacency(model, random);
		let result: Step['result'] = null;
		let error: Step['error'] = null;
		const mintedBefore = minted;
		try {
			result = apply(model, step, index, () => `id-${++minted}`, landed);
		} catch (caught) {
			minted = mintedBefore;
			if (caught instanceof ModelError) error = { kind: caught.kind, message: caught.message };
			else if (caught instanceof OpError) error = { status: caught.status, detail: caught.detail };
			else throw caught;
		}
		expect(error, label).toEqual(step.error);
		expect(result, label).toEqual(step.result);
		const seen = observe(model);
		if (step.unchanged) {
			expect(seen, label).toEqual(last);
		} else {
			if (step.state !== undefined) {
				// A checkpoint: compare what can be read before what can only be seen.
				expect(seen.state, label).toEqual(step.state);
				expect(JSON.parse(seen.indexes), label).toEqual(JSON.parse(step.indexes!));
			}
			expect(seen.digest, label).toBe(step.digest);
			expect(seen.fingerprint, label).toBe(step.fingerprint);
		}
		verifyConsistent(model);
		expect(observe(model), `${label}, after a rebuild`).toEqual(seen);
		last = seen;
	});
}
```

In `engine/test/model/fixtures.ts`, replace:

```ts
import { Metamodel, type MetamodelDoc } from '../../src/index.ts';
```

with:

```ts
import { Metamodel, Model, type MetamodelDoc } from '../../src/index.ts';
```

In `engine/test/model/fixtures.ts`, replace:

```ts
export const nodeMetamodel = () => Metamodel.fromJSON(NODE_DOC);
```

with:

```ts
export const nodeMetamodel = () => Metamodel.fromJSON(NODE_DOC);

/**
 * `a` contains `b` and refers to `c`; `b` contains `d`. Every id is the
 * entity's own name, and every element is named by it in upper case.
 */
export function family(): Model {
	const model = new Model(nodeMetamodel());
	for (const id of ['a', 'b', 'c', 'd']) {
		model.setProperty(model.createElement('Node', id), 'name', id.toUpperCase());
	}
	model.connect('Contains', 'a', 'b', 'a-b');
	model.connect('Contains', 'b', 'd', 'b-d');
	model.connect('Refers', 'a', 'c', 'a-c');
	return model;
}
```

- [ ] **Step 2: Write the failing tests**

`engine/test/ops/batches.golden.test.ts`:

```ts
import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('the op applier matches the oracle', () => {
	const fixture = loadFixture<StepsFixture>('ops_batches');

	it('step by step: outcomes, refusal texts, state, indexes, digest', () => {
		replaySteps(fixture);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(fixture, { hashKey: () => 0 });
	});
});
```

`engine/test/ops/recreate.golden.test.ts`:

```ts
import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('the op applier matches the oracle when an entity is created again under its id', () => {
	const fixture = loadFixture<StepsFixture>('ops_recreate');

	it('step by step: outcomes, refusal texts, state, indexes, digest', () => {
		replaySteps(fixture);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(fixture, { hashKey: () => 0 });
	});
});
```

`engine/test/ops/churn.golden.test.ts`:

```ts
import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('the op applier follows the oracle through a random walk of batches', () => {
	const fixture = loadFixture<StepsFixture>('ops_churn');

	it('step by step: outcomes, refusal texts, state, indexes, digest', () => {
		replaySteps(fixture);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(fixture, { hashKey: () => 0 });
	});
});
```

`engine/test/ops/apply.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	applyBatch,
	Model,
	OpError,
	PyFloat,
	shuffleAdjacency,
	verifyConsistent,
	type ModelOp
} from '../../src/index.ts';
import { thrown } from '../golden/thrown.ts';
import { observe, seededRandom } from '../golden/model-steps.ts';
import { family, nodeMetamodel } from '../model/fixtures.ts';

const node = (temp_id: string, properties?: ModelOp & object): ModelOp =>
	({ kind: 'create_element', temp_id, type_name: 'Node', ...properties }) as ModelOp;

describe('ids', () => {
	it('keeps a created entity under its temp id when no idFor is given', () => {
		const model = new Model(nodeMetamodel());
		const res = applyBatch(model, [
			node('tmp_a'),
			node('tmp_b'),
			{
				kind: 'create_relationship',
				temp_id: 'tmp_r',
				type_name: 'Refers',
				source_id: 'tmp_a',
				target_id: 'tmp_b'
			},
			{ kind: 'update_element', id: 'tmp_a', properties_patch: { peer: 'tmp_b' } }
		]);
		expect([...res.idMap]).toEqual([
			['tmp_a', 'tmp_a'],
			['tmp_b', 'tmp_b'],
			['tmp_r', 'tmp_r']
		]);
		expect(model.getRelationship('tmp_r').source.id).toBe('tmp_a');
		expect(model.getElement('tmp_a').props).toEqual({ peer: 'tmp_b' });
		verifyConsistent(model);
	});

	it('asks idFor once per minted entity, in op order, and never for a hinted or reinstated one', () => {
		const model = new Model(nodeMetamodel());
		const asked: string[] = [];
		const idFor = (tempId: string) => (asked.push(tempId), `real-${asked.length}`);
		applyBatch(
			model,
			[node('tmp_a'), { ...node('tmp_b'), id: 'given' } as ModelOp, node('exact'), node('tmp_c')],
			{ restore: true, idFor }
		);
		expect(asked).toEqual(['tmp_a', 'tmp_c']);
		expect([...model.elements()].map((e) => e.id)).toEqual(['real-1', 'given', 'exact', 'real-2']);
	});
});

describe('property bags', () => {
	it('takes a create op without properties', () => {
		const model = new Model(nodeMetamodel());
		applyBatch(model, [node('tmp_a')]);
		expect(model.getElement('tmp_a').props).toEqual({});
	});

	it('carries __proto__ and constructor as plain keys through create, patch and inverse', () => {
		const model = new Model(nodeMetamodel());
		const properties = JSON.parse('{"__proto__": "p", "constructor": "c"}');
		const created = applyBatch(model, [
			{ kind: 'create_element', temp_id: 'tmp_a', type_name: 'Node', properties }
		]);
		const element = model.getElement('tmp_a');
		expect(Object.keys(element.props)).toEqual(['__proto__', 'constructor']);
		expect(Object.getPrototypeOf(element.props)).toBe(Object.prototype);
		const patch = JSON.parse('{"__proto__": null, "constructor": "d"}');
		const patched = applyBatch(model, [
			{ kind: 'update_element', id: 'tmp_a', properties_patch: patch }
		]);
		expect(Object.keys(element.props)).toEqual(['constructor']);
		applyBatch(model, patched.inverseOps(), { restore: true });
		expect(Object.entries(element.props)).toEqual([
			['constructor', 'c'],
			['__proto__', 'p']
		]);
		applyBatch(model, created.inverseOps(), { restore: true });
		expect(model.elementCount).toBe(0);
	});

	it.each([
		['a property name', { '0': 'x' }],
		['a key inside a value', { name: { deep: [{ '42': 1 }] } }]
	])('refuses an array-index key: %s', (_, properties) => {
		const model = new Model(nodeMetamodel());
		applyBatch(model, [node('tmp_a')]);
		const before = observe(model);
		const key = Object.keys(properties)[0] === '0' ? '0' : '42';
		const detail = `Property key '${key}' is an array index, which cannot keep its place in insertion order`;
		for (const op of [
			{ kind: 'create_element', temp_id: 'tmp_b', type_name: 'Node', properties },
			{ kind: 'update_element', id: 'tmp_a', properties_patch: properties },
			{
				kind: 'create_relationship',
				temp_id: 'tmp_r',
				type_name: 'Refers',
				source_id: 'tmp_a',
				target_id: 'tmp_a',
				properties
			}
		] as ModelOp[]) {
			const error = thrown(() => applyBatch(model, [node('tmp_c'), op]));
			expect(error).toBeInstanceOf(OpError);
			expect(error).toMatchObject({ status: 422, detail });
		}
		expect(observe(model)).toEqual(before);
	});

	it('keeps a float a float and leaves a value holding a temp id inside a dict alone', () => {
		const model = new Model(nodeMetamodel());
		applyBatch(model, [
			node('tmp_a'),
			{
				kind: 'update_element',
				id: 'tmp_a',
				properties_patch: { name: [new PyFloat(1), { at: 'tmp_a' }, ['tmp_a']] }
			}
		]);
		expect(model.getElement('tmp_a').props['name']).toEqual([
			new PyFloat(1),
			{ at: 'tmp_a' },
			['tmp_a']
		]);
	});
});

describe('a refused batch leaves no trace', () => {
	it('puts back revs and the place of every entity a cascade took', () => {
		const model = family();
		const random = seededRandom(7);
		const before = observe(model);
		const error = thrown(() =>
			applyBatch(model, [
				{ kind: 'update_element', id: 'c', properties_patch: { name: 'changed', peer: 'a' } },
				{ kind: 'delete_element', id: 'a' },
				node('tmp_new'),
				{ kind: 'delete_element', id: 'ghost' }
			])
		);
		expect(error).toMatchObject({ status: 422, detail: "No element with id 'ghost" });
		shuffleAdjacency(model, random);
		expect(observe(model)).toEqual(before);
		expect(model.containerOf('d')).toBe('b');
		verifyConsistent(model);
	});

	it('also when something other than the model refuses', () => {
		const model = family();
		const before = observe(model);
		const boom = new Error('boom');
		const idFor = () => {
			throw boom;
		};
		expect(
			thrown(() =>
				applyBatch(model, [{ kind: 'delete_element', id: 'b' }, node('tmp_x')], { idFor })
			)
		).toBe(boom);
		expect(observe(model)).toEqual(before);
		verifyConsistent(model);
	});
});
```

`engine/test/ops/rewind.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	applyBatch,
	Model,
	parseJson,
	rewind,
	shuffleAdjacency,
	verifyConsistent,
	type ModelOp
} from '../../src/index.ts';
import { observe, seededRandom } from '../golden/model-steps.ts';
import { family, nodeMetamodel } from '../model/fixtures.ts';

/** Lands `ops`, rewinds them, and expects the model to stand exactly where it stood. */
function landAndRewind(model: Model, ops: ModelOp[]): void {
	const random = seededRandom(11);
	const before = observe(model);
	const result = applyBatch(model, ops);
	expect(observe(model)).not.toEqual(before);
	verifyConsistent(model);
	shuffleAdjacency(model, random);
	rewind(model, result);
	expect(observe(model)).toEqual(before);
	verifyConsistent(model);
}

describe('rewinding a landed batch', () => {
	it('undoes property writes where the records are, revs included', () => {
		const model = family();
		const a = model.getElement('a');
		landAndRewind(model, [
			{ kind: 'update_element', id: 'a', properties_patch: { name: null, peer: 'c' } },
			{ kind: 'update_element', id: 'a', properties_patch: { name: 'again' } }
		]);
		expect(model.getElement('a')).toBe(a);
		expect(a.rev).toBe(1);
	});

	it('puts a cascade back in its place: elements, relationships, owners', () => {
		const model = family();
		landAndRewind(model, [{ kind: 'delete_element', id: 'a' }]);
		expect([...model.elements()].map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
		expect([...model.relationships()].map((r) => r.id)).toEqual(['a-b', 'b-d', 'a-c']);
		expect(model.containerOf('d')).toBe('b');
	});

	it('removes what the batch created, entities created over a deleted id included', () => {
		const model = family();
		landAndRewind(model, [
			{ kind: 'delete_relationship', id: 'a-c' },
			{
				kind: 'create_relationship',
				temp_id: 'tmp_r',
				type_name: 'Refers',
				source_id: 'c',
				target_id: 'a',
				id: 'a-c'
			},
			{ kind: 'delete_element', id: 'd' },
			{ kind: 'create_element', temp_id: 'tmp_d', type_name: 'Node', id: 'd' },
			{
				kind: 'create_relationship',
				temp_id: 'tmp_s',
				type_name: 'Contains',
				source_id: 'tmp_d',
				target_id: 'c'
			}
		]);
		expect(model.getRelationship('a-c').source.id).toBe('a');
	});

	it('brings back an element whose type the metamodel does not have', () => {
		const model = new Model(nodeMetamodel());
		model.loadElement(parseJson('{"id":"old","type_name":"Gone","properties":{"k":1},"rev":5}'));
		model.loadElement(parseJson('{"id":"n","type_name":"Node","properties":{},"rev":0}'));
		model.loadRelationship(
			parseJson(
				'{"id":"r","type_name":"AlsoGone","source_id":"old","target_id":"n","properties":{},"rev":2}'
			)
		);
		model.rebuildIndexes();
		landAndRewind(model, [{ kind: 'delete_element', id: 'old' }]);
	});

	it('rewinds batch after batch, newest first', () => {
		const model = family();
		const before = observe(model);
		const first = applyBatch(model, [
			{ kind: 'create_element', temp_id: 'tmp_e', type_name: 'Node', properties: { name: 'E' } },
			{
				kind: 'create_relationship',
				temp_id: 'tmp_r',
				type_name: 'Contains',
				source_id: 'd',
				target_id: 'tmp_e'
			}
		]);
		const second = applyBatch(model, [
			{ kind: 'update_element', id: 'tmp_e', properties_patch: { peer: 'a' } },
			{ kind: 'delete_element', id: 'b' }
		]);
		expect(model.findElement('tmp_e')).toBeUndefined();
		rewind(model, second);
		expect(model.containerOf('tmp_e')).toBe('d');
		rewind(model, first);
		expect(observe(model)).toEqual(before);
		verifyConsistent(model);
	});
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pixi run engine-test`
Expected: FAIL — 20 tests in the five new files, 140 passed: `(0 , applyBatch) is not a function`, and `Right-hand side of 'instanceof' is not an object` where the runner's catch meets the missing `OpError`. The older scenarios still pass through the rewritten runner.

- [ ] **Step 4: Write the applier**

`engine/src/ops/types.ts`:

```ts
import type { Props } from '../model/records.ts';

/**
 * The model family of the ops protocol, in the server's wire shapes. A create
 * op names its entity by a provisional `temp_id`; `id` asks for a given final
 * id instead of a minted one. A patch is a merge patch one level deep: `null`
 * removes the key, anything else replaces its value.
 */
export type CreateElementOp = {
	kind: 'create_element';
	temp_id: string;
	type_name: string;
	properties?: Props;
	id?: string | null;
};

export type UpdateElementOp = { kind: 'update_element'; id: string; properties_patch: Props };

export type DeleteElementOp = { kind: 'delete_element'; id: string };

export type CreateRelationshipOp = {
	kind: 'create_relationship';
	temp_id: string;
	type_name: string;
	source_id: string;
	target_id: string;
	properties?: Props;
	id?: string | null;
};

export type UpdateRelationshipOp = {
	kind: 'update_relationship';
	id: string;
	properties_patch: Props;
};

export type DeleteRelationshipOp = { kind: 'delete_relationship'; id: string };

export type ModelOp =
	| CreateElementOp
	| UpdateElementOp
	| DeleteElementOp
	| CreateRelationshipOp
	| UpdateRelationshipOp
	| DeleteRelationshipOp;
```

`engine/src/ops/errors.ts`:

```ts
/**
 * A refused op batch. `status` speaks the HTTP vocabulary callers already
 * branch on; `detail` is the server's text for the same refusal.
 */
export class OpError extends Error {
	readonly status: number;
	readonly detail: string;

	constructor(status: number, detail: string) {
		super(detail);
		this.name = 'OpError';
		this.status = status;
		this.detail = detail;
	}
}
```

`engine/src/ops/result.ts`:

```ts
import type { ElementRec, Props, RelRec } from '../model/records.ts';
import type { ModelOp } from './types.ts';

/** An element as it stood, its place in state order included. `props` is a copy of the bag, not of the values. */
export type ElementImage = {
	id: string;
	typeName: string;
	props: Props;
	rev: number;
	ord: number;
};

export type RelImage = ElementImage & { sourceId: string; targetId: string };

export function elementImage(element: ElementRec): ElementImage {
	return {
		id: element.id,
		typeName: element.typeName,
		props: { ...element.props },
		rev: element.rev,
		ord: element.ord
	};
}

export function relImage(rel: RelRec): RelImage {
	return {
		id: rel.id,
		typeName: rel.typeName,
		props: { ...rel.props },
		rev: rel.rev,
		ord: rel.ord,
		sourceId: rel.source.id,
		targetId: rel.target.id
	};
}

/**
 * Everything one batch application produced. The four id sets are in
 * first-touch order and the changed and deleted ones stay disjoint: deleting
 * an entity takes it out of the changed set, creating it again takes it out of
 * the deleted set.
 */
export class BatchResult {
	/** Temp id → the id the entity was created under. */
	readonly idMap = new Map<string, string>();
	/** One unit per completed mutation, in application order. A unit's own order matters. */
	readonly inverseUnits: ModelOp[][] = [];
	readonly changedElementIds = new Set<string>();
	readonly changedRelationshipIds = new Set<string>();
	readonly deletedElementIds = new Set<string>();
	readonly deletedRelationshipIds = new Set<string>();
	/**
	 * The state of every touched entity before its FIRST touch; `null` when it
	 * did not exist. Every id in the four sets has an entry.
	 */
	readonly beforeElements = new Map<string, ElementImage | null>();
	readonly beforeRelationships = new Map<string, RelImage | null>();

	/** The flat inverse batch: applied front to back, in restore mode, it undoes this one. */
	inverseOps(): ModelOp[] {
		return this.inverseUnits.toReversed().flat();
	}

	markElementChanged(id: string): void {
		this.changedElementIds.add(id);
		this.deletedElementIds.delete(id);
	}

	markRelationshipChanged(id: string): void {
		this.changedRelationshipIds.add(id);
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
	noteElementBefore(id: string, element: ElementRec | null): void {
		if (!this.beforeElements.has(id)) {
			this.beforeElements.set(id, element === null ? null : elementImage(element));
		}
	}

	noteRelationshipBefore(id: string, rel: RelRec | null): void {
		if (!this.beforeRelationships.has(id)) {
			this.beforeRelationships.set(id, rel === null ? null : relImage(rel));
		}
	}
}
```

`engine/src/ops/resolve.ts`:

```ts
import { getProp, setProp, type Props } from '../model/records.ts';
import type { Value } from '../value/types.ts';

/** A string naming a mapped temp id becomes its id, in lists too; anything else stays as it is. */
export function resolveValue(value: Value, idMap: ReadonlyMap<string, string>): Value {
	if (typeof value === 'string') return idMap.get(value) ?? value;
	if (Array.isArray(value)) return value.map((item) => resolveValue(item, idMap));
	return value;
}

/** A new bag, keys in the same order, values resolved. */
export function resolveProps(props: Props | undefined, idMap: ReadonlyMap<string, string>): Props {
	const out: Props = {};
	if (props === undefined) return out;
	for (const key of Object.keys(props)) {
		setProp(out, key, resolveValue(getProp(props, key)!, idMap));
	}
	return out;
}
```

`engine/src/ops/rewind.ts`:

```ts
import type { Model } from '../model/model.ts';
import type { BatchResult } from './result.ts';

/**
 * Puts back every entity a batch touched exactly as its before-image has it:
 * properties, `rev` and place in state order. The batch must be the newest
 * change still applied to the model.
 *
 * A record that outlived the batch still carries the `ord` of its image — a
 * record created again under the same id never does, creation always takes a
 * new one — and is rewritten where it is. Whatever else the batch left under a
 * touched id goes, relationships first; then what is missing comes back,
 * elements first.
 */
export function rewind(model: Model, result: BatchResult): void {
	for (const [id, image] of result.beforeRelationships) {
		const rel = model.findRelationship(id);
		if (rel === undefined) continue;
		if (image !== null && rel.ord === image.ord) {
			model.overwrite(rel, { ...image.props }, image.rev);
		} else {
			model.disconnect(id);
		}
	}
	for (const [id, image] of result.beforeElements) {
		const element = model.findElement(id);
		if (element === undefined) continue;
		if (image !== null && element.ord === image.ord) {
			model.overwrite(element, { ...image.props }, image.rev);
		} else {
			model.deleteElement(id);
		}
	}
	for (const [id, image] of result.beforeElements) {
		if (image !== null && model.findElement(id) === undefined) {
			model.insertElement(id, image.typeName, { ...image.props }, image.rev, image.ord);
		}
	}
	for (const [id, image] of result.beforeRelationships) {
		if (image !== null && model.findRelationship(id) === undefined) {
			model.insertRelationship(
				id,
				image.typeName,
				image.sourceId,
				image.targetId,
				{ ...image.props },
				image.rev,
				image.ord
			);
		}
	}
}
```

`engine/src/ops/apply.ts`:

```ts
import { ModelError } from '../model/errors.ts';
import { findArrayIndexKey, TEMP_ID_PREFIX } from '../model/load.ts';
import type { Model } from '../model/model.ts';
import { getProp, setProp, type ElementRec, type Props, type RelRec } from '../model/records.ts';
import { cmpCodePoint } from '../value/compare.ts';
import { pyRepr } from '../value/repr.ts';
import { OpError } from './errors.ts';
import { resolveProps } from './resolve.ts';
import { BatchResult } from './result.ts';
import { rewind } from './rewind.ts';
import type { CreateElementOp, CreateRelationshipOp, ModelOp } from './types.ts';

export type ApplyOptions = {
	/** A create op whose `temp_id` lacks the temp prefix names the exact id to reinstate. */
	restore?: boolean;
	/**
	 * The id of an entity created under a temp id. The identity when absent: a
	 * staged entity lives under its temp id until the server mints the real one.
	 */
	idFor?: (tempId: string) => string;
};

/** A JavaScript object cannot keep such a key in insertion order, so no op may carry one. */
function refuseIndexKeys(props: Props | undefined): void {
	const indexKey = props === undefined ? null : findArrayIndexKey(props);
	if (indexKey !== null) {
		throw new ModelError(
			'value',
			`Property key ${pyRepr(indexKey)} is an array index, ` +
				'which cannot keep its place in insertion order'
		);
	}
}

/** Unknown keys are refused up front, so that a patch never fails half applied. */
function checkPatchKeys(valid: ReadonlySet<string>, typeName: string, patch: Props): void {
	for (const key of Object.keys(patch)) {
		if (!valid.has(key)) {
			throw new ModelError('key', `${pyRepr(typeName)} has no property ${pyRepr(key)}`);
		}
	}
}

/** The replayed journal branches on the prefix, so a final id must never carry it. */
function rejectReservedHint(hint: string): void {
	if (hint.startsWith(TEMP_ID_PREFIX)) {
		throw new ModelError(
			'value',
			`id hint ${pyRepr(hint)} must not use the reserved ${pyRepr(TEMP_ID_PREFIX)} prefix`
		);
	}
}

/** The final id of a create op, by the prefix of its `temp_id`: hinted, minted, or reinstated. */
function createdId(
	op: CreateElementOp | CreateRelationshipOp,
	options: ApplyOptions
): { id: string; temp: boolean } {
	if (op.temp_id.startsWith(TEMP_ID_PREFIX)) {
		if (op.id === undefined || op.id === null) {
			return { id: options.idFor ? options.idFor(op.temp_id) : op.temp_id, temp: true };
		}
		rejectReservedHint(op.id);
		return { id: op.id, temp: true };
	}
	if (options.restore) return { id: op.temp_id, temp: false };
	throw new ModelError(
		'value',
		`${op.kind} temp_id ${pyRepr(op.temp_id)} must start with ${pyRepr(TEMP_ID_PREFIX)}`
	);
}

/**
 * The elements `deleteElement` would remove, the element first. Walked from a
 * stack, children by sorted relationship id: the order is part of the result.
 */
function containmentClosure(model: Model, elementId: string): ElementRec[] {
	const root = model.getElement(elementId);
	const order = [root];
	const seen = new Set([root]);
	const stack = [root];
	while (stack.length > 0) {
		const element = stack.pop()!;
		const contained = element.out
			.filter((rel) => model.metamodel.isContainment(rel.typeName))
			.sort((a, b) => cmpCodePoint(a.id, b.id));
		for (const rel of contained) {
			if (seen.has(rel.target)) continue;
			seen.add(rel.target);
			order.push(rel.target);
			stack.push(rel.target);
		}
	}
	return order;
}

const byId = (a: RelRec, b: RelRec) => cmpCodePoint(a.id, b.id);

function applyPatch(model: Model, target: ElementRec | RelRec, patch: Props): Props {
	// The inverse restores each prior value, and removes a key that was not there.
	const inverse: Props = {};
	for (const key of Object.keys(patch)) setProp(inverse, key, getProp(target.props, key) ?? null);
	for (const key of Object.keys(patch)) {
		const value = getProp(patch, key)!;
		if (value === null) model.deleteProperty(target, key);
		else model.setProperty(target, key, value);
	}
	return inverse;
}

/**
 * Applies one op, recording its inverse unit and what it touched. A unit is
 * recorded only for a mutation that happened, and a create's before its
 * properties are set, so whatever fails midway is covered by what is on record.
 */
function applyOne(model: Model, op: ModelOp, res: BatchResult, options: ApplyOptions): void {
	const resolve = (id: string) => res.idMap.get(id) ?? id;
	switch (op.kind) {
		case 'create_element': {
			refuseIndexKeys(op.properties);
			const props = resolveProps(op.properties, res.idMap);
			const { id, temp } = createdId(op, options);
			const element = model.createElement(op.type_name, id);
			if (temp) res.idMap.set(op.temp_id, element.id);
			res.noteElementBefore(element.id, null);
			res.inverseUnits.push([{ kind: 'delete_element', id: element.id }]);
			for (const key of Object.keys(props)) model.setProperty(element, key, getProp(props, key)!);
			res.markElementChanged(element.id);
			return;
		}
		case 'update_element': {
			const id = resolve(op.id);
			const element = model.getElement(id);
			res.noteElementBefore(id, element);
			refuseIndexKeys(op.properties_patch);
			const patch = resolveProps(op.properties_patch, res.idMap);
			const valid = model.metamodel.effectiveElementPropertyNames(element.typeName);
			checkPatchKeys(valid, element.typeName, patch);
			const inverse = applyPatch(model, element, patch);
			res.inverseUnits.push([{ kind: 'update_element', id, properties_patch: inverse }]);
			res.markElementChanged(id);
			return;
		}
		case 'delete_element': {
			const id = resolve(op.id);
			// The cascade is read before it happens: the containment closure, and
			// per closure element its outgoing then its incoming relationships.
			const closure = containmentClosure(model, id);
			const removed = new Set<RelRec>();
			for (const element of closure) {
				for (const rel of element.out.toSorted(byId)) removed.add(rel);
				for (const rel of element.in.toSorted(byId)) removed.add(rel);
			}
			// Elements come back before relationships: ends must exist first.
			const unit: ModelOp[] = [];
			for (const element of closure) {
				res.noteElementBefore(element.id, element);
				unit.push({
					kind: 'create_element',
					temp_id: element.id,
					type_name: element.typeName,
					properties: { ...element.props },
					id: null
				});
			}
			for (const rel of removed) {
				res.noteRelationshipBefore(rel.id, rel);
				unit.push(recreate(rel));
			}
			model.deleteElement(id);
			res.inverseUnits.push(unit);
			for (const element of closure) res.markElementDeleted(element.id);
			for (const rel of removed) res.markRelationshipDeleted(rel.id);
			return;
		}
		case 'create_relationship': {
			const sourceId = resolve(op.source_id);
			const targetId = resolve(op.target_id);
			refuseIndexKeys(op.properties);
			const props = resolveProps(op.properties, res.idMap);
			const { id, temp } = createdId(op, options);
			const rel = model.connect(op.type_name, sourceId, targetId, id);
			if (temp) res.idMap.set(op.temp_id, rel.id);
			res.noteRelationshipBefore(rel.id, null);
			res.inverseUnits.push([{ kind: 'delete_relationship', id: rel.id }]);
			for (const key of Object.keys(props)) model.setProperty(rel, key, getProp(props, key)!);
			res.markRelationshipChanged(rel.id);
			return;
		}
		case 'update_relationship': {
			const id = resolve(op.id);
			const rel = model.getRelationship(id);
			res.noteRelationshipBefore(id, rel);
			refuseIndexKeys(op.properties_patch);
			const patch = resolveProps(op.properties_patch, res.idMap);
			const valid = model.metamodel.effectiveRelationshipPropertyNames(rel.typeName);
			checkPatchKeys(valid, rel.typeName, patch);
			const inverse = applyPatch(model, rel, patch);
			res.inverseUnits.push([{ kind: 'update_relationship', id, properties_patch: inverse }]);
			res.markRelationshipChanged(id);
			return;
		}
		case 'delete_relationship': {
			const id = resolve(op.id);
			const rel = model.getRelationship(id);
			res.noteRelationshipBefore(id, rel);
			const unit = [recreate(rel)];
			model.disconnect(id);
			res.inverseUnits.push(unit);
			res.markRelationshipDeleted(id);
			return;
		}
	}
}

function recreate(rel: RelRec): CreateRelationshipOp {
	return {
		kind: 'create_relationship',
		temp_id: rel.id,
		type_name: rel.typeName,
		source_id: rel.source.id,
		target_id: rel.target.id,
		properties: { ...rel.props },
		id: null
	};
}

/** The server strips the quotes off the ends of a missing-key message, whichever they are. */
function errorDetail(error: ModelError): string {
	if (error.kind !== 'key') return error.message;
	const text = pyRepr(error.message);
	let start = 0;
	let end = text.length;
	while (start < end && (text[start] === "'" || text[start] === '"')) start++;
	while (end > start && (text[end - 1] === "'" || text[end - 1] === '"')) end--;
	return text.slice(start, end);
}

/**
 * Applies `ops` to the model as one unit, with the server applier's semantics
 * and refusal texts. A refused batch leaves no trace: every touched entity is
 * put back as it was — `rev` and place in state order included — and an
 * `OpError` is thrown. Anything else that throws is a bug, and propagates
 * after the same rewind.
 */
export function applyBatch(
	model: Model,
	ops: readonly ModelOp[],
	options: ApplyOptions = {}
): BatchResult {
	const res = new BatchResult();
	try {
		for (const op of ops) applyOne(model, op, res, options);
	} catch (caught) {
		rewind(model, res);
		if (caught instanceof ModelError) throw new OpError(422, errorDetail(caught));
		throw caught;
	}
	return res;
}
```

In `engine/src/model/load.ts`, replace:

```ts
function findArrayIndexKey(value: Value): string | null {
```

with:

```ts
/** The first key, at any depth of `value`, that a JavaScript object would list out of insertion order. */
export function findArrayIndexKey(value: Value): string | null {
```

In `engine/src/index.ts`, replace:

```ts
export { ElementRec, RelRec, type Props } from './model/records.ts';
```

with:

```ts
export { ElementRec, RelRec, type Props } from './model/records.ts';
export { applyBatch, type ApplyOptions } from './ops/apply.ts';
export { OpError } from './ops/errors.ts';
export { BatchResult, type ElementImage, type RelImage } from './ops/result.ts';
export { rewind } from './ops/rewind.ts';
export type {
	CreateElementOp,
	CreateRelationshipOp,
	DeleteElementOp,
	DeleteRelationshipOp,
	ModelOp,
	UpdateElementOp,
	UpdateRelationshipOp
} from './ops/types.ts';
```

- [ ] **Step 5: Run the tests**

Run: `pixi run engine-test`
Expected: PASS — 160 tests in 31 files.

- [ ] **Step 6: See the fixtures bite**

In `engine/src/ops/apply.ts`, change `stack.pop()!` to `stack.shift()!` and run `pixi run engine-test`.
Expected: FAIL — the two tests of `test/ops/batches.golden.test.ts`, at step 22. Put `pop` back.

In `engine/src/ops/rewind.ts`, in the elements' loop, change `model.overwrite(element, { ...image.props }, image.rev)` to pass `element.rev` and run the suite again.
Expected: FAIL — 6 tests: the four golden tests of `batches` and `churn`, `puts back revs and the place of every entity a cascade took` and `undoes property writes where the records are, revs included`. Put `image.rev` back and see 160 pass.

- [ ] **Step 7: Tidy and commit**

Run: `pixi run engine-tidy`
Expected: nothing reformatted, no diagnostics.

Run: `LC_ALL=C grep -rnP '[^[:ascii:]]' tests/golden engine/test`
Expected: only the `café` line of `engine/test/value/serialize.test.ts`.

```bash
git add engine
git commit -m "Add the engine's op applier with an exact rollback"
```

---

### Task 4: The working copy

`WorkingCopy` owns a `Model`, the committed `rev` and digest, the staged batches with what each touched, and the committed image of every touched entity. Staging applies a batch in place under temp ids. Everything else is a rebase: rewind every staged batch newest first, change what is underneath — the staged list for `unstage`, committed state for `applyDelta` — and replay in order, parking what no longer applies. `applyDelta` follows CT-2's apply rule, reads the delta's entities with the bulk loader's checks before anything moves (finding 10), writes them through Task 2's methods in the order relationships out, elements out, elements in, relationships in, puts an entity that changed type or ends last (finding 2), folds the digest per entity (finding 9), and for the user's own commit drops the committed batches and rewrites their temp ids in the rest.

**Files:**
- Create: `engine/src/ops/remap.ts`, `engine/src/working/delta.ts`, `engine/src/working/working-copy.ts`
- Modify: `engine/src/index.ts`, `engine/test/golden/digest.ts`, `architecture/contracts.md`
- Test: `engine/test/working/helpers.ts`, `engine/test/working/working-copy.test.ts`, `engine/test/working/replica.golden.test.ts`

**Interfaces:**
- Consumes: Task 3's `applyBatch`, `rewind`, `BatchResult`, `elementImage`, `relImage`, `OpError`, `resolveProps`; Task 2's committed-state methods; `asEntity`, `requireStr`, `readProps`, `readRev` (`model/load.ts`); Task 1's `changed_elements` / `changed_relationships` / `deleted_*` in the fixtures.
- Produces:
  - `remapOp(op: ModelOp, idMap: ReadonlyMap<string, string>): ModelOp`.
  - `type Delta = { rev: number; prev_rev: number; state_digest: string; changed_elements: readonly Value[]; changed_relationships: readonly Value[]; deleted_element_ids: readonly string[]; deleted_relationship_ids: readonly string[] }`.
  - `class WorkingCopy { constructor(model: Model, committed: { rev: number; digest: string }, options: { entityHash: EntityHash }); readonly model; get rev(): number; get digest(): string; get diverged(): boolean; staged(): readonly StagedBatch[]; conflicts(): readonly Conflict[]; isStaged(id): boolean; committedElement(id): ElementImage | null; committedRelationship(id): RelImage | null; stage(ops): { batch: StagedBatch; changes: ChangeSet }; unstage(what: Unstage): ChangeSet; applyDelta(delta: Delta, own?: OwnCommit): { status: DeltaStatus; changes: ChangeSet } }`.
  - `type EntityHash = (id: string, rev: number) => bigint`; `type StagedBatch = { id: number; ops: readonly ModelOp[] }`; `type Conflict = { batch: StagedBatch; error: OpError }`; `type ChangeSet = { elementIds; relationshipIds; deletedElementIds; deletedRelationshipIds: string[] }`; `type Unstage = 'all' | { batch: number } | { entity: string; incident?: boolean }`; `type OwnCommit = { batchIds: readonly number[]; idMap: ReadonlyMap<string, string> }`; `type DeltaStatus = 'applied' | 'duplicate' | 'gap'`.
  - In tests (`test/working/helpers.ts`): `clone(model): Model`, `workingCopy(model, rev = 0): WorkingCopy`, `class Server { model; rev; commit(ops): { delta: Delta; result: BatchResult } }` — a second model that lands batches under `srv-N` ids and says what a delta says. `entityHash` is exported from `test/golden/digest.ts`.

- [ ] **Step 1: Write the helpers and the failing tests**

In `engine/test/golden/digest.ts`, replace:

```ts
function entityHash(id: string, rev: number): bigint {
```

with:

```ts
/** One entity's share of the state digest: the first 8 bytes of SHA-256 over `utf8(id) + 0x00 + ascii(rev)`. */
export function entityHash(id: string, rev: number): bigint {
```

In `engine/test/golden/digest.ts`, replace:

```ts
/**
 * The state digest of a model, on Node's SHA-256: the XOR over every entity of
 * the first 8 bytes of SHA-256 over `utf8(id) + 0x00 + ascii(rev)`.
 */
```

with:

```ts
/** The state digest of a model, on Node's SHA-256: the XOR of every entity's hash. */
```

`engine/test/working/helpers.ts`:

```ts
import {
	applyBatch,
	elementLine,
	Model,
	modelLines,
	parseJson,
	relationshipLine,
	WorkingCopy,
	type BatchResult,
	type Delta,
	type ModelOp
} from '../../src/index.ts';
import { entityHash, stateDigest } from '../golden/digest.ts';

/** A second model holding the same state, entity order and `rev`s included, loaded from its lines. */
export function clone(model: Model): Model {
	const copy = new Model(model.metamodel);
	const lines = modelLines(model);
	lines.slice(0, model.elementCount).forEach((line) => copy.loadElement(parseJson(line)));
	lines.slice(model.elementCount).forEach((line) => copy.loadRelationship(parseJson(line)));
	copy.rebuildIndexes();
	return copy;
}

export const workingCopy = (model: Model, rev = 0) =>
	new WorkingCopy(model, { rev, digest: stateDigest(model) }, { entityHash });

/**
 * Stands in for the server: one model that lands batches under ids of its own
 * minting and says what a commit delta says.
 */
export class Server {
	readonly model: Model;
	rev: number;
	private minted = 0;

	constructor(model: Model, rev = 0) {
		this.model = model;
		this.rev = rev;
	}

	commit(ops: readonly ModelOp[]): { delta: Delta; result: BatchResult } {
		const result = applyBatch(this.model, ops, { idFor: () => `srv-${++this.minted}` });
		const model = this.model;
		const delta: Delta = {
			rev: this.rev + 1,
			prev_rev: this.rev,
			state_digest: stateDigest(model),
			changed_elements: [...result.changedElementIds].map((id) =>
				parseJson(elementLine(model.getElement(id)))
			),
			changed_relationships: [...result.changedRelationshipIds].map((id) =>
				parseJson(relationshipLine(model.getRelationship(id)))
			),
			deleted_element_ids: [...result.deletedElementIds],
			deleted_relationship_ids: [...result.deletedRelationshipIds]
		};
		this.rev += 1;
		return { delta, result };
	}
}
```

`engine/test/working/working-copy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	OpError,
	parseJson,
	SnapshotError,
	verifyConsistent,
	type ModelOp
} from '../../src/index.ts';
import { stateDigest } from '../golden/digest.ts';
import { observe } from '../golden/model-steps.ts';
import { thrown } from '../golden/thrown.ts';
import { family } from '../model/fixtures.ts';
import { clone, Server, workingCopy } from './helpers.ts';

const rename = (id: string, name: string | null): ModelOp => ({
	kind: 'update_element',
	id,
	properties_patch: { name }
});

const node = (temp_id: string, name: string): ModelOp => ({
	kind: 'create_element',
	temp_id,
	type_name: 'Node',
	properties: { name }
});

const refers = (temp_id: string, source_id: string, target_id: string): ModelOp => ({
	kind: 'create_relationship',
	temp_id,
	type_name: 'Refers',
	source_id,
	target_id
});

describe('staging', () => {
	it('applies in place under temp ids, says what changed, and keeps committed state readable', () => {
		const wc = workingCopy(family());
		const { batch, changes } = wc.stage([
			rename('a', 'renamed'),
			node('tmp_e', 'E'),
			refers('tmp_r', 'tmp_e', 'a'),
			{ kind: 'delete_element', id: 'b' }
		]);
		expect(batch.id).toBe(1);
		expect(changes).toEqual({
			elementIds: ['a', 'tmp_e'],
			relationshipIds: ['tmp_r'],
			deletedElementIds: ['b', 'd'],
			// per deleted element, its outgoing relationships, then its incoming ones
			deletedRelationshipIds: ['b-d', 'a-b']
		});
		expect(wc.model.getElement('a').props).toEqual({ name: 'renamed' });
		expect(wc.committedElement('a')).toMatchObject({ props: { name: 'A' }, rev: 1 });
		expect(wc.committedElement('b')).toMatchObject({ props: { name: 'B' } });
		expect(wc.committedElement('tmp_e')).toBeNull();
		expect(wc.committedElement('c')).toMatchObject({ props: { name: 'C' } });
		expect(wc.committedRelationship('a-b')).toMatchObject({ sourceId: 'a', targetId: 'b' });
		expect(wc.committedRelationship('tmp_r')).toBeNull();
		expect(['a', 'tmp_e', 'a-b', 'c'].map((id) => wc.isStaged(id))).toEqual([
			true,
			true,
			true,
			false
		]);
		verifyConsistent(wc.model);
	});

	it('keeps the FIRST committed image when batches touch an entity again', () => {
		const wc = workingCopy(family());
		wc.stage([rename('a', 'one')]);
		wc.stage([rename('a', 'two')]);
		expect(wc.committedElement('a')).toMatchObject({ props: { name: 'A' }, rev: 1 });
	});

	it('throws on a refused batch and leaves no trace of it', () => {
		const wc = workingCopy(family());
		wc.stage([rename('a', 'kept')]);
		const before = observe(wc.model);
		const error = thrown(() => wc.stage([rename('c', 'lost'), rename('ghost', 'x')]));
		expect(error).toBeInstanceOf(OpError);
		expect(observe(wc.model)).toEqual(before);
		expect(wc.staged().map((batch) => batch.id)).toEqual([1]);
		expect(wc.isStaged('c')).toBe(false);
	});
});

describe('unstaging', () => {
	it('everything: the committed state is back byte for byte, order included', () => {
		const wc = workingCopy(family());
		const committed = observe(wc.model);
		wc.stage([{ kind: 'delete_element', id: 'a' }]);
		wc.stage([node('tmp_e', 'E'), refers('tmp_r', 'tmp_e', 'c')]);
		wc.stage([rename('c', null)]);
		const changes = wc.unstage('all');
		expect(observe(wc.model)).toEqual(committed);
		expect(wc.staged()).toEqual([]);
		expect(wc.isStaged('a')).toBe(false);
		expect(changes.elementIds.sort()).toEqual(['a', 'b', 'c', 'd']);
		expect(changes.deletedElementIds).toEqual(['tmp_e']);
		expect(changes.deletedRelationshipIds).toEqual(['tmp_r']);
		verifyConsistent(wc.model);
	});

	it('one batch: the rest replays on top, and a batch that needed it is parked, not dropped', () => {
		const wc = workingCopy(family());
		wc.stage([node('tmp_e', 'E')]);
		wc.stage([rename('c', 'still here')]);
		wc.stage([refers('tmp_r', 'tmp_e', 'c')]);
		wc.unstage({ batch: 1 });
		expect(wc.staged().map((batch) => batch.id)).toEqual([2]);
		expect(wc.model.getElement('c').props).toEqual({ name: 'still here' });
		expect(wc.model.findElement('tmp_e')).toBeUndefined();
		expect(wc.conflicts().map(({ batch, error }) => [batch.id, error.detail])).toEqual([
			[3, "No source element 'tmp_e"]
		]);
		wc.unstage({ batch: 3 });
		expect(wc.conflicts()).toEqual([]);
		verifyConsistent(wc.model);
	});

	it('one entity: the ops that target it go, the rest of their batches stay', () => {
		const wc = workingCopy(family());
		wc.stage([rename('a', 'x'), rename('c', 'y')]);
		wc.stage([rename('a', 'z')]);
		wc.unstage({ entity: 'a' });
		expect(wc.staged()).toEqual([{ id: 1, ops: [rename('c', 'y')] }]);
		expect(wc.model.getElement('a').props).toEqual({ name: 'A' });
		expect(wc.model.getElement('a').rev).toBe(1);
		expect(wc.unstage({ entity: 'nobody' })).toEqual({
			elementIds: [],
			relationshipIds: [],
			deletedElementIds: [],
			deletedRelationshipIds: []
		});
	});

	it('one entity with its incident relationship ops, whatever names their ends', () => {
		const wc = workingCopy(family());
		wc.stage([node('tmp_e', 'E'), refers('tmp_r', 'tmp_e', 'c')]);
		wc.stage([{ kind: 'delete_relationship', id: 'tmp_r' }]);
		wc.stage([{ kind: 'delete_relationship', id: 'a-c' }, rename('d', 'D2')]);
		wc.unstage({ entity: 'c', incident: true });
		expect(wc.staged()).toEqual([
			{ id: 1, ops: [node('tmp_e', 'E')] },
			{ id: 3, ops: [rename('d', 'D2')] }
		]);
		expect(wc.conflicts()).toEqual([]);
		expect(wc.model.findRelationship('a-c')).toBeDefined();
	});
});

describe('deltas', () => {
	it('rebases the staged batches over a peer commit, as if they had been staged after it', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		wc.stage([rename('a', 'mine'), node('tmp_e', 'E'), refers('tmp_r', 'tmp_e', 'c')]);
		const { delta } = server.commit([
			rename('c', 'theirs'),
			node('tmp_p', 'P'),
			{ kind: 'delete_element', id: 'd' }
		]);
		const { status, changes } = wc.applyDelta(delta);
		expect(status).toBe('applied');
		expect([wc.rev, wc.digest, wc.diverged]).toEqual([1, delta.state_digest, false]);
		expect(changes.elementIds.sort()).toEqual(['a', 'c', 'srv-1', 'tmp_e']);
		expect(changes.deletedElementIds).toEqual(['d']);

		const fresh = workingCopy(clone(server.model));
		fresh.stage(wc.staged()[0]!.ops);
		expect(observe(wc.model)).toEqual(observe(fresh.model));
		expect([...wc.model.elements()].map((e) => e.id)).toEqual(['a', 'b', 'c', 'srv-1', 'tmp_e']);
		expect(wc.committedElement('c')).toMatchObject({ props: { name: 'theirs' } });
		verifyConsistent(wc.model);
	});

	it('ignores a delta that is not newer and reports one that skips ahead', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		const first = server.commit([rename('a', 'one')]).delta;
		const second = server.commit([rename('a', 'two')]).delta;
		expect(wc.applyDelta(second).status).toBe('gap');
		expect(wc.rev).toBe(0);
		expect(wc.applyDelta(first).status).toBe('applied');
		expect(wc.applyDelta(first).status).toBe('duplicate');
		expect(wc.applyDelta(second).status).toBe('applied');
		expect(wc.model.getElement('a').props).toEqual({ name: 'two' });
		expect(wc.diverged).toBe(false);
	});

	it('own commit: drops the committed batches and rewrites their temp ids in what stays', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		const first = wc.stage([node('tmp_e', 'E')]).batch;
		const second = wc.stage([refers('tmp_r', 'tmp_e', 'c')]).batch;
		wc.stage([
			{ kind: 'update_element', id: 'tmp_e', properties_patch: { peer: 'tmp_e' } },
			{ kind: 'update_element', id: 'a', properties_patch: { peer: 'tmp_e' } },
			refers('tmp_s', 'a', 'tmp_e'),
			{ kind: 'delete_relationship', id: 'tmp_r' }
		]);
		const { delta, result } = server.commit([...first.ops, ...second.ops]);
		wc.applyDelta(delta, { batchIds: [first.id, second.id], idMap: result.idMap });
		expect(wc.staged()).toEqual([
			{
				id: 3,
				ops: [
					{ kind: 'update_element', id: 'srv-1', properties_patch: { peer: 'srv-1' } },
					{ kind: 'update_element', id: 'a', properties_patch: { peer: 'srv-1' } },
					{ ...refers('tmp_s', 'a', 'srv-1'), properties: {} },
					{ kind: 'delete_relationship', id: 'srv-2' }
				]
			}
		]);
		expect(wc.conflicts()).toEqual([]);
		expect(wc.model.findElement('tmp_e')).toBeUndefined();
		expect(wc.model.getElement('srv-1').props).toEqual({ name: 'E', peer: 'srv-1' });
		expect(wc.committedElement('srv-1')).toMatchObject({ props: { name: 'E' } });
		expect(wc.model.findRelationship('srv-2')).toBeUndefined();
		expect(wc.diverged).toBe(false);
		verifyConsistent(wc.model);
	});

	it('parks a staged batch the commit made impossible, and replays the others', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		wc.stage([rename('d', 'doomed')]);
		wc.stage([rename('c', 'fine')]);
		wc.applyDelta(server.commit([{ kind: 'delete_element', id: 'b' }]).delta);
		expect(wc.staged().map((batch) => batch.id)).toEqual([2]);
		expect(
			wc.conflicts().map(({ batch, error }) => [batch.id, error.status, error.detail])
		).toEqual([[1, 422, "No element with id 'd"]]);
		expect(wc.model.getElement('c').props).toEqual({ name: 'fine' });
		expect(wc.diverged).toBe(false);
	});

	it('puts an entity that comes back under other ends or another type last, as the server did', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
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
		wc.applyDelta(delta);
		expect(observe(wc.model)).toEqual(observe(server.model));
		expect([...wc.model.relationships()].map((r) => r.id)).toEqual(['b-d', 'a-c', 'a-b']);
		expect(wc.model.containerOf('b')).toBe('c');
		verifyConsistent(wc.model);
	});
});

describe('divergence', () => {
	it('is set when the digest after a delta is not the one the delta names', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		const { delta } = server.commit([rename('a', 'x')]);
		wc.applyDelta({ ...delta, state_digest: '0'.repeat(16) });
		expect(wc.diverged).toBe(true);
		expect(wc.digest).toBe(stateDigest(wc.model));
	});

	it('is set by a delta that does not fit the replica, and staged work survives', () => {
		const wc = workingCopy(family());
		wc.stage([rename('a', 'mine')]);
		const orphan = parseJson(
			'{"id":"r","type_name":"Refers","source_id":"nobody","target_id":"a","properties":{},"rev":0}'
		);
		wc.applyDelta({
			rev: 1,
			prev_rev: 0,
			state_digest: wc.digest,
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
		const wc = workingCopy(family());
		wc.stage([rename('a', 'mine')]);
		const before = observe(wc.model);
		const error = thrown(() =>
			wc.applyDelta({
				rev: 1,
				prev_rev: 0,
				state_digest: wc.digest,
				changed_elements: [
					parseJson('{"id":"a","type_name":"Node","properties":{"name":{"7":1}},"rev":2}')
				],
				changed_relationships: [],
				deleted_element_ids: [],
				deleted_relationship_ids: []
			})
		);
		expect(error).toBeInstanceOf(SnapshotError);
		expect((error as Error).message).toBe(
			"changed_elements[0]: property key '7' is an array index, which cannot keep its place in insertion order"
		);
		expect(observe(wc.model)).toEqual(before);
		expect([wc.rev, wc.diverged]).toEqual([0, false]);
	});
});
```

`engine/test/working/replica.golden.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	Metamodel,
	Model,
	parseJson,
	shuffleAdjacency,
	verifyConsistent,
	WorkingCopy
} from '../../src/index.ts';
import { entityHash } from '../golden/digest.ts';
import { loadFixture } from '../golden/load.ts';
import {
	observe,
	seededRandom,
	type BatchOutcome,
	type StepsFixture
} from '../golden/model-steps.ts';

/**
 * A replica that starts empty and is told of each landed batch only what a
 * commit delta says (whole changed entities, deleted ids, the digest) must
 * stand where the oracle stands, entity order included.
 */
function follow(name: string): void {
	const fixture = loadFixture<StepsFixture>(name);
	const model = new Model(Metamodel.fromJSON(fixture.metamodel));
	const replica = new WorkingCopy(model, { rev: 0, digest: '0'.repeat(16) }, { entityHash });
	const random = seededRandom(20260919);
	let expected = { digest: replica.digest, fingerprint: observe(model).fingerprint };
	fixture.steps.forEach((step, index) => {
		if (step.error !== null) return;
		const label = `step ${index}: ${step.do}`;
		const landed = step.result as BatchOutcome;
		if (!step.unchanged) expected = { digest: step.digest!, fingerprint: step.fingerprint! };
		shuffleAdjacency(model, random);
		const { status } = replica.applyDelta({
			rev: replica.rev + 1,
			prev_rev: replica.rev,
			state_digest: expected.digest,
			changed_elements: landed.changed_elements.map(parseJson),
			changed_relationships: landed.changed_relationships.map(parseJson),
			deleted_element_ids: landed.deleted_element_ids,
			deleted_relationship_ids: landed.deleted_relationship_ids
		});
		expect(status, label).toBe('applied');
		expect(replica.diverged, label).toBe(false);
		const seen = observe(model);
		if (step.state !== undefined) expect(seen.state, label).toEqual(step.state);
		expect(seen.digest, label).toBe(expected.digest);
		expect(seen.fingerprint, label).toBe(expected.fingerprint);
		verifyConsistent(model);
	});
}

describe('a replica fed only deltas stands where the oracle stands', () => {
	it('through every op kind, id hints, undo, a rewire and a change of type', () => {
		follow('ops_batches');
	});

	it('through a random walk of batches', () => {
		follow('ops_churn');
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pixi run engine-test`
Expected: FAIL — the 17 tests of `test/working/working-copy.test.ts` and `test/working/replica.golden.test.ts`, each with `WorkingCopy is not a constructor`; the other 160 pass.

- [ ] **Step 3: Write the working copy**

`engine/src/ops/remap.ts`:

```ts
import { resolveProps } from './resolve.ts';
import type { ModelOp } from './types.ts';

/**
 * The op with every reference to a mapped temp id rewritten — the ids it
 * targets, its ends, its property values. Its own `temp_id` is not a
 * reference, and stays.
 */
export function remapOp(op: ModelOp, idMap: ReadonlyMap<string, string>): ModelOp {
	const id = (value: string) => idMap.get(value) ?? value;
	switch (op.kind) {
		case 'create_element':
			return { ...op, properties: resolveProps(op.properties, idMap) };
		case 'create_relationship':
			return {
				...op,
				source_id: id(op.source_id),
				target_id: id(op.target_id),
				properties: resolveProps(op.properties, idMap)
			};
		case 'update_element':
		case 'update_relationship':
			return { ...op, id: id(op.id), properties_patch: resolveProps(op.properties_patch, idMap) };
		case 'delete_element':
		case 'delete_relationship':
			return { ...op, id: id(op.id) };
	}
}
```

`engine/src/working/delta.ts`:

```ts
import { SnapshotError } from '../model/errors.ts';
import { asEntity, readProps, readRev, requireStr } from '../model/load.ts';
import type { Props } from '../model/records.ts';
import type { Value } from '../value/types.ts';

/**
 * What a replica reads of a commit delta, in the wire's names. `changed_*`
 * hold whole entities as committed, in first-touch order; `deleted_*` name
 * every entity the commit removed, cascades included.
 */
export type Delta = {
	rev: number;
	prev_rev: number;
	state_digest: string;
	changed_elements: readonly Value[];
	changed_relationships: readonly Value[];
	deleted_element_ids: readonly string[];
	deleted_relationship_ids: readonly string[];
};

export type CommittedElement = { id: string; typeName: string; props: Props; rev: number };
export type CommittedRel = CommittedElement & { sourceId: string; targetId: string };

export type CommittedChange = {
	elements: CommittedElement[];
	relationships: CommittedRel[];
	deletedElementIds: readonly string[];
	deletedRelationshipIds: readonly string[];
};

function readElement(doc: Value, where: string): CommittedElement {
	const entity = asEntity(doc, where);
	return {
		id: requireStr(entity, 'id', where),
		typeName: requireStr(entity, 'type_name', where),
		props: readProps(entity, where),
		rev: readRev(entity, where)
	};
}

function readIds(ids: readonly string[], where: string): readonly string[] {
	ids.forEach((id, i) => {
		if (typeof id !== 'string') throw new SnapshotError(`${where}[${i}]: must be a string`);
	});
	return ids;
}

/**
 * The delta's entities, checked as the bulk loader checks a snapshot's, with
 * the same refusals. Reading happens before anything is applied, so a delta
 * the replica cannot hold leaves it untouched.
 */
export function readDelta(delta: Delta): CommittedChange {
	return {
		elements: delta.changed_elements.map((doc, i) => readElement(doc, `changed_elements[${i}]`)),
		relationships: delta.changed_relationships.map((doc, i) => {
			const where = `changed_relationships[${i}]`;
			const entity = asEntity(doc, where);
			return {
				...readElement(doc, where),
				sourceId: requireStr(entity, 'source_id', where),
				targetId: requireStr(entity, 'target_id', where)
			};
		}),
		deletedElementIds: readIds(delta.deleted_element_ids, 'deleted_element_ids'),
		deletedRelationshipIds: readIds(delta.deleted_relationship_ids, 'deleted_relationship_ids')
	};
}
```

`engine/src/working/working-copy.ts`:

```ts
import { ModelError } from '../model/errors.ts';
import type { Model } from '../model/model.ts';
import { applyBatch } from '../ops/apply.ts';
import { OpError } from '../ops/errors.ts';
import { remapOp } from '../ops/remap.ts';
import {
	elementImage,
	relImage,
	type BatchResult,
	type ElementImage,
	type RelImage
} from '../ops/result.ts';
import { rewind } from '../ops/rewind.ts';
import type { ModelOp } from '../ops/types.ts';
import { readDelta, type CommittedChange, type Delta } from './delta.ts';

/** The 64-bit hash of one `(id, rev)` pair that the state digest folds with XOR. */
export type EntityHash = (id: string, rev: number) => bigint;

export type WorkingCopyOptions = { entityHash: EntityHash };

export type StagedBatch = { readonly id: number; readonly ops: readonly ModelOp[] };

/** A staged batch that a change underneath it made impossible to apply. */
export type Conflict = { readonly batch: StagedBatch; readonly error: OpError };

/** The ids an operation may have changed, and the ids it left absent. */
export type ChangeSet = {
	elementIds: string[];
	relationshipIds: string[];
	deletedElementIds: string[];
	deletedRelationshipIds: string[];
};

/**
 * What to unstage: everything; one batch, staged or parked; or every staged op
 * that targets one entity — with `incident`, also every staged relationship op
 * with that entity at one end.
 */
export type Unstage = 'all' | { batch: number } | { entity: string; incident?: boolean };

/** The staged batches a delta committed, and the ids the server minted for their temp ids. */
export type OwnCommit = { batchIds: readonly number[]; idMap: ReadonlyMap<string, string> };

export type DeltaStatus = 'applied' | 'duplicate' | 'gap';

type Entry = { batch: StagedBatch; result: BatchResult };

class Touched {
	readonly elements = new Set<string>();
	readonly relationships = new Set<string>();

	add(result: BatchResult): void {
		for (const id of result.beforeElements.keys()) this.elements.add(id);
		for (const id of result.beforeRelationships.keys()) this.relationships.add(id);
	}

	/** Present now means changed, absent means deleted: over-reporting is harmless. */
	changeSet(model: Model): ChangeSet {
		const changes = emptyChangeSet();
		for (const id of this.elements) {
			(model.findElement(id) ? changes.elementIds : changes.deletedElementIds).push(id);
		}
		for (const id of this.relationships) {
			(model.findRelationship(id) ? changes.relationshipIds : changes.deletedRelationshipIds).push(
				id
			);
		}
		return changes;
	}
}

const emptyChangeSet = (): ChangeSet => ({
	elementIds: [],
	relationshipIds: [],
	deletedElementIds: [],
	deletedRelationshipIds: []
});

function touches(
	op: ModelOp,
	id: string,
	incident: boolean,
	endsOf: (relId: string) => readonly string[]
): boolean {
	switch (op.kind) {
		case 'create_element':
			return op.temp_id === id || op.id === id;
		case 'update_element':
		case 'delete_element':
			return op.id === id;
		case 'create_relationship':
			if (op.temp_id === id || op.id === id) return true;
			return incident && (op.source_id === id || op.target_id === id);
		case 'update_relationship':
		case 'delete_relationship':
			return op.id === id || (incident && endsOf(op.id).includes(id));
	}
}

/**
 * A replica of one project's model with the user's uncommitted edits applied
 * to it in place. Committed state moves only through `applyDelta`; edits are
 * staged as op batches, each remembered with what it touched. Every change
 * underneath the staged batches is a rebase: rewind them newest first, make
 * the change, replay them in order. A batch that no longer applies is parked
 * as a conflict, never dropped.
 *
 * Nothing else may write to `model` once it is handed over.
 */
export class WorkingCopy {
	readonly model: Model;

	private committedRev: number;
	private committedDigest: bigint;
	private hasDiverged = false;
	private entries: Entry[] = [];
	private parked: Conflict[] = [];
	private nextBatchId = 1;
	private readonly entityHash: EntityHash;
	// The first before-image of every entity a staged batch touched: its
	// committed state, `null` when it has none.
	private readonly committedElements = new Map<string, ElementImage | null>();
	private readonly committedRelationships = new Map<string, RelImage | null>();

	constructor(
		model: Model,
		committed: { rev: number; digest: string },
		options: WorkingCopyOptions
	) {
		this.model = model;
		this.committedRev = committed.rev;
		this.committedDigest = BigInt('0x' + committed.digest);
		this.entityHash = options.entityHash;
	}

	// -- reading -------------------------------------------------------------

	/** The project revision the committed state stands at. */
	get rev(): number {
		return this.committedRev;
	}

	/** The state digest of the committed state, as the wire carries it. */
	get digest(): string {
		return this.committedDigest.toString(16).padStart(16, '0');
	}

	/** Set once the committed state is known to differ from the server's: discard the replica. */
	get diverged(): boolean {
		return this.hasDiverged;
	}

	staged(): readonly StagedBatch[] {
		return this.entries.map((entry) => entry.batch);
	}

	conflicts(): readonly Conflict[] {
		return this.parked;
	}

	isStaged(id: string): boolean {
		return this.committedElements.has(id) || this.committedRelationships.has(id);
	}

	/** The element as committed, whatever is staged on top; `null` when it has no committed state. */
	committedElement(id: string): ElementImage | null {
		const image = this.committedElements.get(id);
		if (image !== undefined) return image;
		const element = this.model.findElement(id);
		return element === undefined ? null : elementImage(element);
	}

	committedRelationship(id: string): RelImage | null {
		const image = this.committedRelationships.get(id);
		if (image !== undefined) return image;
		const rel = this.model.findRelationship(id);
		return rel === undefined ? null : relImage(rel);
	}

	// -- staging -------------------------------------------------------------

	/**
	 * Applies `ops` on top of everything staged. Created entities live under
	 * their temp ids. A refused batch throws `OpError` and leaves no trace.
	 */
	stage(ops: readonly ModelOp[]): { batch: StagedBatch; changes: ChangeSet } {
		const result = applyBatch(this.model, ops);
		const batch = { id: this.nextBatchId++, ops };
		this.keep({ batch, result });
		return {
			batch,
			changes: {
				elementIds: [...result.changedElementIds],
				relationshipIds: [...result.changedRelationshipIds],
				deletedElementIds: [...result.deletedElementIds],
				deletedRelationshipIds: [...result.deletedRelationshipIds]
			}
		};
	}

	unstage(what: Unstage): ChangeSet {
		if (what === 'all') {
			this.parked = [];
			return this.rebase(() => (this.entries = []));
		}
		if ('batch' in what) {
			this.parked = this.parked.filter((conflict) => conflict.batch.id !== what.batch);
			if (!this.entries.some((entry) => entry.batch.id === what.batch)) return emptyChangeSet();
			return this.rebase(() => {
				this.entries = this.entries.filter((entry) => entry.batch.id !== what.batch);
			});
		}
		// Ends are looked up while the staged state still stands.
		const kept = this.entries.map((entry) => ({
			batch: entry.batch,
			ops: entry.batch.ops.filter(
				(op) => !touches(op, what.entity, what.incident === true, (id) => this.endsOf(id))
			)
		}));
		if (kept.every(({ batch, ops }) => ops.length === batch.ops.length)) return emptyChangeSet();
		return this.rebase(() => {
			this.entries = this.entries.flatMap((entry, i) => {
				const ops = kept[i]!.ops;
				return ops.length === 0 ? [] : [{ ...entry, batch: { id: entry.batch.id, ops } }];
			});
		});
	}

	/** The ends of a relationship, staged or committed or deleted by a staged batch. */
	private endsOf(relId: string): readonly string[] {
		const rel = this.model.findRelationship(relId);
		if (rel !== undefined) return [rel.source.id, rel.target.id];
		for (const entry of this.entries) {
			const image = entry.result.beforeRelationships.get(relId);
			if (image) return [image.sourceId, image.targetId];
		}
		return [];
	}

	// -- committed state -----------------------------------------------------

	/**
	 * Takes a commit delta. It applies when it continues from this replica's
	 * revision; one that is not newer is a duplicate; anything else is a gap,
	 * and the caller fetches the tail. For the user's own commit, `own` names
	 * the staged batches it carried: they are dropped, and the ids the server
	 * minted replace their temp ids in what stays staged.
	 *
	 * A delta the replica cannot hold throws `SnapshotError` before anything
	 * moves. One that does not fit the replica, or whose digest disagrees
	 * afterwards, sets `diverged`.
	 */
	applyDelta(delta: Delta, own?: OwnCommit): { status: DeltaStatus; changes: ChangeSet } {
		if (delta.prev_rev !== this.committedRev) {
			const status = delta.rev <= this.committedRev ? 'duplicate' : 'gap';
			return { status, changes: emptyChangeSet() };
		}
		const change = readDelta(delta);
		const changes = this.rebase((touched) => {
			try {
				this.commit(change, touched);
			} catch (caught) {
				if (!(caught instanceof ModelError)) throw caught;
				this.hasDiverged = true;
			}
			if (own !== undefined) this.adopt(own);
		});
		this.committedRev = delta.rev;
		if (this.digest !== delta.state_digest) this.hasDiverged = true;
		return { status: 'applied', changes };
	}

	/**
	 * Writes committed state, the staged batches being rewound: relationships
	 * out, elements out, elements in, relationships in. A record keeps its
	 * identity and its place; a new entity goes last. An entity that comes back
	 * under another type or other ends was deleted and created again within the
	 * commit, which put it last on the server: so it is here.
	 */
	private commit(change: CommittedChange, touched: Touched): void {
		const model = this.model;
		const fold = (id: string, rev: number) => {
			this.committedDigest ^= this.entityHash(id, rev);
		};
		const dropRelationship = (id: string) => {
			const rel = model.findRelationship(id);
			if (rel === undefined) return;
			fold(id, rel.rev);
			model.disconnect(id);
			touched.relationships.add(id);
		};
		const dropElement = (id: string) => {
			const element = model.findElement(id);
			if (element === undefined) return;
			// A consistent delta names every relationship of a deleted element.
			// What it does not name goes unfolded, and the digest tells.
			fold(id, element.rev);
			model.deleteElement(id);
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
					next.sourceId,
					next.targetId,
					next.props,
					next.rev
				);
			}
			fold(next.id, next.rev);
		}
	}

	/** Drops the batches the server committed and rewrites their temp ids in the rest. */
	private adopt(own: OwnCommit): void {
		const committed = new Set(own.batchIds);
		const remap = (batch: StagedBatch): StagedBatch => ({
			id: batch.id,
			ops: batch.ops.map((op) => remapOp(op, own.idMap))
		});
		this.entries = this.entries
			.filter((entry) => !committed.has(entry.batch.id))
			.map((entry) => ({ ...entry, batch: remap(entry.batch) }));
		this.parked = this.parked
			.filter((conflict) => !committed.has(conflict.batch.id))
			.map((conflict) => ({ ...conflict, batch: remap(conflict.batch) }));
	}

	// -- rebase --------------------------------------------------------------

	private keep(entry: Entry): void {
		this.entries.push(entry);
		for (const [id, image] of entry.result.beforeElements) {
			if (!this.committedElements.has(id)) this.committedElements.set(id, image);
		}
		for (const [id, image] of entry.result.beforeRelationships) {
			if (!this.committedRelationships.has(id)) this.committedRelationships.set(id, image);
		}
	}

	/**
	 * Rewinds every staged batch, newest first; runs `change` on committed
	 * state, where it may also edit the staged list; replays what is left, in
	 * order, parking each batch that is refused.
	 */
	private rebase(change: (touched: Touched) => void): ChangeSet {
		const touched = new Touched();
		for (const entry of this.entries.toReversed()) {
			rewind(this.model, entry.result);
			touched.add(entry.result);
		}
		this.committedElements.clear();
		this.committedRelationships.clear();
		change(touched);
		const replay = this.entries;
		this.entries = [];
		for (const { batch } of replay) {
			try {
				const result = applyBatch(this.model, batch.ops);
				this.keep({ batch, result });
				touched.add(result);
			} catch (caught) {
				if (!(caught instanceof OpError)) throw caught;
				this.parked.push({ batch, error: caught });
			}
		}
		return touched.changeSet(this.model);
	}
}
```

In `engine/src/index.ts`, replace:

```ts
export { OpError } from './ops/errors.ts';
```

with:

```ts
export { OpError } from './ops/errors.ts';
export { remapOp } from './ops/remap.ts';
```

In `engine/src/index.ts`, replace:

```ts
export { PyFloat, type Value } from './value/types.ts';
```

with:

```ts
export { PyFloat, type Value } from './value/types.ts';
export type { Delta } from './working/delta.ts';
export {
	WorkingCopy,
	type ChangeSet,
	type Conflict,
	type DeltaStatus,
	type EntityHash,
	type OwnCommit,
	type StagedBatch,
	type Unstage,
	type WorkingCopyOptions
} from './working/working-copy.ts';
```

- [ ] **Step 4: Run the tests**

Run: `pixi run engine-test`
Expected: PASS — 177 tests in 33 files.

- [ ] **Step 5: See the rewire rule bite**

In `engine/src/working/working-copy.ts`, in `commit`, read `const ord = rel?.ord;` before `dropRelationship(next.id)` and pass `ord` as the last argument of `model.insertRelationship(…)`, so that a rewired relationship keeps its place. Run `pixi run engine-test`.
Expected: FAIL — `through every op kind, id hints, undo, a rewire and a change of type` at `step 24: batch`, and `puts an entity that comes back under other ends or another type last`. Undo the change and see 177 pass.

- [ ] **Step 6: Put the rules into the contracts**

In `architecture/contracts.md`, replace:

```markdown
- **Apply rule.** Apply a delta iff `prev_rev == replica.rev`. If `rev <= replica.rev`, drop it
  as a duplicate. Otherwise fetch the tail from `replica.rev`; if it is incomplete,
  re-bootstrap.
```

with:

```markdown
- **Apply rule.** Apply a delta iff `prev_rev == replica.rev`. If `rev <= replica.rev`, drop it
  as a duplicate. Otherwise fetch the tail from `replica.rev`; if it is incomplete,
  re-bootstrap.
- **Entities in a delta.** Apply in this order: relationships out, elements out, elements in,
  relationships in. A deleted id the replica does not hold is skipped (an entity created and
  deleted within one commit). A changed entity the replica holds keeps its record and its
  place; one it does not hold is appended. One that arrives under another type, or other ends,
  than the replica's record was deleted and created again within the commit — an apply-CR
  rewire does that — which put it last on the server: the replica removes it and appends it.
  A re-creation that changes neither cannot be told from an update and keeps its place
  (`BACKLOG.md`, `K-31`).
```

In `architecture/contracts.md`, replace:

```markdown
2. Staged ops use the op shapes of `src/data_rover/api/schemas.py`, are applied in place, and
   each records its inverse. The engine keeps the committed state of every entity a staged op
   touched, so committed reads need no rewind.
```

with:

```markdown
2. Staged ops use the op shapes of `src/data_rover/api/schemas.py`, are applied in place, and
   each records its inverse. The engine keeps the committed state of every entity a staged op
   touched, so committed reads need no rewind. A refused batch leaves no trace, and a rewind
   is exact: every touched entity goes back to its before-image — properties, `rev` and place
   in state order — which replaying inverse ops, as the server's rollback does, cannot give
   (`BACKLOG.md`, `K-30`).
```

- [ ] **Step 7: Tidy and commit**

Run: `pixi run engine-tidy`
Expected: nothing reformatted, no diagnostics.

Run: `LC_ALL=C grep -rnP '[^[:ascii:]]' tests/golden engine/test`
Expected: only the `café` line of `engine/test/value/serialize.test.ts`.

```bash
git add engine architecture/contracts.md
git commit -m "Add the engine's working copy"
```

---

### Task 5: Hold the working copy to its invariants

No oracle stages, rewinds or rebases, so these paths are held by invariants over seeded random batches (spec §9): each compares the whole observable state — entity lines in order, the index dump, the digest — with a replica that got there another way. Adjacency is shuffled between steps and the indexes are checked against a rebuild. The metamodel is the one inside the `ops_churn` fixture.

**Files:**
- Test: `engine/test/working/random-ops.ts`, `engine/test/working/invariants.test.ts`

**Interfaces:**
- Consumes: Task 4's `WorkingCopy` and `test/working/helpers.ts`; `observe`, `seededRandom` (`test/golden/model-steps.ts`); `shuffleAdjacency`, `verifyConsistent`.
- Produces: `class RandomOps { constructor(random: () => number, prefix = 'tmp_'); batch(model: Model): ModelOp[] }`. No production code.

- [ ] **Step 1: Write the generator and the invariants**

`engine/test/working/random-ops.ts`:

```ts
import type { Model, ModelOp, Value } from '../../src/index.ts';

const NAMES = ['', 'a', 'b', 'B', '\u{e9}', '\u{1f600}'];
const CODES: Value[] = [0, 1, true, 2, null];

/**
 * Random op batches against the metamodel of the `ops_churn` fixture (`Part`
 * and `Slot`; `Owns`, `Seats`, `Feeds`). Most batches land; some name an
 * entity that is gone by then, and a few are wrong on purpose.
 */
export class RandomOps {
	private temps = 0;
	private readonly random: () => number;
	private readonly prefix: string;

	constructor(random: () => number, prefix = 'tmp_') {
		this.random = random;
		this.prefix = prefix;
	}

	private pick<T>(items: readonly T[]): T {
		return items[Math.floor(this.random() * items.length)]!;
	}

	batch(model: Model): ModelOp[] {
		const parts = [...model.elements()].filter((e) => e.typeName === 'Part').map((e) => e.id);
		const slots = [...model.elements()].filter((e) => e.typeName === 'Slot').map((e) => e.id);
		const rels = [...model.relationships()].map((r) => r.id);
		const ops: ModelOp[] = [];
		const count = 1 + Math.floor(this.random() * 4);
		for (let i = 0; i < count; i++) {
			const kind = this.pick([
				...Array<string>(4).fill('create'),
				...Array<string>(6).fill('update'),
				...Array<string>(5).fill('connect'),
				'delete_rel',
				'delete',
				'delete',
				'stale'
			]);
			if (kind === 'create') {
				const temp_id = `${this.prefix}${++this.temps}`;
				const type_name = this.pick(['Part', 'Part', 'Slot']);
				(type_name === 'Part' ? parts : slots).push(temp_id);
				ops.push({ kind: 'create_element', temp_id, type_name, properties: { name: 'new' } });
			} else if (kind === 'update' && parts.length + slots.length > 0) {
				const id = this.pick([...parts, ...slots]);
				const some = this.pick([...parts, ...slots, 'dangling']);
				const patch: { [key: string]: Value } = { name: this.pick([...NAMES, null]) };
				if (slots.includes(id)) {
					patch['code'] = this.pick(CODES);
					patch['holder'] = some;
				} else {
					patch['peers'] = [some, this.pick([...parts, 'dangling'])];
				}
				ops.push({ kind: 'update_element', id, properties_patch: patch });
			} else if (kind === 'connect' && parts.length > 0) {
				const type_name = this.pick(['Owns', 'Seats', 'Feeds']);
				const sources = type_name === 'Feeds' ? slots : parts;
				const targets = type_name === 'Owns' ? parts : slots;
				if (sources.length === 0 || targets.length === 0) continue;
				const temp_id = `${this.prefix}${++this.temps}`;
				rels.push(temp_id);
				ops.push({
					kind: 'create_relationship',
					temp_id,
					type_name,
					source_id: this.pick(sources),
					target_id: this.pick(targets)
				});
			} else if (kind === 'delete_rel' && rels.length > 0) {
				ops.push({ kind: 'delete_relationship', id: this.pick(rels) });
			} else if (kind === 'delete' && parts.length + slots.length > 0) {
				ops.push({ kind: 'delete_element', id: this.pick([...parts, ...slots]) });
			} else if (kind === 'stale') {
				ops.push({ kind: 'delete_element', id: 'gone' });
			}
		}
		return ops;
	}
}
```

`engine/test/working/invariants.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	Metamodel,
	Model,
	OpError,
	shuffleAdjacency,
	verifyConsistent,
	type ModelOp,
	type WorkingCopy
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { observe, seededRandom, type StepsFixture } from '../golden/model-steps.ts';
import { clone, Server, workingCopy } from './helpers.ts';
import { RandomOps } from './random-ops.ts';

const metamodel = Metamodel.fromJSON(loadFixture<StepsFixture>('ops_churn').metamodel);

/** A committed model grown by a server landing random batches. */
function grow(random: () => number, batches: number): Server {
	const server = new Server(new Model(metamodel));
	const ops = new RandomOps(random, 'tmp_grow');
	for (let i = 0; i < batches; i++) landSome(server, ops);
	return server;
}

/** Lands the next random batch the server accepts, and returns what it returns. */
function landSome(server: Server, ops: RandomOps) {
	for (;;) {
		try {
			return server.commit(ops.batch(server.model));
		} catch (caught) {
			if (!(caught instanceof OpError)) throw caught;
		}
	}
}

/** Stages `count` random batches; the refused ones leave no trace and are not counted. */
function stageSome(wc: WorkingCopy, ops: RandomOps, random: () => number, count: number): void {
	for (let staged = 0; staged < count;) {
		shuffleAdjacency(wc.model, random);
		try {
			wc.stage(ops.batch(wc.model));
			staged++;
		} catch (caught) {
			if (!(caught instanceof OpError)) throw caught;
		}
		verifyConsistent(wc.model);
	}
}

/** Stages each batch on a replica that never saw the others rebased; the refused ones are the conflicts. */
function restage(wc: WorkingCopy, batches: readonly (readonly ModelOp[])[]): number[] {
	const refused: number[] = [];
	batches.forEach((ops, i) => {
		try {
			wc.stage(ops);
		} catch (caught) {
			if (!(caught instanceof OpError)) throw caught;
			refused.push(i);
		}
	});
	return refused;
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

describe('working-copy invariants over seeded random batches', () => {
	it.each(SEEDS)(
		'seed %i: staging then unstaging everything leaves the committed state',
		(seed) => {
			const random = seededRandom(seed);
			const wc = workingCopy(grow(random, 30).model);
			const committed = observe(wc.model);
			stageSome(wc, new RandomOps(random), random, 25);
			expect(observe(wc.model)).not.toEqual(committed);
			wc.unstage('all');
			expect(observe(wc.model)).toEqual(committed);
			verifyConsistent(wc.model);
		}
	);

	it.each(SEEDS)('seed %i: unstaging one batch equals staging the others afresh', (seed) => {
		const random = seededRandom(seed);
		const committed = grow(random, 30).model;
		const wc = workingCopy(clone(committed));
		stageSome(wc, new RandomOps(random), random, 12);
		const batches = wc.staged();
		const victim = batches[Math.floor(random() * batches.length)]!;
		wc.unstage({ batch: victim.id });

		const fresh = workingCopy(clone(committed));
		const others = batches.filter((batch) => batch !== victim);
		const refused = restage(
			fresh,
			others.map((batch) => batch.ops)
		);
		expect(observe(wc.model)).toEqual(observe(fresh.model));
		expect(wc.conflicts().map((conflict) => conflict.batch.id)).toEqual(
			refused.map((i) => others[i]!.id)
		);
		verifyConsistent(wc.model);
	});

	it.each(SEEDS)('seed %i: a rebase over deltas equals staging on a fresh replica', (seed) => {
		const random = seededRandom(seed);
		const server = grow(random, 30);
		const wc = workingCopy(clone(server.model), server.rev);
		stageSome(wc, new RandomOps(random), random, 10);
		const batches = wc.staged();

		const peer = new RandomOps(random, 'tmp_peer');
		for (let i = 0; i < 5; i++) {
			shuffleAdjacency(wc.model, random);
			expect(wc.applyDelta(landSome(server, peer).delta).status).toBe('applied');
			verifyConsistent(wc.model);
		}
		expect(wc.diverged).toBe(false);

		// Conflicts are parked as they arise, and a parked batch is not retried:
		// a fresh replica must refuse the same batches, given the same survivors.
		const parked = new Set(wc.conflicts().map((conflict) => conflict.batch.id));
		const fresh = workingCopy(clone(server.model), server.rev);
		const survivors = batches.filter((batch) => !parked.has(batch.id));
		expect(
			restage(
				fresh,
				survivors.map((batch) => batch.ops)
			)
		).toEqual([]);
		expect(observe(wc.model)).toEqual(observe(fresh.model));
		expect(wc.digest).toBe(fresh.digest);
	});

	it.each(SEEDS)('seed %i: an own commit lands where the server landed it', (seed) => {
		const random = seededRandom(seed);
		const server = grow(random, 30);
		const wc = workingCopy(clone(server.model), server.rev);
		stageSome(wc, new RandomOps(random), random, 8);
		const batches = wc.staged();
		const cut = 1 + Math.floor(random() * (batches.length - 1));
		const sent = batches.slice(0, cut);

		const { delta, result } = server.commit(sent.flatMap((batch) => batch.ops));
		const { status } = wc.applyDelta(delta, {
			batchIds: sent.map((batch) => batch.id),
			idMap: result.idMap
		});
		expect(status).toBe('applied');
		expect(wc.diverged).toBe(false);
		expect(wc.conflicts()).toEqual([]);

		const rest = wc.staged();
		expect(rest.map((batch) => batch.id)).toEqual(batches.slice(cut).map((batch) => batch.id));
		const fresh = workingCopy(clone(server.model), server.rev);
		expect(
			restage(
				fresh,
				rest.map((batch) => batch.ops)
			)
		).toEqual([]);
		expect(observe(wc.model)).toEqual(observe(fresh.model));
		verifyConsistent(wc.model);
	});
});
```

- [ ] **Step 2: Run them**

Run: `pixi run engine-test`
Expected: PASS — 209 tests in 34 files. These tests describe code that exists, so they pass at once; the next step is what shows they can fail.

- [ ] **Step 3: See them bite**

In `engine/src/working/working-copy.ts`, in `rebase`, change `for (const entry of this.entries.toReversed())` to `for (const entry of this.entries)` — a rewind oldest first. Run `pixi run engine-test`.
Expected: FAIL — 35 tests: all 32 of `invariants.test.ts` and 3 of `working-copy.test.ts`. Undo the change.

In `adopt`, change `ops: batch.ops.map((op) => remapOp(op, own.idMap))` to `ops: batch.ops`. Run the suite.
Expected: FAIL — 8 tests: `an own commit lands where the server landed it` on 7 of the 8 seeds, and `own commit: drops the committed batches and rewrites their temp ids in what stays`. Undo the change and see 209 pass.

- [ ] **Step 4: Tidy and commit**

Run: `pixi run engine-tidy`
Expected: nothing reformatted, no diagnostics.

Run: `LC_ALL=C grep -rnP '[^[:ascii:]]' tests/golden engine/test`
Expected: only the `café` line of `engine/test/value/serialize.test.ts`.

```bash
git add engine
git commit -m "Hold the working copy to its invariants over random batches"
```

---

### Task 6: Run everything, document, update the status

**Files:**
- Modify: `CLAUDE.md`, `BACKLOG.md`, `architecture/program.md`

**Interfaces:**
- Consumes: everything above. Produces no code.

- [ ] **Step 1: Run everything**

Run: `pixi run dr-test`
Expected: core pytest 2,429 passed / 34 deselected; frontend vitest 2,492 passed; engine vitest 209 passed in 34 files.

Run: `pixi run dr-tidy`
Expected: no file changes, no diagnostics; `git status --short` prints nothing.

- [ ] **Step 2: Describe the applier and the working copy in `CLAUDE.md`, update the status and the backlog**

In `CLAUDE.md`, replace:

```markdown
Today it holds the **value layer, the metamodel and the record-graph store**; nothing in the frontend or the server imports it yet.
```

with:

```markdown
Today it holds the **value layer, the metamodel, the record-graph store, the op applier and the working copy**; nothing in the frontend or the server imports it yet.
```

In `CLAUDE.md`, replace:

```markdown
which a JavaScript object cannot keep in insertion order.
- **`src/debug/`**
```

with:

```markdown
which a JavaScript object cannot keep in insertion order. Committed state enters through `insertElement` / `insertRelationship` / `overwrite`, which check no type (a model may hold one its metamodel no longer has) and take `rev` as given instead of counting it.
- **`src/ops/`** — `applyBatch(model, ops, {restore, idFor})` is the port of `routes/ops.py::_apply_batch` for the six model ops, in the wire's shapes: temp ids resolved through `idMap` in ids, ends and property values (strings and lists, never inside a dict), `id` hints, restore mode, merge patches, the cascade read before it happens, first-touch changed/deleted sets kept disjoint, inverse units and `inverseOps()`. `idFor` decides a created entity's id and is the identity by default — a staged entity lives under its temp id. A refusal is an `OpError {status: 422, detail}` with the server's text, the quote-stripping of `_error_detail` included (`No element with id 'ghost`). Two deliberate differences from the server: an op carrying an array-index property key at any depth is refused, and a refused batch leaves NO trace — `rewind(model, result)` puts every touched entity back from its first-touch before-image (properties, `rev`, `ord`), where the server's `_rollback` replays inverse ops and leaves `rev` bumped and restored entities last (`K-30`). A record that outlived the batch still has the `ord` of its image and is rewritten in place; anything else under a touched id is removed and the image inserted at its old `ord`.
- **`src/working/`** — `WorkingCopy` owns a `Model`, the committed `rev` and state digest, the staged batches and the committed image of every entity they touched (`committedElement` / `committedRelationship`, `isStaged`). `stage(ops)` applies a batch in place; `unstage('all' | {batch} | {entity, incident?})` and `applyDelta(delta, own?)` are both a rebase — rewind every staged batch newest first, change committed state, replay in order — and a batch that no longer applies is parked in `conflicts()`, never dropped. `applyDelta` follows CT-2 (`applied` / `duplicate` / `gap`), reads the delta's entities with the bulk loader's checks before anything moves, writes them through the committed-state methods (an entity arriving under another type or other ends is removed and appended, as the server's dict did), folds the digest per entity and sets `diverged` on a mismatch or on a delta that does not fit; for the user's own commit it drops the committed batches and rewrites their temp ids in the rest (`remapOp`). The `(id, rev)` hash is injected (`entityHash`) until the engine has its own SHA-256. Every operation returns a change set.
- **`src/debug/`**
```

In `CLAUDE.md`, replace:

```markdown
`engine/test/golden/model-steps.ts` replays them, a second time with every uniqueness key forced into one bucket.
```

with:

```markdown
`engine/test/golden/model-steps.ts` replays them, a second time with every uniqueness key forced into one bucket. A `batch` step runs an op batch through `routes/ops.py::_apply_batch` on a deep copy of the oracle's model, kept only when the batch lands — the server's own rollback is not exact (`K-30`), and none of its drift may enter a fixture — and records the outcome, the first-touch before-images, the inverse ops and the delta a replica would be sent; `undo` runs an earlier batch's inverse ops in restore mode. `engine/test/working/replica.golden.test.ts` feeds a `WorkingCopy` those deltas alone and expects the oracle's state, entity order included; `ops_recreate` (an entity created again under its id, unchanged in type and ends) is kept out of it, because no delta can express that (`K-31`).
```

In `architecture/program.md`, replace:

```markdown
| A | Engine foundation | in progress — plans 1–2 of 4 landed (value layer, golden pipeline; Python snapshot v2 and digest, metamodel, store, indexes, mutation boundary) |
```

with:

```markdown
| A | Engine foundation | in progress — plans 1–3 of 4 landed (value layer, golden pipeline; Python snapshot v2 and digest, metamodel, store, indexes, mutation boundary; op applier, working copy) |
```

In `BACKLOG.md`, replace:

```markdown
A → F. A (engine foundation) is built as four plans; the first two — package, value layer and
golden-fixture pipeline; Python snapshot v2 and state digest, metamodel, record-graph store,
indexes and mutation boundary — have landed.
```

with:

```markdown
A → F. A (engine foundation) is built as four plans; the first three — package, value layer
and golden-fixture pipeline; Python snapshot v2 and state digest, metamodel, record-graph
store, indexes and mutation boundary; op applier and working copy — have landed.
```

In `BACKLOG.md`, replace:

```markdown
imported with one would open on the server and not in the browser. Fix: check the other
kind's ids in `_guard_relationship`; the file is outside the MR-3 freeze.
```

with:

```markdown
imported with one would open on the server and not in the browser. Fix: check the other
kind's ids in `_guard_relationship`; the file is outside the MR-3 freeze.

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

- [ ] **Step 3: Commit and bring the branch home**

```bash
git add CLAUDE.md BACKLOG.md architecture/program.md
git commit -m "Document the engine's op applier and working copy"
git switch engine-migration
git merge --ff-only feat/engine-ops
```

---

## After this plan

Plan 4 (snapshot reader, engine digest, benchmarks, closing docs) is written once this one has landed. What it inherits:

- `WorkingCopyOptions.entityHash` is required today. Plan 4's pure-TypeScript SHA-256 becomes its default, tested against `engine/test/golden/digest.ts` and the vectors of `tests/api/test_state_digest.py`; `openSnapshot` hands `WorkingCopy` the header's `rev` and `state_digest`, and `verifyDigest()` recomputes from the model.
- The benchmarks of spec §9 now have their subjects: a 1,000-op batch through `applyBatch`, a rebase with 100 staged ops, a delta apply. Known costs to look at first: a rewind that restores an old `ord` re-sorts the whole entity map on the next ordered iteration; `unstage({entity})` scans every staged op; `Touched` reports every touched id as changed.
- `K-30` and `K-31` are sub-project B's: the server's rollback must become exact before it serves the digest, and CT-2 needs a way to say "created again".
