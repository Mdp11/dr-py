"""Import new-format artifacts (metamodel.yaml + model.json + view.json) as a
project's durable rev-0 baseline. Reused by the dev-seed and runnable as a CLI:

    python -m data_rover.api.importer --project-id default --name "Smart City" \
        --owner-id default-user --metamodel examples/smart-city.metamodel.yaml \
        --model examples/smart-city.model.json --view examples/smart-city.view.json
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from collections.abc import Mapping, Sequence
from pathlib import Path

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.view.ids import ensure_folder_ids
from data_rover.core.view.schema import Folder, View

from . import content, tenancy
from .artifact_bundle import ArtifactBundle, BundleArtifact, SkippedEntry
from .artifact_kinds import get_spec, rewrite_refs
from .db import db_session, init_engine
from .db_models import ArtifactKind, Membership, Project, Role
from .hydration import write_snapshot
from .routes._snapshot import build_model_from_dicts
from .session import Session
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
      An invalid one is not merely ugly: ``routes/tables.py`` re-validates on
      every read, so it would 500 that table forever. Filtering matches
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


def import_project(
    *,
    project_id: str,
    name: str,
    owner_id: str,
    metamodel_yaml: str,
    model_json: str,
    view_json: str | None = None,
    view_jsons: Sequence[str] = (),
    artifact_bundle: str | None = None,
    trust_artifacts: bool = False,
) -> list[SkippedEntry]:
    """Create the project baseline. Idempotent: no-op if the project exists.

    Returns the bundle artifacts that were reported-and-skipped (empty on the
    trusted path in practice). ``trust_artifacts`` defaults to the SAFE side:
    a caller that forgets it gets validation, and only ``clone_project`` — the
    one caller whose bundle never left this database — opts out. See
    :func:`_landable_artifacts`.
    """
    with db_session() as s:
        if s.get(Project, project_id) is not None:
            return []  # already imported
        tenancy.upsert_user(s, owner_id, "")
        s.add(Project(id=project_id, name=name))
        s.add(Membership(user_id=owner_id, project_id=project_id, role=Role.owner))
        mm_row = content.create_metamodel(s, name=name, version=1, blob=metamodel_yaml)
        content.upsert_model_row(s, project_id, metamodel_id=mm_row.id)
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

        # Every landed artifact gets a FRESH id; the map below feeds both the
        # payload ref rewrite here and the view-blob rewrite further down. It
        # is built for the landable set FIRST so a ref to a sibling resolves
        # regardless of order — and a ref to a SKIPPED artifact stays unmapped,
        # i.e. keeps its literal bundle id (tolerant-dangler stance).
        artifact_id_map: dict[str, str] = {}
        skipped: list[SkippedEntry] = []
        if artifact_bundle is not None:
            bundle = ArtifactBundle.model_validate_json(artifact_bundle)
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

        # ``view_json`` is the one-file convenience (CLI / wizard); ``view_jsons``
        # carries a clone's whole set. Each view is named from its document
        # (``"Default"`` when blank); a clash inside one import is suffixed
        # rather than refused, since a baseline import has no user to answer.
        for doc in ([view_json] if view_json is not None else []) + list(view_jsons):
            view = View.model_validate_json(doc)
            ensure_folder_ids(view)
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

    # build the model + write the rev-0 snapshot (outside the txn above; the
    # commit/model rows are already durable and the snapshot row is its own).
    metamodel = load_metamodel_str(metamodel_yaml)
    model = build_model_from_dicts(metamodel, json.loads(model_json))
    sess = Session(metamodel=metamodel, model=model)
    sess.model_rev = 0
    write_snapshot(project_id, sess, 0)
    return skipped


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
    skipped = import_project(
        project_id=args.project_id,
        name=args.name,
        owner_id=args.owner_id,
        metamodel_yaml=args.metamodel.read_text(encoding="utf-8"),
        model_json=args.model.read_text(encoding="utf-8"),
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
