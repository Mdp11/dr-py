"""Read-set attribution tests (Phase B): every read a call USES — including
memo hits and piggyback-primed projections — lands in `CallResult.reads`."""

from __future__ import annotations

from data_rover.core.script.runner import (
    RunLimits,
    ScriptBudget,
    decode_reads,
)

from tests.script.conftest import tiny_model
from tests.script.trusted_runner import TrustedRunner


def _call(code: str, ids: list[str], *, calls: int = 1):
    model = tiny_model()
    runner = TrustedRunner()
    sess = runner.open_session(model, code, RunLimits(), budget=ScriptBudget.start(60))
    assert sess.boot_error is None, sess.boot_error
    res = None
    for _ in range(calls):
        res = sess.call("value", ids)
    assert res is not None and res.error is None, res and res.error
    return res


def test_root_read_recorded_despite_piggyback() -> None:
    res = _call("def value(els):\n    return els[0].name\n", ["b1"])
    assert res.reads == frozenset({("el", "b1")})


def test_traversal_reads_recorded() -> None:
    res = _call(
        "def value(els):\n"
        "    n = els[0].name\n"
        "    for rel in els[0].out():\n"
        "        n += dr.element(rel['target_id']).name\n"
        "    els[0].children()\n"
        "    els[0].parent()\n"
        "    return n\n",
        ["b1"],
    )
    assert res.reads == frozenset(
        {
            ("el", "b1"),
            ("out", "b1"),
            ("children", "b1"),
            ("parent", "b1"),
            ("el", "b2"),
        }
    )


def test_memo_hit_charged_to_reusing_call() -> None:
    # Second call reuses the memoized b2 fetch; its read-set must still
    # contain ("el", "b2") even though no bridge trip happened.
    model = tiny_model()
    runner = TrustedRunner()
    sess = runner.open_session(
        model,
        "def value(els):\n    return dr.element('b2').name\n",
        RunLimits(),
        budget=ScriptBudget.start(60),
    )
    assert sess.boot_error is None
    first = sess.call("value", ["b1"])
    second = sess.call("value", ["b3"])
    assert first.reads == frozenset({("el", "b1"), ("el", "b2")})
    assert second.reads == frozenset({("el", "b3"), ("el", "b2")})


def test_scan_read_recorded() -> None:
    res = _call(
        "def value(els):\n"
        "    return sum(1 for _ in dr.elements(type='Building'))\n",
        ["b1"],
    )
    assert res.reads == frozenset({("el", "b1"), ("scan", "Building")})


def test_untyped_scan_records_none_key() -> None:
    res = _call(
        "def value(els):\n    return sum(1 for _ in dr.elements())\n", ["b1"]
    )
    assert res.reads == frozenset({("el", "b1"), ("scan", None)})


def test_boot_reads_charged_to_every_call() -> None:
    res = _call(
        "_index = {e.id: e.name for e in dr.elements(type='Building')}\n"
        "def value(els):\n"
        "    return _index[els[0].id]\n",
        ["b2"],
    )
    assert res.reads is not None
    assert ("scan", "Building") in res.reads  # boot-time scan
    assert ("el", "b2") in res.reads


def test_error_call_has_no_reads() -> None:
    model = tiny_model()
    runner = TrustedRunner()
    sess = runner.open_session(
        model,
        "def value(els):\n    raise RuntimeError('boom')\n",
        RunLimits(),
        budget=ScriptBudget.start(60),
    )
    res = sess.call("value", ["b1"])
    assert res.error is not None
    assert res.reads is None


def test_mixed_typed_and_untyped_scan_does_not_crash_the_call() -> None:
    # Regression: sorting the merged read-set must never compare a scan's
    # None (untyped) second element against another scan's type-name string
    # -- that raised TypeError and turned a legitimate call into an error.
    res = _call(
        "def value(els):\n"
        "    a = sum(1 for _ in dr.elements(type='Building'))\n"
        "    b = sum(1 for _ in dr.elements())\n"
        "    return a + b\n",
        ["b1"],
    )
    assert res.reads == frozenset(
        {("el", "b1"), ("scan", "Building"), ("scan", None)}
    )


def test_decode_reads_accepts_and_rejects() -> None:
    ok = decode_reads([["el", "b1"], ["scan", None]])
    assert ok == frozenset({("el", "b1"), ("scan", None)})
    assert decode_reads(None) is None
    assert decode_reads("nope") is None
    assert decode_reads([["el"]]) is None  # wrong arity
    assert decode_reads([["el", 7]]) is None  # non-str id
    assert decode_reads([[7, "x"]]) is None  # non-str tag
    assert decode_reads([["x" * 33, "b1"]]) is None  # tag too long
    assert decode_reads([["el", "x" * 513]]) is None  # id too long
    assert decode_reads([["el", str(i)] for i in range(2001)]) is None  # cap
