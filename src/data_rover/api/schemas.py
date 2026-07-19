from __future__ import annotations

from dataclasses import asdict
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

from data_rover.core.model.change_request import (
    ChangeRequest as CoreChangeRequest,
    ModifiedElement as CoreModifiedElement,
    ModifiedRelationship as CoreModifiedRelationship,
)
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship
from data_rover.core.navigation.schema import NavigationDefinition
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
            origin=origin,
        )


class MetamodelDiffResponse(BaseModel):
    """Read-only sandbox conformance diff (Phase 6B). now_failing = issues the
    candidate metamodel introduces; now_passing = issues it resolves."""

    now_failing: list[IssueOut]
    now_passing: list[IssueOut]
    unchanged_count: int
    current_error_count: int
    candidate_error_count: int


class RebindResponse(BaseModel):
    """Result of a non-destructive metamodel rebind (Phase 6B)."""

    model_rev: int
    metamodel_id: str
    validation_error_count: int
    issue_counts: dict[str, int]
    issues: list[IssueOut]


class ArtifactRefOut(BaseModel):
    id: str
    kind: str


class FolderOut(BaseModel):
    name: str
    folders: list[FolderOut] = Field(default_factory=list)
    elements: list[str] = Field(default_factory=list)
    artifacts: list[ArtifactRefOut] = Field(default_factory=list)

    @classmethod
    def from_core(cls, folder: Folder) -> FolderOut:
        return cls(
            name=folder.name,
            folders=[FolderOut.from_core(f) for f in folder.folders],
            elements=list(folder.elements),
            artifacts=[ArtifactRefOut(id=a.id, kind=a.kind) for a in folder.artifacts],
        )


FolderOut.model_rebuild()


class ViewOut(BaseModel):
    name: str
    folders: list[FolderOut] = Field(default_factory=list)

    @classmethod
    def from_core(cls, view: View) -> ViewOut:
        return cls(
            name=view.name,
            folders=[FolderOut.from_core(f) for f in view.folders],
        )


class ViewIn(BaseModel):
    """Inbound view snapshot. Accepts the same shape as ViewOut."""

    name: str
    folders: list[FolderOut] = Field(default_factory=list)

    def to_core(self) -> View:
        return View.model_validate(self.model_dump())


class ViewSnapshotResponse(BaseModel):
    view: ViewOut
    warnings: list[IssueOut] = Field(default_factory=list)


class ViewStateResponse(BaseModel):
    view: ViewOut | None = None
    warnings: list[IssueOut] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Delta-protocol op schemas (POST /model/ops) — mirror frontend
# `frontend/src/lib/state/ops.ts` exactly (THE FILE IS THE CONTRACT)
# ---------------------------------------------------------------------------


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


OpIn = Annotated[
    CreateElementOp
    | UpdateElementOp
    | DeleteElementOp
    | CreateRelationshipOp
    | UpdateRelationshipOp
    | DeleteRelationshipOp,
    Field(discriminator="kind"),
]

#: (de)serializes a list of ops to/from plain JSON for the durable commit
#: journal (Commit.ops / inverse_ops). Mode "json" keeps Literal "kind" tags
#: so the discriminated union round-trips.
OPS_ADAPTER: TypeAdapter[list[OpIn]] = TypeAdapter(list[OpIn])


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
    kind: Literal["navigation", "table", "diagram", "diagram_kind", "code_snippet"]
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

    kind: Literal["syntax", "runtime", "timeout", "cancelled", "memory", "limit"]
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


class ChainValueOut(BaseModel):
    """Terminal VALUE node in a chain: a scalar property step ends its chain at
    the property's value instead of an element. Discriminated from `TreeItem`
    by the `kind` tag (TreeItem has no `kind` field)."""

    kind: Literal["value"] = "value"
    value: str | int | float | bool


class ChainPageOut(BaseModel):
    """One page of navigation chains, each node a TreeItem projection — except
    a possible trailing `ChainValueOut` when the path ends in a scalar property
    step. `total` counts chains found WITHIN the evaluation caps; `truncated`
    means the caps stopped enumeration (there may be more matches than
    `total`)."""

    step_types: list[str] = Field(default_factory=list)
    chains: list[list[TreeItem | ChainValueOut]] = Field(default_factory=list)
    total: int = 0
    truncated: bool = False


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


class TableColumnOut(BaseModel):
    kind: str
    header: str
    width_px: int | None = None


class TableCellOut(BaseModel):
    kind: Literal["element", "value", "values", "elements"]
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


class TableRowOut(BaseModel):
    key: list[object]
    cells: list[TableCellOut]


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
