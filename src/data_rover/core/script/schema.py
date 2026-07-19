"""Payload schema for `code_snippet` artifacts.

A snippet is just Python source. Its *roles* (standalone / table column /
navigation step) are decided by which entry-point functions it defines, which
is derived from the AST at save time (see `lint.derive_entry_points`) — the
`entry_points` field here is advisory metadata only and is NEVER trusted at
evaluation time (inline snippets carry client-supplied values).
"""

from __future__ import annotations

from pydantic import BaseModel, Field, TypeAdapter, model_validator
from typing import Literal

SNIPPET_SCHEMA_VERSION = 1
SNIPPET_MAX_CODE_BYTES = 64 * 1024


class SnippetDefinition(BaseModel):
    schema_version: int = SNIPPET_SCHEMA_VERSION
    language: Literal["python"] = "python"
    code: str = Field(max_length=SNIPPET_MAX_CODE_BYTES)
    entry_points: list[str] = Field(default_factory=list)


SNIPPET_ADAPTER: TypeAdapter[SnippetDefinition] = TypeAdapter(SnippetDefinition)


class SnippetSource(BaseModel):
    """At most one of `ref` (saved snippet artifact id) / `definition`
    (inline). NEITHER set (`{}`) is a legal, UNCONFIGURED source — the column/
    step editors create the item before the user picks its snippet, and
    evaluation treats it as producing nothing. Same tolerant stance (and same
    shape) as `core.table.schema.NavigationSource`. BOTH set is rejected:
    ambiguous, not incomplete."""

    ref: str | None = None
    definition: SnippetDefinition | None = None

    @model_validator(mode="after")
    def _at_most_one(self) -> SnippetSource:
        if self.ref is not None and self.definition is not None:
            raise ValueError("provide at most one of `ref` / `definition`")
        return self

    @property
    def is_empty(self) -> bool:
        """True for the unconfigured (`{}`) source."""
        return self.ref is None and self.definition is None
