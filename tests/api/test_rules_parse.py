"""POST /rules/parse: a rule set's normalized document, as text, for the
engine. Always 200 for a well-formed request, 422 for a malformed envelope;
viewers get 403, as on /rules/lint."""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel

from data_rover.api import db
from data_rover.api.db_models import Role, User
from data_rover.api.main import create_app
from data_rover.api.routes.rules import parse_result
from data_rover.api.session import DEFAULT_PROJECT_ID
from data_rover.api.tenancy import add_member
from data_rover.core.validation.rules.schema import (
    RULES_MAX_YAML_BYTES,
    RuleSetDefinition,
    parse_rule_set,
)

from .conftest import AUTH_HEADERS, papi, seed_default_project

EVERY_FEATURE_YAML = """\
schema_version: 1
rules:
  - name: every-feature
    description: all of it
    applies_to: Building
    severity: warning
    disabled: false
    when:
      all:
        - {property: a, equals: null}
        - {property: b, in: [1, "1", true, 1.0]}
        - {property: c, gt: 1}
        - {property: d, lt: .inf}
        - {property: e, equals: 123456789012345678901}
    then:
      any:
        - not: {property: f, exists: true}
        - {property: g, not_equals: x}
        - {property: h, gte: 2.5}
        - {property: i, lte: -3}
        - {property: j, contains: sub}
        - relationship:
            type: connects
            direction: outgoing
            to: Road
            where: {property: k, exists: false}
            count: {eq: true, gte: 0, lte: 4}
        - relationship: {type: feeds, direction: incoming, exists: true}
    message: custom message
  - name: plain
    applies_to: Road
    disabled: true
    then: {property: name, not_equals: null}
"""

# Keys written out of the model's field order, and no defaults.
SMALL_YAML = """\
rules:
  - then:
      relationship: {count: {eq: 1}, to: Road, direction: outgoing, type: connects}
    description: one road
    applies_to: Building
    name: one-road
  - applies_to: Building
    name: kind-not-listed
    then: {not: {in: [a, b], property: kind}}
"""

SMALL_DOCUMENT = (
    '{"rules":['
    '{"name":"one-road","description":"one road","applies_to":"Building",'
    '"then":{"relationship":{"type":"connects","direction":"outgoing",'
    '"to":"Road","count":{"eq":1}}}},'
    '{"name":"kind-not-listed","applies_to":"Building",'
    '"then":{"not":{"property":"kind","in":["a","b"]}}}'
    "]}"
)


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def _parse(client: TestClient, yaml_text: str) -> dict[str, Any]:
    res = client.post(papi("/rules/parse"), json={"yaml": yaml_text})
    assert res.status_code == 200, res.text
    body: dict[str, Any] = res.json()
    return body


def _assert_same(a: object, b: object, at: str = "") -> None:
    """Equal field for field, with the same fields set and the same scalar
    types (`1 == 1.0 == True` in Python, so `==` alone would not tell)."""
    if isinstance(a, BaseModel):
        assert type(a) is type(b), at
        assert isinstance(b, BaseModel)
        assert a.model_fields_set == b.model_fields_set, at
        for name in type(a).model_fields:
            _assert_same(getattr(a, name), getattr(b, name), f"{at}.{name}")
    elif isinstance(a, list):
        assert isinstance(b, list), at
        assert len(a) == len(b), at
        for i, (x, y) in enumerate(zip(a, b, strict=True)):
            _assert_same(x, y, f"{at}[{i}]")
    else:
        assert type(a) is type(b), at
        assert a == b, at


def test_the_document_round_trips_every_feature(client: TestClient) -> None:
    body = _parse(client, EVERY_FEATURE_YAML)

    assert body["ok"] is True
    assert body["errors"] == []
    document = body["document"]
    assert isinstance(document, str)
    reread = RuleSetDefinition.model_validate(json.loads(document))
    _assert_same(reread, parse_rule_set(EVERY_FEATURE_YAML))
    for written in (
        '"equals":null',
        '"in":[1,"1",true,1.0]',
        '"gt":1.0',
        '"count":{"eq":1,',
        '"lt":Infinity',
        '"equals":123456789012345678901',
        '"not_equals":null',
    ):
        assert written in document, written


def test_the_document_text_is_pinned(client: TestClient) -> None:
    body = _parse(client, SMALL_YAML)

    assert body == {"ok": True, "document": SMALL_DOCUMENT, "errors": []}


@pytest.mark.parametrize(
    "yaml_text",
    [
        pytest.param("rules: [", id="unclosed"),
        pytest.param("a: &x 1\nb: *x\n", id="alias"),
    ],
)
def test_unparseable_yaml_answers_the_lint_error(
    client: TestClient, yaml_text: str
) -> None:
    body = _parse(client, yaml_text)
    lint = client.post(papi("/rules/lint"), json={"yaml": yaml_text}).json()

    assert body["ok"] is False
    assert body["document"] is None
    (err,) = body["errors"]
    assert isinstance(err["line"], int)
    assert isinstance(err["column"], int)
    assert body["errors"] == lint["errors"]


def test_a_schema_failure_has_no_position(client: TestClient) -> None:
    yaml_text = "rules:\n  - name: no-then\n    applies_to: Building\n"
    body = _parse(client, yaml_text)
    lint = client.post(papi("/rules/lint"), json={"yaml": yaml_text}).json()

    assert body["ok"] is False
    assert body["document"] is None
    (err,) = body["errors"]
    assert "no-then" in err["message"]
    assert err["line"] is None
    assert err["column"] is None
    assert body["errors"] == lint["errors"]


def test_an_empty_document_is_an_empty_set(client: TestClient) -> None:
    assert _parse(client, "") == {"ok": True, "document": "{}", "errors": []}


def test_the_route_answers_parse_result(client: TestClient) -> None:
    for yaml_text in (EVERY_FEATURE_YAML, "rules: [", ""):
        assert _parse(client, yaml_text) == parse_result(yaml_text).model_dump(
            mode="json"
        )


@pytest.mark.parametrize(
    "body",
    [
        pytest.param({"yaml": "x" * (RULES_MAX_YAML_BYTES + 1)}, id="over-cap"),
        pytest.param({}, id="missing"),
    ],
)
def test_a_malformed_envelope_is_422(client: TestClient, body: dict) -> None:
    res = client.post(papi("/rules/parse"), json=body)
    assert res.status_code == 422, res.text


def test_a_viewer_gets_403(client: TestClient) -> None:
    with db.db_session() as s:
        s.add(User(id="vw", email="vw@example.com"))
        add_member(s, DEFAULT_PROJECT_ID, "vw", Role.viewer)
    res = client.post(
        papi("/rules/parse"),
        json={"yaml": SMALL_YAML},
        headers={"x-user-id": "vw", "x-user-email": "vw@example.com"},
    )
    assert res.status_code == 403, res.text
