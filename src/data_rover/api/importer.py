"""Import new-format artifacts (metamodel.yaml + model.json + view.json) as a
project's durable rev-0 baseline. Reused by the dev-seed and runnable as a CLI:

    python -m data_rover.api.importer --project-id default --name "Smart City" \
        --owner-id default-user --metamodel examples/smart-city.metamodel.yaml \
        --model examples/smart-city.model.json --view examples/smart-city.view.json
"""

from __future__ import annotations

import argparse
import io
import sys
import uuid
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import BinaryIO

from fastapi import HTTPException
from sqlalchemy import insert, literal, select
from sqlalchemy.orm import Session as DbSession

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.view.ids import ensure_folder_ids
from data_rover.core.view.schema import Folder, View

from . import content, tenancy
from .artifact_bundle import (
    ArtifactBundle,
    BundleArtifact,
    ClosureResult,
    SkippedEntry,
    build_bundle,
)
from .artifact_kinds import get_spec, rewrite_refs
from .db import db_session, init_engine
from .db_models import (
    ArtifactKind,
    ElementRow,
    EntityRefRow,
    Membership,
    ModelRow,
    Project,
    RelationshipRow,
    Role,
)
from .hydration import hydrate_session
from .import_stream import ingest_model
from .session import get_registry
from .snapshot_rows import write_snapshot_from_rows
from .settings import get_settings


def _remap_view_artifact_refs(view: View, id_map: Mapping[str, str]) -> None:
    """Rewrite artifact refs in-place through *id_map*; unknown ids stay
    (tolerant-dangler stance, same as payload refs)."""

    def _visit(folder_like: View | Folder) -> None:
        for ref in folder_like.artifacts:
            ref.id = id_map.get(ref.id, ref.id)
        for child in folder_like.folders:
            _visit(child)

    _visit(view)


def _landable_artifacts(
    bundle: ArtifactBundle, *, trusted: bool
) -> tuple[list[tuple[BundleArtifact, ArtifactKind, dict]], list[SkippedEntry]]:
    """Split the bundle into (artifact, kind, payload-as-stored) triples and
    the per-artifact problems that keep one out.

    TWO callers with opposite provenance share this function, which is why the
    filtering is a parameter rather than a constant:

    - *trusted* (``clone_project``): the rows came out of THIS database, are
      already valid, and re-validating them could reject something a clone must
      not lose — a legacy row written before a schema tightened, or an
      unregistered-but-valid-enum kind (``diagram``) no adapter can vet at all.
      A clone is a copy, not a validation gate: verbatim, minus only an unknown
      enum value, which the storage column cannot hold in the first place.
    - untrusted (the New Project wizard's ``artifacts`` part, ``--artifacts``):
      an ARBITRARY uploaded file, held to exactly what a normal write enforces
      — registered kind, adapter-valid payload, server-derived metadata rerun
      (``entry_points`` is never client-trusted) — because whatever lands here
      becomes a persistent row that read routes deserialize on every request.
      An invalid one is not merely ugly: the artifact routes re-validate on
      every read, so it would 500 that artifact forever. Filtering matches
      ``derive_plan``, the third import-from-outside path, so all three accept
      the same bundle; only clone is the deliberate exception, and only because
      its input never left the database.

    Failures are REPORTED and skipped, never raised: a per-artifact problem
    must not cost a user the rest of an import (the tolerant stance
    ``derive_plan`` already takes).
    """
    landable: list[tuple[BundleArtifact, ArtifactKind, dict]] = []
    skipped: list[SkippedEntry] = []
    claimed: set[tuple[ArtifactKind, str]] = set()
    for art in bundle.artifacts:
        try:
            kind = ArtifactKind(art.kind)
        except ValueError:
            skipped.append(
                SkippedEntry(bundle_id=art.id, reason=f"unknown kind {art.kind!r}")
            )
            continue
        payload = art.payload
        if not trusted:
            if not art.name:
                skipped.append(SkippedEntry(bundle_id=art.id, reason="empty name"))
                continue
            spec = get_spec(kind)
            if spec is None:
                skipped.append(
                    SkippedEntry(
                        bundle_id=art.id, reason=f"unregistered kind {art.kind!r}"
                    )
                )
                continue
            try:
                spec.adapter.validate_python(payload)
            except Exception as exc:  # pydantic ValidationError, broad on purpose
                skipped.append(
                    SkippedEntry(bundle_id=art.id, reason=f"invalid payload: {exc}")
                )
                continue
            if spec.derive_metadata is not None:
                payload = dict(payload)
                spec.derive_metadata(payload)
        if (kind, art.name) in claimed:
            # Only an untrusted bundle can carry this (the source DB's
            # uq_artifact_project_kind_name forbids exporting one), and without
            # the guard the second INSERT raises IntegrityError mid-baseline —
            # a 500 out of the wizard, after the project row is already
            # committed. First occurrence in bundle order wins, matching
            # `derive_plan`.
            skipped.append(
                SkippedEntry(
                    bundle_id=art.id, reason="duplicate (kind, name) in bundle"
                )
            )
            continue
        claimed.add((kind, art.name))
        landable.append((art, kind, payload))
    return landable, skipped


def _model_source(model_json: str | bytes | BinaryIO) -> BinaryIO:
    if isinstance(model_json, str):
        return io.BytesIO(model_json.encode("utf-8"))
    if isinstance(model_json, bytes):
        return io.BytesIO(model_json)
    return model_json


def _load_metamodel(metamodel_yaml: str) -> Metamodel:
    try:
        return load_metamodel_str(metamodel_yaml)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"invalid upload: {exc}") from exc


def _parse_bundle(artifact_bundle: str) -> ArtifactBundle:
    # ENVELOPE-only, and deliberately so: a malformed envelope is the whole
    # upload being wrong, while a per-artifact problem must not cost the user
    # the rest of the bundle (see ``_landable_artifacts``).
    try:
        return ArtifactBundle.model_validate_json(artifact_bundle)
    except Exception as exc:
        raise HTTPException(
            status_code=422, detail=f"invalid artifact bundle: {exc}"
        ) from exc


def _parse_views(view_docs: Sequence[str]) -> list[View]:
    views: list[View] = []
    for doc in view_docs:
        try:
            view = View.model_validate_json(doc)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"invalid view: {exc}") from exc
        ensure_folder_ids(view)
        views.append(view)
    return views


def _start_project(
    s: DbSession,
    project_id: str,
    *,
    name: str,
    owner_id: str,
    metamodel_yaml: str,
) -> ModelRow:
    """The project, its owner, its metamodel and its model row at rev 0 with the
    ``import`` commit; the head rows come after."""
    tenancy.upsert_user(s, owner_id, "")
    s.add(Project(id=project_id, name=name))
    s.add(Membership(user_id=owner_id, project_id=project_id, role=Role.owner))
    mm_row = content.create_metamodel(s, name=name, version=1, blob=metamodel_yaml)
    model_row = content.upsert_model_row(s, project_id, metamodel_id=mm_row.id)
    content.append_commit(
        s,
        project_id,
        rev=0,
        commit_id="import",
        author_id=owner_id,
        ops=[],
        inverse_ops=[],
        id_map={},
    )
    content.set_model_rev(s, project_id, 0)
    return model_row


def _land_artifacts_and_views(
    s: DbSession,
    project_id: str,
    *,
    bundle: ArtifactBundle | None,
    trust_artifacts: bool,
    views: Sequence[View],
) -> list[SkippedEntry]:
    """Every landed artifact gets a FRESH id; the map below feeds both the
    payload ref rewrite and the view-blob rewrite. It is built for the landable
    set FIRST so a ref to a sibling resolves regardless of order, and a ref to a
    SKIPPED artifact stays unmapped, i.e. keeps its literal bundle id
    (tolerant-dangler stance). A view is named from its document (``"Default"``
    when blank); a clash inside one import is suffixed rather than refused,
    since a baseline import has no user to answer."""
    artifact_id_map: dict[str, str] = {}
    skipped: list[SkippedEntry] = []
    if bundle is not None:
        landable, skipped = _landable_artifacts(bundle, trusted=trust_artifacts)
        for art, _kind, _payload in landable:
            artifact_id_map[art.id] = uuid.uuid4().hex
        for art, kind, payload in landable:
            content.create_artifact(
                s,
                project_id,
                kind=kind,
                name=art.name,
                payload=rewrite_refs(payload, artifact_id_map),
                updated_by=None,
                artifact_id=artifact_id_map[art.id],
            )
    for view in views:
        if artifact_id_map:
            _remap_view_artifact_refs(view, artifact_id_map)
        base = view.name.strip() or "Default"
        for n in range(1, 1000):
            view.name = base if n == 1 else f"{base} ({n})"
            try:
                content.create_view(
                    s, project_id, name=view.name, blob=view.model_dump_json()
                )
                break
            except content.DuplicateViewNameError:
                continue
    return skipped


def import_project(
    *,
    project_id: str,
    name: str,
    owner_id: str,
    metamodel_yaml: str,
    model_json: str | bytes | BinaryIO,
    view_json: str | None = None,
    view_jsons: Sequence[str] = (),
    artifact_bundle: str | None = None,
    trust_artifacts: bool = False,
) -> list[SkippedEntry]:
    """Create the project baseline. Idempotent: no-op if the project exists.

    ``model_json`` is the model document as text, bytes or a binary file, which
    is streamed (``import_stream.ingest_model``): no ``Model`` is built. The
    project, its rows, its artifacts and its views land in ONE transaction that
    commits only when every check passes; a refusal is a 422
    (``HTTPException``) and leaves no project, no rows and no snapshot. The
    rev-0 snapshot is written after the commit.

    Returns the bundle artifacts that were reported-and-skipped (empty on the
    trusted path in practice). ``trust_artifacts`` defaults to the SAFE side:
    a caller that forgets it gets validation. See :func:`_landable_artifacts`.
    """
    with db_session() as s:
        if s.get(Project, project_id) is not None:
            return []  # already imported
        # the cheap documents first, so a bad one costs no parse of the model
        metamodel = _load_metamodel(metamodel_yaml)
        bundle = _parse_bundle(artifact_bundle) if artifact_bundle is not None else None
        views = _parse_views(
            ([view_json] if view_json is not None else []) + list(view_jsons)
        )
        _start_project(
            s, project_id, name=name, owner_id=owner_id, metamodel_yaml=metamodel_yaml
        )
        ingest_model(s, project_id, metamodel, _model_source(model_json))
        skipped = _land_artifacts_and_views(
            s,
            project_id,
            bundle=bundle,
            trust_artifacts=trust_artifacts,
            views=views,
        )
    # the rev-0 snapshot, after the commit above. Synchronous: hydrating a
    # session reads it, and a session built without one is an empty model.
    write_snapshot_from_rows(project_id)
    return skipped


def _copy_rows(
    s: DbSession,
    table: type[ElementRow] | type[RelationshipRow] | type[EntityRefRow],
    source_id: str,
    project_id: str,
) -> None:
    """``INSERT ... SELECT`` every row of ``source_id`` into ``project_id``."""
    columns = [c.key for c in table.__table__.columns if c.key != "project_id"]
    s.execute(
        insert(table).from_select(
            ["project_id", *columns],
            select(literal(project_id), *(getattr(table, c) for c in columns)).where(
                table.project_id == source_id
            ),
        )
    )


def clone_project(*, source_id: str, project_id: str, name: str, owner_id: str) -> None:
    """Copy a project's CURRENT state into a new project owned by ``owner_id`` at
    a fresh rev-0 baseline; commit history is not carried over.

    The head rows are copied in SQL (no row passes through Python), under the
    source's model-row lock so no commit lands between the statements: the new
    project's rows, digest, counts and ``next_seq`` are the source's. Artifacts
    and views are copied through the importer's landing, which gives each
    artifact a fresh id and remaps the refs to it. One transaction, then the
    rev-0 snapshot."""
    with db_session() as s:
        tenancy.upsert_user(s, owner_id, "")
        src = s.get(Project, source_id)
        if src is None:
            raise HTTPException(status_code=404, detail="project not found")
        source = content.lock_model_row(s, source_id)
        if source is None:
            raise HTTPException(
                status_code=409, detail="project has no content to clone"
            )
        if source.next_seq is None or source.state_digest is None:
            raise HTTPException(
                status_code=409, detail="project has no head rows: re-import it"
            )
        mm_row = content.get_metamodel_row(s, source.metamodel_id)
        if mm_row is None:
            raise HTTPException(status_code=409, detail="project metamodel missing")
        views = _parse_views([r.blob for r in content.list_views(s, source_id)])
        # Every artifact row rides along, VERBATIM: a clone is a copy, not a
        # validation gate, so this deliberately does NOT run `compute_closure`
        # — a closure walk is pointless when every row is a root anyway, and it
        # would drop rows the registry doesn't know (legacy `diagram`).
        rows = content.list_artifacts(s, source_id)
        bundle = (
            _parse_bundle(
                build_bundle(
                    src,
                    ClosureResult(rows=rows, dangling_refs=[]),
                    roots=[r.id for r in rows],
                ).model_dump_json()
            )
            if rows
            else None
        )
        model_row = _start_project(
            s, project_id, name=name, owner_id=owner_id, metamodel_yaml=mm_row.blob
        )
        s.flush()
        for table in (ElementRow, RelationshipRow, EntityRefRow):
            _copy_rows(s, table, source_id, project_id)
        model_row.state_digest = source.state_digest
        model_row.element_count = source.element_count
        model_row.relationship_count = source.relationship_count
        model_row.next_seq = source.next_seq
        _land_artifacts_and_views(
            s,
            project_id,
            bundle=bundle,
            # the ONE trusted caller: this bundle was built from rows two
            # statements ago, so validating it could only reject data a clone
            # is obliged to carry (see _landable_artifacts)
            trust_artifacts=True,
            views=views,
        )
    write_snapshot_from_rows(project_id)


def install_model(
    db: DbSession,
    project_id: str,
    *,
    metamodel_yaml: str,
    model_json: str | bytes | BinaryIO,
) -> None:
    """Replace the project's metamodel and model with these documents at a fresh
    baseline (rev 0, no history).

    One transaction: a refused model (422) leaves the project as it was. A warm
    session's mirror follows the new rows and its feed clients get a reset."""
    metamodel = load_metamodel_str(metamodel_yaml)
    try:
        mm_row = content.create_metamodel(db, name="", version=1, blob=metamodel_yaml)
        content.upsert_model_row(db, project_id, metamodel_id=mm_row.id)
        content.clear_history(db, project_id)
        ingest_model(db, project_id, metamodel, _model_source(model_json))
        content.append_commit(
            db,
            project_id,
            rev=0,
            commit_id="import",
            author_id=None,
            ops=[],
            inverse_ops=[],
            id_map={},
        )
        content.set_model_rev(db, project_id, 0)
        db.commit()
    except BaseException:
        db.rollback()
        raise
    write_snapshot_from_rows(project_id)
    _refresh_mirror(project_id)


def _refresh_mirror(project_id: str) -> None:
    """Bring a warm session's model mirror to the rows just installed, in place,
    so its feed clients and leases stay attached, and tell its feed clients. A
    cold project has no mirror: it hydrates from the rev-0 snapshot when first
    asked. This is the one place the install builds a ``Model``, only while a
    legacy mirror is warm."""
    session = get_registry().peek(project_id)
    if session is None:
        return
    fresh = hydrate_session(project_id)
    with session.write_mutex:
        session.metamodel = fresh.metamodel
        session.model = fresh.model
        session.model_rev = fresh.model_rev
        session.state_digest_value = None
    session.announce_reset()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Import an MBSE project baseline.")
    p.add_argument("--project-id", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--owner-id", required=True)
    p.add_argument("--metamodel", required=True, type=Path)
    p.add_argument("--model", required=True, type=Path)
    p.add_argument("--view", type=Path, default=None)
    p.add_argument("--artifacts", type=Path, default=None)
    args = p.parse_args(argv)

    init_engine(get_settings().database_url)
    # A CLI bundle is a file someone hands the importer, so it goes through the
    # untrusted path (the default) like the wizard's upload. Skips are printed
    # rather than swallowed: this is the only surface a CLI user has.
    with args.model.open("rb") as model_file:
        skipped = import_project(
            project_id=args.project_id,
            name=args.name,
            owner_id=args.owner_id,
            metamodel_yaml=args.metamodel.read_text(encoding="utf-8"),
            model_json=model_file,
            view_json=args.view.read_text(encoding="utf-8") if args.view else None,
            artifact_bundle=args.artifacts.read_text(encoding="utf-8")
            if args.artifacts
            else None,
        )
    print(f"Imported project {args.project_id!r}")
    for entry in skipped:
        print(f"  skipped artifact {entry.bundle_id}: {entry.reason}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
