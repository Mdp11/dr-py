"""TransformHost (spec §8 + §17.2): session reuse per code, size caps, the
failure-is-failure ValueError mapping, and slot acquisition/release."""

import pytest

from data_rover.api.settings import Settings
from data_rover.api.snippet_concurrency import concurrency_guard
from data_rover.api.table_export_engine import (
    TransformUnavailableError,
    open_transform_host,
)
from tests.script.conftest import tiny_model
from tests.script.trusted_runner import TrustedRunner

# Build the smallest Model the api test-package already uses for direct
# (non-HTTP) engine tests — see tests/api/_script_fakes.py / the model
# builders in tests/script; the host never reads the model in these tests.


@pytest.fixture
def model():
    return tiny_model()


def _settings(**kw):
    return Settings(dev_seed=True, **kw)


def test_no_runner_raises_unavailable_not_busy(model):
    with pytest.raises(TransformUnavailableError) as e:
        open_transform_host(None, model, _settings())
    assert e.value.busy is False


def test_no_slot_raises_busy(model):
    settings = _settings(snippet_concurrency=1)
    assert concurrency_guard.try_acquire_global(global_limit=1)
    try:
        with pytest.raises(TransformUnavailableError) as e:
            open_transform_host(TrustedRunner(), model, settings)
        assert e.value.busy is True
    finally:
        concurrency_guard.release_global()


def test_apply_transforms_and_reuses_one_session_per_code(model):
    host = open_transform_host(TrustedRunner(), model, _settings())
    try:
        code = "def transform(doc):\n    return {'wrapped': doc}\n"
        out1 = host.apply(code, [1], "e1")
        out2 = host.apply(code, [2], "e2")
        assert out1 == {"wrapped": [1]} and out2 == {"wrapped": [2]}
        assert len(host._sessions) == 1  # one warm session per distinct code
    finally:
        host.close()


def test_apply_failures_are_value_errors_naming_the_entry(model):
    host = open_transform_host(TrustedRunner(), model, _settings())
    try:
        with pytest.raises(ValueError, match="entryX"):
            host.apply("def transform(doc):\n    raise RuntimeError('boom')\n", {}, "entryX")
        with pytest.raises(ValueError, match="entryY"):
            host.apply("syntax error here(", {}, "entryY")  # boot error
    finally:
        host.close()


def test_doc_and_result_size_caps(model):
    host = open_transform_host(
        TrustedRunner(), model, _settings(snippet_transform_max_bytes=64)
    )
    try:
        with pytest.raises(ValueError, match="document exceeds"):
            host.apply("def transform(doc):\n    return doc\n", "x" * 100, "big-in")
        with pytest.raises(ValueError, match="result exceeds"):
            host.apply("def transform(doc):\n    return 'y' * 100\n", "x", "big-out")
    finally:
        host.close()


def test_close_releases_the_slot(model):
    settings = _settings(snippet_concurrency=1)
    host = open_transform_host(TrustedRunner(), model, settings)
    host.close()
    host.close()  # idempotent
    assert concurrency_guard.try_acquire_global(global_limit=1)
    concurrency_guard.release_global()
