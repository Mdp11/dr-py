from __future__ import annotations

from pydantic import BaseModel, Field


class ArtifactRef(BaseModel):
    """A reference to a project artifact (saved navigation/table/diagram)
    placed in this folder. Like element refs, the view does not OWN the
    artifact: deleting the artifact leaves the ref dangling and renderers
    skip ids they cannot resolve (the same tolerate-don't-prune stance as
    element refs — see validate_view)."""

    id: str
    kind: str


class Folder(BaseModel):
    """A named container that lists child folders and element ids.

    Folder identity within a view is its name path. Sibling folders must have
    unique names; duplicates are reported as warnings by `validate_view` and the
    later occurrence is ignored at render time.
    """

    name: str
    folders: list["Folder"] = Field(default_factory=list)
    elements: list[str] = Field(default_factory=list)
    artifacts: list[ArtifactRef] = Field(default_factory=list)


class View(BaseModel):
    """A user-defined organisational overlay on top of a model.

    A view does not own elements; it only references them by id. Elements that
    are not referenced by any folder render at the root, alongside top-level
    folders. Only root-level elements (no containment parent) may be placed;
    placements of contained elements are reported as warnings and ignored.

    `artifacts` mirrors `Folder.artifacts` but at the root: an artifact placed
    here renders alongside top-level folders/elements instead of inside a
    folder. Additive field — old view documents without it parse unchanged
    with an empty list (see test_old_view_without_artifacts_still_valid).
    """

    name: str
    folders: list[Folder] = Field(default_factory=list)
    artifacts: list[ArtifactRef] = Field(default_factory=list)


Folder.model_rebuild()
