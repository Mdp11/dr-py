"""The `kind='exporter'` artifact payload: a named collection of table
exports whose presentation lives IN the artefact.

`overridden_table` is the override mechanism: a copy of the table definition
whose PRESENTATION fields are restated from an entry. RENDER ONLY — the copy
feeds `export_layout`/`export_header`/`export_definition`/`render_json` and
nothing else; evaluation keeps the original definition so cell values, row
order and script cache keys are independent of the artefact (the
`export_definition` boundary, applied from a different source).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, TypeAdapter

from data_rover.core.script.schema import SnippetSource

from .schema import (
    ColumnExportOptions,
    JsonColumnOptions,
    JsonSplitOptions,
    RowNumberExportOptions,
    TableDefinition,
    TableRef as TableRef,  # re-export: TableRef lives in schema.py (schema.py
    # cannot import from exporter.py, which imports from schema.py, without a
    # cycle) but every existing importer reaches it via exporter.py.
)

#: Hard cap on entries per exporter. A schema bound in the tradition of
#: SNIPPET_MAX_CODE_BYTES — enforced at validation (so it rejects at artifact
#: save), NOT an export-time strictness rule. Without it, POST /exports/run's
#: viewer-supplied draft definitions could chain unboundedly many whole-table
#: exports (each O(model)) into one synchronous request.
MAX_EXPORTER_ENTRIES = 50


#: The four wire formats an export can ship as. One vocabulary for
#: `ExporterEntry.format` and the standalone route's `ExportTableIn.format`
#: (extending both is nearly free — the engine branch is shared).
type ExportFormat = Literal["xlsx", "json", "csv", "jsonl"]

#: The two formats that render through the JSON document list — ONE spelling
#: for every "json family" gate (the engine's split/render branches, the run
#: route's split-template validation). csv/xlsx take the layout path. The
#: frontend mirror is `isJsonFamily` in `frontend/src/lib/api/types.ts`.
JSON_FAMILY: frozenset[ExportFormat] = frozenset({"json", "jsonl"})


class JsonDocumentOptions(BaseModel):
    """Document shaping for the `json` branch: applied after
    `render_json`, before serialization. Exporter-entry-only by decision —
    `TableDefinition` never grows this. On `jsonl`, `shape`/`pretty` are
    ignored with tolerance; `on_error` applies. On `xlsx`/`csv` the whole
    object is tolerated-and-ignored (presentation settings never block)."""

    shape: Literal["array", "object"] = "array"
    #: Definition column index whose rendered value keys each member when
    #: shape == "object". Strict at EXPORT time (missing/out-of-range/empty/
    #: duplicate -> 422 naming the entry); never blocks Save.
    key_column: int | None = None
    pretty: bool = True  # indent=2 vs compact separators
    #: "fail": any cell that would ship as {"$error": ...} turns the export
    #: into a 422 — a script consumer can demand a clean document or nothing.
    #: The default "emit" keeps the degraded-not-failed stance.
    on_error: Literal["emit", "fail"] = "emit"


class ColumnOverride(BaseModel):
    """Presentation override for ONE definition column, keyed by index.
    Indices drift-normalize against the current definition at apply time
    (out-of-range dropped, duplicates first-wins) — `normalized_order`'s
    stance: a stale override left by a column remove must not block an
    export."""

    index: int = Field(ge=0)
    export: ColumnExportOptions | None = None
    json_export: JsonColumnOptions | None = None


class OutputOptions(BaseModel):
    mode: Literal["zip", "bare"] = "zip"
    #: Zip filename template; "" = the artifact's name. NAME_TOKENS vocabulary.
    filename: str = ""
    manifest: bool = True


class ExporterEntry(BaseModel):
    source: TableRef
    #: Output base-name template; "" = the table's name. NAME_TOKENS vocabulary.
    name: str = ""
    #: Folder path template inside the zip; "" = archive root. Multi-segment.
    folder: str = ""
    format: ExportFormat = "xlsx"
    columns: list[ColumnOverride] = Field(default_factory=list)
    export_order: list[int] = Field(default_factory=list)
    show_row_numbers: bool = False
    export_row_number: RowNumberExportOptions | None = None
    json_split: JsonSplitOptions | None = None
    json_doc: JsonDocumentOptions | None = None
    #: Per-entry snippet post-processor: `transform(doc)` runs render ->
    #: shape -> TRANSFORM -> serialize, JSON-family formats only. Ref or
    #: inline, like every other `SnippetSource`. `None` OR an empty
    #: (`{}`/unconfigured) source both mean "no transform", never "inherit
    #: the table's own" — the no-bleed rule, both directions.
    transform: SnippetSource | None = None


class ExporterDefinition(BaseModel):
    schema_version: int = 1
    output: OutputOptions = Field(default_factory=OutputOptions)
    entries: list[ExporterEntry] = Field(
        default_factory=list, max_length=MAX_EXPORTER_ENTRIES
    )


EXPORTER_ADAPTER: TypeAdapter[ExporterDefinition] = TypeAdapter(ExporterDefinition)


def overridden_table(defn: TableDefinition, entry: ExporterEntry) -> TableDefinition:
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
            # The export engine reads its resolved code via an explicit
            # parameter, not off this copy — this restatement exists so the
            # render copy carries the entry's presentation completely, the
            # no-bleed rule made structural.
            "transform": entry.transform,
        }
    )
