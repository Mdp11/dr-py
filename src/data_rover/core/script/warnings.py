"""The embedded-evaluation warnings channel: structured, aggregated by KIND.

Table and navigation evaluation degrade rather than fail — a snippet that
raises prunes its chains, a snippet reference that no longer resolves is
reported — and this channel is how the user is told. It is deliberately
DATA, not prose: every entry is a code plus counts, and the user-facing
sentence is built client-side.

Aggregating by `(code, detail)` and carrying the numbers separately (rather
than deduping on rendered message text with counts baked in) keeps counts
accurate when many calls hit the same kind, and leaves the copy in one place
(the client) instead of scattered across f-strings.

This module is deliberately a LEAF: it imports nothing from the rest of the
core, so `navigation` and `table` can import the codes at runtime with no risk
of an import cycle through `embed`.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from enum import StrEnum

#: Cap on DISTINCT KINDS held at once (see `ScriptWarningLog.add`).
MAX_SCRIPT_WARNINGS = 20


class ScriptWarningCode(StrEnum):
    """The closed set of degradations this channel reports.

    Values are the wire form. Adding a member is a client-compatible change:
    the frontend formatter falls back to the raw detail/code for a code it
    does not recognize, so an older client renders something readable rather
    than a blank strip.
    """

    NAV_SNIPPET_NOT_FOUND = "nav_snippet_not_found"
    NAV_STEP_FAILED = "nav_step_failed"
    #: Never emitted server-side today: a navigation script step DISPLAYS a
    #: returned value that names no element (see
    #: navigation/evaluate.py::_hop_script) rather than treating it as a
    #: failure. Kept in the vocabulary because the wire is open by design —
    #: a client must still format a code an older/other server sends.
    NAV_UNKNOWN_IDS = "nav_unknown_ids"
    SORT_NEEDS_SCRIPT_NAV = "sort_needs_script_nav"


#: Aggregation key. `detail` participates so two genuinely different failures
#: (two distinct exception messages) stay two distinct entries.
type WarningKey = tuple[ScriptWarningCode, str | None]


@dataclass(frozen=True)
class ScriptWarning:
    """One aggregated warning kind.

    `occurrences` counts how many times the kind fired; `total` sums the
    subject quantity it carries (ids returned unknown, elements dropped) and
    stays 0 for kinds that have no such quantity. Both are needed: "42 ids
    across 17 calls" and "42 ids in 1 call" are different stories.
    """

    code: ScriptWarningCode
    occurrences: int
    total: int = 0
    detail: str | None = None


class ScriptWarningLog:
    """Insertion-ordered aggregate of `ScriptWarning`s, keyed by kind."""

    def __init__(self) -> None:
        self._by_key: dict[WarningKey, ScriptWarning] = {}

    @property
    def entries(self) -> list[ScriptWarning]:
        """The aggregate, in first-seen order.

        A fresh list on every call, but the `ScriptWarning` instances inside
        it are shared with the log: since they are frozen, a caller has no
        way to corrupt the aggregate through them, so copying the instances
        too would buy nothing.
        """
        return list(self._by_key.values())

    def add(
        self,
        code: ScriptWarningCode,
        *,
        detail: str | None = None,
        count: int = 0,
    ) -> None:
        """Record ONE occurrence of `code` (optionally carrying `count`
        subjects).

        `MAX_SCRIPT_WARNINGS` caps distinct KINDS. Once full, a new kind is
        dropped but kinds already present keep counting — a cap that stopped
        counting would understate exactly the numbers this channel exists to
        report. Overflow is unlikely: keys are bounded by the 4 codes in
        `ScriptWarningCode` times distinct details, and only
        `NAV_STEP_FAILED` / `NAV_SNIPPET_NOT_FOUND` carry unbounded details.
        """
        key = (code, detail)
        entry = self._by_key.get(key)
        if entry is None:
            if len(self._by_key) >= MAX_SCRIPT_WARNINGS:
                return
            self._by_key[key] = ScriptWarning(
                code=code, detail=detail, occurrences=1, total=count
            )
        else:
            self._by_key[key] = replace(
                entry,
                occurrences=entry.occurrences + 1,
                total=entry.total + count,
            )

    def snapshot(self) -> dict[WarningKey, tuple[int, int]]:
        """Freeze the current counts, for a later `since()`.

        Needed because a repeat `add()` of an existing key keeps that entry's
        POSITION in `_by_key` (insertion order is by first occurrence, not
        last write): a positional slice of `entries` cannot see growth in an
        entry that already existed earlier in the order, so a per-call view
        needs a value snapshot instead.
        """
        return {k: (w.occurrences, w.total) for k, w in self._by_key.items()}

    def since(self, snap: dict[WarningKey, tuple[int, int]]) -> list[ScriptWarning]:
        """What was added since `snap`, as DELTA counts, in first-seen order."""
        out: list[ScriptWarning] = []
        for key, w in self._by_key.items():
            occ0, tot0 = snap.get(key, (0, 0))
            if w.occurrences > occ0:
                out.append(
                    ScriptWarning(
                        code=w.code,
                        occurrences=w.occurrences - occ0,
                        total=w.total - tot0,
                        detail=w.detail,
                    )
                )
        return out
