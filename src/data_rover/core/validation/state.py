"""Incrementally maintained validation-issue store.

:class:`ValidationState` holds the full issue list of one model, keyed by
each issue's OWNER — the entity the issue is attributed to, i.e.
``issue.target_ids[0]`` (every pipeline validator puts the reported entity
first; secondary targets such as a duplicate group's primary are context).

The incremental loop is:

1. seed with one full run: :meth:`set_full`;
2. after a mutation, compute the dirty set (see :mod:`.dirty`), run a scoped
   validation over exactly those ids, and :meth:`replace` — issues owned by
   dirty ids are dropped wholesale and the scoped run's issues take their
   place. Deleted entities are in the dirty set, so their issues vanish.

Determinism: ``issues_by_owner`` keeps owner insertion order and per-owner
issue order, so :meth:`all_issues` is stable for a given operation history
(re-validated owners move to the end, which is itself deterministic).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

from .issue import Issue


def issue_owner(issue: Issue) -> str:
    """The entity an issue is attributed to: its first target id."""
    return issue.target_ids[0] if issue.target_ids else ""


@dataclass
class IssuesDelta:
    """What :meth:`ValidationState.replace` changed.

    ``removed_owner_ids`` lists the owners whose issues were dropped (only
    those that actually had issues), in the dirty set's iteration order;
    ``added`` lists the inserted issues in scoped-validation order.
    """

    removed_owner_ids: list[str]
    added: list[Issue]


@dataclass
class ValidationState:
    issues_by_owner: dict[str, list[Issue]] = field(default_factory=dict)

    def set_full(self, issues: list[Issue]) -> None:
        """Reset the store from a FULL validation run's issue list."""
        self.issues_by_owner = {}
        for issue in issues:
            self.issues_by_owner.setdefault(issue_owner(issue), []).append(issue)

    def replace(self, dirty: Iterable[str], new_issues: list[Issue]) -> IssuesDelta:
        """Drop all issues owned by ids in *dirty*, insert *new_issues*.

        *new_issues* must be the output of a scoped validation over exactly
        the *dirty* ids (every new issue's owner is then a dirty id, so the
        drop+insert is a true replacement). Pass an ordered *dirty*
        collection for a deterministic delta.
        """
        removed: list[str] = []
        for owner in dict.fromkeys(dirty):
            if self.issues_by_owner.pop(owner, None) is not None:
                removed.append(owner)
        for issue in new_issues:
            self.issues_by_owner.setdefault(issue_owner(issue), []).append(issue)
        return IssuesDelta(removed_owner_ids=removed, added=list(new_issues))

    def all_issues(self) -> list[Issue]:
        out: list[Issue] = []
        for issues in self.issues_by_owner.values():
            out.extend(issues)
        return out

    def counts(self) -> dict[str, int]:
        """Issue count per severity name (the wire value, e.g. ``"error"``)."""
        counts: dict[str, int] = {}
        for issues in self.issues_by_owner.values():
            for issue in issues:
                name = issue.severity.value
                counts[name] = counts.get(name, 0) + 1
        return counts
