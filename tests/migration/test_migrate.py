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
    person = result.metamodel.element_type("Person")
    assert person is not None
    props = {p.name: p for p in person.properties}
    assert props["email"].datatype == "string"
    assert props["age"].datatype == "integer"
    assert props["tags"].datatype == "string"


def test_property_multiplicities():
    result = migrate(_old_mm(), _old_model())
    person = result.metamodel.element_type("Person")
    assert person is not None
    props = {p.name: p for p in person.properties}
    assert props["email"].multiplicity == "1"  # id property
    assert props["age"].multiplicity == "0..1"  # plain scalar
    assert props["tags"].multiplicity == "0..*"  # list-valued in data


def test_dropped_properties_absent_from_metamodel():
    result = migrate(_old_mm(), _old_model())
    person = result.metamodel.element_type("Person")
    assert person is not None
    names = {p.name for p in person.properties}
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


# --- typed elements key on their type --------------------------------------


def _typed_old_mm():
    return {
        "elements": {
            "Device": {
                "is_owned_by_one_of": [],
                "is_typed_by_one_of": ["DeviceType"],
                "id_properties": ["serial"],
                "other_properties": [],
            },
            # an instance kind with no id properties of its own
            "Reading": {
                "is_owned_by_one_of": [],
                "is_typed_by_one_of": ["DeviceType"],
                "id_properties": [],
                "other_properties": ["value"],
            },
            "DeviceType": {
                "is_owned_by_one_of": [],
                "is_typed_by_one_of": [],
                "id_properties": ["name"],
                "other_properties": [],
            },
        },
        "relationships": {},
    }


def _typed_old_model():
    return {
        "metadata": {"release": "", "commit": ""},
        "elements": {
            "dt1": {
                "id": "dt1",
                "stereotype": "DeviceType",
                "owner": None,
                "element_type": None,
                "properties": {"name": "Sensor"},
            },
            "d1": {
                "id": "d1",
                "stereotype": "Device",
                "owner": None,
                "element_type": "dt1",
                "properties": {"serial": "S1"},
            },
        },
        "relationships": {},
    }


def test_typed_element_key_appends_out_typedby():
    result = migrate(_typed_old_mm(), _typed_old_model())
    device = result.metamodel.element_type("Device")
    assert device is not None
    # the element that HAS a type is the source of TypedBy -> out:TypedBy
    assert device.key == ["serial", "out:TypedBy"]


def test_typed_element_without_id_props_keys_only_on_type():
    result = migrate(_typed_old_mm(), _typed_old_model())
    reading = result.metamodel.element_type("Reading")
    assert reading is not None
    assert reading.key == ["out:TypedBy"]


def test_untyped_element_key_unchanged():
    result = migrate(_typed_old_mm(), _typed_old_model())
    device_type = result.metamodel.element_type("DeviceType")
    assert device_type is not None
    assert device_type.key == ["name"]


def test_typed_key_metamodel_is_valid():
    result = migrate(_typed_old_mm(), _typed_old_model())
    assert check_metamodel(result.metamodel) == []


def test_typed_key_uses_renamed_typedby_on_collision():
    # a pre-existing "TypedBy" stereotype forces the synthesized relationship
    # to be renamed; the key must reference the renamed type, not a literal.
    old_mm = _typed_old_mm()
    old_mm["relationships"]["TypedBy"] = {
        "other_properties": [],
        "mappings": [{"source": "Device", "destination": "Device"}],
    }
    result = migrate(old_mm, _typed_old_model())
    device = result.metamodel.element_type("Device")
    assert device is not None
    assert device.key == ["serial", "out:TypedBy2"]
    assert check_metamodel(result.metamodel) == []


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


# --- numeric string coercion -----------------------------------------------


def _numeric_string_inputs():
    mm = {
        "elements": {
            "Reading": {
                "is_owned_by_one_of": [],
                "is_typed_by_one_of": [],
                "id_properties": ["code"],
                "other_properties": [
                    "amount",
                    "count",
                    "ratios",
                    "label",
                    "limit",
                    "raw",
                ],
            },
        },
        "relationships": {
            "Trend": {
                "other_properties": ["slope"],
                "mappings": [{"source": "Reading", "destination": "Reading"}],
            }
        },
    }
    model = {
        "elements": {
            "r1": {
                "id": "r1",
                "stereotype": "Reading",
                "owner": None,
                "element_type": None,
                "properties": {
                    "code": "abc",
                    "amount": "2.5",  # float string
                    "count": "5",  # integer string
                    # list mixing float/int strings + an infinity token
                    "ratios": ["1.5", "2", "Infinity"],
                    "label": "hello",  # plain string, untouched
                    "limit": "Infinity",  # special float value
                    "raw": "inf",  # non-canonical, stays a plain string
                },
            },
        },
        "relationships": {
            "t1": {
                "id": "t1",
                "stereotype": "Trend",
                "source": "r1",
                "destination": "r1",
                "properties": {"slope": "0.5"},
            }
        },
    }
    return mm, model


def test_numeric_string_datatypes_inferred():
    mm, model = _numeric_string_inputs()
    result = migrate(mm, model)
    reading = result.metamodel.element_type("Reading")
    assert reading is not None
    props = {p.name: p for p in reading.properties}
    assert props["amount"].datatype == "float"
    assert props["count"].datatype == "integer"
    assert props["ratios"].datatype == "float"  # finite floats + Infinity token
    assert props["label"].datatype == "string"
    assert props["limit"].datatype == "float"  # "Infinity" is a special float
    assert props["raw"].datatype == "string"  # "inf" is not a canonical token


def test_numeric_strings_coerced_in_model():
    mm, model = _numeric_string_inputs()
    result = migrate(mm, model)
    el = {e["id"]: e for e in result.model["elements"]}["r1"]
    p = el["properties"]
    assert p["amount"] == 2.5 and isinstance(p["amount"], float)
    assert p["count"] == 5 and isinstance(p["count"], int)
    assert p["ratios"] == [1.5, 2, "Infinity"]  # token kept as-is in the list
    assert p["label"] == "hello"
    assert p["limit"] == "Infinity"  # canonical special-float token preserved
    assert p["raw"] == "inf"  # non-canonical, stays a plain string


def test_numeric_relationship_property_coerced():
    mm, model = _numeric_string_inputs()
    result = migrate(mm, model)
    rels = {r["id"]: r for r in result.model["relationships"]}
    assert rels["t1"]["properties"]["slope"] == 0.5
    assert isinstance(rels["t1"]["properties"]["slope"], float)


def test_migrated_model_is_strict_json_serializable():
    import json

    mm, model = _numeric_string_inputs()
    result = migrate(mm, model)
    # allow_nan=False mirrors the API serializer; a leaked inf/nan would raise.
    json.dumps(result.model, allow_nan=False)


def test_native_infinity_normalized_to_token():
    import json

    mm, model = _numeric_string_inputs()
    # a real float infinity (e.g. from json.loads of "Infinity") must be turned
    # into the canonical string token so the output stays JSON-serializable.
    model["elements"]["r1"]["properties"]["amount"] = float("-inf")
    result = migrate(mm, model)
    el = {e["id"]: e for e in result.model["elements"]}["r1"]
    assert el["properties"]["amount"] == "-Infinity"
    json.dumps(result.model, allow_nan=False)
