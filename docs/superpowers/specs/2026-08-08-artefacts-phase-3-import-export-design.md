# Artefacts revamp Phase 3 — Import/export closure (backend slice)

Date: 2026-08-08
Status: approved (brainstorm 2026-08-08)
Parent spec: `2026-07-29-artefacts-revamp-design.md` (Phase 3 section)

## Scope

Backend only. The export preview UI and the import upload/confirm dialog are a
separate follow-up slice (Phase 2 precedent: backend slice first, then its own
frontend design doc). This slice delivers:

1. Bundle format `datarover.artifact-bundle/v1` + export with dependency closure.
2. Stateless two-request import: plan → user decisions → one journaled commit.
3. `clone_project` / `importer.import_project` carry artifacts (fixes the
   silent artifact drop + dangling view refs).
4. Importer CLI `--artifacts` and project-creation multipart `artifacts` part.

Decisions fixed during brainstorm:

- **Backend first** — no frontend work in this slice.
- **Clash = (kind, name)**, matching the DB `uq_artifact_project_kind_name`
  constraint. Payload-aware default: propose `reuse` when the payload is
  identical after ref-normalization, else `copy` with a deduped name.
- **No view ops on import** — imported artifacts appear only in the flat
  artifacts list, never auto-placed in the view tree. The bundle format carries
  no placement data.
- **Stateless protocol** — the client re-sends the bundle at confirm; the
  server stages nothing between the two calls (bundles are KB-scale).

## Bundle format & export

New module `src/data_rover/api/artifact_bundle.py` with the pydantic schema:

```json
{
  "format": "datarover.artifact-bundle/v1",
  "exported_at": "<ISO-8601 UTC>",
  "source_project": {"id": "...", "name": "..."},
  "roots": ["<artifact id>", ...],
  "artifacts": [{"id": "...", "kind": "...", "name": "...", "payload": {...}}]
}
```

Payloads carry their own `schema_version` internally — that is the versioning
seam on import; the envelope version only governs the envelope.

- `POST /projects/{pid}/artifacts/export` body `{root_ids: [...]}` → BFS
  closure over `ArtifactKindSpec.extract_deps` (visited-set, cycle-safe).
  Dangling refs are tolerated: the ref stays in the exported payload, the
  missing target simply isn't in the bundle. Unknown `root_ids` are likewise
  tolerated — reported in `dangling_refs` and skipped; an all-unknown request
  yields an empty bundle, not an error. Unregistered-kind rows ARE exportable
  (deps via the generic `extract_refs` walk, which needs no spec) — filtering
  unknown kinds is import's job, not export's. Returns the bundle as a JSON
  download (`Content-Disposition: attachment`); KB-scale, no streaming.
- `POST /projects/{pid}/artifacts/export/preview` — same closure walk, metadata
  only: `{artifacts: [{id, kind, name}], dangling_refs: [...]}`.
- Both join `authz._READ_ONLY_POST_SUFFIXES` (viewers may export).

## Import plan — `POST /projects/{pid}/artifacts/import/plan`

Body = the bundle. Response = resolution plan. The plan is advisory; nothing is
written.

- **Hard 422** only for a malformed envelope: unparseable JSON, missing/wrong
  `format` tag, schema-invalid envelope (pydantic body validation — the same
  status every other invalid body gets in this API).
- **Tolerant-skip** for per-artifact issues, reported as
  `skipped: [{bundle_id, reason}]`: unregistered kind (`diagram`,
  `diagram_kind`, anything unknown), or a payload its kind's adapter rejects.
  A skipped artifact never fails the plan or the rest of the bundle.
- **Clash detection**: an existing artifact in the target project with the same
  `(kind, name)`.
- **Payload-aware proposal**: build the tentative map
  `{bundle_id → existing_id}` from every (kind, name) match in the bundle,
  rewrite the bundle payload's refs through it via `rewrite_refs`, then
  canonical-JSON-compare against the existing payload. Identical → propose
  `reuse`; different → propose `copy` with a server-proposed deduped name
  ("Name (2)", first free suffix). Re-importing an unchanged bundle therefore
  proposes all-reuse (near-idempotent).
- Plan entry: `{bundle_id, kind, name, action: "create" | "reuse" | "copy",
  existing_id?, copy_name?}` (`create` = no clash).

## Import confirm — `POST /projects/{pid}/artifacts/import`

Body = `{bundle, decisions: {bundle_id: action}, copy_names?: {bundle_id:
name}, message?}`. Decisions may override proposals (e.g. flip a proposed
`copy` to `reuse`).

- **Re-derive the plan server-side**; if any decision no longer holds (reuse
  target deleted, a `create`/`copy` name now clashing), answer **409 with the
  fresh plan in the body** — the stale-base posture commits already have.
- **Op batch**: one `CreateArtifactOp` per `create`/`copy` decision, with
  `temp_id = TEMP_ID_PREFIX + bundle_id` and payload refs pre-rewritten via
  `rewrite_refs` using `{bundle_id → TEMP_ID_PREFIX + bundle_id}` for created
  siblings and `{bundle_id → existing_id}` for reused ones. The existing
  applier (`artifact_ops.py` — temp-id → fresh uuid + `_resolve_json`)
  resolves the rest; **zero new resolution machinery**. `copy` uses the
  decided/proposed copy name. Reused artifacts get **no op** (never modified).
- **No leases**: the batch is exclusively fresh-id creates (the existing
  temp-id rule in `required_locks`).
- **Lands through `create_commit`**: the handler synthesizes a `CommitIn`
  (message defaults to `Imported N artifacts from <source name>`) and calls
  `create_commit` directly with resolved dependencies — one journaled commit,
  diffable (`GET /commits/{rev}/diff` renders it journal-only), undoable
  (`POST /model/undo` compensating commit), feed event `scope: ["artifact"]`,
  `_CommitUnwind` failure handling for free.
- **Empty batch guard**: an all-reuse/all-skipped import returns a no-op
  response WITHOUT calling `create_commit` — the never-send-an-empty-batch
  rule is absolute, even though import holds no leases to orphan.
- Response: `{rev, created: [{bundle_id, id, name}], reused: [{bundle_id,
  existing_id}], skipped: [{bundle_id, reason}]}` (`rev` null on no-op).

## Clone fix + baseline import

- `importer.import_project` gains `artifact_bundle: str | None`. When present:
  insert `ArtifactRow`s at the rev-0 baseline with fresh uuids, build the
  id-map, rewrite refs in artifact payloads AND in the view blob with the same
  map (fixes the dangling view refs). Baseline artifacts are rows only — no
  journal entries — consistent with materialized-heads hydration (replay skips
  artifact ops anyway).
- `clone_project` builds an internal bundle = closure over ALL source
  artifacts (same export code path) and passes it to `import_project`. One
  remap implementation, no bespoke clone logic. Unregistered-kind artifacts in
  the source (legacy `diagram` rows, if any) ride along untouched — clone is a
  copy, not a validation gate; only *import from outside* filters kinds.
  (If closure-over-all + tolerant copy conflict in implementation, prefer
  copying every row verbatim with id remap — clone must never lose data.)
- CLI: `python -m data_rover.api.importer --artifacts bundle.json` (optional).
- Project-creation multipart (`routes/projects.py` create): optional
  `artifacts` part, same parameter.

## Error handling & authz summary

| Condition | Response |
|---|---|
| Malformed bundle envelope (plan/confirm/export input) | 422 (pydantic) |
| Unknown kind / adapter-invalid payload in bundle | skip + report, 200 |
| Dangling refs at export | tolerated, reported in preview |
| Stale decisions at confirm | 409 + fresh plan |
| (kind,name) race at apply (peer created same name between re-check and apply) | the applier's `_ClashTracker` 422s; confirm catches it → 409 + fresh plan (no `IntegrityError` can be reached) |
| DB failure after in-memory apply | existing `create_commit` 500 + rollback |
| Viewer calls import | 403 (method-based write detection, unchanged) |
| Viewer calls export/preview | 200 (read-only allowlist) |
| `/commits/revert` across an import commit | existing 409 (artifact ops) |

## Testing (hermetic SQLite conftest; no frontend tests this slice)

- **Closure**: chains, diamond deps, ref cycles, dangling refs; preview and
  export agree on the closure set.
- **Plan**: no-clash → create; clash + identical-after-rewrite → reuse; clash
  + different payload → copy with deduped name; unknown-kind and
  invalid-payload skips; malformed envelope 400.
- **Confirm**: happy path = one commit (single rev bump, feed
  `scope: ["artifact"]`, sibling refs → fresh uuids, reuse refs → existing
  ids); commit-diff renders it; undo reverts it; no-op import writes no
  commit; 409 on stale decisions and on the IntegrityError race; viewer 403 on
  import, 200 on export/preview; revert-across-import 409 pinned.
- **Clone**: artifacts carried with remapped ids; view blob refs rewritten
  (regression test for today's silent-drop bug); baseline artifacts survive
  evict + rehydrate.
- **CLI/multipart**: `--artifacts` and multipart round-trip.
- Registry contract tests (`tests/api/test_artifact_kinds.py`) already pin
  `extract_deps`/`rewrite_refs` per kind — extended only if the walk changes
  (it shouldn't).

## Out of scope

- Frontend export preview / import confirm UI (follow-up slice).
- Bundle folder placements / view recreation on import (declined at brainstorm).
- Auto-placing imported artifacts in the view (declined at brainstorm — flat
  artifacts list only).
- Stateful staged import (token + server-side bundle store) — rejected
  approach; stateless re-upload chosen.
- Cross-instance concerns (Redis locks etc., Phase 7).
- Extending `datarover.cr/v1` — unchanged, per parent spec.
