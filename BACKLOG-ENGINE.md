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
(`attributable_issues`) and `validation_error_count`, and answers every fallback: an unreadable
rule set, an unsupported pattern, `staging: legacy` and the window before the replica's first
sweep. Two bugs landed on both sides under it: `value_conforms`'s float branch, which raised
`TypeError` on an unhashable value and now answers `False`, and the dirty hooks, which missed a
key relationship's endpoints' uniqueness groups on connect, disconnect and cascade delete until
6b3cdb6. The second widens strict mode's `base_dirty`: connecting, disconnecting or cascading
away a relationship named in a key now makes the keyed ends' old and new group members
attributable, so a strict commit that used to land can get a 422, as a key-property edit already
could. `core/validation/rules` and `api/rules.py` are frozen from C's plan 3 on, which ports them
to the engine: a bug or a feature there lands on both sides with a fixture until F.

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
C (evaluation) is in progress, C's plan 3 of 8 built: the engine holds the project's artifacts —
the committed payloads the shell fetches and follows, the staged entries mirrored from the
frontend's buffer (AD-30) — and serves navigation and criteria search over the working copy,
by default (`navigation` and `criteria` surfaces, held to the routes by fixture and by shadow
comparison); a call that reaches a script, or a pattern the regex translator cannot vouch
for, is refused with 501 and answered by the server, a navigation's page marked so (AD-31).
C's plan 2 adds one live issue store over the working copy (AD-32) — a resumable background
sweep, incremental revalidation inside every transition, origins by a rewind probe — and
serves `getModelIssues`, `validateModel` and the model half of `previewCommit` from it, behind
the `issues` surface, which now defaults to the engine too, gated on the replica's first sweep
completing and the artifact follower's first load. C's plan 3 evaluates custom validation rules in
that store (AD-33): the server parses each rule set's YAML for the engine (`POST /rules/parse`,
`rules` beside each rule set on `GET /artifacts/payloads`), and the engine compiles, reaches and
evaluates the committed and the staged rule sets, so a staged rule set's issues show in the Issues
panel and in Validate before any commit, while the preview reads the committed rules, as the
server's does (`K-65`); an `issues` call waits for a rule-set change's rescan, and only a rule set
the engine cannot read sends it to the server (501 `reaches unreadable rules`). The plan also
lists the sweep in steps (`K-59`), caches uniqueness key texts in the engine (`K-60`'s engine
half) and tags the panel's list without a probe per keystroke (`K-61`).
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
fallback: an unreadable rule set, an unsupported pattern, `staging: legacy` and the window
before the replica's first sweep. A bug fixed during a port, or found in any of these areas
afterward, lands on both sides with a fixture until F (MR-1), whether or not the feature freeze
has lifted for that area. Two landed by C's plan 2: `value_conforms`'s float branch, which raised
`TypeError` on an unhashable value and now answers `False`, and the dirty hooks, which missed a
key relationship's endpoints' uniqueness groups on connect, disconnect and cascade delete until
6b3cdb6. The second widens strict mode's `base_dirty`: connecting, disconnecting or cascading
away a relationship named in a key now makes the keyed ends' old and new group members
attributable, so a strict commit that used to land can get a 422, as a key-property edit already
could. `core/validation/rules` and `api/rules.py` are frozen from C's plan 3 on: a bug or a
feature there lands on both sides with a fixture until F.
Open: `K-29`, `K-32`, `K-35`, `K-36`, `K-38`, `K-41`, `K-42`, `K-45`, `K-46`, `K-47`, `K-48`,
`K-49`, `K-50`, `K-51`, `K-52`, `K-53`, `K-54`, `K-55`, `K-56`, `K-57`, `K-58`, `K-60`, `K-62`,
`K-63`, `K-65`, `K-66`, `K-67`, `K-68`, `K-69`, `K-70`, `K-71`, `K-72`, `K-73`, `C-21`, `C-22`,
`C-23` in this file; `K-33`, `K-34`, `T-10` in
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

### K-59 · The sweep's first step, and a browser slice while sweeping, exceed their budgets · `done` · perf · *2026-09-24*
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
**Done:** the sweep walks the model in steps: its first step only takes the total, and each
later one pulls the next 512 entities it has not validated yet from a live iterator per map,
passing over those it has (a set of the ids it validated), at most 16 × 512 a step; the
iterator is taken again when a re-sort moves `Model.orderEpoch`. `done` stays short of the
total until the last step. The bench's two ping loops are separated:
one until the digest check ends, a second from then until the sweep ends. At M (`pixi run
engine-bench`, medians of three passes, before → after): the first step 13 → 0.0 ms, the longest
step after it 6.0 → 10–14 and the whole sweep 843 → 986–1,035 (two runs on a loaded machine).
The set of validated ids costs that: growing a `Set` to 300,000 ids alone takes 40–80 ms, and
the rehash near 262,144 ids 8–20 ms in one step, which puts the longest step past the 8 ms
slice target; not optimized. In the browser, before the set was added: the longest slice while
sweeping, the check ended, 9.7 → 9.7 ms; the longest during the check, the sweep's first steps
among them, 12 → 11, and its moment 26 → 151 ms after ready. The walk ends as long as each
step's 8,192 skips outrun what lands behind the iterator between two steps: a probe's or a
rebase's replay appends one entry per staged create, a re-sort the whole map again. With the
set, in the browser (a cloud container, Chromium 141's headless shell, so not comparable to the
rows above, 2026-09-25): the longest slice while sweeping 13 ms (16, 13, 11), inside CN-3's
16 ms chunk, the digest check's 15, and the sweep 1,219 ms from ready to seeded. The browser
bench holds no rule set; in Node on the same machine the sweep with the bench's five rules is
1,163 ms, its longest step after the first 12 (16, 12, 11).

### K-60 · The server walks a whole duplicate group per call · `open` · perf · *2026-09-24*
The Python core keeps each element's key (`uniq_key_of`) and groups by it, so it serializes
nothing per call, but it still walks the whole group: the scoped uniqueness validator finds
each scoped member's primary by a `min` over the group (`validators/uniqueness.py:54`), so a
scoped run over k members of a group pays O(k × group) — the server's sweep once per chunk —
and `DirtyCollector.add_uniqueness_group_of` sorts the group on every call, so a commit or an
ops batch that touches one member pays O(group log group) inside its write. Fix direction: the
primary once per group and run, as the engine's validator finds it; `core/validation` and
`core/model` are frozen (MR-3), so it waits for the freeze to lift.
**Done for the engine,** whose `uniqGroupOf` re-keyed every member of the bucket on each call
(a `pyKey` serialization each, about 27 ms per sweep step over a 20,000-member group):
`IndexSet.keyText` caches the text of every member of a bucket of two or more, written as an
element is filed and refreshed by every rekey, and `verifyConsistent` holds it to a rebuild's.
At M, with 20,000 copies of one element staged: `uniqGroupOf` over the group 23 → 1.7 ms, the
sweep's longest step 39 → 7.9 ms and the sweep 1,956 → 989 ms (12–13 and 1,170–1,205 once the
sweep tracks its validated ids, K-59); a 1,000-op stage through the
store 82 → 54 ms (with the bench rules' reach 81 → 58).

### K-61 · Every issue refetch with a large staged set runs a probe · `done` · perf · *2026-09-24*
`getModelIssues` and `previewCommit` read `origins()`, which probes (rewinds and replays every
staged batch) once per `(rev, stagedVersion)`. Each staged edit moves `stagedVersion` and
then `issues_version`, so each 300 ms refetch probes again: about 27 ms per 100 staged batches
at M, inside a model-lane transition that holds reads behind it. Fine at today's staged sizes;
a user holding thousands of batches pays it on every keystroke's refetch. Fix direction: a
probe incremental in the batches that moved (the top ones, for an edit that coalesces or
stages on top), or a refetch that skips the probe when only the list, not the origins, is
read.
**Done:** `getModelIssues` tags through `LiveIssues.tagScope()`: the owners an exact probe
dirtied, with their committed issues, then every id a transition dirties, with the store's
issues from just before it revalidates them, kept while the store is seeded and settled, the
rev and the rule sets hold and the working rules are the committed ones; otherwise it probes.
`previewCommit` and `validateModel` keep the exact probe. At M, the list read after a keystroke
merged into the latest staged batch: 100 batches 7.6 → 0.0 ms, 1,000 batches 258 → 0.0 ms.

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

### K-65 · The preview ignores a staged rule set that a strict commit enforces · `open` · *2026-09-25*
`POST /commits/preview` validates with the session's COMMITTED rules: a staged rules artifact
contributes nothing to it (`routes/commits.py:595-598`), while `POST /commits` recompiles with
the batch's rule sets before it validates and its strict gate counts every `rule:` issue in
the scope. So on a strict project, staging a rule set that fails on existing elements, the
preview says the batch lands and the commit answers 422. The engine mirrors the server's
preview on purpose (AD-33), so both sides give the same wrong promise. Fix on both sides with a
fixture: the preview compiles the staged rule sets, and its dirty set adds their
`applies_population` over the old and new compiles, as the commit's does.

### K-66 · A peer's rules commit reaches the engine as a model delta first, its payload after · `open` · *2026-09-25*
The commit's delta arrives on the feed and is applied at once; the changed rule set arrives
later, through the follower's payload fetch for the artifact event. In between, the engine
answers issue reads with the old rules while the server already has the new ones, so a
dev-shadow `[shadow]` line is possible in that window. An own commit whose parses have landed
does not open it: the follower puts the rule sets the commit created or updated into the
engine's committed layer when the commit is announced. One committed while its parse is still
out does — Save, then commit within one `/rules/parse` round trip: the rule set goes into
neither layer until the payload refresh lands, so a create shows no rules and an update keeps
the old committed ones meanwhile — and so does a follower load in flight at the commit, whose
answer drops the committed rule set until the refresh. A single user can reach both, an e2e
too. `/model/undo` of a rules commit reaches the engine as a peer's does (a delta, then an
artifact event). Fix direction: hold the delta until the payloads of the artifacts its commit
names have landed, or have the feed's commit event carry the changed rule sets' parses.

### K-67 · A YAML scalar PyYAML cannot construct escapes `parse_rule_set` as a bare `ValueError` · `open` · *2026-09-25*
`core/validation/rules/schema.py::parse_rule_set` catches `yaml.YAMLError` and `RecursionError`
only, but PyYAML's constructors raise a plain `ValueError` for a scalar their tag cannot build
— an impossible date (`x: 2001-13-45`), an explicit `!!float abc`. It escapes unwrapped, the
app's `ValueError` handler answers 422, and `POST /rules/lint` and `POST /rules/parse` both 422
where they should answer 200 with `ok: false` and one error. The rules editor reads lint's 422
as "Rule set is too large to lint" (the only 422 it expects) and blocks Save; a staged rule set
holding such YAML (saved inside the lint's debounce) stays `'pending'` in the engine, since the
shell counts a failed parse as not landed and asks again only at the next staged push. Fix:
catch the constructor's `ValueError` in `parse_rule_set` as a `RuleSetError`, with a test on both
routes; a bug fix, so the freeze allows it, and the engine, which reads no YAML, does not change.

### K-68 · A legacy `PUT`/`DELETE /artifacts/{id}` on a rule set splits the engine from the server · `open` · *2026-09-25*
The legacy artifact routes leave `session.compiled_rules` alone on a `validation_rules` write
(`routes/artifacts.py`'s module note): the server keeps the old rules until the session is
evicted and rehydrated. They emit the same `artifact` feed event as a commit, though, and the
follower fetches the payload with its parse and hands it to the engine, which recompiles and
rescans at once. From then until the rehydrate the engine's issue list, `rules_status` and the
model half of its preview use the new rules while the server's use the old, so the two answer
differently and a dev-shadow `[shadow]` line is possible. The frontend never calls those routes;
only a script or a second client does. Fix direction: the routes recompile and re-splice as
`POST /commits` does (the module note says why recompiling alone is worse than neither), or
the event marks the write so the follower leaves the committed rules alone until a load.

### K-69 · A table sort compares numbers through `float()` · `open` · *2026-09-25*
`core/table/evaluate.py::_script_sort_atom` ranks a number or bool by `float(item)`. An int past
≈ 1.8e308 raises `OverflowError`, so sorting a column that holds one answers 500. An int past 2^53
rounds, so two distinct ints can tie. A `NaN` compares false with everything, so a column that
holds one has no defined order. C's plan 4 ports the table sort mirroring all three rather than
fixing them on one side (`Number(bigint)` rounds the same way and throws past `Number.MAX_VALUE`),
and keeps `NaN` atoms out of the golden fixtures. Fix direction, on both sides with a fixture:
compare ints exactly, never through a float, and sort a `NaN` atom last.

### K-70 · With the `tables` surface itself on the server, an artifact-only commit that changes a referenced navigation does not re-page an open table · `open` · *2026-09-25*
`table-editor.svelte.ts`'s `onCommitEvent` handler only calls `handleTableModelRevChanged` when
the feed event's `scope` includes `'model'`, on the premise that "an artifact-only commit
changes no model content and invalidates none of the server's cell-evaluation caches." True for
the server's per-cell cache, but not for a table whose row source or a column navigates through
a REFERENCED navigation artifact (a `ref`, not an inline definition): a peer's commit that only
updates that navigation changes what the table computes, yet moves no `model_rev`, so an open
table keeps showing the old rows until an unrelated model-moving commit or a reload happens to
refresh it. `handleTableModelRevChanged` itself only runs when `engineSide('tables') ===
'server'` — the `tables` SURFACE switch, not a per-table thing: a table the engine has refused
(a script column, say) still re-pages correctly, because `followTables`/`scheduleTablesRepage`
re-page every open table on any `artifacts_version` move through `changed`, and that runs
whenever the surface itself is on the engine, independent of which individual tables happen to
fall back. So the gap is narrower than "server-served tables": it exists only with the `tables`
switch itself set to `server`, or with no engine at all (the sandbox refused to start — the
workspace's dismissible fallback notice, and every surface reads from the server). Fix
direction: re-page on an artifact-scoped commit too, or narrow the server path's cache
invalidation to cover a referenced artifact's navigation ids the way the engine's `ArtifactSet`
already does.

### K-71 · Installing rules is one unsliced `now` unit · `open` · perf · *2026-09-25*
`Service.moveArtifacts` compiles the working and committed rule sets and, on a change, calls
`live.setRules`, which walks `appliesPopulation` over every element of the old and new rules'
applicable types to seed the rescan queue — all inline, in the one `now` call `moveArtifacts`
runs from (artifact methods never slice). Measured at M in the browser (2026-09-25,
Chromium 141): rules install + rescan 372 ms, its longest slice 50 ms — over CN-3's 16 ms step
budget, on a project whose rules happen to change on load or on a peer's rules commit. Not
optimized here; the owner schedules it.

### K-72 · An element-typed property column reading a dict or list item raises, expand or collapse · `open` · *2026-09-25*
`core/table/cells.py::_element_ids` does `dict.fromkeys(items)` to de-duplicate the reached
references; `items` is the raw property value itself, or its list unwrapped. Three call sites
reach it: `expand_property_values` (an `expand` element-typed property column, `:170`), the
single-element collapse branch when the value is a list (`:247`), and the many-element collapse
branch's joined values (`:255`) — so a property declared element-typed whose actual value is a
`dict`, or a list holding a `dict` or another `list`, raises whether the column is `expand` or
`collapse`, over one element or many. `dict.fromkeys` hits the unhashable key and raises a bare
`TypeError`, which the route turns into a 500. The engine's `elementIds` (`table/rows.ts`)
mirrors it on purpose, throwing the same `unhashable type: 'list'`/`'dict'` message — an
unrefused 500 there too. Fix direction, on both sides with a fixture covering all three call
sites: treat a non-string, non-id item as a plain value (through `cellText`) instead of assuming
every element-typed item is an id.

### K-73 · Every open table tab re-pages on each staged change, hidden ones included · `open` · perf · *2026-09-25*
`table-editor.svelte.ts::repageOpenTables` re-pages every table tab that has evaluated once the
replica's staged state moves, whether or not the tab is the one on screen. A staged edit moves
the order cache's stamp (`rev`, `staged_version`), so each re-page misses it and rebuilds and
sorts the table: at M, the gate's table costs ~190 ms of model-lane work per tab on a miss, and N
open tabs queue N of those behind every pause in the user's typing, delaying every read and
transition behind them. Fix direction: re-page only the visible tabs and mark the others stale,
as a suspended tab already is (`_suspendedStale`), re-paging a stale tab when it is shown.

---

## 3. Cleanups

| ID | Item | Source |
|---|---|---|
| C-20 | `done` (2026-09-24, feat/eval-navigation) — `check_metamodel` refuses a property that redeclares an ancestor's, so the two readings never differ on a metamodel that reaches the engine; `_effective_props`' comment now says so. | 2026-09-18 |
| C-21 | `api/routes/commits.py:785` and `:923` list "apply-cr baseline reset" among what bumps `model_rev` opaquely; apply-CR is a dry run that stages a batch and never resets the baseline. Drop it from both comments (C-12 applies: reword only, no reshaping). | 2026-09-19 |
| C-22 | `api/routes/artifacts.py::evaluate_navigation`'s `except LookupError` also catches the evaluator's `KeyError`: an unknown `row_element_id` behind a filter or a property step answers 422 `unknown navigation artifact 'x'`, and with no steps the page's `_tree_item` answers 404 `x`. The top-level `artifact_id` refusal names the id unquoted (`unknown navigation artifact n1`, `LookupError` formatted with `str`) where a nested ref's is quoted. The engine mirrors all three (fixture `nav_eval`). Fix on both sides with a fixture. | 2026-09-24 |
| C-23 | A containment cycle has two readings. `POST /model/validate` with nothing staged runs `Scope.all()` on the server, which names ONE representative of a cycle; the engine ports scoped runs only, so its store (the sweep's, as the server's own store is) reports every element whose first-parent chain reaches the cycle, those hanging below it included, and the engine's `validateModel` answers that store. The server already disagrees with itself the same way (its sweep and its full branch). Pick one reading on both sides when the candidate validation is decided. | 2026-09-24 |
