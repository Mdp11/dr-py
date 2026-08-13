"""Split-export partitioning and the filename policy (spec §3.2).

Partitioning is pure slot-0 bucketing, so hand-rolled RowKey/Cell pairs are
fine here (unlike grouping, which needs real evaluator rows)."""

import re

import pytest

from data_rover.core.table.cells import ValueCell
from data_rover.core.table.split import (
    SPLIT_TOKEN,
    render_filenames,
    split_partitions,
    validate_template,
)


def _cell(v):
    return [ValueCell(present=True, value=v, element_id=None, editable=False)]


def test_partitions_bucket_by_slot0_preserving_first_appearance_order():
    keys = [("a",), ("b",), ("a",), ("c",), ("b",)]
    rows = [_cell(i) for i in range(5)]
    parts = split_partitions(keys, iter(rows))  # type: ignore[arg-type]
    assert [b for b, _ in parts] == ["a", "b", "c"]
    a_pairs = parts[0][1]
    assert [rk for rk, _ in a_pairs] == [("a",), ("a",)]
    assert a_pairs[0][1] is rows[0] and a_pairs[1][1] is rows[2]


def test_validate_template_requires_the_token():
    validate_template("DataFor${name}Element")  # no raise
    with pytest.raises(ValueError, match=re.escape(SPLIT_TOKEN)):
        validate_template("export")


def test_filenames_substitute_sanitize_and_dedupe_in_order():
    items = [("e1", "pump"), ("e2", "pump"), ("e3", "a/b:c")]
    assert render_filenames("DataFor${name}", items) == [
        "DataForpump",
        "DataForpump_2",
        "DataFora_b_c",
    ]


def test_filename_suffix_survives_a_literal_pre_collision():
    items = [("e1", "a"), ("e2", "a_2"), ("e3", "a")]
    # "a" then literal "a_2"; third "a" must skip PAST the taken "a_2".
    assert render_filenames("${name}", items) == ["a", "a_2", "a_3"]


def test_empty_render_falls_back_to_the_id_then_to_element():
    assert render_filenames("${name}", [("e-42", "")]) == ["e-42"]
    assert render_filenames("${name}", [("", "")]) == ["element"]


def test_render_filenames_rejects_a_tokenless_template():
    with pytest.raises(ValueError):
        render_filenames("static", [("e1", "x")])
