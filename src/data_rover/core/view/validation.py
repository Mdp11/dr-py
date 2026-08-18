from __future__ import annotations

from collections.abc import Collection

from data_rover.core.model.model import Model
from data_rover.core.validation.issue import Issue, Severity

from .schema import ArtifactRef, Folder, View


def _folder_path(parents: list[str], name: str) -> str:
    return "/".join([*parents, name])


def validate_view(
    view: View,
    model: Model,
    *,
    known_artifact_ids: Collection[str] | None = None,
) -> list[Issue]:
    """Return warnings about a view in the context of a model.

    Warnings emitted (all `Severity.WARNING`, view is never rejected):

    - Element id placed in a folder that does not exist in the model.
    - Element placed in a folder while having a containment parent (ignored).
    - Element placed in more than one folder within the same view (later
      occurrences ignored).
    - Two sibling folders with the same name (later occurrences ignored).
    - Artifact ref (folder-level or root-level) whose id is not among
      `known_artifact_ids` — same tolerate-don't-prune stance as element
      refs: renderers skip ids they cannot resolve rather than the view
      being rejected. `known_artifact_ids=None` (the default) SKIPS this
      check entirely: core stays DB-free (there is no model-side notion of
      "known artifacts"), so only callers that can supply the live set
      (the API routes, backed by `content.list_artifacts`) opt in; the
      importer and other pure-core callers pass nothing.
    """

    issues: list[Issue] = []
    indexes = model.indexes
    placed: dict[str, str] = {}

    def check_artifacts(refs: list[ArtifactRef], where: str) -> None:
        if known_artifact_ids is None:
            return
        for ref in refs:
            if ref.id not in known_artifact_ids:
                issues.append(
                    Issue(
                        Severity.WARNING,
                        (
                            f"view {view.name!r}: {where} references "
                            f"unknown artifact {ref.id!r}; renderers skip it"
                        ),
                        check="view",
                    )
                )

    def visit(folder: Folder, ancestor_names: list[str]) -> None:
        path = _folder_path(ancestor_names, folder.name)

        check_artifacts(folder.artifacts, f"folder {path!r}")

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
                        check="view",
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
                        check="view",
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
                        check="view",
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
                        check="view",
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
                    check="view",
                )
            )
            continue
        top_seen.add(folder.name)
        visit(folder, [])

    check_artifacts(view.artifacts, "the view root")

    return issues
