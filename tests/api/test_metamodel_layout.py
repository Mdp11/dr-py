"""GET/PUT /metamodel/layout — shared canvas positions (spec 2026-08-13 §5).

Presentation-only: last-write-wins, no lease, no commit journal entry. The
authz matrix is the standard method-based one: any member reads, editors+
write, viewers 403 on PUT, non-members 403, unknown project 404.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db
from data_rover.api.db_models import Membership, MetamodelLayoutRow, Role, User
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID

from .conftest import AUTH_HEADERS, papi, seed_default_project

VIEWER_HEADERS = {"x-user-id": "viewer-user", "x-user-email": "viewer@example.com"}
STRANGER_HEADERS = {"x-user-id": "stranger", "x-user-email": "stranger@example.com"}

PAYLOAD = {"positions": {"el:Zone": {"x": 12.5, "y": -40.0}, "enum:Status": {"x": 0, "y": 0}}}


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def _seed_viewer() -> None:
    gen = db.get_db()
    s = next(gen)
    try:
        if s.get(User, "viewer-user") is None:
            s.add(User(id="viewer-user", email="viewer@example.com"))
            s.add(
                Membership(
                    user_id="viewer-user", project_id=DEFAULT_PROJECT_ID, role=Role.viewer
                )
            )
            s.commit()
    finally:
        gen.close()


def test_get_layout_empty_before_any_save(client):
    seed_default_project()
    r = client.get(papi("/metamodel/layout"), headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.json() == {"positions": {}}


def test_put_then_get_round_trips(client):
    seed_default_project()
    r = client.put(papi("/metamodel/layout"), json=PAYLOAD, headers=AUTH_HEADERS)
    assert r.status_code == 204
    r = client.get(papi("/metamodel/layout"), headers=AUTH_HEADERS)
    assert r.json()["positions"]["el:Zone"] == {"x": 12.5, "y": -40.0}


def test_put_overwrites_last_write_wins(client):
    seed_default_project()
    client.put(papi("/metamodel/layout"), json=PAYLOAD, headers=AUTH_HEADERS)
    second = {"positions": {"el:Zone": {"x": 1.0, "y": 2.0}}}
    client.put(papi("/metamodel/layout"), json=second, headers=AUTH_HEADERS)
    r = client.get(papi("/metamodel/layout"), headers=AUTH_HEADERS)
    assert r.json() == second


def test_viewer_reads_but_cannot_write(client):
    seed_default_project()
    _seed_viewer()
    assert client.get(papi("/metamodel/layout"), headers=VIEWER_HEADERS).status_code == 200
    r = client.put(papi("/metamodel/layout"), json=PAYLOAD, headers=VIEWER_HEADERS)
    assert r.status_code == 403


def test_non_member_403_unknown_project_404(client):
    seed_default_project()
    assert (
        client.get(papi("/metamodel/layout"), headers=STRANGER_HEADERS).status_code == 403
    )
    r = client.get(
        "/api/v1/projects/nope/metamodel/layout", headers=AUTH_HEADERS
    )
    assert r.status_code == 404


def test_invalid_payload_422(client):
    seed_default_project()
    r = client.put(
        papi("/metamodel/layout"),
        json={"positions": {"el:Zone": {"x": "NaN-ish"}}},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 422


def test_put_metamodel_layout_survives_concurrent_first_write_race(client):
    """Two concurrent FIRST PUTs for a project both see ``get() is None`` and
    both attempt an INSERT (see ``content.put_metamodel_layout``'s docstring).
    This exercises that exact race directly against the service function
    (HTTP's one-session-per-request DI has no seam to inject a second,
    genuinely-concurrent writer): while our session's ``get()`` call is
    in-flight, commit a DIFFERENT row through a second session, so the INSERT
    this call goes on to attempt truly does collide on the primary key and
    the retry-as-update path is what resolves it — not a sequential PUT/PUT
    round trip, which would never reach the collision at all.

    Without the fix (bare ``add()``+``commit()`` on the check-then-act path)
    this raises ``sqlalchemy.exc.IntegrityError`` and the test fails; the
    fix's retry must land instead, and per last-write-wins the SECOND
    (this call's) payload must be what's stored, not the racer's.
    """
    seed_default_project()
    project_id = DEFAULT_PROJECT_ID
    racer_payload = {"positions": {"el:Racer": {"x": 1.0, "y": 1.0}}}
    our_payload = {"positions": {"el:Ours": {"x": 9.0, "y": 9.0}}}

    gen = db.get_db()
    session = next(gen)
    try:
        real_get = session.get

        def racing_get(model, ident, *args, **kwargs):
            # Only intercept the ONE lookup that content.put_metamodel_layout
            # makes at the top of its check-then-act; restore the real method
            # immediately so the retry's re-fetch below sees the true state.
            session.get = real_get
            if model is MetamodelLayoutRow and ident == project_id:
                racer_gen = db.get_db()
                racer = next(racer_gen)
                try:
                    racer.add(MetamodelLayoutRow(project_id=project_id, blob=racer_payload))
                    racer.commit()
                finally:
                    racer_gen.close()
                return None
            return real_get(model, ident, *args, **kwargs)

        session.get = racing_get  # type: ignore[method-assign]

        content.put_metamodel_layout(session, project_id, our_payload)
    finally:
        gen.close()

    verify_gen = db.get_db()
    verify = next(verify_gen)
    try:
        stored = verify.get(MetamodelLayoutRow, project_id)
        assert stored is not None
        assert stored.blob == our_payload
    finally:
        verify_gen.close()
