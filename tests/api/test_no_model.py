"""The server loads no model: no module of the API builds a whole one or reads one
from a document, except the few that are listed here with the reason.

The walk is over every ``.py`` under ``src/data_rover/api``, by ``ast``, for calls
by name. The allowlist is exact: a listed pair that no longer occurs fails too, so
it cannot go stale."""

from __future__ import annotations

import ast
from pathlib import Path

import data_rover.api

API = Path(data_rover.api.__file__).parent

#: calls that build a whole model, or read a model file or snapshot into one
FORBIDDEN = frozenset(
    {
        "Model",
        "build_model_from_dicts",
        "build_partial_model",
        "decode_snapshot",
        "parse_model_json",
    }
)

#: (module path under ``api``, called name): why the call is not a model load
ALLOWED: dict[tuple[str, str], str] = {
    # the one module that builds a model, and a partial one: only the rows a
    # request needs, never the whole project
    ("commit_load.py", "build_partial_model"): "partial model of the needed rows",
    ("commit_load.py", "parse_model_json"): "one row's properties text",
    # one entity's properties text, read back from its row
    ("head.py", "parse_model_json"): "one row's properties text",
    ("rebind_check.py", "parse_model_json"): "one row's properties text",
    # the snapshot codec decodes a blob it is handed; nothing in the API hands it
    # a project's snapshot to build a model from
    ("snapshot_codec.py", "parse_model_json"): "the codec's own decoder",
    # the builders themselves (the golden readers and the tests build models
    # through them); no route or job calls them
    ("routes/_snapshot.py", "Model"): "the dict-to-model builder",
}


def _called_names(tree: ast.AST) -> list[str]:
    names: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name):
            names.append(func.id)
        elif isinstance(func, ast.Attribute):
            names.append(func.attr)
    return names


def _found() -> set[tuple[str, str]]:
    found: set[tuple[str, str]] = set()
    for path in sorted(API.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        rel = path.relative_to(API).as_posix()
        found.update((rel, n) for n in _called_names(tree) if n in FORBIDDEN)
    return found


def test_no_api_module_builds_a_model_but_the_listed_ones() -> None:
    found = _found()
    assert found == set(ALLOWED), (
        f"unlisted: {sorted(found - set(ALLOWED))}; "
        f"listed but no longer called: {sorted(set(ALLOWED) - found)}"
    )


def test_the_session_and_hydration_modules_are_gone() -> None:
    assert not (API / "session.py").exists()
    assert not (API / "hydration.py").exists()


def test_the_walk_sees_a_forbidden_call() -> None:
    tree = ast.parse("m = build_model_from_dicts(a, b)\nx = mod.Model(mm)\nf()\n")
    assert _called_names(tree) == ["build_model_from_dicts", "Model", "f"]
