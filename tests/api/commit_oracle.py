"""The full-model answer a commit on head rows must equal.

``Oracle`` holds a complete core ``Model`` built from the same documents the
project was installed from and runs a batch the way the server answers it, the
whole-model way: ``_apply_batch``, then ``structural_blockers`` over the touched
entities. ``assert_state`` then compares everything a commit leaves behind (head
rows, ``entity_refs``, the ``Commit`` row, the ``ModelRow``) with what the
oracle's model says it should be.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from data_rover.api import content, db
from data_rover.api.commit_states import capture_entity_states
from data_rover.api.db_models import EntityRefRow
from data_rover.api.head import read_head
from data_rover.api.hydration import deserialize_ops, serialize_ops
from data_rover.api.artifact_ops import split_ops
from data_rover.api.routes._snapshot import build_model_from_dicts
from data_rover.api.routes.commits import _structural_ids
from data_rover.api.routes.ops import _apply_batch, _BatchResult, _rollback
from data_rover.api.schemas import IssueOut, ModelOpIn
from data_rover.api.state_digest import model_digest
from data_rover.api.structural import structural_blockers
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model

MM = """
elements:
  - name: Node
    properties:
      - {name: label, datatype: string}
      - {name: n, datatype: integer}
      - {name: x, datatype: float}
      - {name: ref, datatype: Node}
      - {name: refs, datatype: Node, multiplicity: "0..*"}
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
  - name: Link
    source: Node
    target: Node
    properties:
      - {name: via, datatype: Node}
"""


@contextmanager
def session() -> Iterator[DbSession]:
    gen = db.get_db()
    s = next(gen)
    try:
        yield s
    finally:
        gen.close()


def model_ops(raw: list[dict[str, Any]]) -> list[ModelOpIn]:
    """The typed model ops of a batch, validated as the commit request is."""
    return split_ops(deserialize_ops(raw))[0]


@dataclass
class Outcome:
    status: int
    #: the JSON body a rejection answers with
    body: dict[str, Any] | None
    res: _BatchResult | None
    #: on accept: what the commit row stores and the digest after the batch
    entity_states: dict[str, Any] | None = None
    digest: str | None = None


class Oracle:
    def __init__(self, model_json: str, metamodel_yaml: str = MM) -> None:
        self.metamodel = load_metamodel_str(metamodel_yaml)
        self.model: Model = build_model_from_dicts(
            self.metamodel, json.loads(model_json)
        )

    def run(self, ops: list[ModelOpIn], *, restore: bool = False) -> Outcome:
        """Apply ``ops`` to the full model. A rejection leaves it as it was."""
        try:
            res = _apply_batch(self.model, ops, restore=restore)
        except HTTPException as exc:
            return Outcome(exc.status_code, {"detail": exc.detail}, None)
        structural = structural_blockers(self.model, _structural_ids(self.model, res))
        if structural:
            _rollback(self.model, res)
            return Outcome(
                422,
                {
                    "detail": "structural validation blocker",
                    "structural_blockers": [
                        IssueOut.from_core(i).model_dump() for i in structural
                    ],
                },
                res,
            )
        return Outcome(
            200,
            None,
            res,
            entity_states=capture_entity_states(self.model, res),
            digest=model_digest(self.model),
        )

    def rows(self) -> tuple[list[dict], list[dict]]:
        return (
            [asdict(e) for e in self.model.elements.values()],
            [asdict(r) for r in self.model.relationships.values()],
        )

    def refs(self) -> set[tuple[str, str]]:
        return {(r, t) for t, rs in self.model.indexes.ref_targets.items() for r in rs}


def head_refs(s: DbSession, project_id: str) -> set[tuple[str, str]]:
    return {
        (r, t)
        for r, t in s.execute(
            select(EntityRefRow.referencer_id, EntityRefRow.target_id).where(
                EntityRefRow.project_id == project_id
            )
        )
    }


def assert_rows(oracle: Oracle, project_id: str, why: str) -> None:
    """The head rows equal the oracle's model: entities in order, refs, counts,
    digest."""
    with session() as s:
        got_e, got_r = read_head(s, project_id)
        want_e, want_r = oracle.rows()
        assert got_e == want_e, f"{why}: element rows"
        assert got_r == want_r, f"{why}: relationship rows"
        assert head_refs(s, project_id) == oracle.refs(), f"{why}: entity_refs"
        row = content.get_model_row(s, project_id)
        assert row is not None
        s.refresh(row)
        assert row.element_count == len(want_e), f"{why}: element_count"
        assert row.relationship_count == len(want_r), f"{why}: relationship_count"
        assert row.state_digest == model_digest(oracle.model), f"{why}: digest"


def assert_commit_row(outcome: Outcome, rev: int, project_id: str, why: str) -> None:
    """The journal row at ``rev`` carries what the oracle's batch produced."""
    res = outcome.res
    assert res is not None
    with session() as s:
        row = content.get_commit(s, project_id, rev)
        assert row is not None, f"{why}: no commit row at rev {rev}"
        assert row.ops == serialize_ops(res.canonical_ops), f"{why}: ops"
        assert row.inverse_ops == serialize_ops(res.inverse_ops()), f"{why}: inverse"
        assert row.id_map == res.id_map, f"{why}: id_map"
        assert row.entity_states == outcome.entity_states, f"{why}: entity_states"
        assert row.state_digest == outcome.digest, f"{why}: journal digest"
