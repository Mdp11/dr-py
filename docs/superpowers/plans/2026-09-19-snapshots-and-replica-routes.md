# Snapshots and Replica Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The current server serves what a replica opens from and catches up by: every snapshot writer emits `datarover.snapshot/v2` with the session's digest in its header, the `Snapshot` row records what that header says, and three member-gated read routes — the snapshot descriptor, the blob, the tail — plus an `X-Metamodel-Id` header on `GET /metamodel` give a client everything CT-1 and CT-2 ask of the server.

**Architecture:** Plan 2 of 6 for sub-project B (`architecture/program.md`). `hydration.write_snapshot` stays the one funnel of every snapshot writer; it switches to `encode_snapshot_v2`, takes `write_mutex` itself for the length of the stream, and records the header's fields on the `Snapshot` row (five nullable columns, Alembic `0016`). A new `api/replica.py` holds the three rules the routes share — when a journal range is expressible as deltas, how one `Commit` row becomes a delta, which stored snapshot a client should open — and a new `routes/replica.py` serves them: `GET /replica/snapshot`, `GET /replica/snapshots/{rev}`, `GET /replica/tail`. The descriptor and the tail decide completeness with the SAME function over the SAME query, so the descriptor's promise ("head is reachable from here by a complete tail") is by construction the tail's answer. Nothing in the frontend or the engine changes.

**Tech Stack:** Python 3.14 (FastAPI, pydantic 2, SQLAlchemy 2, Alembic, pytest, ruff, mypy, pyright); pixi for every command.

**Spec:** `docs/superpowers/specs/2026-09-19-replica-and-frontend-seam-design.md` — §2 is this plan's whole scope; §9 names its tests, §10 the `architecture/` and backlog edits that ride with the code. Read `architecture/contracts.md` (CT-1, CT-2, CT-3), `architecture/constraints.md` (CN-9, CN-11, CN-12), `architecture/program.md` (B) and `architecture/conventions.md` first, then plan 1's "After this plan" (`docs/superpowers/plans/2026-09-19-exact-server-state.md`, end of file).

**What kind of plan this is.** Direction with specifics: interfaces, signatures, the test cases and what each asserts, the order, and the mechanisms that are easy to get wrong, spelled out. It holds no full code and nothing in it was built or run — the implementer writes the tests and the code, and the expected results of the "see it fail" steps are reasoned from the code, not observed. If a step's expected result does not appear, trust the run, read the step's intent, and say so in the hand-back. What WAS checked while planning is listed next, each with how.

## What planning found

Facts the plan rests on, each checked against the code at `1cd75f9` or by a throwaway probe.

1. **One funnel, five writers, one of them outside the mutex.** `store.put` has exactly one caller in `src/`: `hydration.write_snapshot(project_id, session, rev)`. Its callers: the periodic job (`snapshot_job._run`), the evict hook (`session.install_persistent_registry`), the rebind-forced snapshot (`routes/commits.py::create_commit`, step f) — all three under `write_mutex` — the importer (`importer.import_project`, a private `Session` nobody else sees; `clone_project` goes through it), and `persist_baseline` (`routes/model.py::_install_model`), which runs under NO mutex. v1 tolerated that: a snapshot torn by a concurrent commit was silently inconsistent. v2 does not: a header whose counts disagree with the lines is refused by `decode_snapshot`, and hydration with it. Hence mechanism M1.
2. **A `None` in a JSON column is JSON `null`, not SQL NULL.** *Probed on SQLite through the ORM:* `append_commit(entity_states=None)` stores the text `null`; `Commit.entity_states.is_(None)` matches NOTHING. Rows older than migration `0013` hold SQL NULL. A SQL-side "has no `entity_states`" test must catch both: `entity_states IS NULL OR CAST(entity_states AS VARCHAR) = 'null'`. `Commit.state_digest` is a `String` and does store SQL NULL.
3. **Key order survives the journal.** `commits.entity_states` is `sa.JSON()` — Postgres `json`, which keeps the text, not `jsonb` — and `capture_entity_states` writes the changed ids in first-touch order, then the deleted ids. Reading `after` entities in dict order therefore reproduces the feed's `changed_*` order, and the ids whose `after` is null reproduce `deleted_*`.
4. **Every journal writer captures `entity_states` and `state_digest` unconditionally** — also for an artifact-only, view-only or layout-only commit, whose `entity_states` is `{"elements": {}, "relationships": {}, "recreated": {…}}`. Such a row is expressible: a delta with empty entity lists that moves `rev`.
5. **A rebind row is known by its metamodel-id columns**, as `content.first_rebind_after` already assumes. They are `SET NULL` on metamodel delete, but no code path deletes a `MetamodelRow` (grep over `src/data_rover/api`), so the marker stands. `to_metamodel_id` is always set on a rebind row; `from_metamodel_id` may be NULL.
6. **Raw journal ops can be classified without pydantic**: `ARTIFACT_OP_KINDS`, `VIEW_OP_KINDS`, `METAMODEL_OP_KINDS` exist for exactly that (`commit_diff.py` ~:514 does it).
7. **`session.model_rev` moves before the row is durable.** In all four journal writers the bump precedes `db.commit()`, all inside `write_mutex`. A lock-free reader can see head `N+1` with no row `N+1`. Hence mechanism M3.
8. **`touch_model` and the deprecated `POST /model` bump `model_rev` with no journal row**, and `models.model_rev` does not follow. The feed's reconnect `snapshot` event reports the SESSION's `model_rev`, so the tail's `head_rev` must be the session's too, or a client could be told "complete" at a head below the one the feed announced.
9. **No middleware compresses responses** (`main.py` adds CORS and CSRF only), so a route that sets no `Content-Encoding` ships none. CORS has no `expose_headers`; dev is same-origin through the Vite proxy, but a cross-origin deployment could not read a custom header.
10. **`GcsSnapshotStore.put` uploads as `application/octet-stream`** with no `Content-Encoding` (load-bearing, see its comment). Nothing reads the stored object's type before F's signed URLs; the blob route sets `application/gzip` itself.
11. **`GcsSnapshotStore.get` and `MemorySnapshotStore.get` both raise `KeyError` on a miss.**
12. **Measured at M** (170,340 elements, 126,820 relationships, Python 3.14, medians of 3, `benchmarks/large.model.json`): encode v1 858 ms; encode v2 1,426 ms, of which 277 ms is `model_digest` recomputed inside the encoder — ≈ 1,150 ms once the session's digest is passed in; both blobs 5.83 MiB. Decode v1 1,238 ms; decode v2 2,360 ms. So the descriptor's synchronous head write holds `write_mutex` for ≈ 1.15 s plus the upload (the periodic job already holds it ≈ 0.86 s plus the upload every `snapshot_every` = 200 commits), and a cold hydration at M gains ≈ 1.1 s in its parse phase. Reported to the owner, who accepted both and asked for a watch item: `K-34`, logged in Task 2. **Do not optimize.**

## Decisions

Taken with the owner (2026-09-19):

- **D1. The descriptor reads typed columns.** `Snapshot` gains `format`, `metamodel_id`, `state_digest`, `elements`, `relationships`, all nullable, written by the v2 writer. The descriptor is one row read and never touches the blob store.
- **D2. v2's decode cost is accepted and watched** (`K-34`); no codec optimization in this plan.

Taken by this plan — each small, each reversible at review; say so if one is wrong:

- **D3. The store key does not change** (`projects/{id}/snapshots/{rev}.json.gz`). CT-1 makes the suffix naming only. It matters at rollout: the first replica open of most projects writes a v2 snapshot at the very `rev` an evict or baseline v1 snapshot already holds; the same key overwrites that blob in place (readers sniff bytes, so the moment where the row still says v1 is harmless) where a new suffix would orphan one v1 blob per project.
- **D4. `encode_snapshot` (v1) stays**, unused by any server writer: `scripts/bench.py` and the read-compat tests use it, and F deletes v1 whole.
- **D5. The tail's `head_rev` is the session's `model_rev`, read under `write_mutex`** — a two-line critical section (facts 7 and 8, mechanism M3).
- **D6. The descriptor's `url` is a path, not an absolute URL**: the request's own path with its last segment replaced. `request.url_for` would name the backend's host, which behind the dev proxy is not the browser's origin.
- **D7. The blob answers `Cache-Control: no-store`.** The shell caches the bytes itself (CN-12, spec §6); an HTTP-cache copy would be a second 6 MiB of the same thing, keyed by a URL F replaces.
- **D8. `GET /metamodel` stays lock-free.** Its document and its id are read a moment apart; a rebind landing between them mispairs them, and the client heals through the `rebind_event` it has been buffering since before it asked (spec §6, Open).
- **D9. A rebind is detected by the row's metamodel-id columns** (fact 5), in SQL, not by scanning `ops`.
- **D10. The stored object's content type stays as it is** (fact 10); F owns it.
- **D11. A tail asked from beyond head is `complete: false`**, not an error: a replica ahead of the server follows a server-side reset, and re-bootstrapping is the cure.

## Global Constraints

- Everything runs through pixi. There is no global `python`: `pixi run <task>`, `pixi run -e core-dev ...`.
- Work on branch `feat/replica-routes`, cut from `engine-migration` (Task 1 cuts it) and fast-forwarded back when the plan is done (Task 6). Never touch `main`. **Commit only with the owner's go-ahead for this plan's execution** — plan 1's blanket approval does not carry over; ask before Task 1.
- **Freeze rule (MR-3):** `core/model`, `core/metamodel` and the model-op applier are frozen for behaviour. This plan touches none of them. The golden fixtures must not move: `encode_snapshot_v2` keeps its present output for its present arguments (Task 2 checks).
- `snapshot_codec.py` stays the only module that knows the blob format, and MUST keep reading v1 (CT-1). No reader branches on the key or on `Snapshot.format` to pick a decoder.
- Never `Content-Encoding` on a snapshot response (CN-11).
- `Session.state_digest()` is called under `write_mutex` only.
- `/model/ops` and `/model/undo` stay silent on the feed. `prev_rev` is not stored on `Commit`. `recreated_*` are lists of their own.
- Never keep a reference to `model.elements` / `model.relationships` across `Model.settle_order()`.
- Performance: do not optimize. If a number looks wrong during execution, report it.
- Formatting: Python is ruff-formatted. `pixi run dr-tidy` lints neither `tests/`, `scripts/` nor `alembic/`: run `pixi run -e core-dev ruff check <files>` and `ruff format <files>` by hand on every file a task adds or edits there. Pre-existing findings in a touched test file are NOT this plan's to fix and no step promises them clean (`tests/api/test_feed_hub.py:12` `UP037`, `tests/api/test_commit_states.py` unformatted are known).
- The check-only lint is `pixi run dr-tidy true` (the argument is positional; `check_only=true` is rejected).
- A "see it fail" step lists the tests it expects red. A shared helper or fixture that touches a missing name fails every test that uses it: expect ALL of them, and treat any OTHER red test as a finding to report, not to silence.
- Comments and docstrings are concise and present-tense, only for what the code cannot say. No references to specs, plans, phases or `architecture/` ids in code.
- `architecture/`, `CLAUDE.md`, `BACKLOG.md` and `BACKLOG-ENGINE.md` are tracked and change in the same commit as the code they describe (RC-10); `docs/` and `benchmarks/` are git-ignored — never `git add -f`.
- Commit subjects: one imperative sentence, capitalized, no prefix, no trailing period; the message ends with the session's `Co-Authored-By` line.
- Ids: this plan uses `K-34`. The next free ones afterwards are `K-35`, `C-21`, `AD-26`.

## File Structure

```
src/data_rover/api/db_models.py             Snapshot: + format, metamodel_id, state_digest, elements, relationships
alembic/versions/0016_snapshot_format.py    the five columns
src/data_rover/api/content.py               record_snapshot(+ header fields); latest_snapshot(format=);
                                            + get_snapshot, commit_tail_marks
src/data_rover/api/snapshot_codec.py        encode_snapshot_v2(state_digest=)
src/data_rover/api/hydration.py             write_snapshot: v2, under write_mutex, header fields on the row
src/data_rover/api/replica.py               (new) TAIL_MAX_REVS, tail_is_complete, scope_of_ops,
                                            delta_from_commit, build_tail, pick_snapshot
src/data_rover/api/routes/replica.py        (new) the three routes
src/data_rover/api/schemas.py               SnapshotDescriptorOut, ReplicaTailOut
src/data_rover/api/routes/metamodel.py      GET /metamodel: X-Metamodel-Id
src/data_rover/api/main.py                  mount the router; CORS expose_headers

tests/api/test_alembic.py                   + 0016
tests/api/test_content.py                   + the row's header fields, the format filter, the tail marks
tests/api/test_snapshot_codec.py            + the digest argument
tests/api/test_snapshot_writers.py          (new) every writer emits v2; the mutex; v1 still hydrates
tests/api/test_hydration.py                 one test rewritten for v2
tests/api/test_replica_tail.py              (new)
tests/api/test_replica_snapshot.py          (new) descriptor and blob
tests/api/test_metamodel_id_header.py       (new)

CLAUDE.md, architecture/contracts.md, architecture/program.md, BACKLOG.md
```

`api/replica.py` is to the replica routes what `commit_diff.py` is to the diff route: pure rules over rows, no FastAPI. Queries live in `content.py`, as everywhere else.

## Mechanisms

Referred to by the tasks; read them before the task that uses them.

**M1 — `write_snapshot` holds the model still.** `write_snapshot` opens with `with session.write_mutex:` around everything it does. The mutex is a `threading.RLock`, so the three callers that already hold it pay nothing, and `persist_baseline` and the importer become safe by construction. Inside, in this order: (1) one `db_session()`: read `ModelRow.metamodel_id` (`""` when there is no row); (2) still inside that DB session, take `session.state_digest()`, `len(model.elements)`, `len(model.relationships)`; (3) `store.put(key, encode_snapshot_v2(model, project_id=…, rev=rev, metamodel_id=…, state_digest=…))`; (4) `content.record_snapshot(...)` with `format="v2"` and the same four values. The header and the row are written from the SAME four locals, so they cannot disagree. The DB connection is held across the upload; that is one connection for one to two seconds, on paths that already serialize on the mutex. Lock order: `persist_baseline` now takes the mutex while its request holds a connection — the order every commit request already has — and `write_snapshot` opens its connection under the mutex, the inversion `snapshot_job.py`'s docstring already accounts for; no new pairing appears.

**M2 — one completeness rule.** `content.commit_tail_marks(db, project_id, *, after_rev, max_rev)` returns `[(rev, expressible)]` ascending for `after_rev < rev <= max_rev`, selecting scalar expressions only — never the JSON bodies. `expressible` is computed in SQL as: `state_digest IS NOT NULL AND from_metamodel_id IS NULL AND to_metamodel_id IS NULL AND entity_states IS NOT NULL AND CAST(entity_states AS VARCHAR) != 'null'` (fact 2). `replica.tail_is_complete(marks, from_rev, head_rev)` is pure: true iff `0 <= head_rev - from_rev <= TAIL_MAX_REVS` and the marks' revs are exactly `from_rev + 1 … head_rev` and every mark is expressible. That one predicate covers every `complete: false` case of spec §2: a missing revision (a hole: `touch_model`, the deprecated `POST /model`, a row not there), a row without `entity_states` (older than `0013`, or over `ENTITY_STATES_MAX`), a row without `state_digest` (older than `0015`, or a baseline marker, which has neither), a rebind, more than 1,000 revisions, and a `from_rev` beyond head. Because the revs are contiguous whenever it is true, `prev_rev` of each delta is `rev - 1`, which IS "the row before"; the first delta's is `from_rev`, whether or not a row exists at `from_rev`. The hermetic suite runs the expression on SQLite only; on Postgres it rests on `json → varchar` being an I/O conversion cast that yields the stored text — Task 6 checks that once by hand.

**M3 — a head no commit is halfway through.** Both routes read head as `with session.write_mutex: head = session.model_rev`, and release before any query. Under the mutex no journal writer is between its bump and its `db.commit()`, so every row `<= head` is durable and — the journal being append-only — stays as it is after the mutex is released. The wait is bounded by the longest mutex holder (a snapshot write, a rebind's full validation): seconds at M, on a route a client calls on reconnect.

**M4 — the descriptor: look, then look again under the mutex, then write.**
1. `require_model(session)` — 404 `No model loaded` without one.
2. Fast path, lock-free: `head = session.model_rev`; `snap = replica.pick_snapshot(db, project_id, head)`. If found, answer.
3. Slow path: `with session.write_mutex:` — read head again, `pick_snapshot` again (a second opener finds what the first wrote; a commit that was mid-flight in step 2 has landed), and only if there is still none: `write_snapshot(project_id, session, head)`, then read the row back with `content.get_snapshot`.
4. A failure of the write (store or DB) is a 503 `snapshot store unavailable`, logged with its traceback; the mutex is released by the `with`.

`pick_snapshot(db, project_id, head_rev)` is: `content.latest_snapshot(db, project_id, max_rev=head_rev, format="v2")`; `None` → `None`; else the marks for `(snap.rev, head_rev]` and `tail_is_complete`. ONE candidate suffices: an older snapshot's range contains the newest one's, so if the newest fails, all fail. The fast path's lock-free head can be a bumped-but-not-durable `N+1`; then the marks miss the last row, the fast path declines, and the slow path settles it — a needless wait, never a wrong answer. The descriptor is a GET and viewer-allowed, and it can write a snapshot; that is a cache fill, idempotent, and it cannot be provoked repeatedly: once a v2 snapshot exists at head, every later call finds it until a rebind, an over-cap commit, a hole or 1,000 commits intervene.

**M5 — a delta from a row.** `replica.delta_from_commit(row, prev_rev)` reads the RAW `row.entity_states` dict — no `load_entity_states`, no pydantic round trip; the stored dicts are already the wire's — and returns `feed.commit_event(...)`'s dict, so the shape cannot drift from the feed's: `changed_elements` = every `after` that is not null, in dict order; `deleted_element_ids` = every id whose `after` is null, in dict order (one created and deleted within the commit included: its `before` is null too); the same for relationships; `recreated_*` from `raw.get("recreated", {})` (absent on rows older than plan 1: none named); `state_digest`, `commit_id`, `message`, `validation_error_count` from the row; `author_id` = `row.author_id or ""` (SET NULL after a user delete); `rev`, `prev_rev`. `scope` = `replica.scope_of_ops(row.ops)` over the raw op dicts: `"model"` if any kind is in none of the three kind sets, `"artifact"` / `"view"` by their sets, `"metamodel-layout"` if any kind is `metamodel.move_node`; sorted; `["model"]` when empty — the expression `create_commit` evaluates over its typed lists. `create_commit` is NOT refactored onto it (`C-12`: that file is not one to reshape in passing); the tail-equals-feed tests of Task 3 are what holds the two together.

---

### Task 1: The snapshot row records its header

`Snapshot` learns what its blob's header says. Nothing writes the new columns yet; every existing row and every row written until Task 2 has them NULL, which reads as v1.

**Files:**
- Create: `alembic/versions/0016_snapshot_format.py`
- Modify: `src/data_rover/api/db_models.py`, `src/data_rover/api/content.py`, `tests/api/test_alembic.py`, `tests/api/test_content.py`, `CLAUDE.md`

**Interfaces:**
- Consumes: nothing from this plan.
- Produces: on `Snapshot`: `format: Mapped[str | None]` (`String(8)`), `metamodel_id: Mapped[str | None]` (`String`, NO foreign key — `""` is a legal value and history must survive a metamodel's deletion), `state_digest: Mapped[str | None]` (`String(16)`), `elements: Mapped[int | None]`, `relationships: Mapped[int | None]`. In `content.py`: `record_snapshot(db, project_id, *, rev: int, key: str, format: str | None = None, metamodel_id: str | None = None, state_digest: str | None = None, elements: int | None = None, relationships: int | None = None) -> Snapshot` — the upsert sets ALL six on an existing row, so a v2 write over a v1 row at the same `rev` leaves no stale field; `latest_snapshot(db, project_id, max_rev: int | None = None, *, format: str | None = None) -> Snapshot | None` — `format=None` keeps today's meaning (any row), `format="v2"` filters; `get_snapshot(db, project_id, rev: int) -> Snapshot | None` — the PK lookup.

- [ ] **Step 1: Ask, then cut the branch.** Ask the owner whether commits are pre-approved for this plan. Then `git switch engine-migration && git switch -c feat/replica-routes`.

- [ ] **Step 2: Write the failing tests.**
  - `tests/api/test_alembic.py::test_migration_0016_adds_snapshot_format_columns` — modelled on `test_migration_0015_adds_commit_state_digest`: upgrade to `0015`, insert a project and a `snapshots` row by SQL, upgrade to head; the row survives with all five new columns NULL; the five columns exist with the types above; downgrade to `0015` drops them and keeps the row.
  - `tests/api/test_content.py`:
    - `test_record_snapshot_stores_the_header_fields` — record with all five; read back through `get_snapshot`; every field equal.
    - `test_record_snapshot_over_a_v1_row_replaces_every_field` — record `(p, 3)` with the key alone, then again with `format="v2"` and the rest; one row, all set. And the reverse (v2 then a bare call) leaves the five NULL: the row says what the LAST writer wrote.
    - `test_latest_snapshot_can_ask_for_v2_only` — rows at revs 1 (v2), 2 (v1), 3 (v2), 4 (v1): `latest_snapshot(format="v2")` is rev 3; with `max_rev=2` it is rev 1; without `format` it is rev 4, as today; a project with v1 rows only gives `None` for v2.
    - `test_get_snapshot_is_none_for_an_unknown_rev`.

- [ ] **Step 3: See them fail.** `pixi run -e core-dev pytest tests/api/test_alembic.py tests/api/test_content.py -q`. Expected red: the five new tests (unknown keyword arguments, missing `get_snapshot`, no revision `0016`). `test_snapshot_record_and_latest` and the rest stay green.

- [ ] **Step 4: Implement.** The five columns with a docstring line saying NULL means a v1 blob (or a row older than the columns) and that the values are the blob's header, written by the same call; migration `0016` (`down_revision = "0015"`, five `op.add_column`, downgrade drops them in reverse); the three `content.py` functions.

- [ ] **Step 5: See them pass**, same command. Then `pixi run -e core-dev pytest tests/api -q -k "snapshot or hydrat or evict or importer"` — everything that reads or writes snapshot rows is still green (the new arguments default to today's behaviour).

- [ ] **Step 6: Lint.** `pixi run backend-lint`; by hand, ruff check + format on `alembic/versions/0016_snapshot_format.py`, `tests/api/test_alembic.py`, `tests/api/test_content.py`.

- [ ] **Step 7: `CLAUDE.md`.** In "Durable persistence", the `db_models.py` bullet: `Snapshot` (PK `(project_id, rev)`; blob `key`) gains "and, for a v2 blob, its header's fields — `format`, `metamodel_id`, `state_digest`, `elements`, `relationships`; all NULL on a v1 row (Alembic `0016`)".

- [ ] **Step 8: Commit** (with the owner's go-ahead): `Record a snapshot's format and header on its row`.

---

### Task 2: Every writer emits v2

**Files:**
- Create: `tests/api/test_snapshot_writers.py`
- Modify: `src/data_rover/api/snapshot_codec.py`, `src/data_rover/api/hydration.py`, `src/data_rover/api/storage.py` (docstrings only), `src/data_rover/api/snapshot_job.py` (docstring only), `tests/api/test_snapshot_codec.py`, `tests/api/test_hydration.py`, `CLAUDE.md`, `BACKLOG.md`

**Interfaces:**
- Consumes: Task 1's `record_snapshot` fields.
- Produces: `encode_snapshot_v2(model, *, project_id: str, rev: int, metamodel_id: str, state_digest: str | None = None) -> Iterator[bytes]` — `None` recomputes `model_digest(model)` as today (so `scripts/snapshot_v2.py`, the golden scenario `snapshot_v2` and every existing test are untouched), a string is written as given. `write_snapshot(project_id: str, session: Session, rev: int) -> None` keeps its signature; its behaviour is M1.

- [ ] **Step 1: Write the failing tests.**

  `tests/api/test_snapshot_codec.py`:
  - `test_v2_header_takes_the_digest_it_is_given` — a digest string that is NOT the model's appears verbatim in the header, and `model_digest` is not called (monkeypatch `data_rover.api.snapshot_codec.model_digest` to raise).
  - `test_v2_header_computes_the_digest_when_given_none` — equals `model_digest(model)`.

  `tests/api/test_snapshot_writers.py` — a module fixture like `tests/api/test_commit_delta.py`'s `client`, but the model arrives through `POST /model/upload` (a raw JSON body), because only `_install_model` persists a baseline; the deprecated `POST /model` writes no snapshot. Two helpers: `_header(project_id, rev)` — the row's key → `store.get` → `gzip.decompress` → first line → `json.loads`; `_row(project_id, rev)` — `content.get_snapshot`. One assertion helper, `_assert_v2(project_id, rev)`: the inflated blob starts with `{"format":"datarover.snapshot/v2"`; the header's `project_id` and `rev` are right; `row.format == "v2"`; the row's `metamodel_id`, `state_digest`, `elements`, `relationships` equal the header's; the header's counts equal the number of lines that follow; `decode_snapshot(blob)` equals the live model's `{"elements", "relationships"}` document.
  - `test_the_baseline_snapshot_is_v2` — after the upload, at the session's `model_rev`; `metamodel_id` equals `ModelRow.metamodel_id`.
  - `test_the_periodic_snapshot_is_v2` — `monkeypatch.setenv("DATA_ROVER_SNAPSHOT_EVERY", "2")`, as `tests/api/test_snapshot_job.py` sets it (the conftest already runs the job inline), then `/model/ops` batches up to an even `rev`.
  - `test_the_evict_snapshot_is_v2` — a batch, then `get_registry().evict(DEFAULT_PROJECT_ID)`.
  - `test_the_rebind_snapshot_is_v2_and_names_the_new_metamodel` — a `metamodel.rebind` commit (reuse the setup of `tests/api/test_commits_metamodel_ops.py`): the header's `metamodel_id` is the commit row's `to_metamodel_id`, not the one before.
  - `test_the_importer_snapshot_is_v2` — `import_project` with the smart-city examples: rev 0, `metamodel_id` = the project's `ModelRow.metamodel_id`. (`clone_project` lands through the same call; no test of its own.)
  - `test_a_project_without_a_model_row_writes_an_empty_metamodel_id` — a `Session` built by hand over a project row with no `ModelRow`, `write_snapshot` called directly: header and row say `""`.
  - `test_the_header_digest_is_the_sessions` — after a landed batch the digest is known; monkeypatch both `data_rover.api.session.digest_value` and `data_rover.api.snapshot_codec.model_digest` to raise; evict; the snapshot is written without a full pass and its digest equals the batch response's `state_digest`.
  - `test_a_fresh_session_pays_one_pass_for_its_first_snapshot` — after the upload `state_digest_value` is `None`; the baseline header's digest equals `model_digest(model)`, and `state_digest_value` is known afterwards.
  - `test_write_snapshot_holds_the_write_mutex_for_the_whole_stream` — a store double whose `put`, while it drains the chunks, starts a thread that tries `session.write_mutex.acquire(blocking=False)` and records the result; called from a test that does NOT hold the mutex (the baseline path's situation); the thread must have been refused, and the mutex must be free afterwards. (`RLock._is_owned` is private; probing from another thread is the public way to ask.)
  - `test_a_v2_snapshot_hydrates_to_the_same_state` — several batches (creates, a relationship, an update, a delete), evict, `get_session()` again: `list(iter_entity_lines(model))` equal before and after — entity ORDER included — and `session.state_digest()` equal to the header's.
  - `test_a_v1_snapshot_still_hydrates` — seed a project whose only snapshot is a v1 blob written by hand (`store.put(key, encode_snapshot(model))` + a bare `record_snapshot`): it hydrates; its row's `format` is NULL.

  `tests/api/test_hydration.py::test_snapshot_blob_is_gzip_under_the_gz_key` — rewrite its last content assertion: the inflated blob is no longer `{"elements":[],"relationships":[]}` but a v2 header line with zero counts and nothing after it. Keep the key and gzip-magic assertions (D3). Rename to `test_snapshot_blob_is_a_gzipped_v2_text_under_the_gz_key`.

- [ ] **Step 2: See them fail.** `pixi run -e core-dev pytest tests/api/test_snapshot_codec.py tests/api/test_snapshot_writers.py tests/api/test_hydration.py -q`. Expected red: the two codec tests (unknown keyword), every `test_snapshot_writers.py` test except `test_a_v1_snapshot_still_hydrates` (blobs are v1, rows carry no format), and the rewritten hydration test. `test_a_v1_snapshot_still_hydrates` is green from the start — it pins behaviour that must not change.

- [ ] **Step 3: Implement the codec argument.** `_v2_lines` takes the digest; `encode_snapshot_v2` resolves `None` to `model_digest(model)`. Update the module docstring: v2 is what every writer emits; v1 is read, and written by no server path.

- [ ] **Step 4: Implement M1 in `write_snapshot`.** Exactly the order M1 gives. Update its docstring (it states the mutex and that the row mirrors the header), `hydration.py`'s module docstring, `storage.py`'s two docstrings (the blob is a gzip member of the v2 text; the key suffix names an older format and is naming only) and the one sentence of `snapshot_job.py`'s docstring that describes the write. `snapshot_job._run` and the evict hook need no change: their `with session.write_mutex:` re-enters.

- [ ] **Step 5: See them pass**, same command as Step 2.

- [ ] **Step 6: Find what else expected v1.** `pixi run -e core-dev pytest tests/api -q`. A test that inflates a stored blob and expects one JSON document is this task's to update (planning found only the one in `test_hydration.py`; `tests/api/test_storage_gcs.py:93` puts its own legacy blob and is unaffected). Anything else red is a finding: stop and report.

- [ ] **Step 7: The fixtures do not move.** `pixi run golden-fixtures && git status --short engine/fixtures` prints nothing — the codec's default path is byte-identical.

- [ ] **Step 8: Lint.** `pixi run backend-lint`; ruff by hand on the three test files.

- [ ] **Step 9: Docs and backlog.**
  - `CLAUDE.md`, "Durable persistence", the `snapshot_codec.py` paragraph: every writer emits `encode_snapshot_v2` — one funnel, `hydration.write_snapshot`, which takes `write_mutex` itself for the whole stream (a v2 text torn by a concurrent commit would be refused by its own header counts), reads `metamodel_id` from `ModelRow` (`""` without one), writes the SESSION's digest into the header and mirrors the header onto the `Snapshot` row; `encode_snapshot` (v1) is written by no server path and read until F; the `.json.gz` suffix is naming only. Remove "NO server writer emits it yet". In the periodic-snapshot paragraph nothing changes.
  - `BACKLOG.md`, section 6, after `K-33`, in its format: `### K-34 · Decoding a v2 snapshot costs twice a v1 · open · perf · 2026-09-19` — the numbers of finding 12 (decode 1,238 → 2,360 ms, encode 858 → ≈ 1,150 ms at M), that it is paid once per cold hydration, that `_decode_v2`'s split / join / one-parse path is the suspect, and that the owner accepted it: watch, do not fix without a missed budget.

- [ ] **Step 10: Commit:** `Write every snapshot as datarover.snapshot/v2`.

---

### Task 3: The tail

**Files:**
- Create: `src/data_rover/api/replica.py`, `src/data_rover/api/routes/replica.py`, `tests/api/test_replica_tail.py`
- Modify: `src/data_rover/api/content.py`, `src/data_rover/api/schemas.py`, `src/data_rover/api/main.py`, `tests/api/test_content.py`, `CLAUDE.md`, `architecture/contracts.md`

**Interfaces:**
- Consumes: `feed.commit_event`, `content.commits_between`, the three op-kind sets.
- Produces:
  - `content.commit_tail_marks(db, project_id: str, *, after_rev: int, max_rev: int) -> list[tuple[int, bool]]` (M2).
  - `replica.TAIL_MAX_REVS = 1000`; `replica.tail_is_complete(marks: Sequence[tuple[int, bool]], from_rev: int, head_rev: int) -> bool` (M2); `replica.scope_of_ops(raw_ops: Sequence[Mapping[str, Any]]) -> list[str]` and `replica.delta_from_commit(row: Commit, prev_rev: int) -> dict[str, Any]` (M5); `replica.build_tail(db, project_id: str, from_rev: int, head_rev: int) -> dict[str, Any]` — marks first; incomplete → `{"from_rev", "head_rev", "complete": False, "deltas": []}` without loading a row; complete → `commits_between(after_rev=from_rev, max_rev=head_rev)` and one delta per row.
  - `schemas.ReplicaTailOut` — `from_rev: int`, `head_rev: int`, `complete: bool`, `deltas: list[dict[str, Any]]`. The deltas stay dicts: they are `commit_event`'s, and a second pydantic model of that shape would be a second definition of CT-2.
  - Route `GET /replica/tail` in `routes/replica.py`: `from_rev: int = Query(ge=0)` (required — a missing or negative one is FastAPI's 422); depends on `get_request_session` (so membership is checked and a cold project hydrates) and `get_db`; head by M3; `build_tail`. The router is mounted in `main.py` under `proj` with `tags=["replica"]`. It is a GET: `authz` treats it as a read, so viewers are allowed and nothing is added to `_READ_ONLY_POST_SUFFIXES`.

- [ ] **Step 1: Write the failing tests.**

  `tests/api/test_content.py`:
  - `test_commit_tail_marks_tell_expressible_rows_apart` — rows appended by hand at revs 1–6: a full one; one with `entity_states=None` (stored as JSON `null`); one whose `entity_states` is then set to SQL NULL (`update(...).values(entity_states=null())`); one with `state_digest=None`; one with `to_metamodel_id` set (needs a `MetamodelRow`); one with only `from_metamodel_id` set. Marks: `[(1, True), (2, False), (3, False), (4, False), (5, False), (6, False)]`. The range bounds are honoured (`after_rev` exclusive, `max_rev` inclusive), another project's rows never appear. This is the test that pins fact 2; its docstring says so in one line.

  `tests/api/test_replica_tail.py` — pure tests of `tail_is_complete` first (no app): contiguous and expressible → true; empty marks with `from_rev == head_rev` → true; a missing first, middle or last rev → false; one inexpressible mark → false; `head_rev - from_rev == TAIL_MAX_REVS` → true and one more → false; `from_rev > head_rev` → false. And of `scope_of_ops`: one raw op per family and the mixes, `[]` → `["model"]`, `metamodel.rebind` alone → `["model"]` is NOT asserted (a rebind row never reaches `delta_from_commit`; say so in a comment and leave it unspecified).

  Then the route, with a fixture as in Task 2 (upload, so a baseline marker and a v2 snapshot exist at `R0`) and a helper `_tail(client, from_rev)`:
  - `test_a_tail_delta_is_the_feed_event_of_its_commit` — the central test. With the feed open (`client.websocket_connect(feed_url())`, as `test_commit_delta.py` does), land through `POST /commits`: a model commit (creates, a relationship, an update of a property holding a float and a nested dict whose keys are NOT sorted); a commit that deletes an element with children (cascade ids in `deleted_*`); a commit that creates and deletes a temp element (it appears in `deleted_element_ids`, `before` and `after` both null); a commit that deletes an element and creates it again under an `id` hint (`recreated_element_ids`); an artifact-only commit; a view-only commit; a `metamodel.move_node`-only commit; one mixing model and artifact ops. The commits are lock-verified: reuse the conftest's `commit_create`, `create_folder_via_commit`, `container_lock_target` and the lock helpers of `tests/api/test_commits_route.py` rather than writing new ones. Collect every event whose `type` is `commit` as JSON (artifact, lock and presence events pass by). Then `_tail(R0)`: `complete` is true, `head_rev` is the session's, and `deltas` equals the collected events, in order, as whole dicts. Equality of whole dicts is the point: shape, entity order, property key order, `scope`, `prev_rev` and `state_digest` are all held to the feed at once.
  - `test_ops_and_undo_rows_are_in_the_tail` — `/model/ops` and `/model/undo` are silent on the feed; their tail deltas carry the `prev_rev`, `state_digest` and `recreated_*` their `OpsResponse`s carried, and `changed_*` equal to the responses'.
  - `test_the_tail_from_head_is_empty_and_complete`.
  - `test_a_tail_from_the_middle_starts_there` — `from_rev = head - 1` gives exactly the last delta, its `prev_rev == from_rev`.
  - One test per incomplete case, each asserting `complete is False`, `deltas == []`, `from_rev` echoed and `head_rev` right: `…_across_a_baseline` (a second upload; ask from before it); `…_across_a_commit_over_the_entity_states_cap` (monkeypatch `data_rover.api.commit_states.ENTITY_STATES_MAX` to 1); `…_across_a_row_older_than_the_digest` (null the row's `state_digest` by SQL); `…_across_a_rebind`; `…_across_a_bump_with_no_row` (a legacy `POST /model/elements`, which calls `touch_model`) — both with the hole LAST in the range (nothing landed since: only the session's head reveals it, D5) and with a commit after it; `…_past_the_revision_cap` (monkeypatch `data_rover.api.replica.TAIL_MAX_REVS` to 2, land three); `…_from_beyond_head`. And the complement of each where it exists: asked from AFTER the offending revision, the tail is complete again.
  - `test_an_incomplete_tail_loads_no_rows` — monkeypatch `content.commits_between` to raise; an incomplete tail still answers.
  - `test_the_head_is_read_under_the_write_mutex` — hold `session.write_mutex` in the test thread, fire the request from a worker thread, see that it has not answered after a short wait, release, see it answer. (The pattern, if `tests/api` has one for `GET /model/issues`, is to be reused; if it has none, this is it.)
  - `test_tail_requires_from_rev` (422 missing, 422 negative); `test_a_viewer_may_read_the_tail`; `test_a_non_member_may_not` (403).

- [ ] **Step 2: See them fail.** `pixi run -e core-dev pytest tests/api/test_content.py tests/api/test_replica_tail.py -q`. Expected red: the marks test (no such function) and ALL of `test_replica_tail.py` at import (`data_rover.api.replica` does not exist).

- [ ] **Step 3: Implement** `commit_tail_marks`, then `replica.py` (M2, M5, `build_tail`), then `ReplicaTailOut`, the route (M3) and the mount. `replica.py`'s module docstring says what a tail is for and names the one rule: a range is served whole or not at all.

- [ ] **Step 4: See them pass.** If `test_a_tail_delta_is_the_feed_event_of_its_commit` fails on a VALUE (a number's form, a key's order) rather than on shape, do not normalize either side in the test: the feed and the journal disagree about an entity, which is a finding — report it with the two values.

- [ ] **Step 5: Lint.** `pixi run backend-lint`; ruff by hand on the two test files.

- [ ] **Step 6: Docs.**
  - `architecture/contracts.md`, CT-2, the tail bullet: "`complete` is `false`, and `deltas` empty, when any revision in range cannot be expressed as a delta — a baseline, a commit whose `entity_states` or `state_digest` is missing, a metamodel rebind, a `model_rev` bump with no journal row — when more than 1,000 revisions separate `from_rev` from head, or when `from_rev` is beyond head. `head_rev` is the session's `model_rev`, the one the feed reports." (The commit-in-flight order that spec §10 also lists for CT-2 is plan 4's.)
  - `CLAUDE.md`: a new bullet group "Replica routes (`api/replica.py`, `routes/replica.py`)" after "The commit delta (CT-2)", for now holding the tail: what it returns, M2's single rule and its SQL trap (one sentence: a `None` in a JSON column is JSON `null`), M3, M5's "built through `commit_event` from the raw `entity_states`", and that `/model/ops` and `/model/undo` rows, silent on the feed, are served here.

- [ ] **Step 7: Commit:** `Serve the commit tail a replica catches up by`.

---

### Task 4: The descriptor and the blob

**Files:**
- Create: `tests/api/test_replica_snapshot.py`
- Modify: `src/data_rover/api/replica.py`, `src/data_rover/api/routes/replica.py`, `src/data_rover/api/schemas.py`, `CLAUDE.md`

**Interfaces:**
- Consumes: Task 1's `latest_snapshot(format=)` and `get_snapshot`; Task 2's `write_snapshot`; Task 3's `commit_tail_marks` and `tail_is_complete`.
- Produces: `replica.pick_snapshot(db, project_id: str, head_rev: int) -> Snapshot | None` (M4); `schemas.SnapshotDescriptorOut` — `rev: int`, `metamodel_id: str`, `state_digest: str`, `elements: int`, `relationships: int`, `url: str`; routes `GET /replica/snapshot` (M4) and `GET /replica/snapshots/{rev}`.
- The blob route: `content.get_snapshot`; 404 `no v2 snapshot at rev N` when there is no row OR the row's `format` is not `"v2"` (a v1 blob is nothing a replica can open); `store.get(row.key)`, a `KeyError` → the same 404; `Response(content=blob, media_type="application/gzip", headers={"Cache-Control": "no-store"})`. Starlette derives `Content-Length` from the body. No `Content-Encoding`, ever. It needs no `Session` — depend on `require_membership` directly, as the non-hydrating routes do, so downloading a blob never hydrates a project.
- The descriptor's `url` (D6): `request.url.path.removesuffix("/snapshot") + f"/snapshots/{rev}"`.

- [ ] **Step 1: Write the failing tests.** Fixture as in Task 3; helpers `_descriptor(client)`, `_snapshot_revs()` (the project's `Snapshot` rows), and a store double that counts `put` calls.
  - `test_the_descriptor_names_the_newest_v2_snapshot_head_is_reachable_from` — baseline at `R0`, two commits: `rev == R0`; no snapshot was written by the call (`put` count unchanged, rows unchanged); `metamodel_id`, `state_digest`, `elements`, `relationships` equal the row's AND the blob's header (`state_digest` is the digest AT `R0`, not the live one); `url` is `/api/v1/projects/<id>/replica/snapshots/<R0>`.
  - `test_the_descriptor_prefers_a_newer_snapshot` — after a periodic snapshot at a later rev, that one is named.
  - `test_the_descriptor_writes_one_at_head_when_none_qualifies`, parametrized over how none qualifies: only v1 snapshots (null the rows' `format`); a project set up through the deprecated `POST /model` (no snapshot at all, a hole at the start); a commit over the `entity_states` cap after the snapshot; a rebind whose forced snapshot is missing (delete its row); more than `TAIL_MAX_REVS` revisions (patched to 1); a `touch_model` hole. Each: `rev` is the session's head; a v2 row exists there; `state_digest` equals the live digest; exactly one `put`.
  - `test_the_descriptor_and_the_tail_agree` — parametrized over the same cases plus the two happy ones: `_tail(descriptor["rev"])` is `complete`, and its `head_rev` is head. This is the contract between the two routes (M2); a client that follows a descriptor must never meet an incomplete tail it could not have been told about.
  - `test_a_second_opener_writes_nothing` — two calls, one `put`.
  - `test_the_head_write_happens_under_the_write_mutex` — the probing store double of Task 2, through the route.
  - `test_the_slow_path_looks_again_before_it_writes` — make the fast path decline while the slow path can succeed: monkeypatch `replica.pick_snapshot` with a wrapper that returns `None` on its first call and delegates afterwards; no `put`.
  - `test_a_failed_head_write_is_a_503` — the store's `put` raises: 503, and `session.write_mutex` is free afterwards (acquire it non-blocking from another thread).
  - `test_no_model_no_descriptor` — 404 `No model loaded`.
  - `test_a_viewer_may_open` — a viewer's GET works, the writing case included.
  - Blob: `test_the_blob_is_the_stored_bytes` — follow `url`: 200; `content-type` is `application/gzip`; `content-length` equals the stored blob's length; `"content-encoding" not in res.headers`; `res.content` equals `store.get(key)` byte for byte and starts with the gzip magic (a client library would have inflated it had an encoding been declared — that the bytes arrive still gzipped is the proof); `cache-control` is `no-store`. `test_the_blob_inflates_to_the_descriptors_header` — the first line's fields equal the descriptor's. `test_no_blob_for_an_unknown_rev`, `test_no_blob_for_a_v1_snapshot`, `test_no_blob_when_the_store_lost_it` (row present, key deleted) — 404 each. `test_the_blob_route_hydrates_nothing` — evict, GET the blob, `get_registry().peek(project_id)` is still `None`.

- [ ] **Step 2: See them fail.** `pixi run -e core-dev pytest tests/api/test_replica_snapshot.py -q`: all red — 404 from an unknown route, or `AttributeError` on `replica.pick_snapshot` for the one that patches it.

- [ ] **Step 3: Implement** `pick_snapshot`, `SnapshotDescriptorOut`, the two routes. Keep M4's four steps visible in the descriptor route as four short blocks; the comment on the slow path says why it looks again.

- [ ] **Step 4: See them pass**; then Task 3's file again (`pytest tests/api/test_replica_tail.py -q`) — the shared module moved under it.

- [ ] **Step 5: Lint.** `pixi run backend-lint`; ruff by hand on the test file.

- [ ] **Step 6: `CLAUDE.md`.** Complete the "Replica routes" group: the descriptor (M4, and why one candidate suffices), that it is a viewer-allowed GET that can fill a cache under `write_mutex` (≈ 1.15 s at M plus the upload, *measured*), the blob route (CN-11's rule, `no-store`, non-hydrating, stands in for F's signed URL: the descriptor's `url` is all a client follows), and that a v1 row is invisible to both.

- [ ] **Step 7: Commit:** `Serve the snapshot a replica opens from`.

---

### Task 5: `X-Metamodel-Id`

**Files:**
- Create: `tests/api/test_metamodel_id_header.py`
- Modify: `src/data_rover/api/routes/metamodel.py`, `src/data_rover/api/main.py`, `CLAUDE.md`

**Interfaces:**
- Produces: `GET /metamodel` answers the same document with an `X-Metamodel-Id` response header: `ModelRow.metamodel_id`, or `""` when the project has no `ModelRow` (or the row no id). The route gains `project_id: str`, `db: DbSession = Depends(get_db)` and `response: Response`; it stays lock-free (D8). `CORSMiddleware` gains `expose_headers=["X-Metamodel-Id"]`.

- [ ] **Step 1: Write the failing tests.**
  - `test_the_header_names_the_bound_metamodel` — equals `ModelRow.metamodel_id`; the body is unchanged (equal to what the route returned before, i.e. to `POST /metamodel`'s answer).
  - `test_the_header_pairs_with_the_descriptor_and_the_snapshot` — header == descriptor's `metamodel_id` == the blob header's `metamodel_id`.
  - `test_the_header_follows_a_rebind` — after a `metamodel.rebind` commit it is the commit row's `to_metamodel_id`, and so is the new descriptor's.
  - `test_the_header_is_empty_without_a_model_row` — a metamodel installed on the session directly (`get_session().set_metamodel(...)`, no route, no row): the header is present and `""`.
  - `test_cors_exposes_the_header` — a request with an allowed `Origin`: `access-control-expose-headers` contains `X-Metamodel-Id`.

- [ ] **Step 2: See them fail** — all five: no such header.

- [ ] **Step 3: Implement.** Four lines in the route, one argument in `main.py`.

- [ ] **Step 4: See them pass**; then `pixi run -e core-dev pytest tests/api -q -k metamodel` — the route's other users are untouched.

- [ ] **Step 5: Lint**; ruff by hand on the test file.

- [ ] **Step 6: `CLAUDE.md`.** One sentence in the "Replica routes" group: `GET /metamodel` carries `X-Metamodel-Id` so a client can pair the document with a descriptor; read lock-free, a rebind between the two reads is healed by the `rebind_event` the client is already buffering.

- [ ] **Step 7: Commit:** `Name the metamodel a document belongs to`.

---

### Task 6: Verify the whole, and bring the branch home

**Files:** `architecture/program.md`.

- [ ] **Step 1: `architecture/program.md`**, B's row in the table and its status line: plan 2 built — v2 snapshot writers, the descriptor, blob and tail routes, `X-Metamodel-Id`.

- [ ] **Step 2: Every suite, every linter.**

```bash
pixi run dr-test
pixi run dr-tidy true
pixi run golden-fixtures
git status --short
```

Expected: core pytest green with the tests this plan added and none lost (2,465 before it); frontend vitest and engine vitest unchanged (2,493 in 252 files; 272 in 39 files) — this plan touches neither; every linter clean; `git status` shows `architecture/program.md` alone.

- [ ] **Step 3: The migration against a database that has rows.** `pixi run -e core-dev pytest tests/api/test_alembic.py -q` — all pass, `test_migration_0016_adds_snapshot_format_columns` among them. On a deployed Postgres the columns arrive with `pixi run db-upgrade`; existing rows keep NULL and read as v1, and each project's first replica open writes its first v2 snapshot.

- [ ] **Step 4: By hand, once** (needs the dev stack; say in the hand-back if it was skipped). Against the dev Postgres: `select cast('null'::json as varchar) = 'null', cast(null::json as varchar) is null;` must answer `t, t` — M2's expression on the database production runs. Then `pixi run backend-start`, open a project, `curl` the descriptor with a session cookie, follow `url` with `curl -sD - -o snap.gz`, check the headers, `gunzip -c snap.gz | head -c 200`.

- [ ] **Step 5: Commit** `Mark the replica routes built`, then, with the owner's go-ahead:

```bash
git switch engine-migration
git merge --ff-only feat/replica-routes
```

---

## Known limits

- A complete tail is bounded in revisions (1,000), not in bytes: 1,000 commits of up to `ENTITY_STATES_MAX` entities each would be a response larger than the snapshot it spares. Nothing produces such a history today; if one appears, the cure is a second bound on the marks (a summed entity count), not a change of shape.
- A project whose newest snapshot is v1 pays one synchronous v2 write at its first replica open (≈ 1.15 s at M under `write_mutex`, plus the upload). There is no backfill, on purpose.
- The legacy direct-mutation routes and the deprecated `POST /model` leave holes no tail can cross; the descriptor heals them with a snapshot at head, recorded at a `rev` ahead of `models.model_rev` — the dead-row case `snapshot_job.py`'s docstring already describes.
- The server's `_decode_v2` accepts a line holding two documents where the engine refuses it; no writer emits one. Still unlogged, as before this plan.

## After this plan

Plan 3 (the engine service: CT-4 dispatcher, scheduler, sliced index build and digest check, the reads) is written once this one has landed. What it and plan 4 inherit:

- The three routes and their exact answers are in `CLAUDE.md`'s "Replica routes"; CT-2's tail bullet is current. The descriptor's `state_digest` is the digest AT the snapshot's `rev` — the one `openSnapshot` adopts — not the live one.
- `head_rev` of a tail is the session's `model_rev`, the same number the feed's reconnect `snapshot` event reports, so "the tail brought me to `head_rev`" and "the feed says head is N" can be compared directly.
- A tail delta is `commit_event`'s dict, `type: "commit"` included; rebinds never appear in a tail — a range holding one is incomplete.
- The shell's MSW handlers (plan 4) can be fed from a real v2 snapshot of smart-city written by `import_project` and read back through the blob route's own code path.
- MR-3 freezes `routes/read.py`'s route functions from the start of plan 3 (spec §4).
- Open: `K-32` (plan 3's), `K-29`, `C-20` in `BACKLOG-ENGINE.md`; `K-33`, `K-34` in `BACKLOG.md`.
