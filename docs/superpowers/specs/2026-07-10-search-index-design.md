# Fuzzy-search trigram index (Approach C slice) — design

Date: 2026-07-10
Status: implemented (2026-07-10)

## Problem

`GET /model/elements?q=` — the quick search behind the command palette, the
sidebar search, and the element pickers — scores **every element in the model
on every keystroke** (`routes/read.py`, `_search_score` loop). Per element it
checks the name (tiered), the id, the type name, and every other top-level
string property value. O(n) per request; the last interactive path that is not
O(page)-ish. At today's 100k–500k-element scale this is felt per keystroke.

Prior slice (2026-07-10-interactive-path-hardening) fixed tree/list reads and
moved validation to a background sweep; it explicitly deferred search indexing
to this slice.

## Decisions taken during brainstorming

- **Surface:** accelerate the fuzzy `GET /model/elements?q=` path only.
  Advanced `POST /model/search` is submit-driven (not per-keystroke) and stays
  O(n) — out of scope. Relationships are not indexed (fuzzy search is
  elements-only).
- **Parity:** results and ranking must stay **byte-identical** to today's
  scan. The index is a *candidate generator*; `_search_score` remains the sole
  arbiter of matching and order.
- **Approach:** trigram inverted index in `IndexSet` (in-process, maintained
  at the `Model` mutation boundary — standing Approach-C constraint), over a
  per-element fast-scan blob (still O(n), misses the latency bar at 500k) and
  an embedded FTS engine (contradicts Approach C, new dependency, awkward
  substring semantics).

## Scope & success criteria

- Selective queries (`len(q) >= 3`, non-degenerate) at 500k elements: well
  under the 30 ms server-side bar the prior slice set.
- **Byte-identical results** (items, order, `total`) to the pre-index scan for
  every query, including `type`+`q` combinations.
- `len(q) < 3` (after trim) falls back to the existing scan — no behavior
  change, no regression.
- Index stays consistent through create / delete / set_property / restore /
  undo and bulk loads; asserted by `verify_consistent()`.
- Memory and rebuild-time overhead measured at 50k and 500k via the perf
  probe and recorded in Results below.
- **Out of scope:** advanced-search acceleration, relationship indexing,
  frontend changes of any kind, ranking changes.

## Design

### 1. Index structures (`core/model/indexes.py`)

Two new structures on `IndexSet`, mirroring the `ref_targets` / `_refs_of`
forward/reverse pattern:

- `search_postings: dict[str, set[str]]` — lowercased trigram → ids of
  elements whose searchable text contains it. SPARSE: a posting set that
  becomes empty is deleted (existing IndexSet invariant).
- `_trigrams_of: dict[str, frozenset[str]]` — element id → its current
  trigram set. Reverse map needed to diff on property change and to remove on
  delete (by hook time the old text is gone). Elements whose trigram set is
  empty (all fields shorter than 3 chars) get no entry (sparse).

**Searchable text per element** — exactly the fields `_search_score` reads:
`element.id`, `element.type_name`, and every **top-level string property
value** (including `name`), each lowercased. Non-string and nested values
contribute nothing (parity: the scan ignores them too). Trigrams of all fields
merge into ONE per-element set: cross-field false positives are possible and
harmless, because every candidate is score-verified. Strings shorter than 3
chars contribute no trigrams — they cannot contain a `>= 3`-char query, so no
parity loss.

**Parity superset argument (load-bearing):** if `q` (len ≥ 3) is a substring
of some field, that field contains every trigram of `q`, so the element sits
in every one of those posting sets and survives the intersection. Hence
candidates ⊇ true hits; `_search_score > 0` removes the rest. Order is
unaffected: the route's final sort on `(-score, id)` is a total order.

**Posting sets hold references** to the same id-string objects the model
dicts own — no string duplication; the cost is set-slot overhead. Estimate at
500k elements: ~100–300 MB depending on property-text weight. This is the
design's main risk; it is measured (below), with a documented escape hatch —
swap posting `set[str]` for int-handle arrays behind the same accessor —
if real models blow the budget.

### 2. Maintenance hooks (no new call sites in `Model`)

All mutation paths already funnel through the existing hooks (create AND
restore call `on_element_created`; set_property and the ops applier call
`on_properties_changed`; delete calls `on_element_deleted`):

- `on_element_created` → compute trigram set, record in `_trigrams_of`, add
  to postings.
- `on_element_deleted` → remove via `_trigrams_of`.
- `on_properties_changed` (element branch) → recompute the trigram set
  (id/type_name are immutable per element, so re-deriving them is cheap and
  correct), diff old vs new, apply only the delta.
- `rebuild()` → recompute both structures from scratch (bulk-load path).
- `verify_consistent()` → both structures added to the compared-attributes
  list.

Per-hook cost is O(len of the entity's searchable text) — same discipline as
the other property-driven indexes (the roots-order lesson: no hidden
whole-model work per mutation).

### 3. Query path (`routes/read.py`)

`IndexSet` gains one accessor:

- `search_candidates(q: str) -> Set[str] | None` — `None` when the index
  cannot answer (`len(q) < 3`; caller falls back to the scan). Otherwise:
  trigrams of `q`; any trigram with no posting set → empty result (a true hit
  would contain ALL trigrams); else intersect posting sets smallest-first and
  return the result. Live-view convention (do NOT mutate), like the other
  accessors.

In `list_elements`, the `query:` branch changes only its **iteration
source**: candidates from the index when available, else
`model.elements.values()`. The exact-type filter, the per-type `type_matches`
memo, `_search_score`, the `(-score, id)` sort, paging, and `total` are
untouched.

**Degenerate queries** (a token present in ~every element, e.g. "element" on
synthetic `Element NNNNN` names): the intersection is ~all elements and the
request costs what the scan costs today. Same asymptote, no regression,
explicitly not a target.

## Error handling

No new error surface: the index is internal, always consistent at the
mutation boundary, and the route's validation/paging behavior is unchanged.
Desync bugs surface as test failures via `verify_consistent()` (and the
existing `SortedPairs.remove` ValueError convention has its analogue: removing
a trigram an element does not hold is impossible by construction — removal
goes through `_trigrams_of`).

## Testing

- **Core unit tests** (`tests/model/test_search_index.py`): postings after
  create / delete / property change (rename, add/remove a string property,
  non-string values ignored, short strings ignored); sparse invariants (no
  empty posting sets, no empty `_trigrams_of` entries); `rebuild()`
  equivalence; `verify_consistent()` after mutation sequences including
  restore/undo.
- **Parity tests (load-bearing):** seeded-random small models (mixed names,
  ids, property text) × a query battery (exact / prefix / word-boundary /
  substring / property-only / id-fragment / type-name / no-hit / short /
  `type`+`q`) asserting index-backed results equal a reference scan
  item-for-item, including order and `total`.
- **API tests:** existing `/model/elements?q=` tests must pass unchanged (they
  now exercise the index path); add short-query fallback and `type`+`q` cases
  if not already covered.
- **Perf probe** (`tests/api/test_perf_probe.py`): new timed rows — selective
  fuzzy query, degenerate common-token query, short-query fallback — plus a
  printed index stat (posting count / total posting entries). Baseline
  (pre-index) and after numbers recorded below at 50k and 500k.

## Documentation

- Extend the `IndexSet` module docstring's maintenance-obligations paragraph
  with the new index (direct writers of `entity.properties` must call
  `on_properties_changed` — obligation unchanged, now also feeding search).
- Add the search index to CLAUDE.md's read-path notes alongside
  `roots_order`.

## Deltas during implementation

Two measured problems from the probe run above prompted a follow-up fix wave
(separate commit, same branch):

1. **Scan-fallback threshold in `search_candidates`.** The "same asymptote, no
   regression" framing for degenerate queries did not hold in practice: at
   500k, intersecting five ~500k-entry posting sets measured 5.6x slower than
   the scan it replaces (2.1 s vs 375 ms). Root cause: intersecting-and-then-
   scoring ~the whole model costs strictly more work than a single linear scan
   over the same elements, once you account for set-intersection overhead on
   top of the scoring the scan would have done anyway. Fix: `indexes.py`
   gained `_SEARCH_FALLBACK_FLOOR = 10_000` and `_SEARCH_FALLBACK_FRACTION =
   4`; `search_candidates` now returns `None` (caller scans) when the
   *smallest* posting set for `q` already has `>= max(FLOOR, len(elements) //
   FRACTION)` members — even the rarest trigram of `q` is ubiquitous, so no
   intersection can narrow the candidate set enough to beat the scan. The
   fraction rule scales with model size; the absolute floor keeps small models
   from ever tripping it. Measured trigger: a query whose rarest trigram
   matches every element in an 8-element test model (floor patched to 2 to
   make the model-size math exercise the branch without an 8-element-scale
   model needing a real 10k threshold).
2. **`_trigrams_of` stored as sorted tuples of canonicalized trigrams (was
   `frozenset[str]`).** Root-cause memory analysis of the ~1 GB figure showed
   the frozenset container overhead (~730 B/element vs ~208 B/element for a
   tuple) was real but not dominant — the bigger, previously invisible cost
   was that `_element_trigrams`'s `s[i:i+3]` slicing allocates a brand-new
   `str` object per trigram occurrence, per element (~8M small-string copies
   at 500k, invisible to `sys.getsizeof` on the container because Python's
   small-string interning does not dedupe runtime slices). Fix: every trigram
   is canonicalized at creation, collapsing all per-element slice copies of
   the same 3-char sequence to one canonical string object (only ~1,100
   distinct trigrams exist over lowercase alnum text), and `_trigrams_of`
   stores `tuple(sorted(new))` instead of a `frozenset` (~4x smaller
   container, and deterministic so `verify_consistent()` needs no change).
   `_update_trigrams` derives the old set for diffing via
   `frozenset(self._trigrams_of.get(element_id) or ())`.

   **Canonicalization mechanism (revised in review):** the first
   implementation used `sys.intern`, rejected in review because interned
   strings persist in CPython's global intern table for the life of the
   process (verified empirically on this repo's 3.14) — in a long-running
   multi-project server (`SessionRegistry` creating/evicting sessions over
   weeks of uptime, property text being arbitrary user input) the interned
   trigram universe of every project ever loaded would accrue monotonically
   and survive project eviction/deletion, silently losing the previous
   behavior where trigram strings became GC-eligible once unreferenced.
   Replaced with a per-IndexSet canonical table (`_canon_trigrams:
   dict[str, str]`; `trigs.add(self._canon_trigrams.setdefault(t, t))`): the
   same deduplication win with model-scoped lifetime — the table dies with
   the IndexSet. It is a cache, not an index: `rebuild()` does not clear it
   (stale entries remain valid canonical mappings, like the `_key_specs`-style
   caches) and `verify_consistent()` does not compare it (fresh instances
   would legitimately differ). Never pruned on removal — entries are 3-char
   strings, negligible next to the postings they canonicalize.

## Results

### Baseline (pre-index, main @ 2f0802c)

| probe row                       | 50k (ms) | 500k (ms) |
|---------------------------------|----------|-----------|
| fuzzy search, selective         | 45.4     | 406.4     |
| fuzzy search, degenerate        | 77.2     | 652.2     |
| fuzzy search, short fallback    | 73.6     | 607.8     |

### After (feat/search-index @ 8606d0e)

| probe row                       | 50k (ms) | 500k (ms) |
|---------------------------------|----------|-----------|
| fuzzy search, selective         | ~5       | ~5        |
| fuzzy search, degenerate        | ~120     | ~2100     |
| fuzzy search, short fallback    | ~43      | ~450      |

Index: 1104 trigrams, 7,994,710 posting entries, ~1002 MB at 500k (1100
trigrams, 798,567 posting entries, ~100 MB at 50k).

Upload+install: 14.7 s -> 21.8 s at 500k (index build cost). The before figure
is a fresh same-session re-measurement at the pre-index commit (9ce3327, the
Task 1/Task 2 boundary) via a throwaway worktree, since no 500k upload number
for this branch was captured before the index landed; this machine runs
noticeably faster right now than the 27.6 s figure recorded for the same
probe on an unrelated branch earlier the same day, so an apples-to-apples
same-session comparison was used instead of that number.

Numbers above are the mean of 2-3 repeated runs each, discounting one early
500k run that looked like a cold-process/GC outlier (upload 46.6 s, degenerate
6.7 s) — later runs clustered tightly (upload 20.8-23.4 s, degenerate
2.0-2.25 s). Even after discounting that outlier, selective queries land
exactly on target (single-digit ms, ~50-80x faster than the scan at 500k).
Degenerate and short-fallback did **not** land at "≈ baseline" as hoped:
against a fresh pre-index re-measurement taken in the same session (500k:
selective 253.7 ms, degenerate 375.4 ms, short 364.5 ms — all lower than the
original baseline row above, reflecting this session's faster machine/load),
the degenerate query is ~5.6x slower with the index (375 ms -> ~2.1 s) and the
short-query fallback — an unchanged code path — is ~25% slower (365 ms ->
~450 ms). Both are consistent with one cause: the ~1 GB of extra live Python
objects (8M posting-set entries) increases GC/allocator overhead for every
request that scans the full model, not just ones that touch the index. This
contradicts the design's "same asymptote, no regression" framing for the
degenerate case and is flagged for the branch review; it does not block this
slice's stated scope (selective-query acceleration) and no code changes were
made here — measurement only.

### After fix wave (commit 44ba981)

Fix wave: (1) a scan-fallback threshold in `search_candidates` (degenerate
queries now return `None` and the route scans instead of intersecting
near-whole-model posting sets); (2) `_trigrams_of` stores sorted tuples of
canonicalized trigrams instead of frozensets of per-element slice copies
(measured with `sys.intern`; later revised in review to a per-IndexSet
canonical table — identical memory characteristics for a single model's
lifetime, so these numbers stand). See "Deltas during implementation" above.

| probe row                       | 50k (ms) | 500k (ms) |
|---------------------------------|----------|-----------|
| fuzzy search, selective         | 5.1      | 5.6       |
| fuzzy search, degenerate        | 42.3     | 393.7     |
| fuzzy search, short fallback    | 41.3     | 362.8     |

Index: 1104 trigrams, 7,994,710 posting entries, ~473 MB at 500k (1100
trigrams, 798,567 posting entries, ~48 MB at 50k) — down from ~1002 MB / ~100
MB before the fix wave, roughly a 53% drop in the reported container figure.
The `sys.getsizeof`-based probe formula only ever measured `search_postings`
and `_trigrams_of` container/entry overhead — it never counted the trigram
*string* objects themselves (they live outside those two containers'
`getsizeof`). Interning collapsed ~8M per-element slice copies at 500k down to
~1,100 canonical string objects process-wide, so the true memory saving is
substantially larger than the reported container delta; this fix removes real
resident memory that the probe's formula was always blind to, honestly
reported here as a known probe limitation rather than adjusting the formula.

Upload+install at 500k: 20.4 s (previously 20.8-23.4 s clustered runs) — no
meaningful change expected or observed; the fix wave does not touch the
upload/build path's asymptotic cost, only the reverse-map representation.

Degenerate (393.7 ms) and short-fallback (362.8 ms) at 500k now land close to
the fresh pre-index scan baseline from the same investigation (375.4 ms /
364.5 ms) — the "same asymptote, no regression" property the original design
intended is restored: degenerate went from ~5.6x slower than the scan to
roughly at parity, and short-fallback's ~25% regression (attributed to
GC/allocator pressure from ~1 GB of live posting objects) is gone now that the
live object count is reduced. Selective queries are unaffected and remain
single-digit ms at both scales (5.1 ms / 5.6 ms), confirming the fallback
threshold and the tuple representation change do not touch the accelerated
path.
