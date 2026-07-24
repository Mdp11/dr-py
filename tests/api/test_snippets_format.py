"""POST /snippets/format — the Reformat button's backend.

Formatting is read-only with respect to the model: it never touches
``session.model``, which is why the route sits in
``authz._READ_ONLY_POST_SUFFIXES`` and a viewer may call it.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from httpx import Response

from data_rover.api import db, script_format
from data_rover.api.main import create_app
from data_rover.core.script.schema import SNIPPET_MAX_CODE_BYTES

from .conftest import AUTH_HEADERS, papi, seed_default_project


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    script_format.reset_ruff_path_cache()
    return TestClient(create_app())


def _post(c: TestClient, code: str) -> Response:
    return c.post(papi("/snippets/format"), json={"code": code}, headers=AUTH_HEADERS)


def test_formats_and_reports_changed(client: TestClient) -> None:
    r = _post(client, "def f( a ):\n\treturn  a+1\n")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["code"] == "def f(a):\n    return a + 1\n"
    assert body["changed"] is True


def test_already_formatted_reports_unchanged(client: TestClient) -> None:
    formatted = "def f(a):\n    return a + 1\n"
    r = _post(client, formatted)
    assert r.status_code == 200, r.text
    assert r.json() == {"code": formatted, "changed": False}


def test_indents_with_four_spaces(client: TestClient) -> None:
    r = _post(client, "if True:\n  x = 1\n  if x:\n    y = 2\n")
    assert r.status_code == 200, r.text
    assert r.json()["code"] == "if True:\n    x = 1\n    if x:\n        y = 2\n"


def test_syntax_error_is_422(client: TestClient) -> None:
    r = _post(client, "def f(:\n")
    assert r.status_code == 422, r.text
    assert r.json()["detail"]


def test_oversized_code_is_rejected(client: TestClient) -> None:
    r = _post(client, "x = 1\n" * (SNIPPET_MAX_CODE_BYTES // 6 + 10))
    assert r.status_code == 422


def test_viewer_may_format(client: TestClient) -> None:
    from data_rover.api.db_models import Role, User
    from data_rover.api.session import DEFAULT_PROJECT_ID
    from data_rover.api.tenancy import add_member

    gen = db.get_db()
    s = next(gen)
    try:
        s.add(User(id="vw", email="vw@example.com"))
        add_member(s, DEFAULT_PROJECT_ID, "vw", Role.viewer)
        s.commit()
    finally:
        gen.close()
    r = client.post(
        papi("/snippets/format"),
        json={"code": "x=1\n"},
        headers={"x-user-id": "vw", "x-user-email": "vw@example.com"},
    )
    assert r.status_code == 200, r.text


def test_missing_ruff_is_503_not_500(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same degraded-not-failed posture as a missing snippet guest binary."""
    monkeypatch.setattr(script_format.shutil, "which", lambda _name: None)
    script_format.reset_ruff_path_cache()
    r = _post(client, "x=1\n")
    assert r.status_code == 503, r.text
