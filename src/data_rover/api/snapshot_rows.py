"""Snapshots written from the head rows, never from a model.

``write_snapshot_from_rows`` streams the project's ``ElementRow`` then
``RelationshipRow`` rows, each table in ``seq`` order (the model's dict order),
into the snapshot store. The rows hold each entity's properties as the line
encoder's text, so a line is assembled by concatenation, not re-encoded, and
is byte-identical to ``serialize.iter_entity_lines``'s.
"""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import select, text

from . import content
from .db import db_session
from .db_models import ElementRow, RelationshipRow
from .serialize import _LINE_ENCODER
from .snapshot_codec import encode_snapshot_v2_rows
from .storage import get_snapshot_store, snapshot_key

#: rows fetched per round trip while streaming a table
YIELD_PER = 2000

_enc = _LINE_ENCODER.encode


def element_line(row: ElementRow) -> str:
    return (
        f'{{"id":{_enc(row.id)},"type_name":{_enc(row.type_name)},'
        f'"properties":{row.properties},"rev":{row.rev}}}\n'
    )


def relationship_line(row: RelationshipRow) -> str:
    return (
        f'{{"id":{_enc(row.id)},"type_name":{_enc(row.type_name)},'
        f'"source_id":{_enc(row.source_id)},"target_id":{_enc(row.target_id)},'
        f'"properties":{row.properties},"rev":{row.rev}}}\n'
    )


def write_snapshot_from_rows(project_id: str) -> int:
    """Write the project's head as a v2 snapshot, record its row, and return
    the rev written.

    Reads in one transaction (``REPEATABLE READ`` on Postgres), so the header,
    the counts and the lines are one rev. Raises ``LookupError`` when the
    project has no model row and ``RuntimeError`` when its head rows are not
    written yet."""
    with db_session() as s:
        if s.get_bind().dialect.name == "postgresql":
            s.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
        model_row = content.get_model_row(s, project_id)
        if model_row is None:
            raise LookupError(f"project {project_id} has no model")
        if model_row.state_digest is None:
            raise RuntimeError(f"project {project_id} has no head rows yet")
        rev = model_row.model_rev
        metamodel_id = model_row.metamodel_id
        digest = model_row.state_digest
        elements, relationships = model_row.element_count, model_row.relationship_count

        def element_lines() -> Iterator[str]:
            stmt = (
                select(ElementRow)
                .where(ElementRow.project_id == project_id)
                .order_by(ElementRow.seq)
                .execution_options(yield_per=YIELD_PER)
            )
            for row in s.scalars(stmt):
                yield element_line(row)

        def relationship_lines() -> Iterator[str]:
            stmt = (
                select(RelationshipRow)
                .where(RelationshipRow.project_id == project_id)
                .order_by(RelationshipRow.seq)
                .execution_options(yield_per=YIELD_PER)
            )
            for row in s.scalars(stmt):
                yield relationship_line(row)

        key = snapshot_key(project_id, rev)
        get_snapshot_store().put(
            key,
            encode_snapshot_v2_rows(
                project_id=project_id,
                rev=rev,
                metamodel_id=metamodel_id,
                state_digest=digest,
                elements=elements,
                relationships=relationships,
                element_lines=element_lines(),
                relationship_lines=relationship_lines(),
            ),
        )
        content.record_snapshot(
            s,
            project_id,
            rev=rev,
            key=key,
            format="v2",
            metamodel_id=metamodel_id,
            state_digest=digest,
            elements=elements,
            relationships=relationships,
        )
    return rev
