"""ScriptStep schema + evaluation tests (model/metamodel fixtures follow
tests/table/test_script_column.py's _mm()/_fixture() pattern rather than
pytest fixtures)."""

from __future__ import annotations

from data_rover.core.metamodel.schema import ElementType, Metamodel
from data_rover.core.model.model import Model
from data_rover.core.navigation.evaluate import PropertyValue, evaluate
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
from data_rover.core.script.warnings import ScriptWarning, ScriptWarningCode
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


# ---- Real ScriptStep evaluation (frontier hops, warnings) -----------------
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
    # occurrences is per START ELEMENT: `Scope(types=[])` matches the whole
    # fixture, so the step fires once per element, not once per evaluate call.
    assert res.warnings == [
        ScriptWarning(
            code=ScriptWarningCode.NAV_STEP_FAILED,
            occurrences=len(model.elements),
            detail=res.warnings[0].detail,
        )
    ]
    assert "boom" in (res.warnings[0].detail or "")


def test_script_step_unresolvable_string_becomes_a_value_terminal() -> None:
    # A string that names no element is DISPLAYED, not dropped: `step()` has
    # no declared return type, so the model decides per value — the same
    # stance a scalar PropertyStep takes, and what makes
    # `return el.properties["name"]` useful instead of silently empty.
    mm, model = _fixture()
    ids = sorted(model.elements)
    defn = _path([ScriptStep(
        snippet=_snip(f"def step(el): return ['{ids[0]}', 'no-such-id']")
    )])
    res = evaluate(mm, model, defn, script=_ctx(model))
    assert res.warnings == []                       # nothing was dropped
    seconds = sorted({chain[1] for chain in res.chains}, key=repr)
    # ids[0] hops (except from itself — the cycle guard); the unknown string
    # terminates every chain at its value.
    assert PropertyValue("no-such-id") in seconds
    assert ids[0] in seconds


def test_script_step_scalar_returns_become_value_terminals() -> None:
    mm, model = _fixture()
    defn = _path([ScriptStep(snippet=_snip("def step(el): return len(el.id)"))])
    res = evaluate(mm, model, defn, script=_ctx(model))
    assert res.warnings == []
    assert all(len(chain) == 2 for chain in res.chains)
    assert all(isinstance(chain[1], PropertyValue) for chain in res.chains)
    assert {chain[1] for chain in res.chains} == {
        PropertyValue(len(i)) for i in model.elements
    }


def test_script_step_mixed_return_keeps_order_and_both_node_kinds() -> None:
    mm, model = _fixture()
    ids = sorted(model.elements)
    defn = _path([ScriptStep(
        snippet=_snip(f"def step(el): return ['{ids[0]}', 7, 'note']")
    )])
    res = evaluate(mm, model, defn, script=_ctx(model))
    start = ids[1]                                   # not ids[0]: no cycle guard hit
    reached = [chain[1] for chain in res.chains if chain[0] == start]
    assert reached == [ids[0], PropertyValue(7), PropertyValue("note")]


def test_script_step_dedup_keeps_distinct_scalar_types() -> None:
    # dict.fromkeys would collapse True/1 (and 1/1.0) into one node — for
    # element ids that never mattered, but these render as "True" and "1".
    mm, model = _fixture()
    defn = _path([ScriptStep(snippet=_snip("def step(el): return [1, True, 1.0, 1]"))])
    res = evaluate(mm, model, defn, script=_ctx(model))
    start = sorted(model.elements)[0]
    reached = [chain[1] for chain in res.chains if chain[0] == start]
    assert reached == [PropertyValue(1), PropertyValue(True), PropertyValue(1.0)]
    # The equality above is type-aware (PropertyValue's own), but spell the
    # surviving types out: a list of three identical `1`s would satisfy a
    # value-only comparison, which is exactly the collapse under test.
    assert [type(n.value).__name__ for n in reached if isinstance(n, PropertyValue)] == [
        "int",
        "bool",
        "float",
    ]


def test_script_step_non_finite_floats_become_strings() -> None:
    # inf/-inf/nan have no JSON literal, so they must never reach the wire as
    # floats (see _hop_script). Each arrives as its repr, a plain string
    # terminal — and, being strings that name no element, stays terminal.
    mm, model = _fixture()
    defn = _path([ScriptStep(snippet=_snip(
        "def step(el): return [float('inf'), float('-inf'), float('nan')]"
    ))])
    res = evaluate(mm, model, defn, script=_ctx(model))
    start = sorted(model.elements)[0]
    reached = [chain[1] for chain in res.chains if chain[0] == start]
    assert reached == [
        PropertyValue("inf"),
        PropertyValue("-inf"),
        PropertyValue("nan"),
    ]
    assert res.warnings == []


def test_step_after_a_value_terminal_prunes_the_chain() -> None:
    # "Block further navigation": identical to a scalar PropertyStep followed
    # by another step — the chain cannot continue from a value.
    mm, model = _fixture()
    ids = sorted(model.elements)
    defn = _path([
        ScriptStep(snippet=_snip("def step(el): return 'not-an-id'")),
        ScriptStep(snippet=_snip(f"def step(el): return ['{ids[0]}']")),
    ])
    res = evaluate(mm, model, defn, script=_ctx(model))
    assert res.chains == []
    assert res.warnings == []


def test_script_step_dangling_and_unconfigured() -> None:
    mm, model = _fixture()
    res = evaluate(
        mm, model,
        _path([ScriptStep(snippet=SnippetSource(ref="missing"))]),
        script=_ctx(model),
    )
    assert res.chains == []
    # occurrences is per START ELEMENT (see above) -- len(model.elements), not 1.
    assert res.warnings == [
        ScriptWarning(
            code=ScriptWarningCode.NAV_SNIPPET_NOT_FOUND,
            occurrences=len(model.elements),
            detail="missing",
        )
    ]
    res = evaluate(mm, model, _path([ScriptStep()]), script=_ctx(model))
    assert res.chains == [] and res.warnings == []      # unconfigured: silent


def test_script_step_no_runner_fallback_prunes_silently() -> None:
    # script=None is the DEGRADED fallback for callers with no runner at all.
    # Table/nav routes always open a context when the definition has script
    # work (table_has_script / navigation_has_script), so this path is never
    # reached from those routes.
    mm, model = _fixture()
    defn = _path([ScriptStep(snippet=_snip("def step(el): return []"))])
    res = evaluate(mm, model, defn)                      # script=None
    assert res.chains == [] and res.warnings == []


def test_script_step_visited_drop_is_silent() -> None:
    # identity return: every id the step returns is already in the chain, so
    # the cycle guard drops them all. That is INTENDED -- "keep this element"
    # is the natural idiom for a step that filters rather than hops -- so it
    # must not warn NAV_ALREADY_VISITED.
    mm, model = _fixture()
    defn = _path([ScriptStep(snippet=_snip("def step(el): return [el]"))])
    res = evaluate(mm, model, defn, script=_ctx(model))
    assert res.chains == []
    assert res.warnings == []


def test_two_distinct_step_failures_stay_two_entries() -> None:
    mm, model = _fixture()
    ctx = _ctx(model)
    evaluate(mm, model, _path([ScriptStep(
        snippet=_snip("def step(el): raise RuntimeError('boom')")
    )]), script=ctx)
    evaluate(mm, model, _path([ScriptStep(
        snippet=_snip("def step(el): raise RuntimeError('kaboom')")
    )]), script=ctx)
    failures = [w for w in ctx.warnings if w.code == ScriptWarningCode.NAV_STEP_FAILED]
    assert len(failures) == 2


def test_chain_result_warnings_are_this_call_only() -> None:
    """`ChainResult.warnings` carries deltas: a second evaluate over a context
    that already logged the same kind must not re-report the first call's
    counts."""
    mm, model = _fixture()
    ctx = _ctx(model)
    # A step failure (unlike an identity return) still warns every call, so it
    # can pin the delta-not-cumulative invariant now that identity returns are
    # silent (see test_script_step_visited_drop_is_silent).
    defn = _path([ScriptStep(snippet=_snip("def step(el): raise RuntimeError('boom')"))])
    first = evaluate(mm, model, defn, script=ctx)
    second = evaluate(mm, model, defn, script=ctx)
    assert first.warnings and second.warnings
    assert second.warnings[0].occurrences == first.warnings[0].occurrences
