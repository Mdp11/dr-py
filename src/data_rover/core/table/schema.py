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

from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field, TypeAdapter, model_validator

from data_rover.core.navigation.schema import NavigationDefinition
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
    def _at_most_one(self) -> "NavigationSource":
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
    Union[ScopeRows, NavigationRows, ChainRows], Field(discriminator="kind")
]


# ---- column source ----------------------------------------------------------
class RowSlot(BaseModel):
    kind: Literal["row"] = "row"
    chain_index: int = Field(default=0, ge=0)


class ColumnRef(BaseModel):
    kind: Literal["column"] = "column"
    index: int = Field(ge=0)


ColumnSource = Annotated[Union[RowSlot, ColumnRef], Field(discriminator="kind")]


# ---- columns ----------------------------------------------------------------
class ElementColumn(BaseModel):
    kind: Literal["element"] = "element"
    source: ColumnSource = Field(default_factory=RowSlot)
    header: str = ""
    width_px: int | None = None


class PropertyColumn(BaseModel):
    kind: Literal["property"] = "property"
    source: ColumnSource = Field(default_factory=RowSlot)
    name: str
    mode: Literal["collapse", "expand"] = "collapse"
    keep_empty: bool = True
    header: str = ""
    width_px: int | None = None


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


Column = Annotated[
    Union[ElementColumn, PropertyColumn, NavigationColumn],
    Field(discriminator="kind"),
]


class TableDefinition(BaseModel):
    schema_version: int = SCHEMA_VERSION
    row_source: RowSource
    columns: list[Column] = Field(min_length=1, max_length=MAX_COLUMNS)
    default_cell_mode: Literal["collapse", "expand"] = "collapse"

    @model_validator(mode="after")
    def _validate_sources(self) -> "TableDefinition":
        is_chains = self.row_source.kind == "chains"
        for i, col in enumerate(self.columns):
            src = col.source
            # backward-only column refs
            if isinstance(src, ColumnRef) and src.index >= i:
                raise ValueError(
                    f"column {i} sources column {src.index} (must be < {i})"
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

    def _source_arity(self, src: "ColumnSource") -> tuple[bool, bool]:
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
            single = ref.mode == "expand"
            return True, single
        # property column
        return False, ref.mode == "expand"


TABLE_ADAPTER: TypeAdapter[TableDefinition] = TypeAdapter(TableDefinition)
