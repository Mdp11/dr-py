from __future__ import annotations

import json
import threading
import time
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import importer, tenancy
from .csrf import CSRFMiddleware
from .db import create_all, db_session, init_engine
from .db_models import Role
from .errors import register_exception_handlers
from .feed import lock_event
from .routes import (
    admin,
    auth,
    change_request,
    commits,
    elements,
    feed,
    health,
    locks,
    metamodel,
    metamodel_swap,
    model,
    ops,
    projects,
    read,
    relationships,
    settings as settings_routes,
    validation,
    view,
)
from .session import get_registry, install_persistent_registry
from .settings import Settings, get_settings
from .storage import build_store_from_settings, set_snapshot_store

DEV_USER_ID = "default-user"
DEV_PROJECT_ID = "default"
_EXAMPLES = Path(__file__).resolve().parents[3] / "examples"


def _seed_artifact(configured: str, default_name: str) -> Path:
    """Resolve a dev-seed artifact path: the configured path (CWD-relative) if
    set, else the bundled ``examples/smart-city.*`` fallback."""
    return Path(configured) if configured else (_EXAMPLES / default_name)


def _provision_dev_users(users_file: str) -> None:
    """Provision extra dev users as members of the seeded ``default`` project
    from a JSON file (``DATA_ROVER_DEV_USERS_FILE``), so local multi-user
    testing needs no manual member calls. Idempotent (upserts users +
    memberships); runs even when the project already exists. Skips silently if
    no path is configured or the file is absent. Dev-only — the caller is gated
    by ``settings.dev_seed``.

    File shape: ``{"users": [{"id": "alice", "email": "a@x", "role": "editor"}]}``
    (a bare list of user objects is also accepted). ``role`` defaults to
    ``editor``; ``email`` defaults to ``<id>@example.com``."""
    if not users_file:
        return
    path = Path(users_file)
    if not path.exists():
        return
    data = json.loads(path.read_text("utf-8"))
    users = data.get("users", []) if isinstance(data, dict) else data
    if not users:
        return
    with db_session() as s:
        for entry in users:
            uid = entry["id"]
            email = entry.get("email") or f"{uid}@example.com"
            role = Role(entry.get("role", "editor"))
            tenancy.upsert_user(s, uid, email)
            tenancy.add_member(s, DEV_PROJECT_ID, uid, role)
    print(f"[dev-seed] provisioned {len(users)} user(s) from {path}")


def _ensure_dev_seed(settings: Settings) -> None:
    """Dev/SQLite only: create the schema, import the configured seed model as
    the ``default`` project, and provision any extra dev users so the frontend
    opens a real model and local multi-user testing works out of the box.

    The seed model defaults to the bundled smart-city example but is overridable
    via ``DATA_ROVER_SEED_METAMODEL`` / ``_MODEL`` / ``_VIEW``. Idempotent (the
    importer no-ops if the project exists; user provisioning upserts). Gated by
    ``settings.dev_seed`` — MUST be false in production."""
    if settings.database_url.startswith("sqlite"):
        create_all()
    view_path = _seed_artifact(settings.seed_view, "smart-city.view.json")
    importer.import_project(
        project_id=DEV_PROJECT_ID,
        name="Smart City",
        owner_id=DEV_USER_ID,
        metamodel_yaml=_seed_artifact(
            settings.seed_metamodel, "smart-city.metamodel.yaml"
        ).read_text("utf-8"),
        model_json=_seed_artifact(
            settings.seed_model, "smart-city.model.json"
        ).read_text("utf-8"),
        view_json=view_path.read_text("utf-8") if view_path.exists() else None,
    )
    _provision_dev_users(settings.dev_users_file)
    # dev convenience: a known admin login (overridden by BOOTSTRAP_ADMIN_* if set),
    # made an OWNER of the seeded ``default`` project so the single dev admin can
    # actually open and edit it. ``is_admin`` (admin-sees-all) grants picker
    # VISIBILITY of every project but NOT membership, and the project data/feed
    # routes still require membership — so without this the dev admin would see
    # "Smart City" yet 403 on opening it. add_member upserts (idempotent).
    if not settings.bootstrap_admin_email:
        with db_session() as s:
            admin = tenancy.get_user_by_email(s, "admin@example.com")
            if admin is None:
                admin = tenancy.create_user(
                    s, "admin@example.com", "admin12345", is_admin=True
                )
            tenancy.add_member(s, DEV_PROJECT_ID, admin.id, Role.owner)


def _ensure_bootstrap_admin(settings: Settings) -> None:
    """Idempotently ensure an admin exists (from DATA_ROVER_BOOTSTRAP_ADMIN_*),
    so a fresh deploy has a first admin to log in as (admin-only provisioning
    means no self-signup). Independent of dev_seed. No-op if email is unset."""
    if not settings.bootstrap_admin_email:
        return
    with db_session() as s:
        existing = tenancy.get_user_by_email(s, settings.bootstrap_admin_email)
        if existing is None:
            tenancy.create_user(
                s,
                settings.bootstrap_admin_email,
                settings.bootstrap_admin_password,
                is_admin=True,
            )
        elif not existing.is_admin:
            tenancy.set_user_fields(s, existing.id, is_admin=True)


def _guard_prod_secret(settings: Settings) -> None:
    """Refuse to boot the cookie provider in a non-dev deploy still using the
    insecure default JWT secret."""
    insecure_default = "dev-insecure-secret-change-me"
    if (
        settings.identity_provider == "cookie"
        and not settings.dev_seed
        and settings.jwt_secret == insecure_default
    ):
        raise RuntimeError(
            "DATA_ROVER_JWT_SECRET must be set when identity_provider=cookie "
            "and dev_seed=false (refusing to sign tokens with the dev default)"
        )


def _idle_sweep_once(now: float, ttl: float) -> list[str]:
    """Evict (snapshot-then-drop) every session idle for >= ttl. Returns the
    evicted project ids. Pure single-pass — the background loop calls this on a
    timer; tests call it directly with a controlled ``now``."""
    reg = get_registry()
    stale = reg.idle(now=now, ttl=ttl)
    for pid in stale:
        reg.evict(pid)
    return stale


def _start_idle_sweeper(ttl: float) -> tuple[threading.Thread, threading.Event]:
    stop = threading.Event()

    def _loop() -> None:
        interval = max(1.0, ttl / 4)
        while not stop.wait(interval):
            with suppress(Exception):  # a sweep failure must not kill the loop
                _idle_sweep_once(now=time.monotonic(), ttl=ttl)

    t = threading.Thread(target=_loop, name="idle-sweeper", daemon=True)
    t.start()
    return t, stop


def _sweep_expired_locks(now: float) -> int:
    """Drop expired leases from every warm session. Returns count released.

    Iterates warm_items() so the sweeper neither refreshes last_access
    (which would defeat the idle-evict sweeper) nor hydrates cold/evicted
    projects (which would undo the eviction).

    Broadcasts lock{expired} for each session whose leases were swept,
    outside the write_mutex (enqueue is non-blocking; no mutex needed)."""
    released = 0
    for _pid, session in get_registry().warm_items():
        with session.write_mutex:
            expired = session.lock_table.sweep_expired(now)
        if expired:
            session.hub.broadcast(
                lock_event(
                    "expired",
                    [
                        {
                            "resource_id": le.resource_id,
                            "mode": le.mode.value,
                            "holder_id": le.holder,
                        }
                        for le in expired
                    ],
                )
            )
        released += len(expired)
    return released


def _start_lock_sweeper(interval: float) -> tuple[threading.Thread, threading.Event]:
    stop = threading.Event()

    def _loop() -> None:
        while not stop.wait(interval):
            with suppress(Exception):  # a sweep failure must not kill the loop
                _sweep_expired_locks(time.monotonic())

    t = threading.Thread(target=_loop, name="lock-sweeper", daemon=True)
    t.start()
    return t, stop


def create_app() -> FastAPI:
    settings = get_settings()
    init_engine(settings.database_url)
    set_snapshot_store(build_store_from_settings(settings))
    install_persistent_registry()
    _guard_prod_secret(settings)
    if settings.dev_seed:
        _ensure_dev_seed(settings)
    _ensure_bootstrap_admin(settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        idle_thread = idle_stop = None
        if settings.idle_evict_seconds > 0:
            idle_thread, idle_stop = _start_idle_sweeper(
                float(settings.idle_evict_seconds)
            )
        lock_thread = lock_stop = None
        if settings.lock_sweep_seconds > 0:
            lock_thread, lock_stop = _start_lock_sweeper(
                float(settings.lock_sweep_seconds)
            )
        try:
            yield
        finally:
            if idle_stop is not None:
                idle_stop.set()
            if idle_thread is not None:
                idle_thread.join(timeout=2.0)
            if lock_stop is not None:
                lock_stop.set()
            if lock_thread is not None:
                lock_thread.join(timeout=2.0)

    app = FastAPI(
        title="data-rover API",
        version="0.1.0",
        description="HTTP surface for the data-rover MBSE metamodel engine.",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(CSRFMiddleware)
    register_exception_handlers(app)
    app.include_router(auth.router, prefix="/api/v1", tags=["auth"])
    app.include_router(admin.router, prefix="/api/v1", tags=["admin"])
    app.include_router(health.router)
    app.include_router(projects.router, prefix="/api/v1", tags=["projects"])
    proj = "/api/v1/projects/{project_id}"
    app.include_router(metamodel.router, prefix=proj, tags=["metamodel"])
    app.include_router(metamodel_swap.router, prefix=proj, tags=["metamodel"])
    app.include_router(model.router, prefix=proj, tags=["model"])
    app.include_router(ops.router, prefix=proj, tags=["ops"])
    app.include_router(read.router, prefix=proj, tags=["read"])
    app.include_router(change_request.router, prefix=proj, tags=["change-request"])
    app.include_router(elements.router, prefix=proj, tags=["elements"])
    app.include_router(relationships.router, prefix=proj, tags=["relationships"])
    app.include_router(validation.router, prefix=proj, tags=["validation"])
    app.include_router(view.router, prefix=proj, tags=["view"])
    app.include_router(locks.router, prefix=proj, tags=["locks"])
    app.include_router(commits.router, prefix=proj, tags=["commits"])
    app.include_router(settings_routes.router, prefix=proj, tags=["settings"])
    app.include_router(feed.router, prefix=proj, tags=["feed"])
    return app


app = create_app()
