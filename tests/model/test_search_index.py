"""Trigram search-index maintenance: postings must track every mutation path
and always equal what a fresh rebuild() computes (verify_consistent).

Trigram keys asserted below ("pum", "coo", ...) contain non-hex letters, so
they can never collide with trigrams of UUIDv7 element ids (hex + dashes).
"""

import random

import pytest

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


def _bulk_loaded(names: list[str]) -> Model:
    """Populate the dicts directly (the bulk-load path) and rebuild()."""
    from data_rover.core.model.element import Element

    m = _model()
    for i, name in enumerate(names):
        eid = f"bulk-{i}"
        m.elements[eid] = Element(id=eid, type_name="Item", properties={"name": name})
    m.indexes.rebuild()
    return m


def test_rebuild_recomputes_from_scratch() -> None:
    m = _model()
    _named(m, "Pump")
    _named(m, "Valve")
    snapshot = {t: set(ids) for t, ids in m.indexes.search_postings.items()}
    trig_snapshot = dict(m.indexes._trigrams_of)
    m.indexes.rebuild()
    # rebuild() drops the search index (bulk-load semantics) ...
    assert m.indexes.search_ready is False
    assert m.indexes.search_postings == {}
    assert m.indexes._trigrams_of == {}
    # ... and a synchronous full build restores it exactly
    m.indexes.build_search_index()
    assert m.indexes.search_ready is True
    assert {t: set(ids) for t, ids in m.indexes.search_postings.items()} == snapshot
    assert m.indexes._trigrams_of == trig_snapshot


def test_fresh_index_is_ready_and_hooks_keep_it_complete() -> None:
    m = _model()
    assert m.indexes.search_ready is True  # an empty model's empty index is complete
    a = _named(m, "Pump")
    assert m.indexes.search_candidates("pump") == {a.id}
    m.indexes.verify_consistent()


def test_rebuild_keep_search_preserves_the_index() -> None:
    m = _model()
    a = _named(m, "Pump")
    postings = {t: set(ids) for t, ids in m.indexes.search_postings.items()}
    m.indexes.rebuild(keep_search=True)
    assert m.indexes.search_ready is True
    assert {t: set(ids) for t, ids in m.indexes.search_postings.items()} == postings
    assert m.indexes.search_candidates("pump") == {a.id}
    m.indexes.verify_consistent()


def test_candidates_none_until_ready_then_exact() -> None:
    m = _bulk_loaded(["Pump", "Valve"])
    assert m.indexes.search_ready is False
    assert m.indexes.search_candidates("pump") is None  # scan fallback
    m.indexes.build_search_index()
    assert m.indexes.search_candidates("pump") == {"bulk-0"}
    assert m.indexes.search_candidates("valve") == {"bulk-1"}
    m.indexes.verify_consistent()


def test_chunked_build_skips_hook_maintained_and_deleted_elements() -> None:
    """The background builder's contract: ids are snapshotted up front, then
    indexed chunk by chunk while the mutation hooks keep running. An element
    edited before its chunk lands is left to that chunk (indexed once, with
    its current text); a hook-created one already has its entry (skipped, not
    duplicated); a deleted one is absent from the model (skipped)."""
    m = _bulk_loaded(["Pump", "Valve", "Turbine"])
    ids = list(m.elements)  # snapshot, as the builder does
    # mutations BEFORE the build reaches them
    m.set_property(m.elements["bulk-0"], "name", "Compressor")
    m.delete_element("bulk-2")
    created = _named(m, "Boiler")  # hook-indexed, never in the snapshot
    m.indexes.index_search_chunk(ids[:2])
    m.indexes.index_search_chunk(ids[2:])
    m.indexes.mark_search_ready()
    assert m.indexes.search_candidates("compressor") == {"bulk-0"}
    assert m.indexes.search_candidates("pump") == frozenset()
    assert m.indexes.search_candidates("valve") == {"bulk-1"}
    assert m.indexes.search_candidates("turbine") == frozenset()
    assert m.indexes.search_candidates("boiler") == {created.id}
    m.indexes.verify_consistent()


def test_index_search_chunk_is_idempotent() -> None:
    m = _bulk_loaded(["Pump"])
    m.indexes.index_search_chunk(["bulk-0"])
    m.indexes.index_search_chunk(["bulk-0", "bulk-0", "missing"])
    assert _posting_ids(m, "pum") == {"bulk-0"}
    assert m.indexes._trigrams_of.keys() == {"bulk-0"}


def test_verify_consistent_tolerates_a_partial_index() -> None:
    m = _bulk_loaded(["Pump", "Valve"])
    m.indexes.index_search_chunk(["bulk-0"])  # half built, not ready
    m.indexes.verify_consistent()  # search structures excluded while not ready
    m.indexes.mark_search_ready()
    with pytest.raises(AssertionError, match="search_postings"):
        m.indexes.verify_consistent()  # ready but incomplete => caught


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


def test_candidates_degenerate_falls_back_to_scan(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from data_rover.core.model import indexes as indexes_module

    monkeypatch.setattr(indexes_module, "_SEARCH_FALLBACK_FLOOR", 2)
    m = _model()
    for i in range(8):
        _named(m, f"Pump {i}")
    # smallest posting for "pump" holds all 8 elements >= max(2, 8 // 4) -> scan
    assert m.indexes.search_candidates("pump") is None
    # a selective query stays on the index
    valve = _named(m, "Valve")
    assert m.indexes.search_candidates("valve") == {valve.id}


def test_delete_property_removes_postings() -> None:
    m = _model()
    el = _named(m, "Pump")
    m.set_property(el, "note", "cooling")
    assert el.id in _posting_ids(m, "coo")
    m.delete_property(el, "note")
    assert "coo" not in m.indexes.search_postings
    m.indexes.verify_consistent()


# ---------------------------------------------------------------------------
# per-property diff (set_property / delete_property hook)
# ---------------------------------------------------------------------------


def test_diff_keeps_trigrams_another_field_still_holds() -> None:
    m = _model()
    el = _named(m, "cooling pump")
    m.set_property(el, "note", "cooling circuit")
    m.set_property(el, "note", "heat circuit")
    assert el.id in _posting_ids(m, "coo")  # left the note, still in the name
    assert el.id not in _posting_ids(m, "g c")  # only ever in the old note
    assert el.id in _posting_ids(m, "hea")
    m.indexes.verify_consistent()


def test_diff_falls_back_for_list_values_and_list_names() -> None:
    m = _model()
    el = _named(m, "Pump")
    el.properties["name"] = ["Valve", "Gauge"]  # multiplicity-many name (legacy models)
    m.indexes.on_properties_changed(el)
    assert el.id in _posting_ids(m, "val")
    m.set_property(el, "note", "turbine")  # a list-valued name: whole-element path
    assert el.id in _posting_ids(m, "tur")
    assert el.id in _posting_ids(m, "val")
    m.set_property(el, "name", "Boiler")  # list -> str: fallback again, list text gone
    assert el.id in _posting_ids(m, "boi")
    assert "val" not in m.indexes.search_postings
    m.set_property(el, "note", ["turbine", "hall"])  # str -> list value: fallback
    assert "tur" not in m.indexes.search_postings
    m.indexes.verify_consistent()


def test_diff_delete_property_and_same_value_rewrite() -> None:
    m = _model()
    el = _named(m, "Pump")
    m.set_property(el, "note", "cooling")
    before = m.indexes._trigrams_of[el.id]
    m.set_property(el, "note", "cooling")  # same text again: nothing moves
    assert m.indexes._trigrams_of[el.id] == before
    m.delete_property(el, "note")
    assert "coo" not in m.indexes.search_postings
    assert el.id in _posting_ids(m, "pum")
    m.indexes.verify_consistent()


def test_diff_matches_full_derivation_over_random_edits() -> None:
    """The per-value diff must land on exactly what a whole-element
    re-derivation produces, after every single write."""
    rng = random.Random(23)
    words = ["pump", "valve", "cooling", "heat", "pumps", "ab", "", "turbine hall", "coo"]
    m = _model()
    els = [_named(m, rng.choice(words)) for _ in range(6)]
    for _ in range(300):
        el = rng.choice(els)
        prop = rng.choice(["name", "note"])
        if rng.random() < 0.2:
            m.delete_property(el, prop)
        else:
            m.set_property(el, prop, rng.choice(words))
        have = frozenset(m.indexes._trigrams_of.get(el.id) or ())
        assert have == m.indexes._element_trigrams(el)
    m.indexes.verify_consistent()


def test_on_property_changed_is_the_model_hook() -> None:
    m = _model()
    el = _named(m, "Pump")
    old = el.properties["name"]
    el.properties["name"] = "Valve"
    m.indexes.on_property_changed(el, "name", old)
    assert el.id in _posting_ids(m, "val")
    assert "pum" not in m.indexes.search_postings
    m.indexes.verify_consistent()


# ---------------------------------------------------------------------------
# ownership: a cold (bulk-loaded, not yet built) element is the builder's
# ---------------------------------------------------------------------------


def test_bulk_loaded_element_edit_is_left_to_the_builder() -> None:
    """Under a not-ready index the hooks maintain only what they own: an
    element the bulk load left unindexed is the chunked build's, which
    indexes its CURRENT text when it reaches it — never derived twice."""
    m = _bulk_loaded(["Pump", "Valve"])
    m.set_property(m.elements["bulk-0"], "name", "Compressor")
    assert "bulk-0" not in m.indexes._trigrams_of  # deferred
    assert m.indexes.search_postings == {}
    m.indexes.build_search_index()
    assert m.indexes.search_candidates("compressor") == {"bulk-0"}
    assert m.indexes.search_candidates("pump") == frozenset()
    m.indexes.verify_consistent()


def test_hook_created_element_is_indexed_while_not_ready() -> None:
    m = _bulk_loaded(["Pump"])
    created = _named(m, "Boiler")  # hook-owned from creation on
    assert created.id in m.indexes._trigrams_of
    m.set_property(created, "note", "turbine")  # diffed, not deferred
    assert created.id in _posting_ids(m, "tur")
    m.indexes.build_search_index()
    assert m.indexes.search_candidates("turbine") == {created.id}
    m.indexes.verify_consistent()


def test_indexed_element_keeps_an_entry_when_its_text_has_no_trigram() -> None:
    """An entry marks 'indexed' and must exist even when empty — otherwise a
    text-less element looks builder-owned and is skipped forever after it
    gains text."""
    m = Model(load_metamodel_str(MM.replace("Item", "It")))
    el = m.restore_element("e1", "It")  # id and type name both under 3 chars
    assert m.indexes._trigrams_of[el.id] == ()
    m.indexes.rebuild()  # bulk-load semantics: builder-owned again
    assert el.id not in m.indexes._trigrams_of
    m.set_property(el, "name", "Pump")  # deferred ...
    assert "pum" not in m.indexes.search_postings
    m.indexes.build_search_index()  # ... and picked up by the build
    assert m.indexes.search_candidates("pump") == {"e1"}
    m.set_property(el, "name", "ab")  # empty again: the entry stays
    assert m.indexes._trigrams_of[el.id] == ()
    m.indexes.verify_consistent()
