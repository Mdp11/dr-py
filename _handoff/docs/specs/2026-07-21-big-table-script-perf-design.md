# Big-table script-column performance — design

**Date:** 2026-07-21
**Status:** approved for planning
**Problem:** tables with 3k+ rows and script columns are slow in three ways:
cold sweep on first open, full recompute after every commit, and
sorting/paging by script column (gated on the sweep). Typical snippets are
mixed: simple property math and relationship traversals, user-authored.

## Measured ground truth (do not re-litigate without new numbers)

- Warm per-call bridge round trip: **~0.3–0.5 ms** on the reference machine
  (`tests/api/test_script_sweep_perf.py::test_percall_roundtrip_budget`).
- Every facade read (`dr.element`, `out()`, `in_()`, `children()`,
  `parent()`, `dr.elements()` pages) is its own round trip; `parent()` is two.
  A traversal cell pays many trips; a trivial cell pays the call frame plus
  one root fetch.
- Sweep sharding at 4 workers yields ~3–4× (same file,
  `test_parallel_sweep_speedup`); host-side dispatch is GIL-bound, and the
  pool cliff is `workers × distinct codes` (`core/script/README.md`,
  "Pool sizing caveat").
- The cell cache is cleared wholesale on every rev bump
  (`ScriptCellCache.clear_and_stamp`), so one edit recomputes every cell.

Consequences: call-frame batching has a fixed ceiling (~0.4 ms/cell);
read-trip collapse scales with snippet chattiness; nothing but smarter
invalidation fixes the post-edit grind.

## Phase A′ — transparent trip-collapse (cold sweep + sort latency)

Zero snippet edits, zero new host-side orchestration. Three changes:

1. **Inline far-endpoint projections on hop reads.** `outgoing`/`incoming`
   bridge responses gain an additive key carrying the far endpoint's element
   projection (`_project_element` output) next to each relationship dict.
   Existing consumers ignore the extra key; the wire shape is otherwise
   unchanged.
2. **Session-lifetime read memo in the guest facade.** The facade memoizes
   bridge read responses for the life of the embedded session, and hop
   responses prime the memo with the neighbor projections they shipped.
   `out()` + N neighbor fetches drops from 1 + N trips to 1; repeated
   `parent()` walks through shared ancestors collapse to one fetch each.
   Capped (size bound, drop-oldest); soundness rests on the invariant the
   cell cache already assumes — same code + same model ⇒ same result — and a
   session never outlives one rev's work (sessions are per
   `(ScriptEvalContext, code)`, contexts are per request / per sweep job at a
   sampled rev).
3. **Root-element piggyback on the call frame.** The embedded `call` message
   includes the projected root elements inline (the host has them; today the
   facade re-fetches each by id). A trivial property-math cell becomes
   exactly one round trip. Piggybacked roots also prime the memo.

**Instrumentation first.** Task 1 of the phase: a perf-marked fixture with a
3k-row table (mixed cheap + traversal columns) counting round trips per cell
and separating host-dispatch from guest-exec time. Run before and after; the
numbers decide whether the deferred items (below) stay deferred, and extend
`test_script_sweep_perf.py` with a trips-per-cell regression guard.

Determinism is untouched: same shims, same guest, same per-item
pure-function contract. `RunLimits`/budget semantics unchanged.

## Phase B — read-set tracking → incremental invalidation (post-edit grind)

**Capture is guest-side, at the facade wrapper level.** Each embedded call
records the read keys it *uses* — including memo hits and piggyback-primed
data, charged to the item that reuses them — and returns them on the
`call_result` frame. Read keys are structured:

- `("el", id)` — element fetch / property read / primed projection use
- `("out", id)` / `("in", id)` / `("children", id)` / `("parent", id)`
- `("scan", type_or_none)` — any `dr.elements(type=...)` page; deliberately
  coarse

**Cache stores read-sets; commits evict selectively.** `ScriptCellCache`
entries become `(CallResult, frozenset[ReadKey] | None)`. On the commit
paths (`/commits`, `/model/ops`, `/model/undo`) the op batch is translated
into a touched-key set:

- update/delete element → its `el` + all four adjacency keys
- connect/delete relationship → `out` of the source, `in` of the target
- containment change → `children`/`parent` keys of both old and new parents
- create/delete of type T → `("scan", T)` and `("scan", None)`

`evict_touched(touched, new_rev)` drops intersecting cells and re-stamps
survivors to the new rev in place. Everything else is over-invalidation-safe:

- Paths with no op delta — legacy `touch_model`, model upload, hydration,
  metamodel swap — keep clear-all.
- `reads=None` (pre-Phase-B result, or a read-set that overflowed the
  per-cell cap of ~2 000 keys) means "depends on everything": always evicted.
- Sweep job registry and `TableOrderCache` still invalidate per rev; the
  post-edit sweep simply finds most cells warm, and a script-column re-sort
  is a cache-only pass over warm cells. The "computing" flash becomes
  proportional to the edit.

**Memory:** read-sets are interned tuples; traversal cells hold ~10–50 keys,
tens of MB worst-case at the 50k-cell cap, bounded by the overflow rule.

## Explicit non-goals (this design)

- **`call_many` / chunked call frames.** Fixed ceiling ~0.4 ms/cell; brings
  per-chunk timeout attribution and retry-fallback complexity, and would
  force per-item read-set bookkeeping in Phase B. Revisit only if the
  post-A′ instrumentation shows the residual call frame dominating on big
  cheap tables.
- **Worker/pool scale-up.** ~3–4× at 4 workers already banked; further
  workers are GIL-bound on dispatch, cost a full WASM interpreter each, and
  walk into the `workers × distinct codes` pool cliff.
- **Whole-column mode** (`value()` once with all 3k roots) and bulk facade
  primitives (`elements_by_ids`, `neighbors`). Whole-column fights the
  per-row cache key, per-cell degradation, and Phase B invalidation
  granularity; the primitives are YAGNI until measurement shows residual
  demand. Both remain candidate future opt-ins.

## Testing

**Phase A′:**
- Facade memo: hop primes memo; repeated fetch of the same neighbor across
  items is one trip (assert via a counting dispatcher fake); cap eviction.
- Wire compat: old-shape consumers of `outgoing`/`incoming` unaffected by
  the additive key; `TrustedRunner` grows the same inline/memo behavior so
  the hermetic suite covers it without the binary.
- Results parity: a traversal snippet's output is byte-identical with the
  memo on vs off (determinism regression).
- Perf: trips-per-cell guard added to the perf-marked suite; existing
  round-trip and sharding guards must stay green.

**Phase B:**
- Attribution: memo-hit reads and primed projections are charged to the
  using item; per-call read-sets round-trip on `call_result`.
- `evict_touched`: table-driven cases per op kind asserting exactly which
  key shapes evict; `reads=None` always evicts; overflow → `None`;
  clear-all paths still wipe.
- End-to-end: small table, commit touching one element → exactly that row's
  cells recompute (assert via sweep `total` / guest-call count).
- Soundness property test: random small op batches × random snippet shapes —
  every surviving cached value equals a fresh recompute.

**Rollout:** both phases behind settings (memo cap, incremental-invalidation
boolean, default on once the property test is green). No client-visible API
changes — same `script_status` protocol, just faster.
