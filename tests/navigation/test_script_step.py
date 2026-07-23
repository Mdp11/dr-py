"""ScriptStep schema + evaluation tests (Task 9 adds the evaluation tests at
the bottom; model/metamodel fixtures follow tests/table/test_script_column.py's
_mm()/_fixture() pattern rather than pytest fixtures)."""

from __future__ import annotations

from data_rover.core.metamodel.schema import ElementType, Metamodel
from data_rover.core.model.model import Model
from data_rover.core.navigation.evaluate import evaluate
from data_rover.core.navigation.resolve import navigation_has_script, resolve_refs
from data_rover.core.navigation.schema import (
    NAVIGATION_ADAPTER,
    PathNavigation,
    Scope,
    ScriptStep,
)
from data_rover.core.script.embed import ScriptEvalContext
from data_rover.core.script.runner import RunLimits, ScriptBudget
from data_rover.core.script.schema import SnippetDefinition, SnippetSource
from tests.script.trusted_runner import TrustedRunner


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


# ---- Task 9: real ScriptStep evaluation (frontier hops, warnings) ----------
#
# Fixture: three bare "Thing" elements, no properties needed — the snippets
# below only touch `el.id`.


def _mm() -> Metamodel:
    return Metamodel(elements=[ElementType(name="Thing")])


def _fixture() -> tuple[Metamodel, Model]:
    mm = _mm()
    model = Model(mm)
    for _ in range(3):
        model.create_element("Thing")
    return mm, model


def _snip(code: str) -> SnippetSource:
    return SnippetSource(definition=SnippetDefinition(code=code))


def _ctx(model: Model) -> ScriptEvalContext:
    return ScriptEvalContext(TrustedRunner(), model, RunLimits(), ScriptBudget.start(30))


def test_script_step_advances_frontier() -> None:
    mm, model = _fixture()
    ids = sorted(model.elements)
    target = ids[0]
    defn = _path([ScriptStep(
        snippet=_snip(
            f"def step(el):\n    return ['{target}'] if el.id != '{target}' else []"
        ),
        comment="to-target",
    )])
    res = evaluate(mm, model, defn, script=_ctx(model))
    assert res.step_types == ["to-target"]
    assert all(chain[1] == target for chain in res.chains)
    assert all(chain[0] != target for chain in res.chains)  # exclude_visited
    assert res.warnings == []


def test_script_step_error_prunes_with_warning() -> None:
    mm, model = _fixture()
    defn = _path([ScriptStep(snippet=_snip("def step(el): raise RuntimeError('boom')"))])
    res = evaluate(mm, model, defn, script=_ctx(model))
    assert res.chains == []
    assert any("boom" in w for w in res.warnings)


def test_script_step_unknown_ids_dropped_with_warning() -> None:
    mm, model = _fixture()
    ids = sorted(model.elements)
    defn = _path([ScriptStep(
        snippet=_snip(f"def step(el): return ['{ids[0]}', 'no-such-id']")
    )])
    res = evaluate(mm, model, defn, script=_ctx(model))
    assert any("unknown element id" in w for w in res.warnings)
    assert all(chain[1] == ids[0] for chain in res.chains)


def test_script_step_dangling_and_unconfigured() -> None:
    mm, model = _fixture()
    res = evaluate(
        mm, model,
        _path([ScriptStep(snippet=SnippetSource(ref="missing"))]),
        script=_ctx(model),
    )
    assert res.chains == [] and any("not found" in w for w in res.warnings)
    res = evaluate(mm, model, _path([ScriptStep()]), script=_ctx(model))
    assert res.chains == [] and res.warnings == []      # unconfigured: silent


def test_script_step_without_context_prunes_silently() -> None:
    mm, model = _fixture()
    defn = _path([ScriptStep(snippet=_snip("def step(el): return []"))])
    res = evaluate(mm, model, defn)                      # script=None
    assert res.chains == [] and res.warnings == []


def test_script_step_visited_drop_warns() -> None:
    # identity return: every id the step returns is already in the chain, so
    # the cycle guard drops them all -- previously with NO signal at all
    mm, model = _fixture()
    defn = _path([ScriptStep(snippet=_snip("def step(el): return [el]"))])
    res = evaluate(mm, model, defn, script=_ctx(model))
    assert res.chains == []
    assert any("already visited" in w for w in res.warnings)
