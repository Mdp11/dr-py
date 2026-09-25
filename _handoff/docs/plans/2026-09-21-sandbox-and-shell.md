# Sandbox and Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline, one commit per task (the owner's choice for this program). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project opened in the app is also opened as a full replica in an engine worker inside the sandbox origin — from the snapshot cache or the network, brought to head through the tail — and kept there: feed deltas, the user's own commits, reconnects, gaps, divergence and a metamodel rebind. No read surface and no edit path uses it yet; its state shows in the status bar and nowhere else.

**Architecture:** Plan 4 of 6 for sub-project B (`architecture/program.md`). Two pieces are added. (1) `sandbox/` — a static Vite site, always served as built files on `http://localhost:5174` under CN-17's policy: a page that does the handshake and leaves the data path, and a module worker that runs the engine's `createService` over the transferred `MessagePort` with the three things the engine cannot hold (`inflate`, `yieldToHost`, `now`). (2) `frontend/src/lib/engine/` — the shell, plain TypeScript with no runes: `frame.ts` (the iframe and the handshake), `client.ts` (the CT-4 client), `cache.ts` (IndexedDB), `sync.ts` (the replica's life: open, follow, heal, the commit in flight, the rebind freeze), over `lib/api/replica.ts` for the three replica routes. A thin reactive store (`lib/state/replica.svelte.ts`) wires it to `boot()`, the feed, the two commit paths, the two metamodel-adoption paths and a status-bar indicator. Nothing in `engine/src/` or `src/data_rover/` changes.

**Tech Stack:** TypeScript 6, Vite 8, vitest 3 (Node environment for `sandbox/`; happy-dom + MSW for the frontend), `fake-indexeddb` 6 (new dev dependency of `frontend/`), Playwright (Chromium) for e2e; pixi for every command.

**Spec:** `docs/superpowers/specs/2026-09-19-replica-and-frontend-seam-design.md` — §5 and §6 are this plan's scope, minus what decision D1 moves to plan 5; §9 names its tests, §10 the `architecture/` edits that ride with the code. Read `architecture/contracts.md` (CT-2, CT-4, CT-5), `architecture/constraints.md` (CN-9, CN-11, CN-12, CN-14 to CN-17), `architecture/decisions.md` (AD-5, AD-10, AD-16, AD-25, AD-26), `architecture/system.md` (rules 1–3, the Open, Peer commit and Rebind flows) first, then `CLAUDE.md`'s `src/service/` bullet and plan 3's "After this plan" (`docs/superpowers/plans/2026-09-19-engine-service.md`, end of file), then `frontend/README.md`'s "Auth, projects & routing" and "State model".

**What kind of plan this is.** Direction with specifics: interfaces, signatures, the test cases and what each asserts, the order, and the mechanisms that are easy to get wrong, spelled out. It holds no full code and nothing in it was built or run — the implementer writes the tests and the code, and the expected results of the "see it fail" steps are reasoned from the code, not observed. If a step's expected result does not appear, trust the run, read the step's intent, and say so in the hand-back. What WAS checked while planning is listed next, each with how.

## What planning found

Facts the plan rests on, each checked against the code at `c7bba47` or by a throwaway probe (Node 22.22.3, Vite 8.0.14, vitest 3, happy-dom 20, headless Chromium 148.0.7778.96 through the frontend's Playwright, WSL2). Probes lived in the session's scratch directory or as untracked files that were deleted again; none is in the tree.

1. **Vite's `server.headers` does not reach SvelteKit's pages.** *Probe:* the frontend dev server with `server.headers` set to COOP and COEP — `/@vite/client` carries them; `/login`, `/p/abc`, `/favicon.png` and a proxied `/api/v1/…` answer do not. A plugin whose `configureServer` adds a middleware that sets both headers covers the pages, the modules and the proxied answers. Appended AFTER `sveltekit()` it still misses `static/` files, which is harmless (a same-origin subresource needs no CORP); first in the list it should cover those too *(estimate — not probed)*.
2. **`vite preview`'s `preview.headers` reach every response** — `/`, a hashed asset, and the SPA fallback, which answers a missing path with 200 and `index.html` (`appType: 'spa'` is the default). `--host localhost` binds `127.0.0.1` only on this machine; `[::1]` refuses.
3. **A Vite build of a page and a module worker is clean under the CSP.** *Probe:* a scratch site whose worker imports `engine/src/index.ts` by path, `worker: {format: 'es'}`, `build.target: 'es2022'`: 4 modules, 156 ms, an `index.html` of 0.21 kB with ONE external module script and no inline script or style, and a worker chunk of 92 kB that holds the whole engine.
4. **Isolation, the port handshake and the engine in the worker behave in Chromium as spec §5 says.** *Probe:* an app page on `http://127.0.0.1:5198` (COOP `same-origin`, COEP `require-corp`) embedding that built site from `http://localhost:5197` (CN-17's CSP, COEP `require-corp`, CORP `cross-origin`) in an iframe with `allow="cross-origin-isolated"`: the page and the frame are both `crossOriginIsolated`, `SharedArrayBuffer` exists in the worker; `sandbox-ready` arrives with `origin === 'http://localhost:5197'` and `source === frame.contentWindow`; a `connect` with a transferred port reaches the worker, and `createService` over it answers `No method 'nope'` (404), `staged` (`[]`) and a `chunk` without an open (409 `no snapshot is being opened`); a transferred `ArrayBuffer` is detached in the sender; zero `securitypolicyviolation` events, zero console lines. Without the `allow` attribute the frame is not isolated and everything else works; without the app's two headers neither side is. The spike (`spikes/client_engine/`) had proven isolation and the CSP with a `window.postMessage` relay and `sandbox="allow-scripts allow-same-origin"` on the iframe; the transferred port and a Vite-built worker were new ground. The probe's iframe carried no `sandbox` attribute.
5. **`DecompressionStream` in Node.** *Probe:* the 6.11 MB gzip-3 of M inflates to 76.95 MB in 0.45–0.48 s (medians of 3, input cut at 64 KiB, at 1 MiB and whole) through a `getReader()` loop; the output arrives in 16 KiB chunks, about 4,700 of them. A truncated member rejects with a `TypeError` of code `Z_BUF_ERROR`, trailing bytes and non-gzip input with `Z_DATA_ERROR` — all three with an EMPTY message. The service maps anything that is not a `SnapshotError` to a 500 with its message (`engine/src/service/service.ts:71-72`), so a broken download would be a 500 with no text.
6. **`writer.write(chunk)` needs a cast.** *Probe (svelte-check):* under TypeScript 6's DOM lib the engine's `Uint8Array` is `Uint8Array<ArrayBufferLike>` and is not a `BufferSource`; `chunk as Uint8Array<ArrayBuffer>` type-checks. The chunks are `ArrayBuffer`-backed in fact: they arrive as transferred buffers.
7. **The frontend's test environment.** *Probe:* under vitest + happy-dom, `indexedDB`, `IDBKeyRange` and `Worker` are undefined; `DecompressionStream`, `CompressionStream`, `structuredClone`, `ReadableStream` and `MessageChannel` are Node's own, and a port transfer detaches the buffer. `window.postMessage(message, '*', [port])` delivers `ports: []`, an `origin` of `http://localhost:3000` and a `source` that is not `window`. Appending an `<iframe src="http://localhost:5174/">` makes happy-dom FETCH that URL for real (`ECONNREFUSED` on stderr). So the handshake cannot be exercised through happy-dom's window: `frame.ts` takes its window, its document and its frame factory as dependencies, and the real thing is e2e's.
8. **The engine runs inside the frontend's test run and type-checks under its tsconfig.** *Probe:* a test importing `createService` from `engine/src/index.ts` by relative path passes; `svelte-check` with the engine's sources in the program: 6,231 files, 0 errors, 18 s (`rewriteRelativeImportExtensions` admits the engine's `.ts` specifiers). A whole open of smart-city (1,002 elements, 746 relationships, 42 kB of gzip) over a real `MessageChannel`, `DecompressionStream` as `inflate` and a `MessageChannel` post as `yieldToHost`: `open` → 11 × `chunk` → `end` (the header) → `applyTail` → `replica ready` in 42 ms, then `verify` to its total. The snapshot text was built from the engine's PUBLIC exports alone (`Model`, `Metamodel.fromJSON`, `modelLines`, `modelDigest`, `pyDumps`, `parseJson`).
9. **The engine's test helpers cannot be imported from another Vite root.** *Probe:* importing `engine/test/service/helpers.ts` fails at load with `Denied ID …/BACKLOG-ENGINE.md?url`: `smartCity()` holds ``new URL(`../../../${…}`, import.meta.url)``, which Vite's asset-URL transform turns into a glob over the repository root. svelte-check accepts the file; vitest does not. The shell's fake server is therefore written on the public exports (fact 8), not on `engine/test/**`.
10. **A streamed body through MSW.** *Probe:* `apiFetchRaw` under happy-dom + MSW: `response.body.getReader()` yields the handler's chunks as `Uint8Array`s (4 × 70,000 + 20,000 of 300,000 bytes); `Content-Length` and a custom `X-Metamodel-Id` header are readable.
11. **The feed transport throws the frame's text away.** *Code (`frontend/src/lib/api/feed.ts:134-141`):* `config.onEvent(JSON.parse(data) as FeedEvent)`; `data` never leaves the handler. `FeedEvent`'s `commit` member has no `prev_rev`, `state_digest` or `recreated_*` — it is a type, not a schema, so nothing strips them either.
12. **`apiFetch` consumes the body** (`client.ts:151-163`); `apiFetchRaw` returns the `Response`, headers and `.text()` included, and is not re-exported from `lib/api/index.ts`. `lib/api/*` never imports `lib/state/*`; the two existing seams are injected callbacks.
13. **The user's own deltas arrive on two paths**, both echoed on the feed: `commitStaged` (`state/checkout.svelte.ts:371`; `commitChanges` at `:422`, `applyDelta(res)` at `:450`, `adoptReboundMetamodel()` at `:471` when `res.rebound`) and the history drawer's revert (`components/HistoryDrawer.svelte:126-131`, `revertToCommit` → `applyDelta`). `/model/ops` and `/model/undo` have no production caller. `OpsResponseSchema` (`api/types.ts:271`) strips `prev_rev`.
14. **Boot.** *Code (`routes/p/[projectId]/+page.svelte`):* `onMount(() => startRealtime())` (`:75`) is registered before `onMount(() => void boot())` (`:86`); `boot()`'s first fetch is `GET /metamodel` (`:182`); `onDestroy(() => stopRealtime())` (`:89`). A project switch is a new mount of the page; there is no switch event — `getActiveProjectId()` is a plain reactive cell and `apiFetchRaw` resolves its base URL at CALL time from a module global, so a late call of a stopped open would hit the NEXT project unless its base URL is pinned.
15. **A rebind today.** *Code:* a peer's `rebind` event sets `_pendingRebind` (`realtime.svelte.ts:243`); the banner's Reload is `onReloadRebind()` (`+page.svelte:280-293`) — an in-place refetch of metamodel, summary and issues, not a page reload. The committer's own rebind runs the module-private `adoptReboundMetamodel()` (`checkout.svelte.ts:478-487`).
16. **The descriptor's `url` is an absolute PATH as the backend sees it** (`routes/replica.py:27`: the request's own path, last segment replaced), e.g. `/api/v1/projects/p/replica/snapshots/12`; the dev proxy forwards `/api/v1` unchanged, and `buildUrl('', path)` gives the path back as it is.
17. **The docs send people to the sandbox's host.** *Read:* `README.md:56,59`, `QUICKSTART.md:22,42` and `frontend/README.md:1569` say `http://localhost:5173`. The dev server binds `127.0.0.1`, and both names reach it; opened as `localhost:5173` the app would be same-site with a sandbox on `localhost:5174`, and the sandbox page — which answers `http://127.0.0.1:5173` only — would never complete the handshake.
18. **Only commits, locks, artifacts, views and presence are broadcast.** *Code (`grep broadcast(` over `routes/` and `main.py`):* `POST /model/upload`, `POST /metamodel`, `DELETE /metamodel` and the legacy element routes bump `model_rev` and tell the feed nothing. A replica hears of them at the next delta (a gap, then an incomplete tail) or at a reconnect.
19. **A nested `setTimeout(0)` is clamped to 4 ms from its fifth level** (HTML standard); an open at M is about 300 slices of 8 ms (plan 3, 2.4 s), so a `setTimeout` yield would add about 1.2 s *(estimate)*. A `MessageChannel` post is a macrotask with no clamp, and fact 8 ran one.
20. **Tooling.** *Code:* pixi tasks take `cwd`; `dr-test` and `dr-tidy` name their members one by one (`pixi.toml:181-201`); the root `.gitignore` names `node_modules` per directory; `process-compose.yaml` pins `-e` on every command; the frontend's vitest has no `exclude` and takes `src/**/*.{test,spec}.{ts,js}`; `.svelte-kit/tsconfig.json` builds its `paths` from `kit.alias`, and `vitest.config.ts` keeps its own alias block because it runs without the SvelteKit plugin. `fake-indexeddb` is at 6.2.5 on npm and the frontend has no IndexedDB helper. No e2e spec drives a second client or watches the console.
21. **Part of spec §10 is left for this plan.** *Read:* CT-2's commit-in-flight order (plan 3, fact 21) and RC-1's `sandbox/` row are not yet in `architecture/`.

## Decisions

Taken with the owner (2026-09-21):

- **D1. Indicator only.** Plan 4 builds the replica's state and progress and shows them in one status-bar indicator. Nothing blocks, no banner, no notice. The gate (`server ready AND replica ready`), the four open-journey slices, the boot-fallback notice and the blocking re-bootstrap banner of spec §6 move to plan 5, where the first engine surface needs them. The states they will render — `server`, `failed` — exist and are tested here.
- **D2. The replica changes metamodel when the UI does.** A `rebind` feed event, and an own commit answered `rebound: true`, FREEZE the replica — later deltas could not apply anyway: a tail across a rebind is incomplete. The two adoption paths, the banner's Reload and `adoptReboundMetamodel()`, re-bootstrap it. The engine's metamodel is always the one the UI shows, and from plan 6 on staged edits are replayed under a new schema only when the user asks. Recorded as `AD-27`.

Taken by this plan — each small, each reversible at review; say so if one is wrong:

- **D3. The metamodel is fetched before the bytes.** Spec §6 orders it after them; plan 3's `open {project_id, metamodel}` needs it first. It is 28 kB at M. A rebind that lands between the descriptor and the metamodel shows as an `X-Metamodel-Id` mismatch and restarts the attempt.
- **D4. A page mount owns a frame; a re-bootstrap keeps the worker.** `stop()` removes the iframe, which ends the worker and frees its heap; the next `open()` makes a new one ("a project switch replaces the worker"). A re-bootstrap is `staged` + `conflicts` → `close` → the open sequence on the SAME worker, so reads queued in it survive (CT-4); the engine's `close` drops the old replica before the new one is read.
- **D5. Two raw-text seams, both additive.** `FeedConfig.onEvent(event, raw)` hands over the frame's text; `ApiFetchInit.onText(text)` hands over a response's body before it is parsed. Nothing that exists today changes behaviour.
- **D6. `lib/engine/*` holds no rune and imports no `lib/state/*`.** It may import `lib/api/*`. The reactive half is `lib/state/replica.svelte.ts`, barrel-exported like every other store.
- **D7. Production code imports engine TYPES only.** A `$engine` alias (`kit.alias` and vitest's own block) points at `../engine/src/index.ts`; `import type` is erased (`verbatimModuleSyntax`), so the app bundle never holds the engine. ESLint's `@typescript-eslint/no-restricted-imports` with `allowTypeImports` refuses a value import of `$engine` or `$sandbox` outside `**/__tests__/**` and `lib/engine/testing.ts`.
- **D8. Shell tests run the real engine and the worker's real host code against a fake project server** (RC-14). `lib/engine/testing.ts` wires `createService` to a Node `MessageChannel` with `sandbox/src/host.ts`'s `createHost()` and `portOf()` (alias `$sandbox`). The fake server (`__tests__/support/project-server.ts`) is written on the engine's public exports (facts 8, 9) and sits behind MSW routes. The spec's "real v2 snapshot of smart-city" is v2 in format and written by that helper, not by Python: the server's bytes are already held to the engine by plans 2 and 3, and e2e runs the real server.
- **D9. A download that does not inflate is a 422.** The worker's `inflate` rethrows a stream failure as `SnapshotError('snapshot bytes do not inflate')` (fact 5). A refused open whose bytes came from the cache drops that cache row and runs again from the network, without using up an attempt.
- **D10. `yieldToHost` is a post on a private `MessageChannel`** (fact 19), never `setTimeout`.
- **D11. The cache keeps one row per project**: key `project_id`, value `{project_id, rev, bytes: ArrayBuffer, size, used_at}` — "the newest `rev` per project" by construction; a hit needs the descriptor's exact `rev`. Cap 64 MiB across projects (M is 6 MB, L about 11), least recently used first; a row is written only after `end` has answered, so a broken download is never cached.
- **D12. Numbers.** Handshake timeout 10 s. Three attempts per open or re-bootstrap, 1 s before the second and 3 s before the third. A metamodel-id mismatch restarts an attempt for free, three times at most. At most 1,000 feed frames are buffered while the replica is not `ready`; past that the buffer is emptied and a catch-up is owed (the tail's own cap).
- **D13. Two hosts or no engine.** The shell refuses to build a frame when `location.hostname` is the sandbox's hostname (CN-17 wants another site) — state `server`, reason `open the app at http://127.0.0.1:5173` — and the three docs of fact 17 change to `127.0.0.1:5173`.
- **D14. The iframe carries `sandbox="allow-scripts allow-same-origin"`** as the spike's did, beside `allow="cross-origin-isolated"`. Fact 4's probe ran without it; Task 10's e2e is the check, and the attribute is the first thing to drop if the worker does not start.
- **D15. A tail body is parsed twice** — by the shell for `complete` and `head_rev`, by the engine exactly (AD-26). An incomplete tail has no deltas, so the double parse is paid only when it succeeds.
- **D16. Parked batches cross a re-bootstrap too**: `adoptStaged` gets `staged` and `conflicts`' batches together, by id. They park again or apply; nothing is dropped silently (CT-5.3).
- **D17. `sandbox/` is its own npm package** with its own install and lockfile, like `engine/`; `appType: 'mpa'`, so a missing file is a 404 and not the page again (fact 2).
- **D18. e2e lands here, in a small form**: the replica is `ready` in the real sandbox, isolated, with no CSP violation; an own commit, a peer commit and a silent `/model/ops` bump all reach it; a second open is a cache hit. The peer is an API client, not a second browser.
- **D19. The commit response is applied only when it applied something.** `OpsResponseSchema` gains `prev_rev` (nullable, optional); a `null` one is handed to the replica as nothing.

## Global Constraints

- Everything runs through pixi. There is no global `node` or `python`: `pixi run <task>`, `pixi run -e frontend ...`.
- Work on branch `feat/sandbox-and-shell`, which exists already, cut from `engine-migration` at `c7bba47`, and is fast-forwarded back when the plan is done (Task 10). Never touch `main`. **Commit only with the owner's go-ahead for this plan's execution** — earlier approvals do not carry over; ask before Task 1.
- **Nothing under `engine/src/` or `src/data_rover/` changes.** The MR-3 freeze stands; if a task seems to need an engine change, stop and report it.
- `engine/src` stays free of DOM and WebWorker typings; they live in `sandbox/`. `sandbox/src/host.ts` may use only what a window, a worker and Node 22 share (`DecompressionStream`, `MessageChannel`, `performance`), because the frontend's tests run it (D8).
- The sandbox never touches the network and the shell never parses or evaluates model content (`system.md`, rules 1–2): bytes cross as transferred `ArrayBuffer`s, deltas and tails as the text the shell received (AD-26). The shell may `JSON.parse` an envelope for ITS OWN use (`rev`, `complete`, `head_rev`); it never re-serializes anything for the engine.
- `lib/api/*` imports no `lib/state/*` and no `lib/engine/*`; `lib/engine/*` imports no `lib/state/*` and no rune; production code imports `$engine` and `$sandbox` as types only (D6, D7).
- Every asynchronous continuation in `sync.ts` checks a generation token that `stop()` and `open()` bump; every API call of an open carries its project's base URL explicitly (fact 14).
- Tests of the shell use the real engine (`connectInProcess()`), never a mock of it (RC-14), MSW with `onUnhandledRequest: 'error'`, and NO fake timers — the engine's scheduler yields through real macrotasks; waits are injected (`deps.sleep`) or awaited through `sync.settled()`.
- Every Node `MessageChannel` a test opens is closed in its teardown (`link.dispose()`): an open port keeps the vitest worker alive.
- Performance: build what is written and report numbers. Do not optimize; plan 5's browser benchmark is the judge.
- Formatting: `pixi run frontend-tidy`, `pixi run sandbox-tidy` (Task 1 adds it). The check-only lint is `pixi run dr-tidy true` (the argument is positional).
- A "see it fail" step lists the tests it expects red. A helper that touches a missing name fails every test that uses it: expect ALL of them, and treat any OTHER red test as a finding to report, not to silence.
- Comments and docstrings are concise and present-tense, only for what the code cannot say. No references to specs, plans, phases or `architecture/` ids in code.
- `architecture/`, `CLAUDE.md`, `frontend/README.md`, `README.md`, `QUICKSTART.md` and `BACKLOG-ENGINE.md` are tracked and change in the same commit as the code they describe (RC-10); `docs/` and `benchmarks/` are git-ignored — never `git add -f`.
- Commit subjects: one imperative sentence, capitalized, no prefix, no trailing period; the message ends with the session's `Co-Authored-By` line.
- Ids: this plan uses `AD-27` and `K-37`. The next free ones afterwards are `K-38`, `C-22`, `AD-28`.
- Baseline (from the hand-off, as of `c7bba47`, not re-run while planning): core 2,551 passed / 34 deselected; frontend 2,493 tests in 252 files; engine 461 tests in 59 files.

## File Structure

```
sandbox/package.json, package-lock.json      (new) @data-rover/sandbox: vite, vitest, typescript, eslint, prettier
sandbox/tsconfig.json                        (new) the page: ES2023 + DOM
sandbox/tsconfig.worker.json                 (new) the worker: ES2023 + WebWorker
sandbox/tsconfig.test.json                   (new) tests and configs: + node
sandbox/vite.config.ts                       (new) mpa, es worker, the three headers on preview, localhost:5174
sandbox/vitest.config.ts, eslint.config.js, .prettierrc, .prettierignore, .gitignore   (new) as engine/'s
sandbox/index.html                           (new) one module script, nothing inline
sandbox/src/env.d.ts                         (new) vite/client types
sandbox/src/origins.ts                       (new) APP_ORIGIN, a build-time setting
sandbox/src/handshake.ts                     (new) the four message types; connectPort(): which event is the connect
sandbox/src/page.ts                          (new) starts the worker, reports readiness and violations, hands the port over
sandbox/src/host.ts                          (new) inflate, createHost (yieldToHost, now), portOf
sandbox/src/engine-worker.ts                 (new) createService over the first port it is given
sandbox/test/handshake.test.ts, host.test.ts (new)

frontend/vite.config.ts                      + the isolation plugin, first in the list
frontend/svelte.config.js                    + kit.alias: $engine, $sandbox
frontend/vitest.config.ts                    + the same two aliases
frontend/eslint.config.js                    + the type-only rule for $engine and $sandbox
frontend/package.json, package-lock.json     + fake-indexeddb (dev)
frontend/playwright.config.ts                + the sandbox web server
frontend/src/lib/api/feed.ts                 onEvent(event, raw); the commit event's delta fields
frontend/src/lib/api/client.ts               + ApiFetchInit.onText
frontend/src/lib/api/checkout.ts, history.ts + onText on commitChanges and revertToCommit
frontend/src/lib/api/types.ts                + prev_rev on OpsResponseSchema
frontend/src/lib/api/replica.ts              (new) descriptor, snapshot bytes, tail, the metamodel document with its id
frontend/src/lib/api/index.ts                + export * as replica
frontend/src/lib/engine/origins.ts           (new) SANDBOX_ORIGIN, sameHost
frontend/src/lib/engine/client.ts            (new) the CT-4 client over a port
frontend/src/lib/engine/frame.ts             (new) the iframe and the handshake
frontend/src/lib/engine/cache.ts             (new) the IndexedDB snapshot cache
frontend/src/lib/engine/sync.ts              (new) the replica's life
frontend/src/lib/engine/testing.ts           (new) connectInProcess: the real engine over a MessageChannel (tests only)
frontend/src/lib/engine/__tests__/{client,frame,cache,sync-open,sync-follow}.test.ts   (new)
frontend/src/lib/engine/__tests__/support/project-server.ts                            (new) the fake project server
frontend/src/lib/api/__tests__/{replica,feed,client,checkout,history}.test.ts          new file / + cases
frontend/src/lib/state/replica.svelte.ts     (new) the one sync of the tab, its status as state
frontend/src/lib/state/realtime.svelte.ts    hands commit, rebind and snapshot events to the replica
frontend/src/lib/state/checkout.svelte.ts    the commit in flight; adoption tells the replica
frontend/src/lib/state/index.ts              + the replica exports
frontend/src/lib/components/HistoryDrawer.svelte   the revert in flight
frontend/src/lib/components/StatusBar.svelte       + the indicator
frontend/src/routes/p/[projectId]/+page.svelte     start and stop; Reload tells the replica
frontend/src/lib/state/__tests__/{replica,realtime,checkout}.test.ts, components/__tests__/StatusBar.replica.test.ts   new / + cases
frontend/e2e/isolation.spec.ts, replica.spec.ts, helpers/replica.ts, helpers/api-client.ts   (new)

pixi.toml                                    + sandbox-install, -build, -start, -test, -check, -lint, -format, -tidy; dr-test, dr-tidy
process-compose.yaml                         + the sandbox process
.gitignore                                   + sandbox/node_modules, sandbox/dist
README.md, QUICKSTART.md, frontend/README.md, CLAUDE.md, BACKLOG-ENGINE.md
architecture/{contracts,decisions,conventions,program}.md
```

`sync.ts` is the one place that knows the order of things; `frame.ts`, `client.ts`, `cache.ts` and `lib/api/replica.ts` know nothing of each other and reach `sync.ts` as injected dependencies, which is what lets its tests swap the frame for `connectInProcess()`.

## Mechanisms

Referred to by the tasks; read them before the task that uses them.

**M1 — Origins.** Both are build-time settings with the defaults of spec §5: `sandbox/src/origins.ts` exports `APP_ORIGIN = import.meta.env.VITE_APP_ORIGIN ?? 'http://127.0.0.1:5173'`; `frontend/src/lib/engine/origins.ts` exports `SANDBOX_ORIGIN = import.meta.env.VITE_SANDBOX_ORIGIN ?? 'http://localhost:5174'` and `sameHost(a: string, b: string): boolean` (the two URLs' `hostname`s compared). They are origins — scheme, host, port, no trailing slash — because they are compared with `event.origin` by `===`.

**M2 — The handshake.** Four messages, all plain objects with a `type`:
- frame → shell `{type: 'sandbox-ready', crossOriginIsolated: boolean}` — posted once, with `APP_ORIGIN` as the target origin, after the worker has been created.
- shell → frame `{type: 'connect'}` with ONE transferred `MessagePort`, target origin `SANDBOX_ORIGIN`.
- frame → shell `{type: 'csp-violation', directive, blocked}` for every `securitypolicyviolation`, and `{type: 'worker-error', message}` when the worker's `error` event fires.
The shell accepts a message only when `event.origin === SANDBOX_ORIGIN` AND `event.source === frame.contentWindow`; anything else is ignored without a word. The page accepts a `connect` only when `event.origin === APP_ORIGIN`, `event.source === window.parent`, `event.ports.length === 1`, and none was accepted before; it posts `{type: 'port'}` with that port to the worker, keeps no reference to it, and is from then on outside the data path. The worker runs `createService` over the FIRST port it is given and ignores any other. Messages posted on a port before its `onmessage` is set are queued by the port, so the shell may call as soon as it has posted `connect`.

**M3 — What the worker supplies.**
- `inflate(chunks)`: a `DecompressionStream('gzip')`, fed by a pump that writes each chunk (`as Uint8Array<ArrayBuffer>`, fact 6) and closes, read through `getReader()` in a loop — not through the stream's async iterator, which not every evergreen browser has *(estimate)*. A failure of the STREAM — the reader's or the writer's — is rethrown as `SnapshotError('snapshot bytes do not inflate')` (D9); a failure of the SOURCE iterable (the service's `ByteQueue` failing on `close`) is rethrown as it is. The pump's promise is always awaited, so nothing is left unhandled.
- `createHost()` → `{deps: ServiceDeps, close()}`: `yieldToHost` pushes its resolver on a FIFO and posts `null` on a private `MessageChannel`, whose other port's `onmessage` shifts and calls one resolver (D10); `now` is `performance.now()`; `close()` closes both ports — the worker never calls it, tests must.
- `portOf(port)` → the engine's `Port`: `post(message, transfer)` is `port.postMessage(message, transfer ? [...transfer] : [])`; `onMessage(handler)` sets `port.onmessage = (event) => handler(event.data)`, which also starts the port.

**M4 — The client.** `createEngineClient(port)` over a `ClientPort` (`{postMessage(message, transfer?), onmessage, close()}` — a `MessagePort` fits). Request ids count from 1. An answer `{id, ok: true, result}` resolves its call; `{id, ok: false, error: {status, detail}}` rejects it with `errorForStatus(status, {detail}, detail)` of `lib/api/errors`, so a caller branches on `NotFoundError` / `ConflictError` / `ValidationError` as after an HTTP call (CT-4). A message with an `event` key goes to every listener; anything else, and an answer to an id that is not pending, is ignored. `options.signal`: aborted already → the call rejects with a `DOMException` named `AbortError` and nothing is posted; aborted later → `{cancel: id}` is posted, the call rejects the same way and its id is forgotten, so a late answer is dropped. `options.transfer` rides as the transfer list. `dispose()` rejects every pending call with an `EngineGoneError`, closes the port and makes every later call reject likewise.

**M5 — The replica API** (`lib/api/replica.ts`). Every function takes a `ClientConfig`, and `sync.ts` always passes `{baseUrl: '/api/v1/projects/<id>'}` of ITS project (fact 14).
- `getSnapshotDescriptor(cfg)` → the zod-checked `{rev, metamodel_id, state_digest, elements, relationships, url}`, or `null` on a 404 (`No model loaded`). A 503 throws.
- `fetchSnapshot(url, signal)` → the `Response` of `apiFetchRaw(url, {method: 'GET', signal}, {baseUrl: ''})` — the descriptor's `url` is a whole path (fact 16).
- `fetchTail(fromRev, cfg)` → `{text, fromRev, headRev, complete}`: `apiFetchRaw('/replica/tail', {query: {from_rev}})`, `text = await response.text()`, and the three envelope fields out of `JSON.parse(text)` through a zod object that names only them (D15).
- `fetchMetamodelDocument(cfg)` → `{doc, metamodelId}`: `apiFetchRaw('/metamodel')`, `metamodelId = response.headers.get('X-Metamodel-Id') ?? ''`, `doc = JSON.parse(text)` with NO schema — the engine takes the server's document as it stands (AD-22), and a zod pass would reshape it.

**M6 — The cache.** One database `datarover-snapshots`, version 1, one object store `snapshots` with key path `project_id` (D11). `get(projectId, rev)`: the row, if its `rev` is the one asked for — then `used_at` is rewritten and a COPY of `bytes` is returned — else `null`. `put(projectId, rev, bytes)`: refuses silently a row larger than the cap; writes the row; then reads every row's `size` and `used_at` and deletes least-recently-used rows of OTHER projects until the sum fits. `drop(projectId)`. Every function resolves, whatever happens: no `indexedDB` at all, an `open` that errors or is blocked, a transaction that aborts, a quota error (AD-10). The clock (`now`) and the factory are options, so a test can order rows and break the store.

**M7 — An attempt to open.** Input: the project id, whether the cache may be read, the batches to adopt (a re-bootstrap) or none. Every step first checks the generation token. The engine link is built on first need — after step 1 has said there is a model — and kept until `stop()`; a `connect()` that rejects (`FrameError`) is the boot fallback AT ONCE, phase `server` with the error's message as the reason, no retry: a frame that did not load will not load a second later.
1. `descriptor = api.descriptor()`; `null` → status `off`, reason `no model`, and the open ends without failing.
2. `{doc, metamodelId} = api.metamodel()`; when `metamodelId !== descriptor.metamodel_id` go back to step 1 — free of charge, three times at most (D3, D12).
3. `client.call('open', {project_id, metamodel: doc})`.
4. Bytes. A cache hit is ONE `chunk` call that transfers the whole buffer (the engine cuts large chunks itself); status `source: 'cache'`. A miss is `api.snapshot(descriptor.url, signal)`: `total` from `Content-Length` (`null` without it), and for every chunk read from `response.body.getReader()`: keep a copy for the cache, then transfer it. **What is transferred is exactly the chunk:** when `chunk.byteOffset !== 0 || chunk.byteLength !== chunk.buffer.byteLength` the view is copied first (`chunk.slice().buffer`) — transferring a view's `buffer` sends the WHOLE buffer, and the engine reads all of it. `chunk` calls are not awaited one by one; their promises are collected, and a rejected one is what `end` reports too. Progress `download`, per chunk.
5. `header = await client.call('end')`. It must name the descriptor's `rev` and `metamodel_id`, else the attempt fails. A 422 here when the bytes came from the cache: `cache.drop(projectId)`, and the attempt runs again from step 1 with the cache off, uncounted (D9). After a good `end` on a miss: `cache.put(projectId, header.rev, <the copies joined>)`, not awaited.
6. With batches to adopt: `client.call('adoptStaged', {batches})`.
7. `tail = api.tail(header.rev)`; `complete: false` fails the attempt (the server's descriptor promises a complete tail, so something moved — a rebind, most likely — and the next attempt's descriptor names another snapshot).
8. `client.call('applyTail', {text: tail.text})`; a `gap` or `diverged: true` fails the attempt.
9. Status `ready` at the result's `rev`; the pump (M8) starts on whatever the feed buffered.
Engine `progress` events for `parse`, `index` and `tail` become the status's `progress` while opening or resyncing; `verify` is carried too, but does not change the phase. An attempt that fails — a rejected call, a thrown fetch, one of the checks above — calls `close` on the engine (ignoring its answer), waits (`deps.sleep`: 1 s, then 3 s) and runs again; after the third failure the phase is `server` when this sync has never been `ready` since its `open()` (the boot fallback, D1) — the link is disposed, so whatever waits in the worker rejects with `EngineGoneError` — and `failed` otherwise, the link kept.

**M8 — The pump.** Following is ONE queue of inputs, handled one at a time, each to its end, in arrival order: `{kind: 'delta', raw, rev, own?}`, `{kind: 'snapshot', modelRev}`. It runs only while the phase is `ready` and no commit is in flight (M9); in `opening` and `resyncing` inputs wait (at most 1,000, D12); in `off`, `frozen`, `failed` and `server` they are dropped.
- A delta whose `rev` is not past the replica's is dropped without a call — unless it carries `own` (a duplicate with `own` still has bookkeeping to do, CT-5.3). Otherwise `applyDelta {text: raw, own}`: `applied` and `duplicate` move on; `gap` runs a *catch-up*; `diverged: true` re-bootstraps.
- A snapshot event ahead of the replica (`modelRev > rev`) runs a catch-up (CN-9); one that is not does nothing.
- *Catch-up:* `api.tail(rev)` → incomplete → re-bootstrap; else `applyTail {text}` → `gap` or diverged → re-bootstrap. Deltas that arrived during the fetch are behind it in the queue and drop as duplicates.
- The engine's event `replica {state: 'diverged'}` — the background digest check ended false — re-bootstraps.
The shell learns the replica's `rev` from the results of `end`, `applyTail` and `applyDelta` and from `replica` events, never from its own arithmetic.

**M9 — A commit in flight.** `beginCommit()` is called BEFORE the POST and returns a flight; the pump holds while any flight is open, so feed deltas — the echo among them — wait. `flight.settle({text, rev, applied, rebound, idMap, batchIds})` after the response: when `rebound`, the replica freezes (M10) and nothing is applied; when `applied` is false (D19), nothing is queued; otherwise the response is inserted INTO the queue at its place by `rev` — before the first waiting delta whose `rev` is not smaller — as a delta with `own = {batch_ids: batchIds ?? [], id_map: idMap}`. Then the pump runs: what came before the commit, the commit itself, the rest; the echo, no longer past the replica, is dropped by M8's first rule (CT-2's order). `flight.abandon()` — the POST failed — just lets the pump go. Settling or abandoning twice is a no-op. While the replica is not `ready` a settled response waits in the buffer like any delta. In this plan nothing is staged in the engine, so `batchIds` is always empty; plan 6 passes the real ones.

**M10 — Freeze and re-bootstrap.**
- *Freeze* (D2): `feedRebind(rev)` and a `rebound` settle set phase `frozen`, reason `metamodel changed at rev N`, empty the queue, and end any attempt in flight at its next token check. `metamodelAdopted()` while `frozen` re-bootstraps; in any other phase it does nothing.
- *Re-bootstrap:* phase `resyncing`; read `staged` and `conflicts` from the engine, join their batches by id (D16); `close`; then M7's attempts with those batches, which the sync holds across the attempts — after `close` the engine no longer has them. A re-bootstrap asked for while one runs is remembered and runs once more after it, not in parallel. Feed inputs wait in the queue meanwhile.

**M11 — Status.** One object, replaced on every change and handed to `deps.onStatus`:
```
ReplicaPhase  = 'off' | 'opening' | 'ready' | 'resyncing' | 'frozen' | 'failed' | 'server'
ReplicaStatus = { phase, rev: number | null,
                  progress: {task: 'download'|'parse'|'index'|'tail'|'verify', done: number, total: number | null} | null,
                  attempt: number,                  // 1…3 while opening or resyncing, else 0
                  source: 'cache' | 'network' | null,
                  isolated: boolean | null,         // the frame's crossOriginIsolated; null before the handshake
                  cspViolations: number,
                  reason: string | null }           // why off, frozen, failed or server
```
`server` is this plan's name for the boot fallback: the frame did not connect (`FrameError`: same host, timeout, worker error) or three opens failed before the first `ready`. Plan 5 turns `server` into the surface flip and its notice, `failed` into the blocking banner (D1).

**M12 — The fake project server** (`__tests__/support/project-server.ts`). `fakeProject({projectId, rev, metamodelId})` loads the smart-city example (`examples/smart-city.model.json` through `parseJson`, the metamodel document out of `engine/fixtures/golden/smart_city.json`, both by `readFileSync` from `process.cwd() + '/..'`) into an engine `Model` and stands for the server:
- `commit(ops)` applies a batch with `applyBatch` (ids minted `srv-1`, `srv-2`, …), bumps `rev`, records the delta — `rev`, `prev_rev`, `state_digest: modelDigest(model)`, the changed entities read back from `elementLine` / `relationshipLine` through `parseJson`, the deleted and recreated ids — and returns `{delta, eventText, responseText}`: `pyDumps` of the delta as a feed `commit` event (`type: 'commit'`, `rev`) and as a commit response (`model_rev` in place of `rev`, an `id_map`).
- `silentCommit(ops)` does the same and marks the row as not broadcast — what `/model/ops` is to a replica.
- `rebind(metamodelId)` swaps the metamodel document and id, bumps `rev`, writes a row that makes every tail across it incomplete, and takes a fresh snapshot. `opaqueBump()` bumps `rev` with no row at all — what `touch_model` is to a replica — and takes a fresh snapshot too.
- `snapshot()` fixes the snapshot the descriptor names at the current `rev`: the header line, then `modelLines(model)`, every line LF-ended, gzipped with `node:zlib` at level 3.
- `handlers(options?)` → MSW handlers for `GET …/replica/snapshot`, `…/replica/snapshots/:rev` (a streamed body in chunks of `options.chunk ?? 4096` with `Content-Length`; 404 for another `rev`), `…/replica/tail?from_rev=` (complete iff every row in range is a recorded delta and the range is at most 1,000) and `…/metamodel` (with `X-Metamodel-Id`); `requests` counts the calls per route; `fail(route, status, times)` makes a route answer an error a number of times; `corruptNextSnapshot()`, `wrongDigestInNextSnapshot()`.

---

### Task 1: The sandbox site

**Files:**
- Create: everything under `sandbox/` listed in File Structure
- Modify: `pixi.toml`, `.gitignore`, `CLAUDE.md`, `architecture/conventions.md`

**Interfaces:**
- `sandbox/src/handshake.ts`: `type SandboxReady = {type: 'sandbox-ready'; crossOriginIsolated: boolean}`; `type Connect = {type: 'connect'}`; `type CspViolation = {type: 'csp-violation'; directive: string; blocked: string}`; `type WorkerFailed = {type: 'worker-error'; message: string}`; `type FrameMessage = SandboxReady | CspViolation | WorkerFailed`; `connectPort(event: {origin: string; source: unknown; data: unknown; ports: readonly MessagePort[]}, expected: {origin: string; parent: unknown}): MessagePort | null` — the port of an acceptable `connect` (M2), else `null`. The "only once" rule is the page's, not this function's.
- `sandbox/src/host.ts`: `inflate(chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array>`; `createHost(): {deps: ServiceDeps; close(): void}`; `type HostPort = {postMessage(message: unknown, transfer: Transferable[]): void; onmessage: ((event: MessageEvent) => void) | null}`; `portOf(port: HostPort): Port` (M3). `ServiceDeps` and `Port` are the engine's types; `SnapshotError` and `createService` its values — imported from `../../engine/src/index.ts`.
- `sandbox/src/origins.ts`: `APP_ORIGIN` (M1).
- pixi tasks under `[feature.frontend.tasks]`, each with `cwd = "sandbox"`, shaped as the engine's: `sandbox-install` (`npm install`), `sandbox-build` (`npm run build`), `sandbox-start` (`npm run start`), `sandbox-test`, `sandbox-check`, `sandbox-lint`, `sandbox-format`, `sandbox-tidy` (the last three with the `check_only` argument, as `engine-*`). `dr-test` gains `sandbox-test`, `dr-tidy` gains `sandbox-tidy`, both with `environment = "frontend"`.
- `sandbox/package.json` scripts: `build` = `vite build`; `preview` = `vite preview`; `start` = `vite build && (vite build --watch & vite preview)`; `check` = `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.worker.json && tsc --noEmit -p tsconfig.test.json`; `lint`, `format`, `test` as `engine/package.json`'s. Dev dependencies at the versions `engine/` and `frontend/` already pin: `vite`, `vitest`, `typescript`, `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-config-prettier`, `globals`, `prettier`, `@types/node`.
- `sandbox/vite.config.ts`: `appType: 'mpa'`; `worker: {format: 'es'}`; `build: {target: 'es2022', outDir: 'dist', emptyOutDir: true}`; `preview: {host: 'localhost', port: 5174, strictPort: true, headers}` with `headers` = `Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: cross-origin` — and the same `headers` under `server`, so that nobody who runs `vite dev` here gets a laxer policy than the one that ships.

- [ ] **Step 1: Ask.** Ask the owner whether commits are pre-approved for this plan. `git switch feat/sandbox-and-shell` (it exists).
- [ ] **Step 2: Scaffold and install.** Write the package, the three tsconfigs (`tsconfig.json`: `lib: ["ES2023", "DOM"]`, includes `src/page.ts`, `src/handshake.ts`, `src/origins.ts`, `src/env.d.ts`; `tsconfig.worker.json`: `lib: ["ES2023", "WebWorker"]`, includes `src/engine-worker.ts`, `src/host.ts`; `tsconfig.test.json`: `lib: ["ES2023", "DOM"]`, `types: ["node"]`, includes `test/**`, `src/host.ts`, `src/handshake.ts`, the two config files — every other option as `engine/tsconfig.json`, `allowImportingTsExtensions` included, since the engine's sources come in through the imports), the vitest config (`environment: 'node'`, `include: ['test/**/*.test.ts']`), eslint and prettier files copied from `engine/` (ignores: `node_modules/`, `dist/`), `.gitignore` (`node_modules`, `dist`), the pixi tasks and the two root `.gitignore` lines. `pixi run sandbox-install`. Whether DOM and WebWorker can share one tsconfig was NOT checked; keep them apart even if they can — the page must not see worker globals.
- [ ] **Step 3: Write the failing tests.**
  - `test/host.test.ts`:
    - `inflate gives the bytes back however the input is cut` — a 200 kB text gzipped with `node:zlib`, cut at 1 byte, 7 bytes and 64 KiB: the joined output equals the text's bytes and every piece is a `Uint8Array`.
    - `a stream that does not inflate is a SnapshotError` — a truncated member, a member followed by stray bytes, and plain text each reject with `SnapshotError` and the message `snapshot bytes do not inflate`.
    - `a failing source keeps its own error` — a source iterable that throws `new Error('closed')` after one chunk rejects with that error, and no unhandled rejection is reported (`process.on('unhandledRejection')` spy).
    - `yieldToHost is a macrotask, first in first out` — two yields requested in order resolve in order; after 1,000 `await null` neither has resolved; after `await new Promise((r) => setTimeout(r, 5))` both have.
    - `portOf carries the engine over a MessagePort` — `createService(portOf(port2), host.deps)` over a Node `MessageChannel`: `{id: 1, method: 'nope'}` is answered `{id: 1, ok: false, error: {status: 404, detail: "No method 'nope'"}}`; a request posted BEFORE `createService` ran is answered too (the port queues); `post` hands its transfer list on (a transferred buffer arrives detached at the sender).
    - Close every channel and `host.close()` in `afterEach`.
  - `test/handshake.test.ts`: `connectPort` returns the port for the right origin, source, type and one port; `null` for another origin, another source, another `type`, no port, two ports, a `data` that is not an object.
- [ ] **Step 4: See them fail.** `pixi run sandbox-test`: both files red at import (no `src/host.ts`, no `src/handshake.ts`).
- [ ] **Step 5: Implement** `handshake.ts`, `host.ts` (M3), `origins.ts`, then the two entry points, which no unit test covers: `page.ts` — create the worker (`new Worker(new URL('./engine-worker.ts', import.meta.url), {type: 'module'})`), report its `error` event and every `securitypolicyviolation` to the parent at `APP_ORIGIN`, listen for `message` and hand the first `connectPort(...)` hit to the worker as `{type: 'port'}`, then post `sandbox-ready`; `engine-worker.ts` — on the first `message` whose `data.type === 'port'` and that carries a port: `createService(portOf(port), createHost().deps)`. `index.html`: doctype, charset, a title, `<script type="module" src="/src/page.ts"></script>`, nothing else.
- [ ] **Step 6: See them pass, build, and look at what was built.** `pixi run sandbox-test`, `pixi run sandbox-check`, `pixi run sandbox-build`. Then by hand: `sandbox/dist/index.html` holds one `<script type="module" … src="/assets/…">` and no inline script or style; `dist/assets/` holds a page chunk and an `engine-worker-*.js`. Start `pixi run -e frontend bash -c 'cd sandbox && npx vite preview'` and `curl -s -D - -o /dev/null http://localhost:5174/` and a hashed asset: both carry the three headers; `curl -s -o /dev/null -w '%{http_code}' http://localhost:5174/missing.js` is 404 (D17). Stop the server.
- [ ] **Step 7: Lint.** `pixi run sandbox-tidy`.
- [ ] **Step 8: Docs.** `architecture/conventions.md`, RC-1: a row `sandbox/` — "Sandbox page and engine worker: a static Vite site, the only place with DOM and WebWorker typings — created by sub-project B" — and RC-2's last sentence names `sandbox/` too. `CLAUDE.md`: the commands block gains the sandbox tasks under a `# Sandbox (static site in sandbox/; the tasks set cwd = "sandbox")` heading; a new section after "Engine package", **"Sandbox (`sandbox/`)"**: what the page does and that it leaves the data path, the worker's three dependencies and why each is what it is (the reader loop, the `SnapshotError` wrap and the 500 it avoids, the `MessageChannel` yield and the 4 ms clamp), the policy headers and that they sit on `preview` AND `server`, `appType: 'mpa'`, the three tsconfigs, that `host.ts` may use only what window, worker and Node share because the frontend's tests run it.
- [ ] **Step 9: Commit** (with the owner's go-ahead): `Serve the engine worker from a sandbox site`.

---

### Task 2: The app's isolation and the stack

**Files:**
- Create: `frontend/e2e/isolation.spec.ts`
- Modify: `frontend/vite.config.ts`, `frontend/playwright.config.ts`, `process-compose.yaml`, `README.md`, `QUICKSTART.md`, `frontend/README.md`, `CLAUDE.md`

**Interfaces:**
- `frontend/vite.config.ts`: a local `crossOriginIsolation(): Plugin` whose `configureServer` AND `configurePreviewServer` register a middleware that sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on every response and calls `next()`. It is FIRST in `plugins` (fact 1).
- `playwright.config.ts`: a third `webServer` — `command: 'npm run build && npm run preview'`, `cwd: '../sandbox'`, `url: 'http://localhost:5174/'`, `timeout: 60_000`, `reuseExistingServer: true`.
- `process-compose.yaml`: a process `sandbox` — `command: "pixi run -e frontend sandbox-start"` — independent of the others, with a comment saying it is always built files so that development runs under the shipped policy.

- [ ] **Step 1: Write the failing spec.** `e2e/isolation.spec.ts`: (a) on `/login`, `await page.evaluate(() => self.crossOriginIsolated)` is `true`; (b) `request.get('http://localhost:5174/')` is 200 and carries the CSP of CN-17 verbatim, `cross-origin-embedder-policy: require-corp` and `cross-origin-resource-policy: cross-origin`; (c) a missing path there is 404.
- [ ] **Step 2: See it fail.** `pixi run frontend-test-e2e -- isolation` (if pixi does not pass the argument through, `pixi run -e frontend bash -c 'cd frontend && npx playwright test isolation'`): (a) red — `false`; (b) and (c) red until the config knows the sandbox server (connection refused).
- [ ] **Step 3: Implement** the plugin, the web server entry, the process-compose entry.
- [ ] **Step 4: See it pass, then run the WHOLE e2e suite** (`pixi run frontend-test-e2e`): every existing spec now runs on a cross-origin isolated app. A spec that goes red here is this task's finding — COEP blocks a cross-origin subresource without CORP, and planning found none in `frontend/src` or `frontend/static`; report what it was before touching it.
- [ ] **Step 5: Docs.** `README.md:56,59`, `QUICKSTART.md:22,42`, `frontend/README.md:1569`: `http://127.0.0.1:5173`, with one sentence why (the sandbox lives on `localhost`, and the two must be different hosts). `README.md`'s start section and task table and `QUICKSTART.md`'s manual list gain `pixi run sandbox-start` (`http://localhost:5174`, built files); `frontend/README.md` "Running" says the app is served with COOP and COEP in dev and e2e and that any future cross-origin subresource needs CORP or CORS (CN-14). `CLAUDE.md`'s commands block: one line for `sandbox-start`.
- [ ] **Step 6: Lint** (`pixi run frontend-tidy`) **and commit:** `Serve the app cross-origin isolated beside the sandbox`.

---

### Task 3: The engine client

**Files:**
- Create: `frontend/src/lib/engine/client.ts`, `testing.ts`, `__tests__/client.test.ts`
- Modify: `frontend/svelte.config.js`, `frontend/vitest.config.ts`, `frontend/eslint.config.js`, `frontend/README.md`

**Interfaces:**
- Aliases: `$engine` → `../engine/src/index.ts`, `$sandbox` → `../sandbox/src` — in `kit.alias` (svelte-check and the build) and in `vitest.config.ts`'s alias block. The lint rule of D7.
- `client.ts`:
  - `type ClientPort = {postMessage(message: unknown, transfer?: Transferable[]): void; onmessage: ((event: {data: unknown}) => void) | null; close(): void}`
  - `type CallOptions = {signal?: AbortSignal; transfer?: ArrayBuffer[]}`
  - `type EngineClient = {call<T>(method: string, params?: unknown, options?: CallOptions): Promise<T>; on(listener: (event: ServiceEvent) => void): () => void; dispose(): void}`
  - `class EngineGoneError extends Error` (`name = 'EngineGoneError'`)
  - `createEngineClient(port: ClientPort): EngineClient` (M4). `ServiceEvent` is `import type` from `$engine`.
  - `type EngineLink = {client: EngineClient; isolated: boolean | null; onViolation(listener: (violation: {directive: string; blocked: string}) => void): () => void; dispose(): void}` — what `sync.ts` is handed; `frame.ts` builds the real one, `testing.ts` the in-process one.
- `testing.ts`: `connectInProcess(): EngineLink` — a Node `MessageChannel`, `createService(portOf(port2), host.deps)` with `$sandbox/host.ts`'s `createHost()`, a client on `port1`, `isolated: null`, and a `dispose()` that disposes the client, closes both ports and the host.

- [ ] **Step 1: Write the failing tests** (`__tests__/client.test.ts`, every link from `connectInProcess()`, disposed in `afterEach`):
  - `a call is answered under its id` — `staged` resolves to `[]`; five calls posted at once (`staged`, `conflicts`, `nope`, `staged`, `conflicts`) each settle with their own answer.
  - `an error answer is the ApiError its status names` — `nope` → `NotFoundError`, message `No method 'nope'`, `status` 404, `body` `{detail: …}`; `chunk` without an open → `ConflictError`; `open` with `{project_id: 'p', metamodel: {elements: 5}}` (the engine's own malformed document) → `ValidationError`.
  - `a signal that is already aborted posts nothing` — spy on the port's `postMessage`: not called; the rejection is a `DOMException` named `AbortError`.
  - `aborting a waiting call cancels it` — `getElement {id: 'x'}` with no replica open waits in the engine's queue; abort: the call rejects `AbortError`, `{cancel: <id>}` was posted; then a `staged` call is still answered.
  - `a late answer to a cancelled call is dropped` — drive a `createEngineClient` over a hand-made `ClientPort`: post nothing back until after the abort, then deliver `{id, ok: true, result: 1}`: nothing throws and no listener sees it.
  - `events reach every listener until it unsubscribes` — open smart-city through the client (`open`, `chunk`s, `end`, `applyTail`, with `fakeProject` of Task 7 not yet there: build the gzip inline with `pyDumps`, `modelLines`, `modelDigest` and `node:zlib`, as planning's probe did — the helper moves to `support/` in Task 7): two listeners both see `replica opening` … `replica ready`; one unsubscribes and sees nothing of a second open.
  - `a transferred buffer leaves the caller` — after `call('chunk', {bytes}, {transfer: [bytes]})`, `bytes.byteLength === 0`.
  - `dispose rejects what is pending and everything after` — a waiting `getElement` rejects with `EngineGoneError`; a later `staged` too; the port's `close` was called.
- [ ] **Step 2: See them fail** — the file, at import. Add the aliases first, or the failure is a resolution error instead of a missing module; either is red.
- [ ] **Step 3: Implement** `client.ts` (M4) and `testing.ts`.
- [ ] **Step 4: See them pass**; `pixi run frontend-check` (the engine's and the sandbox's sources are now in svelte-check's program: planning saw 0 errors with the engine's; `sandbox/src/host.ts` is new to it — an error there is fixed in `host.ts`, which must satisfy both programs).
- [ ] **Step 5: See the lint rule bite.** Temporarily add `import { createService } from '$engine';` to `client.ts`: `pixi run frontend-lint true` must refuse it; remove it. `import type` must pass.
- [ ] **Step 6: Docs.** `frontend/README.md`: a new section **"Replica (engine shell)"** after "State model", for now: the `$engine` / `$sandbox` aliases and the types-only rule with its reason (the app bundle never holds the engine), the client (ids, `ApiError`s by status, `AbortSignal` → `{cancel}` → `AbortError`, events, `dispose`), and `connectInProcess()` as the only way a shell test gets an engine.
- [ ] **Step 7: Lint and commit:** `Call the engine through a port`.

---

### Task 4: The frame

**Files:** Create `frontend/src/lib/engine/origins.ts`, `frame.ts`, `__tests__/frame.test.ts`. Modify `frontend/README.md`.

**Interfaces:**
- `origins.ts` (M1).
- `frame.ts`:
  - `type FrameElement = {contentWindow: {postMessage(message: unknown, targetOrigin: string, transfer: Transferable[]): void} | null; remove(): void}`
  - `type FrameDeps = {window: Pick<Window, 'addEventListener' | 'removeEventListener'>; location: {origin: string}; createFrame(src: string): FrameElement; createChannel(): {port1: ClientPort; port2: MessagePort}; sandboxOrigin: string; timeoutMs: number}`
  - `class FrameError extends Error { kind: 'same-host' | 'timeout' | 'worker' }`
  - `connectFrame(deps?: Partial<FrameDeps>): Promise<EngineLink>` — defaults: the real `window` and `location`, `SANDBOX_ORIGIN`, 10,000 ms, `new MessageChannel()`, and a `createFrame` that appends to `document.body` an `<iframe>` with `src = sandboxOrigin + '/'`, `allow="cross-origin-isolated"`, `sandbox="allow-scripts allow-same-origin"` (D14), `aria-hidden="true"`, `tabindex="-1"`, `title="Data Rover engine"` and a style that takes it out of layout (`position:absolute;width:0;height:0;border:0`). One frame per call; the caller (`sync.ts`) holds at most one link.

- [ ] **Step 1: Write the failing tests** (`frame.test.ts`; the window is a bare `EventTarget`, the frame a hand-made `FrameElement` with a `vi.fn()` `postMessage`, the channel a real `MessageChannel`; messages are dispatched as `new MessageEvent('message', {data, origin})` with `source` set through `Object.defineProperty` — happy-dom's own `postMessage` cannot carry them, and a test says so in a comment):
  - `a ready frame is connected` — dispatch `sandbox-ready {crossOriginIsolated: true}` from the sandbox's origin and the frame's `contentWindow`: `contentWindow.postMessage` was called once with `{type: 'connect'}`, `SANDBOX_ORIGIN` and ONE port; the promise resolves to a link with `isolated: true`; with `crossOriginIsolated: false` the link says `false` — it is a warning in B, not a failure.
  - `the link's client talks over the channel` — hand the transferred port to `createService` (as `testing.ts` does) and `call('staged')` answers `[]`.
  - `other origins, other sources and other messages are ignored` — each alone, and the promise is still pending; then a good one resolves it.
  - `a second ready does not connect twice`.
  - `no frame on the sandbox's own host` — `location.origin = 'http://localhost:5173'`: rejects `FrameError` of kind `same-host`, and `createFrame` was never called (D13).
  - `a frame that never answers times out` — `timeoutMs: 20`: rejects kind `timeout`; the frame was removed and the listener is gone (a late `sandbox-ready` posts nothing).
  - `a worker error before ready rejects; after ready it ends the link` — before: kind `worker` with the message; after: a pending `call` rejects with `EngineGoneError`.
  - `violations are counted for whoever listens` — two `csp-violation` messages reach `onViolation`'s listener with `directive` and `blocked`; after unsubscribing, none.
  - `dispose removes the frame, the listener and the port`.
- [ ] **Step 2: See them fail** — at import.
- [ ] **Step 3: Implement** (M2).
- [ ] **Step 4: See them pass.**
- [ ] **Step 5: Docs** — the README section gains the frame: the four messages, the two checks on each side, the timeout, the same-host refusal and the docs rule that goes with it, and why the unit tests inject the window (fact 7).
- [ ] **Step 6: Lint and commit:** `Embed the sandbox and hand it a port`.

---

### Task 5: The snapshot cache

**Files:** Create `frontend/src/lib/engine/cache.ts`, `__tests__/cache.test.ts`. Modify `frontend/package.json` (+ lockfile), `frontend/README.md`.

**Interfaces:**
- `type SnapshotCache = {get(projectId: string, rev: number): Promise<ArrayBuffer | null>; put(projectId: string, rev: number, bytes: ArrayBuffer): Promise<void>; drop(projectId: string): Promise<void>}`
- `const SNAPSHOT_CACHE_CAP = 64 * 1024 * 1024`
- `createSnapshotCache(options?: {factory?: IDBFactory | undefined; capBytes?: number; now?: () => number}): SnapshotCache` — `factory` defaults to `globalThis.indexedDB`, `now` to `Date.now` (M6).

- [ ] **Step 1: Install and write the failing tests.** `pixi run -e frontend bash -c 'cd frontend && npm install --save-dev fake-indexeddb'`. `cache.test.ts`, each test with `new IDBFactory()` from `fake-indexeddb`:
  - `a miss on an empty store`; `what was put comes back, as a copy` (mutating the returned buffer does not change the next `get`); `another rev is a miss`; `a newer put replaces the project's row` (the old `rev` is then a miss).
  - `the least recently used project goes first` — cap 100 bytes, three projects of 40 put at `now` 1, 2, 3, then a `get` of the first at 4, then a fourth project of 40: the SECOND is gone, the others are there.
  - `the project being written is never the one evicted`; `a row larger than the cap is not stored`; `drop`.
  - `nothing ever rejects` — no factory at all (`factory: undefined` with `globalThis.indexedDB` absent): `get` is `null`, `put` and `drop` resolve; a factory whose `open` throws; one whose request fires `onerror`; one that fires `onblocked`; a `put` whose transaction aborts (wrap the fake's `IDBObjectStore.put` to throw a `QuotaExceededError`): each call resolves and a following `get` is `null`.
- [ ] **Step 2: See them fail** — at import.
- [ ] **Step 3: Implement** (M6). One `open` per call is fine (no connection is kept: a version change elsewhere can never block on this tab).
- [ ] **Step 4: See them pass.**
- [ ] **Step 5: Docs** — the README section gains the cache: the key, the one row per project, the cap, that a hit needs the descriptor's exact `rev`, that a row is written only after the engine accepted the bytes and dropped when it refused them, and that every failure is a miss (AD-10).
- [ ] **Step 6: Lint and commit:** `Cache snapshot bytes in IndexedDB`.

---

### Task 6: Raw text, and the replica routes on the client

**Files:**
- Create: `frontend/src/lib/api/replica.ts`, `__tests__/replica.test.ts`
- Modify: `frontend/src/lib/api/feed.ts`, `client.ts`, `checkout.ts`, `history.ts`, `types.ts`, `index.ts`; their tests in `frontend/src/lib/api/__tests__/` (`feed.test.ts`, `client.test.ts`, and the files that cover `commitChanges` and `revertToCommit`); `frontend/README.md`

**Interfaces:**
- `feed.ts`: `FeedConfig.onEvent: (event: FeedEvent, raw: string) => void`; the `commit` member of `FeedEvent` gains `prev_rev?: number`, `state_digest?: string`, `recreated_element_ids?: string[]`, `recreated_relationship_ids?: string[]`.
- `client.ts`: `ApiFetchInit.onText?: (text: string) => void` — called by `apiFetch` with the body's text, once, BEFORE `JSON.parse`, for a non-empty 2xx body only. It must not reach `fetch` (strip it with the other non-`RequestInit` keys).
- `checkout.ts`: `commitChanges(req, cfg?, onText?: (text: string) => void)`; `history.ts`: `revertToCommit(req, cfg?, onText?)` — each passes it as `init.onText`.
- `types.ts`: `OpsResponseSchema` gains `prev_rev: z.number().int().nullable().optional()` (D19).
- `replica.ts` (M5): `SnapshotDescriptorSchema`, `type SnapshotDescriptor`, `type TailBody = {text: string; fromRev: number; headRev: number; complete: boolean}`, `getSnapshotDescriptor(cfg?: ClientConfig): Promise<SnapshotDescriptor | null>`, `fetchSnapshot(url: string, signal?: AbortSignal): Promise<Response>`, `fetchTail(fromRev: number, cfg?: ClientConfig): Promise<TailBody>`, `fetchMetamodelDocument(cfg?: ClientConfig): Promise<{doc: unknown; metamodelId: string}>`.

- [ ] **Step 1: Write the failing tests.**
  - `feed.test.ts`: `the frame's text comes with the event` — a frame sent as the STRING `{"type":"commit","rev":3,"changed_elements":[{"id":"a","type_name":"T","properties":{"x":1.0,"n":9007199254740993},"rev":2}], …}`: `onEvent`'s second argument is that string, byte for byte (`1.0` and the big integer intact), while the first is its `JSON.parse`. The file's `FakeSocket.message` helper stringifies an object; add a `raw(text)` twin.
  - `client.test.ts`: `onText gets the body before it is parsed` — the text, once; not called on a 204, on an empty body or on an error status; `init.onText` does not show up in the `fetch` init (MSW handler inspects nothing of it; spy on a passed `config.fetch`).
  - The `commitChanges` and `revertToCommit` tests: `onText` receives the response's text; `prev_rev` survives the schema (`3`, `null`, absent).
  - `replica.test.ts` (MSW, `BASE = 'http://api.test/api/v1/projects/p1'`): the descriptor parses, a 404 is `null`, a 503 throws an `ApiError` of that status; `fetchSnapshot('/api/v1/projects/p1/replica/snapshots/7')` requests exactly that path on the page's origin (the handler is registered on the absolute URL happy-dom resolves it to) and returns a `Response` whose body streams and whose `Content-Length` reads; an aborted signal rejects `AbortError`; `fetchTail(5)` sends `from_rev=5`, returns the text UNTOUCHED — assert on a body holding `1.0` — and the three envelope fields, for a complete and an incomplete body; `fetchMetamodelDocument` returns the header's id, `''` without the header, and the document as `JSON.parse` gives it, keys the zod `MetamodelSchema` would not know included.
- [ ] **Step 2: See them fail** — the new file at import; the new cases on missing arguments and fields. Every existing test of these five files stays green: the second `onEvent` argument and `onText` are additive.
- [ ] **Step 3: Implement.** In `feed.ts` the change is `config.onEvent(JSON.parse(data) as FeedEvent, data)`.
- [ ] **Step 4: See them pass**, then the whole `pixi run frontend-test` — `realtime.test.ts` and the component tests that build feed events call `handleFeedEvent(e)` with one argument and must not notice.
- [ ] **Step 5: `pixi run frontend-check`**, docs (the README section gains "Raw text": which three texts the shell keeps and why `JSON.parse` would lose `1.0` and integers past 2^53; `CLAUDE.md`'s sentence "The frontend's zod schemas strip the new fields; nothing reads them yet" becomes: `prev_rev` is kept, and the shell hands the response's text to the replica), lint.
- [ ] **Step 6: Commit:** `Keep the texts a replica needs`.

---

### Task 7: Sync — opening a replica

**Files:** Create `frontend/src/lib/engine/sync.ts`, `__tests__/support/project-server.ts`, `__tests__/sync-open.test.ts`. Modify `__tests__/client.test.ts` (its inline snapshot builder moves to the support module), `frontend/README.md`.

**Interfaces:**
- `sync.ts` — this task builds `open`, `stop`, `status`, `settled`, the buffer, and M7; Task 8 completes the rest:
  - `type ReplicaPhase`, `type ReplicaStatus` (M11); `const OFF: ReplicaStatus`.
  - `type SyncApi = {descriptor(projectId: string): Promise<SnapshotDescriptor | null>; snapshot(url: string, signal: AbortSignal): Promise<Response>; tail(projectId: string, fromRev: number): Promise<TailBody>; metamodel(projectId: string): Promise<{doc: unknown; metamodelId: string}>}`
  - `type SyncDeps = {connect(): Promise<EngineLink>; api: SyncApi; cache: SnapshotCache; sleep(ms: number): Promise<void>; onStatus(status: ReplicaStatus): void}`
  - `type CommitAnswer = {text: string; rev: number; applied: boolean; rebound: boolean; idMap: {[tempId: string]: string}; batchIds?: number[]}`
  - `type CommitFlight = {settle(answer: CommitAnswer): void; abandon(): void}`
  - `type ReplicaSync = {open(projectId: string): void; stop(): void; status(): ReplicaStatus; settled(): Promise<void>; feedCommit(raw: string, rev: number): void; feedRebind(rev: number): void; feedSnapshot(modelRev: number): void; beginCommit(): CommitFlight; metamodelAdopted(): void}`
  - `createReplicaSync(deps: SyncDeps): ReplicaSync`. `open` for the project already open is a no-op; for another project it is `stop()` first. `stop()` bumps the generation, aborts the download, disposes the link, empties the queue, status `off`. `settled()` resolves when no attempt runs, the pump is idle and no sleep is pending — tests await it instead of polling.
- `support/project-server.ts` (M12): `fakeProject(options?)` → `{projectId, rev, metamodelId, doc, model, commit, silentCommit, rebind, opaqueBump, snapshot, handlers, requests, fail, corruptNextSnapshot, wrongDigestInNextSnapshot}`; `syncOver(project, overrides?)` → `{sync, link, statuses, cache}` — a `createReplicaSync` whose `connect` is `connectInProcess()`, whose `api` is the four real `lib/api/replica.ts` functions under `baseUrl = BASE + '/projects/' + id`, whose cache is a real one on a fresh `fake-indexeddb` factory, whose `sleep` records the delay and resolves at once, and whose `onStatus` appends to `statuses`.

- [ ] **Step 1: Write the support module and the failing tests** (`sync-open.test.ts`; MSW `server.use(...project.handlers())`; `afterEach`: `sync.stop()`):
  - `a project opens from the network` — `open(id)`, `await settled()`: the last status is `{phase: 'ready', rev: project.rev, source: 'network', attempt: 0, progress: null | verify, reason: null}`; the statuses passed through `opening` with a `download` progress whose `done` never decreases and ends at `total` (the `Content-Length`), then `parse`, `index`; the engine answers `getModelSummary` with smart-city's counts and `model_rev: project.rev`; `requests` is one each of descriptor, metamodel, snapshot, tail.
  - `the tail brings a snapshot to head` — `snapshot()` at rev 7, then three commits, then open: `ready` at 10, and `getElement` of something the third commit created answers.
  - `the second open is a cache hit` — open, stop, open again with the SAME cache: `source: 'cache'`, the snapshot route was requested once in all; a project that has moved on to a new snapshot `rev` misses and replaces the row.
  - `bytes the engine refuses are not cached, and a bad row is dropped` — `corruptNextSnapshot()`: the attempt fails, nothing is in the cache; with a corrupted row PUT by hand under the right `rev`: the open ends `ready` from the network, `sleep` was never called (no attempt used up), and the row now holds good bytes.
  - `what is transferred is exactly the chunk` — a `snapshot` dependency whose body yields `subarray` views into one big buffer: the replica still opens (the engine would refuse or mis-read a whole-buffer transfer), and each `chunk` call's `bytes.byteLength` equals its view's length (spy on `link.client.call`).
  - `a metamodel that does not match restarts for free` — the metamodel route answers another id once: `ready`, the descriptor was requested twice, `sleep` never called; answering another id for ever: three free restarts, then counted failures.
  - `a header that is not the descriptor's fails the attempt` — a descriptor naming rev 7 over a blob of rev 6.
  - `a project without a model is off` — the descriptor's 404: `{phase: 'off', reason: 'no model'}`, nothing else requested, no frame even (assert `connect` was not called — connect lazily, after the descriptor).
  - `three failed opens are the boot fallback` — `fail('snapshot', 503, 99)`: `sleep` saw `[1000, 3000]`, `attempt` went 1, 2, 3, the last status is `{phase: 'server', reason: <the last error's text>}`, and the engine was told `close` between attempts; `fail('tail', 500, 1)`: the second attempt is `ready`.
  - `a frame that does not connect is the boot fallback at once` — `connect` rejects `FrameError('timeout')`: `server`, reason the error's message, no retry.
  - `an incomplete tail right after the descriptor is a failed attempt, not a loop` — the first tail answers `complete: false`, the second open's is whole: `ready` on attempt 2.
  - `feed frames that arrive while opening wait` — `feedCommit` twice during the download (MSW handler gated on a promise the test resolves): after `ready` both were applied in order and `rev` is theirs; a third that the tail had already covered dropped without an `applyDelta` call.
  - `more than 1,000 waiting frames become a catch-up` — feed 1,001 during the download: after `ready` the tail route was asked once more and the queue is empty.
  - `stop in the middle leaves nothing` — stop during the download: the fetch's signal is aborted, the link disposed, the status `off`, and resolving the gated response afterwards changes nothing (the generation token) — then `open` of ANOTHER project works and no request of the first ever carries the second's base URL.
  - `the frame's isolation and violations show in the status` — a link with `isolated: false` and an `onViolation` that fires twice: `isolated: false`, `cspViolations: 2`.
- [ ] **Step 2: See them fail** — at import of `sync.ts`.
- [ ] **Step 3: Implement** M7, M11 and the waiting half of M8. Build the link lazily: after a descriptor said there is a model.
- [ ] **Step 4: See them pass**; the whole frontend suite.
- [ ] **Step 5: Docs** — the README section gains "Opening": M7 in prose, the status vocabulary (M11) and what plan 5 will hang on `server`; lint.
- [ ] **Step 6: Commit:** `Open a replica from the snapshot and the tail`.

---

### Task 8: Sync — following, healing, the commit in flight, the rebind

**Files:** Modify `frontend/src/lib/engine/sync.ts`, `__tests__/support/project-server.ts` (if a helper is missing), `frontend/README.md`, `architecture/contracts.md`, `architecture/decisions.md`. Create `__tests__/sync-follow.test.ts`.

**Interfaces:** the rest of `ReplicaSync` (Task 7's block): `feedCommit`, `feedRebind`, `feedSnapshot`, `beginCommit`, `metamodelAdopted` — M8, M9, M10.

- [ ] **Step 1: Write the failing tests** (`sync-follow.test.ts`; every test starts from a `ready` replica; "the replica holds X" means a read through `link.client`):
  - `a delta moves the replica` — `commit` on the fake server, `feedCommit(eventText, rev)`: status `rev` follows, the replica holds the change. **The text is handed over untouched:** the commit sets one property to `1.0` and another to `9007199254740993`, and `link.client.call` (spied) was given `applyDelta` with the event text byte for byte. What the engine makes of such a text is plan 3's test (`delta-text.test.ts`); neither a wire read (`toWire`) nor the digest, which folds `(id, rev)` only, could show it here.
  - `an old delta and a repeated one are dropped without a call`.
  - `a gap is healed by the tail` — one `silentCommit`, then a broadcast commit: `feedCommit` of the second → the tail route is asked `from_rev=<replica rev>` → `ready` at head, holding both.
  - `an incomplete tail re-bootstraps` — `opaqueBump()` on the server, then a commit whose event is fed: the gap's tail is incomplete → `resyncing` → `ready` at head from the fresh snapshot; the engine was told `close` before the second `open`.
  - **`divergence, and the way back`** (spec §9) — stage a rename and a create through `link.client.call('stage', …)`; feed a delta whose `state_digest` is wrong: `resyncing`, then `ready` at the server's `rev`; `staged` answers the same two batches under their old ids, and the replica holds the server's state plus the staged edits; a `getElement` posted during the re-bootstrap is answered after it.
  - `a parked batch crosses too` (D16) — a staged update of an element a peer delta deletes is parked; after a forced re-bootstrap `conflicts` still names it.
  - `the background check can end the replica` — `wrongDigestInNextSnapshot()` before the open: `ready`, then `verify` ends false → `resyncing` → (the next snapshot is good) `ready`.
  - `a reconnect that is ahead catches up` — two silent commits, `feedSnapshot(head)`: the tail is asked, `ready` at head; `feedSnapshot(rev)` of the replica's own `rev` asks nothing.
  - `the commit in flight: the echo first` — `beginCommit()`; the server commits; `feedCommit(echo)` — nothing is applied yet (`applyDelta` not called); `settle({text: responseText, rev, applied: true, rebound: false, idMap})`: `applyDelta` is called ONCE, with the RESPONSE text and `own: {batch_ids: [], id_map}`; the echo, no longer past the replica, is dropped without a call.
  - `the commit in flight: a peer's commit lands first` — peer commit at N, own at N+1, frames arrive N+1 (echo), then N … whatever the arrival order, after `settle` the calls are N, then N+1 as the response with `own`, and nothing for the echo. `a response the tail already covered still goes to the engine` — settle while `opening`, with a tail that reaches past it: one `applyDelta` with `own`, answered `duplicate`. `a response that applied nothing queues nothing`. `abandon lets the pump go`. `settling twice is a no-op`.
  - `an own rebind freezes` — `settle({…, rebound: true})`: phase `frozen`, reason names the `rev`, nothing applied.
  - `a peer's rebind freezes, and adoption thaws` — `feedRebind(rev)`: `frozen`; later `feedCommit`s are dropped (no call); `metamodelAdopted()`: `resyncing` → `ready` at head, and `open` was called with the NEW metamodel document (the fake's `rebind('mm-2')` swaps document and id); `metamodelAdopted()` while `ready` does nothing.
  - `three failed re-bootstraps are failed, not server` — after a `ready`, make every snapshot fetch fail and force a re-bootstrap: `sleep` saw `[1000, 3000]`, the last status is `{phase: 'failed', …}`; inputs are dropped from then on.
  - `a re-bootstrap asked for during one runs once more, after it`.
- [ ] **Step 2: See them fail** — every case (the five methods are stubs from Task 7 or absent).
- [ ] **Step 3: Implement** M8, M9, M10.
- [ ] **Step 4: See them pass**; the whole frontend suite; `pixi run frontend-check`.
- [ ] **Step 5: Docs.**
  - `architecture/decisions.md`: `## AD-27 · The replica changes metamodel when the UI does` — **Decision:** a rebind, a peer's or the user's own, freezes the replica; it re-bootstraps onto the new metamodel when the UI adopts it (the banner's Reload, the committer's in-place refetch). **Why:** the engine checks staged edits against ITS metamodel and the forms are drawn from the UI's; while the two differ a refusal contradicts the form, and staged edits would be replayed — and parked — under a schema the user has not seen. Nothing is lost by waiting: no delta can cross a rebind anyway (CT-2). **Rejected:** re-bootstrapping on the event.
  - `architecture/contracts.md`, CT-2, a new bullet **Commit in flight**: from a `POST /commits` (or `/commits/revert`) to its response the shell holds the feed's deltas; then everything is applied in `rev` order, the response in its place with the user's own commit named, the echo dropping as a duplicate; a response that says `rebound` is no delta.
  - The README section gains "Following": the pump, catch-up, the three roads to a re-bootstrap, the flight, the freeze.
- [ ] **Step 6: Lint and commit:** `Follow the server and heal the replica`.

---

### Task 9: The wiring and the indicator

**Files:**
- Create: `frontend/src/lib/state/replica.svelte.ts`, `frontend/src/lib/state/__tests__/replica.test.ts`, `frontend/src/lib/components/__tests__/StatusBar.replica.test.ts`
- Modify: `realtime.svelte.ts`, `checkout.svelte.ts`, `state/index.ts`, `components/HistoryDrawer.svelte`, `components/StatusBar.svelte`, `routes/p/[projectId]/+page.svelte`; `state/__tests__/realtime.test.ts`, the test file that covers `commitStaged`; `frontend/README.md`, `CLAUDE.md`

**Interfaces:**
- `replica.svelte.ts`: `getReplicaStatus(): ReplicaStatus` (reactive); `startReplica(): void` — `sync.open(getActiveProjectId())`, nothing without a project; `stopReplica(): void`; `handReplicaFeed(event: FeedEvent, raw: string | undefined): void` — a `commit` WITH `raw` → `feedCommit(raw, event.rev)`, a `commit` without `raw` → nothing (a re-serialized text is never handed over, AD-26), `rebind` → `feedRebind`, `snapshot` → `feedSnapshot(event.model_rev)`; `beginReplicaCommit(): CommitFlight`; `replicaMetamodelAdopted(): void`; `configureReplica(options: {deps?: Partial<SyncDeps>; sync?: ReplicaSync} | null): void` — tests swap single dependencies, or the whole sync for a spy — and `resetReplica(): void`. The one `ReplicaSync` of the tab is built on first use from `connectFrame`, the four `lib/api/replica.ts` functions under `/api/v1/projects/<id>`, `createSnapshotCache()`, a `setTimeout` sleep, and an `onStatus` that writes the `$state`.
- `realtime.svelte.ts`: `handleFeedEvent(e: FeedEvent, raw?: string)`; its first line is `handReplicaFeed(e, raw)`; `connectFeed`'s `onEvent` is `handleFeedEvent` as today (the transport now passes two arguments).
- `checkout.svelte.ts::commitStaged`: `const flight = beginReplicaCommit()` right before `commitChanges`, which gets `(text) => { responseText = text; }` as `onText`; on success `flight.settle({text: responseText, rev: res.model_rev, applied: res.prev_rev != null, rebound: res.rebound === true, idMap: res.id_map})` BEFORE `applyDelta(res)`; on a throw `flight.abandon()` and rethrow. `adoptReboundMetamodel()` calls `replicaMetamodelAdopted()` after `setMetamodel(mm)`.
- `HistoryDrawer.svelte::doRevert`: the same bracket around `revertToCommit`.
- `+page.svelte`: `onMount(() => startReplica())` registered BEFORE the `startRealtime` one; `onDestroy(() => stopReplica())`; `onReloadRebind()` calls `replicaMetamodelAdopted()` after `setMetamodel(mm)`.
- `StatusBar.svelte`: after the live badge, when the phase is not `off`: a separator and `<span data-testid="replica-indicator" data-phase data-rev data-source data-isolated data-csp-violations title=…>` reading `replica 42 %` (opening or resyncing with a progress whose `total` is known; `replica …` without), `replica r128` (`ready`), `replica frozen`, `replica failed`, `server mode` — `text-muted-foreground/50` for `ready`, `text-warning` for `frozen`, `failed` and `server`; the `title` carries the reason, the attempt, `not cross-origin isolated` when `isolated === false`, and the violation count when it is not zero.

- [ ] **Step 1: Write the failing tests.**
  - `state/__tests__/replica.test.ts` (`configureReplica` with `connectInProcess`, a fake project behind MSW, a fresh cache, an instant sleep): `startReplica` without a project does nothing; with one the status goes `opening` → `ready` and `getReplicaStatus()` is reactive (read inside `$effect.root`, or compare successive reads after `flushSync`, as the file's neighbours do); `stopReplica` → `off`; `handReplicaFeed` routes the three events, and a commit without `raw` reaches nothing (with a spy sync through `configureReplica({sync})`: `feedCommit` not called).
  - `realtime.test.ts`: `handleFeedEvent(e, raw)` hands over before its own work; the existing one-argument calls behave as before.
  - The `commitStaged` test file: `the replica's flight brackets the POST` — with a spy sync through `configureReplica({sync})`, whose `beginCommit` returns a recording flight: `beginCommit` is called before the request leaves (order log with the MSW handler), `settle` gets the response's TEXT (byte for byte what MSW sent), `rev`, `applied`, `rebound`, `idMap`, before `applyDelta`'s effects show; a 409 → `abandon`, and the error still reaches the caller; `a rebound commit tells the replica twice` — `settle` with `rebound: true`, then `metamodelAdopted` once the metamodel was refetched.
  - `StatusBar.replica.test.ts`: nothing rendered at `off`; the text, the `data-*` attributes and the class for each phase; `replica 42 %` from `{done: 42, total: 100}`, `replica …` for `total: null`.
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement.** Add the exports to `state/index.ts` beside the realtime block.
- [ ] **Step 4: See them pass**; `pixi run frontend-test`, `pixi run frontend-check`.
- [ ] **Step 5: See it live.** `pixi run dr-start` needs Docker; without it: `pixi run backend-start` with a SQLite DSN and `DATA_ROVER_DEV_SEED=true` (as `playwright.config.ts` does), `pixi run frontend-start`, `pixi run sandbox-start`; log in at `http://127.0.0.1:5173`, create a project from the smart-city example, open it: the status bar shows `replica r0` (or the project's `rev`); commit an edit: the number follows the model's `rev`; open the app at `http://localhost:5173` instead: `server mode`, and its title says why. Report what was seen; do not fix forward silently.
- [ ] **Step 6: Docs.** The README section is completed: "Wiring" (who starts and stops the replica, the feed hand-over and why a commit without its text is not handed over, the two flights, the two adoption calls, the indicator and its `data-*` attributes) and the "Where to find things" table gains the new files. `CLAUDE.md`: a new section after "Sandbox", **"Shell (`frontend/src/lib/engine/`)"** — one paragraph per file in the density of its neighbours: the frame (M2, D13, D14), the client (M4), the cache (M6), sync (M7–M11, D2 and its AD, D12's numbers), the raw-text seams, the types-only rule, how the tests get an engine and a server (D8, facts 7 and 9), and that in B's fourth plan nothing reads the replica: the indicator is its only face. The "Engine package" opening sentence changes from "nothing in the frontend or the server imports it yet" to what is now true.
- [ ] **Step 7: Lint and commit:** `Open and follow a replica beside the workspace`.

---

### Task 10: e2e, closing docs, bringing the branch home

**Files:** Create `frontend/e2e/replica.spec.ts`, `frontend/e2e/helpers/replica.ts`, `frontend/e2e/helpers/api-client.ts`. Modify `frontend/e2e/isolation.spec.ts`, `architecture/program.md`, `architecture/contracts.md`, `BACKLOG-ENGINE.md`, `CLAUDE.md`.

**Interfaces:**
- `helpers/replica.ts`: `replica(page)` → the indicator's locator; `expectReplicaReady(page, timeout = 60_000)` — `data-phase="ready"`; `replicaRev(page): Promise<number>`.
- `helpers/api-client.ts`: `peer(playwright)` → an `APIRequestContext` on `http://127.0.0.1:8000/api/v1` logged in as the bootstrap admin with the CSRF header (as `seed.setup.ts` does); `projectIdByName(api, name)`; `peerCommit(api, projectId, {elementId, patch})` — `GET /open` for `model_rev`, `POST /locks` (EXCLUSIVE on the element), `POST /commits` with one `update_element`, the lock token and a message; `silentBump(api, projectId, {elementId, patch})` — `POST /model/ops` with `base_rev`.

- [ ] **Step 1: Write the specs.** `replica.spec.ts`, on the seeded "Smart City" project:
  - `the replica opens in the real sandbox` — open the project: `expectReplicaReady`; `data-isolated="true"`; `data-csp-violations="0"`; `replicaRev` equals the `rev` the status bar's model side shows (or `GET /open`'s through `peer`); the page logged no console error (a `page.on('console')` collector on `error` — the first e2e to watch the console; keep it local to this spec).
  - `an own commit reaches it` — rename an element through the UI and commit (the `commit.ts` helper): `replicaRev` becomes the new `model_rev`.
  - `a peer's commit reaches it` — `peerCommit`: `replicaRev` follows within 10 s, with no reload.
  - `a silent bump is healed by the next delta` — `silentBump`, then `peerCommit`: `replicaRev` equals head (the gap went through the tail), and the phase never left `ready`… or passed through `resyncing` — assert the END state only, and report which road it took.
  - `the second open is a cache hit` — reload the page: `data-source="cache"` — unless a snapshot was written in between (the periodic job): then `network` is right, so first read `GET /replica/snapshot`'s `rev` through `peer` before and after, and assert `cache` only when it did not move.
  - `isolation.spec.ts` gains: the workspace holds exactly one `iframe[title="Data Rover engine"]` whose `src` is the sandbox origin; leaving to `/projects` removes it.
- [ ] **Step 2: Run them.** `pixi run frontend-test-e2e`. They are written after the code, so red means a finding. The likeliest: the iframe's `sandbox` attribute (D14) — if the worker does not start under it, drop the attribute, say so, and record it in `CLAUDE.md`; a snapshot write on the first descriptor of a fresh project (it holds `write_mutex`; the spec's 60 s timeout covers it).
- [ ] **Step 3: Numbers, by hand, reported and not acted on.** With `benchmarks/large.model.json` imported as a project (the New Project wizard, or the importer CLI) and Chromium's devtools open: from navigation to `replica r…` cold, and again from the cache; the worker's heap after `ready`. This is NOT plan 5's benchmark — one run, one machine, no medians; it tells the owner whether plan 5 starts from a surprise. Skip it, and say so, if the import cannot be done without Docker.
- [ ] **Step 4: Docs.**
  - `architecture/program.md`: B's status row — plans 1–4 built; plan 4: the sandbox site and the shell — the replica opens from the cache or the network and follows by delta, tail and re-bootstrap, with a status-bar indicator as its only face. The "Built as six plans" sentence: (4) sandbox and shell, the replica opening and following in the background, seen through an indicator; (5) the transport swap …, **with the wait for `ready`, the open-journey slices, the boot-fallback notice and the re-bootstrap banner** (D1).
  - `architecture/contracts.md`, CT-4: a bullet **Port hand-over** — the four handshake messages, the origin-and-source check on each side, one `connect` per page life, the page outside the data path afterwards.
  - `BACKLOG-ENGINE.md`: `R-3` — four of B's six plans built. A new item **`K-37` · A `model_rev` bump with no journal row is silent to a replica** · `open`: `POST /model/upload`, `POST /metamodel`, `DELETE /metamodel` and the legacy element routes broadcast nothing (fact 18); a replica hears of them at the next delta — a gap, an incomplete tail, a re-bootstrap — or at a reconnect. Harmless while nothing reads the replica; from plan 5 on a read between the bump and the next delta answers from before it. Decide there: broadcast a header-only event from `touch_model` and `set_model`, or have the shell re-bootstrap after its own such calls.
  - `CLAUDE.md`: the e2e list under "Toolchain & commands" says the suite boots the sandbox too; anything Step 2 found.
- [ ] **Step 5: Every suite, every linter.**

```bash
pixi run dr-test
pixi run dr-tidy true
pixi run frontend-test-e2e
pixi run golden-fixtures
git status --short
```

Expected: core pytest unchanged at 2,551 passed / 34 deselected — this plan touches no Python; engine vitest unchanged at 461; frontend vitest 2,493 + this plan's tests and none lost; sandbox vitest green; every linter clean, `sandbox-tidy` among them; e2e green; no fixture moved; `git status` shows Step 4's files alone.
- [ ] **Step 6: Commit** `Mark the sandbox and the shell built`, then, with the owner's go-ahead:

```bash
git switch engine-migration
git merge --ff-only feat/sandbox-and-shell
```

---

## Known limits

- Nothing reads the replica yet: a wrong replica shows only in the indicator, the digest and the tests. Plan 5's shadow comparison is the first thing that compares it with the server.
- A `model_rev` bump that writes no journal row reaches the replica late (`K-37`).
- A feed that is closed for good (4401, 4403, 4404) leaves the replica where it was; the existing feed banner is the user's signal, and the indicator keeps saying `ready`.
- A `POST /commits` whose response is lost is abandoned; the echo then applies as any peer delta (spec, Known limits).
- The tail body is parsed twice when it is complete (D15), and once more by nobody when it is not. A very large tail is one long step in the engine (plan 3's limit) and one `JSON.parse` on the main thread here.
- During `sandbox-start`'s rebuild the `dist/` directory is empty for a moment (`emptyOutDir`); a page load in that window fails its handshake and the tab runs in `server` mode until reloaded. Development only.
- `vite preview` is the sandbox's server in development and e2e only. Production hosting of the two origins, their headers included, is F's; the adapter-static build of the app carries no COOP or COEP of its own.
- The cache is per browser profile and unencrypted, like every IndexedDB store; it holds what the user could download anyway. Sign-out does not clear it.
- One frame per workspace mount: two tabs on one project hold two replicas (AD-16).
- Not checked while planning: that one tsconfig cannot hold DOM and WebWorker (Task 1 keeps them apart regardless); that the isolation plugin, placed first, also covers `static/` files; the iframe's `sandbox` attribute together with a module worker under this CSP in a Vite build (the spike ran it with hand-written files); `ReadableStream` async iteration in every evergreen browser (the reader loop avoids the question).

## After this plan

Plan 5 (transport swap) is written once this one has landed. What it and plan 6 inherit:

- **The states are there, the consequences are not** (D1): `server` is the boot fallback and `failed` the exhausted re-bootstrap. Plan 5 builds `surfaces.ts` on them — `server` flips every surface for the tab, with the dismissible notice; `failed` is the blocking banner with Reload — and adds the wait for `ready` to `boot()` with the `download`, `parse`, `index` and `tail` slices, which `ReplicaStatus.progress` already feeds.
- **Reads go through `getReplicaStatus()`'s sync**: `link.client.call(method, params, {signal})` is the engine side of `route(surface, engineCall, serverCall)`; results are HTTP bodies and pass the same zod schemas; errors are already the `ApiError` subclasses. The link is private to `sync.ts` today — plan 5 exposes a `call` on the replica store that waits for nothing itself (the engine queues until `ready`) and rejects with `EngineGoneError` in `server` mode.
- **`setViewPlacement`** is nobody's yet. Placements survive `close`, so a re-bootstrap keeps them (CT-4); they do not survive a new frame, so plan 5 registers each loaded view's committed placements after every `startReplica()`.
- **`K-37`** must be settled before a surface defaults to the engine.
- **Plan 6** passes real `batchIds` to `flight.settle` and nothing else changes in the flight; a `failed` sync still holds the staged batches it read before `close` — the banner's way out must not lose them; a frozen replica with staged edits is where `AD-27` earns its keep; `metamodelAdopted()` is already called from both adoption paths.
- **The browser benchmark** (plan 5) starts from a working sandbox: `sandbox-build` + `vite preview` is its server, `connectFrame` its way in, and the snapshot of M is served by any static server that sends `Content-Length` and no `Content-Encoding`.
- Open: `K-32`, `K-29`, `K-35`, `K-36`, `K-37`, `C-20`, `C-21` in `BACKLOG-ENGINE.md`; `K-33`, `K-34` in `BACKLOG.md`.
