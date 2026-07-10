"""Opt-in perf probe for the interactive read path (spec §1).

Run:  pixi run -e core-dev pytest tests/api/test_perf_probe.py -m perf -s
Env:  PERF_N (default 50000) controls the synthetic element count.

Half the elements are containment roots, each containing one child, so the
roots endpoints see a large root set (the audited hot spot). Numbers are
printed, not asserted — this is a measurement harness, not a regression gate.
"""

from __future__ import annotations

import os
import time

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, seed_default_project

pytestmark = pytest.mark.perf

API = "/api/v1/projects/default"

MM = """
elements:
  - name: Item
    properties:
      - {name: name, datatype: string}
relationships:
  - name: Contains
    containment: true
    source: Item
    target: Item
"""


def _timed_get(client: TestClient, label: str, path: str, params: dict | None = None) -> None:
    t0 = time.perf_counter()
    res = client.get(path, params=params or {})
    dt_ms = (time.perf_counter() - t0) * 1000
    assert res.status_code == 200, res.text
    print(f"{label:<44} {dt_ms:8.1f} ms")


def test_perf_probe() -> None:
    n = int(os.environ.get("PERF_N", "50000"))
    half = n // 2
    seed_default_project()
    client = TestClient(create_app())
    client.headers.update(AUTH_HEADERS)
    res = client.post(
        f"{API}/metamodel", content=MM, headers={"content-type": "application/x-yaml"}
    )
    assert res.status_code == 200, res.text

    elements = [
        {"id": f"e{i}", "type_name": "Item", "properties": {"name": f"Element {i:07d}"}}
        for i in range(n)
    ]
    relationships = [
        {
            "id": f"r{i}",
            "type_name": "Contains",
            "source_id": f"e{i}",
            "target_id": f"e{half + i}",
            "properties": {},
        }
        for i in range(half)
    ]
    t0 = time.perf_counter()
    res = client.post(
        f"{API}/model/upload",
        json={"elements": elements, "relationships": relationships},
    )
    assert res.status_code == 200, res.text
    print(f"\nupload+install ({n} elements)              {(time.perf_counter() - t0) * 1000:8.1f} ms")

    _timed_get(client, "containment roots, first page", f"{API}/model/containment/roots", {"limit": 100})
    _timed_get(client, "containment roots, deep page", f"{API}/model/containment/roots", {"limit": 100, "offset": max(half - 200, 0)})
    _timed_get(client, "excluded roots, first page", f"{API}/model/containment/roots/excluded", {"limit": 100})
    _timed_get(client, "children of e0", f"{API}/model/elements/e0/children", {"limit": 100})
    _timed_get(client, "elements, deep page (insertion order)", f"{API}/model/elements", {"limit": 100, "offset": max(n - 200, 0)})
    _timed_get(client, "summary", f"{API}/model/summary")

    sel = f"{n // 2:07d}"  # zero-padded name fragment of exactly one element
    _timed_get(client, f"fuzzy search, selective (q={sel})", f"{API}/model/elements", {"q": sel, "limit": 50})
    _timed_get(client, "fuzzy search, degenerate (q=element)", f"{API}/model/elements", {"q": "element", "limit": 50})
    _timed_get(client, "fuzzy search, short fallback (q=el)", f"{API}/model/elements", {"q": "el", "limit": 50})
