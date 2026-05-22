import pytest

from data_rover.metamodel.schema import ElementType, Metamodel
from data_rover.model.model import Model
from data_rover.repository.in_memory import InMemoryRepository
from data_rover.repository.repository import ConflictError


def _mm():
    return Metamodel(elements=[ElementType(name="Block")])


def test_save_and_load_metamodel_roundtrip():
    repo = InMemoryRepository()
    repo.save_metamodel("mm1", _mm())
    loaded = repo.load_metamodel("mm1")
    assert loaded.element_type("Block") is not None


def test_save_and_load_model_roundtrip():
    repo = InMemoryRepository()
    mm = _mm()
    model = Model(mm)
    el = model.create_element("Block")
    repo.save_model("m1", model)
    reloaded = repo.load_model("m1", mm)
    assert el.id in reloaded.elements


def test_optimistic_conflict_on_stale_expected_rev():
    repo = InMemoryRepository()
    mm = _mm()
    model = Model(mm)
    rev = repo.save_model("m1", model)          # rev 1
    repo.save_model("m1", model, expected_rev=rev)  # ok -> rev 2
    with pytest.raises(ConflictError):
        repo.save_model("m1", model, expected_rev=rev)  # stale
