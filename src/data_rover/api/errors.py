from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from data_rover.core.metamodel.loader import MetamodelError
from data_rover.core.repository.repository import ConflictError

logger = logging.getLogger(__name__)


def _json(status: int, message: str, **extra: object) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message, **extra})


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(KeyError)
    async def _key_error(_: Request, exc: KeyError) -> JSONResponse:
        return _json(404, str(exc).strip("'\""))

    @app.exception_handler(ConflictError)
    async def _conflict(_: Request, exc: ConflictError) -> JSONResponse:
        return _json(409, str(exc))

    @app.exception_handler(MetamodelError)
    async def _bad_metamodel(_: Request, exc: MetamodelError) -> JSONResponse:
        return _json(422, str(exc))

    @app.exception_handler(ValidationError)
    async def _validation(_: Request, exc: ValidationError) -> JSONResponse:
        return _json(422, "validation_error", details=exc.errors())

    @app.exception_handler(ValueError)
    async def _value(_: Request, exc: ValueError) -> JSONResponse:
        return _json(422, str(exc))
