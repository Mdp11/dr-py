# Multi-User Collaborative Architecture — Design

**Date:** 2026-06-16
**Status:** Design approved (pending spec review) → implementation planning
**Scope:** Evolve data-rover from a localhost single-user tool into a deployed multi-user
collaborative MBSE engine for **one organization, ~100–1000 users, on GCP**.

---

## 1. Problem & framing

The tool currently relies on YAML/JSON files for metamodel/model/view, served by a single
process-wide `Session` singleton that holds the whole model (~80 MB) in memory, mutated in
place with no locks, with rev-based conflict detection explicitly *not suitable for deployed
multi-user*.

**Key reframe:** the file format is **not** the primary blocker. The blockers are:
1. the **single global session** (one model, one user assumption), and
2. **disk-file persistence** (no durability, sharing, or availability for a deployment).

The `perf/large-model-overhaul` work (delta ops, in-place mutation + inverse rollback,
incremental validation, paged reads, streaming I/O, op-log/undo) is **reused, not discarded** —
it turns out to be most of a collaborative server already. The op-log/delta protocol is
simultaneously the write path, the broadcast payload, the edit history, the batch unit, and the
undo/revert engine.

## 2. Requirements (from brainstorming)

- **Collaboration model:** concurrent editing of shared models, **pessimistic locking acceptable**
  (Cameo/Capella-style check-out → edit → check-in).
- **Deployment:** single organization, ~100–1000 users, **GCP**. Not a multi-tenant hyperscale SaaS.
- **Editing model (user-specified, simpler):** **no continuous sync.** A user:
  1. locks one or more resources,
  2. edits them **locally** (no backend traffic),
  3. **commits** — pushed to the server, which updates the model.
- **Commits** carry author, date, revision, an optional **message**, and a **validation-error count**.
- **Metamodel experimentation:** keep the same model, **swap the metamodel** to test a new one.
- **Validation never blocks a commit** (conformance tier); user is informed of the error count and
  may continue or review.
- **Relationship creation UX:** the frontend offers only metamodel-valid relationship types by
  default (with an escape hatch), and grays out (not hides) options that would exceed multiplicity.

## 3. Chosen approach — A: in-memory engine + durable journal

Two approaches were weighed:

- **A — model lives in RAM (per open project); Postgres is the durable journal.** Reuses the entire
  engine; complexity goes into *routing* (project→instance affinity). Memory scales with number of
  **open models**, not users.
- **B — model lives in the DB; stateless app servers.** Trivial HA/horizontal scale; but rewrites
  IndexSet/validators/traversals as SQL, pays DB latency per op, and re-introduces stateful tiers
  (WebSocket hubs, pub/sub) the moment real-time push + locks are added.

**Decision: A.** At single-org scale the workload is *many users on few shared models* — A's sweet
spot. B's only real wins (idiomatic cross-instance optimistic concurrency, no affinity) are the
things least needed here, bought by rewriting the engine just built. A is **not a dead end toward
B**: because the in-memory session is a cache over a durable log, hot data can later move to the DB
or shard across instances incrementally.

## 4. System topology (GCP)

```
Browser (SPA) ── company SSO (via auth seam) ── ownership-aware router/ingress
                                                      │ routes project X to its owner
                              ┌───────────────────────┴───────────────────────┐
                              │  Backend instances (GKE, stateful)              │
                              │   each OWNS a subset of open projects;          │
                              │   holds ProjectSession(s) in RAM + WS hub       │
                              └───┬───────────────────┬──────────────────┬─────┘
                                  │                   │                  │
                          Memorystore (Redis)   Cloud SQL (Postgres)    GCS
                          • ownership leases     • users/projects/roles  • model snapshots
                          • locks / presence     • commit journal (hist) • large blobs
                          • pub/sub (handoff)    • metamodel blobs, views
                                                 • per-project model_rev
```

- **Compute → GKE, stateful.** Cloud Run's request-scoped, scale-to-zero model fights the long-lived
  in-memory hub + WebSocket connections.
- **Cloud SQL (Postgres)** — durable source of truth for everything except the hot in-memory model.
  (AlloyDB is a later swap if read load demands it.)
- **GCS** — periodic full-model snapshots (existing streaming serializer).
- **Memorystore (Redis)** — coordination plane: ownership leases, locks/presence, pub/sub fan-out
  (only during ownership handoff; steady-state fan-out is in-process).
- **Auth — pluggable seam, NOT a hard-wired provider** (company auth is non-Google, currently
  unknown protocol). The backend trusts a verified identity and exposes one interface:
  `IdentityProvider → (user_id, email, groups)`. Satisfiable by either a **header-injecting gateway**
  (reverse proxy speaking OIDC/SAML) or an **in-app OIDC/SAML client**. *Open integration point:*
  confirm whether company SSO is OIDC / SAML / LDAP / gateway. Authorization (who-can-do-what) is
  ours, in Postgres; authentication is delegated through the seam.

**The one genuinely new distributed-systems piece** is *ownership/affinity*: a project is owned by
exactly one instance at a time (single-writer hub), recorded as a TTL lease in Redis; the router
sends all of that project's traffic to its owner. Phases 1–6 run on a single instance where
ownership is trivial; this piece switches on only at Phase 7 (HA / second instance).

## 5. Domain model (Postgres)

- **`Metamodel`** — standalone, **versioned, shareable** resource. `{id, name, version, blob, ...}`.
  Immutable per version (core already treats `Metamodel` as frozen); a "new metamodel" is a new
  version row, never a mutation. Shareable across many models.
- **`Model`** — `{id, name, metamodel_id, ...}`. The `metamodel_id` binding is a **swappable pointer**.
- **`Project`** — `{id, name, ...}` bundling **one model + N views**. The metamodel comes *through* the
  model's binding, not nailed to the project. **Ownership/affinity is per-project.**
- **`Membership`** — `{project_id, user_id, role}`, role ∈ `owner | editor | viewer`. The authorization
  table; maps directly to editor/viewer cohorts.
- **`commits`** — see §7 (journal == commit log).
- **`snapshots`** — `{project_id, rev, gcs_uri, ts}`.

### Metamodel swap (the experimentation requirement)

- **Sandbox validation — non-destructive, ephemeral.** Validation is **read-only over the model**, so
  on the owning instance run a *second* validation pipeline bound to the candidate metamodel over the
  *same live in-memory model* — no copy, no lock, not journaled — and return a **conformance diff**
  (`now_failing[]`, `now_passing[]`, unchanged counts). Scope for v1: **read-only conformance report**.
  An editable throwaway branch is deferred (YAGNI).
- **Rebind — durable, journaled.** Change the model's `metamodel_id`; recorded as a normal commit
  (in history, revertible). May land with outstanding conformance issues (engine "stays inspectable"
  philosophy); a follow-on migration/cleanup pass is out of scope here.
- Supersedes the current destructive `session.set_metamodel()` (which clears the model — a single-user
  assumption).

## 6. Runtime — `Session` singleton → `SessionRegistry`

```
SessionRegistry (per backend instance)
  get(project_id)  -> ProjectSession   # hydrate on cache-miss (init-once guarded), reuse if warm
  evict(project_id)                     # idle timeout / LRU / graceful handoff (under write-mutex)

ProjectSession (today's Session, scoped to one project)
  metamodel, model, view(s), validation baseline, model_rev, op_log(hot window)
  + connected_clients   (WS hub set)
  + lock_table          (held resource leases)
  + write_mutex         (serializes commits/preview for this project)
```

- `get_session()` everywhere → `registry.get(project_id)`; project_id arrives on the request and is
  authorized against `Membership` before the session is touched.
- **Hydration on cache-miss:** load nearest GCS snapshot + replay commit-journal tail (uses existing
  streaming loader + `build_model_from_dicts` fast path).
- **Eviction:** idle projects (no connected clients for T) are snapshotted and dropped from RAM →
  keeps "80 MB × *actively-connected* models" bounded.
- **Unchanged:** `Model` mutation boundary, `IndexSet`, validation pipeline, delta-ops, paged reads,
  streaming serialize — reused verbatim, per-project.

## 7. Editing model — lock → edit-locally → commit

### Flows

```
OPEN     GET /projects/X/open
         authz(membership) → registry.get(X) → {model_rev, summary, role}
         client holds a read-snapshot + subscribes to the commit feed (WS)

LOCK     POST /projects/X/locks { targets[], intent }
         server expands lock scope (rules below), checks conflicts,
         grants leases (TTL + heartbeat), broadcasts lock state → { lock_tokens }

EDIT     purely local; client mutates its copy of the locked objects; NO server traffic.
         new elements get tmp_ ids (existing temp-id → id_map mechanism).

PREVIEW  POST /projects/X/commits/preview { ops }          (mandatory, automatic before commit)
         server apply → validate dirty set → ROLL BACK
         → { conformance_error_count, issues[], structural_blockers[] }
         structural_blockers → must fix (rare; UI prevents them arising)
         conformance_error_count > 0 → UI: "N validation errors  [Commit anyway] [Review]"

COMMIT   POST /projects/X/commits { base_rev, ops, message, lock_tokens, ack_errors }
         a. verify caller still holds required locks            → 409 if lost
         b. hard structural check vs current model              → 422 if violated (safety net)
         c. apply in-place, collect inverses, incremental validate (soft issues recorded)
         d. persist ONE commit row {rev, commit_id, author, ts, message,
                                    ops, inverse_ops, id_map, validation_error_count, issues}
         e. model_rev += 1
         f. BROADCAST {rev, ops, commit_meta} to cohort  (one-way live refresh)
         g. release locks (commit = finalize + unlock), broadcast release
         → { rev, commit_id, id_map, validation_result }

REFRESH  others apply the committed batch to their local read-view (readers see the change).
ABANDON  POST /projects/X/locks/release → discard local edits, free locks.
```

`base_rev` is checked **once, at commit** — the continuous-sync / 409-rebase machinery is gone from
normal editing. The only live downstream traffic is the one-way commit feed.

### History & revert (one level — commit == revision)

Because there is no frequent sync, **a commit is the unit of revision**: one commit = one op-batch =
one journal row. The two-level (revision/commit) model collapses.

```
commits   (project_id, rev PK, commit_id, author_id, ts, message,
           ops, inverse_ops, id_map, validation_error_count, issues)
snapshots (project_id, rev, gcs_uri, ts)   -- full model to GCS every K commits / on commit
```

- `model_rev` == latest commit's `rev`. History = `SELECT ... ORDER BY rev` per project.
- **Revert to commit N** = apply inverse_ops of every commit after N, newest-first (existing
  `restore_element` / `restore_relationship` reinstate exact ids). Revert is **itself a new commit**.
- **Multi-user revert caveat:** reverting an old commit whose objects a later commit also touched needs
  a policy — v1: revert requires locking the affected objects first (plays by normal edit rules).
- Cold-start / eviction-safe: hydrate = nearest snapshot + replay commit tail.

## 8. Locking (resource leases)

**Mechanics:** a lock is a TTL lease (held in the session, mirrored to Redis for visibility/recovery),
renewed by client heartbeat; expiry → auto-release + broadcast. **Steal** allowed (peer/admin) with a
warning; a displaced holder's uncommitted local edits become a conflict to re-apply or discard.

**Two lock strengths:**
- **Exclusive** (write) — at most one holder.
- **Shared pin** (read) — many concurrent holders; blocks *deletion* of the pinned object.

**Lock-scope rules per op (decision: 1c):**

| Operation | Required lock scope |
|---|---|
| `set_property(E)` | exclusive **E** |
| `create` free-floating element | none (not yet shared); tmp id until commit |
| `create` element under parent P (containment) | exclusive **P** |
| `connect` relationship A→B | exclusive **A** (source) + **shared pin on B**; B existence guaranteed by pin |
| `delete` element E | exclusive **E + entire containment subtree**; incident relationships removed with it |
| `delete` relationship A→B | exclusive **A** (source) |

Rationale for 1c: MBSE has **hot shared targets** (`TypedBy` → few type elements, shared library
blocks). Locking the target exclusively on every connect would serialize the most common modeling
action. The shared pin guarantees the target can't vanish (closes the delete race) while letting many
editors connect concurrently. Trade-off accepted: **target-side multiplicity** can't be lock-protected
under concurrent connects → it surfaces as a soft flag at commit.

## 9. Validation policy — three tiers

| Tier | Examples | At commit |
|---|---|---|
| **Structural corruption** | pointer to non-existent id; cycle in containment; two parents; instance of unknown/abstract type | **Prevented** — impossible-state / client-protocol bug. 422 safety net. Normal users never see one (pins + frontend prevent them). |
| **Conformance errors** | endpoint-type mismatch, uniqueness collision, multiplicity, facets | **Counted, never blocks.** Surfaced pre-commit (user continues/reviews); count + issue list stored on the commit. |
| **Clean** | — | commits silently |

- **Endpoint typing is soft** (structure is sound; only the schema rule is violated). Kept soft for
  consistency with the rest of the pipeline **and** because the metamodel-swap workflow must be able to
  *hold* type-mismatched edges — making connect-time typing a hard reject would contradict that.
- **Optional project-level "strict mode"** promotes a configurable set of soft issues (typing
  especially) to hard rejects, for shops wanting the model to never go non-conforming.
- Pre-commit validation is **mandatory and automatic** (the PREVIEW step) so the user always sees the
  error count before committing.

## 10. Frontend metamodel-driven editing UX

- **Filtered relationship picker (default):** offer only relationship types whose metamodel `mappings`
  allow (source type → target type), respecting inheritance. **Escape hatch** ("show all" / gated on
  strict-mode) preserves the flexibility soft-typing exists to provide.
- **Multiplicity gray-out (bonus):** relationship types that would exceed multiplicity are **grayed
  out, not hidden**, with an explanatory tooltip (uses counts from the read API).
- **Mechanism:** ship the (small, immutable) metamodel to the client and compute connection rules
  locally — instant UI, fewer round-trips, also powers "what can I create under this parent" and
  property editors. Fallback if a metamodel ever grows large:
  `GET /metamodel/connections?source_type=S&target_type=T`.
- The backend remains soft regardless; the UI filter is a guardrail (defense in depth), not enforcement.

## 11. Concurrency & threading

A project is owned by exactly one instance → all of X's concurrency is **in-process**; no distributed
write locks.

- **Resource lease** (§8, minutes) vs **write-mutex** (internal, milliseconds) — keep distinct.
- **Writes (commit) serialized** per project via the write-mutex; commits are infrequent → near-zero
  contention.
- **Preview also takes the write-mutex** (applies → validates → rolls back; fast, O(edited set)).
- **Reads are concurrent & lock-free** — mutations replace values wholesale (never in place), so a
  reader always sees a coherent before-or-after value (existing streaming-download semantics).
- **Validator-sharing footgun eliminated by construction:** one pipeline per `ProjectSession`, only
  ever entered under the write-mutex; reads use cached `ValidationState`, not the pipeline.
- **Cross-project parallelism is full** — independent sessions/mutexes/pipelines.
- **Guard two races:** cold-open double-hydration (init-once guard in the registry); evict-during-commit
  (eviction takes the write-mutex + verifies zero clients / no in-flight commit).

## 12. Phasing & migration

Everything through **Phase 6 runs on a single GKE instance** (a few GB RAM holds the active projects —
sufficient for 100–1000 single-org users). **Phase 7** (the only hard distributed piece) is deferred
until a second instance is needed, and adds a routing layer **without rewriting** anything (session =
cache over durable log).

| Phase | Delivers |
|---|---|
| **1. Session registry** | Un-singleton `Session` → `SessionRegistry` keyed by `project_id`; routes carry project_id |
| **2. Tenancy + auth seam** | `User`/`Project`/`Membership` in Postgres; `IdentityProvider` seam (dev/header provider now, company SSO later); authorize per membership |
| **3. Durable persistence** | Commit-journal + GCS snapshots replace file load/save; hydrate-on-open, evict-on-idle; per-project `model_rev` |
| **4. Check-out/commit + locking** | Resource leases (exclusive + shared-pin), client-side local-edit staging, mandatory pre-commit validation, commit (message + error count), lock-scope rules. **First real collaborative release.** |
| **5. Realtime feed** | WS one-way commit feed, presence, lock badges |
| **6. Metamodel-driven UX** | Ship metamodel to client; filtered relationship picker + multiplicity gray-out + escape hatch; sandbox validate + rebind |
| **7. HA / horizontal scale** | Redis ownership leases + affinity routing + graceful handoff (add 2nd instance) |
| **8. History & revert** | Commit-history browser, revert-to-commit, optional strict-mode |

**Data migration:** extend the existing migration CLI with a one-time **importer**:
`(metamodel.yaml + model.json + view.json)` → create `Metamodel` + `Project` + initial commit
(`rev 0`, *"Initial import"*) + snapshot. Existing artifacts become a project's first commit.

**Testing:** mirror tests into `tests/<area>/` per existing convention; Phase 4 (commit/lock) and
Phase 6 (connection-rules) get the heaviest coverage.

## 13. Open questions / follow-ons

1. **Auth protocol** — confirm company SSO: OIDC / SAML / LDAP / header-gateway (decides the seam impl).
2. **Project granularity** — confirmed: project = 1 model + N views; metamodel bound via the model and
   swappable/shareable.
3. **Editable metamodel-swap branch** — deferred (sandbox is read-only for v1). Revisit if needed.
4. **Multi-user revert conflict policy** — v1 requires locking affected objects; richer 3-way merge later.
5. **Strict-mode** — exact set of promotable soft issues TBD with users.
6. **Uncommitted local-edit durability** — optional client-side persistence (IndexedDB) to survive a
   browser crash; YAGNI for v1.
7. **Metamodel migration/cleanup** after a stricter rebind — deferred to §14.

## 14. Future: Metamodel Evolution (deferred — NOT in v1)

These two capabilities are the two halves of *"evolve the metamodel of a live model safely."* Both are
explicitly **out of v1 scope**; captured here so v1 doesn't preclude them. They should be designed as a
single later feature, against observed real-world metamodel-change patterns.

**v1 line (what ships):** read-only sandbox validation (§5) + journaled rebind (§5) + **manual,
validation-guided cleanup** — surface the conformance issue list well (e.g. "37 elements of type T
missing required property P") with jump-to navigation, and let users fix via normal lock→edit→commit.
This already satisfies "test a new metamodel against an existing model, then adopt it."

```
1. Sandbox (read-only)   see what a new metamodel breaks          ← v1
2. Editable branch       fix it in isolation, fully validate      ← deferred (B)
3. Cleanup / migration   the transforms that do the fixing        ← deferred (A, levels 2–3)
4. Adopt                 rebind mainline + apply (replace > merge)
```

### A. Metamodel cleanup after a stricter rebind

A data migration driven by the **v1→v2 metamodel diff** (computable, since `Metamodel` is structured &
immutable per version). The diff both *explains* each issue and *generates suggested transforms*.

Break categories: new required property; datatype narrowed; facet tightened; multiplicity tightened;
type/property renamed; type removed/made-abstract; relationship mapping removed/narrowed; new uniqueness key.

Levels: **(1)** manual validation-guided *(v1)*; **(2)** assisted transforms from the diff, applied as one
large journaled, revertible commit ("Migrate to v2"); **(3)** a first-class `MetamodelMigration
{from, to, transforms[]}` artifact — authorable, reviewable, **dry-runnable via the sandbox**, then applied.

Constraints: **rename detection is the hard part** → require explicit rename declarations, not heuristics.
Transforms run through the `Model` mutation boundary (journaled/validated/reversible — a migration is just
a big commit). A model-wide migration needs an **exclusive project-wide lock** (gated admin op). Partial
conformance is acceptable (reduce the error count, leave the rest flagged).

### B. Editable sandbox branch

A divergent, independently-editable copy of the model (a `ProjectSession` forked from a base rev + candidate
metamodel, with its **own commit journal**; `commits`/`snapshots` gain a `branch_id`, mainline = default
branch). Lets a user *fix* against a candidate metamodel in isolation, then discard or adopt.

**Architectural caution:** this system deliberately chose **locking to avoid merge**. A long-lived editable
branch reintroduces three-way graph merge through the back door. To preserve the no-merge principle, anchor
adoption on **replace-on-adopt** — because metamodel migrations are rare, coordinated, org-level events,
"this branch becomes mainline; everyone reload" eliminates merge entirely and is likely sufficient. Fallbacks
if finer control is needed: short-lived + freeze-on-adopt; rebase-branch-onto-main; scope branch to a subtree.
