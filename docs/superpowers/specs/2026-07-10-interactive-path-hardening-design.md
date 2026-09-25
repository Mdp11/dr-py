# Interactive-path hardening (Approach C slice) — design

Date: 2026-07-10
Status: approved (user, 2026-07-10)

## Problem

At today's scale (100–500 MB models, 100k–500k elements) the exploration UX is
not smooth: tree scrolling, folder expansion, and list scrolling stutter, and
project open blocks with no feedback. A code audit located the causes:

1. `list_containment_roots` / `list_excluded_roots` rebuild and re-sort the
   full root set on **every page request**, ignoring offset/limit
   (`src/data_rover/api/routes/read.py:509-555`) — O(model · log n) per call.
2. Unfiltered element paging skip-scans from the start — O(offset)
   (`read.py:229-241`).
3. Full-model validation (6 validators, O(model)) runs synchronously inside
   load/upload/hydrate requests (`routes/model.py:135`, `hydration.py:193`).
4. No progress feedback during long waits (upload, open, validation).
5. When a project has a view, the tree paints all elements for a moment before
   collapsing to the view state (paint-before-view-resolution race).

The frontend is already virtualized and paged (windowed tree, batch fetches,
never holds the whole model) — it inherits whatever latency the server has.

## Scope & success criteria

- Tree scroll, folder open, list scroll feel instant at 500k elements:
  hot read endpoints O(page), target < 30 ms server-side.
- Project open returns fast; validation runs in the background with visible
  progress; issues appear when the sweep completes.
- Long waits show a spinner; when a total is known it is a determinate radial
  progress with the percentage number centered.
- No flash of un-collapsed tree when a view is present: first paint is the
  collapsed view state.
- **Out of scope:** search indexing (next slice), embedded-store/Postgres
  moves (Approaches A/B), any API shape change for existing frontend calls.

## Design

### 1. Baseline measurement

A script generates a synthetic ~500k-element project; record before/after
timings for containment-roots, tree-items, and element-page endpoints. Proof,
not vibes.

### 2. Maintained order indexes (backend core)

`IndexSet` gains incrementally-maintained sorted collections (SortedList-style,
keyed by `(display_name, id)`):

- all elements (for unfiltered element paging), and
- containment roots (elements with no containment parent).

Maintenance hooks live where the existing adjacency indexes are kept in sync —
the single `Model` mutation boundary (create/connect/set_property/delete/
restore). `indexes.rebuild()` repopulates them for bulk loads. Display-name
changes (property set) must reposition the entry.

Endpoints `list_containment_roots`, `list_excluded_roots`, and unfiltered
element paging become O(page + log n) slices over these collections. The
offset-based API contract is **unchanged**; the frontend needs zero changes
and random-access scrolling keeps working.

### 3. Background validation + progress (backend)

Full-model validation moves off the load/upload/hydrate request path into a
background task per session:

- Requests return as soon as the model is built and indexed.
- The session exposes task status — `phase`, `done`, `total` (entities
  processed) — via a lightweight `GET .../model/status` endpoint.
- Issues splice into the issue store when the sweep completes. Dirty-set
  validation on edit batches is untouched (it must still work against a
  not-yet-seeded baseline exactly as `_ensure_validation_seeded` does today).

### 4. Progress UI (frontend)

One reusable overlay component: radial spinner, **determinate (0–100 % with
the number centered) whenever a total is known**, indeterminate otherwise.
Wired to:

- model upload — browser upload-byte progress (determinate);
- project open / hydration and background validation — poll `/model/status`
  (determinate per phase);
- other known-long awaits (save/download) — indeterminate unless measurable.

Polling, not the WebSocket feed: it must work before the feed connects.

### 5. View-flash fix (frontend)

Ordering invariant in load orchestration: on project open the tree does not
paint rows until view membership is resolved (view loaded, or confirmed
absent). Until then it shows the §4 loading state; first paint is already the
collapsed view. A sequencing fix, not a new mechanism.

## Testing

- Core unit tests: order-index maintenance under create/delete/rename/
  restore/rebuild; parity between index slices and a naive recompute.
- API tests: paging correctness (roots, excluded roots, element pages),
  `/model/status` lifecycle (idle → running with counts → complete), issues
  present after background sweep.
- Frontend (vitest + MSW): progress component determinate/indeterminate modes;
  no-flash gating — an MSW-delayed view fetch must not produce an expanded
  first paint.
- Perf: §1 baseline re-run as before/after evidence.

## Sequencing

§2 first (biggest felt win) → §3 + §4 together (shared status plumbing) → §5.
Each lands independently.

## Design deltas (from implementation planning, same day)

1. **Element-list paging demoted to a micro-fix.** `/model/elements` promises
   *insertion order* (docstring + tests assert it); a display-name order index
   can't serve it and a per-type insertion-order index isn't warranted — the
   user-named pain is the tree, which never calls this endpoint. We keep the
   contract and swap the Python skip-loop for `itertools.islice` (C-level
   skip). The order index (§2) therefore covers **containment roots only**.
2. **Chunked background validation changes containment-cycle reporting
   granularity.** The full sweep reports ONE representative issue per run for
   a containment cycle; the chunked sweep (scoped runs over id chunks)
   reports one issue per swept element whose parent chain reaches a cycle.
   Cycles are pathological (structural blockers) — more precise reporting is
   acceptable; tests asserting the single-representative count are updated.
3. **Test determinism.** A `validation_sweep_sync` setting runs the sweep
   inline; `tests/api/conftest.py` pins it true so the existing suite keeps
   its "validation seeded after load" assumption. Async behaviour is covered
   by dedicated unit tests driving the sweep directly.
4. **Save/download overlay de-scoped this round.** Both already stream
   chunk-wise and never freeze the UI; the overlay wires into upload, open,
   and validation only. Revisit if users report export waits.

## Results

Task 1 baseline vs. after-implementation re-run, both at PERF_N=50000
(`pixi run -e core-dev pytest tests/api/test_perf_probe.py -m perf -s`):

| Endpoint                              | Baseline (Task 1) | After (Task 11) |
| -------------------------------------- | -----------------: | ----------------: |
| upload + install                       |           2036.9 ms |          1267.6 ms |
| containment roots, first page          |             40.2 ms |             5.4 ms |
| containment roots, deep page           |             44.8 ms |             4.9 ms |
| excluded roots, first page             |             39.3 ms |             8.0 ms |
| children of e0                         |              9.4 ms |             5.1 ms |
| elements, deep page (insertion order)  |             12.0 ms |             6.1 ms |
| summary                                |              9.8 ms |             4.9 ms |

Containment-roots pages (the core felt-latency target) dropped from ~40-45 ms
to single-digit ms — an ~8x improvement — confirming the maintained order
index (§2) eliminates the per-request rebuild/re-sort. Excluded roots improved
~5x for the same reason. Upload+install also improved substantially (~1.6x)
because full-model validation moved off the request path (§3) into the
background sweep. All other read endpoints stayed in single-digit ms.

### 500k re-probe (2026-07-10, follow-up ticket 7)

`PERF_N=500000` on merged main (2277e4a) — 10x the elements above, at the
spec's stated scale target:

| Endpoint                              | After, 500k |
| -------------------------------------- | ----------: |
| upload + install                       |   27591.8 ms |
| containment roots, first page          |      12.5 ms |
| containment roots, deep page           |      12.5 ms |
| excluded roots, first page             |      47.9 ms |
| children of e0                         |       9.9 ms |
| elements, deep page (insertion order)  |      19.3 ms |
| summary                                |      10.6 ms |

Every interactive read stays well under the 100 ms felt-latency bar at 500k.
Excluded roots (47.9 ms) is the one O(roots)-per-page path, exactly as
documented — it scaled ~6x for 10x elements and remains the endpoint to watch
at ~250k+ roots. Upload+install (27.6 s, one-time) is fully covered by the
determinate progress overlay + background validation sweep.
