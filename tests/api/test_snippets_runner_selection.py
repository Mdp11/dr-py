"""Tests for Task 10: runner selection, settings mapping, and the RCE
tripwire that keeps `TrustedRunner` out of non-dev deployments.

Hermetic on purpose: none of these tests touch the wasmtime/CPython-WASI
guest binary. The wasm-selection test proves `build_runner_from_settings`
picks the `WasmScriptRunner` class and passes it the right constructor
arguments WITHOUT booting a real pool, by monkeypatching the class binding
in `script_runner`'s own module namespace (the "builder's namespace" the
task brief calls out) -- the least invasive seam available, since
`WasmScriptRunner` is resolved as a module global at call time inside
`build_runner_from_settings`. No wasmtime engine, no guest process, no
refill/epoch threads are ever created by this file.

See `tests/api/test_snippets_wasm.py` (integration-marked, needs the fetched
guest binary) for the real `WasmScriptRunner` end-to-end coverage.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from data_rover.api import script_runner
from data_rover.api.main import create_app
from data_rover.api.script_runner import (
    build_runner_from_settings,
    get_runner,
    reset_runner,
    run_limits_from_settings,
)
from data_rover.api.settings import Settings
from data_rover.core.script.runner import RunLimits


@pytest.fixture(autouse=True)
def _reset_runner_singleton() -> Iterator[None]:
    """The process-wide runner singleton in `script_runner` is shared across
    the whole test session; make sure this file never leaks a runner into
    (or inherits one from) another test module."""
    reset_runner()
    yield
    reset_runner()


# -- build_runner_from_settings: the "trusted" RCE tripwire ------------------


def test_trusted_runner_refused_when_dev_seed_false() -> None:
    """The whole point of the tripwire: TrustedRunner execs snippet code
    in-process with no sandbox, so selecting it outside a dev checkout
    (`dev_seed=False`) must hard-fail before any import is attempted."""
    settings = Settings(snippet_runner="trusted", dev_seed=False)
    with pytest.raises(RuntimeError, match="DEV_SEED"):
        build_runner_from_settings(settings)


def test_trusted_runner_allowed_when_dev_seed_true() -> None:
    """With `dev_seed=True` (a dev checkout), `"trusted"` lazily imports and
    returns a real `TrustedRunner` from `tests/script/trusted_runner.py`."""
    from tests.script.trusted_runner import TrustedRunner

    settings = Settings(snippet_runner="trusted", dev_seed=True)
    runner = build_runner_from_settings(settings)
    assert isinstance(runner, TrustedRunner)


# -- build_runner_from_settings: "wasm" selects the class, doesn't boot it ---


class _StubWasmRunner:
    """Stand-in for `WasmScriptRunner` that records its constructor args
    instead of booting a real wasmtime engine/pool/threads."""

    def __init__(self, guest_wasm_path: str, guest_lib_path: str, *, pool_size: int) -> None:
        self.guest_wasm_path = guest_wasm_path
        self.guest_lib_path = guest_lib_path
        self.pool_size = pool_size


def test_wasm_runner_selected_without_booting_a_real_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    """`build_runner_from_settings` resolves `WasmScriptRunner` as a module
    global on `data_rover.api.script_runner` at call time, so monkeypatching
    it there swaps in a stub that proves the wasm branch was taken (right
    class, right constructor args) without spawning the refill/epoch-ticker
    threads a real `WasmScriptRunner()` would."""
    monkeypatch.setattr(script_runner, "WasmScriptRunner", _StubWasmRunner)
    settings = Settings(
        snippet_runner="wasm",
        snippet_guest_wasm_path="fake/python.wasm",
        snippet_guest_lib_path="fake/lib",
        snippet_pool_size=3,
    )

    runner = build_runner_from_settings(settings)

    assert isinstance(runner, _StubWasmRunner)
    assert runner.guest_wasm_path == "fake/python.wasm"
    assert runner.guest_lib_path == "fake/lib"
    assert runner.pool_size == 3


# -- run_limits_from_settings -------------------------------------------------


def test_run_limits_from_settings_maps_every_field() -> None:
    settings = Settings(
        snippet_wall_timeout_s=5.5,
        snippet_memory_bytes=111,
        snippet_stdout_bytes=222,
        snippet_result_repr_bytes=333,
        snippet_max_ops=444,
        snippet_max_op_bytes=555,
        snippet_page_limit=666,
    )

    limits = run_limits_from_settings(settings)

    assert limits.wall_timeout_s == 5.5
    assert limits.memory_bytes == 111
    assert limits.stdout_bytes == 222
    assert limits.result_repr_bytes == 333
    assert limits.max_ops == 444
    assert limits.max_op_bytes == 555
    assert limits.page_limit == 666
    assert limits == RunLimits(
        wall_timeout_s=5.5,
        memory_bytes=111,
        stdout_bytes=222,
        result_repr_bytes=333,
        max_ops=444,
        max_op_bytes=555,
        page_limit=666,
    )


# -- app-level: lifespan must not explode without the guest binary -----------


def test_create_app_lifespan_survives_missing_guest_binary(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force a definitely-absent guest binary path (independent of whether
    THIS checkout happens to have `spikes/code_exec/vendor/` fetched) and
    drive the app through a real lifespan startup+shutdown via `with
    TestClient(...)`. Must not raise; the runner must stay unset (routes are
    Task 11's job to 503 on that), and shutdown must not error over a
    never-booted runner (no thread leak)."""
    monkeypatch.setenv(
        "DATA_ROVER_SNIPPET_GUEST_WASM_PATH", "/nonexistent/dr-test-vendor/python.wasm"
    )

    app = create_app()
    with TestClient(app) as client:
        assert get_runner() is None
        r = client.get("/healthz")
        assert r.status_code == 200

    # Lifespan shutdown ran cleanly; the singleton was never populated.
    assert get_runner() is None
