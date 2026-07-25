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


def test_script_step_unknown_ids_dropped_with_warning() -> None:
    mm, model = _fixture()
    ids = sorted(model.elements)
    defn = _path([ScriptStep(
        snippet=_snip(f"def step(el): return ['{ids[0]}', 'no-such-id']")
    )])
    res = evaluate(mm, model, defn, script=_ctx(model))
    # occurrences/total are per START ELEMENT (see above) -- len(ids), not 1.
    # The start element equal to ids[0] also returns its own id, which trips
    # the already-visited cycle guard too, so `res.warnings` carries a second,
    # unrelated NAV_ALREADY_VISITED entry: filter by code rather than
    # asserting the whole list.
    (entry,) = [w for w in res.warnings if w.code == ScriptWarningCode.NAV_UNKNOWN_IDS]
    assert entry.occurrences == len(ids)
    assert entry.total == len(ids)
    assert all(chain[1] == ids[0] for chain in res.chains)


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
    # the table story -- see 2026-07-23 spec, section 1.
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
    assert res.warnings == [
        ScriptWarning(
            code=ScriptWarningCode.NAV_ALREADY_VISITED,
            occurrences=res.warnings[0].occurrences,
            total=res.warnings[0].total,
        )
    ]
    assert res.warnings[0].total >= 1


def test_unknown_ids_across_many_chains_sum_instead_of_collapsing() -> None:
    """THE BUG: each start element's step drops one unknown id, and the old
    dedup-by-message channel reported that as a single line reading "1"
    regardless of how many chains hit it. One entry is right; a total of 1 is
    not."""
    mm, model = _fixture()
    ids = sorted(model.elements)
    defn = _path([ScriptStep(
        snippet=_snip(f"def step(el): return ['{ids[0]}', 'no-such-id']")
    )])
    res = evaluate(mm, model, defn, script=_ctx(model))
    (entry,) = [w for w in res.warnings if w.code == ScriptWarningCode.NAV_UNKNOWN_IDS]
    assert entry.occurrences == len(ids)
    assert entry.total == len(ids)


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
    counts (the invariant `warnings[w0:]` slicing used to provide)."""
    mm, model = _fixture()
    ctx = _ctx(model)
    defn = _path([ScriptStep(snippet=_snip("def step(el): return [el]"))])
    first = evaluate(mm, model, defn, script=ctx)
    second = evaluate(mm, model, defn, script=ctx)
    assert first.warnings and second.warnings
    assert second.warnings[0].occurrences == first.warnings[0].occurrences
