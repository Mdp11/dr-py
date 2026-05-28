from data_rover.core.metamodel.schema import ElementType, Metamodel, RelationshipType
from data_rover.core.model.model import Model
from data_rover.core.repository.file_store import FileRepository


def _mm():
    return Metamodel(
        elements=[ElementType(name="Block")],
        relationships=[
            RelationshipType(
                name="HasPart", containment=True, source="Block", target="Block"
            )
        ],
    )


def test_metamodel_roundtrip_through_disk(tmp_path):
    repo = FileRepository(tmp_path)
    repo.save_metamodel("mm", _mm())
    loaded = repo.load_metamodel("mm")
    assert loaded.is_containment("HasPart") is True


def test_model_roundtrip_through_disk(tmp_path):
    repo = FileRepository(tmp_path)
    mm = _mm()
    model = Model(mm)
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("HasPart", a.id, b.id)
    repo.save_model("m", model)
    reloaded = repo.load_model("m", mm)
    assert set(reloaded.elements) == {a.id, b.id}
    assert rel.id in reloaded.relationships
    assert reloaded.relationships[rel.id].source_id == a.id
