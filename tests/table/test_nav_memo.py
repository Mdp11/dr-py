"""`NavMemo` is a per-pass, bounded LRU of navigation results. These tests pin
the contract the evaluator leans on: hit/miss by key, LRU eviction at
`max_entries`, immutable stored chains, and the script-bearing bypass."""

import data_rover.core.table.evaluate as ev
from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model
from data_rover.core.navigation.evaluate import PropertyValue
from data_rover.core.table.evaluate import SortSpec, build_rows_ex, order_rows
from data_rover.core.table.nav_memo import MemoEntry, NavMemo
from data_rover.core.table.schema import TABLE_ADAPTER, NavigationColumn


def _entry(*ids: str) -> MemoEntry:
    return MemoEntry(chains=tuple((i,) for i in ids), truncated=False)


def test_get_miss_then_hit():
    memo = NavMemo()
    key = (1, ("root",))
    assert memo.get(key) is None
    memo.put(key, _entry("a", "b"))
    hit = memo.get(key)
    assert hit is not None
    assert hit.chains == (("a",), ("b",))
    assert hit.truncated is False
    assert len(memo) == 1


def test_lru_evicts_least_recently_used_at_cap():
    memo = NavMemo(max_entries=2)
    memo.put((1, ("a",)), _entry("x"))
    memo.put((1, ("b",)), _entry("y"))
    assert memo.get((1, ("a",))) is not None  # touch a -> b is now LRU
    memo.put((1, ("c",)), _entry("z"))  # over cap: evicts b
    assert len(memo) == 2
    assert memo.get((1, ("b",))) is None
    assert memo.get((1, ("a",))) is not None
    assert memo.get((1, ("c",))) is not None


def test_entry_is_frozen_and_chains_are_tuples():
    import dataclasses

    import pytest

    e = MemoEntry(chains=(("a", PropertyValue("v")),), truncated=True)
    assert isinstance(e.chains, tuple)
    assert all(isinstance(c, tuple) for c in e.chains)
    with pytest.raises(dataclasses.FrozenInstanceError):
        e.truncated = False  # type: ignore[misc]


def _nav_column(steps: list[dict]) -> NavigationColumn:
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [{
            "kind": "navigation", "source": {"kind": "row"},
            "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                "steps": steps}},
        }],
    })
    col = defn.columns[0]
    assert isinstance(col, NavigationColumn)
    return col


def test_scripted_true_for_script_step_false_otherwise():
    memo = NavMemo()
    plain = _nav_column([
        {"kind": "relationship", "relationship_type": "BlockHasPart", "direction": "out"},
    ])
    scripted = _nav_column([
        {"kind": "relationship", "relationship_type": "BlockHasPart", "direction": "out"},
        {"kind": "script", "snippet": {"definition": {
            "code": "def step(el):\n    return el\n"}}},
    ])
    unconfigured = _nav_column([
        {"kind": "script", "snippet": {}},
    ])
    assert memo.scripted(plain) is False
    assert memo.scripted(scripted) is True
    # An EMPTY snippet never invokes a guest, so it is safe to memoize.
    assert memo.scripted(unconfigured) is False
    # Answer is memoized per column identity: same object, same answer.
    assert memo.scripted(scripted) is True


# --- pass-level behavior: the evaluator calls `evaluate()` once per root ---

N_ROOTS, FAN = 3, 4


def _mm() -> Metamodel:
    return Metamodel(
        elements=[ElementType(name="Block", properties=[
            PropertyDef(name="name", datatype="string"),
            PropertyDef(name="mass", datatype="integer", multiplicity="0..1"),
        ])],
        relationships=[RelationshipType(name="BlockHasPart", source="Block", target="Block")],
    )


def _split_model(mm: Metamodel) -> tuple[Model, list[str], dict[str, str]]:
    """N_ROOTS roots, each owning FAN parts, each part owning one leaf.
    Part names are chosen so that sorting by part name INTERLEAVES roots.
    Returns `(model, root ids, leaf id -> its part id)`."""
    model = Model(mm)
    roots: list[str] = []
    parent_of: dict[str, str] = {}
    for r in range(N_ROOTS):
        root = model.create_element("Block")
        model.set_property(root, "name", f"Root{r}")
        roots.append(root.id)
        for p in range(FAN):
            part = model.create_element("Block")
            model.set_property(part, "name", f"P{p}-{r}")
            model.set_property(part, "mass", p * 10 + r)
            leaf = model.create_element("Block")
            model.set_property(leaf, "name", f"L{p}-{r}")
            model.connect("BlockHasPart", root.id, part.id)
            model.connect("BlockHasPart", part.id, leaf.id)
            parent_of[leaf.id] = part.id
    return model, roots, parent_of


def _step_ref_table(second_step: dict | None = None):
    steps = [
        {"kind": "relationship", "relationship_type": "BlockHasPart", "direction": "out"},
        second_step or {"kind": "relationship", "relationship_type": "BlockHasPart",
                        "direction": "out"},
    ]
    return TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "navigation", "source": {"kind": "row"}, "mode": "expand",
             "keep_empty": False,
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": steps}}},
            {"kind": "property", "source": {"kind": "column", "index": 0, "step_index": 1},
             "name": "name"},
        ],
    })


def _count_evaluate(monkeypatch) -> list[int]:
    calls: list[int] = []
    real = ev.evaluate

    def counting(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(ev, "evaluate", counting)
    return calls


def test_sort_by_step_ref_navigates_once_per_root(monkeypatch):
    mm = _mm()
    model, _, parent_of = _split_model(mm)
    defn = _step_ref_table()
    calls = _count_evaluate(monkeypatch)
    built = build_rows_ex(mm, model, defn)
    # Rows: every Block is in scope; only the N_ROOTS roots reach 2 hops
    # (keep_empty=False drops the rest). One evaluate per scope element.
    assert len(built.keys) == N_ROOTS * FAN
    calls.clear()
    ordered = order_rows(mm, model, defn, built.keys, SortSpec(column=1, direction="asc"))
    assert len(calls) == N_ROOTS  # was N_ROOTS * FAN before the memo
    # Correctness: rows come out sorted by the step-1 part name, interleaving roots.
    names = []
    for key in ordered:
        leaf = key[1]
        assert isinstance(leaf, str)
        names.append(model.elements[parent_of[leaf]].properties["name"])
    assert names == sorted(names)
    assert names[:N_ROOTS] == [f"P0-{r}" for r in range(N_ROOTS)]


def test_sort_by_step_ref_over_value_terminal_navigates_once_per_root(monkeypatch):
    mm = _mm()
    model, _, _ = _split_model(mm)
    defn = _step_ref_table({"kind": "property", "property_name": "mass"})
    built = build_rows_ex(mm, model, defn)
    calls = _count_evaluate(monkeypatch)
    order_rows(mm, model, defn, built.keys, SortSpec(column=1, direction="desc"))
    assert len(calls) == N_ROOTS


def test_script_navigation_bypasses_memo(monkeypatch):
    # A ScriptStep navigation is NEVER memoized: with `script=None` the step
    # prunes silently, but the bypass must still route every row through
    # `evaluate()` so per-call side effects are never skipped.
    mm = _mm()
    model, _, _ = _split_model(mm)
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "navigation", "source": {"kind": "row"}, "mode": "collapse",
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": [
                     {"kind": "relationship", "relationship_type": "BlockHasPart",
                      "direction": "out"},
                     {"kind": "script", "snippet": {"definition": {
                         "code": "def step(el):\n    return el\n"}}},
                 ]}}},
        ],
    })
    built = build_rows_ex(mm, model, defn)
    calls = _count_evaluate(monkeypatch)
    order_rows(mm, model, defn, built.keys, SortSpec(column=0, direction="asc"))
    assert len(calls) == len(built.keys)


def test_public_passes_take_no_memo_parameter():
    # The memo is created INSIDE each pass; letting a caller hand one in is
    # exactly how a cache-only result could reach the live window pass.
    import inspect

    from data_rover.core.table.cells import evaluate_cells
    from data_rover.core.table.evaluate import build_rows, iter_export_rows

    for fn in (build_rows, build_rows_ex, order_rows, evaluate_cells, iter_export_rows):
        assert "memo" not in inspect.signature(fn).parameters, fn.__name__
