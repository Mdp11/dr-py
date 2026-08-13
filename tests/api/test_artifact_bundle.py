"""Bundle module tests: envelope schema, dependency closure, plan derivation.

Setup mirrors tests/api/test_content.py: hermetic in-memory SQLite via
db.init_engine + create_all; rows created through content helpers so the
(project, kind, name) unique constraint is live.
"""

from __future__ import annotations

import pytest

from data_rover.api import content, db
from data_rover.api.artifact_bundle import (
    BUNDLE_FORMAT,
    ArtifactBundle,
    StalePlanError,
    build_bundle,
    build_import_ops,
    compute_closure,
    dedupe_name,
    derive_plan,
    derive_plan_ex,
)
from data_rover.api.db_models import ArtifactKind, Project
from data_rover.api.schemas import TEMP_ID_PREFIX

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


#: minimal valid `table` artifact payload — no refs of its own, so it never
#: pulls anything else into a closure built from it.
_TABLE_PAYLOAD = {
    "schema_version": 1,
    "row_source": {"kind": "scope", "types": []},
    "columns": [{"kind": "element"}],
}


def test_custom_export_root_pulls_its_tables_into_the_closure() -> None:
    _setup()
    with db.db_session() as s:
        s.add(Project(id="p2", name="P2"))
        s.flush()

        t1 = content.create_artifact(
            s, "p1", kind=ArtifactKind.table, name="t1", payload=_TABLE_PAYLOAD, updated_by=None
        )
        t2 = content.create_artifact(
            s, "p1", kind=ArtifactKind.table, name="t2", payload=_TABLE_PAYLOAD, updated_by=None
        )
        ce_payload = {
            "schema_version": 1,
            "entries": [
                {"source": {"ref": t1.id}, "name": "a", "format": "xlsx"},
                {"source": {"ref": t2.id}, "name": "b", "format": "json"},
            ],
        }
        custom_export = content.create_artifact(
            s, "p1", kind=ArtifactKind.custom_export, name="export", payload=ce_payload,
            updated_by=None,
        )

        # the custom_export as the ONLY root still pulls both tables in
        # (extract_deps's generic "ref"-key walk over CustomExportDefinition)
        res = compute_closure(s, "p1", [custom_export.id])
        assert {r.id for r in res.rows} == {custom_export.id, t1.id, t2.id}
        assert res.dangling_refs == []

        project = s.get(Project, "p1")
        assert project is not None
        bundle = build_bundle(project, res, [custom_export.id])

        # importing that bundle into a FRESH project (p2, nothing to reuse)
        # proposes "create" for all three and rewrites the custom_export's
        # entries[].source.ref off the sibling tables' temp ids
        plan = derive_plan(s, "p2", bundle)
        assert {e.action for e in plan.entries} == {"create"}
        ops, _reused, _final_names = build_import_ops(plan, bundle, {}, {})

        by_bundle_id = {op.temp_id.removeprefix(TEMP_ID_PREFIX): op for op in ops}
        ce_op = by_bundle_id[custom_export.id]
        assert ce_op.artifact_kind == "custom_export"
        t1_temp = by_bundle_id[t1.id].temp_id
        t2_temp = by_bundle_id[t2.id].temp_id

        refs = {entry["source"]["ref"] for entry in ce_op.payload["entries"]}
        assert refs == {t1_temp, t2_temp}
        # no ref left pointing at the source project's ids
        assert t1.id not in refs and t2.id not in refs


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
        # a reuse entry still reserves a free copy name, so the client can
        # flip it to "copy" at confirm time (see PlanEntry.copy_name)
        assert e.copy_name == "s (2)"


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


def test_plan_skips_empty_name_so_the_op_constructor_is_never_reached() -> None:
    # CreateArtifactOp.name is min_length=1 while BundleArtifact.name is a
    # bare str, so an empty name in an uploaded bundle would blow up inside
    # build_import_ops as an uncaught ValidationError (a 500). The plan is the
    # filter that keeps that unreachable -- and its sibling must still import.
    _setup()
    with db.db_session() as s:
        bundle = _bundle(
            [
                {"id": "b1", "kind": "code_snippet", "name": "", "payload": SNIP},
                {"id": "b2", "kind": "code_snippet", "name": "ok", "payload": SNIP},
            ]
        )
        plan = derive_plan(s, "p1", bundle)
        assert [(sk.bundle_id, sk.reason) for sk in plan.skipped] == [("b1", "empty name")]
        assert [e.bundle_id for e in plan.entries] == ["b2"]
        ops, _reused, final_names = build_import_ops(plan, bundle, {}, {})
        assert [op.name for op in ops] == ["ok"]
        assert final_names == {"b2": "ok"}


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


def test_plan_create_and_copy_never_target_the_same_name() -> None:
    # A has no DB clash, but its OWN name already looks like the dedupe
    # suffix B's copy would otherwise be handed; B clashes (different
    # payload) with an existing "s" row. Both entries would create/land a
    # (kind, name) row when the plan executes, so they must not both target
    # "s (2)" -- the dedupe pool has to know about A's name up front, not
    # just about existing DB rows.
    _setup()
    other = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return 1\n"}
    with db.db_session() as s:
        content.create_artifact(
            s, "p1", kind=ArtifactKind.code_snippet, name="s", payload=SNIP, updated_by=None
        )
        plan = derive_plan(
            s,
            "p1",
            _bundle(
                [
                    {"id": "a", "kind": "code_snippet", "name": "s (2)", "payload": SNIP},
                    {"id": "b", "kind": "code_snippet", "name": "s", "payload": other},
                ]
            ),
        )
        by_id = {e.bundle_id: e for e in plan.entries}
        assert by_id["a"].action == "create"
        assert by_id["b"].action == "copy"
        targets = {by_id["a"].name, by_id["b"].copy_name}
        assert len(targets) == 2, "create and copy entries collided on the same target name"


def test_build_ops_rewrites_sibling_and_reuse_refs() -> None:
    _setup()
    with db.db_session() as s:
        ex_snip = content.create_artifact(
            s, "p1", kind=ArtifactKind.code_snippet, name="s", payload=SNIP, updated_by=None
        )
        bundle = _bundle(
            [
                {"id": "bs", "kind": "code_snippet", "name": "s", "payload": SNIP},
                {"id": "bn", "kind": "navigation", "name": "n", "payload": _nav("bs")},
                {"id": "bm", "kind": "navigation", "name": "m", "payload": _nav("bn")},
            ]
        )
        plan = derive_plan(s, "p1", bundle)
        ops, reused, final_names = build_import_ops(plan, bundle, {}, {})
        # bs proposed reuse -> no op; bn/bm created
        assert [op.temp_id for op in ops] == [f"{TEMP_ID_PREFIX}bn", f"{TEMP_ID_PREFIX}bm"]
        assert reused[0].existing_id == ex_snip.id
        by_temp = {op.temp_id: op for op in ops}
        # bn's ref to the reused snippet points at the EXISTING id
        assert by_temp[f"{TEMP_ID_PREFIX}bn"].payload["operands"][0]["ref"] == ex_snip.id
        # bm's ref to its created sibling points at the sibling's TEMP id
        assert by_temp[f"{TEMP_ID_PREFIX}bm"].payload["operands"][0]["ref"] == f"{TEMP_ID_PREFIX}bn"
        assert final_names == {"bn": "n", "bm": "m"}


def test_build_ops_flip_reuse_to_copy_and_back() -> None:
    _setup()
    with db.db_session() as s:
        content.create_artifact(
            s, "p1", kind=ArtifactKind.code_snippet, name="s", payload=SNIP, updated_by=None
        )
        bundle = _bundle([{"id": "bs", "kind": "code_snippet", "name": "s", "payload": SNIP}])
        plan = derive_plan(s, "p1", bundle)  # proposes reuse
        ops, reused, final_names = build_import_ops(plan, bundle, {"bs": "copy"}, {})
        assert len(ops) == 1 and reused == []
        assert ops[0].name == "s (2)" and final_names == {"bs": "s (2)"}
        # explicit copy_names override wins
        ops2, _, names2 = build_import_ops(plan, bundle, {"bs": "copy"}, {"bs": "mine"})
        assert ops2[0].name == "mine" and names2 == {"bs": "mine"}


def test_build_ops_stale_decisions_raise() -> None:
    _setup()
    other = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return 1\n"}
    with db.db_session() as s:
        bundle = _bundle([{"id": "bs", "kind": "code_snippet", "name": "s", "payload": SNIP}])
        plan = derive_plan(s, "p1", bundle)  # fresh project -> proposes create
        with pytest.raises(StalePlanError):
            build_import_ops(plan, bundle, {"bs": "reuse"}, {})  # no reuse target
        with pytest.raises(StalePlanError):
            build_import_ops(plan, bundle, {"ghost": "create"}, {})  # unknown bundle id
        # decide-and-pin: a "create" decision is only honorable while the name
        # is still free. A peer claiming (kind, name) between plan and confirm
        # flips the FRESH action to reuse (identical payload) or copy
        # (different payload) — both must reject rather than silently create
        # under a now-taken name and trip the unique constraint.
        content.create_artifact(
            s, "p1", kind=ArtifactKind.code_snippet, name="s", payload=SNIP, updated_by=None
        )
        reuse_plan = derive_plan(s, "p1", bundle)
        assert reuse_plan.entries[0].action == "reuse"
        with pytest.raises(StalePlanError):
            build_import_ops(reuse_plan, bundle, {"bs": "create"}, {})
        copy_bundle = _bundle(
            [{"id": "bs", "kind": "code_snippet", "name": "s", "payload": other}]
        )
        copy_plan = derive_plan(s, "p1", copy_bundle)
        assert copy_plan.entries[0].action == "copy"
        with pytest.raises(StalePlanError):
            build_import_ops(copy_plan, copy_bundle, {"bs": "create"}, {})


def test_plan_skips_duplicate_kind_name_inside_the_bundle() -> None:
    # Two bundle artifacts sharing (kind, name) with NOTHING in the DB to
    # clash against: the `existing is None` branch never consults the dedupe
    # pool, so both would propose "create" under the same name and the second
    # op would trip uq_artifact_project_kind_name when the batch lands (a 422
    # the confirm route can only report as an unactionable 409). A legitimate
    # export cannot produce this — the source DB constraint forbids it — so
    # the later one is reported-and-skipped like every other per-artifact
    # problem in an untrusted bundle.
    _setup()
    other = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return 1\n"}
    with db.db_session() as s:
        bundle = _bundle(
            [
                {"id": "b1", "kind": "code_snippet", "name": "dup", "payload": SNIP},
                {"id": "b2", "kind": "code_snippet", "name": "dup", "payload": other},
            ]
        )
        plan = derive_plan(s, "p1", bundle)
        assert [(e.bundle_id, e.action, e.name) for e in plan.entries] == [("b1", "create", "dup")]
        assert [(sk.bundle_id, sk.reason) for sk in plan.skipped] == [
            ("b2", "duplicate (kind, name) in bundle")
        ]
        # ...and the batch that plan builds carries the name exactly once
        ops, _reused, final_names = build_import_ops(plan, bundle, {}, {})
        assert [op.name for op in ops] == ["dup"]
        assert final_names == {"b1": "dup"}


def test_plan_duplicate_is_scoped_per_kind() -> None:
    # the claim set is per (kind, name), not per name: a snippet and a
    # navigation may legitimately share a name
    _setup()
    with db.db_session() as s:
        plan = derive_plan(
            s,
            "p1",
            _bundle(
                [
                    {"id": "b1", "kind": "code_snippet", "name": "x", "payload": SNIP},
                    {"id": "b2", "kind": "navigation", "name": "x", "payload": _nav("b1")},
                ]
            ),
        )
        assert [e.action for e in plan.entries] == ["create", "create"]
        assert plan.skipped == []


def test_build_ops_rejects_a_copy_name_that_is_already_taken() -> None:
    # `copy_names` is the ONE field no plan ever vetted (the client types it
    # into the rename box). Passing it through unchecked hands the applier a
    # guaranteed (kind, name) clash, which the confirm route can only report
    # as a whole-plan 409 whose freshly-derived plan is byte-identical to the
    # one the client already decided against — an unrecoverable loop. Rejected
    # here instead, naming the offending value.
    _setup()
    other = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return 1\n"}
    with db.db_session() as s:
        content.create_artifact(
            s, "p1", kind=ArtifactKind.code_snippet, name="s", payload=SNIP, updated_by=None
        )
        # a row that is NOT in the bundle, so only the DB-derived pool the plan
        # hands over can know its name is taken
        content.create_artifact(
            s, "p1", kind=ArtifactKind.code_snippet, name="taken", payload=other, updated_by=None
        )
        bundle = _bundle([{"id": "bs", "kind": "code_snippet", "name": "s", "payload": other}])
        res = derive_plan_ex(s, "p1", bundle)
        assert res.plan.entries[0].action == "copy"
        with pytest.raises(StalePlanError, match="taken"):
            build_import_ops(res.plan, bundle, {}, {"bs": "taken"}, res.taken_names)
        # the plan's own proposal is of course still honored
        _ops, _reused, names = build_import_ops(res.plan, bundle, {}, {}, res.taken_names)
        assert names == {"bs": "s (2)"}


def test_build_ops_rejects_two_copies_renamed_onto_the_same_name() -> None:
    # batch-local collision: catchable without any DB pool at all
    _setup()
    other1 = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return 1\n"}
    other2 = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return 2\n"}
    with db.db_session() as s:
        content.create_artifact(
            s, "p1", kind=ArtifactKind.code_snippet, name="s", payload=SNIP, updated_by=None
        )
        bundle = _bundle(
            [
                {"id": "b1", "kind": "code_snippet", "name": "s", "payload": other1},
                {"id": "b2", "kind": "code_snippet", "name": "s", "payload": other2},
            ]
        )
        plan = derive_plan(s, "p1", bundle)
        with pytest.raises(StalePlanError, match="mine"):
            build_import_ops(plan, bundle, {}, {"b1": "mine", "b2": "mine"})


def test_build_ops_leaves_refs_to_skipped_artifacts_dangling() -> None:
    # The tolerant-dangler stance, end to end: a payload ref whose target the
    # plan SKIPPED keeps the bundle's literal id. Nothing to point at is not
    # an error — the referencing artifact still imports.
    _setup()
    with db.db_session() as s:
        bundle = _bundle(
            [
                # valid enum, unregistered kind -> skipped by the plan
                {"id": "bd", "kind": "diagram", "name": "d", "payload": {}},
                {"id": "bn", "kind": "navigation", "name": "n", "payload": _nav("bd")},
            ]
        )
        plan = derive_plan(s, "p1", bundle)
        assert [sk.bundle_id for sk in plan.skipped] == ["bd"]
        ops, _reused, _names = build_import_ops(plan, bundle, {}, {})
        assert [op.payload["operands"][0]["ref"] for op in ops] == ["bd"]
