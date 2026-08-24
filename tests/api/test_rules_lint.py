"""POST /rules/lint — parse + schema + drift check for the editor's debounced
calls. Sibling of POST /metamodel/lint: always 200, viewers get 403."""

from __future__ import annotations

from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.db_models import Role, User
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID
from data_rover.api.tenancy import add_member

from .conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Building
    properties:
      - {name: name, datatype: string, multiplicity: "0..1"}
"""

_VALID_YAML = (
    "rules:\n"
    "  - name: has-name\n"
    "    applies_to: Building\n"
    "    then: {property: name, exists: true}\n"
)

# Unclosed flow sequence -> yaml.YAMLError with a problem_mark.
_SYNTAX_BAD_YAML = "rules: ["

# Parses as YAML but violates the rule schema (missing required `then`).
_SCHEMA_BAD_YAML = (
    "rules:\n"
    "  - name: no-then\n"
    "    applies_to: Building\n"
)

# Schema-valid, but `applies_to` names a stereotype the metamodel doesn't have.
_DRIFT_YAML = (
    "rules:\n"
    "  - name: bogus-rule\n"
    "    applies_to: Bogus\n"
    "    then: {property: name, exists: true}\n"
)


def _client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    r = c.post(
        papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"}
    )
    assert r.status_code == 200, r.text
    return c


def test_lint_ok() -> None:
    r = _client().post(papi("/rules/lint"), json={"yaml": _VALID_YAML})
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "errors": [], "warnings": []}


def test_lint_yaml_error_carries_line() -> None:
    r = _client().post(papi("/rules/lint"), json={"yaml": _SYNTAX_BAD_YAML})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    (err,) = body["errors"]
    assert isinstance(err["line"], int)
    assert err["message"]


def test_lint_schema_error_message_only() -> None:
    r = _client().post(papi("/rules/lint"), json={"yaml": _SCHEMA_BAD_YAML})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    (err,) = body["errors"]
    assert "no-then" in err["message"]
    assert err["line"] is None


def test_lint_drift_is_warning_not_error() -> None:
    r = _client().post(papi("/rules/lint"), json={"yaml": _DRIFT_YAML})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["errors"] == []
    (warning,) = body["warnings"]
    assert warning["rule"] == "bogus-rule"
    assert "Bogus" in warning["message"]


def test_lint_viewer_403() -> None:
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
        papi("/rules/lint"),
        json={"yaml": _VALID_YAML},
        headers={"x-user-id": "vw", "x-user-email": "vw@example.com"},
    )
    assert r.status_code == 403
