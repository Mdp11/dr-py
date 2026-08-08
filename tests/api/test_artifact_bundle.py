"""Bundle module tests: envelope schema, dependency closure, plan derivation.

Setup mirrors tests/api/test_content.py: hermetic in-memory SQLite via
db.init_engine + create_all; rows created through content helpers so the
(project, kind, name) unique constraint is live.
"""

from __future__ import annotations

from data_rover.api import content, db
from data_rover.api.artifact_bundle import (
    BUNDLE_FORMAT,
    ArtifactBundle,
    build_bundle,
    compute_closure,
)
from data_rover.api.db_models import ArtifactKind, Project

SNIP = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return el.name\n"}


def _nav(ref: str) -> dict:
    """Minimal valid navigation payload referencing another artifact."""
    return {"kind": "set_op", "op": "union", "operands": [{"ref": ref}]}


def _setup() -> None:
    db.init_engine("sqlite://", force=True)
    db.create_all()
    with db.db_session() as s:
        s.add(Project(id="p1", name="P1"))


def test_closure_follows_chain_and_dedups_diamond() -> None:
    _setup()
    with db.db_session() as s:
        snip = content.create_artifact(
            s, "p1", kind=ArtifactKind.code_snippet, name="s", payload=SNIP, updated_by=None
        )
        nav_a = content.create_artifact(
            s, "p1", kind=ArtifactKind.navigation, name="a", payload=_nav(snip.id), updated_by=None
        )
        nav_b = content.create_artifact(
            s, "p1", kind=ArtifactKind.navigation, name="b", payload=_nav(snip.id), updated_by=None
        )
        res = compute_closure(s, "p1", [nav_a.id, nav_b.id])
        # diamond: both navs depend on the same snippet; it appears ONCE
        assert [r.id for r in res.rows] == [nav_a.id, nav_b.id, snip.id]
        assert res.dangling_refs == []


def test_closure_tolerates_cycles() -> None:
    _setup()
    with db.db_session() as s:
        a = content.create_artifact(
            s, "p1", kind=ArtifactKind.navigation, name="a", payload=_nav("placeholder"), updated_by=None
        )
        b = content.create_artifact(
            s, "p1", kind=ArtifactKind.navigation, name="b", payload=_nav(a.id), updated_by=None
        )
        a_row = content.get_artifact(s, a.id)
        assert a_row is not None
        content.update_artifact(
            s, a_row, expected_rev=a.artifact_rev, payload=_nav(b.id), updated_by=None
        )
        res = compute_closure(s, "p1", [a.id])
        assert {r.id for r in res.rows} == {a.id, b.id}


def test_closure_reports_dangling_and_unknown_roots() -> None:
    _setup()
    with db.db_session() as s:
        nav = content.create_artifact(
            s, "p1", kind=ArtifactKind.navigation, name="a", payload=_nav("ghost"), updated_by=None
        )
        res = compute_closure(s, "p1", [nav.id, "no-such-root"])
        assert [r.id for r in res.rows] == [nav.id]
        assert res.dangling_refs == sorted(["ghost", "no-such-root"])


def test_closure_ignores_other_projects_rows() -> None:
    _setup()
    with db.db_session() as s:
        s.add(Project(id="p2", name="P2"))
        s.flush()
        foreign = content.create_artifact(
            s, "p2", kind=ArtifactKind.code_snippet, name="s", payload=SNIP, updated_by=None
        )
        nav = content.create_artifact(
            s, "p1", kind=ArtifactKind.navigation, name="a", payload=_nav(foreign.id), updated_by=None
        )
        res = compute_closure(s, "p1", [nav.id])
        # a ref crossing projects is dangling, not followed
        assert [r.id for r in res.rows] == [nav.id]
        assert res.dangling_refs == [foreign.id]


def test_build_bundle_roundtrips_through_schema() -> None:
    _setup()
    with db.db_session() as s:
        snip = content.create_artifact(
            s, "p1", kind=ArtifactKind.code_snippet, name="s", payload=SNIP, updated_by=None
        )
        project = s.get(Project, "p1")
        assert project is not None
        res = compute_closure(s, "p1", [snip.id])
        bundle = build_bundle(project, res, [snip.id])
        assert bundle.format == BUNDLE_FORMAT
        assert bundle.source_project.id == "p1"
        assert bundle.roots == [snip.id]
        assert bundle.artifacts[0].kind == "code_snippet"
        # envelope round-trips through JSON (the on-disk form)
        again = ArtifactBundle.model_validate_json(bundle.model_dump_json())
        assert again == bundle


def test_bundle_parses_unknown_kind() -> None:
    # kind is a raw string on the wire: a bundle from a newer server must
    # PARSE here; filtering is the import plan's job, not the schema's.
    bundle = ArtifactBundle.model_validate(
        {
            "format": BUNDLE_FORMAT,
            "exported_at": "2026-08-08T00:00:00+00:00",
            "source_project": {"id": "x", "name": "X"},
            "roots": [],
            "artifacts": [{"id": "a1", "kind": "hologram", "name": "h", "payload": {}}],
        }
    )
    assert bundle.artifacts[0].kind == "hologram"
