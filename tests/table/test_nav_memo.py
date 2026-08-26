"""`NavMemo` is a per-pass, bounded LRU of navigation results. These tests pin
the contract the evaluator leans on: hit/miss by key, LRU eviction at
`max_entries`, immutable stored chains, and the script-bearing bypass."""

from data_rover.core.navigation.evaluate import PropertyValue
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
