"""RulesValidator: issue shape, guard behavior, dispatch, error tolerance."""

import logging

from data_rover.core.validation.issue import IssueCategory, Severity
from data_rover.core.validation.pipeline import ValidationPipeline
from data_rover.core.validation.rules.compile import RuleSetSource, compile_rule_sets
from data_rover.core.validation.rules.validator import RulesValidator
from data_rover.core.validation.scope import Scope

from .test_eval import _mm  # shared fixture metamodel
from data_rover.core.model.model import Model

DOC = """
rules:
  - name: zoned
    applies_to: Building
    severity: warning
    when: {property: critical, equals: true}
    then:
      relationship: {type: Owns, direction: outgoing, to: Zone, exists: true}
    message: critical buildings need a zone
"""


def _compiled(model):
    return compile_rule_sets([RuleSetSource("a1", "s", DOC)], model.metamodel)


def test_guard_gates_and_issue_shape():
    model = Model(_mm())
    model.create_element("Building")  # when fails -> no issue
    hot = model.create_element("Building")
    model.set_property(hot, "critical", True)  # when passes, then fails
    issues = RulesValidator(_compiled(model)).validate(model, Scope.all())
    assert len(issues) == 1
    issue = issues[0]
    assert issue.target_ids == [hot.id]
    assert issue.severity is Severity.WARNING
    assert issue.category is IssueCategory.CONFORMANCE
    assert issue.check == "rule:zoned"
    assert issue.message == "critical buildings need a zone"


def test_satisfied_rule_emits_nothing():
    model = Model(_mm())
    hot = model.create_element("Building")
    model.set_property(hot, "critical", True)
    z = model.create_element("Zone")
    model.connect("Owns", hot.id, z.id)
    assert RulesValidator(_compiled(model)).validate(model, Scope.all()) == []


def test_non_matching_type_skipped():
    model = Model(_mm())
    model.create_element("Zone")
    assert RulesValidator(_compiled(model)).validate(model, Scope.all()) == []


def test_default_message_generated():
    doc = DOC.replace("    message: critical buildings need a zone\n", "")
    model = Model(_mm())
    hot = model.create_element("Building")
    model.set_property(hot, "critical", True)
    compiled = compile_rule_sets([RuleSetSource("a1", "s", doc)], model.metamodel)
    [issue] = RulesValidator(compiled).validate(model, Scope.all())
    assert "zoned" in issue.message


def test_evaluation_error_degrades_and_counts(monkeypatch):
    model = Model(_mm())
    hot = model.create_element("Building")
    model.set_property(hot, "critical", True)
    compiled = _compiled(model)
    import data_rover.core.validation.rules.validator as vmod

    def boom(*a, **k):
        raise RuntimeError("boom")

    monkeypatch.setattr(vmod, "evaluate_condition", boom)
    issues = RulesValidator(compiled).validate(model, Scope.all())
    assert issues == []  # degraded, not raised
    assert compiled.eval_errors["rule:zoned"] == 1


# -- evaluation-failure accounting ------------------------------------------

MANY = """
rules:
  - name: zoned
    applies_to: Building
    then:
      relationship: {type: Owns, direction: outgoing, to: Zone, exists: true}
"""


def _always_raising(model, monkeypatch, count=3):
    """A rule set whose evaluation blows up on every element, plus a record of
    what ``eval_errors`` looked like at each element."""
    import data_rover.core.validation.rules.validator as vmod

    compiled = compile_rule_sets([RuleSetSource("a1", "s", MANY)], model.metamodel)
    for _ in range(count):
        model.create_element("Building")
    seen: list[dict[str, int]] = []

    def boom(*a, **k):
        seen.append(compiled.eval_error_counts())
        raise RuntimeError("boom")

    monkeypatch.setattr(vmod, "evaluate_condition", boom)
    return compiled, seen


def _run(model, compiled):
    return ValidationPipeline([RulesValidator(compiled)]).validate(model, Scope.all())


def test_eval_errors_merge_once_per_run_and_log_once_per_rule(monkeypatch, caplog):
    """Counts land in one merge at the end of a run; a rule that fails on
    every element still yields a single traceback."""
    model = Model(_mm())
    compiled, seen = _always_raising(model, monkeypatch)
    with caplog.at_level(logging.WARNING, logger="data_rover.core.validation.rules"):
        assert _run(model, compiled) == []  # degraded, not raised
    assert len(seen) == 3
    assert seen == [{}, {}, {}]  # nothing merged mid-run
    assert compiled.eval_error_counts() == {"rule:zoned": 3}
    # the API layer's unlocked read of the swapped-in Counter
    assert dict(compiled.eval_errors) == {"rule:zoned": 3}
    assert len([r for r in caplog.records if r.name.endswith(".validator")]) == 1


def test_eval_errors_reset_and_accumulate(monkeypatch):
    """``reset_eval_errors`` zeroes; consecutive runs otherwise add up."""
    model = Model(_mm())
    compiled, _ = _always_raising(model, monkeypatch)
    _run(model, compiled)
    compiled.reset_eval_errors()
    assert compiled.eval_error_counts() == {}
    _run(model, compiled)
    assert compiled.eval_error_counts() == {"rule:zoned": 3}
    _run(model, compiled)
    assert compiled.eval_error_counts() == {"rule:zoned": 6}
