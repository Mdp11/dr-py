from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .errors import register_exception_handlers
from .routes import (
    elements,
    health,
    metamodel,
    model,
    relationships,
    validation,
    view,
)
from .settings import get_settings


def create_app() -> FastAPI:
    settings = get_settings()
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
    prefix = "/api/v1"
    app.include_router(metamodel.router, prefix=prefix, tags=["metamodel"])
    app.include_router(model.router, prefix=prefix, tags=["model"])
    app.include_router(elements.router, prefix=prefix, tags=["elements"])
    app.include_router(relationships.router, prefix=prefix, tags=["relationships"])
    app.include_router(validation.router, prefix=prefix, tags=["validation"])
    app.include_router(view.router, prefix=prefix, tags=["view"])

    return app


app = create_app()
