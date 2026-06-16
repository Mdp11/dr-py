from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .db import init_engine
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


def create_app() -> FastAPI:
    settings = get_settings()
    init_engine(settings.database_url)
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
