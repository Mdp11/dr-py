from data_rover.core.metamodel.schema import ElementType, Metamodel, RelationshipType
from data_rover.core.model.ids import SequentialIdGenerator
from data_rover.core.model.model import Model
from data_rover.core.validation.issue import Issue, Severity
from data_rover.core.validation.pipeline import EntityValidator, ValidationPipeline
from data_rover.core.validation.scope import Scope


def _model() -> Model:
    mm = Metamodel(
        elements=[ElementType(name="Block")],
        relationships=[RelationshipType(name="Link", source="Block", target="Block")],
    )
    return Model(mm, id_generator=SequentialIdGenerator("e"))


class _StubValidator(EntityValidator):
    """Records every per-entity/global call and tags issues with its label."""

    def __init__(self, label: str):
        self._label = label
        self.element_ids: list[str] = []
        self.relationship_ids: list[str] = []
        self.last_scope = None

    def validate_element(self, model, el):
        self.element_ids.append(el.id)
        return [Issue(Severity.ERROR, f"{self._label}:element:{el.id}", [el.id])]

    def validate_relationship(self, model, rel):
        self.relationship_ids.append(rel.id)
        return [Issue(Severity.ERROR, f"{self._label}:rel:{rel.id}", [rel.id])]

    def validate_global(self, model, scope):
        self.last_scope = scope
        return [Issue(Severity.WARNING, f"{self._label}:global")]


def test_pipeline_interleaves_validators_per_entity_then_runs_globals():
    model = _model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("Link", a.id, b.id)
    v1, v2 = _StubValidator("v1"), _StubValidator("v2")
    issues = ValidationPipeline([v1, v2]).validate(model)
    assert [i.message for i in issues] == [
        f"v1:element:{a.id}",
        f"v2:element:{a.id}",
        f"v1:element:{b.id}",
        f"v2:element:{b.id}",
        f"v1:rel:{rel.id}",
        f"v2:rel:{rel.id}",
        "v1:global",
        "v2:global",
    ]


def test_pipeline_defaults_to_scope_all():
    model = _model()
    v = _StubValidator("v")
    ValidationPipeline([v]).validate(model)
    last_scope = v.last_scope
    assert last_scope is not None
    assert last_scope.is_all is True


def test_pipeline_passes_through_explicit_scope():
    model = _model()
    v = _StubValidator("v")
    scope = Scope({"e1"})
    ValidationPipeline([v]).validate(model, scope=scope)
    assert v.last_scope is scope


def test_scoped_run_resolves_only_scoped_entities():
    model = _model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("Link", a.id, b.id)
    v = _StubValidator("v")
    ValidationPipeline([v]).validate(model, Scope({a.id, rel.id, "missing-id"}))
    # b is out of scope; the unknown id is silently skipped
    assert v.element_ids == [a.id]
    assert v.relationship_ids == [rel.id]
    assert b.id not in v.element_ids


def test_pipeline_reports_each_validator_to_callback():
    v1, v2 = _StubValidator("v1"), _StubValidator("v2")
    seen: list[str] = []
    ValidationPipeline([v1, v2]).validate(_model(), on_validator=seen.append)
    assert seen == ["_StubValidator", "_StubValidator"]


def test_entity_validator_standalone_validate_drives_iteration():
    model = _model()
    a = model.create_element("Block")
    v = _StubValidator("v")
    issues = v.validate(model)
    assert [i.message for i in issues] == [f"v:element:{a.id}", "v:global"]
