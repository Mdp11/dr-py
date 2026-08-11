from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import get_session
from data_rover.core.metamodel.loader import load_metamodel_str

from .conftest import AUTH_HEADERS, papi, seed_default_project

# Leading comment + odd spacing are the point: raw must be byte-identical.
_MM = """\
# smart-city seed (comment must survive verbatim)
elements:
  - name: Node
relationships:
  - name: Link
    source: Node
    target: Node
"""

_MM2 = """\
# candidate v2
elements:
  - name: Node
  - name: Sensor
relationships:
  - name: Link
    source: Node
    target: Node
"""

_YAML = {"content-type": "application/x-yaml"}


def _client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def _rev(c: TestClient) -> int:
    return c.get(papi("/model/summary")).json()["model_rev"]


def test_raw_404_when_no_metamodel_bound() -> None:
    c = _client()
    r = c.get(papi("/metamodel/raw"))
    assert r.status_code == 404


def test_raw_returns_stored_blob_verbatim_after_upload() -> None:
    c = _client()
    assert c.post(papi("/metamodel"), content=_MM, headers=_YAML).status_code == 200
    r = c.get(papi("/metamodel/raw"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "stored"
    assert body["blob"] == _MM  # byte-identical, comment intact


def test_raw_returns_rebound_blob_verbatim() -> None:
    c = _client()
    assert c.post(papi("/metamodel"), content=_MM, headers=_YAML).status_code == 200
    assert c.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    r = c.post(
        papi("/metamodel/rebind"),
        content=_MM2,
        headers=_YAML,
        params={"base_rev": _rev(c), "message": "adopt v2"},
    )
    assert r.status_code == 200, r.text
    raw = c.get(papi("/metamodel/raw"))
    assert raw.status_code == 200
    assert raw.json() == {"blob": _MM2, "source": "stored"}


def test_raw_serialized_fallback_without_durable_rows() -> None:
    """A session with an in-memory metamodel but no DB rows degrades to a
    re-serialized blob rather than 404ing (house degraded-never-failed)."""
    c = _client()
    sess = get_session()
    sess.set_metamodel(load_metamodel_str(_MM))
    r = c.get(papi("/metamodel/raw"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "serialized"
    load_metamodel_str(body["blob"])  # must round-trip through the loader
