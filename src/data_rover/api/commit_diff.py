"""Per-commit diff rendering.

Model entities: journal-only when the commit row carries ``entity_states``
— the full before/after state of every entity the batch touched, captured
at commit time (``commit_states``) because the inverse ops alone cannot
render a ``modified`` entry: an update's inverse patch carries only the
touched keys, never the whole entity. A row without it (written before the
column existed, or a batch over ``ENTITY_STATES_MAX``) falls back to
reconstructing the model at rev-1 and rev (same machinery and cost class as
GET /commits/{rev}/model) and comparing only the ids the commit's ops name.
Both paths feed the same renderer, so the output is identical.

Artifacts: journal-only. Canonical artifact ops carry full AFTER state and
their inverses full BEFORE state (the applier's invariant — see
``artifact_ops.apply_artifact_ops``), so before/after per artifact id falls
out of simulating the forward ops from the inverse-derived base. No artifact
row is read for state, which is what makes the diff of an OLD commit correct
even for an artifact deleted or re-edited since. The one thing the journal
cannot supply for an update-only commit is the artifact's KIND (neither an
update op nor its inverse carries one), so that single field falls back to the
row, and to ``"unknown"`` when a later commit deleted it.

View: also journal-only, but unlike artifacts there is no before/after
reconstruction at all — the view ops family is fine-grained enough on the
wire that the canonical ops themselves ARE the diff. Only the "prior name"
fields (rename/delete) need the inverse half, the same one-name-not-a-state
narrowness the artifact section's ``kind`` fallback has. No ``ViewRow`` is
ever read here, so an old commit's view diff stays correct after the folder
in question has since been renamed again or deleted.

Metamodel + layout: a rebind-carrying commit's structural
half is rendered neither from the model reconstruction nor from the ops
journal, but recomputed from the two immutable ``MetamodelRow`` blobs named
by the commit's ``from_metamodel_id``/``to_metamodel_id`` columns
(``_metamodel_structural``) — the same "recompute, never store" stance as the
model half, but off metamodel rows instead of model revs, since the rebind op
itself carries only the raw YAML, not a structural diff. The layout half is
journal-only like artifacts/view, but reads the FORWARD ops alone
(``_layout_moves``): a ``metamodel.move_node`` write has no cascade, so the
inverse side adds nothing the forward op doesn't already name, and the
surface promises "N nodes moved", not per-coordinate before/after. The two
halves are independent and can both be present on one commit (a rebind that
also repositions nodes it renamed).

This module is deliberately route-free: the future change-request workflow
points these same functions at a draft instead of a commit, so nothing here
may depend on FastAPI, a request, or a live ``Session``.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, assert_never

import yaml
from sqlalchemy.orm import Session as DbSession

from data_rover.core.metamodel.diff import MetamodelStructuralDiff, diff_metamodels
from data_rover.core.metamodel.loader import MetamodelError, load_metamodel_str
from data_rover.core.model.model import Model

from . import content
from .artifact_ops import ARTIFACT_OP_KINDS, split_ops
from .commit_states import (
    ElementPair,
    EntityStates,
    RelationshipPair,
    load_entity_states,
)
from .db_models import Commit
from .hydration import deserialize_ops, reconstruct_model_at
from .schemas import (
    METAMODEL_OP_KINDS,
    VIEW_OP_KINDS,
    ArtifactDiffAddedOut,
    ArtifactDiffDeletedOut,
    ArtifactDiffModifiedOut,
    CommitArtifactDiffs,
    CommitDiffOut,
    CreateArtifactOp,
    CreateFolderOp,
    CrElementOps,
    CrRelationshipOps,
    DeleteArtifactOp,
    DeleteFolderOp,
    ElementOut,
    JsonChangeOut,
    LayoutMoveOut,
    ModifiedElementOut,
    ModifiedRelationshipOut,
    MoveArtifactOp,
    MoveElementOp,
    MoveFolderOp,
    MoveMetamodelNodeOp,
    PlaceArtifactOp,
    PlaceElementOp,
    RelationshipOut,
    RemoveArtifactOp,
    RemoveElementOp,
    RenameFolderOp,
    UpdateArtifactOp,
    ViewDiffEntryOut,
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
    _, inverse_artifact_ops, _, _ = split_ops(deserialize_ops(commit.inverse_ops))
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
    _, forward_artifact_ops, _, _ = split_ops(deserialize_ops(commit.ops))
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


def _kind_from_row(db: DbSession, project_id: str, artifact_id: str) -> str:
    """Resolve an artifact's kind from its row (update-only commits only).

    The applier's update inverse carries no kind, and kind is immutable for the
    life of a row, so a row lookup is exact whenever the row still exists. The
    ``"unknown"`` fallback is reached only for an artifact a LATER commit
    deleted — the diff's states stay correct, only this label degrades.

    Project-scoped like every other content read (``artifact_ops._require_row``
    is the model): uuid4 ids make a cross-tenant hit unreachable in practice,
    but a bare PK lookup is still the wrong SHAPE — the scoping is what keeps
    it unreachable BY CONSTRUCTION rather than by id entropy.

    ``content`` is a service module (no FastAPI/route dependency), so a
    module-level import keeps this module's route-free stance (see the module
    docstring) intact — it is also used at the top level by
    ``_metamodel_structural`` below.
    """
    row = content.get_artifact(db, artifact_id)
    if row is None or row.project_id != project_id:
        return "unknown"
    return row.kind.value


def _element_diffs(states: Mapping[str, ElementPair]) -> CrElementOps:
    out = CrElementOps()
    for eid in sorted(states):
        bo, ao = states[eid]
        if bo is None and ao is not None:
            out.added.append(ao)
        elif bo is not None and ao is None:
            out.deleted.append(bo)
        elif bo is not None and ao is not None and bo != ao:
            out.modified.append(ModifiedElementOut(id=eid, before=bo, after=ao))
    return out


def _relationship_diffs(states: Mapping[str, RelationshipPair]) -> CrRelationshipOps:
    out = CrRelationshipOps()
    for rid in sorted(states):
        bo, ao = states[rid]
        if bo is None and ao is not None:
            out.added.append(ao)
        elif bo is not None and ao is None:
            out.deleted.append(bo)
        elif bo is not None and ao is not None and bo != ao:
            out.modified.append(ModifiedRelationshipOut(id=rid, before=bo, after=ao))
    return out


def _states_from_models(
    el_ids: set[str],
    rel_ids: set[str],
    before: Model | None,
    after: Model | None,
) -> EntityStates:
    """The reconstruction fallback's input: pairs for exactly the ids the
    commit's ops name, read off two throwaway models (None = contentless)."""
    b_el = before.elements if before is not None else {}
    a_el = after.elements if after is not None else {}
    b_rel = before.relationships if before is not None else {}
    a_rel = after.relationships if after is not None else {}
    elements: dict[str, ElementPair] = {}
    for eid in el_ids:
        b, a = b_el.get(eid), a_el.get(eid)
        elements[eid] = (
            ElementOut.from_core(b) if b is not None else None,
            ElementOut.from_core(a) if a is not None else None,
        )
    relationships: dict[str, RelationshipPair] = {}
    for rid in rel_ids:
        rb, ra = b_rel.get(rid), a_rel.get(rid)
        relationships[rid] = (
            RelationshipOut.from_core(rb) if rb is not None else None,
            RelationshipOut.from_core(ra) if ra is not None else None,
        )
    return EntityStates(elements=elements, relationships=relationships)


def _artifact_diffs(
    db: DbSession, project_id: str, commit: Commit
) -> CommitArtifactDiffs:
    art_before, art_after, art_kinds = _artifact_states(commit)
    out = CommitArtifactDiffs()
    for aid in sorted(set(art_before) | set(art_after)):
        b, a = art_before.get(aid), art_after.get(aid)
        if b is None and a is None:
            continue  # created and deleted within this same commit — a no-op
        kind = art_kinds.get(aid) or _kind_from_row(db, project_id, aid)
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


def _metamodel_structural(
    db: DbSession, commit: Commit
) -> MetamodelStructuralDiff | None:
    """The rebind commit's document diff, recomputed from the two immutable
    MetamodelRow blobs — never stored. Total: any missing id,
    missing row, or unparseable blob degrades to None — a broken historical
    blob must not 500 the whole commit diff."""
    if commit.from_metamodel_id is None or commit.to_metamodel_id is None:
        return None
    before = content.get_metamodel_row(db, commit.from_metamodel_id)
    after = content.get_metamodel_row(db, commit.to_metamodel_id)
    if before is None or after is None:
        return None
    try:
        return diff_metamodels(
            load_metamodel_str(before.blob), load_metamodel_str(after.blob)
        )
    except MetamodelError, yaml.YAMLError:
        return None


def _view_diffs(commit: Commit) -> list[ViewDiffEntryOut]:
    """Render the view half journal-only (module docstring: same stance as
    artifacts). Prior names come from the inverse half: a rename's inverse
    carries the old name, and a delete's inverse unit RECREATES the subtree,
    so its create ops name every deleted folder."""
    _, _, forward, _ = split_ops(deserialize_ops(commit.ops))
    _, _, inverse, _ = split_ops(deserialize_ops(commit.inverse_ops))
    names_before: dict[str, str] = {}
    for op in inverse:
        if isinstance(op, RenameFolderOp):
            # inverse units are stored reversed (undo order): the LAST write
            # per id is the earliest unit == the true pre-batch name.
            names_before[op.id] = op.name
        elif isinstance(op, CreateFolderOp):
            names_before[op.temp_id] = op.name

    out: list[ViewDiffEntryOut] = []
    for op in forward:
        if isinstance(op, CreateFolderOp):
            out.append(
                ViewDiffEntryOut(
                    kind=op.kind,
                    view_id=op.view_id,
                    folder_id=op.temp_id,  # canonical ops carry the real id
                    name=op.name,
                    parent_id=op.parent_id,
                    index=op.index,
                )
            )
        elif isinstance(op, RenameFolderOp):
            out.append(
                ViewDiffEntryOut(
                    kind=op.kind,
                    view_id=op.view_id,
                    folder_id=op.id,
                    name=op.name,
                    name_before=names_before.get(op.id),
                )
            )
        elif isinstance(op, MoveFolderOp):
            out.append(
                ViewDiffEntryOut(
                    kind=op.kind,
                    view_id=op.view_id,
                    folder_id=op.id,
                    to_folder_id=op.to_parent_id,
                    index=op.index,
                    name_before=names_before.get(op.id),
                )
            )
        elif isinstance(op, DeleteFolderOp):
            out.append(
                ViewDiffEntryOut(
                    kind=op.kind,
                    view_id=op.view_id,
                    folder_id=op.id,
                    name_before=names_before.get(op.id),
                )
            )
        elif isinstance(op, (PlaceElementOp, RemoveElementOp)):
            out.append(
                ViewDiffEntryOut(
                    kind=op.kind,
                    view_id=op.view_id,
                    folder_id=op.folder_id,
                    element_id=op.element_id,
                    index=getattr(op, "index", None),
                )
            )
        elif isinstance(op, MoveElementOp):
            out.append(
                ViewDiffEntryOut(
                    kind=op.kind,
                    view_id=op.view_id,
                    element_id=op.element_id,
                    from_folder_id=op.from_folder_id,
                    to_folder_id=op.to_folder_id,
                    index=op.index,
                )
            )
        elif isinstance(op, (PlaceArtifactOp, RemoveArtifactOp)):
            out.append(
                ViewDiffEntryOut(
                    kind=op.kind,
                    view_id=op.view_id,
                    folder_id=op.folder_id,
                    artifact_id=op.artifact_id,
                    artifact_kind=getattr(op, "artifact_kind", None),
                    index=getattr(op, "index", None),
                )
            )
        elif isinstance(op, MoveArtifactOp):
            out.append(
                ViewDiffEntryOut(
                    kind=op.kind,
                    view_id=op.view_id,
                    artifact_id=op.artifact_id,
                    from_folder_id=op.from_folder_id,
                    to_folder_id=op.to_folder_id,
                    index=op.index,
                )
            )
        else:
            assert_never(op)
    return out


def _layout_moves(commit: Commit) -> list[LayoutMoveOut]:
    """Journal-only summary of the layout half — a moved node's destination
    (x/y None = key removed). Deliberately no before/after per coordinate:
    the diff surface promises "N nodes moved", not pixel history.

    Reads the FORWARD ops only (unlike the model/artifact/view halves above):
    a layout write carries no cascade, so there is nothing the inverse side
    would add that the forward ops don't already name. ``split_ops`` returns
    a 4-tuple here (model, artifact, view, metamodel); this helper wants only
    the fourth slot, a rebind-carrying batch's own ``metamodel.rebind`` op
    simply isn't a ``MoveMetamodelNodeOp`` and is filtered out by the
    ``isinstance`` check below — so a mixed rebind+move commit still renders
    just its moves here, with the structural rebind half rendered separately
    by ``_metamodel_structural``.
    """
    _, _, _, forward = split_ops(deserialize_ops(commit.ops))
    return [
        LayoutMoveOut(
            node=op.node,
            x=op.pos.x if op.pos is not None else None,
            y=op.pos.y if op.pos is not None else None,
        )
        for op in forward
        if isinstance(op, MoveMetamodelNodeOp)
    ]


def diff_commit(db: DbSession, project_id: str, commit: Commit) -> CommitDiffOut:
    """Render one commit's changes across content families.

    Four mechanisms on purpose (see the module docstring): model entities are
    read from the row's captured ``entity_states`` when present and
    reconstructed at rev-1 and rev only for rows without them (pre-column
    rows, over-cap batches), artifacts are read straight out of the journal
    (state simulated from the inverse-derived base), view ops are rendered
    as-is — the ops ARE the diff, no reconstruction at all — and the
    metamodel/layout half is its own pair: the rebind's structural diff is
    recomputed from the two immutable metamodel rows the commit names, while
    layout moves are read journal-only off the forward ops.

    A fallback commit that names no model entity at all (a pure-artifact
    commit, an empty batch, a rebind) skips reconstruction entirely: the
    entity halves iterate over the named ids only, so both sides would be
    discarded anyway, and the model can be ~80 MB — paying two
    reconstructions to render an unavoidably empty model diff is the one cost
    worth short-circuiting here.
    """
    if commit.entity_states is not None:
        states = load_entity_states(commit.entity_states)
    else:
        raw = [*commit.ops, *commit.inverse_ops]
        el_ids = _entity_ids(raw, _EL_KINDS)
        rel_ids = _entity_ids(raw, _REL_KINDS)
        m_before = m_after = None
        if el_ids or rel_ids:
            m_before = reconstruct_model_at(project_id, commit.rev - 1)
            m_after = reconstruct_model_at(project_id, commit.rev)
        states = _states_from_models(el_ids, rel_ids, m_before, m_after)

    # A rebind commit carries no ops at all but changes how the model reads, so
    # it still counts as touching the model scope; an empty batch reports
    # "model" too, so the list is never empty (mirrors the commit feed event).
    is_rebind = (
        commit.from_metamodel_id is not None or commit.to_metamodel_id is not None
    )
    has_artifact = any(op.get("kind") in ARTIFACT_OP_KINDS for op in commit.ops)
    has_view = any(op.get("kind") in VIEW_OP_KINDS for op in commit.ops)
    has_layout = any(op.get("kind") == "metamodel.move_node" for op in commit.ops)
    has_model = any(
        op.get("kind") not in ARTIFACT_OP_KINDS
        and op.get("kind") not in VIEW_OP_KINDS
        and op.get("kind") not in METAMODEL_OP_KINDS
        for op in commit.ops
    )
    scope = sorted(
        ({"model"} if has_model or is_rebind else set())
        | ({"artifact"} if has_artifact else set())
        | ({"view"} if has_view else set())
        | ({"metamodel-layout"} if has_layout else set())
    ) or ["model"]

    return CommitDiffOut(
        rev=commit.rev,
        commit_id=commit.commit_id,
        author_id=commit.author_id,
        ts=commit.ts,
        message=commit.message,
        scope=scope,
        is_rebind=is_rebind,
        elements=_element_diffs(states.elements),
        relationships=_relationship_diffs(states.relationships),
        artifacts=_artifact_diffs(db, project_id, commit),
        view=_view_diffs(commit),
        metamodel=_metamodel_structural(db, commit) if is_rebind else None,
        layout_moves=_layout_moves(commit),
    )
