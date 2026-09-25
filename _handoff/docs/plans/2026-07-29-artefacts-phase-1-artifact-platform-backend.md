# Artefacts Phase 1 — Artifact Platform (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Artifacts (navigations, tables, snippets) become first-class committable content: a kind registry, typed lock resources, artifact ops through `POST /commits`, a generalized conflict backstop, and a per-commit diff API.

**Architecture:** One journal, materialized heads (spec: `docs/superpowers/specs/2026-07-29-artefacts-revamp-design.md`). Artifact ops join the existing `OpIn` union and are applied to `ArtifactRow`s on the request's DB transaction — never to the in-memory model. The model applier (`routes/ops.py::_apply_one`) must NEVER receive an artifact op; a `split_ops` helper separates the families everywhere. Current state stays in `ArtifactRow.payload`; the `Commit` journal is read for history/diffs/undo only.

**Tech Stack:** Python 3.14, FastAPI, SQLAlchemy 2.0 (sync), pydantic v2, pytest (hermetic in-memory SQLite via `tests/api/conftest.py`).

## Global Constraints

- All commands go through pixi: tests `pixi run -e core-dev pytest <path> -v`, full suite `pixi run core-test`, lint `pixi run backend-lint` (ruff + mypy + pyright — ALL must pass), format `pixi run dr-tidy`.
- **Backend only.** Do not touch anything under `frontend/`. The frontend keeps using legacy `PUT /artifacts/{id}`; both paths must stay consistent (both bump `artifact_rev`).
- **No Alembic migration.** No DB schema changes in this plan (new op kinds ride the existing `Commit.ops` JSON).
- **Off-limits files** (STOP and report if you believe you must edit them): `src/data_rover/core/model/model.py`, `src/data_rover/core/metamodel/schema.py`, `src/data_rover/core/validation/*`, `src/data_rover/api/db_models.py`, `alembic/*`.
- **Never** add artifact-op branches to `routes/ops.py::_apply_one` — it stays model-only (its `assert_never` enforces this at type-check time once `ModelOpIn` exists).
- Preserve the dense-docstring style: new modules explain *why* invariants exist.
- Do not delete or weaken any existing test. If an existing test fails after your change, the change is wrong — fix the change, not the test.
- Every commit message follows the repo style (`feat(api): ...`, `test(api): ...`) and ends with the Co-Authored-By line from the repo instructions.

## Guardrail Protocol (applies to every task)

1. Write the failing test FIRST, run it, and confirm it fails for the expected reason (missing symbol / 404 / wrong status), not an import typo.
2. After implementation, run the task's named tests AND `pixi run -e core-dev pytest tests/api -q`. Expected: all pass.
3. Run `pixi run backend-lint`. Expected: zero errors. If pyright flags a missing union branch, that is the plan working as intended — add the branch it names (never silence with `# type: ignore`).
4. Commit at the end of every task. Never batch two tasks into one commit.
5. **CHECKPOINT tasks** (2, 5, 8, 9) additionally run `pixi run core-test`. If anything unrelated fails, STOP — do not proceed to the next task; report the failure.
6. If you are blocked, confused, or an instruction contradicts what you find in the code, STOP and report rather than improvising.

---

### Task 1: Artifact kind registry

Formalize the per-kind knowledge (`_PAYLOAD_ADAPTERS`, `_apply_derived_metadata`, entry-point headers) into one registry module, and add the dependency-extraction/ref-rewrite contract (declared now, consumed by the Phase 3 import/export plan).

**Files:**
- Create: `src/data_rover/api/artifact_kinds.py`
- Modify: `src/data_rover/api/routes/artifacts.py` (replace `_PAYLOAD_ADAPTERS`, `_apply_derived_metadata`, and the kind-branch in `_header`)
- Test: `tests/api/test_artifact_kinds.py`

**Interfaces:**
- Consumes: `NAVIGATION_ADAPTER`, `TABLE_ADAPTER`, `SNIPPET_ADAPTER`, `derive_entry_points` (all existing core imports currently in `routes/artifacts.py`), `ArtifactKind` from `..db_models`.
- Produces (used by Tasks 4, 5 and the Phase 3 plan):
  - `ArtifactKindSpec` dataclass: `kind: ArtifactKind`, `adapter: TypeAdapter[Any]`, `derive_metadata: Callable[[dict[str, Any]], None] | None`, `surfaces_entry_points: bool`, `extract_deps: Callable[[dict[str, Any]], set[str]]`, `rewrite_refs: Callable[[dict[str, Any], Mapping[str, str]], dict[str, Any]]`
  - `get_spec(kind: ArtifactKind) -> ArtifactKindSpec | None`
  - `extract_refs(payload: Any) -> set[str]` and `rewrite_refs(payload: Any, id_map: Mapping[str, str]) -> Any` (module-level generics, also the per-kind defaults)

- [ ] **Step 1: Write the failing tests**

```python
# tests/api/test_artifact_kinds.py
"""Registry contract tests: every registered kind must round-trip its adapter,
extract its artifact refs, and rewrite them under an id map. These pin the
generic `"ref"`-key walk against each schema so a schema change that moves
refs breaks HERE, not silently in export."""

from __future__ import annotations

from data_rover.api.artifact_kinds import extract_refs, get_spec, rewrite_refs
from data_rover.api.db_models import ArtifactKind

NAV_PAYLOAD = {
    "kind": "set_op",
    "op": "union",
    "operands": [
        {"ref": "nav-artifact-1"},
        {
            "definition": {
                "kind": "path",
                "start": {"kind": "scope", "types": ["Block"]},
                "steps": [{"kind": "script", "snippet": {"ref": "snip-artifact-1"}}],
            }
        },
    ],
}

TABLE_PAYLOAD = {
    "schema_version": 1,
    "row_source": {"kind": "navigation", "navigation": {"ref": "nav-artifact-2"}},
    "columns": [
        {"kind": "element"},
        {"kind": "navigation", "navigation": {"ref": "nav-artifact-1"}},
        {"kind": "script", "snippet": {"ref": "snip-artifact-1"}},
    ],
}

SNIPPET_PAYLOAD = {
    "schema_version": 1,
    "language": "python",
    "code": "def value(el):\n    return el.name\n",
}


def test_all_current_kinds_are_registered() -> None:
    for kind in (ArtifactKind.navigation, ArtifactKind.table, ArtifactKind.code_snippet):
        assert get_spec(kind) is not None
    assert get_spec(ArtifactKind.diagram) is None
    assert get_spec(ArtifactKind.diagram_kind) is None


def test_registered_adapters_validate_payloads() -> None:
    get_spec(ArtifactKind.navigation).adapter.validate_python(NAV_PAYLOAD)
    get_spec(ArtifactKind.table).adapter.validate_python(TABLE_PAYLOAD)
    get_spec(ArtifactKind.code_snippet).adapter.validate_python(SNIPPET_PAYLOAD)


def test_navigation_deps_cover_operand_and_snippet_refs() -> None:
    assert extract_refs(NAV_PAYLOAD) == {"nav-artifact-1", "snip-artifact-1"}


def test_table_deps_cover_row_source_columns_and_snippets() -> None:
    assert extract_refs(TABLE_PAYLOAD) == {
        "nav-artifact-1",
        "nav-artifact-2",
        "snip-artifact-1",
    }


def test_snippet_has_no_deps() -> None:
    assert extract_refs(SNIPPET_PAYLOAD) == set()


def test_rewrite_refs_remaps_known_and_keeps_unknown() -> None:
    out = rewrite_refs(TABLE_PAYLOAD, {"nav-artifact-1": "NEW-1"})
    assert out["columns"][1]["navigation"]["ref"] == "NEW-1"
    assert out["row_source"]["navigation"]["ref"] == "nav-artifact-2"  # untouched
    # original payload is never mutated
    assert TABLE_PAYLOAD["columns"][1]["navigation"]["ref"] == "nav-artifact-1"


def test_snippet_spec_derives_entry_points() -> None:
    payload = dict(SNIPPET_PAYLOAD)
    get_spec(ArtifactKind.code_snippet).derive_metadata(payload)
    assert "value" in payload["entry_points"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_artifact_kinds.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'data_rover.api.artifact_kinds'`

- [ ] **Step 3: Create the registry module**

```python
# src/data_rover/api/artifact_kinds.py
"""The artifact-kind registry — the ONE place per-kind knowledge lives.

Adding a kind = one `ArtifactKindSpec` entry (plus its schema module).
Everything else (`routes/artifacts.py` CRUD, artifact ops in Task 4, the
Phase 3 export closure) is generic over this registry. `diagram` /
`diagram_kind` stay unregistered on purpose: unregistered kinds 422 on
write, exactly as before.

Dependency extraction / ref rewriting use a generic walk: in every
registered payload schema an artifact reference is a dict entry under the
literal key ``"ref"`` (navigation ``Operand.ref``, table
``NavigationSource.ref``, ``SnippetSource.ref``). Keeping ONE walk keeps
``extract_deps`` and ``rewrite_refs`` in lockstep; the contract tests in
``tests/api/test_artifact_kinds.py`` pin the exact behavior per schema, so
a schema change that adds a differently-shaped reference fails there."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from pydantic import TypeAdapter

from data_rover.core.navigation.schema import NAVIGATION_ADAPTER
from data_rover.core.script.lint import derive_entry_points
from data_rover.core.script.schema import SNIPPET_ADAPTER
from data_rover.core.table.schema import TABLE_ADAPTER

from .db_models import ArtifactKind


def extract_refs(payload: Any) -> set[str]:
    """Every artifact id referenced by *payload* (see module docstring)."""
    out: set[str] = set()
    _walk(payload, out)
    return out


def _walk(node: Any, out: set[str]) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "ref" and isinstance(value, str):
                out.add(value)
            else:
                _walk(value, out)
    elif isinstance(node, list):
        for value in node:
            _walk(value, out)


def rewrite_refs(payload: Any, id_map: Mapping[str, str]) -> Any:
    """A structural copy of *payload* with every known ref remapped.

    Unknown refs pass through unchanged (tolerant-dangler stance); the input
    is never mutated."""
    if isinstance(payload, dict):
        return {
            key: (
                id_map.get(value, value)
                if key == "ref" and isinstance(value, str)
                else rewrite_refs(value, id_map)
            )
            for key, value in payload.items()
        }
    if isinstance(payload, list):
        return [rewrite_refs(value, id_map) for value in payload]
    return payload


def _derive_snippet_metadata(payload: dict[str, Any]) -> None:
    """entry_points is server-owned: recomputed from the code AST on every
    write, overwriting any client-supplied value (M1 contract)."""
    payload["entry_points"] = derive_entry_points(payload.get("code", ""))


@dataclass(frozen=True)
class ArtifactKindSpec:
    kind: ArtifactKind
    adapter: TypeAdapter[Any]
    #: recompute server-owned derived fields in-place; None = kind has none
    derive_metadata: Callable[[dict[str, Any]], None] | None = None
    #: surface payload["entry_points"] on list headers (snippets only today)
    surfaces_entry_points: bool = False
    extract_deps: Callable[[dict[str, Any]], set[str]] = field(default=extract_refs)
    rewrite_refs: Callable[[dict[str, Any], Mapping[str, str]], dict[str, Any]] = field(
        default=rewrite_refs
    )


_REGISTRY: dict[ArtifactKind, ArtifactKindSpec] = {
    ArtifactKind.navigation: ArtifactKindSpec(
        kind=ArtifactKind.navigation, adapter=NAVIGATION_ADAPTER
    ),
    ArtifactKind.table: ArtifactKindSpec(kind=ArtifactKind.table, adapter=TABLE_ADAPTER),
    ArtifactKind.code_snippet: ArtifactKindSpec(
        kind=ArtifactKind.code_snippet,
        adapter=SNIPPET_ADAPTER,
        derive_metadata=_derive_snippet_metadata,
        surfaces_entry_points=True,
    ),
}


def get_spec(kind: ArtifactKind) -> ArtifactKindSpec | None:
    return _REGISTRY.get(kind)
```

- [ ] **Step 4: Rewire `routes/artifacts.py` onto the registry**

In `src/data_rover/api/routes/artifacts.py`:
1. Delete the `_PAYLOAD_ADAPTERS` dict and its comment block; remove now-unused imports (`TypeAdapter` from pydantic stays only if still used; `derive_entry_points`, `TABLE_ADAPTER` etc. stay only if still referenced by the navigation-evaluate endpoint — `NAVIGATION_ADAPTER`/`SNIPPET_ADAPTER` ARE still used there, keep them).
2. Add `from ..artifact_kinds import get_spec`.
3. Replace `_validate_payload` and `_apply_derived_metadata`:

```python
def _validate_payload(kind: ArtifactKind, payload: dict[str, Any]) -> None:
    spec = get_spec(kind)
    if spec is None:
        raise HTTPException(
            status_code=422,
            detail=f"artifact kind {kind.value!r} is not supported yet",
        )
    try:
        spec.adapter.validate_python(payload)
    except ValidationError as exc:
        raise HTTPException(
            status_code=422, detail=f"invalid {kind.value} payload: {exc}"
        ) from exc


def _apply_derived_metadata(kind: ArtifactKind, payload: dict[str, Any]) -> None:
    """Recompute server-owned derived fields in-place (registry hook)."""
    spec = get_spec(kind)
    if spec is not None and spec.derive_metadata is not None:
        spec.derive_metadata(payload)
```

4. In `_header`, replace the `if row.kind is ArtifactKind.code_snippet:` branch condition with:

```python
    spec = get_spec(row.kind)
    entry_points: list[str] | None = None
    if spec is not None and spec.surfaces_entry_points:
        raw = row.payload.get("entry_points")
        entry_points = (
            [e for e in raw if isinstance(e, str)] if isinstance(raw, list) else []
        )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_artifact_kinds.py tests/api/test_artifacts_routes.py tests/api/test_snippets_routes.py -v` (if `test_snippets_routes.py` does not exist, run whichever `tests/api/test_snippet*` files do)
Expected: PASS — the routes suite proves the rewire changed no behavior.

- [ ] **Step 6: Lint and commit**

Run: `pixi run backend-lint` — expected clean.

```bash
git add src/data_rover/api/artifact_kinds.py src/data_rover/api/routes/artifacts.py tests/api/test_artifact_kinds.py
git commit -m "feat(api): artifact kind registry with deps/ref-rewrite contract"
```

---

### Task 2: Typed lock resources (CHECKPOINT)

Namespace lock resource ids so non-model resources can hold leases: elements KEEP bare ids (backward compatible — the frontend's lock badges key on element ids), artifacts get `art:<id>`, folders `folder:<id>` (constant declared now, used in Phase 2), the metamodel binding the singleton `mm`. Refine the rebind quiescence rule so artifact leases don't block rebinds.

**Files:**
- Modify: `src/data_rover/api/locking.py` (prefix constants + helpers; `expand_targets` guard)
- Modify: `src/data_rover/api/schemas.py` (`LockTargetIn` gains `type`)
- Modify: `src/data_rover/api/routes/locks.py` (canonicalize targets)
- Modify: `src/data_rover/api/routes/metamodel_swap.py` (model-lease-only refusal)
- Test: `tests/api/test_locking_typed.py`

**Interfaces:**
- Produces (used by Tasks 3, 5, 7):
  - `ARTIFACT_PREFIX = "art:"`, `FOLDER_PREFIX = "folder:"`, `METAMODEL_RESOURCE = "mm"` (module constants in `locking.py`)
  - `artifact_resource(artifact_id: str) -> str` — returns `"art:" + artifact_id`
  - `is_model_resource(resource_id: str) -> bool` — True for bare element/relationship ids
- Wire change: `LockTargetIn` gains `type: Literal["element", "artifact", "metamodel"] = "element"` (default keeps every existing client working unchanged).

- [ ] **Step 1: Write the failing tests**

```python
# tests/api/test_locking_typed.py
"""Typed lock resources: artifact leases share the LockTable with element
leases under a namespace, never containment-expand, and no longer block
metamodel rebinds (only bare model-resource leases do)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api.locking import (
    ARTIFACT_PREFIX,
    METAMODEL_RESOURCE,
    artifact_resource,
    is_model_resource,
)
from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Node
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
"""

OTHER_HEADERS = {"x-user-id": "user-2", "x-user-email": "user2@example.com"}


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


def test_resource_helpers() -> None:
    assert artifact_resource("abc") == "art:abc"
    assert is_model_resource("some-element-id")
    assert not is_model_resource(ARTIFACT_PREFIX + "abc")
    assert not is_model_resource("folder:xyz")
    assert not is_model_resource(METAMODEL_RESOURCE)


def test_acquire_artifact_lock_roundtrip(client: TestClient) -> None:
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": "art-1", "mode": "exclusive", "type": "artifact"}],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text
    leases = r.json()["leases"]
    assert [le["resource_id"] for le in leases] == ["art:art-1"]


def test_artifact_delete_lock_does_not_containment_expand(client: TestClient) -> None:
    # DELETE intent on an element expands to its subtree; on an artifact it
    # must stay a single resource (dangling refs are tolerated, no cascade).
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": "art-1", "mode": "exclusive", "type": "artifact"}],
            "intent": "delete",
        },
    )
    assert r.status_code == 200, r.text
    assert len(r.json()["leases"]) == 1


def test_second_user_conflicts_on_same_artifact(client: TestClient) -> None:
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": "art-1", "mode": "exclusive", "type": "artifact"}],
            "intent": "edit",
        },
    )
    assert r.status_code == 200
    r2 = client.post(
        papi("/locks"),
        headers=OTHER_HEADERS,
        json={
            "targets": [{"resource_id": "art-1", "mode": "exclusive", "type": "artifact"}],
            "intent": "edit",
        },
    )
    assert r2.status_code == 409
    assert r2.json()["conflicts"][0]["resource_id"] == "art:art-1"


def test_rebind_ignores_artifact_leases(client: TestClient) -> None:
    # an artifact lease is live; rebind must proceed (artifacts degrade
    # tolerantly under a retyped metamodel — spec, locking section)
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": "art-1", "mode": "exclusive", "type": "artifact"}],
            "intent": "edit",
        },
    )
    assert r.status_code == 200
    rev = client.get(papi("/model/summary")).json()["model_rev"]
    r = client.post(
        papi(f"/metamodel/rebind?base_rev={rev}"),
        content=_MM,
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_locking_typed.py -v`
Expected: FAIL with `ImportError: cannot import name 'ARTIFACT_PREFIX'`

- [ ] **Step 3: Implement**

In `src/data_rover/api/locking.py`, add right after the `LockIntent` enum:

```python
#: Resource-id namespace (spec 2026-07-29, locking section). Elements and
#: relationships keep BARE ids — the pre-existing wire format the frontend's
#: lock badges key on — so only non-model resources carry a prefix. Element
#: ids are uuid-hex / user ids that never contain ':', so prefix collision
#: is not a practical concern; all writers go through the helpers below.
ARTIFACT_PREFIX = "art:"
FOLDER_PREFIX = "folder:"  # Phase 2 (view folders); declared with its family
METAMODEL_RESOURCE = "mm"  # singleton — one metamodel binding per project


def artifact_resource(artifact_id: str) -> str:
    return ARTIFACT_PREFIX + artifact_id


def is_model_resource(resource_id: str) -> bool:
    """True for bare element/relationship ids — the resources whose leases
    gate model mutation (and rebind quiescence)."""
    return (
        not resource_id.startswith((ARTIFACT_PREFIX, FOLDER_PREFIX))
        and resource_id != METAMODEL_RESOURCE
    )
```

In `expand_targets`, change the DELETE branch guard so only model resources containment-expand:

```python
    for rid, mode in targets:
        if (
            intent is LockIntent.DELETE
            and mode is LockMode.EXCLUSIVE
            and is_model_resource(rid)
        ):
            for member in containment_subtree(model, rid):
                add(member, LockMode.EXCLUSIVE)
        else:
            add(rid, mode)
```

In `src/data_rover/api/schemas.py`, extend `LockTargetIn`:

```python
class LockTargetIn(BaseModel):
    resource_id: str
    mode: Literal["exclusive", "shared"]
    #: what the id names; the route canonicalizes to the internal namespace
    #: ("element" -> bare id, "artifact" -> "art:<id>", "metamodel" -> "mm").
    #: Defaults to "element" so pre-existing clients are untouched.
    type: Literal["element", "artifact", "metamodel"] = "element"
```

In `src/data_rover/api/routes/locks.py::acquire_locks`, replace the `targets = ...` line:

```python
    def _canonical(t: LockTargetIn) -> str:
        if t.type == "artifact":
            return artifact_resource(t.resource_id)
        if t.type == "metamodel":
            return METAMODEL_RESOURCE
        return t.resource_id

    targets = [(_canonical(t), LockMode(t.mode)) for t in payload.targets]
```

with imports `from ..locking import ... artifact_resource, METAMODEL_RESOURCE` and `from ..schemas import LockTargetIn` added, and the rest of the function unchanged.

In `src/data_rover/api/routes/metamodel_swap.py`, the refusal inside `rebind_metamodel` currently reads:

```python
        if session.lock_table.active_leases(time.monotonic()):
```

Replace with (import `is_model_resource` from `..locking`):

```python
        model_leases = [
            le
            for le in session.lock_table.active_leases(time.monotonic())
            if is_model_resource(le.resource_id)
        ]
        if model_leases:
```

and update the docstring line "Refuses (409) when any lease is active" to "Refuses (409) when any MODEL lease is active (artifact/folder leases don't block — affected artifacts degrade tolerantly under the new metamodel)".

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_locking_typed.py tests/api/test_locking.py tests/api/test_lock_scope.py tests/api/test_locks_route.py tests/api/test_metamodel_rebind.py -v`
Expected: PASS (existing suites prove backward compatibility).

- [ ] **Step 5: CHECKPOINT — full suite, lint, commit**

Run: `pixi run core-test` then `pixi run backend-lint`. Expected: all green. STOP if not.

```bash
git add src/data_rover/api/locking.py src/data_rover/api/schemas.py src/data_rover/api/routes/locks.py src/data_rover/api/routes/metamodel_swap.py tests/api/test_locking_typed.py
git commit -m "feat(api): typed lock resources (art:/folder:/mm namespace)"
```

---

### Task 3: Artifact op schemas, `split_ops`, hydration filter, lock derivation

Add the three artifact ops to the `OpIn` union, introduce the `ModelOpIn`/`ArtifactOpIn` split, keep every existing consumer model-only via `split_ops`, and teach `required_locks` the new ops. **This task makes the union bigger while keeping behavior identical** — artifact ops are rejected with 422 everywhere until Task 5 wires them in.

**Files:**
- Modify: `src/data_rover/api/schemas.py` (op classes + union split)
- Create: `src/data_rover/api/artifact_ops.py` (only `split_ops` + kind-set constant for now; the applier lands in Task 4)
- Modify: `src/data_rover/api/routes/ops.py` (`_apply_one`/`_apply_batch`/`_rollback` typed to `ModelOpIn`; `/model/ops` rejects artifact ops)
- Modify: `src/data_rover/api/routes/commits.py` (preview + commit + revert reject artifact ops FOR NOW)
- Modify: `src/data_rover/api/hydration.py` (`replay_commits_into` filters to model ops)
- Modify: `src/data_rover/api/locking.py` (`required_locks` branches)
- Test: `tests/api/test_artifact_op_schemas.py`

**Interfaces:**
- Produces (used by Tasks 4–8):

```python
# schemas.py
class CreateArtifactOp(BaseModel):
    kind: Literal["create_artifact"]
    temp_id: str
    artifact_kind: Literal["navigation", "table", "diagram", "diagram_kind", "code_snippet"]
    name: str = Field(min_length=1)
    payload: dict[str, Any] = Field(default_factory=dict)

class UpdateArtifactOp(BaseModel):
    kind: Literal["update_artifact"]
    id: str
    name: str | None = Field(default=None, min_length=1)
    #: FULL replacement payload (None = name-only change). Inverse ops always
    #: carry the full prior payload — that is what makes diffs/undo journal-only.
    payload: dict[str, Any] | None = None
    #: optional optimistic precondition (mirrors PUT /artifacts); None skips.
    #: Stripped from the canonical stored op (precondition is consumed at apply).
    artifact_rev: int | None = None

class DeleteArtifactOp(BaseModel):
    kind: Literal["delete_artifact"]
    id: str

ModelOpIn = (CreateElementOp | UpdateElementOp | DeleteElementOp
             | CreateRelationshipOp | UpdateRelationshipOp | DeleteRelationshipOp)
ArtifactOpIn = CreateArtifactOp | UpdateArtifactOp | DeleteArtifactOp
OpIn = Annotated[ModelOpIn | ArtifactOpIn, Field(discriminator="kind")]
```

- `artifact_ops.split_ops(ops: Sequence[OpIn]) -> tuple[list[ModelOpIn], list[ArtifactOpIn]]`
- `artifact_ops.ARTIFACT_OP_KINDS = frozenset({"create_artifact", "update_artifact", "delete_artifact"})` (for raw-dict journal rows)

- [ ] **Step 1: Write the failing tests**

```python
# tests/api/test_artifact_op_schemas.py
"""The op-union split: artifact ops parse through OPS_ADAPTER (journal
round-trip), split_ops separates families, required_locks derives art:
leases, and every legacy endpoint still rejects artifact ops until the
commit route learns them (Task 5)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.artifact_ops import ARTIFACT_OP_KINDS, split_ops
from data_rover.api.locking import LockIntent, LockMode, artifact_resource, required_locks
from data_rover.api.schemas import OPS_ADAPTER, CreateArtifactOp, UpdateArtifactOp
from data_rover.core.metamodel.load import load_metamodel_from_yaml
from data_rover.core.model.model import Model

from .conftest import AUTH_HEADERS, papi, seed_default_project
from data_rover.api.main import create_app

_MM = """
elements:
  - name: Node
"""


def _model() -> Model:
    return Model(metamodel=load_metamodel_from_yaml(_MM))


def test_ops_adapter_roundtrips_artifact_ops() -> None:
    raw = [
        {"kind": "create_artifact", "temp_id": "tmp_a", "artifact_kind": "code_snippet",
         "name": "s", "payload": {"code": "x = 1"}},
        {"kind": "update_artifact", "id": "a1", "payload": {"code": "y = 2"}},
        {"kind": "delete_artifact", "id": "a2"},
    ]
    ops = OPS_ADAPTER.validate_python(raw)
    assert isinstance(ops[0], CreateArtifactOp)
    dumped = OPS_ADAPTER.dump_python(ops, mode="json")
    assert [d["kind"] for d in dumped] == [r["kind"] for r in raw]
    assert set(d["kind"] for d in dumped) <= ARTIFACT_OP_KINDS | {"create_element"}


def test_split_ops_separates_families() -> None:
    ops = OPS_ADAPTER.validate_python([
        {"kind": "create_element", "temp_id": "tmp_e", "type_name": "Node", "properties": {}},
        {"kind": "update_artifact", "id": "a1", "payload": {"code": "y"}},
    ])
    model_ops, artifact_ops = split_ops(ops)
    assert [o.kind for o in model_ops] == ["create_element"]
    assert [o.kind for o in artifact_ops] == ["update_artifact"]


def test_required_locks_for_artifact_ops() -> None:
    ops = OPS_ADAPTER.validate_python([
        {"kind": "create_artifact", "temp_id": "tmp_a", "artifact_kind": "table",
         "name": "t", "payload": {}},
        {"kind": "update_artifact", "id": "a1", "payload": {}},
        {"kind": "delete_artifact", "id": "a2"},
    ])
    reqs = required_locks(_model(), ops)
    by_id = {r.resource_id: r for r in reqs}
    assert set(by_id) == {artifact_resource("a1"), artifact_resource("a2")}
    assert by_id["art:a1"].mode is LockMode.EXCLUSIVE
    assert by_id["art:a1"].intent is LockIntent.EDIT
    assert by_id["art:a2"].intent is LockIntent.DELETE


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"})
    assert res.status_code == 200, res.text
    res = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert res.status_code == 200, res.text
    return c


def _artifact_op_batch(c: TestClient) -> dict:
    rev = c.get(papi("/model/summary")).json()["model_rev"]
    return {
        "base_rev": rev,
        "ops": [{"kind": "update_artifact", "id": "a1", "payload": {"code": "y"}}],
    }


def test_legacy_model_ops_endpoint_rejects_artifact_ops(client: TestClient) -> None:
    r = client.post(papi("/model/ops"), json=_artifact_op_batch(client))
    assert r.status_code == 422
    assert "artifact ops" in r.text


def test_commit_endpoints_reject_artifact_ops_until_wired(client: TestClient) -> None:
    # These two flip to real behavior in Task 5; the guard proves artifact ops
    # can never reach the model applier meanwhile.
    r = client.post(papi("/commits/preview"), json=_artifact_op_batch(client))
    assert r.status_code == 422
    r = client.post(papi("/commits"), json={**_artifact_op_batch(client), "lock_tokens": []})
    assert r.status_code == 422
```

Note: if `load_metamodel_from_yaml` is not the real loader name, find it with `grep -rn "def load_metamodel" src/data_rover/core/metamodel/` and use what `tests/model/` tests import; same for the `Model` constructor — mirror any existing core test that builds a tiny model from YAML.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_artifact_op_schemas.py -v`
Expected: FAIL with `ImportError` (no `artifact_ops` module / `CreateArtifactOp`).

- [ ] **Step 3: Implement the schema split**

In `src/data_rover/api/schemas.py`, immediately before the existing `OpIn = Annotated[...]`, add the three op classes exactly as in the Interfaces block above. Then replace the `OpIn` definition with:

```python
#: Model-content ops — the ONLY ops routes/ops.py::_apply_one may receive
#: (its assert_never enforces the closed set at type-check time).
ModelOpIn = (
    CreateElementOp
    | UpdateElementOp
    | DeleteElementOp
    | CreateRelationshipOp
    | UpdateRelationshipOp
    | DeleteRelationshipOp
)

#: Artifact-row ops (Phase 1 artefacts revamp) — applied by
#: api/artifact_ops.py to DB rows, never to the in-memory model.
ArtifactOpIn = CreateArtifactOp | UpdateArtifactOp | DeleteArtifactOp

OpIn = Annotated[ModelOpIn | ArtifactOpIn, Field(discriminator="kind")]
```

- [ ] **Step 4: Create `artifact_ops.py` with the splitter**

```python
# src/data_rover/api/artifact_ops.py
"""Artifact-op plumbing (Phase 1 artefacts revamp).

Artifacts are materialized DB rows, not model content, so their ops must
never reach the model applier (routes/ops.py::_apply_one). ``split_ops`` is
the single chokepoint every batch passes through; the applier itself lands
with the commit wiring (see this module's growth in the same plan)."""

from __future__ import annotations

from collections.abc import Sequence

from .schemas import (
    ArtifactOpIn,
    CreateArtifactOp,
    DeleteArtifactOp,
    ModelOpIn,
    OpIn,
    UpdateArtifactOp,
)

#: kind-tags of artifact ops, for raw journal dicts (Commit.ops JSON).
ARTIFACT_OP_KINDS = frozenset({"create_artifact", "update_artifact", "delete_artifact"})


def split_ops(ops: Sequence[OpIn]) -> tuple[list[ModelOpIn], list[ArtifactOpIn]]:
    """Separate a mixed batch into (model ops, artifact ops), order-preserving
    within each family. The families are independent (artifact payloads may
    REFERENCE model ids, but tolerantly), so relative cross-family order
    carries no meaning."""
    model_ops: list[ModelOpIn] = []
    artifact_ops: list[ArtifactOpIn] = []
    for op in ops:
        if isinstance(op, (CreateArtifactOp, UpdateArtifactOp, DeleteArtifactOp)):
            artifact_ops.append(op)
        else:
            model_ops.append(op)
    return model_ops, artifact_ops
```

- [ ] **Step 5: Retype the model applier and guard the endpoints**

1. `src/data_rover/api/routes/ops.py`: change type hints only — `_apply_one(model: Model, op: ModelOpIn, ...)`, `_apply_batch(model: Model, ops: list[ModelOpIn], ...)`, `_rollback(model: Model, inverse_units: list[list[ModelOpIn]], ...)`, `_BatchResult.canonical_ops: list[ModelOpIn]`, `inverse_units: list[list[ModelOpIn]]`, `inverse_ops() -> list[ModelOpIn]` (import `ModelOpIn` from `..schemas`). Pyright will now FLAG every call site that passes `list[OpIn]` — that is the enforcement working; fix each flagged site as below.
2. In `apply_ops` (`/model/ops`), after the base_rev check add:

```python
    from ..artifact_ops import split_ops  # move to module imports

    model_ops, artifact_ops = split_ops(payload.ops)
    if artifact_ops:
        # The legacy unlocked path is model-only FOREVER: artifact edits go
        # through POST /commits (lock-verified) or legacy PUT /artifacts.
        raise HTTPException(
            status_code=422,
            detail="artifact ops are not supported on /model/ops; use /commits",
        )
```

and pass `model_ops` (not `payload.ops`) to `_apply_batch`.
3. In `undo`, wrap the inverse batch: `model_inv, artifact_inv = split_ops(batch.inverse_ops)` and pass `model_inv` to `_apply_batch`; if `artifact_inv` is non-empty raise `HTTPException(422, "undo across artifact changes lands with the commit wiring")` — Task 6 replaces this guard with real handling. (Until Task 5 no artifact op can enter the op_log, so the guard is unreachable today; it exists so pyright's retype is satisfied honestly.)
4. In `routes/commits.py`: in `preview_commit`, `create_commit`, and `revert_commit`, add the same split+422 guard right after their base_rev checks (message: `"artifact ops are not yet supported on this endpoint"`), passing `model_ops` onward. Revert additionally: pass the deserialized inverse ops through `split_ops` and use only the model part (guard identical). Task 5/6 replace these guards.
5. `src/data_rover/api/hydration.py::replay_commits_into`: change

```python
        ops = deserialize_ops(c.ops)
```

to

```python
        from .artifact_ops import split_ops  # module-level import

        ops, _artifact_ops = split_ops(deserialize_ops(c.ops))
        # artifact ops are SKIPPED on model replay: artifact rows are the
        # materialized heads and already reflect them (spec: one journal,
        # materialized heads).
```

(put the import at module top, not inside the loop).
6. `src/data_rover/api/locking.py::required_locks`: add imports for the three artifact op classes and `ARTIFACT_PREFIX`, then extend the loop before the final `return`:

```python
        elif isinstance(op, CreateArtifactOp):
            created.add(op.temp_id)
        elif isinstance(op, UpdateArtifactOp):
            add(ARTIFACT_PREFIX + op.id, LockMode.EXCLUSIVE, LockIntent.EDIT)
        elif isinstance(op, DeleteArtifactOp):
            add(ARTIFACT_PREFIX + op.id, LockMode.EXCLUSIVE, LockIntent.DELETE)
```

(`create_artifact` needs no lease — fresh id, mirrors the temp-id rule.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_artifact_op_schemas.py tests/api -q`
Expected: new file PASSES and the whole `tests/api` directory stays green (the guards changed no existing behavior).

- [ ] **Step 7: Lint and commit**

Run: `pixi run backend-lint` — pyright passing proves no call site can hand artifact ops to the model applier.

```bash
git add src/data_rover/api/schemas.py src/data_rover/api/artifact_ops.py src/data_rover/api/routes/ops.py src/data_rover/api/routes/commits.py src/data_rover/api/hydration.py src/data_rover/api/locking.py tests/api/test_artifact_op_schemas.py
git commit -m "feat(api): artifact op schemas, ModelOpIn split, replay filter"
```

---

### Task 4: Artifact op applier

The DB-side twin of `_apply_batch`: applies artifact ops to `ArtifactRow`s on the request's DB session (flush only — the caller owns the transaction), collecting full-state inverse ops.

**Files:**
- Modify: `src/data_rover/api/content.py` (`create_artifact` gains `artifact_id` param)
- Modify: `src/data_rover/api/artifact_ops.py` (add the applier)
- Test: `tests/api/test_artifact_ops_apply.py`

**Interfaces:**
- Consumes: `get_spec` (Task 1), `content.create/get/find/update/delete_artifact`, the op classes (Task 3).
- Produces (used by Tasks 5, 6):

```python
@dataclass
class ArtifactBatchResult:
    canonical_ops: list[ArtifactOpIn]
    inverse_units: list[list[ArtifactOpIn]]
    id_map: dict[str, str]              # temp artifact id -> canonical id
    changed_ids: dict[str, None]        # created+updated, first-touch order
    deleted: list[dict[str, Any]]       # pre-delete header dicts (feed events)
    def inverse_ops(self) -> list[ArtifactOpIn]: ...

def apply_artifact_ops(db, project_id, ops, *, user_id, id_map=None, restore=False) -> ArtifactBatchResult
def validate_artifact_ops(db, project_id, ops) -> None   # dry preview check, no writes
```

- Failure contract: raises `HTTPException` (422 for validation/unknown-id/name-clash, 409 with `{"message", "current_rev"}` for a stale `artifact_rev` precondition). **No internal rollback** — staged row changes are discarded by the caller's `db.rollback()`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/api/test_artifact_ops_apply.py
"""apply_artifact_ops: full-state inverses, restore-mode exact-id
reinstatement, and the apply-then-inverse == identity property that undo
and commit diffs both lean on."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from data_rover.api import content, db
from data_rover.api.artifact_ops import apply_artifact_ops, validate_artifact_ops
from data_rover.api.db_models import ArtifactKind
from data_rover.api.schemas import OPS_ADAPTER

from .conftest import seed_default_project

SNIP = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return 1\n"}


@pytest.fixture
def dbs():
    seed_default_project()
    with db.session_scope() as s:  # if session_scope doesn't exist, use: s = next(db.get_db(...)) pattern from test_content.py
        yield s


def _ops(raw: list[dict]):
    return OPS_ADAPTER.validate_python(raw)


def test_create_assigns_id_and_derives_metadata(dbs) -> None:
    res = apply_artifact_ops(
        dbs, "default",
        _ops([{"kind": "create_artifact", "temp_id": "tmp_s", "artifact_kind": "code_snippet",
               "name": "s1", "payload": SNIP}]),
        user_id="u1",
    )
    aid = res.id_map["tmp_s"]
    row = content.get_artifact(dbs, aid)
    assert row is not None and row.name == "s1"
    assert "value" in row.payload["entry_points"]           # server-derived
    assert res.canonical_ops[0].temp_id == aid              # canonicalized
    assert res.inverse_ops()[0].kind == "delete_artifact"
    assert list(res.changed_ids) == [aid]


def test_update_inverse_carries_full_prior_state(dbs) -> None:
    row = content.create_artifact(dbs, "default", kind=ArtifactKind.code_snippet,
                                  name="s1", payload=dict(SNIP), updated_by="u1")
    res = apply_artifact_ops(
        dbs, "default",
        _ops([{"kind": "update_artifact", "id": row.id, "name": "s2",
               "payload": {**SNIP, "code": "def step(el):\n    return el\n"}}]),
        user_id="u1",
    )
    inv = res.inverse_ops()[0]
    assert inv.kind == "update_artifact" and inv.name == "s1"
    assert inv.payload["code"] == SNIP["code"]
    # canonical op strips the consumed precondition
    assert res.canonical_ops[0].artifact_rev is None


def test_apply_then_inverse_restores_state(dbs) -> None:
    row = content.create_artifact(dbs, "default", kind=ArtifactKind.code_snippet,
                                  name="s1", payload=dict(SNIP), updated_by="u1")
    before = (row.name, dict(row.payload))
    res = apply_artifact_ops(
        dbs, "default",
        _ops([{"kind": "update_artifact", "id": row.id, "name": "s2",
               "payload": {**SNIP, "code": "x = 1"}},
              {"kind": "delete_artifact", "id": row.id}]),
        user_id="u1",
    )
    assert content.get_artifact(dbs, row.id) is None
    apply_artifact_ops(dbs, "default", list(res.inverse_ops()), user_id="u1", restore=True)
    restored = content.get_artifact(dbs, row.id)
    assert restored is not None                      # exact id reinstated
    assert (restored.name, dict(restored.payload))[0] == before[0]
    assert restored.payload["code"] == before[1]["code"]


def test_delete_records_header_and_recreate_inverse(dbs) -> None:
    row = content.create_artifact(dbs, "default", kind=ArtifactKind.code_snippet,
                                  name="s1", payload=dict(SNIP), updated_by="u1")
    res = apply_artifact_ops(dbs, "default",
                             _ops([{"kind": "delete_artifact", "id": row.id}]), user_id="u1")
    assert res.deleted[0]["id"] == row.id and res.deleted[0]["name"] == "s1"
    inv = res.inverse_ops()[0]
    assert inv.kind == "create_artifact" and inv.temp_id == row.id


def test_stale_rev_precondition_409(dbs) -> None:
    row = content.create_artifact(dbs, "default", kind=ArtifactKind.code_snippet,
                                  name="s1", payload=dict(SNIP), updated_by="u1")
    with pytest.raises(HTTPException) as e:
        apply_artifact_ops(dbs, "default",
                           _ops([{"kind": "update_artifact", "id": row.id,
                                  "artifact_rev": 99, "payload": SNIP}]), user_id="u1")
    assert e.value.status_code == 409


def test_unknown_id_and_name_clash_422(dbs) -> None:
    with pytest.raises(HTTPException) as e:
        apply_artifact_ops(dbs, "default",
                           _ops([{"kind": "delete_artifact", "id": "nope"}]), user_id="u1")
    assert e.value.status_code == 422
    content.create_artifact(dbs, "default", kind=ArtifactKind.code_snippet,
                            name="taken", payload=dict(SNIP), updated_by="u1")
    with pytest.raises(HTTPException) as e:
        apply_artifact_ops(dbs, "default",
                           _ops([{"kind": "create_artifact", "temp_id": "tmp_x",
                                  "artifact_kind": "code_snippet", "name": "taken",
                                  "payload": SNIP}]), user_id="u1")
    assert e.value.status_code == 422


def test_validate_artifact_ops_is_write_free(dbs) -> None:
    validate_artifact_ops(dbs, "default",
                          _ops([{"kind": "create_artifact", "temp_id": "tmp_x",
                                 "artifact_kind": "code_snippet", "name": "n",
                                 "payload": SNIP}]))
    assert content.find_artifact(dbs, "default", ArtifactKind.code_snippet, "n") is None
    with pytest.raises(HTTPException):
        validate_artifact_ops(dbs, "default",
                              _ops([{"kind": "update_artifact", "id": "nope",
                                     "payload": SNIP}]))
```

Before running: check how `tests/api/test_content.py` obtains a DB session for direct service-layer tests and copy that fixture pattern for `dbs` (the comment in the fixture shows the intent; mirror the existing suite exactly).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_artifact_ops_apply.py -v`
Expected: FAIL with `ImportError: cannot import name 'apply_artifact_ops'`

- [ ] **Step 3: Extend `content.create_artifact` for restore mode**

In `src/data_rover/api/content.py`, add an `artifact_id: str | None = None` keyword to `create_artifact` and use it:

```python
def create_artifact(
    db: Session,
    project_id: str,
    *,
    kind: ArtifactKind,
    name: str,
    payload: dict,
    updated_by: str | None,
    artifact_id: str | None = None,
) -> ArtifactRow:
    """`artifact_id` reinstates an exact id (undo/revert restore mode);
    None (the normal path) assigns a fresh uuid."""
    row = ArtifactRow(
        id=artifact_id or uuid.uuid4().hex,
        ...  # rest unchanged
```

- [ ] **Step 4: Implement the applier in `artifact_ops.py`**

Append to `src/data_rover/api/artifact_ops.py` (extend module imports accordingly: `uuid`, `dataclass/field`, `Any`, `HTTPException`, `Session as DbSession` from sqlalchemy.orm, `assert_never`, `from . import content`, `from .artifact_kinds import get_spec`, `from .db_models import ArtifactKind, ArtifactRow`, `from pydantic import ValidationError`):

```python
#: mirrors routes/ops.py TEMP_ID_PREFIX (same precedent as locking.py's copy)
_TEMP_ID_PREFIX = "tmp_"


def _resolve_json(value: Any, id_map: dict[str, str]) -> Any:
    """Dict-aware port of routes/ops._resolve_value: temp ids anywhere in a
    payload (element ids in scope criteria, artifact ids in refs) are replaced
    by their canonical ids; unknown strings pass through as tolerant
    danglers."""
    if isinstance(value, str):
        return id_map.get(value, value)
    if isinstance(value, list):
        return [_resolve_json(v, id_map) for v in value]
    if isinstance(value, dict):
        return {k: _resolve_json(v, id_map) for k, v in value.items()}
    return value


@dataclass
class ArtifactBatchResult:
    """Everything one artifact-op batch produced (twin of ops._BatchResult).

    There is NO in-memory rollback path: row changes are only flushed, so the
    caller's db.rollback() discards everything on failure."""

    canonical_ops: list[ArtifactOpIn] = field(default_factory=list)
    inverse_units: list[list[ArtifactOpIn]] = field(default_factory=list)
    id_map: dict[str, str] = field(default_factory=dict)
    changed_ids: dict[str, None] = field(default_factory=dict)
    deleted: list[dict[str, Any]] = field(default_factory=list)

    def inverse_ops(self) -> list[ArtifactOpIn]:
        """Flat inverse batch: applying it front-to-back undoes this batch."""
        return [op for unit in reversed(self.inverse_units) for op in unit]


def _spec_or_422(kind: ArtifactKind):
    spec = get_spec(kind)
    if spec is None:
        raise HTTPException(
            status_code=422,
            detail=f"artifact kind {kind.value!r} is not supported yet",
        )
    return spec


def _validated_payload(
    spec, kind: ArtifactKind, payload: dict[str, Any], *, restore: bool
) -> dict[str, Any]:
    """Adapter-validate + rerun derived metadata. Restore replays previously
    accepted state verbatim (mirrors the model applier's restore stance)."""
    if restore:
        return payload
    try:
        spec.adapter.validate_python(payload)
    except ValidationError as exc:
        raise HTTPException(
            status_code=422, detail=f"invalid {kind.value} payload: {exc}"
        ) from exc
    if spec.derive_metadata is not None:
        payload = dict(payload)
        spec.derive_metadata(payload)
    return payload


def _require_row(db: DbSession, project_id: str, artifact_id: str) -> ArtifactRow:
    row = content.get_artifact(db, artifact_id)
    if row is None or row.project_id != project_id:
        raise HTTPException(status_code=422, detail=f"no artifact with id {artifact_id!r}")
    return row


def _check_clash(
    db: DbSession, project_id: str, kind: ArtifactKind, name: str, own_id: str | None
) -> None:
    clash = content.find_artifact(db, project_id, kind, name)
    if clash is not None and clash.id != own_id:
        raise HTTPException(
            status_code=422,
            detail=f"a {kind.value} named {name!r} already exists",
        )


def _header_dict(row: ArtifactRow) -> dict[str, Any]:
    return {"id": row.id, "kind": row.kind.value, "name": row.name,
            "artifact_rev": row.artifact_rev}


def apply_artifact_ops(
    db: DbSession,
    project_id: str,
    ops: list[ArtifactOpIn],
    *,
    user_id: str | None,
    id_map: dict[str, str] | None = None,
    restore: bool = False,
) -> ArtifactBatchResult:
    """Apply artifact ops to their rows, staging changes on *db* (flush only).

    Inverse ops carry FULL prior state (name + payload), never patches — the
    journal alone must be able to answer diffs and undo. Restore mode
    reinstates exact ids and skips validation/derivation/clash checks, exactly
    like the model applier's restore stance. A recreated row's artifact_rev
    restarts at 1 — artifact_rev is an OCC ticker, not identity, matching the
    'per-entity rev counters continue forward' rule in routes/ops.py."""
    res = ArtifactBatchResult(id_map=dict(id_map or {}))
    for op in ops:
        if isinstance(op, CreateArtifactOp):
            kind = ArtifactKind(op.artifact_kind)
            spec = _spec_or_422(kind)
            payload = _resolve_json(op.payload, res.id_map)
            if op.temp_id.startswith(_TEMP_ID_PREFIX):
                artifact_id = uuid.uuid4().hex
                res.id_map[op.temp_id] = artifact_id
            elif restore:
                artifact_id = op.temp_id  # reinstate the exact id
            else:
                raise HTTPException(
                    status_code=422,
                    detail=f"create_artifact temp_id {op.temp_id!r} must start "
                    f"with {_TEMP_ID_PREFIX!r}",
                )
            payload = _validated_payload(spec, kind, payload, restore=restore)
            if not restore:
                _check_clash(db, project_id, kind, op.name, own_id=None)
            row = content.create_artifact(
                db, project_id, kind=kind, name=op.name, payload=payload,
                updated_by=user_id, artifact_id=artifact_id,
            )
            res.inverse_units.append([DeleteArtifactOp(kind="delete_artifact", id=row.id)])
            res.canonical_ops.append(op.model_copy(update={"temp_id": row.id, "payload": payload}))
            res.changed_ids[row.id] = None
        elif isinstance(op, UpdateArtifactOp):
            row = _require_row(db, project_id, op.id)
            if op.artifact_rev is not None and op.artifact_rev != row.artifact_rev:
                raise HTTPException(
                    status_code=409,
                    detail={"message": "artifact was modified by someone else",
                            "current_rev": row.artifact_rev},
                )
            inverse = UpdateArtifactOp(
                kind="update_artifact", id=row.id, name=row.name,
                payload=dict(row.payload),
            )
            payload = op.payload
            if payload is not None:
                spec = _spec_or_422(row.kind)
                payload = _validated_payload(
                    spec, row.kind, _resolve_json(payload, res.id_map), restore=restore
                )
            if op.name is not None and op.name != row.name and not restore:
                _check_clash(db, project_id, row.kind, op.name, own_id=row.id)
            content.update_artifact(
                db, row, expected_rev=row.artifact_rev, name=op.name,
                payload=payload, updated_by=user_id,
            )
            res.inverse_units.append([inverse])
            res.canonical_ops.append(
                op.model_copy(update={"payload": payload, "artifact_rev": None})
            )
            res.changed_ids[row.id] = None
        elif isinstance(op, DeleteArtifactOp):
            row = _require_row(db, project_id, op.id)
            res.deleted.append(_header_dict(row))
            res.inverse_units.append([
                CreateArtifactOp(
                    kind="create_artifact", temp_id=row.id,
                    artifact_kind=row.kind.value, name=row.name,
                    payload=dict(row.payload),
                )
            ])
            content.delete_artifact(db, row)
            res.canonical_ops.append(op)
            res.changed_ids.pop(row.id, None)
        else:
            assert_never(op)
    return res


def validate_artifact_ops(db: DbSession, project_id: str, ops: list[ArtifactOpIn]) -> None:
    """Dry preview validation: payload adapters + existence + preconditions +
    name clashes — WITHOUT writing anything. Mirrors what apply would reject."""
    for op in ops:
        if isinstance(op, CreateArtifactOp):
            kind = ArtifactKind(op.artifact_kind)
            spec = _spec_or_422(kind)
            _validated_payload(spec, kind, op.payload, restore=False)
            _check_clash(db, project_id, kind, op.name, own_id=None)
        elif isinstance(op, UpdateArtifactOp):
            row = _require_row(db, project_id, op.id)
            if op.artifact_rev is not None and op.artifact_rev != row.artifact_rev:
                raise HTTPException(
                    status_code=409,
                    detail={"message": "artifact was modified by someone else",
                            "current_rev": row.artifact_rev},
                )
            if op.payload is not None:
                spec = _spec_or_422(row.kind)
                _validated_payload(spec, row.kind, op.payload, restore=False)
            if op.name is not None and op.name != row.name:
                _check_clash(db, project_id, row.kind, op.name, own_id=row.id)
        elif isinstance(op, DeleteArtifactOp):
            _require_row(db, project_id, op.id)
        else:
            assert_never(op)
```

Note on `update_artifact`: it is called with `expected_rev=row.artifact_rev` (always current) because the op-level precondition was already checked — the content-layer check can then never fail.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_artifact_ops_apply.py tests/api/test_artifacts_routes.py -v`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
git add src/data_rover/api/artifact_ops.py src/data_rover/api/content.py tests/api/test_artifact_ops_apply.py
git commit -m "feat(api): artifact op applier with full-state inverses"
```

---

### Task 5: Wire artifact ops into POST /commits and /commits/preview (CHECKPOINT)

Replace Task 3's 422 guards on the commit endpoints with real behavior: lock-verified, journaled, feed-broadcast artifact commits.

**Files:**
- Modify: `src/data_rover/api/routes/commits.py` (`create_commit`, `preview_commit`)
- Modify: `src/data_rover/api/routes/ops.py` (`_persist_commit` takes explicit op lists)
- Modify: `src/data_rover/api/schemas.py` (`CommitResponse` extension)
- Modify: `src/data_rover/api/feed.py` (`commit_event` gains `scope`)
- Test: `tests/api/test_commits_artifact_ops.py`

**Interfaces:**
- `_persist_commit(db, project_id, *, rev, author_id, ops: list[OpIn], inverse_ops: list[OpIn], id_map: dict[str, str], _commit_id=None, _message="", _validation_error_count=0, _issues=None) -> bool` — the `res: _BatchResult` parameter is REPLACED by the three explicit lists; update ALL call sites (`apply_ops`, `create_commit`, `revert_commit`) mechanically: `ops=res.canonical_ops, inverse_ops=res.inverse_ops(), id_map=dict(res.id_map)`.
- `CommitResponse` gains `changed_artifacts: list[ArtifactHeaderOut] = Field(default_factory=list)` and `deleted_artifact_ids: list[str] = Field(default_factory=list)`.
- `commit_event(..., scope: list[str], ...)` — new required keyword; existing callers pass `scope=["model"]`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/api/test_commits_artifact_ops.py
"""Artifact ops through the lock-verified commit flow: lease enforcement,
journaling, artifact_rev lockstep with the legacy PUT path, rollback
atomicity, and feed events."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Node
"""

SNIP = {"schema_version": 1, "language": "python",
        "code": "def value(el):\n    return 1\n"}

OTHER_HEADERS = {"x-user-id": "user-2", "x-user-email": "user2@example.com"}


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    r = c.post(papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"})
    assert r.status_code == 200, r.text
    r = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert r.status_code == 200, r.text
    return c


def _rev(c: TestClient) -> int:
    return c.get(papi("/model/summary")).json()["model_rev"]


def _mk_snippet(c: TestClient, name: str = "s1") -> dict:
    r = c.post(papi("/artifacts"),
               json={"kind": "code_snippet", "name": name, "payload": SNIP})
    assert r.status_code == 201, r.text
    return r.json()


def _lock_artifact(c: TestClient, artifact_id: str, headers: dict | None = None) -> str:
    r = c.post(papi("/locks"), headers=headers,
               json={"targets": [{"resource_id": artifact_id, "mode": "exclusive",
                                  "type": "artifact"}], "intent": "edit"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def test_update_without_lock_409_missing(client: TestClient) -> None:
    art = _mk_snippet(client)
    r = client.post(papi("/commits"), json={
        "base_rev": _rev(client),
        "ops": [{"kind": "update_artifact", "id": art["id"],
                 "payload": {**SNIP, "code": "x = 1"}}],
        "lock_tokens": [],
    })
    assert r.status_code == 409
    assert r.json()["missing"][0]["resource_id"] == f"art:{art['id']}"


def test_locked_update_commits_and_bumps_both_revs(client: TestClient) -> None:
    art = _mk_snippet(client)
    tok = _lock_artifact(client, art["id"])
    before_rev = _rev(client)
    r = client.post(papi("/commits"), json={
        "base_rev": before_rev,
        "ops": [{"kind": "update_artifact", "id": art["id"],
                 "payload": {**SNIP, "code": "def step(el):\n    return el\n"}}],
        "lock_tokens": [tok], "message": "edit snippet",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["model_rev"] == before_rev + 1               # project rev moved
    assert body["changed_artifacts"][0]["id"] == art["id"]
    assert body["changed_artifacts"][0]["artifact_rev"] == art["artifact_rev"] + 1
    got = client.get(papi(f"/artifacts/{art['id']}")).json()
    assert "step" in got["payload"]["entry_points"]          # derived metadata ran
    # the lease was auto-released by the commit
    assert client.get(papi("/locks")).json()["leases"] == []
    # journaled: history shows the commit with 1 op
    hist = client.get(papi("/commits")).json()["commits"]
    assert hist[0]["message"] == "edit snippet" and hist[0]["op_count"] == 1


def test_create_needs_no_lock_and_maps_temp_id(client: TestClient) -> None:
    r = client.post(papi("/commits"), json={
        "base_rev": _rev(client),
        "ops": [{"kind": "create_artifact", "temp_id": "tmp_a",
                 "artifact_kind": "code_snippet", "name": "born-in-commit",
                 "payload": SNIP}],
        "lock_tokens": [],
    })
    assert r.status_code == 200, r.text
    aid = r.json()["id_map"]["tmp_a"]
    assert client.get(papi(f"/artifacts/{aid}")).status_code == 200


def test_mixed_batch_atomic_rollback_on_artifact_failure(client: TestClient) -> None:
    # model op valid + artifact op invalid -> whole batch rejected, element NOT created
    before_elements = client.get(papi("/model/summary")).json()["element_count"]
    r = client.post(papi("/commits"), json={
        "base_rev": _rev(client),
        "ops": [
            {"kind": "create_element", "temp_id": "tmp_e", "type_name": "Node",
             "properties": {}},
            {"kind": "delete_artifact", "id": "does-not-exist"},
        ],
        "lock_tokens": [],
    })
    assert r.status_code == 422
    assert client.get(papi("/model/summary")).json()["element_count"] == before_elements


def test_delete_artifact_requires_delete_lock_and_removes_row(client: TestClient) -> None:
    art = _mk_snippet(client, "todelete")
    r = client.post(papi("/locks"),
                    json={"targets": [{"resource_id": art["id"], "mode": "exclusive",
                                       "type": "artifact"}], "intent": "delete"})
    tok = r.json()["token"]
    r = client.post(papi("/commits"), json={
        "base_rev": _rev(client),
        "ops": [{"kind": "delete_artifact", "id": art["id"]}],
        "lock_tokens": [tok],
    })
    assert r.status_code == 200, r.text
    assert r.json()["deleted_artifact_ids"] == [art["id"]]
    assert client.get(papi(f"/artifacts/{art['id']}")).status_code == 404


def test_preview_validates_artifact_ops_without_writes(client: TestClient) -> None:
    art = _mk_snippet(client, "pv")
    r = client.post(papi("/commits/preview"), json={
        "base_rev": _rev(client),
        "ops": [{"kind": "update_artifact", "id": art["id"],
                 "payload": {"schema_version": 1, "language": "ruby", "code": "x"}}],
    })
    assert r.status_code == 422                      # invalid payload caught
    r = client.post(papi("/commits/preview"), json={
        "base_rev": _rev(client),
        "ops": [{"kind": "update_artifact", "id": art["id"],
                 "payload": {**SNIP, "code": "y = 2"}}],
    })
    assert r.status_code == 200, r.text              # valid -> normal preview
    assert client.get(papi(f"/artifacts/{art['id']}")).json()["payload"]["code"] == SNIP["code"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_commits_artifact_ops.py -v`
Expected: FAIL — the Task 3 guard answers 422 where the tests expect 409/200.

- [ ] **Step 3: Refactor `_persist_commit` to explicit lists**

In `routes/ops.py`, change `_persist_commit`'s signature per the Interfaces block (drop `res: _BatchResult`, add `ops`, `inverse_ops`, `id_map`), and inside use `serialize_ops(ops)` / `serialize_ops(inverse_ops)` / `id_map` directly. Update its three call sites mechanically (`apply_ops` in the same file; `create_commit` and `revert_commit` in `commits.py`): `ops=res.canonical_ops, inverse_ops=res.inverse_ops(), id_map=dict(res.id_map)`. Leave `_persist_undo_commit` untouched for now (Task 6 handles undo). Run `pixi run -e core-dev pytest tests/api -q` — everything must still pass before continuing.

- [ ] **Step 4: Wire `create_commit`**

In `routes/commits.py` add imports:

```python
from ..artifact_ops import apply_artifact_ops, split_ops, validate_artifact_ops
from ..feed import artifact_event
from .artifacts import _header as _artifact_header
```

In `create_commit`, replace Task 3's artifact-guard with the real flow. The complete new body of the `with session.write_mutex:` block, replacing steps a–d (KEEP steps e–h and adapt as marked):

```python
    model_ops, artifact_ops = split_ops(payload.ops)
    with session.write_mutex:
        # a. verify the caller still holds every required lock (art: included)
        reqs = required_locks(model, payload.ops)
        missing = session.lock_table.verify_held(
            user.id, payload.lock_tokens, reqs, now=time.monotonic()
        )
        if missing:
            return JSONResponse(  # unchanged 409 body
                ...
            )
        # b. apply model ops (422 on mutation-boundary error — let it propagate)
        res = _apply_batch(model, model_ops, restore=False)
        # b2. apply artifact ops — staged on this request's DB transaction; a
        # failure discards staged rows (db.rollback) AND undoes the in-memory
        # model apply, keeping the mixed batch atomic.
        try:
            art_res = apply_artifact_ops(
                db, project_id, artifact_ops,
                user_id=user.id, id_map=dict(res.id_map), restore=False,
            )
        except HTTPException:
            _rollback(model, res.inverse_units)
            session.invalidate_derived_caches()
            db.rollback()
            raise
        # c. structural gate (model content only; artifact ops are validated
        # at apply and can never be structural blockers) — on reject, also
        # discard the staged artifact rows.
        scoped = default_pipeline().validate(model, res.dirty.to_scope())
        structural = [i for i in scoped if i.category is IssueCategory.STRUCTURAL]
        if structural:
            _rollback(model, res.inverse_units)
            session.invalidate_derived_caches()
            db.rollback()  # discard staged artifact rows
            return JSONResponse(...)  # unchanged 422 body
        # (strict-mode gate unchanged, but ALSO add db.rollback() beside its
        # _rollback call, same reason)
        ...
        # d. commit accepted — merged bookkeeping across both families
        delta = state.replace(res.dirty.ids, scoped)
        session.model_rev += 1
        ...  # cache eviction unchanged (empty model res -> no-op eviction)
        merged_id_map = {**res.id_map, **art_res.id_map}
        canonical_ops: list[OpIn] = [*res.canonical_ops, *art_res.canonical_ops]
        inverse_ops: list[OpIn] = [*res.inverse_ops(), *art_res.inverse_ops()]
        session.record_batch(
            AppliedBatch(ops=canonical_ops, inverse_ops=inverse_ops, id_map=merged_id_map)
        )
        # e. persist — pass the MERGED lists to _persist_commit
        ...
            persisted = _persist_commit(
                db, project_id, rev=session.model_rev, author_id=user.id,
                ops=canonical_ops, inverse_ops=inverse_ops, id_map=merged_id_map,
                _commit_id=commit_id, _message=payload.message,
                _validation_error_count=len(conformance), _issues=issues_json,
            )
        # (the except-path is unchanged: db.rollback() there now also discards
        # the staged artifact rows — add a comment saying so)
```

After step f (periodic snapshot), collect the artifact deltas for response + feed:

```python
        created_ids = set(art_res.id_map.values())
        changed_artifact_headers = []
        for aid in art_res.changed_ids:
            arow = content.get_artifact(db, aid)
            if arow is not None:
                changed_artifact_headers.append(_artifact_header(arow))
```

In step h, pass `scope` to `commit_event` and broadcast artifact events after it:

```python
        scope = sorted(
            ({"model"} if model_ops else set()) | ({"artifact"} if artifact_ops else set())
        ) or ["model"]
        session.hub.broadcast(commit_event(..., scope=scope, ...))
        for h in changed_artifact_headers:
            action = "created" if h.id in created_ids else "updated"
            session.hub.broadcast(artifact_event(action, h.model_dump(mode="json")))
        for d in art_res.deleted:
            session.hub.broadcast(artifact_event("deleted", d))
```

And extend the returned `CommitResponse`:

```python
        changed_artifacts=changed_artifact_headers,
        deleted_artifact_ids=[d["id"] for d in art_res.deleted],
```

In `preview_commit`, replace the Task 3 guard with:

```python
    model_ops, artifact_ops = split_ops(payload.ops)
    validate_artifact_ops(db, project_id, artifact_ops)  # 422/409 on invalid; no writes
```

(add `db: DbSession = Depends(get_db)` to `preview_commit`'s parameters) and pass `model_ops` to `_apply_batch`. `revert_commit` keeps its Task 3 guard (Task 6 refines it).

- [ ] **Step 5: `CommitResponse` + `commit_event` extensions**

`schemas.py` — on `CommitResponse`:

```python
class CommitResponse(OpsResponse):
    commit_id: str
    message: str = ""
    validation_error_count: int = 0
    changed_artifacts: list[ArtifactHeaderOut] = Field(default_factory=list)
    deleted_artifact_ids: list[str] = Field(default_factory=list)
```

`feed.py` — `commit_event` gains a required keyword `scope: list[str]` placed after `rev`, emitted as `"scope": scope` in the dict, with docstring note: `scope` says which content families the commit touched (`model` / `artifact`) so clients refresh only what moved. Update the OTHER callers (`revert_commit` in commits.py) to pass `scope=["model"]`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_commits_artifact_ops.py tests/api/test_commits_route.py tests/api/test_commit_history.py tests/api/test_feed_session.py -v`
Expected: PASS.

- [ ] **Step 7: CHECKPOINT — full suite, lint, commit**

Run: `pixi run core-test` then `pixi run backend-lint`. STOP on any failure.

```bash
git add src/data_rover/api/routes/commits.py src/data_rover/api/routes/ops.py src/data_rover/api/schemas.py src/data_rover/api/feed.py tests/api/test_commits_artifact_ops.py
git commit -m "feat(api): artifact ops through the lock-verified commit flow"
```

---

### Task 6: Undo across artifact ops; revert refuses them

**Files:**
- Modify: `src/data_rover/api/routes/ops.py` (`undo` + `_persist_undo_commit`)
- Modify: `src/data_rover/api/routes/commits.py` (`revert_commit` guard)
- Test: `tests/api/test_undo_artifact_ops.py`

**Interfaces:**
- `_persist_undo_commit` gets the same explicit-list signature as `_persist_commit`: `(db, project_id, *, rev, author_id, ops, inverse_ops, id_map) -> bool`.
- Consumes `split_ops`, `apply_artifact_ops` (restore mode) from Task 4.

- [ ] **Step 1: Write the failing tests**

```python
# tests/api/test_undo_artifact_ops.py
"""Undo of a commit containing artifact ops: the artifact row is restored
(exact id), a compensating forward commit is journaled, and revert refuses
ranges containing artifact ops (Phase 1 boundary)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Node
"""

SNIP = {"schema_version": 1, "language": "python",
        "code": "def value(el):\n    return 1\n"}


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    r = c.post(papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"})
    assert r.status_code == 200, r.text
    r = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert r.status_code == 200, r.text
    return c


def _rev(c: TestClient) -> int:
    return c.get(papi("/model/summary")).json()["model_rev"]


def _commit_create_snippet(c: TestClient, name: str = "s1") -> str:
    r = c.post(papi("/commits"), json={
        "base_rev": _rev(c),
        "ops": [{"kind": "create_artifact", "temp_id": "tmp_a",
                 "artifact_kind": "code_snippet", "name": name, "payload": SNIP}],
        "lock_tokens": [],
    })
    assert r.status_code == 200, r.text
    return r.json()["id_map"]["tmp_a"]


def test_undo_artifact_create_deletes_row_and_moves_rev_forward(client: TestClient) -> None:
    aid = _commit_create_snippet(client)
    rev_after_commit = _rev(client)
    r = client.post(papi("/model/undo"))
    assert r.status_code == 200, r.text
    assert r.json()["model_rev"] == rev_after_commit + 1     # forward compensating commit
    assert client.get(papi(f"/artifacts/{aid}")).status_code == 404


def test_undo_of_undo_restores_exact_id(client: TestClient) -> None:
    aid = _commit_create_snippet(client)
    assert client.post(papi("/model/undo")).status_code == 200   # deletes
    assert client.post(papi("/model/undo")).status_code == 200   # recreates
    assert client.get(papi(f"/artifacts/{aid}")).status_code == 200


def test_revert_across_artifact_commit_409(client: TestClient) -> None:
    base = _rev(client)
    _commit_create_snippet(client, "s-revert")
    r = client.post(papi("/commits/revert"),
                    json={"target_rev": base, "base_rev": _rev(client)})
    assert r.status_code == 409
    assert "artifact" in r.json()["detail"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_undo_artifact_ops.py -v`
Expected: `test_undo_artifact_create...` FAILS with the Task 3 undo guard's 422; the revert test fails with the generic guard message assertion or a non-409.

- [ ] **Step 3: Implement undo**

In `routes/ops.py::undo`, replace the Task 3 guard with real handling:

```python
        batch = session.op_log.pop()
        model_inv, artifact_inv = split_ops(batch.inverse_ops)
        try:
            res = _apply_batch(model, model_inv, restore=True)
        except Exception:
            session.op_log.append(batch)  # _apply_batch already rolled back
            raise
        try:
            art_res = apply_artifact_ops(
                db, project_id, artifact_inv, user_id=user.id, restore=True
            )
        except HTTPException:
            _rollback(model, res.inverse_units)
            session.op_log.append(batch)
            db.rollback()
            raise
```

(import `apply_artifact_ops` at module top). Then merge for the compensating commit exactly like Task 5:

```python
        canonical_ops: list[OpIn] = [*res.canonical_ops, *art_res.canonical_ops]
        inverse_ops: list[OpIn] = [*res.inverse_ops(), *art_res.inverse_ops()]
        merged_id_map = {**res.id_map, **art_res.id_map}
```

change `_persist_undo_commit` to the explicit-list signature (Interfaces above) and pass the merged lists; in the 500-failure except-branch nothing new is needed beyond the existing `db.rollback()` (staged artifact rows are discarded by it — add that comment). `session.model_rev += 1` and cache eviction stay as they are. After a successful persist, broadcast artifact feed events exactly like Task 5 step h (import `artifact_event`, reuse the `_artifact_header` import pattern — `from .artifacts import _header as _artifact_header`).

- [ ] **Step 4: Implement the revert guard**

In `routes/commits.py::revert_commit`, replace the Task 3 guard: inside the `with session.write_mutex:` block, right after the rebind-refusal loop over `commits`, add:

```python
        for c in commits:
            if any(op.get("kind") in ARTIFACT_OP_KINDS for op in c.ops):
                return JSONResponse(
                    status_code=409,
                    content={
                        "detail": "revert across artifact changes is not yet supported",
                        "artifact_commit_rev": c.rev,
                    },
                )
```

(import `ARTIFACT_OP_KINDS` from `..artifact_ops`). The `deserialize_ops(...)` call below then needs no split — the guard guarantees a model-only range; note that in a comment.

- [ ] **Step 5: Run tests, lint, commit**

Run: `pixi run -e core-dev pytest tests/api/test_undo_artifact_ops.py tests/api/test_ops_route.py tests/api/test_commits_revert.py -v` (if `test_ops_route.py` is named differently, run the whole `tests/api` dir)
Expected: PASS. Then `pixi run backend-lint`.

```bash
git add src/data_rover/api/routes/ops.py src/data_rover/api/routes/commits.py tests/api/test_undo_artifact_ops.py
git commit -m "feat(api): undo replays artifact inverses; revert refuses artifact ranges"
```

---

### Task 7: Generalized conflict backstop on POST /commits

Replace strict `base_rev` equality with the spec rule: *a batch conflicts iff the resources it touches overlap the resources touched by commits in `(base_rev, head]`*. Leases prevent conflicts up front; this is the backstop for the legacy-unlocked coexistence window.

**Files:**
- Modify: `src/data_rover/api/routes/commits.py` (`_affected_ids` extension, `_batch_touched_ids`, `create_commit` staleness logic)
- Test: `tests/api/test_commit_conflict_backstop.py`

**Interfaces:**
- `_affected_ids(commits)` now returns artifact resources PREFIXED (`art:<id>`), matching lease resource ids; model ids stay bare.
- New `_batch_touched_ids(model, ops: list[OpIn]) -> set[str]` in `commits.py`.
- Preview keeps strict equality (it is advisory; a stale preview just re-runs).

- [ ] **Step 1: Write the failing tests**

```python
# tests/api/test_commit_conflict_backstop.py
"""The generalized staleness rule: non-overlapping concurrent commits land;
overlapping ones 409. Leases make conflicts rare — this is the backstop."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Node
"""

SNIP = {"schema_version": 1, "language": "python",
        "code": "def value(el):\n    return 1\n"}


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    r = c.post(papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"})
    assert r.status_code == 200, r.text
    r = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert r.status_code == 200, r.text
    return c


def _rev(c: TestClient) -> int:
    return c.get(papi("/model/summary")).json()["model_rev"]


def _commit(c: TestClient, ops: list[dict], base_rev: int):
    return c.post(papi("/commits"),
                  json={"base_rev": base_rev, "ops": ops, "lock_tokens": []})


def test_non_overlapping_stale_commit_lands(client: TestClient) -> None:
    base = _rev(client)  # both clients start here
    r1 = _commit(client, [{"kind": "create_element", "temp_id": "tmp_a",
                           "type_name": "Node", "properties": {}}], base)
    assert r1.status_code == 200, r1.text
    # second client, still at the old base, touches a DIFFERENT resource
    r2 = _commit(client, [{"kind": "create_artifact", "temp_id": "tmp_b",
                           "artifact_kind": "code_snippet", "name": "s",
                           "payload": SNIP}], base)
    assert r2.status_code == 200, r2.text          # would have been 409 before


def test_overlapping_stale_commit_409(client: TestClient) -> None:
    r = _commit(client, [{"kind": "create_artifact", "temp_id": "tmp_b",
                          "artifact_kind": "code_snippet", "name": "s",
                          "payload": SNIP}], _rev(client))
    aid = r.json()["id_map"]["tmp_b"]
    base = _rev(client)
    r1 = _commit(client, [{"kind": "update_artifact", "id": aid,
                           "payload": {**SNIP, "code": "a = 1"}}], base)
    # (no lease held: lock verification only reports MISSING locks the caller
    # needs; with none required-held this proceeds — acquire one to pass)
    if r1.status_code == 409 and "missing" in r1.text:
        tok = client.post(papi("/locks"),
                          json={"targets": [{"resource_id": aid, "mode": "exclusive",
                                             "type": "artifact"}], "intent": "edit"}
                          ).json()["token"]
        r1 = client.post(papi("/commits"),
                         json={"base_rev": base,
                               "ops": [{"kind": "update_artifact", "id": aid,
                                        "payload": {**SNIP, "code": "a = 1"}}],
                               "lock_tokens": [tok]})
    assert r1.status_code == 200, r1.text
    # a second writer still at `base` touching the SAME artifact -> 409
    tok2 = client.post(papi("/locks"),
                       json={"targets": [{"resource_id": aid, "mode": "exclusive",
                                          "type": "artifact"}], "intent": "edit"}
                       ).json()["token"]
    r2 = client.post(papi("/commits"),
                     json={"base_rev": base,
                           "ops": [{"kind": "update_artifact", "id": aid,
                                    "payload": {**SNIP, "code": "b = 2"}}],
                           "lock_tokens": [tok2]})
    assert r2.status_code == 409
    assert r2.json()["detail"] == "conflicting concurrent commits"


def test_future_base_rev_still_409(client: TestClient) -> None:
    r = _commit(client, [], _rev(client) + 5)
    assert r.status_code == 409
```

Note: the update path always requires an `art:` lease (Task 5), so the test acquires tokens where needed; the important assertions are the final 200 and 409.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_commit_conflict_backstop.py -v`
Expected: `test_non_overlapping_stale_commit_lands` FAILS (r2 gets 409 "stale base_rev").

- [ ] **Step 3: Implement**

In `routes/commits.py`:

1. Extend `_affected_ids` (artifact ops prefix; keep model behavior identical):

```python
def _affected_ids(commits: list[Commit]) -> set[str]:
    """Resource ids touched by the forward ops of these commits. Model ids
    are bare; artifact ids carry the lease namespace (art:<id>) so the sets
    compare directly against lease resource ids and _batch_touched_ids."""
    ids: set[str] = set()
    for c in commits:
        for op in c.ops:
            if op.get("kind") in ARTIFACT_OP_KINDS:
                for key in ("id", "temp_id"):
                    v = op.get(key)
                    if isinstance(v, str):
                        ids.add(ARTIFACT_PREFIX + v)
                continue
            for key in _ID_KEYS:
                v = op.get(key)
                if isinstance(v, str):
                    ids.add(v)
    return ids
```

(imports: `ARTIFACT_OP_KINDS` from `..artifact_ops`, `ARTIFACT_PREFIX` + op classes from below.)

2. Add `_batch_touched_ids`:

```python
def _batch_touched_ids(model, ops: list[OpIn]) -> set[str]:
    """Conservative touched-set for the conflict backstop: the lock-derived
    resources (elements incl. delete subtrees, art: resources) plus raw
    relationship/endpoint ids, which locks abstract to source elements but
    journal rows record directly."""
    ids = {r.resource_id for r in required_locks(model, ops)}
    for op in ops:
        if isinstance(op, (UpdateElementOp, DeleteElementOp,
                           UpdateRelationshipOp, DeleteRelationshipOp)):
            ids.add(op.id)
        elif isinstance(op, CreateRelationshipOp):
            ids.add(op.source_id)
            ids.add(op.target_id)
        elif isinstance(op, (UpdateArtifactOp, DeleteArtifactOp)):
            ids.add(ARTIFACT_PREFIX + op.id)
    return {i for i in ids if not i.startswith("tmp_")}
```

(import the op classes and `ARTIFACT_PREFIX`, `required_locks` is already imported).

3. In `create_commit`, replace the strict check:

```python
    if payload.base_rev > session.model_rev:
        return JSONResponse(
            status_code=409,
            content={"detail": "stale base_rev", "model_rev": session.model_rev},
        )
    if payload.base_rev < session.model_rev:
        # Generalized staleness (spec 2026-07-29): conflict iff this batch's
        # touched resources overlap what landed in (base_rev, head]. Requires
        # a durable journal to inspect; projects without one keep the strict
        # rule. A rebind in the tail always conflicts (the metamodel changed
        # under the client — element ops were computed against the old one).
        if content.get_model_row(db, project_id) is None:
            return JSONResponse(
                status_code=409,
                content={"detail": "stale base_rev", "model_rev": session.model_rev},
            )
        tail = content.commits_after(db, project_id, payload.base_rev)
        if any(c.from_metamodel_id is not None or c.to_metamodel_id is not None
               for c in tail):
            return JSONResponse(
                status_code=409,
                content={"detail": "stale base_rev", "model_rev": session.model_rev},
            )
        if _affected_ids(tail) & _batch_touched_ids(model, payload.ops):
            return JSONResponse(
                status_code=409,
                content={"detail": "conflicting concurrent commits",
                         "model_rev": session.model_rev},
            )
```

The overlap check runs BEFORE the mutex (like the old strict check); the lock verification inside the mutex remains the authoritative gate.

- [ ] **Step 4: Run tests, lint, commit**

Run: `pixi run -e core-dev pytest tests/api/test_commit_conflict_backstop.py tests/api/test_commits_route.py tests/api/test_commits_artifact_ops.py -v`
Expected: PASS (note: existing tests asserting 409-on-any-stale-base may exist in `test_commits_route.py` — if one now gets 200 because its batch does NOT overlap, that is the intended new behavior; update THAT assertion and say so in the commit message, this is the one sanctioned test change).

```bash
git add src/data_rover/api/routes/commits.py tests/api/test_commit_conflict_backstop.py
git commit -m "feat(api): overlap-based conflict backstop for POST /commits"
```

---

### Task 8: Commit diff API — GET /commits/{rev}/diff (CHECKPOINT)

One endpoint that renders any commit's changes: elements/relationships via before/after reconstruction, artifacts via journal ops (full-state inverses make this journal-only), plus `scope` and rebind flagging. This is the seam the future CR workflow reuses.

**Files:**
- Create: `src/data_rover/api/commit_diff.py`
- Modify: `src/data_rover/api/content.py` (`get_commit`)
- Modify: `src/data_rover/api/schemas.py` (diff response schemas)
- Modify: `src/data_rover/api/routes/commits.py` (route)
- Test: `tests/api/test_commit_diff.py`

**Interfaces:**

```python
# content.py
def get_commit(db, project_id: str, rev: int) -> Commit | None

# schemas.py
class JsonChangeOut(BaseModel):
    path: str            # dotted key path, "$" for the document root
    before: Any = None
    after: Any = None

class ArtifactDiffAddedOut(BaseModel):
    id: str; kind: str; name: str; payload: dict[str, Any]
class ArtifactDiffModifiedOut(BaseModel):
    id: str; kind: str; name_before: str; name_after: str
    changes: list[JsonChangeOut]
class ArtifactDiffDeletedOut(BaseModel):
    id: str; kind: str; name: str; payload: dict[str, Any]
class CommitArtifactDiffs(BaseModel):
    added: list[ArtifactDiffAddedOut]; modified: list[ArtifactDiffModifiedOut]
    deleted: list[ArtifactDiffDeletedOut]

class CommitDiffOut(BaseModel):
    rev: int; commit_id: str; author_id: str | None; ts: datetime; message: str
    scope: list[str]; is_rebind: bool
    elements: CrElementOps            # REUSED CR shapes (before/after entities)
    relationships: CrRelationshipOps
    artifacts: CommitArtifactDiffs

# commit_diff.py
def json_structural_diff(before: Any, after: Any, path: str = "") -> list[JsonChangeOut]
def diff_commit(db, project_id: str, commit: Commit) -> CommitDiffOut
```

- [ ] **Step 1: Write the failing tests**

```python
# tests/api/test_commit_diff.py
"""GET /commits/{rev}/diff renders element AND artifact changes from the
journal; json_structural_diff pins the path-level artifact payload diff."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.commit_diff import json_structural_diff
from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project

# NOTE: before using this, check the exact property-declaration YAML shape
# against examples/smart-city.metamodel.yaml (key names for datatype may
# differ) and adjust _MM to match — the test needs one string property.
_MM = """
elements:
  - name: Node
    properties:
      - name: label
        datatype: string
"""

SNIP = {"schema_version": 1, "language": "python",
        "code": "def value(el):\n    return 1\n"}


def test_json_structural_diff_paths() -> None:
    changes = json_structural_diff(
        {"a": 1, "b": {"c": 2, "d": 3}, "e": [1, 2]},
        {"a": 1, "b": {"c": 9, "d": 3}, "e": [1, 3], "f": 4},
    )
    by_path = {c.path: c for c in changes}
    assert set(by_path) == {"b.c", "e", "f"}
    assert by_path["b.c"].before == 2 and by_path["b.c"].after == 9
    assert by_path["e"].before == [1, 2]        # lists compare wholesale
    assert by_path["f"].before is None and by_path["f"].after == 4


def test_json_structural_diff_equal_is_empty() -> None:
    assert json_structural_diff({"x": [1]}, {"x": [1]}) == []


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    r = c.post(papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"})
    assert r.status_code == 200, r.text
    r = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert r.status_code == 200, r.text
    return c


def _rev(c: TestClient) -> int:
    return c.get(papi("/model/summary")).json()["model_rev"]


def test_diff_of_mixed_commit(client: TestClient) -> None:
    r = client.post(papi("/commits"), json={
        "base_rev": _rev(client),
        "ops": [
            {"kind": "create_element", "temp_id": "tmp_e", "type_name": "Node",
             "properties": {"label": "n1"}},
            {"kind": "create_artifact", "temp_id": "tmp_a",
             "artifact_kind": "code_snippet", "name": "s1", "payload": SNIP},
        ],
        "lock_tokens": [],
    })
    assert r.status_code == 200, r.text
    rev = r.json()["model_rev"]
    aid = r.json()["id_map"]["tmp_a"]
    d = client.get(papi(f"/commits/{rev}/diff"))
    assert d.status_code == 200, d.text
    body = d.json()
    assert sorted(body["scope"]) == ["artifact", "model"]
    assert len(body["elements"]["added"]) == 1
    assert body["elements"]["added"][0]["properties"]["label"] == "n1"
    assert body["artifacts"]["added"][0]["id"] == aid
    assert body["artifacts"]["added"][0]["kind"] == "code_snippet"


def test_diff_of_artifact_update_has_path_changes(client: TestClient) -> None:
    r = client.post(papi("/commits"), json={
        "base_rev": _rev(client),
        "ops": [{"kind": "create_artifact", "temp_id": "tmp_a",
                 "artifact_kind": "code_snippet", "name": "s1", "payload": SNIP}],
        "lock_tokens": [],
    })
    aid = r.json()["id_map"]["tmp_a"]
    tok = client.post(papi("/locks"),
                      json={"targets": [{"resource_id": aid, "mode": "exclusive",
                                         "type": "artifact"}], "intent": "edit"}
                      ).json()["token"]
    r = client.post(papi("/commits"), json={
        "base_rev": _rev(client),
        "ops": [{"kind": "update_artifact", "id": aid,
                 "payload": {**SNIP, "code": "def value(el):\n    return 2\n"}}],
        "lock_tokens": [tok],
    })
    assert r.status_code == 200, r.text
    d = client.get(papi(f"/commits/{r.json()['model_rev']}/diff")).json()
    mod = d["artifacts"]["modified"][0]
    assert mod["id"] == aid and mod["kind"] == "code_snippet"
    paths = {c["path"] for c in mod["changes"]}
    assert "code" in paths


def test_diff_of_element_update_and_delete(client: TestClient) -> None:
    r = client.post(papi("/commits"), json={
        "base_rev": _rev(client),
        "ops": [{"kind": "create_element", "temp_id": "tmp_e", "type_name": "Node",
                 "properties": {"label": "before"}}],
        "lock_tokens": [],
    })
    eid = r.json()["id_map"]["tmp_e"]
    r = client.post(papi("/commits"), json={
        "base_rev": _rev(client),
        "ops": [{"kind": "update_element", "id": eid,
                 "properties_patch": {"label": "after"}}],
        "lock_tokens": [],
    })
    assert r.status_code in (200, 409)
    if r.status_code == 409:  # needs the element lease
        tok = client.post(papi("/locks"),
                          json={"targets": [{"resource_id": eid, "mode": "exclusive"}],
                                "intent": "edit"}).json()["token"]
        r = client.post(papi("/commits"), json={
            "base_rev": _rev(client),
            "ops": [{"kind": "update_element", "id": eid,
                     "properties_patch": {"label": "after"}}],
            "lock_tokens": [tok]})
        assert r.status_code == 200, r.text
    d = client.get(papi(f"/commits/{r.json()['model_rev']}/diff")).json()
    mod = d["elements"]["modified"][0]
    assert mod["before"]["properties"]["label"] == "before"
    assert mod["after"]["properties"]["label"] == "after"


def test_diff_unknown_rev_404(client: TestClient) -> None:
    assert client.get(papi("/commits/999/diff")).status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_commit_diff.py -v`
Expected: FAIL with `ModuleNotFoundError: ... commit_diff`

- [ ] **Step 3: Implement**

1. `content.py`:

```python
def get_commit(db: Session, project_id: str, rev: int) -> Commit | None:
    return db.execute(
        select(Commit).where(Commit.project_id == project_id, Commit.rev == rev)
    ).scalar_one_or_none()
```

2. `schemas.py`: add the diff schemas from the Interfaces block (place after the commit-history schemas; `CrElementOps`/`CrRelationshipOps` already exist earlier in the file).
3. `src/data_rover/api/commit_diff.py`:

```python
"""Per-commit diff rendering (Phase 1 artefacts revamp).

Model entities: reconstruct the model at rev-1 and rev (same machinery and
cost class as GET /commits/{rev}/model) and compare only the entity ids the
commit's ops name — correct for cold projects and O(model) per request,
which the history UI tolerates like the model-at-rev endpoint.

Artifacts: journal-only. Canonical artifact ops carry full AFTER state and
their inverses full BEFORE state (the applier's invariant), so before/after
per artifact id falls out of simulating the forward ops from the inverse-
derived base — no row access, hence correct even for artifacts deleted or
re-edited since.

This module is deliberately route-free: the future CR workflow points these
functions at a draft instead of a commit."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session as DbSession

from .artifact_ops import ARTIFACT_OP_KINDS, split_ops
from .db_models import Commit
from .hydration import deserialize_ops, reconstruct_model_at
from .schemas import (
    ArtifactDiffAddedOut,
    ArtifactDiffDeletedOut,
    ArtifactDiffModifiedOut,
    CommitArtifactDiffs,
    CommitDiffOut,
    CrElementOps,
    CrRelationshipOps,
    CreateArtifactOp,
    DeleteArtifactOp,
    ElementOut,
    JsonChangeOut,
    ModifiedElementOut,
    ModifiedRelationshipOut,
    RelationshipOut,
    UpdateArtifactOp,
)

_EL_KINDS = frozenset({"create_element", "update_element", "delete_element"})
_REL_KINDS = frozenset(
    {"create_relationship", "update_relationship", "delete_relationship"}
)


def json_structural_diff(before: Any, after: Any, path: str = "") -> list[JsonChangeOut]:
    """Path-level structural diff of two JSON values. Dicts recurse over the
    union of keys; ANY other difference (scalars, lists, type changes) is one
    change at the current path — lists compare wholesale on purpose, a
    reordered list is one human-reviewable change, not N index noise."""
    if before == after:
        return []
    if isinstance(before, dict) and isinstance(after, dict):
        out: list[JsonChangeOut] = []
        for key in sorted(set(before) | set(after)):
            sub = f"{path}.{key}" if path else key
            out.extend(json_structural_diff(before.get(key), after.get(key), sub))
        return out
    return [JsonChangeOut(path=path or "$", before=before, after=after)]


def _entity_ids(raw_ops: list[dict[str, Any]], kinds: frozenset[str]) -> set[str]:
    """Ids named by ops of the given family, across forward AND inverse ops
    (cascade deletions surface as recreate ops on the inverse side only)."""
    ids: set[str] = set()
    for op in raw_ops:
        if op.get("kind") in kinds:
            for key in ("id", "temp_id"):
                v = op.get(key)
                if isinstance(v, str):
                    ids.add(v)
    return ids


def _artifact_states(
    commit: Commit,
) -> tuple[dict[str, dict[str, Any] | None], dict[str, dict[str, Any] | None], dict[str, str]]:
    """(before, after, kind_by_id) per artifact id, from the journal alone."""
    before: dict[str, dict[str, Any] | None] = {}
    kinds: dict[str, str] = {}
    # flat inverse list = reversed units; iterating in order and overwriting
    # leaves the LAST occurrence per id = the earliest unit = true pre-state.
    _, inverse_artifact_ops = split_ops(deserialize_ops(commit.inverse_ops))
    for op in inverse_artifact_ops:
        if isinstance(op, CreateArtifactOp):  # forward deleted it
            before[op.temp_id] = {"name": op.name, "payload": op.payload}
            kinds[op.temp_id] = op.artifact_kind
        elif isinstance(op, UpdateArtifactOp):
            before[op.id] = {"name": op.name or "", "payload": op.payload or {}}
        elif isinstance(op, DeleteArtifactOp):  # forward created it
            before[op.id] = None
    after: dict[str, dict[str, Any] | None] = {
        aid: (dict(state) if state is not None else None)
        for aid, state in before.items()
    }
    _, forward_artifact_ops = split_ops(deserialize_ops(commit.ops))
    for op in forward_artifact_ops:
        if isinstance(op, CreateArtifactOp):
            after[op.temp_id] = {"name": op.name, "payload": op.payload}
            kinds[op.temp_id] = op.artifact_kind
        elif isinstance(op, UpdateArtifactOp):
            prev = after.get(op.id) or {"name": "", "payload": {}}
            after[op.id] = {
                "name": op.name if op.name is not None else prev["name"],
                "payload": op.payload if op.payload is not None else prev["payload"],
            }
        elif isinstance(op, DeleteArtifactOp):
            after[op.id] = None
    return before, after, kinds


def diff_commit(db: DbSession, project_id: str, commit: Commit) -> CommitDiffOut:
    raw = list(commit.ops) + list(commit.inverse_ops)
    el_ids = _entity_ids(raw, _EL_KINDS)
    rel_ids = _entity_ids(raw, _REL_KINDS)

    m_before = reconstruct_model_at(project_id, commit.rev - 1)
    m_after = reconstruct_model_at(project_id, commit.rev)
    b_el = m_before.elements if m_before is not None else {}
    a_el = m_after.elements if m_after is not None else {}
    b_rel = m_before.relationships if m_before is not None else {}
    a_rel = m_after.relationships if m_after is not None else {}

    elements = CrElementOps()
    for eid in sorted(el_ids):
        b, a = b_el.get(eid), a_el.get(eid)
        if b is None and a is not None:
            elements.added.append(ElementOut.from_core(a))
        elif b is not None and a is None:
            elements.deleted.append(ElementOut.from_core(b))
        elif b is not None and a is not None:
            bo, ao = ElementOut.from_core(b), ElementOut.from_core(a)
            if bo != ao:
                elements.modified.append(ModifiedElementOut(id=eid, before=bo, after=ao))

    relationships = CrRelationshipOps()
    for rid in sorted(rel_ids):
        b, a = b_rel.get(rid), a_rel.get(rid)
        if b is None and a is not None:
            relationships.added.append(RelationshipOut.from_core(a))
        elif b is not None and a is None:
            relationships.deleted.append(RelationshipOut.from_core(b))
        elif b is not None and a is not None:
            bo, ao = RelationshipOut.from_core(b), RelationshipOut.from_core(a)
            if bo != ao:
                relationships.modified.append(
                    ModifiedRelationshipOut(id=rid, before=bo, after=ao)
                )

    art_before, art_after, art_kinds = _artifact_states(commit)
    artifacts = CommitArtifactDiffs(added=[], modified=[], deleted=[])
    for aid in sorted(set(art_before) | set(art_after)):
        b, a = art_before.get(aid), art_after.get(aid)
        kind = art_kinds.get(aid) or _kind_from_row(db, aid)
        if b is None and a is not None:
            artifacts.added.append(
                ArtifactDiffAddedOut(id=aid, kind=kind, name=a["name"], payload=a["payload"])
            )
        elif b is not None and a is None:
            artifacts.deleted.append(
                ArtifactDiffDeletedOut(id=aid, kind=kind, name=b["name"], payload=b["payload"])
            )
        elif b is not None and a is not None and b != a:
            artifacts.modified.append(
                ArtifactDiffModifiedOut(
                    id=aid, kind=kind, name_before=b["name"], name_after=a["name"],
                    changes=json_structural_diff(b["payload"], a["payload"]),
                )
            )

    has_artifact = any(op.get("kind") in ARTIFACT_OP_KINDS for op in commit.ops)
    has_model = any(op.get("kind") not in ARTIFACT_OP_KINDS for op in commit.ops)
    is_rebind = commit.from_metamodel_id is not None or commit.to_metamodel_id is not None
    scope = sorted(
        ({"model"} if has_model or is_rebind else set())
        | ({"artifact"} if has_artifact else set())
    ) or ["model"]
    return CommitDiffOut(
        rev=commit.rev, commit_id=commit.commit_id, author_id=commit.author_id,
        ts=commit.ts, message=commit.message, scope=scope, is_rebind=is_rebind,
        elements=elements, relationships=relationships, artifacts=artifacts,
    )
```

Also add this helper above `diff_commit` (kind resolution for update-only commits — the applier's update inverse carries no kind; the row lookup works because kind is immutable, and the `"unknown"` fallback only remains for an artifact deleted by a LATER commit):

```python
def _kind_from_row(db: DbSession, artifact_id: str) -> str:
    from . import content  # local import: commit_diff must stay route-free

    row = content.get_artifact(db, artifact_id)
    return row.kind.value if row is not None else "unknown"
```

Check the actual field names of `Commit` (`ts`, `commit_id`, `author_id`) against `db_models.py` before writing; adjust if they differ.

4. Route in `routes/commits.py`:

```python
@router.get("/commits/{rev}/diff", response_model=None)
def commit_diff_endpoint(
    rev: int,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> CommitDiffOut | JSONResponse:
    """Render one commit's changes across content families (spec 2026-07-29,
    Phase 1 diff API). Read endpoint — any member. O(model) like
    /commits/{rev}/model; the CR workflow will reuse diff_commit directly."""
    row = content.get_commit(db, project_id, rev)
    if row is None:
        return JSONResponse(status_code=404, content={"detail": "no commit at this rev"})
    return diff_commit(db, project_id, row)
```

(imports: `from ..commit_diff import diff_commit`, `CommitDiffOut` from `..schemas`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_commit_diff.py tests/api/test_commit_model_at.py -v`
Expected: PASS.

- [ ] **Step 5: CHECKPOINT — full suite, lint, commit**

Run: `pixi run core-test` then `pixi run backend-lint`. STOP on any failure.

```bash
git add src/data_rover/api/commit_diff.py src/data_rover/api/content.py src/data_rover/api/schemas.py src/data_rover/api/routes/commits.py tests/api/test_commit_diff.py
git commit -m "feat(api): GET /commits/{rev}/diff across model and artifact scopes"
```

---

### Task 9: Final verification and docs (CHECKPOINT)

- [ ] **Step 1: Full verification sweep**

Run, in order, and confirm each is clean:
1. `pixi run dr-tidy` (then `git diff --stat` — if the formatter changed files, re-run the api tests and include the changes in this task's commit)
2. `pixi run core-test`
3. `pixi run backend-lint`
4. Invariant greps (each must return NOTHING):
   - `grep -n "ArtifactOpIn" src/data_rover/api/routes/ops.py | grep -v split_ops | grep -v import | grep -v ModelOpIn` — the model applier never handles artifact ops
   - `grep -rn "create_artifact\|update_artifact\|delete_artifact" src/data_rover/core/` — core stays artifact-op free

- [ ] **Step 2: Update CLAUDE.md**

In the Phase 4 section of `CLAUDE.md` (after the `/model/ops` legacy note), add one paragraph:

```markdown
- **Artifact ops (artefacts revamp Phase 1)** — `create_artifact`/`update_artifact`/`delete_artifact` join the `OpIn` union and flow ONLY through `POST /commits` (lock-verified, `art:<id>` leases from the typed lock namespace in `locking.py`); `/model/ops` rejects them permanently. They are applied to `ArtifactRow`s by `api/artifact_ops.py` on the request's DB transaction (materialized heads; model hydration replay SKIPS them via `split_ops`), with full-state inverses so undo and `GET /commits/{rev}/diff` are journal-only. The kind registry lives in `api/artifact_kinds.py` (`ArtifactKindSpec`: adapter + derived metadata + deps/ref-rewrite for the Phase 3 export closure). Commit staleness is now overlap-based (a stale `base_rev` only 409s when the batch's touched resources intersect the journal tail); commit feed events carry a `scope` list. Legacy `PUT /artifacts/{id}` stays alive for the frontend migration window. Spec: `docs/superpowers/specs/2026-07-29-artefacts-revamp-design.md`.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: artifact ops, typed locks, and commit diff in CLAUDE.md"
```

- [ ] **Step 4: Report**

Produce a summary for the user: tasks completed, test counts before/after, any sanctioned test change (Task 7), any deviation from this plan (there should be none without a STOP-and-report having happened).

---

## Out of scope for this plan (later plans in the same program)

- Frontend: artifact-editor lease acquisition, `ops.ts` mirror of the artifact op union, commit-flow saves, feed `scope` handling (Phase 1 frontend plan).
- View ops, folder ids, folder leases (Phase 2).
- Import/export bundles, clone fix (Phase 3 — consumes `extract_deps`/`rewrite_refs` from Task 1).
- Metamodel `mm` lease enforcement on rebind + structural YAML diff (Phase 4; the `mm` resource name is already reserved by Task 2).
- Artifact revert support (`/commits/revert` across artifact commits — currently a clean 409).
