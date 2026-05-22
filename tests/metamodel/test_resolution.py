from data_rover.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)


def _mm():
    return Metamodel(
        elements=[
            ElementType(name="NamedElement", abstract=True,
                        properties=[PropertyDef(name="name", datatype="string", multiplicity="1")]),
            ElementType(name="Block", extends="NamedElement",
                        properties=[PropertyDef(name="mass", datatype="float")]),
            ElementType(name="CpuBlock", extends="Block"),
        ],
        relationships=[
            RelationshipType(name="Link", source="NamedElement", target="NamedElement"),
            RelationshipType(name="HasPart", extends="Link", containment=True,
                             source="Block", target="Block"),
        ],
    )


def test_element_ancestors_self_and_chain():
    mm = _mm()
    assert mm.element_ancestors("CpuBlock") == ["CpuBlock", "Block", "NamedElement"]


def test_is_element_subtype():
    mm = _mm()
    assert mm.is_element_subtype("CpuBlock", "NamedElement") is True
    assert mm.is_element_subtype("Block", "Block") is True
    assert mm.is_element_subtype("NamedElement", "Block") is False


def test_effective_element_properties_merge_chain():
    mm = _mm()
    names = [p.name for p in mm.effective_element_properties("Block")]
    assert names == ["name", "mass"]


def test_effective_relationship_containment_inherited():
    mm = _mm()
    assert mm.is_containment("HasPart") is True
    assert mm.is_containment("Link") is False


def test_is_relationship_subtype():
    mm = _mm()
    assert mm.is_relationship_subtype("HasPart", "Link") is True
