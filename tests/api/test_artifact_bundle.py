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
    dedupe_name,
    derive_plan,
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


def _bundle(artifacts: list[dict]) -> ArtifactBundle:
    return ArtifactBundle.model_validate(
        {
            "format": BUNDLE_FORMAT,
            "exported_at": "2026-08-08T00:00:00+00:00",
            "source_project": {"id": "src", "name": "Source"},
            "roots": [a["id"] for a in artifacts],
            "artifacts": artifacts,
        }
    )


def test_dedupe_name_first_free_suffix() -> None:
    assert dedupe_name(set(), "T") == "T (2)"
    assert dedupe_name({"T (2)"}, "T") == "T (3)"
    assert dedupe_name({"T (2)", "T (3)"}, "T") == "T (4)"


def test_plan_no_clash_proposes_create() -> None:
    _setup()
    with db.db_session() as s:
        plan = derive_plan(
            s, "p1", _bundle([{"id": "b1", "kind": "code_snippet", "name": "fresh", "payload": SNIP}])
        )
        assert len(plan.entries) == 1
        e = plan.entries[0]
        assert (e.bundle_id, e.action, e.existing_id, e.copy_name) == ("b1", "create", None, None)
        assert plan.skipped == []


def test_plan_identical_payload_proposes_reuse() -> None:
    _setup()
    with db.db_session() as s:
        existing = content.create_artifact(
            s, "p1", kind=ArtifactKind.code_snippet, name="s", payload=SNIP, updated_by=None
        )
        plan = derive_plan(
            s, "p1", _bundle([{"id": "b1", "kind": "code_snippet", "name": "s", "payload": SNIP}])
        )
        e = plan.entries[0]
        assert e.action == "reuse"
        assert e.existing_id == existing.id


def test_plan_different_payload_proposes_copy_with_deduped_name() -> None:
    _setup()
    other = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return 1\n"}
    with db.db_session() as s:
        content.create_artifact(
            s, "p1", kind=ArtifactKind.code_snippet, name="s", payload=SNIP, updated_by=None
        )
        plan = derive_plan(
            s, "p1", _bundle([{"id": "b1", "kind": "code_snippet", "name": "s", "payload": other}])
        )
        e = plan.entries[0]
        assert e.action == "copy"
        assert e.copy_name == "s (2)"


def test_plan_reuse_respects_ref_normalization() -> None:
    # nav in the bundle references the bundle SNIPPET id; the existing nav
    # references the existing snippet id. After rewriting through the
    # tentative reuse map the payloads are identical -> both propose reuse.
    _setup()
    with db.db_session() as s:
        ex_snip = content.create_artifact(
            s, "p1", kind=ArtifactKind.code_snippet, name="s", payload=SNIP, updated_by=None
        )
        content.create_artifact(
            s, "p1", kind=ArtifactKind.navigation, name="n", payload=_nav(ex_snip.id), updated_by=None
        )
        plan = derive_plan(
            s,
            "p1",
            _bundle(
                [
                    {"id": "bs", "kind": "code_snippet", "name": "s", "payload": SNIP},
                    {"id": "bn", "kind": "navigation", "name": "n", "payload": _nav("bs")},
                ]
            ),
        )
        assert {e.bundle_id: e.action for e in plan.entries} == {"bs": "reuse", "bn": "reuse"}


def test_plan_skips_unknown_kind_and_invalid_payload() -> None:
    _setup()
    with db.db_session() as s:
        plan = derive_plan(
            s,
            "p1",
            _bundle(
                [
                    {"id": "b1", "kind": "hologram", "name": "h", "payload": {}},
                    {"id": "b2", "kind": "diagram", "name": "d", "payload": {}},
                    {"id": "b3", "kind": "code_snippet", "name": "bad", "payload": {"nope": 1}},
                ]
            ),
        )
        assert plan.entries == []
        reasons = {sk.bundle_id: sk.reason for sk in plan.skipped}
        assert "b1" in reasons and "b2" in reasons and "b3" in reasons


def test_plan_two_copies_same_base_name_get_distinct_names() -> None:
    # two bundle artifacts of the same kind whose names both clash with
    # existing rows must not be handed the SAME deduped name
    _setup()
    other1 = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return 1\n"}
    other2 = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return 2\n"}
    with db.db_session() as s:
        content.create_artifact(
            s, "p1", kind=ArtifactKind.code_snippet, name="s", payload=SNIP, updated_by=None
        )
        plan = derive_plan(
            s,
            "p1",
            _bundle(
                [
                    {"id": "b1", "kind": "code_snippet", "name": "s", "payload": other1},
                    {"id": "b2", "kind": "code_snippet", "name": "s", "payload": other2},
                ]
            ),
        )
        names = [e.copy_name for e in plan.entries]
        assert len(names) == 2 and len(set(names)) == 2
