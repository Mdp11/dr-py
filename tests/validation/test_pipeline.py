from data_rover.core.validation.issue import Issue, Severity
from data_rover.core.validation.pipeline import ValidationPipeline
from data_rover.core.validation.scope import Scope


class _StubValidator:
    def __init__(self, issues):
        self._issues = issues
        self.last_scope = None

    def validate(self, model, scope):
        self.last_scope = scope
        return self._issues


def test_pipeline_aggregates_issues_from_all_validators():
    v1 = _StubValidator([Issue(Severity.ERROR, "a")])
    v2 = _StubValidator([Issue(Severity.WARNING, "b")])
    pipeline = ValidationPipeline([v1, v2])
    issues = pipeline.validate(model=None)
    assert [i.message for i in issues] == ["a", "b"]


def test_pipeline_defaults_to_scope_all():
    v = _StubValidator([])
    ValidationPipeline([v]).validate(model=None)
    last_scope = v.last_scope
    assert last_scope is not None
    assert last_scope.is_all is True


def test_pipeline_passes_through_explicit_scope():
    v = _StubValidator([])
    scope = Scope({"e1"})
    ValidationPipeline([v]).validate(model=None, scope=scope)
    assert v.last_scope is scope


def test_pipeline_reports_each_validator_to_callback():
    v1 = _StubValidator([])
    v2 = _StubValidator([])
    seen: list[str] = []
    ValidationPipeline([v1, v2]).validate(model=None, on_validator=seen.append)
    assert seen == ["_StubValidator", "_StubValidator"]
