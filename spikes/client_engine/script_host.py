"""THROWAWAY SPIKE — Python user scripts over a NON-Python store.

What options 1 and 3 would run: the unmodified facade (`FACADE_SOURCE`, through
the trusted session) in Pyodide, with the bridge answered by a JavaScript or
Rust/WASM store behind one synchronous JSON-in / JSON-out call. It drives the
same `bench_engine.run_calls` as the Python store, so only the store differs.
"""

from __future__ import annotations

import json

import trusted_runner

import bench_engine

_state: dict = {}


class StoreDispatcher:
    """`BridgeDispatcher`'s surface, answered by whatever store is bound."""

    def __init__(self, model, **_limits) -> None:
        self.model = model
        self.ops: list = []

    def dispatch(self, req: dict) -> dict:
        return json.loads(_state["dispatch"](json.dumps(req)))


def _project_roots(_model, element_ids) -> list[dict]:
    req = {"id": 0, "op": "project_roots", "ids": list(element_ids)}
    return json.loads(_state["dispatch"](json.dumps(req)))["elements"]


def bind(js_dispatch) -> None:
    """Point the facade's transport at a store: `js_dispatch(str) -> str`."""
    _state["dispatch"] = js_dispatch
    trusted_runner.BridgeDispatcher = StoreDispatcher
    trusted_runner.project_roots = _project_roots


def run_calls_json(ids_json: str) -> str:
    return bench_engine.run_calls(None, json.loads(ids_json))
