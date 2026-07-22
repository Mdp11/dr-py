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
        "    return sum(1 for _ in dr.elements(stereotypes='Building'))\n",
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
        "_index = {e.id: e.name for e in dr.elements(stereotypes='Building')}\n"
        "def value(els):\n"
        "    return _index[els[0].id]\n",
        ["b2"],
    )
    assert res.reads is not None
    assert ("scan", "Building") in res.reads  # boot-time scan
    assert ("el", "b2") in res.reads


def test_parent_on_non_root_reads_parent_element() -> None:
    # Every other test binds "b1" (a containment root), so `parent()`'s
    # delegation to `_fetch_element` (which itself records ("el", parent_id))
    # is never exercised. `tiny_model()` connects "Owns" b1 -> b2, so b2 is
    # the non-root case: `parent()` on it must record its own read AND the
    # fetched parent element's read.
    res = _call(
        "def value(els):\n"
        "    p = els[0].parent()\n"
        "    return p.name if p is not None else None\n",
        ["b2"],
    )
    assert res.reads == frozenset(
        {("el", "b2"), ("parent", "b2"), ("el", "b1")}
    )


def test_error_call_has_no_reads() -> None:
    # NOTE: this only pins the dataclass default (`CallResult.reads=None`),
    # not a real "facade shipped a bogus read-set on the error path" case --
    # there is no such case to construct. `_dr_call_entry` has no `except`
    # around the snippet call: an exception propagates straight out before
    # `return {"payload": ..., "reads": ...}` is ever reached, so
    # `_TrustedSession.call`'s `except Exception:` branch builds this
    # `CallResult` without ever seeing a `res` dict to read `"reads"` from
    # (bogus or otherwise) -- there is no path in the facade that raises
    # a snippet error and ALSO packages a reads value the host could
    # mistakenly trust. Left as-is; see the comment above for why
    # strengthening it further isn't meaningfully possible.
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


def test_boot_overflow_reports_none() -> None:
    # _READS_CAP overflow is otherwise untested. Flip the boot-overflow flag
    # directly via the trusted host's namespace (cheaper than actually
    # accumulating 2000+ distinct reads) and confirm the call degrades to
    # reads=None, the conservative "depends on everything" signal.
    model = tiny_model()
    runner = TrustedRunner()
    sess = runner.open_session(
        model,
        "def value(els):\n    return els[0].name\n",
        RunLimits(),
        budget=ScriptBudget.start(60),
    )
    assert sess.boot_error is None
    sess._namespace["_boot_overflow"][0] = True  # type: ignore[attr-defined]
    res = sess.call("value", ["b1"])
    assert res.error is None
    assert res.reads is None


def test_call_overflow_reports_none() -> None:
    # Same idea as test_boot_overflow_reports_none, but for the per-call
    # overflow flag: _call_overflow is reset to False at the top of every
    # `_dr_call_entry` call, so it can't be pre-set from outside like
    # _boot_overflow can. Instead, shrink the facade's own _READS_CAP to 0
    # in the guest namespace so the very first `_note_read` this call makes
    # (recording the bound root's own "el" read, before the snippet body
    # even runs) trips the per-call overflow path.
    model = tiny_model()
    runner = TrustedRunner()
    sess = runner.open_session(
        model,
        "def value(els):\n    return els[0].name\n",
        RunLimits(),
        budget=ScriptBudget.start(60),
    )
    assert sess.boot_error is None
    sess._namespace["_READS_CAP"] = 0  # type: ignore[attr-defined]
    res = sess.call("value", ["b1"])
    assert res.error is None
    assert res.reads is None


def test_mixed_typed_and_untyped_scan_does_not_crash_the_call() -> None:
    # Regression: sorting the merged read-set must never compare a scan's
    # None (untyped) second element against another scan's type-name string
    # -- that raised TypeError and turned a legitimate call into an error.
    res = _call(
        "def value(els):\n"
        "    a = sum(1 for _ in dr.elements(stereotypes='Building'))\n"
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


def test_list_stereotype_scan_records_the_name_not_the_list() -> None:
    # A list-valued filter must still record a per-NAME tag: the tag ident is
    # the string "Building", never the list itself (which is unhashable and
    # would not match anything `invalidation.touched_keys` emits).
    res = _call(
        "def value(els):\n"
        "    return len(list(dr.elements(stereotypes=['Building'])))\n",
        ["b1"],
    )
    assert res.reads == frozenset({("el", "b1"), ("scan", "Building")})


def test_multi_stereotype_scan_records_one_tag_per_name() -> None:
    # One ("scan", name) tag per REQUESTED name — including a name the
    # metamodel does not know (it is still a dependency: creating an element
    # of that stereotype later would change the scan's answer).
    res = _call(
        "def value(els):\n"
        "    return len(list(dr.elements(stereotypes=['Building', 'Ghost'])))\n",
        ["b1"],
    )
    assert res.reads == frozenset(
        {("el", "b1"), ("scan", "Building"), ("scan", "Ghost")}
    )
