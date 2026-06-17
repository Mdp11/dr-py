from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .db import create_all, get_db, init_engine
from .db_models import Membership, Project, Role, User
from .errors import register_exception_handlers
from .routes import (
    change_request,
    elements,
    health,
    metamodel,
    model,
    ops,
    projects,
    read,
    relationships,
    validation,
    view,
)
from .settings import get_settings

#: Identity + project the dev-seed provisions so the single-user frontend works
#: without a project picker. The frontend sends DEV_USER_ID as its identity.
DEV_USER_ID = "default-user"
DEV_PROJECT_ID = "default"


def _ensure_dev_seed(database_url: str) -> None:
    """Create the schema (SQLite/dev only) and a default user+project.

    Idempotent. Gated by ``settings.dev_seed`` (MUST be false in production,
    where Alembic owns the Postgres schema and real projects are created via
    the API). Lets the existing single-user frontend work against
    ``/api/v1/projects/default`` with the dev identity, no picker needed.

    ``create_all`` runs ONLY for SQLite — never against a non-SQLite
    (Alembic-managed) database, so a dev who forgets ``DATA_ROVER_DEV_SEED=false``
    while pointing at Postgres can't have the ORM stomp the migration schema.
    The row seed itself is harmless/idempotent on any backend.
    """
    if database_url.startswith("sqlite"):
        create_all()
    gen = get_db()
    db = next(gen)
    try:
        if db.get(Project, DEV_PROJECT_ID) is None:
            if db.get(User, DEV_USER_ID) is None:
                db.add(User(id=DEV_USER_ID, email="dev@example.com"))
            db.add(Project(id=DEV_PROJECT_ID, name="Default Project"))
            db.add(
                Membership(
                    user_id=DEV_USER_ID,
                    project_id=DEV_PROJECT_ID,
                    role=Role.owner,
                )
            )
            db.commit()
    finally:
        gen.close()


def create_app() -> FastAPI:
    settings = get_settings()
    init_engine(settings.database_url)
    if settings.dev_seed:
        _ensure_dev_seed(settings.database_url)
    app = FastAPI(
        title="data-rover API",
        version="0.1.0",
        description="HTTP surface for the data-rover MBSE metamodel engine.",
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

    return app


app = create_app()
