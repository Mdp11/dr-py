"""HTTP tests for the bundle routes: export, preview, import plan, confirm."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db, tenancy
from data_rover.api.artifact_bundle import BUNDLE_FORMAT
from data_rover.api.db_models import Role
from data_rover.api.feed import reset_loop
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID

from .conftest import AUTH_HEADERS, feed_url, papi, seed_default_project

SNIP = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return el.name\n"}

_MM = """
elements:
  - name: Node
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    reset_loop()  # each TestClient creates its own event loop; clear the cached one
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    # Import confirm lands its batch through POST /commits, which requires a
    # loaded metamodel + model (require_model) and a durable model row to
    # journal against — so the fixture seeds both, mirroring
    # tests/api/test_commits_artifact_ops.py. Export/plan tests don't care.
    r = c.post(
        papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"}
    )
    assert r.status_code == 200, r.text
    r = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert r.status_code == 200, r.text
    return c


def _mk(client: TestClient, kind: str, name: str, payload: dict) -> dict:
    r = client.post(
        papi("/artifacts"),
        json={"kind": kind, "name": name, "payload": payload},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 201, r.text
    return r.json()


def _nav(ref: str) -> dict:
    return {"kind": "set_op", "op": "union", "operands": [{"ref": ref}]}


def test_export_computes_closure_and_streams_bundle(client: TestClient) -> None:
    snip = _mk(client, "code_snippet", "s", SNIP)
    nav = _mk(client, "navigation", "n", _nav(snip["id"]))
    r = client.post(
        papi("/artifacts/export"), json={"root_ids": [nav["id"]]}, headers=AUTH_HEADERS
    )
    assert r.status_code == 200, r.text
    assert "attachment" in r.headers.get("content-disposition", "")
    bundle = r.json()
    assert bundle["format"] == BUNDLE_FORMAT
    assert bundle["roots"] == [nav["id"]]
    assert {a["id"] for a in bundle["artifacts"]} == {nav["id"], snip["id"]}


def test_export_preview_metadata_only(client: TestClient) -> None:
    snip = _mk(client, "code_snippet", "s", SNIP)
    nav = _mk(client, "navigation", "n", _nav(snip["id"]))
    r = client.post(
        papi("/artifacts/export/preview"),
        json={"root_ids": [nav["id"], "ghost"]},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert {a["id"] for a in body["artifacts"]} == {nav["id"], snip["id"]}
    assert body["dangling_refs"] == ["ghost"]
    assert all("payload" not in a for a in body["artifacts"])


def test_export_all_unknown_roots_yields_empty_bundle(client: TestClient) -> None:
    r = client.post(
        papi("/artifacts/export"), json={"root_ids": ["nope"]}, headers=AUTH_HEADERS
    )
    assert r.status_code == 200
    assert r.json()["artifacts"] == []


def _seed_viewer() -> dict[str, str]:
    """Make 'viewer-user' a viewer of the DEFAULT project (papi() targets it,
    unlike tests/api/test_authz.py's throwaway one) and return its headers.

    The email header must be part of the returned dict, not left out: httpx
    merges a per-request `headers=` dict with the client's default headers
    rather than replacing them, so omitting it would leak the fixture's
    `AUTH_HEADERS["x-user-email"]` onto the viewer's auto-provisioned row and
    collide with the owner's existing (unique) email.
    """
    gen = db.get_db()
    s = next(gen)
    try:
        tenancy.upsert_user(s, "viewer-user", "")
        tenancy.add_member(s, DEFAULT_PROJECT_ID, "viewer-user", Role.viewer)
    finally:
        gen.close()
    return {"x-user-id": "viewer-user", "x-user-email": "viewer@example.com"}


def test_viewer_can_export_and_preview(client: TestClient) -> None:
    # read-only allowlist: a viewer's POST to export/preview must not 403.
    viewer_headers = _seed_viewer()

    r = client.post(
        papi("/artifacts/export"), json={"root_ids": []}, headers=viewer_headers
    )
    assert r.status_code == 200, r.text

    r = client.post(
        papi("/artifacts/export/preview"), json={"root_ids": []}, headers=viewer_headers
    )
    assert r.status_code == 200, r.text
    # The write side of the same coin (POST /artifacts/import/plan and
    # /artifacts/import both 403) is pinned by
    # test_import_plan_is_a_write_for_viewers and test_viewer_403_on_import.


def _bundle_body(artifacts: list[dict]) -> dict:
    return {
        "format": BUNDLE_FORMAT,
        "exported_at": "2026-08-08T00:00:00+00:00",
        "source_project": {"id": "src", "name": "Source"},
        "roots": [a["id"] for a in artifacts],
        "artifacts": artifacts,
    }


def test_import_plan_mixed_actions(client: TestClient) -> None:
    _mk(client, "code_snippet", "s", SNIP)
    other = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return 1\n"}
    r = client.post(
        papi("/artifacts/import/plan"),
        json=_bundle_body(
            [
                {"id": "b1", "kind": "code_snippet", "name": "s", "payload": SNIP},
                {"id": "b2", "kind": "code_snippet", "name": "s2", "payload": other},
                {"id": "b3", "kind": "hologram", "name": "h", "payload": {}},
            ]
        ),
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text
    plan = r.json()
    actions = {e["bundle_id"]: e["action"] for e in plan["entries"]}
    assert actions == {"b1": "reuse", "b2": "create"}
    assert [sk["bundle_id"] for sk in plan["skipped"]] == ["b3"]


def test_import_plan_malformed_envelope_422(client: TestClient) -> None:
    r = client.post(
        papi("/artifacts/import/plan"),
        json={"format": "wrong/v9", "artifacts": []},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 422


def test_import_plan_is_a_write_for_viewers(client: TestClient) -> None:
    # /artifacts/import/plan is NOT in the read-only allowlist (spec decision:
    # planning is part of the write flow). Expect 403.
    viewer_headers = _seed_viewer()

    r = client.post(
        papi("/artifacts/import/plan"),
        json=_bundle_body([]),
        headers=viewer_headers,
    )
    assert r.status_code == 403, r.text


def _rev(client: TestClient) -> int:
    rev: int = client.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]
    return rev


def _import_body(artifacts: list[dict], **extra: object) -> dict:
    return {"bundle": _bundle_body(artifacts), **extra}


#: the bundle every confirm test below imports: one snippet that will be
#: reused (identical payload to a pre-created row) plus one nav that refers
#: to it and will therefore be created with a rewritten ref.
_REUSE_AND_CREATE = [
    {"id": "bs", "kind": "code_snippet", "name": "s", "payload": SNIP},
    {"id": "bn", "kind": "navigation", "name": "n", "payload": _nav("bs")},
]


def test_import_confirm_lands_one_commit(client: TestClient) -> None:
    ex_snip = _mk(client, "code_snippet", "s", SNIP)
    rev0 = _rev(client)
    body = _import_body(_REUSE_AND_CREATE, decisions={}, message="")
    r = client.post(papi("/artifacts/import"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["rev"] == rev0 + 1 and _rev(client) == rev0 + 1  # exactly one commit
    assert out["reused"] == [{"bundle_id": "bs", "existing_id": ex_snip["id"]}]
    [c] = out["created"]
    assert c["bundle_id"] == "bn" and c["name"] == "n"
    # the created nav's ref points at the EXISTING snippet id
    nav = client.get(papi(f"/artifacts/{c['id']}"), headers=AUTH_HEADERS).json()
    assert nav["payload"]["operands"][0]["ref"] == ex_snip["id"]
    # journaled with the default message
    hist = client.get(papi("/commits"), headers=AUTH_HEADERS).json()["commits"]
    assert hist[0]["rev"] == out["rev"]
    assert hist[0]["message"] == "Imported 1 artifacts from Source"
    # diff renders and undo reverts (journal-only artifact commit)
    assert client.get(papi(f"/commits/{out['rev']}/diff"), headers=AUTH_HEADERS).status_code == 200
    undo = client.post(papi("/model/undo"), headers=AUTH_HEADERS)
    assert undo.status_code == 200, undo.text
    assert client.get(papi(f"/artifacts/{c['id']}"), headers=AUTH_HEADERS).status_code == 404
    # the REUSED row is untouched by the undo — it was never this import's
    assert client.get(papi(f"/artifacts/{ex_snip['id']}"), headers=AUTH_HEADERS).status_code == 200


def test_import_confirm_all_reuse_is_noop_without_commit(client: TestClient) -> None:
    _mk(client, "code_snippet", "s", SNIP)
    rev0 = _rev(client)
    body = _import_body([{"id": "bs", "kind": "code_snippet", "name": "s", "payload": SNIP}])
    r = client.post(papi("/artifacts/import"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    assert r.json()["rev"] is None
    assert _rev(client) == rev0  # no commit minted


def test_import_confirm_skipped_entries_reported_without_commit(
    client: TestClient,
) -> None:
    # all-skipped is the OTHER never-mint-an-empty-batch path
    body = _import_body([{"id": "b1", "kind": "hologram", "name": "h", "payload": {}}])
    rev0 = _rev(client)
    r = client.post(papi("/artifacts/import"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["rev"] is None and out["created"] == []
    assert [sk["bundle_id"] for sk in out["skipped"]] == ["b1"]
    assert _rev(client) == rev0


def test_import_confirm_copy_decision_renames(client: TestClient) -> None:
    _mk(client, "code_snippet", "s", SNIP)
    body = _import_body(
        [{"id": "bs", "kind": "code_snippet", "name": "s", "payload": SNIP}],
        decisions={"bs": "copy"},
    )
    r = client.post(papi("/artifacts/import"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["reused"] == []
    [c] = out["created"]
    assert c["name"] == "s (2)"
    got = client.get(papi(f"/artifacts/{c['id']}"), headers=AUTH_HEADERS).json()
    assert got["name"] == "s (2)"


def test_import_confirm_stale_decision_409_with_fresh_plan(client: TestClient) -> None:
    body = _import_body(
        [{"id": "bs", "kind": "code_snippet", "name": "s", "payload": SNIP}],
        decisions={"bs": "reuse"},  # fresh project: nothing to reuse
    )
    rev0 = _rev(client)
    r = client.post(papi("/artifacts/import"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 409, r.text
    detail = r.json()
    assert "plan" in detail  # fresh plan rides along for the client to re-render
    assert detail["plan"]["entries"][0]["action"] == "create"
    assert _rev(client) == rev0  # a rejected confirm writes nothing


def test_import_confirm_rejects_a_copy_name_that_is_already_taken(
    client: TestClient,
) -> None:
    # The rename box of the (not yet built) import dialog is the normal way to
    # reach this: a copy renamed onto a row that already exists. Before the
    # check moved into build_import_ops this reached the applier, came back as
    # "import plan is stale" + a plan byte-identical to the one the client had
    # already decided against, and re-submitting looped forever.
    other = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return 1\n"}
    _mk(client, "code_snippet", "s", SNIP)
    _mk(client, "code_snippet", "taken", other)
    rev0 = _rev(client)
    body = _import_body(
        [{"id": "bs", "kind": "code_snippet", "name": "s", "payload": other}],
        decisions={"bs": "copy"},
        copy_names={"bs": "taken"},
    )
    r = client.post(papi("/artifacts/import"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 409, r.text
    detail = r.json()
    assert "taken" in detail["detail"]  # names the offending value...
    assert detail["plan"]["entries"][0]["action"] == "copy"  # ...fresh plan still rides along
    assert _rev(client) == rev0  # a rejected confirm writes nothing


def test_import_confirm_409_carries_the_appliers_own_detail(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The applier 422 stays reachable under genuine concurrency (a peer
    # claiming (kind, name) between our re-derive and the commit). Flattening
    # it to a bare "import plan is stale" hid the only description of what
    # actually happened; the cause must ride along.
    from fastapi import HTTPException

    from data_rover.api.routes import artifact_bundle as route_mod

    def boom(*_a: object, **_k: object) -> None:
        raise HTTPException(status_code=422, detail="a code_snippet named 'n' already exists")

    monkeypatch.setattr(route_mod, "create_commit", boom)
    r = client.post(
        papi("/artifacts/import"),
        json=_import_body([{"id": "bn", "kind": "navigation", "name": "n", "payload": _nav("x")}]),
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 409, r.text
    assert "already exists" in r.json()["detail"]
    assert "plan" in r.json()


def test_import_confirm_malformed_envelope_422(client: TestClient) -> None:
    r = client.post(
        papi("/artifacts/import"),
        json={"bundle": {"format": "wrong/v9", "artifacts": []}},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 422


def test_import_confirm_empty_name_is_skipped_not_500(client: TestClient) -> None:
    # An uploaded bundle is untrusted input, and CreateArtifactOp.name carries
    # a min_length=1 the bundle schema deliberately doesn't. Both routes must
    # answer the SAME way (skipped), or confirm turns the plan's 200 into an
    # uncontracted 500. The valid sibling still imports.
    artifacts = [
        {"id": "b1", "kind": "code_snippet", "name": "", "payload": SNIP},
        {"id": "b2", "kind": "code_snippet", "name": "ok", "payload": SNIP},
    ]
    r = client.post(
        papi("/artifacts/import/plan"), json=_bundle_body(artifacts), headers=AUTH_HEADERS
    )
    assert r.status_code == 200, r.text
    assert [sk["bundle_id"] for sk in r.json()["skipped"]] == ["b1"]

    r = client.post(
        papi("/artifacts/import"), json=_import_body(artifacts), headers=AUTH_HEADERS
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert [(sk["bundle_id"], sk["reason"]) for sk in out["skipped"]] == [
        ("b1", "empty name")
    ]
    assert [c["name"] for c in out["created"]] == ["ok"]


def test_import_confirm_feed_scope_is_artifact(client: TestClient) -> None:
    """An import is announced as a pure-artifact commit, so a peer refreshes
    its library without refetching model content it knows did not move."""
    _mk(client, "code_snippet", "s", SNIP)
    with client.websocket_connect(feed_url()) as ws:
        assert ws.receive_json()["type"] == "snapshot"
        r = client.post(
            papi("/artifacts/import"),
            json=_import_body(_REUSE_AND_CREATE),
            headers=AUTH_HEADERS,
        )
        assert r.status_code == 200, r.text
        commit = ws.receive_json()
        while commit["type"] != "commit":  # skip the own-presence join
            commit = ws.receive_json()
        assert commit["scope"] == ["artifact"]
        assert commit["changed_elements"] == []
        art = ws.receive_json()
        assert art["type"] == "artifact" and art["action"] == "created"
        assert art["artifact"]["name"] == "n"


def test_viewer_403_on_import(client: TestClient) -> None:
    # confirm is a write in every sense; a viewer must never reach the applier
    viewer_headers = _seed_viewer()
    r = client.post(
        papi("/artifacts/import"),
        json=_import_body([{"id": "bs", "kind": "code_snippet", "name": "s", "payload": SNIP}]),
        headers=viewer_headers,
    )
    assert r.status_code == 403, r.text


def test_revert_across_import_409(client: TestClient) -> None:
    # the existing artifact-op revert boundary applies to import commits too
    _mk(client, "code_snippet", "s", SNIP)
    before_rev = _rev(client)
    r = client.post(
        papi("/artifacts/import"),
        json=_import_body(_REUSE_AND_CREATE),
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text
    import_rev = r.json()["rev"]
    revert = client.post(
        papi("/commits/revert"),
        json={"target_rev": before_rev, "base_rev": _rev(client)},
        headers=AUTH_HEADERS,
    )
    assert revert.status_code == 409, revert.text
    assert revert.json()["artifact_commit_rev"] == import_rev
