# Sub-project F: thin server — design

Refines `architecture/program.md` §F, AD-7, AD-17 and AD-35, and the thin-server end state in
`architecture/system.md`. The server stops loading models. The engine becomes the only
implementation of everything it already serves; the server keeps auth, tenancy, locks, commits
with exact inverses and history, the feed, snapshots and import, and reads only the rows a
request needs. Built as **one plan**. Deployment is a separate spec, written once the corporate
platform documents arrive (§9).

## Decisions (owner, 2026-10-05)

1. F retires `GET /exports/run-by-name`, the server's script runner (`WasmScriptRunner`, script
   sweeps, the server cell cache) and every server export path that needs a model (AD-35).
2. The thin server is built first; deployment comes last, in its own spec.
3. The golden fixtures are frozen as engine fixtures. Generators, `test_fixtures_current`,
   `engine-parity-large` and the oracle bench writers are deleted. The Python code that stays
   (op applier, digest, snapshot codec) keeps reading the frozen fixtures.
4. A tab whose engine cannot start is blocked behind a Retry screen. There is no server read
   path.
5. The commit check runs the existing applier on a precomputed partial model and re-runs on a
   miss (approach A below).
6. Data and history are not migrated. Projects are re-imported from their files (AD-17).
7. API tokens wait for E or the deploy spec.
8. The tool is corporate only. Login goes through the corporate SSO, behind a provided load
   balancer. The mechanism is unknown until the docs arrive.
9. Work stays on `engine-migration`. One plan, with a checkpoint task at the seam between
   removal and the new server (§10).

## What the code says (at `ab4dddaa`)

1. **Every project route hydrates.** `deps.py:23-36` `get_request_session` calls
   `get_registry().get(project_id)`, which runs `hydrate_session` on a cold project
   (`hydration.py:236`). 21 route modules depend on it, among them locks, artifacts, views,
   rules, `/replica/tail` and the feed (`feed.py:78`). The `Session` holds `model_rev`, the
   lease table, the hub, the views and `write_mutex` along with the model.
2. **Routes that still read the model.**
   - Moved to the engine, server as fallback:
     - reads (`read.py` 95-628)
     - navigation evaluation and model search
     - validation (`validation.py:100,137`)
     - tables and exports (`tables.py`, `exports.py`)
     - compare and apply-CR (`change_request.py`)
     - download (`model.py:370`)
     - view warnings (`views.py:66`)
     - metamodel diff (`metamodel_swap.py:60`)
   - No frontend caller:
     - neighborhood, `relationships.py`, legacy element and relationship CRUD
     - `/model/save`, `/model/load`, `/model/upload`
     - `/snippets/run`, `/commits/{rev}/model`
     - `POST /ops` and undo (`ops.py:829,927`)
     - `/model/changes` and `/model/changes/summary`: their only caller, `refreshChangesBadge`
       (`state/changes.svelte.ts:40`), is never called
   - Server only:
     - commits, revert, `/commits/preview`, history diffs
     - `/open` (`commits.py:500`): it seeds validation, but the frontend reads only `role`,
       `lock_ttl_seconds` and `strict_mode`
     - `/model/status`, polled by `state/open-progress.svelte.ts`
     - lock expansion (`locking.py:382`)
     - the replica descriptor (`replica.py:47`)
     - project create and clone (`projects.py:97-111,190-195`)
     - metamodel POST (`metamodel.py:68`)
3. **Background work over the model.**
   - `validation_sweep.py`, `search_index_build.py`
   - `script_sweep.py` with the `WasmScriptRunner` pool (`main.py:183-217`), `table_cache.py`,
     `session.script_cell_cache`
   - `snapshot_job.py` and the evict hook (`session.py:417-460,574`)
4. **Commit path** (`commits.py:773-1443`). Steps, in order:
   - the stale-rev overlap check, which reads the model through `required_locks`
     (`locking.py:358-371`)
   - validation seeding
   - under `write_mutex`: leases, the metamodel half, `_apply_batch`, the artifact and view
     halves, rule recompilation, validation over a widened dirty set, the strict gate, the issue
     splice, the digest fold, `_persist_commit`, the snapshot, lock release, the broadcast
   
   The only blockers are structural:
   - a dangling element-valued reference (`validators/type_conformance.py:136-146`)
   - two containment parents (`containment.py:28-40`)
   - a containment cycle (`containment.py:62-75`)
   - the applier's own refusals: an unknown or abstract type, an undeclared property, a
     missing target or endpoint, an id already used (`model.py:35-205`)

   Elements and relationships share one id namespace.
5. **`entity_states`** are NULL above 5,000 touched entities (`commit_states.py:39`), and the
   history diff then reconstructs the model (`commit_diff.py:496-506`, `range_diff.py:48-67`).
   The digest is a per-entity XOR fold that is O(batch) (`state_digest.py:51-67`). It is held
   only in session memory and recomputed O(model) when unknown (`session.py:188-205`).
6. **Snapshots.**
   - Format: v2, gzip, a header line, then one line per entity, elements then relationships in
     insertion order (`snapshot_codec.py:71-110`, `serialize.py:195-208`).
   - Writing one asserts a loaded model (`hydration.py:87`).
   - `GcsSnapshotStore.put` buffers the blob and sets no content type (`storage_gcs.py:39-50`).
7. **Import** reads each file whole and builds the model twice (`projects.py:97-111`,
   `importer.py:211-217`). The rows commit before the snapshot is written, so a failure leaves a
   project without one. K-29: an element and a relationship can share an id.
8. **Frontend fallbacks** (`api/engine-route.ts:116-145,231-243`).
   - `route()` goes to the server in these cases:
     - `seam.gone`
     - a "moved" 409
     - `refusedOps`
     - a 501 in `FALLBACKS`
   - The seam answers `server` when the sync phase is `off` or `server` (`engine/seam.ts:22-27`).
     The phase is `server` when the replica never became ready (`sync.ts:848-851`), and on a
     same-host origin such as localhost (`frame.ts:86`).
   - Surface switches: `engine/surfaces.ts`, `localStorage['dr.surfaces']`, plus `staging:
     legacy` with `state/model-legacy.svelte.ts`.
   - Shadow comparison: `engine/shadow.ts`.
9. **The engine's 501s.**
   - `pattern`:
     - a search or navigation regex that `translatePyRegex` refuses (`search/criteria.ts:236-255`,
       `regex.ts:336-724`)
     - a facet pattern, which marks the whole metamodel broken and refuses every issue call
       (`validation/pipeline.ts:95-139`, `service.ts:1278,1302`)
   - `rules`: an unreadable rule set refuses every issue call (`rules/compile.ts:100-122`).
   - `file`: non-UTF-8 bytes or invalid JSON (`cr/read-file.ts:55,67`).
   - `change request`: a change request the strict reader refuses (`cr/propose.ts:64,160-198`).
   - The rebind preview's refused ops (`validation/candidate.ts:168-243`).
   - The "moved" 409s are engine races: `stale base_rev`, `stale staged batches`, `replica is not
     ready`, `replica closed` (`service.ts:277-1902`).
10. **Golden fixture generators** (`tests/golden/scenarios/*`) import `api.routes`,
    `api.session`, `api.validation_sweep`, `api.rules` and the evaluators.

## 1. The engine answers everything

Every engine refusal that today falls back to the server becomes an answer, or an error the
user can act on.

- **Search or navigation regex the engine cannot translate.** A 422 that names the construct,
  for example "scoped inline flags `(?i:…)` are not supported". The error is shown where the
  criteria or step is edited.
- **Facet pattern.**
  - A pattern the engine cannot translate, or that throws while matching a value, no longer
    breaks the metamodel. Each affected value gets a facet issue, "pattern cannot be checked",
    with the reason; every other check runs.
  - Metamodel lint (`/metamodel/lint` and the engine's candidate path) reports an untranslatable
    pattern as an error. The translator is the engine's. The server's lint keeps its Python
    check, and the engine adds this one in the editor's Preview.
- **Unreadable rule set.** It is skipped with a reason, shown in the issues panel. The other
  sets evaluate.
- **Compare file.** A 422 "not a UTF-8 JSON model file" or "invalid JSON: …".
- **Change request.** A 422 carrying the strict reader's message.
- **Rebind preview.**
  - A staged create or update naming a type or property the candidate lacks: the engine answers
    the same 422 the server's commit gives, with the server's wording, held by a test.
  - A staged `delete_element` while containment differs: a 409 "commit or unstage model edits
    before changing containment".
- **"Moved" 409s.** `route()` waits for the sync to settle (a ready replica at the caller's rev,
  with the staged batch ids re-captured) and retries the engine once. A second refusal reaches
  the caller as an error.
- **A tab whose engine is not ready.** The `server` phase becomes a terminal `unavailable` phase.
  The workspace shows the existing "replica cannot be rebuilt" overlay with Retry and a reason
  (worker failed to start; on a same-host origin, "open the app at http://127.0.0.1:5173").
  Uncommitted edits are kept, as today. Pages that read no model (project list, admin, login)
  are unaffected.
- **Dev redirect.** The frontend dev server and preview redirect `localhost` to `127.0.0.1`
  (same port and path), so the same-host trap stops happening in development.
- **Removed from the frontend.**
  - The serving apparatus: `surfaces.ts` and `dr.surfaces`, `staging: legacy` and
    `model-legacy.svelte.ts` (the shared half folds into the engine store), `shadow.ts` and
    `dr.shadow`, `FALLBACKS`, `MOVED` and `refusedOps` in `engine-route.ts`, the
    `table-fallback` and `export-fallback` markers, and the boot-fallback notice.
  - Dead or replaced code: every `lib/api` server function that only served a fallback, the
    `/model/status` poll (`open-progress.svelte.ts`; the engine's `sweep` progress already
    drives the open journey), and `state/changes.svelte.ts`.
- **e2e.** The specs that pair an engine surface with its server side keep the engine half.
  Shadow assertions are removed.

## 2. Server removals

- **Routes.**
  - Everything listed as moved or callerless in "What the code says" 2.
  - `GET /exports/run-by-name`.
  - `/model/issues`, `/model/validate`, `/model/status`.
  - `GET /commits/{rev}/model`.
- **Services.**
  - The script runner: `WasmScriptRunner`, `script_sweep.py`, `table_cache.py`, the session
    cell cache, `scripts/ensure_guest.sh` and its activation hook.
  - The validation sweep, the issue store, the trigram index build.
  - Rule compilation in the session. `POST /rules/parse` and the rule payload stay (AD-33).
- **The commit path loses:**
  - validation seeding
  - rule recompilation and `expand_dirty`
  - the widened-scope validation
  - the strict gate: strict mode is enforced by the client (AD-8)
  - the issue splice and `touched_keys` cache eviction

  `validation_error_count` and the issues on a `Commit` row are client-reported, as AD-8
  already says. The commit body carries them; the server stores them unchecked.
- **Kept routes.**
  - `lint` and `format` for snippets
  - `/snippets/docs`: it reads no model (`/snippets/cancel` goes with `/snippets/run`)
  - `POST /rules/parse`
  - artifact, view and metamodel CRUD
  - metamodel lint: it parses the document and reads no model
  - the replica routes, the feed, locks, commits, revert, history
  - projects, admin and auth
- **Dead Python core is deleted.**
  - `core/navigation/{evaluate,resolve}` and `core/search/criteria`.
  - `core/table` except the payload schemas that `api/artifact_kinds.py` validates with.
  - `core/script` except `schema`, `lint` and `docs`.
  - `core/model/change_request.py`, `core/metamodel/diff.py` and `core/view/validation.py`.
  - `core/validation` except the structural validators, the `dirty` key logic and the rules
    schema.
  - The corresponding `api/` modules (`search.py`, `table_export*.py`, `export_manifest.py`,
    `metamodel_candidate.py`, `rules.py`'s pipeline half, `validation_sweep.py`,
    `search_index_build.py`).
  - Their tests.

  `migration/` keeps what it imports (`core.metamodel`, `core.model` and the validators it
  calls); if it needs a deleted validator, that validator stays under `migration/`.

### Fixture freeze

- **Deleted:** `tests/golden/scenarios/*`, the `golden-fixtures` task,
  `tests/golden/test_fixtures_current.py`, `engine-parity-large`, and the oracle writers behind
  `engine-bench` and `engine-bench-browser`. The benches keep their engine half and read
  committed or generated inputs.
- **Kept:** `engine/fixtures/golden/` stays committed and every engine test that reads it keeps
  running.
- **Python reads the frozen fixtures** for what it still runs: ops and inverses, digest, and
  snapshot encode/decode. A small Python test per family loads the fixture and asserts the
  Python result equals it. This keeps engine and server agreeing on the commit and snapshot
  contracts (CT-1, CT-3).
- **Fixture changes from now on** are edits reviewed with the change. An engine-only feature
  adds its fixture by an engine-side generator or by hand.
- **Ordering.** The freeze lands before any generator dependency is deleted.

## 3. Head tables

The Alembic migration creates the new tables and drops nothing used. Old `snapshots` and
`commits` rows from before F are not read again (AD-17), and the cutover wipes them (§8).

- **`elements`.**
  - Columns: `project_id`, `id`, `type_name`, `properties` (JSON, JSONB on Postgres), `rev`,
    `seq`.
  - Primary key `(project_id, id)`, unique `(project_id, seq)`.
- **`relationships`.**
  - The same columns, plus `source_id` and `target_id`.
  - Indexes `(project_id, source_id)` and `(project_id, target_id)`.
- **Shared id namespace.** A new id is refused when either table holds it (one `UNION` probe per
  batch). The import checks it set-wise, which closes K-29.
- **`entity_refs`.** Columns `(project_id, referencer_id, target_id)`, indexed on `target_id`.
  - One row per element-valued property reference, from elements and relationships alike.
    Which properties count is taken from the metamodel's cached effective schema.
  - A row belongs to its referencer and survives the target's deletion, so dangling references
    stay findable.
  - Per commit, a touched entity's rows are replaced. A deleted entity's rows as referencer are
    removed.
- **`ModelRow` gains:**
  - `state_digest`: the durable digest, folded per commit.
  - `element_count` and `relationship_count`, maintained per commit.
  - `next_seq`: allocation order. CT-1 order and `first_parent` hang on it.
- **Portability.** SQLAlchemy `JSON` with a JSONB variant. The recursive CTEs use the syntax both
  SQLite and Postgres accept, so API tests stay database-free.

## 4. The commit check (approach A)

A commit runs in one transaction:
1. `SELECT … FOR UPDATE` on the project's `ModelRow`. The in-process `write_mutex` stays: one
   instance (CN-10), and SQLite has no row locks.
2. Load the partial model.
3. Run the existing applier and the structural checks on it.
4. Write the changed rows and `entity_refs`.
5. Fold the digest and counts into `ModelRow`, insert the `Commit` row and commit the
   transaction.
6. Broadcast the delta, inside the mutex as today, so feed order equals rev order.

### Loading the partial model

From the batch alone, a planner gathers the ids to load and loads them in a fixed number of
indexed queries:

- **Named ids:** update and delete targets, relationship endpoints, and element-valued
  reference values in created or updated properties.
- **Deletes:** the containment subtree of each deleted element (recursive CTE down over
  relationships whose type is in the metamodel's containment set), every relationship incident
  to the subtree, and that relationship's other endpoint. Also the referencers of every deleted
  id (`entity_refs` by target).
- **New or changed containment relationships:** the target's incoming containment
  relationships (the two-parents check) and the source's ancestor chain (recursive CTE up, the
  cycle check).
- **Id hints:** probed in both tables.

Every id the planner queried and did not find is recorded as **known absent**. The rows build an
ordinary core `Model` in a **partial** mode, with the search index off and uniqueness groups
unused (conformance is the engine's, AD-8):
- A lookup of a loaded id answers as today.
- A lookup of a known-absent id answers "absent", exactly as a full model would. That gives the
  same 422 for a missing target, endpoint or reference.
- A lookup of any other id raises `NotLoaded(ids)`.

A miss happens when an earlier op in the batch reaches an entity the planner could not foresee,
for example attaching an existing element under one that a later op deletes. The check catches
`NotLoaded`, adds those ids (with their subtrees and incident relationships, by the same rules),
and re-runs the whole batch on a fresh partial model. The bound is 8 rounds. Past it the commit
fails with a 500 that is logged with the batch's shape; reaching the bound is a bug, not a user
error.

The partial `Model` is the only `Model` the server builds outside import's checks and tests
(§7).

### What runs on it

- **Applier and inverses.** The applier runs unchanged, so it produces the inverses, `id_map`,
  per-entity `rev` and the first-touch `before` states.
- **Structural checks.** They run over the batch's dirty set: the touched entities, plus the
  referencers of deleted ids. Narrower than today's widened set: an old structural issue on an
  untouched neighbour no longer blocks an unrelated commit.
- **`required_locks` and the stale-rev overlap check.** These read the partial model after the
  load (it holds the subtrees and sources they need), so neither touches a full model. The
  overlap check moves inside the transaction: `base_rev` and the tail are read under the row
  lock.
- **`entity_states`.** Always written, with no cap. The 5,000-entity NULL and the reconstruct
  fallback behind it are gone.
- **Writes.**
  - Each touched entity is an upsert with its new `properties` and `rev`; a created entity gets
    `seq = next_seq++`.
  - Each deleted entity is a delete.
  - `entity_refs` rows are replaced for touched referencers.
  - An entity deleted and recreated in one batch gets a fresh `seq`, as the indexes' recreated
    semantics require (`indexes.py:139-160`).

### Built on the same path

- **Revert** applies the inverses of `commits_after(target)`, newest first, in restore mode, on
  a partial model planned from those ops. Its refusals (artifact, view or metamodel ops; peer
  leases) are unchanged.
- **Lock expansion** (`POST /locks` with a delete intent) uses the subtree CTE. Locks themselves
  stay in process (CN-10).
- **Rebind** (`metamodel.rebind`, hoisted first in its batch) cannot be O(batch). It checks the
  head rows against the new metamodel by streaming them in chunks of 1,000 under the row lock.
  Memory stays O(chunk), plus the containment edge list as id pairs for the cycle walk.
  - Every type is known, and an element type is not abstract.
  - Property keys are declared.
  - No element has two containment parents (a `GROUP BY` over the new containment set).
  - There is no containment cycle.
  - `entity_refs` is rebuilt, since which properties count as references depends on the
    metamodel.
  - A snapshot is forced, as today.

  The batch's model ops then run as an ordinary commit under the new metamodel.
- **`/commits/preview`** keeps only its non-model half: `base_rev` against `ModelRow`, artifact
  ops validated dry against the database, view ops against the stored views. The engine
  previews the model half, as it does today.
- **`/open`** answers `role`, `lock_ttl_seconds` and `strict_mode` from membership, settings and
  `ModelRow`.
- **History.** `/commits/{rev}/diff` and `/commits/diff` depend on membership, not the session.
  They fold `entity_states` and fold across rebind commits, which carry no entity ops. A range
  past 1,000 revs is a 422.

## 5. Snapshots and import from rows

**Snapshot job.**
- **Source:** `ModelRow` (rev, digest, counts, metamodel id) read in one transaction:
  repeatable read on Postgres, a transaction on SQLite.
- **Order:** elements by `seq`, then relationships by `seq`.
- **Output:** each row is encoded with the existing v2 line writer and gzip-streamed into the
  blob store in parts.
- **Storage:** the blob is stored with content type `application/gzip` (CN-11).
- **Triggers:**
  - every `snapshot_every` revs after a commit
  - forced after a rebind
  - at rev 0 after import
  - on the descriptor route when no usable snapshot exists

  The descriptor route answers from the `Snapshot` row and `ModelRow` and never needs a model.
  Evict no longer snapshots.
- **Contract test:** a snapshot written from the head rows of each golden model equals that
  model's committed v2 fixture once decompressed, header included.

**Import.**
- **Callers:** `POST /projects` (multipart) and the importer CLI. The model JSON is parsed
  incrementally with `ijson` (conda-forge; `use_float=True` keeps `1.0` a float and large ints
  exact).
- **Per entity:**
  - the type is known and not abstract
  - property keys are declared
  - inserted with `seq` in file order
  - `entity_refs` written
- **After the ingest**, set-based checks run in the same transaction:
  - ids unique across both tables (K-29)
  - relationship endpoints exist (anti-join)
  - no dangling references (anti-join on `entity_refs`)
  - no element has two containment parents
  - no containment cycle (the same streaming walk as rebind)
- **Failure** rolls back the transaction, so no half-imported project remains.
- **Afterwards:** `ModelRow` gets its digest (streamed fold), counts and `next_seq`, and the
  snapshot job writes rev 0.
- **Size limit:** the multipart route gets a body cap, `max_request_body_bytes`, which it lacks
  today.
- **Clone** copies head rows, `entity_refs`, artifacts and views with `INSERT … SELECT`, then
  snapshots.
- **Removed:** `/model/upload` and `/model/load` (no caller). Replacing a project's model means
  creating a new project.

## 6. No session hydration

- **`ProjectState` replaces `Session`.** It is a per-project, in-process holder:
  - `model_rev`, read from and written through `ModelRow`
  - `write_mutex`, the lease table and the feed hub
  - the views cache
  - the metamodel's frozen caches, loaded once per metamodel id; they are small and independent
    of model size

  It holds no model.
- **Wiring.** `get_request_session` becomes `get_project_state` and never hydrates.
- **Deleted:**
  - `hydration.py` (hydrate, replay, `reconstruct_model_at`)
  - the session's model fields and op log
  - `require_model`
  - the evict hook's snapshot
- **Idle eviction** drops a `ProjectState` once no leases or feed clients remain.
- **Done-criterion guard.** A test fails if any API module other than the commit check
  constructs a `Model`, or imports `build_model_from_dicts` or the snapshot decoder. Import's
  checks build no `Model`, and tests are exempt. It is enforced by import inspection over
  `src/data_rover/api`.

## 7. Local development

- **Same as before:** `dr-start`, `backend-start`, `frontend-start`, `dr-test`, `dr-tidy`, and
  `DATA_ROVER_DEV_SEED` with SQLite. API tests stay database-free on in-memory SQLite.
- **Gone:** `ensure_guest.sh`, `golden-fixtures`, `engine-parity-large`, `dr.surfaces` and
  `dr.shadow`. CLAUDE.md's gotchas are updated.
- **Behaviour changes:** `localhost` redirects to `127.0.0.1`. The sandbox dev server must run;
  `dr-start` starts it.
- **New: `pixi run core-test-pg`.** Opt-in, against the compose Postgres, not part of `dr-test`.
  It covers what SQLite cannot exercise:
  - `FOR UPDATE` serialization between two concurrent commits
  - JSONB round trips, including `1.0` and integers past 2^53
  - the recursive CTEs
  - the repeatable-read snapshot
  - K-36 (the JSON-`null` tail cast)

## 8. Cutover

Before the first thin-server deploy, existing databases and buckets are wiped and projects are
re-created from their files through the new import (AD-17).
- No data is migrated, and no export-all tool is built.
- The importer carries only the owner. Members are added again through admin.

## 9. Deploy: separate spec, constraints recorded now

Written when the corporate documents on SSO, the provided load balancer, domains and the GCP
project and org arrive. This design leaves it these constraints:
- **Identity.** It enters through the identity-provider seam (`settings.py:38-57`). The corporate
  SSO becomes one provider. `cookie` and `header` stay for local development and tests.
- **Sandbox.** It is served on its own site (a different registrable domain or a public-suffix
  host, CN-17) and without SSO: its static files hold no data, and a cross-site iframe cannot
  carry SSO cookies. Both origins carry COOP, COEP and CORP (CN-14); the sandbox carries its CSP
  and `frame-ancestors`.
- **API.** One API instance (CN-10).
- **Snapshots.** Stored as `application/gzip`, never transcoded (CN-11).
- **Cost.** CN-13 (no load balancer) no longer holds: the corporate load balancer is provided.
  CN-7 is revised in the deploy spec.

## 10. Plan shape

One plan, ordered so each task leaves the branch green.
1. **Fixture freeze.** Independent; runs beside §1.
2. **The engine answers everything** (§1). Engine and frontend only.
3. **Server removals and dead core** (§2). Depends on 2.
4. **Checkpoint.** Stop and report to the owner what the server still does, with path evidence,
   and confirm §3–§6 against the code as it now stands. Wait for the owner's go-ahead.
5. **Head tables, partial-model commit check, revert, locks, rebind, preview, `/open`, history**
   (§3–§4).
6. **Snapshots and import from rows** (§5).
7. **`ProjectState`, hydration removal and the done-criterion guard** (§6).
8. **Docs.**
   - `architecture/`: AD-7 done; MR-1…MR-3 retired; system.md "Current → target" marked done;
     CN-13 and CN-7 flagged for the deploy spec; program.md status.
   - The API, core, engine-shell and frontend READMEs.
   - CLAUDE.md.

## Testing

- **The commit check against a full model** (the key test). Randomized batches over generated
  models are applied twice: through the thin commit, and with the same batch on a full core
  `Model` built from the same head rows (tests only). The two must agree on:
  - the resulting rows and `entity_refs`
  - `entity_states`, inverses, `id_map`
  - the digest
  - accept or reject, with the same error

  Batches include:
  - deletes under containment
  - attach-then-delete (the `NotLoaded` re-run)
  - deletes and recreates
  - cycles and second parents
  - dangling references
  - id collisions across elements and relationships
- **Revert.** Revert of random ranges restores the earlier head rows and digest exactly.
- **Rebind and import.** Fixtures for each structural refusal, and K-29.
- **Snapshots.** The contract test in §5. The engine opens a snapshot written from rows and its
  digest check passes.
- **Postgres lane.** See §7.
- **Engine and frontend.** Each new 422 or 409 in §1, the per-pattern facet issue, the skipped
  rule set, the retry on a "moved" 409, the `unavailable` phase and its overlay, and the dev
  redirect.
- **Done guard.** The guard in §6.
- **Measured, reported, not gated** (Postgres, M):
  - a 1,000-op commit
  - a delete of a 10,000-element subtree
  - a snapshot from rows
  - an import of M

  CN-3 has no server budget; the numbers go in program.md.

## Out of scope

- The deploy (§9) and API tokens.
- E's CLI.
- Moving leases or the feed hub to Redis or Postgres (CN-10, not before about 500 users).
- K-113, K-114, K-115.

## Rulings from the plan inventory (2026-10-05)

The plan's inventory, taken at `700b39f0`, found these points where the code contradicts or
goes beyond the sections above. Each ruling overrides those sections.

1. **`core/metamodel/diff.py` stays.** `POST /metamodel/structural-diff` (the engine's Preview
   calls it, `frontend/src/lib/api/metamodel.ts:76`) and the history diff of rebind commits
   (`api/commit_diff.py:58,335`) use it. It reads no model.
2. **`core/search/criteria.py` keeps its `Criterion` models.** The navigation and table schemas
   import them. Only the matchers go.
3. **`migration/` needs the whole validation pipeline** (`migration/legacy.py:27,591`).
   `core/validation`'s pipeline, scope, issue and all six validators stay. The server stops
   calling them, except the structural gate.
4. **`POST /rules/lint` stays, and `core/validation/rules/compile.py` with it.** The rules
   editor calls the route, and it reads no model.
5. **`/snippets/docs` keeps `core/script/facade_src.py`.**
6. **Generated engine sources.** The golden driver writes 8 engine source files from Python. The
   ones whose source survives (Unicode and regex tables from the stdlib, `facade.generated.ts`
   from `facade_src`, the xlsx tables) get a small generator under `scripts/`, with a staleness
   test. `harness.generated.ts` is engine-owned from now on, since its Python source goes.
   `scripts/script_corpus_snapshot.py` gets its corpus inline.
7. **Bench inputs.** An oracle writer under `scripts/` stays if it imports no deleted module.
   Otherwise its bench case is deleted with it.
8. **Seeding API tests.** Many API test files seed and assert through removed routes:
   `POST /model` (52 files), `/model/summary` (40), `/model/ops` (34), `/model/undo` (15),
   `/model/upload` (17). They move to test helpers before the routes go. The helpers are built
   on an `install_model` importer function and a `head()` reader, whose implementations change
   underneath them as the plan proceeds. Undo tests are deleted or become revert tests.
9. **The trigram index leaves `IndexSet`** (`core/model/indexes.py` 263, 506, 534, 851-890).
10. **Client-reported counts.** `CommitRequest` gains `validation_error_count` and `issues`,
    which the frontend sends from its preview. A revert has no client preview, so it stores
    `validation_error_count` as NULL (the column becomes nullable), and the history shows "—".
11. **Rebind checks tighten.** Today a rebind that drops a type still in use, or a property
    still set, lands with conformance issues. After F it is refused with a 422 naming the first
    offending entities, because the thin server cannot hold rows its applier does not
    understand. The user deletes or migrates them first.
12. **Open progress.** The journey does not read the engine's sweep progress
    (`open-journey.ts:422-427`). Removing the `/model/status` poll drops the server half of
    `journeyStatus`, and nothing replaces it.
13. **A closed replica gate.** While the replica is opening or not yet seeded, `route()` used
    to send calls to the server. Now it waits for the gate to open.
14. **The snapshot contract test** compares the rows writer with the kept encoder,
    `encode_snapshot_v2(build_model_from_dicts(...))`, over smart-city and the `snapshot_v2`
    fixture model. There is no per-golden-model v2 fixture family.
