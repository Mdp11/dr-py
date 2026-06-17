from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class Severity(Enum):
    ERROR = "error"
    WARNING = "warning"


class IssueCategory(Enum):
    """Commit-time validation tier (spec §9).

    STRUCTURAL — model-graph corruption (dangling reference, containment
    cycle, two parents). At commit these HARD-fail with 422: a well-behaved
    client never produces one (the mutation boundary + frontend prevent them).
    CONFORMANCE — schema-rule violations (endpoint typing, multiplicity,
    uniqueness, facets, scalar type). Counted and surfaced, never block a
    commit (the engine "stays inspectable"); a Phase 8 strict mode may later
    promote a configurable subset to hard rejects.
    """

    STRUCTURAL = "structural"
    CONFORMANCE = "conformance"


@dataclass
class Issue:
    severity: Severity
    message: str
    target_ids: list[str] = field(default_factory=list)
    #: commit-time tier; defaults to CONFORMANCE so only the few structural
    #: call sites (containment cycle/two-parents, dangling reference) opt in.
    category: IssueCategory = IssueCategory.CONFORMANCE
