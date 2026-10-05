import json
from pathlib import Path

from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.db_models import Role, User
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID
from data_rover.api.tenancy import add_member

from .conftest import (
    AUTH_HEADERS,
    papi,
    seed_default_project,
    head,
    install,
    EMPTY_MODEL,
)
from .test_commits_metamodel_ops import _acquire_mm

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


def _exact(value: object) -> str:
    """JSON text that tells ``1`` from ``1.0`` and keeps key order."""
    return json.dumps(value)


def test_lint_valid_ok() -> None:
    c = _client()
    assert c.post(papi("/metamodel"), content=_VALID, headers=_YAML).status_code == 200
    stored = c.get(papi("/metamodel"))
    assert stored.status_code == 200, stored.text
    r = c.post(papi("/metamodel/lint"), content=_VALID, headers=_YAML)
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "errors": [], "document": stored.json()}


def test_lint_document_is_what_a_rebind_to_the_same_blob_serves() -> None:
    """The document the engine opens for a candidate is the one the server
    would answer after committing that candidate."""
    candidate = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")
    c = _client()
    install(metamodel=_VALID, model=EMPTY_MODEL)
    rev = head().rev
    r = c.post(
        papi("/commits"),
        json={
            "base_rev": rev,
            "ops": [{"kind": "metamodel.rebind", "blob": candidate}],
            "message": "rebind",
            "lock_tokens": [_acquire_mm(c)],
        },
    )
    assert r.status_code == 200, r.text
    served = c.get(papi("/metamodel"))
    assert served.status_code == 200, served.text
    r = c.post(papi("/metamodel/lint"), content=candidate, headers=_YAML)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert _exact(body["document"]) == _exact(served.json())


def test_lint_syntax_error_carries_position() -> None:
    r = _client().post(papi("/metamodel/lint"), content=_SYNTAX_BAD, headers=_YAML)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    (err,) = body["errors"]
    assert err["message"]
    assert isinstance(err["line"], int) and err["line"] >= 1
    assert isinstance(err["column"], int) and err["column"] >= 1
    assert body["document"] is None


def test_lint_schema_error_message_only() -> None:
    r = _client().post(papi("/metamodel/lint"), content=_SCHEMA_BAD, headers=_YAML)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    (err,) = body["errors"]
    assert err["message"]
    assert err["line"] is None and err["column"] is None
    assert body["document"] is None


def test_lint_works_without_a_bound_metamodel() -> None:
    """Lint checks the CANDIDATE text only — no session content needed."""
    r = _client().post(papi("/metamodel/lint"), content=_VALID, headers=_YAML)
    assert r.status_code == 200


def test_lint_undecodable_utf8_body_is_ok_false_not_500() -> None:
    """A body that isn't even valid UTF-8 must still land inside the
    always-200 contract, not escape as an unhandled 500."""
    r = _client().post(
        papi("/metamodel/lint"), content=b"\xff\xfe elements:", headers=_YAML
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    (err,) = body["errors"]
    assert err["message"]
    assert body["document"] is None


def test_lint_malformed_json_body_is_ok_false_not_500() -> None:
    """A malformed body under a JSON content-type must also stay inside the
    always-200 contract (the JSON decode happens inside _read_metamodel_blob,
    before load_metamodel_str even runs)."""
    r = _client().post(
        papi("/metamodel/lint"),
        content="{not valid json",
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    (err,) = body["errors"]
    assert err["message"]


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
