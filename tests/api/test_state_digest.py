"""The state digest: pinned vectors, order independence, O(batch) upkeep."""

from __future__ import annotations

import zlib

from data_rover.api.state_digest import entity_hash, format_digest, model_digest
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.ids import SequentialIdGenerator
from data_rover.core.model.model import Model

MM_YAML = """
elements:
  - name: Node
    properties:
      - {name: name, datatype: string}
relationships:
  - {name: Link, source: Node, target: Node}
"""


def _model() -> Model:
    model = Model(load_metamodel_str(MM_YAML), SequentialIdGenerator())
    a = model.create_element("Node")
    b = model.create_element("Node")
    model.set_property(a, "name", "A")
    model.connect("Link", a.id, b.id)
    return model


def test_entity_hash_vectors() -> None:
    # The engine reproduces these; they pin the byte layout, not just the idea.
    vectors = [
        ("id-1", 0, "b83d885159d11dd4"),
        ("id-1", 1, "14d07545607c068e"),
        ("", 0, "db3426e878068d28"),
        ("caf\u00e9", 12, "c9524fe14dc453b5"),
        ("\U0001f600", 3, "7907ed2f4cfeac90"),
    ]
    for entity_id, rev, expected in vectors:
        assert format_digest(entity_hash(entity_id, rev)) == expected


def test_format_is_sixteen_lower_case_hex_digits() -> None:
    assert format_digest(0) == "0000000000000000"
    assert format_digest(0xAB) == "00000000000000ab"
    assert format_digest(2**64 - 1) == "ffffffffffffffff"


def test_empty_model_digest_is_zero() -> None:
    assert model_digest(Model(load_metamodel_str(MM_YAML))) == "0000000000000000"


def test_model_digest_covers_elements_and_relationships() -> None:
    model = _model()
    # id-1 was written once (rev 1); id-2 and the relationship id-3 never.
    expected = entity_hash("id-1", 1) ^ entity_hash("id-2", 0) ^ entity_hash("id-3", 0)
    assert model_digest(model) == format_digest(expected)


def test_digest_ignores_entity_order() -> None:
    model = _model()
    before = model_digest(model)
    model.elements = dict(reversed(list(model.elements.items())))
    assert model_digest(model) == before


def test_digest_is_maintainable_per_entity() -> None:
    model = _model()
    value = int(model_digest(model), 16)
    element = model.get_element("id-2")
    old_rev = element.rev
    model.set_property(element, "name", "B")
    value ^= entity_hash(element.id, old_rev) ^ entity_hash(element.id, element.rev)
    assert format_digest(value) == model_digest(model)


def test_digest_sees_two_ids_exchanging_revs() -> None:
    swapped = entity_hash("a", 2) ^ entity_hash("b", 10)
    assert entity_hash("a", 10) ^ entity_hash("b", 2) != swapped

    # The reason the per-entity hash is not a CRC: folded with XOR, a linear
    # checksum gives both states the same digest.
    def crc(entity_id: str, rev: int) -> int:
        return zlib.crc32(entity_id.encode() + b"\x00" + str(rev).encode())

    assert crc("a", 1) ^ crc("b", 2) == crc("a", 2) ^ crc("b", 1)
