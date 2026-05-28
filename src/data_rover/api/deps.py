from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from threading import RLock

from fastapi import Depends

from data_rover.core.repository.file_store import FileRepository

from .settings import Settings, get_settings

_INDEX_FILE = "_models.json"
_lock = RLock()


class ModelIndex:
    """Tiny on-disk map from model name -> metamodel name.

    Kept beside the FileRepository data files. Single-process; protected by an
    in-process RLock so concurrent requests inside one worker don't corrupt it.
    """

    def __init__(self, path: Path) -> None:
        self._path = path

    def _read(self) -> dict[str, str]:
        if not self._path.exists():
            return {}
        with self._path.open("r", encoding="utf-8") as fh:
            return json.load(fh) or {}

    def _write(self, data: dict[str, str]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._path.open("w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, sort_keys=True)

    def all(self) -> dict[str, str]:
        with _lock:
            return self._read()

    def get(self, model_name: str) -> str:
        with _lock:
            data = self._read()
            if model_name not in data:
                raise KeyError(f"No model {model_name!r}")
            return data[model_name]

    def set(self, model_name: str, metamodel_name: str) -> None:
        with _lock:
            data = self._read()
            data[model_name] = metamodel_name
            self._write(data)

    def delete(self, model_name: str) -> None:
        with _lock:
            data = self._read()
            data.pop(model_name, None)
            self._write(data)


@lru_cache(maxsize=1)
def _repo_for(data_dir: str) -> FileRepository:
    return FileRepository(data_dir)


def get_repository(settings: Settings = Depends(get_settings)) -> FileRepository:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    return _repo_for(str(settings.data_dir.resolve()))


def get_index(settings: Settings = Depends(get_settings)) -> ModelIndex:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    return ModelIndex(settings.data_dir / _INDEX_FILE)
