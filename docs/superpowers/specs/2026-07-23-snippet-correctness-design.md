# Snippet correctness & error visibility — design

Date: 2026-07-23
Status: approved (session 1 of the July 2026 fix batch)

## Problem

Three related problems around embedded snippet evaluation (`value`/`step` entry
points in tables and navigations):

1. **Navigations containing a script step return empty results when embedded in
   a table** (row source or navigation column), always and silently. Root
   cause: the table evaluator calls navigation `evaluate()` at four sites
   without passing the `ScriptEvalContext` it already holds for script columns
   (`core/table/evaluate.py:93, 112, 268, 305` — the helpers don't even accept
   a `script` parameter). With `script=None`, `_hop_script` returns `[]`
   silently (`core/navigation/evaluate.py:348-349`), a behavior locked in by
   `test_script_step_without_context_prunes_silently`.
2. **The `step()` return contract is hostile to natural usage.** Returning a
   single `Element` (e.g. `return el` or `return el.children()[0]`) fails with
   the baffling `KeyError: 0` — the guest serializer requires an iterable, and
   iterating an `Element` (which has `__getitem__` for property access but no
   `__iter__`) tries `el[0]`. Returning a non-element value fails with a
   message that never mentions that `return None` is the documented way to end
   a chain. Additionally, ids dropped by the chain walker's visited-exclusion
   guard vanish with no warning, so `step(el) -> [el]` looks like a silent
   failure even though the exclusion is by design.
3. **Failed script cells are hard to find.** Errors surface only as per-cell
   `⚠` glyphs in the grid; in a large virtualized table the user must scroll
   hunting for them. There is no error list, count, or jump-to-cell anywhere
   (verified: no aggregate exists in backend or frontend today).

Additionally, two regression-test gaps in the embedded read-only guarantee were
found: the `/snippets/run` route's `record_ops=(entry == "script")` mapping
(`routes/snippets.py:282`) is untested for `value`/`step` write rejection, and
no end-to-end test drives a table script column that attempts a write.

## Scope

In scope: the four fixes below, their tests, and doc updates. Out of scope:
project-wide error aggregation, navigation-editor UX changes beyond warnings,
any change to the read-only enforcement itself (it is correct; only test
coverage is missing).

## Design

### 1. Thread the script context through the table evaluator

Add a `script: ScriptEvalContext | None` parameter to the four
navigation-evaluating helpers in `core/table/evaluate.py`
(`_navigation_row_keys`, `_chain_row_keys`, `_navigation_reached_ex`,
`_navigation_step_elements`) and their call chain, passing the context the
table evaluation already owns. Consequences, all via existing machinery:

- Nav-step warnings flow into `TablePageOut.warnings` (`schemas.py:951` —
  the field's documented purpose).
- Nav-step calls participate in the shared per-session cell cache, request
  memoization, and `ScriptBudget` exactly like script-column calls
  (`ScriptEvalContext.call` is the common entry).
- The sweep/cache-only degraded stance is unchanged: a cache miss in a
  cache-only pass yields a synthetic `pending` error, which `_hop_script`
  already prunes with a warning.

Defense-in-depth: when `_hop_script` runs with `script=None` for a step that
*is* configured (has a `definition`), it can no longer stay silent — but with
`script=None` there is no warnings channel. Resolution: `_hop_script` keeps
returning `[]`, and `evaluate()` grows no new channel; instead the guarantee
is structural — `table_has_script()` already returns `True` for nested script
steps, so the table route always opens a context, and after this change that
context always reaches the hop. Update
`test_script_step_without_context_prunes_silently` to keep pinning the
`script=None` behavior (it remains the correct degraded fallback for callers
without a runner) but retitle/comment it so it no longer reads as an endorsement
of the table path's silence.

### 2. Fix the `step()` return contract (guest serializer)

In `facade_src.py`'s `_dr_serialize_entry_result("step", value)`:

- Accept a single `Element` → `{"ids": [el.id]}`.
- Accept a single `str` (an element id) → `{"ids": [value]}`. A bare string is
  no longer rejected as "iterable of characters"; it is one id.
- `None` → `{"ids": []}` (unchanged — ends the chain).
- Iterables of `Element`/`str` unchanged.
- Anything else raises `ValueError` with a teaching message:
  `"step() must return an Element, an element id, an iterable of those, or
  None (None ends the chain); got <type name>"`.

The `Element` check runs before generic iteration, so the `KeyError: 0` path
disappears. Host-side validation (`runner.py` `decode_call_payload`) is
unchanged — the wire shape is still `{"ids": [str, ...]}`.

`value()` keeps its own contract; no change there.

### 3. Warn when visited-exclusion drops script-step results

In `core/navigation/evaluate.py`'s walker: when the `exclude_visited` guard
drops ids that came from a **script** step, emit
`script step: N element(s) dropped (already visited in this chain)` via the
existing warnings channel. Relationship hops keep dropping silently (expected
navigation semantics). Warnings are already deduped and capped at
`MAX_SCRIPT_WARNINGS`, so no flood risk. Semantics of the guard itself are
unchanged (identity returns still do not continue a chain).

### 4. Per-table script-error recap with jump-to-cell

**Backend** — new route `POST /projects/{project_id}/tables/script-errors`
(read-only POST; add its suffix to `authz._READ_ONLY_POST_SUFFIXES`). Request
body mirrors `/tables/evaluate` (inline definition XOR `artifact_id`).
Behavior mirrors `/tables/export`'s whole-table cache-only pass:

- If the sweep for this `(fingerprint, rev)` is still computing → respond
  `202` with `Retry-After: 1` (the status code is the retry signal, matching
  export).
- Otherwise walk the table cache-only and collect cells that are
  `ErrorCell`s, returning
  `{state, errors: [{row_index, row_element_id, row_label, column_label,
  message}], total_errors, truncated}` with the `errors` list capped at 200
  (`truncated: true` beyond that; `total_errors` is the full count).
  `PendingCell`s encountered after a terminal sweep count as errors with a
  "could not be computed" message (consistent with `script_status: failed`
  semantics).
- Degraded stance preserved: missing runner or empty cache never 5xxs — the
  response reports what the cache holds.

**Frontend** — next to the existing script-status line in
`TableView.svelte`: once `script_status` settles (`ready` or `failed`), fetch
the recap unconditionally; show an error-count badge only when
`total_errors > 0`. Clicking opens a
panel listing the failures (row label, column, message); clicking an entry
scrolls the virtualized grid to `row_index` and highlights the cell.
State lives in `table-editor.svelte.ts` alongside the existing per-tab
`script_status`; the recap invalidates on rev change like the rest of the
table state. MSW-backed vitest coverage for badge/panel/jump.

### 5. Read-only regression tests

- Route-level: `POST /snippets/run` with `entry="value"` and `entry="step"`
  whose code calls `dr.create(...)` → the run reports the ReadOnly error and
  records zero ops. Pins `routes/snippets.py:282`.
- End-to-end: a table with a script column whose snippet attempts a write
  evaluates to an error cell over HTTP and leaves the model unmutated.

### Testing strategy

Core fixes are tested with `TrustedRunner` (it executes the same
`facade_src.py`, so the serializer change is covered without WASM): step
returning a single `Element`, a single id, `None`, bad types (message
asserted), visited-drop warning. New end-to-end route tests cover the exact
scenario that was never covered: a navigation with a script step used as a
table row source and as a navigation column, evaluated via HTTP, asserting
non-empty results and warning propagation. Recap endpoint tests cover the
202-while-computing contract, the cap/truncation, and pending-after-terminal
accounting. Existing wasm `integration`-marked tests are extended only if the
serializer change needs sandbox confirmation (one case: single-Element return).

### Docs

- `core/script/README.md`: update the `step()` contract row (single
  Element/id accepted, `None` ends the chain, visited-exclusion warning).
- `frontend/README.md`: document the recap badge/panel in the table section.

## Risks / notes

- Threading the context into table-embedded navs means those calls now spend
  the shared request `ScriptBudget`; a table with many nav-step rows could
  exhaust it and degrade to `timeout`-pruned chains with warnings — accepted
  (same stance as script columns, and strictly better than silent empty).
- The recap endpoint takes a global concurrency slot like evaluate/export?
  No — it is cache-only and never calls the guest, so it takes no slot.
- `step()` accepting a bare string changes behavior for a snippet that
  (incorrectly) returned a multi-char string expecting per-character ids —
  no realistic snippet does this; the old behavior was an error anyway.
