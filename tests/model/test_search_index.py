"""Trigram search-index maintenance: postings must track every mutation path
and always equal what a fresh rebuild() computes (verify_consistent).

Trigram keys asserted below ("pum", "coo", ...) contain non-hex letters, so
they can never collide with trigrams of UUIDv7 element ids (hex + dashes).
"""

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model

MM = """
elements:
  - name: Item
    properties:
      - {name: name, datatype: string}
      - {name: note, datatype: string}
      - {name: size, datatype: integer}
relationships:
  - name: Contains
    containment: true
    source: Item
    target: Item
"""


def _model() -> Model:
    return Model(load_metamodel_str(MM))


def _named(model: Model, name: str):
    el = model.create_element("Item")
    model.set_property(el, "name", name)
    return el


def _posting_ids(m: Model, trigram: str) -> set[str]:
    return m.indexes.search_postings.get(trigram, set())


def test_create_indexes_name_id_and_type() -> None:
    m = _model()
    el = _named(m, "Pump Alpha")
    assert el.id in _posting_ids(m, "pum")
    assert el.id in _posting_ids(m, "alp")
    assert el.id in _posting_ids(m, "ite")  # type name "item"
    assert el.id in _posting_ids(m, el.id[:3].lower())  # own id text
    m.indexes.verify_consistent()


def test_string_properties_indexed_non_strings_ignored() -> None:
    m = _model()
    el = _named(m, "Pump")
    m.set_property(el, "note", "cooling circuit")
    m.set_property(el, "size", 12345)
    assert el.id in _posting_ids(m, "coo")
    assert el.id not in _posting_ids(m, "123")  # int contributes nothing
    m.indexes.verify_consistent()


def test_rename_moves_postings_and_stays_sparse() -> None:
    m = _model()
    el = _named(m, "Pump")
    m.set_property(el, "name", "Valve")
    assert el.id in _posting_ids(m, "val")
    assert "pum" not in m.indexes.search_postings  # emptied set deleted
    m.indexes.verify_consistent()


def test_short_fields_contribute_nothing() -> None:
    m = _model()
    el = m.create_element("Item")
    before = m.indexes._trigrams_of[el.id]  # id + type trigrams only
    m.set_property(el, "name", "ab")  # < 3 chars: no trigrams
    assert m.indexes._trigrams_of[el.id] == before
    m.indexes.verify_consistent()


def test_delete_removes_all_postings() -> None:
    m = _model()
    el = _named(m, "Pump")
    keep = _named(m, "Pipe")
    m.delete_element(el.id)
    assert el.id not in m.indexes._trigrams_of
    assert all(el.id not in ids for ids in m.indexes.search_postings.values())
    assert all(ids for ids in m.indexes.search_postings.values())  # sparse
    assert keep.id in _posting_ids(m, "pip")
    m.indexes.verify_consistent()


def test_delete_restore_reindexes() -> None:
    m = _model()
    el = _named(m, "Pump")
    eid = el.id
    m.delete_element(eid)
    restored = m.restore_element(eid, "Item")
    m.set_property(restored, "name", "Pump")
    assert eid in _posting_ids(m, "pum")
    m.indexes.verify_consistent()


def test_direct_property_write_via_hook() -> None:
    """Direct writers of entity.properties must call on_properties_changed —
    the documented IndexSet obligation now also feeds search."""
    m = _model()
    el = _named(m, "Pump")
    el.properties["note"] = "turbine"
    m.indexes.on_properties_changed(el)
    assert el.id in _posting_ids(m, "tur")
    m.indexes.verify_consistent()


def test_rebuild_recomputes_from_scratch() -> None:
    m = _model()
    _named(m, "Pump")
    _named(m, "Valve")
    snapshot = {t: set(ids) for t, ids in m.indexes.search_postings.items()}
    trig_snapshot = dict(m.indexes._trigrams_of)
    m.indexes.rebuild()
    assert {t: set(ids) for t, ids in m.indexes.search_postings.items()} == snapshot
    assert m.indexes._trigrams_of == trig_snapshot


def test_mixed_mutation_sequence_stays_consistent() -> None:
    m = _model()
    a = _named(m, "Pump Station")
    b = _named(m, "Valve House")
    rel = m.connect("Contains", a.id, b.id)
    m.set_property(b, "note", "east grid")
    m.disconnect(rel.id)
    m.set_property(a, "name", "Compressor")
    m.delete_element(b.id)
    m.indexes.verify_consistent()


def test_candidates_superset_with_cross_field_false_positive() -> None:
    m = _model()
    hit = _named(m, "Hydraulic Pump")
    fp = _named(m, "pumX")  # 'pum' in name ...
    m.set_property(fp, "note", "Yump")  # ... 'ump' in another field
    miss = _named(m, "Valve")
    cands = m.indexes.search_candidates("pump")
    assert cands is not None
    assert hit.id in cands  # a true hit always survives (superset guarantee)
    assert fp.id in cands  # cross-field FP allowed; the score check filters
    assert miss.id not in cands


def test_candidates_short_query_none_unknown_trigram_empty() -> None:
    m = _model()
    _named(m, "Pump")
    assert m.indexes.search_candidates("pu") is None
    assert m.indexes.search_candidates("") is None
    assert m.indexes.search_candidates("zzz") == frozenset()
    # one absent trigram kills the whole intersection
    assert m.indexes.search_candidates("pumzzz") == frozenset()


def test_candidates_single_trigram_query() -> None:
    m = _model()
    a = _named(m, "Pump")
    b = _named(m, "Pumice")
    assert m.indexes.search_candidates("pum") == {a.id, b.id}
