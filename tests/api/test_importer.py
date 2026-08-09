from __future__ import annotations

import json
from pathlib import Path

from data_rover.api import content, db, hydration, importer
from data_rover.api.db_models import Project, User
from data_rover.api.importer import import_project
from data_rover.api.storage import MemorySnapshotStore, set_snapshot_store

MM = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")
MODEL = Path("examples/smart-city.model.json").read_text(encoding="utf-8")
VIEW = Path("examples/smart-city.view.json").read_text(encoding="utf-8")


def _env():
    db.init_engine("sqlite://", force=True)
    db.create_all()
    set_snapshot_store(MemorySnapshotStore())


def test_import_creates_project_baseline_and_hydrates() -> None:
    _env()
    try:
        importer.import_project(
            project_id="proj", name="Smart City", owner_id="u1",
            metamodel_yaml=MM, model_json=MODEL, view_json=VIEW,
        )
        with db.db_session() as s:
            assert s.get(Project, "proj") is not None
            assert s.get(User, "u1") is not None
            model_row = content.get_model_row(s, "proj")
            assert model_row is not None and model_row.model_rev == 0
            snap = content.latest_snapshot(s, "proj")
            assert snap is not None and snap.rev == 0
        sess = hydration.hydrate_session("proj")
        assert sess.model is not None and len(sess.model.elements) > 0
        assert sess.view is not None
        # the fixture's folders carry no ids at all (an un-migrated blob
        # shape); the importer's ensure_folder_ids call heals them at import
        # time, one of its two entry points alongside hydration
        # (tests/api/test_hydration.py::test_hydration_heals_missing_folder_ids).
        assert all(len(f.id) == 32 for f in sess.view.folders)
    finally:
        set_snapshot_store(None)


def test_import_is_idempotent_noop_when_project_exists() -> None:
    _env()
    try:
        importer.import_project(
            project_id="proj", name="Smart City", owner_id="u1",
            metamodel_yaml=MM, model_json=MODEL,
        )
        importer.import_project(  # second call must not raise or duplicate
            project_id="proj", name="Smart City", owner_id="u1",
            metamodel_yaml=MM, model_json=MODEL,
        )
        with db.db_session() as s:
            row2 = content.get_model_row(s, "proj")
            assert row2 is not None and row2.model_rev == 0
    finally:
        set_snapshot_store(None)


def test_import_project_lands_artifact_bundle_with_remap() -> None:
    _env()
    try:
        snip_payload = {
            "schema_version": 1,
            "language": "python",
            "code": "def value(el):\n    return el.name\n",
        }
        bundle = {
            "format": "datarover.artifact-bundle/v1",
            "exported_at": "2026-08-08T00:00:00+00:00",
            "source_project": {"id": "src", "name": "Source"},
            "roots": ["old-nav"],
            "artifacts": [
                {"id": "old-snip", "kind": "code_snippet", "name": "s", "payload": snip_payload},
                {"id": "old-nav", "kind": "navigation", "name": "n",
                 "payload": {"kind": "set_op", "op": "union", "operands": [{"ref": "old-snip"}]}},
                {"id": "old-diagram", "kind": "diagram", "name": "d", "payload": {"x": 1}},
                {"id": "old-alien", "kind": "hologram", "name": "h", "payload": {}},
            ],
        }
        view_json = json.dumps({
            "name": "V",
            "folders": [{"name": "F", "artifacts": [{"id": "old-nav", "kind": "navigation"}]}],
            "artifacts": [{"id": "old-snip", "kind": "code_snippet"}, {"id": "ghost", "kind": "table"}],
        })
        import_project(
            project_id="pz", name="PZ", owner_id="u1",
            metamodel_yaml=MM, model_json="{}",
            view_json=view_json, artifact_bundle=json.dumps(bundle),
        )
        with db.db_session() as s:
            rows = content.list_artifacts(s, "pz")
            by_name = {r.name: r for r in rows}
            # diagram (valid enum, unregistered) RIDES ALONG; alien kind is skipped
            assert set(by_name) == {"s", "n", "d"}
            assert all(r.id not in {"old-snip", "old-nav", "old-diagram"} for r in rows)  # fresh ids
            # nav payload ref remapped to the snippet's NEW id
            assert by_name["n"].payload["operands"][0]["ref"] == by_name["s"].id
            # view blob refs remapped too; unknown ref left dangling (tolerant)
            view_row = content.get_single_view(s, "pz")
            assert view_row is not None
            view = json.loads(view_row.blob)
            assert view["folders"][0]["artifacts"][0]["id"] == by_name["n"].id
            assert view["artifacts"][0]["id"] == by_name["s"].id
            assert view["artifacts"][1]["id"] == "ghost"
    finally:
        set_snapshot_store(None)
