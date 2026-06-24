"""Service functions over the content tables (metamodels/models/views/
commits/snapshots). Mirrors ``tenancy.py``: the single place these queries
live; routes and hydration call these instead of inlining SQL. Each function
takes a live ``Session`` and does NOT commit — callers own the unit of work
(``db.db_session`` commits on exit; request code commits explicitly)."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .db_models import Commit, MetamodelRow, ModelRow, Snapshot, ViewRow


def create_metamodel(
    db: Session, *, name: str, version: int, blob: str
) -> MetamodelRow:
    row = MetamodelRow(id=uuid.uuid4().hex, name=name, version=version, blob=blob)
    db.add(row)
    db.flush()
    return row


def get_metamodel_row(db: Session, metamodel_id: str) -> MetamodelRow | None:
    return db.get(MetamodelRow, metamodel_id)


def get_model_row(db: Session, project_id: str) -> ModelRow | None:
    return db.execute(
        select(ModelRow).where(ModelRow.project_id == project_id)
    ).scalar_one_or_none()


def upsert_model_row(
    db: Session, project_id: str, *, metamodel_id: str, name: str = "model"
) -> ModelRow:
    row = get_model_row(db, project_id)
    if row is None:
        row = ModelRow(
            id=uuid.uuid4().hex,
            project_id=project_id,
            metamodel_id=metamodel_id,
            name=name,
        )
        db.add(row)
    else:
        row.metamodel_id = metamodel_id
    db.flush()
    return row


def set_model_rev(db: Session, project_id: str, rev: int) -> None:
    row = get_model_row(db, project_id)
    if row is not None:
        row.model_rev = rev


def append_commit(
    db: Session,
    project_id: str,
    *,
    rev: int,
    commit_id: str,
    author_id: str | None,
    ops: list[Any],
    inverse_ops: list[Any],
    id_map: dict[str, str],
    message: str = "",
    validation_error_count: int = 0,
    issues: list[Any] | None = None,
    from_metamodel_id: str | None = None,
    to_metamodel_id: str | None = None,
) -> Commit:
    row = Commit(
        project_id=project_id,
        rev=rev,
        commit_id=commit_id,
        author_id=author_id,
        ops=ops,
        inverse_ops=inverse_ops,
        id_map=id_map,
        message=message,
        validation_error_count=validation_error_count,
        issues=issues or [],
        from_metamodel_id=from_metamodel_id,
        to_metamodel_id=to_metamodel_id,
    )
    db.add(row)
    db.flush()
    return row


def commits_after(db: Session, project_id: str, rev: int) -> list[Commit]:
    return list(
        db.execute(
            select(Commit)
            .where(Commit.project_id == project_id, Commit.rev > rev)
            .order_by(Commit.rev)
        ).scalars()
    )


def list_commits(
    db: Session, project_id: str, *, before_rev: int | None, limit: int
) -> list[Commit]:
    """Durable commit history for a project, newest-first.

    The page-by cursor is ``before_rev`` (exclusive): pass the smallest ``rev``
    of the previous page to fetch the next, older page. Distinct from
    ``commits_after`` (ascending replay tail used by hydration) — this is the
    descending read for a history browser.
    """
    q = select(Commit).where(Commit.project_id == project_id)
    if before_rev is not None:
        q = q.where(Commit.rev < before_rev)
    q = q.order_by(Commit.rev.desc()).limit(limit)
    return list(db.execute(q).scalars())


def record_snapshot(db: Session, project_id: str, *, rev: int, key: str) -> Snapshot:
    row = db.get(Snapshot, (project_id, rev))
    if row is None:
        row = Snapshot(project_id=project_id, rev=rev, key=key)
        db.add(row)
    else:
        row.key = key
    db.flush()
    return row


def latest_snapshot(
    db: Session, project_id: str, max_rev: int | None = None
) -> Snapshot | None:
    stmt = select(Snapshot).where(Snapshot.project_id == project_id)
    if max_rev is not None:
        stmt = stmt.where(Snapshot.rev <= max_rev)
    return db.execute(stmt.order_by(Snapshot.rev.desc()).limit(1)).scalar_one_or_none()


def clear_history(db: Session, project_id: str) -> None:
    """Delete all commits + snapshot rows for a project (baseline reset).

    Does NOT delete the snapshot blobs from the store — callers that reset a
    baseline overwrite the rev-0 blob immediately afterwards; orphan blobs at
    other revs are harmless (a later GC pass is out of scope)."""
    db.execute(delete(Commit).where(Commit.project_id == project_id))
    db.execute(delete(Snapshot).where(Snapshot.project_id == project_id))


def upsert_single_view(
    db: Session, project_id: str, *, name: str, blob: str
) -> ViewRow:
    row = get_single_view(db, project_id)
    if row is None:
        row = ViewRow(id=uuid.uuid4().hex, project_id=project_id, name=name, blob=blob)
        db.add(row)
    else:
        row.name, row.blob = name, blob
    db.flush()
    return row


def get_single_view(db: Session, project_id: str) -> ViewRow | None:
    return (
        db.execute(
            select(ViewRow).where(ViewRow.project_id == project_id).order_by(ViewRow.id)
        )
        .scalars()
        .first()
    )
