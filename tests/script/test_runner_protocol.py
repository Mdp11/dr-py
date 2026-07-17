from data_rover.core.script.runner import RunLimits, RunRequest, RunResult, ScriptError


def test_defaults():
    lim = RunLimits()
    assert lim.wall_timeout_s == 10 and lim.max_ops == 1000
    req = RunRequest(code="x=1")
    assert req.entry == "script"


def test_result_shape():
    res = RunResult(stdout="hi", result_repr=None, ops=[], error=None, duration_ms=3, truncated=False)
    assert res.ops == [] and res.error is None
    err = ScriptError(kind="timeout", message="deadline", traceback=None)
    assert err.kind == "timeout"
