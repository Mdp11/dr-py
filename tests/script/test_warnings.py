"""The warnings channel aggregates by KIND, not by rendered text.

The bug these tests pin: the old channel deduped on the exact message string
while three of the four navigation warnings baked their count INTO that
string, so ten chains each dropping one id collapsed to a single line reading
"1". Every count assertion below is that bug, stated as an expectation.
"""

from data_rover.core.script.warnings import (
    MAX_SCRIPT_WARNINGS,
    ScriptWarning,
    ScriptWarningCode,
    ScriptWarningLog,
)


def test_repeated_kind_aggregates_occurrences_and_total() -> None:
    log = ScriptWarningLog()
    for _ in range(10):
        log.add(ScriptWarningCode.NAV_UNKNOWN_IDS, count=1)
    assert log.entries == [
        ScriptWarning(code=ScriptWarningCode.NAV_UNKNOWN_IDS, occurrences=10, total=10)
    ]


def test_differing_counts_sum_into_one_entry() -> None:
    # Previously these were THREE near-identical lines saying 1, 2 and 5.
    log = ScriptWarningLog()
    for n in (1, 2, 5):
        log.add(ScriptWarningCode.NAV_ALREADY_VISITED, count=n)
    (entry,) = log.entries
    assert (entry.occurrences, entry.total) == (3, 8)


def test_distinct_details_stay_distinct_entries() -> None:
    log = ScriptWarningLog()
    log.add(ScriptWarningCode.NAV_STEP_FAILED, detail="boom")
    log.add(ScriptWarningCode.NAV_STEP_FAILED, detail="boom")
    log.add(ScriptWarningCode.NAV_STEP_FAILED, detail="kaboom")
    assert [(e.detail, e.occurrences) for e in log.entries] == [("boom", 2), ("kaboom", 1)]


def test_entries_are_in_first_seen_order() -> None:
    log = ScriptWarningLog()
    log.add(ScriptWarningCode.SORT_NEEDS_SCRIPT_NAV)
    log.add(ScriptWarningCode.NAV_UNKNOWN_IDS, count=3)
    log.add(ScriptWarningCode.SORT_NEEDS_SCRIPT_NAV)
    assert [e.code for e in log.entries] == [
        ScriptWarningCode.SORT_NEEDS_SCRIPT_NAV,
        ScriptWarningCode.NAV_UNKNOWN_IDS,
    ]


def test_cap_drops_new_kinds_but_keeps_counting_known_ones() -> None:
    # The old cap stopped recording entirely, which understated the very
    # numbers this channel exists to report.
    log = ScriptWarningLog()
    for i in range(MAX_SCRIPT_WARNINGS):
        log.add(ScriptWarningCode.NAV_STEP_FAILED, detail=f"err-{i}")
    log.add(ScriptWarningCode.NAV_STEP_FAILED, detail="overflow")
    log.add(ScriptWarningCode.NAV_STEP_FAILED, detail="err-0")
    assert len(log.entries) == MAX_SCRIPT_WARNINGS
    assert all(e.detail != "overflow" for e in log.entries)
    assert log.entries[0].occurrences == 2


def test_since_returns_deltas_not_absolutes() -> None:
    log = ScriptWarningLog()
    log.add(ScriptWarningCode.NAV_UNKNOWN_IDS, count=4)
    snap = log.snapshot()
    log.add(ScriptWarningCode.NAV_UNKNOWN_IDS, count=3)
    log.add(ScriptWarningCode.NAV_ALREADY_VISITED, count=1)
    assert log.since(snap) == [
        ScriptWarning(code=ScriptWarningCode.NAV_UNKNOWN_IDS, occurrences=1, total=3),
        ScriptWarning(code=ScriptWarningCode.NAV_ALREADY_VISITED, occurrences=1, total=1),
    ]


def test_since_an_empty_snapshot_is_everything() -> None:
    log = ScriptWarningLog()
    snap = log.snapshot()
    log.add(ScriptWarningCode.NAV_SNIPPET_NOT_FOUND, detail="missing")
    assert log.since(snap) == log.entries


def test_since_omits_untouched_kinds() -> None:
    log = ScriptWarningLog()
    log.add(ScriptWarningCode.NAV_UNKNOWN_IDS, count=2)
    snap = log.snapshot()
    assert log.since(snap) == []


def test_code_is_a_plain_string_on_the_wire() -> None:
    # Serialized straight into JSON by the API layer.
    assert ScriptWarningCode.NAV_UNKNOWN_IDS == "nav_unknown_ids"


def test_entries_copies_are_independent() -> None:
    # Mutating what entries() returns must not corrupt the log. entries()
    # returns a fresh LIST each call; the ScriptWarning instances inside it
    # may be shared with the log because they are frozen, so identity
    # equality on the elements is not the guarantee to pin here — only that
    # nothing can be mutated through them.
    log = ScriptWarningLog()
    log.add(ScriptWarningCode.NAV_UNKNOWN_IDS, count=5)
    entries1 = log.entries
    entries2 = log.entries
    assert entries1 is not entries2  # Different list objects
    assert entries1[0] == entries2[0]  # Same data
    # Verify instances are frozen (cannot be mutated)
    import pytest
    with pytest.raises(AttributeError):
        entries1[0].occurrences = 0  # type: ignore[misc]
