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
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, cast

from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DbSession

from . import content
from .artifact_kinds import extract_refs, get_spec
from .db_models import ArtifactKind, ArtifactRow, Project
from .schemas import TEMP_ID_PREFIX, CreateArtifactOp

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


class ExportRequest(BaseModel):
    root_ids: list[str] = Field(default_factory=list)


class ExportPreviewArtifact(BaseModel):
    id: str
    kind: str
    name: str


class ExportPreviewResponse(BaseModel):
    artifacts: list[ExportPreviewArtifact] = Field(default_factory=list)
    dangling_refs: list[str] = Field(default_factory=list)


class PlanEntry(BaseModel):
    bundle_id: str
    kind: str
    name: str
    action: Literal["create", "reuse", "copy"]
    existing_id: str | None = None
    #: the free name a COPY of this artifact would take. Set on reuse entries
    #: too, not just copy ones: the client may flip reuse -> copy at confirm
    #: time, and `build_import_ops` (which has no DB session) can only honor
    #: that flip if the plan already reserved a DB-aware free name for it.
    #: None only for "create", where the bundle's own name is already free.
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
        if not art.name:
            # This loop is the ONLY filter between an untrusted uploaded
            # bundle and the `CreateArtifactOp`s build_import_ops constructs,
            # and that op's `name` is the one field carrying a pydantic
            # constraint the bundle schema does not (`min_length=1` —
            # `BundleArtifact.name` is a bare `str` on purpose, so a bundle
            # from a newer server still parses). Without this skip an empty
            # name reaches the op constructor and raises a ValidationError
            # that escapes the confirm route UNCAUGHT as a 500, adding a
            # fourth outcome to its 200/409/422 contract — and it would do so
            # only at confirm, after the plan route had already answered 200
            # for the same bundle. Skipping keeps the two answers consistent
            # and matches the tolerant stance of the checks below: a
            # malformed artifact is reported, never fatal to its siblings.
            skipped.append(SkippedEntry(bundle_id=art.id, reason="empty name"))
            continue
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

    #: names already taken per kind — existing DB rows, PLUS every bundle
    #: artifact's own name for that kind, plus names this plan hands out as it
    #: goes. The bundle-side names are load-bearing, not just belt-and-braces:
    #: a create-entry's name becomes a real (kind, name) row the moment this
    #: plan is executed, so a LATER copy's dedupe_name must dodge it too, or
    #: two entries in the same plan (one create, one copy) can propose the
    #: same target name and collide on `uq_artifact_project_kind_name` when
    #: both ops land. Seeding from `valid` (computed above, before this loop)
    #: means the full bundle-side name set for a kind is known regardless of
    #: which entry happens to be processed first.
    taken: dict[ArtifactKind, set[str]] = {}

    def _taken_names(kind: ArtifactKind) -> set[str]:
        if kind not in taken:
            names = {r.name for r in content.list_artifacts(db, project_id, kind)}
            names.update(a.name for a, k, _existing in valid if k == kind)
            taken[kind] = names
        return taken[kind]

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
        # Reserved for BOTH clash outcomes (see PlanEntry.copy_name): a reuse
        # entry the user flips to copy needs a free name just as much as a
        # proposed copy does, and only this loop can see the full name pool.
        # Reserving unconditionally means an accepted reuse burns a suffix
        # number nobody uses — harmless, and strictly safer than handing the
        # same name to two entries that could both land.
        names = _taken_names(kind)
        copy_name = dedupe_name(names, art.name)
        names.add(copy_name)
        # `existing.payload` is normalized too, not compared raw: real writes
        # already ran it through this same derive_metadata pass, so this is a
        # no-op for production rows, but it keeps the comparison honest for
        # rows a test (or a pre-derive_metadata-era import) wrote directly.
        if _canonical(rewritten) == _canonical(_normalized_payload(kind, existing.payload)):
            entries.append(
                PlanEntry(
                    bundle_id=art.id,
                    kind=art.kind,
                    name=art.name,
                    action="reuse",
                    existing_id=existing.id,
                    copy_name=copy_name,
                )
            )
            continue
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


class StalePlanError(Exception):
    """A decision references state the FRESH plan can't honor (target gone,
    name newly clashing, unknown bundle id). The confirm route maps this to
    409 + the fresh plan."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class ImportConfirmRequest(BaseModel):
    bundle: ArtifactBundle
    decisions: dict[str, Literal["create", "reuse", "copy"]] = Field(
        default_factory=dict
    )
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
    """Turn a FRESH plan plus the client's decisions into one create batch.

    Decide-and-pin: the plan the client decided against may be minutes old, so
    every decision is re-checked against *plan* (re-derived at confirm time)
    and anything it can no longer honor raises :class:`StalePlanError` rather
    than being silently downgraded — the client re-renders and re-decides. The
    "create" case is the load-bearing one: a peer claiming (kind, name) in the
    meantime flips the fresh action to reuse/copy, and creating anyway would
    trip ``uq_artifact_project_kind_name`` inside the commit.
    """
    entries = {e.bundle_id: e for e in plan.entries}
    for bid in decisions:
        if bid not in entries:
            # Covers both "never in this bundle" and "the fresh plan SKIPPED
            # it" (unknown/unregistered kind, invalid payload) — either way
            # there is no entry to act on.
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
            # An explicit client name wins; otherwise the plan's deduped
            # proposal, which already dodged every name this plan hands out.
            # `e.name` is the last resort only for a copy DECISION on an entry
            # the plan proposed as create (no clash -> no copy_name), where the
            # bundle's own name is by construction free.
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
                # narrowing only: derive_plan drops every kind that isn't a
                # registered ArtifactKind, so e.kind is always one of the
                # literal members (re-proved by the get_spec assert above).
                artifact_kind=cast(Any, e.kind),
                name=final_names[e.bundle_id],
                payload=spec.rewrite_refs(payloads[e.bundle_id], ref_map),
            )
        )
    return ops, reused, final_names
