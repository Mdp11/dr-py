from __future__ import annotations

from dataclasses import asdict
from typing import Any

from pydantic import BaseModel, Field

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
