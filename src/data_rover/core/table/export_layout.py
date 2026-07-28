"""Which columns an export contains, in what order, under what names.

Presentation only, and deliberately a separate module from `schema.py`: this
is the ONE place that answers the question, so the xlsx writer, the JSON
renderer, and the settings UI's client-side mirror cannot drift apart.

The load-bearing idea is that an export never permutes the definition. Column
order there is structural — a `ColumnRef` may only point backwards and expand
slots are positional — so `export_order` describes an OUTPUT order and the
renderers walk the definition through it.

Spec: docs/superpowers/specs/2026-07-28-table-export-settings-design.md
"""

from __future__ import annotations

from dataclasses import dataclass

from .schema import TableDefinition

#: `export_order`'s stand-in for the row-number pseudo-column, which has no
#: definition index of its own. Negative so it can never collide with one.
ROW_NUMBER_SLOT = -1

DEFAULT_ROW_NUMBER_HEADER = "#"
DEFAULT_ROW_NUMBER_KEY = "row_number"


@dataclass(frozen=True)
class ExportLayout:
    """Where every column lands in one exported file.

    `order` and `rank` are two views of the same permutation because the two
    renderers need opposite lookups: the xlsx writer walks output positions and
    needs the definition index at each (`order`), while `json_export` walks
    definition indices and needs each one's output position (`rank`).
    """

    #: Definition indices, in export order, INCLUDED ones only.
    order: tuple[int, ...]
    #: Output position per DEFINITION column index, positionally aligned with
    #: `defn.columns`. An excluded column ranks past every included one rather
    #: than raising, so a stray reference sorts last instead of exploding.
    rank: tuple[int, ...]
    #: Output position of the row-number pseudo-column (0 = first), or `None`
    #: when `show_row_numbers` is off or it was excluded. In the SAME position
    #: space as `rank`.
    row_number_pos: int | None
    #: Already defaulted — callers never re-apply the `or "#"` fallback.
    row_number_header: str
    row_number_key: str


def _included(defn: TableDefinition) -> list[bool]:
    """Per definition column, whether the export contains it. `include=None`
    follows `hidden`, which is the whole no-migration guarantee."""
    out: list[bool] = []
    for col in defn.columns:
        opts = col.export
        if opts is None or opts.include is None:
            out.append(not col.hidden)
        else:
            out.append(opts.include)
    return out


def normalized_order(defn: TableDefinition) -> tuple[int, ...]:
    """`export_order` made safe, INCLUDING excluded entries.

    Drops out-of-range and duplicate entries, drops `ROW_NUMBER_SLOT` when
    `show_row_numbers` is off, then appends every definition column the list
    forgot. When row numbers are on and the slot is absent it leads — that is
    where the "#" column has always sat.

    Normalized, never validated: `export_order` is a presentation setting, and
    a stale list left behind by a column insert or remove must not be able to
    block an export.
    """
    n = len(defn.columns)
    seen: set[int] = set()
    out: list[int] = []
    for i in defn.export_order:
        if i == ROW_NUMBER_SLOT:
            if not defn.show_row_numbers or i in seen:
                continue
        elif not (0 <= i < n) or i in seen:
            continue
        seen.add(i)
        out.append(i)
    if defn.show_row_numbers and ROW_NUMBER_SLOT not in seen:
        out.insert(0, ROW_NUMBER_SLOT)
    out.extend(i for i in range(n) if i not in seen)
    return tuple(out)


def export_layout(defn: TableDefinition) -> ExportLayout:
    """The definition's export settings resolved into output positions."""
    included = _included(defn)
    rn = defn.export_row_number
    rn_included = defn.show_row_numbers and (rn is None or rn.include)

    order: list[int] = []
    # Sentinel for an excluded column. Positions run 0..len(columns), so
    # len(columns) + 1 is past every one of them.
    rank = [len(defn.columns) + 1] * len(defn.columns)
    row_number_pos: int | None = None
    pos = 0
    for i in normalized_order(defn):
        if i == ROW_NUMBER_SLOT:
            if not rn_included:
                continue
            row_number_pos = pos
        else:
            if not included[i]:
                continue
            rank[i] = pos
            order.append(i)
        pos += 1

    return ExportLayout(
        order=tuple(order),
        rank=tuple(rank),
        row_number_pos=row_number_pos,
        row_number_header=(rn.header if rn is not None else "")
        or DEFAULT_ROW_NUMBER_HEADER,
        row_number_key=(rn.key if rn is not None else "") or DEFAULT_ROW_NUMBER_KEY,
    )


def export_definition(defn: TableDefinition) -> TableDefinition:
    """A copy of `defn` whose `hidden` flags say what the EXPORT includes.

    Reusing `hidden` is the point. `resolve_json_keys`, `_honors_group`, and
    `build_group_plan` already skip hidden columns, and the group plan derives
    its whole nesting structure from them; an export-effective copy inherits
    all of that instead of threading a second include-set through three
    functions that would then have to agree forever.

    Header overrides are deliberately NOT applied here — see `export_header`.
    `resolve_json_keys` falls back to `col.header`, so folding the xlsx header
    override into this copy would leak it into JSON keys, and the two renames
    are separate by design.

    RENDER ONLY. Evaluation keeps the ORIGINAL definition: `hidden` is
    presentation, but this copy is not what the user wrote, and feeding it to
    `build_rows_ex`/`order_rows`/`iter_export_rows`/the script context would
    make cached cells depend on export settings.
    """
    included = _included(defn)
    columns = [
        col if col.hidden == (not inc) else col.model_copy(update={"hidden": not inc})
        for col, inc in zip(defn.columns, included, strict=True)
    ]
    return defn.model_copy(update={"columns": columns})


def export_header(defn: TableDefinition, index: int) -> str:
    """The xlsx header for one column: its export override, else its grid
    header, else its kind — the last two being exactly today's fallback."""
    col = defn.columns[index]
    opts = col.export
    return (opts.header if opts is not None else "") or col.header or col.kind
