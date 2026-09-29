"""A view's warnings as ``GET /views/{id}`` computes them: the view document
against the smart-city example, which has containment, and a project with two
artifacts.

The views put every warning in its place: a folder's artifact refs before its
child folders before its elements, the root's artifact refs last, a duplicate
top-level folder skipped with a subtree that would warn, duplicate sibling
folders nested and under a root folder with an empty name, an element that
fails several checks warned once by the first, an element listed twice in one
folder, names a ``repr`` quotes differently or that hold a ``/``, and a known
next to an unknown artifact. Folders leave out what the document may leave
out. Two views are validated again with ops staged: an element they place
deleted, then contained."""

from __future__ import annotations

import re
from typing import Any

from data_rover.core.metamodel.loader import load_metamodel_str

from ..driver import ROOT, scenario
from ..model_steps import run_steps, validate_view_step

_METAMODEL_FILE = ROOT / "examples" / "smart-city.metamodel.yaml"
_MODEL_FILE = "examples/smart-city.model.json"

#: an organization, a team it owns, and two teams nothing contains
_ORG = "e_000001"
_OWNED = "e_000006"
_FREE = "e_000026"
_OTHER = "e_000027"

_KNOWN = "a-known"
_ARTIFACTS = {
    _KNOWN: {"kind": "table", "payload": {"schema_version": 1, "columns": []}},
    "a-spare": {"kind": "table", "payload": {"schema_version": 1, "columns": []}},
}


def _ref(artifact_id: str) -> dict[str, Any]:
    return {"id": artifact_id, "kind": "table"}


def _folder(name: str, **parts: Any) -> dict[str, Any]:
    return {"name": name, **parts}


#: artifacts, then children, then elements, the root's artifacts last; the
#: duplicate top-level folder's subtree would warn, and does not
_ORDER = {
    "name": "order",
    "folders": [
        _folder(
            "top",
            id="f-top",
            artifacts=[_ref(_KNOWN), _ref("a-gone")],
            folders=[
                _folder("child", elements=["missing-1"]),
                _folder("child", elements=["missing-2"], folders=[_folder("x")]),
                _folder("", id="f-blank", elements=[_FREE]),
            ],
            elements=[_OWNED, _FREE],
        ),
        _folder(
            "top",
            artifacts=[_ref("a-skipped")],
            folders=[_folder("inner", elements=["missing-3"])],
            elements=["missing-4", _OWNED],
        ),
    ],
    "artifacts": [_ref("a-root-gone"), _ref(_KNOWN)],
}

#: duplicate siblings under a root folder named "" and deeper down; an
#: unknown and a contained element twice each, one clean element twice in one
#: folder and again in another
_PRECEDENCE = {
    "name": "it's",
    "folders": [
        _folder(
            "",
            folders=[
                _folder("dup", elements=[_OTHER]),
                _folder("dup", elements=["missing-5"]),
                _folder(
                    "a/b",
                    id="f-slash",
                    folders=[
                        _folder("same", elements=[]),
                        _folder("same"),
                        _folder("Same"),
                    ],
                    elements=[_OTHER],
                ),
            ],
        ),
        _folder(
            'say "hi" it\'s',
            elements=["missing-6", "missing-6", _OWNED, _OWNED, _FREE, _FREE],
        ),
        _folder("later", elements=[_FREE]),
    ],
}

#: nothing to warn about until the staged ops touch its elements
_CLEAN = {
    "name": "quote \" and '",
    "folders": [_folder("teams", elements=[_FREE, _OTHER])],
    "artifacts": [_ref(_KNOWN)],
}

_DELETE_FREE = [{"kind": "delete_element", "id": _FREE}]
_CONTAIN_OTHER = [
    {
        "kind": "create_relationship",
        "temp_id": "tmp_owns",
        "type_name": "Owns",
        "source_id": _ORG,
        "target_id": _OTHER,
    }
]

#: each message kind, by its fixed wording
_KINDS = {
    "A": r"references unknown artifact",
    "B": r"duplicate folder .* under ",
    "C": r"references unknown element",
    "D": r"has a containment parent",
    "E": r"is placed in multiple folders",
    "F": r"duplicate top-level folder",
}


@scenario("view_warnings")
def view_warnings() -> Any:
    metamodel = load_metamodel_str(_METAMODEL_FILE.read_text(encoding="utf-8"))
    run = run_steps(
        metamodel,
        [
            {"do": "artifacts", "_artifacts": _ARTIFACTS},
            {"do": "seed"},
            validate_view_step(_ORDER),
            validate_view_step(_PRECEDENCE),
            validate_view_step(_CLEAN),
            validate_view_step(_CLEAN, _DELETE_FREE),
            validate_view_step(_CLEAN, _CONTAIN_OTHER),
            validate_view_step(_PRECEDENCE, _DELETE_FREE),
            validate_view_step(_PRECEDENCE, _CONTAIN_OTHER),
        ],
        full_every=None,
        model_file=_MODEL_FILE,
    )
    messages = [
        issue["message"]
        for step in run["steps"]
        if step["do"] == "validate_view"
        for issue in step["result"]
    ]
    for kind, pattern in _KINDS.items():
        assert any(re.search(pattern, m) for m in messages), f"no {kind} warning"
    results = [step["result"] for step in run["steps"] if step["do"] == "validate_view"]
    assert results[2] == [], results[2]
    assert [i["target_ids"] for i in results[3]] == [[_FREE]], results[3]
    assert "unknown element" in results[3][0]["message"]
    assert [i["target_ids"] for i in results[4]] == [[_OTHER]], results[4]
    assert "containment parent" in results[4][0]["message"]
    return run
