"""POST /tables/evaluate: resolves navigation refs, builds/sorts/pages rows
through the pure core evaluator, and caches the ordered row list per session
(Task 7's TableOrderCache). Viewer-callable (read-only POST allowlist)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project
from .test_artifacts_routes import _bootstrap_model


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


@pytest.fixture
def viewer_headers(client: TestClient) -> dict[str, str]:
    """A membership with role=viewer on the default project (mirrors
    test_artifacts_routes.py::test_viewer_can_evaluate_but_not_create)."""
    from data_rover.api import tenancy
    from data_rover.api.db import db_session
    from data_rover.api.db_models import Role

    with db_session() as s:
        tenancy.upsert_user(s, user_id="viewer-1", email="v@example.com")
        tenancy.add_member(
            s, project_id="default", user_id="viewer-1", role=Role.viewer
        )
    return {"x-user-id": "viewer-1", "x-user-email": "v@example.com"}


def test_create_table_artifact_and_evaluate(client: TestClient) -> None:
    _bootstrap_model(client)
    payload = {
        "kind": "table",
        "name": "blocks",
        "payload": {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": [
                {"kind": "element", "source": {"kind": "row"}},
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "mass",
                },
            ],
        },
    }
    r = client.post(papi("/artifacts"), json=payload, headers=AUTH_HEADERS)
    assert r.status_code == 201, r.text
    art_id = r.json()["id"]
    r = client.post(
        papi("/tables/evaluate"),
        json={"artifact_id": art_id, "offset": 0, "limit": 50},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] >= 1
    assert body["rows"][0]["cells"][0]["kind"] == "element"
    assert "model_rev" in body


def test_evaluate_inline_with_sort(client: TestClient) -> None:
    _bootstrap_model(client)
    r = client.post(
        papi("/tables/evaluate"),
        json={
            "definition": {
                "row_source": {"kind": "scope", "types": ["Block"]},
                "columns": [
                    {"kind": "element", "source": {"kind": "row"}},
                    {
                        "kind": "property",
                        "source": {"kind": "row"},
                        "name": "mass",
                    },
                ],
            },
            "sort": {"column": 1, "direction": "asc"},
        },
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text


def test_expand_on_scalar_property_yields_one_row_each(client: TestClient) -> None:
    # Splitting a single-valued property is tolerated (one row per element),
    # not a 422 — the whole table must keep evaluating (see cells.py's
    # expand_property_values docstring).
    _bootstrap_model(client)
    r = client.post(
        papi("/tables/evaluate"),
        json={
            "definition": {
                "row_source": {"kind": "scope", "types": ["Block"]},
                "columns": [
                    {
                        "kind": "property",
                        "source": {"kind": "row"},
                        "name": "mass",
                        "mode": "expand",
                    }
                ],
            },
        },
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 3  # root, p1, p2 — one row each, scalar mass
    values = [row["cells"][0]["value"] for row in body["rows"]]
    assert values == [1.0, 1.0, 1.0]


def test_cache_hit_second_page(client: TestClient) -> None:
    _bootstrap_model(client)
    body = {
        "definition": {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": [{"kind": "element", "source": {"kind": "row"}}],
        },
        "sort": {"column": 0, "direction": "asc"},
    }
    r1 = client.post(
        papi("/tables/evaluate"),
        json={**body, "offset": 0, "limit": 1},
        headers=AUTH_HEADERS,
    )
    r2 = client.post(
        papi("/tables/evaluate"),
        json={**body, "offset": 1, "limit": 1},
        headers=AUTH_HEADERS,
    )
    assert r1.status_code == r2.status_code == 200
    assert r1.json()["total"] == r2.json()["total"]


def test_viewer_can_evaluate_not_create(
    client: TestClient, viewer_headers: dict[str, str]
) -> None:
    _bootstrap_model(client)
    r = client.post(
        papi("/tables/evaluate"),
        json={
            "definition": {
                "row_source": {"kind": "scope", "types": ["Block"]},
                "columns": [{"kind": "element", "source": {"kind": "row"}}],
            },
        },
        headers=viewer_headers,
    )
    assert r.status_code == 200, r.text
    denied = client.post(
        papi("/artifacts"),
        json={
            "kind": "table",
            "name": "x",
            "payload": {
                "row_source": {"kind": "scope", "types": ["Block"]},
                "columns": [{"kind": "element", "source": {"kind": "row"}}],
            },
        },
        headers=viewer_headers,
    )
    assert denied.status_code == 403


def test_evaluate_unknown_artifact_id_422(client: TestClient) -> None:
    _bootstrap_model(client)
    r = client.post(
        papi("/tables/evaluate"),
        json={"artifact_id": "ghost"},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 422


def test_evaluate_requires_exactly_one_of_definition_or_artifact_id(
    client: TestClient,
) -> None:
    _bootstrap_model(client)
    r = client.post(papi("/tables/evaluate"), json={}, headers=AUTH_HEADERS)
    assert r.status_code == 422
    r = client.post(
        papi("/tables/evaluate"),
        json={
            "definition": {
                "row_source": {"kind": "scope", "types": ["Block"]},
                "columns": [{"kind": "element", "source": {"kind": "row"}}],
            },
            "artifact_id": "whatever",
        },
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 422


def test_sort_column_out_of_range_422(client: TestClient) -> None:
    """An out-of-range sort column is a clear ValueError->422, NOT an
    IndexError inside order_rows mislabeled as an 'unknown artifact'."""
    _bootstrap_model(client)
    r = client.post(
        papi("/tables/evaluate"),
        json={
            "definition": {
                "row_source": {"kind": "scope", "types": ["Block"]},
                "columns": [{"kind": "element", "source": {"kind": "row"}}],
            },
            "sort": {"column": 5, "direction": "asc"},
        },
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 422
    assert "unknown artifact" not in r.json()["detail"]
    assert "out of range" in r.json()["detail"]


def test_table_reflects_referenced_navigation_edit(client: TestClient) -> None:
    """A navigation column referencing a saved navigation artifact (`ref`)
    must reflect edits to that artifact on the very next evaluate, with no
    model_rev bump in between — because /tables/evaluate fingerprints the
    RESOLVED definition (refs inlined), not the raw request body, so editing
    the referenced navigation changes the fingerprint and misses the cache."""
    names = _bootstrap_model(client)
    nav = {
        "kind": "navigation",
        "name": "parts",
        "payload": {
            "kind": "path",
            "start": {"kind": "row"},
            "steps": [
                {
                    "kind": "relationship",
                    "relationship_type": "BlockHasPart",
                    "direction": "out",
                }
            ],
        },
    }
    nr = client.post(papi("/artifacts"), json=nav, headers=AUTH_HEADERS)
    assert nr.status_code == 201, nr.text
    nav_id, nav_rev = nr.json()["id"], nr.json()["artifact_rev"]

    table = {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}},
            {
                "kind": "navigation",
                "source": {"kind": "row"},
                "navigation": {"ref": nav_id},
            },
        ],
    }
    r1 = client.post(
        papi("/tables/evaluate"), json={"definition": table}, headers=AUTH_HEADERS
    )
    assert r1.status_code == 200, r1.text
    model_rev_before = r1.json()["model_rev"]
    root_row_1 = next(
        row
        for row in r1.json()["rows"]
        if row["cells"][0]["item"]["id"] == names["root"]
    )
    nav_cell_1 = root_row_1["cells"][1]
    assert nav_cell_1["kind"] == "elements"
    assert nav_cell_1["total"] == 2  # root -BlockHasPart-> p1, p2

    # Edit the referenced navigation to follow NO relationship (empty steps):
    # its terminal set becomes just the row element itself.
    put = client.put(
        papi(f"/artifacts/{nav_id}"),
        json={
            "artifact_rev": nav_rev,
            "payload": {
                "kind": "path",
                "start": {"kind": "row"},
                "steps": [],
            },
        },
        headers=AUTH_HEADERS,
    )
    assert put.status_code == 200, put.text

    r2 = client.post(
        papi("/tables/evaluate"), json={"definition": table}, headers=AUTH_HEADERS
    )
    assert r2.status_code == 200, r2.text
    # No model_rev bump: editing a navigation artifact does not touch the model.
    assert r2.json()["model_rev"] == model_rev_before
    root_row_2 = next(
        row
        for row in r2.json()["rows"]
        if row["cells"][0]["item"]["id"] == names["root"]
    )
    nav_cell_2 = root_row_2["cells"][1]
    assert nav_cell_2["kind"] == "elements"
    assert nav_cell_2["total"] == 1  # only the row element itself, no parts


def test_truncated_flag_survives_cache_hit(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The `truncated` flag build_rows computed must be reported identically on
    the miss page AND every subsequent cached page (it is stored in the order
    cache, not recomputed). Force truncation via monkeypatch so we needn't seed
    50k rows; omit `sort` so order_rows is a no-op."""
    _bootstrap_model(client)
    import data_rover.api.routes.tables as tmod

    from dataclasses import replace

    orig = tmod.build_rows_ex
    monkeypatch.setattr(
        tmod, "build_rows_ex", lambda *a, **k: replace(orig(*a, **k), truncated=True)
    )
    body = {
        "definition": {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": [{"kind": "element", "source": {"kind": "row"}}],
        }
    }
    r1 = client.post(papi("/tables/evaluate"), json=body, headers=AUTH_HEADERS)
    r2 = client.post(papi("/tables/evaluate"), json=body, headers=AUTH_HEADERS)
    assert r1.status_code == r2.status_code == 200
    assert r1.json()["truncated"] is True
    assert r2.json()["truncated"] is True


def test_preview_rollback_invalidates_table_order_cache(client: TestClient) -> None:
    """A1: /commits/preview applies ops in place and then ALWAYS rolls back
    without bumping model_rev (routes/commits.py:preview_commit). A cache
    entry populated at that unchanged rev must not survive the rollback —
    otherwise a later /tables/evaluate at the same rev could serve rows that
    reflect the rolled-back, never-committed mutation (final-review A1)."""
    from data_rover.api.session import get_session
    from data_rover.api.table_cache import table_fingerprint
    from data_rover.core.table.schema import TABLE_ADAPTER

    ids = _bootstrap_model(client)
    definition = {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}},
            {"kind": "property", "source": {"kind": "row"}, "name": "mass"},
        ],
    }
    r1 = client.post(
        papi("/tables/evaluate"), json={"definition": definition}, headers=AUTH_HEADERS
    )
    assert r1.status_code == 200, r1.text
    rev = r1.json()["model_rev"]

    # Same fingerprint/sort_key the route computes (routes/tables.py:149-150)
    # for this inline, ref-free definition.
    resolved = TABLE_ADAPTER.validate_python(definition)
    fp = table_fingerprint(TABLE_ADAPTER.dump_json(resolved).decode(), None)
    session = get_session()
    assert session.table_order_cache.get(fp, "none", rev) is not None  # primed

    preview = client.post(
        papi("/commits/preview"),
        headers=AUTH_HEADERS,
        json={
            "base_rev": rev,
            "ops": [
                {
                    "kind": "update_element",
                    "id": ids["root"],
                    "properties_patch": {"mass": 999.0},
                }
            ],
        },
    )
    assert preview.status_code == 200, preview.text
    # preview rolls back in place; model_rev is unchanged
    assert (
        client.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]
        == rev
    )

    # The bug: the entry cached at `rev` before the preview must be gone, or a
    # later evaluate at the same (still-unchanged) rev would HIT and could
    # serve rows computed mid-preview instead of recomputing.
    assert session.table_order_cache.get(fp, "none", rev) is None


def test_evaluate_reports_base_total(client: TestClient) -> None:
    # `base_total` = rows produced by the row source BEFORE expand columns
    # split them (for a scope source: the scope size). The cached second
    # request must report the same value.
    _bootstrap_model(client)
    defn = {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}},
            {
                "kind": "navigation",
                "source": {"kind": "row"},
                "mode": "expand",
                "keep_empty": True,
                "navigation": {
                    "definition": {
                        "kind": "path",
                        "start": {"kind": "row"},
                        "steps": [
                            {
                                "kind": "relationship",
                                "relationship_type": "BlockHasPart",
                                "direction": "out",
                            }
                        ],
                    }
                },
            },
        ],
    }
    for _ in range(2):  # second request hits the order cache
        r = client.post(
            papi("/tables/evaluate"),
            json={"definition": defn, "offset": 0, "limit": 50},
            headers=AUTH_HEADERS,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["base_total"] == 3  # root, p1, p2
        assert body["total"] == 4  # root x 2 parts + p1/p2 keep-empty rows
