"""Folder identity helpers (artefacts revamp Phase 2).

Folder ids are assigned LAZILY: old blobs parse with ``Folder.id == ""`` and
are healed by ``ensure_folder_ids`` at hydration / import time — there is
deliberately no Alembic migration for blob content. This module is
the one place assignment and id-addressed traversal live so the API layer
(op applier, lock-scope expansion) cannot grow a second, subtly different
walk. All functions are pure over the core ``View``.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator

from .schema import VIEW_ROOT_ID, Folder, View


def iter_folders(view: View) -> Iterator[Folder]:
    """All folders, DFS pre-order (parents before children)."""
    stack: list[Folder] = list(reversed(view.folders))
    while stack:
        f = stack.pop()
        yield f
        stack.extend(reversed(f.folders))


def ensure_folder_ids(view: View) -> bool:
    """Assign a uuid4-hex id to every folder lacking a usable one.

    "Usable" excludes three shapes: empty (an un-migrated blob), a duplicate
    of an id already seen this walk (first occurrence wins — ops addressed at
    the survivor keep working), and the reserved ``VIEW_ROOT_ID`` (a folder
    claiming the root's address would shadow root placements). Returns True
    if anything was (re)assigned so callers know to persist the blob back.
    """
    changed = False
    seen: set[str] = set()
    for f in iter_folders(view):
        if not f.id or f.id == VIEW_ROOT_ID or f.id in seen:
            f.id = uuid.uuid4().hex
            changed = True
        seen.add(f.id)
    return changed


def find_folder(view: View, folder_id: str) -> Folder | None:
    """Find a folder by id, or None."""
    for f in iter_folders(view):
        if f.id == folder_id:
            return f
    return None


def locate_folder(view: View, folder_id: str) -> tuple[View | Folder, int] | None:
    """(parent node, index in ``parent.folders``) for *folder_id*, or None.

    The parent of a top-level folder is the ``View`` itself — callers translate
    that back to ``VIEW_ROOT_ID`` when they need a resource id.
    """

    def walk(parent: View | Folder) -> tuple[View | Folder, int] | None:
        for i, child in enumerate(parent.folders):
            if child.id == folder_id:
                return parent, i
            found = walk(child)
            if found is not None:
                return found
        return None

    return walk(view)


def folder_subtree(view: View | None, folder_id: str) -> list[str]:
    """*folder_id* + all transitive descendant folder ids (pre-order).

    Falls back to ``[folder_id]`` when the view is absent or the id unknown:
    lock-scope expansion must stay total (a lease request on a just-deleted
    folder degrades to a single-resource lock rather than raising).
    """
    if view is None:
        return [folder_id]
    root = find_folder(view, folder_id)
    if root is None:
        return [folder_id]
    out: list[str] = []
    stack = [root]
    while stack:
        f = stack.pop()
        out.append(f.id)
        stack.extend(reversed(f.folders))
    return out
