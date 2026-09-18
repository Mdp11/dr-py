"""The canonical rendering of a model's indexes.

Everything a set holds is sorted and every mapping is a list of pairs, so the
dump depends on the model's state alone, never on hash order, and a plain
JSON reader keeps its order. The engine renders the same document from its own
indexes (``engine/src/debug/dump-indexes.ts``).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from data_rover.core.model.model import Model


def _pairs(mapping: Mapping[str, Iterable[str]]) -> list[list[Any]]:
    return [[key, sorted(mapping[key])] for key in sorted(mapping)]


def _counts(counter: Mapping[tuple[str, str], int]) -> list[list[Any]]:
    return [[eid, rel_type, n] for (eid, rel_type), n in sorted(counter.items())]


def dump_indexes(model: Model) -> dict[str, Any]:
    ix = model.indexes
    return {
        "by_type": _pairs(ix.elements_by_type),
        "out": _pairs(ix.out_rels),
        "in": _pairs(ix.in_rels),
        "out_count": _counts(ix.out_count),
        "in_count": _counts(ix.in_count),
        # parents and their relationships keep relationship-insertion order
        "parents": [
            [child, list(parents), list(ix._containment_rel_ids[child])]
            for child, parents in sorted(ix.containment_parents.items())
        ],
        "refs": _pairs(ix._refs_of),
        "referencers": _pairs(ix.ref_targets),
        "uniq_groups": sorted(sorted(group) for group in ix.uniq_groups.values()),
        "duplicates": sorted(sorted(ix.uniq_groups[key]) for key in ix.duplicate_keys),
        "roots": [[name, eid] for name, eid in ix.roots_order.as_list()],
    }
