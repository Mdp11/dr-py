"""GET /commits/{rev}/diff renders element AND artifact changes from the
journal; json_structural_diff pins the path-level artifact payload diff.

The artifact half is deliberately journal-only (no artifact-row reads), which
is what makes a diff of an OLD commit correct even after the artifact has been
re-edited or deleted since — the tests below pin exactly that.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from data_rover.api.commit_diff import _artifact_states, json_structural_diff
from data_rover.api.db_models import Commit
from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Node
    properties:
      - name: label
        datatype: string
"""

SNIP: dict[str, Any] = {
    "schema_version": 1,
    "language": "python",
    "code": "def value(el):\n    return 1\n",
}


def test_json_structural_diff_paths() -> None:
    changes = json_structural_diff(
        {"a": 1, "b": {"c": 2, "d": 3}, "e": [1, 2]},
        {"a": 1, "b": {"c": 9, "d": 3}, "e": [1, 3], "f": 4},
    )
    by_path = {c.path: c for c in changes}
    assert set(by_path) == {"b.c", "e", "f"}
    assert by_path["b.c"].before == 2 and by_path["b.c"].after == 9
    assert by_path["e"].before == [1, 2]  # lists compare wholesale
    assert by_path["f"].before is None and by_path["f"].after == 4


def test_json_structural_diff_equal_is_empty() -> None:
    assert json_structural_diff({"x": [1]}, {"x": [1]}) == []


def test_artifact_states_of_create_then_delete_in_one_commit() -> None:
    """A commit that creates an artifact and deletes it again nets out to
    NOTHING — before is None and after is None, so the diff reports neither an
    add nor a delete.

    Tested against ``_artifact_states`` directly rather than over HTTP because
    the shape is unreachable through ``POST /commits``: the delete op would have
    to name the not-yet-assigned id (``apply_artifact_ops`` resolves temp ids
    only inside payloads, so ``delete_artifact`` on a temp id 422s). The
    journal-only reader must still be correct for it, since a future
    change-request draft can compose exactly this sequence.
    """
    commit = Commit(
        project_id="p",
        rev=1,
        commit_id="c",
        # applied order: create then delete
        ops=[
            {
                "kind": "create_artifact",
                "temp_id": "a1",
                "artifact_kind": "code_snippet",
                "name": "s1",
                "payload": SNIP,
            },
            {"kind": "delete_artifact", "id": "a1"},
        ],
        # inverse units are stored reversed (undo order): recreate, then delete
        inverse_ops=[
            {
                "kind": "create_artifact",
                "temp_id": "a1",
                "artifact_kind": "code_snippet",
                "name": "s1",
                "payload": SNIP,
            },
            {"kind": "delete_artifact", "id": "a1"},
        ],
    )
    before, after, kinds = _artifact_states(commit)
    assert before["a1"] is None
    assert after["a1"] is None
    assert kinds["a1"] == "code_snippet"


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    r = c.post(
        papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"}
    )
    assert r.status_code == 200, r.text
    r = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert r.status_code == 200, r.text
    return c


def _rev(c: TestClient) -> int:
    rev: int = c.get(papi("/model/summary")).json()["model_rev"]
    return rev


def _folder_lease(client: TestClient, fid: str, intent: str = "edit") -> str:
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": fid, "mode": "exclusive", "type": "folder"}],
            "intent": intent,
        },
    )
    assert r.status_code == 200, r.text
    token: str = r.json()["token"]
    return token


def _lock(
    c: TestClient, resource_id: str, intent: str = "edit", rtype: str = "element"
) -> str:
    """Acquire an exclusive lease so every commit below is deterministic — the
    commit route 409s a lock-less mutation of an existing entity."""
    r = c.post(
        papi("/locks"),
        json={
            "targets": [
                {"resource_id": resource_id, "mode": "exclusive", "type": rtype}
            ],
            "intent": intent,
        },
    )
    assert r.status_code == 200, r.text
    token: str = r.json()["token"]
    return token


def _mk_snippet(c: TestClient, name: str = "s1") -> str:
    r = c.post(
        papi("/commits"),
        json={
            "base_rev": _rev(c),
            "ops": [
                {
                    "kind": "create_artifact",
                    "temp_id": "tmp_a",
                    "artifact_kind": "code_snippet",
                    "name": name,
                    "payload": SNIP,
                }
            ],
            "lock_tokens": [],
        },
    )
    assert r.status_code == 200, r.text
    aid: str = r.json()["id_map"]["tmp_a"]
    return aid


def test_diff_of_mixed_commit(client: TestClient) -> None:
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {
                    "kind": "create_element",
                    "temp_id": "tmp_e",
                    "type_name": "Node",
                    "properties": {"label": "n1"},
                },
                {
                    "kind": "create_artifact",
                    "temp_id": "tmp_a",
                    "artifact_kind": "code_snippet",
                    "name": "s1",
                    "payload": SNIP,
                },
            ],
            "lock_tokens": [],
        },
    )
    assert r.status_code == 200, r.text
    rev = r.json()["model_rev"]
    aid = r.json()["id_map"]["tmp_a"]
    d = client.get(papi(f"/commits/{rev}/diff"))
    assert d.status_code == 200, d.text
    body = d.json()
    assert body["rev"] == rev
    assert sorted(body["scope"]) == ["artifact", "model"]
    assert body["is_rebind"] is False
    assert len(body["elements"]["added"]) == 1
    assert body["elements"]["added"][0]["properties"]["label"] == "n1"
    assert body["artifacts"]["added"][0]["id"] == aid
    assert body["artifacts"]["added"][0]["kind"] == "code_snippet"
    assert body["artifacts"]["added"][0]["name"] == "s1"


def test_diff_of_artifact_update_has_path_changes(client: TestClient) -> None:
    aid = _mk_snippet(client)
    tok = _lock(client, aid, rtype="artifact")
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {
                    "kind": "update_artifact",
                    "id": aid,
                    "payload": {**SNIP, "code": "def value(el):\n    return 2\n"},
                }
            ],
            "lock_tokens": [tok],
        },
    )
    assert r.status_code == 200, r.text
    d = client.get(papi(f"/commits/{r.json()['model_rev']}/diff"))
    assert d.status_code == 200, d.text
    body = d.json()
    assert body["scope"] == ["artifact"]
    # a pure-artifact commit names no model entity, so both entity halves are
    # empty — which is exactly what lets diff_commit skip reconstruction
    assert body["elements"] == {"added": [], "modified": [], "deleted": []}
    assert body["relationships"] == {"added": [], "modified": [], "deleted": []}
    mod = body["artifacts"]["modified"][0]
    # kind is not on an update op either way, so it comes from the row
    assert mod["id"] == aid and mod["kind"] == "code_snippet"
    assert mod["name_before"] == "s1" and mod["name_after"] == "s1"
    paths = {c["path"] for c in mod["changes"]}
    assert "code" in paths
    change = next(c for c in mod["changes"] if c["path"] == "code")
    assert change["before"] == SNIP["code"]
    assert change["after"] == "def value(el):\n    return 2\n"


def test_diff_of_two_updates_in_one_commit_spans_the_whole_batch(
    client: TestClient,
) -> None:
    """before is the state at the START of the batch and after the state at its
    END — not the last op's own before/after. This is what the flat inverse
    list's reverse ordering buys (last write per id wins == earliest unit)."""
    aid = _mk_snippet(client, "twice")
    tok = _lock(client, aid, rtype="artifact")
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {
                    "kind": "update_artifact",
                    "id": aid,
                    "name": "mid",
                    "payload": {**SNIP, "code": "x = 1\n"},
                },
                {
                    "kind": "update_artifact",
                    "id": aid,
                    "name": "last",
                    "payload": {**SNIP, "code": "x = 2\n"},
                },
            ],
            "lock_tokens": [tok],
        },
    )
    assert r.status_code == 200, r.text
    d = client.get(papi(f"/commits/{r.json()['model_rev']}/diff"))
    assert d.status_code == 200, d.text
    mod = d.json()["artifacts"]["modified"][0]
    assert mod["name_before"] == "twice" and mod["name_after"] == "last"
    change = next(c for c in mod["changes"] if c["path"] == "code")
    assert change["before"] == SNIP["code"] and change["after"] == "x = 2\n"


def test_diff_of_artifact_delete_reports_prior_state(client: TestClient) -> None:
    aid = _mk_snippet(client, "doomed")
    tok = _lock(client, aid, intent="delete", rtype="artifact")
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "delete_artifact", "id": aid}],
            "lock_tokens": [tok],
        },
    )
    assert r.status_code == 200, r.text
    d = client.get(papi(f"/commits/{r.json()['model_rev']}/diff"))
    assert d.status_code == 200, d.text
    deleted = d.json()["artifacts"]["deleted"]
    assert [a["id"] for a in deleted] == [aid]
    # kind + full prior payload come off the delete's inverse (a create op),
    # so they survive the row being gone
    assert deleted[0]["kind"] == "code_snippet"
    assert deleted[0]["name"] == "doomed"
    assert deleted[0]["payload"]["code"] == SNIP["code"]


def test_diff_of_old_update_survives_a_later_delete(client: TestClient) -> None:
    """The journal-only stance: an update commit still renders its before/after
    after the artifact has been deleted. Only ``kind`` degrades to "unknown",
    because an update op carries none on either side and the row it would have
    been read from is gone."""
    aid = _mk_snippet(client, "shortlived")
    tok = _lock(client, aid, rtype="artifact")
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {"kind": "update_artifact", "id": aid, "payload": {**SNIP, "code": "y = 1\n"}}
            ],
            "lock_tokens": [tok],
        },
    )
    assert r.status_code == 200, r.text
    update_rev = r.json()["model_rev"]
    tok = _lock(client, aid, intent="delete", rtype="artifact")
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "delete_artifact", "id": aid}],
            "lock_tokens": [tok],
        },
    )
    assert r.status_code == 200, r.text
    d = client.get(papi(f"/commits/{update_rev}/diff"))
    assert d.status_code == 200, d.text
    mod = d.json()["artifacts"]["modified"][0]
    assert mod["id"] == aid and mod["kind"] == "unknown"
    change = next(c for c in mod["changes"] if c["path"] == "code")
    assert change["before"] == SNIP["code"] and change["after"] == "y = 1\n"


def test_diff_of_element_update_and_delete(client: TestClient) -> None:
    """Two commits, two shapes: the update commit renders before/after states,
    the delete commit renders the entity as it stood at rev-1."""
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {
                    "kind": "create_element",
                    "temp_id": "tmp_e",
                    "type_name": "Node",
                    "properties": {"label": "before"},
                }
            ],
            "lock_tokens": [],
        },
    )
    assert r.status_code == 200, r.text
    eid = r.json()["id_map"]["tmp_e"]

    tok = _lock(client, eid)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {"kind": "update_element", "id": eid, "properties_patch": {"label": "after"}}
            ],
            "lock_tokens": [tok],
        },
    )
    assert r.status_code == 200, r.text
    d = client.get(papi(f"/commits/{r.json()['model_rev']}/diff"))
    assert d.status_code == 200, d.text
    mod = d.json()["elements"]["modified"][0]
    assert mod["id"] == eid
    assert mod["before"]["properties"]["label"] == "before"
    assert mod["after"]["properties"]["label"] == "after"

    tok = _lock(client, eid, intent="delete")
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "delete_element", "id": eid}],
            "lock_tokens": [tok],
        },
    )
    assert r.status_code == 200, r.text
    d = client.get(papi(f"/commits/{r.json()['model_rev']}/diff"))
    assert d.status_code == 200, d.text
    body = d.json()
    assert body["scope"] == ["model"]
    assert [e["id"] for e in body["elements"]["deleted"]] == [eid]
    assert body["elements"]["deleted"][0]["properties"]["label"] == "after"


def test_diff_unknown_rev_404(client: TestClient) -> None:
    assert client.get(papi("/commits/999/diff")).status_code == 404


def test_view_commit_diff_renders_ops_with_prior_names(client) -> None:
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    token = _folder_lease(client, fid)
    base = _rev(client)
    ops = [
        {"kind": "rename_folder", "id": fid, "name": "A2"},
        {"kind": "create_folder", "temp_id": "tmp_c", "parent_id": fid, "name": "C"},
        {"kind": "place_element", "element_id": "e1", "folder_id": "tmp_c"},
    ]
    r = client.post(
        papi("/commits"),
        json={"base_rev": base, "ops": ops, "message": "m", "lock_tokens": [token]},
    )
    assert r.status_code == 200, r.text
    cid = r.json()["id_map"]["tmp_c"]

    r = client.get(papi(f"/commits/{base + 1}/diff"))
    assert r.status_code == 200
    out = r.json()
    assert out["scope"] == ["view"]
    entries = out["view"]
    assert [e["kind"] for e in entries] == ["rename_folder", "create_folder", "place_element"]
    assert entries[0] == {
        **entries[0],
        "folder_id": fid,
        "name": "A2",
        "name_before": "A",
    }
    assert entries[1]["folder_id"] == cid and entries[1]["parent_id"] == fid
    assert entries[2]["element_id"] == "e1" and entries[2]["folder_id"] == cid
    # model/artifact halves untouched by a pure-view commit
    assert out["elements"] == {"added": [], "modified": [], "deleted": []}


def test_delete_folder_diff_carries_prior_name(client) -> None:
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    token = _folder_lease(client, fid, intent="delete")
    base = _rev(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [{"kind": "delete_folder", "id": fid}],
            "message": "m",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    r = client.get(papi(f"/commits/{base + 1}/diff"))
    e = r.json()["view"][0]
    assert e["kind"] == "delete_folder" and e["name_before"] == "A"


def test_mixed_commit_scope_lists_both(client) -> None:
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    token = _folder_lease(client, fid)
    base = _rev(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [
                {"kind": "create_element", "temp_id": "tmp_e", "type_name": "Node"},
                {"kind": "rename_folder", "id": fid, "name": "A2"},
            ],
            "message": "m",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    r = client.get(papi(f"/commits/{base + 1}/diff"))
    assert r.json()["scope"] == ["model", "view"]
