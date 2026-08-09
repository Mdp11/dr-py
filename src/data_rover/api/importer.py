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
from collections.abc import Mapping
from pathlib import Path

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.view.ids import ensure_folder_ids
from data_rover.core.view.schema import Folder, View

from . import content, tenancy
from .artifact_bundle import ArtifactBundle, BundleArtifact
from .artifact_kinds import rewrite_refs
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


def import_project(
    *,
    project_id: str,
    name: str,
    owner_id: str,
    metamodel_yaml: str,
    model_json: str,
    view_json: str | None = None,
    artifact_bundle: str | None = None,
) -> None:
    """Create the project baseline. Idempotent: no-op if the project exists."""
    with db_session() as s:
        if s.get(Project, project_id) is not None:
            return  # already imported
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

        # Baseline import is a VERBATIM copy of the bundle, not a
        # registry-filtered import: an unregistered-but-valid-enum kind
        # (`diagram`) must ride along so a clone never loses data. Only an
        # unknown enum value is skipped, because the storage column requires
        # the enum — such a kind cannot become a row at all. Every landed
        # artifact gets a FRESH id; the map below feeds both the payload
        # ref rewrite here and the view-blob rewrite below.
        artifact_id_map: dict[str, str] = {}
        if artifact_bundle is not None:
            bundle = ArtifactBundle.model_validate_json(artifact_bundle)
            landable: list[tuple[BundleArtifact, ArtifactKind]] = []
            for art in bundle.artifacts:
                try:
                    kind = ArtifactKind(art.kind)
                except ValueError:
                    continue
                artifact_id_map[art.id] = uuid.uuid4().hex
                landable.append((art, kind))
            for art, kind in landable:
                content.create_artifact(
                    s,
                    project_id,
                    kind=kind,
                    name=art.name,
                    payload=rewrite_refs(art.payload, artifact_id_map),
                    updated_by=None,
                    artifact_id=artifact_id_map[art.id],
                )

        if view_json is not None:
            view = View.model_validate_json(view_json)
            ensure_folder_ids(view)
            if artifact_id_map:
                _remap_view_artifact_refs(view, artifact_id_map)
            content.upsert_single_view(
                s,
                project_id,
                name=view.name,
                blob=view.model_dump_json(),
                bump_rev=False,  # a baseline import starts at rev 0, like model_rev
            )

    # build the model + write the rev-0 snapshot (outside the txn above; the
    # commit/model rows are already durable and the snapshot row is its own).
    metamodel = load_metamodel_str(metamodel_yaml)
    model = build_model_from_dicts(metamodel, json.loads(model_json))
    sess = Session(metamodel=metamodel, model=model)
    sess.model_rev = 0
    write_snapshot(project_id, sess, 0)


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
    import_project(
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
