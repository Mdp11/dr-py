"""Scripted oracle runs: steps whose answers come from running snippets.

``pin_determinism`` replaces ``datetime.datetime`` for the whole process and
cannot be undone, so the steps run in a child that starts with
``PYTHONHASHSEED=0`` and ``TZ=UTC``, as ``script_parity`` does. The child's
recorder has the trusted runner with the clock and entropy pinned and
``snippet_sweep_sync`` on, so a table's sweep completes within the call that
starts it. Every step goes to the child, the unscripted ones too: what a
scripted step reads is the model the steps before it left.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from collections.abc import Iterable
from typing import Any

from data_rover.api.settings import Settings
from data_rover.core.metamodel.schema import Metamodel

from .driver import ROOT
from .model_steps import Recorder


def child_main() -> None:
    """Reads ``{metamodel, steps}`` from stdin, writes the recorded steps to
    stdout."""
    from tests.script.trusted_runner import TrustedRunner

    request = json.load(sys.stdin)
    recorder = Recorder(
        Metamodel.model_validate(request["metamodel"]),
        runner=TrustedRunner(deterministic=True),
        settings=Settings(snippet_sweep_sync=True),
    )
    for step in request["steps"]:
        recorder.run(step)
    # A table's sweep runs snippets on threads, and the harness's print capture
    # swaps ``sys.stdout`` without a lock, so one may be left in place.
    stdout = sys.__stdout__
    assert stdout is not None
    stdout.write(json.dumps(recorder.document()["steps"]))


def run_scripted(metamodel: Metamodel, steps: Iterable[dict[str, Any]]) -> list[dict]:
    """The recorded entries of ``steps`` run as ``run_steps`` runs them, in a
    child, with ``scripted`` steps running their snippets. The steps cross as
    JSON, so they hold nothing JSON cannot carry. A child that fails raises
    with what it wrote to stderr."""
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
            "from tests.golden.scripted import child_main; child_main()",
        ],
        input=json.dumps(
            {"metamodel": metamodel.model_dump(mode="json"), "steps": list(steps)}
        ),
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        cwd=ROOT,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"scripted child failed:\n{proc.stderr}")
    return json.loads(proc.stdout)
