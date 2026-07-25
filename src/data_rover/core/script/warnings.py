"""The embedded-evaluation warnings channel: structured, aggregated by KIND.

Table and navigation evaluation degrade rather than fail — a snippet that
raises prunes its chains, an unknown returned id is dropped — and this channel
is how the user is told. It is deliberately DATA, not prose: every entry is a
code plus counts, and the user-facing sentence is built client-side.

That split is the fix for the channel's original defect. It deduped on the
rendered message text while the navigation messages baked their counts INTO
that text, so ten chains each dropping one id emitted ten identical strings,
collapsed to a single line reading "1" — the user was told 1 when the truth
was 10 — and chains dropping 1, 2 and 5 fragmented into three near-identical
lines that also ate the cap. Aggregating by `(code, detail)` and carrying the
numbers separately makes both cases come out right, and leaves the copy in one
place (the client) instead of scattered across f-strings.

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
    NAV_UNKNOWN_IDS = "nav_unknown_ids"
    NAV_ALREADY_VISITED = "nav_already_visited"
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
    occurrences: int = 0
    total: int = 0
    detail: str | None = None


class ScriptWarningLog:
    """Insertion-ordered aggregate of `ScriptWarning`s, keyed by kind."""

    def __init__(self) -> None:
        self._by_key: dict[WarningKey, ScriptWarning] = {}

    @property
    def entries(self) -> list[ScriptWarning]:
        """The aggregate, in first-seen order.

        Returns a fresh list of new `ScriptWarning` instances on every call.
        Mutating returned instances does not affect the log; instances are
        frozen dataclasses.
        """
        return [replace(w) for w in self._by_key.values()]

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
        report. Overflow is far less likely than under the old text dedup:
        keys are now bounded by 5 codes times distinct details, and only
        `NAV_STEP_FAILED` / `NAV_SNIPPET_NOT_FOUND` carry unbounded details.
        """
        key = (code, detail)
        entry = self._by_key.get(key)
        if entry is None:
            if len(self._by_key) >= MAX_SCRIPT_WARNINGS:
                return
            self._by_key[key] = ScriptWarning(code=code, detail=detail, occurrences=1, total=count)
        else:
            self._by_key[key] = replace(
                entry,
                occurrences=entry.occurrences + 1,
                total=entry.total + count,
            )

    def snapshot(self) -> dict[WarningKey, tuple[int, int]]:
        """Freeze the current counts, for a later `since()`.

        Needed because entries mutate IN PLACE: `navigation.evaluate` used to
        slice `warnings[w0:]` to return only its own call's warnings, and an
        index slice cannot see growth in an entry that already existed.
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
