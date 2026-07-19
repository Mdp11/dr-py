"""M2/M3 embedded-evaluation route tests (TrustedRunner injected). Route-level
coverage lands in Tasks 11-13; this file starts with the script_eval helper."""

from __future__ import annotations

import pytest

from data_rover.api.script_eval import close_script_context, open_script_context
from data_rover.api.settings import Settings
from data_rover.api.snippet_concurrency import ConcurrencyGuard, concurrency_guard
from data_rover.core.metamodel.schema import ElementType, Metamodel
from data_rover.core.model.model import Model
from tests.script.trusted_runner import TrustedRunner


def _settings(**kw) -> Settings:
    return Settings(dev_seed=True, **kw)


@pytest.fixture(autouse=True)
def _reset_concurrency_guard():
    """Safety net for the module-singleton `concurrency_guard`: the tests in
    this file release every slot they acquire (matching the brief's
    `close_script_context` calls), but assert that held here so a leaked
    acquire fails fast in THIS test rather than silently starving a later
    one."""
    yield
    assert concurrency_guard._global_count == 0
    concurrency_guard._per_user_count.clear()


@pytest.fixture(scope="session")
def small_model() -> Model:
    """A minimal Model (one `Building` element) for exercising
    `open_script_context`/`ScriptEvalContext` without a full session fixture."""
    metamodel = Metamodel(elements=[ElementType(name="Building")])
    model = Model(metamodel)
    model.create_element("Building")
    return model


def test_guard_global_slot() -> None:
    g = ConcurrencyGuard()
    assert g.try_acquire_global(global_limit=1)
    assert not g.try_acquire_global(global_limit=1)
    g.release_global()
    assert g.try_acquire_global(global_limit=1)
    g.release_global()


def test_open_context_modes(small_model) -> None:
    s = _settings()
    ctx, acquired = open_script_context(None, None, s, needs_script=False)
    assert ctx is None and not acquired

    ctx, acquired = open_script_context(None, None, s, needs_script=True)
    assert ctx is not None and not acquired          # unavailable mode
    res = ctx.call("def value(els): return 1", "value", ["x"])
    assert res.error is not None and res.error.kind == "unavailable"
    close_script_context(ctx, acquired)

    runner = TrustedRunner()
    ctx, acquired = open_script_context(runner, small_model, s, needs_script=True)
    assert ctx is not None and acquired
    close_script_context(ctx, acquired)


def test_open_context_busy(small_model) -> None:
    s = _settings(snippet_concurrency=1)
    runner = TrustedRunner()
    ctx1, a1 = open_script_context(runner, small_model, s, needs_script=True)
    ctx2, a2 = open_script_context(runner, small_model, s, needs_script=True)
    assert a1 and not a2
    assert ctx2 is not None
    res = ctx2.call("def value(els): return 1", "value", ["x"])
    assert res.error is not None and "busy" in res.error.message
    close_script_context(ctx2, a2)
    close_script_context(ctx1, a1)
    # slot actually freed:
    assert concurrency_guard.try_acquire_global(global_limit=1)
    concurrency_guard.release_global()
