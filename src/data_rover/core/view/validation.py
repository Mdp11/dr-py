from __future__ import annotations

from data_rover.core.model.model import Model
from data_rover.core.validation.issue import Issue, Severity

from .schema import Folder, View


def _folder_path(parents: list[str], name: str) -> str:
    return "/".join([*parents, name])


def validate_view(view: View, model: Model) -> list[Issue]:
    """Return warnings about a view in the context of a model.

    Warnings emitted (all `Severity.WARNING`, view is never rejected):

    - Element id placed in a folder that does not exist in the model.
    - Element placed in a folder while having a containment parent (ignored).
    - Element placed in more than one folder within the same view (later
      occurrences ignored).
    - Two sibling folders with the same name (later occurrences ignored).
    """

    issues: list[Issue] = []
    indexes = model.indexes
    placed: dict[str, str] = {}

    def visit(folder: Folder, ancestor_names: list[str]) -> None:
        path = _folder_path(ancestor_names, folder.name)

        # duplicate sibling folder names
        seen: set[str] = set()
        for child in folder.folders:
            if child.name in seen:
                where = repr(path) if path else "'/'"
                issues.append(
                    Issue(
                        Severity.WARNING,
                        (
                            f"view {view.name!r}: duplicate folder "
                            f"{child.name!r} under {where}; later "
                            "occurrence ignored"
                        ),
                    )
                )
                continue
            seen.add(child.name)
            visit(child, [*ancestor_names, folder.name])

        for element_id in folder.elements:
            if element_id not in model.elements:
                issues.append(
                    Issue(
                        Severity.WARNING,
                        (
                            f"view {view.name!r}: folder {path!r} references "
                            f"unknown element {element_id!r}"
                        ),
                        [element_id],
                    )
                )
                continue
            if indexes.parents_of(element_id):
                issues.append(
                    Issue(
                        Severity.WARNING,
                        (
                            f"view {view.name!r}: element {element_id!r} has a "
                            f"containment parent and cannot be placed in folder "
                            f"{path!r}; placement ignored"
                        ),
                        [element_id],
                    )
                )
                continue
            existing = placed.get(element_id)
            if existing is not None:
                issues.append(
                    Issue(
                        Severity.WARNING,
                        (
                            f"view {view.name!r}: element {element_id!r} is "
                            f"placed in multiple folders ({existing!r} and "
                            f"{path!r}); first placement wins"
                        ),
                        [element_id],
                    )
                )
                continue
            placed[element_id] = path

    # top-level duplicate folder names
    top_seen: set[str] = set()
    for folder in view.folders:
        if folder.name in top_seen:
            issues.append(
                Issue(
                    Severity.WARNING,
                    (
                        f"view {view.name!r}: duplicate top-level folder "
                        f"{folder.name!r}; later occurrence ignored"
                    ),
                )
            )
            continue
        top_seen.add(folder.name)
        visit(folder, [])

    return issues
