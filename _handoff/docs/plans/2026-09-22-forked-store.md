# Forked Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline, one commit per task (the owner's choice for this program). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In engine mode the user's staged model edits live in the engine replica's working copy, so the five read surfaces the replica already serves — elements, fuzzy search, incident relationships, containment tree, summary counts — show staged creates, renames, deletes and connects without a client-side overlay; a temp-id element is reachable from the tree; a staged edit that no longer applies after a peer's commit is shown as a conflict and never committed; the commit batch is built from the engine's staged batches and the response drops exactly them; today's store is frozen as the server-mode fallback behind a `staging` switch; and B closes.

**Architecture:** Plan 6 of 6 for sub-project B (`architecture/program.md`), the last. `lib/state/model.svelte.ts` becomes a facade over two entity halves — `model-legacy.svelte.ts`, today's code moved and frozen, and `model-engine.svelte.ts`, a view over the engine — with the shared half (summary, rev, issues, rules status, error, generation) in `model-shared.svelte.ts`. The engine store keeps reactive caches of what the UI asked for, writes an edit into them synchronously, posts it to the engine as a `stage`, mirrors the engine's staged batches for the synchronous readers, and refreshes caches and mirror from the engine's `changed` event. `sync.ts` gains the event surface and a transition path beside the read barrier; `surfaces.ts` gains the `staging` switch; the commit flight gets its real `batchIds`; the DiffDrawer gets a conflicts section. Nothing under `engine/src/` or `src/data_rover/` changes.

**Tech Stack:** TypeScript 6, Svelte 5 (runes), Vite 8, vitest 3 (happy-dom + MSW, the real engine through `connectInProcess()`), Playwright (Chromium) for e2e; pixi for every command.

**Spec:** `docs/superpowers/specs/2026-09-19-replica-and-frontend-seam-design.md` — §8 "The forked store" is this plan's scope; §7's `staging` switch and shadow rule, §9's store tests and the e2e "a staged edit visible in the tree", §11, §12 "Done when" and "Known limits" bind it. Read first: `architecture/README.md`, `program.md` (B's row, MR-1 to MR-4), `contracts.md` (CT-2, CT-4, CT-5), `constraints.md` (CN-3), `decisions.md` (AD-23 to AD-28), `system.md` (Edit and Commit flows); then plan 5 (`docs/superpowers/plans/2026-09-22-transport-swap.md`: Decisions D9–D21, Mechanisms M2–M7, "After this plan") and plan 4's M7–M10; then `CLAUDE.md`'s "Engine package" (`src/working/`, `src/service/`) and "Shell", and `frontend/README.md`'s "State model" and "Replica (engine shell)".

**What kind of plan this is.** As plans 4 and 5: direction with specifics — interfaces, signatures, the test cases and what each asserts, the order, and the mechanisms that are easy to get wrong. It holds no full code, and nothing in it was built; the expected results of the "see it fail" steps are reasoned from the code. If a step's expected result does not appear, trust the run, read the step's intent, and say so in the hand-back. What WAS checked while planning is listed next.

## What planning found

Checked against the code at `8482178` (branch `engine-migration`), by reading; facts 19–23 by a throwaway probe in the session's scratch directory (Node 22 running `engine/src` unbuilt over the smart-city example).

1. **The legacy store's staged state is its caches, not a render-time overlay.** `emit(op)` (`model.svelte.ts:564`) applies the op to `_elements` / `_relationships` / `_treeItems` synchronously through `applyOptimistic` (`:480-542`), records a revert journal per op (`RevertEntry`, `:71-78`) and pushes the op onto `_queue` (`:115`). Only eight readers look at the buffer itself: `getStagedOps` `:630`, `getStagedOpsFor` `:634`, `getStagedNameOverride` `:646`, `getStagedDepth` `:665`, `getStagedDiff` `:752`, `isStagedDeleted` `:1016`, and the private `isStagedDeletedRelationship` `:1029` and `hasQueuedOpFor` `:1040`. Everything else reads the caches through `getCachedElements()`, `getCachedRelationships()`, `getTreeElements()` (`:156-165`, lite tree rows with full entries winning) and the `ensure*` family.
2. **Coalescing merges in place** (`:569-588`): a property update finds the FIRST queued op of the same kind and id and spreads its patch over it; the op object handed out by `getStagedOps()` is the live one. `popLastStaged` (`:734`) pops the last queue entry, so an Undo can remove an older op than the last keystroke when that keystroke coalesced.
3. **The guards protect against committed reads.** `seedElements` / `seedRelationships` skip ids with a queued op (`:1061`, `:1075`); `ensureElement` / `ensureElements` / `ensureTreeItems` return `null` or skip for a temp id (`:825`, `:880`, `:927`) — "the server never heard of it" — and for a staged-deleted id (`:827`, `:834`, `:881`, `:897`, `:930`, `:945`); `applyDelta` skips upserting an entity with a queued op (`:425`, `:436`) so a peer's delta cannot clobber a staged edit, and that is why `commitStaged` calls `clearStaged()` BEFORE `applyDelta(res)` (`checkout.svelte.ts:466-473`). `_missingElementIds` means "the server confirmed it does not exist" (`:445`, `:841`); the Inspector checks `isStagedDeleted` separately (`Inspector.svelte:53`) to end its spinner.
4. **A staged delete does not hide a tree row today.** `applyOptimistic`'s `delete_element` removes from `_elements` only; `_treeItems` loses an id in `dropTreeItems` (`:178`), the remap (`:328`) and a COMMITTED delete (`:441`). A row with a lite tree entry keeps rendering after a staged delete. A staged create appears in no tree page (`StagedSection.svelte:22-25` says so), and a staged containment relationship re-parents nothing: `containmentChildren` is built from server pages (`ContainmentTree.svelte:458-467`).
5. **The tree and the relationships list refetch on `getStructureRev()`** (`ContainmentTree.svelte:365-388`, `:395-421`, `:426-450`; `RelationshipsList.svelte:46-48`), which moves in exactly two places: `applyDelta` on a structural committed delta (`model.svelte.ts:454`, the formula at `:395-400`) and `markStructureChanged()` (`:236`, one caller: `checkout.svelte.ts:509`). `emit()` never bumps it: a staged edit could not change a server answer.
6. **The property form emits on every input event** (`PropertyField.svelte:226-353`, `oninput` → `onChange` → `PropertyForm.svelte:31-45` → `emit`) and renders `value={entity.properties[pd.name]}` (`PropertyForm.svelte:74`) from the cached entity. The field keeps no draft of its own: the cache write in `emit` is what keeps the input's text under the caret.
7. **The commit batch is four families in one array**, metamodel → model → artifact → view (`checkout.svelte.ts:383-384`, the order's reasons at `:340-353`: view last because a `place_element` may name a temp id the model half minted), `previewStaged` the same inline (`:357-362`), `base_rev` = `getModelRev()`. `mmOps` is read once (`:374-383`); the batch is refused empty (`:385-391`). The token partition (`:412-423`) keeps an `art:` token not needed by the batch and sends the rest; `lockedResourcesNeededBy` (`:777-835`) is the client mirror of `required_locks` and is called from five places (`:540`, `:576`, `:689`, `:859` besides the commit). After the POST: `flight.settle` (`:442-448`), the three `clear*` (`:466-468`), the token drop, `applyDelta(res)` (`:473`), the artifact / view / metamodel notifications, `adoptReboundMetamodel()` on `rebound` (`:494`, `:501-515`).
8. **`batchIds` is typed and never sent.** `CommitAnswer` (`sync.ts:80-90`) has `batchIds?`; `settle` builds `own = {batch_ids: answer.batchIds ?? [], id_map}` (`:1021`); both callers omit it (`checkout.svelte.ts:442-448`, `HistoryDrawer.svelte:144-150`). Today nothing is staged in the engine, so the engine drops no batch and remaps through `id_map` alone.
9. **The sync exposes no engine event.** Its one listener, `onEngineEvent` (`sync.ts:440-452`, attached per link at `:398`), handles `progress` and `replica`; `changed` falls through. `link` is private (`:280`); `ReplicaSync` (`:92-125`) has no `on`. `onStatus` carries `ReplicaStatus` only.
10. **`sync.call` is method-agnostic and its barrier is a read's** (`:1036-1067`, `answers` `:302-306`): a call waits for `ready` with `rev >= known`, is posted at once in `frozen` and `failed`, rejects `EngineGoneError` in `off` / `server`. For a `stage` that means: held for a PEER's rev while `ready` (needless — the engine rebases a staged batch over any delta), posted to a `failed` replica's closed scheduler (it would run after the next `adoptStaged`, which is the right order, but `dropLink()` on a lost worker rejects it with `EngineGoneError` and the edit is gone), and a flight in progress holds nothing (`flights` gates the pump only, `:830`, `:838`).
11. **A re-bootstrap carries the batches.** `resync` (`:650-686`) reads `staged` and `conflicts` BEFORE `close`, joins them by id into `run.held`, and every attempt posts `adoptStaged {batches}` after `end` and before the tail (`:539`); `held` clears at `ready` (`:548-550`), so `retry()` (`:995-997`) and an `off` reopen (`:698`) adopt them again. `metamodelAdopted()` in `frozen` is the same road (`:1032-1034`). The overlay's "Your uncommitted edits are kept." (`ReplicaFailedOverlay.svelte:34-35`) is true of the legacy buffer today and of this road from this plan on.
12. **The switches** (`surfaces.ts:3-18`, `:43`, `:48-50`): `SURFACES` is the five read surfaces, `SURFACE_DEFAULTS` all `engine`, `readSurfaces` accepts the two `Side` literals only, and `anyEngineSurface` gates `getReplicaNotice`, `isReplicaBlocked` and `replicaGate` (`replica.svelte.ts:89-91`, `:157`, `:166`, `:176`). Adding `staging` to `SURFACES` would change when the notice and the overlay show. `createEngineSeam` (`seam.ts:17-21`) coerces a surface to `server` in phase `off` / `server`; `route` (`engine-route.ts:54-68`) has a server fallback for reads and nothing for a write.
13. **Shadow has no staged gate.** `createShadow(deps)` takes `{rev, quiet, report}` (`shadow.ts:21-27`); the comparison runs at `:44` after the terminal check, the re-test at `:54-63`; the store supplies the deps at `replica.svelte.ts:108-112`. The e2e fixture turns shadow on in every spec, so an ungated shadow fails e2e the moment a spec stages an edit on the engine.
14. **The engine's staging wire** (`engine/src/service/types.ts:38-81`, `service.ts`): `stage {ops}` reads its ops at ARRIVAL (`:218-221`, `readOps`: a 422 `ops[i].kind: must be one of …` before it queues) and answers `{batch: {id, ops}, coalesced, changes: {element_ids, relationship_ids, deleted_element_ids, deleted_relationship_ids, structural}, elements, relationships}` — the two post-state lists `null` together when the CHANGED ids exceed 500 (`STAGE_POST_STATE_MAX`, `:109`, `:637`), deletions not counted. The service always coalesces (`:635`): a single `update_element` / `update_relationship` merges into the first staged batch holding an update of the same kind and id, as a NEW batch object under the OLD id (`working-copy.ts:346-366`), tried alone first so a bad patch parks nothing. `unstage {what}` (`'all' | {batch} | {entity, incident?}`, read at arrival, `:150-160`) answers `{changes}`. `staged` and `conflicts` are `now` methods answered in any state (`:226-227`), `stagedDiff` an `inspect` method on the model lane (`:228`, `:358-360`) answering `{elements: [{id, before, after}], relationships: […]}` in first-touch order. `adoptStaged {batches}` takes exactly what `staged` returns and numbers the next batch past the highest id (`working-copy.ts:395`). `applyDelta` / `applyTail` answer no change set: what changed reaches the shell through the `changed` event alone. A refused batch throws `OpError {status: 422, detail}` with the server's quote-stripped text and leaves no trace.
15. **The `changed` event is emitted BEFORE the answer** (`service.ts:635-637`: `this.changed(…)` then the return), from `stage`, `unstage` and every applied delta, iff the replica is `ready` and something moved: a `stage` always moves `staged_version` (a new batch object, `ops: []` included), an `unstage` that matched nothing moves nothing and emits nothing (`replica.test.ts:376`). `adoptStaged` emits nothing (the replica is `opening`).
16. **A staged entity lives under its temp id and every read sees it.** `idFor` is the identity and the service passes none (`ops/apply.ts:20`, `:61`); reads run over the working copy's `Model` (`service.ts:343`) and no read in `engine/src/read/` takes a `committed` flag — CT-5.4 is not built. `createdId` (`apply.ts:55-71`) refuses a `temp_id` without the `tmp_` prefix and an `id` hint with it.
17. **`unstage {entity}` ignores parked conflicts** (`working-copy.ts:417-431` never filters `parked`); `'all'` and `{batch}` drop them (`:405-416`). `stagedVersion` (`:236-238`, `:619-636`) moves whenever the batch objects in `staged()` or `conflicts()` differ — a stage, a merge, a remap, a drop, a park — not on a plain rebase.
18. **The engine's `remapOp` rewrites what an op REFERENCES** — its `id`, its ends, its property values — never its own `temp_id` (`ops/remap.ts`; `replica.test.ts:311-314`), and an own delta that arrives as a `duplicate` (the echo before the answer) still drops and remaps when `own` names a batch still held (`working-copy.ts:503-509`; `replica.test.ts:295-318`).
19. *Probe.* **A staged create is a root the tree, the search and the tree-items read all return.** `stage [create_element tmp_x Organization]` on smart-city: `listContainmentRoots` total 719 → 720 with `tmp_x` LAST (root order is insertion order; page 2 at `limit: 500`), `listElementsPage {q: 'zed'}` → `['tmp_x']`, `getTreeItemsBatch {ids: ['tmp_x']}` → one item with its display name, `getElement` → `{id: 'tmp_x', …, rev: 1}`. A staged `Owns` from `tmp_x` to a Team that already has a parent re-parents NOTHING (`parents[0]` wins): a move is delete-the-old-containment then create.
20. *Probe.* **A staged delete cascades in the diff and 404s the element.** `delete_element` of an Organization with four children: `changes` = 5 deleted elements, 13 deleted relationships; `stagedDiff` lists every one as `{before: image, after: null}` beside the staged create's `{before: null, after: record}`; `listContainmentRoots` omits it; `getElement` throws `ModelError` `No element with id 'e_000002`.
21. *Probe.* **An own delta drops the named batches, remaps the rest, and reports WIDE.** Five batches staged (create `tmp_x`, create `tmp_r` from it, a coalesced rename, the delete of fact 20, an update of `tmp_x`); `applyDelta(delta at rev 8, {batchIds: [1, 2], idMap})`: `applied`, batches 3, 4, 5 remain, batch 5's `id` is now the server id, `stagedVersion` moved; the change set names `tmp_x` and `tmp_r` as deleted, the two server ids as changed, AND the still-staged delete's five elements and thirteen relationships as deleted and the renamed element as changed — every entity a rewound batch touched, as CLAUDE.md warns ("a rebase over-reports what it touched"). `unstage {entity}` reports the same width. The set is exact about before and after, only wide.
22. *Probe.* **A peer's delete parks a staged update; `{entity}` leaves it, `{batch}` removes it.** `stage [update_element e_000003]`, then a delta deleting `e_000003`: `conflicts()` = `[{batch: 6, error: {422, "No element with id 'e_000003"}}]`; `unstage {entity: 'e_000003'}` → empty change set, the conflict still there, `stagedVersion` unmoved; `unstage {batch: 6}` → empty change set, no conflict, `stagedVersion` moved.
23. *Probe.* **Coalescing keeps the batch and moves the version once**: four stages (two creates, a rename, a second rename of the same element) give batches `[1, 2, 3]` with the fourth answering `batch.id` 3, `coalesced: true`, `stagedVersion` 4.
24. **Every store test pins reads to MSW.** `setModelApiConfig` (`model.svelte.ts:126`) is called by tests only (`model-store.test.ts:44`, `model.staged-delete-guard.test.ts:37`, `model.tree-items.test.ts:42`, `validate-staged.test.ts`, six component tests), and `route` takes an explicit `baseUrl` as a server call (plan 5 D11); in production `_clientConfig` is `undefined` and every entity read of the store already goes through the seam (`elements.ts:18-19`, `model-read.ts:43-78`). No store test runs a replica; `replica.svelte.test.ts:64` (`realReplica()`) and `sync-heal.test.ts:80-129` are the two suites that stage through the engine, both by calling `link.client` directly.
25. **The proposed-ops paths emit one op at a time** (`stage-proposed.ts:148-150`, after the temp-id remap `:57-91` that keeps a create's `id` hint, the pre-state seeding `:93-113` where `ensureElement(op.id) === null` is `reason: 'missing'`, and the locks `:115-146`); `snippet-stage.ts` delegates to it. A create's `id` hint rides through.
26. **The realtime store synthesises an `OpsResponse` for every peer commit** (`realtime.svelte.ts:228-247`: `id_map: {}`, the event's four entity arrays, the store's own issue counts) and calls `applyDelta` unconditionally, so `base_rev` stays equal to the server's. `handReplicaFeed` runs first.
27. **Known noise, not this plan's.** e2e `script-embedding.spec.ts:91` and `snippet-flow.spec.ts:69` fail on `engine-migration` as it stands; the frontend's vitest run prints `ECONNREFUSED 127.0.0.1:3000` lines; `tests/model/test_search_index.py::test_string_properties_indexed_non_strings_ignored` is flaky. A run is judged against them.

## Decisions

Taken with the owner (2026-09-22):

- **D1. Model ops only.** The six model ops stage in the engine; artifact, view and metamodel edits stay in their legacy buffers and join the commit batch as today (spec non-goals, CT-5.5). The commit assembly reads the engine's `staged()` for whatever families the engine holds, so C can add artifacts without another fork.
- **D2. `K-39` and `K-40` fold in**, each a task of its own with a test and a commit: the peer-rebind Reload handler bumps the structure rev; a re-bootstrap that reaches `ready` bumps it too.
- **D3. The "Staged elements" section stays**, fed by the engine's diff: it remains the per-element review and cascade-discard surface, its rows derived as today from `getStagedDiff()`.

Taken by this plan — each reversible at review; say so if one is wrong:

- **D4. `staging` is its own switch, not a surface.** `StagingSide = 'engine' | 'legacy'`, read from the same `dr.surfaces` object under the key `staging`, `STAGING_DEFAULT` `'legacy'` until Task 11 flips it. `staging: engine` forces the five read surfaces to `engine` (spec §7) inside `readSwitches`; it is NOT folded into `SURFACES` or `anyEngineSurface` (fact 12). The EFFECTIVE side is `engine` iff the switch says so and the replica's phase is neither `off` nor `server` — `server` is decided before the workspace unblocks (plan 5's gate), so the side never flips with edits staged; `failed` and `frozen` keep the engine side, whose batches the sync holds (fact 11).
- **D5. Four files, not three.** Spec §8's shared half lives in `model-shared.svelte.ts` and `model.svelte.ts` re-exports it, because the legacy half writes shared state (`_modelRev`, `_structureRev`, issues) and the facade imports both halves: a cycle otherwise. Importers see the same names from `model.svelte.ts` and `state/index.ts`.
- **D6. The optimistic write stays, and an engine write never regresses it** (fact 6). `emit` writes the op into the caches synchronously as today, without a journal; the entity's `pending` count goes up; the engine's post-state for that entity is written only by the answer that brings the count back to zero, and a `changed`-driven re-read skips entities with a pending edit. A refusal is what restores the cache: the entity is re-read from the engine.
- **D7. The mirror is read from the engine, never predicted.** The store keeps `staged`, `conflicts` and `stagedDiff` as the engine last answered them, re-read whenever a `changed` event's `staged_version` differs from the version the mirror reflects (one read in flight, one owed), plus PROVISIONAL entries for edits whose `stage` has not been covered by such a read. Synchronous readers see both; commit, preview and validate wait for `stagedSettled()` and see the engine's batches alone.
- **D8. A transition is held for the phase, not the rev** (fact 10). `sync.call(method, params, {transition: true})` waits in the shell — in the SAME list as the reads, so arrival order holds — until the phase is `ready` or `frozen`; it never waits for `known`; `failed`, `opening` and `resyncing` hold it (the batches the sync holds are adopted first, and a worker that died cannot lose it); `off`, `server` and `stop()` reject `EngineGoneError`. A flight in progress holds nothing: an edit during a commit is rebased over the response.
- **D9. One path refreshes the caches after a transition: the `changed` event.** Its deleted ids leave the caches and the tree items; its changed ids that are cached are re-read in one `getElementsBatch`; a changed cached relationship is left to the relationships list's refetch (there is no batch read of relationships and the event is structural, fact 21); `structural` bumps `_structureRev`. The `stage` answer's post-state is used for the pending entity only (D6). `applyDelta(res)` — own and peer — does the shared half (rev, issue delta, summary patch, the legacy structural formula), re-keys the caches through `id_map` and re-points selection and visit history, and upserts the delta's entities that no staged batch touched (the diff's ids); it never touches the staged list.
- **D10. Conflicts are a section of the DiffDrawer** — the batch's ops, the engine's text, one Discard per batch through `unstage {batch}` — counted outside the drawer's `total` and never part of a commit; `revertStagedForElement` also drops the parked batches touching the element (fact 22), `revertAllStaged` drops them all (the engine does).
- **D11. Proposed ops stage as ONE batch.** `emitMany(ops)` posts one `stage {ops}`: all-or-nothing, one refusal, one batch id — where today's loop could stop half way. Coalescing does not apply to it (fact 14).
- **D12. Shadow is off while anything is staged.** `ShadowDeps` gains `staged(): boolean`, asked before `server()` is called and again before each re-test round; the store hands it the engine store's `hasStagedOps`.
- **D13. Undo is `unstage {batch: last}`.** A coalesced keystroke lives in its first batch, so Undo may remove an older batch than the last keystroke — the same as today's `popLastStaged` over a coalesced queue (fact 2).
- **D14. `getStagedDiff` is the engine's diff.** `before` is the committed image, `after` the record now; an entity edited back to its committed value is no change in the drawer and the badge while its op stays staged (today's journal shows it as modified).
- **D15. The engine store has no `ClientConfig`.** `setModelApiConfig` stays the legacy half's; every engine-store read goes through the seam (fact 24), and its tests run the real replica.
- **D16. A temp id is a real id to the engine store** (fact 16): no `isTempId` short-circuit in its `ensure*`; a 404 from the engine puts the id in `_missingElementIds` whatever its prefix.
- **D17. `K-40`'s bump lives in the replica store**, on every `resyncing → ready`, for both staging sides: the tree's reads come from the replica whichever side stages.

## Global Constraints

- Everything runs through pixi. No global `node` or `python`.
- Branch `feat/forked-store`, cut from `engine-migration` at `8482178`; fast-forwarded back in Task 12. Never touch `main`. **Commit only with the owner's go-ahead for this plan's execution — ask before Task 1.**
- **Nothing under `engine/src/` or `src/data_rover/` changes.** If a task seems to need it, stop and report. The engine's staging wire is taken as fact 14 describes it.
- Import rules (plans 4 and 5, kept): `lib/api/*` imports no `lib/state/*` and no `lib/engine/*`; `lib/engine/*` holds no rune and imports no `lib/state/*`; production code imports `$engine` / `$sandbox` as types only. New in this plan: `lib/state/replica.svelte.ts` may import `model-engine.svelte.ts` and `model-shared.svelte.ts`, and NEITHER of those imports `replica.svelte.ts` or `model.svelte.ts` (D5; the engine handle is injected, M4).
- Tests run the real engine (`connectInProcess()`, `fakeProject()`, `syncOver()`, `realReplica()`), never a mock of it (RC-14); MSW with `onUnhandledRequest: 'error'`; no fake timers; every link disposed in teardown. The legacy half's tests stay on the legacy half and stay untouched (MR-4).
- Engine results pass the SAME zod schema as the server's body; the shell never re-serializes model content for the engine (AD-26). Ops cross to the engine as the plain objects `lib/state/ops.ts` types.
- Performance: build what is written, report numbers, optimize nothing; a stage per keystroke is a rebase from the coalesced batch (K-32's numbers bound it).
- Comments and docstrings: concise, present tense, only what the code cannot say; no spec, plan, phase or `architecture/` id in code.
- `architecture/`, `CLAUDE.md`, `frontend/README.md`, `BACKLOG-ENGINE.md` change in the commit of the code they describe (RC-10). `docs/` and `benchmarks/` are git-ignored — never `git add -f`.
- Commit subjects: one imperative sentence, capitalized, no prefix, no trailing period; the message ends with the session's `Co-Authored-By` line.
- A "see it fail" step lists what it expects red; any OTHER red test is a finding to report, judged against fact 27's known noise.
- Ids: this plan closes `K-39` and `K-40` and mints `AD-29`. Next free afterwards: `K-41`, `C-22`, `AD-30`.
- Formatting and lint: `pixi run frontend-tidy`; check-only is `pixi run dr-tidy true`.

## File Structure

```
frontend/src/lib/engine/surfaces.ts             + StagingSide, STAGING_DEFAULT, Switches, readSwitches (staging forces the five)
frontend/src/lib/engine/sync.ts                 + on('changed'), call(…, {transition}); one held list
frontend/src/lib/engine/shadow.ts               + ShadowDeps.staged
frontend/src/lib/engine/staged-probe.ts         (new) the "nothing staged" probe the shadow reads
frontend/src/lib/state/replica.svelte.ts        getStagingSide, subscribeReplicaStatus, the engine handle, K-40's bump, the shadow's staged dep
frontend/src/lib/state/model-shared.svelte.ts   (new) the shared half: summary, rev, structure rev, issues, rules, error, generation
frontend/src/lib/state/model-legacy.svelte.ts   (new) today's entity half, moved verbatim, frozen
frontend/src/lib/state/model-engine.svelte.ts   (new) the engine view: caches, emit, the mirror, the readers, the unstage family
frontend/src/lib/state/model-caches.ts          (new) remapCaches / remapElement / remapRelationship as pure functions over the two cache maps (shared by both halves)
frontend/src/lib/state/model.svelte.ts          the facade: re-exports the shared half, dispatches the entity half by getStagingSide()
frontend/src/lib/state/index.ts                 + stagedSettled, getStagedBatchIds, getStagedConflicts, revertConflict, emitMany, StagedConflict
frontend/src/lib/state/checkout.svelte.ts       stagedSettled before preview and commit; batchIds on settle; discardConflict
frontend/src/lib/state/stage-proposed.ts        emitMany
frontend/src/lib/state/realtime.svelte.ts       unchanged in code; its applyDelta now reaches the facade
frontend/src/lib/components/DiffDrawer.svelte   the conflicts section
frontend/src/routes/p/[projectId]/+page.svelte  K-39: markStructureChanged in onReloadRebind
frontend/src/lib/state/__tests__/support/engine-store.ts   (new) engineStore(): the replica store over fakeProject() with staging on the engine
frontend/src/lib/state/__tests__/model-engine*.test.ts, checkout.engine.test.ts, model-shared.test.ts, replica.svelte.test.ts (+)
frontend/src/lib/engine/__tests__/surfaces.test.ts, sync-transition.test.ts (new), sync-events.test.ts (new), shadow.test.ts (+)
frontend/src/lib/components/__tests__/diff-drawer-conflicts.test.ts (new), staged-section.test.ts (+)
frontend/e2e/staged-edits.spec.ts               (new)
tests, READMEs, CLAUDE.md, BACKLOG-ENGINE.md, architecture/{decisions,contracts,program}.md
```

## Mechanisms

**M1 — The `staging` switch** (`lib/engine/surfaces.ts`).
```
type StagingSide = 'engine' | 'legacy'
const STAGING_DEFAULT: StagingSide                     // 'legacy' until Task 11
type Switches = { surfaces: Record<Surface, Side>; staging: StagingSide }
readSwitches(storage = globalThis.localStorage): Switches
readSurfaces(storage?): Record<Surface, Side>         // = readSwitches(storage).surfaces, as before
```
`readSwitches`: the defaults, overlaid with the `dr.surfaces` object as today for the five surfaces; `staging` is taken when its value is `'engine'` or `'legacy'`, ignored otherwise; THEN, when `staging === 'engine'`, every surface is set to `'engine'` whatever the object said. Any throw is the defaults. `SURFACES`, `SURFACE_DEFAULTS` and `anyEngineSurface` are untouched.

**M2 — The event surface and the transition path** (`lib/engine/sync.ts`).
- `on(event: 'changed', listener: (e: ChangedEvent) => void): () => void` — `ChangedEvent` is the engine's `changed` event type imported as a type from `$engine`. Listeners are kept on the sync, not on a link: `adopt(r, made)` attaches ONE forwarding `client.on` per link (beside `onEngineEvent`) that hands every `changed` to the listeners; a link disposed forwards nothing more. A `changed` arriving while the sync's phase is not `ready` or `frozen` is still forwarded (the engine emits only when its own replica is `ready`; the shell's `frozen` is shell state, fact 11).
- `call<T>(method, params?, options?: {signal?: AbortSignal; transition?: boolean})`: with `transition: true` the waiter's target is "phase `ready` or `frozen`" and no rev; everything else as M3 of plan 5 — the same `waiters` list, examined on every `set()`, released in arrival order, so a read asked after an edit is posted after it. `off`, `server`, `stop()`, no link when released → `EngineGoneError`; `signal` → `AbortError`.

**M3 — The engine handle and the staging side** (`lib/state/replica.svelte.ts`).
```
getStagingSide(): StagingSide            // 'engine' iff _switches.staging === 'engine' and the phase is neither 'off' nor 'server'; 'legacy' without a sync
subscribeReplicaStatus(listener: (status: ReplicaStatus, previous: ReplicaStatus) => void): () => void
type EngineHandle = {
  call: ReplicaSync['call'];
  on: ReplicaSync['on'];
  status(): ReplicaStatus;
  subscribe: typeof subscribeReplicaStatus;
}
```
`build()` reads `readSwitches()` once (the `surfaces` half goes to the seam as today), creates the sync, and calls `attachEngine(handle)` of `model-engine.svelte.ts`; `stopReplica()` / `resetReplica()` call `detachEngine()` before they drop the sync. `onStatus` also feeds the status listeners, previous status included, and — D17 — calls `markStructureChanged()` (from `model-shared`) when the previous phase was `resyncing` and the new one is `ready`. The shadow deps gain `staged: anyStaged` (M7).

**M4 — The engine store's state** (`lib/state/model-engine.svelte.ts`). The same cache names and shapes as the legacy half — `_elements`, `_relationships` (`SvelteMap`), `_treeItems`, `_missingElementIds` (`SvelteSet`), `_pendingElementFetches`, `_inFlightBatchIds` — copied without the guards of fact 3 and without the temp-id short-circuits (D16); the cache code is duplicated on purpose (the legacy half is frozen and deleted in F). Beside them:
```
type Provisional = { seq: number; ops: ModelOp[]; answered: number | null }   // answered = _reads when the stage answered
_batches: WireBatch[]         // the engine's staged(), as last read     (WireBatch: {id: number; ops: ModelOp[]})
_parked: StagedConflict[]     // the engine's conflicts(), as last read  (StagedConflict: {batch: WireBatch; error: {status: number; detail: string}})
_diff: StagedDiffResult | null   // the engine's stagedDiff(), as last read
_provisional: Provisional[]
_pending: Map<string, number>    // entity id → edits in flight
_seenVersion: number             // the last changed event's staged_version
_mirrorVersion: number           // the version the mirror reflects
_reads: number                   // mirror reads issued
_handle: EngineHandle | null
```
`attachEngine(handle)` stores it, subscribes to `changed` (M6) and to the status (a phase that becomes `ready` schedules a mirror read — the batches adopted by a re-bootstrap emit no `changed`, fact 15); `detachEngine()` unsubscribes, clears the mirror, the pending map and the caches. `resetModelStore()` (facade) resets both halves and the shared half.

**M5 — `emit`, `emitMany` and the mirror.**
- `emit(op)`: (1) `applyOptimistic(op)` — the legacy's cache write, journal-free: a create is cached under its temp id with `rev: 0` and a lite tree item; an update patches the cached entity (nothing if not cached); a delete drops the element, its cached incident relationships AND its tree item (fact 4's gap closed). (2) `pending(op.target) += 1`, target = `temp_id` for a create, `id` otherwise. (3) `_provisional.push({seq, ops: [op], answered: null})`. (4) `void post([op], entry)`.
- `emitMany(ops)`: steps 1–3 over every op in order, one provisional entry, one `post(ops, entry)`.
- `post(ops, entry)`: `await handle.call('stage', {ops}, {transition: true})`. **Answered:** for each target id, `pending -= 1`; when a count reaches 0 and the answer's `elements` / `relationships` hold the entity, write it; when they are `null` (past 500), re-read the targets whose count is 0 through `getElementsBatch`. `entry.answered = _reads`. **Refused** (`ValidationError`, or any error): remove `entry`, decrement its targets, `setModelError({kind: 'rejected', message: error.message})` (an `EngineGoneError`: `kind: 'error'`), and re-read every target through `getElementsBatch` — an id the engine does not return leaves the caches (that is the optimistic create or a resurrected delete going back), a returned one overwrites — and drop the targets' tree items when the batch held a create or a delete; bump `_structureRev` when any op was structural.
- **The mirror read** (`readMirror()`): if one is in flight, set `owed`; else `_reads += 1`, `at = _reads`, `version = _seenVersion`, then `Promise.all([call('staged'), call('conflicts'), call('stagedDiff')])` → `_batches`, `_parked`, `_diff`, `_mirrorVersion = version`; drop every provisional entry whose `answered !== null && answered < at` (a read ISSUED after its answer covers it; one issued before may have run ahead of the transition — `staged` is a `now` method); then if `owed` or `_seenVersion !== _mirrorVersion`, read again. A rejected read (`EngineGoneError`) leaves the mirror as it was: the next `ready` reads it.
- `stagedSettled(): Promise<void>` resolves when `_provisional` is empty, no mirror read is in flight or owed, and no `pending` count is above zero (waiters are a list resolved at the end of `post` and `readMirror`).
- The readers, all synchronous over `_batches ++ _provisional` (the provisional ops after the batches, in `seq` order): `getStagedOps()` — every op; `getStagedOpsFor(id)` — the legacy's `queuedTargetId` rule; `getStagedDepth()` — the op count; `hasStagedOps()`; `getStagedBatchIds()` — the ids of `_batches`; `getStagedNameOverride(id)` — the legacy's rule, newest op first; `isStagedDeleted(id)` — a `delete_element` op targeting `id` in any staged op; `getStagedDiff(): Diff` — `computeDiff(baseline, working)` over `_diff`, baseline = the non-null `before`s, working = the non-null `after`s, `touched` = every id in `_diff` (an empty `Diff` when `_diff` is null); `getStagedChangeCount()`; `getStagedConflicts(): StagedConflict[]` — `_parked`.
- The unstage family, each `await stagedSettled()` first, then one transition, then nothing (M6 does the rest): `popLastStaged(): boolean` — false when nothing is staged, else `unstage {batch: last of _batches}`; `revertStagedFor(id)` — `unstage {entity: id}`; `revertStagedForElement(id)` — `unstage {entity: id, incident: true}` then `unstage {batch}` for every parked batch whose ops target `id` or have it as an end (fact 22); `revertAllStaged()` — `unstage 'all'`; `revertConflict(batchId)` — `unstage {batch: batchId}`; `clearStaged()` — nothing.

**M6 — `changed`, and `applyDelta`.**
- On `changed {rev, staged_version, element_ids, relationship_ids, deleted_element_ids, deleted_relationship_ids, structural}`: `_seenVersion = staged_version`; when it differs from `_mirrorVersion`, `readMirror()`. `deleted_element_ids` leave `_elements` and `_treeItems` (and `_pendingElementFetches`), `deleted_relationship_ids` leave `_relationships`; `element_ids` that are cached and have no pending edit are re-read in one `getElementsBatch` (chunks of 500) and written without guards, an id the answer omits leaving the caches; cached `relationship_ids` are left as they are (D9); `structural` → `_structureRev += 1` (through `model-shared`); `rev` → `setModelRev(rev)` when it is past the store's (an applied delta's `changed` may reach the store before, or after, the realtime store's `applyDelta` — the higher number wins and the barrier keeps a read from seeing less).
- `applyDelta(d: OpsResponse)`: the legacy's `structural` formula and shared writes (`_modelRev`, `_issueCounts`, the summary patch, the issue delta, `clearOverlay()`, `_structureRev`) live in `model-shared`'s `applyDeltaShared(d)` and run first; then, when `id_map` is not empty, `remapCaches(_elements, _relationships, _treeItems, d.id_map)` (`model-caches.ts`), `remapVisitIds`, the selection re-point — the legacy's order, fact 7; then the delta's `changed_elements` / `changed_relationships` are upserted UNLESS a staged batch touches the id (`_diff` holds it, or a provisional op targets it), and `deleted_*` leave the caches and the tree items. It never touches the mirror: the engine's own `changed` moves it.

**M7 — The shadow gate.** `lib/engine/staged-probe.ts`: `setStagedProbe(probe: (() => boolean) | null)`, `anyStaged(): boolean` (false without a probe). `ShadowDeps.staged(): boolean`; `createShadow` returns at once when `deps.staged()` is true — before `server()` is called — and ends a re-test silently when it turns true between rounds. `model-engine`'s `attachEngine` sets the probe to `hasStagedOps`, `detachEngine` clears it.

**M8 — The commit** (`checkout.svelte.ts`). `previewStaged` and `commitStaged` begin with `await stagedSettled()`; `commitStaged` captures `modelOps = getStagedOps()` and `batchIds = getStagedBatchIds()` beside `mmOps` (fact 7's capture-once), builds the batch as today with `modelOps` in the model slot, and settles with `batchIds`. `clearStaged()` stays where it is (a no-op on the engine side). `validateAll()` awaits `stagedSettled()` too. `discardConflict(batchId)` = `revertConflict(batchId)` then the `_discardWith` lease sweep. `HistoryDrawer`'s revert settles with `batchIds: getStagedBatchIds()` as well — a revert lands a delta over whatever is staged, and the batches it names are none.

**M9 — The DiffDrawer's conflicts section.** Under the entity rows, `{#if conflicts.length > 0}` a section `data-testid="staged-conflicts"` headed `N staged edits no longer apply` with one row per parked batch (`data-testid="conflict-row-<batchId>"`): each op summarised as the entity rows summarise theirs (kind glyph, type name or id, the name override when the op carries one), the engine's `error.detail` verbatim in `text-warning`, and a ghost `Discard` button → `discardConflict(batchId)`. Conflicts are not in `total`, and the `Commit` button ignores them.

---

### Task 1: The `staging` switch, the event surface and the transition path

**Files:** Modify `frontend/src/lib/engine/surfaces.ts`, `sync.ts`, `__tests__/surfaces.test.ts`. Create `__tests__/sync-events.test.ts`, `__tests__/sync-transition.test.ts`. Docs: `frontend/README.md`, `architecture/contracts.md` (CT-4), `CLAUDE.md`.

**Agent:** `critical-implementer` — the held-list ordering between reads and transitions, and the per-link forwarding, are protocol.

**Interfaces:** M1, M2. `readSurfaces` keeps its signature and behaviour for a `dr.surfaces` object without `staging`.

- [ ] **Step 1: Ask** the owner whether commits are pre-approved for this plan. `git switch -c feat/forked-store`.
- [ ] **Step 2: Write the failing tests.**
  - `surfaces.test.ts`: `readSwitches()` gives `STAGING_DEFAULT` and the surface defaults; `{staging: 'engine'}` gives every surface `engine` although `{tree: 'server'}` is set beside it; `{staging: 'legacy', tree: 'server'}` keeps `tree` `server`; `{staging: 'other'}` is the default; `readSurfaces()` equals `readSwitches().surfaces`; every existing case unchanged.
  - `sync-events.test.ts` (over `fakeProject()` + `syncOver()`): `a changed event reaches a listener` — `ready`, then `link.client.call('stage', …)` of a rename: the listener got one event with `staged_version` 1 and the element's id; `a listener added before the link exists gets the events` — `on` right after `open()`; `a link replaced mid-life still forwards` — dispose the first link mid-open so the second attempt connects anew, stage after `ready`: one event, not zero; `an unsubscribed listener hears nothing`; `stop() forwards nothing more`.
  - `sync-transition.test.ts`: `a transition posts at once while ready whatever known is` — `feedCommit` of a peer's delta (so `known` is ahead) with the pump held (a flight open through `beginCommit()`): `call('stage', {ops}, {transition: true})` resolves while the flight is still open, and the spied link saw `stage` before `applyDelta`; `a read asked after a transition is posted after it` — while opening, `call('stage', …, {transition: true})` then `call('getElement', …)`: the link saw them in that order after `applyTail`; `a transition waits while opening, resyncing and failed` — asked in each phase it is pending, resolves after `ready` (for `failed`: after `retry()`), and the link saw `adoptStaged` BEFORE it; `a transition posts while frozen` — `feedRebind(rev)`, then a stage: resolved by the frozen replica; `off and server refuse`; `stop refuses the waiter`; `an aborted transition posts nothing`.
- [ ] **Step 3: See them fail** — `surfaces.test.ts`'s new cases (no `readSwitches`), the two new files at import.
- [ ] **Step 4: Implement** M1 and M2. The listeners are a `Set` on the sync; `adopt` registers one `client.on('changed', …)` per link and keeps its unsubscribe with the link's `detach`.
- [ ] **Step 5: See them pass;** `sync-call.test.ts`, `sync-open.test.ts`, `sync-follow.test.ts`, `sync-heal.test.ts` unchanged and green; `pixi run frontend-check`.
- [ ] **Step 6: Docs.** README "Surfaces": the `staging` key, its two values, that `engine` forces the five, that it is read once with the rest. README "Reading" gains a paragraph "Transitions": what `{transition: true}` waits for and what it does not (D8), and "Events": `on('changed')`. CT-4's "Reads … wait for it" bullet: the shell holds a transition for the phase alone and posts it before any read asked after it. `CLAUDE.md` "Shell" → `sync.ts`: `on`, `call`'s `transition` option.
- [ ] **Step 7:** `pixi run frontend-tidy`; commit: `Let the shell stage through the replica and hear it change`.

---

### Task 2: The store split — shared half, legacy half, facade

**Files:** Create `frontend/src/lib/state/model-shared.svelte.ts`, `model-legacy.svelte.ts`, `model-caches.ts`, `__tests__/model-shared.test.ts`. Modify `model.svelte.ts` (becomes the facade), `state/index.ts` (no new names yet), `replica.svelte.ts` (`getStagingSide`, `readSwitches`), `__tests__/replica.svelte.test.ts`. Docs: README, `CLAUDE.md`, `architecture/decisions.md` (AD-24 gains the file layout).

**Agent:** `implementer` — a mechanical move with the existing suite as the oracle.

**Interfaces:**
- `model-shared.svelte.ts` exports today's shared half by its names (`getModelSummary`, `getModelRev`, `getStructureRev`, `markStructureChanged`, `getModelGeneration`, `getIssueCounts`, `getIssuesByOwner`, `getLiveIssues`, `getIssuesTruncatedTotal`, `getRulesStatus`, `getModelError`, `clearModelError`, `setModelError`, `refreshSummary`, `loadSummary`, `adoptSummary`, `adoptIssues`, `refetchIssues`, `resetSharedStore`, `ModelStoreError`) plus the setters the halves need: `setModelRev(rev)`, `bumpStructureRev()`, `nextGeneration()`, `applyDeltaShared(d: OpsResponse)` (fact 7's shared writes and the structural formula — the formula needs `_elements.has(e.id)`, so it takes a `has(id)` callback), `patchSummary(modelRev, issueCounts)`.
- `model-legacy.svelte.ts` exports today's entity half by its names (fact 1's list, `setModelApiConfig` included, `getStagedNameOverride` included), reading and writing shared state through those setters; `remapElement` / `remapRelationship` / `remapCaches` move to `model-caches.ts` as pure functions over `(elements, relationships, treeItems, idMap)`, called by the legacy with its maps.
- `model.svelte.ts`: `export * from './model-shared.svelte'`; for each entity-half name an exported function that calls `side().name(…)`, `side()` = `getStagingSide() === 'engine' ? engine : legacy` — in this task `engine` is `legacy` again (the engine half comes in Task 3); `validateAll()` and `resetModelStore()` are the facade's (they touch both halves).
- `replica.svelte.ts`: `getStagingSide(): StagingSide` (M3, first half), `_switches` read through `readSwitches()`.

- [ ] **Step 1: Write the failing tests.** `model-shared.test.ts`: `applyDeltaShared` bumps `_modelRev`, patches the summary's `model_rev` and `issue_counts`, applies the issue delta, clears the overlay, bumps the structure rev exactly when the formula says (an `id_map`, a relationship, a deletion, an unseen element; not a property-only change); `markStructureChanged`; `resetSharedStore`. `replica.svelte.test.ts`: `getStagingSide()` is `legacy` without a sync, `legacy` with `dr.surfaces` `{staging: 'legacy'}`, `engine` with `{staging: 'engine'}` at `ready`, `legacy` at `server` and at `off`, `engine` at `failed` and `frozen`.
- [ ] **Step 2: See them fail** — both files at import.
- [ ] **Step 3: Move.** `git mv` nothing: `model.svelte.ts` keeps its path (every importer), its content goes to the two new files. Keep the legacy half's code byte-for-byte where it can be, the shared references becoming setter calls.
- [ ] **Step 4: See them pass, and the WHOLE frontend suite unchanged** — every legacy store test (`model-store.test.ts`, `model.staged.test.ts`, `model.staged-delete-guard.test.ts`, `model.tree-items.test.ts`, `validate-staged.test.ts`, `checkout.*.test.ts`, `realtime.test.ts`, the component tests) passes without an edit: the facade dispatches to the legacy half and no test sets `staging`. `pixi run frontend-check`; ESLint's import rules.
- [ ] **Step 5: Docs.** README "State model": a first paragraph naming the four files and what each holds (D5), the legacy half frozen and deleted in F. AD-24: a line on the layout. `CLAUDE.md` "Shell" → a bullet "The store" naming the four files.
- [ ] **Step 6:** commit: `Split the model store into a facade, a shared half and the legacy half`.

---

### Task 3: The engine store — caches, `changed`, `applyDelta`, the handle

**Files:** Create `frontend/src/lib/state/model-engine.svelte.ts`, `__tests__/support/engine-store.ts`, `__tests__/model-engine.reads.test.ts`. Modify `model.svelte.ts` (dispatch to the engine half), `replica.svelte.ts` (M3: the handle, `subscribeReplicaStatus`), `__tests__/replica.svelte.test.ts`. Docs: README, `CLAUDE.md`.

**Agent:** `critical-implementer` — the cache invariants under peer deltas and the pending rule are where a subtle mistake passes the tests.

**Interfaces:** M3, M4, M6 (M5's `emit` is Task 4: in this task `emit` and the unstage family throw `Error('not built')` on the engine side, and the readers answer from an empty mirror). `engineStore(options?)` (`support/engine-store.ts`): `fakeProject()`, `localStorage['dr.surfaces'] = JSON.stringify({staging: 'engine'})`, `configureReplica({deps: …})` as `realReplica()` does, `startReplica()`, `await` the phase `ready`; returns `{project, sync, link, dispose}` where `dispose` runs `resetReplica()`, `resetModelStore()` and disposes the link. Every test file `afterEach(dispose)`.

- [ ] **Step 1: Write the failing tests** (`model-engine.reads.test.ts`, over `engineStore()`; MSW has NO read route, so a read that strays to the server fails the test):
  - `ensureElement reads the replica` — a smart-city id: cached after; `ensureElement('ghost')` → `null` and `getMissingElementIds()` has it; `ensureElement('tmp_x')` → `null` and MISSING too (D16: the engine answered 404, no short-circuit — spy on `sync.call` to see the read posted).
  - `ensureTreeItems and ensureElements fill the caches` — including a temp id staged through `link.client.call('stage', …)` directly: the tree item and the element ARE cached (the engine knows it).
  - `a peer delta refreshes what is cached` — cache two elements; `project.commit(rename of one)`; `feedCommit` through `handReplicaFeed` and `applyDelta` through the facade as the realtime store does (fact 26); after `sync.settled()`: the cached element carries the new name (from the delta's upsert AND the `changed` re-read — assert the value, and that `getElementsBatch` was asked with the cached id only); a deleted element leaves the caches and `getCachedTreeItems()`; `getStructureRev()` moved once for a structural delta and not for a property-only one.
  - `a peer delta does not clobber a staged edit` — stage a rename of `e` through `link.client.call('stage', …)`, `readMirror` having landed (wait for `sync.settled()` and the store's `stagedSettled()`); `project.commit` of a rename of `e` by the peer; feed it; the cache keeps the STAGED name (the working copy replayed the batch over the delta, and the upsert skipped the id).
  - `the structure rev follows changed.structural` — a `stage` of a create through the link: `getStructureRev()` moves; a property update: it does not.
  - `an own delta re-keys the caches and re-points selection` — stage a create through the link (`tmp_x`), cache it, `select({kind: 'element', id: 'tmp_x'})`, push a visit; `beginReplicaCommit()`, `project.commit(the same op)` → `settle({text: responseText, rev, applied: true, rebound: false, idMap, batchIds: [1]})`, `applyDelta(parsed response)`; after settled: `getCachedElements()` has the server id and not `tmp_x`, the selection and the visit stack carry the server id, `getStagedOps()` is empty (the mirror re-read), `getModelRev()` is the new rev.
  - `the handle detaches` — cache an element, `stopReplica()`: `getStagingSide()` is `legacy`, and after `startReplica()` again and `ready` the engine half starts empty (`getCachedElements()` has nothing, `getStagedOps()` is empty) — `detachEngine` cleared it.
  - `replica.svelte.test.ts`: `subscribeReplicaStatus` gets `(status, previous)` on every change; `attachEngine` is called on `startReplica` with a handle whose `status()` follows the store and `detachEngine` on `stopReplica` (spy the module).
- [ ] **Step 2: See them fail** — the files at import.
- [ ] **Step 3: Implement** M3, M4, M6 and the facade's dispatch. `applyDelta` in the facade dispatches by side; `applyDeltaShared` is called by BOTH halves' `applyDelta` (the legacy's existing shared writes were already turned into that call in Task 2).
- [ ] **Step 4: See them pass;** the whole suite; `pixi run frontend-check`.
- [ ] **Step 5: Docs.** README "State model": a subsection "The engine store" — the caches, what `changed` does (M6, fact 21's width), what `applyDelta` does on each side, D9, D16. `CLAUDE.md` "Shell" → "The store": the engine half's duties so far.
- [ ] **Step 6:** commit: `Read the model store's caches from the replica`.

---

### Task 4: The engine store — `emit`, the mirror, the readers, the unstage family

**Files:** Modify `frontend/src/lib/state/model-engine.svelte.ts`, `model.svelte.ts` (the new facade names), `state/index.ts`. Create `__tests__/model-engine.staging.test.ts`. Docs: README, `CLAUDE.md`, `architecture/contracts.md` (CT-5).

**Agent:** `critical-implementer` — the pending rule, the provisional entries and the settled predicate are ordering invariants a test can pass while wrong.

**Interfaces:** M5; the facade exports `emitMany(ops: ModelOp[]): void`, `stagedSettled(): Promise<void>`, `getStagedBatchIds(): number[]`, `getStagedConflicts(): StagedConflict[]`, `revertConflict(batchId: number): void`, type `StagedConflict` (on the legacy side: a loop of `emit`, a resolved promise, `[]`, `[]`, a no-op). `state/index.ts` re-exports them.

- [ ] **Step 1: Write the failing tests** (`model-engine.staging.test.ts`, over `engineStore()`):
  - `an edit is in the cache at once and in the engine after` — `emit(rename of e)`: `getCachedElements().get(e).properties.name` is the new name synchronously and `getStagedDepth()` is 1 before any await; after `stagedSettled()`: `getStagedOps()` is `[the op]`, `getStagedBatchIds()` is `[1]`, and `listElementsPage({q: <new name>})` from `lib/api` finds `e` (the real read through the seam).
  - `a create is reachable from the tree` — `emit(create_element tmp_…)`: cached under the temp id with a tree item at once; after settled, `listContainmentRoots` (the last page) lists it and `ensureElement(tmp)` keeps it cached (D16).
  - `a delete hides the row` — cache an element with a lite tree item; `emit(delete_element)`: it leaves `getCachedElements()` AND `getCachedTreeItems()` at once; `isStagedDeleted(id)`; after settled `getStagedDiff().counts.deleted` counts it and its containment children (fact 20), and `getElement(id)` from `lib/api` rejects `NotFoundError`.
  - `keystrokes coalesce and never bounce` — `emit(name 'a')`, `emit(name 'ab')`, `emit(name 'abc')` on one tick; poll the cached name on every microtask until settled: it is `'abc'` at every observation (never `'a'` after `'ab'`); after settled `getStagedOps()` is ONE op with `properties_patch: {name: 'abc'}`, `getStagedBatchIds()` is `[1]`, and `getStagedDepth()` is 1.
  - `a refused edit leaves no trace and says so` — `emit(update with an unknown property)`: the op is in the provisional mirror for a tick; after settled: `getStagedOps()` is empty, `getModelError()` is `{kind: 'rejected', message: "'Organization' has no property 'nope'"}` (the engine's text through `ValidationError`), the cached entity equals the engine's (re-read), and `getStagedDepth()` is 0. A refused create: the temp id is gone from the caches and the tree items.
  - `emitMany stages one batch` — three ops (a create and two updates of it): after settled one batch, `getStagedBatchIds()` `[1]`; a refused list (the last op bad) stages nothing and restores every touched entity.
  - `the name override and the ops-for reads` — after a rename and a create: `getStagedNameOverride(e)` is the new name, `getStagedNameOverride(other)` undefined, `getStagedOpsFor(tmp)` has the create; `hasStagedOps()`.
  - `undo removes the last batch` — rename `e` (batch 1), create `tmp` (batch 2), rename `e` again (coalesces into 1): `popLastStaged()` returns true and, after settled, batch 2 is gone, the temp id left the caches, batch 1 still holds `'…'` (D13); `popLastStaged()` on nothing returns false.
  - `revert for an element drops its incident relationship ops` — create `tmp`, connect it to `t` (`create_relationship`), rename `t`: `revertStagedForElement(tmp)` → after settled only the rename remains (the engine's `incident`); `revertStagedFor(t)` → nothing remains; `revertAllStaged()` after three edits → nothing, the caches equal the committed state (compare with a fresh `ensureElement` after a cache clear).
  - `a peer's delete parks a staged update` — `emit(update of x)`, settled; `project.commit(delete of x)`, feed it, `applyDelta`; after settled: `getStagedConflicts()` is `[{batch: {id: 1, ops: [the op]}, error: {status: 422, detail: "No element with id 'x"}}]`, `getStagedOps()` is empty (a parked batch is not staged), `revertStagedForElement(x)` removes it (fact 22), or `revertConflict(1)` does.
  - `stagedSettled waits for everything` — `emit` twice, `stagedSettled()` resolves only after both answers and the mirror read (assert `getStagedBatchIds()` is exact when it resolves).
  - `edits survive a re-bootstrap` — plan 5's `sync-heal` case through the store: two edits, every snapshot fetch failing, a wrong-digest delta → `failed`; heal the route, `retryReplica()`: `ready`, `getStagedOps()` the same two ops, `getStagedBatchIds()` the same ids, the caches still show them.
  - `an edit while frozen lands and is carried` — `feedRebind(rev)` via `handReplicaFeed`; `emit(rename)`: settled while `frozen`; `project.rebind(...)` and `replicaMetamodelAdopted()`: after `ready` the op is still staged (or parked, when the fake's new metamodel refuses it — assert whichever the fake's `rebind` gives and say which).
- [ ] **Step 2: See them fail** — every case (the engine side throws `not built`).
- [ ] **Step 3: Implement** M5. `applyOptimistic` is the legacy's minus the journal; keep its "uncached → nothing" rule for updates and deletes.
- [ ] **Step 4: See them pass;** the whole suite; `pixi run frontend-check`.
- [ ] **Step 5: Docs.** README "The engine store": `emit`'s four steps, the pending rule (D6), the mirror and the provisional entries (D7), `stagedSettled`, the unstage family's mapping (D10, D13), `getStagedDiff` (D14). CT-5.2: a sentence that a client keeps the edit under the caret while the engine answers and never lets the engine's answer regress a newer edit. `CLAUDE.md` "The store".
- [ ] **Step 6:** commit: `Stage the model edits in the replica`.

---

### Task 5: Commit, preview, validate and proposed ops through the engine's batches; the shadow gate

**Files:** Modify `frontend/src/lib/state/checkout.svelte.ts`, `stage-proposed.ts`, `model.svelte.ts` (`validateAll`), `lib/engine/shadow.ts`, `replica.svelte.ts`, `components/HistoryDrawer.svelte`. Create `lib/engine/staged-probe.ts`, `state/__tests__/checkout.engine.test.ts`; modify `lib/engine/__tests__/shadow.test.ts`, `state/__tests__/stage-proposed.test.ts`. Docs: README, `CLAUDE.md`.

**Agent:** `critical-implementer` — the batch ids on the flight are the CT-5.3 contract; a wrong list replays committed ops.

**Interfaces:** M7, M8. `checkout.svelte.ts` exports `discardConflict(batchId: number): Promise<void>`.

- [ ] **Step 1: Write the failing tests.**
  - `checkout.engine.test.ts` (over `engineStore()`, plus MSW routes for `/locks`, `/commits/preview`, `/commits` that record their bodies and answer from `project.commit(body.ops)`): `the commit sends the engine's batches and names them` — two edits; `commitStaged('m', false)`: the POST body's model ops are the engine's staged ops in batch order, `settle` (spy) got `batchIds: [1, 2]`; after `sync.settled()` and `stagedSettled()`: `getStagedOps()` empty, `getStagedConflicts()` empty, the caches re-keyed, `getModelRev()` the new rev; `an edit during the flight survives` — hold the `/commits` route; commit; `emit` a third edit while held; release: after settled `getStagedOps()` is that one op under a NEW batch id, its temp references remapped when it named a committed temp id; `preview waits for the engine` — `emit` then `previewStaged()` at once: the body holds the op (no race); `validateAll sends the engine's ops`; `a refused commit keeps the batches` — `/commits` answers 422: `flight.abandon` was called, `getStagedOps()` unchanged; `discardConflict releases the lease` — park a batch (a peer's delete, as Task 4), `discardConflict(1)`: the conflict is gone and `/locks/release` was asked for the element's token.
  - `stage-proposed.test.ts`, a new block over `engineStore()`: `stageProposedOps` posts ONE `stage` call carrying every op (spy `sync.call`), `id` hints kept, and returns `{ok: true, count}`; a refused list (the last op bad) stages nothing, restores every touched entity, and surfaces as `getModelError()` `{kind: 'rejected'}` — the outcome stays `{ok: true, count}`, since `emit` is void on both sides and `StageOutcome` has no `rejected` reason (say so in the hand-back if one reads better). The existing cases (the legacy loop) stay as they are.
  - `shadow.test.ts`: with `staged()` true nothing is compared — `server()` is never called; a difference found while nothing was staged and `staged()` turning true before the re-test ends silently; `replica.svelte.test.ts`: the shadow built by the store is handed `anyStaged`, which follows the engine store's `hasStagedOps` (stage one edit: a wrong MSW answer logs no `[shadow]` line; discard it: it does).
- [ ] **Step 2: See them fail; Step 3: implement** M7 and M8. `HistoryDrawer.svelte::doRevert` settles with `batchIds: getStagedBatchIds()`.
- [ ] **Step 4: See them pass;** `checkout.commit.test.ts` and every legacy commit test unchanged; `pixi run frontend-check`.
- [ ] **Step 5: Docs.** README "State model" step 4: the commit on the engine side (M8); "Shadow comparison": the staged gate; `CLAUDE.md` "Shell" → shadow's rule (plan 5's "only while nothing is staged" is now true).
- [ ] **Step 6:** commit: `Commit the replica's staged batches and drop them on the answer`.

---

### Task 6: The DiffDrawer's conflicts section, and the Staged elements section on the engine's diff

**Files:** Modify `frontend/src/lib/components/DiffDrawer.svelte`, `Sidebar/StagedSection.svelte` (only if its inputs need a change — they should not: `deriveStagedElementRows` takes what the facade now answers). Create `components/__tests__/diff-drawer-conflicts.test.ts`; modify `components/__tests__/staged-section.test.ts` (or the file that tests it).

**Agent:** `implementer` — the section is specified to the testid.

**Interfaces:** M9; `getStagedConflicts()` and `discardConflict()` from Task 5.

- [ ] **Step 1: Write the failing tests.** `diff-drawer-conflicts.test.ts` (a hand-made facade state is fine here: mock `getStagedConflicts` from `$lib/state` to return two parked batches): the section exists with the heading `2 staged edits no longer apply`, one row per batch with the engine's text verbatim, `Discard` calls `discardConflict` with the batch id, the drawer's `total` does not count them, no section when there are none. `staged-section.test.ts`: over `engineStore()`, a create, a rename and a delete: the rows are `new`, `modified`, `deleted` with the right names (the deleted one's from the diff's `before`), the per-row revert calls `discardElementCascade`.
- [ ] **Step 2: See them fail; Step 3: implement; Step 4: see them pass.**
- [ ] **Step 5: See it live** (the stack of plan 4's Task 9 Step 5, `localStorage.setItem('dr.surfaces', JSON.stringify({staging: 'engine'}))`, reload): create an element from the tree, rename it, search for it, open it, connect it, delete another: every surface follows without a commit; the badge counts; Undo; Discard; then, as a peer (`e2e/helpers/api-client.ts`'s pattern through curl with the session cookie), commit a delete of an element you have a staged rename on: the DiffDrawer shows the conflict, Discard clears it; commit the rest: the tree shows the server ids. Report what was seen.
- [ ] **Step 6: Docs.** README "State model": the conflicts section (D10); `CLAUDE.md`. Commit: `Show the staged edits that no longer apply`.

---

### Task 7: `K-39` — a peer's rebind re-reads the structure

**Files:** Modify `frontend/src/routes/p/[projectId]/+page.svelte` (`onReloadRebind`, `:303-316`), `e2e/engine-mode.spec.ts`, `e2e/helpers/api-client.ts` (a `peerRebind` if `peerCommit` cannot carry a `metamodel.rebind`: the peer takes the `mm` lease through `POST /locks` and commits as an owner), `BACKLOG-ENGINE.md`. `+page.svelte` has no unit test (plan 5 fact 13) and no e2e spec carries a peer's rebind today, so the test is e2e.

**Agent:** `implementer`.

- [ ] **Step 1: Write the failing test** — `engine-mode.spec.ts`: `a peer's rebind with a new element shows after Reload` — the page open on Smart City with the tree expanded; the peer commits `[metamodel.rebind {blob: the current YAML with one comment line added}, create_element {temp_id, type_name: 'Organization', properties: {name: 'After rebind'}}]`; the rebind banner shows; click `Reload`: the indicator passes `resyncing` and ends `ready` at the new rev, and the tree lists `After rebind` without a page reload.
- [ ] **Step 2: See it fail** (the row is missing until a later structural change); **Step 3:** `markStructureChanged()` after `replicaMetamodelAdopted()` in `onReloadRebind`; **Step 4: see it pass.**
- [ ] **Step 5:** `BACKLOG-ENGINE.md` `K-39` → `done`, one line. Commit: `Re-read the structure after a peer's rebind`.

---

### Task 8: `K-40` — a re-bootstrap that reaches `ready` re-reads the structure

**Files:** Modify `frontend/src/lib/state/replica.svelte.ts` (D17, in `onStatus`), `__tests__/replica.svelte.test.ts`, `BACKLOG-ENGINE.md`.

**Agent:** `implementer`.

- [ ] **Step 1: Write the failing test** — over `realReplica()`: force `failed` (every snapshot fetch failing after a wrong-digest delta), note `getStructureRev()`, heal, `retryReplica()`: at `ready` the rev moved by one; a plain open (`opening → ready`) moves nothing; a re-bootstrap from `diverged` moves it too.
- [ ] **Step 2: See it fail; Step 3: implement; Step 4: see it pass.**
- [ ] **Step 5:** `BACKLOG-ENGINE.md` `K-40` → `done`. README "Following": one sentence. Commit: `Re-read the structure once a rebuilt replica is ready`.

---

### Task 9: e2e — a staged edit visible in the tree

**Files:** Create `frontend/e2e/staged-edits.spec.ts`. Modify `e2e/helpers/replica.ts` if a wait is missing.

**Agent:** `implementer` — the spec's steps are named; the fixture and the helpers exist.

- [ ] **Step 1: The spec** (imports `test`/`expect` from `./fixtures`; `page.addInitScript` sets `dr.surfaces` = `{staging: 'engine'}` for THIS spec until Task 11 removes it): open Smart City, `expectReplicaReady`; create an element from the tree's new-element action, name it: the tree shows the row, the search finds it, the Inspector opens it, all before any commit and with no `[shadow]` line (shadow is gated); rename an existing element: the tree row and the search follow; delete one with children: its subtree leaves the tree; the change badge counts; Undo removes the last; Discard all empties the tree of the create and restores the delete; then create + rename + commit: the tree shows the new element under its server id (`data-id` no longer `tmp_`), the search finds it; as a peer (`peerCommit`) delete an element the page has a staged rename on: the DiffDrawer shows `1 staged edits no longer apply` with the engine's text, `Discard` clears it, the commit lands the rest; reload the page: the replica opens from the cache and nothing is staged (a reload loses staged edits, as today).
- [ ] **Step 2: Run it** — `pixi run frontend-test-e2e` whole (stop a stale `sandbox-start` first); judge against fact 27. A `[shadow]` line in ANY spec is a finding: with staging on the engine for this spec only, a line here means the gate is wrong; a line elsewhere is plan 5's rule broken.
- [ ] **Step 3:** `CLAUDE.md`'s e2e bullet: the spec. Commit: `Prove a staged edit shows in the tree before it is committed`.

---

### Task 10: The overlay's promise, and the frozen replica's

**Files:** Modify `frontend/src/lib/components/ReplicaFailedOverlay.svelte` (copy unchanged; this task PROVES it), `__tests__/replica.svelte.test.ts`; README.

**Agent:** `implementer`.

- [ ] **Step 1: Write the test** — over `engineStore()`: two edits; `failed`; `isReplicaBlocked()`; `retryReplica()`: `ready`, `getStagedOps()` the two ops (the overlay's sentence is true of the engine's batches — plan 5's D6); and the rebind banner's path: `feedRebind` → `frozen` → one edit → `replicaMetamodelAdopted()` → `ready` with the edit staged or parked, never dropped.
- [ ] **Step 2: See it pass** (nothing to implement if Tasks 4 and 8 did their work; if it fails, that is a finding — fix in the store, not the test).
- [ ] **Step 3:** README "Following" (`failed`) and "The freeze": what is kept, on which side. Commit: `Hold the retry overlay to its promise for the replica's edits`.

---

### Task 11: `staging: engine` by default

**Files:** Modify `frontend/src/lib/engine/surfaces.ts` (`STAGING_DEFAULT = 'engine'`), `__tests__/surfaces.test.ts`, `e2e/staged-edits.spec.ts` (the override goes), `e2e/fixtures.ts` (nothing to add: engine mode is the defaults). Docs: README "Surfaces".

**Agent:** `implementer`.

- [ ] **Step 1:** flip; the defaults assertion follows.
- [ ] **Step 2:** `pixi run frontend-test` — a unit test that relied on the legacy default WITH a replica running is a finding (tests without `startReplica()` never see the engine side: `getStagingSide()` is `legacy` without a sync).
- [ ] **Step 3:** `pixi run frontend-test-e2e` whole: every spec now stages on the engine with shadow gated; green, no `[shadow]` line; report the suite's wall time against Task 9's.
- [ ] **Step 4:** commit: `Stage in the replica by default`.

---

### Task 12: Closing docs — B is done

**Files:** `architecture/program.md`, `architecture/decisions.md` (`AD-29`), `architecture/contracts.md`, `BACKLOG-ENGINE.md`, `CLAUDE.md`, `frontend/README.md`.

**Agent:** `chores` for the mechanical parts, `implementer` for the verification run.

- [ ] **Step 1: Docs.** `program.md`: B's status row — six plans built, B done (spec §12: the five surfaces and staging default to the engine, the server path behind the switch; cold open and heap as measured in plan 5; the divergence-recovery test; `K-30`, `K-31` closed) *(measured numbers quoted from plan 5's row)*. `decisions.md`: `## AD-29 · Staged edits stay under the caret` — **Decision:** the engine store writes an edit into its caches synchronously and lets no engine answer regress a newer edit; the engine's staged list is mirrored, never predicted. **Why:** the property form emits per keystroke and renders from the cache (fact 6); an answer that overwrote a later keystroke would move the caret; predicting batch ids and versions would make the mirror drift the first time an event and an answer crossed. **Rejected:** a per-field draft (every emitter would need one); applying `stage` answers to the mirror (the `changed` event, not the answer, is the engine's word on the staged list). `contracts.md` CT-5: item 4 gains *(not built in B: no read takes `committed: true`; the committed image crosses through `stagedDiff`)*; item 5 gains *(B: the model family; artifacts in C)*. `BACKLOG-ENGINE.md` `R-3`: B done, C next; the open list. `CLAUDE.md`: "Shell" opens with what the replica serves AND stages; "Backend session" — "the client never holds the whole model" gains "except through the replica, which mirrors it and stages the model edits"; `frontend/README.md` "State model": the legacy paragraph is marked the server-mode path.
- [ ] **Step 2: Every suite, every linter.**
```bash
pixi run dr-test
pixi run dr-tidy true
pixi run frontend-test-e2e
pixi run golden-fixtures
git status --short
```
Expected: core pytest, engine and sandbox vitest at their old counts (nothing under `engine/`, `sandbox/` or `src/` moved); frontend green, fact 27's noise aside; no fixture moved; `git status` shows Step 1's files alone.
- [ ] **Step 3: Commit** `Mark the forked store built and sub-project B done`, then, with the owner's go-ahead: `git switch engine-migration && git merge --ff-only feat/forked-store`.

---

## Known limits

- **A stage is a round trip per keystroke** — the rebase from the coalesced batch, K-32's numbers — and every `changed` event triggers a mirror read (`staged`, `conflicts`, `stagedDiff`: three messages copying every staged op). With a thousand staged ops that is a few hundred kilobytes per keystroke, watched, not optimized.
- **The badge lags the engine by a mirror read** (D7): after a commit the count shows the committed ops until the own delta's `changed` lands; `stagedSettled()` makes the commit itself exact.
- **A cached relationship changed by a peer under a staged edit of it** shows its stale properties until the relationships list refetches (D9); a cached relationship's property edit by the user is exact (the answer's post-state).
- **`getStagedDiff` is the committed image against the record** (D14): an edit undone by hand is no change; the op stays staged and commits (a no-op on the server).
- **`unstage {entity}` leaves parked batches** in the engine (fact 22); the store drops them itself in `revertStagedForElement`, but `revertStagedFor` (the drawer's per-element row) leaves a parked batch for the conflicts section.
- **Table cells keep their overlay** (`getStagedOpsFor`, `getStagedNameOverride` over server-rendered cells): tables are server-rendered until C, and the overlay reads the mirror.
- **A reload loses staged edits**, as today; the retry overlay and the rebind banner keep them.
- **`ensureRelationship` stays cache-only** on both sides: there is no single-relationship read.
- **The legacy half keeps its guards and its journal**, verbatim, until F.
- Not checked while planning: that the fake project server's `rebind(nextId, nextDoc?)` can be given a metamodel that refuses a staged op (Task 4's last case says to assert whichever it gives); that e2e's `peerCommit` can carry a `metamodel.rebind` (Task 7 names the fallback); that happy-dom lets a `.svelte.test.ts` observe the cache on every microtask (Task 4's bounce case can poll on `await Promise.resolve()` in a loop bounded by the settled promise); the wall time of e2e with staging on the engine (Task 11 reports it).

## When B is done

Plan 6 closes sub-project B (`architecture/program.md`). What C inherits:

- **The engine holds one staged state for the model family**; evaluation (C) reads it through the working copy. The artifact family is C's: `staged()`, `adoptStaged`, `batchIds` and the mirror are keyed by batch, not by op kind, and `commitStaged` takes the model slot from the engine and the rest from the legacy buffers (D1).
- **CT-5.4 (`committed: true`) is not built**; C decides whether evaluation needs it.
- **The legacy half** (`model-legacy.svelte.ts`) and the server read paths live until F, behind `staging: legacy` and `dr.surfaces`.
- **The table cells' overlay** goes when tables move to the engine (C).
- Open after this plan: `K-29`, `K-32`, `K-35`, `K-36`, `K-38`, `C-20`, `C-21` in `BACKLOG-ENGINE.md`; `K-33`, `K-34` in `BACKLOG.md`.
