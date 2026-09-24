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
five read surfaces defaulted to the engine. `core/search`, `core/navigation`, `api/search.py`,
`routes/read.py::search_model` and `routes/artifacts.py::evaluate_navigation` stay frozen past
C's first plan flipping navigation and criteria search to the engine: `core/table`'s evaluator
and `api/routes/{tables,exports}.py` still read them for tables and exports, which stay on the
server until C's plans 4–5, and `api/search.py` and the route functions are also the 501
fallback's server side (AD-31); `api/artifact_kinds.py` validates every committed navigation
payload against them. The freeze lifts for FEATURES once tables and exports default to the
engine; a bug found in any of them still lands on both sides with a fixture until F (MR-1)
regardless. `core/table/resolve.py` (ref resolution and script reach) is frozen from C's
first plan on. `core/validation` minus `rules/`, `api/validation_sweep.py` and the preview's
conformance half (`routes/commits.py::preview_commit`'s model half,
`api/rules.py::attributable_issues`) are frozen for behaviour from C's plan 2 on and stay so
past its flip of `issues` to the engine: until F a feature there lands on both sides with a
fixture step, as a bug does, since the server pipeline still decides strict commits
(`attributable_issues`) and `validation_error_count`, and answers every fallback: a rules
project, an unsupported pattern, `staging: legacy` and the window before the replica's first
sweep. Two bugs landed on both sides under it: `value_conforms`'s float branch, which raised
`TypeError` on an unhashable value and now answers `False`, and the dirty hooks, which missed a
key relationship's endpoints' uniqueness groups on connect, disconnect and cascade delete until
6b3cdb6. The second widens strict mode's `base_dirty`: connecting, disconnecting or cascading
away a relationship named in a key now makes the keyed ends' old and new group members
attributable, so a strict commit that used to land can get a 422, as a key-property edit already
could.

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
C (evaluation) is in progress, C's plan 2 of 8 built: the engine holds the project's artifacts —
the committed payloads the shell fetches and follows, the staged entries mirrored from the
frontend's buffer (AD-30) — and serves navigation and criteria search over the working copy,
by default (`navigation` and `criteria` surfaces, held to the routes by fixture and by shadow
comparison); a call that reaches a script, or a pattern the regex translator cannot vouch
for, is refused with 501 and answered by the server, a navigation's page marked so (AD-31).
C's plan 2 adds one live issue store over the working copy (AD-32) — a resumable background
sweep, incremental revalidation inside every transition, origins by a rewind probe — and
serves `getModelIssues`, `validateModel` and the model half of `previewCommit` from it, behind
the `issues` surface, which now defaults to the engine too, gated on the replica's first sweep
completing and the artifact follower's first load; a call that also reaches validation rules is refused with 501 and answered by the
server (plan 3 deletes this refusal once rules are ported).
The freeze rule (`MR-3`) covers `core/model`, `core/metamodel` and the model-op applier from
the start of A's second plan; `routes/read.py`'s route functions and
`routes/elements.py::get_element` left it for features once B's fifth plan flipped the
surfaces' defaults. `core/search`, `core/navigation`, `api/search.py` and the `search_model`
and `evaluate_navigation` route functions stay frozen past C's first plan's flip of navigation
and criteria search: `core/table`'s evaluator and `api/routes/{tables,exports}.py` still read
them for tables and exports, on the server until C's plans 4–5, and `api/search.py` and the
route functions are also the 501 fallback's server side; `api/artifact_kinds.py` validates
every committed navigation payload against them; `core/table/resolve.py` (ref resolution and
script reach) is frozen from C's first plan on too. `core/validation` minus `rules/`,
`api/validation_sweep.py` and the preview's conformance half
(`routes/commits.py::preview_commit`'s model half, `api/rules.py::attributable_issues`) are
frozen for behaviour from C's plan 2 on and stay so past its flip of `issues` to the engine:
until F a feature there lands on both sides with a fixture step, since the server pipeline still
decides strict commits (`attributable_issues`) and `validation_error_count`, and answers every
fallback: a rules project, an unsupported pattern, `staging: legacy` and the window before the
replica's first sweep. A bug fixed during a port, or found in any of these areas afterward,
lands on both sides with a fixture until F (MR-1), whether or not the feature freeze has lifted
for that area. Two landed by C's plan 2: `value_conforms`'s float branch, which raised
`TypeError` on an unhashable value and now answers `False`, and the dirty hooks, which missed a
key relationship's endpoints' uniqueness groups on connect, disconnect and cascade delete until
6b3cdb6. The second widens strict mode's `base_dirty`: connecting, disconnecting or cascading
away a relationship named in a key now makes the keyed ends' old and new group members
attributable, so a strict commit that used to land can get a 422, as a key-property edit already
could.
Open: `K-29`, `K-32`, `K-35`, `K-36`, `K-38`, `K-41`, `K-42`, `K-45`, `K-46`, `K-47`, `K-48`,
`K-49`, `K-50`, `K-51`, `K-52`, `K-53`, `K-54`, `K-55`, `K-56`, `K-57`, `K-58`, `K-59`, `K-60`,
`K-61`, `K-62`, `K-63`, `C-21`, `C-22`, `C-23` in this file; `K-33`, `K-34`, `T-10` in
`BACKLOG.md`.
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

### K-49 · A peer's new navigation can be named before its payload reaches the engine · `open` · *2026-09-24*
The shell's artifact follower (`frontend/src/lib/engine/artifacts.ts`) fetches a peer's
created or updated artifact when its `artifact` feed event arrives, and the artifact list the
editors offer takes the same event at once. A navigation that names the new artifact in the
moment between the two is answered 422 `unknown navigation artifact 'x'` by the engine where
the server finds it; the preview shows a failed run until the next edit re-runs it. The
startup window is closed: the `navigation` surface is the server's until the follower's
first `load()` lands (`loaded()`, a gate on the engine seam), a failed load is asked once
more after a second, and a shadow re-test waits for the follower's fetches (a quiet probe),
so this window cannot log a false `[shadow]` line. Decide whether an evaluation should wait
for the fetches out, or the window stays a known limit. It is also AD-31's known gap: a
preview whose first page came from the server before the follower's load and whose "Load
more" runs after it can mix committed and working state, and with staged model edits a chain
can then be duplicated or skipped.

### K-50 · A staged artifact edit can miss a read issued in the same synchronous run · `open` · *2026-09-24*
`stagedChanged()` defers its push of the composed overlay to the engine by a microtask
(`frontend/src/lib/engine/artifacts.ts:183`), while `sync.call` posts a read to the engine at
once whenever it is ready. During a commit's refresh, an artifact staged meanwhile reaches the
engine only when the refresh lands. Now that a commit's creates are aliased under their real
ids during that refresh (`bcae61e`), the hold may no longer be needed. Fix direction: push the
composed overlay during the hold too, and add a test that a read issued right after
`stageArtifactUpdate` sees the staged update.

### K-51 · `setArtifacts` in a `now` handler can exceed the chunk budget · `open` · *2026-09-24*
`engine/src/artifacts/artifact-set.ts:70-82` stringifies and parses the whole artifact list at
once, and `now` handlers run inside one host turn (CN-3's ≤16 ms). Measured cost is about
5 ms/MB without floats, and 30–50 ms/MB once any payload holds a float, because the whole list
then goes through the exact parser: 2.8 MB of snippets plus one `1.5` took 74–102 ms. Every
project open pays this twice — `startReplica`'s `load()` and the first feed `snapshot`'s
`load()` both fetch and set all payloads. Fix direction: read and set per artifact, and drop
the duplicate initial load.

### K-52 · Superseded navigation previews are never cancelled · `open` · *2026-09-24*
`evaluateNavigation` passes no `AbortSignal` (`frontend/src/lib/api/artifacts.ts:72`), so each
debounced auto-run while editing a definition queues a full model-lane scan that runs to
completion even after a newer edit supersedes it. Fix direction: abort on the editor's
generation bump, as B's scans do.

### K-53 · The artifact follower's fetch chain has no timeout · `open` · *2026-09-24*
`frontend/src/lib/engine/artifacts.ts:125-134` awaits `/artifacts/payloads` with no timeout.
One hung request stalls every later feed event and refresh, and the staged mirror with them if
a commit's hold sits behind it. Fix direction: a fetch timeout, or a way for a later fetch not
to wait on a stuck one holding the staged mirror.

### K-54 · A pattern fallback in Advanced Search reads committed state silently · `open` · *2026-09-24*
`frontend/src/lib/api/model-read.ts:134-150` falls back to the server for a pattern the engine
cannot vouch for, with no mark on the result. A user with a staged rename gets different
results depending only on the regex syntax used, with nothing telling them the run read
committed state. Fix direction: a one-line note like the navigation dock's `nav-fallback`.

### K-55 · The criteria warm-up can freeze the worker on a catastrophic pattern · `open` · *2026-09-24*
`compileCriteria`'s warm-up (`engine/src/search/criteria.ts:244-245`) runs every translated
pattern before the first step. A catastrophic-backtracking pattern (e.g. `'(?:a?|b?)'` repeated
22 times plus `'x'`) freezes the worker for about 4.5 s, and the scheduler has no way to
interrupt a warm-up run. Fix direction: bound or step the warm-up.

### K-56 · `sendArtifacts` swallows an engine refusal silently · `open` · *2026-09-24*
`frontend/src/lib/engine/sync.ts`'s `sendArtifacts` drops an engine refusal without surfacing
it, so an engine holding no artifacts can still look "loaded". Fix direction: a dev-mode
`console.error` on refusal.

### K-57 · `py_coerce`'s `to_number` rows miss several `toNumber` branches · `open` · *2026-09-24*
The fixture's `to_number` rows lack a plain int, a finite bigint, a float, a dict, `""` and
`"   "`, so those branches of `toNumber` (`engine/src/value/coerce.ts:110-128`) have no oracle
row. Fix direction: add the inputs to `tests/golden/scenarios/py_coerce.py` and regenerate.

### K-58 · `change_request_dirty_ids` is dead outside tests and shares the key-relationship dirty gap · `open` · *2026-09-24*
`change_request_dirty_ids` (`src/data_rover/core/validation/dirty.py:355-434`) has no
production caller at HEAD: apply-CR has proposed an op batch since `be3bcb9` (pre-dating this
branch), translated by `api/change_request_ops.py::ops_for_change` and staged and committed
like a manual edit, through the ops route's hooks — the same ones 6b3cdb6 fixed. Only
`tests/validation/test_dirty.py:246` and `tests/validation/rules/test_reach.py:363` still call
it, and it still adds a relationship's endpoints' uniqueness groups only when the relationship
type is containment (the same gap `after_connect`/`before_disconnect`/`after_element_delete`
had before 6b3cdb6 fixed them for staged ops), so any caller that appeared would leave the
issue store holding a duplicate that is gone, or missing one that appeared, after a CR built
through it applies. Fix direction: fix it — mirror 6b3cdb6's hooks, adding the keyed other
ends' old and new groups for every added, modified or deleted relationship of a keyed type —
or delete it with its two tests. Either way, `dirty.py:41-44`'s module docstring, which still
calls it the CR-apply path, goes with it.

### K-59 · The sweep's first step, and a browser slice while sweeping, exceed their budgets · `open` · perf · *2026-09-24*
`LiveIssues.sweepSteps()`'s first step lists every element id then every relationship id in
one unit: 13 ms at M (`pixi run engine-bench`, 15 ms on the first pass) against the
scheduler's 8 ms slice target, and up to 8 ms of other units can precede it in the same slice.
In the browser (`pixi run engine-bench-browser`) the longest slice while sweeping is 21 ms
(21, 23, 21), past CN-3's 16 ms chunk; the bench's two ping loops overlap
(`frontend/bench/main.ts:521-532`), so that row may also count digest-check slices. Every
other sweep step is 5.8 ms at most once warm (11 ms on the first pass). The whole sweep, ready
to seeded, is 767 ms in the browser. Fix direction: list the ids in steps too (an
`ord`-ordered walk that resumes), then separate the bench's two ping loops before reading the
row again. Not optimized yet: the owner's rule is to report before optimizing.

### K-60 · `uniqGroupOf` re-keys every member of a duplicate group per call · `open` · perf · *2026-09-24*
`model/indexes.ts:92-97` derives `uniqKey` (a `pyKey` serialization) for every member of the
bucket on each call, so a scoped run that reaches a large duplicate group pays O(group)
serializations once per run: a 20,000-member group costs about 27 ms per sweep step, and a
stage, unstage or probe that touches one of its members pays the same inside its transition.
The Python core (`core/validation`'s uniqueness over `model.indexes`) has the same shape, so
the server pays it too. Fix direction: cache the key per member (or the group per bucket)
across calls, invalidated at the mutation boundary; on both sides, with a fixture step, while
the freeze holds.

### K-61 · Every issue refetch with a large staged set runs a probe · `open` · perf · *2026-09-24*
`getModelIssues` and `previewCommit` read `origins()`, which probes (rewinds and replays every
staged batch) once per `(rev, stagedVersion)`. Each staged edit moves `stagedVersion` and
then `issues_version`, so each 300 ms refetch probes again: about 27 ms per 100 staged batches
at M, inside a model-lane transition that holds reads behind it. Fine at today's staged sizes;
a user holding thousands of batches pays it on every keystroke's refetch. Fix direction: a
probe incremental in the batches that moved (the top ones, for an edit that coalesces or
stages on top), or a refetch that skips the probe when only the list, not the origins, is
read.

### K-62 · A server issue list fetched with the gate closed can land after the engine's · `open` · *2026-09-24*
`refetchIssues()` issued while the `issues` gate was closed goes to `GET /model/issues`; when
the gate opens meanwhile, the refetch it schedules is answered by the engine, and a slower
server answer can land after it. `adoptIssues` accepts an equal `model_rev` (the server's own
sweep grows its store without moving the rev), so the server's committed list overwrites the
engine's — a staged edit's `uncommitted` issues vanish — until the next `issues_version` move
refetches. Fix direction: a refetch sequence number in `model-shared.svelte.ts`, adopting only
the answer of the latest refetch asked.

### K-63 · Past the 5,000-issue cap a staged edit's own issues can fall off the list · `open` · *2026-09-24*
`issueListBody` truncates at `ISSUES_RESPONSE_MAX` (5,000) in store order, and every
transition re-files its dirty owners last, so on a store past the cap the staged edit just
made lists its issues past the cut: `counts` has them, the panel does not. The server
truncates its own store's order, a different subset, which is why the dev shadow skips a
`truncated` list's `issues`. Fix direction: when truncating, list the probe's `S` owners (the
staged edits' dirty set) first, then the rest in store order.

---

## 3. Cleanups

| ID | Item | Source |
|---|---|---|
| C-20 | `done` (2026-09-24, feat/eval-navigation) — `check_metamodel` refuses a property that redeclares an ancestor's, so the two readings never differ on a metamodel that reaches the engine; `_effective_props`' comment now says so. | 2026-09-18 |
| C-21 | `api/routes/commits.py:785` and `:923` list "apply-cr baseline reset" among what bumps `model_rev` opaquely; apply-CR is a dry run that stages a batch and never resets the baseline. Drop it from both comments (C-12 applies: reword only, no reshaping). | 2026-09-19 |
| C-22 | `api/routes/artifacts.py::evaluate_navigation`'s `except LookupError` also catches the evaluator's `KeyError`: an unknown `row_element_id` behind a filter or a property step answers 422 `unknown navigation artifact 'x'`, and with no steps the page's `_tree_item` answers 404 `x`. The top-level `artifact_id` refusal names the id unquoted (`unknown navigation artifact n1`, `LookupError` formatted with `str`) where a nested ref's is quoted. The engine mirrors all three (fixture `nav_eval`). Fix on both sides with a fixture. | 2026-09-24 |
| C-23 | A containment cycle has two readings. `POST /model/validate` with nothing staged runs `Scope.all()` on the server, which names ONE representative of a cycle; the engine ports scoped runs only, so its store (the sweep's, as the server's own store is) reports every element whose first-parent chain reaches the cycle, those hanging below it included, and the engine's `validateModel` answers that store. The server already disagrees with itself the same way (its sweep and its full branch). Pick one reading on both sides when the candidate validation is decided. | 2026-09-24 |
