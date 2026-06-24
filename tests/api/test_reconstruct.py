"""Unit tests for hydration.reconstruct_model_at (historical model state)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from data_rover.api.hydration import reconstruct_model_at
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID
from tests.api.conftest import (
    AUTH_HEADERS,
    commit_create,
    model_rev,
    papi,
    seed_default_project,
)

_MM = """
elements:
  - name: Node
    properties:
      - name: label
        datatype: string
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
"""


def _client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    assert c.post(papi("/metamodel"), content=_MM,
                  headers={"content-type": "application/x-yaml"}).status_code == 200
    assert c.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    return c


def test_reconstruct_at_mid_rev_excludes_later_commits() -> None:
    c = _client()
    commit_create(c, "A")          # rev R1
    r1 = model_rev(c)
    commit_create(c, "B")          # rev R2
    m_at_r1 = reconstruct_model_at(DEFAULT_PROJECT_ID, r1)
    m_at_head = reconstruct_model_at(DEFAULT_PROJECT_ID, model_rev(c))
    assert m_at_r1 is not None and m_at_head is not None
    assert len(m_at_r1.elements) == 1     # only A
    assert len(m_at_head.elements) == 2   # A + B


def test_reconstruct_survives_eviction() -> None:
    from data_rover.api.session import get_registry

    c = _client()
    commit_create(c, "A")
    r1 = model_rev(c)
    commit_create(c, "B")
    get_registry().evict(DEFAULT_PROJECT_ID)
    m = reconstruct_model_at(DEFAULT_PROJECT_ID, r1)
    assert m is not None and len(m.elements) == 1


_MM_RENAMED = """
elements:
  - name: Widget
relationships:
  - name: Contains
    containment: true
    source: Widget
    target: Widget
"""


def test_reconstruct_before_a_rebind_uses_prior_metamodel() -> None:
    """A rev BEFORE a metamodel swap reconstructs against the pre-swap
    metamodel (first_rebind_after -> from_metamodel_id) and tolerates the
    now-removed 'Node' type via strict=False."""
    c = _client()
    commit_create(c, "A")          # Node element under the original metamodel
    r1 = model_rev(c)
    rebind = c.post(
        papi("/metamodel/rebind") + f"?base_rev={model_rev(c)}&message=swap",
        content=_MM_RENAMED, headers={"content-type": "application/x-yaml"},
    )
    assert rebind.status_code == 200, rebind.text
    # reconstructing at r1 (pre-swap) must still yield the Node element and not
    # raise, even though the CURRENT metamodel no longer defines 'Node'.
    m = reconstruct_model_at(DEFAULT_PROJECT_ID, r1)
    assert m is not None and len(m.elements) == 1
