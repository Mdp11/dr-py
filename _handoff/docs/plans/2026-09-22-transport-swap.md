# Transport Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline, one commit per task (the owner's choice for this program; Task 12 is five commits, one per surface). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The five model read surfaces — elements, fuzzy search, incident relationships, containment tree, summary counts — are answered by the engine replica in the sandbox worker, each behind its own switch with the server as fallback; the workspace waits for the replica with an honest progress bar; a tab whose engine cannot start says so and reads from the server; a replica that cannot be rebuilt blocks the workspace with a way back that loses nothing; shadow comparison holds the engine to the server in dev and in every e2e spec; and a browser benchmark says whether the cold open and the heap meet CN-3.

**Architecture:** Plan 5 of 6 for sub-project B (`architecture/program.md`). Nothing new runs anywhere: the replica of plan 4 gains readers. `lib/api`'s nine read functions keep signature and schema and pick a side through `route(surface, …)` over an INJECTED seam (`lib/api` still imports nothing of `lib/engine` or `lib/state`); `lib/engine/surfaces.ts` holds the switches, `lib/engine/seam.ts` turns a `ReplicaSync` into that seam, `lib/engine/shadow.ts` compares the two sides. `sync.ts` gains `call` — which waits for the link and for every `rev` the shell has been told of (the read barrier, `AD-28`) — the view placements, `retry()`, the `reset` input and one retry of a failed tail fetch. The server gains one header-only feed event, `reset`, for a `model_rev` bump that writes no journal row (`K-37`). The benchmark is a static bench page on the app's origin driving the real sandbox, run by Playwright.

**Tech Stack:** TypeScript 6, Svelte 5, Vite 8, vitest 3 (happy-dom + MSW, the real engine through `connectInProcess()`), Playwright (Chromium) for e2e and the benchmark, Python 3.14 / FastAPI / pytest for the one server change; pixi for every command.

**Spec:** `docs/superpowers/specs/2026-09-19-replica-and-frontend-seam-design.md` — §6's last two bullets (the progress slices, the boot fallback), §7 (the seam) and §9 (tests, `engine-bench-browser`) are this plan's scope; §8 is plan 6's. Read first: `architecture/README.md`, `program.md` (B's row, MR-1 to MR-4), `contracts.md` (CT-2, CT-4, CT-5), `constraints.md` (CN-3, CN-5, CN-9, CN-14 to CN-17), `decisions.md` (AD-10, AD-16, AD-22, AD-25 to AD-27), `system.md`; then plan 4 (`docs/superpowers/plans/2026-09-21-sandbox-and-shell.md`: Decisions, Mechanisms M7–M11, Known limits, After this plan); then `CLAUDE.md`'s "Engine package" (`src/read/`, `src/service/`), "Sandbox" and "Shell", and `frontend/README.md`'s "Replica (engine shell)", "State model" and "Auth, projects & routing".

**What kind of plan this is.** As plan 4: direction with specifics — interfaces, signatures, the test cases and what each asserts, the order, and the mechanisms that are easy to get wrong. It holds no full code, and nothing in it was built; the expected results of the "see it fail" steps are reasoned from the code. If a step's expected result does not appear, trust the run, read the step's intent, and say so in the hand-back. What WAS checked while planning is listed next.

## What planning found

Checked against the code at `be8c46a` (branch `feat/transport-swap`, cut from `engine-migration`), by reading; fact 20 by a throwaway probe in the session's scratch directory.

1. **No production code calls a silent-bump route.** `uploadModelBody`, `loadModelFromPath`, `uploadMetamodel`, `clearMetamodel`, `createElement` / `patchElement` / `deleteElement`, `createRelationship` / `deleteRelationship`, `applyOps` / `undoOps` are called by `lib/api/__tests__/**` only. `K-37`'s second option ("the shell re-bootstraps after its own such calls") has no call site; only a peer, a test or a script triggers the bump.
2. **Server side of `K-37`.** `Session.touch_model()` (`session.py:286-312`) and `set_model()` (`:266-284`) bump `model_rev`, have `self.hub`, no DB handle, and broadcast nothing. Call sites: `routes/elements.py:32,58,69` and `routes/relationships.py:36,47` (`touch_model`, WITHOUT `write_mutex`, two of them in a `finally`); `routes/model.py:122,155,162,201` (`set_model`); `session.py:327` (`set_metamodel` → `set_model(None)`, reached from `POST /metamodel` and `DELETE /metamodel`). `_install_model` (`routes/model.py:201-206`) calls `set_model` and THEN `persist_baseline`, which clears history and writes the snapshot; `POST /metamodel` (`routes/metamodel.py:81-97`) calls `set_metamodel` and THEN writes its rows and clears history. `content.record_snapshot` upserts. After a `touch_model` hole `GET /replica/snapshot` writes a fresh v2 snapshot at head (`replica.py:34-38`: the list of revs must equal the range), and `GET /replica/tail` is incomplete. `snapshot_event` is sent on connect only (`routes/feed.py:100-101`), never broadcast. `DELETE /metamodel` writes nothing to the database (no `db` in its signature): `K-38`, new.
3. **The legacy store on a snapshot event** (`realtime.svelte.ts:195-211`): presence and the lock table replaced, `refreshSummary()` when the server is ahead, a debounced issues refetch. No cache is invalidated.
4. **The pump is asynchronous, so arrival order does not protect a read.** `sync.ts`: `enqueue → pump → drain → handle → live().call('applyDelta')`; `drain` awaits each input's answer before it posts the next one, and holds while a commit is in flight. After `flight.settle(...)` with a peer's delta waiting, the peer's delta is posted, the user's own only after its answer — and `checkout.svelte.ts` runs `applyDelta(res)` right after `settle`, whose effects (a structure bump, the tree's refetch, `refreshSummary()` writing `_modelRev`) post reads in between. A read can therefore answer from BEFORE a commit the UI already shows. While opening it is worse: the feed's deltas reach the legacy store at once and the replica only after `ready`.
5. **The link is lazy.** `client(c)` builds it after the descriptor said there is a model (`sync.ts:331-354`); a read can be asked for before it exists. `dropLink()` also runs inside a run (an `EngineGoneError` in an attempt), and the next attempt builds a NEW worker — which holds no view placements.
6. **`open(sameId)` is a no-op in every phase** (`sync.ts:836-838`); `run` is cleared by `stop()` alone. `run.held` (the staged and parked batches read before `close`) is cleared on success only (`:470`), so after `giveUp` → `failed` it is still there, and `rebootstrap(r)` → `resync` skips the read when `r.held !== null` (`:574`). A failed fetch or call while following goes straight to `ask` → re-bootstrap (`:757-763`); a re-bootstrap drops the cache row and never reads the cache (`:601,606`).
7. **The nine functions.** `getElement` (`api/elements.ts:16`); in `api/model-read.ts`: `getModelSummary` `:32`, `getElementsBatch` `:41`, `getTreeItemsBatch` `:54`, `listElementsPage` `:72`, `listElementRelationships` `:135`, `listContainmentRoots` `:152`, `listExcludedRoots` `:205`, `listContainmentChildren` `:248`; the two `…Paged` wrappers (`:183`, `:223`) sit on top and need no change. None takes an `AbortSignal`. Production callers import the modules directly, never the barrel. The store passes `_clientConfig` (`model.svelte.ts:123`), `undefined` in production.
8. **Engine params** (`engine/src/read/params.ts`, `elements.ts`, `tree.ts`): flat, snake_case. `elementId` → `id` (three reads), `viewId` → `view_id`, a positional id list → `{ids}`; `type`, `q`, `limit`, `offset`, `direction` are the same names. Defaults `limit` 100 / `offset` 0 on both sides (`routes/read.py:195-196,446-447,513-514,552-553,584-585`), and `lib/api` omits what the caller omitted. `getTreeItemsBatch` answers `{items}` with no `total`; `TreeItemPageSchema` defaults it.
9. **The engine's summary carries `issue_counts: null` and `undo_depth: 0`**, and `ModelSummarySchema` accepts both. `refreshSummary()` (`model.svelte.ts:961-967`) writes `_issueCounts = s.issue_counts` — routed to the engine as it stands, every refresh would blank the issue counts. `undo_depth` is read nowhere. Every `getModelSummary()` in a component is the STORE getter; the one API caller is `refreshSummary()`.
10. **Search.** `Sidebar/Search.svelte:54-79`, `Navigation/ElementStartPicker.svelte:21-45` and `Snippet/ElementContextRow.svelte:50-73` are the same pattern: a debounce, a sequence counter, no abort — a superseded search runs to its end. On the engine a search is a full scan in steps, and scans run one after another.
11. **Views.** Only the ACTIVE view's content is loaded; the committed document exists in one place, `res.view` inside `refreshView()` (`view.svelte.ts:193`), before the staged ops are replayed onto it; every change of it (boot, a view switch, an own commit, a peer commit of `view` scope, a `view_event`, the JSON editor's save, a delete, a discard, a model reload) goes through `refreshView()`. `clearViewState()` (`:112-117`) is the project switch. The server's list is `read.py:537-547`: the raw union of `folder.elements` over every nested folder — no filter, artifacts excluded. No frontend helper computes it (`view-tree.ts`'s `placedElementIds` filters). `listExcludedRoots` has one caller, `ContainmentTree.svelte:305,323`, always with the active view's id.
12. **The open journey.** `state/open-journey.ts`: `PhaseName = upload|create|hydrate|validate|finalize`, `SLICES` per `JourneyKind` (`:92-109`; open: hydrate 0–72, validate 72–95, finalize 95–100), a monotonic eased percent; `beginJourney` is idempotent because the picker starts it before navigating (`routes/projects/+page.svelte:44`); `boot()` ends it in its `finally` (`+page.svelte:224-227`), so the overlay lasts as long as `boot()`; `journeyStatus` is fed by `open-progress.svelte.ts`'s poll of `GET /model/status`. `ProgressOverlay.svelte` (`fixed inset-0 z-[60]`) is the only blocking surface in the app.
13. **Banners** are inline `col-span-5` rows of `+page.svelte` (`:443-525`), each an `auto` row of `grid-template-rows` (`:426-434`), `role="alert"`; no toast, no dismissal persistence. Copy in use: `The metamodel was changed to rev N (K conformance issues). Reload to continue.`; `Model out of sync` / `Edit rejected`; `Disconnected` + `Realtime connection lost.` `+page.svelte` has no unit test.
14. **`boot()`** (`+page.svelte:134-228`): `getMetamodel` → `loadViews` → `refreshView` → `refreshSummary` (a throw returns: "a metamodel but no model") → `refetchIssues` (not awaited) → `loadProjectInfo` → `loadArtifacts`. Mount order: `startReplica()`, `startRealtime()`, …, `boot()` (`:79-93`).
15. **e2e.** 19 specs, each importing `@playwright/test` directly; no fixture file, no `storageState`; `page.addInitScript` is the one pre-boot hook in use (`smoke.spec.ts:70`). The app is `vite dev` (so `import.meta.env.DEV` is true there), the sandbox a production build. `replica.spec.ts:86-105` watches the console from after the login on: the login page's session probe answers 401 by design. `workers: 1`.
16. **No code reads `import.meta.env.DEV` today**, and there is no flag pattern: every `localStorage` key is `ui.*` UI state behind a local try/catch.
17. **The sandbox's policy is one `headers` constant** in `sandbox/vite.config.ts:3-11`, sent as HTTP headers on `preview` and `server`; `APP_ORIGIN` is an `import.meta.env` read (`sandbox/src/origins.ts`), which the config cannot evaluate. `e2e/isolation.spec.ts:5-7,19` pins the CSP by exact equality; CN-17 quotes it.
18. **Bench inputs.** `scripts/snapshot_v2.py` writes the INFLATED text and the metamodel document; no gzip of M as the server encodes it exists (`benchmarks/spike.snapshot.json.gz` is the spike's v1 document). Playwright belongs to `frontend/` alone. The spike's heap number (`spikes/client_engine/run.mjs:37-47`) was a PAGE heap through `context.newCDPSession(page)`; the engine now lives in a dedicated worker inside an out-of-process iframe.
19. **Known noise, not this plan's.** e2e `script-embedding.spec.ts:91` and `snippet-flow.spec.ts:69` fail on `engine-migration` as it stands. The frontend's vitest run prints 26 `ECONNREFUSED 127.0.0.1:3000` lines: happy-dom's default origin is `http://localhost:3000`, and a relative fetch no MSW handler claims goes there. Both predate plan 4; a run is judged against them, and neither is fixed here.
20. **The benchmark's way in.** *Probe (scratch files, deleted with the session; headless Chromium 148.0.7778.96 through the frontend's Playwright, Ryzen 9 3900X, WSL2, load ≈ 0.1):* a static page on `http://127.0.0.1:5173` with COOP and COEP, a hand-written handshake and client, the built sandbox on `localhost:5174`, M's gzip (6,108,779 bytes) streamed from loopback.
    - It works end to end: both sides isolated, the handshake 15–28 ms after the iframe is appended (the `message` listener must exist BEFORE the append — `frame.ts` does that), no CSP violation; an empty tail `{"from_rev":1,"head_rev":1,"complete":true,"deltas":[]}` answers `applied` and `replica ready` fires.
    - **Cold open 1.77 s** to `ready` (1,821 / 1,771 / 1,756 ms; 1.85 s under `channel: 'chromium'`). The body is posted whole after ≈ 40 ms: the rest is the worker. That is HALF of the 3.4 s the owner saw through the app — the difference is everything the bench page does not do (the descriptor and metamodel round trips through the dev proxy, the copies kept for the cache, a main thread busy with `boot()`), and Task 2 measures that gap instead of guessing at it.
    - **The longest `staged` round trip during an open: 27–29 ms** (headless shell; 29–43 ms under full Chromium), ≈ 190 pings an open averaging 10 ms, 11–16 of them past 16 ms, none past 50. `staged` is a `now` method answered on the worker's next host turn, so this bounds the longest slice from above — and it is OVER CN-3's 16 ms. The main thread's own work is inside the number.
    - **Heap: 115.2 MB** `usedSize` after a collection (132–150 MB before it; 19.5 MB more of `ArrayBuffer` backing stores), read over the WORKER's own `webSocketDebuggerUrl`: launch with `--remote-debugging-port`, `GET /json/list`, the target of type `worker` whose `url` holds `engine-worker`, a plain WebSocket (Node 22's global), `HeapProfiler.collectGarbage` then `Runtime.getHeapUsage`. It equals the owner's devtools number. What does NOT work: `page.workers()` lists the worker but a worker has no `performance.memory`; `performance.measureUserAgentSpecificMemory()` in the sandbox frame works only under `channel: 'chromium'` with `--enable-blink-features=ForceEagerMeasureMemory` and counts backing stores too (134.6 MB); `context.newCDPSession(frame)` needs an out-of-process frame, which Playwright's default headless shell does not give; a flattened browser-level session cannot address a child session through Playwright.
    - CDP evaluation is not stopped by the sandbox's CSP. The wire op is `{kind: 'update_element', id, properties_patch}`. `stage` answers the WHOLE batch back (1,000 ops echoed — a structured clone inside the round trip): 1,000 ops staged in 48–55 ms, `unstage 'all'` in 46–50 ms, through the port.

## Decisions

Taken with the owner (2026-09-22):

- **D1. Bench first, then all five.** The browser benchmark is Task 2 and its numbers go to the owner; a miss pauses the plan for the owner's call before anything is optimized. Then summary, elements, relationships, tree and search each flip to the engine in their own commit, each after a clean shadow run (Task 12).
- **D2. Shadow comparison runs in every e2e spec.** A new `e2e/fixtures.ts` extends `test`: engine mode and shadow on through `localStorage` before the app boots, and any console line starting `[shadow]` fails the test. All 19 specs import it.
- **D3. Shadow is opt-in in dev**: code under `import.meta.env.DEV` (absent from a build), off unless `localStorage['dr.shadow'] === '1'`.
- **D4. `K-37`: the server says so.** A `model_rev` bump that writes no journal row broadcasts a header-only `{"type": "reset", "model_rev"}`. The shell treats it as a snapshot event ahead of the replica: catch-up, an incomplete tail, a re-bootstrap.
- **D5. The boot-fallback notice** is a dismissible warning row: `The in-browser engine could not start — this tab reads from the server instead. Reload the page to try again.` `[Dismiss]`. The reason stays in the indicator's title.
- **D6. The re-bootstrap banner** blocks the workspace: label `Model out of sync`, text `The local copy of the model could not be rebuilt from the server. Your uncommitted edits are kept.`, one button `Retry` — an IN-PLACE re-bootstrap that adopts the batches the sync still holds. Never a page reload: that would lose the legacy store's staged edits today and the engine's from plan 6 on.
- **D7. A tail FETCH that throws while following is tried once more** after 1 s before a re-bootstrap. A refused engine call, a gap, an incomplete tail and a digest mismatch re-bootstrap at once, and a re-bootstrap still never reads the cache.
- **D8. `off` wakes, `server` stays.** A `reset` or a snapshot event in `off` (no model) restarts the open; `server` is terminal for the tab (spec §6), and the notice says to reload.

Taken by this plan — each small, each reversible at review; say so if one is wrong:

- **D9. A read waits for what the shell has been told** (`AD-28`, fact 4). `sync.call` holds a read until the replica's `rev` has reached the highest `rev` handed to the sync before the call (`feedCommit`, an applied `settle`, `feedSnapshot`, `feedReset`). Plan 4's note said `call` "waits for nothing itself"; arrival order in the engine does not cover an `applyDelta` the shell has not posted yet. No engine change.
- **D10. `lib/api` stays free of `lib/engine`.** The seam is injected (`installEngineSeam`), like the two callbacks `lib/api` already takes. The `Surface` type lives in `lib/api/engine-route.ts`; `lib/engine` imports it.
- **D11. A call with an explicit `baseUrl` or `fetch` is a server call.** It names its server; that keeps every MSW test of the server path as it is (MR-4).
- **D12. A surface's EFFECTIVE side** is `engine` iff its switch says so and the replica's phase is neither `off` nor `server`; and a call the engine cannot answer at all (`EngineGoneError`: the link was disposed while it waited) is answered by the server instead. That is the boot fallback for reads already in flight.
- **D13. The gate, the notice and the banner exist only when some surface is on the engine** (`anyEngineSurface`). With every switch on `server` plan 4's behaviour stands: an indicator, nothing else.
- **D14. The progress bar is led by the replica once it reports.** Phases only move forward (`upload < create < hydrate < validate < download < parse < index < tail < finalize`), so `download` and `parse`, which interleave, cannot flap, and a late `validate` poll cannot pull the bar back. A journey begun with `replica: false` keeps today's slices exactly.
- **D15. Placements belong to the sync**: it remembers what was registered and sends it again to every new link (fact 5). The view store registers the COMMITTED document's ids from inside `refreshView()` (fact 11).
- **D16. The summary keeps its issue counts.** With `summary` on the engine, `refreshSummary()` leaves `_issueCounts` alone and asks `refetchIssues()`; shadow compares a summary without `issue_counts` and `undo_depth`.
- **D17. `signal` for the three searches**, not only `Sidebar/Search.svelte` (fact 10): a stale scan delays the fresh one.
- **D18. The override is honoured in a build too** (`localStorage['dr.surfaces']`): MR-1's switch is also a support lever. Shadow is not (D3).
- **D19. `set_model` and `touch_model` announce by default; two routes announce late.** `_install_model` and `POST /metamodel` pass `announce=False` and call `session.announce_reset()` after their durable writes (fact 2): an early event would send a replica to the descriptor route between the bump and `persist_baseline`, and cost a second full snapshot.
- **D20. The benchmark needs no backend.** A bench page served on `http://127.0.0.1:5173` (the only origin the sandbox answers) drives the real built sandbox through `frame.ts` and `client.ts`; the gzip is the server's own encoder's (`scripts/snapshot_v2.py` gains `--gzip`).
- **D21. `staging` is not a switch yet.** `surfaces.ts` names the five read surfaces; plan 6 adds `staging` with the store that reads it. Shadow's "only while nothing is staged" is plan 6's too: in this plan nothing is ever staged in the engine, and both sides answer committed state.

## Global Constraints

- Everything runs through pixi. No global `node` or `python`.
- Branch `feat/transport-swap` exists, cut from `engine-migration` at `be8c46a`; it is fast-forwarded back in Task 13. Never touch `main`. **Commit only with the owner's go-ahead for this plan's execution — ask before Task 1.**
- **Nothing under `engine/src/` changes.** If a task seems to need it, stop and report. Under `src/data_rover/` exactly Task 3's files change (`api/session.py`, `api/feed.py`, `api/routes/model.py`, `api/routes/metamodel.py`) — none is in an MR-3 frozen area (`core/model`, `core/metamodel`, the op applier, `routes/read.py`'s route functions, `routes/elements.py::get_element`).
- Import rules (plan 4's, kept): `lib/api/*` imports no `lib/state/*` and no `lib/engine/*`; `lib/engine/*` holds no rune and imports no `lib/state/*` (it may import `lib/api/*`); production code imports `$engine` / `$sandbox` as types only.
- Tests run the real engine (`connectInProcess()`, `fakeProject()`, `syncOver()`), never a mock of it (RC-14); MSW with `onUnhandledRequest: 'error'`; no fake timers — waits are injected (`deps.sleep`) or awaited (`sync.settled()`); every link is disposed in teardown.
- A migrated surface is tested by running the real engine on the smart-city fixture; the MSW tests of its server path stay untouched (MR-4).
- Engine results pass the SAME zod schema as the server's body. The shell never re-serializes model content for the engine (AD-26).
- Performance: build what is written, report numbers, optimize nothing. Task 2's checkpoint is the judge.
- Comments and docstrings: concise, present tense, only what the code cannot say; no spec, plan, phase or `architecture/` id in code.
- `architecture/`, `CLAUDE.md`, `frontend/README.md`, `BACKLOG-ENGINE.md` change in the commit of the code they describe (RC-10). `docs/` and `benchmarks/` are git-ignored — never `git add -f`.
- Commit subjects: one imperative sentence, capitalized, no prefix, no trailing period; the message ends with the session's `Co-Authored-By` line.
- A "see it fail" step lists what it expects red; any OTHER red test is a finding to report, judged against fact 19's known noise.
- Ids: this plan uses `AD-28` and `K-38`. Next free afterwards: `K-39`, `C-22`, `AD-29`.
- Formatting and lint: `pixi run frontend-tidy`, `pixi run sandbox-tidy`, `pixi run core-lint` / `backend-lint`; check-only is `pixi run dr-tidy true`.

## File Structure

```
sandbox/vite.config.ts                        + frame-ancestors, the app's origin through loadEnv
frontend/e2e/isolation.spec.ts                the pinned CSP

scripts/snapshot_v2.py                        + --gzip: the encoder's own bytes beside the text
pixi.toml                                     engine-bench-data writes the gzip; + engine-bench-browser
frontend/bench/index.html, main.ts            (new) the bench page: frame.ts + client.ts, the measurements
frontend/bench/vite.config.ts                 (new) root bench/, 127.0.0.1:5173, COOP + COEP, serves benchmarks/
frontend/bench/run.ts                         (new) the Playwright driver: 3 passes, medians, the verdict
frontend/package.json                         + "bench:browser"

src/data_rover/api/feed.py                    + reset_event
src/data_rover/api/session.py                 announce_reset(); set_model / touch_model / set_metamodel(announce=True)
src/data_rover/api/routes/model.py            _install_model announces after persist_baseline
src/data_rover/api/routes/metamodel.py        POST /metamodel announces after its rows
tests/api/test_feed_reset.py                  (new)

frontend/src/lib/api/feed.ts                  + the reset member of FeedEvent
frontend/src/lib/api/engine-route.ts          (new) Surface, Side, EngineSeam, installEngineSeam, route
frontend/src/lib/api/elements.ts, model-read.ts   the nine functions routed; signal on the option bags
frontend/src/lib/engine/sync.ts               + call, setViewPlacement, dropViewPlacement, retry, feedReset; the tail retry; off wakes
frontend/src/lib/engine/surfaces.ts           (new) SURFACES, SURFACE_DEFAULTS, readSurfaces, anyEngineSurface
frontend/src/lib/engine/seam.ts               (new) createEngineSeam(sync, surfaces, shadow?)
frontend/src/lib/engine/quiet.ts              (new) addQuietProbe, quiet
frontend/src/lib/engine/shadow.ts             (new) shadowEnabled, createShadow
frontend/src/lib/engine/placements.ts         (new) placedElementIds(view)
frontend/src/lib/state/replica.svelte.ts      installs the seam; the gate, the notice, the block, retry, placements
frontend/src/lib/state/realtime.svelte.ts     the reset event
frontend/src/lib/state/model.svelte.ts        refreshSummary keeps the issue counts on the engine side
frontend/src/lib/state/view.svelte.ts         registers and drops placements; a quiet probe
frontend/src/lib/state/open-journey.ts        + download, parse, index, tail; forward-only; journeyReplica
frontend/src/lib/components/ReplicaFallbackNotice.svelte, ReplicaFailedOverlay.svelte   (new)
frontend/src/lib/components/Sidebar/Search.svelte, Navigation/ElementStartPicker.svelte, Snippet/ElementContextRow.svelte   abort
frontend/src/routes/p/[projectId]/+page.svelte, routes/projects/+page.svelte   the gate, the two components, beginJourney's flag
frontend/e2e/fixtures.ts                      (new) engine mode, shadow on, [shadow] fails the test
frontend/e2e/*.spec.ts (19)                   import { test, expect } from './fixtures'
frontend/e2e/engine-mode.spec.ts              (new)
tests, READMEs, CLAUDE.md, BACKLOG-ENGINE.md, architecture/{contracts,constraints,decisions,program}.md
```

## Mechanisms

**M1 — The switches** (`lib/engine/surfaces.ts`). `SURFACES = ['elements', 'search', 'relationships', 'tree', 'summary'] as const`; `SURFACE_DEFAULTS: Record<Surface, Side>` — every entry `'server'` until Task 12. `readSurfaces(storage = globalThis.localStorage)`: the defaults, overlaid with `JSON.parse(storage.getItem('dr.surfaces'))` when that is an object — a known surface with the value `'engine'` or `'server'` is taken, anything else ignored; any throw (no storage, bad JSON) is the defaults. `anyEngineSurface(surfaces)`. The replica store reads it ONCE per page load (spec §7) and `resetReplica()` forgets it, for tests. Which function belongs to which surface: `elements` — `getElement`, `getElementsBatch`, `listElementsPage` without a `q`; `search` — `listElementsPage` with a `q` that is not blank after `trim()`; `relationships` — `listElementRelationships`; `tree` — `getTreeItemsBatch`, `listContainmentRoots`, `listExcludedRoots`, `listContainmentChildren`; `summary` — `getModelSummary`.

**M2 — The seam** (`lib/api/engine-route.ts`).
```
type Surface = 'elements' | 'search' | 'relationships' | 'tree' | 'summary'
type Side = 'engine' | 'server'
type EngineCall = <T>(method: string, params: unknown, signal?: AbortSignal) => Promise<T>
type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown }
type EngineSeam = {
  side(surface: Surface): Side                 // the effective side (D12)
  call: EngineCall
  gone(error: unknown): boolean                // the engine cannot answer at all
  shadow?(probe: {surface: Surface; method: string; params: unknown; engine: Outcome;
                  again(): Promise<unknown>;   // the same engine call once more, parsed
                  server(): Promise<unknown>}): void
}
installEngineSeam(seam: EngineSeam | null): void
engineSide(surface: Surface): Side             // 'server' without a seam
route<T>(surface, cfg: ClientConfig | undefined, engineCall: (call: EngineCall) => Promise<T>, serverCall: () => Promise<T>): Promise<T>
```
`route`: no seam, or `cfg?.baseUrl !== undefined || cfg?.fetch !== undefined` (D11), or `side(surface) === 'server'` → `serverCall()`. Else `engineCall(seam.call)`; a rejection for which `seam.gone(error)` holds → `serverCall()`; otherwise the engine's outcome is the answer, and when `seam.shadow` exists it is handed a probe — the outcome, `again` (`() => engineCall(seam.call)`) and `server` (`serverCall`) — inside a `try`, not awaited, its promise's rejection swallowed: nothing it does can reach the caller. `engineCall` parses with the function's own schema, so a body the schema refuses rejects as a server body would. `method` and `params` reach the probe through a small wrapper around `seam.call` inside `route` that records the one call `engineCall` makes.

**M3 — `sync.call` and the read barrier** (`AD-28`). `call<T>(method, params?, options?: {signal?: AbortSignal}): Promise<T>`:
1. No run, or phase `off` or `server` → reject with `EngineGoneError` at once.
2. `target = known` — the highest `rev` handed to the sync so far: `feedCommit(raw, rev)`, a `settle` with `applied`, `feedSnapshot(modelRev)`, `feedReset(rev)`; reset to 0 by `open()` and `stop()`. A frame dropped for its phase still counts.
3. Wait — in the shell — until ONE of: phase `ready` and `status.rev >= target`; phase `frozen` or `failed` (the read goes to the engine as it is: a frozen replica answers at its `rev`, a closed one keeps the read until `retry()` brings the next); phase `off` or `server`, or `stop()` → reject `EngineGoneError`; `options.signal` aborts → reject with a `DOMException` named `AbortError`. Waiters are re-examined from `set()` (every status change, `learnRev` included).
4. Then `link.client.call(method, params, {signal})`. The link exists by then in `ready`, `frozen` and `failed`… unless the worker died: no link → reject `EngineGoneError`.
While `opening` or `resyncing` a read therefore waits in the SHELL, not in the engine's queue (fact 4's second half). A read already posted when a re-bootstrap starts stays in the engine's model lane and is answered by the next replica at its tail's `rev` — Known limits.

**M4 — Placements in the sync.** `setViewPlacement(viewId, elementIds)` stores the list in a `Map` and, with a link, posts `setViewPlacement {view_id, element_ids}` (a `now` method: answered in any state); `dropViewPlacement(viewId)` likewise; both ignore the answer's failure. `adopt(r, made)` — every new link — posts the whole map BEFORE any waiter of M3 is released, so no `listExcludedRoots` can overtake its placements. `stop()` clears the map. `placedElementIds(view)` (`lib/engine/placements.ts`): the union of `folder.elements` over every nested folder of `view.folders`, first occurrence kept, no filtering — what `read._placed_element_ids` computes.

**M5 — `retry`, `reset`, `off`, the tail retry.**
- `retry()`: phase `failed` → `rebootstrap(run)`; anything else → nothing. `run.held` is still set (fact 6), so the batches are adopted again; a link that is gone is rebuilt by the attempt.
- `feedReset(rev)`: `known = max(known, rev)`; phase `off` with a run → restart the open (below); else `enqueue({kind: 'snapshot', modelRev: rev})` — M8's existing road: catch-up → incomplete → re-bootstrap.
- `feedSnapshot(modelRev)` in `off` with a run restarts the open too (a `reset` missed while the feed was down). Restart: `set({...OFF, phase: 'opening', attempt: 1})`, `track(cycles(run, 'opening'))` — the run, its project and its link-to-be are the same; nothing else is reset.
- The tail retry (D7): in `catchUp`, a `deps.api.tail(...)` that THROWS (not `Stopped`) → `await guard(r, deps.sleep(1000))` → once more; a second throw propagates to `drain`'s catch as today. Everything else in `catchUp` and `handle` is unchanged.

**M6 — Shadow** (`lib/engine/shadow.ts`, `quiet.ts`). `shadowEnabled(storage?)`: `import.meta.env.DEV && storage.getItem('dr.shadow') === '1'`, false on any throw. The replica store builds the seam's `shadow` only then, through a dynamic `import('./shadow')` guarded by the same `import.meta.env.DEV`, so a build holds none of it. `createShadow({rev: () => number | null, quiet: () => Promise<void>, report: (line: string) => void})` returns the seam's `shadow` function:
1. Run `server()`; build its `Outcome`.
2. `same(a, b)`: both `ok` → deep equality of the parsed values (plain JSON: key ORDER is not compared, array order is); both failed → the same `status` when both are `ApiError`s, else the same `name`; one of each → different. For `summary` both values are compared without `issue_counts` and `undo_depth`.
3. Same → done. Different → `await quiet()`, note `rev()`, run `again()` and `server()`, note `rev()`: when the `rev` moved in between, repeat, three rounds at most; same → done; different → `report('[shadow] <surface> <method> <JSON params>: engine <short> ≠ server <short>')`, the two shorts cut at 300 characters. `report` is `console.error` in the store.
4. A thrown `AbortError` on either side ends the comparison silently.
`quiet.ts`: `addQuietProbe(probe: () => Promise<void>): () => void`, `quiet(): Promise<void>` — awaits every probe. The replica store adds `sync.settled()`; the view store adds "no `refreshView()` in flight" (a counter and a list of resolvers), because after a commit of view ops the server's excluded pool is ahead of the registered placements until the refetch lands.

**M7 — The store side.** `replica.svelte.ts`:
- `build()` reads the surfaces once, creates the sync, then `installEngineSeam(createEngineSeam(sync, surfaces, shadow))`; `resetReplica()` and the replaced-sync path uninstall it. `createEngineSeam` (`lib/engine/seam.ts`): `side(s)` = `surfaces[s] === 'engine'` and `sync.status().phase` not `off` / `server`; `call` = `sync.call`; `gone` = `error instanceof EngineGoneError`.
- `replicaGate(): Promise<void>` — resolves at once when no surface is on the engine (D13); else once the phase is none of `opening` (so: `ready`, `server`, `off`, `failed`, `frozen`), and on `stopReplica()`.
- `getReplicaNotice(): boolean` — `anyEngine && phase === 'server' && !dismissed`; `dismissReplicaNotice()`; `startReplica()` clears `dismissed`.
- `isReplicaBlocked(): boolean` — `anyEngine && (phase === 'failed' || (retrying && phase === 'resyncing'))`; `isReplicaRetrying()`; `retryReplica()` sets `retrying`, calls `sync.retry()`; `retrying` clears when the phase becomes `ready`, `failed`, `off` or `server`.
- `registerViewPlacement(viewId, ids)`, `forgetViewPlacement(viewId)`, `forgetViewPlacements()`.
- `handReplicaFeed`: a `reset` event → `sync.feedReset(event.model_rev)`.
- `onStatus` also feeds the journey: phase `opening` with a progress → `journeyReplica(status.progress)`.

**M8 — The journey** (`state/open-journey.ts`). `PhaseName` gains `download | parse | index | tail`; `PHASE_ORDER` as D14. `beginJourney(kind, options?: {replica?: boolean})`; two tables. `SLICES` (replica false) is today's, the four new phases given the zero-width slice at `validate`'s ceiling (`[95, 95]` for open, `[96, 96]` for create), so it behaves exactly as now. `REPLICA_SLICES` *(estimate — the weights follow Task 2's split of a cold open and are tuned there, nowhere else)*:
```
open:   hydrate [0,28]  validate [28,34]  download [34,52]  parse [52,78]  index [78,92]  tail [92,96]  finalize [96,100]
create: upload [0,22]  create [22,32]  hydrate [32,48]  validate [48,52]  download [52,66]  parse [66,84]  index [84,94]  tail [94,97]  finalize [97,100]
```
`_setPhase` refuses a phase earlier in `PHASE_ORDER` than the current one (the fraction of the CURRENT phase still updates). `journeyReplica({task, done, total})`: `verify` is ignored; else phase = task, fraction = `total ? done / total : null`. Both callers of `beginJourney` pass `{replica: anyEngineSurface(readSurfaces())}`.

**M9 — The `reset` event** (server). `feed.reset_event(*, model_rev: int) -> dict` = `{"type": "reset", "model_rev": model_rev}`. `Session.announce_reset()` broadcasts it for `self.model_rev` (`FeedHub.broadcast` is thread-safe and a no-op without a loop). `set_model(model, validation=None, *, announce=True)`, `touch_model(*, announce=True)` and `set_metamodel(metamodel, *, announce=True)` (handed on to its `set_model(None)`) end with `if announce: self.announce_reset()`. `_install_model` passes `announce=False` and announces after `persist_baseline` (or after `set_model` when there is no model row); `POST /metamodel` passes `announce=False` and announces after `content.set_model_rev`. Every other call site takes the default.

**M10 — The benchmark** — see Task 2; its shape depends on fact 20's probe.

---

### Task 1: `frame-ancestors` on the sandbox

**Files:** Modify `sandbox/vite.config.ts`, `frontend/e2e/isolation.spec.ts`, `architecture/constraints.md` (CN-17), `CLAUDE.md` ("Sandbox" → Policy).

**Interfaces:** `sandbox/vite.config.ts` becomes `defineConfig(({mode}) => …)`: `const appOrigin = loadEnv(mode, process.cwd(), 'VITE_').VITE_APP_ORIGIN ?? 'http://127.0.0.1:5173'` — `loadEnv`, not `process.env`, so an `.env` file that sets the origin for `src/origins.ts` sets it here too; the CSP is `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'; frame-ancestors ${appOrigin}`. `frame-ancestors` is honoured as a header only, which is how the policy is sent (fact 17).

- [ ] **Step 1: Ask** the owner whether commits are pre-approved for this plan. `git switch feat/transport-swap`.
- [ ] **Step 2: Change the pinned string first.** `isolation.spec.ts`'s `SANDBOX_CSP` gains `; frame-ancestors http://127.0.0.1:5173`. Add one test: `page.goto('http://localhost:5174/')` as a TOP-LEVEL page still loads (frame-ancestors does not bind a top-level document) — it documents that the directive is about embedding only.
- [ ] **Step 3: See it fail** — `pixi run -e frontend bash -c 'cd frontend && npx playwright test isolation'`: the header assertion red. Stop any `sandbox-start` first: a running preview serves its old `dist/` and old headers.
- [ ] **Step 4: Implement**, `pixi run sandbox-check`, `pixi run sandbox-build`.
- [ ] **Step 5: See it pass**, then `replica.spec.ts` too — the frame still embeds from the app's origin, `data-csp-violations="0"`.
- [ ] **Step 6: Docs.** CN-17's quoted policy gains the directive and half a sentence: only the app's origin may embed the sandbox. `CLAUDE.md`'s Policy bullet: the new string, and that the origin comes from `loadEnv`.
- [ ] **Step 7:** `pixi run sandbox-tidy`; commit: `Let only the app embed the sandbox`.

---

### Task 2: The browser benchmark, and the checkpoint

**Files:** Create `frontend/bench/{index.html,main.ts,vite.config.ts,run.ts}`. Modify `scripts/snapshot_v2.py`, `pixi.toml`, `frontend/package.json`, `frontend/tsconfig` include if `bench/` is outside it, `frontend/eslint.config.js` (the type-only rule does not apply to `bench/`: it imports no engine VALUE either — it talks over the port), `CLAUDE.md`, `architecture/program.md`, `BACKLOG-ENGINE.md` (`K-32`).

**Interfaces:**
- `scripts/snapshot_v2.py --gzip`: also writes `<out>.gz` — `encode_snapshot_v2`'s bytes as they are, before the script inflates them. `engine-bench-data` passes it; `benchmarks/large.snapshot.v2.gz` is the file.
- `frontend/bench/vite.config.ts`: `root: 'bench'`, `server: {host: '127.0.0.1', port: 5173, strictPort: true}`, the COOP / COEP middleware of `frontend/vite.config.ts` (import its plugin if it is exported, else export it), and a middleware serving `GET /data/snapshot.gz` (`application/gzip`, `Content-Length`, no `Content-Encoding`, `Cache-Control: no-store`) and `GET /data/metamodel.json` from `../benchmarks/`.
- `frontend/bench/main.ts`: imports `connectFrame` (`$lib/engine/frame`) and nothing of `lib/state`; exposes `window.bench = {open(), transitions(), close()}` for the driver.
- `frontend/bench/run.ts`: the driver — starts `vite` with the bench config and `vite preview` of the built sandbox as child processes (or reuses them when the ports answer), launches Chromium through `@playwright/test`'s `chromium`, runs `PASSES = 3` in fresh contexts, prints the table, exits non-zero never: a miss is a report, not a failure.
- pixi: `[feature.frontend.tasks.engine-bench-browser]` `cmd = "npm run bench:browser"`, `cwd = "frontend"`, `depends-on = ["sandbox-build"]`; `frontend/package.json`: `"bench:browser": "node --experimental-strip-types bench/run.ts"` (if Node 22's type stripping refuses the file, `vite-node bench/run.ts`).

**What is measured**, per pass, medians of 3 in ONE pass of the script (CN-5), each pass in a fresh browser context:
1. **Cold open** — from the first byte asked of `/data/snapshot.gz` to the `replica ready` event: `open {project_id, metamodel}`, every chunk of `response.body.getReader()` transferred exactly (`sync.ts`'s `exactBuffer` rule — copy a view first), `end`, `applyTail {text: '{"from_rev":R,"head_rev":R,"complete":true,"deltas":[]}'}` with the header's `rev`. Reported whole and split: to the last chunk sent, to `end` answered, to `ready`; and, from the engine's `progress` events, when `parse` and `index` began and ended — Task 9's weights come from this split.
2. **The longest slice, from outside.** While the open runs, a loop posts `staged` — a `now` method, answered on the worker's next host turn — each posted when the last was answered; the longest round trip is the longest time the worker went without taking a message, which bounds its longest slice from above. Reported beside the median round trip when idle.
3. **The digest check** — from `ready` to the `verify` task's last `progress`, and the longest `staged` round trip during it.
4. **Heap** — the worker's V8 heap (`Runtime.getHeapUsage().usedSize` after `HeapProfiler.collectGarbage`), with one replica open and the digest check DONE (wait for `verify`'s last `progress`; before it the number is 15–35 MB higher), over the worker's own debugger socket (fact 20): Chromium launched with `--remote-debugging-port=<a free port>`, `GET http://127.0.0.1:<port>/json/list`, the `worker` target whose `url` holds `engine-worker`, Node's global `WebSocket`, the two commands, close. `backingStorageSize` is reported beside it, not added: CN-3's heap is the JS heap, as sub-project A measured it in Node.
5. **Transitions, through the port** (round trip, so an upper bound): `stage` of 1,000 `update_element` ops over ids taken from two `listElementsPage {limit: 500}` pages; `unstage {what: 'all'}`; then, LAST in the pass because it ends the replica: 100 single-op batches staged and one `applyDelta` of a hand-made delta at `rev + 1` touching one element (`prev_rev` = `rev`). The page cannot compute a state digest, so the delta carries a wrong one and the answer says `diverged: true` — expected and ignored: the rewind, the apply and the replay of the 100 batches have all run by then, which is what the row times. Before that: the first `listElementsPage {limit: 1}` after the unstage (`K-32`'s re-sort).
6. **Reads** — `listElementsPage {q: 'a', limit: 50}` (the broadest scan), `{q: <a rare name>}`, `listContainmentRoots {limit: 500}`, `getElementsBatch` of 500.
Output: a header line (model counts, gzip size, Chromium's version, `uptime`'s load), one aligned row per measurement `label  median  [p1 p2 p3]`, and a verdict line: cold open against 3,000 ms, heap against 400 MB, the longest slice against 16 ms, each transition against 100 ms.

- [ ] **Step 1: Read fact 20** — the heap recipe, what does not work, the op's wire shape (`properties_patch`). The default headless shell is the benchmark's browser (it is e2e's); say so in the header line.
- [ ] **Step 2: The data.** `--gzip` in the script; `pixi run engine-bench-data`; check `gzip -t benchmarks/large.snapshot.v2.gz` through `pixi run -e core-dev python -c …` and that its size is CN-1's (≈ 5.8–6.1 MB).
- [ ] **Step 3: The page and the driver**, as above. No unit tests: the benchmark is its own check. `pixi run frontend-check` must still pass with `bench/` in the program.
- [ ] **Step 4: Run it** with nothing else on 5173 / 5174 / the CPU: `pixi run engine-bench-browser`. Run `pixi run engine-bench` in the same sitting and quote its open and heap beside the browser's (CN-5: same session, not same pass — say so).
- [ ] **Step 5: The same open through the app, by hand, once.** The benchmark leaves out what the app adds, and planning saw 1.8 s here against the owner's 3.4 s there (fact 20). With M imported as a project (the wizard or the importer CLI; skip this step, and say so, if that cannot be done without Docker) and the project WARM on the server: in devtools' Performance panel, from navigation to the indicator's `replica r…`, cold and from the cache; and from the Network panel, when the descriptor, the metamodel and the snapshot's first and last bytes came. Report where the extra time sits — waiting for the descriptor (a snapshot write under `write_mutex` on the first ask), the dev proxy's streaming, or the main thread — as numbers, with no fix.
- [ ] **Step 6: CHECKPOINT — report to the owner and wait.** The table, the verdict, the split of the cold open, Step 5's account of the gap. Expected from planning's probe: the cold open and the heap INSIDE their budgets on the bench page (≈ 1.8 s, 115 MB), the longest slice OVER its 16 ms as bounded from outside (27–43 ms), the two 1,000-op transitions at about half of 100 ms. Do not optimize, do not tune, and do not continue to Task 3 on any miss without the owner's word (D1) — the slice is a miss until the owner says the bound is loose enough to live with or asks for a measurement from inside the worker (which would be an engine or sandbox change, and is not this plan's to make unasked).
- [ ] **Step 7: Docs.** `CLAUDE.md`: the command block gains `engine-bench-browser` (and that `engine-bench-data` now writes the gzip too); the "Engine package" section's bench bullet gains a paragraph on the browser benchmark — what it measures, that slices are bounded from outside by the `staged` round trip, how the heap is read. `architecture/program.md`, B's status row: the measured numbers *(measured, Chromium N, WSL2, date)*. `BACKLOG-ENGINE.md` `K-32`: the transition rows as measured in the browser.
- [ ] **Step 8:** `pixi run frontend-tidy`; commit: `Measure the replica in the browser`.

---

### Task 3: The server announces a silent bump (`K-37`)

**Files:** Create `tests/api/test_feed_reset.py`. Modify `src/data_rover/api/feed.py`, `session.py`, `routes/model.py`, `routes/metamodel.py`; `architecture/contracts.md` (CT-2), `BACKLOG-ENGINE.md`, `CLAUDE.md`.

**Interfaces:** M9.

- [ ] **Step 1: Write the failing tests** — the WebSocket pattern of `tests/api/test_feed_ws.py` (connect, read the initial `snapshot`, act over HTTP, read the next frame):
  - `a legacy element write announces itself` — `POST /model/elements`: the next frame is `{"type": "reset", "model_rev": N}` with `N` the session's new `model_rev`; likewise `PATCH`, `DELETE`, and the two relationship routes (parametrized).
  - `an upload announces after its baseline` — `POST /model/upload` on a project WITH a model row: a `reset` frame at the new rev; and at the moment it is broadcast the baseline is durable — patch `session.hub.broadcast` with a spy that, when called, reads `content.latest_snapshot(db, project_id).rev` and records it: it equals the new rev.
  - `POST /metamodel announces after its rows` — the spy reads `ModelRow.metamodel_id`: already the new one. `DELETE /metamodel`, `DELETE /model`: a `reset` frame.
  - `a commit does not` — `POST /commits` and `POST /model/ops`: no `reset` frame (the first is a `commit` frame, the second silent as before).
  - `a replica's routes after a reset` — after a legacy write: `GET /replica/tail?from_rev=<before>` is `complete: false`, and `GET /replica/snapshot` names a snapshot at the new head (this is today's behaviour; the test pins what the shell's road relies on).
  - `feed.reset_event` has exactly the two keys.
- [ ] **Step 2: See them fail** — every `reset` expectation (no such frame arrives: assert with the file's existing "no frame within" helper, or a short receive timeout, so a red test ends instead of hanging); the last two pass already.
- [ ] **Step 3: Implement** M9. `pixi run -e core-dev pytest tests/api/test_feed_reset.py tests/api/test_feed_ws.py tests/api/test_feed_session.py -q`.
- [ ] **Step 4: The whole core suite and the fixtures:** `pixi run core-test` (unchanged count plus this file; `tests/golden/test_fixtures_current.py` green — nothing the oracle computes moved), `pixi run core-lint`, `pixi run backend-lint`.
- [ ] **Step 5: Docs.** CT-2: a bullet **Reset** — a `model_rev` bump that writes no journal row (a model or metamodel upload or delete, the legacy element and relationship routes) is broadcast as `{"type":"reset","model_rev"}`; it carries no delta, the tail across it is incomplete, and a replica re-bootstraps. `CLAUDE.md`: "Realtime feed" — the builders' list gains `reset_event`, the broadcast hook sites gain `Session.announce_reset` with D19's two late callers and why; the delta-protocol section's sentence on `/model/ops` staying silent is untouched. `BACKLOG-ENGINE.md`: `K-37` → `done`, one line on how; **`K-38` · `DELETE /metamodel` writes nothing durable · `open`**: the route clears the session and touches no row, so `ModelRow` keeps its `metamodel_id` and `model_rev` and an evict + rehydrate brings back what was deleted *(read from the code, not reproduced)*; decide whether the route should clear the rows or go.
- [ ] **Step 6:** commit: `Announce a model replaced outside the journal`.

---

### Task 4: Sync — reads, the barrier, placements

**Files:** Modify `frontend/src/lib/engine/sync.ts`, `__tests__/support/project-server.ts` (only if a helper is missing). Create `frontend/src/lib/engine/placements.ts`, `__tests__/sync-call.test.ts`, `__tests__/placements.test.ts`. Docs: `frontend/README.md`, `architecture/decisions.md`, `architecture/contracts.md`.

**Interfaces:** `ReplicaSync` gains `call<T>(method: string, params?: unknown, options?: {signal?: AbortSignal}): Promise<T>`, `setViewPlacement(viewId: string, elementIds: readonly string[]): void`, `dropViewPlacement(viewId: string): void` (M3, M4). `placedElementIds(view: {folders: readonly FolderLike[]}): string[]` with `FolderLike = {elements: readonly string[]; folders: readonly FolderLike[]}` (structural, so `lib/engine` needs no `lib/api/types` value).

- [ ] **Step 1: Write the failing tests** (`sync-call.test.ts`, over `fakeProject()` + `syncOver()`):
  - `a read is answered by the replica` — after `ready`: `call('getModelSummary')` has smart-city's counts and `model_rev` = the project's rev; `call('getElement', {id: 'ghost'})` rejects `NotFoundError` with the server's text.
  - `a read asked while opening waits for ready` — gate the snapshot route; `call('getModelSummary')` is pending; release: it resolves with the head's `rev`. The spied link saw the read posted AFTER `applyTail` answered.
  - `a read asked before there is a link waits for it` — asked right after `open()`: resolves; no throw for the missing link.
  - **`a read sees the commit the UI already has`** — `beginCommit()`; the server commits a peer change at N and the user's own at N+1; `feedCommit` of both; `settle` the own; on the SAME tick `call('getElement', {id: <created by the own commit>})`: it resolves with the element (not 404). The spied order: `applyDelta` N, `applyDelta` N+1, then the read.
  - `a read does not wait for a commit still in flight` — `beginCommit()`, no feed frame: `call('getModelSummary')` resolves at the current rev while the flight is open.
  - `a frozen replica answers as it is` — `feedRebind(rev)`, then a read: resolves at the pre-rebind `rev`, although `known` is past it.
  - `server and off refuse at once` — a `connect` that rejects: `call` rejects `EngineGoneError`; a project with no model: likewise. `a read waiting when the open gives up is refused` — `fail('snapshot', 503, 99)`: the pending read rejects `EngineGoneError` when the phase becomes `server`.
  - `an aborted wait posts nothing` — abort while opening: `AbortError`, and the link never saw the method. `an aborted posted read is cancelled` — `{cancel: id}` was posted (plan 4's client does it; assert the hand-over of `signal`).
  - `stop refuses the waiters`.
  - `placements reach the engine, now and on every new link` — `setViewPlacement('v1', [<a root id>])` before `open()`: after `ready`, `call('listExcludedRoots', {view_id: 'v1'})` does not list that root, `{view_id: 'other'}` does; after a re-bootstrap (force one with a wrong-digest delta) it still does not; after an attempt that lost its worker (dispose the first link mid-open, so the second attempt connects anew) it still does not; `dropViewPlacement('v1')` lists it again; after `stop()` and a new `open()` nothing is registered.
  - `placements.test.ts`: nested folders, a duplicate id kept once in first-seen order, artifacts ignored, an id the model does not hold kept, an empty view → `[]`.
- [ ] **Step 2: See them fail** — `sync-call.test.ts` whole (no `call`), `placements.test.ts` at import.
- [ ] **Step 3: Implement** M3 and M4. The waiters are one list examined in `set()`; `known` is one number.
- [ ] **Step 4: See them pass;** `sync-open.test.ts` and `sync-follow.test.ts` unchanged and green; `pixi run frontend-check`.
- [ ] **Step 5: Docs.** `architecture/decisions.md`: `## AD-28 · A read waits for what the shell has been told` — **Decision:** the shell posts a read only once the replica's `rev` has reached the highest `rev` handed to it before the call — a feed delta, an own commit's response, a snapshot or reset event. **Why:** the shell applies deltas one at a time and holds them during a commit, so the engine's arrival order cannot cover a delta not yet posted; the UI acts on a commit the moment its response is parsed, and a read from before it would undo what the user just saw — or write an older `model_rev` into the store. **Rejected:** a `min_rev` parameter on every read (an engine change for a shell concern); waiting for the pump to be idle (a commit in flight would stall every read). CT-4: one sentence under "Reads … wait for it" — the shell holds a read for the revs it has been told of (AD-28) — and the context bullet says the shell re-sends placements to every new worker. `frontend/README.md` "Replica (engine shell)": a subsection "Reading" (M3, M4).
- [ ] **Step 6:** `pixi run frontend-tidy`; commit: `Read from the replica at the revision the UI has seen`.

---

### Task 5: Sync — retry, reset, waking from `off`, one more try at a tail

**Files:** Modify `frontend/src/lib/engine/sync.ts`, `frontend/src/lib/api/feed.ts`; `__tests__/support/project-server.ts` (`fail` already counts per route; add `appearModel()` if the fake cannot go from "no model" to a model). Create `__tests__/sync-heal.test.ts`. Docs: `frontend/README.md`.

**Interfaces:** `ReplicaSync` gains `retry(): void`, `feedReset(rev: number): void` (M5). `FeedEvent` gains `| {type: 'reset'; model_rev: number}`.

- [ ] **Step 1: Write the failing tests** (`sync-heal.test.ts`):
  - **`retry rebuilds a failed replica with the edits it held`** — `ready`; stage a rename and a create through `links[0].client.call('stage', …)`; make every snapshot fetch fail; force a re-bootstrap (a wrong-digest delta): `failed`. Heal the route; `retry()`: `resyncing` → `ready` at head; `staged` answers the same two batches under their ids; `sleeps` shows a fresh `[1000, 3000]` budget was available (assert the attempt counter restarted at 1). `retry()` in `ready` does nothing.
  - `a read asked while failed is answered after the retry`.
  - `a reset re-bootstraps` — `opaqueBump()` on the fake, `feedReset(project.rev)`: the tail is asked once (incomplete), then `resyncing` → `ready` at the new head from a fresh snapshot; a read asked right after `feedReset` resolves at the NEW rev (the barrier).
  - `a reset at or below the replica does nothing` — no request.
  - `off wakes on a reset` — a project with no model: `off`; the fake gains a model and a snapshot; `feedReset(rev)`: `opening` → `ready`. `feedSnapshot(rev)` wakes it too. In `server`, neither does anything.
  - `one failed tail fetch is tried again` — a silent commit then a fed delta (a gap), `fail('tail', 500, 1)`: `sleeps` is `[1000]`, the phase never left `ready`, the replica is at head, the tail was asked twice. `two failed tail fetches re-bootstrap` — `fail('tail', 500, 2)`: `resyncing` → `ready`. `an incomplete tail does not wait` — re-bootstrap with no sleep.
- [ ] **Step 2: See them fail** — all (no `retry`, no `feedReset`; the tail case re-bootstraps today).
- [ ] **Step 3: Implement** M5.
- [ ] **Step 4: See them pass;** the three older sync test files green — `sync-follow.test.ts`'s cases that fail the tail route assert on a re-bootstrap: if one of them fails the route exactly once, it now sees a retry instead; change that test to fail it twice and say so in the hand-back.
- [ ] **Step 5: Docs** — README "Following": the retry, `reset`, `off` waking, `retry()` and what it keeps. Commit: `Heal a replica without losing what it held`.

---

### Task 6: The seam, and the nine reads through it

**Files:** Create `frontend/src/lib/api/engine-route.ts`, `frontend/src/lib/engine/surfaces.ts`, `seam.ts`; tests `lib/api/__tests__/engine-route.test.ts`, `lib/api/__tests__/engine-reads.test.ts`, `lib/engine/__tests__/surfaces.test.ts`. Modify `frontend/src/lib/api/elements.ts`, `model-read.ts`, `index.ts` (export the seam's types and functions). Docs: `frontend/README.md`, `CLAUDE.md`.

**Interfaces:** M1, M2; `createEngineSeam(sync: Pick<ReplicaSync, 'call' | 'status'>, surfaces: Record<Surface, Side>, shadow?: EngineSeam['shadow']): EngineSeam`. The option bags gain `signal?: AbortSignal`: `ElementsPageQuery`, and the `opts` of `listElementRelationships`, `listContainmentRoots`, `listExcludedRoots`, `listContainmentChildren`; the server path hands it to `apiFetch` as `init.signal` and never into the query string. Engine params per fact 8:

| function | method | params |
|---|---|---|
| `getElement(id)` | `getElement` | `{id}` |
| `getElementsBatch(ids)` | `getElementsBatch` | `{ids}` → `.items` |
| `getTreeItemsBatch(ids)` | `getTreeItemsBatch` | `{ids}` → `.items` |
| `listElementsPage(q)` | `listElementsPage` | `{type, q, limit, offset}`, absent keys omitted |
| `listElementRelationships(id, o)` | same | `{id, direction, limit, offset}` |
| `getModelSummary()` | same | `{}` (the service supplies `model_rev`) |
| `listContainmentRoots(o)` | same | `{limit, offset}` |
| `listExcludedRoots(o)` | same | `{limit, offset, view_id}` |
| `listContainmentChildren(id, o)` | same | `{id, limit, offset}` |

- [ ] **Step 1: Write the failing tests.**
  - `surfaces.test.ts`: the defaults; an override of one surface; an unknown surface, a bad value, bad JSON and a throwing storage each give the defaults; `anyEngineSurface`.
  - `engine-route.test.ts` (a hand-made seam — this is `route`'s own logic, no engine needed): no seam → server; side `server` → server; an explicit `baseUrl` or `fetch` → server although the side is `engine`; side `engine` → the engine's value, the server never called; `gone` → the server's value; any other engine error reaches the caller and the server is not called; `shadow` is handed the surface, the method, the params, the outcome (a value, and an error), a working `again` and the server closure, is not awaited, and a `shadow` that throws or rejects changes nothing for the caller; `engineSide`.
  - `engine-reads.test.ts` (the real engine: `fakeProject()`, `syncOver()`, `open`, `settled`, then `installEngineSeam(createEngineSeam(sync, allEngine))`; `afterEach`: `installEngineSeam(null)`, `dispose()`; MSW has NO read route, so a call that strays to the server fails the test as an unhandled request): for each of the nine functions — the value equals what the fake's `model` says (ids, order, `total`), and it is the schema's output (`getTreeItemsBatch` items carry `child_count`; a page has `total`); `elementId` and `viewId` arrive under the engine's names (spy on `sync.call`); an omitted `limit` is not sent; `getElement('ghost')` rejects `NotFoundError`, `getElementsBatch` of 501 ids `ValidationError` with `too many ids: 501 (max 500)`, `listContainmentChildren('ghost')` `NotFoundError`; `listElementsPage({q: 'sta'})` is a search and goes to the `search` surface while `{q: '  '}` and no `q` go to `elements` (two seams with one surface on the engine each prove it); `a signal reaches the engine` — abort a search mid-scan: `AbortError`; the two `…Paged` wrappers walk their pages through the engine; with the sync in `server` every function falls back — register the MSW read routes for that one test and see them hit.
- [ ] **Step 2: See them fail** — the three files at import.
- [ ] **Step 3: Implement.** Each function becomes `route(surface, cfg, (call) => call(method, params, signal).then((body) => Schema.parse(body)).then(unwrap), () => <today's apiFetch call>)`. Build `params` without `undefined` values.
- [ ] **Step 4: See them pass;** the WHOLE frontend suite — no seam is installed anywhere else, so every existing test takes the server path and must not notice; `pixi run frontend-check`.
- [ ] **Step 5: Docs.** README: a subsection "Surfaces" — the five, which function belongs to which, the switch, `dr.surfaces`, D11, D12, that defaults are all `server` for now. `CLAUDE.md` "Shell": a bullet for `engine-route.ts` / `surfaces.ts` / `seam.ts`.
- [ ] **Step 6:** commit: `Route the model reads through a switch`.

---

### Task 7: Shadow comparison

**Files:** Create `frontend/src/lib/engine/quiet.ts`, `shadow.ts`, `__tests__/shadow.test.ts`, `__tests__/quiet.test.ts`. Docs: README, `CLAUDE.md`.

**Interfaces:** M6.

- [ ] **Step 1: Write the failing tests** (`shadow.test.ts`; `createShadow` with a recording `report`, a `quiet` that resolves at once, a `rev` the test moves; the two sides are closures):
  - equal values report nothing; key order does not matter, array order does; `1` and `1.0` are equal (both are numbers after the schemas).
  - a difference that is still there after the re-test reports ONE line starting `[shadow] tree listContainmentRoots {"limit":500}`; one that heals on the re-test reports nothing; the re-test awaited `quiet()` first (order log).
  - a `rev` that moves during the re-test repeats it; after three moving rounds it gives up silently (a replica that never rests is not a mismatch).
  - errors: 404 on both sides is equal whatever the texts; 404 against a value differs; an `AbortError` on either side ends it without a report.
  - `summary` ignores `issue_counts` and `undo_depth`, and only those.
  - the line is cut: a 10,000-character difference gives a line under 1,000.
  - `shadowEnabled`: `'1'` → true; absent, another value, a throwing storage → false.
  - `quiet.test.ts`: awaits every probe; a removed probe is not asked; no probes → resolves.
  - One test over the REAL engine: the seam of Task 6 with `createShadow`, a server closure answering a deliberately wrong page → one report; answering the engine's own value → none.
- [ ] **Step 2: See them fail; Step 3: implement; Step 4: see them pass.**
- [ ] **Step 5: Prove a build holds none of it.** `pixi run -e frontend bash -c 'cd frontend && npm run build'`, then `grep -rl "\[shadow\]" frontend/build/ frontend/.svelte-kit/output/client 2>/dev/null` finds nothing (the replica store's guard lands in Task 8; re-run this grep there — here it proves only that nothing imports the file statically).
- [ ] **Step 6: Docs** — README "Shadow comparison": when it runs, what equal means, the re-test, the line's shape, how to turn it on. Commit: `Compare the engine's answers with the server's`.

---

### Task 8: The store — the seam installed, the summary, the placements, the searches

**Files:** Modify `frontend/src/lib/state/replica.svelte.ts`, `realtime.svelte.ts`, `model.svelte.ts`, `view.svelte.ts`, `state/index.ts`; `components/Sidebar/Search.svelte`, `Navigation/ElementStartPicker.svelte`, `Snippet/ElementContextRow.svelte`. Tests: `state/__tests__/replica.svelte.test.ts`, `realtime.test.ts`, `model-store.test.ts`, the view store's test file, the three components' tests. Docs: README, `CLAUDE.md`.

**Interfaces:** M7's exports, minus the gate, the notice and the block (Tasks 9 and 10). `handleFeedEvent`: a `reset` event → `handReplicaFeed` first (as every event), then what the `snapshot` case does WITHOUT touching presence or locks: `refreshSummary()` when `e.model_rev > getModelRev()`, `scheduleIssuesRefetch()`.

- [ ] **Step 1: Write the failing tests.**
  - `replica.svelte.test.ts`: `startReplica` installs a seam whose sides follow `dr.surfaces` (set it in `localStorage` before; `resetReplica()` makes the next start read it again) and the phase; with a real replica (`realReplica()`), `getElementsBatch([...])` from `lib/api` is answered by the engine (no MSW read route exists); `stopReplica` / `resetReplica` uninstall it (`engineSide('elements')` is `server`); `a reset event reaches the sync` (spy sync: `feedReset` called with the rev); shadow is built only when `dr.shadow` is `'1'` (with it, a wrong MSW answer logs one `[shadow]` line through a `console.error` spy; without it, the read route is never requested).
  - `realtime.test.ts`: a `reset` ahead refreshes the summary and schedules the issues refetch; one at or below the store's rev only schedules; presence and locks are untouched.
  - `model-store.test.ts`: `with the summary on the engine, the issue counts survive a refresh` — install a hand-made seam (`side: () => 'engine'`, `call` answering a summary with `issue_counts: null`), seed `_issueCounts` through `adoptIssues`, `refreshSummary()`: the counts are unchanged, `getModelSummary()` (the getter) carries them, and `GET /model/issues` was requested once; on the server side the old behaviour stands (the body's `issue_counts` is adopted, null included).
  - the view store: `refreshView` registers the committed ids — a staged `view.place_element` on top of a fetched view: what is registered is the FETCHED document's list, not the overlaid one; a view switch forgets the old view's and registers the new one's; a view that 404s forgets; `clearViewState` forgets all; the quiet probe is pending while a `refreshView()` is in flight and resolves after.
  - the three search components: a second query aborts the first call's signal (spy on `listElementsPage`: the first call's `signal.aborted` is true once the second starts); an `AbortError` leaves the results as they were and clears nothing.
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement.** In `refreshView`, register BEFORE `setState(next, …)` — the tree's refetch is keyed on `_view`'s identity and must find the placements already posted. `refreshSummary`: `if (engineSide('summary') === 'engine') { _summary = {...s, issue_counts: _issueCounts}; void refetchIssues(); } else { …today… }`; `_modelRev = s.model_rev` on both sides (the barrier makes the engine's `rev` no older than the store's).
- [ ] **Step 4: See them pass;** the whole suite; `pixi run frontend-check`; Task 7's build grep again — still nothing.
- [ ] **Step 5: See it live, surface by surface.** The stack as plan 4's Task 9 Step 5; in the console `localStorage.setItem('dr.surfaces', JSON.stringify({summary: 'engine'}))`, `localStorage.setItem('dr.shadow', '1')`, reload: the status bar's counts are right, the network panel shows `GET /model/summary` only as shadow's second call, no `[shadow]` line. Then all five: expand the tree, search, open an element, its relationships; commit a rename: every surface follows, no `[shadow]` line. Report what was seen.
- [ ] **Step 6: Docs** — README: "Wiring" gains the seam, the `reset` event, the summary rule, the placements and their hook, the abort; "Where to find things". `CLAUDE.md` "Shell": `replica.svelte.ts`'s new duties; "Nothing reads the replica yet" becomes what is true (readers exist, every default is `server`). Commit: `Let the workspace read from the replica`.

---

### Task 9: The wait for `ready`, with its slices

**Files:** Modify `frontend/src/lib/state/open-journey.ts`, `replica.svelte.ts`, `routes/p/[projectId]/+page.svelte`, `routes/projects/+page.svelte`. Tests: `state/__tests__/open-journey.test.ts`, `replica.svelte.test.ts`. Docs: README.

**Interfaces:** M8; `replicaGate()` (M7).

- [ ] **Step 1: Write the failing tests.**
  - `open-journey.test.ts`: every existing test passes UNCHANGED (a journey begun without `replica` is today's); with `{replica: true}`: `hydrate` fills 0–28; `journeyReplica({task: 'download', done: 1, total: 2})` puts the target inside 34–52; then `parse` reports, then a late `download` report: the phase stays `parse` and the percent never drops; a `validate` poll after `download` is ignored; `verify` is ignored; `total: null` creeps inside its slice; `finishJourney()` ramps to 100 from wherever it is; `journeyReplica` without a journey is a no-op.
  - `replica.svelte.test.ts`: `replicaGate()` resolves at once with every surface on `server`; with one on the engine it resolves at `ready`, and at `server` (a rejected `connect`), and at `off` (no model), and on `stopReplica()`; the journey is fed (`journeyReplica` spied) while `opening` only.
- [ ] **Step 2: See them fail; Step 3: implement.** In `boot()`: `await replicaGate()` after `loadArtifacts()`, inside the `try`, so the `finally`'s `finishJourney()` comes after it; the early returns (`cancelJourney()`) stay as they are. Tune `REPLICA_SLICES` to Task 2's measured split — keep the phase boundaries proportional to where `parse` and `index` began and ended there, and write the measured split in a comment-free place: the README.
- [ ] **Step 4: See them pass; see it live** with all five on the engine: a cold project (restart the backend) and a warm one — the bar moves through download, parse, index and tail without going back, the workspace appears when the indicator says `replica rN`; with `dr.surfaces` absent (all `server`) the open is exactly as before.
- [ ] **Step 5: Docs** — README "Opening": the gate, the slices and where their weights came from, D13 and D14. Commit: `Wait for the replica behind an honest bar`.

---

### Task 10: The notice and the way back

**Files:** Create `frontend/src/lib/components/ReplicaFallbackNotice.svelte`, `ReplicaFailedOverlay.svelte`, their tests under `components/__tests__/`. Modify `replica.svelte.ts`, `state/index.ts`, `+page.svelte`, `replica.svelte.test.ts`. Docs: README, `CLAUDE.md`.

**Interfaces:** M7's `getReplicaNotice`, `dismissReplicaNotice`, `isReplicaBlocked`, `isReplicaRetrying`, `retryReplica`.
- `ReplicaFallbackNotice.svelte`: the rebind banner's markup and classes (`col-span-5`, `bg-warning/15 text-warning`, `role="alert"`, the slide-in), `data-testid="replica-notice"`, the text of D5 verbatim, a ghost `Dismiss` button. `+page.svelte` renders it when `getReplicaNotice()` and gives it its `auto` row in `rows`.
- `ReplicaFailedOverlay.svelte`: `fixed inset-0 z-[55]` (under the progress overlay's 60), `bg-background/90 backdrop-blur-sm`, `role="alertdialog"`, `aria-modal="true"`, `aria-labelledby`, `data-testid="replica-blocked"`; a card with the label `Model out of sync`, D6's text verbatim, and one button — `Retry`, or `Retrying…` and disabled while `isReplicaRetrying()`; the button takes focus on mount. Rendered by `+page.svelte` when `isReplicaBlocked()`.

- [ ] **Step 1: Write the failing tests.** The two components: the exact copy (assert the strings of D5 and D6 character for character), the roles, the button's two states, `Dismiss` and `Retry` call the store. `replica.svelte.test.ts`: the notice shows at `server` with a surface on the engine, not with none, not after `dismissReplicaNotice()`, again after the next `startReplica()`; `isReplicaBlocked()` is true at `failed`, stays true through the retry's `resyncing`, false at `ready`; a retry that fails again is blocked again with `Retry` enabled; with every surface on `server` a `failed` replica blocks nothing (D13).
- [ ] **Step 2: See them fail; Step 3: implement; Step 4: see them pass.**
- [ ] **Step 5: See it live.** Open the app at `http://localhost:5173` with a surface on the engine: `server mode` in the status bar, the notice above the workspace, every surface answered by the server, `Dismiss` removes it. For the overlay: with the workspace open and one edit staged, block the URL pattern `*/replica/snapshots/*` in the browser's network panel (request blocking binds the app page's fetches, which is where the shell fetches), then force a re-bootstrap as a peer — a legacy `POST /model/elements` through curl with the session cookie, which broadcasts a `reset`: three attempts in the indicator, then the overlay. Unblock, `Retry`: `Retrying…`, the workspace comes back, and the staged edit is still in the change badge.
- [ ] **Step 6: Docs** — README "Opening" and "Following": what `server` and `failed` look like to the user; `CLAUDE.md` "Shell". Commit: `Say when the engine is not serving, and offer the way back`.

---

### Task 11: e2e in engine mode, shadow on

**Files:** Create `frontend/e2e/fixtures.ts`, `frontend/e2e/engine-mode.spec.ts`. Modify all 19 `frontend/e2e/*.spec.ts` (the import), `e2e/helpers/auth.ts` if `openDefaultProject` should wait for the gate, `CLAUDE.md`.

**Interfaces:** `e2e/fixtures.ts` exports `test` and `expect`: `test = base.extend<{shadowWatch: void}>({shadowWatch: [async ({page}, use) => { lines = []; page.on('console', m => { if (m.text().startsWith('[shadow]')) lines.push(m.text()) }); await page.addInitScript(() => { localStorage.setItem('dr.shadow', '1'); localStorage.setItem('dr.surfaces', JSON.stringify({elements: 'engine', search: 'engine', relationships: 'engine', tree: 'engine', summary: 'engine'})) }); await use(); expect(lines, 'shadow comparison').toEqual([]); }, {auto: true}]})`. `seed.setup.ts` keeps importing `@playwright/test`. A spec that opens a second page (`context.newPage()`) gets the init script only if it is added on the CONTEXT: use `context.addInitScript` in the fixture instead when any spec does.

- [ ] **Step 1: The fixture and the imports** — a mechanical edit: `from '@playwright/test'` → `from './fixtures'` for `test` and `expect` (types such as `Page` keep their import).
- [ ] **Step 2: `engine-mode.spec.ts`:**
  - `the workspace is served by the engine` — open Smart City: `expectReplicaReady`; expand a tree node, search a name, open an element, open its relationships; assert through `page.on('request')` that, shadow being on, each migrated route WAS requested (shadow's second call) and — after `page.evaluate(() => localStorage.removeItem('dr.shadow'))` and a reload — none of `/model/summary`, `/model/elements`, `/model/containment/` is requested while the same walk runs.
  - `an own commit shows in the tree and the search` — rename through the UI, commit: the tree row and a search for the new name show it.
  - `a peer's commit shows` — `peerCommit` a rename: the open element's inspector follows without a reload.
  - `a model replaced outside the journal heals` — `peer` does `POST /model/elements` (a legacy write): the indicator passes through `resyncing` and ends `ready` at the new rev (`watchPhases` of `replica.spec.ts` — move it to `helpers/replica.ts`), and a search finds the new element.
  - `the boot fallback` — a context whose `baseURL` is `http://localhost:5173`: login, open the project: `data-phase="server"`, `replica-notice` visible with D5's text, the tree and a search work, `Dismiss` hides the notice. (The session cookie is per host: this context logs in on its own.)
- [ ] **Step 3: Run the whole suite:** `pixi run frontend-test-e2e` (stop any stale `sandbox-start` first). Judge against fact 19: `script-embedding.spec.ts:91` and `snippet-flow.spec.ts:69` were red before. Any `[shadow]` line is a FINDING — the engine and the server disagree, or the comparison is wrong: report the line, the spec, and which it is, before changing anything. The likeliest false alarm is the excluded pool right after a commit of view ops (M6's view probe exists for it).
- [ ] **Step 4: Timing.** Report the suite's wall time before and after (every read is doubled).
- [ ] **Step 5: Docs** — `CLAUDE.md`'s e2e bullet: the fixture, what it sets, that a `[shadow]` line fails a test, that specs import `./fixtures`. Commit: `Run the e2e suite on the engine, compared with the server`.

---

### Task 12: The defaults, one surface at a time

Five commits, in this order — cheapest and most watched first, the full scan last: `summary`, `elements`, `relationships`, `tree`, `search`.

For EACH surface:
- [ ] **Step 1:** `SURFACE_DEFAULTS[surface] = 'engine'`; `surfaces.test.ts`'s defaults assertion follows.
- [ ] **Step 2:** `pixi run frontend-test` — a unit test that relied on the server default for this surface WITH a replica running is a finding; tests without a replica never install a seam and cannot notice.
- [ ] **Step 3:** e2e with the fixture's `dr.surfaces` override REMOVED for this surface (the fixture keeps forcing the ones not flipped yet, so the suite always runs all five on the engine; after the fifth flip the override goes entirely and only `dr.shadow` stays): green, no `[shadow]` line.
- [ ] **Step 4:** README "Surfaces": the default; commit: `Serve <the surface> from the replica by default` (`Serve the summary counts …`, `Serve elements …`, `Serve incident relationships …`, `Serve the containment tree …`, `Serve fuzzy search …`).

After the fifth: `pixi run engine-bench-browser` once more is NOT needed (nothing it measures changed); `pixi run dr-test`.

---

### Task 13: Closing docs, bringing the branch home

**Files:** `architecture/program.md`, `architecture/contracts.md`, `BACKLOG-ENGINE.md`, `CLAUDE.md`, `frontend/README.md`.

- [ ] **Step 1: Docs.** `program.md`: B's status row — plans 1–5 built; plan 5: the five read surfaces served by the engine by default behind per-surface switches, the wait for `ready`, the fallback notice and the retry overlay, shadow comparison in dev and e2e, the browser benchmark with its numbers *(measured)*. MR-3: with the defaults flipped, `routes/read.py`'s route functions and `routes/elements.py::get_element` leave the freeze for FEATURES (they land in TypeScript only); a bug still lands on both sides with a fixture while the server path lives. `BACKLOG-ENGINE.md`: `R-3` — five of six plans; the freeze paragraph at the top follows MR-3. CT-4: nothing new beyond Task 4's. `CLAUDE.md`: a last pass — "Shell" opens with what reads the replica; the "Backend session" section's sentence "the client never holds the whole model" gains its exception (the replica, for the five read surfaces).
- [ ] **Step 2: Every suite, every linter.**
```bash
pixi run dr-test
pixi run dr-tidy true
pixi run frontend-test-e2e
pixi run golden-fixtures
git status --short
```
Expected: core pytest at its old count plus Task 3's file; engine vitest unchanged (nothing under `engine/` moved); frontend and sandbox green, fact 19's noise aside; no fixture moved; `git status` shows Step 1's files alone.
- [ ] **Step 3: Commit** `Mark the transport swap built`, then, with the owner's go-ahead: `git switch engine-migration && git merge --ff-only feat/transport-swap`.

---

## Known limits

- A read ALREADY POSTED to the engine when a re-bootstrap starts is answered by the next replica at its tail's `rev`, which a delta that arrived during the re-bootstrap may be past. The barrier covers every read asked after; this one heals at the next `changed`-driven refetch, and shadow's re-test absorbs it.
- A re-bootstrap stalls every engine read for a whole open (≈ 3.4 s at M, *measured by hand*); only the status-bar indicator says so. The overlay is for `failed` alone.
- The legacy store invalidates no cache on a `reset` (it never did on a replaced model): the tree and search are right — they read the new replica — while an element already cached shows its old self until re-read. The next commit from that tab gets its 409 and the `Model out of sync` row, as today.
- The notice says "Reload the page" also when the reason is the host (`open the app at http://127.0.0.1:5173`), where a reload changes nothing; the indicator's title says why.
- Shadow doubles every migrated read; it is off unless asked for, and absent from a build. Its "nothing staged" rule is plan 6's (D21).
- `dr.surfaces` is honoured in production (D18): a user who sets it gets what they set.
- The benchmark bounds the longest slice from OUTSIDE (the longest time the worker took no message); a slice is at most that, and the digest check's and the open's are told apart only by when they happened. Transition times include the port's round trip.
- `server` is terminal for the tab (D8); `failed` has `Retry` and nothing else — a user who reloads the page instead loses uncommitted edits, as any reload does today.
- Not checked while planning: that Node 22's type stripping runs `bench/run.ts` (the fallback is named in Task 2); the benchmark's delta row (the probe staged and unstaged; it applied no delta); that `context.addInitScript` is needed rather than `page.addInitScript` (Task 11 says how to tell); `K-38`'s reading of `DELETE /metamodel`.

## After this plan

Plan 6 (the forked store) is written once this one has landed. What it inherits:

- **The seam is the store's way in too**: `sync.call` for `stage`, `unstage`, `staged`, `stagedDiff`, `conflicts`; the `changed` event is not yet handed to anyone — plan 6 adds an `on` to the replica store.
- **`staging`** joins `surfaces.ts` and forces the five reads to `engine` (spec §7); shadow gains "only while nothing is staged".
- **`flight.settle`'s `batchIds`** become real; `retry()` and `run.held` already carry staged batches across a failed re-bootstrap — plan 6's test is this plan's `sync-heal` case with the store on top.
- **Spec §9's e2e "a staged edit visible in the tree"** is plan 6's: until the store forks, nothing is staged in the engine and the tree shows staged edits through the legacy overlay, as today.
- **The barrier** holds for staged reads as it stands: a `stage` is a transition in the engine's own queue, and reads posted after it see it.
- **A frozen replica with staged edits** (`AD-27`) and the overlay's "Your uncommitted edits are kept" are where plan 6 must not lie: the legacy store's edits today, the engine's then.
- Open: `K-29`, `K-32`, `K-35`, `K-36`, `K-38`, `C-20`, `C-21` in `BACKLOG-ENGINE.md`; `K-33`, `K-34` in `BACKLOG.md`.
