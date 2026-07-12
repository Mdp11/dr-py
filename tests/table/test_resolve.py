"""`_resolve_table_navigation_refs` inlines every `NavigationSource` embedded
in a `TableDefinition` (row_source's navigation on `NavigationRows`/
`ChainRows`, and each `NavigationColumn`'s navigation) via an injected fetch
callable — even when the source was already inline, since an inline
navigation definition can itself carry operand refs that must be inlined too.
Mirrors `tests/navigation/test_resolve.py`."""

import pytest

from data_rover.core.navigation.schema import (
    NAVIGATION_ADAPTER,
    PathNavigation,
    SetExpression,
)
from data_rover.core.table.resolve import _resolve_table_navigation_refs
from data_rover.core.table.schema import (
    TABLE_ADAPTER,
    ChainRows,
    NavigationColumn,
    NavigationRows,
)


def _nav(doc: dict):
    return NAVIGATION_ADAPTER.validate_python(doc)


PATH = {
    "kind": "path",
    "start": {"kind": "scope", "types": ["Block"]},
    "steps": [{"kind": "relationship", "relationship_type": "BlockHasPart"}],
}


def _table(doc: dict):
    return TABLE_ADAPTER.validate_python(doc)


def test_unknown_column_ref_raises_lookup_error() -> None:
    defn = _table(
        {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": [
                {
                    "kind": "navigation",
                    "source": {"kind": "row"},
                    "navigation": {"ref": "ghost"},
                }
            ],
        }
    )
    with pytest.raises(LookupError):
        _resolve_table_navigation_refs(defn, fetch={}.__getitem__)


def test_column_navigation_ref_is_replaced_by_inlined_definition() -> None:
    orig = _table(
        {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": [
                {
                    "kind": "navigation",
                    "source": {"kind": "row"},
                    "navigation": {"ref": "a"},
                }
            ],
        }
    )
    resolved = _resolve_table_navigation_refs(
        orig, fetch={"a": _nav(PATH)}.__getitem__
    )
    col = resolved.columns[0]
    assert isinstance(col, NavigationColumn)
    assert col.navigation.ref is None
    assert isinstance(col.navigation.definition, PathNavigation)
    assert col.navigation.definition == _nav(PATH)
    # the original is untouched
    orig_col = orig.columns[0]
    assert isinstance(orig_col, NavigationColumn)
    assert orig_col.navigation.ref == "a"


def test_row_source_navigation_ref_is_replaced_by_inlined_definition() -> None:
    defn = _table(
        {
            "row_source": {"kind": "navigation", "navigation": {"ref": "a"}},
            "columns": [{"kind": "element", "source": {"kind": "row"}}],
        }
    )
    resolved = _resolve_table_navigation_refs(
        defn, fetch={"a": _nav(PATH)}.__getitem__
    )
    rs = resolved.row_source
    assert isinstance(rs, NavigationRows)
    assert rs.navigation.ref is None
    assert rs.navigation.definition == _nav(PATH)


def test_chain_rows_navigation_ref_is_replaced_by_inlined_definition() -> None:
    defn = _table(
        {
            "row_source": {"kind": "chains", "navigation": {"ref": "a"}},
            "columns": [{"kind": "element", "source": {"kind": "row"}}],
        }
    )
    resolved = _resolve_table_navigation_refs(
        defn, fetch={"a": _nav(PATH)}.__getitem__
    )
    rs = resolved.row_source
    assert isinstance(rs, ChainRows)
    assert rs.navigation.ref is None
    assert rs.navigation.definition == _nav(PATH)


def test_scope_rows_with_ref_free_inline_column_is_returned_equivalently() -> None:
    """A ScopeRows table whose column navigation is already inline (no refs
    anywhere) comes back structurally identical — ref-free stays ref-free."""
    defn = _table(
        {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": [
                {
                    "kind": "navigation",
                    "source": {"kind": "row"},
                    "navigation": {"definition": PATH},
                }
            ],
        }
    )
    resolved = _resolve_table_navigation_refs(
        defn, fetch=lambda _id: (_ for _ in ()).throw(LookupError())
    )
    assert resolved == defn


def test_inline_definition_with_nested_operand_ref_is_also_inlined() -> None:
    """The critical case: an ALREADY-INLINE navigation definition can itself
    carry an operand ref (a set-expression operand), and that must be
    inlined too so the result is fully ref-free — this is what makes
    fingerprinting the resolved definition sound for cache invalidation."""
    nested = {"kind": "set_op", "op": "union", "operands": [{"ref": "a"}]}
    defn = _table(
        {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": [
                {
                    "kind": "navigation",
                    "source": {"kind": "row"},
                    "navigation": {"definition": nested},
                }
            ],
        }
    )
    resolved = _resolve_table_navigation_refs(
        defn, fetch={"a": _nav(PATH)}.__getitem__
    )
    col = resolved.columns[0]
    assert isinstance(col, NavigationColumn)
    nav_def = col.navigation.definition
    assert isinstance(nav_def, SetExpression)
    op = nav_def.operands[0]
    assert op.ref is None
    assert op.definition == _nav(PATH)
