"""Per-commit diff rendering (Phase 1 artefacts revamp).

Model entities: reconstruct the model at rev-1 and rev (same machinery and
cost class as GET /commits/{rev}/model) and compare only the entity ids the
commit's ops name — correct for cold projects and O(model) per request,
which the history UI tolerates like the model-at-rev endpoint.

Artifacts: journal-only. Canonical artifact ops carry full AFTER state and
their inverses full BEFORE state (the applier's invariant — see
``artifact_ops.apply_artifact_ops``), so before/after per artifact id falls
out of simulating the forward ops from the inverse-derived base. No artifact
row is read for state, which is what makes the diff of an OLD commit correct
even for an artifact deleted or re-edited since. The one thing the journal
cannot supply for an update-only commit is the artifact's KIND (neither an
update op nor its inverse carries one), so that single field falls back to the
row, and to ``"unknown"`` when a later commit deleted it.

This module is deliberately route-free: the future change-request workflow
points these same functions at a draft instead of a commit, so nothing here
may depend on FastAPI, a request, or a live ``Session``.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session as DbSession

from data_rover.core.model.element import Element
from data_rover.core.model.relationship import Relationship

from .artifact_ops import ARTIFACT_OP_KINDS, split_ops
from .db_models import Commit
from .hydration import deserialize_ops, reconstruct_model_at
from .schemas import (
    ArtifactDiffAddedOut,
    ArtifactDiffDeletedOut,
    ArtifactDiffModifiedOut,
    CommitArtifactDiffs,
    CommitDiffOut,
    CreateArtifactOp,
    CrElementOps,
    CrRelationshipOps,
    DeleteArtifactOp,
    ElementOut,
    JsonChangeOut,
    ModifiedElementOut,
    ModifiedRelationshipOut,
    RelationshipOut,
    UpdateArtifactOp,
)

#: raw journal ``kind`` tags per model-entity family (see ``_entity_ids``)
_EL_KINDS = frozenset({"create_element", "update_element", "delete_element"})
_REL_KINDS = frozenset(
    {"create_relationship", "update_relationship", "delete_relationship"}
)

#: one artifact's state at a point in time: ``{"name": str, "payload": dict}``,
#: or None for "did not exist".
_ArtifactState = dict[str, Any] | None


def json_structural_diff(
    before: Any, after: Any, path: str = ""
) -> list[JsonChangeOut]:
    """Path-level structural diff of two JSON values.

    Dicts recurse over the union of keys; ANY other difference (scalars, lists,
    type changes) is one change at the current path — lists compare wholesale
    on purpose, a reordered list is one human-reviewable change, not N index
    deltas. The root path is reported as ``"$"`` so a top-level scalar/list
    replacement still names something.
    """
    if before == after:
        return []
    if isinstance(before, dict) and isinstance(after, dict):
        out: list[JsonChangeOut] = []
        for key in sorted(set(before) | set(after)):
            sub = f"{path}.{key}" if path else key
            out.extend(json_structural_diff(before.get(key), after.get(key), sub))
        return out
    return [JsonChangeOut(path=path or "$", before=before, after=after)]


def _entity_ids(raw_ops: list[Any], kinds: frozenset[str]) -> set[str]:
    """Ids named by ops of the given family, across forward AND inverse ops.

    The inverse half is not redundant: a containment ``delete_element``
    cascades, and its forward op names only the root — the cascade victims
    appear exclusively as ``create_element``/``create_relationship`` ops on the
    inverse side (same reason ``routes/commits._affected_ids`` reads both).
    ``temp_id`` is read alongside ``id`` because canonical stored create ops
    carry the ASSIGNED id there.
    """
    ids: set[str] = set()
    for op in raw_ops:
        if op.get("kind") not in kinds:
            continue
        for key in ("id", "temp_id"):
            v = op.get(key)
            if isinstance(v, str):
                ids.add(v)
    return ids


def _artifact_states(
    commit: Commit,
) -> tuple[dict[str, _ArtifactState], dict[str, _ArtifactState], dict[str, str]]:
    """(before, after, kind_by_id) per artifact id, from the journal alone.

    ``before`` is derived from the inverse ops: undoing the commit restores
    exactly the pre-commit state, so each inverse op IS a statement of what the
    artifact looked like beforehand. ``inverse_ops`` is stored as the inverse
    UNITS reversed (undo order), so iterating it front-to-back and overwriting
    leaves the LAST occurrence per id — the earliest unit — which is the true
    pre-batch state even when one commit touches the same artifact twice.

    ``after`` then replays the forward ops on top of that base, so a create
    followed by a delete of the same artifact nets out to None/None (no diff
    entry) rather than a phantom add.
    """
    before: dict[str, _ArtifactState] = {}
    kinds: dict[str, str] = {}
    _, inverse_artifact_ops = split_ops(deserialize_ops(commit.inverse_ops))
    for op in inverse_artifact_ops:
        if isinstance(op, CreateArtifactOp):  # the forward op deleted it
            before[op.temp_id] = {"name": op.name, "payload": op.payload}
            kinds[op.temp_id] = op.artifact_kind
        elif isinstance(op, UpdateArtifactOp):  # full prior state, by invariant
            before[op.id] = {"name": op.name or "", "payload": op.payload or {}}
        elif isinstance(op, DeleteArtifactOp):  # the forward op created it
            before[op.id] = None
    after: dict[str, _ArtifactState] = {
        aid: (dict(state) if state is not None else None)
        for aid, state in before.items()
    }
    _, forward_artifact_ops = split_ops(deserialize_ops(commit.ops))
    for op in forward_artifact_ops:
        if isinstance(op, CreateArtifactOp):
            after[op.temp_id] = {"name": op.name, "payload": op.payload}
            kinds[op.temp_id] = op.artifact_kind
        elif isinstance(op, UpdateArtifactOp):
            # a name-only or payload-only update leaves the other field alone
            prev = after.get(op.id) or {"name": "", "payload": {}}
            after[op.id] = {
                "name": op.name if op.name is not None else prev["name"],
                "payload": op.payload if op.payload is not None else prev["payload"],
            }
        elif isinstance(op, DeleteArtifactOp):
            after[op.id] = None
    return before, after, kinds


def _kind_from_row(db: DbSession, artifact_id: str) -> str:
    """Resolve an artifact's kind from its row (update-only commits only).

    The applier's update inverse carries no kind, and kind is immutable for the
    life of a row, so a row lookup is exact whenever the row still exists. The
    ``"unknown"`` fallback is reached only for an artifact a LATER commit
    deleted — the diff's states stay correct, only this label degrades.

    Imported locally: this module must stay route-free and content.py is a
    service module, but the import is kept out of the header so the dependency
    reads as "one narrow fallback", not a structural one.
    """
    from . import content

    row = content.get_artifact(db, artifact_id)
    return row.kind.value if row is not None else "unknown"


def _element_diffs(
    ids: set[str], before: dict[str, Element], after: dict[str, Element]
) -> CrElementOps:
    out = CrElementOps()
    for eid in sorted(ids):
        b, a = before.get(eid), after.get(eid)
        if b is None and a is not None:
            out.added.append(ElementOut.from_core(a))
        elif b is not None and a is None:
            out.deleted.append(ElementOut.from_core(b))
        elif b is not None and a is not None:
            bo, ao = ElementOut.from_core(b), ElementOut.from_core(a)
            if bo != ao:
                out.modified.append(ModifiedElementOut(id=eid, before=bo, after=ao))
    return out


def _relationship_diffs(
    ids: set[str], before: dict[str, Relationship], after: dict[str, Relationship]
) -> CrRelationshipOps:
    out = CrRelationshipOps()
    for rid in sorted(ids):
        b, a = before.get(rid), after.get(rid)
        if b is None and a is not None:
            out.added.append(RelationshipOut.from_core(a))
        elif b is not None and a is None:
            out.deleted.append(RelationshipOut.from_core(b))
        elif b is not None and a is not None:
            bo, ao = RelationshipOut.from_core(b), RelationshipOut.from_core(a)
            if bo != ao:
                out.modified.append(
                    ModifiedRelationshipOut(id=rid, before=bo, after=ao)
                )
    return out


def _artifact_diffs(db: DbSession, commit: Commit) -> CommitArtifactDiffs:
    art_before, art_after, art_kinds = _artifact_states(commit)
    out = CommitArtifactDiffs()
    for aid in sorted(set(art_before) | set(art_after)):
        b, a = art_before.get(aid), art_after.get(aid)
        if b is None and a is None:
            continue  # created and deleted within this same commit — a no-op
        kind = art_kinds.get(aid) or _kind_from_row(db, aid)
        if b is None and a is not None:
            out.added.append(
                ArtifactDiffAddedOut(
                    id=aid, kind=kind, name=a["name"], payload=a["payload"]
                )
            )
        elif b is not None and a is None:
            out.deleted.append(
                ArtifactDiffDeletedOut(
                    id=aid, kind=kind, name=b["name"], payload=b["payload"]
                )
            )
        elif b is not None and a is not None and b != a:
            out.modified.append(
                ArtifactDiffModifiedOut(
                    id=aid,
                    kind=kind,
                    name_before=b["name"],
                    name_after=a["name"],
                    changes=json_structural_diff(b["payload"], a["payload"]),
                )
            )
    return out


def diff_commit(db: DbSession, project_id: str, commit: Commit) -> CommitDiffOut:
    """Render one commit's changes across content families.

    Two mechanisms on purpose (see the module docstring): model entities are
    reconstructed at rev-1 and rev and compared, artifacts are read straight
    out of the journal. Only the ids the commit's ops name are compared, so the
    response size tracks the commit, not the model.

    A commit that names no model entity at all (a pure-artifact commit, an
    empty batch, a rebind) skips reconstruction entirely: the entity halves
    iterate over the named ids only, so both sides would be discarded anyway,
    and the model can be ~80 MB — paying two reconstructions to render an
    unavoidably empty model diff is the one cost worth short-circuiting here.
    """
    raw = [*commit.ops, *commit.inverse_ops]
    el_ids = _entity_ids(raw, _EL_KINDS)
    rel_ids = _entity_ids(raw, _REL_KINDS)

    b_el: dict[str, Element] = {}
    a_el: dict[str, Element] = {}
    b_rel: dict[str, Relationship] = {}
    a_rel: dict[str, Relationship] = {}
    if el_ids or rel_ids:
        m_before = reconstruct_model_at(project_id, commit.rev - 1)
        m_after = reconstruct_model_at(project_id, commit.rev)
        if m_before is not None:
            b_el, b_rel = m_before.elements, m_before.relationships
        if m_after is not None:
            a_el, a_rel = m_after.elements, m_after.relationships

    # A rebind commit carries no ops at all but changes how the model reads, so
    # it still counts as touching the model scope; an empty batch reports
    # "model" too, so the list is never empty (mirrors the commit feed event).
    is_rebind = (
        commit.from_metamodel_id is not None or commit.to_metamodel_id is not None
    )
    has_artifact = any(op.get("kind") in ARTIFACT_OP_KINDS for op in commit.ops)
    has_model = any(op.get("kind") not in ARTIFACT_OP_KINDS for op in commit.ops)
    scope = sorted(
        ({"model"} if has_model or is_rebind else set())
        | ({"artifact"} if has_artifact else set())
    ) or ["model"]

    return CommitDiffOut(
        rev=commit.rev,
        commit_id=commit.commit_id,
        author_id=commit.author_id,
        ts=commit.ts,
        message=commit.message,
        scope=scope,
        is_rebind=is_rebind,
        elements=_element_diffs(el_ids, b_el, a_el),
        relationships=_relationship_diffs(rel_ids, b_rel, a_rel),
        artifacts=_artifact_diffs(db, commit),
    )
