from __future__ import annotations

import threading
import time
from contextlib import asynccontextmanager, suppress
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import tenancy
from .csrf import CSRFMiddleware
from .db import create_all, db_session, init_engine
from .errors import register_exception_handlers
from .feed import lock_event
from .routes import (
    admin,
    artifacts,
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


def _ensure_dev_seed(settings: Settings) -> None:
    """Dev/SQLite convenience: create the tenancy + content schema so local
    dev works without Alembic (Postgres schema is Alembic-owned). Gated by
    ``settings.dev_seed`` — MUST be false in production. No user or model
    seeding happens here: the single admin comes from
    ``_ensure_bootstrap_admin`` and projects are created via the New Project
    wizard (``POST /api/v1/projects``) or the importer CLI."""
    if settings.database_url.startswith("sqlite"):
        create_all()


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
    """Refuse to boot a non-dev deploy (``dev_seed=false``) that still carries a
    known-insecure default: the dev JWT secret (cookie provider only) or the dev
    bootstrap-admin password. Both ship in ``.env.example`` for local
    convenience and MUST be replaced in production."""
    if (
        settings.identity_provider == "cookie"
        and not settings.dev_seed
        and settings.jwt_secret == "dev-insecure-secret-change-me"
    ):
        raise RuntimeError(
            "DATA_ROVER_JWT_SECRET must be set when identity_provider=cookie "
            "and dev_seed=false (refusing to sign tokens with the dev default)"
        )
    if not settings.dev_seed and settings.bootstrap_admin_password == "admin12345":
        raise RuntimeError(
            "DATA_ROVER_BOOTSTRAP_ADMIN_PASSWORD must be changed when "
            "dev_seed=false (refusing to seed the well-known dev admin password "
            "in production)"
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
                            "holder_email": le.holder_email,
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
    app.include_router(artifacts.router, prefix=proj, tags=["artifacts"])
    app.include_router(settings_routes.router, prefix=proj, tags=["settings"])
    app.include_router(feed.router, prefix=proj, tags=["feed"])
    return app


app = create_app()
