"""POST /tables/export with json_split enabled (P-13)."""

import io
import json
import zipfile

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


def _body(split, columns=None):
    return {
        "definition": {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": columns
            or [
                {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            ],
            "json_split": split,
        },
        "format": "json",
    }


def _post(client, body):
    return client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)


def test_split_export_ships_a_zip_with_one_array_file_per_base_element(client):
    _bootstrap_model(client)
    r = _post(client, _body({"enabled": True, "filename_template": "DataFor${name}"}))
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    assert r.headers["content-disposition"].endswith('.zip"')
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = zf.namelist()
    assert names and all(n.startswith("DataFor") and n.endswith(".json") for n in names)
    # every file is an ARRAY, and concatenating them reproduces the unsplit export
    concat = []
    for n in names:
        docs = json.loads(zf.read(n))
        assert isinstance(docs, list) and docs
        concat.extend(docs)
    plain = _post(client, _body(None))
    assert json.loads(plain.content) == concat


def test_split_export_is_byte_deterministic(client):
    _bootstrap_model(client)
    body = _body({"enabled": True, "filename_template": "${name}"})
    assert _post(client, body).content == _post(client, body).content


def test_tokenless_template_answers_422_before_evaluating(client):
    _bootstrap_model(client)
    r = _post(client, _body({"enabled": True, "filename_template": "static"}))
    assert r.status_code == 422
    assert "${name}" in r.json()["detail"]


def test_unknown_token_in_split_template_answers_422(client):
    _bootstrap_model(client)
    r = _post(client, _body({"enabled": True, "filename_template": "${name}-${revv}"}))
    assert r.status_code == 422
    assert "${revv}" in r.json()["detail"]


def test_disabled_split_and_xlsx_format_ignore_the_setting(client):
    _bootstrap_model(client)
    r = _post(client, _body({"enabled": False, "filename_template": "${name}"}))
    assert r.headers["content-type"].startswith("application/json")
    body = _body({"enabled": True, "filename_template": "${name}"})
    body["format"] = "xlsx"
    r = _post(client, body)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/vnd.openxml")
