"""Write the Python oracle's evaluation of the gate's table over model M.

Loads ``benchmarks/large.model.json`` against its metamodel the way
``scripts/issues_large.py`` does, BEFORE any violation op lands on it,
resolves ``engine/bench/big-table.json`` (no refs to inline; kept as a real
resolve so a later definition with one still works) and runs the core table
evaluator over every row with the default ``TableLimits()`` (50,000 rows,
20 elements a cell — the gate's cap). ``benchmarks/large.table.json``
receives one JSON line per row, in the built and sorted order: ``[key,
cells]``, ``key`` a JSON list (a value terminal as ``{"value": ...}``,
never reached by this table) and ``cells`` a list of objects in
``TableCellOut``'s field order. ``engine/bench/parity-large.ts`` evaluates
the same definition over the same (pre-violation) model through
``tableSteps`` and compares the two, line by line.

Run from the repo root (``pixi run engine-parity-large`` does, through the
``engine-table-oracle`` task):

    pixi run -e core-dev python scripts/table_large.py
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from data_rover.api.routes._snapshot import build_model_from_dicts  # noqa: E402
from data_rover.api.routes.read import _tree_item  # noqa: E402
from data_rover.api.serialize import parse_model_json  # noqa: E402
from data_rover.core.metamodel.loader import load_metamodel_file  # noqa: E402
from data_rover.core.model.model import Model  # noqa: E402
from data_rover.core.navigation.evaluate import PropertyValue  # noqa: E402
from data_rover.core.table.cells import (  # noqa: E402
    Cell,
    ElementCell,
    ElementsCell,
    ErrorCell,
    PendingCell,
    ValueCell,
    ValuesCell,
    evaluate_cells,
)
from data_rover.core.table.evaluate import (  # noqa: E402
    RowKey,
    TableLimits,
    build_rows_ex,
    order_rows,
    sort_keys,
)
from data_rover.core.table.resolve import resolve_table_refs, table_has_script  # noqa: E402
from data_rover.core.table.schema import TABLE_ADAPTER, TableDefinition  # noqa: E402

BENCHMARKS = REPO_ROOT / "benchmarks"
ENGINE_BENCH = REPO_ROOT / "engine" / "bench"


def _no_refs(artifact_id: str) -> Any:
    raise LookupError(artifact_id)  # the gate's table embeds its navigation inline


def _key_out(key: RowKey) -> list[Any]:
    return [{"value": b.value} if isinstance(b, PropertyValue) else b for b in key]


#: `TableCellOut`'s field order (`api/schemas.py`): `kind` first, every other
#: field present and `None` unless the cell's kind sets it.
_CELL_FIELDS = (
    "kind",
    "item",
    "ref_type",
    "present",
    "value",
    "element_id",
    "editable",
    "items",
    "values",
    "total",
    "truncated",
    "message",
    "traceback",
)


def _cell_out(model: Model, cell: Cell) -> dict[str, Any]:
    filled: dict[str, Any]
    if isinstance(cell, ElementCell):
        filled = dict(
            kind="element",
            item=_tree_item(model, cell.element_id).model_dump(mode="json")
            if cell.element_id
            else None,
            element_id=cell.owner_id,
            editable=cell.editable,
            ref_type=cell.ref_type,
        )
    elif isinstance(cell, ValueCell):
        filled = dict(
            kind="value",
            present=cell.present,
            value=cell.value,
            element_id=cell.element_id,
            editable=cell.editable,
        )
    elif isinstance(cell, ValuesCell):
        filled = dict(
            kind="values",
            present=cell.present,
            values=cell.values,
            total=cell.total,
            truncated=cell.truncated,
        )
    elif isinstance(cell, ErrorCell):
        filled = dict(kind="error", message=cell.message, traceback=cell.traceback)
    elif isinstance(cell, PendingCell):
        filled = dict(kind="pending")
    else:
        assert isinstance(cell, ElementsCell)
        filled = dict(
            kind="elements",
            items=[
                _tree_item(model, e).model_dump(mode="json") for e in cell.element_ids
            ],
            total=cell.total,
            truncated=cell.truncated,
        )
    return {field: filled.get(field) for field in _CELL_FIELDS}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", type=Path, default=BENCHMARKS / "large.model.json")
    parser.add_argument(
        "--metamodel",
        type=Path,
        default=REPO_ROOT / "examples" / "smart-city.metamodel.yaml",
    )
    parser.add_argument("--table", type=Path, default=ENGINE_BENCH / "big-table.json")
    parser.add_argument("--out", type=Path, default=BENCHMARKS / "large.table.json")
    args = parser.parse_args()

    if not args.model.exists():
        raise SystemExit(
            f"{args.model} is missing: examples/generate_large_model.py writes it "
            "(--scale 170 for model M)"
        )
    metamodel = load_metamodel_file(args.metamodel)
    doc = parse_model_json(args.model.read_bytes())
    model = build_model_from_dicts(metamodel, doc, strict=False)

    defn: TableDefinition = TABLE_ADAPTER.validate_json(args.table.read_bytes())
    defn = resolve_table_refs(defn, _no_refs)
    if table_has_script(defn):
        raise SystemExit(f"{args.table} reaches a script: the gate's table must not")

    limits = TableLimits()
    start = time.perf_counter()
    built = build_rows_ex(metamodel, model, defn, limits)
    keys = order_rows(
        metamodel,
        model,
        defn,
        built.keys,
        sort_keys(defn),
        limits,
        base_slots=built.base_slots,
    )
    cells = evaluate_cells(
        metamodel, model, defn, keys, limits, base_slots=built.base_slots
    )
    seconds = time.perf_counter() - start

    with args.out.open("w", encoding="utf-8") as out:
        for key, row in zip(keys, cells, strict=True):
            out.write(
                json.dumps(
                    [_key_out(key), [_cell_out(model, cell) for cell in row]],
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
            )
            out.write("\n")
    print(
        f"wrote {args.out}: {len(keys):,} rows (base_total {built.base_total:,}, "
        f"truncated={built.truncated}) over {args.model}, swept in {seconds:.1f} s"
    )


if __name__ == "__main__":
    main()
