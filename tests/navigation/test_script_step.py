"""ScriptStep schema tests (fixture-free; evaluation tests land with Task 9)."""

from __future__ import annotations

from data_rover.core.navigation.resolve import navigation_has_script, resolve_refs
from data_rover.core.navigation.schema import (
    NAVIGATION_ADAPTER,
    PathNavigation,
    Scope,
    ScriptStep,
)
from data_rover.core.script.schema import SnippetDefinition, SnippetSource


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


def _path(steps) -> PathNavigation:
    return PathNavigation(kind="path", start=Scope(types=[]), steps=steps)


def test_resolve_inlines_script_step_refs_and_keeps_dangling() -> None:
    defn = _path([ScriptStep(snippet=SnippetSource(ref="s1")),
                  ScriptStep(snippet=SnippetSource(ref="missing"))])

    def snippet_fetch(aid: str) -> SnippetDefinition:
        if aid == "s1":
            return SnippetDefinition(code="def step(el): return []")
        raise LookupError(aid)

    def nav_fetch(aid: str):
        raise LookupError(aid)

    out = resolve_refs(defn, nav_fetch, snippet_fetch=snippet_fetch)
    assert isinstance(out, PathNavigation)
    step0, step1 = out.steps
    assert isinstance(step0, ScriptStep)
    assert isinstance(step1, ScriptStep)
    assert step0.snippet.definition is not None      # inlined
    assert step0.snippet.ref is None
    assert step1.snippet.ref == "missing"            # dangling marker kept
    orig_step0 = defn.steps[0]
    assert isinstance(orig_step0, ScriptStep)
    assert orig_step0.snippet.ref == "s1"             # input not mutated


def test_navigation_has_script() -> None:
    assert not navigation_has_script(_path([]))
    assert navigation_has_script(
        _path([ScriptStep(snippet=SnippetSource(ref="s1"))])
    )
