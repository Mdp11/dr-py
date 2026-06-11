from __future__ import annotations

from dataclasses import asdict
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from data_rover.core.model.change_request import (
    ChangeRequest as CoreChangeRequest,
    ModifiedElement as CoreModifiedElement,
    ModifiedRelationship as CoreModifiedRelationship,
)
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship
from data_rover.core.validation.issue import Issue
from data_rover.core.view.schema import Folder, View


class ElementOut(BaseModel):
    id: str
    type_name: str
    properties: dict[str, Any] = Field(default_factory=dict)
    rev: int = 0

    @classmethod
    def from_core(cls, element: Element) -> "ElementOut":
        return cls(**asdict(element))


class RelationshipOut(BaseModel):
    id: str
    type_name: str
    source_id: str
    target_id: str
    properties: dict[str, Any] = Field(default_factory=dict)
    rev: int = 0

    @classmethod
    def from_core(cls, rel: Relationship) -> "RelationshipOut":
        return cls(**asdict(rel))


class ModelOut(BaseModel):
    elements: list[ElementOut]
    relationships: list[RelationshipOut]

    @classmethod
    def from_core(cls, model: Model) -> "ModelOut":
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


class IssueOut(BaseModel):
    severity: str
    message: str
    target_ids: list[str] = Field(default_factory=list)

    @classmethod
    def from_core(cls, issue: Issue) -> "IssueOut":
        return cls(
            severity=issue.severity.value,
            message=issue.message,
            target_ids=list(issue.target_ids),
        )


class FolderOut(BaseModel):
    name: str
    folders: list["FolderOut"] = Field(default_factory=list)
    elements: list[str] = Field(default_factory=list)

    @classmethod
    def from_core(cls, folder: Folder) -> "FolderOut":
        return cls(
            name=folder.name,
            folders=[FolderOut.from_core(f) for f in folder.folders],
            elements=list(folder.elements),
        )


FolderOut.model_rebuild()


class ViewOut(BaseModel):
    name: str
    folders: list[FolderOut] = Field(default_factory=list)

    @classmethod
    def from_core(cls, view: View) -> "ViewOut":
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


class ApplyCrRequest(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    model: InlineModel
    cr: ChangeRequestIn


class ApplyCrResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    model: ModelOut
    issues: list[IssueOut] = Field(default_factory=list)
