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


def sanitize_stem(name: str) -> str:
    """Neutralize a filename STEM before it reaches any archive-member or
    filesystem path — the boundary where free-form user text (an artifact
    name, a `${name}`-templated element name) turns into a path component an
    unpacking tool will honor verbatim. `zipfile.ZipInfo` does not sanitize
    its `filename`, so an uncleaned stem becomes a zip-slip: unzipping walks
    OUTSIDE the archive root. Two independent hazards, both closed here:

    1. An EMBEDDED separator (`/`, `\\`) turns one path segment into several
       — stripped along with the other filesystem-unsafe characters.
    2. A stem that is nothing BUT dots (`"."`, `".."`, `"..."`, ...) is
       indistinguishable from a self/parent-directory reference once it is
       used as a whole path segment — as this module's own callers do for a
       `stem.ext` filename (harmless: `"..".ext` is just an odd filename,
       never a directory token) but as split-entry ZIP FOLDER names are NOT
       (`"../evil.json"` walks up a directory for real). Since this function
       cannot know which shape its caller will build, it neutralizes the
       all-dots case unconditionally rather than trusting every caller to
       reason about it — the cost is a same-length run of `_` in the rare
       case a stem really was all dots, in exchange for the property that
       output is NEVER `"."`/`".."`-equivalent as a lone path segment.
       Empty input stays empty (`""` is not "all dots" — no dots at all) so
       callers that fall back through `... or fallback or "element"` still
       reach that fallback.
    """
    cleaned = "".join("_" if ch in _UNSAFE or ord(ch) < 32 else ch for ch in name)
    cleaned = cleaned.strip()[:MAX_FILENAME_LEN].strip()
    if cleaned and not cleaned.strip("."):
        cleaned = "_" * len(cleaned)
    return cleaned


# Module-private alias: keeps this module's own call sites (below) unchanged
# while `sanitize_stem` is the public name callers outside this module use.
_sanitize = sanitize_stem


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
