from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model
from data_rover.core.validation.scope import Scope
from data_rover.core.validation.validators.uniqueness import UniquenessValidator


def _named_mm(named_key: list[str] | None = None, with_doc_key: bool = False):
    named = ElementType(
        name="NamedElement",
        abstract=True,
        properties=[PropertyDef(name="name", datatype="string", multiplicity="1")],
        key=named_key,
    )
    requirement = ElementType(name="Requirement", extends="NamedElement")
    block = ElementType(name="Block", extends="NamedElement")
    document = ElementType(
        name="Document",
        extends="NamedElement",
        properties=[PropertyDef(name="isbn", datatype="string", multiplicity="1")],
        key=["isbn"] if with_doc_key else None,
    )
    return Metamodel(
        elements=[named, requirement, block, document],
        relationships=[
            RelationshipType(
                name="HasPart",
                containment=True,
                source="NamedElement",
                target="NamedElement",
            )
        ],
    )


def _set_name(model: Model, el, name: str) -> None:
    model.set_property(el, "name", name)


def test_duplicate_keyed_elements_same_owner_reported():
    mm = _named_mm(named_key=["name"])
    model = Model(mm)
    parent = model.create_element("Block")
    a = model.create_element("Requirement")
    b = model.create_element("Requirement")
    _set_name(model, a, "Foo")
    _set_name(model, b, "Foo")
    model.connect("HasPart", parent.id, a.id)
    model.connect("HasPart", parent.id, b.id)

    issues = UniquenessValidator().validate(model, Scope.all())
    assert len(issues) == 1
    assert "Requirement" in issues[0].message
    assert "Foo" in issues[0].message


def test_duplicate_keyed_elements_different_owners_ok():
    mm = _named_mm(named_key=["name"])
    model = Model(mm)
    p1 = model.create_element("Block")
    p2 = model.create_element("Block")
    _set_name(model, p1, "P1")
    _set_name(model, p2, "P2")
    a = model.create_element("Requirement")
    b = model.create_element("Requirement")
    _set_name(model, a, "Foo")
    _set_name(model, b, "Foo")
    model.connect("HasPart", p1.id, a.id)
    model.connect("HasPart", p2.id, b.id)

    issues = UniquenessValidator().validate(model, Scope.all())
    # p1 vs p2 names are unique; a and b have different owners
    assert issues == []


def test_duplicate_keyed_elements_both_unowned_reported():
    mm = _named_mm(named_key=["name"])
    model = Model(mm)
    a = model.create_element("Requirement")
    b = model.create_element("Requirement")
    _set_name(model, a, "Orphan")
    _set_name(model, b, "Orphan")

    issues = UniquenessValidator().validate(model, Scope.all())
    assert len(issues) == 1


def test_same_name_different_types_not_duplicates():
    mm = _named_mm(named_key=["name"])
    model = Model(mm)
    a = model.create_element("Requirement")
    b = model.create_element("Block")
    _set_name(model, a, "Foo")
    _set_name(model, b, "Foo")

    assert UniquenessValidator().validate(model, Scope.all()) == []


def test_no_key_full_property_equality_required():
    mm = _named_mm(named_key=None)
    model = Model(mm)
    a = model.create_element("Requirement")
    b = model.create_element("Requirement")
    _set_name(model, a, "Foo")
    _set_name(model, b, "Foo")

    issues = UniquenessValidator().validate(model, Scope.all())
    assert len(issues) == 1


def test_no_key_differing_properties_ok():
    mm = _named_mm(named_key=None)
    model = Model(mm)
    a = model.create_element("Requirement")
    b = model.create_element("Requirement")
    _set_name(model, a, "Foo")
    _set_name(model, b, "Bar")

    assert UniquenessValidator().validate(model, Scope.all()) == []


def test_rev_excluded_from_no_key_equality():
    mm = _named_mm(named_key=None)
    model = Model(mm)
    a = model.create_element("Requirement")
    b = model.create_element("Requirement")
    _set_name(model, a, "Foo")
    _set_name(model, b, "Foo")
    # bump b.rev once more to differ from a.rev
    _set_name(model, b, "Foo")
    assert a.rev != b.rev

    issues = UniquenessValidator().validate(model, Scope.all())
    assert len(issues) == 1


def test_subtype_inherits_ancestor_key():
    mm = _named_mm(named_key=["name"])
    model = Model(mm)
    a = model.create_element("Requirement")
    b = model.create_element("Requirement")
    _set_name(model, a, "Foo")
    _set_name(model, b, "Foo")

    issues = UniquenessValidator().validate(model, Scope.all())
    assert len(issues) == 1


def test_subtype_overrides_ancestor_key():
    mm = _named_mm(named_key=["name"], with_doc_key=True)
    model = Model(mm)
    a = model.create_element("Document")
    b = model.create_element("Document")
    # same name, different isbn -> Document key is ['isbn'], so NOT duplicate
    _set_name(model, a, "Foo")
    _set_name(model, b, "Foo")
    model.set_property(a, "isbn", "111")
    model.set_property(b, "isbn", "222")

    assert UniquenessValidator().validate(model, Scope.all()) == []

    # same isbn -> duplicate
    model.set_property(b, "isbn", "111")
    issues = UniquenessValidator().validate(model, Scope.all())
    assert len(issues) == 1


def test_out_of_scope_violations_skipped():
    mm = _named_mm(named_key=["name"])
    model = Model(mm)
    a = model.create_element("Requirement")
    b = model.create_element("Requirement")
    _set_name(model, a, "Foo")
    _set_name(model, b, "Foo")

    assert UniquenessValidator().validate(model, Scope(set())) == []
