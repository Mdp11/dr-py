"""Tests for POST /commits/revert and the _affected_ids helper."""

from __future__ import annotations

from data_rover.api.db_models import Commit
from data_rover.api.routes.commits import _affected_ids


def test_affected_ids_collects_real_ids_from_forward_ops() -> None:
    commits = [
        Commit(
            project_id="p", rev=1, commit_id="c1", author_id=None,
            ops=[{"kind": "create_element", "temp_id": "E1",
                  "type_name": "Node", "properties": {}}],
            inverse_ops=[], id_map={}, message="",
        ),
        Commit(
            project_id="p", rev=2, commit_id="c2", author_id=None,
            ops=[{"kind": "create_relationship", "temp_id": "R1",
                  "type_name": "Contains", "source_id": "E1",
                  "target_id": "E2", "properties": {}},
                 {"kind": "delete_element", "id": "E9"}],
            inverse_ops=[], id_map={}, message="",
        ),
    ]
    assert _affected_ids(commits) == {"E1", "E2", "E9", "R1"}
