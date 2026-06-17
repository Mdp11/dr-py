from __future__ import annotations

import threading
import time
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import importer
from .db import create_all, init_engine
from .errors import register_exception_handlers
from .routes import (
    change_request,
    commits,
    elements,
    health,
    locks,
    metamodel,
    model,
    ops,
    projects,
    read,
    relationships,
    validation,
    view,
)
from .session import get_registry, install_persistent_registry
from .settings import get_settings
from .storage import build_store_from_settings, set_snapshot_store

DEV_USER_ID = "default-user"
DEV_PROJECT_ID = "default"
_EXAMPLES = Path(__file__).resolve().parents[3] / "examples"


def _ensure_dev_seed(database_url: str) -> None:
    """SQLite/dev only: create the schema and import the smart-city example as
    the ``default`` project so the single-user frontend opens a real model.

    Idempotent (the importer no-ops if the project exists). Gated by
    ``settings.dev_seed`` — MUST be false in production."""
    if database_url.startswith("sqlite"):
        create_all()
    importer.import_project(
        project_id=DEV_PROJECT_ID,
        name="Smart City",
        owner_id=DEV_USER_ID,
        metamodel_yaml=(_EXAMPLES / "smart-city.metamodel.yaml").read_text("utf-8"),
        model_json=(_EXAMPLES / "smart-city.model.json").read_text("utf-8"),
        view_json=(_EXAMPLES / "smart-city.view.json").read_text("utf-8"),
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
    projects (which would undo the eviction)."""
    released = 0
    for _pid, session in get_registry().warm_items():
        with session.write_mutex:
            released += len(session.lock_table.sweep_expired(now))
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
    if settings.dev_seed:
        _ensure_dev_seed(settings.database_url)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        idle_thread = idle_stop = None
        if settings.idle_evict_seconds > 0:
            idle_thread, idle_stop = _start_idle_sweeper(float(settings.idle_evict_seconds))
        lock_thread = lock_stop = None
        if settings.lock_sweep_seconds > 0:
            lock_thread, lock_stop = _start_lock_sweeper(float(settings.lock_sweep_seconds))
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
    register_exception_handlers(app)
    app.include_router(health.router)
    app.include_router(projects.router, prefix="/api/v1", tags=["projects"])
    proj = "/api/v1/projects/{project_id}"
    app.include_router(metamodel.router, prefix=proj, tags=["metamodel"])
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
    return app


app = create_app()
