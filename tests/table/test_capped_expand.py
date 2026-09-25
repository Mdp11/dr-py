"""A build capped at `max_rows` inside an expand column: every later column
still runs over the capped keys, so every key carries every slot, the rows are
a prefix of the uncapped build's, and every consumer reads the row source's
slot count from the build rather than from a key's length."""

from functools import partial
from typing import Any, cast

import pytest
from sqlalchemy.orm import Session as DbSession

from data_rover.api import script_sweep
from data_rover.api.routes import tables as tables_route
from data_rover.api.routes.tables import evaluate_table
from data_rover.api.schemas import EvaluateTableIn
from data_rover.api.script_sweep import kick_or_join_sweep
from data_rover.api.session import Session
from data_rover.api.settings import Settings
from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model
from data_rover.core.table.evaluate import (
    SortSpec,
    TableLimits,
    build_rows_ex,
    order_rows,
)
from data_rover.core.table.schema import TABLE_ADAPTER, TableDefinition
from tests.api._script_fakes import CountingRunner


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Block",
                properties=[
                    PropertyDef(name="name", datatype="string"),
                    PropertyDef(name="tags", datatype="string", multiplicity="0..*"),
                    PropertyDef(name="codes", datatype="string", multiplicity="0..*"),
                ],
            )
        ],
        relationships=[
            RelationshipType(name="BlockHasPart", source="Block", target="Block")
        ],
    )


def _scope_model() -> tuple[Model, dict[str, str]]:
    """A, B, C: tags `<n>t1`, `<n>t2`; codes `<n>c1`."""
    model = Model(_mm())
    ids: dict[str, str] = {}
    for n in "ABC":
        el = model.create_element("Block")
        model.set_property(el, "name", n)
        model.set_property(el, "tags", [f"{n}t1", f"{n}t2"])
        model.set_property(el, "codes", [f"{n}c1"])
        ids[n] = el.id
    return model, ids


def _scope_defn(extra: list[dict[str, Any]] | None = None) -> TableDefinition:
    return TABLE_ADAPTER.validate_python(
        {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": [
                {"kind": "element", "source": {"kind": "row"}},
                {"kind": "property", "name": "tags", "mode": "expand"},
                {"kind": "property", "name": "codes", "mode": "expand"},
                *(extra or []),
            ],
        }
    )


def _chains_model() -> Model:
    """R owns P1 and P2; P1's tags are `P1t1`, `P1t2`; R's codes `Rc1`, `Rc2`."""
    model = Model(_mm())
    ids: dict[str, str] = {}
    for n in ("R", "P1", "P2"):
        el = model.create_element("Block")
        model.set_property(el, "name", n)
        ids[n] = el.id
    model.set_property(model.elements[ids["P1"]], "tags", ["P1t1", "P1t2"])
    model.set_property(model.elements[ids["P2"]], "tags", ["P2t1"])
    model.set_property(model.elements[ids["R"]], "codes", ["Rc1", "Rc2"])
    model.connect("BlockHasPart", ids["R"], ids["P1"])
    model.connect("BlockHasPart", ids["R"], ids["P2"])
    return model


def _chains_defn() -> TableDefinition:
    return TABLE_ADAPTER.validate_python(
        {
            "row_source": {
                "kind": "chains",
                "navigation": {
                    "definition": {
                        "kind": "path",
                        "start": {"kind": "scope", "types": ["Block"]},
                        "steps": [
                            {
                                "kind": "relationship",
                                "relationship_type": "BlockHasPart",
                                "direction": "out",
                            }
                        ],
                    }
                },
            },
            "columns": [
                {"kind": "element", "source": {"kind": "row", "chain_index": 0}},
                {"kind": "element", "source": {"kind": "row", "chain_index": 1}},
                {
                    "kind": "property",
                    "source": {"kind": "row", "chain_index": 1},
                    "name": "tags",
                    "mode": "expand",
                },
                {
                    "kind": "property",
                    "source": {"kind": "row", "chain_index": 0},
                    "name": "codes",
                    "mode": "expand",
                },
            ],
        }
    )


def _evaluate(
    model: Model, defn: TableDefinition, session: Session | None = None
) -> dict[str, Any]:
    page = evaluate_table(
        EvaluateTableIn(definition=defn, offset=0, limit=500),
        "p",
        session=session or Session(metamodel=model.metamodel, model=model),
        db=cast(DbSession, None),
        runner=None,
        settings=Settings(),
    )
    return page.model_dump(mode="json")


def _cap(monkeypatch: pytest.MonkeyPatch, module: object, max_rows: int) -> None:
    monkeypatch.setattr(module, "TableLimits", partial(TableLimits, max_rows=max_rows))


def test_capped_build_runs_every_column_and_is_a_prefix_of_the_uncapped_one():
    model, _ = _scope_model()
    mm = model.metamodel
    for defn in (
        _scope_defn(),
        _scope_defn([{"kind": "property", "name": "tags", "keep_empty": False}]),
    ):
        full = build_rows_ex(mm, model, defn)
        for cap in (1, 2, 3, 4, 5):
            capped = build_rows_ex(mm, model, defn, TableLimits(max_rows=cap))
            assert capped.truncated is True
            assert capped.base_slots == 1
            assert all(len(k) == 3 for k in capped.keys)
            assert capped.keys == full.keys[: len(capped.keys)]
            assert len(capped.keys) == cap


def test_capped_expand_page_holds_each_columns_own_values(
    monkeypatch: pytest.MonkeyPatch,
):
    # Cap 3 trips inside `tags` (A gives 2 rows, B's first makes 3): `codes`
    # still expands the capped keys, so every cell reads its own slot.
    model, ids = _scope_model()
    _cap(monkeypatch, tables_route, 3)
    page = _evaluate(model, _scope_defn())
    assert page["truncated"] is True
    assert page["total"] == 3
    names = {v: k for k, v in ids.items()}
    got = []
    for row in page["rows"]:
        element, tag, code = row["cells"]
        name = names[element["item"]["id"]]
        assert tag["kind"] == code["kind"] == "value"
        assert tag["value"].startswith(f"{name}t")
        assert code["value"] == f"{name}c1"
        got.append((name, tag["value"], code["value"]))
    assert got == [("A", "At1", "Ac1"), ("A", "At2", "Ac1"), ("B", "Bt1", "Bc1")]


def test_capped_chains_page_matches_the_uncapped_first_row(
    monkeypatch: pytest.MonkeyPatch,
):
    model = _chains_model()
    full = _evaluate(model, _chains_defn())
    assert full["truncated"] is False
    _cap(monkeypatch, tables_route, 1)
    capped = _evaluate(model, _chains_defn())
    assert capped["truncated"] is True
    assert capped["rows"] == full["rows"][:1]
    tag, code = capped["rows"][0]["cells"][2:]
    assert (tag["value"], code["value"]) == ("P1t1", "Rc1")


def test_a_cached_order_keeps_its_builds_slot_count(monkeypatch: pytest.MonkeyPatch):
    model = _chains_model()
    session = Session(metamodel=model.metamodel, model=model)
    _cap(monkeypatch, tables_route, 1)
    first = _evaluate(model, _chains_defn(), session)
    entry = next(iter(session.table_order_cache._d.values()))
    assert entry[-1] == 2  # the chain length, not the key length
    assert _evaluate(model, _chains_defn(), session) == first


def test_sorting_the_second_expand_column_under_the_cap():
    model, _ = _scope_model()
    mm = model.metamodel
    defn = _scope_defn()
    built = build_rows_ex(mm, model, defn, TableLimits(max_rows=3))
    ordered = order_rows(
        mm,
        model,
        defn,
        built.keys,
        [SortSpec(column=2, direction="desc")],
        base_slots=built.base_slots,
    )
    assert [k[1:] for k in ordered] == [("Bt1", "Bc1"), ("At1", "Ac1"), ("At2", "Ac1")]


def test_script_sweep_cell_pass_under_the_cap(monkeypatch: pytest.MonkeyPatch):
    model, _ = _scope_model()
    defn = _scope_defn(
        [
            {
                "kind": "script",
                "source": {"kind": "row"},
                "snippet": {"definition": {"code": "def value(els): return len(els)"}},
            }
        ]
    )
    _cap(monkeypatch, script_sweep, 3)
    runner = CountingRunner()
    job = kick_or_join_sweep(
        Session(metamodel=model.metamodel, model=model),
        model.metamodel,
        model,
        defn,
        runner,
        Settings(snippet_sweep_sync=True, snippet_sweep_workers=1),
        0,
    )
    assert job.state == "done", job.message
    assert job.done == job.total == 3
    assert runner.calls == 2  # rows over A share one binding
