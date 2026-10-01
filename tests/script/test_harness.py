"""The one snippet harness, exercised through the in-process trusted runner
(the server guest runs the same source; `tests/api/test_snippets_wasm.py`
covers it there)."""

from __future__ import annotations

import sys

import pytest

from data_rover.core.script.facade_src import FACADE_SOURCE
from data_rover.core.script.harness_src import HARNESS_SOURCE
from data_rover.core.script.runner import (
    RunLimits,
    RunRequest,
    ScriptBudget,
)
from tests.script.conftest import tiny_model
from tests.script.trusted_runner import TrustedRunner

# (raising statement, message the harness reports)
_NON_EXCEPTIONS = [
    ("raise KeyboardInterrupt", "KeyboardInterrupt: "),
    ("raise SystemExit(3)", "SystemExit: 3"),
    ("raise E('custom')", "E: custom"),
]

_PRELUDE = "class E(BaseException):\n    pass\n"


def _session(code: str):
    return TrustedRunner().open_session(
        tiny_model(), code, RunLimits(), budget=ScriptBudget.start(60)
    )


@pytest.mark.parametrize(("stmt", "message"), _NON_EXCEPTIONS)
def test_session_call_answers_base_exception_as_runtime_error(stmt: str, message: str) -> None:
    sess = _session(
        _PRELUDE + f"def value(els):\n    if els[0].id == 'b1':\n        {stmt}\n    return 7\n"
    )
    assert sess.boot_error is None
    bad = sess.call("value", ["b1"])
    assert bad.value is None
    assert bad.error is not None
    assert bad.error.kind == "runtime"
    assert bad.error.message == message
    assert bad.error.traceback is not None
    assert bad.error.traceback.startswith("Traceback (most recent call last):\n")
    assert 'File "<snippet>", line 5, in value' in bad.error.traceback
    assert message.split(":")[0] in bad.error.traceback
    assert "trusted_runner" not in bad.error.traceback
    assert "<facade>" not in bad.error.traceback
    good = sess.call("value", ["b2"])
    assert good.error is None
    assert good.value == {"kind": "scalar", "value": 7}
    sess.close()


@pytest.mark.parametrize(("stmt", "message"), _NON_EXCEPTIONS)
def test_run_answers_base_exception_as_runtime_error(stmt: str, message: str) -> None:
    runner = TrustedRunner()
    res = runner.run(
        tiny_model(),
        RunRequest(code=_PRELUDE + f"print('before')\n{stmt}\n"),
        RunLimits(),
        record_ops=False,
        rev=0,
    )
    assert res.error is not None
    assert res.error.kind == "runtime"
    assert res.error.message == message
    assert res.stdout == "before\n"
    again = runner.run(
        tiny_model(), RunRequest(code="result = 1"), RunLimits(), record_ops=False, rev=0
    )
    assert again.error is None
    assert again.result_repr == "1"


@pytest.mark.parametrize(("stmt", "message"), _NON_EXCEPTIONS)
def test_session_boot_answers_base_exception_as_runtime_error(stmt: str, message: str) -> None:
    sess = _session(_PRELUDE + stmt + "\n")
    assert sess.boot_error is not None
    assert sess.boot_error.kind == "runtime"
    assert sess.boot_error.message == message
    sess.close()


def test_memory_error_escapes_the_run() -> None:
    with pytest.raises(MemoryError):
        TrustedRunner().run(
            tiny_model(),
            RunRequest(code="raise MemoryError"),
            RunLimits(),
            record_ops=False,
            rev=0,
        )


def test_memory_error_escapes_a_session_call() -> None:
    sess = _session("def value(els):\n    raise MemoryError\n")
    with pytest.raises(MemoryError):
        sess.call("value", ["b1"])


def test_memory_error_escapes_a_session_boot() -> None:
    with pytest.raises(MemoryError):
        _session("raise MemoryError\n")


def test_result_repr_is_cut_to_the_cap_with_an_ellipsis() -> None:
    res = TrustedRunner().run(
        tiny_model(),
        RunRequest(code="result = 'x' * 100"),
        RunLimits(result_repr_bytes=10),
        record_ops=False,
        rev=0,
    )
    assert res.error is None
    assert res.result_repr == "'xxxxxxxxx" + "..."
    assert len(res.result_repr) == 10 + 3
    assert res.truncated is True


def test_result_repr_at_the_cap_is_kept() -> None:
    res = TrustedRunner().run(
        tiny_model(),
        RunRequest(code="result = 'x' * 8"),
        RunLimits(result_repr_bytes=10),
        record_ops=False,
        rev=0,
    )
    assert res.result_repr == "'xxxxxxxx'"
    assert res.truncated is False


# --- the harness's own shapes ------------------------------------------------


def _harness() -> dict:
    harness: dict = {"_transport": lambda req: {}, "_read_memo_max": 0}
    exec(compile(HARNESS_SOURCE, "<harness>", "exec"), harness)
    return harness


_LIMITS = {"stdout_bytes": 100, "result_repr_bytes": 100}


def test_open_answers_namespace_carry_and_error() -> None:
    opened = _harness()["_dr_open"](FACADE_SOURCE, "print('boot')\n", _LIMITS)
    assert set(opened) == {"namespace", "carry", "error"}
    assert opened["carry"] == "boot\n"
    assert opened["error"] is None
    assert "_dr_call_entry" in opened["namespace"]


def test_open_answers_a_syntax_error_without_traceback() -> None:
    opened = _harness()["_dr_open"](FACADE_SOURCE, "def (:\n", _LIMITS)
    assert opened["error"]["kind"] == "syntax"
    assert opened["error"]["traceback"] is None


def test_call_answers_its_four_fields_and_hands_the_carry_to_the_first_call() -> None:
    harness = _harness()
    session = harness["_dr_open"](
        FACADE_SOURCE,
        "print('boot')\ndef transform(doc):\n    print('in')\n    return doc\n",
        _LIMITS,
    )
    call = {"entry": "transform", "element_ids": [], "doc": {"a": 1}}
    first = harness["_dr_call"](session, call, _LIMITS)
    assert list(first) == ["payload", "error", "reads", "stdout"]
    assert first["payload"] == {"kind": "json", "value": {"a": 1}}
    assert first["error"] is None
    assert first["stdout"] == "boot\nin\n"
    assert harness["_dr_call"](session, call, _LIMITS)["stdout"] == "in\n"


def test_a_failed_call_still_hands_over_the_carry() -> None:
    harness = _harness()
    session = harness["_dr_open"](
        FACADE_SOURCE, "print('boot')\ndef transform(doc):\n    1 / 0\n", _LIMITS
    )
    out = harness["_dr_call"](
        session, {"entry": "transform", "element_ids": [], "doc": None}, _LIMITS
    )
    assert out["error"]["message"] == "ZeroDivisionError: division by zero"
    assert out["stdout"] == "boot\n"
    assert out["payload"] is None and out["reads"] is None


def test_run_answers_its_fields_and_omits_error_when_none() -> None:
    out = _harness()["_dr_run"](
        {
            "code": "print('hi')\nresult = [1, 2]",
            "facade": FACADE_SOURCE,
            "entry": "script",
            "element_ids": [],
            "inputs": None,
            "limits": _LIMITS,
        }
    )
    assert out == {"stdout": "hi\n", "result_repr": "[1, 2]", "truncated": False}


def test_stdout_is_restored_after_a_run_a_boot_and_a_call() -> None:
    before = sys.stdout
    harness = _harness()
    harness["_dr_run"](
        {
            "code": "raise SystemExit(1)",
            "facade": FACADE_SOURCE,
            "entry": "script",
            "element_ids": [],
            "inputs": None,
            "limits": _LIMITS,
        }
    )
    assert sys.stdout is before
    session = harness["_dr_open"](FACADE_SOURCE, "def value(els):\n    raise KeyboardInterrupt\n", _LIMITS)
    assert sys.stdout is before
    harness["_dr_call"](session, {"entry": "value", "element_ids": []}, _LIMITS)
    assert sys.stdout is before
    with pytest.raises(MemoryError):
        harness["_dr_run"](
            {
                "code": "raise MemoryError",
                "facade": FACADE_SOURCE,
                "entry": "script",
                "element_ids": [],
                "inputs": None,
                "limits": _LIMITS,
            }
        )
    assert sys.stdout is before
