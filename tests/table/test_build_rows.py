"""Row-builder tests: scope/navigation/chain row sources, expand columns
producing a cross product, keep_empty semantics, max_rows truncation, and the
critical base_slots/partial-key invariant for a column sourced from an expand
column (see evaluate.py's `resolve_source_elements` docstring)."""

from data_rover.core.metamodel.schema import ElementType, Metamodel, PropertyDef, RelationshipType
from data_rover.core.model.model import Model
from data_rover.core.table.evaluate import TableLimits, build_rows
from data_rover.core.table.schema import TABLE_ADAPTER


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Block",
                properties=[
                    PropertyDef(name="name", datatype="string"),
                    PropertyDef(name="mass", datatype="integer", multiplicity="0..*"),
                ],
            ),
        ],
        relationships=[
            RelationshipType(name="BlockHasPart", source="Block", target="Block"),
        ],
    )


def _fixture() -> tuple[Model, dict[str, str]]:
    """root: a Block owning 2 parts (part1, part2); leaf: a Block with no parts."""
    model = Model(_mm())
    ids: dict[str, str] = {}
    for key, name in [("root", "Root"), ("part1", "Part 1"), ("part2", "Part 2"), ("leaf", "Leaf")]:
        el = model.create_element("Block")
        model.set_property(el, "name", name)
        ids[key] = el.id
    model.connect("BlockHasPart", ids["root"], ids["part1"])
    model.connect("BlockHasPart", ids["root"], ids["part2"])
    return model, ids


def test_scope_rows_one_binding_per_element():
    mm = _mm(); model, ids = _fixture()
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [{"kind": "element", "source": {"kind": "row"}}],
    })
    keys, truncated = build_rows(mm, model, defn)
    assert not truncated
    assert sorted(keys) == sorted((eid,) for eid in ids.values())


def test_expand_navigation_column_cross_product():
    mm = _mm(); model, ids = _fixture()
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}},
            {"kind": "navigation", "source": {"kind": "row"}, "mode": "expand",
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": [{"kind": "relationship",
                            "relationship_type": "BlockHasPart", "direction": "out"}]}}},
        ],
    })
    keys, _ = build_rows(mm, model, defn)
    # every key is (block_id, part_id); the parent appears once per owned part
    parent = ids["root"]
    part_keys = [k for k in keys if k[0] == parent]
    assert len(part_keys) == 2  # root owns 2 parts in the fixture
    assert all(len(k) == 2 for k in part_keys)


def test_expand_single_valued_property_yields_one_row_per_element():
    # Regression: enabling "split into rows" on a single-valued property used to
    # raise ("not multi-valued; cannot expand") and 422 the whole table. A
    # scalar value now expands to exactly one row; elements without the value
    # follow keep_empty as usual.
    mm = _mm(); model, ids = _fixture()
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}},
            # `name` is declared single-valued (default multiplicity) in _mm()
            {"kind": "property", "source": {"kind": "row"}, "name": "name",
             "mode": "expand"},
        ],
    })
    keys, truncated = build_rows(mm, model, defn)
    assert not truncated
    assert len(keys) == len(ids)  # one row per element, not zero, not an error
    by_root = {k[0]: k for k in keys}
    for key, eid in ids.items():
        assert by_root[eid][1] == model.elements[eid].properties["name"], key


def test_expand_keep_empty_true_keeps_barren_row():
    mm = _mm(); model, ids = _fixture()
    leaf = ids["leaf"]  # a Block with no outgoing BlockHasPart
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}},
            {"kind": "navigation", "source": {"kind": "row"}, "mode": "expand",
             "keep_empty": True,
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": [{"kind": "relationship",
                            "relationship_type": "BlockHasPart", "direction": "out"}]}}},
        ],
    })
    keys, _ = build_rows(mm, model, defn)
    assert (leaf, None) in keys


def test_expand_keep_empty_false_drops_barren_row():
    mm = _mm(); model, ids = _fixture()
    leaf = ids["leaf"]
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}},
            {"kind": "navigation", "source": {"kind": "row"}, "mode": "expand",
             "keep_empty": False,
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": [{"kind": "relationship",
                            "relationship_type": "BlockHasPart", "direction": "out"}]}}},
        ],
    })
    keys, _ = build_rows(mm, model, defn)
    assert all(k[0] != leaf for k in keys)


def test_max_rows_truncates():
    mm = _mm(); model, ids = _fixture()
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [{"kind": "element", "source": {"kind": "row"}}],
    })
    keys, truncated = build_rows(mm, model, defn, TableLimits(max_rows=1))
    assert truncated and len(keys) == 1


def test_column_sourced_from_expand_column_binds_that_rows_element():
    # col0 expands owned parts (one row per part); col1 navigates FROM col0.
    # Each row's col1 must root at THAT row's part, not the parent's whole set.
    mm = _mm(); model, ids = _fixture()
    from data_rover.core.table.evaluate import resolve_source_elements

    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}},
            {"kind": "navigation", "source": {"kind": "row"}, "mode": "expand",
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": [{"kind": "relationship",
                            "relationship_type": "BlockHasPart", "direction": "out"}]}}},
            {"kind": "navigation", "source": {"kind": "column", "index": 1},
             "mode": "collapse",
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": []}}},  # identity nav: returns the source element itself
        ],
    })
    keys, _ = build_rows(mm, model, defn)
    base_slots = 1
    # for a row whose expand slot is a specific part, col2's source resolves to
    # exactly that part (length-1), never the parent's full part set.
    a_row = next(k for k in keys if k[0] == ids["root"] and k[1] is not None)
    src = defn.columns[2].source
    resolved = resolve_source_elements(mm, model, defn, a_row, src, base_slots, TableLimits())
    assert resolved == [a_row[1]]


def test_iter_export_rows_matches_evaluate_cells_regardless_of_chunk_size():
    # Chunking is purely a memory-bounding detail (Task 10) — it must not
    # change which rows are produced or their order, so a chunk smaller than
    # the row count must agree byte-for-byte with one unchunked evaluate_cells
    # call over the same keys.
    from data_rover.core.table.cells import evaluate_cells
    from data_rover.core.table.evaluate import iter_export_rows

    mm = _mm(); model, ids = _fixture()
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}},
            {"kind": "property", "source": {"kind": "row"}, "name": "name"},
        ],
    })
    keys, _ = build_rows(mm, model, defn)
    limits = TableLimits()
    expected = evaluate_cells(mm, model, defn, keys, limits)
    chunked = list(iter_export_rows(mm, model, defn, keys, limits, chunk=1))
    assert chunked == expected
    assert len(chunked) == len(keys)


def test_navigation_row_source_truncation_propagates():
    # A navigation row source that hits its own max_chains budget yields an
    # INCOMPLETE row set even though max_rows never fires — build_rows must
    # still report truncated=True (previously swallowed: the API said
    # `truncated: false` over silently missing rows).
    from data_rover.core.navigation.evaluate import EvalLimits

    mm = _mm(); model, ids = _fixture()
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "chains", "navigation": {"definition": {
            "kind": "path", "start": {"kind": "scope", "types": ["Block"]},
            "steps": []}}},
        "columns": [{"kind": "element", "source": {"kind": "row"}}],
    })
    limits = TableLimits(nav_limits=EvalLimits(max_chains=2))
    keys, truncated = build_rows(mm, model, defn, limits)
    assert truncated is True
    assert len(keys) == 2  # 4 Blocks in the fixture, capped by max_chains


def test_expand_column_navigation_truncation_propagates():
    # Same rule for an expand column's per-row navigation: hitting max_chains
    # drops reached elements (rows), so the table must be flagged truncated.
    from data_rover.core.navigation.evaluate import EvalLimits

    mm = _mm(); model, ids = _fixture()
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}},
            {"kind": "navigation", "source": {"kind": "row"}, "mode": "expand",
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": [{"kind": "relationship",
                            "relationship_type": "BlockHasPart", "direction": "out"}]}}},
        ],
    })
    limits = TableLimits(nav_limits=EvalLimits(max_chains=1))
    keys, truncated = build_rows(mm, model, defn, limits)
    assert truncated is True  # root reaches 2 parts; max_chains=1 dropped one


def test_step_index_out_of_range_raises_value_error():
    # An out-of-range step_index must surface as a ValueError (the API maps it
    # to 422), not an IndexError escaping as a 500.
    import pytest

    mm = _mm(); model, _ = _fixture()
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "navigation", "step_index": 5,
                       "navigation": {"definition": {
                           "kind": "path",
                           "start": {"kind": "scope", "types": ["Block"]},
                           "steps": []}}},
        "columns": [{"kind": "element", "source": {"kind": "row"}}],
    })
    with pytest.raises(ValueError, match="step_index 5 out of range"):
        build_rows(mm, model, defn)
