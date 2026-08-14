"""The `kind='custom_export'` artifact payload: a named collection of table
exports whose presentation lives IN the artefact (spec §3.3).

`overridden_table` is the override mechanism: a copy of the table definition
whose PRESENTATION fields are restated from an entry. RENDER ONLY — the copy
feeds `export_layout`/`export_header`/`export_definition`/`render_json` and
nothing else; evaluation keeps the original definition so cell values, row
order and script cache keys are independent of the artefact (the
`export_definition` boundary, applied from a different source).

Spec: docs/superpowers/specs/2026-08-13-table-export-split-and-custom-export-design.md
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, TypeAdapter

from .schema import (
    ColumnExportOptions,
    JsonColumnOptions,
    JsonSplitOptions,
    RowNumberExportOptions,
    TableDefinition,
)


class TableRef(BaseModel):
    """Serialized as a dict under the literal key `"ref"` — the shape
    artifact_kinds.extract_refs's generic walk already understands, so the
    bundle deps closure and id rewriting need zero per-kind code."""

    ref: str


class ColumnOverride(BaseModel):
    """Presentation override for ONE definition column, keyed by index.
    Indices drift-normalize against the current definition at apply time
    (out-of-range dropped, duplicates first-wins) — `normalized_order`'s
    stance: a stale override left by a column remove must not block an
    export."""

    index: int = Field(ge=0)
    export: ColumnExportOptions | None = None
    json_export: JsonColumnOptions | None = None


class ExportEntry(BaseModel):
    source: TableRef
    #: Output base name in the zip; "" falls back to the table's name.
    name: str = ""
    format: Literal["xlsx", "json"] = "xlsx"
    columns: list[ColumnOverride] = Field(default_factory=list)
    export_order: list[int] = Field(default_factory=list)
    show_row_numbers: bool = False
    export_row_number: RowNumberExportOptions | None = None
    json_split: JsonSplitOptions | None = None


class CustomExportDefinition(BaseModel):
    schema_version: int = 1
    entries: list[ExportEntry] = Field(default_factory=list)


CUSTOM_EXPORT_ADAPTER: TypeAdapter[CustomExportDefinition] = TypeAdapter(
    CustomExportDefinition
)


def overridden_table(defn: TableDefinition, entry: ExportEntry) -> TableDefinition:
    """A copy of `defn` whose presentation restates `entry`.

    Columns the entry does not mention get DEFAULT presentation (`export=None`
    -> include follows `hidden`; `json_export=None`), deliberately NOT the
    table's own standalone settings — the two config sets never bleed into
    each other in either direction. Structural fields (sources, modes,
    `hidden`, filters, row source) are untouched: an entry restates how a
    table RENDERS, never what it computes.
    """
    by_index: dict[int, ColumnOverride] = {}
    for ov in entry.columns:
        if 0 <= ov.index < len(defn.columns) and ov.index not in by_index:
            by_index[ov.index] = ov
    columns = []
    for i, col in enumerate(defn.columns):
        override = by_index.get(i)
        columns.append(
            col.model_copy(
                update={
                    "export": override.export if override is not None else None,
                    "json_export": override.json_export
                    if override is not None
                    else None,
                }
            )
        )
    return defn.model_copy(
        update={
            "columns": columns,
            "export_order": list(entry.export_order),
            "show_row_numbers": entry.show_row_numbers,
            "export_row_number": entry.export_row_number,
            "json_split": entry.json_split,
        }
    )
