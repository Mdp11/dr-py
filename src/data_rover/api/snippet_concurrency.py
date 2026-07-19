"""Process-wide snippet-run concurrency guard (Task 10).

Shared by the interactive console (``routes/snippets.py``) and embedded
evaluation (``script_eval.py``, M2/M3 script columns/steps) — the global cap
covers BOTH so a burst of table/navigation evaluation work can't starve (or
be starved by) console runs.
"""

from __future__ import annotations

import threading


class ConcurrencyGuard:
    """Non-blocking global + per-user run-concurrency limiter.

    ``try_acquire`` fails fast (returns ``False``) rather than blocking, so a
    request over either cap gets an immediate 429 instead of queuing behind
    other snippet executions. Thread-safe: FastAPI's sync routes run on a
    threadpool, so ``try_acquire``/``release`` can be called concurrently
    from multiple request threads.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._global_count = 0
        self._per_user_count: dict[str, int] = {}

    def try_acquire(
        self, user_id: str, *, global_limit: int, per_user_limit: int
    ) -> bool:
        with self._lock:
            if self._global_count >= global_limit:
                return False
            if self._per_user_count.get(user_id, 0) >= per_user_limit:
                return False
            self._global_count += 1
            self._per_user_count[user_id] = self._per_user_count.get(user_id, 0) + 1
            return True

    def release(self, user_id: str) -> None:
        with self._lock:
            if self._global_count > 0:
                self._global_count -= 1
            remaining = self._per_user_count.get(user_id, 0) - 1
            if remaining <= 0:
                self._per_user_count.pop(user_id, None)
            else:
                self._per_user_count[user_id] = remaining

    def try_acquire_global(self, *, global_limit: int) -> bool:
        """Global-only slot for EMBEDDED evaluation (script columns/steps):
        one slot per evaluate/export request, no per-user cap (the per-user
        cap protects the interactive console; a table view is not an
        interactive run). Fail-fast like `try_acquire` — the caller degrades
        to error cells / warnings, never blocks."""
        with self._lock:
            if self._global_count >= global_limit:
                return False
            self._global_count += 1
            return True

    def release_global(self) -> None:
        with self._lock:
            if self._global_count > 0:
                self._global_count -= 1


#: module singleton — counters must persist across requests within this
#: process; limits are read fresh from settings on every acquire. Shared by
#: console runs (routes/snippets.py) and embedded evaluation
#: (script_eval.py) — the global cap covers BOTH.
concurrency_guard = ConcurrencyGuard()
