"""Native evaluation of compiled declarative rules as a pipeline validator."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, assert_never

from ..issue import Issue, IssueCategory, Severity
from ..pipeline import EntityValidator
from .compile import CompiledRule, CompiledRules
from .schema import (
    AllCond,
    AnyCond,
    Condition,
    CountSpec,
    NotCond,
    PropertyCond,
    RelationshipCond,
    RelationshipSpec,
)

if TYPE_CHECKING:
    from ...model.element import Element
    from ...model.model import Model

logger = logging.getLogger(__name__)

_SEVERITY = {"error": Severity.ERROR, "warning": Severity.WARNING}


def _eq(a: Any, b: Any) -> bool:
    """Pinned equality: plain Python == (so "3" != 3 falls out naturally),
    with a bool/int guard because bool subclasses int (True must not equal 1)."""
    if isinstance(a, bool) is not isinstance(b, bool):
        return False
    return a == b


def _test_scalar(cond: PropertyCond, value: Any) -> bool:
    """One stored scalar against the atom's single test. Type-mismatched
    comparisons are False, never an error (the engine stays inspectable)."""
    fields = cond.model_fields_set
    if "equals" in fields:
        return _eq(value, cond.equals)
    if "not_equals" in fields:
        return not _eq(value, cond.not_equals)
    if "in_" in fields:
        return any(_eq(value, v) for v in cond.in_ or [])
    if "contains" in fields:
        return (
            isinstance(value, str)
            and isinstance(cond.contains, str)
            and cond.contains in value
        )
    # numeric comparisons; bool is an int subclass we deliberately exclude
    bound = (
        cond.gt
        if "gt" in fields
        else cond.gte
        if "gte" in fields
        else cond.lt
        if "lt" in fields
        else cond.lte
    )
    if not isinstance(value, int | float) or isinstance(value, bool):
        return False
    assert bound is not None
    if "gt" in fields:
        return value > bound
    if "gte" in fields:
        return value >= bound
    if "lt" in fields:
        return value < bound
    return value <= bound


def _eval_property(el: Element, cond: PropertyCond) -> bool:
    value = el.properties.get(cond.property)
    present = value is not None and value != []
    if "exists" in cond.model_fields_set:
        return present is cond.exists
    if not present:
        return False  # missing fails every non-exists test (not_equals included)
    if isinstance(value, list):
        if "contains" in cond.model_fields_set:
            # list value: whole-value membership, the one list-operand test
            return any(_eq(v, cond.contains) for v in value)
        return any(_test_scalar(cond, v) for v in value)
    return _test_scalar(cond, value)


def _count_ok(spec: CountSpec, n: int) -> bool:
    return (
        (spec.eq is None or n == spec.eq)
        and (spec.gte is None or n >= spec.gte)
        and (spec.lte is None or n <= spec.lte)
    )


def _eval_relationship(model: Model, el: Element, spec: RelationshipSpec) -> bool:
    mm = model.metamodel
    rel_types = mm.relationship_descendants(spec.type)
    far_types = None if spec.to is None else mm.element_descendants(spec.to)
    outgoing = spec.direction == "outgoing"
    rel_ids = (
        model.indexes.outgoing_ids(el.id)
        if outgoing
        else model.indexes.incoming_ids(el.id)
    )
    n = 0
    for rid in rel_ids:
        rel = model.relationships[rid]
        if rel.type_name not in rel_types:
            continue
        if far_types is not None or spec.where is not None:
            far_id = rel.target_id if outgoing else rel.source_id
            far = model.elements.get(far_id)
            if far is None:
                continue  # dangling far endpoint: non-matching, never an error
            if far_types is not None and far.type_name not in far_types:
                continue
            if spec.where is not None and not evaluate_condition(
                model, far, spec.where
            ):
                continue
        n += 1
    if spec.exists is not None:
        return (n > 0) is spec.exists
    assert spec.count is not None
    return _count_ok(spec.count, n)


def evaluate_condition(model: Model, el: Element, cond: Condition) -> bool:
    match cond:
        case AllCond(all=subs):
            return all(evaluate_condition(model, el, c) for c in subs)
        case AnyCond(any=subs):
            return any(evaluate_condition(model, el, c) for c in subs)
        case NotCond(not_=sub):
            return not evaluate_condition(model, el, sub)
        case PropertyCond():
            return _eval_property(el, cond)
        case RelationshipCond(relationship=spec):
            return _eval_relationship(model, el, spec)
        case _:
            assert_never(cond)


def _issue_for(cr: CompiledRule, el: Element) -> Issue:
    rule = cr.rule
    message = rule.message or (
        f"Rule '{rule.name}' violated"
        + (f": {rule.description}" if rule.description else "")
    )
    return Issue(
        severity=_SEVERITY[rule.severity],
        message=message,
        target_ids=[el.id],
        category=IssueCategory.CONFORMANCE,
        check=cr.check,
    )


class RulesValidator(EntityValidator):
    """Evaluates user-defined rules; degraded-not-failed on any surprise."""

    check_name = ""  # per-issue checks are stamped at construction

    def __init__(self, compiled: CompiledRules) -> None:
        self._compiled = compiled

    def validate_element(self, model: Model, el: Element) -> list[Issue]:
        rules = self._compiled.rules_by_type.get(el.type_name)
        if not rules:
            return []
        issues: list[Issue] = []
        for cr in rules:
            try:
                if cr.rule.when is not None and not evaluate_condition(
                    model, el, cr.rule.when
                ):
                    continue
                if not evaluate_condition(model, el, cr.rule.then):
                    issues.append(_issue_for(cr, el))
            except Exception:
                # a user rule must never break validation: count and move on
                self._compiled.eval_errors[cr.check] += 1
                logger.warning(
                    "rule %s failed to evaluate on element %s",
                    cr.check,
                    el.id,
                    exc_info=True,
                )
        return issues
