# Server map for the snapshot-v2 / per-commit-delta protocol change

Repo: `/home/mdp/workspace/data-rover-py` @ `src/data_rover/api/`. All paths absolute. Router prefix for every project-scoped route is `/api/v1/projects/{project_id}` (`/home/mdp/workspace/data-rover-py/src/data_rover/api/main.py:307-328`).

---

## 1. Snapshot writers and readers

### `snapshot_codec.py` public surface — `/home/mdp/workspace/data-rover-py/src/data_rover/api/snapshot_codec.py`

| symbol | line | signature |
|---|---|---|
| `SNAPSHOT_GZIP_LEVEL = 3` | :36 | deflate level |
| `SNAPSHOT_V2_FORMAT = "datarover.snapshot/v2"` | :38 | |
| `_V2_PREFIX` | :44 | `b'{"format":"datarover.snapshot/v2"'` — the sniff prefix |
| `encode_snapshot(model: Model) -> Iterator[bytes]` | :61 | gzip member of the **compact v1 document** |
| `_v2_lines(model, project_id, rev, metamodel_id) -> Iterator[str]` | :70 | header line + `iter_entity_lines` |
| `encode_snapshot_v2(model: Model, *, project_id: str, rev: int, metamodel_id: str) -> Iterator[bytes]` | :90 | gzip member of LF-terminated JSON lines |
| `is_gzip(blob: bytes) -> bool` | :103 | |
| `_decode_v2(blob) -> dict[str, Any]` | :107 | validates line count vs header counts, one `json.loads` of `[l1,…]` |
| `decode_snapshot(blob: bytes) -> Any` | :131 | gunzip-if-magic, then v2-prefix branch, else `parse_model_json` |

v2 header keys, in this order (`:73-81`): `format, project_id, rev, metamodel_id, elements, relationships, state_digest`. Counts + digest are taken **when iteration starts**; the caller must hold `write_mutex` for the whole stream (`:96-99`).

**`encode_snapshot_v2` has ZERO production callers today.** Only `tests/api/test_snapshot_codec.py:100` and `tests/golden/scenarios/snapshot_v2.py:96`. Every writer below emits v1.

### Every ENCODE call site

| site | path:line | what |
|---|---|---|
| `hydration.write_snapshot` | `.../api/hydration.py:75-83` | the one funnel: `store.put(snapshot_key(pid, rev), encode_snapshot(session.model))` then `content.record_snapshot` |
| `hydration.persist_baseline` | `.../api/hydration.py:86-111` | `clear_history` + empty-ops `append_commit` at `session.model_rev` + `set_model_rev` + `write_snapshot` |
| periodic snapshot job `_run` | `.../api/snapshot_job.py:82-99` | takes `write_mutex`, re-checks `get_registry().peek(pid) is session`, `write_snapshot(pid, session, session.model_rev)` |
| evict hook | `.../api/session.py:527-529` (`install_persistent_registry`) | `write_snapshot(project_id, sess, sess.model_rev)` before the session is dropped |
| **rebind-forced** snapshot | `.../api/routes/commits.py:1343-1351` | `if rebound: write_snapshot(...)` else `_maybe_periodic_snapshot`; failure is logged, not 500 (`:1352-1359`) |
| importer | `.../api/importer.py:211-217` | builds a throwaway `Session`, `sess.model_rev = 0`, `write_snapshot(project_id, sess, 0)` |
| `clone_project` | `.../api/routes/projects.py:165-226` | **no direct encode** — serializes the live model with `"".join(iter_model_json(session.model))` (:193) and hands it to `importer.import_project`, which writes the rev-0 snapshot |
| upload/load baseline | `.../api/routes/model.py:198-209` (`_install_model`) → `persist_baseline` (:206) | |
| periodic trigger | `.../api/routes/ops.py:698-708` (`_maybe_periodic_snapshot`), called at `ops.py:799`, `ops.py:1067`, `commits.py:1351`, `commits.py:1679` | `if every > 0 and rev % every == 0: schedule_periodic_snapshot` |
| `schedule_periodic_snapshot` | `.../api/snapshot_job.py:55-79` | one job per session; returns `None` if one is running; `sync=None` reads `settings.snapshot_sync` |

### Every DECODE call site

- `.../api/hydration.py:245-258` — `_hydrate_session`: `get_snapshot_store().get(snap_key)` → `decode_snapshot(blob)` → `build_model_from_dicts(metamodel, raw, strict=False, on_progress=…)`.
- `.../api/hydration.py:180-181` — `reconstruct_model_at`: same, `strict=False`, throwaway model.
- No other decoder exists.

`build_model_from_dicts(metamodel, raw, *, strict=True, on_progress=None) -> Model` lives at `/home/mdp/workspace/data-rover-py/src/data_rover/api/routes/_snapshot.py:235-331`; the pydantic sibling `_build_model_from_payload` at `:148-193`.

### Blob key

`/home/mdp/workspace/data-rover-py/src/data_rover/api/storage.py:26-30`:
```python
_SNAPSHOT_KEY = "projects/{project_id}/snapshots/{rev}.json.gz"
def snapshot_key(project_id: str, rev: int) -> str: ...
```
Readers never branch on the suffix — `decode_snapshot` sniffs bytes (:24-27 comment), so legacy `.json` rows still load (`tests/api/test_hydration.py:295`).

### `Snapshot` row — `/home/mdp/workspace/data-rover-py/src/data_rover/api/db_models.py:278-291`

`project_id` (PK, FK→projects ondelete CASCADE), `rev` (PK, Integer), `key` (String, NOT NULL), `ts` (DateTime tz, default `_utcnow`). **No format/version/digest/size column.** Upsert-by-PK in `content.record_snapshot` (`.../api/content.py:208-216`); selection in `content.latest_snapshot(db, project_id, max_rev=None)` (`:219-225`) = highest `rev <= max_rev`.

### `SnapshotStore` — `/home/mdp/workspace/data-rover-py/src/data_rover/api/storage.py:33-37`

```python
class SnapshotStore(Protocol):
    def put(self, key: str, chunks: Iterable[bytes]) -> None: ...
    def get(self, key: str) -> bytes: ...
    def exists(self, key: str) -> bool: ...
    def delete(self, key: str) -> None: ...
```
Impls: `MemorySnapshotStore` (:40-59, dict-backed, `clear()` extra), `GcsSnapshotStore` (`/home/mdp/workspace/data-rover-py/src/data_rover/api/storage_gcs.py:17-69`). Seam: `get_snapshot_store()` :65, `set_snapshot_store()` :75, `build_store_from_settings()` :85.

**No signed-URL and no streaming read anywhere.** `GcsSnapshotStore.put` (:39-50) *buffers* `b"".join(chunks)` into `io.BytesIO` before `upload_from_file` (the streaming generator dies at the store boundary); `get` (:52-58) is `blob.download_as_bytes()`, `NotFound → KeyError`. The comment at `:44-49` is load-bearing: no `Content-Encoding`/`content-type` is set, so GCS must not transcode `.json.gz`. `delete`/`exists` are the only other methods. Adding a signed-URL or ranged/streaming read means a new Protocol method.

### `api/state_digest.py` in full — `/home/mdp/workspace/data-rover-py/src/data_rover/api/state_digest.py` (39 lines)

```python
def entity_hash(entity_id: str, rev: int) -> int:
    """First 8 bytes of SHA-256 over ``utf8(id) ‖ 0x00 ‖ ascii(decimal rev)``."""
    data = entity_id.encode("utf-8") + b"\x00" + str(rev).encode("ascii")
    return int.from_bytes(hashlib.sha256(data).digest()[:8], "big")

def format_digest(value: int) -> str:
    return f"{value:016x}"                      # 16 lower-case hex digits

def model_digest(model: Model) -> str:
    value = 0
    for element in model.elements.values():
        value ^= entity_hash(element.id, element.rev)
    for rel in model.relationships.values():
        value ^= entity_hash(rel.id, rel.rev)
    return format_digest(value)
```
Elements and relationships share one id namespace (:20-22). Empty model → `"0000000000000000"`. **Only consumer today: `snapshot_codec._v2_lines:80`.** No route, no `Commit` column, no feed event carries a digest.

### `serialize.iter_entity_lines` — `/home/mdp/workspace/data-rover-py/src/data_rover/api/serialize.py:190-208`

```python
_LINE_ENCODER = json.JSONEncoder(separators=(",", ":"), ensure_ascii=False, allow_nan=False)

def iter_entity_lines(model: Model) -> Iterator[str]:
    encode = _LINE_ENCODER.encode
    for entity in _element_dicts(list(model.elements.values())):
        yield encode(entity)
    for entity in _relationship_dicts(list(model.relationships.values())):
        yield encode(entity)
```
No line terminator; byte-identical to that entity's text inside `iter_model_json_compact`; entity SETS are snapshotted at iteration start, entity objects read live (same semantics as `iter_model_json`, :102-132). Key order comes from `_element_dicts` (:78-85) = `id, type_name, properties, rev` and `_relationship_dicts` (:88-99) = `id, type_name, source_id, target_id, properties, rev`.

---

## 2. Per-entity `rev`

### Where it lives

- `Element` — `/home/mdp/workspace/data-rover-py/src/data_rover/core/model/element.py:8-13`: `@dataclass(slots=True)` with `rev: int = 0`.
- `Relationship` — `/home/mdp/workspace/data-rover-py/src/data_rover/core/model/relationship.py:8-15`: same, `rev: int = 0`.

### What bumps it — exactly two places in the whole core

- `Model.set_property` — `/home/mdp/workspace/data-rover-py/src/data_rover/core/model/model.py:91` → `target.rev += 1`.
- `Model.delete_property` — `.../core/model/model.py:118` → `target.rev += 1`, but **only if the key is present** (`:115-116` early-returns with no bump, JSON-merge-patch semantics).

Everything else starts at 0 and never touches `rev`:
- `create_element` :34, `restore_element` :53, `connect` :128, `restore_relationship` :155 all construct with the dataclass default `rev=0`.
- `delete_element` :210 / `disconnect` :168 pop the entity.
- `build_rebind_view` :214-233 aliases the same entity objects (no copy, no rev change).

The one place that writes an explicit rev: `apply_change_request` — `/home/mdp/workspace/data-rover-py/src/data_rover/core/model/change_request.py:240-245` and `:255-262` set `rev=current_rev + 1` on a *modified* entity regardless of how many properties changed, and `_copy_element`/`_copy_relationship` (:65, :76) carry `rev=e.rev`. **Not reachable on a live session today** — `POST /model/apply-cr` (`/home/mdp/workspace/data-rover-py/src/data_rover/api/routes/change_request.py:179-212`) is a dry run returning `ProposeCrResponse`; it never calls `set_model`. (The `create_commit` staleness docstring at `commits.py:770` and `:901` still claims CR-apply replaces the model — stale comment.)

`rev` is explicitly ignored for CR identity matching (`core/model/change_request.py:81`, `:284`) and for conflict detection generally (`routes/ops.py:55-58`).

### Where it is serialized

| surface | path:line |
|---|---|
| v1 snapshot / compact doc | `serialize.py:84` (`"rev": e.rev`), `:98` (`"rev": r.rev`) — same dicts feed `iter_model_json`, `iter_model_json_compact`, `iter_entity_lines` |
| `/model/save`, `GET /model/download` | `routes/model.py:322`, `:367` via `iter_model_json` |
| `ElementOut` / `RelationshipOut` | `schemas.py:43`, `:74` (`rev: int = 0`); `from_core` is `cls(**asdict(...))` :47, :78 |
| `GET /model`, `GET /commits/{rev}/model` | `ModelOut.from_core` `schemas.py:85-92` |
| legacy element/relationship API | `routes/elements.py:33,42,59`, `routes/relationships.py:26,37` |
| all read routes | `routes/read.py` — `ElementPage`, `NeighborhoodOut`, `RelationshipPage`, `/model/elements/batch`, `POST /model/search`. **Not** in `TreeItem` (`schemas.py:50-59`: only `id, type_name, display_name, child_count`) |
| `OpsResponse.changed_*` / `CommitResponse` | `schemas.py:658-659` |
| `commit_event` payload | `routes/commits.py:1372-1379` / `:1690-1697` — `ElementOut.from_core(...).model_dump()`, so `rev` rides the feed |
| `Commit.entity_states` | `commit_states.py:51-52` `_dump` → `ElementOut.model_dump(mode="json")`, rev included |
| load surfaces | `_snapshot.py:168` (`rev=e.rev`), `:189`, `:221-225` `_optional_rev` (rejects bool, requires int, default 0), `:289`, `:320` |

### Is it restored on hydration replay?

**The snapshot half is exact.** `encode_snapshot` writes `rev`; `build_model_from_dicts` reads it back via `_optional_rev` (`_snapshot.py:221-225`, used at `:289` / `:320`). A snapshot-only hydrate is rev-identical.

**The replay half is exact *for journaled ops*, and only for those.** `replay_commits_into` (`hydration.py:114-131`) feeds each commit's model ops to `_apply_batch(model, ops, restore=True)`; artifact/view/metamodel ops are skipped (`:124-129`). The journaled `canonical_ops` are the resolved forward ops (`ops.py:291-295`, `:323-325`), so a replayed create does `restore_element` (rev 0) + one `set_property` per property — **the same count as the live path** (`create_element` rev 0 + one `set_property` per property, `ops.py:262-296`), and a replayed update does the same number of set/delete calls. So journaled work replays rev-for-rev.

**Everything that moves the live model WITHOUT a journal row makes the live `rev`s diverge from a rehydrated replay.** Sources, all confirmed in code:

1. **K-30 rollback drift (the big one).** Any apply-then-rollback on the live session leaves updated entities at `rev + 2` and deleted-then-restored entities at `rev = len(properties)` and at the END of the dict. Full enumeration in §5. A snapshot taken *after* the drift bakes it in; a hydrate from an *earlier* snapshot + replay does not reproduce it. Digest over `(id, rev)` therefore differs.
2. **Legacy direct routes.** `routes/elements.py:25-32` (create + `set_property` loop), `:52-58` (patch), `:68-69` (delete); `routes/relationships.py:35-36`, `:46-47`. These go through `Model` methods (so `rev` bumps) and then only `session.touch_model()` — no `Commit` row. Hydration cannot reproduce them at all (the entity change is lost entirely, not just its rev).
3. **`restore_element`/`restore_relationship` reset `rev` to 0.** Undo (`ops.py:917`), revert (`commits.py:1615`) and rollback all recreate through them (`model.py:39-56`, `:138-163`). For undo/revert this IS journaled (a compensating forward commit), so replay reproduces it — but it means **`rev` is not monotonic per entity id** and can go down.
4. **Snapshot-vs-journal rev accounting.** `_persist_commit` returns `False` when the project has no `ModelRow` (`ops.py:623`), so for an in-memory-only project every `/model/ops`, `/commits`, `/commits/revert`, `/model/undo` bumps `session.model_rev` with no row at all.
5. `snapshot_job`'s own docstring flags the mismatch: a job waking after a `touch_model()` can record a `Snapshot` row at a rev **ahead of `models.model_rev`** (`snapshot_job.py:24-29`); it is never selected because `latest_snapshot(max_rev=model_row.model_rev)`, but the blob is orphaned.

**Bottom line for a `(id, rev)` digest:** the server's `rev` is a per-entity *property-write counter*, not a state version. It survives a snapshot exactly, it survives journaled replay exactly, and it drifts on preview/rollback, legacy routes, and restore-mode recreation.

---

## 3. Commit delta today

### `commit_event` — `/home/mdp/workspace/data-rover-py/src/data_rover/api/feed.py:118-153`

```python
def commit_event(*, rev, scope: list[str], commit_id, author_id, message,
                 validation_error_count, changed_elements: list[dict],
                 changed_relationships: list[dict], deleted_element_ids: list[str],
                 deleted_relationship_ids: list[str]) -> dict:
    return {"type": "commit", "rev", "scope", "commit_id", "author_id", "message",
            "validation_error_count", "changed_elements", "changed_relationships",
            "deleted_element_ids", "deleted_relationship_ids"}
```
`scope` ∈ `{"model","artifact","view","metamodel-layout"}`, sorted, never empty (falls back to `["model"]`, `commits.py:1384-1389`). **No `prev_rev`, no `base_rev`, no digest, no `id_map` on the wire event.** Other builders: `snapshot_event` :107 (`type, model_rev, locks, connected`), `lock_event` :156, `presence_event` :160, `rebind_event` :169 (`type, rev, from_metamodel_id, to_metamodel_id, validation_error_count` — header only, deliberately no delta), `view_event` :186, `artifact_event` :195.

`FeedHub.broadcast` (:79-89) is non-blocking (`loop.call_soon_threadsafe`), safe under `write_mutex`; a client whose bounded queue (`settings.feed_queue_max`) overflows is drained, sent `CLOSE_SENTINEL` and unregistered (:91-101) — it must re-open from scratch.

### `CommitResponse` — `/home/mdp/workspace/data-rover-py/src/data_rover/api/schemas.py:990-1008`, extends `OpsResponse` (:650-668)

`OpsResponse`: `model_rev`, `id_map`, `changed_elements: list[ElementOut]`, `changed_relationships: list[RelationshipOut]`, `deleted_element_ids: list[str]`, `deleted_relationship_ids: list[str]`, `issues_removed_owner_ids`, `issues_added: list[IssueOut]`, `issue_counts: dict[str,int]`.
`CommitResponse` adds: `commit_id`, `message`, `validation_error_count`, `changed_artifacts: list[ArtifactHeaderOut]`, `deleted_artifact_ids`, `view_revs: dict[str,int]`, `rebound: bool`, `to_metamodel_id: str | None`.

### How `changed_*` / `deleted_*` are computed

In `_BatchResult` (`/home/mdp/workspace/data-rover-py/src/data_rover/api/routes/ops.py:162-223`): four **ordered sets** (dict-of-`None`) in **first-touch op application order**, kept disjoint by `mark_element_changed` (:191, pops from deleted) / `mark_element_deleted` (:199, pops from changed) and the relationship twins (:195, :203). Cascade IS included: `DeleteElementOp` (`:329-379`) computes `containment_closure(model, eid)` **before** deleting, then per closure element walks `sorted(outgoing_ids)` then `sorted(incoming_ids)` into an ordered `removed_rel_ids` dict (:337-343); every closure element is `mark_element_deleted` and every removed rel `mark_relationship_deleted` (:375-378). Deterministic order = closure-walk order, then sorted rel ids (`schemas.py:660-661` documents it).

Serialization: changed entities are read from the **post-batch live model** (`ElementOut.from_core(model.elements[eid])`) in `_finalize` (`ops.py:555-570`), `create_commit` (`commits.py:1372-1379` for the event, `:1445-1453` for the response) and `revert_commit` (`:1690-1697`, `:1717-1725`).

### Every broadcaster of a commit-like event, and every journal writer

| writer | path:line | writes `Commit` row? | broadcasts? |
|---|---|---|---|
| `POST /commits` | `routes/commits.py:740` | yes, `_persist_commit` :1284 (with `_entity_states`, `_from/_to_metamodel_id`) | **full delta** `commit_event` :1406-1419 — **unless `rebound`**, then `rebind_event` :1397-1404 (header only, no delta, "peers reload"). Plus `broadcast_artifact_events` :1420 and `lock_event("released")` :1424 |
| `POST /commits/revert` | `routes/commits.py:1468` | yes, `_persist_commit` :1658 | **full delta** `commit_event` :1698-1713, `scope=["model"]` (artifact/view/metamodel reverts 409 first, :1536, :1550, :1568) |
| `POST /model/ops` | `routes/ops.py:711` | yes, `_persist_commit` :773 | **NOTHING.** No `hub.broadcast` call on this path at all |
| `POST /model/undo` | `routes/ops.py:803` | yes, compensating forward commit `_persist_undo_commit` :1038 | **artifact events only** (`broadcast_artifact_events` :1072). **No `commit_event`** — peers never learn the model changed |
| `hydration.persist_baseline` | `hydration.py:86-111` | yes — `clear_history` then an **empty-ops** row at `session.model_rev` | nothing |
| `importer.import_project` | `importer.py:156-166` | yes — rev-0 empty-ops row, `commit_id="import"` | nothing |
| legacy `POST/PATCH/DELETE /model/elements`, `POST/DELETE /model/relationships` | `routes/elements.py:19,45,62`, `routes/relationships.py:29,40` | **no** | nothing |
| `POST /metamodel` (upload) | `routes/metamodel.py:51-99` | **no** — `clear_history` :96 + `set_model_rev` :97 only | nothing |
| `DELETE /metamodel` | `routes/metamodel.py:130-139` | **no** | nothing |
| `POST /model/load`, `POST /model/upload` | `routes/model.py:212`, `:254` → `_install_model` :175-209 | yes, via `persist_baseline` :206 (empty-ops marker) | nothing |
| `POST /model`, `PUT /model/snapshot`, `DELETE /model` | `routes/model.py:107,140,160` | **no** | nothing |
| views CRUD | `routes/views.py:80,111,178` | no | `view_event` :107, :174, :205 (header `{id,name}`) |
| legacy artifacts CRUD | `routes/artifacts.py:192,237,256` | no | `artifact_event` header-only |
| locks | `routes/locks.py:117,132`; sweeper `main.py:163` | no | `lock_event` |
| feed connect | `routes/feed.py:101` / `:90,:116` | no | `snapshot_event` (`model_rev`, `locks`, `connected`), `presence_event` |

### Paths that bump `session.model_rev` WITHOUT writing a `Commit` row

Every `model_rev` mutation in the codebase (`grep "model_rev [+-]="`): `session.py:255` (`set_model`), `session.py:279` (`touch_model`), `ops.py:757`/`:989`, `commits.py:1206`/`:1639` (the four journaled bumps), and the three rollback decrements `ops.py:785`, `ops.py:1050`, `commits.py:475`.

Unjournaled bumps:
1. `Session.touch_model()` — `session.py:258-283`. Callers: `routes/elements.py:32, 58, 69`; `routes/relationships.py:36, 47`.
2. `Session.set_model()` — `session.py:239-256`. Callers: `routes/model.py:122` (`POST /model`), `:155` (`PUT /model/snapshot`), `:162` (`DELETE /model`), `:201` (`_install_model` — **this one IS accounted for**, `persist_baseline` immediately writes an empty-ops row at the new rev).
3. `Session.set_metamodel()` — `session.py:285-298` → `set_model(None)`. Callers: `routes/metamodel.py:81` (`POST /metamodel` upload), `:138` (`DELETE /metamodel`).
4. Any journaled path on a project with **no `ModelRow`**: `_persist_commit`/`_persist_undo_commit` return `False` (`ops.py:623`, `:669`) after the rev was already bumped.

`create_commit`'s staleness guard fails closed precisely because of (1)–(4): `len(tail) != session.model_rev - payload.base_rev` → 409 (`commits.py:893-905`), and an empty-ops row in the tail → unconditional 409 (`:906-924`).

---

## 4. Journal as a tail source

### `Commit` columns — `/home/mdp/workspace/data-rover-py/src/data_rover/api/db_models.py:221-275`

`project_id` (PK, FK CASCADE) · `rev` (PK, Integer) · `commit_id` (String) · `author_id` (FK users, SET NULL) · `ts` (DateTime tz, default `_utcnow`) · `ops` (JSON, canonical forward ops) · `inverse_ops` (JSON, **execution order**, apply front-to-back) · `id_map` (JSON) · `message` (Text, `""` for `/model/ops` and `/model/undo`) · `validation_error_count` (Int) · `issues` (JSON, `IssueOut` dicts) · `from_metamodel_id` / `to_metamodel_id` (FK metamodels, SET NULL; both NULL except a rebind) · `entity_states` (JSON, nullable).

**There is no `prev_rev`, no parent/commit-graph pointer, and no digest column.** Ordering is carried only by the integer `rev` (PK) — "one accepted ops batch == one revision == one journal row" (:222) — and by list order inside `ops`/`inverse_ops`.

### `entity_states` shape — `/home/mdp/workspace/data-rover-py/src/data_rover/api/commit_states.py`

```
{"elements":      {id: {"before": ElementOut|null,      "after": ElementOut|null}},
 "relationships": {id: {"before": RelationshipOut|null, "after": RelationshipOut|null}}}
```
(`:10-18`). `ENTITY_STATES_MAX = 5000` (`:36`) — cap on `len(changed_el)+len(deleted_el)+len(changed_rel)+len(deleted_rel)`.

`capture_entity_states(model: Model, res: _BatchResult) -> dict[str, Any] | None` (`:55-87`) — `model` is the **post-apply** model; `before` comes from the applier's first-touch snapshots (`_BatchResult.note_element_before` `ops.py:207-219`, which does NOT alias live property dicts). Insert order per map: all `changed_*` ids first, then all `deleted_*` ids, each in first-touch order.
`load_entity_states(raw: Mapping) -> EntityStates` (`:90-108`) → frozen dataclass `EntityStates{elements: dict[str, ElementPair], relationships: dict[str, RelationshipPair]}` (`:42-48`).

**NULL when:** over `ENTITY_STATES_MAX` (`:66-67`); rows written before the column existed (never backfilled, `db_models.py:270-272`); any writer with no model batch to capture (`_persist_commit(_entity_states=None)` default `ops.py:588` — e.g. `persist_baseline`/`importer`, which call `content.append_commit` directly with no `entity_states` kwarg, `hydration.py:100-109`, `importer.py:156-165`). An **artifact-only** `POST /commits` stores `{"elements": {}, "relationships": {}}`, not NULL (`tests/api/test_commit_states.py:292`).

Writers passing it: `ops.py:781` (`/model/ops`), `ops.py:1046` (`/model/undo`), `commits.py:1301` (`POST /commits`), `commits.py:1670` (revert).

### Journal readers

| route | handler | reads |
|---|---|---|
| `GET /commits?limit=&before_rev=` | `routes/commits.py:647-686` | `content.list_commits(db, pid, before_rev=, limit=limit+1)` (`content.py:191-205`, `rev DESC`), limit clamped `[1,200]`; → `CommitHistoryResponse{commits: [CommitSummaryOut{rev, commit_id, author_id, ts, message, validation_error_count, op_count=len(r.ops), is_rebind}], has_more}` (`schemas.py:1016-1044`) |
| `GET /commits/{rev}/model` | `routes/commits.py:689-713` | `hydration.reconstruct_model_at(project_id, rev)` → `ModelOut` (O(model)) |
| `GET /commits/{rev}/diff` | `routes/commits.py:716-737` | `content.get_commit` (`content.py:140-148`) → `commit_diff.diff_commit` |
| `GET /model/changes`, `/model/changes/summary` | `routes/read.py:616-664` | **not the journal** — the in-memory capped `session.op_log`, via `changes.compact_changes`; `complete=session.op_log_dropped == 0` |

`content.py` tail helpers: `commits_after(db, pid, rev)` :130 (rev > N, ASC), `commits_between(db, pid, *, after_rev, max_rev)` :151 (ASC, bounded), `first_rebind_after` :172, `append_commit(...)` :93-127, `clear_history` :228 (deletes commits + snapshot ROWS, **not blobs**).

### `commit_states.py` / `commit_diff.py` signatures

```python
# commit_states.py
ENTITY_STATES_MAX = 5000                                              # :36
@dataclass(frozen=True, slots=True) class EntityStates                # :42
def capture_entity_states(model: Model, res: _BatchResult) -> dict[str, Any] | None   # :55
def load_entity_states(raw: Mapping[str, Any]) -> EntityStates        # :90

# commit_diff.py  (/home/mdp/workspace/data-rover-py/src/data_rover/api/commit_diff.py)
def diff_commit(db: DbSession, project_id: str, commit: Commit) -> CommitDiffOut      # :476
def _element_diffs(states: Mapping[str, ElementPair]) -> CrElementOps                 # :231
def _relationship_diffs(states: Mapping[str, RelationshipPair]) -> CrRelationshipOps  # :244
def _states_from_models(el_ids, rel_ids, before: Model|None, after: Model|None) -> EntityStates  # :257
def _artifact_diffs(db, project_id, commit) -> CommitArtifactDiffs                    # :286
def _view_diffs(commit) -> list[ViewDiffEntryOut]                                     # :342
def _layout_moves(commit) -> list[LayoutMoveOut]                                      # :449
def _metamodel_structural(db, commit)                                                 # :321
def json_structural_diff(...)                                                         # :116
```
`diff_commit` uses `entity_states` when present, else reconstructs `reconstruct_model_at(rev-1)` and `(rev)` (`:496-506`), short-circuiting when the ops name no model entity (`:503`).

### Can a CT-2-style delta be rebuilt from one `entity_states` row?

**Yes, for a row that has it.** For each id: `after != null` → the complete post-commit entity (id, type_name, [source_id, target_id], properties, **rev**) → goes in `changed_elements`/`changed_relationships`; `after == null && before != null` → goes in `deleted_element_ids`/`deleted_relationship_ids`. Cascade victims are present (`tests/api/test_commit_states.py:106`).

Caveats you must handle:
- **NULL rows** (over-cap, pre-column, `persist_baseline`/`importer` markers) force the `reconstruct_model_at` path — two O(model) rebuilds.
- **`(before=null, after=null)` entries** exist for create-then-delete inside one batch (`tests/api/test_commit_states.py:136`). The live `CommitResponse`/`commit_event` still lists that id under `deleted_*` (it is in `res.deleted_element_ids`); a naive reconstruction from `entity_states` would also emit it as deleted, which is consistent but names an id the replica never had.
- **Ordering:** only two things are kept — (a) key insertion order within each map (changed-first-touch, then deleted-first-touch), which survives SQLAlchemy `JSON`/`json` text storage but which **no reader relies on** (`commit_diff._element_diffs:233` and `_relationship_diffs:246` both do `sorted(states)`); and (b) `Commit.rev` as the global total order. Op application order is recoverable only from `Commit.ops` / `Commit.inverse_ops` list order.
- `entity_states` does **not** record where a newly created entity landed in the model's insertion order, nor the element-vs-relationship interleaving, nor `id_map` (that is its own column).
- There is **no digest and no `prev_rev`** on the row, so a replica following the journal can only trust `rev - 1` as the implied parent (valid only because of the one-batch-one-rev invariant, which §3's unjournaled bumps break).

---

## 5. The op applier's rollback (K-30)

Known-issue text lives at `/home/mdp/workspace/data-rover-py/BACKLOG-ENGINE.md:45-56` (K-30, open, 2026-09-18), with the observed vector: `[update id-3, delete id-1, update ghost]` → 422, `id-3` at `rev` 3 instead of 1, `id-1`/`id-2` moved behind, digest `d2499a403aeabae2` → `6b1333ccfa35d720`, no commit. Also cross-referenced at `/home/mdp/workspace/data-rover-py/architecture/contracts.md:110` (CT-5.2) and `/home/mdp/workspace/data-rover-py/tests/golden/model_steps.py:13-17`.

### `_BatchResult` — `routes/ops.py:162-223`

```python
canonical_ops: list[ModelOpIn]
inverse_units: list[list[ModelOpIn]]     # one inner list per completed mutation, application order;
                                         # inner order must NEVER be reversed (delete-element inverses
                                         # recreate elements before relationships)
id_map: dict[str, str]
dirty: DirtyCollector
changed_element_ids / changed_relationship_ids / deleted_element_ids / deleted_relationship_ids: dict[str, None]
before_elements: dict[str, ElementOut | None]        # first-touch snapshot; None = did not exist
before_relationships: dict[str, RelationshipOut | None]
# methods: mark_*_changed/deleted (:191-205), note_element_before/note_relationship_before (:207-219),
#          inverse_ops() -> flat list, reversed(inverse_units) (:221-223)
```

### `_rollback` — `routes/ops.py:477-487`

```python
def _rollback(model: Model, inverse_units: list[list[ModelOpIn]]) -> None:
    scratch = _BatchResult()
    for unit in reversed(inverse_units):
        for op in unit:
            _apply_one(model, op, scratch, restore=True)
```
It replays inverse ops through the **same mutation boundary**. It never consults `before_elements`/`before_relationships`, even though the exact before-images are sitting right there in the result it was handed.

### `_apply_batch` — `routes/ops.py:496-515`

```python
def _apply_batch(model: Model, ops: list[ModelOpIn], *, restore: bool) -> _BatchResult:
    res = _BatchResult()
    try:
        for op in ops:
            _apply_one(model, op, res, restore=restore)
    except Exception as exc:
        _rollback(model, res.inverse_units)
        if isinstance(exc, (KeyError, ValueError)):
            raise HTTPException(status_code=422, detail=_error_detail(exc)) from exc
        raise
    return res
```

### `POST /commits/preview` — `routes/commits.py:510-644`

Under `session.write_mutex` (:554): optional in-memory metamodel swap (`session.metamodel`/`model.metamodel`/`model.indexes.rebuild(keep_search=True)` :566-570) → `res = _apply_batch(model, model_ops, restore=False)` (:578) → validate → **`finally: _rollback(model, res.inverse_units)` (:603, always)** → outer `finally` restores the metamodel (:611-619) and calls `session.invalidate_derived_caches()` (:624). Rev is never bumped, so the drifted model sits at the **same `model_rev`** — which is exactly why `invalidate_derived_caches` exists there (`session.py:180-217`).

### Every caller of `_rollback` / apply-then-unwind on the LIVE session model

| # | site | path:line | mutates live model in place, then undoes via inverse ops? |
|---|---|---|---|
| 1 | `_apply_batch` internal (mid-batch op failure → 422) | `ops.py:511` | **yes** |
| 2 | `POST /commits/preview` — unconditional `finally` | `commits.py:603` | **yes**, on every preview including the successful one |
| 3 | `POST /model/ops` persist failure (500) | `ops.py:784` + `model_rev -= 1` :785 + `invalidate_derived_caches()` :792 + `op_log.pop()` :793 | **yes** |
| 4 | `POST /model/undo` artifact-half failure | `ops.py:933-937` (+ `invalidate_derived_caches` :934, re-push batch) | **yes** |
| 5 | `POST /model/undo` view-half failure | `ops.py:954-960` (+ `rollback_view` per done group) | **yes** |
| 6 | `POST /model/undo` metamodel-half failure | `ops.py:982-988` | **yes** |
| 7 | `POST /model/undo` persist failure (500) | `ops.py:1049-1058` + `model_rev -= 1` :1050 | **yes** |
| 8 | `_CommitUnwind.unwind()` | `commits.py:449-489` (`_rollback` at :451) | **yes** — the shared ledger for *all* of `create_commit`'s and `revert_commit`'s failure paths |
| 8a | `create_commit` metamodel-apply failure | `commits.py:1035-1037` | via ledger |
| 8b | `create_commit` model-apply failure | `commits.py:1044-1046` | `_apply_batch` self-rolled back; ledger also unwinds the mm half |
| 8c | `create_commit` artifact-apply failure | `commits.py:1065-1071` | via ledger |
| 8d | `create_commit` view-apply failure | `commits.py:1086-1093` | via ledger |
| 8e | `create_commit` rules-recompile failure | `commits.py:1114-1116` | via ledger |
| 8f | `create_commit` **structural-blocker reject (422)** | `commits.py:1147-1157` | via ledger — the common rejection |
| 8g | `create_commit` **strict-mode conformance reject (422)** | `commits.py:1184-1194` | via ledger |
| 8h | `create_commit` **DB persist failure (500)** | `commits.py:1303-1311` | via ledger (rev decrement + `op_log.pop()`) |
| 8i | `create_commit` standalone `db.commit()` failure | `commits.py:1329-1335` | via ledger |
| 8j | `revert_commit` structural reject | `commits.py:1626-1636` (ledger built at :1619 with `model_res=res`) | via ledger |
| 8k | `revert_commit` persist failure | `commits.py:1672-1676` | via ledger |
| 9 | **`POST /model/validate` with staged ops** | `routes/validation.py:200-211` — `_apply_batch(current, model_ops, restore=False)` then `finally: _rollback(current, res.inverse_units)` | **yes — and it does NOT call `invalidate_derived_caches()`** (unlike preview `commits.py:624`). Grep confirms `invalidate_derived_caches` never appears in `validation.py`. A second, quieter K-30 site |

**NOT apply-then-unwind (verified):**
- **metamodel diff candidate** `POST /metamodel/diff` — `routes/metamodel_swap.py:72-105`: uses `build_rebind_view(model, candidate)` (`core/model/model.py:214-233`), a READ-ONLY `Model` that **aliases** `elements`/`relationships` by reference and builds a fresh `IndexSet`. No entity is mutated, no `rev` moves. (Note `POST /commits/preview` with a rebind DOES swap `model.metamodel` in place and rebuild indexes twice — but that touches no `rev`.)
- **snippet staging** — `routes/snippets.py`: runs are dry-run in the guest; the route only *records* proposed ops (`:215`, `:331`, `:343`, `:412`) and rejects artifact/view/metamodel ops (`:360-380`). Nothing is applied to the model.
- **table / nav evaluate** — `routes/tables.py` takes **no** staged-ops parameter (`EvaluateTableIn` `schemas.py:1471-1484`, `EvaluateNavigationIn` `:1399-1412` carry only `definition`/`artifact_id`/paging) and holds **no `write_mutex`** (`tables.py:3`, `:247`, `:902`). It is the *victim* of the drift, not a cause — hence `invalidate_derived_caches`' docstring (`session.py:186-213`).

### Why `rev` and dict order drift — concretely

The only `rev` writers are `Model.set_property` (`core/model/model.py:91`) and `Model.delete_property` (`:118`). The rollback re-enters both.

- **Update.** Forward `UpdateElementOp` → one `set_property`/`delete_property` per patched key → `rev += 1` each (`ops.py:308-315`). The recorded inverse is `UpdateElementOp(properties_patch=inverse_patch)` with the *prior* values (`ops.py:308-322`). Replaying it calls `set_property` again for each key → **`rev += 1` again**. Net: value correct, **`rev` +2 per touched key**.
- **Delete → restore.** `Model.delete_element` (`core/model/model.py:189-211`) does `self.elements.pop(element_id)`. The inverse unit is `CreateElementOp(temp_id=<original id>, properties=dict(e.properties))` (`ops.py:347-371`); in restore mode `_apply_one` calls `model.restore_element(op.temp_id, op.type_name)` (`ops.py:276`), which constructs a **fresh `Element` with the dataclass default `rev=0`** (`core/model/model.py:53` + `element.py:13`) and does `self.elements[element.id] = element` — a **plain dict insert, i.e. at the END of insertion order** (`model.py:54`). Then the property loop (`ops.py:289-290`) sets each property → `rev = len(properties)`. So the entity loses its history AND moves last. Identical for `restore_relationship` (`model.py:155-161`) into `self.relationships`.
- **Cascade delete.** A rolled-back subtree delete re-inserts every closure element and every incident relationship at the end, in closure-walk / sorted-rel-id order (`ops.py:337-371`) — the whole subtree's relative order is rewritten.
- **Create.** Forward create + inverse `DeleteElementOp` leaves no residue in the model (only the uuid7 id is burned; the generator is not journaled).
- **Digest consequence.** `model_digest` XORs `entity_hash(id, rev)` (`state_digest.py:32-39`), so any update (+2) or delete/restore (rev reset) after a preview flips the digest — exactly the vector in `BACKLOG-ENGINE.md:50-53`. Entity *order* does not affect the digest (XOR is commutative) but it does affect v2 snapshot line order and `iter_model_json` output, i.e. the replica's state order.

---

## 6. `GET /open`, `GET /model/status`, `GET /metamodel`

### `GET /api/v1/projects/{project_id}/open`

Handler `/home/mdp/workspace/data-rover-py/src/data_rover/api/routes/commits.py:492-507`. Calls `require_model` + `_ensure_validation_seeded` (so a cold project pays an O(model) validation seed here if none exists).
Schema `OpenResponse` — `/home/mdp/workspace/data-rover-py/src/data_rover/api/schemas.py:950-963`:
`model_rev: int`, `role: str`, `element_count: int`, `relationship_count: int`, `issue_counts: dict[str,int]`, `lock_ttl_seconds: int` (from `settings.lock_ttl_seconds`), `strict_mode: bool`. **No snapshot key, no metamodel id, no digest.**

### `GET /api/v1/projects/{project_id}/model/status`

Handler + schemas all in `/home/mdp/workspace/data-rover-py/src/data_rover/api/routes/model.py` (**not** `schemas.py`):
- `ValidationStatusOut{running: bool, done: int, total: int}` :52-55
- `HydrationStatusOut{phase: str, done: int, total: int}` :58-61
- `ModelStatusOut{state: Literal["cold","hydrating","empty","validating","ready"], model_rev: int|None, validation: ValidationStatusOut|None, hydration: HydrationStatusOut|None}` :64-68
- handler :71-104 — uses `get_registry().peek()` (never hydrates, never refreshes `last_access`), falls back to `hydration.hydration_progress(project_id)` (`hydration.py:59-60`, phases `download | parse | build | replay`, `hydration.py:40-51`).

### `GET /api/v1/projects/{project_id}/metamodel`

Handler `/home/mdp/workspace/data-rover-py/src/data_rover/api/routes/metamodel.py:102-104` — `return require_metamodel(session)`, i.e. the raw core pydantic `Metamodel` object. Exact JSON document (`/home/mdp/workspace/data-rover-py/src/data_rover/core/metamodel/schema.py:354-368`):

```jsonc
{
  "enums": { "<EnumName>": ["v1", "v2"] },                     // dict[str, list[str]]
  "elements": [ {                                              // ElementType, schema.py:96-101
      "name": "...", "abstract": false, "extends": null|"...",
      "properties": [ { "name","datatype","multiplicity":"0..1",
                        "min":null,"max":null,"pattern":null,"max_length":null } ],  // PropertyDef :22-30
      "key": null | ["..."] } ],
  "relationships": [ {                                         // RelationshipType, schema.py:104-118
      "name": "...", "abstract": false, "extends": null|"...", "containment": false,
      "source": null|"...", "target": null|"...",              // mirror of mappings[0], :120-128
      "mappings": [ {"source":"...","target":"..."} ],         // Mapping :33-37 — the source of truth
      "source_multiplicity": "0..*", "target_multiplicity": "0..*",
      "properties": [ PropertyDef, ... ] } ]
}
```

**It carries NO metamodel id and NO version.** Those live only on `MetamodelRow` (`db_models.py:143-145`: `id`, `name`, `version`, `blob`, `created_at`) and reach the client only via `CommitResponse.to_metamodel_id` (`schemas.py:1007-1008`), `rebind_event.from/to_metamodel_id` (`feed.py:169-183`), and the v2 snapshot header's `metamodel_id`. `GET /metamodel/raw` (`routes/metamodel.py:107-127`) returns `RawMetamodelResponse{blob, source: "stored"|"serialized"}` — the YAML source, still no id. `Metamodel` is treated as immutable once constructed (`schema.py:357-362`).

---

## 7. Read routes B will shadow

All under `/api/v1/projects/{project_id}`. `routes/read.py` is strictly read-only, takes **no `write_mutex`**, and never moves `model_rev` (`read.py:9-10`). `MAX_PAGE_LIMIT = 500` (`read.py:64`).

| feature | route | file:line | query params | response schema | core work | ordering / view overlay |
|---|---|---|---|---|---|---|
| element listing + fuzzy search | `GET /model/elements` | `read.py:191-274` | `type`, `q`, `limit` (1..500, def 100), `offset` | `ElementPage{items: list[ElementOut], total}` `schemas.py:783-786` | `_search_score` :151-188 / `_name_score` :128-148; candidates via `model.indexes.search_candidates(query)` (`core/model/indexes.py:254`) | no `q` → **model insertion order** (`islice(model.elements.values(), …)`, exact-type filter scans in the same order); with `q` → `hits.sort()` on `(-score, id)` i.e. score desc, id asc. `total` is pre-paging. Trigram index is a *superset* filter only, results byte-identical to the scan. **No view overlay.** |
| get one element | `GET /model/elements/{element_id}` | `routes/elements.py:36-42` | — | `ElementOut` | `Model.get_element` (`core/model/model.py:59-62`, `KeyError` → 404 via `errors.py`) | n/a. **No view overlay.** |
| batch by id | `POST /model/elements/batch` | `read.py:314-334` | body `{ids: list[str]}` | `BatchElementsOut{items}` `read.py:71-72` | — | **request order**, duplicates duplicated, unknown ids silently omitted, >500 ids → 422 |
| lite tree rows by id | `POST /model/elements/tree-items` | `read.py:345-365` | body `{ids}` | `TreeItemsOut{items: list[TreeItem]}` `read.py:341-342` | `_tree_item` :501-508 | request order, same omission rule |
| relationships of an element | `GET /model/elements/{element_id}/relationships` | `read.py:442-472` | `direction: both\|in\|out` (def both), `limit`, `offset` | `RelationshipPage{items, total}` `schemas.py:799-802` | `IndexSet.outgoing_ids` / `incoming_ids` (`indexes.py:216-222`) | **relationship id ascending** (`sorted(ids)[offset:offset+limit]`); `both` dedupes self-loops via set union; `total` pre-paging. **No view overlay.** |
| all relationships (legacy) | `GET /model/relationships` | `routes/relationships.py:11-26` | `type`, `source_id`, `target_id` | `list[RelationshipOut]` | full scan | **insertion order, unpaged** |
| containment roots | `GET /model/containment/roots` | `read.py:511-534` | `limit`, `offset` | `TreeItemPage{items: list[TreeItem], total}` `schemas.py:62-65` | `IndexSet.roots_page` / `roots_count` (`indexes.py:242-248`), backed by the maintained `roots_order: SortedPairs` (`indexes.py:133-137`) | **display_name then id ascending** — O(page + log n), no per-request sort. **No view overlay.** |
| excluded roots pool | `GET /model/containment/roots/excluded` | `read.py:550-578` | `limit`, `offset`, **`view_id`** | `TreeItemPage` | `IndexSet.iter_roots` (:250-252) + `_placed_element_ids(view)` :537-547 | same display_name/id order, filtered. **This is the ONLY read route that participates in the view overlay** — `session.views.get(view_id)`; unknown/absent `view_id` ⇒ every root is "excluded". Note `total` is computed by walking all roots (O(roots)). |
| containment children | `GET /model/elements/{element_id}/children` | `read.py:581-602` | `limit`, `offset` | `TreeItemPage` | `_containment_child_ids` :480-498 ("first containment parent wins" via `IndexSet.first_parent`, `indexes.py:234`) | sorted by `(display_name(el), id)` per request. **No view overlay.** |
| neighborhood (BFS) | `GET /model/elements/{element_id}/neighborhood` | `read.py:373-434` | `hops` (1..5, def 2), `cap` (1..500, def 60) | `NeighborhoodOut{nodes, edges, hops_by_id, truncated}` `schemas.py:789-796` | inline frontier BFS over `IndexSet` | nodes in **BFS discovery order**, per frontier node over `sorted(outgoing ∪ incoming)` rel ids; edges = both endpoints in the node set, **sorted by rel id**; `cap` is a hard node cap (further neighbors set `truncated` and are skipped, continue-not-break). Deliberately differs from the frontend's global-scan tie-break under truncation. **No view overlay.** |
| advanced / criteria search | `POST /model/search` | `read.py:282-306` | body `SearchQueryIn{target: "element"\|"relationship", criteria: list[Criterion], limit ≤500, offset}` (`api/search.py:55-59`) | `SearchResultPage{target, elements, relationships, total}` (`api/search.py:62-70`) | `api/search.run_query` :73-85 → `core/search/criteria.match_element` :261 / `match_relationship` :295 | **model insertion order**, AND over all criteria, `total` pre-paging. **No view overlay.** |
| model summary / counts | `GET /model/summary` | `read.py:111-120`, builder `model_summary(session)` :88-108 | — | `ModelSummary{model_rev, element_count, relationship_count, elements_by_type, issue_counts\|None, undo_depth}` `schemas.py:767-780` | `len(model.elements)`, `model.indexes.elements_by_type` | `elements_by_type` **sorted by type name**, exact type (no inheritance roll-up); `issue_counts=None` means "never validated"; `undo_depth = len(session.op_log)`. Also returned verbatim by `POST /model/load` and `POST /model/upload` (`routes/model.py:209`). **No view overlay.** |
| pending change set | `GET /model/changes`, `GET /model/changes/summary` | `read.py:616-664` | — | `ChangesOut` `schemas.py:805-821`, `ChangesSummaryOut` :824-833 | `changes.compact_changes(model, session.op_log)` | entities in **first-touch op-log order**, partitioned added/modified/deleted; `complete=false` once `op_log_dropped > 0` (`OP_LOG_MAX = 1000`, `session.py:37`) |

Paging determinism summary (`read.py:12-24`): the only orders that are stable across concurrent commits are the sorted ones (rel-id, display_name+id, score+id). Plain insertion order (`GET /model/elements` without `q`, `POST /model/search`) is stable only while the dict is not mutated — and §5's rollback re-inserts restored entities at the end, which visibly reshuffles those two.

---

## 8. Settings and tests

### Settings — `/home/mdp/workspace/data-rover-py/src/data_rover/api/settings.py` (env prefix `DATA_ROVER_`, `.env`; `get_settings()` :242 builds a **fresh `Settings()` per call**, no cache)

| setting | line | default | note |
|---|---|---|---|
| `snapshot_store` | :67 | `"gcs"` | `"gcs"` \| `"memory"` |
| `gcs_bucket` | :69 | `"data-rover-snapshots"` | |
| `storage_emulator_host` | :72 | `""` | non-empty ⇒ emulator + `create_bucket=True` |
| **`snapshot_every`** | :103 | **200** | `rev % every == 0` ⇒ schedule; `0` disables. Read in `ops._maybe_periodic_snapshot:706` |
| **`snapshot_sync`** | :140 | `False` | run the periodic snapshot inline under `write_mutex`; test conftest pins `true` |
| `idle_evict_seconds` | :106 | 1800 | idle sweeper snapshots + evicts; 0 disables |
| `lock_ttl_seconds` | :109 | 300 | surfaced in `OpenResponse.lock_ttl_seconds` |
| `lock_sweep_seconds` | :111 | 60 | |
| **`feed_queue_max`** | :114 | **256** | per-client `asyncio.Queue(maxsize=…)` (`routes/feed.py:95`); overflow ⇒ drop + close 4408 |
| `max_request_body_bytes` | :120 | 512 MiB | `/model/upload`, `/model/compare` |
| `validation_sweep_sync` | :130 | `False` | conftest pins true |
| `search_index_sync` | :135 | `False` | conftest pins true |
| `snippet_incremental_invalidation` | :239 | `True` | selective cell-cache eviction on the op-delta commit paths |
| `snippet_cell_cache_max` | :214 | 50 000 | read at `Session` construction |

Related non-settings constants: `SNAPSHOT_GZIP_LEVEL = 3` (`snapshot_codec.py:36`), `_COMPRESS_CHUNK_CHARS = 1 MiB` (:47), `SNAPSHOT_BATCH = 2000` (`serialize.py:140`), `iter_buffered` min 64 KiB (`serialize.py:211`), `ENTITY_STATES_MAX = 5000` (`commit_states.py:36`), `ISSUES_RESPONSE_MAX = 5000` (`routes/validation.py:31`), `OP_LOG_MAX = 1000` (`session.py:37`), `MAX_PAGE_LIMIT = 500` (`read.py:64`).

Test env pins — `/home/mdp/workspace/data-rover-py/tests/api/conftest.py:11-28`: `DATABASE_URL=sqlite://`, `SNAPSHOT_STORE=memory`, `IDLE_EVICT_SECONDS=0`, `LOCK_SWEEP_SECONDS=0`, `VALIDATION_SWEEP_SYNC=true`, `SEARCH_INDEX_SYNC=true`, **`SNAPSHOT_SYNC=true`**, `IDENTITY_PROVIDER=header`. `set_snapshot_store(MemorySnapshotStore())` :53, `install_persistent_registry()` :55, reset to `None` on teardown :63.

### Tests that exist

**Snapshot codec** — `/home/mdp/workspace/data-rover-py/tests/api/test_snapshot_codec.py`: v1 `:42-89` (gzip-member identity, roundtrip, plain indented/compact JSON bytes accepted, empty model, multi-chunk streaming, short-input `is_gzip`); **v2 `:108-196`** (`test_v2_is_a_gzip_member_of_a_header_and_entity_lines`, `..._lines_are_the_compact_documents_entities`, `..._decodes_to_the_v1_document`, `..._roundtrip_rebuilds_the_same_state` — asserts `iter_entity_lines` equality *and* `model_digest` equality :150-151, `..._empty_model_is_a_lone_header` (digest `"0000000000000000"` :159), `..._keeps_every_value_exact_and_on_one_line`, `..._decode_rejects_a_truncated_blob`, `..._decode_rejects_a_header_without_counts`).

**State digest** — `/home/mdp/workspace/data-rover-py/tests/api/test_state_digest.py`: pinned `entity_hash` vectors :31, 16-hex format :44, empty = zero :50, elements+relationships :54, order independence :61, **O(batch) XOR-out/XOR-in upkeep** :68, two ids exchanging revs :78.

**Snapshot blob shape / strictness** — `tests/api/test_storage.py` (key scheme `"projects/p1/snapshots/7.json.gz"` :16-17, memory store, seam, GCS bucket-create gating), `tests/api/test_storage_gcs.py` (fake client + a live emulator roundtrip :84), `tests/api/test_snapshot_strict.py` (strict/non-strict `build_model_from_dicts`).

**Hydration** — `/home/mdp/workspace/data-rover-py/tests/api/test_hydration.py`: `test_persist_then_hydrate_roundtrip_empty_model` :59, `..._nonempty_model` :277, `test_hydrate_contentless_project_is_empty_session` :68, **`test_hydrate_replays_commit_tail_on_top_of_snapshot` :74**, folder-id healing :122, all views loaded :156, view-op commit survives eviction :172, `test_hydrate_replay_ignores_id_hint_in_restore_mode` :223, search index built :245, **`test_snapshot_blob_is_gzip_under_the_gz_key` :265**, **`test_hydrate_loads_a_legacy_plain_json_snapshot_row` :295**, `test_reconstruct_model_at_reads_the_compressed_snapshot` :318. Also `tests/api/test_reconstruct.py` (mid-rev, survives eviction, pre-rebind metamodel), `tests/api/test_eviction.py` (idle sweep evicts + snapshots), `tests/api/test_snapshot_job.py` (async scheduling, rev-it-finds, dropped second trigger, registry-miss skip, failure logged-not-raised, route survives a failing snapshot).

**Feed / commit events** — `/home/mdp/workspace/data-rover-py/tests/api/test_feed_ws.py`: `test_connect_receives_snapshot` :42, `test_lock_acquire_broadcasts` :138, **`test_commit_broadcasts_delta_to_feed` :165**; `tests/api/test_feed_hub.py` (queue-full drop+close :47, `test_event_builders_shapes` :67); `tests/api/test_feed_session.py` (evict blocked while clients connected).

**Journal / delta** — `tests/api/test_commit_states.py` (capture semantics incl. cascade :106, create-then-delete `(None,None)` :136, over-cap NULL :185/:359, persistence from all four writers :268/:305/:335/:292), `tests/api/test_commit_diff.py`, `tests/api/test_commit_history.py`, `tests/api/test_commit_model_at.py`, `tests/api/test_commits_route.py`, `tests/api/test_commits_revert.py`, `tests/api/test_commit_conflict_backstop.py` (the empty-ops baseline marker, :303/:382), `tests/api/test_ops_persistence.py`, `tests/api/test_commit_metamodel_columns.py`.

**Rollback** — no test named for K-30; coverage is indirect: `tests/api/test_commits_route.py:75` `test_preview_does_not_mutate_model_rev` (rev only — it does **not** check `rev`s or entity order), `tests/api/test_commits_artifact_ops.py:192` `test_mixed_batch_atomic_rollback_on_artifact_failure`, `tests/api/test_commits_metamodel_ops.py:811` `test_preview_restores_schema_when_model_ops_fail_mid_preview`, `tests/api/test_tables_routes.py:338` `test_preview_rollback_invalidates_table_order_cache`, `tests/api/test_validate_staged.py` (the `/model/validate` staged path — no drift assertions), `tests/api/test_incremental_invalidation.py`, `tests/api/test_view_ops_apply.py`, `tests/api/test_ops_route.py`. **Nothing asserts that a rolled-back batch leaves `rev`s or insertion order untouched** — that is exactly the gap K-30 names, and `tests/golden/model_steps.py:13-17` works around it by running each batch on a `copy.deepcopy` of the oracle model so the drift never enters a fixture.

**Golden fixtures (the engine oracle)** — `tests/golden/scenarios/snapshot_v2.py` (a v2 text as encoded, plus `same`/`refused` variants for the decoder), `tests/golden/scenarios/ops_batches.py`, `ops_churn.py` (seeded 160-step random walk), `ops_recreate.py` (K-31's delete-and-recreate-under-own-id case, deliberately excluded from the replica test), `model_cascades.py`, `model_churn.py`, `model_indexes.py`, `model_mutations.py`; recorder `tests/golden/model_steps.py` (records `model_digest` + `iter_entity_lines` fingerprint per step), guard `tests/golden/test_fixtures_current.py`.

---

## Cross-cutting notes for the design

- `encode_snapshot_v2` and `state_digest` are already built and tested but **wired to nothing on the server**: no writer emits v2, no route or event exposes a digest, and `Snapshot` has no format column (the decoder sniffs bytes, so introducing v2 writes needs no schema change).
- `SnapshotStore` has no signed-URL and no streaming/ranged read; both impls buffer the whole blob on `put` and on `get`.
- `POST /model/ops` and `POST /model/undo` write journal rows but broadcast **no** commit event — a replica following the feed would silently miss them.
- `rebind` deliberately has **no applyable delta**: `rebind_event` is header-only and the rebind commit forces a synchronous snapshot so "the replay tail never spans a schema boundary" (`commits.py:1345-1349`).
- The per-commit "parent" today is only the implicit `rev - 1`, and §3's unjournaled `model_rev` bumps (legacy routes, metamodel upload/delete, `set_model`, no-`ModelRow` projects) break that invariant — `create_commit`'s staleness guard already fails closed on exactly those gaps (`commits.py:893-924`).
