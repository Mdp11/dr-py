# System

The target system. Rationale lives in [decisions.md](decisions.md); wire formats in
[contracts.md](contracts.md); limits in [constraints.md](constraints.md).

## What runs where

```
 APP ORIGIN  (UI, login cookie)                   SANDBOX ORIGIN  (static files only, strict CSP,
┌──────────────────────────────┐                  no network, no credentials, separate site)
│ Svelte UI                    │   MessagePort   ┌─────────────────────────────────────────────┐
│ lib/api ──► engine client    │◄───────────────►│ engine worker: the one replica, the working │
│ shell: fetches snapshot,     │  bytes, deltas  │   copy, all evaluation and validation       │
│  tail, feed; caches snapshots│────────────────►│        ▲ synchronous bridge (shared memory) │
└──────────────┬───────────────┘                 │ script workers ×N: Pyodide + facade + user  │
               │ HTTPS + WebSocket               │   Python; they hold no model                │
               ▼                                 └─────────────────────────────────────────────┘
 THIN SERVER (FastAPI): auth, tenancy, locks, commit check, journal, feed, artifacts, views, metamodel
   ├─ Postgres: head rows + journal + tenancy
   ├─ GCS: gzip snapshots, handed out as signed URLs
   └─ HEADLESS HOST (Node + the same engine + Pyodide), scales to zero; serves CI exports
```

## Rules

1. **The engine lives in the sandbox origin**, beside the script workers (AD-5). The sandbox
   page embeds as a cross-origin iframe; the UI talks to the engine worker over a transferred
   `MessagePort`.
2. **The sandbox never touches the network** (CN-17). The shell fetches; the sandbox computes.
   Snapshot bytes cross as transferred `ArrayBuffer`s.
3. **One replica per tab, in one dedicated engine worker** (AD-16). Script workers read through
   the bridge (CT-6) and hold no model.
4. **The engine never blocks.** Script workers block on the bridge; the engine awaits script
   results asynchronously and keeps serving UI reads and bridge reads meanwhile. Evaluations
   and background work — opening, the index build, the digest check — run in chunks that
   yield to the event loop and are cancellable. Engine state MUST be consistent at every
   yield point, so a transition — stage, unstage, rebase, delta apply — is atomic and never
   yields (AD-23). Budgets: CN-3.
5. **Writes are server-authoritative.** Locks and commits go over HTTPS. Committed state enters
   the replica only as a snapshot or a delta (CT-1, CT-2); the engine never derives committed
   state from its own ops.
6. **Every evaluation reads the working copy** unless it asks for committed state (CT-5).

## Responsibilities

| Component | Owns | Never |
|---|---|---|
| UI (app origin) | Rendering, staged-edit UX, lock UX, downloads | Computes over the model |
| Shell (app origin) | Snapshot/tail/feed transport, IndexedDB snapshot cache keyed `(project, rev)`, re-bootstrap | Parses or evaluates |
| Engine worker | Replica, working copy, indexes, navigation, search, tables, exports, validation, rules, compare, script cell cache | Opens a connection; sees a credential |
| Script workers | Running user Python against the facade | Hold model state; outlive their wall timeout |
| Thin server | Identity, authorization, leases, commit check, journal, feed, snapshots, artifact/view/metamodel rows, payload schema checks | Loads a model; evaluates; trusts client-supplied inverses or `entity_states` |
| Headless host | One export per request, byte-identical to the browser's | Calls out; holds a credential; reuses a process across runs |

## Flows

**Open.** Shell connects the feed and buffers deltas → asks the server for the snapshot
descriptor → takes the bytes from its cache or the signed URL → transfers them to the engine,
which inflates, parses and indexes while bytes arrive → shell fetches the tail from the
snapshot's `rev` → engine applies tail, then buffered deltas (duplicates drop by `rev`) →
replica is `ready`. A `complete: false` tail, a `prev_rev` gap or a digest mismatch at any
time discards the replica and restarts this flow (CT-2, CT-3).

**Read.** UI → `lib/api` function → engine client → engine → working copy. No network.

**Edit.** UI acquires leases from the server as today → hands ops to the engine → engine
applies them to the working copy, records inverses, emits `changed`.

**Commit.** Engine validates the working copy locally (this replaces `POST /commits/preview`)
→ UI sends `POST /commits` with `base_rev`, ops, lock tokens, message and the client's
validation result → server runs the commit check and answers with the delta and `id_map` →
engine rewinds staged ops, applies the delta, remaps temp ids, replays what is left (CT-5).

**Peer commit.** Feed delta → engine, same path as the commit response.

**Rebind.** A `rebind_event` carries no delta. The shell re-bootstraps the replica at the new
`rev` with the new metamodel; the server forces a snapshot at every rebind.

**Script evaluation.** Engine assigns cells to script workers → each worker runs the facade,
reading through the bridge → results land in the engine's cell cache with their read-sets →
later deltas and staged ops evict by read-set.

**Browser export.** Engine renders bytes → transfers them to the UI → UI triggers the download.

**Headless export.** CI calls the server → server authorizes, gathers snapshot bytes, tail,
metamodel and the export's artifact closure → sends them to the headless host → returns its
bytes to the caller.

## Thin server (end state)

- **Head tables.** `elements` and `relationships`: id, type, JSONB properties, per-entity
  `rev`, insertion sequence (preserves CT-1 order). Indexes on relationship source and target.
  `entity_refs` holds element-valued property references, maintained per commit.
- **Commit check — O(batch), one transaction.** A row lock on the project's `ModelRow`
  serializes commits. The server loads the partial model (touched entities, deleted subtrees,
  incident relationships, ancestor chains, referencers), runs the existing op applier and the
  structural checks on it, writes changed rows, updates the digest, inserts the `Commit` row,
  broadcasts the delta. Revert and undo take the same path.
- **O(model) work that remains**, none of it in server memory: snapshot job (streams head rows
  in sequence order inside a repeatable-read transaction); import (line-by-line ingest, then
  set-based SQL structural checks); metamodel rebind (the same set-based checks, plus an
  `entity_refs` rebuild).
- **Kept from the Python core:** `core/model`, `core/metamodel`, the structural validators,
  payload schemas (artifact kind adapters, rules parse) and the pure-AST snippet lint with its
  entry-point derivation. The snippet `lint` and `format` routes read no model and stay.

## Headless host (end state)

Node service, same engine package, same Pyodide version, concurrency 1, scale-to-zero,
callable only by the thin server. Inputs arrive in the request; isolation per CN-20.

## Current → target

| Today | Target |
|---|---|
| `Session`: model in server RAM, `IndexSet`, trigram index, hydration | Replica in the engine; no server session; no trigram index (AD-13) |
| Read routes: element pages, tree, search, neighborhoods | Engine |
| Tables, navigation, validation, rules, exports, compare/apply-CR, save/download, metamodel diff, history Compare | Engine |
| `WasmScriptRunner`, script sweeps, server cell cache, `pending` cells, 202 retries | Script workers + engine cell cache; synchronous results |
| `GET /model/issues`, `GET /model/status`, `POST /commits/preview` | Engine-local |
| Commits, locks, feed, journal | Stay; the commit check reads head rows |
| Snapshots encoded from the live model | Snapshots streamed from head rows |
| Auth, tenancy, admin, projects; artifact, view and metamodel rows | Unchanged |
