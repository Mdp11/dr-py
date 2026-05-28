import pytest

from data_rover.core.metamodel.loader import MetamodelError, load_metamodel_str


VALID = """
enums:
  Status: [Draft, Approved]
elements:
  - name: NamedElement
    abstract: true
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
  - name: Block
    extends: NamedElement
relationships:
  - name: HasPart
    containment: true
    source: Block
    target: Block
"""


def test_load_valid_metamodel():
    mm = load_metamodel_str(VALID)
    et = mm.element_type("Block")
    assert et is not None
    assert et.extends == "NamedElement"
    assert mm.is_containment("HasPart") is True


def test_load_invalid_raises_with_errors():
    bad = "elements:\n  - name: Block\n    extends: Ghost\n"
    with pytest.raises(MetamodelError) as exc:
        load_metamodel_str(bad)
    assert "Ghost" in str(exc.value)
