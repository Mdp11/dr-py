"""CSRF guard for cookie-authenticated writes.

The session cookie is SameSite=Strict, but as defense-in-depth every unsafe
request that carries the cookie must ALSO send a custom header that a browser
cannot attach on a cross-site request (no CORS preflight allowance for it).
Header-authenticated requests (gateway/tests) send no cookie and are exempt;
login itself has no cookie yet and is exempt.
"""

from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .settings import get_settings

_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})
_CSRF_HEADER = "x-requested-with"
_CSRF_VALUE = "data-rover"


class CSRFMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        if request.method not in _SAFE_METHODS:
            cookie_name = get_settings().auth_cookie_name
            if cookie_name in request.cookies:
                if request.headers.get(_CSRF_HEADER) != _CSRF_VALUE:
                    return JSONResponse(
                        {"detail": "missing or invalid CSRF header"},
                        status_code=403,
                    )
        return await call_next(request)
