from data_rover.core.validation.issue import Issue, Severity
from data_rover.core.validation.pipeline import (
    EntityValidator,
    ValidationPipeline,
    default_pipeline,
)


def test_default_pipeline_validators_declare_check_names():
    names = {v.check_name for v in default_pipeline()._validators}
    assert names == {
        "type_conformance",
        "multiplicity",
        "facets",
        "endpoint_typing",
        "containment",
        "uniqueness",
    }


class _Fake(EntityValidator):
    check_name = "fake"

    def validate_global(self, model, scope):
        return [
            Issue(Severity.ERROR, "boom"),
            Issue(Severity.WARNING, "pre", check="preset"),
        ]


class _EmptyModel:
    elements: dict = {}
    relationships: dict = {}


def test_pipeline_stamps_unset_check_with_the_validator_name():
    issues = ValidationPipeline([_Fake()]).validate(_EmptyModel())
    assert [i.check for i in issues] == ["fake", "preset"]
