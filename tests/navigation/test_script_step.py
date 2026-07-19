"""ScriptStep schema + evaluation tests. Fixtures follow
tests/navigation/test_evaluate.py's construction pattern."""

from __future__ import annotations

from data_rover.core.navigation.schema import (
    NAVIGATION_ADAPTER,
    PathNavigation,
    ScriptStep,
)


def test_script_step_parses() -> None:
    defn = NAVIGATION_ADAPTER.validate_python(
        {
            "kind": "path",
            "start": {"kind": "scope", "types": []},
            "steps": [
                {"kind": "script", "snippet": {"definition": {"code": "def step(el): return []"}}},
                {"kind": "script", "snippet": {}, "comment": "note"},
            ],
        }
    )
    assert isinstance(defn, PathNavigation)
    assert all(isinstance(s, ScriptStep) for s in defn.steps)
    step1 = defn.steps[1]
    assert isinstance(step1, ScriptStep)
    assert step1.snippet.is_empty
