"""The model half of ``POST /metamodel/diff``: the live model validated under a
candidate metamodel, diffed against the session's issue store.

The route reads the store and calls ``candidate_issues`` under
``session.write_mutex``, then ``model_half`` over what they returned, after the
mutex. They take no session, so the engine's candidate diff is checked against
them outside a request.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

from data_rover.core.model.model import build_rebind_view
from data_rover.core.validation.issue import Issue
from data_rover.core.validation.rules.compile import RuleSetSource, compile_rule_sets

from .rules import pipeline_for
from .schemas import IssueOut

if TYPE_CHECKING:
    from data_rover.core.metamodel.schema import Metamodel
    from data_rover.core.model.model import Model


def issue_key(issue: Issue) -> tuple[str, str, str, str, tuple[str, ...]]:
    """Stable identity for diffing two validation runs (Issue has no code).

    ``check`` is part of the key: two user rules can produce the same custom
    message on the same element, and without it one of them vanishes from the
    diff. Both sides are stamped by the same pipeline, so including it only
    ever splits keys, never merges distinct issues.
    """
    return (
        issue.category.value,
        issue.severity.value,
        issue.check,
        issue.message,
        tuple(sorted(issue.target_ids)),
    )


def candidate_issues(
    model: Model, candidate: Metamodel, sources: Sequence[RuleSetSource]
) -> list[Issue]:
    """Every issue of ``model`` under ``candidate``, with the rule ``sources``
    recompiled against it: a rule the candidate drifts reports nothing, so its
    current issues land in ``now_passing``. The model is read through a
    rebind view and never mutated."""
    return pipeline_for(compile_rule_sets(sources, candidate)).validate(
        build_rebind_view(model, candidate)
    )


def model_half(current: Sequence[Issue], candidate: Sequence[Issue]) -> dict[str, Any]:
    """The diff's model fields. A key keeps its first position and its last
    value on each side; ``now_failing`` is in candidate order, ``now_passing``
    in current order, and the two counts are the raw lengths."""
    cur_by_key = {issue_key(i): i for i in current}
    cand_by_key = {issue_key(i): i for i in candidate}
    return {
        "now_failing": [
            _render(v) for k, v in cand_by_key.items() if k not in cur_by_key
        ],
        "now_passing": [
            _render(v) for k, v in cur_by_key.items() if k not in cand_by_key
        ],
        "unchanged_count": len(cur_by_key.keys() & cand_by_key.keys()),
        "current_error_count": len(current),
        "candidate_error_count": len(candidate),
    }


def _render(issue: Issue) -> dict[str, Any]:
    return IssueOut.from_core(issue).model_dump(mode="json")
