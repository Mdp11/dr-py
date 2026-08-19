from __future__ import annotations

from dataclasses import asdict
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

from data_rover.core.metamodel.diff import MetamodelStructuralDiff
from data_rover.core.model.change_request import (
    ChangeRequest as CoreChangeRequest,
    ModifiedElement as CoreModifiedElement,
    ModifiedRelationship as CoreModifiedRelationship,
)
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship
from data_rover.core.navigation.schema import NavigationDefinition
from data_rover.core.script.schema import SNIPPET_MAX_CODE_BYTES
from data_rover.core.script.warnings import ScriptWarning
from data_rover.core.table.schema import TableDefinition
from data_rover.core.validation.issue import Issue
from data_rover.core.view.schema import Folder, View


class ElementOut(BaseModel):
    id: str
    type_name: str
    properties: dict[str, Any] = Field(default_factory=dict)
    rev: int = 0

    @classmethod
    def from_core(cls, element: Element) -> ElementOut:
        return cls(**asdict(element))


class TreeItem(BaseModel):
    """Lightweight tree-row projection: everything Sidebar/TreeRow.svelte
    renders for a row (display name, type, expand caret) WITHOUT the element's
    full ``properties`` bag. A ~1k-row folder ships as tens of KB instead of
    many MB, and the payload cost no longer scales with property size."""

    id: str
    type_name: str
    display_name: str
    child_count: int = 0


class TreeItemPage(BaseModel):
    items: list[TreeItem] = Field(default_factory=list)
    #: number of items BEFORE limit/offset paging
    total: int = 0


class RelationshipOut(BaseModel):
    id: str
    type_name: str
    source_id: str
    target_id: str
    properties: dict[str, Any] = Field(default_factory=dict)
    rev: int = 0

    @classmethod
    def from_core(cls, rel: Relationship) -> RelationshipOut:
        return cls(**asdict(rel))


class ModelOut(BaseModel):
    elements: list[ElementOut]
    relationships: list[RelationshipOut]

    @classmethod
    def from_core(cls, model: Model) -> ModelOut:
        return cls(
            elements=[ElementOut.from_core(e) for e in model.elements.values()],
            relationships=[
                RelationshipOut.from_core(r) for r in model.relationships.values()
            ],
        )


class CreateElementRequest(BaseModel):
    type: str
    properties: dict[str, Any] = Field(default_factory=dict)


class UpdateElementRequest(BaseModel):
    properties: dict[str, Any]


class CreateRelationshipRequest(BaseModel):
    type: str
    source_id: str
    target_id: str


class InlineModel(BaseModel):
    elements: list[ElementOut] = Field(default_factory=list)
    relationships: list[RelationshipOut] = Field(default_factory=list)


class SnapshotIn(BaseModel):
    elements: list[ElementOut] = Field(default_factory=list)
    relationships: list[RelationshipOut] = Field(default_factory=list)


class ValidateRequest(BaseModel):
    scope: list[str] | None = None
    inline: InlineModel | None = None
    #: staged (uncommitted) op batch to validate against the committed model;
    #: when present, the response tags each issue's origin. Mirrors PreviewRequest.
    ops: list[OpIn] | None = None
    #: model_rev the ops were computed against; mismatch -> 409 (like preview).
    base_rev: int | None = None


class IssueOut(BaseModel):
    severity: str
    message: str
    target_ids: list[str] = Field(default_factory=list)
    category: str = "conformance"
    #: producing validator's stable name (e.g. "multiplicity", "facets", or
    #: "view" for view-tree warnings); "" for issues with no known producer.
    #: Defaults so pre-existing durable `Commit.issues` JSON rows (persisted
    #: before this field existed) still parse.
    check: str = ""
    #: relationship to the committed model: "on_server" (pre-existing),
    #: "uncommitted" (introduced by staged edits), or "resolved" (fixed by them).
    origin: str = "on_server"

    @classmethod
    def from_core(cls, issue: Issue, origin: str = "on_server") -> IssueOut:
        return cls(
            severity=issue.severity.value,
            message=issue.message,
            target_ids=list(issue.target_ids),
            category=issue.category.value,
            check=issue.check,
            origin=origin,
        )


class IssueListOut(BaseModel):
    """Snapshot of the session's maintained issue store (GET /model/issues).

    A cheap read — never a pipeline run: the store is seeded at load/hydrate,
    streamed into by the background sweep, and spliced by every commit.
    ``counts`` is exact even when ``issues`` is truncated, so a client can
    always render true totals.
    """

    model_config = ConfigDict(protected_namespaces=())

    model_rev: int
    issues: list[IssueOut] = Field(default_factory=list)
    counts: dict[str, int] = Field(default_factory=dict)
    truncated: bool = False


class RawMetamodelResponse(BaseModel):
    """The current metamodel's SOURCE text (Phase 5 editor baseline).

    ``blob`` is the stored ``MetamodelRow`` YAML verbatim — comments and
    formatting intact (the rebind route's persist-the-original-blob
    invariant made visible). ``source`` is ``"serialized"`` only on the
    degraded fallback where no durable row resolves and the in-memory
    metamodel is re-serialized instead.
    """

    blob: str
    source: Literal["stored", "serialized"]


class LintErrorOut(BaseModel):
    """One metamodel lint finding. Position is best-effort: YAML syntax
    errors carry a 1-based line/column from the parser mark; schema errors
    (``MetamodelError``) are message-only."""

    message: str
    line: int | None = None
    column: int | None = None


class MetamodelLintResponse(BaseModel):
    """Cheap parse/schema check for the live editor (Phase 5). Always 200 —
    a failed parse is the RESULT, not an error."""

    ok: bool
    errors: list[LintErrorOut] = Field(default_factory=list)


class MetamodelDiffResponse(BaseModel):
    """Read-only sandbox conformance diff (Phase 6B) + structural document
    diff (Phase 4). now_failing = issues the candidate metamodel introduces;
    now_passing = issues it resolves; structural = what changed in the
    document itself (one differ, also rendered by the commit-diff API)."""

    now_failing: list[IssueOut]
    now_passing: list[IssueOut]
    unchanged_count: int
    current_error_count: int
    candidate_error_count: int
    structural: MetamodelStructuralDiff = Field(default_factory=MetamodelStructuralDiff)


class ArtifactRefOut(BaseModel):
    id: str
    kind: str


class FolderOut(BaseModel):
    #: mirrors `Folder.id`; "" means not yet assigned (legacy blob healed at
    #: hydration/import time — this field just carries whatever the core
    #: side already has).
    id: str = ""
    name: str
    folders: list[FolderOut] = Field(default_factory=list)
    elements: list[str] = Field(default_factory=list)
    artifacts: list[ArtifactRefOut] = Field(default_factory=list)

    @classmethod
    def from_core(cls, folder: Folder) -> FolderOut:
        return cls(
            id=folder.id,
            name=folder.name,
            folders=[FolderOut.from_core(f) for f in folder.folders],
            elements=list(folder.elements),
            artifacts=[ArtifactRefOut(id=a.id, kind=a.kind) for a in folder.artifacts],
        )


FolderOut.model_rebuild()


class ViewOut(BaseModel):
    name: str
    folders: list[FolderOut] = Field(default_factory=list)
    #: Root-level artifact refs. Before Phase 2 this field did not exist, so
    #: `View.artifacts` was silently dropped on every wire response even
    #: though the core model always carried it — this field is the fix.
    #: Additive: old clients that don't know about it simply ignore it.
    artifacts: list[ArtifactRefOut] = Field(default_factory=list)

    @classmethod
    def from_core(cls, view: View) -> ViewOut:
        return cls(
            name=view.name,
            folders=[FolderOut.from_core(f) for f in view.folders],
            artifacts=[ArtifactRefOut(id=a.id, kind=a.kind) for a in view.artifacts],
        )


class ViewStateResponse(BaseModel):
    view: ViewOut | None = None
    warnings: list[IssueOut] = Field(default_factory=list)
    #: None when no ``ViewRow`` exists for the project (nothing has ever been
    #: saved); an int (possibly 0, pre-any-edit) once one does.
    view_rev: int | None = None


# ---------------------------------------------------------------------------
# Delta-protocol op schemas (POST /model/ops) — mirror frontend
# `frontend/src/lib/state/ops.ts` exactly (THE FILE IS THE CONTRACT)
# ---------------------------------------------------------------------------

#: Client-generated provisional ids carry this prefix (mirrors
#: ``TEMP_ID_PREFIX`` in ``frontend/src/lib/state/ops.ts``). It lives HERE, with
#: the op union it belongs to, because it is part of that wire contract and
#: every module that reasons about ops needs it: ``routes/ops.py`` (re-exported
#: from there for its long-standing importers), ``artifact_ops.py`` and
#: ``locking.py``. It used to be copied literally into each — a copy is exactly
#: how the applier and the lock-scope derivation could come to disagree about
#: which ids are "not yet shared".
TEMP_ID_PREFIX = "tmp_"


class CreateElementOp(BaseModel):
    kind: Literal["create_element"]
    temp_id: str
    type_name: str
    properties: dict[str, Any] = Field(default_factory=dict)


class UpdateElementOp(BaseModel):
    kind: Literal["update_element"]
    id: str
    #: JSON-merge-patch over the element's properties: a null value DELETES
    #: the key, anything else replaces it; absent keys are untouched
    properties_patch: dict[str, Any]


class DeleteElementOp(BaseModel):
    kind: Literal["delete_element"]
    id: str


class CreateRelationshipOp(BaseModel):
    kind: Literal["create_relationship"]
    temp_id: str
    type_name: str
    source_id: str
    target_id: str
    properties: dict[str, Any] = Field(default_factory=dict)


class UpdateRelationshipOp(BaseModel):
    kind: Literal["update_relationship"]
    id: str
    properties_patch: dict[str, Any]


class DeleteRelationshipOp(BaseModel):
    kind: Literal["delete_relationship"]
    id: str


class CreateArtifactOp(BaseModel):
    kind: Literal["create_artifact"]
    temp_id: str
    artifact_kind: Literal[
        "navigation",
        "table",
        "diagram",
        "diagram_kind",
        "code_snippet",
        "exporter",
    ]
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


class CreateFolderOp(BaseModel):
    kind: Literal["create_folder"]
    temp_id: str
    parent_id: str
    name: str
    #: position among siblings, None = append; canonical stored ops always
    #: carry the concrete index (referenced by the sibling view ops below).
    index: int | None = None


class RenameFolderOp(BaseModel):
    kind: Literal["rename_folder"]
    id: str
    name: str


class MoveFolderOp(BaseModel):
    kind: Literal["move_folder"]
    id: str
    to_parent_id: str
    index: int | None = None


class DeleteFolderOp(BaseModel):
    kind: Literal["delete_folder"]
    id: str


class PlaceElementOp(BaseModel):
    kind: Literal["place_element"]
    element_id: str
    #: must be a real folder id, never VIEW_ROOT_ID — an unplaced element
    #: already renders at the root (enforced by the applier, Task 5).
    folder_id: str
    index: int | None = None


class RemoveElementOp(BaseModel):
    kind: Literal["remove_element"]
    element_id: str
    folder_id: str


class MoveElementOp(BaseModel):
    kind: Literal["move_element"]
    element_id: str
    from_folder_id: str
    to_folder_id: str
    index: int | None = None


class PlaceArtifactOp(BaseModel):
    kind: Literal["place_artifact"]
    artifact_id: str
    #: plain str, NOT the artifact Literal — view refs are tolerant danglers;
    #: a ref must outlive kind-registry evolution.
    artifact_kind: str
    folder_id: str
    index: int | None = None


class RemoveArtifactOp(BaseModel):
    kind: Literal["remove_artifact"]
    artifact_id: str
    folder_id: str


class MoveArtifactOp(BaseModel):
    kind: Literal["move_artifact"]
    artifact_id: str
    from_folder_id: str
    to_folder_id: str
    index: int | None = None


#: View-content ops (Phase 2 artefacts revamp) — applied by api/view_ops.py to
#: the in-memory session.view, then the blob is persisted; never to the model.
ViewOpIn = (
    CreateFolderOp
    | RenameFolderOp
    | MoveFolderOp
    | DeleteFolderOp
    | PlaceElementOp
    | RemoveElementOp
    | MoveElementOp
    | PlaceArtifactOp
    | RemoveArtifactOp
    | MoveArtifactOp
)


class MetamodelNodePos(BaseModel):
    """Diagram node's canvas position in client-defined units, opaque to the
    backend (never interpreted server-side — only stored and echoed)."""

    x: float
    y: float


class RebindMetamodelOp(BaseModel):
    """Whole-metamodel swap as a batch member (spec 2026-08-16). ``blob`` is
    the author's YAML SOURCE, persisted verbatim as a new immutable
    ``MetamodelRow`` (Correction A: never a pydantic round-trip). At most one
    per batch; the commit applier hoists it FIRST so every other op in the
    batch validates against the candidate schema. The inverse op carries the
    PRIOR blob — full-state, so the journal alone answers undo/diff."""

    kind: Literal["metamodel.rebind"]
    blob: str = Field(min_length=1)


class MoveMetamodelNodeOp(BaseModel):
    """One diagram-layout key write against ``metamodel_layouts``. ``node``
    is a layout key (``el:<Name>`` / ``rel:<Name>`` / ``enum:<Name>``);
    ``pos: None`` REMOVES the key (a rename migrates a position as two ops:
    old key -> None, new key -> pos). The inverse carries the prior position
    (or None). Presentation data: no validation beyond this schema."""

    kind: Literal["metamodel.move_node"]
    node: str = Field(min_length=1)
    pos: MetamodelNodePos | None = None


#: Metamodel-family ops (spec 2026-08-16) — applied by api/metamodel_ops.py
#: to the in-memory metamodel + content tables, never to the model.
MetamodelOpIn = RebindMetamodelOp | MoveMetamodelNodeOp

OpIn = Annotated[
    ModelOpIn | ArtifactOpIn | ViewOpIn | MetamodelOpIn, Field(discriminator="kind")
]

#: kind-tags of view ops, for raw journal dicts (mirrors ARTIFACT_OP_KINDS,
#: which lives with ITS applier; this one lives here because schemas is the
#: only module every consumer can import without cycles).
VIEW_OP_KINDS = frozenset(
    {
        "create_folder",
        "rename_folder",
        "move_folder",
        "delete_folder",
        "place_element",
        "remove_element",
        "move_element",
        "place_artifact",
        "remove_artifact",
        "move_artifact",
    }
)

#: kind-tags of metamodel ops, for raw journal dicts (lives here for the same
#: no-cycle reason VIEW_OP_KINDS does).
METAMODEL_OP_KINDS = frozenset({"metamodel.rebind", "metamodel.move_node"})

#: (de)serializes a list of ops to/from plain JSON for the durable commit
#: journal (Commit.ops / inverse_ops). Mode "json" keeps Literal "kind" tags
#: so the discriminated union round-trips.
OPS_ADAPTER: TypeAdapter[list[OpIn]] = TypeAdapter(list[OpIn])

#: validates ONE raw journal op dict into a typed view op (the conflict
#: backstop deserializes only the view ops of tail commits; model/artifact
#: ops are cheaper to scan as raw dicts, see routes/commits._affected_ids).
VIEW_OP_ADAPTER: TypeAdapter[ViewOpIn] = TypeAdapter(ViewOpIn)


class OpsRequest(BaseModel):
    #: the model revision the ops were computed against; mismatch -> 409
    base_rev: int
    ops: list[OpIn] = Field(default_factory=list)


class OpsResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    model_rev: int
    #: temp id -> generated canonical id, for every create op in the batch
    id_map: dict[str, str] = Field(default_factory=dict)
    #: created + updated entities surviving the batch, in first-touch op
    #: application order, serialized in their final (post-batch) state
    changed_elements: list[ElementOut] = Field(default_factory=list)
    changed_relationships: list[RelationshipOut] = Field(default_factory=list)
    #: deleted ids in op application order, including containment-cascade
    #: deletions (cascade order: containment closure walk / sorted rel ids)
    deleted_element_ids: list[str] = Field(default_factory=list)
    deleted_relationship_ids: list[str] = Field(default_factory=list)
    #: issue-store delta of the scoped re-validation (see ValidationState)
    issues_removed_owner_ids: list[str] = Field(default_factory=list)
    issues_added: list[IssueOut] = Field(default_factory=list)
    #: post-batch issue count per severity, over the WHOLE issue store
    issue_counts: dict[str, int] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Change-request schemas
# ---------------------------------------------------------------------------


class ModifiedElementOut(BaseModel):
    id: str
    before: ElementOut
    after: ElementOut


class ModifiedRelationshipOut(BaseModel):
    id: str
    before: RelationshipOut
    after: RelationshipOut


class CrElementOps(BaseModel):
    added: list[ElementOut] = Field(default_factory=list)
    modified: list[ModifiedElementOut] = Field(default_factory=list)
    deleted: list[ElementOut] = Field(default_factory=list)


class CrRelationshipOps(BaseModel):
    added: list[RelationshipOut] = Field(default_factory=list)
    modified: list[ModifiedRelationshipOut] = Field(default_factory=list)
    deleted: list[RelationshipOut] = Field(default_factory=list)


class CrOps(BaseModel):
    elements: CrElementOps = Field(default_factory=CrElementOps)
    relationships: CrRelationshipOps = Field(default_factory=CrRelationshipOps)


class CrBaseline(BaseModel):
    filename: str | None = None
    elementCount: int = 0
    relationshipCount: int = 0


def _el(e: ElementOut) -> Element:
    return Element(
        id=e.id,
        type_name=e.type_name,
        properties=dict(e.properties),
        rev=e.rev,
    )


def _rel(r: RelationshipOut) -> Relationship:
    return Relationship(
        id=r.id,
        type_name=r.type_name,
        source_id=r.source_id,
        target_id=r.target_id,
        properties=dict(r.properties),
        rev=r.rev,
    )


class ChangeRequestIn(BaseModel):
    format: Literal["datarover.cr/v1"]
    createdAt: str
    baseline: CrBaseline = Field(default_factory=CrBaseline)
    ops: CrOps = Field(default_factory=CrOps)

    def to_core(self) -> CoreChangeRequest:
        return CoreChangeRequest(
            elements_added=[_el(e) for e in self.ops.elements.added],
            elements_modified=[
                CoreModifiedElement(
                    id=m.id,
                    before=_el(m.before),
                    after=_el(m.after),
                )
                for m in self.ops.elements.modified
            ],
            elements_deleted=[_el(e) for e in self.ops.elements.deleted],
            relationships_added=[_rel(r) for r in self.ops.relationships.added],
            relationships_modified=[
                CoreModifiedRelationship(
                    id=m.id,
                    before=_rel(m.before),
                    after=_rel(m.after),
                )
                for m in self.ops.relationships.modified
            ],
            relationships_deleted=[_rel(r) for r in self.ops.relationships.deleted],
        )


# ---------------------------------------------------------------------------
# Paged/on-demand read schemas (Phase C2-read; see routes/read.py)
# ---------------------------------------------------------------------------


class ModelSummary(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    model_rev: int
    element_count: int
    relationship_count: int
    #: exact-type element counts (no inheritance roll-up), sorted by type name
    elements_by_type: dict[str, int] = Field(default_factory=dict)
    #: issue count per severity from the session issue store; ``None`` means
    #: the model has not been validated yet (no full run seeded the store) —
    #: clients should render "not validated" rather than zero issues
    issue_counts: dict[str, int] | None = None
    #: number of op batches available to POST /model/undo
    undo_depth: int = 0


class ElementPage(BaseModel):
    items: list[ElementOut] = Field(default_factory=list)
    #: number of matches BEFORE limit/offset paging
    total: int = 0


class NeighborhoodOut(BaseModel):
    nodes: list[ElementOut] = Field(default_factory=list)
    #: relationships whose BOTH endpoints are in ``nodes``, sorted by id
    edges: list[RelationshipOut] = Field(default_factory=list)
    #: BFS distance from the center element (0) for every node
    hops_by_id: dict[str, int] = Field(default_factory=dict)
    #: True if some neighbors were dropped because ``cap`` was reached
    truncated: bool = False


class RelationshipPage(BaseModel):
    items: list[RelationshipOut] = Field(default_factory=list)
    #: number of incident relationships BEFORE limit/offset paging
    total: int = 0


class ChangesOut(BaseModel):
    """``datarover.cr/v1`` change request derived from the session op log.

    Shape-compatible with the frontend's ``buildChangeRequest`` export
    (``frontend/src/lib/state/cr.ts``) plus one extra field, ``complete``,
    which :class:`ChangeRequestIn` ignores on the apply path — so the
    document round-trips through POST /model/apply-cr unchanged.
    """

    format: Literal["datarover.cr/v1"] = "datarover.cr/v1"
    createdAt: str
    baseline: CrBaseline = Field(default_factory=CrBaseline)
    ops: CrOps = Field(default_factory=CrOps)
    #: False when the op log was truncated (OP_LOG_MAX exceeded) since the
    #: model was loaded: the CR then describes only the RETAINED history and
    #: its baseline is the post-truncation state, not the loaded base model
    complete: bool = True


class ChangesSummaryOut(BaseModel):
    #: batches currently retained in the op log
    batches: int = 0
    #: compacted CR op count (= adds + modifies + deletes)
    ops: int = 0
    adds: int = 0
    modifies: int = 0
    deletes: int = 0
    #: see ChangesOut.complete
    complete: bool = True


class ApplyCrRequest(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    #: legacy inline mode when present; ``None`` selects session mode (the CR
    #: is applied to the session model and an OpsResponse delta is returned)
    model: InlineModel | None = None
    cr: ChangeRequestIn


class ApplyCrResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    model: ModelOut
    issues: list[IssueOut] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Streaming load/save schemas (Phase C3; see routes/model.py)
# ---------------------------------------------------------------------------


class LoadModelRequest(BaseModel):
    #: local filesystem path of the model JSON file, resolved server-side
    path: str


class SaveModelRequest(BaseModel):
    #: local filesystem path to write to, resolved server-side
    path: str


class SaveModelResponse(BaseModel):
    path: str
    element_count: int
    relationship_count: int
    bytes_written: int


# --- Phase 4: check-out / commit + locking --------------------------------


class LockTargetIn(BaseModel):
    resource_id: str
    mode: Literal["exclusive", "shared"]
    #: what the id names; the route canonicalizes to the internal namespace
    #: ("element" -> bare id, "artifact" -> "art:<id>", "metamodel" -> "mm",
    #: "folder" -> "folder:<id>"). Defaults to "element" so pre-existing
    #: clients are untouched.
    type: Literal["element", "artifact", "metamodel", "folder"] = "element"


class LockRequest(BaseModel):
    targets: list[LockTargetIn]
    intent: Literal["edit", "create_child", "connect", "delete"]
    #: peer/admin override — evict a conflicting holder's leases (spec §8).
    steal: bool = False


class LeaseOut(BaseModel):
    resource_id: str
    mode: str
    holder: str
    holder_email: str = ""
    token: str
    intent: str
    expires_at: float


class LockConflictOut(BaseModel):
    resource_id: str
    held_by: str
    held_by_email: str = ""
    held_mode: str


class LockResponse(BaseModel):
    token: str
    leases: list[LeaseOut] = Field(default_factory=list)


class ReleaseRequest(BaseModel):
    token: str


class RenewRequest(BaseModel):
    token: str


class RenewResponse(BaseModel):
    ok: bool


class OpenResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    model_rev: int
    role: str
    element_count: int
    relationship_count: int
    issue_counts: dict[str, int] = Field(default_factory=dict)
    #: per-lease TTL (seconds). The client heartbeat renews at ttl/2. Sourced
    #: from settings.lock_ttl_seconds; lease expires_at is a server monotonic
    #: value, meaningless to the client clock, so the client needs the TTL.
    lock_ttl_seconds: int = 0
    #: project strict-mode policy; clients disable "commit anyway" when on.
    strict_mode: bool = False


class PreviewRequest(BaseModel):
    base_rev: int
    ops: list[OpIn] = Field(default_factory=list)


class PreviewResponse(BaseModel):
    conformance_error_count: int
    structural_blockers: list[IssueOut] = Field(default_factory=list)
    issues: list[IssueOut] = Field(default_factory=list)
    #: true when strict mode is on AND there are conformance errors — i.e. this
    #: batch would be hard-rejected by the commit strict gate. Lets the client
    #: gate the commit button without re-deriving policy.
    would_block: bool = False


class CommitRequest(BaseModel):
    base_rev: int
    ops: list[OpIn] = Field(default_factory=list)
    message: str = ""
    lock_tokens: list[str] = Field(default_factory=list)
    #: client acknowledges the surfaced conformance-error count (UI gate).
    ack_errors: bool = False


class CommitResponse(OpsResponse):
    commit_id: str
    message: str = ""
    validation_error_count: int = 0
    #: artifact half of the commit delta (created + updated rows, headers
    #: only — the client refetches a payload it actually has open). Empty on
    #: a model-only commit, which is why both fields default rather than
    #: being required: every pre-artifact client keeps parsing the response.
    changed_artifacts: list[ArtifactHeaderOut] = Field(default_factory=list)
    deleted_artifact_ids: list[str] = Field(default_factory=list)
    #: post-commit ViewRow.view_rev; None when the batch touched no view
    #: content (Phase 2). Secondary/informational — see ViewRow.view_rev.
    view_rev: int | None = None
    #: True when this commit carried a metamodel.rebind: the client must
    #: refetch the metamodel + issues (there is no applyable schema delta).
    rebound: bool = False
    #: the new MetamodelRow id when ``rebound``, else None.
    to_metamodel_id: str | None = None


# ---------------------------------------------------------------------------
# Durable commit-history schemas (Phase 8: GET /commits)
# ---------------------------------------------------------------------------


class CommitSummaryOut(BaseModel):
    """One row in the durable commit-history list (GET /commits).

    ``op_count`` is derived from the stored ops list length rather than being
    stored separately — it avoids a denormalisation bug where the count and list
    could diverge. ``is_rebind`` is true when either metamodel FK is set,
    covering both the from-old and to-new sides of a rebind commit.
    """

    rev: int
    commit_id: str
    author_id: str | None = None
    ts: datetime
    message: str
    validation_error_count: int
    op_count: int
    is_rebind: bool


class CommitHistoryResponse(BaseModel):
    """Paginated durable commit history (GET /commits).

    ``has_more`` is true when there are older commits beyond the current page
    (determined by fetching limit+1 rows and trimming the last). Clients page
    forward by passing ``before_rev=commits[-1].rev`` to the next request.
    """

    commits: list[CommitSummaryOut]
    has_more: bool


# ---------------------------------------------------------------------------
# Per-commit diff schemas (Phase 1 artefacts revamp: GET /commits/{rev}/diff)
# ---------------------------------------------------------------------------


class JsonChangeOut(BaseModel):
    """One leaf-level difference between two JSON documents.

    ``path`` is a dotted key path into the document ("$" for the document root,
    i.e. the two values are not both objects). Lists and scalars are reported
    wholesale at their own path — see ``commit_diff.json_structural_diff`` for
    why a reordered list is one reviewable change rather than N index deltas.
    """

    path: str
    before: Any = None
    after: Any = None


class ArtifactDiffAddedOut(BaseModel):
    """An artifact this commit created, in its post-commit state."""

    id: str
    kind: str
    name: str
    payload: dict[str, Any] = Field(default_factory=dict)


class ArtifactDiffModifiedOut(BaseModel):
    """An artifact this commit changed. ``kind`` may be ``"unknown"``: an
    update op carries no kind on either side, so it is resolved from the row,
    which a LATER commit may have deleted."""

    id: str
    kind: str
    name_before: str
    name_after: str
    changes: list[JsonChangeOut] = Field(default_factory=list)


class ArtifactDiffDeletedOut(BaseModel):
    """An artifact this commit deleted, in its pre-commit state. Reconstructed
    from the delete's inverse op (a create carrying kind + name + full
    payload), so it stays renderable long after the row is gone."""

    id: str
    kind: str
    name: str
    payload: dict[str, Any] = Field(default_factory=dict)


class CommitArtifactDiffs(BaseModel):
    added: list[ArtifactDiffAddedOut] = Field(default_factory=list)
    modified: list[ArtifactDiffModifiedOut] = Field(default_factory=list)
    deleted: list[ArtifactDiffDeletedOut] = Field(default_factory=list)


class ViewDiffEntryOut(BaseModel):
    """One canonical view op, rendered for history. The view family is
    fine-grained on the wire, so the ops ARE the diff — no before/after
    reconstruction. ``name_before`` (rename/delete) comes from the commit's
    inverse half. Folder ids referenced by other entries are NOT resolved to
    names here (journal-only stance): the client resolves against its live
    view and degrades to the bare id for folders deleted since."""

    kind: str
    folder_id: str | None = None
    name: str | None = None
    name_before: str | None = None
    parent_id: str | None = None
    index: int | None = None
    from_folder_id: str | None = None
    to_folder_id: str | None = None
    element_id: str | None = None
    artifact_id: str | None = None
    artifact_kind: str | None = None


class LayoutMoveOut(BaseModel):
    """One diagram-layout key write, journal-only SUMMARY form (spec
    2026-08-16): a moved node's destination, not its pixel history.
    ``x``/``y`` both ``None`` means the key was REMOVED (``pos: None`` on the
    forward ``metamodel.move_node`` op) — deliberately no before/after per
    coordinate, since the diff surface promises "N nodes moved", not a replay
    of every intermediate drag."""

    node: str
    x: float | None = None
    y: float | None = None


class CommitDiffOut(BaseModel):
    """Everything one commit changed, across content families.

    Model entities reuse the change-request shapes (``CrElementOps`` /
    ``CrRelationshipOps``) rather than parallel ones, so a client renders a
    commit diff and a CR diff with the same component. ``scope`` mirrors the
    commit feed event's field ("model" / "artifact" / "view" /
    "metamodel-layout"); ``is_rebind`` is true when either metamodel FK is
    set, matching ``CommitSummaryOut``. ``metamodel`` is the structural
    document diff, recomputed from the two immutable MetamodelRow blobs —
    only for rebind commits, and None when either blob is missing/unparseable
    (degraded, never failed). ``layout_moves`` is the journal-only summary of
    the layout half (see ``LayoutMoveOut``) and is independent of
    ``metamodel``/``is_rebind`` — a single commit can carry a rebind AND a
    handful of node moves, in which case both render on this one page.
    """

    rev: int
    commit_id: str
    author_id: str | None = None
    ts: datetime
    message: str = ""
    scope: list[str] = Field(default_factory=list)
    is_rebind: bool = False
    elements: CrElementOps = Field(default_factory=CrElementOps)
    relationships: CrRelationshipOps = Field(default_factory=CrRelationshipOps)
    artifacts: CommitArtifactDiffs = Field(default_factory=CommitArtifactDiffs)
    view: list[ViewDiffEntryOut] = Field(default_factory=list)
    metamodel: MetamodelStructuralDiff | None = None
    layout_moves: list[LayoutMoveOut] = Field(default_factory=list)


class RevertRequest(BaseModel):
    """Revert the model to the state at ``target_rev`` (Phase 8).

    ``base_rev`` is the client's last-seen ``model_rev`` for optimistic-
    concurrency (409 on mismatch). ``target_rev`` must be in ``[0, model_rev]``.
    """

    target_rev: int
    base_rev: int
    message: str | None = None


class ArtifactHeaderOut(BaseModel):
    """Artifact list row: everything the sidebar renders, payload omitted.

    `entry_points` is the ONE payload-derived field surfaced on headers: the
    sidebar's entry-point badges (and the M2/M3 embedding pickers) filter on
    it, and it is server-owned anyway (`_apply_derived_metadata` recomputes it
    on every write). None for non-snippet kinds; a (possibly empty) list for
    `code_snippet` rows."""

    id: str
    kind: str
    name: str
    artifact_rev: int
    updated_at: datetime
    updated_by: str | None = None
    entry_points: list[str] | None = None


class ArtifactOut(ArtifactHeaderOut):
    payload: dict[str, Any] = Field(default_factory=dict)


class ArtifactListOut(BaseModel):
    items: list[ArtifactHeaderOut] = Field(default_factory=list)


class ArtifactCreateIn(BaseModel):
    kind: Literal[
        "navigation",
        "table",
        "diagram",
        "diagram_kind",
        "code_snippet",
        "exporter",
    ]
    name: str = Field(min_length=1)
    payload: dict[str, Any] = Field(default_factory=dict)


class ArtifactUpdateIn(BaseModel):
    artifact_rev: int
    name: str | None = Field(default=None, min_length=1)
    payload: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# Snippet execution (Task 11: POST /snippets/run|lint|cancel)
# ---------------------------------------------------------------------------


class SnippetRunIn(BaseModel):
    """Body for POST /snippets/run. Exactly one of `code` (inline) /
    `artifact_id` (a saved `code_snippet` artifact) must be supplied — mirrors
    `EvaluateNavigationIn`'s exactly-one pattern above."""

    run_id: str
    code: str | None = None
    artifact_id: str | None = None
    entry: Literal["script", "value", "step"] = "script"
    element_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _exactly_one(self) -> SnippetRunIn:
        if (self.code is None) == (self.artifact_id is None):
            raise ValueError("provide exactly one of `code` / `artifact_id`")
        return self

    @model_validator(mode="after")
    def _entry_context(self) -> SnippetRunIn:
        """`value` runs against 1+ bound elements, `step` against exactly one;
        `script` ignores the field. Enforced here (not in the runner) so a bad
        request 422s before a sandbox instance is consumed."""
        if self.entry == "value" and len(self.element_ids) < 1:
            raise ValueError("entry 'value' requires at least one element id")
        if self.entry == "step" and len(self.element_ids) != 1:
            raise ValueError("entry 'step' requires exactly one element id")
        return self


class SnippetErrorOut(BaseModel):
    """Mirrors `core.script.runner.ScriptError` field-for-field."""

    kind: Literal[
        "syntax",
        "runtime",
        "timeout",
        "cancelled",
        "memory",
        "limit",
        "unavailable",
        "pending",
    ]
    message: str
    traceback: str | None = None


class SnippetRunOut(BaseModel):
    run_id: str
    stdout: str
    result_repr: str | None
    #: recorded op batch, validated through `OPS_ADAPTER` by the route before
    #: this response is built (a runner emitting an invalid op dict is a
    #: server bug, surfaced as a 500 instead of reaching this model).
    ops: list[OpIn]
    error: SnippetErrorOut | None
    duration_ms: int
    #: `session.model_rev` as observed AFTER the run completed.
    model_rev: int
    #: True when `model_rev` moved between the run's start and end — the run
    #: executed without holding `write_mutex` (see routes/snippets.py's
    #: module docstring), so a concurrent commit could land mid-run. The
    #: run's own read was still a consistent point-in-time snapshot; `stale`
    #: only tells the caller that snapshot may now be behind HEAD.
    stale: bool
    truncated: bool


class SnippetLintIn(BaseModel):
    code: str


class DiagnosticOut(BaseModel):
    """Mirrors `core.script.lint.Diagnostic` field-for-field."""

    line: int
    col: int
    severity: Literal["error", "warning"]
    message: str


class SnippetLintOut(BaseModel):
    diagnostics: list[DiagnosticOut]
    entry_points: list[str]


class SnippetCancelIn(BaseModel):
    run_id: str


class SnippetFormatIn(BaseModel):
    """Body for POST /snippets/format. The cap is enforced here so oversized
    input 422s in validation, before a subprocess is spawned. ``max_length``
    counts characters, not bytes — a tighter-or-equal bound, and the same
    spelling ``SnippetDefinition.code`` already uses."""

    code: str = Field(max_length=SNIPPET_MAX_CODE_BYTES)


class SnippetFormatOut(BaseModel):
    code: str
    #: False when the snippet was already formatted — the client skips the
    #: editor transaction (and its undo entry) in that case.
    changed: bool


class FacadeDocEntryOut(BaseModel):
    """Mirrors `core.script.docs.FacadeDocEntry` field-for-field."""

    name: str
    kind: Literal["function", "method", "property", "exception"]
    signature: str
    doc: str
    example: str | None


class SnippetLimitsOut(BaseModel):
    """The actual configured `RunLimits` values the runner enforces."""

    wall_timeout_s: float
    memory_bytes: int
    stdout_bytes: int
    result_repr_bytes: int
    max_ops: int
    max_op_bytes: int
    page_limit: int


class SnippetDocsOut(BaseModel):
    facade: list[FacadeDocEntryOut]
    limits: SnippetLimitsOut
    notes: list[str]


# ---------------------------------------------------------------------------
# Navigation evaluation (Stage 1: POST /navigations/evaluate)
# ---------------------------------------------------------------------------


class EvaluateNavigationIn(BaseModel):
    """Exactly one of `definition` (inline) / `artifact_id` (saved)."""

    definition: NavigationDefinition | None = None
    artifact_id: str | None = None
    row_element_id: str | None = None
    limit: int = Field(100, ge=1, le=500)
    offset: int = Field(0, ge=0)

    @model_validator(mode="after")
    def _exactly_one(self) -> EvaluateNavigationIn:
        if (self.definition is None) == (self.artifact_id is None):
            raise ValueError("provide exactly one of `definition` / `artifact_id`")
        return self


class ScriptWarningOut(BaseModel):
    """A structured embedded-evaluation degradation.

    `code` is typed `str`, NOT the enum, so a client that does not know a
    newly added code still parses the payload — the frontend formatter falls
    back to `detail` for an unrecognized code. Copy lives client-side, which
    is why nothing here is a sentence.
    """

    code: str
    #: How many times this kind fired.
    occurrences: int
    #: Summed subject quantity (unknown ids, dropped elements); 0 when the
    #: kind carries no such number.
    total: int = 0
    #: The variable part — an artifact ref, an exception message.
    detail: str | None = None

    @classmethod
    def from_core(cls, w: ScriptWarning) -> ScriptWarningOut:
        return cls(
            code=str(w.code), occurrences=w.occurrences, total=w.total, detail=w.detail
        )


class ChainValueOut(BaseModel):
    """Terminal VALUE node in a chain: a scalar property step ends its chain at
    the property's value instead of an element. Discriminated from `TreeItem`
    by the `kind` tag (TreeItem has no `kind` field)."""

    kind: Literal["value"] = "value"
    value: str | int | float | bool


class ChainPageOut(BaseModel):
    """One page of navigation chains, each node a TreeItem projection — except
    a possible trailing `ChainValueOut` when the path ends in a scalar property
    step or in a script step that returned a non-element. `total` counts
    chains found WITHIN the evaluation caps; `truncated` means the caps
    stopped enumeration (there may be more matches than `total`)."""

    step_types: list[str] = Field(default_factory=list)
    chains: list[list[TreeItem | ChainValueOut]] = Field(default_factory=list)
    total: int = 0
    truncated: bool = False
    warnings: list[ScriptWarningOut] = Field(
        default_factory=list,
        description="Script-step degradations produced by this evaluation.",
    )


# ---------------------------------------------------------------------------
# Table evaluation (Stage 2: POST /tables/evaluate)
# ---------------------------------------------------------------------------


class TableSortIn(BaseModel):
    column: int = Field(ge=0)
    direction: Literal["asc", "desc"] = "asc"


class EvaluateTableIn(BaseModel):
    """Exactly one of `definition` (inline) / `artifact_id` (saved)."""

    definition: TableDefinition | None = None
    artifact_id: str | None = None
    offset: int = Field(0, ge=0)
    limit: int = Field(100, ge=1, le=500)
    sort: TableSortIn | None = None

    @model_validator(mode="after")
    def _exactly_one(self) -> EvaluateTableIn:
        if (self.definition is None) == (self.artifact_id is None):
            raise ValueError("provide exactly one of `definition` / `artifact_id`")
        return self


class ExportTableIn(EvaluateTableIn):
    """`/tables/export`'s payload: `EvaluateTableIn` plus the output format.

    A SUBCLASS rather than a new field on `EvaluateTableIn` so `/tables/evaluate`
    and `/tables/script-errors` — which have no notion of a format — keep their
    exact wire contract. `offset`/`limit` are inherited and ignored here: an
    export is always whole-table.
    """

    format: Literal["xlsx", "json"] = "xlsx"


class RunExportIn(BaseModel):
    """`POST /exports/run` body. The id travels in the BODY, not the path:
    `authz._READ_ONLY_POST_SUFFIXES` matches fixed path suffixes, and this
    route must be viewer-callable like `/tables/export`."""

    artifact_id: str


class JsonPreviewOut(BaseModel):
    """A bounded, already-rendered JSON sample for the export settings UI.

    `sample` is the rendered TEXT rather than parsed objects: the pane displays
    it verbatim, and re-serializing it client-side would let key order and
    formatting drift from what the real export produces.
    """

    sample: str
    truncated: bool


class TableColumnOut(BaseModel):
    kind: str
    header: str
    width_px: int | None = None


class TableCellOut(BaseModel):
    kind: Literal["element", "value", "values", "elements", "error", "pending"]
    # element
    item: TreeItem | None = None
    # value
    present: bool | None = None
    value: object | None = None
    element_id: str | None = None
    editable: bool | None = None
    # values / elements
    items: list[TreeItem] | None = None
    values: list[object] | None = None
    total: int | None = None
    truncated: bool | None = None
    # error
    message: str | None = None
    traceback: str | None = None


class TableRowOut(BaseModel):
    key: list[object]
    cells: list[TableCellOut]


class ScriptStatusOut(BaseModel):
    """Progress of script-column computation for this table (spec §4.2).

    `ready`: NOTHING IS PENDING COMPUTATION — the rows in this response are
    final for this model rev and polling again would not change them. It does
    NOT promise every cell holds a value: the degraded-not-failed stance means
    a cell whose call was never attempted (no runner, no free concurrency slot)
    or whose snippet raised renders as an `unavailable`/error cell under a
    `ready` status, because retrying is the client's decision, not a matter of
    waiting for a background sweep.
    `computing`: a background sweep is filling the cell cache; the rows in this
    response are DEGRADED (build order, possibly `pending` cells) — poll again.
    `failed`: the work is dead and will not finish on its own; `message` says
    why. Cleared by the next commit, which re-keys the sweep registry.

    Only ever populated for tables that actually carry a script column: a table
    with no script work reports `script_status: null`.

    The field names below are part of the frontend contract — the client reads
    `state`/`done`/`total`/`message` verbatim (see
    `frontend/src/lib/state/table-editor.svelte.ts`), so they must not be
    renamed without changing the client in the same commit.
    """

    state: Literal["ready", "computing", "failed"]
    done: int = 0
    total: int | None = None
    message: str | None = None


class ScriptErrorItemOut(BaseModel):
    """One failed script cell, addressable by grid position.

    `row_index` is an index into the row order the CLIENT DISPLAYS for the same
    `(definition, sort, model_rev)` — the recap route derives it exactly the way
    `/tables/evaluate` derives its page, degrade rules included — so the panel
    can scroll straight to the offending cell. `column_index` indexes
    `defn.columns`, i.e. the same positions as `TablePageOut.columns` and each
    `TableRowOut.cells` (hidden columns are NOT filtered out, so the two stay
    aligned).

    `row_element_id`/`row_label` describe the row's first key slot when it holds
    an element id (`display_name` of it), purely so the panel can name the row
    without a second round trip; both are None for a row keyed by a scalar.
    """

    row_index: int
    row_element_id: str | None = None
    row_label: str | None = None
    column_index: int
    column_label: str
    message: str


class ScriptErrorsOut(BaseModel):
    """Whole-table script-error recap (cache-only; never drives the guest).

    `state` is a one-valued literal on purpose: the recap route answers either
    this shape with 200, or a `ScriptStatusOut` (`computing`/`failed`) with 202,
    so a client can discriminate the two bodies on `state` alone even though the
    STATUS CODE is the actual retry signal (same contract as `/tables/export`).

    `errors` is capped at `routes.tables.SCRIPT_ERRORS_CAP`; `total_errors` is
    always the full count, and `truncated` says the list is short of it.
    """

    state: Literal["ready"] = "ready"
    errors: list[ScriptErrorItemOut]
    total_errors: int
    truncated: bool


class TablePageOut(BaseModel):
    columns: list[TableColumnOut]
    rows: list[TableRowOut]
    total: int
    #: Rows the row source produced BEFORE expand columns split them (for a
    #: scope source: the scope size) — see `evaluate.RowBuild.base_total`.
    base_total: int
    truncated: bool
    offset: int
    model_rev: int
    #: script-step degradations from navigations this evaluation triggered
    #: (pruned-frontier warnings etc.) + nothing else today. Structured, with
    #: aggregated counts; the client renders the copy.
    warnings: list[ScriptWarningOut] = Field(default_factory=list)
    #: None when the table has no script column at all; otherwise the
    #: poll-again contract for this page (see `ScriptStatusOut`).
    script_status: ScriptStatusOut | None = None
