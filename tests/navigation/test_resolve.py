"""resolve_refs inlines Operand.ref via an injected fetch callable; a ref
chain that revisits an artifact id is a cycle (RefCycleError), an unknown id
is RefNotFoundError. The evaluator never sees a ref."""

import pytest

from data_rover.core.navigation.resolve import (
    RefCycleError,
    RefNotFoundError,
    resolve_refs,
)
from data_rover.core.navigation.schema import (
    NAVIGATION_ADAPTER,
    PathNavigation,
    SetExpression,
)


def _nav(doc: dict):
    return NAVIGATION_ADAPTER.validate_python(doc)


PATH = {"kind": "path", "start": {"kind": "scope", "types": ["Block"]},
        "steps": [{"relationship_type": "Owns"}]}


def test_path_without_refs_is_returned_as_is() -> None:
    nav = _nav(PATH)
    assert resolve_refs(nav, fetch=lambda _id: (_ for _ in ()).throw(LookupError())) == nav


def test_ref_operand_is_inlined() -> None:
    expr = _nav({"kind": "set_op", "op": "union",
                 "operands": [{"ref": "a", "step_index": 0}]})
    resolved = resolve_refs(expr, fetch={"a": _nav(PATH)}.__getitem__)
    assert isinstance(resolved, SetExpression)
    op = resolved.operands[0]
    assert op.ref is None
    assert isinstance(op.definition, PathNavigation)
    assert op.step_index == 0  # preserved through inlining


def test_nested_refs_resolve_through_set_expression_start() -> None:
    doc = dict(PATH)
    doc["start"] = {"kind": "set_op", "op": "union", "operands": [{"ref": "a"}]}
    resolved = resolve_refs(_nav(doc), fetch={"a": _nav(PATH)}.__getitem__)
    assert isinstance(resolved, PathNavigation)
    assert isinstance(resolved.start, SetExpression)
    assert isinstance(resolved.start.operands[0].definition, PathNavigation)


def test_unknown_ref_raises() -> None:
    expr = _nav({"kind": "set_op", "op": "union", "operands": [{"ref": "ghost"}]})
    with pytest.raises(RefNotFoundError) as exc:
        resolve_refs(expr, fetch={}.__getitem__)
    assert exc.value.artifact_id == "ghost"


def test_ref_cycle_raises() -> None:
    # a -> b -> a
    a = _nav({"kind": "set_op", "op": "union", "operands": [{"ref": "b"}]})
    b = _nav({"kind": "set_op", "op": "union", "operands": [{"ref": "a"}]})
    with pytest.raises(RefCycleError) as exc:
        resolve_refs(a, fetch={"a": a, "b": b}.__getitem__)
    assert exc.value.artifact_id in {"a", "b"}


def test_self_cycle_raises() -> None:
    a = _nav({"kind": "set_op", "op": "union", "operands": [{"ref": "a"}]})
    with pytest.raises(RefCycleError):
        resolve_refs(a, fetch={"a": a}.__getitem__)
