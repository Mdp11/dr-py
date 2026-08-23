"""Per-base-element partitioning and the filename policy for split JSON export.

Pure over (row keys, cells), like `json_export.py` — the renderer stays
per-document; this module sits ABOVE it and decides which rows land in which
file and what that file is called.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping

from data_rover.core.model.model import Model
from data_rover.core.model.naming import display_name

from .cells import Cell
from .evaluate import Binding, RowKey
from .naming import sanitize_stem, substitute

#: Re-exported here (defined in `.naming`, imported above) because external
#: callers (`routes/exports.py`, `tests/table/test_split.py`) import it FROM
#: this module. Declared explicitly in `__all__` rather than left to look
#: like an unused import, so ruff's re-export lint has something to trust.
__all__ = [
    "sanitize_stem",
    "render_filenames",
    "split_partitions",
    "partition_label",
    "validate_template",
]

SPLIT_TOKEN = "${name}"

_Pair = tuple[RowKey, list[Cell]]


def validate_template(template: str) -> None:
    """`ValueError` when `${name}` is absent — the routes map `ValueError` to
    422, and the frontend dialog mirrors this predicate (reject, don't
    normalize — the ONE strict export setting)."""
    if SPLIT_TOKEN not in template:
        raise ValueError(f"filename template must contain {SPLIT_TOKEN}")


def split_partitions(
    row_keys: list[RowKey], row_iter: Iterable[list[Cell]]
) -> list[tuple[Binding, list[_Pair]]]:
    """The rows bucketed by RowKey slot 0 (the base element for scope/nav
    sources, the chain origin for chains), in first-appearance order so the
    requested sort survives. Materializes — same trade as `render_json`."""
    parts: dict[Binding, list[_Pair]] = {}
    for rk, cells in zip(row_keys, row_iter, strict=True):
        parts.setdefault(rk[0], []).append((rk, cells))
    return list(parts.items())


def partition_label(model: Model, binding: Binding) -> tuple[str, str]:
    """`(fallback_id, name)` for one partition's slot-0 binding. A dangling id
    (element deleted between evaluation and render) degrades to the id itself
    — same tolerance as `json_export._element_json`."""
    if isinstance(binding, str):
        el = model.elements.get(binding)
        return (binding, display_name(el)) if el is not None else (binding, binding)
    return str(binding), str(binding)


def render_filenames(
    template: str,
    items: list[tuple[str, str]],
    *,
    extra: Mapping[str, str] | None = None,
) -> list[str]:
    """One filename STEM per `(fallback_id, name)` item, deduplicated `_2`,
    `_3`, ... in row order. Per-item vars are `name` (display name) and `id`
    (the fallback id); `extra` carries the run-level context tokens
    (rev/date/project). The extension is appended by the CALLER after dedup,
    so `a` and a literal `a_2` can never merge. Loop (not a single suffix)
    for the same reason `resolve_json_keys` loops: a produced `_2` can
    collide with a literal name."""
    validate_template(template)
    base_vars = dict(extra or {})
    taken: set[str] = set()
    out: list[str] = []
    for fallback, name in items:
        rendered = substitute(template, {**base_vars, "name": name, "id": fallback})
        base = sanitize_stem(rendered) or sanitize_stem(fallback) or "element"
        candidate, n = base, 2
        while candidate in taken:
            candidate = f"{base}_{n}"
            n += 1
        taken.add(candidate)
        out.append(candidate)
    return out
