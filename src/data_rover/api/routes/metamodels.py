from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response

import yaml

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.repository.file_store import FileRepository

from ..deps import ModelIndex, get_index, get_repository

router = APIRouter()


@router.get("/metamodels")
def list_metamodels(repo: FileRepository = Depends(get_repository)) -> list[str]:
    return sorted(
        p.name.removesuffix(".metamodel.yaml")
        for p in repo._dir.glob("*.metamodel.yaml")
    )


async def _parse_metamodel(request: Request) -> Metamodel:
    body = (await request.body()).decode("utf-8")
    content_type = request.headers.get("content-type", "")
    if "json" in content_type:
        data = await request.json() if body else {}
        return load_metamodel_str(yaml.safe_dump(data))
    return load_metamodel_str(body)


@router.put("/metamodels/{name}")
async def put_metamodel(
    name: str,
    request: Request,
    repo: FileRepository = Depends(get_repository),
) -> Metamodel:
    metamodel = await _parse_metamodel(request)
    repo.save_metamodel(name, metamodel)
    return metamodel


@router.get("/metamodels/{name}")
def get_metamodel(
    name: str, repo: FileRepository = Depends(get_repository)
) -> Metamodel:
    return repo.load_metamodel(name)


@router.delete("/metamodels/{name}", status_code=204)
def delete_metamodel(
    name: str,
    repo: FileRepository = Depends(get_repository),
    index: ModelIndex = Depends(get_index),
) -> Response:
    bound = [m for m, mm in index.all().items() if mm == name]
    if bound:
        raise ValueError(
            f"Metamodel {name!r} is still bound to models: {sorted(bound)}"
        )
    path = repo._path(name, "metamodel", "yaml")
    if not path.exists():
        raise KeyError(f"No metamodel {name!r}")
    path.unlink()
    return Response(status_code=204)
