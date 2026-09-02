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
        (view,) = sess.views.values()  # one view, named from the document
        assert view.name == "Operational"
        # the fixture's folders carry no ids at all (an un-migrated blob
        # shape); the importer's ensure_folder_ids call heals them at import
        # time, one of its two entry points alongside hydration
        # (tests/api/test_hydration.py::test_hydration_heals_missing_folder_ids).
        assert all(len(f.id) == 32 for f in view.folders)
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


def test_trusted_import_lands_artifact_bundle_verbatim_with_remap() -> None:
    # trust_artifacts=True is the CLONE path: rows came out of this DB, are
    # already valid, and re-validating them could reject a legacy row a clone
    # must not lose. Verbatim copy, unregistered kinds ride along.
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
            trust_artifacts=True,
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
            (view_row,) = content.list_views(s, "pz")
            assert view_row.name == "V"
            view = json.loads(view_row.blob)
            assert view["folders"][0]["artifacts"][0]["id"] == by_name["n"].id
            assert view["artifacts"][0]["id"] == by_name["s"].id
            assert view["artifacts"][1]["id"] == "ghost"
    finally:
        set_snapshot_store(None)


def _untrusted_bundle() -> str:
    """One artifact per untrusted-import failure mode, plus the two that must
    survive: a landable snippet and a nav that references a SKIPPED one."""
    snip = {
        "schema_version": 1,
        "language": "python",
        "code": "def value(el):\n    return el.name\n",
        # client-supplied and deliberately wrong: entry_points is server-owned
        "entry_points": ["script", "step", "bogus"],
    }
    return json.dumps({
        "format": "datarover.artifact-bundle/v1",
        "exported_at": "2026-08-08T00:00:00+00:00",
        "source_project": {"id": "src", "name": "Source"},
        "roots": [],
        "artifacts": [
            {"id": "b-snip", "kind": "code_snippet", "name": "s", "payload": snip},
            {"id": "b-nav", "kind": "navigation", "name": "n",
             "payload": {"kind": "set_op", "op": "union", "operands": [{"ref": "b-snip"}]}},
            # schema-invalid table: landing it would 500 every GET /tables read
            {"id": "b-table", "kind": "table", "name": "t", "payload": {"nope": 1}},
            # over the 64 KiB code cap the normal write path enforces
            {"id": "b-huge", "kind": "code_snippet", "name": "big",
             "payload": {"schema_version": 1, "language": "python", "code": "#" * (64 * 1024 + 1)}},
            # valid enum but unregistered: no adapter, so nothing can vet it
            {"id": "b-diagram", "kind": "diagram", "name": "d", "payload": {"x": 1}},
            {"id": "b-alien", "kind": "hologram", "name": "h", "payload": {}},
            {"id": "b-empty", "kind": "code_snippet", "name": "", "payload": snip},
            # same (kind, name) as b-snip -> IntegrityError (a 500) if landed
            {"id": "b-dup", "kind": "code_snippet", "name": "s", "payload": snip},
            # references an artifact this import SKIPS
            {"id": "b-ghost", "kind": "navigation", "name": "g",
             "payload": {"kind": "set_op", "op": "union", "operands": [{"ref": "b-table"}]}},
        ],
    })


def test_untrusted_import_validates_derives_and_skips_tolerantly() -> None:
    # The wizard/CLI path takes an ARBITRARY uploaded file, so it runs the
    # registered kind's adapter + derive_metadata and reports-and-skips what
    # fails. Nothing here may raise: tolerant skip, never a hard failure.
    _env()
    try:
        skipped = import_project(
            project_id="pu", name="PU", owner_id="u1",
            metamodel_yaml=MM, model_json="{}",
            artifact_bundle=_untrusted_bundle(),
        )
        assert {sk.bundle_id for sk in skipped} == {
            "b-table", "b-huge", "b-diagram", "b-alien", "b-empty", "b-dup"
        }
        reasons = {sk.bundle_id: sk.reason for sk in skipped}
        assert reasons["b-diagram"] == "unregistered kind 'diagram'"
        assert reasons["b-alien"] == "unknown kind 'hologram'"
        assert reasons["b-empty"] == "empty name"
        assert reasons["b-dup"] == "duplicate (kind, name) in bundle"
        assert reasons["b-table"].startswith("invalid payload:")
        with db.db_session() as s:
            by_name = {r.name: r for r in content.list_artifacts(s, "pu")}
            assert set(by_name) == {"s", "n", "g"}
            # entry_points is server-derived, never client-trusted
            assert by_name["s"].payload["entry_points"] == ["script", "value"]
            assert by_name["n"].payload["operands"][0]["ref"] == by_name["s"].id
            # a ref to a SKIPPED artifact survives as the literal bundle id
            # (tolerant-dangler stance) rather than dropping its holder
            assert by_name["g"].payload["operands"][0]["ref"] == "b-table"
    finally:
        set_snapshot_store(None)


def test_untrusted_import_is_the_default() -> None:
    # the safe path is what a caller gets by forgetting the flag
    _env()
    try:
        assert [sk.bundle_id for sk in import_project(
            project_id="pd", name="PD", owner_id="u1",
            metamodel_yaml=MM, model_json="{}",
            artifact_bundle=json.dumps({
                "format": "datarover.artifact-bundle/v1",
                "exported_at": "2026-08-08T00:00:00+00:00",
                "source_project": {"id": "src", "name": "Source"},
                "roots": [],
                "artifacts": [{"id": "b1", "kind": "diagram", "name": "d", "payload": {}}],
            }),
        )] == ["b1"]
        with db.db_session() as s:
            assert content.list_artifacts(s, "pd") == []
    finally:
        set_snapshot_store(None)
