# Artefacts Phase 3 — Import/Export Closure (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Artifact bundle export with dependency closure, stateless plan→confirm import landing as one journaled commit, and artifact-carrying clone/baseline import (fixes the silent artifact drop in `clone_project`).

**Architecture:** New `api/artifact_bundle.py` holds the `datarover.artifact-bundle/v1` pydantic envelope, the BFS closure over `ArtifactKindSpec.extract_deps`, plan derivation ((kind,name) clash + payload-aware reuse/copy proposal), and import-op building. New `routes/artifact_bundle.py` mounts four routes under the project prefix; the confirm route delegates to the existing `create_commit` (one journaled, undoable, diffable commit; no leases — fresh-id creates only). `importer.import_project` gains an `artifact_bundle` parameter used by clone, the CLI, and the project-creation wizard.

**Tech Stack:** FastAPI, pydantic v2, SQLAlchemy 2.0 (sync), pytest with the hermetic in-memory-SQLite conftest in `tests/api/`.

**Spec:** `docs/superpowers/specs/2026-08-08-artefacts-phase-3-import-export-design.md` — read it first.

## Global Constraints

- Everything runs through pixi: `pixi run -e core-dev pytest tests/api/test_x.py -q`. There is no global `python`.
- Gates that must pass before the branch is done: `pixi run core-test`, `pixi run dr-tidy`, `pixi run backend-lint` (ruff + mypy + pyright all three).
- Work on branch `feature/artefacts-phase-3-import-export` off `main`. Commit after every task (steps say when).
- **Never send an empty commit batch** through `POST /commits` / `create_commit` — the empty-batch early return must never be minted by our code. The confirm route returns a no-op response instead.
- **No OCC / rev preconditions** on artifact ops (CLAUDE.md "Lease rule"). Import creates need **no leases** (fresh-id rule).
- Bundle `kind` is a **raw string** in the envelope (unknown kinds must parse); it becomes `ArtifactKind` only at the point of storage.
- Tolerant-skip stance: per-artifact problems (unknown kind, adapter-invalid payload) are reported and skipped, never a hard failure. Only a malformed envelope 422s.
- Preserve the dense invariant-comment style of the codebase in new modules.
- Python 3.14 idioms (PEP 604 unions, `datetime.UTC`); ruff `UP` rules are on.
- Import as `from data_rover.api...` in tests (`pythonpath=src`).

## Existing interfaces you will use (verified against the tree at `707f6d6`)

- `api/artifact_kinds.py`: `get_spec(kind: ArtifactKind) -> ArtifactKindSpec | None`; `extract_refs(payload) -> set[str]` (generic walk, kind-agnostic); `rewrite_refs(payload, id_map) -> Any` (pure, unknown refs pass through); `ArtifactKindSpec.extract_deps` / `.rewrite_refs` / `.adapter` / `.derive_metadata`.
- `api/schemas.py`: `TEMP_ID_PREFIX = "tmp_"`; `CreateArtifactOp(kind="create_artifact", temp_id, artifact_kind, name, payload)`; `CommitRequest(base_rev, ops, message, lock_tokens, ack_errors)`; `CommitResponse` (extends `OpsResponse`: has `model_rev: int`, `id_map: dict[str, str]`, `changed_artifacts`).
- `api/content.py`: `get_artifact(db, artifact_id) -> ArtifactRow | None`; `find_artifact(db, project_id, kind, name) -> ArtifactRow | None`; `list_artifacts(db, project_id, kind=None) -> list[ArtifactRow]`; `create_artifact(db, project_id, *, kind, name, payload, updated_by, artifact_id=None) -> ArtifactRow`.
- `api/db_models.py`: `ArtifactRow` (`id`, `project_id`, `kind: ArtifactKind`, `name`, `payload: dict`), unique on `(project_id, kind, name)`; `ArtifactKind` enum (`navigation`, `table`, `diagram`, `diagram_kind`, `code_snippet`).
- `routes/commits.py::create_commit(payload: CommitRequest, project_id: str, session: Session, db: DbSession, user: User) -> CommitResponse | JSONResponse` — plain function; call it directly with resolved dependencies. Raises `HTTPException(422)` when the batch is rejected at apply (including the applier's `_ClashTracker` (kind,name) clash check) with full rollback already done.
- `core/view/schema.py`: `View(name, folders, artifacts)`, `Folder(id, name, folders, elements, artifacts)`, `ArtifactRef(id, kind)`.
- `api/importer.py::import_project(*, project_id, name, owner_id, metamodel_yaml, model_json, view_json=None)`.
- Test helpers (`tests/api/conftest.py`): `client` fixture (header-auth `TestClient`, default project seeded), `papi(path)` → `/api/v1/projects/default{path}`, `AUTH_HEADERS`, `seed_default_project()`. Content-layer tests use `db.init_engine("sqlite://", force=True); db.create_all()` directly (pattern: `tests/api/test_content.py::_setup`).

## File Structure

- Create `src/data_rover/api/artifact_bundle.py` — envelope schema, closure, plan derivation, op building (pure-ish; DB access only via `content` helpers).
- Create `src/data_rover/api/routes/artifact_bundle.py` — 4 routes: `POST /artifacts/export`, `POST /artifacts/export/preview`, `POST /artifacts/import/plan`, `POST /artifacts/import`.
- Create `tests/api/test_artifact_bundle.py` (module-level logic) and `tests/api/test_artifact_bundle_routes.py` (HTTP).
- Modify `src/data_rover/api/main.py` (mount router), `src/data_rover/api/authz.py` (read-only allowlist), `src/data_rover/api/importer.py` (+`artifact_bundle` param, CLI flag), `src/data_rover/api/routes/projects.py` (clone + wizard multipart).
- Modify tests: `tests/api/test_project_clone.py`, `tests/api/test_importer.py`, `tests/api/test_projects_wizard.py`, `tests/api/test_authz.py` (if it enumerates the allowlist).

---

### Task 1: Bundle envelope + dependency closure

**Files:**
- Create: `src/data_rover/api/artifact_bundle.py`
- Test: `tests/api/test_artifact_bundle.py`

**Interfaces:**
- Consumes: `artifact_kinds.get_spec/extract_refs`, `content.get_artifact`, `db_models.ArtifactRow/Project`.
- Produces (later tasks rely on these exact names):
  - `BUNDLE_FORMAT = "datarover.artifact-bundle/v1"`
  - `class BundleSourceProject(BaseModel)`: `id: str`, `name: str`
  - `class BundleArtifact(BaseModel)`: `id: str`, `kind: str`, `name: str`, `payload: dict[str, Any]`
  - `class ArtifactBundle(BaseModel)`: `format: Literal["datarover.artifact-bundle/v1"]`, `exported_at: str`, `source_project: BundleSourceProject`, `roots: list[str]`, `artifacts: list[BundleArtifact]`
  - `@dataclass(frozen=True) class ClosureResult`: `rows: list[ArtifactRow]`, `dangling_refs: list[str]`
  - `def row_deps(row: ArtifactRow) -> set[str]`
  - `def compute_closure(db: DbSession, project_id: str, root_ids: Sequence[str]) -> ClosureResult`
  - `def build_bundle(project: Project, closure: ClosureResult, roots: Sequence[str]) -> ArtifactBundle`

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feature/artefacts-phase-3-import-export main
```

- [ ] **Step 2: Write the failing tests**

Create `tests/api/test_artifact_bundle.py`:

```python
"""Bundle module tests: envelope schema, dependency closure, plan derivation.

Setup mirrors tests/api/test_content.py: hermetic in-memory SQLite via
db.init_engine + create_all; rows created through content helpers so the
(project, kind, name) unique constraint is live.
"""

from __future__ import annotations

from data_rover.api import content, db
from data_rover.api.artifact_bundle import (
    BUNDLE_FORMAT,
    ArtifactBundle,
    build_bundle,
    compute_closure,
)
from data_rover.api.db_models import ArtifactKind, Project

SNIP = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return el.name\n"}


def _nav(ref: str) -> dict:
    """Minimal valid navigation payload referencing another artifact."""
    return {"kind": "set_op", "op": "union", "operands": [{"ref": ref}]}


def _setup() -> None:
    db.init_engine("sqlite://", force=True)
    db.create_all()
    with db.db_session() as s:
        s.add(Project(id="p1", name="P1"))


def test_closure_follows_chain_and_dedups_diamond() -> None:
    _setup()
    with db.db_session() as s:
        snip = content.create_artifact(
            s, "p1", kind=ArtifactKind.code_snippet, name="s", payload=SNIP, updated_by=None
        )
        nav_a = content.create_artifact(
            s, "p1", kind=ArtifactKind.navigation, name="a", payload=_nav(snip.id), updated_by=None
        )
        nav_b = content.create_artifact(
            s, "p1", kind=ArtifactKind.navigation, name="b", payload=_nav(snip.id), updated_by=None
        )
        res = compute_closure(s, "p1", [nav_a.id, nav_b.id])
        # diamond: both navs depend on the same snippet; it appears ONCE
        assert [r.id for r in res.rows] == [nav_a.id, nav_b.id, snip.id]
        assert res.dangling_refs == []


def test_closure_tolerates_cycles() -> None:
    _setup()
    with db.db_session() as s:
        a = content.create_artifact(
            s, "p1", kind=ArtifactKind.navigation, name="a", payload=_nav("placeholder"), updated_by=None
        )
        b = content.create_artifact(
            s, "p1", kind=ArtifactKind.navigation, name="b", payload=_nav(a.id), updated_by=None
        )
        content.update_artifact(s, content.get_artifact(s, a.id), payload=_nav(b.id))
        res = compute_closure(s, "p1", [a.id])
        assert {r.id for r in res.rows} == {a.id, b.id}


def test_closure_reports_dangling_and_unknown_roots() -> None:
    _setup()
    with db.db_session() as s:
        nav = content.create_artifact(
            s, "p1", kind=ArtifactKind.navigation, name="a", payload=_nav("ghost"), updated_by=None
        )
        res = compute_closure(s, "p1", [nav.id, "no-such-root"])
        assert [r.id for r in res.rows] == [nav.id]
        assert res.dangling_refs == sorted(["ghost", "no-such-root"])


def test_closure_ignores_other_projects_rows() -> None:
    _setup()
    with db.db_session() as s:
        s.add(Project(id="p2", name="P2"))
        s.flush()
        foreign = content.create_artifact(
            s, "p2", kind=ArtifactKind.code_snippet, name="s", payload=SNIP, updated_by=None
        )
        nav = content.create_artifact(
            s, "p1", kind=ArtifactKind.navigation, name="a", payload=_nav(foreign.id), updated_by=None
        )
        res = compute_closure(s, "p1", [nav.id])
        # a ref crossing projects is dangling, not followed
        assert [r.id for r in res.rows] == [nav.id]
        assert res.dangling_refs == [foreign.id]


def test_build_bundle_roundtrips_through_schema() -> None:
    _setup()
    with db.db_session() as s:
        snip = content.create_artifact(
            s, "p1", kind=ArtifactKind.code_snippet, name="s", payload=SNIP, updated_by=None
        )
        project = s.get(Project, "p1")
        res = compute_closure(s, "p1", [snip.id])
        bundle = build_bundle(project, res, [snip.id])
        assert bundle.format == BUNDLE_FORMAT
        assert bundle.source_project.id == "p1"
        assert bundle.roots == [snip.id]
        assert bundle.artifacts[0].kind == "code_snippet"
        # envelope round-trips through JSON (the on-disk form)
        again = ArtifactBundle.model_validate_json(bundle.model_dump_json())
        assert again == bundle


def test_bundle_parses_unknown_kind() -> None:
    # kind is a raw string on the wire: a bundle from a newer server must
    # PARSE here; filtering is the import plan's job, not the schema's.
    bundle = ArtifactBundle.model_validate(
        {
            "format": BUNDLE_FORMAT,
            "exported_at": "2026-08-08T00:00:00+00:00",
            "source_project": {"id": "x", "name": "X"},
            "roots": [],
            "artifacts": [{"id": "a1", "kind": "hologram", "name": "h", "payload": {}}],
        }
    )
    assert bundle.artifacts[0].kind == "hologram"
```

Note: `content.update_artifact(s, row, payload=...)` — check its exact signature in `src/data_rover/api/content.py:349` before using; if it requires `expected_rev` or different kwargs, adapt the cycle test to match (the intent is just: point `a`'s payload at `b`).

- [ ] **Step 3: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_artifact_bundle.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'data_rover.api.artifact_bundle'`

- [ ] **Step 4: Implement the module**

Create `src/data_rover/api/artifact_bundle.py`:

```python
"""Artifact bundle — the `datarover.artifact-bundle/v1` import/export closure.

Export computes the dependency closure of user-selected roots via the kind
registry's `extract_deps` and serializes it as a self-contained JSON envelope.
Import derives a resolution plan against the target project ((kind,name)
clashes, payload-aware reuse/copy proposals) and builds the `create_artifact`
op batch the confirm route lands through `create_commit`.

Stances that are load-bearing here:
- `BundleArtifact.kind` is a RAW string, never `ArtifactKind`: a bundle from a
  newer server must parse; unknown kinds are reported-and-skipped by the plan,
  not rejected by the schema.
- Dangling refs are tolerated everywhere (the tolerant-dangler stance of
  `rewrite_refs`): a ref whose target is missing stays in the payload and the
  target is simply reported, never an error.
- Payload comparison for the reuse proposal normalizes the bundle payload the
  same way a write would (adapter validation + `derive_metadata`) and rewrites
  its refs through the tentative reuse map first — a re-imported unchanged
  bundle therefore proposes all-reuse.
"""

from __future__ import annotations

import json
from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DbSession

from . import content
from .artifact_kinds import extract_refs, get_spec
from .db_models import ArtifactKind, ArtifactRow, Project

BUNDLE_FORMAT = "datarover.artifact-bundle/v1"


class BundleSourceProject(BaseModel):
    id: str
    name: str


class BundleArtifact(BaseModel):
    id: str
    #: raw string, NOT ArtifactKind — see module docstring
    kind: str
    name: str
    payload: dict[str, Any] = Field(default_factory=dict)


class ArtifactBundle(BaseModel):
    format: Literal["datarover.artifact-bundle/v1"]
    exported_at: str
    source_project: BundleSourceProject
    roots: list[str] = Field(default_factory=list)
    artifacts: list[BundleArtifact] = Field(default_factory=list)


@dataclass(frozen=True)
class ClosureResult:
    #: BFS discovery order, deduplicated
    rows: list[ArtifactRow]
    #: sorted ids that were referenced (or requested as roots) but don't
    #: exist in this project — tolerated, reported
    dangling_refs: list[str]


def row_deps(row: ArtifactRow) -> set[str]:
    """Artifact ids *row* references. Registered kinds go through their spec;
    unregistered rows (legacy `diagram`) fall back to the generic walk, which
    needs no spec — export must never lose them."""
    spec = get_spec(row.kind)
    if spec is not None:
        return spec.extract_deps(row.payload)
    return extract_refs(row.payload)


def compute_closure(
    db: DbSession, project_id: str, root_ids: Sequence[str]
) -> ClosureResult:
    rows: list[ArtifactRow] = []
    dangling: set[str] = set()
    seen: set[str] = set(dict.fromkeys(root_ids))
    queue = deque(dict.fromkeys(root_ids))
    while queue:
        aid = queue.popleft()
        row = content.get_artifact(db, aid)
        if row is None or row.project_id != project_id:
            dangling.add(aid)
            continue
        rows.append(row)
        for dep in sorted(row_deps(row)):
            if dep not in seen:
                seen.add(dep)
                queue.append(dep)
    return ClosureResult(rows=rows, dangling_refs=sorted(dangling))


def build_bundle(
    project: Project, closure: ClosureResult, roots: Sequence[str]
) -> ArtifactBundle:
    return ArtifactBundle(
        format=BUNDLE_FORMAT,
        exported_at=datetime.now(UTC).isoformat(),
        source_project=BundleSourceProject(id=project.id, name=project.name),
        roots=list(roots),
        artifacts=[
            BundleArtifact(
                id=r.id, kind=r.kind.value, name=r.name, payload=r.payload
            )
            for r in closure.rows
        ],
    )
```

(`json` import is used by Task 2's canonical compare; keep it now to avoid churn, or add it in Task 2 — either is fine, ruff will tell you.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_artifact_bundle.py -q`
Expected: PASS (all 6)

- [ ] **Step 6: Lint and commit**

```bash
pixi run backend-lint
git add src/data_rover/api/artifact_bundle.py tests/api/test_artifact_bundle.py
git commit -m "feat(api): artifact bundle envelope + dependency closure"
```

---

### Task 2: Import plan derivation

**Files:**
- Modify: `src/data_rover/api/artifact_bundle.py` (append)
- Test: `tests/api/test_artifact_bundle.py` (append)

**Interfaces:**
- Consumes: Task 1's `ArtifactBundle`/`BundleArtifact`; `artifact_kinds.get_spec`; `content.find_artifact`, `content.list_artifacts`.
- Produces:
  - `class PlanEntry(BaseModel)`: `bundle_id: str`, `kind: str`, `name: str`, `action: Literal["create", "reuse", "copy"]`, `existing_id: str | None = None`, `copy_name: str | None = None`
  - `class SkippedEntry(BaseModel)`: `bundle_id: str`, `reason: str`
  - `class ImportPlan(BaseModel)`: `entries: list[PlanEntry]`, `skipped: list[SkippedEntry]` (both default empty)
  - `def dedupe_name(taken: set[str], base: str) -> str` — `"Name (2)"`, first free suffix
  - `def derive_plan(db: DbSession, project_id: str, bundle: ArtifactBundle) -> ImportPlan`

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_artifact_bundle.py`:

```python
from data_rover.api.artifact_bundle import dedupe_name, derive_plan


def _bundle(artifacts: list[dict]) -> ArtifactBundle:
    return ArtifactBundle.model_validate(
        {
            "format": BUNDLE_FORMAT,
            "exported_at": "2026-08-08T00:00:00+00:00",
            "source_project": {"id": "src", "name": "Source"},
            "roots": [a["id"] for a in artifacts],
            "artifacts": artifacts,
        }
    )


def test_dedupe_name_first_free_suffix() -> None:
    assert dedupe_name(set(), "T") == "T (2)"
    assert dedupe_name({"T (2)"}, "T") == "T (3)"
    assert dedupe_name({"T (2)", "T (3)"}, "T") == "T (4)"


def test_plan_no_clash_proposes_create() -> None:
    _setup()
    with db.db_session() as s:
        plan = derive_plan(
            s, "p1", _bundle([{"id": "b1", "kind": "code_snippet", "name": "fresh", "payload": SNIP}])
        )
        assert len(plan.entries) == 1
        e = plan.entries[0]
        assert (e.bundle_id, e.action, e.existing_id, e.copy_name) == ("b1", "create", None, None)
        assert plan.skipped == []


def test_plan_identical_payload_proposes_reuse() -> None:
    _setup()
    with db.db_session() as s:
        existing = content.create_artifact(
            s, "p1", kind=ArtifactKind.code_snippet, name="s", payload=SNIP, updated_by=None
        )
        plan = derive_plan(
            s, "p1", _bundle([{"id": "b1", "kind": "code_snippet", "name": "s", "payload": SNIP}])
        )
        e = plan.entries[0]
        assert e.action == "reuse"
        assert e.existing_id == existing.id


def test_plan_different_payload_proposes_copy_with_deduped_name() -> None:
    _setup()
    other = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return 1\n"}
    with db.db_session() as s:
        content.create_artifact(
            s, "p1", kind=ArtifactKind.code_snippet, name="s", payload=SNIP, updated_by=None
        )
        plan = derive_plan(
            s, "p1", _bundle([{"id": "b1", "kind": "code_snippet", "name": "s", "payload": other}])
        )
        e = plan.entries[0]
        assert e.action == "copy"
        assert e.copy_name == "s (2)"


def test_plan_reuse_respects_ref_normalization() -> None:
    # nav in the bundle references the bundle SNIPPET id; the existing nav
    # references the existing snippet id. After rewriting through the
    # tentative reuse map the payloads are identical -> both propose reuse.
    _setup()
    with db.db_session() as s:
        ex_snip = content.create_artifact(
            s, "p1", kind=ArtifactKind.code_snippet, name="s", payload=SNIP, updated_by=None
        )
        content.create_artifact(
            s, "p1", kind=ArtifactKind.navigation, name="n", payload=_nav(ex_snip.id), updated_by=None
        )
        plan = derive_plan(
            s,
            "p1",
            _bundle(
                [
                    {"id": "bs", "kind": "code_snippet", "name": "s", "payload": SNIP},
                    {"id": "bn", "kind": "navigation", "name": "n", "payload": _nav("bs")},
                ]
            ),
        )
        assert {e.bundle_id: e.action for e in plan.entries} == {"bs": "reuse", "bn": "reuse"}


def test_plan_skips_unknown_kind_and_invalid_payload() -> None:
    _setup()
    with db.db_session() as s:
        plan = derive_plan(
            s,
            "p1",
            _bundle(
                [
                    {"id": "b1", "kind": "hologram", "name": "h", "payload": {}},
                    {"id": "b2", "kind": "diagram", "name": "d", "payload": {}},
                    {"id": "b3", "kind": "code_snippet", "name": "bad", "payload": {"nope": 1}},
                ]
            ),
        )
        assert plan.entries == []
        reasons = {sk.bundle_id: sk.reason for sk in plan.skipped}
        assert "b1" in reasons and "b2" in reasons and "b3" in reasons


def test_plan_two_copies_same_base_name_get_distinct_names() -> None:
    # two bundle artifacts of the same kind whose names both clash with
    # existing rows must not be handed the SAME deduped name
    _setup()
    other1 = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return 1\n"}
    other2 = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return 2\n"}
    with db.db_session() as s:
        content.create_artifact(
            s, "p1", kind=ArtifactKind.code_snippet, name="s", payload=SNIP, updated_by=None
        )
        plan = derive_plan(
            s,
            "p1",
            _bundle(
                [
                    {"id": "b1", "kind": "code_snippet", "name": "s", "payload": other1},
                    {"id": "b2", "kind": "code_snippet", "name": "s", "payload": other2},
                ]
            ),
        )
        names = [e.copy_name for e in plan.entries]
        assert len(names) == 2 and len(set(names)) == 2
```

Note on `b2`/`diagram`: `diagram` IS a valid `ArtifactKind` enum member but has no registered spec — it must be skipped by the plan (import filters kinds; the reason string should say unregistered).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_artifact_bundle.py -q`
Expected: FAIL — `ImportError: cannot import name 'derive_plan'`

- [ ] **Step 3: Implement plan derivation**

Append to `src/data_rover/api/artifact_bundle.py`:

```python
class PlanEntry(BaseModel):
    bundle_id: str
    kind: str
    name: str
    action: Literal["create", "reuse", "copy"]
    existing_id: str | None = None
    copy_name: str | None = None


class SkippedEntry(BaseModel):
    bundle_id: str
    reason: str


class ImportPlan(BaseModel):
    entries: list[PlanEntry] = Field(default_factory=list)
    skipped: list[SkippedEntry] = Field(default_factory=list)


def _canonical(payload: Any) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def dedupe_name(taken: set[str], base: str) -> str:
    """First free "base (N)" name, N starting at 2 (matches the copy-suffix
    convention users see elsewhere)."""
    n = 2
    while f"{base} ({n})" in taken:
        n += 1
    return f"{base} ({n})"


def _normalized_payload(kind: ArtifactKind, payload: dict[str, Any]) -> dict[str, Any]:
    """The payload as a WRITE would store it: adapter-validated (caller has
    already done that) + server-derived metadata rerun. Stored rows went
    through exactly this in `artifact_ops._validated_payload`, so comparing
    normalized-vs-stored is apples to apples (a bundle snippet with stale
    `entry_points` still matches its unchanged original)."""
    spec = get_spec(kind)
    assert spec is not None  # callers only pass registered kinds
    if spec.derive_metadata is not None:
        payload = dict(payload)
        spec.derive_metadata(payload)
    return payload


def derive_plan(
    db: DbSession, project_id: str, bundle: ArtifactBundle
) -> ImportPlan:
    entries: list[PlanEntry] = []
    skipped: list[SkippedEntry] = []
    #: (bundle artifact, its ArtifactKind, its (kind,name) clash row or None)
    valid: list[tuple[BundleArtifact, ArtifactKind, ArtifactRow | None]] = []

    for art in bundle.artifacts:
        try:
            kind = ArtifactKind(art.kind)
        except ValueError:
            skipped.append(
                SkippedEntry(bundle_id=art.id, reason=f"unknown kind {art.kind!r}")
            )
            continue
        spec = get_spec(kind)
        if spec is None:
            skipped.append(
                SkippedEntry(bundle_id=art.id, reason=f"unregistered kind {art.kind!r}")
            )
            continue
        try:
            spec.adapter.validate_python(art.payload)
        except Exception as exc:  # pydantic ValidationError, kept broad on purpose
            skipped.append(
                SkippedEntry(bundle_id=art.id, reason=f"invalid payload: {exc}")
            )
            continue
        valid.append((art, kind, content.find_artifact(db, project_id, kind, art.name)))

    # Tentative reuse map covers EVERY clash: ref-normalizing a payload before
    # comparison must see all of its siblings' potential reuse targets, or a
    # bundle re-import would propose copy for anything that references a peer.
    tentative = {art.id: row.id for art, _kind, row in valid if row is not None}

    #: names already taken per kind — existing rows plus names this plan hands out
    taken: dict[ArtifactKind, set[str]] = {}

    for art, kind, existing in valid:
        if existing is None:
            entries.append(
                PlanEntry(bundle_id=art.id, kind=art.kind, name=art.name, action="create")
            )
            continue
        spec = get_spec(kind)
        assert spec is not None  # filtered above
        normalized = _normalized_payload(kind, art.payload)
        rewritten = spec.rewrite_refs(normalized, tentative)
        if _canonical(rewritten) == _canonical(existing.payload):
            entries.append(
                PlanEntry(
                    bundle_id=art.id,
                    kind=art.kind,
                    name=art.name,
                    action="reuse",
                    existing_id=existing.id,
                )
            )
            continue
        if kind not in taken:
            taken[kind] = {r.name for r in content.list_artifacts(db, project_id, kind)}
        copy_name = dedupe_name(taken[kind], art.name)
        taken[kind].add(copy_name)
        entries.append(
            PlanEntry(
                bundle_id=art.id,
                kind=art.kind,
                name=art.name,
                action="copy",
                existing_id=existing.id,
                copy_name=copy_name,
            )
        )
    return ImportPlan(entries=entries, skipped=skipped)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_artifact_bundle.py -q`
Expected: PASS

- [ ] **Step 5: Lint and commit**

```bash
pixi run backend-lint
git add src/data_rover/api/artifact_bundle.py tests/api/test_artifact_bundle.py
git commit -m "feat(api): import plan derivation with payload-aware reuse/copy proposals"
```

---

### Task 3: Export routes (`/artifacts/export`, `/artifacts/export/preview`)

**Files:**
- Create: `src/data_rover/api/routes/artifact_bundle.py`
- Modify: `src/data_rover/api/main.py` (router import + mount), `src/data_rover/api/authz.py:54-70` (allowlist)
- Test: `tests/api/test_artifact_bundle_routes.py`

**Interfaces:**
- Consumes: Task 1's `compute_closure`/`build_bundle`; `deps.get_request_session` is NOT needed (export reads rows from the DB, not the in-memory model); `authz.require_membership`, `db.get_db`.
- Produces: router `routes.artifact_bundle.router`; wire models in `src/data_rover/api/artifact_bundle.py`:
  - `class ExportRequest(BaseModel)`: `root_ids: list[str]`
  - `class ExportPreviewArtifact(BaseModel)`: `id: str`, `kind: str`, `name: str`
  - `class ExportPreviewResponse(BaseModel)`: `artifacts: list[ExportPreviewArtifact]`, `dangling_refs: list[str]`

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_artifact_bundle_routes.py`. Look at `tests/api/test_artifacts_routes.py` first for how that suite creates artifacts over HTTP (`POST /artifacts` shape) and reuse its helper pattern. Then:

```python
"""HTTP tests for the bundle routes: export, preview, import plan, confirm."""

from __future__ import annotations

from fastapi.testclient import TestClient

from data_rover.api.artifact_bundle import BUNDLE_FORMAT

from .conftest import AUTH_HEADERS, papi

SNIP = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return el.name\n"}


def _mk(client: TestClient, kind: str, name: str, payload: dict) -> dict:
    r = client.post(
        papi("/artifacts"),
        json={"kind": kind, "name": name, "payload": payload},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 201, r.text
    return r.json()


def _nav(ref: str) -> dict:
    return {"kind": "set_op", "op": "union", "operands": [{"ref": ref}]}


def test_export_computes_closure_and_streams_bundle(client: TestClient) -> None:
    snip = _mk(client, "code_snippet", "s", SNIP)
    nav = _mk(client, "navigation", "n", _nav(snip["id"]))
    r = client.post(
        papi("/artifacts/export"), json={"root_ids": [nav["id"]]}, headers=AUTH_HEADERS
    )
    assert r.status_code == 200, r.text
    assert "attachment" in r.headers.get("content-disposition", "")
    bundle = r.json()
    assert bundle["format"] == BUNDLE_FORMAT
    assert bundle["roots"] == [nav["id"]]
    assert {a["id"] for a in bundle["artifacts"]} == {nav["id"], snip["id"]}


def test_export_preview_metadata_only(client: TestClient) -> None:
    snip = _mk(client, "code_snippet", "s", SNIP)
    nav = _mk(client, "navigation", "n", _nav(snip["id"]))
    r = client.post(
        papi("/artifacts/export/preview"),
        json={"root_ids": [nav["id"], "ghost"]},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert {a["id"] for a in body["artifacts"]} == {nav["id"], snip["id"]}
    assert body["dangling_refs"] == ["ghost"]
    assert all("payload" not in a for a in body["artifacts"])


def test_export_all_unknown_roots_yields_empty_bundle(client: TestClient) -> None:
    r = client.post(
        papi("/artifacts/export"), json={"root_ids": ["nope"]}, headers=AUTH_HEADERS
    )
    assert r.status_code == 200
    assert r.json()["artifacts"] == []


def test_viewer_can_export_and_preview(client: TestClient) -> None:
    # read-only allowlist: a viewer's POST to export/preview must not 403.
    # Mirror how tests/api/test_authz.py seeds a viewer membership for the
    # default project, then:
    ...
```

For the viewer test, open `tests/api/test_authz.py`, copy its viewer-seeding helper verbatim (it creates a second user with `Role.viewer` membership and header-authenticates as them), and assert `POST /artifacts/export` and `POST /artifacts/export/preview` both return 200 while (sanity) `POST /artifacts/import` returns 403 (route exists in Task 5 — mark that assertion with a comment and add it in Task 5 if the route 404s under TestClient before then; a 404-vs-403 here would make the test order-dependent, so ONLY assert the export/preview half in this task).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_artifact_bundle_routes.py -q`
Expected: FAIL — 404 on `/artifacts/export` (route not mounted)

- [ ] **Step 3: Implement wire models + routes + mounting**

Append to `src/data_rover/api/artifact_bundle.py`:

```python
class ExportRequest(BaseModel):
    root_ids: list[str] = Field(default_factory=list)


class ExportPreviewArtifact(BaseModel):
    id: str
    kind: str
    name: str


class ExportPreviewResponse(BaseModel):
    artifacts: list[ExportPreviewArtifact] = Field(default_factory=list)
    dangling_refs: list[str] = Field(default_factory=list)
```

Create `src/data_rover/api/routes/artifact_bundle.py`:

```python
"""Bundle routes: export closure + stateless plan→confirm import.

Export/preview read ONLY artifact rows (never the in-memory model), so they
take no session dependency and sit in the read-only POST allowlist — viewers
may export. Import (plan + confirm) is Task 4/5."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session as DbSession

from ..artifact_bundle import (
    ArtifactBundle,
    ExportPreviewArtifact,
    ExportPreviewResponse,
    ExportRequest,
    build_bundle,
    compute_closure,
)
from ..authz import require_membership
from ..db import get_db
from ..db_models import Membership, Project

router = APIRouter()


@router.post("/artifacts/export")
def export_artifacts(
    body: ExportRequest,
    project_id: str,
    _membership: Membership = Depends(require_membership),
    db: DbSession = Depends(get_db),
) -> JSONResponse:
    project = db.get(Project, project_id)
    assert project is not None  # require_membership proved existence
    closure = compute_closure(db, project_id, body.root_ids)
    bundle = build_bundle(project, closure, body.root_ids)
    return JSONResponse(
        content=bundle.model_dump(),
        headers={
            "Content-Disposition": 'attachment; filename="artifacts.bundle.json"'
        },
    )


@router.post("/artifacts/export/preview", response_model=ExportPreviewResponse)
def export_preview(
    body: ExportRequest,
    project_id: str,
    _membership: Membership = Depends(require_membership),
    db: DbSession = Depends(get_db),
) -> ExportPreviewResponse:
    closure = compute_closure(db, project_id, body.root_ids)
    return ExportPreviewResponse(
        artifacts=[
            ExportPreviewArtifact(id=r.id, kind=r.kind.value, name=r.name)
            for r in closure.rows
        ],
        dangling_refs=closure.dangling_refs,
    )
```

In `src/data_rover/api/authz.py`, extend `_READ_ONLY_POST_SUFFIXES` (keep it sorted-by-topic like the existing entries; note `/artifacts/import/plan` is deliberately NOT here — planning is part of the write flow, spec decision):

```python
    "/artifacts/export",
    "/artifacts/export/preview",
```

In `src/data_rover/api/main.py`: add `artifact_bundle` to the `from .routes import (...)` list and mount next to the artifacts router:

```python
    app.include_router(artifact_bundle.router, prefix=proj, tags=["artifacts"])
```

Check `src/data_rover/api/routes/__init__.py` — if it enumerates route modules explicitly, add `artifact_bundle` there too.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_artifact_bundle_routes.py tests/api/test_authz.py -q`
Expected: PASS (including the untouched authz suite)

- [ ] **Step 5: Lint and commit**

```bash
pixi run backend-lint
git add -A src/data_rover/api tests/api/test_artifact_bundle_routes.py
git commit -m "feat(api): artifact bundle export + preview routes (viewer-allowed)"
```

---

### Task 4: Import plan route (`POST /artifacts/import/plan`)

**Files:**
- Modify: `src/data_rover/api/routes/artifact_bundle.py`
- Test: `tests/api/test_artifact_bundle_routes.py` (append)

**Interfaces:**
- Consumes: Task 2's `derive_plan`, `ImportPlan`.
- Produces: `POST /artifacts/import/plan` accepting an `ArtifactBundle` body, returning `ImportPlan` JSON: `{"entries": [{"bundle_id", "kind", "name", "action", "existing_id", "copy_name"}], "skipped": [{"bundle_id", "reason"}]}`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_artifact_bundle_routes.py`:

```python
def _bundle_body(artifacts: list[dict]) -> dict:
    return {
        "format": BUNDLE_FORMAT,
        "exported_at": "2026-08-08T00:00:00+00:00",
        "source_project": {"id": "src", "name": "Source"},
        "roots": [a["id"] for a in artifacts],
        "artifacts": artifacts,
    }


def test_import_plan_mixed_actions(client: TestClient) -> None:
    _mk(client, "code_snippet", "s", SNIP)
    other = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return 1\n"}
    r = client.post(
        papi("/artifacts/import/plan"),
        json=_bundle_body(
            [
                {"id": "b1", "kind": "code_snippet", "name": "s", "payload": SNIP},
                {"id": "b2", "kind": "code_snippet", "name": "s2", "payload": other},
                {"id": "b3", "kind": "hologram", "name": "h", "payload": {}},
            ]
        ),
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text
    plan = r.json()
    actions = {e["bundle_id"]: e["action"] for e in plan["entries"]}
    assert actions == {"b1": "reuse", "b2": "create"}
    assert [sk["bundle_id"] for sk in plan["skipped"]] == ["b3"]


def test_import_plan_malformed_envelope_422(client: TestClient) -> None:
    r = client.post(
        papi("/artifacts/import/plan"),
        json={"format": "wrong/v9", "artifacts": []},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 422


def test_import_plan_is_a_write_for_viewers(client: TestClient) -> None:
    # /artifacts/import/plan is NOT in the read-only allowlist (spec decision:
    # planning is part of the write flow). Reuse the viewer helper from the
    # Task 3 viewer test; expect 403.
    ...
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_artifact_bundle_routes.py -q`
Expected: new tests FAIL with 404 (route missing)

- [ ] **Step 3: Implement the route**

Append to `src/data_rover/api/routes/artifact_bundle.py` (add `derive_plan`, `ImportPlan` to the existing `..artifact_bundle` import):

```python
@router.post("/artifacts/import/plan", response_model=ImportPlan)
def import_plan(
    bundle: ArtifactBundle,
    project_id: str,
    _membership: Membership = Depends(require_membership),
    db: DbSession = Depends(get_db),
) -> ImportPlan:
    """Advisory resolution plan; writes nothing. Deliberately NOT in the
    read-only allowlist — planning an import is part of the write flow."""
    return derive_plan(db, project_id, bundle)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_artifact_bundle_routes.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
pixi run backend-lint
git add src/data_rover/api/routes/artifact_bundle.py tests/api/test_artifact_bundle_routes.py
git commit -m "feat(api): import resolution plan route"
```

---

### Task 5: Import confirm route (`POST /artifacts/import`)

**Files:**
- Modify: `src/data_rover/api/artifact_bundle.py` (op building + confirm wire models), `src/data_rover/api/routes/artifact_bundle.py` (route)
- Test: `tests/api/test_artifact_bundle_routes.py` (append)

**Interfaces:**
- Consumes: `schemas.TEMP_ID_PREFIX` / `CreateArtifactOp` / `CommitRequest`; `routes.commits.create_commit`; `deps.get_request_session`; `identity.get_current_user`; Task 2's `derive_plan`/`ImportPlan`/`PlanEntry`.
- Produces (in `api/artifact_bundle.py`):
  - `class StalePlanError(Exception)` — `def __init__(self, detail: str)`
  - `class ImportConfirmRequest(BaseModel)`: `bundle: ArtifactBundle`, `decisions: dict[str, Literal["create", "reuse", "copy"]]` (default `{}`), `copy_names: dict[str, str]` (default `{}`), `message: str = ""`
  - `class CreatedEntry(BaseModel)`: `bundle_id: str`, `id: str`, `name: str`
  - `class ReusedEntry(BaseModel)`: `bundle_id: str`, `existing_id: str`
  - `class ImportConfirmResponse(BaseModel)`: `rev: int | None`, `created: list[CreatedEntry]`, `reused: list[ReusedEntry]`, `skipped: list[SkippedEntry]`
  - `def build_import_ops(plan: ImportPlan, bundle: ArtifactBundle, decisions: Mapping[str, str], copy_names: Mapping[str, str]) -> tuple[list[CreateArtifactOp], list[ReusedEntry], dict[str, str]]` — returns `(ops, reused, final_names)` where `final_names` maps bundle_id → the name each created artifact will get; raises `StalePlanError` on any decision the fresh plan can't honor.

- [ ] **Step 1: Write the failing op-builder tests**

Append to `tests/api/test_artifact_bundle.py`:

```python
import pytest

from data_rover.api.artifact_bundle import StalePlanError, build_import_ops
from data_rover.api.schemas import TEMP_ID_PREFIX


def test_build_ops_rewrites_sibling_and_reuse_refs() -> None:
    _setup()
    with db.db_session() as s:
        ex_snip = content.create_artifact(
            s, "p1", kind=ArtifactKind.code_snippet, name="s", payload=SNIP, updated_by=None
        )
        bundle = _bundle(
            [
                {"id": "bs", "kind": "code_snippet", "name": "s", "payload": SNIP},
                {"id": "bn", "kind": "navigation", "name": "n", "payload": _nav("bs")},
                {"id": "bm", "kind": "navigation", "name": "m", "payload": _nav("bn")},
            ]
        )
        plan = derive_plan(s, "p1", bundle)
        ops, reused, final_names = build_import_ops(plan, bundle, {}, {})
        # bs proposed reuse -> no op; bn/bm created
        assert [op.temp_id for op in ops] == [f"{TEMP_ID_PREFIX}bn", f"{TEMP_ID_PREFIX}bm"]
        assert reused[0].existing_id == ex_snip.id
        by_temp = {op.temp_id: op for op in ops}
        # bn's ref to the reused snippet points at the EXISTING id
        assert by_temp[f"{TEMP_ID_PREFIX}bn"].payload["operands"][0]["ref"] == ex_snip.id
        # bm's ref to its created sibling points at the sibling's TEMP id
        assert by_temp[f"{TEMP_ID_PREFIX}bm"].payload["operands"][0]["ref"] == f"{TEMP_ID_PREFIX}bn"
        assert final_names == {"bn": "n", "bm": "m"}


def test_build_ops_flip_reuse_to_copy_and_back() -> None:
    _setup()
    with db.db_session() as s:
        content.create_artifact(
            s, "p1", kind=ArtifactKind.code_snippet, name="s", payload=SNIP, updated_by=None
        )
        bundle = _bundle([{"id": "bs", "kind": "code_snippet", "name": "s", "payload": SNIP}])
        plan = derive_plan(s, "p1", bundle)  # proposes reuse
        ops, reused, final_names = build_import_ops(plan, bundle, {"bs": "copy"}, {})
        assert len(ops) == 1 and reused == []
        assert ops[0].name == "s (2)" and final_names == {"bs": "s (2)"}
        # explicit copy_names override wins
        ops2, _, names2 = build_import_ops(plan, bundle, {"bs": "copy"}, {"bs": "mine"})
        assert ops2[0].name == "mine" and names2 == {"bs": "mine"}


def test_build_ops_stale_decisions_raise() -> None:
    _setup()
    with db.db_session() as s:
        bundle = _bundle([{"id": "bs", "kind": "code_snippet", "name": "s", "payload": SNIP}])
        plan = derive_plan(s, "p1", bundle)  # fresh project -> proposes create
        with pytest.raises(StalePlanError):
            build_import_ops(plan, bundle, {"bs": "reuse"}, {})  # no reuse target
        with pytest.raises(StalePlanError):
            build_import_ops(plan, bundle, {"ghost": "create"}, {})  # unknown bundle id
```

Also decide-and-pin: a decision of `"create"` on an entry whose fresh action is `"copy"`/`"reuse"` (i.e. the name now clashes) must raise `StalePlanError` — add an assertion for that in `test_build_ops_stale_decisions_raise` by pre-creating the clashing row.

- [ ] **Step 2: Run to verify failure, then implement the builder**

Run: `pixi run -e core-dev pytest tests/api/test_artifact_bundle.py -q` → ImportError.

Append to `src/data_rover/api/artifact_bundle.py` (import `CreateArtifactOp`, `TEMP_ID_PREFIX` from `.schemas`, `Mapping` from `collections.abc`):

```python
class StalePlanError(Exception):
    """A decision references state the FRESH plan can't honor (target gone,
    name newly clashing, unknown bundle id). The confirm route maps this to
    409 + the fresh plan."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class ImportConfirmRequest(BaseModel):
    bundle: ArtifactBundle
    decisions: dict[str, Literal["create", "reuse", "copy"]] = Field(default_factory=dict)
    copy_names: dict[str, str] = Field(default_factory=dict)
    message: str = ""


class CreatedEntry(BaseModel):
    bundle_id: str
    id: str
    name: str


class ReusedEntry(BaseModel):
    bundle_id: str
    existing_id: str


class ImportConfirmResponse(BaseModel):
    #: null when the import was a no-op (nothing to create)
    rev: int | None
    created: list[CreatedEntry] = Field(default_factory=list)
    reused: list[ReusedEntry] = Field(default_factory=list)
    skipped: list[SkippedEntry] = Field(default_factory=list)


def build_import_ops(
    plan: ImportPlan,
    bundle: ArtifactBundle,
    decisions: Mapping[str, str],
    copy_names: Mapping[str, str],
) -> tuple[list[CreateArtifactOp], list[ReusedEntry], dict[str, str]]:
    entries = {e.bundle_id: e for e in plan.entries}
    for bid in decisions:
        if bid not in entries:
            raise StalePlanError(f"decision for unknown/skipped artifact {bid!r}")

    payloads = {a.id: a.payload for a in bundle.artifacts}
    reused: list[ReusedEntry] = []
    created: list[PlanEntry] = []
    final_names: dict[str, str] = {}

    for e in plan.entries:
        action = decisions.get(e.bundle_id, e.action)
        if action == "reuse":
            if e.existing_id is None:
                raise StalePlanError(f"no reuse target for {e.bundle_id!r}")
            reused.append(ReusedEntry(bundle_id=e.bundle_id, existing_id=e.existing_id))
        elif action == "create":
            if e.action != "create":
                raise StalePlanError(f"name for {e.bundle_id!r} now clashes")
            created.append(e)
            final_names[e.bundle_id] = e.name
        else:  # copy
            name = copy_names.get(e.bundle_id) or e.copy_name or e.name
            created.append(e)
            final_names[e.bundle_id] = name

    # created siblings resolve to temp ids (the commit applier maps them to
    # fresh uuids and resolves refs via its id_map); reused ones resolve to
    # the existing target. Skipped bundle ids stay unmapped -> dangling refs,
    # the tolerant stance.
    ref_map: dict[str, str] = {r.bundle_id: r.existing_id for r in reused}
    ref_map.update({e.bundle_id: TEMP_ID_PREFIX + e.bundle_id for e in created})

    ops: list[CreateArtifactOp] = []
    for e in created:
        kind = ArtifactKind(e.kind)
        spec = get_spec(kind)
        assert spec is not None  # plan entries only ever carry registered kinds
        ops.append(
            CreateArtifactOp(
                kind="create_artifact",
                temp_id=TEMP_ID_PREFIX + e.bundle_id,
                artifact_kind=e.kind,
                name=final_names[e.bundle_id],
                payload=spec.rewrite_refs(payloads[e.bundle_id], ref_map),
            )
        )
    return ops, reused, final_names
```

Type note: `CreateArtifactOp.artifact_kind` is a `Literal[...]` — passing `e.kind` (a `str`) is fine at runtime but mypy/pyright may want a cast; if they complain use `cast(Any, e.kind)` with a comment (plan entries only carry registered kinds, checked above).

Run: `pixi run -e core-dev pytest tests/api/test_artifact_bundle.py -q` → PASS.

- [ ] **Step 3: Write the failing route tests**

Append to `tests/api/test_artifact_bundle_routes.py`. Before writing, open `tests/api/test_commits_artifact_ops.py` and reuse its `_rev(client)` helper pattern (reads `model_rev` from `GET /model/summary`).

```python
def _rev(client: TestClient) -> int:
    return client.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]


def test_import_confirm_lands_one_commit(client: TestClient) -> None:
    ex_snip = _mk(client, "code_snippet", "s", SNIP)
    rev0 = _rev(client)
    body = {
        "bundle": _bundle_body(
            [
                {"id": "bs", "kind": "code_snippet", "name": "s", "payload": SNIP},
                {"id": "bn", "kind": "navigation", "name": "n", "payload": _nav("bs")},
            ]
        ),
        "decisions": {},
        "message": "",
    }
    r = client.post(papi("/artifacts/import"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["rev"] == rev0 + 1 and _rev(client) == rev0 + 1  # exactly one commit
    assert out["reused"] == [{"bundle_id": "bs", "existing_id": ex_snip["id"]}]
    [c] = out["created"]
    assert c["bundle_id"] == "bn"
    # the created nav's ref points at the EXISTING snippet id
    nav = client.get(papi(f"/artifacts/{c['id']}"), headers=AUTH_HEADERS).json()
    assert nav["payload"]["operands"][0]["ref"] == ex_snip["id"]
    # journaled with the default message
    hist = client.get(papi("/commits"), headers=AUTH_HEADERS).json()["commits"]
    assert hist[0]["message"] == "Imported 1 artifacts from Source"
    # diff renders and undo reverts (journal-only artifact commit)
    assert client.get(papi(f"/commits/{out['rev']}/diff"), headers=AUTH_HEADERS).status_code == 200
    undo = client.post(papi("/model/undo"), headers=AUTH_HEADERS)
    assert undo.status_code == 200, undo.text
    assert client.get(papi(f"/artifacts/{c['id']}"), headers=AUTH_HEADERS).status_code == 404


def test_import_confirm_all_reuse_is_noop_without_commit(client: TestClient) -> None:
    _mk(client, "code_snippet", "s", SNIP)
    rev0 = _rev(client)
    body = {
        "bundle": _bundle_body([{"id": "bs", "kind": "code_snippet", "name": "s", "payload": SNIP}]),
    }
    r = client.post(papi("/artifacts/import"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    assert r.json()["rev"] is None
    assert _rev(client) == rev0  # no commit minted


def test_import_confirm_stale_decision_409_with_fresh_plan(client: TestClient) -> None:
    body = {
        "bundle": _bundle_body([{"id": "bs", "kind": "code_snippet", "name": "s", "payload": SNIP}]),
        "decisions": {"bs": "reuse"},  # fresh project: nothing to reuse
    }
    r = client.post(papi("/artifacts/import"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 409, r.text
    detail = r.json()
    assert "plan" in detail  # fresh plan rides along for the client to re-render
    assert detail["plan"]["entries"][0]["action"] == "create"


def test_import_confirm_feed_scope_is_artifact(client: TestClient) -> None:
    # Mirror how tests/api/test_commits_artifact_ops.py asserts commit feed
    # events carry scope ["artifact"] (it patches/collects the session hub's
    # broadcast). If that suite asserts scope another way, copy it exactly.
    ...


def test_viewer_403_on_import(client: TestClient) -> None:
    # viewer helper from Task 3; POST /artifacts/import (and /import/plan)
    # both 403 for a viewer.
    ...
```

- [ ] **Step 4: Run to verify failure, then implement the confirm route**

Run: `pixi run -e core-dev pytest tests/api/test_artifact_bundle_routes.py -q` → 404s.

Append to `src/data_rover/api/routes/artifact_bundle.py`:

```python
from fastapi import HTTPException

from ..artifact_bundle import (
    ImportConfirmRequest,
    ImportConfirmResponse,
    CreatedEntry,
    StalePlanError,
    build_import_ops,
    derive_plan,
)
from ..deps import Session, get_request_session
from ..identity import get_current_user
from ..db_models import User
from ..schemas import CommitRequest, TEMP_ID_PREFIX
from .commits import create_commit


@router.post("/artifacts/import", response_model=ImportConfirmResponse)
def import_confirm(
    body: ImportConfirmRequest,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ImportConfirmResponse | JSONResponse:
    """Stateless confirm: re-derive the plan, honor the client's decisions,
    land ONE commit through `create_commit` (fresh-id creates only -> no
    leases). Any decision the fresh plan can't honor -> 409 + fresh plan.
    The 422 a concurrent same-name commit would provoke inside the applier's
    clash check gets the same treatment: re-derive, 409, client re-decides."""

    def stale_conflict(detail: str) -> JSONResponse:
        fresh = derive_plan(db, project_id, body.bundle)
        return JSONResponse(
            status_code=409,
            content={"detail": detail, "plan": fresh.model_dump()},
        )

    plan = derive_plan(db, project_id, body.bundle)
    try:
        ops, reused, final_names = build_import_ops(
            plan, body.bundle, body.decisions, body.copy_names
        )
    except StalePlanError as exc:
        return stale_conflict(exc.detail)

    if not ops:
        # all-reuse / all-skipped: NEVER mint an empty commit batch
        return ImportConfirmResponse(
            rev=None, created=[], reused=reused, skipped=plan.skipped
        )

    message = body.message or (
        f"Imported {len(ops)} artifacts from {body.bundle.source_project.name}"
    )
    req = CommitRequest(
        base_rev=session.model_rev,
        ops=list(ops),
        message=message,
        lock_tokens=[],
        ack_errors=True,
    )
    try:
        result = create_commit(req, project_id, session=session, db=db, user=user)
    except HTTPException as exc:
        if exc.status_code == 422:
            # pre-validated batch -> a 422 here means the project changed
            # under us (e.g. the applier's (kind,name) clash check fired)
            return stale_conflict("import plan is stale")
        raise
    if isinstance(result, JSONResponse):
        # staleness/lock JSON conflicts from create_commit; fresh-id creates
        # never overlap, so this is effectively unreachable — propagate as-is
        return result
    created = [
        CreatedEntry(
            bundle_id=bid,
            id=result.id_map[TEMP_ID_PREFIX + bid],
            name=final_names[bid],
        )
        for bid in final_names
    ]
    return ImportConfirmResponse(
        rev=result.model_rev, created=created, reused=reused, skipped=plan.skipped
    )
```

Check `create_commit`'s actual keyword names at `routes/commits.py:585` (`payload`, `project_id`, `session`, `db`, `user`) and call accordingly (`create_commit(req, project_id, session=session, db=db, user=user)` matches the positional/keyword shape above — adjust if the signature differs).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_artifact_bundle_routes.py tests/api/test_artifact_bundle.py tests/api/test_commits_artifact_ops.py -q`
Expected: PASS (including the untouched commit suite)

- [ ] **Step 6: Pin revert-across-import 409**

Append one test: create an import commit (reuse `test_import_confirm_lands_one_commit`'s body), then `POST /commits/revert` across it → expect the existing 409 (artifact ops in range). Mirror the revert-request shape used in `tests/api/test_commits_revert.py`. Run it.

- [ ] **Step 7: Lint and commit**

```bash
pixi run backend-lint
git add -A src/data_rover/api tests/api
git commit -m "feat(api): stateless import confirm landing one journaled commit"
```

---

### Task 6: Baseline import with artifacts (importer + CLI)

**Files:**
- Modify: `src/data_rover/api/importer.py`
- Test: `tests/api/test_importer.py` (append; read the existing tests first and mirror their setup)

**Interfaces:**
- Consumes: Task 1's `ArtifactBundle`; `artifact_kinds.rewrite_refs` (generic, kind-agnostic); `content.create_artifact`; `core.view.schema.View/Folder/ArtifactRef`.
- Produces: `import_project(*, project_id, name, owner_id, metamodel_yaml, model_json, view_json=None, artifact_bundle: str | None = None)`; CLI flag `--artifacts <path>`; helper `def _remap_view_artifact_refs(view: View, id_map: Mapping[str, str]) -> None` (in `importer.py`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_importer.py` (mirror the existing tests' engine setup in that file — they call `import_project` directly):

```python
def test_import_project_lands_artifact_bundle_with_remap() -> None:
    # ... existing-style setup (init_engine sqlite:// + settings) ...
    snip_payload = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return el.name\n"}
    bundle = {
        "format": "datarover.artifact-bundle/v1",
        "exported_at": "2026-08-08T00:00:00+00:00",
        "source_project": {"id": "src", "name": "Source"},
        "roots": ["old-nav"],
        "artifacts": [
            {"id": "old-snip", "kind": "code_snippet", "name": "s", "payload": snip_payload},
            {"id": "old-nav", "kind": "navigation", "name": "n",
             "payload": {"kind": "set_op", "op": "union", "operands": [{"ref": "old-snip"}]}},
            {"id": "old-diagram", "kind": "diagram", "name": "d", "payload": {"x": 1}},
            {"id": "old-alien", "kind": "hologram", "name": "h", "payload": {}},
        ],
    }
    view_json = json.dumps({
        "name": "V",
        "folders": [{"name": "F", "artifacts": [{"id": "old-nav", "kind": "navigation"}]}],
        "artifacts": [{"id": "old-snip", "kind": "code_snippet"}, {"id": "ghost", "kind": "table"}],
    })
    import_project(
        project_id="pz", name="PZ", owner_id="u1",
        metamodel_yaml=MINIMAL_MM_YAML, model_json="{}",  # reuse the file's existing minimal fixtures
        view_json=view_json, artifact_bundle=json.dumps(bundle),
    )
    with db.db_session() as s:
        rows = content.list_artifacts(s, "pz")
        by_name = {r.name: r for r in rows}
        # diagram (valid enum, unregistered) RIDES ALONG; alien kind is skipped
        assert set(by_name) == {"s", "n", "d"}
        assert all(r.id not in {"old-snip", "old-nav", "old-diagram"} for r in rows)  # fresh ids
        # nav payload ref remapped to the snippet's NEW id
        assert by_name["n"].payload["operands"][0]["ref"] == by_name["s"].id
        # view blob refs remapped too; unknown ref left dangling (tolerant)
        view_row = content.get_single_view(s, "pz")
        view = json.loads(view_row.blob)
        assert view["folders"][0]["artifacts"][0]["id"] == by_name["n"].id
        assert view["artifacts"][0]["id"] == by_name["s"].id
        assert view["artifacts"][1]["id"] == "ghost"
```

Adapt fixture names (`MINIMAL_MM_YAML`, model JSON) to whatever `test_importer.py` already uses — do not invent new metamodel fixtures.

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_importer.py -q`
Expected: FAIL — `import_project() got an unexpected keyword argument 'artifact_bundle'`

- [ ] **Step 3: Implement**

In `src/data_rover/api/importer.py`:

1. Extend the signature: `artifact_bundle: str | None = None` (keyword-only, after `view_json`).
2. Add the helper:

```python
def _remap_view_artifact_refs(view: View, id_map: Mapping[str, str]) -> None:
    """Rewrite artifact refs in-place through *id_map*; unknown ids stay
    (tolerant-dangler stance, same as payload refs)."""

    def _visit(folder_like: View | Folder) -> None:
        for ref in folder_like.artifacts:
            ref.id = id_map.get(ref.id, ref.id)
        for child in folder_like.folders:
            _visit(child)

    _visit(view)
```

(`Folder` import from `data_rover.core.view.schema`; `Mapping` from `collections.abc`.)

3. Inside the existing `with db_session() as s:` block, after the commit/model rows and BEFORE the view handling, land the artifacts and build the id map:

```python
        artifact_id_map: dict[str, str] = {}
        if artifact_bundle is not None:
            bundle = ArtifactBundle.model_validate_json(artifact_bundle)
            landable: list[tuple[BundleArtifact, ArtifactKind]] = []
            for art in bundle.artifacts:
                try:
                    kind = ArtifactKind(art.kind)
                except ValueError:
                    # storage requires the enum; an unknown kind CANNOT be a
                    # row. Baseline import is otherwise a verbatim copy (no
                    # registry filtering — clone must never lose data).
                    continue
                artifact_id_map[art.id] = uuid.uuid4().hex
                landable.append((art, kind))
            for art, kind in landable:
                content.create_artifact(
                    s,
                    project_id,
                    kind=kind,
                    name=art.name,
                    payload=rewrite_refs(art.payload, artifact_id_map),
                    updated_by=None,
                    artifact_id=artifact_id_map[art.id],
                )
```

(`rewrite_refs` is the module-level generic from `artifact_kinds` — kind-agnostic, works for unregistered `diagram` rows; `uuid` is already imported? check — `importer.py` does not import `uuid` today, add it.)

4. In the view branch, after `ensure_folder_ids(view)` add:

```python
            if artifact_id_map:
                _remap_view_artifact_refs(view, artifact_id_map)
```

5. CLI: add `p.add_argument("--artifacts", type=Path, default=None)` and pass `artifact_bundle=args.artifacts.read_text(encoding="utf-8") if args.artifacts else None`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_importer.py -q`
Expected: PASS

- [ ] **Step 5: Lint and commit**

```bash
pixi run backend-lint
git add src/data_rover/api/importer.py tests/api/test_importer.py
git commit -m "feat(api): baseline import carries an artifact bundle with id remap"
```

---

### Task 7: Clone fix + wizard multipart

**Files:**
- Modify: `src/data_rover/api/routes/projects.py` (`clone_project` ~:127, `create_project` ~:76)
- Test: `tests/api/test_project_clone.py`, `tests/api/test_projects_wizard.py` (append; read both files first, reuse their fixtures)

**Interfaces:**
- Consumes: Task 1's `compute_closure`/`build_bundle` — but clone copies **every** row, so use `content.list_artifacts` + `build_bundle(project, ClosureResult(rows=rows, dangling_refs=[]), roots=[r.id for r in rows])`; Task 6's `artifact_bundle` parameter.
- Produces: clone carries artifacts; `create_project` accepts an optional `artifacts` multipart file part.

- [ ] **Step 1: Write the failing clone test**

Append to `tests/api/test_project_clone.py` (reuse its existing clone-scenario fixtures/helpers — read the file first; the test below assumes a `client` making default-project requests and a clone response containing the new project id, adapt to the file's idiom):

```python
def test_clone_carries_artifacts_with_remapped_refs(client: TestClient) -> None:
    snip = client.post(
        papi("/artifacts"),
        json={"kind": "code_snippet", "name": "s",
              "payload": {"schema_version": 1, "language": "python",
                          "code": "def value(el):\n    return el.name\n"}},
        headers=AUTH_HEADERS,
    ).json()
    nav = client.post(
        papi("/artifacts"),
        json={"kind": "navigation", "name": "n",
              "payload": {"kind": "set_op", "op": "union", "operands": [{"ref": snip["id"]}]}},
        headers=AUTH_HEADERS,
    ).json()
    r = client.post(papi("/clone"), json={"name": "Klone"}, headers=AUTH_HEADERS)
    assert r.status_code == 201, r.text
    new_id = r.json()["id"]
    arts = client.get(
        f"/api/v1/projects/{new_id}/artifacts", headers=AUTH_HEADERS
    ).json()
    by_name = {a["name"]: a for a in arts}
    assert set(by_name) == {"s", "n"}
    assert by_name["s"]["id"] != snip["id"] and by_name["n"]["id"] != nav["id"]
    full_nav = client.get(
        f"/api/v1/projects/{new_id}/artifacts/{by_name['n']['id']}", headers=AUTH_HEADERS
    ).json()
    assert full_nav["payload"]["operands"][0]["ref"] == by_name["s"]["id"]
```

(Check the artifact list route's response shape in `routes/artifacts.py` — if list returns headers without payload, the follow-up GET fetches the payload as above; if the list route differs, adapt.)

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_project_clone.py -q`
Expected: the new test FAILS — clone drops artifacts today (`set(by_name)` is empty)

- [ ] **Step 3: Fix `clone_project`**

In `routes/projects.py::clone_project`, before the `importer.import_project` call:

```python
    rows = content.list_artifacts(db, project_id)
    artifact_bundle = (
        build_bundle(
            src,
            ClosureResult(rows=rows, dangling_refs=[]),
            roots=[r.id for r in rows],
        ).model_dump_json()
        if rows
        else None
    )
```

and pass `artifact_bundle=artifact_bundle` to `import_project`. Imports: `from ..artifact_bundle import ClosureResult, build_bundle`. Note this is a verbatim copy of every row (clone is a copy, not a validation gate) — the closure walk is pointless when every row is included, hence `list_artifacts`, not `compute_closure`.

Run the clone suite → PASS.

- [ ] **Step 3b: Pin artifacts-survive-eviction**

Artifacts are DB rows, independent of the in-memory `Session` — eviction must not lose them. Append to the clone test (or a sibling test): after asserting the cloned artifacts, evict the cloned project's session the way `tests/api/test_eviction.py` does (`get_registry().evict(new_id)` — copy that suite's exact idiom, it may need the snapshot store fixture), then `GET /api/v1/projects/{new_id}/artifacts` again and assert the same rows come back. Run it.

- [ ] **Step 4: Wizard multipart part + test**

Append to `tests/api/test_projects_wizard.py` (reuse its admin/multipart fixtures — read the file first):

```python
def test_create_project_with_artifact_bundle_part(...) -> None:
    # POST /api/v1/projects with files={..., "artifacts": ("b.json", bundle_bytes, "application/json")}
    # then GET the new project's /artifacts and assert the bundle landed with fresh ids.
```

Write it concretely against that file's existing multipart idiom (it already sends `metamodel`/`model`/`view` parts). Then in `create_project`:

```python
    artifacts: UploadFile | None = File(default=None),
```

and

```python
    artifact_bundle = artifacts.file.read().decode("utf-8") if artifacts is not None else None
```

Pre-validate the envelope alongside the existing pre-validation block (a bad bundle must 422 **without creating an orphan project**, same stance as metamodel/model):

```python
    if artifact_bundle is not None:
        try:
            ArtifactBundle.model_validate_json(artifact_bundle)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"invalid artifact bundle: {exc}") from exc
```

Pass `artifact_bundle=artifact_bundle` to `import_project`. Run the wizard suite → PASS.

- [ ] **Step 5: Lint and commit**

```bash
pixi run backend-lint
git add src/data_rover/api/routes/projects.py tests/api/test_project_clone.py tests/api/test_projects_wizard.py
git commit -m "fix(api): clone and wizard imports carry artifacts (no more silent drop)"
```

---

### Task 8: Docs + full gates

**Files:**
- Modify: `CLAUDE.md` (artefacts revamp section)
- No new tests.

- [ ] **Step 1: CLAUDE.md**

Extend the artefacts-revamp bullet in `CLAUDE.md` with a Phase 3 sentence (match the existing dense style; keep it SHORT — one or two sentences):

> **Import/export (artefacts revamp Phase 3)** — `api/artifact_bundle.py` owns the `datarover.artifact-bundle/v1` envelope, the `extract_deps` BFS closure, and the stateless plan→confirm import (`POST /artifacts/{export,export/preview,import/plan,import}`): confirm re-derives the plan, builds fresh-id `create_artifact` ops (refs pre-rewritten to temp/reuse ids; the commit applier resolves the rest) and lands ONE commit via `create_commit` — no leases, 409-with-fresh-plan on any stale decision or apply-time clash, and a no-op (never an empty batch) when nothing is created. `importer.import_project(artifact_bundle=…)` lands baseline artifacts with id remap + view-blob ref rewrite; `clone_project` and the wizard/CLI feed it (clone copies every row verbatim — unregistered kinds ride along; only import-from-outside filters kinds). Export/preview are viewer-allowed read-only POSTs.

- [ ] **Step 2: Full gates**

```bash
pixi run core-test
pixi run dr-tidy
pixi run backend-lint
```

Expected: all pass (frontend untouched; if `dr-tidy` reformats anything, commit the delta).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md entry for artefacts Phase 3 import/export"
```

---

## Final review & merge (per process precedent)

1. Final whole-branch review on the most capable model (`superpowers:requesting-code-review`), ONE fix wave with scoped re-reviews per round.
2. `git checkout main && git merge --no-ff feature/artefacts-phase-3-import-export`, delete the branch.
3. Push only if asked.
