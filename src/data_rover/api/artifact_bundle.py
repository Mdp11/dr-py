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

from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DbSession

from . import content
from .artifact_kinds import extract_refs, get_spec
from .db_models import ArtifactRow, Project

BUNDLE_FORMAT: Literal["datarover.artifact-bundle/v1"] = "datarover.artifact-bundle/v1"


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
    # `seen` gates queue admission so a diamond-shaped dependency graph (two
    # roots sharing a dep) enqueues that dep exactly once, and a cycle back to
    # an already-queued/visited id is silently absorbed rather than looping.
    seen: set[str] = set(dict.fromkeys(root_ids))
    queue = deque(dict.fromkeys(root_ids))
    while queue:
        aid = queue.popleft()
        row = content.get_artifact(db, aid)
        # A ref crossing projects must NOT be followed even though the row
        # exists in the DB — closures are project-scoped, so a foreign row is
        # indistinguishable from a missing one to this project's export.
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
            BundleArtifact(id=r.id, kind=r.kind.value, name=r.name, payload=r.payload)
            for r in closure.rows
        ],
    )
