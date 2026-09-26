"""Export downloads named outside ASCII: the name also travels as RFC 5987
`filename*`, beside a `filename` whose code points past U+00FF are `_`; an
ASCII name's header is unchanged."""

import json
from collections.abc import MutableMapping
from typing import Any
from urllib.parse import unquote

import anyio
import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project

_METAMODEL = """
elements:
  - name: Item
    properties:
      - {name: name, datatype: string}
"""

_TABLE = {
    "row_source": {"kind": "scope", "types": ["Item"]},
    "columns": [{"kind": "element", "header": "Item"}],
}


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def _bootstrap(client: TestClient) -> None:
    r = client.post(
        papi("/metamodel"),
        content=_METAMODEL,
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    client.post(papi("/model"), json={"elements": [], "relationships": []})
    client.post(
        papi("/model/elements"), json={"type": "Item", "properties": {"name": "one"}}
    )


def _table(client: TestClient, name: str) -> str:
    r = client.post(
        papi("/artifacts"), json={"kind": "table", "name": name, "payload": _TABLE}
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _names(disposition: str) -> tuple[str, str]:
    """The `filename` fallback and the decoded `filename*`."""
    head, star = disposition.split("; filename*=UTF-8''")
    prefix = 'attachment; filename="'
    assert head.startswith(prefix) and head.endswith('"'), disposition
    return head[len(prefix) : -1], unquote(star, encoding="utf-8", errors="strict")


def test_table_export_sends_a_non_ascii_name_as_filename_star(
    client: TestClient,
) -> None:
    _bootstrap(client)
    artifact_id = _table(client, "日本")
    r = client.post(
        papi("/tables/export"), json={"artifact_id": artifact_id, "format": "csv"}
    )
    assert r.status_code == 200, r.text
    disposition = r.headers["content-disposition"]
    assert disposition == (
        "attachment; filename=\"__.csv\"; filename*=UTF-8''%E6%97%A5%E6%9C%AC.csv"
    )
    assert _names(disposition) == ("__.csv", "日本.csv")


def _raw_disposition(client: TestClient, path: str, body: dict[str, Any]) -> str:
    """`Content-Disposition` as the app sends it, read as Latin-1, the way a
    browser reads it. The TestClient decodes headers as UTF-8, so the request
    goes to the ASGI app directly."""
    payload = json.dumps(body).encode()
    start: dict[str, Any] = {}

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": payload, "more_body": False}

    async def send(message: MutableMapping[str, Any]) -> None:
        if message["type"] == "http.response.start":
            start.update(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [
            (b"content-type", b"application/json"),
            *((k.encode(), v.encode()) for k, v in AUTH_HEADERS.items()),
        ],
        "client": ("testclient", 50000),
        "server": ("testserver", 80),
    }
    anyio.run(client.app, scope, receive, send)
    assert start["status"] == 200, start
    (raw,) = [v for k, v in start["headers"] if k == b"content-disposition"]
    return raw.decode("latin-1")


def test_a_latin1_name_keeps_its_plain_filename(client: TestClient) -> None:
    _bootstrap(client)
    artifact_id = _table(client, "Übersicht")
    body = {"artifact_id": artifact_id, "format": "xlsx"}
    assert _raw_disposition(client, papi("/tables/export"), body) == (
        "attachment; filename=\"Übersicht.xlsx\"; filename*=UTF-8''%C3%9Cbersicht.xlsx"
    )


def test_a_mixed_name_replaces_only_what_latin1_lacks(client: TestClient) -> None:
    _bootstrap(client)
    artifact_id = _table(client, "é 日")
    body = {"artifact_id": artifact_id, "format": "json"}
    disposition = _raw_disposition(client, papi("/tables/export"), body)
    assert _names(disposition) == ("é _.json", "é 日.json")


def test_an_ascii_name_keeps_its_header(client: TestClient) -> None:
    _bootstrap(client)
    artifact_id = _table(client, "plain name")
    r = client.post(
        papi("/tables/export"), json={"artifact_id": artifact_id, "format": "csv"}
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-disposition"] == 'attachment; filename="plain name.csv"'


def _run(client: TestClient, definition: dict[str, Any], name: str) -> str:
    r = client.post(papi("/exports/run"), json={"definition": definition, "name": name})
    assert r.status_code == 200, r.text
    return r.headers["content-disposition"]


def test_run_sends_a_non_ascii_zip_stem_as_filename_star(client: TestClient) -> None:
    _bootstrap(client)
    table_id = _table(client, "t")
    definition = {"entries": [{"source": {"ref": table_id}, "format": "csv"}]}
    assert _names(_run(client, definition, "日本 𝒜")) == ("__ _.zip", "日本 𝒜.zip")


def test_run_sends_a_non_ascii_bare_member_as_filename_star(
    client: TestClient,
) -> None:
    _bootstrap(client)
    table_id = _table(client, "t")
    definition = {
        "output": {"mode": "bare"},
        "entries": [{"source": {"ref": table_id}, "format": "csv", "name": "日本"}],
    }
    assert _names(_run(client, definition, "run")) == ("__.csv", "日本.csv")


def test_run_keeps_an_ascii_bare_header(client: TestClient) -> None:
    _bootstrap(client)
    table_id = _table(client, "t")
    definition = {
        "output": {"mode": "bare"},
        "entries": [{"source": {"ref": table_id}, "format": "csv", "name": "plain"}],
    }
    assert _run(client, definition, "run") == 'attachment; filename="plain.csv"'


def test_run_keeps_an_ascii_zip_header(client: TestClient) -> None:
    _bootstrap(client)
    table_id = _table(client, "t")
    definition = {"entries": [{"source": {"ref": table_id}, "format": "csv"}]}
    assert _run(client, definition, "run") == 'attachment; filename="run.zip"'
