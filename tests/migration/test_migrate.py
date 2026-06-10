from data_rover.core.metamodel.check import check_metamodel
from data_rover.migration.legacy import migrate


def _old_mm():
    return {
        "elements": {
            "Person": {
                "is_owned_by_one_of": ["Org"],
                "is_typed_by_one_of": [],
                "id_properties": ["email"],
                "other_properties": ["age", "nickname", "tags"],
            },
            "Org": {
                "is_owned_by_one_of": [],
                "is_typed_by_one_of": [],
                "id_properties": ["name"],
                "other_properties": [],
            },
        },
        "relationships": {
            "Knows": {
                "other_properties": ["since"],
                "mappings": [{"source": "Person", "destination": "Person"}],
            }
        },
    }


def _old_model():
    return {
        "metadata": {"release": "", "commit": ""},
        "elements": {
            "p1": {
                "id": "p1",
                "stereotype": "Person",
                "owner": "o1",
                "element_type": None,
                "properties": {
                    "email": "a@b.c",
                    "age": 30,
                    "nickname": "al",
                    "tags": ["x", "y"],
                    "SourceDatabase": "db",
                    "debug_data": "junk",
                },
            },
            "o1": {
                "id": "o1",
                "stereotype": "Org",
                "owner": None,
                "element_type": None,
                "properties": {"name": "Acme"},
            },
        },
        "relationships": {
            "r1": {
                "id": "r1",
                "stereotype": "Knows",
                "source": "p1",
                "destination": "p1",
                "properties": {"since": 2020},
            }
        },
    }


# --- metamodel migration ---------------------------------------------------


def test_metamodel_is_valid():
    result = migrate(_old_mm(), _old_model())
    assert check_metamodel(result.metamodel) == []


def test_id_properties_become_key():
    result = migrate(_old_mm(), _old_model())
    person = result.metamodel.element_type("Person")
    assert person is not None
    assert person.key == ["email"]


def test_property_datatypes_inferred_from_data():
    result = migrate(_old_mm(), _old_model())
    props = {p.name: p for p in result.metamodel.element_type("Person").properties}
    assert props["email"].datatype == "string"
    assert props["age"].datatype == "integer"
    assert props["tags"].datatype == "string"


def test_property_multiplicities():
    result = migrate(_old_mm(), _old_model())
    props = {p.name: p for p in result.metamodel.element_type("Person").properties}
    assert props["email"].multiplicity == "1"  # id property
    assert props["age"].multiplicity == "0..1"  # plain scalar
    assert props["tags"].multiplicity == "0..*"  # list-valued in data


def test_dropped_properties_absent_from_metamodel():
    result = migrate(_old_mm(), _old_model())
    names = {p.name for p in result.metamodel.element_type("Person").properties}
    assert "SourceDatabase" not in names
    assert "debug_data" not in names


def test_relationship_mappings_migrated():
    result = migrate(_old_mm(), _old_model())
    knows = result.metamodel.relationship_type("Knows")
    assert knows is not None
    assert [(m.source, m.target) for m in knows.mappings] == [("Person", "Person")]
    assert {p.name for p in knows.properties} == {"since"}


def test_owns_relationship_type_synthesized():
    result = migrate(_old_mm(), _old_model())
    owns = result.metamodel.relationship_type("Owns")
    assert owns is not None
    assert owns.containment is True
    assert [(m.source, m.target) for m in owns.mappings] == [("Org", "Person")]


def test_typedby_not_created_when_no_constraints():
    result = migrate(_old_mm(), _old_model())
    assert result.metamodel.relationship_type("TypedBy") is None


# --- model migration -------------------------------------------------------


def test_elements_converted_to_list_without_dropped_props():
    result = migrate(_old_mm(), _old_model())
    elements = {e["id"]: e for e in result.model["elements"]}
    assert set(elements) == {"p1", "o1"}
    assert elements["p1"]["type_name"] == "Person"
    assert elements["p1"]["rev"] == 0
    assert "SourceDatabase" not in elements["p1"]["properties"]
    assert "debug_data" not in elements["p1"]["properties"]
    assert elements["p1"]["properties"]["age"] == 30


def test_existing_relationship_converted():
    result = migrate(_old_mm(), _old_model())
    rels = {r["id"]: r for r in result.model["relationships"]}
    assert rels["r1"]["type_name"] == "Knows"
    assert rels["r1"]["source_id"] == "p1"
    assert rels["r1"]["target_id"] == "p1"
    assert rels["r1"]["properties"]["since"] == 2020


def test_owner_becomes_owns_relationship():
    result = migrate(_old_mm(), _old_model())
    owns = [r for r in result.model["relationships"] if r["type_name"] == "Owns"]
    assert len(owns) == 1
    assert owns[0]["source_id"] == "o1"  # the owner (container)
    assert owns[0]["target_id"] == "p1"  # the owned element


def test_synthesized_relationship_ids_are_deterministic():
    a = migrate(_old_mm(), _old_model())
    b = migrate(_old_mm(), _old_model())
    ids_a = sorted(r["id"] for r in a.model["relationships"])
    ids_b = sorted(r["id"] for r in b.model["relationships"])
    assert ids_a == ids_b


def test_metadata_dropped_and_rev_set():
    result = migrate(_old_mm(), _old_model())
    assert "metadata" not in result.model
    assert result.model["rev"] == 1


# --- unmapped link handling ------------------------------------------------


def _unmapped_inputs():
    mm = _old_mm()
    mm["elements"]["Person"]["is_owned_by_one_of"] = []  # no allowed owner mapping
    return mm, _old_model()


def test_unmapped_owner_link_skipped_with_warning():
    mm, model = _unmapped_inputs()
    result = migrate(mm, model)
    assert not [r for r in result.model["relationships"] if r["type_name"] == "Owns"]
    assert any("owner" in w.lower() or "o1" in w for w in result.warnings)


def test_unmapped_owner_link_emitted_when_forced():
    mm, model = _unmapped_inputs()
    result = migrate(mm, model, emit_unmapped_links=True)
    owns = [r for r in result.model["relationships"] if r["type_name"] == "Owns"]
    assert len(owns) == 1
