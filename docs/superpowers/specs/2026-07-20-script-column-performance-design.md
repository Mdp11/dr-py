# Script column performance overhaul (Phases A + B + C)

**Date:** 2026-07-20
**Status:** approved design, pre-implementation
**Scope:** embedded snippet evaluation for tables (M2 `ScriptColumn`); navigation
`ScriptStep` (M3) gains the Phase A cache automatically but is otherwise out of
scope.

## 1. Problem

A script column on a small table works; the same snippet on a ~3k-row table
freezes the app. Measured against the real WASM runner (guest binary fetched,
pool warm):

| snippet shape                        | per call | 3,000 rows | 10,000 rows |
|--------------------------------------|----------|------------|-------------|
| property read                        | 0.5 ms   | 1.5 s      | 5 s         |
| one nav hop (`el.out()`)             | 0.8 ms   | 2.3 s      | 8 s         |
| per-row model scan (`dr.elements()`) | 16.3 ms  | **49 s**   | **163 s**   |

Session boot is cheap (instance ~200 ms, `open_session` ~5 ms, call round-trip
~0.5 ms). The freeze is architectural, five interacting causes:

1. **Whole-table passes run serially inside one HTTP request.** Sort by a
   script column, `keep_empty=false`, expand mode, script-as-source, and
   export all call `value()` once per row for the FULL row set
   (`build_rows_ex` / `order_rows` / `_sort_value`) before the response can
   start. Only the default collapse + keep_empty + unsorted case is lazy
   (visible window only).
2. **The 30 s `ScriptBudget` turns big tables into permanently failing
   requests.** Any snippet doing real per-row work exhausts it mid-pass;
   every remaining row degrades to a `timeout` error cell.
3. **The errored→never-cache guard creates an infinite grind loop.**
   `routes/tables.py` skips the `TableOrderCache` when `script_ctx.errored`
   (correct as a poisoning guard), so the order cache NEVER fills for such a
   table. Reproduced: two identical sorted requests on a 3k model each made
   3,003 fresh guest calls, each burned the full budget, each skipped the
   cache. Every scroll chunk, sort toggle, and commit-feed refresh repeats
   the full grind. The frontend's core assumption ("chunk requests are cheap
   page reads, not re-evaluations", `table-editor.svelte.ts`) is violated
   forever.
4. **Zero cross-request reuse of computed cells.** The `ScriptEvalContext`
   memo dies with the request; successfully computed cells are recomputed
   from scratch on the next request. The only cross-request cache is the row
   ORDER — exactly the one that never fills.
5. **Starvation amplifiers.** `ensureTableRange` fires chunk fetches
   concurrently; each takes one of 4 global snippet slots and one of 2 warm
   pool instances. Request #3 blocks 10 s in `pool.get` then degrades to
   `unavailable` cells; #5+ get `busy` cells; neither is cacheable.

Multiple script columns share the one 30 s budget per request, so multi-snippet
tables at 5–10k rows are strictly worse.

## 2. Goals

- No request ever blocks on whole-table script evaluation.
- Script work converges: computed cells are never recomputed within a rev.
- A sorted 10k-row table with multiple heavy snippets settles progressively
  in background and then serves cheap cached pages.
- The engine's existing invariants hold: determinism guarantee, read-only
  sessions, degraded-not-failed stance (routes stay 200), benign-race reads
  without `write_mutex`, `touch_model` invalidation discipline.

Non-goals: `call_many` batch wire frames (measured round-trip is 0.5 ms; not
worth the protocol/timeout complexity — revisit only if profiling after A+B+C
shows round-trips dominating), read-set-based selective invalidation (possible
later phase), durable (DB) persistence of cell results, nav-step sweeps.

## 3. Phase A — durable per-cell result cache

### 3.1 `ScriptCellCache` (`core/script/cell_cache.py`, new)

Pure, thread-safe, LRU-capped map. Lives in `core/script` (imports only
`core.*`), instantiated per `Session` in `api/session.py` (field
`script_cell_cache`, like `table_order_cache`).

- **Key:** `(sha256(code), entry, tuple(element_ids))`. `code` is the snippet
  source exactly as sent to the guest (same string `ScriptEvalContext`
  sessions key on).
- **Rev stamping instead of rev-in-key:** the cache carries a `rev` stamp.
  `Session.touch_model` / `set_model` call `clear_and_stamp(new_rev)` —
  wholesale wipe on every commit, same lifecycle as `TableOrderCache`.
  Rationale: a snippet can read anything in the model, so any commit may
  invalidate any cell; Phase B makes recompute non-blocking, so the wipe
  costs a brief return to "computing", never a freeze.
- **Poisoning guard:** `put(key, result, rev)` is a no-op when
  `rev != stamp`; `get(key, rev)` misses when `rev != stamp`. A request that
  computed against a superseded model cannot write into the fresh cache
  (mirrors the order cache's sampled-rev rule; evaluation stays outside any
  lock, a lost race merely recomputes).
- **Value filtering:** cache `CallResult`s with `error=None`, and
  deterministic errors (`kind` in `{"runtime", "syntax"}`). NEVER cache
  `timeout` / `unavailable` / `memory` / `cancelled` — environmental, must be
  retryable. (Memory kills also destroy the guest; treat like timeout.)
- **Cap:** `snippet_cell_cache_max` entries (default 50,000), LRU eviction
  (`OrderedDict` + `Lock`, same shape as `TableOrderCache`).

### 3.2 Wiring

`ScriptEvalContext.__init__` gains optional `cell_cache: ScriptCellCache |
None` and `rev: int`. `call()` resolution order: per-request `_memo` → cell
cache → guest; successful/deterministic results write through to both.
`open_script_context` (`api/script_eval.py`) passes
`session.script_cell_cache` and the route's already-sampled `rev`.

Phase A alone converts the grind loop into convergence: request N+1 resumes
where request N's budget ran out; cross-chunk and cross-sort recomputation
disappears; the order cache fills on the first fully-clean pass.

## 4. Phase B — whole-table script work leaves the request path

### 4.1 Core rule

**The guest is only ever invoked inline for visible-window cell rendering**
(bounded by `limit ≤ 500`). Whole-table passes run **cache-only**.

`ScriptEvalContext` gains a `cache_only` mode: in this mode, a `call()`
originating from a whole-table pass that misses the cache does NOT invoke the
guest; it returns a
synthetic pending `CallResult` and increments `ctx.pending_misses`. Pending is
tracked separately from `errored`: pending is not poison (no red error cells),
but the route skips the `TableOrderCache` while `pending_misses > 0`, exactly
as it does for `errored`.

Mechanically, `build_rows_ex` / `order_rows` / `_sort_value` /
`resolve_source_elements` run with cache-only semantics; `evaluate_cells` for
the requested window runs with the guest enabled (and its results land in the
shared cache, contributing to sweep progress).

### 4.2 Degraded-but-honest response shape while pending

While anything is pending, the route returns:

- rows **unfiltered** (`keep_empty=false` not applied),
- expand script columns contribute **one pending cell per base row** (no row
  multiplication yet),
- sort-by-script-column falls back to build order,
- a new `script_status` block on `TablePageOut`:
  `{"state": "ready" | "computing" | "failed", "done": int, "total": int | null, "message": str | null}`.
  `total` is `null` until the sweep has built the base row set (expand makes
  the item count dynamic). `failed` carries a `message` (timeout-abort or
  ceiling, §6).

When the sweep completes, the next evaluate is all cache hits → real shape
(filtered, multiplied, sorted), the order cache fills, and pages return to
cheap reads. `script_status.state == "ready"` with no sweep needed is the
steady state (also the state for tables whose script work fits entirely in
the window, e.g. unsorted collapse keep_empty tables — no behavior change for
them beyond the cache).

### 4.3 The sweep (`api/script_sweep.py`, new)

Mirrors `validation_sweep.py`'s shape: per-session job registry + progress
counters readable without a lock dance.

- **Job key:** `(resolved-definition fingerprint EXCLUDING sort, model_rev)`.
  Sort is excluded because `_sort_value` calls the same
  `(code, "value", ids)` keys as cell rendering — **one sweep serves every
  sort order, the keep_empty filter, cell rendering, and export** of that
  table at that rev.
- **Job body:** run `build_rows_ex` with a real guest-enabled context
  (computes expand/keep_empty/source items in dependency order), then for
  every script column × every row call `value()` — all results land in the
  shared cell cache. Progress = items completed / items known.
- **Trigger:** `/tables/evaluate` and `/tables/export` kick-or-join the job
  when their cache-only pass reports `pending_misses > 0`. Idempotent: a
  second request for the same table joins the running job.
- **Failed-job memory:** a job that aborted via a pathology guard (§6) stays
  in the registry as `failed` for its `(fingerprint, rev)` — subsequent
  evaluates return `script_status: failed` and do NOT re-kick it (otherwise
  the next poll would restart the grind: timeouts are deliberately not
  cached). The failed entry is dropped with everything else on
  `touch_model`, so the next commit retries naturally.
- **Abort conditions:** commit (`touch_model` clears the cache and signals
  every job to stop — next poll re-kicks at the new rev), session evict
  (sweeps must never block eviction; `SessionRegistry.evict` aborts jobs
  before dropping the session — NOT another evict-skip guard), runner
  shutdown, and the pathology guards (§6). Abort checks happen between
  calls (the per-call wall timeout bounds the tail).
- **Executor:** sweeps run on their own process-wide worker pool (§5), NOT on
  request threads and NOT drawing console `_ConcurrencyGuard` slots — a sweep
  cannot starve the snippet console and vice versa. Per-session at most one
  active job; further jobs queue FIFO (a user flipping between two script
  tables sweeps them in turn).

### 4.4 API surface

- `TablePageOut.script_status` (nullable, §4.2).
- New `TableCellOut` kind `"pending"`.
- `/tables/export`: if the table's sweep is incomplete, kick/join it and
  return **202** with the `script_status` JSON body and a `Retry-After`
  header; the client retries until the 200 workbook. A complete table
  exports from pure cache hits (no fresh guest work). Export never blocks a
  worker thread for the duration of a sweep and never ships cells that are
  merely not-yet-computed; genuinely errored cells still export as `#ERROR`
  with the existing notice.

### 4.5 Frontend (`table-editor.svelte.ts` + grid)

- While a response carries `script_status.state === "computing"`: re-poll the
  visible window on a ~1 s interval (same pattern as open-journey status
  polling); stop on `ready` / `failed` / tab close; the per-tab generation
  counter already guards stale responses.
- Grid renders `pending` cells as placeholders (shimmer, like unfetched-row
  placeholders) and shows "computing n/N" in the header near the sort
  indicator; `failed` shows the message where eval errors show today.
- Export button: during 202 loops show "preparing export n/N", retry on
  `Retry-After`, then download.
- `handleTableModelRevChanged` needs no change: the post-commit refetch gets
  `computing` and enters the poll loop naturally.

## 5. Phase C — parallel sweep workers

- The sweep shards its item stream across up to `snippet_sweep_workers`
  (default 4) `SnippetSession`s **of the same code**, each on its own guest
  instance, pulling from a shared work queue. Sessions are read-only and the
  determinism guarantee makes call order irrelevant. The documented caveat —
  entry points mutating module globals across calls are outside the
  guarantee — becomes a hard "don't" in the snippet docs: sharding means
  cross-call state is split across instances.
- Expand-column dependency items (row-set construction) stay in a serial
  prefix; per-cell `value()` items (the bulk) parallelize.
- `snippet_pool_size` default rises 2 → 6 (workers + console headroom). The
  refill loop stays serial (~200 ms/boot; worst case ~1.2 s to refill a
  drained pool — acceptable).
- Consecutive-timeout and ceiling guards (§6) are job-global (shared atomic
  counter under the job's lock), not per worker.
- Expected effect: the 49 s / 3k-row scan-snippet column settles in ~12 s of
  background work; 163 s / 10k rows in ~40 s.

## 6. Pathology guards

Per-call `wall_timeout_s` (default 10 s) kill is unchanged. Two new guards in
the sweep loop, both cheap counters:

1. **Consecutive-timeout abort:** after `snippet_sweep_timeout_abort`
   (default 3) consecutive per-call timeouts, abort the column — a snippet
   that times out on 3 different rows is uniformly slow. Remaining cells
   report `timeout` for this rev (NOT cached; a later rev retries);
   `script_status` → `failed` with a message naming the guard.
2. **Sweep ceiling:** `snippet_sweep_ceiling_s` (default 600) wall-clock
   ceiling per job — the backstop for erratically slow snippets that pass
   guard 1. Same `failed` surfacing.

The inline path keeps `snippet_eval_budget_s` (30 s), now generous since
inline work is ≤ 500 calls per request.

## 7. Settings (all `DATA_ROVER_SNIPPET_*`, in `api/settings.py`)

| setting | default | phase |
|---|---|---|
| `snippet_cell_cache_max` | 50,000 entries | A |
| `snippet_sweep_workers` | 4 | B (=1) / C (>1) |
| `snippet_sweep_ceiling_s` | 600 | B |
| `snippet_sweep_timeout_abort` | 3 | B |
| `snippet_pool_size` | 2 → **6** | C |

Phase B ships with the sweep executor honoring `snippet_sweep_workers=1`
semantics (serial); Phase C turns the same knob to 4 by default.

## 8. Testing

- **Core:** `ScriptCellCache` unit tests (LRU, rev stamping, put/get guards,
  error-kind filtering); `ScriptEvalContext` cache-only mode (pending
  synthesis, `pending_misses` vs `errored` separation, write-through).
- **API (hermetic, `TrustedRunner`):** sweep lifecycle — kick/join,
  progress, completion → real shape + order-cache fill; abort on commit
  (`touch_model`), abort on evict, consecutive-timeout abort, ceiling abort;
  route tests for `script_status`, degraded shapes (unfiltered /
  single-pending-expand / unsorted fallback), 202 export loop, order-cache
  skip while pending.
- **Frontend (vitest + MSW):** poll loop start/stop, pending cell rendering,
  generation-guard interplay, export retry loop.
- **Integration (`integration`-marked, real WASM):** sorted 1k-row script
  column settles to sorted order end-to-end; parallel sweep produces
  byte-identical results to serial.
- **Perf (`perf`-marked):** the investigation's benchmark scripts become a
  regression check (per-call round-trip, sweep throughput serial vs 4
  workers).

## 9. Invariants preserved / touched

- Reads stay lock-free (benign-race + rev sampling); the cell cache adds the
  same sampled-rev poisoning guard the order cache uses.
- `touch_model` remains the single invalidation point (now also clears the
  cell cache and aborts sweeps).
- Sessions/dispatchers stay read-only (`record_ops=False`); the sweep adds no
  write path.
- Degraded-not-failed: routes still 200 (202 for incomplete export is the
  one deliberate exception, chosen over shipping incomplete workbooks).
- Determinism guarantee is what makes the cache and the sharding sound; the
  module-global-state caveat is promoted from "outside the guarantee" to an
  explicit documented "don't".
- Eviction: `SessionRegistry.evict` aborts sweeps rather than skipping
  eviction (unlike live locks / feed clients, a sweep is derived work that
  can always be recomputed).

## 10. Implementation order

A (cache + wiring) → B (cache-only mode + degraded shape + sweep + routes +
frontend polling) → C (parallel workers + pool bump). Each phase lands
independently shippable; A alone removes the infinite grind, B removes the
30 s blocked requests, C cuts settle time ~4×.
