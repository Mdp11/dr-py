"""JSON renderer for table export. Pure over (model, definition, row keys,
cells) — no API imports, unlike `api/table_export.py`, which lives in the API
layer only because core stays xlsx-free. JSON needs no dependency at all, so
the whole thing is unit-testable against a plain `Model`.

Spec: docs/superpowers/specs/2026-07-25-table-json-export-design.md
"""

from __future__ import annotations

from .schema import TableDefinition


def resolve_json_keys(defn: TableDefinition) -> list[str | None]:
    """One JSON key per definition column, positionally aligned; `None` for a
    hidden column (evaluated, because a visible column may reference it, but
    never emitted).

    Derivation, in order: an explicit `json_export.key`, else the column
    `header`, else `"<kind>_<index>"`. On a collision the FIRST occurrence keeps
    the name and later ones take `_2`, `_3`, ... The map is GLOBAL rather than
    per nesting level so a column carries the same key wherever it appears in
    the document — a reader can then rely on one key meaning one column.

    A hidden column consumes no name: its key is never emitted, so reserving one
    would push a visible column onto a `_2` suffix for no reason.
    """
    out: list[str | None] = []
    used: set[str] = set()
    for i, col in enumerate(defn.columns):
        if col.hidden:
            out.append(None)
            continue
        opts = col.json_export
        base = (opts.key if opts is not None else "") or col.header or f"{col.kind}_{i}"
        key = base
        n = 2
        # Loop rather than a single suffix: the `_2` a collision produces can
        # itself collide with a literal "Mass_2" header earlier in the table.
        while key in used:
            key = f"{base}_{n}"
            n += 1
        used.add(key)
        out.append(key)
    return out
