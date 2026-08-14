"""Per-base-element partitioning and the filename policy for split JSON export.

Pure over (row keys, cells), like `json_export.py` — the renderer stays
per-document; this module sits ABOVE it and decides which rows land in which
file and what that file is called.

Spec: docs/superpowers/specs/2026-08-13-table-export-split-and-custom-export-design.md
"""

from __future__ import annotations

from collections.abc import Iterable

from data_rover.core.model.model import Model
from data_rover.core.model.naming import display_name

from .cells import Cell
from .evaluate import Binding, RowKey

SPLIT_TOKEN = "${name}"
#: Sanitized-stem length cap. Well under every filesystem's 255-byte limit
#: even after the `.json` extension and a `_NN` dedupe suffix.
MAX_FILENAME_LEN = 120
_UNSAFE = set('/\\:*?"<>|')

_Pair = tuple[RowKey, list[Cell]]


def validate_template(template: str) -> None:
    """`ValueError` when `${name}` is absent — the routes map `ValueError` to
    422, and the frontend dialog mirrors this predicate (spec decision:
    reject, don't normalize — the ONE strict export setting)."""
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


def _sanitize(name: str) -> str:
    cleaned = "".join("_" if ch in _UNSAFE or ord(ch) < 32 else ch for ch in name)
    return cleaned.strip()[:MAX_FILENAME_LEN].strip()


def render_filenames(template: str, items: list[tuple[str, str]]) -> list[str]:
    """One filename STEM per `(fallback_id, name)` item, deduplicated `_2`,
    `_3`, ... in row order. The extension is appended by the CALLER after
    dedup, so `a` and a literal `a_2` can never merge. Loop (not a single
    suffix) for the same reason `resolve_json_keys` loops: a produced `_2`
    can collide with a literal name."""
    validate_template(template)
    taken: set[str] = set()
    out: list[str] = []
    for fallback, name in items:
        base = (
            _sanitize(template.replace(SPLIT_TOKEN, name))
            or _sanitize(fallback)
            or "element"
        )
        candidate, n = base, 2
        while candidate in taken:
            candidate = f"{base}_{n}"
            n += 1
        taken.add(candidate)
        out.append(candidate)
    return out
