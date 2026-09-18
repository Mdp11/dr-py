"""THROWAWAY SPIKE — workloads for the client-engine benchmark.

Runs the real `data_rover.core` unmodified, either natively (baseline) or
inside Pyodide in a browser worker. Every entry point returns a JSON string
of timings so the JS host never converts Python objects.

`trusted_runner` is `tests/script/trusted_runner.py` shipped as a flat module:
in the browser the sandbox origin is the isolation boundary, so an in-process
runner is the shape being measured.
"""

from __future__ import annotations

import gc
import gzip
import json
import time

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship
from data_rover.core.script.embed import ScriptEvalContext
from data_rover.core.script.runner import RunLimits, ScriptBudget
from data_rover.core.table.cells import evaluate_cells
from data_rover.core.table.evaluate import TableLimits, build_rows_ex, order_rows, sort_keys
from data_rover.core.table.schema import TABLE_ADAPTER
from data_rover.core.validation.pipeline import default_pipeline
from trusted_runner import TrustedRunner

STATE: dict = {}
LIMITS = TableLimits(max_rows=10**9)

# ~102k rows on benchmarks/large.model.json (170k elements).
BIG_TYPES = [
    "Person", "DataEntity", "Microservice", "APIEndpoint", "IoTDevice",
    "Service", "Server", "DataSchema", "Database",
]  # fmt: skip

BIG_TABLE = {
    "row_source": {"kind": "scope", "types": BIG_TYPES},
    "columns": [
        {"kind": "element"},
        {"kind": "property", "name": "name"},
        {
            "kind": "navigation",
            "navigation": {
                "definition": {
                    "kind": "path",
                    "start": {"kind": "row"},
                    "steps": [
                        {
                            "kind": "relationship",
                            "relationship_type": "SystemContainsComponent",
                            "direction": "either",
                        }
                    ],
                }
            },
        },
    ],
    "sort": [{"column": 1}],
}

# Ten DISTINCT snippet codes, the shape that exhausts the server pool today.
SCRIPTS = [
    "def value(els):\n    return els[0].name.upper()",
    "def value(els):\n    return len(els[0].outgoing())",
    "def value(els):\n    return len(els[0].incoming())",
    "def value(els):\n    p = els[0].parent()\n    return p.name if p else None",
    "def value(els):\n    return [r.destination().name for r in els[0].outgoing()][:5]",
    "def value(els):\n    return sum(len(r.destination().outgoing()) for r in els[0].outgoing())",
    "def value(els):\n    return els[0].get('status')",
    "def value(els):\n    return ', '.join(sorted(els[0].get('tags') or []))",
    "def value(els):\n    e = els[0]\n    return f'{e.stereotype}:{e.id}'",
    "def value(els):\n    return len(els[0].children())",
]


def _now() -> float:
    return time.perf_counter()


def _ms(start: float) -> float:
    return round((_now() - start) * 1000, 1)


def open_snapshot(data: bytes, metamodel_yaml: str, gzipped: bool, fast: str = "") -> str:
    """`fast` = the cheap bulk-load tricks a real client engine would use.
    "gc": no cyclic GC while allocating ~3M objects, then `gc.freeze()` so later
    collections never re-walk the model. "orjson": the same plus orjson."""
    out: dict = {"fast": fast}
    loads = json.loads
    if fast:
        gc.disable()
    if fast == "orjson":
        import orjson

        loads = orjson.loads
    t = _now()
    mm = load_metamodel_str(metamodel_yaml)
    out["load_metamodel_ms"] = _ms(t)
    if gzipped:
        t = _now()
        data = gzip.decompress(data)
        out["py_gunzip_ms"] = _ms(t)
    out["json_bytes"] = len(data)
    t = _now()
    raw = loads(data)
    out["json_loads_ms"] = _ms(t)
    del data
    t = _now()
    model = Model(mm)
    for e in raw["elements"]:
        model.elements[e["id"]] = Element(
            id=e["id"],
            type_name=e["type_name"],
            properties=e.get("properties") or {},
            rev=e.get("rev", 0),
        )
    for r in raw["relationships"]:
        model.relationships[r["id"]] = Relationship(
            id=r["id"],
            type_name=r["type_name"],
            source_id=r["source_id"],
            target_id=r["target_id"],
            properties=r.get("properties") or {},
            rev=r.get("rev", 0),
        )
    del raw
    out["build_entities_ms"] = _ms(t)
    t = _now()
    model.indexes.rebuild()
    out["rebuild_indexes_ms"] = _ms(t)
    t = _now()
    if fast:
        gc.freeze()
        gc.enable()
    else:
        gc.collect()
    out["gc_ms"] = _ms(t)
    out["elements"] = len(model.elements)
    out["relationships"] = len(model.relationships)
    STATE["mm"], STATE["model"] = mm, model
    return json.dumps(out)


def validate_all() -> str:
    t = _now()
    issues = default_pipeline().validate(STATE["model"])
    return json.dumps({"full_validation_ms": _ms(t), "issues": len(issues)})


def big_table() -> str:
    mm, model = STATE["mm"], STATE["model"]
    defn = TABLE_ADAPTER.validate_python(BIG_TABLE)
    out: dict = {}
    t = _now()
    build = build_rows_ex(mm, model, defn, LIMITS)
    out["build_rows_ms"] = _ms(t)
    out["rows"] = len(build.keys)
    t = _now()
    ordered = order_rows(mm, model, defn, build.keys, sort_keys(defn), LIMITS)
    out["sort_ms"] = _ms(t)
    t = _now()
    evaluate_cells(mm, model, defn, ordered[:200], LIMITS)
    out["page_200_cells_ms"] = _ms(t)
    t = _now()
    cells = evaluate_cells(mm, model, defn, ordered, LIMITS)
    out["all_cells_ms"] = _ms(t)
    out["interactive_total_ms"] = round(
        out["build_rows_ms"] + out["sort_ms"] + out["page_200_cells_ms"], 1
    )
    out["export_total_ms"] = round(out["build_rows_ms"] + out["sort_ms"] + out["all_cells_ms"], 1)
    out["cells"] = len(cells) * len(defn.columns)
    return json.dumps(out)


def script_table(rows: int = 1000, codes: list[str] | None = None) -> str:
    mm, model = STATE["mm"], STATE["model"]
    codes = SCRIPTS if codes is None else codes
    defn = TABLE_ADAPTER.validate_python(
        {
            "row_source": {"kind": "scope", "types": ["Microservice"]},
            "columns": [{"kind": "element"}]
            + [{"kind": "script", "snippet": {"definition": {"code": c}}} for c in codes],
        }
    )
    out: dict = {}
    ctx = ScriptEvalContext(TrustedRunner(), model, RunLimits(), ScriptBudget.start(600))
    try:
        t = _now()
        build = build_rows_ex(mm, model, defn, LIMITS, script=ctx)
        out["build_rows_ms"] = _ms(t)
        keys = build.keys[:rows]
        t = _now()
        cells = evaluate_cells(mm, model, defn, keys, LIMITS, script=ctx)
        out["script_cells_ms"] = _ms(t)
    finally:
        ctx.close()
    out["rows"] = len(keys)
    out["script_cells"] = len(keys) * len(codes)
    out["error_cells"] = sum(1 for row in cells for c in row if type(c).__name__ == "ErrorCell")
    out["us_per_cell"] = round(out["script_cells_ms"] * 1000 / max(1, out["script_cells"]), 1)
    out["sample_row"] = [repr(c)[:80] for c in cells[0]]
    return json.dumps(out)


def run_calls(model, ids: list[str]) -> str:
    """The bare script path: ten warm sessions × `ids`, one `value()` call each,
    with no table evaluator around it. The store behind the facade is whatever
    `trusted_runner.BridgeDispatcher` is bound to (see `script_host.bind`), so
    the three engines differ in nothing but the store."""
    runner = TrustedRunner()
    limits = RunLimits()
    errors = 0
    sample: list = []
    start = _now()
    for code in SCRIPTS:
        session = runner.open_session(model, code, limits, budget=ScriptBudget.start(600))
        for n, eid in enumerate(ids):
            result = session.call("value", [eid])
            errors += result.error is not None
            if n == 0:
                sample.append(repr(result.value)[:60] if result.error is None else result.error.message)
        session.close()
    elapsed = _ms(start)
    total = len(ids) * len(SCRIPTS)
    return json.dumps(
        {
            "script_calls_ms": elapsed,
            "script_calls": total,
            "us_per_call": round(elapsed * 1000 / max(1, total), 1),
            "errors": errors,
            "sample_row": sample,
        }
    )


def script_calls(rows: int = 1000) -> str:
    model = STATE["model"]
    ids = sorted(e.id for e in model.elements.values() if e.type_name == "Microservice")[:rows]
    return run_calls(model, ids)


def search_scan(query: str = "service-12") -> str:
    """Index-free substring search over every element name."""
    q = query.lower()
    t = _now()
    hits = [
        e.id for e in STATE["model"].elements.values() if q in str(e.properties.get("name", "")).lower()
    ]
    return json.dumps({"search_scan_ms": _ms(t), "hits": len(hits)})


def runaway() -> str:
    """One script column that never returns: proves the host can interrupt it."""
    return script_table(rows=5, codes=["def value(els):\n    while True:\n        pass"])


def model_alive() -> str:
    return json.dumps({"elements": len(STATE["model"].elements)})
