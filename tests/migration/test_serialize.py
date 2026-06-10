import yaml

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.migration.legacy import metamodel_to_yaml_dict, migrate

from tests.migration.test_migrate import _old_mm, _old_model


def _roundtrip(mm):
    text = yaml.safe_dump(metamodel_to_yaml_dict(mm))
    return load_metamodel_str(text)


def test_roundtrip_preserves_elements_and_keys():
    mm = migrate(_old_mm(), _old_model()).metamodel
    back = _roundtrip(mm)
    person = back.element_type("Person")
    assert person is not None
    assert person.key == ["email"]
    props = {p.name: (p.datatype, p.multiplicity) for p in person.properties}
    assert props["email"] == ("string", "1")
    assert props["age"] == ("integer", "0..1")
    assert props["tags"] == ("string", "0..*")


def test_roundtrip_preserves_relationship_mappings():
    mm = migrate(_old_mm(), _old_model()).metamodel
    back = _roundtrip(mm)
    knows = back.relationship_type("Knows")
    assert [(m.source, m.target) for m in knows.mappings] == [("Person", "Person")]
    owns = back.relationship_type("Owns")
    assert owns.containment is True
    assert [(m.source, m.target) for m in owns.mappings] == [("Org", "Person")]


def test_serialized_yaml_is_valid_metamodel():
    mm = migrate(_old_mm(), _old_model()).metamodel
    # load_metamodel_str runs check_metamodel and raises on any error
    _roundtrip(mm)
