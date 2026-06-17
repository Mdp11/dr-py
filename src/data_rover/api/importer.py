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
from pathlib import Path

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.view.schema import View

from . import content, tenancy
from .db import db_session, init_engine
from .db_models import Membership, Project, Role
from .hydration import write_snapshot
from .routes._snapshot import build_model_from_dicts
from .session import Session
from .settings import get_settings


def import_project(
    *,
    project_id: str,
    name: str,
    owner_id: str,
    metamodel_yaml: str,
    model_json: str,
    view_json: str | None = None,
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
        if view_json is not None:
            view = View.model_validate_json(view_json)
            content.upsert_single_view(
                s, project_id, name=view.name, blob=view.model_dump_json()
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
    args = p.parse_args(argv)

    init_engine(get_settings().database_url)
    import_project(
        project_id=args.project_id,
        name=args.name,
        owner_id=args.owner_id,
        metamodel_yaml=args.metamodel.read_text(encoding="utf-8"),
        model_json=args.model.read_text(encoding="utf-8"),
        view_json=args.view.read_text(encoding="utf-8") if args.view else None,
    )
    print(f"Imported project {args.project_id!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
