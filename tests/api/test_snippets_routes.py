"""Tests for POST /snippets/run|lint|cancel (Task 11).

**Tripwire note**: conftest pins ``DATA_ROVER_DEV_SEED=false`` (see
conftest.py's env block), which would make ``snippet_runner="trusted"`` fail
the RCE tripwire in ``script_runner.build_runner_from_settings`` (Task 10) if
selected via settings. These tests never touch that settings knob at all —
instead they inject the in-process, sandbox-free ``TrustedRunner`` directly
via FastAPI's dependency-override seam:
``app.dependency_overrides[get_runner] = lambda: TrustedRunner()``. This works
because the route consumes the runner through ``Depends(get_runner)`` (see
routes/snippets.py::run_snippet), which is exactly the seam Task 10 built for
this purpose. The tripwire itself stays untouched and unexercised here.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from data_rover.api import tenancy
from data_rover.api.db import db_session
from data_rover.api.db_models import Role
from data_rover.api.main import create_app
from data_rover.api.script_runner import get_runner
from tests.script.trusted_runner import TrustedRunner

from .conftest import AUTH_HEADERS, papi, seed_default_project

#: One concrete element type with a `name` property, and a containment
#: relationship — mirrors tests/script/conftest.py::tiny_model()'s shape so
#: `dr.element('b1')` etc. address the same kind of fixture the runner's own
#: test suite already exercises.
_MM = """
elements:
  - name: Building
    properties:
      - name: name
        datatype: string
relationships:
  - name: Owns
    containment: true
    source: Building
    target: Building
"""


@pytest.fixture
def app() -> Iterator[FastAPI]:
    """Separate fixture (rather than building it inside `client`) so tests
    that need to swap `get_runner`'s override mid-test (e.g. runner-absent
    503, concurrency 429) can reach `app.dependency_overrides` with a
    properly-typed `FastAPI` object -- `TestClient.app` itself is typed as
    the raw ASGI callable, not `FastAPI`, so pyright rejects
    `client.app.dependency_overrides`."""
    seed_default_project()
    application = create_app()
    application.dependency_overrides[get_runner] = lambda: TrustedRunner()
    yield application
    application.dependency_overrides.clear()


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    c = TestClient(app)
    c.headers.update(AUTH_HEADERS)
    return c


def _seed_model(client: TestClient) -> None:
    """Upload a tiny metamodel + a 3-element model with fixed ids `b1`/`b2`/
    `b3` (mirrors tests/script/conftest.py::tiny_model()), via the same
    house-pattern HTTP upload other route tests use (see
    tests/api/test_commits_route.py, tests/api/test_locks_route.py)."""
    res = client.post(
        papi("/metamodel"),
        content=_MM,
        headers={"content-type": "application/x-yaml"},
    )
    assert res.status_code == 200, res.text
    res = client.post(
        papi("/model"),
        json={
            "elements": [
                {"id": "b1", "type_name": "Building", "properties": {"name": "Building One"}},
                {"id": "b2", "type_name": "Building", "properties": {"name": "Building Two"}},
                {"id": "b3", "type_name": "Building", "properties": {"name": "Building Three"}},
            ],
            "relationships": [
                {
                    "id": "rel1",
                    "type_name": "Owns",
                    "source_id": "b1",
                    "target_id": "b2",
                    "properties": {},
                },
            ],
        },
    )
    assert res.status_code == 200, res.text


def _model_summary(client: TestClient) -> dict:
    r = client.get(papi("/model/summary"))
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def viewer_headers(client: TestClient) -> dict[str, str]:
    """A membership with role=viewer on the default project (mirrors
    tests/api/test_tables_routes.py::viewer_headers)."""
    with db_session() as s:
        tenancy.upsert_user(s, user_id="viewer-1", email="v@example.com")
        tenancy.add_member(s, project_id="default", user_id="viewer-1", role=Role.viewer)
    return {"x-user-id": "viewer-1", "x-user-email": "v@example.com"}


# ---------------------------------------------------------------------------
# lint
# ---------------------------------------------------------------------------


def test_lint_endpoint(client: TestClient) -> None:
    r = client.post(papi("/snippets/lint"), json={"code": "def value(el):\n    return 1\n"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body["entry_points"]) == {"script", "value"}
    assert body["diagnostics"] == []


def test_lint_reports_syntax_error(client: TestClient) -> None:
    r = client.post(papi("/snippets/lint"), json={"code": "def value(el:\n"})
    assert r.status_code == 200, r.text
    diags = r.json()["diagnostics"]
    assert len(diags) == 1
    assert diags[0]["severity"] == "error"


# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------


def test_run_reads_model(client: TestClient) -> None:
    _seed_model(client)
    r = client.post(
        papi("/snippets/run"),
        json={"run_id": "r1", "code": "print(len(list(dr.elements())))"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["error"] is None and body["stdout"].strip().isdigit()
    assert body["stale"] is False


def test_run_records_ops_without_mutating(client: TestClient) -> None:
    _seed_model(client)
    before = _model_summary(client)
    r = client.post(
        papi("/snippets/run"),
        json={"run_id": "r2", "code": "dr.element('b1').delete()"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["ops"] == [{"kind": "delete_element", "id": "b1"}]
    after = _model_summary(client)
    assert before == after  # model untouched -- ops are proposals, not applied


def test_run_exactly_one_of_code_or_artifact_id_422(client: TestClient) -> None:
    _seed_model(client)
    r = client.post(papi("/snippets/run"), json={"run_id": "r3"})
    assert r.status_code == 422, r.text
    r = client.post(
        papi("/snippets/run"),
        json={"run_id": "r4", "code": "pass", "artifact_id": "some-id"},
    )
    assert r.status_code == 422, r.text


def test_run_via_artifact_id(client: TestClient) -> None:
    _seed_model(client)
    r = client.post(
        papi("/artifacts"),
        json={
            "kind": "code_snippet",
            "name": "count",
            "payload": {"code": "print(len(list(dr.elements())))"},
        },
    )
    assert r.status_code == 201, r.text
    artifact_id = r.json()["id"]

    r = client.post(
        papi("/snippets/run"), json={"run_id": "r5", "artifact_id": artifact_id}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["error"] is None
    assert body["stdout"].strip() == "3"


def test_run_artifact_id_not_code_snippet_kind_422(client: TestClient) -> None:
    _seed_model(client)
    r = client.post(
        papi("/artifacts"),
        json={
            "kind": "navigation",
            "name": "nav1",
            "payload": {
                "kind": "path",
                "start": {"kind": "scope", "types": ["Building"]},
                "steps": [],
            },
        },
    )
    assert r.status_code == 201, r.text
    artifact_id = r.json()["id"]

    r = client.post(
        papi("/snippets/run"), json={"run_id": "r6", "artifact_id": artifact_id}
    )
    assert r.status_code == 422, r.text


def test_run_artifact_id_missing_404(client: TestClient) -> None:
    _seed_model(client)
    r = client.post(
        papi("/snippets/run"), json={"run_id": "r7", "artifact_id": "nope"}
    )
    assert r.status_code == 404, r.text


def test_run_no_model_404(client: TestClient) -> None:
    r = client.post(papi("/snippets/run"), json={"run_id": "r8", "code": "pass"})
    assert r.status_code == 404, r.text


def test_run_runner_unavailable_503(client: TestClient, app: FastAPI) -> None:
    _seed_model(client)
    app.dependency_overrides[get_runner] = lambda: None
    r = client.post(papi("/snippets/run"), json={"run_id": "r9", "code": "pass"})
    assert r.status_code == 503, r.text


def test_run_stale_false_on_quiet_run(client: TestClient) -> None:
    _seed_model(client)
    r = client.post(
        papi("/snippets/run"), json={"run_id": "r10", "code": "pass"}
    )
    assert r.status_code == 200, r.text
    assert r.json()["stale"] is False
    assert r.json()["model_rev"] == _model_summary(client)["model_rev"]


def test_run_runtime_error_maps_to_error_out(client: TestClient) -> None:
    _seed_model(client)
    r = client.post(
        papi("/snippets/run"), json={"run_id": "r11", "code": "1 / 0"}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["error"] is not None
    assert body["error"]["kind"] == "runtime"


def test_viewer_can_run_lint_and_cancel(
    client: TestClient, viewer_headers: dict[str, str]
) -> None:
    _seed_model(client)
    r = client.post(
        papi("/snippets/lint"), json={"code": "pass"}, headers=viewer_headers
    )
    assert r.status_code == 200, r.text

    r = client.post(
        papi("/snippets/run"),
        json={"run_id": "r12", "code": "pass"},
        headers=viewer_headers,
    )
    assert r.status_code == 200, r.text

    # cancel their own (already-finished, but registry entries are gone by
    # now -- this exercises the 404-not-403 path: a viewer is authorized to
    # call the endpoint at all, distinct from whether run_id is still live).
    r = client.post(
        papi("/snippets/cancel"), json={"run_id": "r12"}, headers=viewer_headers
    )
    assert r.status_code == 404, r.text  # run already finished/deregistered


# ---------------------------------------------------------------------------
# cancel
# ---------------------------------------------------------------------------


def test_cancel_unknown_run_id_404(client: TestClient) -> None:
    r = client.post(papi("/snippets/cancel"), json={"run_id": "no-such-run"})
    assert r.status_code == 404, r.text


def test_cancel_other_users_run_404(client: TestClient) -> None:
    from data_rover.api.routes import snippets as snippets_route

    token = snippets_route._register_run(
        "default", "owned-by-someone-else", "another-user", lambda: None
    )
    try:
        r = client.post(
            papi("/snippets/cancel"), json={"run_id": "owned-by-someone-else"}
        )
        assert r.status_code == 404, r.text
    finally:
        snippets_route._deregister_run("default", "owned-by-someone-else", token)


def test_cancel_own_active_run_204(client: TestClient) -> None:
    from data_rover.api.routes import snippets as snippets_route

    from .conftest import TEST_USER_ID

    cancelled = []
    token = snippets_route._register_run(
        "default", "mine", TEST_USER_ID, lambda: cancelled.append(True)
    )
    try:
        r = client.post(papi("/snippets/cancel"), json={"run_id": "mine"})
        assert r.status_code == 204, r.text
        assert cancelled == [True]
    finally:
        snippets_route._deregister_run("default", "mine", token)


# ---------------------------------------------------------------------------
# registry collision semantics (reviewer fix: project-scoped keys +
# token-guarded deregistration)
# ---------------------------------------------------------------------------


def test_registry_stale_deregister_does_not_kill_newer_entry() -> None:
    """The race the reviewer walked: user A registers run_id "x"; while A's
    run is in flight, user B (any project) registers the SAME run_id "x" --
    `_register_run`'s last-write-wins semantics silently overwrite A's entry
    with B's. When A's request finishes and calls `_deregister_run` with
    ITS OWN token, that must be a no-op against B's now-live entry -- an
    unconditional pop-by-key would delete B's still-active run, and B's
    subsequent cancel would spuriously 404 while B's run is still running."""
    from data_rover.api.routes import snippets as snippets_route

    snippets_route._active_runs.clear()
    try:
        token_a = snippets_route._register_run("p1", "x", "userA", lambda: None)
        token_b = snippets_route._register_run("p1", "x", "userB", lambda: None)

        # B's registration won (last-register-wins) -- confirmed via the
        # public read path a cancel would use.
        assert snippets_route._active_runs[("p1", "x")] is token_b
        assert snippets_route._active_runs[("p1", "x")].user_id == "userB"

        # A's finally-block deregister uses A's OWN (now-stale) token -- must
        # NOT delete B's live entry.
        snippets_route._deregister_run("p1", "x", token_a)
        assert snippets_route._active_runs.get(("p1", "x")) is token_b
        assert snippets_route._active_runs[("p1", "x")].user_id == "userB"

        # B's own token correctly removes B's own entry.
        snippets_route._deregister_run("p1", "x", token_b)
        assert ("p1", "x") not in snippets_route._active_runs
    finally:
        snippets_route._active_runs.clear()


def test_registry_cross_project_isolation() -> None:
    """Two different projects using the same bare run_id must not collide --
    the registry key is (project_id, run_id), not run_id alone."""
    from data_rover.api.routes import snippets as snippets_route

    snippets_route._active_runs.clear()
    try:
        token_p1 = snippets_route._register_run("p1", "x", "userA", lambda: None)
        token_p2 = snippets_route._register_run("p2", "x", "userB", lambda: None)

        assert snippets_route._active_runs[("p1", "x")] is token_p1
        assert snippets_route._active_runs[("p2", "x")] is token_p2

        snippets_route._deregister_run("p1", "x", token_p1)
        assert ("p1", "x") not in snippets_route._active_runs
        # p2's entry, keyed independently, is untouched.
        assert snippets_route._active_runs[("p2", "x")] is token_p2
    finally:
        snippets_route._active_runs.clear()


# ---------------------------------------------------------------------------
# concurrency guard (Task 10 settings, enforced here)
# ---------------------------------------------------------------------------
#
# A live TestClient/threadpool race is awkward to drive deterministically
# (per the brief's own acknowledgement), so this is a direct unit test on
# `ConcurrencyGuard` -- the class the route calls into -- rather than an
# HTTP-level race. `ConcurrencyGuard` moved to `snippet_concurrency.py`
# (Task 10) so it can be shared with embedded evaluation (`script_eval.py`).


def test_concurrency_guard_global_limit() -> None:
    from data_rover.api.snippet_concurrency import ConcurrencyGuard

    guard = ConcurrencyGuard()
    assert guard.try_acquire("u1", global_limit=1, per_user_limit=5) is True
    assert guard.try_acquire("u2", global_limit=1, per_user_limit=5) is False
    guard.release("u1")
    assert guard.try_acquire("u2", global_limit=1, per_user_limit=5) is True


def test_concurrency_guard_per_user_limit() -> None:
    from data_rover.api.snippet_concurrency import ConcurrencyGuard

    guard = ConcurrencyGuard()
    assert guard.try_acquire("u1", global_limit=5, per_user_limit=1) is True
    assert guard.try_acquire("u1", global_limit=5, per_user_limit=1) is False
    # a different user is unaffected by u1's per-user cap
    assert guard.try_acquire("u2", global_limit=5, per_user_limit=1) is True
    guard.release("u1")
    assert guard.try_acquire("u1", global_limit=5, per_user_limit=1) is True


def test_concurrency_429_over_global_cap(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """End-to-end 429: pre-saturate the module-singleton guard directly (the
    same one the route uses), then confirm the route surfaces 429 rather than
    running -- proves the route actually calls into the shared guard, not
    just that the guard class works in isolation (covered above)."""
    from data_rover.api.snippet_concurrency import concurrency_guard

    _seed_model(client)
    monkeypatch.setenv("DATA_ROVER_SNIPPET_CONCURRENCY", "1")
    assert concurrency_guard.try_acquire(
        "someone-else", global_limit=1, per_user_limit=1
    )
    try:
        r = client.post(
            papi("/snippets/run"), json={"run_id": "r13", "code": "pass"}
        )
        assert r.status_code == 429, r.text
    finally:
        concurrency_guard.release("someone-else")


# ---------------------------------------------------------------------------
# docs (Task 2)
# ---------------------------------------------------------------------------


def test_docs_served_with_facade_limits_and_notes(client: TestClient) -> None:
    resp = client.get(papi("/snippets/docs"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    names = {e["name"] for e in body["facade"]}
    assert "dr.create" in names and "Element.set" in names
    assert all(e["doc"] for e in body["facade"])
    assert set(body["limits"]) == {
        "wall_timeout_s", "memory_bytes", "stdout_bytes",
        "result_repr_bytes", "max_ops", "max_op_bytes", "page_limit",
    }
    assert body["notes"] and all(isinstance(n, str) for n in body["notes"])


def test_docs_limits_mirror_settings(client: TestClient, app: FastAPI) -> None:
    from data_rover.api.settings import Settings, get_settings

    app.dependency_overrides[get_settings] = lambda: Settings(
        snippet_wall_timeout_s=3.5, snippet_max_ops=7
    )
    try:
        body = client.get(papi("/snippets/docs")).json()
    finally:
        app.dependency_overrides.pop(get_settings)
    assert body["limits"]["wall_timeout_s"] == 3.5
    assert body["limits"]["max_ops"] == 7


def test_docs_need_membership(client: TestClient) -> None:
    resp = client.get(
        papi("/snippets/docs"),
        headers={"x-user-id": "stranger", "x-user-email": "s@x.io"},
    )
    assert resp.status_code == 403, resp.text


# ---------------------------------------------------------------------------
# element_ids (Task 2 of the multi-element-value spec)
# ---------------------------------------------------------------------------


def test_run_value_multi_element(client: TestClient) -> None:
    """`value` receives ALL bound elements as a list, in request order."""
    _seed_model(client)
    r = client.post(
        papi("/snippets/run"),
        json={
            "run_id": "rv1",
            "code": "def value(elements):\n    return [e.id for e in elements]\n",
            "entry": "value",
            "element_ids": ["b2", "b1"],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["error"] is None
    assert body["result_repr"] == "['b2', 'b1']"


def test_run_value_requires_element_ids_422(client: TestClient) -> None:
    r = client.post(
        papi("/snippets/run"),
        json={"run_id": "rv2", "code": "def value(elements):\n    return 1\n", "entry": "value"},
    )
    assert r.status_code == 422, r.text


def test_run_step_requires_exactly_one_element_id_422(client: TestClient) -> None:
    for ids in ([], ["b1", "b2"]):
        r = client.post(
            papi("/snippets/run"),
            json={
                "run_id": "rs1",
                "code": "def step(el):\n    return el.id\n",
                "entry": "step",
                "element_ids": ids,
            },
        )
        assert r.status_code == 422, r.text


def test_run_step_single_element(client: TestClient) -> None:
    _seed_model(client)
    r = client.post(
        papi("/snippets/run"),
        json={
            "run_id": "rs2",
            "code": "def step(el):\n    return el.id\n",
            "entry": "step",
            "element_ids": ["b1"],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["result_repr"] == "'b1'"


def test_run_script_ignores_element_ids(client: TestClient) -> None:
    """`script` runs ignore `element_ids` entirely — no count validation."""
    _seed_model(client)
    r = client.post(
        papi("/snippets/run"),
        json={
            "run_id": "rsc1",
            "code": "result = len(list(dr.elements()))",
            "entry": "script",
            "element_ids": ["b1", "b2"],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["result_repr"] == "3"


# ---------------------------------------------------------------------------
# read-only entry mapping (Task 7): routes/snippets.py's
# record_ops=(payload.entry == "script") -- SECURITY TRIPWIRE, see module
# note at the top of this file and the Task 7 brief. `value`/`step` console
# runs must be blocked with zero recorded ops, exactly like the embedded
# (open_session) path's record_ops=False.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("entry", ["value", "step"])
def test_run_value_and_step_entries_are_read_only(
    client: TestClient, entry: str
) -> None:
    """Pins routes/snippets.py's record_ops=(entry == "script") mapping: a
    value/step console run carrying a write must be blocked with zero ops.

    `element_ids=["b1"]` satisfies RunIn's per-entry count validator (value
    needs >=1, step needs exactly 1) so the request reaches the runner rather
    than 422ing before the mapping under test is ever exercised."""
    _seed_model(client)
    before = _model_summary(client)
    code = f"def {entry}(x):\n    return dr.create('Building', {{}})"
    r = client.post(
        papi("/snippets/run"),
        json={
            "run_id": f"ro-{entry}",
            "code": code,
            "entry": entry,
            "element_ids": ["b1"],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["error"] is not None
    assert "ReadOnly" in body["error"]["message"]
    assert body["ops"] == []
    assert _model_summary(client) == before
