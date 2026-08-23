"""The artifact-kind registry — the ONE place per-kind knowledge lives.

Adding a kind = one `ArtifactKindSpec` entry (plus its schema module).
Everything else (`routes/artifacts.py` CRUD, artifact ops, the export
closure) is generic over this registry. `diagram` / `diagram_kind` stay
unregistered on purpose: unregistered kinds 422 on write.

Dependency extraction / ref rewriting use a generic walk: in every
registered payload schema an artifact reference is a dict entry under the
literal key ``"ref"`` (navigation ``Operand.ref``, table
``NavigationSource.ref``, ``SnippetSource.ref``). Keeping ONE walk keeps
``extract_deps`` and ``rewrite_refs`` in lockstep; the contract tests in
``tests/api/test_artifact_kinds.py`` pin the exact behavior per schema, so
a schema change that adds a differently-shaped reference fails there."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from pydantic import TypeAdapter

from data_rover.core.navigation.schema import NAVIGATION_ADAPTER
from data_rover.core.script.lint import derive_entry_points
from data_rover.core.script.schema import SNIPPET_ADAPTER
from data_rover.core.table.exporter import EXPORTER_ADAPTER
from data_rover.core.table.schema import TABLE_ADAPTER

from .db_models import ArtifactKind


def extract_refs(payload: Any) -> set[str]:
    """Every artifact id referenced by *payload* (see module docstring)."""
    out: set[str] = set()
    _walk(payload, out)
    return out


def _walk(node: Any, out: set[str]) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "ref" and isinstance(value, str):
                out.add(value)
            else:
                _walk(value, out)
    elif isinstance(node, list):
        for value in node:
            _walk(value, out)


def rewrite_refs(payload: Any, id_map: Mapping[str, str]) -> Any:
    """A structural copy of *payload* with every known ref remapped.

    Unknown refs pass through unchanged (tolerant-dangler stance); the input
    is never mutated."""
    if isinstance(payload, dict):
        return {
            key: (
                id_map.get(value, value)
                if key == "ref" and isinstance(value, str)
                else rewrite_refs(value, id_map)
            )
            for key, value in payload.items()
        }
    if isinstance(payload, list):
        return [rewrite_refs(value, id_map) for value in payload]
    return payload


def _derive_snippet_metadata(payload: dict[str, Any]) -> None:
    """entry_points is server-owned: recomputed from the code AST on every
    write, overwriting any client-supplied value."""
    payload["entry_points"] = derive_entry_points(payload.get("code", ""))


@dataclass(frozen=True)
class ArtifactKindSpec:
    kind: ArtifactKind
    adapter: TypeAdapter[Any]
    #: recompute server-owned derived fields in-place; None = kind has none
    derive_metadata: Callable[[dict[str, Any]], None] | None = None
    #: surface payload["entry_points"] on list headers (snippets only today)
    surfaces_entry_points: bool = False
    extract_deps: Callable[[dict[str, Any]], set[str]] = field(default=extract_refs)
    rewrite_refs: Callable[[dict[str, Any], Mapping[str, str]], dict[str, Any]] = field(
        default=rewrite_refs
    )


_REGISTRY: dict[ArtifactKind, ArtifactKindSpec] = {
    ArtifactKind.navigation: ArtifactKindSpec(
        kind=ArtifactKind.navigation, adapter=NAVIGATION_ADAPTER
    ),
    ArtifactKind.table: ArtifactKindSpec(
        kind=ArtifactKind.table, adapter=TABLE_ADAPTER
    ),
    ArtifactKind.code_snippet: ArtifactKindSpec(
        kind=ArtifactKind.code_snippet,
        adapter=SNIPPET_ADAPTER,
        derive_metadata=_derive_snippet_metadata,
        surfaces_entry_points=True,
    ),
    ArtifactKind.exporter: ArtifactKindSpec(
        kind=ArtifactKind.exporter, adapter=EXPORTER_ADAPTER
    ),
}


def get_spec(kind: ArtifactKind) -> ArtifactKindSpec | None:
    return _REGISTRY.get(kind)
