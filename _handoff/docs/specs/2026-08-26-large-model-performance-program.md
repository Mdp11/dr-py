# Large-model performance program — design

Production scale: ~300k elements / ~400k relationships, ~200 MB snapshot. All numbers
below were measured on 2026-08-26 on `examples/generate_large_model.py --scale 320`
(320 640 elements / 238 720 relationships; 138 MiB compact, **212 MiB** in the indented
snapshot format the store writes), Python 3.14, WSL2. Fixture ids are 8 chars
(`e_000001`); production ids are 36-char uuid7 strings, so every per-character cost below
is *worse* in production.

## Measurements (baseline, `main` @ 17024a3)

| Phase | Time | Memory |
|---|---|---|
| `json.loads` of the 212 MiB indented snapshot | 2.9 s (2.0 s compact) | +750 MB object graph |
| `build_model_from_dicts` incl. `IndexSet.rebuild()` | **30.0 s** | **+1.78 GB** |
| … same with the trigram search index disabled | **7.5 s** | **+0.29 GB** |
| full validation (`Scope.all()`, 6 validators) | ~12 s (background sweep) | — |
| `iter_model_json` snapshot serialize | 3.8 s → 212 MiB | gzip-6: 10 MiB (+1.3 s) |
| `GET /model/elements?q=sensor` scan vs index | 620 ms vs 11 ms | — |
| `{eid: i for i, eid in enumerate(model.elements)}` | 96 ms | (×350 sweep chunks = 34 s) |

Trigram index at 320k: 4 958 distinct trigrams, **29.5M posting-set entries** (~92 per
element; production uuid ids add ~28 more each).

## Program (one plan each, chained by handoff; BACKLOG ids assigned in plan 1)

1. **K-20 — deferred, session-only search index** (this spec's design section). Cold open
   ~35 s → ~10 s; every `rebuild()`-calling path (rebind preview/commit, `/metamodel/diff`,
   apply-cr per CR, history reconstruction) gets 3–4× cheaper for free.
2. **K-6 — journal-only history diff.** `GET /commits/{rev}/diff` reconstructs the whole
   model twice (`api/commit_diff.py:464-465`): ~70 s + ~5 GB transient per click today.
   Persist the touched entities' full *before* state on the commit row at commit time;
   render the diff from the journal like the artifact half already does.
3. **K-21 — compressed, compact snapshots.** Store `.json.gz` (compact JSON), read path
   branches on key/encoding; 212 MiB → ~10 MiB per hydration/eviction/periodic snapshot.
   Also move the every-200-commits synchronous snapshot out of the commit's critical section
   if measurements still justify it after compression.
4. **K-22 — uniqueness `position` map.** `validators/uniqueness.py:56` builds a 300k dict
   per scoped run under `write_mutex`; maintain an insertion-position index instead.
5. **K-23 — replay hot path.** `Model.set_property`/`delete_property` copy the effective
   property list + build a name set per write (`core/model/model.py:82-85`); `_check_patch_keys`
   likewise; add a cached `frozenset` accessor on `Metamodel`.
6. **K-24 — untyped navigation scope sort.** `core/navigation/evaluate.py:244-245` sorts all
   element ids on the first table request after every commit.
7. **K-25 — `GET /model/relationships` is unpaged** (`routes/relationships.py:19`); no app
   caller — page it or delete it.

## K-20 design — deferred, session-only search index

### Problem

`IndexSet.rebuild()` builds `search_postings`/`_trigrams_of` inline: 75 % of build time,
85 % of index memory. `rebuild()` is called by the live-session bulk load (hydration,
`_install_model`) **and** by transient/derived models that never search: `build_rebind_view`
(`/metamodel/diff`), the rebind preview (twice, under `write_mutex`), the rebind commit (+
unwind), `apply_change_request` (per CR), `reconstruct_model_at` (history diff/model-at-rev),
the migration CLI.

### Design

1. **`rebuild()` no longer builds the search index.** It resets it (clear postings,
   `search_ready = False`) because bulk loaders populated the dicts behind the index's
   back. New keyword `rebuild(*, keep_search=True)` preserves the search structures
   untouched — valid exactly when the entity dicts are unchanged since the index was last
   consistent, i.e. the **metamodel-rebind** case (the searchable text — id, type name,
   string property values, `name_of` — does not depend on the metamodel). The four
   live-model rebind call sites pass it: `api/metamodel_ops.py:186`,
   `routes/commits.py:460`, `:595`, `:644`.
2. **`search_ready: bool`** on `IndexSet`. `True` on a fresh `IndexSet` (an empty model's
   empty index is complete — unit tests that build via the mutation hooks keep working
   unchanged). `search_candidates` returns `None` (scan fallback, already byte-identical)
   while `not search_ready`.
3. **Mutation hooks keep maintaining postings regardless of readiness.** That is what
   makes the chunked background build correct: an element created/edited before the
   builder reaches it already has its `_trigrams_of` entry and is skipped; a deleted one is
   absent from `model.elements` and skipped.
4. **Chunked build API:** `index_search_chunk(element_ids)` (index the ids present in the
   model and absent from `_trigrams_of`), `mark_search_ready()`, and the synchronous
   convenience `build_search_index()` (= chunk over all elements + mark ready) for tests,
   `verify_consistent`, the bench and sync mode.
5. **`api/search_index_build.py`** — a background builder shaped exactly like
   `validation_sweep.py`: snapshot `list(model.elements.keys())` without the mutex (GIL-atomic),
   then per `CHUNK_SIZE = 1000` ids take `session.write_mutex`, abort if
   `session.model is not model` or cancelled, `index_search_chunk(chunk)`; after the loop
   `mark_search_ready()` under the mutex. `SearchIndexProgress {total, done, running,
   cancel, error}` stored on `Session.search_index_build`. Setting
   `search_index_sync: bool = False` (`DATA_ROVER_SEARCH_INDEX_SYNC`), pinned `true` by the
   API conftest like `validation_sweep_sync`.
6. **Kick sites:** `hydration._hydrate_session` (after `start_validation_sweep`),
   `routes/model.py::_install_model`, and the deprecated `POST /model` / `PUT /model/snapshot`
   installers (test fixtures use them). Transient models never start one.
   `SessionRegistry.evict` cancels a running build (it never blocks eviction — the
   snapshot does not depend on it). `set_model` aborts it by identity.
7. `verify_consistent()` builds the fresh copy with `build_search_index()` only when the
   live index is ready; otherwise the two search structures are excluded from the
   comparison (a partial index has no "fresh" equivalent).
8. `GET /model/status` is unchanged: search degrades silently to the scan; nothing waits on
   the index.

### Non-goals (deliberately deferred)

- Shrinking the posting sets (sorted `array` of ordinals + overlay): memory stays ~1.5 GB
  for the *live* session; deferral alone wins the open time and every transient path.
  Revisit only if RSS on the production box is the binding constraint after K-21.
- Indexing fewer fields (e.g. dropping the id): measured 30.0 s → 28.3 s only.

## K-21 design — compressed, compact snapshots

### Problem

`hydration.write_snapshot` streams the **indented save-file format** (`serialize.iter_model_json`,
one `json.dumps` + re-indent per entity) to the store: 212 MiB at scale 320. That blob is
uploaded on every eviction and every 200th commit (`routes/ops.py::_maybe_periodic_snapshot`,
synchronously inside the commit's `write_mutex` section: 3.8 s serialize + the upload) and
downloaded + `json.loads`-ed (2.9 s) on every hydration. `GcsSnapshotStore.put` also joins the
chunks into one transient buffer before the upload, so the write holds the whole 212 MiB in
memory beside the live model.

Spike on the scale-170 fixture (`benchmarks/large.model.json`, 170k/127k; production is ~1.9×):

| Step | Time | Size |
|---|---|---|
| indented `iter_model_json` (today) | 1.90 s | 112.6 MiB |
| compact, one `json.dumps` per entity | 1.58 s | 73.4 MiB |
| compact, one `json.dumps` per **batch of 2000** entities (byte-identical) | **0.82 s** | 73.4 MiB |
| gzip level 1 / **3** / 6 / 9 of the compact bytes | 0.26 / **0.29** / 0.62 / 2.37 s | 6.7 / **5.8** / 4.9 / 4.5 MiB |
| `gzip.decompress` | ~0.2 s | — |
| `json.loads` compact | 1.84 s | — |

Two independent wins: the encoder (batching halves the writer — the C encoder amortizes per-call
overhead and the re-indent `str.replace` disappears) and the bytes (gzip level 3 is the knee:
level 6 doubles the time for 15 % fewer bytes). Projected at scale 320: ~1.6 s encode + ~0.55 s
gzip ≈ **2.1 s in the critical section, ~11 MiB on the wire** (vs 3.8 s + 212 MiB today), and
hydration's download+parse drops from 212 MiB / 2.9 s to 11 MiB / ~0.3 + 2.0 s.

### Design

1. **Compact writer.** `serialize.iter_model_json_compact(model)` yields the same document
   (`{"elements":[…],"relationships":[…]}`, same entity order, same key order, `ensure_ascii=False`,
   `allow_nan=False`) with `separators=(",", ":")`, encoding **`SNAPSHOT_BATCH` = 2000 entities per
   `json.dumps`** and stripping the list brackets — `"".join(...)` is byte-identical to
   `json.dumps(doc, separators=(",", ":"), ensure_ascii=False)` (pinned by a test). Same
   point-in-time semantics as `iter_model_json` (entity SETS snapshotted at start, entities read
   live). `/model/save` and `/model/download` keep the indented writer untouched — the save-file
   contract with the frontend is not a snapshot concern.
2. **Codec module `api/snapshot_codec.py`** — the ONE place that knows the blob format:
   `encode_snapshot(model) -> Iterator[bytes]` (compact writer → `zlib.compressobj(level=3,
   wbits=31)`, i.e. a standard gzip member, streamed batch by batch — peak extra memory is one
   batch plus the deflate window) and `decode_snapshot(blob: bytes) -> Any` (**sniffs the gzip
   magic `1f 8b`** → `gzip.decompress` → `json.loads`; anything else → `json.loads` as-is).
   `SNAPSHOT_GZIP_LEVEL = 3` is a module constant, not a setting.
3. **Key naming.** `storage.snapshot_key` → `projects/{project_id}/snapshots/{rev}.json.gz`. The
   suffix documents intent only; **the decoder branches on the bytes, never on the key**, so an
   old `.json` row, a `.json.gz` row, and a test that puts plain JSON under either key all load.
   No `encoding` column on `Snapshot`, no migration, no blob rewrite, no backfill.
4. **Wiring.** `hydration.write_snapshot` → `encode_snapshot`; `_hydrate_session` and
   `reconstruct_model_at` → `decode_snapshot`. `HydrationProgress.phase` vocabulary is unchanged
   (`parse` covers decompress + loads). `GcsSnapshotStore.put`'s transient buffer becomes the
   compressed size. `scripts/bench.py::bench_serialize` gains a line for the snapshot codec so
   the committed bench covers the production write path.
5. **Critical section — a measured gate, then a background job.** After 1–4 the plan measures
   `write_snapshot` at scale 320 inside the real app. Prediction: ~2 s, which still stalls the
   200th commit. If the in-mutex time is **> 1.0 s**, the periodic snapshot moves to a daemon
   thread (`api/snapshot_job.py`, the `validation_sweep` / `search_index_build` precedent):
   `_maybe_periodic_snapshot` schedules instead of writing; the job takes `session.write_mutex`
   itself, checks `get_registry().peek(project_id) is session` (evicted / discarded → return
   without writing — this is what keeps a deleted project from getting an FK-violating row),
   snapshots at the rev CURRENT when it holds the mutex (not the triggering rev — any rev ≥ the
   trigger bounds the replay tail equally), and logs-and-drops on failure (the existing
   "commit is durable, hydration will rebuild" stance). One job per session at a time
   (`session.snapshot_job` running → the trigger is skipped; the next multiple retries). A
   `Settings.snapshot_sync` seam (pinned `true` by the API conftest, like the other two) runs it
   inline so every existing periodic-snapshot test keeps its assertions. The three snapshots
   that are correctness rather than bounding — the rebind-forced one in `POST /commits`, the
   evict hook, `persist_baseline` — stay synchronous. What this buys: the triggering commit
   returns without the ~2 s; what it does not: a write (or `GET /model/issues`) that lands inside
   that window still waits on the mutex, exactly as it does today.
   If the measurement comes in ≤ 1.0 s the job is skipped and the number recorded in the BACKLOG.

### Non-goals (deliberately deferred)

- **Serialize outside the mutex** by shallow-copying every properties dict under it
  (~0.4 s and +100–200 MB transient at 320k) — the upgrade path if the background job's mutex
  hold proves to contend in practice; not worth the memory spike on a prediction.
- **zstd** (`compression.zstd` is in this Python 3.14 build, 1.5.7): ~4× faster than gzip-3 at
  a similar ratio, i.e. ~0.4 s per write at scale 320. gzip is the spec's proposal, is in every
  interpreter, and the encoder is the larger cost; a second magic branch in `decode_snapshot`
  is all it would take later.
- **Snapshot blob GC** (orphans from `clear_history`, and now the old `.json` blob a baseline
  reset no longer overwrites): unchanged, already recorded as out of scope in `content.py`.
- **A byte cap on `Commit.entity_states`** (the K-6 review note): not a snapshot concern;
  carried to the K-22 handoff.

## K-22 design — maintained element insertion-order index

### Problem

`UniquenessValidator.validate_global` needs, for every duplicate group it reports, the group's
*primary* — the member that comes first in `model.elements` insertion order — and, on a full run,
the groups themselves in primary order. A dict exposes its insertion order only by iteration, so
the validator builds `position = {eid: i for i, eid in enumerate(model.elements)}`. That build is
already lazy (only when the scope touches a duplicate group) and already at most once per run —
and is still the dominant cost of the background sweep, because the sweep is ~160 element
chunks of 2000 and a model with even a few hundred sporadic duplicates has one in most chunks.

Spike at scale 320 (`examples/generate_large_model.py --scale 320`; the generator avoids
duplicates by construction, so 231 duplicate groups were injected by copying the key of a
same-type, same-owner predecessor onto every 1000th element — 121 of the 161 element chunks
then touch a group). Prototype = the design below installed by monkeypatch:

| Measure | Today | Maintained index |
|---|---|---|
| position map build (per run that needs it) | **79 ms, 17.1 MiB** transient | — |
| element half of the sweep (161 chunks; relationship chunks never touch the map) | **17.10 s**, median 126 ms/chunk | **5.55 s**, median 33 ms/chunk |
| `UniquenessValidator` full-scope run (`POST /model/validate`) | 185 ms | 97 ms (the rest is the pipeline's per-entity iteration) |
| `create_element` / `delete_element` (20k each, µs/op) | 42.8 / 16.8 | 48.2 / 18.7 — run-to-run noise; the index's own work is one dict insert / one dict pop |
| `rebuild()` | 3.23 s | 3.56 s (79 ms of it is the `enumerate`) |
| resident memory | — | +15.9 MiB (dict + int objects at 320k; ~1 % of the build) |

Every `POST /commits` whose dirty set reaches a duplicate group pays the same 79 ms + 17 MiB
churn under `write_mutex` today; under the index it pays one `min()` over the group.

The owner named two candidates. **Hoisting the map onto the validator for a sweep's lifetime**
(`MetamodelMemo`-style) was rejected without a full spike: the pipeline is built fresh per
request by design ("one pipeline per request/thread"), so every commit would still pay the whole
build; commits interleave with the sweep between chunks, so a hoisted map needs an invalidation
key the core does not have (`Model` carries no mutation counter, and `len(elements)` is not one —
delete + create keeps it) and a stale map is a `KeyError` on a just-created element; and the
17 MiB transient churn per build stays. **Maintaining the order in `IndexSet`** (the
`roots_order` precedent) removes the cost from both the sweep and the commit path for one dict
insert per create and one pop per delete, and property writes — the mutation that actually
changes uniqueness groups — cost nothing, because an element's position in `model.elements`
never moves.

### Design

1. **`IndexSet.element_order: dict[str, int]`** — element id → monotonic insertion sequence
   number, plus a private `_next_order` counter. **Invariant:**
   `sorted(model.elements, key=element_order.__getitem__) == list(model.elements)`. It holds
   because a dict's iteration order IS insertion order, deletion never reorders the survivors,
   and a deleted id re-inserted (`restore_element`) lands at the end of the dict and gets a
   fresh, larger number. Maintained by the two element hooks only: `on_element_created` assigns
   `_next_order` and increments it; `on_element_deleted` pops the id. `rebuild()` re-derives it
   as `{eid: i for i, eid in enumerate(model.elements)}` and sets `_next_order = len(...)` —
   under `keep_search=True` too (the order is metamodel-independent and 79 ms). Nothing on the
   property/relationship hooks: a rekey moves an element between uniqueness groups, never
   within `model.elements`. The accessor convention holds — the dict is a live internal view.
2. **Validator reads the index** instead of building a map. Scoped branch:
   `primary = min(indexes.uniq_groups[key], key=order.__getitem__)` — O(group), no sort. Full
   branch: `sorted(duplicate_keys, key=min over the group)`, then each group
   `sorted(..., key=order.__getitem__)`. Same primary, same report order, byte-identical
   issues — pinned by a test that compares the two branches' output on a model whose primary
   is not the lexically-first id. `dirty.py`'s group widening is untouched.
3. **`verify_consistent` checks the invariant, not the numbers.** A maintained index carries
   sparse monotonic numbers, a fresh rebuild dense ones, so comparing the dicts would be a
   false mismatch; the helper asserts the sorted-order equality above (and the key set) instead.
4. **Restore semantics unchanged and now pinned:** deleting a group's primary and restoring it
   under the same id makes it the LAST member — it was already so (the dict re-insert), and a
   test says so explicitly, because an undo that silently flipped a primary would be a
   surprising diff.

### Non-goals (deliberately deferred)

- **Folding the sequence number into `uniq_groups` (`dict[UniqKey, dict[str, int]]`)** — saves
  roughly the separate dict's ~3 MiB of the 16, but changes a public structure's type for three
  consumers (`dirty.py`, `verify_consistent`, tests) and threads the ordering concern through
  `_add_to_group`/`_rekey`/`_remove_from_group`. Not worth 3 MiB.
- **A sequence number on `Element`** — a pydantic field would leak into every save file and
  snapshot.
- **The other 33 ms per element chunk** (the five remaining validators, the pipeline's per-entity
  dispatch) — not this item; K-23 owns the property-write hot path next.

## K-23 design — property-write hot path

### Problem

`Model.set_property`/`delete_property` are the per-op-property cost of every commit and of the
hydration replay tail (≤200 commits of `restore_*` + `set_property`). Each write does four
things: (1) `list(effective_*_properties)` + `{p.name for p in defs}` for the unknown-key guard
(`routes/ops.py::_check_patch_keys` repeats it per patch), (2) reference-index diff, (3)
uniqueness rekey + roots reposition, (4) `on_properties_changed` → `_element_trigrams`, which
re-derives the WHOLE element's trigram set (id, type, every string property) and re-sorts it
into `_trigrams_of` — for one changed value. The owner's item named (1); the spike had to say
which of the four actually dominates before anything was designed.

Spike at scale 320 (`examples/generate_large_model.py --scale 320`, bulk-loaded through
`build_model_from_dicts`; each cost stubbed in turn by monkeypatch, then the design below
installed the same way). "Warm" = the element already has a search-index entry (a live session
after the chunked build); "cold" = it does not (`search_ready=False`, the replay tail's case —
the hook then indexes the whole element on first touch, work the chunked build would do anyway).

| Measure | Today | Prototype |
|---|---|---|
| `set_property` of one ~60-char string on a warm element (18.8k ops) | **75.8 µs** | **38.6 µs** |
| … with the trigram work stubbed (the other three costs) / with no hooks at all | 11.6 / 5.3 µs | — |
| … each of the other costs stubbed alone: rekey / roots / refs / name set | −8.6 / −5.8 / −5.3 / −9.1 µs | — |
| first touch of a **cold** element (`search_ready=False`) | **129.8 µs** | **9.4 µs** (deferred to the build) |
| restore-style replay: `restore_element` + one `set_property` per property (4k elements, 48k writes) | 54.5 µs/write | 30.4 µs/write |
| 200-batch tail × 10 `update_element` × 3 keys via `_apply_batch(restore=True)`, cold / warm | 736 / 409 ms | 153 / 178 ms |
| `_check_patch_keys` (3-key patch on a Person, 11 effective properties) | 2.49 µs | 0.31 µs |
| whole-element `_element_trigrams` (103 trigrams) / `tuple(sorted(set))` of it | 30.0 / 5.3 µs | — |

So (4) is ~85 % of a warm write and ~95 % of a cold one; (1) is 2.5 µs per check (paid twice per
op property: once in `_check_patch_keys`, once at the boundary); (2)+(3) together are ~6 µs.
Absolute stakes are modest — a 6 000-write replay tail is 0.74 s of a ~10 s cold open, a 50-property
commit ~4 ms under `write_mutex` — which is why the design stays small: three independent legs,
each O(changed value), none touching the bulk path.

The prototype's postings and `_trigrams_of` were checked against a full re-derivation for 3 000
elements after a mixed edit sequence (renames, deletes, shared trigrams between fields, list
values, sub-3-char values, same-value rewrites): 0 differences, and `verify_consistent` passes
at 320k afterwards.

### Design

1. **Cached property-name sets on `Metamodel`** (the owner's ask). `_Caches` gains
   `effective_element_prop_names` / `effective_relationship_prop_names: dict[str, frozenset[str]]`,
   derived from the effective-property lists it already builds; `Metamodel.effective_element_property_names(name)`
   / `effective_relationship_property_names(name)` return the shared frozenset (an empty one for an
   unknown type). `set_property`, `delete_property` and `_check_patch_keys` test membership on it —
   no list copy, no set build per write. Immutability holds: the cache is built lazily with the rest
   and reset by `model_copy`.
2. **A single-property hook, `IndexSet.on_property_changed(entity, prop, old_value)`**, called by
   `set_property`/`delete_property` — they have the prior value right before the wholesale replace
   (the API's inverse patches alias it; the value is never mutated). Refs, rekey and roots run as
   before; the trigram half is a **diff of the changed value's text**: additions are the new value's
   trigrams not already in the element's set; a removal candidate (in the old text, not the new) is
   kept when any OTHER searchable field (id, type name, the other string properties) still contains
   it — one C-level substring test per candidate — and the sorted `_trigrams_of` tuple is patched
   with `bisect` instead of re-sorted. Exact by construction when both values are plain strings (or
   absent) and no `name`-keyed property holds a list (`name_of` reads inside such a list — text the
   per-value diff never sees); every other case, and an element without an entry yet, falls back
   to the whole-element re-derivation. `on_properties_changed(entity)` (plural) stays as the
   documented obligation for code writing `entity.properties` directly. `verify_consistent` already
   compares the search structures with a fresh build, so the diff is checked by every test that
   ends in it.
3. **Cold elements are the chunked build's, not the hooks'.** `_trigrams_of` changes from "no entry
   when the set is empty" to **an entry for every indexed element (an empty tuple when its text has
   no trigram)** — `on_element_created`, `index_search_chunk` and the property hooks always store
   one, `on_element_deleted` pops it — so *absence* means exactly "bulk-loaded and not yet reached
   by the build". While `search_ready` is False the property hooks leave such an element alone;
   `index_search_chunk` indexes its CURRENT text when it gets there (it already skips ids that have
   an entry and ids no longer in the model, so the interleaving still converges on a full build's
   result — the K-20 argument, with "regardless of readiness" narrowed to "for every element that
   has an entry"). A hook-created element has an entry from birth and is diffed as before; a
   transient model that never builds (previews, apply-cr copies) stays on the scan either way.
   This is the leg that makes the replay tail cheap (first touch 130 → 9 µs): the tail runs before
   `start_search_index_build` snapshots its id list, so every element it touches is in that list.

### Non-goals (deliberately deferred)

- **A bulk `restore_element(..., properties=...)`** for the replay tail — per-property hooks are
  the contract every property-driven index relies on; leg 3 removes the cost instead.
- **Diffing refs / rekey / roots per property** — ≤ 9 µs each; `_rekey`'s `_frozen(properties)`
  for keyless types is the largest and still under the noise of the trigram work.
- **The `zip(s, s[1:], s[2:])` trigram idiom** — measured no faster than the slice loop (5.6 vs
  5.3 µs per 60-char field); `_element_trigrams` and the chunked build are untouched.
- **Per-field trigram storage** (which would make removals trivially exact) — multiplies the
  index's dominant memory cost; the substring check buys the same exactness for a few µs.
- **Bypassing the hooks under `search_ready=False` entirely** — hook-created elements must be
  indexed by the hooks (the build's id snapshot predates them); ownership is per element, not global.
- The remaining ~11 µs floor (guards, dict write, refs/rekey/roots) and the applier's own ~15 µs
  per op — not this item; K-24 (untyped navigation scope sort) is next.

## K-24 design — untyped navigation scope sort

### Problem

`core/navigation/evaluate.py::_scope_ids` is the row source of every table with a `ScopeRows`
source and the start set of every navigation whose `start` is a `Scope`. Its untyped branch is
`set(model.elements.keys())`, then a criteria filter that re-looks each id up in `model.elements`
and calls `_matches_criteria` (an `all(<generator>)` over `scope.criteria`, even when that list is
empty), then `sorted()` over the survivors. `TableOrderCache` is rev-keyed, so this is paid once per
table per commit (the first page after every commit, plus every export's completeness probe) —
not per page — but it is paid on a 300k-element model in full, under no cache, for the commonest
table shape there is ("every element, filtered by a criterion").

Spike at scale 320 (`examples/generate_large_model.py --scale 320`, 320,640 elements, bulk-loaded
through `build_model_from_dicts`; each part timed in isolation, best of three):

| Measure | Today | Prototype |
|---|---|---|
| `_scope_ids` untyped, no criteria | **465 ms** | **24 ms** |
| … its parts: `set(model.elements.keys())` / filter over the set (dict lookup + `all(())` per id) / `sorted()` of the hash-ordered survivors | 48 / 254 / 172 ms | — |
| `list(model.elements)` (insertion order, no sort) / `sorted(model.elements)` (presorted input) | 7 / 24 ms | — |
| filter over `model.elements.values()` with `_matches_criteria` / with the empty-criteria test inlined | 123 / 39 ms | — |
| `_scope_ids` untyped + one `exists` criterion | **762 ms** | **283 ms** |
| … the matcher alone over `values()`: `all(gen)` per element / plain loop over hoisted criteria / bare iteration floor | 374 / 283 / 21 ms | — |
| `_scope_ids` typed (`Person`, 51,200 el), no criteria: union of per-type sets / `sorted(union)` / total | 1.3 / 13 / 45 ms | ~14 ms |
| `sorted()` of 320k UUIDv7 strings: presorted / shuffled / iterated from a `set` | 7.5 / 131 / 165 ms | — |

Three facts fall out. (1) The `set` is pure loss: it costs 48 ms to build, forces a per-id dict
lookup in the filter, and — the largest single item — hands `sorted()` a hash-ordered input, so the
sort is a real O(n log n) (172 ms) where the dict's own insertion order would have been a presorted
run (24 ms): production ids come from `Uuid7Generator` (time-ordered, strictly increasing per
generator) and the importer/generator mint `e_000001`-style sequential ids, so `model.elements`
iterates in ascending id order on every model that was not hand-assembled. (2) `_matches_criteria`
with an EMPTY criteria list still costs ~0.27 µs per element in generator + `all` machinery — 85 ms
of pure overhead on the no-criteria table. (3) With a real criterion the matcher dominates
(~0.8 µs per criterion per element inside `_match_nav_criterion` → `match_element`); a plain loop
over a hoisted `criteria` list recovers a quarter of it, and the rest is the shared search matcher.

### Design

1. **The untyped branch walks `model.elements` directly.** No `set`, no per-id lookup: the
   candidates are `model.elements.values()` in dict (insertion) order, filtered in place, and the
   surviving ids are `sorted()` exactly as today. The sort stays — the result is byte-identical —
   but it now sees insertion order, which on ids minted in order is a single presorted run that
   Timsort finishes in O(n) comparisons; an arbitrary id assignment (a hand-written file, a
   `restore`d element re-inserted last) degrades to the O(n log n) the set already cost and never
   worse (131 vs 165 ms on shuffled UUIDv7s).
2. **An empty criteria list short-circuits.** Both branches return `sorted(<candidates>)` outright
   when `scope.criteria` is empty — `sorted(model.elements)` for the untyped scope — instead of
   calling the matcher per element to compute `all(())`.
3. **`_matches_criteria` / `_matches_filter` become plain loops** over the criteria list read once
   per call (early `return False`), replacing `all(<generator>)`. Same truth table, ~25 % less per
   criterion per element; the matcher they call is untouched.
4. **The typed branch keeps its union** (per-type sets are exact-type keyed, and `scope.types` may
   name a type and its own subtype, so the union is the dedup) and gains only leg 2 and a local
   `elements` binding for the filter; its sort input is hash-ordered either way and the union is
   1.3 ms.

Observable behaviour is unchanged: the returned list is the ascending-id list of matching elements,
as before, so table row order, navigation chain order and the stateless offset/limit paging that
relies on "depth-first over SORTED element ids" (the module docstring) are byte-identical. The
correctness check is differential — the new `_scope_ids` against today's derivation
(`sorted(i for i in set(...) if ...)`) over random scopes on a model whose insertion order is
deliberately NOT id order.

### Non-goals (deliberately deferred)

- **Returning insertion order instead of sorted ids** (dropping the sort). Decided against, not
  merely deferred: it would change untyped table/navigation row order visibly for every project
  whose ids are not insertion-ordered (hand-assembled or externally generated files; any element
  reinstated by undo/restore, which lands last), it would break the evaluator's stated "SORTED
  element ids" paging contract, and it buys 24 → 7 ms — nothing next to the 465 ms removed.
- **A maintained sorted-id index** (a `SortedList` of every id, like `roots_order`) — O(k) paging
  would be its only advantage, but every consumer materializes the whole list per request anyway,
  and it would add a mutation-hook cost and another ~O(n) resident structure for a sort that is
  already O(n) on a presorted input.
- **A per-rev cache of the untyped id list** — core is session-agnostic; `TableOrderCache` already
  bounds the cost to once per table per commit, and 24 ms does not justify a second cache layer.
- **The matcher's own cost** (`_match_nav_criterion` → `match_element`'s isinstance dispatch,
  ~0.8 µs per criterion per element) — shared with `/model/search`, which must stay byte-identical;
  a criterion-shaped fast path is a different item.
- **The evaluator's other sorts** (`sorted(members)` for a set expression, `_start_ids`' row
  elements) — sized by the result, not by the model.
- K-25 (`GET /model/relationships` is unpaged) is next and last in the program.

## K-25 design — delete the unpaged relationship lister

### Problem

`api/routes/relationships.py::list_relationships` (`GET /model/relationships`) is the last
unbounded read in the API. It materializes **every** relationship into the list, applies each
of its three optional filters as a separate full list scan, and converts the whole survivor
set to `RelationshipOut` — no `limit`, no `offset`, no cap. The BACKLOG entry's claim that the
`source_id`/`target_id` filters "are already served by `IndexSet.outgoing_ids`/`incoming_ids`"
is about the *index that exists*, not the route: the route uses neither.

Spike at scale 320 (`examples/generate_large_model.py --scale 320`, 320 640 elements /
238 720 relationships, bulk-loaded through `build_model_from_dicts`; end-to-end rows go
through the FastAPI `TestClient` on a seeded session, best of three):

| Measure | Today |
|---|---|
| `GET /model/relationships`, unfiltered, end to end | **2 423 ms**, 29 MiB response body |
| … `[RelationshipOut.from_core(r) for r in items]` alone | **2 112 ms**, +145 MiB transient |
| … `list(model.relationships.values())` / one filter scan (`type`) | 2.1 / 3.9 ms |
| … one filter scan (`source_id` / `target_id`) | 11.7 / 11.7 ms |
| `GET /model/relationships?type=SystemContainsComponent` (57 600 hits) | **334 ms**, 7 MiB body |
| `GET /model/relationships?source_id=` (1 hit) / `?target_id=` (3 hits) | 19.8 / 20.0 ms |
| `IndexSet.outgoing_ids(src)` / `incoming_ids(tgt)` + `sorted` | < 0.05 ms each, rows identical to the scan |
| `RelationshipOut.from_core` over a 100-row page | 0.5 ms |
| `GET /model/elements/{id}/relationships?limit=100` (paged today) | 3.2 ms |
| `POST /model/search` `target=relationship`, `limit=100` (paged today) | 71.5 ms, `total=238 720` |
| `GET /model/elements?limit=100` (the paging contract to mirror) | 4.3 ms |

Two facts fall out. (1) **The scan is not the cost — the pydantic materialization is**:
2 112 of the 2 423 ms and +145 MiB of transient objects on top of a 29 MiB body, from one
membership-authorized GET with no bound. Serving the filters from the adjacency index removes
11.7 ms of a 19.8 ms request; it does not touch the 2.4 s that makes the route a hazard.
(2) **Nothing calls it.** No Python test issues a GET against it (the three `tests/api`
references are the sibling POST/DELETE); `frontend/src/lib/api/relationships.ts::listRelationships`
is imported only by its own MSW-mocked unit test, which exercises the query-string builder
against a mock and never the server; no `scripts/`, README or e2e reference exists.

### Design

**Delete `GET /model/relationships`.** The route's whole capability is already served, paged,
by two endpoints the app actually calls:

1. `GET /model/elements/{id}/relationships?direction=out|in` — the `source_id`/`target_id`
   filters exactly, drawn from `IndexSet.outgoing_ids`/`incoming_ids`, `limit`/`offset` paged,
   `total` before paging. The spike confirms the index-served id sets equal the list scans.
2. `POST /model/search` with `target: "relationship"` — the whole-model listing including the
   `type` filter (an `EntityTypeCriterion`), paged with a `total`, plus property, name/id and
   endpoint-type criteria the deleted route never had.

So the change is a removal, not a port: the handler and its `RelationshipOut` return annotation
go, `POST` and `DELETE /model/relationships/{id}` (the documented legacy mutation pair, exercised
by `tests/api`) stay mounted and untouched. FastAPI answers the now-method-less `GET` with 405,
which one test pins so a future unpaged lister is not re-added by reflex. On the client,
`listRelationships` and the now-unreferenced `RelationshipListSchema` go with it, along with the
two `frontend/src/lib/api/__tests__/relationships.test.ts` cases that cover only the query-string
builder; `createRelationship`/`deleteRelationship` and the `api` barrel entry stay.

Paging it instead was the alternative, and it is rejected on the evidence rather than on effort:
a paged `RelationshipPage` lister would be a **third** relationship-listing surface with no
caller, whose `type` filter would still scan (there is no relationship-by-type index) and whose
other two filters duplicate endpoint 1 with a worse contract (a flat list rather than an
element's incident set). CLAUDE.md's "self-contained app with no external consumers" is what
makes deleting a REST verb the cheaper of the two.

### Non-goals (deliberately deferred)

- **A `relationships_by_type` index.** The `type` filter's replacement (`POST /model/search`)
  scans, at 3.9 ms per pass over 238 720 relationships — three orders below the cost being
  removed, and a fifth per-type structure on `IndexSet` is not worth it for one caller.
- **Deleting `POST`/`DELETE /model/relationships` and their client wrappers.** They are the
  legacy direct-mutation pair CLAUDE.md keeps for tests and scripts, they are bounded, and
  `tests/api/test_routes.py`, `test_ops_route.py` and `test_artifacts_routes.py` call them.
  That the client wrappers are likewise test-only is a separate (non-performance) cleanup.
- **A global cap on unbounded reads.** `deps.read_capped_body` bounds request bodies; there is
  no response-side equivalent. Two O(model) reads survive this removal on purpose: `GET /model`
  and `PUT /model/snapshot` (both carry `deprecated=True` and a docstring naming the paged
  endpoints that supersede them) and `GET /model/download` (the streamed export contract,
  `iter_model_json`). `GET /model/relationships` is the one that advertised itself as a
  supported read while behaving like neither.
- **The remaining per-request `RelationshipOut` cost** (~8.8 µs per row) — bounded by
  `MAX_PAGE_LIMIT` (500) everywhere it is still paid.
- Nothing follows: K-25 is the last item in the program.
