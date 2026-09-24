# Backlog — client-engine program

Everything known but not done in the client-engine program: the move of computation into the
browser against a full model replica, with a thin server and a headless export host. The
target, its decisions and its build order live in `architecture/` (`program.md` for status);
this file holds only what is open. Everything else — the app as it runs today — stays in
`BACKLOG.md`.

**How to use it.** The rules of `BACKLOG.md` apply: stable ids, the same status vocabulary
(`open`, `in progress`, `done`, `won't do`), and an item closes in the commit that fixes it.
Ids are unique across both files — a new item takes the next free number of its letter in
either — so an id never needs to say which file it is in. The Python core is under the MR-3
freeze: a fix that touches `core/model`, `core/metamodel` or the model-op applier lands on
both sides with a fixture. `routes/read.py`'s route functions and
`routes/elements.py::get_element` left the freeze for FEATURES with B's fifth plan, when the
five read surfaces defaulted to the engine — they land in TypeScript only now; a bug there
still lands on both sides with a fixture while the server path lives (MR-1, until F).

---

## 1. Program

### R-3 · Client-engine program · `in progress`
Computation moves into the browser against a full model replica, with a thin server and a
headless export host. Source of truth: `architecture/` — decisions `AD-n`, contracts `CT-n`,
constraints `CN-n`, build order and status in `architecture/program.md`. Six sub-projects
A → F. A (engine foundation) has landed: package, value layer and golden-fixture pipeline;
Python snapshot v2 and state digest; metamodel, record-graph store, indexes and mutation
boundary; op applier and working copy; snapshot reader, the engine's own SHA-256 digest and
the benchmark at model M (`pixi run engine-bench`: open 2.3 s of the 3 s budget). B (replica
and frontend seam) is done — six plans, listed in `architecture/program.md` (exact server
state; v2 snapshot writers and the replica routes; the engine service; the sandbox site and
the shell, the replica opening and following in the background; the transport swap — the five
read surfaces default to the engine behind per-surface switches, the wait for `ready`, the
fallback notice and the retry overlay, shadow comparison in dev and e2e, and the browser
benchmark; the forked store — `staging` defaults to `engine`, the user's edits stage in the
replica's working copy, the legacy store lives behind `staging: legacy`) — and watches `K-32`.
The freeze rule (`MR-3`) covers `core/model`, `core/metamodel` and the model-op applier from
the start of A's second plan; `routes/read.py`'s route functions and
`routes/elements.py::get_element` left it for features once B's fifth plan flipped the
surfaces' defaults. C (evaluation) is next. Open after B: `K-29`, `K-32`, `K-35`, `K-36`,
`K-38`, `K-41`, `K-42`, `K-45`, `K-46`, `K-47`, `K-48`, `C-20`, `C-21` in this file; `K-33`, `K-34` in `BACKLOG.md`.
Size: very large.

---

## 2. Diagnosed issues

### K-29 · The bulk loader accepts a relationship whose id an element already holds · `open` · *2026-09-18*
`routes/_snapshot.py`'s guards keep one `seen_ids` set per kind, so `build_model_from_dicts`
loads an element and a relationship sharing an id, while the mutation boundary
(`restore_element` / `restore_relationship`) refuses exactly that and the state digest (CT-3)
folds both kinds into one namespace — a same-`rev` pair cancels out of it. The engine's
loader refuses such a snapshot (`Relationship id 'x' is already an element id`), so a project
imported with one would open on the server and not in the browser. Fix: check the other
kind's ids in `_guard_relationship`; the file is outside the MR-3 freeze.

### K-32 · The `ord` re-sort after a rewind is watched · `open` · perf · *2026-09-18*
The first ordered iteration after a rewind that put an entity back at an old `ord` re-sorts
the whole entity map: 58 ms at M against 2 ms for a plain pass, and behind a 39 ms unstage that
is 97 ms of a transition's 100 ms budget (CN-3, AD-23) — inside it, and watched. If the browser
benchmark misses, the fix is an insert in place, or a sort kept to the entities that moved.
The rest of what this item held is done: the index build, the digest check, the roots sort
and the search now run in steps, and their longest step at M is 12, 3.8 and 5.2 ms
(`pixi run engine-bench`, Node 22, medians of 3; the index build's is 8–13 ms across passes)
*(measured)* — under the 16 ms chunk, with the index build over the 8 ms slice target.
In the browser (`pixi run engine-bench-browser`, Chromium 148, WSL2, medians of 3, round
trips through the port) a 1,000-op update batch is staged in 58 ms and unstaged in 52 ms, and
the first read after it takes 0.2 ms — an update is rewound in place; the first read after
unstaging one deleted element re-sorts in 20 ms; 100 single-op batches stage in 22 ms and a
delta rebases over them in 12 ms *(measured, 2026-09-22)*.

### K-35 · The server's v2 decoder accepts a line holding two documents; the engine refuses it · `open` · *2026-09-19*
`api/snapshot_codec.py::_decode_v2` joins the entity lines with `,` and parses the lot as one
JSON array, so a line holding `{…},{…}` parses as two entities — shifting every entity after
it, and the element/relationship split with them — while only the line count is checked. The
engine's `parseLines` refuses such a line. No writer emits one, so
nothing breaks today; a hand-made or corrupted blob could hydrate on the server and fail in the
browser. Decide whether the server should refuse it too (cost: `K-34`'s decode path, the
place to change) or whether the engine's stricter reading is enough.

### K-36 · The tail's "no entity states" test is unverified on Postgres · `open` · *2026-09-19*
`content.commit_tail_marks` treats a row as lacking `entity_states` when the column is SQL NULL
OR `CAST(entity_states AS VARCHAR) = 'null'` — a Python `None` in a JSON column is stored as
JSON `null`. The hermetic suite runs it on SQLite only; on Postgres it rests on `json → varchar`
being an I/O cast that yields the stored text. Not checked: no dev database was running when
plan 2 landed. Check once against the dev stack:
`select cast('null'::json as varchar) = 'null', cast(null::json as varchar) is null;` must
answer `t, t`. If it does not, the descriptor and the tail would call an over-cap commit
expressible and serve a delta with no entities.

### K-37 · A `model_rev` bump with no journal row is silent to a replica · `done` · *2026-09-22*
`POST /model/upload`, `POST /metamodel`, `DELETE /metamodel` and the legacy element routes
bump `model_rev` and broadcast nothing. A replica hears of them at the next delta — a gap, an
incomplete tail, a re-bootstrap — or at a reconnect. Harmless while nothing reads the replica;
once a surface does, a read between the bump and the next delta answers from before it.
Decide before a surface defaults to the engine: broadcast a header-only event from
`touch_model` and `set_model`, or have the shell re-bootstrap after its own such calls.
**Done:** the server broadcasts `{"type":"reset","model_rev"}` from `Session.announce_reset()` —
`set_model`, `touch_model` and `set_metamodel` by default, the model upload and `POST /metamodel`
after their durable writes (CT-2's **Reset**).

### K-38 · `DELETE /metamodel` writes nothing durable · `open` · *2026-09-22*
The route clears the session (`set_metamodel(None)`) and touches no row, so `ModelRow` keeps its
`metamodel_id` and `model_rev`, and an evict + rehydrate brings back what was deleted *(read from
the code, not reproduced)*. Decide whether the route should clear the rows or go.

### K-39 · A peer's rebind never refetches the structure · `done` · *2026-09-22*
A peer's commit that carries `metamodel.rebind` reaches this tab as a `rebind_event`, not a
`commit_event`, so `realtime.svelte.ts` applies no delta and bumps no structure rev, and
`onReloadRebind` (`routes/p/[projectId]/+page.svelte`) calls `replicaMetamodelAdopted()` but never
`markStructureChanged()`. When the peer's batch also created or deleted elements, the tree keeps
its old shape until the next structural delta or a reload — on the server path as well as the
replica's *(read from the code, not reproduced)*. The committer's own path bumps after
adoption (`adoptReboundMetamodel`); the likely fix is the same one-line bump in `onReloadRebind`.
**Done:** `onReloadRebind` calls `markStructureChanged()` after `replicaMetamodelAdopted()`, the
same bump `adoptReboundMetamodel` already made on the committer's own path.

### K-40 · A successful Retry does not refetch the structure · `done` · *2026-09-22*
Reads posted while the replica is `failed` are answered by the failed replica; `retryReplica()`
re-bootstraps it but bumps no structure rev, so a tree read answered before the Retry stays stale
until the next structural change. The overlay blocks the workspace while `failed`, so few such
reads exist. **Done:** `replica.svelte.ts`'s `onStatus` calls `markStructureChanged()` whenever the
previous phase was `resyncing` and the new one is `ready` — a retried `failed` replica and one the
replica re-bootstraps on its own (a diverged digest check) both cross that transition; a plain
first open (`opening` to `ready`) does not.

### K-41 · A rebind's dropped batches leave their dependents parked, unremapped · `open` · *2026-09-22*
`checkout.svelte.ts` (:589) calls the facade's `dropStagedBatches` (`model.svelte.ts:114` →
`model-engine.svelte.ts`'s `dropBatches`) to unstage a rebound commit's own batches by id,
since the frozen replica never applies its delta. Each `unstage {batch}` is a rebase: a LATER
staged batch that named one of the dropped batches' temp ids (an update or a connect referring
to an element the dropped batch created) parks as a conflict right there, in the frozen
replica, and stays parked through the re-bootstrap — a plain commit's `applyDelta` would have
remapped it through `id_map` (`engine/src/working/working-copy.ts:596`), but a rebound commit's
delta is never applied, so that remap never runs. Fix: remap the dependents' temp ids through
the rebound response's `id_map` before (or instead of) dropping the batches that minted them.

### K-42 · An edit that survives a commit flight can lose its lease · `open` · *2026-09-22*
Two ways a lease outlives the POST wrongly:
(i) **Sent, and a later edit rides on it.** `checkout.svelte.ts`'s token partition
(:549-555) keeps back only a token whose resources are all `art:` ones the batch does not
need; every other token — every element and folder token — is sent unconditionally, whether
or not the batch needs it (an element is typically leased because the committed batch edits
it), and the server releases exactly what it is sent (`routes/commits.py:1376-1379`). The gap
is an edit staged DURING the POST on an element whose token is sent (a batch of its own, per
CT-2): it rides on a lease the commit gives up, so once the release lands, the still-staged
edit is left without one, and its next commit may 409 "required lock not held" until the
element is touched again (which re-acquires it). The same happens to a proposal (a snippet
or CR Stage) that took its locks before a commit landed and staged its ops after.
(ii) **Acquired during the POST, forgotten anyway.** A lease taken out WHILE the POST is in
flight is in neither `sent` nor `kept` (both computed from `getHeldTokens()` before the POST);
the answer handler's cleanup (`checkout.svelte.ts:611-613`) deletes every registry entry whose
token is not in `kept` — including that one — so the client forgets a lease the SERVER still
holds. The next commit omits the token, `verify_held` (`routes/commits.py:978`) 409s "required
lock not held", and the heartbeat (which only renews registered tokens) may let the lease
expire on the server too.
Fix direction that covers both: after a commit lands, re-acquire leases for whatever is still
staged (case i) and never forget a token the cleanup didn't itself send (case ii).

### K-43 · A property update always coalesces into the first staged batch of that id · `done` · *2026-09-22*
The engine always merges a single property update (`emit`, or `emitMany` with ONE op) into the
first staged batch already holding an update of the same id, including a batch that is
mid-commit — by design (AD-29: predicting a new batch id would drift the mirror), which would
otherwise let a keystroke land inside a batch already sent and be dropped with it if refused.
**Done:** the DiffDrawer stays undismissable — no Escape, no outside click, no close button
(`DiffDrawer.svelte`) — through the POST and, once it lands, until `commitApplied()` resolves
(`checkout.svelte.ts`), not just until the POST answers: `commitApplied()` now waits for the
replica to have actually APPLIED the commit's own delta (`commitsLanded()`), so an edit typed
while the drawer is still open can no longer land in a batch that is committed but not yet
drained (10bfc0c). A `failed` replica used to drop the user's own commit answer along with
everything else on its queue and refuse new ones, so a retry's re-bootstrap re-adopted the
committed batches and nothing dropped them (a committed create staged again); going `failed`
now keeps the user's own answer and accepts new commits, and the rebuilt replica applies the
kept answer on its first drain, so `commitApplied()` no longer needs to wait through a retry
(6a5fa93). `stageProposedOps` still waits for `commitsLanded()` before staging a proposal.
Two residual windows remain — `K-44`.

### K-44 · Two windows still let a coalesced edit merge into a committed batch · `done` · *2026-09-23*
Left after `K-43`'s fix (`commitApplied()`, `checkout.svelte.ts`): (a) a rebind that freezes
the replica between the POST answering and the replica applying it ends `commitApplied()`'s
wait early — the drawer closes — and keeps the answer queued until the new metamodel is
adopted; an update staged in that window can still merge into the committed batch and be
dropped when the queued answer finally applies. (b) At a Retry, a transition is HELD while
`failed` (`sync.ts:331`'s `admits()` is true only for `ready`/`frozen`, matching `frontend/src/lib/engine/README.md`), so
nothing reaches the engine while the overlay is up — but `sync.ts`'s `set({phase: 'ready', …})`
(:602) calls `examine()` (:312-316), which releases every held transition, BEFORE the same
function calls `pump(r)` to drain the kept own answer: a held edit that COALESCES into the
adopted committed batch (an edit staging as its own new batch survives) reaches the engine
first and is dropped when the answer drains right after it. The failed overlay being non-inert
(nothing stops a keystroke reaching a still-mounted property field behind it) is what lets an
edit queue up to be released this way, not `admits()` itself. Candidate fixes: drain the kept
own answer before releasing held transitions at `ready`; hold transitions while an own answer
is still queued; or make the failed overlay inert. Decide whether either window is worth
closing or stays a known limit.
**Done:** the model store marks a landed commit's batches COMMITTED the moment the POST
answers (`markLanded`, `model-engine.svelte.ts`) and DEFERS a single property update the engine
would merge into one of them (the first staged batch holding an update of that entity): cached
and shown at once, it is posted — with every edit made after it, in order — only once a mirror
read shows the replica has dropped that batch. Both windows are closed for an edit made after
the answer settled: (a) the frozen replica drops the batch at adoption and the deferred edit
stages after; (b) a deferred edit is never handed to the sync, so `ready`'s `examine()` has
nothing of it to release before the drain. While the answer waits, a new commit is refused
(`CommitPendingError`, the sync's `ownPending()`), and `Cmd/Ctrl+S` opens no drawer while the
replica blocks the workspace.

### K-45 · A worker that dies while a commit's answer waits leaves its dependents unremapped · `open` · *2026-09-23*
A re-bootstrap that finds the worker gone adopts the model store's copy of the staged batches
(`handOverStaged`, `model-engine.svelte.ts`), which leaves out the batches of a landed commit
whose answer the replica has not applied yet — correctly, since the engine is gone and the
store cannot tell whether it had applied the answer. The answer, applied later, is then a
`duplicate` naming no batch the new replica holds, so it remaps nothing
(`engine/src/working/working-copy.ts:471`): a later staged batch naming a temp id that commit
minted (an update of, or a connect to, an element it created) parks as a conflict instead of
being rewritten to the server id. The window is a worker death between a commit landing and
the replica applying its answer — a moment while `ready`, until adoption or `retry()` while
`frozen` or `failed`. Fix direction: have the sync hand back the committed batches whose own
answers it still holds (it knows the queue) instead of the store leaving them all out.

### K-46 · A dropped own answer posts a deferred edit into the batch it drops · `open` · *2026-09-23*
When the replica's drain fails twice on the user's own `applyDelta` with an error other than
`EngineGoneError`, `sync.ts` (:1013) calls `forget(r, [input])` (:417), whose `onAbandoned`
reaches `forgetBatches` (`model-engine.svelte.ts:934`). That takes the commit's batch B out of
the mirror and calls `postDeferred()` (:949): an update deferred because it would merge into B
no longer finds B in `_batches` (`mergesIntoCommitted`, :1116) and is posted at once — while
the replica is still `ready` and still holds B. The engine merges the update into B, the
`ask()` right after re-bootstraps, and the re-bootstrap leaves B out through `r.abandoned`,
so the update is lost with it. Reached only through an own delta failing twice with a
non-`EngineGoneError` error while an edit is deferred. Fix direction: `forgetBatches` does not
post the deferred edits while the replica may still hold the forgotten batches; they go at the
next `ready`, as `onStatus` already reads the mirror there.

### K-47 · Two paths drop an own answer without forgetting its batches · `open` · *2026-09-23*
`sync.ts` drops the user's own commit answer without `forget` in two places: `handle`'s
retried-gap branch (:1039-1042, `ask()` and return) and `requeue`'s silent return when
`waits(input)` is false (:969), reachable when the replica goes `off` while an own delta is
being handled. The commit's batches stay in `r.held`, the next replica adopts them, the model
store keeps them out of its readers through `_landed` — and nothing ever drops them from the
replica. A same-entity property update then stays DEFERRED for good (`mergesIntoCommitted`
keeps finding the committed batch): shown in the Inspector, absent from the engine's diff, and
left out of every commit, which `stagedSettled()` no longer waits for. Fix direction:
`forget(r, [input])` on both paths, as the drain's second failure does.

### K-48 · Three rare windows around a landed commit's batches · `open` · *2026-09-23*
(a) **A keystroke during the POST behind the failed overlay.** An edit made while the commit's
POST is in flight and the replica is `failed` is handed to the sync before the store knows the
batch is committed (`markLanded` runs when the POST answers), so it is held, not deferred; at
`retry()` the held transition is released at `ready` before the kept own answer drains, merges
into the committed batch and is dropped with it — `K-44`(b)'s mechanism, narrowed to the
POST's own duration. The modal DiffDrawer and the `Cmd/Ctrl+S` gate make it very hard to
reach. (b) **`unstage {entity}` can strip a committed batch.** While `frozen` or `failed`, the
drawer's per-element discard of a newer edit on an element a committed batch also touches
posts `unstage {entity}`, which takes that element's ops out of the committed batch in the
engine too; the commit already landed, so nothing is lost on the server, but the replica's
batch no longer matches what its answer drops. (c) **The committed-diff filter follows
containment source → target only.** `committedOnly` (`model-engine.svelte.ts:881`) derives a
committed delete's cascade along containment from source to target and keeps back only what a
newer staged op NAMES; an element that both a committed delete and a newer staged delete
cascade into is named by neither, so it can be hidden from the drawer. The commit still
carries exact ops. Decide per window whether it is worth closing or stays a
known limit.

---

## 3. Cleanups

| ID | Item | Source |
|---|---|---|
| C-20 | `core/metamodel/schema.py::_effective_props`' comment says definitions by closer types win; the code keeps the FIRST name seen walking root → leaf, so on a redeclared property the ancestor's definition stays (fixture `metamodel_caches`, type `Mid`). The engine mirrors the code. Decide which was meant; frozen under MR-3 until the metamodel surface defaults to the engine. | 2026-09-18 |
| C-21 | `api/routes/commits.py:785` and `:923` list "apply-cr baseline reset" among what bumps `model_rev` opaquely; apply-CR is a dry run that stages a batch and never resets the baseline. Drop it from both comments (C-12 applies: reword only, no reshaping). | 2026-09-19 |
| C-22 | `api/routes/artifacts.py::evaluate_navigation`'s `except LookupError` also catches the evaluator's `KeyError`: an unknown `row_element_id` behind a filter or a property step answers 422 `unknown navigation artifact 'x'`, and with no steps the page's `_tree_item` answers 404 `x`. The top-level `artifact_id` refusal names the id unquoted (`unknown navigation artifact n1`, `LookupError` formatted with `str`) where a nested ref's is quoted. The engine mirrors all three (fixture `nav_eval`). Fix on both sides with a fixture. | 2026-09-24 |
