from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.db_models import Role, User
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID
from data_rover.api.tenancy import add_member

from .conftest import AUTH_HEADERS, papi, seed_default_project

_YAML = {"content-type": "application/x-yaml"}

_VALID = """\
elements:
  - name: Node
relationships:
  - name: Link
    source: Node
    target: Node
"""

# Unclosed flow mapping -> yaml.YAMLError with a problem_mark.
_SYNTAX_BAD = "elements: [ {"

# Parses as YAML but violates the metamodel schema -> MetamodelError, no mark.
_SCHEMA_BAD = """\
elements:
  - name: Node
    properties:
      - name: p
        datatype: bogus_datatype
"""


def _client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def test_lint_valid_ok() -> None:
    r = _client().post(papi("/metamodel/lint"), content=_VALID, headers=_YAML)
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "errors": []}


def test_lint_syntax_error_carries_position() -> None:
    r = _client().post(papi("/metamodel/lint"), content=_SYNTAX_BAD, headers=_YAML)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    (err,) = body["errors"]
    assert err["message"]
    assert isinstance(err["line"], int) and err["line"] >= 1
    assert isinstance(err["column"], int) and err["column"] >= 1


def test_lint_schema_error_message_only() -> None:
    r = _client().post(papi("/metamodel/lint"), content=_SCHEMA_BAD, headers=_YAML)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    (err,) = body["errors"]
    assert err["message"]
    assert err["line"] is None and err["column"] is None


def test_lint_works_without_a_bound_metamodel() -> None:
    """Lint checks the CANDIDATE text only — no session content needed."""
    r = _client().post(papi("/metamodel/lint"), content=_VALID, headers=_YAML)
    assert r.status_code == 200


def test_viewer_gets_403() -> None:
    """Deliberately NOT in the read-only-POST allowlist."""
    c = _client()
    gen = db.get_db()
    s = next(gen)
    try:
        s.add(User(id="vw", email="vw@example.com"))
        add_member(s, DEFAULT_PROJECT_ID, "vw", Role.viewer)
        s.commit()
    finally:
        gen.close()
    r = c.post(
        papi("/metamodel/lint"),
        content=_VALID,
        headers={**_YAML, "x-user-id": "vw", "x-user-email": "vw@example.com"},
    )
    assert r.status_code == 403
