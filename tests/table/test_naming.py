"""Unit tests for the export template engine."""

import pytest

from data_rover.core.table.naming import (
    NAME_TOKENS,
    SPLIT_TOKENS,
    folder_segments,
    substitute,
    validate_tokens,
)


def test_substitute_replaces_known_tokens_and_leaves_unknown_verbatim():
    out = substitute("${name}-${rev}-${nope}", {"name": "svc", "rev": "7"})
    assert out == "svc-7-${nope}"


def test_substitute_handles_repeated_and_adjacent_tokens():
    assert substitute("${name}${name}", {"name": "a"}) == "aa"


def test_validate_tokens_accepts_the_allowed_vocabulary():
    validate_tokens("x${name}_${rev}_${date}_${project}", NAME_TOKENS)
    validate_tokens("${id}-${name}", SPLIT_TOKENS)


def test_validate_tokens_rejects_unknown_tokens_sorted_and_named():
    with pytest.raises(ValueError, match=r"unknown template token\(s\): \$\{beta\}, \$\{zeta\}"):
        validate_tokens("${zeta}${name}${beta}", NAME_TOKENS)


def test_validate_tokens_rejects_id_outside_split_context():
    with pytest.raises(ValueError, match=r"\$\{id\}"):
        validate_tokens("${id}", NAME_TOKENS)


def test_folder_segments_splits_and_sanitizes():
    assert folder_segments("a/b c/d:e") == ["a", "b c", "d_e"]


def test_folder_segments_empty_template_is_root():
    assert folder_segments("") == []


def test_folder_segments_rejects_absolute_paths():
    with pytest.raises(ValueError, match="relative"):
        folder_segments("/abs")
    with pytest.raises(ValueError, match="relative"):
        folder_segments("\\\\abs")


def test_folder_segments_rejects_empty_segments():
    for bad in ("a//b", "a/", "/",):
        with pytest.raises(ValueError):
            folder_segments(bad)


def test_folder_segments_neutralizes_dot_segments():
    # sanitize_stem turns all-dots into underscores; never a traversal token.
    assert folder_segments("../evil") == ["__", "evil"]


def test_folder_segments_rejects_segments_that_sanitize_to_nothing():
    with pytest.raises(ValueError):
        folder_segments("a/   /b")
