"""Payload schema for `code_snippet` artifacts.

A snippet is just Python source. Its *roles* (standalone / table column /
navigation step) are decided by which entry-point functions it defines, which
is derived from the AST at save time (see `lint.derive_entry_points`) — the
`entry_points` field here is advisory metadata only and is NEVER trusted at
evaluation time (inline snippets carry client-supplied values).
"""

from __future__ import annotations

from pydantic import BaseModel, Field, TypeAdapter
from typing import Literal

SNIPPET_SCHEMA_VERSION = 1
SNIPPET_MAX_CODE_BYTES = 64 * 1024


class SnippetDefinition(BaseModel):
    schema_version: int = SNIPPET_SCHEMA_VERSION
    language: Literal["python"] = "python"
    code: str = Field(max_length=SNIPPET_MAX_CODE_BYTES)
    entry_points: list[str] = Field(default_factory=list)


SNIPPET_ADAPTER: TypeAdapter[SnippetDefinition] = TypeAdapter(SnippetDefinition)
