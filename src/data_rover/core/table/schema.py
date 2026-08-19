"""The `kind='table'` artifact payload schema.

A table's rows are TUPLES OF BINDINGS: the row source contributes one binding
slot (scope / navigation) or N (chains, one per chain column), and every
`expand` column contributes one more. Each column names a `source` — an earlier
binding slot or an earlier column — that resolves to an ordered set of elements;
the column maps over it. `collapse` keeps the mapped values in one cell;
`expand` promotes them to a new binding slot (one row per value).

Static validation here rejects cycles (a ColumnRef must point strictly
backward), non-element navigation sources, multi-binding element sources, and
chain_index on a non-chains row source. Two further rules need the metamodel or
the resolved navigation and are checked at evaluation time (see evaluate.py):
expand-on-a-scalar-property and chain_index-out-of-range.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, TypeAdapter, model_validator

from data_rover.core.navigation.schema import NavigationDefinition
from data_rover.core.script.schema import SnippetSource
from data_rover.core.search.criteria import Criterion

SCHEMA_VERSION = 1
MAX_COLUMNS = 50


class NavigationSource(BaseModel):
    """At most one of `ref` (saved artifact id) / `definition` (inline).

    NEITHER set (`{}`) is a legal, UNCONFIGURED source: the table editor
    creates a navigation column / row source before the user picks its
    navigation, and rejecting that transient state here would 422 every
    evaluate/save of the WHOLE table until it is configured. Evaluation
    treats an unconfigured source as reaching nothing (empty cell / no rows)
    — same tolerant-evaluation stance as `cells.expand_property_values`.
    BOTH set stays rejected: the request is ambiguous, not incomplete.
    """

    ref: str | None = None
    definition: NavigationDefinition | None = None

    @model_validator(mode="after")
    def _at_most_one(self) -> NavigationSource:
        if self.ref is not None and self.definition is not None:
            raise ValueError("provide at most one of `ref` / `definition`")
        return self

    @property
    def is_empty(self) -> bool:
        """True for the unconfigured (`{}`) source."""
        return self.ref is None and self.definition is None


# ---- row source -------------------------------------------------------------
class ScopeRows(BaseModel):
    kind: Literal["scope"] = "scope"
    types: list[str] = Field(default_factory=list)
    criteria: list[Criterion] = Field(default_factory=list)


class NavigationRows(BaseModel):
    kind: Literal["navigation"] = "navigation"
    navigation: NavigationSource
    step_index: int | None = None


class ChainRows(BaseModel):
    kind: Literal["chains"] = "chains"
    navigation: NavigationSource


RowSource = Annotated[
    ScopeRows | NavigationRows | ChainRows, Field(discriminator="kind")
]


# ---- column source ----------------------------------------------------------
class RowSlot(BaseModel):
    kind: Literal["row"] = "row"
    chain_index: int = Field(default=0, ge=0)


class ColumnRef(BaseModel):
    kind: Literal["column"] = "column"
    index: int = Field(ge=0)
    #: Only legal when the referenced column is a NAVIGATION column: resolve
    #: this reference to the elements at THIS chain step (0 = the chain's
    #: start) instead of the referenced column's own projected step. None =
    #: the referenced column's own behavior (unchanged).
    step_index: int | None = None


ColumnSource = Annotated[RowSlot | ColumnRef, Field(discriminator="kind")]


# ---- columns ----------------------------------------------------------------
class JsonColumnOptions(BaseModel):
    """Per-column JSON-export settings (spec:
    docs/superpowers/specs/2026-07-25-table-json-export-design.md).

    Lives on the COLUMN rather than on `TableDefinition` as an index-keyed map
    deliberately: column indices move under reorder/insert/remove (the frontend
    already carries `remapTableSortForRemove/Move/Insert` to keep a single index
    valid across those edits), and settings attached to the column travel with
    it for free.

    The field is named `json_export` and not `json`: pydantic v2 still carries a
    deprecated `.json()` method that a field of that name would collide with.
    """

    #: "" means "derive from the header" — see `resolve_json_keys`.
    key: str = ""
    #: Key for the column's OWN value inside the array entries `group`
    #: produces. Meaningful only where `group` is honored; "" falls back to
    #: the RESOLVED group key — which is exactly what the single key this
    #: field splits already did, so old definitions export unchanged.
    item_key: str = ""
    #: How an element reference renders. Ignored by columns that never produce
    #: elements (a property column), which is tolerated rather than rejected.
    value: Literal["name", "id", "object"] = "name"
    #: Roll this `expand` column's rows back up into one array. Honored only on
    #: a VISIBLE EXPAND column; ignored elsewhere (the column editor can flip
    #: expand->collapse at any time and a 422 would block the whole export).
    group: bool = False


class ColumnExportOptions(BaseModel):
    """Per-column export overrides (spec:
    docs/superpowers/specs/2026-07-28-table-export-settings-design.md).

    On the COLUMN rather than in an index-keyed map on `TableDefinition`, for
    the same reason `JsonColumnOptions` is: column indices move under reorder,
    insert, and remove, and settings attached to the column travel with it for
    free.

    Presentation-only, like `hidden` and `json_export`: never consulted during
    evaluation.
    """

    #: `None` = follow `hidden`, which is what makes every pre-existing
    #: definition export byte-identically. `True` on a hidden column exports it
    #: WITHOUT unhiding it in the grid; `False` on a visible one keeps it on
    #: screen and out of the file.
    include: bool | None = None
    #: xlsx header override; "" keeps today's `header or kind`. JSON renames
    #: through `json_export.key` instead and ignores this — one rename box per
    #: format, never two on one row.
    header: str = ""


class RowNumberExportOptions(BaseModel):
    """Export overrides for the row-number pseudo-column.

    Lives on the definition rather than on a column because there is no
    `Column` to hang it off: the row-number column is synthesized by the
    renderers from `show_row_numbers`.
    """

    include: bool = True
    #: "" -> "#" (xlsx).
    header: str = ""
    #: "" -> "row_number" (JSON).
    key: str = ""


class JsonSplitOptions(BaseModel):
    """Split the JSON export into one file per base element (spec:
    docs/superpowers/specs/2026-08-13-table-export-split-and-custom-export-design.md,
    docs/superpowers/specs/2026-08-19-custom-export-v2-design.md).

    Presentation-only, like `export_order`: never consulted during evaluation.
    `filename_template` must contain `${name}` — enforced at EXPORT time
    (`core/table/split.validate_template`), deliberately not here, so a stored
    bad template cannot block saving or evaluating the table."""

    enabled: bool = False
    #: `${name}` is replaced by each base element's display name.
    filename_template: str = ""


class ElementColumn(BaseModel):
    kind: Literal["element"] = "element"
    source: ColumnSource = Field(default_factory=RowSlot)
    header: str = ""
    width_px: int | None = None
    #: Presentation-only: a hidden column is still evaluated (later columns
    #: may reference it via ColumnRef) but is omitted from the grid and the
    #: xlsx export. Never feed this into evaluation — dropping the column
    #: would shift ColumnRef indices and the expand-slot arithmetic.
    hidden: bool = False
    #: JSON-export settings; `None` means "all defaults", which keeps saved
    #: payloads clean for the overwhelming majority of columns.
    json_export: JsonColumnOptions | None = None
    #: Export overrides (inclusion, xlsx header). `None` means "all defaults",
    #: which keeps saved payloads clean for the overwhelming majority.
    export: ColumnExportOptions | None = None


class PropertyColumn(BaseModel):
    kind: Literal["property"] = "property"
    source: ColumnSource = Field(default_factory=RowSlot)
    name: str
    mode: Literal["collapse", "expand"] = "collapse"
    keep_empty: bool = True
    header: str = ""
    width_px: int | None = None
    #: Presentation-only: a hidden column is still evaluated (later columns
    #: may reference it via ColumnRef) but is omitted from the grid and the
    #: xlsx export. Never feed this into evaluation — dropping the column
    #: would shift ColumnRef indices and the expand-slot arithmetic.
    hidden: bool = False
    #: JSON-export settings; `None` means "all defaults", which keeps saved
    #: payloads clean for the overwhelming majority of columns.
    json_export: JsonColumnOptions | None = None
    #: Export overrides (inclusion, xlsx header). `None` means "all defaults",
    #: which keeps saved payloads clean for the overwhelming majority.
    export: ColumnExportOptions | None = None


class NavigationColumn(BaseModel):
    kind: Literal["navigation"] = "navigation"
    source: ColumnSource = Field(default_factory=RowSlot)
    navigation: NavigationSource
    step_index: int | None = None
    mode: Literal["collapse", "expand"] = "collapse"
    keep_empty: bool = True
    sort_mode: Literal["value", "count"] = "value"
    cell_cap: int = Field(default=20, ge=1)
    header: str = ""
    width_px: int | None = None
    #: Presentation-only: a hidden column is still evaluated (later columns
    #: may reference it via ColumnRef) but is omitted from the grid and the
    #: xlsx export. Never feed this into evaluation — dropping the column
    #: would shift ColumnRef indices and the expand-slot arithmetic.
    hidden: bool = False
    #: JSON-export settings; `None` means "all defaults", which keeps saved
    #: payloads clean for the overwhelming majority of columns.
    json_export: JsonColumnOptions | None = None
    #: Export overrides (inclusion, xlsx header). `None` means "all defaults",
    #: which keeps saved payloads clean for the overwhelming majority.
    export: ColumnExportOptions | None = None


class ScriptColumn(BaseModel):
    kind: Literal["script"] = "script"
    source: ColumnSource = Field(default_factory=RowSlot)
    snippet: SnippetSource = Field(default_factory=SnippetSource)
    mode: Literal["collapse", "expand"] = "collapse"
    keep_empty: bool = True
    header: str = ""
    width_px: int | None = None
    #: Presentation-only: a hidden column is still evaluated (later columns
    #: may reference it via ColumnRef) but is omitted from the grid and the
    #: xlsx export. Never feed this into evaluation — dropping the column
    #: would shift ColumnRef indices and the expand-slot arithmetic.
    hidden: bool = False
    #: JSON-export settings; `None` means "all defaults", which keeps saved
    #: payloads clean for the overwhelming majority of columns.
    json_export: JsonColumnOptions | None = None
    #: Export overrides (inclusion, xlsx header). `None` means "all defaults",
    #: which keeps saved payloads clean for the overwhelming majority.
    export: ColumnExportOptions | None = None


Column = Annotated[
    ElementColumn | PropertyColumn | NavigationColumn | ScriptColumn,
    Field(discriminator="kind"),
]


class TableDefinition(BaseModel):
    schema_version: int = SCHEMA_VERSION
    row_source: RowSource
    columns: list[Column] = Field(min_length=1, max_length=MAX_COLUMNS)
    default_cell_mode: Literal["collapse", "expand"] = "collapse"
    #: Presentation flag: render a 1-based "#" first column in the grid and
    #: prepend the same column to the xlsx export. Not a real column — it
    #: never participates in ColumnRef indexing, sorting, or evaluation.
    show_row_numbers: bool = False
    #: Output order for the export, as definition column indices, with
    #: `export_layout.ROW_NUMBER_SLOT` (-1) standing for the row-number
    #: pseudo-column. `[]` = definition order. NOT an evaluation order:
    #: column order is structural (backward-only `ColumnRef`, positional
    #: expand slots) and is never permuted — this reorders the OUTPUT.
    #: Normalized rather than validated (see `export_layout.normalized_order`):
    #: a stale list left behind by a column insert or remove must degrade to a
    #: sensible order, not 422 the whole export.
    export_order: list[int] = Field(default_factory=list)
    export_row_number: RowNumberExportOptions | None = None
    #: JSON-export split settings; `None` = single-document export (today's
    #: behavior, and the no-migration guarantee for existing payloads).
    json_split: JsonSplitOptions | None = None

    @model_validator(mode="after")
    def _validate_sources(self) -> TableDefinition:
        is_chains = self.row_source.kind == "chains"
        for i, col in enumerate(self.columns):
            src = col.source
            # backward-only column refs
            if isinstance(src, ColumnRef) and src.index >= i:
                raise ValueError(
                    f"column {i} sources column {src.index} (must be < {i})"
                )
            if isinstance(src, ColumnRef) and src.step_index is not None:
                if self.columns[src.index].kind != "navigation":
                    raise ValueError(
                        f"column {i}: source step_index requires the referenced "
                        "column to be a navigation column"
                    )
            # chain_index only on a chains row source
            if isinstance(src, RowSlot) and src.chain_index != 0 and not is_chains:
                raise ValueError("chain_index != 0 requires a chains row source")
            # is the source element-producing, and is it single-binding?
            producing, single = self._source_arity(src)
            if col.kind == "navigation" and not producing:
                raise ValueError(
                    f"column {i}: navigation source is not element-producing"
                )
            if col.kind == "element" and not producing:
                raise ValueError(
                    f"column {i}: element column needs an element-producing source"
                )
            if col.kind == "element" and not single:
                raise ValueError(
                    f"column {i}: element column needs a single-binding source"
                )
            if col.kind == "property" and col.mode == "expand" and not single:
                raise ValueError(
                    f"column {i}: expanded property needs a single-binding source"
                )
        return self

    def _source_arity(self, src: ColumnSource) -> tuple[bool, bool]:
        """(element_producing, single_binding) for a column source.

        A row slot is always element-producing and single. A ColumnRef inherits
        from the referenced column: element/expand columns are single-binding
        elements; a collapse navigation column is multi-binding elements; a
        property column is not element-producing.
        """
        if isinstance(src, RowSlot):
            return True, True
        ref = self.columns[src.index]
        if ref.kind == "element":
            return True, True
        if ref.kind == "navigation":
            # a step-index override re-projects the chains and can return MANY
            # elements per row even off an expand column — no longer single.
            single = ref.mode == "expand" and src.step_index is None
            return True, single
        if ref.kind == "script":
            # Element-capable at RUNTIME: value() may return Element(s); a
            # scalar result simply binds nothing downstream (tolerant — the
            # return type is not statically knowable). Like a navigation
            # column, collapse is multi-binding, expand promotes one binding
            # per row.
            return True, ref.mode == "expand"
        # property column
        return False, ref.mode == "expand"


TABLE_ADAPTER: TypeAdapter[TableDefinition] = TypeAdapter(TableDefinition)
