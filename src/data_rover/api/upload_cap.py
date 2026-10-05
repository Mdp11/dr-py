"""A ceiling on the body of the project-creation upload.

Starlette parses a multipart body itself, before the route runs, so the route
cannot count the bytes it reads. This middleware sits in front of the route's
path: a ``Content-Length`` over ``settings.max_request_body_bytes`` is refused
before a byte is read, and since that header is client-supplied and absent on a
chunked body, the running total is enforced while the parser streams too. 413,
not 422: too large is not malformed. 0 disables the cap.
"""

from __future__ import annotations

from fastapi import HTTPException
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .settings import get_settings


def _too_large(limit: int) -> HTTPException:
    return HTTPException(
        status_code=413, detail=f"Request body is too large (limit {limit} bytes)"
    )


class UploadCapMiddleware:
    def __init__(self, app: ASGIApp, *, path: str) -> None:
        self.app = app
        self.path = path

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        limit = get_settings().max_request_body_bytes
        if (
            scope["type"] != "http"
            or scope["method"] != "POST"
            or scope["path"] != self.path
            or limit <= 0
        ):
            await self.app(scope, receive, send)
            return
        declared = dict(scope["headers"]).get(b"content-length", b"")
        if declared.isdigit() and int(declared) > limit:
            refusal = _too_large(limit)
            await JSONResponse(
                {"detail": refusal.detail}, status_code=refusal.status_code
            )(scope, receive, send)
            return
        total = 0

        async def capped() -> Message:
            nonlocal total
            message = await receive()
            if message["type"] == "http.request":
                total += len(message.get("body", b""))
                if total > limit:
                    raise _too_large(limit)
            return message

        await self.app(scope, capped, send)
