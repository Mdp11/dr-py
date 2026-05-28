from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response

import yaml

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.metamodel.schema import Metamodel

from ..deps import Session, get_session, require_metamodel

router = APIRouter()


async def _parse_metamodel(request: Request) -> Metamodel:
    body = (await request.body()).decode("utf-8")
    content_type = request.headers.get("content-type", "")
    if "json" in content_type:
        data = await request.json() if body else {}
        return load_metamodel_str(yaml.safe_dump(data))
    return load_metamodel_str(body)


@router.post("/metamodel")
async def upload_metamodel(
    request: Request,
    session: Session = Depends(get_session),
) -> Metamodel:
    metamodel = await _parse_metamodel(request)
    session.metamodel = metamodel
    session.model = None
    return metamodel


@router.get("/metamodel")
def get_metamodel(session: Session = Depends(get_session)) -> Metamodel:
    return require_metamodel(session)


@router.delete("/metamodel", status_code=204)
def clear_metamodel(session: Session = Depends(get_session)) -> Response:
    session.metamodel = None
    session.model = None
    return Response(status_code=204)
