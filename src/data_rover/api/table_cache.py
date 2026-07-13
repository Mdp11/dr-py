"""Per-session LRU of ordered table row keys, keyed by (resolved-definition
fingerprint, sort). A stored entry records the model_rev it was computed at AND
the `truncated` flag `build_rows` produced (so a cached page reports the same
completeness as the miss page that filled it — `len(rows) >= max_rows` is NOT a
safe recompute, since a table of EXACTLY max_rows is not truncated). A lookup at
a different rev is a miss. Session.touch_model()/set_model clear the whole cache.
Guards dict ops with a Lock; evaluation runs OUTSIDE the lock (a lost race merely
recomputes)."""

from __future__ import annotations

import hashlib
import json
import threading
from collections import OrderedDict
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from data_rover.core.table.evaluate import RowKey, SortSpec


def table_fingerprint(resolved_defn_json: str, sort: "SortSpec | None") -> str:
    payload = {
        "defn": resolved_defn_json,
        "sort": None if sort is None else [sort.column, sort.direction],
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


class TableOrderCache:
    def __init__(self, cap: int = 16) -> None:
        self._cap = cap
        self._lock = threading.Lock()
        self._d: "OrderedDict[tuple[str, str], tuple[int, tuple[RowKey, ...], bool]]" = OrderedDict()

    def get(
        self, fingerprint: str, sort_key: str, model_rev: int
    ) -> "tuple[tuple[RowKey, ...], bool] | None":
        """`(rows, truncated)` on a fresh hit; `None` on a miss or stale rev."""
        key = (fingerprint, sort_key)
        with self._lock:
            hit = self._d.get(key)
            if hit is None:
                return None
            rev, rows, truncated = hit
            if rev != model_rev:
                del self._d[key]
                return None
            self._d.move_to_end(key)
            return rows, truncated

    def put(
        self,
        fingerprint: str,
        sort_key: str,
        model_rev: int,
        rows: "tuple[RowKey, ...]",
        truncated: bool,
    ) -> None:
        key = (fingerprint, sort_key)
        with self._lock:
            self._d[key] = (model_rev, rows, truncated)
            self._d.move_to_end(key)
            while len(self._d) > self._cap:
                self._d.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._d.clear()
