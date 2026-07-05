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

from .db_models import (
    ArtifactKind,
    ArtifactRow,
    Commit,
    MetamodelRow,
    ModelRow,
    Snapshot,
    ViewRow,
)


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


def get_strict_mode(db: Session, project_id: str) -> bool:
    """Read the project's strict-mode flag. False if no model row or NULL
    policy (the inspectable default)."""
    row = get_model_row(db, project_id)
    if row is None or row.validation_policy is None:
        return False
    return bool(row.validation_policy.get("strict", False))


def set_strict_mode(db: Session, project_id: str, strict: bool) -> None:
    """Set the project's strict-mode flag. Reassigns a fresh dict so
    SQLAlchemy's JSON change-tracking fires (in-place mutation is not
    detected). Raises LookupError if the project has no model row."""
    row = get_model_row(db, project_id)
    if row is None:
        raise LookupError(f"project {project_id!r} has no model row")
    policy = dict(row.validation_policy or {})
    policy["strict"] = strict
    row.validation_policy = policy
    db.commit()


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


def commits_between(
    db: Session, project_id: str, *, after_rev: int, max_rev: int
) -> list[Commit]:
    """Commits with ``after_rev < rev <= max_rev``, ascending (replay order).

    Bounded variant of ``commits_after`` for historical reconstruction: replay
    only the tail from the chosen snapshot up to (and including) a target rev.
    """
    return list(
        db.execute(
            select(Commit)
            .where(
                Commit.project_id == project_id,
                Commit.rev > after_rev,
                Commit.rev <= max_rev,
            )
            .order_by(Commit.rev)
        ).scalars()
    )


def first_rebind_after(db: Session, project_id: str, rev: int) -> Commit | None:
    """Earliest rebind commit with ``rev > given`` (or None).

    A rebind commit carries a non-null ``from_metamodel_id``/``to_metamodel_id``.
    Used to resolve the metamodel effective AT ``rev``: the pre-swap
    ``from_metamodel_id`` of the first rebind after ``rev``.
    """
    return db.execute(
        select(Commit)
        .where(
            Commit.project_id == project_id,
            Commit.rev > rev,
            Commit.from_metamodel_id.is_not(None),
        )
        .order_by(Commit.rev)
        .limit(1)
    ).scalar_one_or_none()


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


class StaleArtifactError(Exception):
    """Optimistic-concurrency failure: the caller's expected_rev is behind."""

    def __init__(self, current_rev: int) -> None:
        super().__init__(f"artifact is at rev {current_rev}")
        self.current_rev = current_rev


def create_artifact(
    db: Session,
    project_id: str,
    *,
    kind: ArtifactKind,
    name: str,
    payload: dict,
    updated_by: str | None,
) -> ArtifactRow:
    row = ArtifactRow(
        id=uuid.uuid4().hex,
        project_id=project_id,
        kind=kind,
        name=name,
        payload=payload,
        updated_by=updated_by,
    )
    db.add(row)
    db.flush()
    return row


def get_artifact(db: Session, artifact_id: str) -> ArtifactRow | None:
    return db.get(ArtifactRow, artifact_id)


def find_artifact(
    db: Session, project_id: str, kind: ArtifactKind, name: str
) -> ArtifactRow | None:
    return db.execute(
        select(ArtifactRow).where(
            ArtifactRow.project_id == project_id,
            ArtifactRow.kind == kind,
            ArtifactRow.name == name,
        )
    ).scalar_one_or_none()


def list_artifacts(
    db: Session, project_id: str, kind: ArtifactKind | None = None
) -> list[ArtifactRow]:
    q = select(ArtifactRow).where(ArtifactRow.project_id == project_id)
    if kind is not None:
        q = q.where(ArtifactRow.kind == kind)
    q = q.order_by(ArtifactRow.kind, ArtifactRow.name)
    return list(db.execute(q).scalars())


def update_artifact(
    db: Session,
    row: ArtifactRow,
    *,
    expected_rev: int,
    name: str | None = None,
    payload: dict | None = None,
    updated_by: str | None,
) -> ArtifactRow:
    """Rev-checked update. `payload` is reassigned wholesale (never mutated in
    place) so SQLAlchemy's JSON change-tracking fires — same rule as
    `set_strict_mode` above."""
    if row.artifact_rev != expected_rev:
        raise StaleArtifactError(row.artifact_rev)
    if name is not None:
        row.name = name
    if payload is not None:
        row.payload = payload
    row.artifact_rev = expected_rev + 1
    row.updated_by = updated_by
    db.flush()
    return row


def delete_artifact(db: Session, row: ArtifactRow) -> None:
    db.delete(row)
    db.flush()
