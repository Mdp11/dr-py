from __future__ import annotations

from dataclasses import asdict
from typing import Any

from pydantic import BaseModel, Field

from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship
from data_rover.core.validation.issue import Issue


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
    name: str
    metamodel: str
    elements: list[ElementOut]
    relationships: list[RelationshipOut]

    @classmethod
    def from_core(cls, name: str, metamodel_name: str, model: Model) -> "ModelOut":
        return cls(
            name=name,
            metamodel=metamodel_name,
            elements=[ElementOut.from_core(e) for e in model.elements.values()],
            relationships=[
                RelationshipOut.from_core(r) for r in model.relationships.values()
            ],
        )


class ModelRef(BaseModel):
    name: str
    metamodel: str


class CreateModelRequest(BaseModel):
    name: str
    metamodel: str


class CreateElementRequest(BaseModel):
    type: str
    properties: dict[str, Any] = Field(default_factory=dict)


class UpdateElementRequest(BaseModel):
    properties: dict[str, Any]


class CreateRelationshipRequest(BaseModel):
    type: str
    source_id: str
    target_id: str


class ValidateRequest(BaseModel):
    scope: list[str] | None = None


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
