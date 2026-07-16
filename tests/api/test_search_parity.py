"""Byte-identical parity between the index-backed fuzzy search and a
reference O(n) scan (spec 2026-07-10-search-index-design: the trigram index
is ONLY a candidate generator; ``_search_score`` stays the sole arbiter of
matching and order). The reference below is the pre-index ``list_elements``
query loop, verbatim."""

from __future__ import annotations

import random

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.routes.read import _search_score
from data_rover.api.session import get_session
from data_rover.core.model.naming import name_of

from .conftest import AUTH_HEADERS, seed_default_project

API = "/api/v1/projects/default"

MM = """
elements:
  - name: Pump
    properties:
      - {name: name, datatype: string}
      - {name: note, datatype: string}
      - {name: size, datatype: integer}
  - name: Pipe
    properties:
      - {name: name, datatype: string}
      - {name: note, datatype: string}
relationships:
  - name: Links
    containment: false
    source: Pump
    target: Pipe
"""

#: small vocabulary => heavy substring/trigram collisions on purpose
WORDS = ["pump", "pipe", "alpha", "beta", "valve", "grid", "hydro", "ab", "x", "straße"]

QUERIES = [
    "pump", "PUMP", "  pump  ",  # case/trim normalization
    "pipe", "hydro", "valve",  # plain substrings
    "pump pipe",  # phrase: only whole-field substrings match
    "alpha-1",  # id fragment
    "pum",  # single-trigram query (len == 3)
    "pu", "x",  # short: scan fallback
    "zzz",  # zero hits
    "grid alpha zzz",  # known trigrams + absent trigram
    "straße",  # unicode: lowering-parity insurance
]


def _text(rng: random.Random) -> str:
    return " ".join(rng.choice(WORDS) for _ in range(rng.randint(0, 4)))


def _client_with_random_model(seed: int, n: int = 200) -> TestClient:
    rng = random.Random(seed)
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(
        f"{API}/metamodel", content=MM, headers={"content-type": "application/x-yaml"}
    )
    assert res.status_code == 200, res.text
    elements = []
    for i in range(n):
        type_name = rng.choice(["Pump", "Pipe"])
        props: dict = {}
        if rng.random() < 0.8:
            # name key casing + shape vary like real (migrated) models:
            # lowercase str, capitalized str, or a multiplicity-many list —
            # all three must be index candidates for the queries the scorer
            # matches (the list shape only reaches trigrams via name_of).
            roll = rng.random()
            if roll < 0.6:
                props["name"] = _text(rng)
            elif roll < 0.8:
                props["Name"] = _text(rng)
            else:
                props["Name"] = ["", _text(rng)]
        if rng.random() < 0.5:
            props["note"] = _text(rng)
        if type_name == "Pump" and rng.random() < 0.3:
            props["size"] = rng.randint(0, 99999)
        elements.append(
            {
                "id": f"{rng.choice(WORDS)}-{i}",  # searchable id fragments
                "type_name": type_name,
                "properties": props,
            }
        )
    res = c.post(f"{API}/model", json={"elements": elements, "relationships": []})
    assert res.status_code == 200, res.text
    return c


def _reference(query: str, type_: str | None) -> tuple[list[str], int]:
    """The pre-index scan loop from routes/read.py, verbatim."""
    model = get_session().model
    assert model is not None
    hits: list[tuple[float, str]] = []
    type_matches: dict[str, bool] = {}
    for element in model.elements.values():
        if type_ is not None and element.type_name != type_:
            continue
        tn = element.type_name
        matches = type_matches.get(tn)
        if matches is None:
            matches = query in tn.lower()
            type_matches[tn] = matches
        score = _search_score(element, query, matches)
        if score > 0:
            hits.append((-score, element.id))
    hits.sort()
    return [eid for _, eid in hits], len(hits)


@pytest.mark.parametrize("seed", [0, 1, 2])
def test_index_search_matches_reference_scan(seed: int) -> None:
    client = _client_with_random_model(seed)
    model = get_session().model
    assert model is not None
    # add a real element name to the battery so the exact-match tier is hit
    # (resolved via name_of so any casing/shape the generator emits qualifies)
    real_name = next(
        (
            name
            for e in model.elements.values()
            if (name := name_of(e)) is not None and len(name) >= 3
        ),
        None,
    )
    queries = QUERIES + ([real_name] if real_name is not None else [])
    for q in queries:
        norm = q.strip().lower()
        for type_ in (None, "Pump"):
            params: dict = {"q": q, "limit": 500}
            if type_ is not None:
                params["type"] = type_
            res = client.get(f"{API}/model/elements", params=params)
            assert res.status_code == 200, res.text
            body = res.json()
            want_ids, want_total = _reference(norm, type_)
            got_ids = [e["id"] for e in body["items"]]
            assert got_ids == want_ids[:500], f"q={q!r} type={type_!r} seed={seed}"
            assert body["total"] == want_total, f"q={q!r} type={type_!r} seed={seed}"

            res = client.get(
                f"{API}/model/elements", params={**params, "limit": 20, "offset": 10}
            )
            assert res.status_code == 200, res.text
            body = res.json()
            got_ids = [e["id"] for e in body["items"]]
            assert got_ids == want_ids[10:30], f"q={q!r} type={type_!r} seed={seed}"
            assert body["total"] == want_total, f"q={q!r} type={type_!r} seed={seed}"
