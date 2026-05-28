from __future__ import annotations


def containment_parents(model) -> dict[str, list[str]]:
    """Map every contained element id to the list of its containment parent ids.

    Elements without a containment parent are omitted from the result. Multiple
    parents are preserved in iteration order so callers (e.g. ContainmentValidator)
    can still detect single-parent violations.
    """
    mm = model.metamodel
    parents: dict[str, list[str]] = {}
    for r in model.relationships.values():
        if mm.is_containment(r.type_name):
            parents.setdefault(r.target_id, []).append(r.source_id)
    return parents
