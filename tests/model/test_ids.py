import uuid

from data_rover.model.ids import SequentialIdGenerator, Uuid7Generator


def test_uuid7_is_valid_uuid_version_7():
    gen = Uuid7Generator()
    value = gen.new_id()
    parsed = uuid.UUID(value)
    assert parsed.version == 7


def test_uuid7_ids_are_unique_and_time_ordered():
    gen = Uuid7Generator()
    ids = [gen.new_id() for _ in range(50)]
    assert len(set(ids)) == 50
    assert ids == sorted(ids)  # v7 sorts by creation time


def test_sequential_generator_is_deterministic():
    gen = SequentialIdGenerator(prefix="e")
    assert gen.new_id() == "e-1"
    assert gen.new_id() == "e-2"
