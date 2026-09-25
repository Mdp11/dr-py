# Replica and frontend seam (sub-project B) — design

The second piece of the client-engine program (`architecture/program.md`): the browser opens a
full replica of the project in an engine worker inside the sandbox origin, follows the
server's commits by delta, and serves the model read surfaces and the staged edits from it.
The current server stays the oracle and the fallback (MR-1).

Contracts this design implements: CT-1 (snapshot v2, server side), CT-2 (delta, its three
carriers), CT-3 (digest, server side and the background check), CT-4 (engine interface),
CT-5 (working copy, model family) in `architecture/contracts.md`; the Open, Read, Edit,
Commit, Peer commit and Rebind flows of `architecture/system.md`.

## Goals

- The current server speaks the sync protocol: exact rollback, v2 snapshots, a state digest,
  `prev_rev`, and the snapshot descriptor, blob and tail routes.
- `engine/src/service/`: the CT-4 dispatcher, a cooperative scheduler, the read surfaces.
- `sandbox/`: the sandbox page and the engine worker, under the CN-17 policy.
- `frontend/src/lib/engine/`: frame, engine client, replica sync, snapshot cache, surface
  switches, shadow comparison.
- Five read surfaces served by the engine by default: elements, fuzzy search, incident
  relationships, containment tree, summary counts.
- `model.svelte.ts` forks: an engine-backed store whose staged edits live in the engine's
  working copy, and today's store frozen as the server-mode fallback.
- `K-30` and `K-31` fixed; `K-32` reduced to a watch item.

## Non-goals

- Criteria search (`POST /model/search`), navigation, tables, validators, rules, issues,
  compare / apply-CR, save / download: sub-project C. `POST /commits/preview`,
  `GET /model/issues` and `POST /model/validate` stay server calls.
- Neighborhoods: `getNeighborhood` has no production caller and no graph view exists; it moves
  when a caller exists.
- The artifact family of the working copy (C). Scripts and `SharedArrayBuffer` use (D).
- Production hosting of the two origins, signed URLs, head rows (F).
- `committed: true` on reads (CT-5.4): nothing in B needs a committed page, tree or search.
- Optimizing anything that meets its budget.

## Decisions taken with the owner (2026-09-19)

1. The store forks. Engine mode stages in the engine; the legacy store stays behind the switch
   until F. Built last, after a plain transport swap.
2. The workspace blocks on the replica. No hybrid warm-up from the server.
3. `system.md` rule 4 binds evaluation and background work. An atomic transition — stage,
   unstage, rebase, delta apply — has its own budget: ≤ 100 ms at M for up to 1,000 ops, order
   repair included *(budget)*.
4. Neighborhoods are dropped from B.

## 1. Server — exact state

### Exact rollback (`K-30`)

- `routes/ops.py::_rollback(model, res)` restores from the batch's first-touch before-images
  instead of replaying inverse ops, in the order of the engine's `rewind`
  (`engine/src/ops/rewind.ts`): relationships out, elements out, elements in, relationships
  in. An entity that outlived the batch — it still carries its image's sequence number — gets
  its properties and `rev` back where it is; anything else under a touched id is removed (an
  entity the batch created, or created again under an old id); an entity the batch deleted is
  re-inserted with its old `rev`.
- `Model` gains the committed-state methods the engine already has (`overwrite`,
  `insert_element`, `insert_relationship`): they check no type, take `rev` as given and fire
  the index hooks. They are the only way a before-image enters the model (RC-8).
- Place in state order: `_BatchResult` notes, with each before-image, the entity's insertion
  sequence number — `IndexSet.element_order`, and a new twin `relationship_order` maintained
  at the same boundary. A re-inserted entity takes its old number back, and the two entity
  dicts are put back in sequence order once, at the end of a rollback that re-inserted
  anything. O(n), and only then; a rollback of updates and creates is O(touched).
- Every caller goes through `_rollback` — mid-batch failure, `POST /commits/preview`,
  `_CommitUnwind`, `/model/ops` and `/model/undo` failures, `POST /model/validate` with staged
  ops — so one change fixes them all. `_rollback` takes the `_BatchResult`, not its
  `inverse_units`.
- MR-3: the fix lands with a golden scenario that runs refused batches on the LIVE oracle
  model and asserts entity lines, index dump and digest unchanged; the recorder's deep copy
  (`tests/golden/model_steps.py`) goes. The engine already behaves this way.
- The order repair is measured at M before the plan is approved.

### Recreated entities (`K-31`)

- `_BatchResult` records the ids deleted and then created again within the batch
  (`recreated_element_ids`, `recreated_relationship_ids`; an id deleted once more leaves the
  list). The engine's `BatchResult` does the same.
- They travel as two lists beside `changed_*` and `deleted_*` on every delta carrier, and
  under a `recreated` key in `Commit.entity_states`. Separate lists, so the legacy store,
  which does not know them, is unaffected.
- A replica removes and appends exactly the ids named there. A changed entity that arrives
  under another type or other ends WITHOUT being named does not fit the replica: `diverged`.
  The type-or-ends heuristic of sub-project A is deleted; `ops_recreate` joins
  `engine/test/working/replica.golden.test.ts`.

### Digest and `prev_rev`

- `Session` holds the CT-3 digest. Every landed model batch updates it in O(batch): XOR out
  `h(id, before.rev)` for each before-image, XOR in `h(id, rev)` for each entity the batch
  left behind. `set_model`, `touch_model` and hydration mark it stale; the next reader
  recomputes it with `state_digest.model_digest`. An exact rollback needs no update.
- `commit_event`, `OpsResponse` / `CommitResponse` and the tail delta gain `prev_rev` (the
  session's `model_rev` before the bump), `state_digest` and `recreated_*`.
- `Commit` gains a nullable `state_digest` column (Alembic), written by all four journal
  writers through `_persist_commit`. `prev_rev` is not stored: journal rows are contiguous,
  and the tail route refuses a hole.
- `/model/ops` and `/model/undo` stay silent on the feed. A replica sees the `prev_rev` gap at
  the next delta and heals through the tail.

## 2. Server — snapshots and replica routes

- `hydration.write_snapshot`, the one funnel of every writer (periodic job, evict, rebind,
  baseline, importer), switches to `encode_snapshot_v2`. `metamodel_id` is read from
  `ModelRow` in the same DB session; a project without a row writes `""`. The header's
  `state_digest` is the session's.
- `Snapshot` gains a nullable `format` column (`"v2"`; `NULL` = v1). `decode_snapshot` keeps
  reading v1 (CT-1).
- Routes, under the project prefix, member-gated, read-only:
  - `GET /replica/snapshot` → `{rev, metamodel_id, state_digest, elements, relationships, url}`.
    It answers with the newest v2 snapshot from which head is reachable by a complete tail of
    at most 1,000 revisions; when there is none it writes one at head, synchronously, under
    `write_mutex`, and answers with that.
  - `GET /replica/snapshots/{rev}` → the stored blob, `application/gzip`, with
    `Content-Length`; never `Content-Encoding` (CN-11). It stands in for F's signed URL: the
    descriptor's `url` is all a client follows.
  - `GET /replica/tail?from_rev=N` → `{from_rev, head_rev, complete, deltas}` (CT-2), each
    delta rebuilt from its `Commit` row: `after` entities in `entity_states` order as
    `changed_*`, ids whose `after` is null as `deleted_*` (one created and deleted within the
    commit included, as on the feed), the `recreated` lists, the row's
    `state_digest`, `prev_rev` from the row before. `complete: false`, with no deltas, when a
    revision is missing, a row has no `entity_states` or no `state_digest`, a row is a rebind
    or a baseline marker, or more than 1,000 revisions separate `N` from head.
- `GET /metamodel` gains an `X-Metamodel-Id` response header (`""` without a row), so a
  client can pair the document with a descriptor.

## 3. Engine — the service (`engine/src/service/`)

"Host" keeps meaning the environment (worker entry, Node); the CT-4 dispatcher is the
*service*.

- `createService(port, deps)`. `port = {post(message, transfer?), onMessage(handler)}`;
  `deps = {yieldToHost(): Promise<void>, now(): number, inflate(chunks)}` — `engine/src` has
  no timers, no clock (RC-5) and no gzip: `inflate` maps an async iterable of gzip bytes to
  one of inflated bytes. A `MessagePort` in the worker, a direct pair in tests and in Node.
- Envelope per CT-4. Errors: `OpError` → its status; `ModelError` `key` → 404, `value` → 422;
  anything else → 500 with the message. A cancelled request answers nothing; the client
  rejects it with an `AbortError`.
- States `opening | ready | diverged`. A read that arrives in any state but `ready` is
  queued, not refused.
- **Scheduler.** One cooperative queue. A long task is a generator; the service runs it until
  `now()` shows 16 ms, awaits `yieldToHost()`, and serves queued requests between slices.
  Requests are taken in arrival order, so a read posted after a `stage` sees it. Transitions
  are atomic (decision 3).
- **Slicing (`K-32`).** `rebuildIndexes` and `verifyDigest` become step generators; their
  synchronous forms drain them, so sub-project A's callers, tests and bench are unchanged.
  `openSnapshot` yields between its 2,000-line batches. The digest check starts after `ready`
  and restarts when committed state changes under it.
- **Methods.**
  - Replica: `open {project_id, metamodel}`, then `chunk {bytes}` … `end` — the gzip bytes as
    the shell received them, in transferred buffers, read through `deps.inflate`;
    `applyDelta {delta, own?}` → `applied | duplicate | gap`;
    `applyTail {deltas}`; `close`.
  - Staging: `stage {ops}` → `{batch, changes, elements, relationships}` (the post-state of
    what it changed; ids only past 500 entities); `unstage {what}`; `staged`; `stagedDiff`
    (before / after pairs from the committed images); `conflicts`.
  - Reads: §4.
  - Context: `setViewPlacement {view_id, element_ids}`, `dropViewPlacement {view_id}`.
- **Working copy additions.** Coalescing: a property update merges into the staged update of
  the same entity, which keeps its place and its first before-image (the rule of today's
  `emit`). `adoptStaged(batches)`: replay staged op lists on a freshly opened replica, parking
  what no longer applies. With `own`, a delta that is a `duplicate` still runs the own-commit
  bookkeeping.
- **Events.** `replica {state, rev}`; `progress {task, done, total}` with tasks `parse`,
  `index`, `tail`, `verify`; `changed {rev, staged_version, element_ids, relationship_ids,
  deleted_element_ids, deleted_relationship_ids, structural}` after every transition.
  `structural` is what the store's `_structureRev` tracks today: an id map, a relationship
  change, a deletion, a new element.
- **Boundary.** `toWire` renders results in the JSON shapes `lib/api` validates: a `PyFloat`
  leaves as its number, a `bigint` as a number — the loss `JSON.parse` of a server response
  has today. Ops arrive as plain JSON and are read as the server reads them.

## 4. Engine — reads (`engine/src/read/`)

A port of `src/data_rover/api/routes/read.py`, rule for rule. Method names are the `lib/api`
function names (CT-4).

| Method | Rule |
|---|---|
| `getElement {id}` | 404 `No element with id 'x'` |
| `getElementsBatch {ids}`, `getTreeItemsBatch {ids}` | request order, duplicates kept, unknown ids omitted, more than 500 → 422 `too many ids: N (max 500)` |
| `listElementsPage {type?, limit, offset}` | state order, exact-type filter, `total` before paging |
| `listElementsPage {q, …}` | `_search_score` / `_name_score`; sorted by `(-score, id)`, ids by code point; lengths in code points; full scan, sliced (AD-13) |
| `listElementRelationships {id, direction, limit, offset}` | sorted by id, `both` counts a self-loop once, 404 for an unknown element |
| `listContainmentRoots`, `listExcludedRoots {view_id?}` | the maintained root order; the excluded pool drops the ids registered for the view, an unknown view drops none |
| `listContainmentChildren {id}` | first containment parent wins; sorted by `(displayName, id)` |
| tree item | `{id, type_name, display_name, child_count}` |
| `getModelSummary` | `model_rev`, counts, `elements_by_type` sorted by name; `issue_counts` and `undo_depth` are not the engine's |

- Limits are checked as the routes check them (1…500).
- `pyLower(s)` equals `str.lower()` on Python 3.14 without relying on the host's Unicode
  version: generated tables plus Python's final-sigma rule, held to an oracle fixture over
  every code point.
- Golden scenarios `read_*` call the real route functions over scripted models: paging, type
  filter, unicode and tie-break queries, self-loops, a view with placements, reads after
  churn. MR-3 freezes those route functions from the start of plan 3.

## 5. Sandbox (`sandbox/`)

- A static site built by Vite: `index.html`, `src/page.ts`, `src/engine-worker.ts`. DOM and
  WebWorker typings live here; `engine/src` stays free of both. Sub-project D adds the script
  workers. pixi tasks under the `frontend` feature, like the engine's.
- Headers (CN-14, CN-17): the CN-17 CSP, `Cross-Origin-Embedder-Policy: require-corp`,
  `Cross-Origin-Resource-Policy: cross-origin`. The app gains `Cross-Origin-Opener-Policy:
  same-origin` and COEP; the iframe carries `allow="cross-origin-isolated"`. The app loads no
  cross-origin subresource today (fonts are bundled).
- Dev and e2e: the app stays on `127.0.0.1:5173`; the sandbox is served on
  `localhost:5174` — another HOST on purpose, because cookies ignore ports and a second port
  on the app's host would be same-site with the login cookie. It is always built files
  (`vite build --watch` + `vite preview`), so development runs under the real policy. Both
  origins are build-time settings with those defaults. `process-compose.yaml` and
  `playwright.config.ts` gain the sandbox process.
- Handshake: the page posts `sandbox-ready {crossOriginIsolated}` to the app origin; the shell
  checks `origin` and `source`, then posts `connect` with one transferred `MessagePort`; the
  page accepts one `connect` from the app origin, hands the port to the engine worker and
  leaves the data path. `securitypolicyviolation` events are reported to the shell.
- The worker entry supplies what the engine cannot hold: `inflate` over
  `DecompressionStream('gzip')`, `yieldToHost`, `now`.

## 6. Shell (`frontend/src/lib/engine/`)

- `frame.ts` — the iframe and the handshake, one per tab (AD-16). A project switch replaces
  the worker. A re-bootstrap discards the old replica BEFORE opening the new one and carries
  only the staged op lists, so the heap never holds two replicas.
- `client.ts` — the CT-4 client: id correlation, `AbortSignal` → `{cancel}` → `AbortError`,
  event listeners, and an in-process transport that calls the service directly (tests).
- `sync.ts` — the replica's life. `realtime.svelte.ts` keeps the socket and hands over
  `commit` and `rebind` events and the reconnect `snapshot`.
  - Open: buffer feed deltas → `GET /replica/snapshot` → bytes from `cache.ts` or `url`,
    streamed to the engine as they arrive → `GET /metamodel`, paired by `X-Metamodel-Id`
    (a mismatch restarts) → tail → drain the buffer → `ready`.
  - Then: delta → `applyDelta`; `gap` → tail; an incomplete tail, `diverged` or a rebind →
    re-bootstrap; a reconnect `snapshot` ahead of the replica → tail (CN-9).
  - Re-bootstrap: three attempts with backoff, then a blocking banner with Reload.
  - Commit in flight: from `POST /commits` to its response, feed deltas are buffered; then
    everything is applied in `rev` order, the response in its place with `own = {batch ids
    sent, id_map}`, the echo dropping as a duplicate.
- `cache.ts` — IndexedDB, `[project_id, rev]` → the gzip bytes; the newest `rev` per project,
  an LRU byte cap across projects; every failure is swallowed (AD-10). A hit needs the
  descriptor's exact `rev`.
- Progress: the open journey gains `download`, `parse`, `index` and `tail` slices; the
  workspace unblocks when the server is ready AND the replica is `ready` (decision 2).
- Boot fallback: a frame that does not load, a handshake timeout or three failed opens flip
  every surface to `server` for this tab, with a dismissible notice — at boot only, never
  with anything staged in the engine. Missing cross-origin isolation is a warning in B.

## 7. Frontend seam

- `surfaces.ts` — `elements | search | relationships | tree | summary` → `engine | server`,
  and `staging` → `engine | legacy`. Defaults are compiled in; a `localStorage` override
  serves dev and e2e; read once at boot. `staging: engine` forces the five reads to `engine`.
- The migrated `lib/api` functions keep signature and schema and pick a side through
  `route(surface, engineCall, serverCall)`; engine results pass the same zod schema. Read
  options gain `signal?: AbortSignal`; `Sidebar/Search.svelte` uses it.
- `summary` in engine mode: counts and `elements_by_type` from the engine; `issue_counts`
  from `GET /model/issues`, as the store adopts them today.
- `tree`: the view store registers each loaded view's COMMITTED placed element ids with
  `setViewPlacement` — what the server route reads — so `ContainmentTree`'s overlay of staged
  view ops stays as it is and both sides answer the same question.
- `shadow.ts` (MR-2) — dev and e2e only, and only while nothing is staged: run both sides,
  deep-compare the parsed values, re-test once after the replica settles, then
  `console.error('[shadow] …')`. An e2e run fails on any such line.
- `boot()` starts `sync.open()` beside today's sequence. The rebind banner's Reload and
  `adoptReboundMetamodel()` re-bootstrap.

## 8. The forked store

- `model.svelte.ts` — the facade every importer keeps using, plus the shared half: summary,
  `rev`, issues, rules status, error, generation.
- `model-legacy.svelte.ts` — today's entity half, moved verbatim and frozen: caches,
  optimistic `emit`, the staged-delete guards, the revert journal, `applyDelta`,
  `remapCaches`. Its tests stay. Deleted in F.
- `model-engine.svelte.ts` — a view over the engine:
  - Reactive caches of what the UI asked for, filled by `ensure*` from the engine. No guards:
    every read is the working copy.
  - `changed` → re-read the cached ids in one batch, drop the deleted, bump `_structureRev`
    on `structural`, adopt `rev`.
  - `emit(op)` stays `void`: it appends to a synchronous mirror of the staged list — or
    coalesces into it, by the engine's rule — posts `stage`, and writes the returned
    post-state into the caches. A refusal removes the op and surfaces as a `ModelStoreError`.
  - The mirror and `stagedDiff` refresh when `staged_version` moves. `getStagedOps`,
    `getStagedOpsFor`, `getStagedDepth`, `getStagedDiff`, `isStagedDeleted` and
    `getStagedNameOverride` read them (tables are server-rendered until C).
  - `popLastStaged`, `revertStagedFor`, `revertStagedForElement`, `revertAllStaged` →
    `unstage`. `clearStaged` does nothing: the own-commit delta drops the batches.
    `applyDelta` hands over to `sync`. Selection and visit history still re-point through
    the response's `id_map`.
  - Conflicts: parked batches are a section of the DiffDrawer — the op, the engine's text,
    Discard — and never part of a commit.
- In engine mode the tree, search and the inspector show staged creates, renames and
  deletes; a temp-id element is reachable from the tree.

## 9. Tests and benchmarks

- Python: the three routes; digest upkeep through every journal writer and every stale path;
  the new delta fields on response and feed; `K-30` directly and as a golden scenario; the
  live digest against the digest after evict and rehydrate.
- Engine: the service over a direct port (envelope, cancel, queueing, events); slicing under
  a fake clock — no slice past 16 ms; the digest check's restart; `read_*` fixtures; seeded
  invariants for coalescing and `adoptStaged`.
- Shell: vitest with the in-process engine and MSW serving the replica routes from a real v2
  snapshot of smart-city — open, cache hit, gap → tail, incomplete tail → re-bootstrap,
  commit-in-flight order, boot fallback, and **divergence recovery**: a delta with a wrong
  digest → `diverged` → re-bootstrap → `ready`, staged ops carried.
- Store: the legacy tests stay on the legacy store; the engine store is tested against the
  real engine (`installTestEngine(model, metamodel)`), never a mock of it (RC-14).
- e2e: the suite runs in engine mode with shadow on; one spec for a staged edit visible in
  the tree; one for two clients, where a peer commit reaches the replica.
- `pixi run engine-bench-browser`: Playwright drives Chromium against the real sandbox and a
  local server of the gzipped M snapshot. Cold open ≤ 3 s, heap ≤ 400 MB (CN-3), the longest
  slice, the transition times; medians of 3 in one pass (CN-5). A miss is reported to the
  owner before anything is optimized.

## 10. Changes to `architecture/` and the backlog

Each lands in the commit of the code it describes (RC-10).

- CT-2: `recreated_*` replaces the type-or-ends rule; the tail's `complete: false` list gains
  a missing `state_digest` and the 1,000-revision cap; the commit-in-flight order.
- CT-4: the staging and context methods, `staged_version` and `structural` on `changed`,
  reads queue until `ready`. CT-5: coalescing, `adoptStaged`.
- CN-3 and `system.md` rule 4: the transition budget (decision 3).
- `program.md`: B's scope (neighborhoods out, incident relationships in), its six plans, its
  status. MR-4: the route-mock tests of a migrated surface stay while its server path does;
  the engine path is tested against the real engine.
- RC-1: `sandbox/`. A new AD: the store forks, and the legacy half lives until F.
- `BACKLOG-ENGINE.md`: `K-30` and `K-31` close; `K-32` becomes the `ord` re-sort watch item.
- `CLAUDE.md`: what each plan made current.

## 11. Plans

Six, written one at a time, each pre-verified in a scratch clone and leaving the branch green.

1. **Exact server state** — §1.
2. **Snapshots and replica routes** — §2.
3. **Engine service** — §3, §4.
4. **Sandbox and shell** — §5, §6; the replica opens and follows in the background, no
   surface switched.
5. **Transport swap** — §7, the five surfaces defaulting to the engine one by one, the
   browser bench, e2e in engine mode.
6. **Forked store** — §8, `staging: engine` by default, closing docs.

## 12. Done when

- The five surfaces and staging default to the engine; the server path still works behind
  the switch.
- Cold open and heap meet CN-3 at M in Chromium.
- The divergence-recovery test is green.
- `K-30` and `K-31` are closed; `dr-test` and `dr-tidy` are green.
- `architecture/`, `BACKLOG-ENGINE.md` and `CLAUDE.md` say what is now true.

## Known limits

- A `POST /commits` whose response is lost leaves its ops staged while the echo may have
  landed them; as today, the user sees the commit error. Not solved in B.
- `K-29`: a project holding an element and a relationship under one id opens on the server
  and is refused by the engine; the boot fallback serves it from the server.
- After a rewind that restored an entity, the first ordered read re-sorts the entity map
  (≈ 55 ms at M, *measured in Node*); charged to the transition budget and watched.
