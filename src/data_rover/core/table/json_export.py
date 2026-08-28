"""JSON renderer for table export. Pure over (model, definition, row keys,
cells) — no API imports, unlike `api/table_export.py`, which lives in the API
layer only because core stays xlsx-free. JSON needs no dependency at all, so
the whole thing is unit-testable against a plain `Model`.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from data_rover.core.model.model import Model
from data_rover.core.model.naming import display_name

from .cells import (
    NOT_COMPUTED_MESSAGE,
    Cell,
    ElementCell,
    ElementsCell,
    ErrorCell,
    PendingCell,
    ValueCell,
    ValuesCell,
)
from .evaluate import RowKey, _expand_slot_of
from .export_layout import ROW_NUMBER_SLOT
from .schema import Column, ColumnRef, TableDefinition


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


def _honors_group(col: Column) -> bool:
    """Whether this column's `group` flag is actually acted on: set, on a
    VISIBLE EXPAND column. A stale flag anywhere else is IGNORED rather than
    rejected — the column editor can flip expand->collapse at any moment and a
    422 would block exporting the whole table over a leftover checkbox."""
    return (
        col.json_export is not None
        and col.json_export.group
        and not col.hidden
        and getattr(col, "mode", "collapse") == "expand"
    )


def resolve_item_keys(
    defn: TableDefinition, jkeys: list[str | None]
) -> list[str | None]:
    """Per definition column, the key a GROUPED column uses for its own value
    inside its array entries; `None` for every column that does not group.

    Positionally aligned with `jkeys`, and deliberately a SECOND pass over it:
    resolving group keys first means a group key always wins a collision, which
    is what keeps definitions written before `item_key` existed rendering
    byte-identically.

    A blank `item_key` — and an explicit one that repeats the column's own
    group key — is taken VERBATIM rather than uniquified. The two names belong
    to the same column at two nesting levels, so the global "one key means one
    column" invariant `resolve_json_keys` maintains still holds; suffixing it
    to `Signals_2` would be noise. Any OTHER explicit key joins that global
    namespace and takes `_2`, `_3`, ... on a clash.
    """
    out: list[str | None] = []
    used = {k for k in jkeys if k is not None}
    for i, col in enumerate(defn.columns):
        own = jkeys[i]
        if own is None or not _honors_group(col):
            out.append(None)  # hidden, or never rendered as a group
            continue
        opts = col.json_export
        base = (opts.item_key if opts is not None else "") or own
        if base == own:
            out.append(own)
            continue
        key = base
        n = 2
        while key in used:
            key = f"{base}_{n}"
            n += 1
        used.add(key)
        out.append(key)
    return out


def _element_json(model: Model, eid: str, mode: str) -> object:
    """One element reference rendered per the column's `json_export.value`.

    A DANGLING id (the element was deleted between evaluation and render)
    yields an error marker rather than raising: the xlsx path tolerates the
    same case, and a whole export must not 500 over one stale reference.
    """
    el = model.elements.get(eid)
    if el is None:
        return {"$error": f"unknown element {eid}"}
    if mode == "id":
        return el.id
    if mode == "object":
        return {"id": el.id, "name": display_name(el), "type": el.type_name}
    return display_name(el)


def render_cell(model: Model, cell: Cell, mode: str, *, single: bool = False) -> object:
    """One evaluated cell as a JSON-serializable value.

    `single` collapses an `ElementsCell` to ONE value: empty -> `None`, one
    element -> that element rendered per `mode`, more -> `ValueError` (the
    routes' 422 mapping) — the caller prefixes the column name. Every other
    cell kind ignores it, the way `mode` is ignored by a property column.

    Both "the type does not declare this property" and "declared but unset"
    render `null`: JSON has one absence, and the distinction the grid draws
    (greyed vs editable) is an editing affordance with no export meaning.

    A failed or uncomputed cell becomes `{"$error": ...}` rather than `null`.
    Nulling it would make a failure indistinguishable from an empty value for
    a programmatic consumer; the marker is the JSON analogue of the xlsx
    `#ERROR:` text, and it deliberately breaks type uniformity for that key.
    """
    if isinstance(cell, ValueCell):
        return None if not cell.present else cell.value
    if isinstance(cell, ValuesCell):
        # Always a list, length 1 included: a consumer must not have to
        # branch on arity to read a multi-source column.
        return list(cell.values)
    if isinstance(cell, ElementCell):
        return (
            None
            if cell.element_id is None
            else _element_json(model, cell.element_id, mode)
        )
    if isinstance(cell, ElementsCell):
        if single:
            if len(cell.element_ids) > 1:
                raise ValueError(
                    f"json_export.single: cell holds {len(cell.element_ids)} "
                    "elements, expected at most one"
                )
            ids = cell.element_ids
            return _element_json(model, ids[0], mode) if ids else None
        return [_element_json(model, e, mode) for e in cell.element_ids]
    if isinstance(cell, ErrorCell):
        return {"$error": cell.message}
    assert isinstance(cell, PendingCell)
    return {"$error": NOT_COMPUTED_MESSAGE}


def jsonl_bytes(docs: list[object]) -> bytes:
    """One compact value per line, `\\n`-terminated. A stream of objects is
    inherently compact and array-like, which is why `json_doc.shape`/`pretty`
    are ignored with tolerance for this format — only `on_error` (see
    `contains_error_marker`) applies. `docs` is typed `list[object]`, not
    `list[dict]`: pre-transform every element is a rendered row object, but a
    `transform(doc)` snippet may return a list of ANY JSON value —
    `json.dumps` handles that fine, and a post-transform line need not be an
    object."""
    return b"".join(
        json.dumps(d, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
        for d in docs
    )


def contains_error_marker(value: object) -> bool:
    """True when a rendered document carries any `{"$error": ...}` marker at
    any depth — the `on_error: "fail"` probe. Walks exactly the
    shapes `render_json` emits (dicts, lists, scalars). A user column whose
    resolved JSON key is literally `$error` would trip this too — accepted:
    strictness may over-fire on a pathological name, never under-fire."""
    if isinstance(value, dict):
        return "$error" in value or any(
            contains_error_marker(v) for v in value.values()
        )
    if isinstance(value, list):
        return any(contains_error_marker(v) for v in value)
    return False


def _mode_of(col: Column) -> str:
    return col.json_export.value if col.json_export is not None else "name"


def _render_column_cell(model: Model, col: Column, key: str, cell: Cell) -> object:
    """`render_cell` with the column's own `value`/`single` settings, naming
    the column in the `single` violation so the 422 points at the setting
    that caused it rather than at an anonymous cell."""
    opts = col.json_export
    single = opts.single if opts is not None else False
    try:
        return render_cell(model, cell, _mode_of(col), single=single)
    except ValueError as exc:
        raise ValueError(f"column {key!r}: {exc}") from None


@dataclass(frozen=True)
class GroupPlan:
    """Static grouping layout, derived once per export and reused per row.

    `grouped` holds only the columns whose `group` flag is HONORED — a visible
    `expand` column. Everything else about the plan is derived from those.
    """

    #: honored grouped columns, ascending
    grouped: tuple[int, ...]
    #: grouped column -> its row-key slot
    slot_of: dict[int, int]
    #: grouped column -> the columns rendered inside its array entries,
    #: ascending and always starting with the grouped column itself
    members: dict[int, tuple[int, ...]]
    #: grouped column -> the grouped columns nested directly inside it
    children: dict[int, tuple[int, ...]]
    #: visible columns rendered on the top-level object
    top_columns: tuple[int, ...]
    #: grouped columns with no grouped ancestor
    top_groups: tuple[int, ...]


def _deps(defn: TableDefinition) -> list[set[int]]:
    """Per column, the TRANSITIVE set of columns its source chain reaches.

    Single forward pass: the schema guarantees a `ColumnRef` points strictly
    backward, so the referenced column's own set is always already computed.
    """
    out: list[set[int]] = []
    for col in defn.columns:
        src = col.source
        if isinstance(src, ColumnRef):
            out.append({src.index} | out[src.index])
        else:
            out.append(set())
    return out


def build_group_plan(defn: TableDefinition, base_slots: int) -> GroupPlan:
    """Work out what nests inside what, from the definition alone.

    A column `j` is OWNED BY grouped column `k` when `k` is in `deps(j)`; when
    several grouped columns qualify the INNERMOST (largest index) wins, which
    is what makes `{part: [{subpart: [{mass: ...}]}]}` come out right instead
    of hoisting `mass` up beside `subpart`.

    `group` is honored only where `_honors_group` says so; a stale flag
    elsewhere is ignored, not rejected.
    """
    deps = _deps(defn)
    grouped = tuple(i for i, c in enumerate(defn.columns) if _honors_group(c))
    gset = set(grouped)

    def owner(i: int) -> int | None:
        candidates = [k for k in gset if k in deps[i]]
        return max(candidates) if candidates else None

    members: dict[int, list[int]] = {k: [] for k in grouped}
    children: dict[int, list[int]] = {k: [] for k in grouped}
    top_columns: list[int] = []
    top_groups: list[int] = []

    for i, col in enumerate(defn.columns):
        if col.hidden:
            continue  # evaluated, never emitted
        home = owner(i)
        if i in gset:
            # A grouped column renders its own value inside its own entries,
            # and nests under its grouped ANCESTOR (never under itself).
            members[i].append(i)
            (children[home] if home is not None else top_groups).append(i)
        elif home is None:
            top_columns.append(i)
        else:
            members[home].append(i)

    # Members come out ascending for free: ownership requires a backward
    # reference, so a grouped column always precedes everything it owns.
    return GroupPlan(
        grouped=grouped,
        slot_of={k: _expand_slot_of(defn, base_slots, k) for k in grouped},
        members={k: tuple(v) for k, v in members.items()},
        children={k: tuple(v) for k, v in children.items()},
        top_columns=tuple(top_columns),
        top_groups=tuple(top_groups),
    )


@dataclass(frozen=True)
class JsonKeys:
    """The resolved names, one entry per definition column.

    `level` is the key at a column's HOME level — for a grouped column that is
    the array's name. `item` is the key a grouped column uses for its own value
    INSIDE its entries, and is `None` for every column that does not group.
    Bundled rather than passed as two parallel lists so the recursive renderers
    keep their arity.
    """

    level: list[str | None]
    item: list[str | None]

    @staticmethod
    def resolve(defn: TableDefinition) -> JsonKeys:
        level = resolve_json_keys(defn)
        return JsonKeys(level=level, item=resolve_item_keys(defn, level))


#: One export row: its key (for grouping) paired with its evaluated cells.
_Pair = tuple[RowKey, list[Cell]]


def render_json_ex(
    model: Model,
    defn: TableDefinition,
    row_keys: list[RowKey],
    row_iter: Iterable[list[Cell]],
    base_slots: int,
    *,
    order: Sequence[int] | None = None,
    row_number: tuple[int, str] | None = None,
    key_column: int | None = None,
) -> tuple[list[dict[str, object]], list[str] | None]:
    """The whole table as a list of JSON objects, plus optional per-document
    keys for the object shape.

    `row_iter` yields cells in `row_keys` order (that is `iter_export_rows`'
    contract), so the two zip positionally.

    THIS CANNOT STREAM. Grouping merges rows through a dict, and a sort can
    scatter one group's rows across the whole result, so the document is held
    whole — the same trade `api/table_export.py` already makes when it gives up
    xlsxwriter's `constant_memory` for `autofit`, bounded by the same
    `TableLimits.max_rows`. Rows still ARRIVE chunk by chunk.

    `order` is a RANK LIST indexed by definition column index — that is,
    `ExportLayout.rank`, not the order list itself — so the lookup in the
    render loop is a subscript rather than a search. `None` keeps definition
    order.

    `row_number` is `(output_position, key)` and is emitted in TOP-LEVEL
    objects only: inside a grouped array the entries are not rows, so a row
    number there would have no referent. The number is the object's 1-based
    position in the returned list, which follows the requested sort.

    With `key_column` given, the second element carries ONE string key per
    returned document, positionally aligned. The key is read from the
    bucket's FIRST row's CELL at `key_column` — never from the rendered
    doc — so a hidden key column works (it is data, not presentation of the
    member list). A plain key column is constant across a grouped bucket by
    the same argument `_render_level` makes for plain columns; a key column
    that VARIES within a bucket (it reads a grouped slot) contributes
    whatever the bucket's first row carried, and the duplicate-key guard is
    what keeps that honest.

    Strict by decision, all `ValueError` (the routes' 422 mapping):
    `key_column` out of range; a key rendering `None`/`""`/non-scalar (an
    error cell renders a dict and lands here too); a duplicate key —
    filenames dedupe, data keys never do.
    """
    plan = build_group_plan(defn, base_slots)
    keys = JsonKeys.resolve(defn)
    pairs: list[_Pair] = list(zip(row_keys, row_iter, strict=True))

    if not plan.grouped:
        # Fast path, and not merely an optimization: bucketing would merge two
        # rows that happen to carry EQUAL keys into one object, silently
        # dropping a row the xlsx export renders twice.
        buckets: list[list[_Pair]] = [[p] for p in pairs]
    else:
        grouped_slots = {plan.slot_of[k] for k in plan.grouped}
        merged: dict[tuple[object, ...], list[_Pair]] = {}
        for rk, cells in pairs:
            gkey = tuple(v for i, v in enumerate(rk) if i not in grouped_slots)
            merged.setdefault(gkey, []).append((rk, cells))
        # dict preserves first-appearance order, which is what keeps the
        # document in the requested sort's order.
        buckets = list(merged.values())

    doc_keys: list[str] | None = None
    if key_column is not None:
        if not 0 <= key_column < len(defn.columns):
            raise ValueError(
                f"json_doc.key_column {key_column} out of range "
                f"(table has {len(defn.columns)} columns)"
            )
        key_col = defn.columns[key_column]
        key_name = keys.level[key_column] or f"#{key_column}"
        doc_keys = []
        seen: set[str] = set()
        for b in buckets:
            rendered = _render_column_cell(model, key_col, key_name, b[0][1][key_column])
            if (
                rendered is None
                or rendered == ""
                or not isinstance(rendered, str | int | float | bool)
            ):
                raise ValueError(
                    "json_doc.key_column renders an empty or non-scalar key "
                    f"for document {len(doc_keys) + 1}"
                )
            key = str(rendered)
            if key in seen:
                raise ValueError(f"json_doc.key_column: duplicate document key {key!r}")
            seen.add(key)
            doc_keys.append(key)

    return (
        [
            _render_level(
                model,
                defn,
                keys,
                plan,
                plan.top_columns,
                plan.top_groups,
                b,
                order=order,
                row_number=(row_number[0], row_number[1], n) if row_number else None,
            )
            for n, b in enumerate(buckets, start=1)
        ],
        doc_keys,
    )


def render_json(
    model: Model,
    defn: TableDefinition,
    row_keys: list[RowKey],
    row_iter: Iterable[list[Cell]],
    base_slots: int,
    *,
    order: Sequence[int] | None = None,
    row_number: tuple[int, str] | None = None,
) -> list[dict[str, object]]:
    """The whole table as a list of JSON objects. See `render_json_ex` for
    the object-shape key variant; everything else about the contract lives
    there now (this is a delegate kept for the many key-less call sites)."""
    docs, _ = render_json_ex(
        model,
        defn,
        row_keys,
        row_iter,
        base_slots,
        order=order,
        row_number=row_number,
    )
    return docs


def _render_level(
    model: Model,
    defn: TableDefinition,
    keys: JsonKeys,
    plan: GroupPlan,
    columns: tuple[int, ...],
    groups: tuple[int, ...],
    rows: list[_Pair],
    *,
    order: Sequence[int] | None = None,
    row_number: tuple[int, str, int] | None = None,
) -> dict[str, object]:
    """One JSON object: the plain `columns` plus one array per grouped column
    in `groups`, emitted in COLUMN ORDER so a grouped column's array sits at
    that column's own position rather than being pushed to the end.

    A plain column is read from `rows[0]` because its value is CONSTANT across
    the group by construction: it reads no grouped slot, so nothing that varies
    within the group can reach it.

    A grouped column appears in exactly two places: as an ARRAY at its home
    level (where it is in `group_set`) and as the plain leading member of its
    OWN entry level (where it is not — `build_group_plan` routes every other
    grouped column to `children`). That is the whole rule for picking between
    the two names.

    Emission order is the EXPORT order when `order` is given, definition order
    otherwise. `row_number` is `(position, key, number)` and is passed only for
    a top-level object — `_render_group` never forwards it.
    """
    group_set = set(groups)
    # (position, definition index) so the sort is total and stable. With no
    # `order` the position IS the definition index; ROW_NUMBER_SLOT's -1 then
    # breaks a tie toward the row number, which is where it belongs.
    entries: list[tuple[int, int]] = [
        (order[i] if order is not None else i, i) for i in (*columns, *groups)
    ]
    if row_number is not None:
        entries.append((row_number[0], ROW_NUMBER_SLOT))

    obj: dict[str, object] = {}
    for _, i in sorted(entries):
        if i == ROW_NUMBER_SLOT:
            assert row_number is not None
            obj[row_number[1]] = row_number[2]
        elif i in group_set:
            key = keys.level[i]
            if key is None:  # hidden: evaluated, never emitted
                continue
            obj[key] = _render_group(model, defn, keys, plan, i, rows, order=order)
        else:
            # A grouped column reached here is rendering its own value inside
            # its own entries, which is what `item` names.
            key = keys.item[i] if i in plan.grouped else keys.level[i]
            if key is None:  # hidden: evaluated, never emitted
                continue
            obj[key] = _render_column_cell(model, defn.columns[i], key, rows[0][1][i])
    return obj


def _render_group(
    model: Model,
    defn: TableDefinition,
    keys: JsonKeys,
    plan: GroupPlan,
    g: int,
    rows: list[_Pair],
    *,
    order: Sequence[int] | None = None,
) -> list[object]:
    """The array for one grouped column: its rows re-partitioned by the value
    sitting in its own expand slot.

    A `None` slot is DROPPED rather than rendered: it is the `keep_empty` row
    an expand column emits when it reached nothing, and `[]` — not `[null]` —
    is the honest JSON for "no children".

    Unwrapping: when the group holds only the grouped column itself and nests
    nothing, the array carries that column's values directly. Wrapping them in
    single-key objects would be noise — and `item_key` goes unused, since there
    is no object to put it on.
    """
    slot = plan.slot_of[g]
    parts: dict[object, list[_Pair]] = {}
    for rk, cells in rows:
        value = rk[slot]
        if value is None:
            continue
        parts.setdefault(value, []).append((rk, cells))

    members, children = plan.members[g], plan.children[g]
    if len(members) == 1 and not children:
        col, key = defn.columns[g], keys.level[g] or f"#{g}"
        return [
            _render_column_cell(model, col, key, sub[0][1][g]) for sub in parts.values()
        ]
    return [
        _render_level(model, defn, keys, plan, members, children, sub, order=order)
        for sub in parts.values()
    ]
