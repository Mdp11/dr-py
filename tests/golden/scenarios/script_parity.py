"""What the script harness answers, case by case, over the ``script_bridge`` model.

Each case is author code plus calls. An embedded case opens one session and
serves its calls in order; a console case runs each call on a fresh namespace.
``results`` are ``json.dumps`` texts of the harness's own answer: a ``_dr_call``
dict (``payload``, ``error``, ``reads``, ``stdout``) for embedded cases, a
``_dr_run`` dict (``stdout``, ``result_repr``, ``truncated``, ``error``?) for
console ones. A session whose boot failed answers every call with
``{"payload": null, "error": <the boot error>, "reads": null, "stdout": ""}``.
Console ``script`` cases also carry ``ops``, the dispatcher's recorded ops.

Time, entropy and hashing are pinned, so the cases run in a child process that
starts with ``PYTHONHASHSEED=0`` and ``TZ=UTC`` and whose runner pins the clock
and random sources."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Any

from data_rover.api.serialize import iter_entity_lines
from data_rover.core.script.runner import RunLimits, RunRequest, ScriptBudget

from ..driver import ROOT, scenario
from .script_bridge import ASTRAL, ELEMENTS, build_model

Case = dict[str, Any]


def _call(
    ids: list[str] | None = None,
    inputs: Any = None,
    doc: Any = None,
) -> dict[str, Any]:
    call: dict[str, Any] = {"element_ids": ids or []}
    if inputs is not None:
        call["inputs_text"] = json.dumps(inputs)
    if doc is not None:
        call["doc_text"] = json.dumps(doc)
    return call


def _case(
    group: str,
    name: str,
    mode: str,
    entry: str,
    code: str,
    calls: list[dict[str, Any]],
) -> Case:
    return {
        "group": group,
        "name": name,
        "mode": mode,
        "entry": entry,
        "code": code,
        "calls": calls,
    }


def _embedded(group: str, name: str, entry: str, code: str, *calls: dict) -> Case:
    return _case(group, name, "embedded", entry, code, list(calls))


def _console(group: str, name: str, entry: str, code: str, *calls: dict) -> Case:
    return _case(group, name, "console", entry, code, list(calls) or [_call()])


_INPUTS = {
    "xs": {"kind": "elements", "ids": ["n1", "n2"]},
    "k": {"kind": "scalars", "values": [1, 2.0]},
}

_TWO_PARAMS = """def value(els, inputs):
    return [e.id for e in els] + sorted(inputs) + [len(inputs["xs"]) if "xs" in inputs else -1]
"""

_ONE_PARAM = """def value(els):
    return [e.id for e in els]
"""

_HELPER_TRACEBACK = """# the author's line numbers start here


def helper(el):
    name = el["name"]
    return undefined_name + name


def value(els):
    return helper(els[0])
"""

_INTERRUPTS = """def value(els):
    if els[0].id == "n1":
        raise KeyboardInterrupt("stop")
    if els[0].id == "n2":
        raise SystemExit(3)
    return els[0].id
"""


def _cases() -> list[Case]:
    n1, n2, n3 = ["n1"], ["n2"], ["n3"]
    return [
        # value, step, transform
        _embedded(
            "value",
            "value_scalar",
            "value",
            'def value(els):\n    return els[0].get("name")\n',
            _call(n1),
            _call(n2),
        ),
        _embedded(
            "value",
            "value_list",
            "value",
            'def value(els):\n    return [e["name"] for e in els]\n',
            _call(["n1", "n2"]),
        ),
        _embedded(
            "value",
            "value_element",
            "value",
            "def value(els):\n    return els[0]\n",
            _call(n1),
        ),
        _embedded(
            "value",
            "value_elements",
            "value",
            "def value(els):\n    return els\n",
            _call(["n2", "n1"]),
        ),
        _embedded(
            "value",
            "value_none",
            "value",
            "def value(els):\n    return None\n",
            _call(n1),
        ),
        _embedded(
            "value",
            "value_inputs",
            "value",
            'def value(els, inputs):\n    return [len(inputs["xs"]), sum(inputs["k"])]\n',
            _call(n1, _INPUTS),
        ),
        _embedded(
            "value",
            "step_nodes",
            "step",
            "def step(el):\n    return el.children()\n",
            _call(n1),
            _call(n2),
        ),
        _embedded(
            "value",
            "step_scalar",
            "step",
            'def step(el):\n    return el["name"]\n',
            _call(n1),
        ),
        _embedded(
            "value",
            "transform_json",
            "transform",
            'def transform(doc):\n    return {"n": len(doc["rows"]), "rows": doc["rows"], "done": True}\n',
            _call(doc={"rows": [1, 2.5, "x"]}),
        ),
        # console runs
        _console(
            "script",
            "script_print_result",
            "script",
            'print("hello")\nprint(dr.element("n1")["name"])\nresult = [1, 2.0, "x"]\n',
        ),
        _console(
            "script",
            "console_value_two_params",
            "value",
            _TWO_PARAMS,
            _call(["n1", "n2"], _INPUTS),
            _call(n1),
        ),
        _console(
            "script",
            "console_value_one_param",
            "value",
            _ONE_PARAM,
            _call(["n1", "n2"], _INPUTS),
            _call(n3),
        ),
        _console(
            "script",
            "console_step",
            "step",
            "def step(el):\n    return el.children()\n",
            _call(n1),
        ),
        _console(
            "script",
            "script_ops",
            "script",
            'tid = dr.create("Node", {"name": "new", "w": 1.0})\n'
            'dr.element("n1").set("name", "Renamed")\n'
            'result = dr.connect("Links", "n1", tid)\n',
        ),
        # errors
        _embedded(
            "errors",
            "syntax_error",
            "value",
            "def value(els:\n    return 1\n",
            _call(n1),
            _call(n2),
        ),
        _console("errors", "script_syntax_error", "script", "x = (1,\n"),
        _embedded(
            "errors",
            "module_raise",
            "value",
            'print("booting")\nraise RuntimeError("boot failed")\n',
            _call(n1),
        ),
        _console(
            "errors",
            "script_module_raise",
            "script",
            'print("before")\nraise RuntimeError("boom")\n',
        ),
        _embedded("errors", "missing_entry", "value", "x = 1\n", _call(n1)),
        _embedded(
            "errors",
            "value_error_then_good",
            "value",
            'def value(els):\n    if els[0]["name"] == "one":\n'
            '        raise ValueError("bad " + els[0].id)\n    return els[0]["name"]\n',
            _call(n1),
            _call(n2),
        ),
        _embedded(
            "errors",
            "not_found",
            "value",
            'def value(els):\n    return dr.element("nope").id\n',
            _call(n1),
        ),
        _embedded(
            "errors",
            "read_only",
            "value",
            'def value(els):\n    els[0].set("name", "x")\n',
            _call(n1),
        ),
        _embedded(
            "errors",
            "value_two_params_no_inputs",
            "value",
            "def value(els, inputs):\n    return 1\n",
            _call(n1),
        ),
        _embedded("errors", "traceback_helper", "value", _HELPER_TRACEBACK, _call(n1)),
        _console(
            "errors", "script_traceback_helper", "value", _HELPER_TRACEBACK, _call(n1)
        ),
        _embedded(
            "errors",
            "interrupts",
            "value",
            _INTERRUPTS,
            _call(n1),
            _call(n2),
            _call(n3),
        ),
        _console(
            "errors",
            "script_keyboard_interrupt",
            "script",
            "raise KeyboardInterrupt()\n",
        ),
        _console("errors", "script_system_exit", "script", "import sys\nsys.exit(2)\n"),
        # caps
        _console(
            "caps",
            "stdout_cap",
            "script",
            f'print("a" * {RunLimits().stdout_bytes + 10})\nresult = 1\n',
        ),
        _console(
            "caps",
            "repr_cap",
            "script",
            f'result = "y" * {RunLimits().result_repr_bytes + 10}\n',
        ),
        _console(
            "caps",
            "ops_1001",
            "script",
            f'for i in range({RunLimits().max_ops + 1}):\n    dr.create("Node", {{"name": str(i)}})\n',
        ),
        _console(
            "caps",
            "op_over_1mib",
            "script",
            f'dr.create("Node", {{"name": "x" * {RunLimits().max_op_bytes}}})\n',
        ),
        # fidelity
        _embedded(
            "fidelity",
            "fidelity_value",
            "value",
            'def value(els):\n    return [els[0]["f"], els[0]["i"], els[0]["big"], els[0]["s"]]\n',
            _call(n3),
        ),
        _embedded(
            "fidelity",
            "fidelity_transform",
            "transform",
            'def transform(doc):\n    return [doc, doc["big"] + 1]\n',
            _call(doc={"f": 1.0, "i": 1, "big": 2**60, "s": ASTRAL}),
        ),
        _console(
            "fidelity",
            "fidelity_script",
            "script",
            'el = dr.element("n3")\nresult = [el["f"], el["i"], el["big"], el["s"], 1.0, 1, 2**60]\n'
            'print(el["s"], el["f"], el["big"])\n',
        ),
        # determinism: Task 3 excludes this group by name
        *[
            _console(
                "determinism",
                f"determinism_{name}",
                "script",
                f"result = {expr}\nprint(result)\n",
            )
            for name, expr in (
                ("time", "__import__('time').time()"),
                ("datetime", "__import__('datetime').datetime.now().isoformat()"),
                ("random", "__import__('random').random()"),
                ("hash", 'hash("abc")'),
                ("set_repr", 'repr({"b", "a", "c"})'),
                ("urandom", "__import__('os').urandom(4).hex()"),
            )
        ],
    ]


def _dump(doc: Any) -> str:
    return json.dumps(doc)


def _run_cases(cases: list[Case]) -> list[dict[str, Any]]:
    """Runs in the pinned child: each case's result texts and ops text."""
    from tests.script.trusted_runner import TrustedRunner

    limits = RunLimits()
    runner = TrustedRunner(deterministic=True)
    out: list[dict[str, Any]] = []
    for case in cases:
        calls = case["calls"]
        results: list[str] = []
        ops: str | None = None
        if case["mode"] == "console":
            for call in calls:
                req = RunRequest(
                    code=case["code"],
                    entry=case["entry"],
                    element_ids=call["element_ids"],
                    inputs=json.loads(call["inputs_text"])
                    if "inputs_text" in call
                    else None,
                )
                res, dispatcher = runner.run_harness(
                    build_model(), req, limits, record_ops=True
                )
                results.append(_dump(res))
                if case["entry"] == "script":
                    assert len(calls) == 1
                    ops = _dump(dispatcher.ops)
        else:
            session = runner.open_session(
                build_model(), case["code"], limits, budget=ScriptBudget.start(30)
            )
            for call in calls:
                if session.boot_error is not None:
                    err = session.boot_error
                    res = {
                        "payload": None,
                        "error": {
                            "kind": err.kind,
                            "message": err.message,
                            "traceback": err.traceback,
                        },
                        "reads": None,
                        "stdout": "",
                    }
                else:
                    res = session.call_harness(
                        case["entry"],
                        call["element_ids"],
                        doc=json.loads(call["doc_text"])
                        if "doc_text" in call
                        else None,
                        inputs=json.loads(call["inputs_text"])
                        if "inputs_text" in call
                        else None,
                    )
                results.append(_dump(res))
        entry: dict[str, Any] = {"results": results}
        if ops is not None:
            entry["ops"] = ops
        out.append(entry)
    return out


def child_main() -> None:
    """Reads the cases from stdin, writes the outcomes to stdout."""
    cases = json.load(sys.stdin)
    sys.stdout.write(json.dumps(_run_cases(cases)))


#: Expected answers of the two hash-dependent cases. `Py_hash_t` is 32 bits on
#: wasm32, so the server's guest and Pyodide agree with each other, not with
#: a 64-bit oracle; `test_wasm_script_parity_hash_constants` pins them.
WASM32_RESULTS: dict[str, str] = {
    "determinism_hash": json.dumps(
        {"stdout": "-1600925533\n", "result_repr": "-1600925533", "truncated": False}
    ),
    "determinism_set_repr": json.dumps(
        {
            "stdout": "{'a', 'c', 'b'}\n",
            "result_repr": "\"{'a', 'c', 'b'}\"",
            "truncated": False,
        }
    ),
}


def _outcomes(cases: list[Case]) -> list[dict[str, Any]]:
    env = {
        **os.environ,
        "PYTHONHASHSEED": "0",
        "TZ": "UTC",
        "PYTHONPATH": os.pathsep.join([str(ROOT / "src"), str(ROOT)]),
    }
    proc = subprocess.run(
        [
            sys.executable,
            "-c",
            "from tests.golden.scenarios.script_parity import child_main; child_main()",
        ],
        input=json.dumps(cases),
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        cwd=ROOT,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"script_parity child failed:\n{proc.stderr}")
    return json.loads(proc.stdout)


@scenario("script_parity")
def script_parity() -> Any:
    model = build_model()
    lines = list(iter_entity_lines(model))
    cases = _cases()
    outcomes = _outcomes(cases)
    for case, outcome in zip(cases, outcomes, strict=True):
        if case["name"] in WASM32_RESULTS:
            outcome["results"] = [WASM32_RESULTS[case["name"]]]
    return {
        "model": {
            "metamodel": model.metamodel.model_dump(mode="json"),
            "elements": lines[: len(ELEMENTS)],
            "relationships": lines[len(ELEMENTS) :],
        },
        "cases": [
            {
                "name": case["name"],
                "group": case["group"],
                "mode": case["mode"],
                "entry": case["entry"],
                "code": case["code"],
                "calls": case["calls"],
                **outcome,
            }
            for case, outcome in zip(cases, outcomes, strict=True)
        ],
    }
