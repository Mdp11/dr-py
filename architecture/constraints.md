# Constraints

Limits the design MUST respect, with the evidence behind them. Every number is marked
*(measured)*, *(estimate)* or *(budget)*.

## Scale

**CN-1 · Model sizes.**

| Size | JSON | Elements / relationships | gzip-3 snapshot | Source |
|---|---|---|---|---|
| S | 5 MB | ≈ 10k | 0.4 MB *(measured)* | `benchmarks/sanity.model.json` |
| M — the normal case | 77 MB | 170,340 / 126,820 | 5.83 MB *(measured)* | `benchmarks/large.model.json` |
| L — the stress case | ≈ 150 MB | ≈ 320k | ≈ 11 MB *(estimate)* | extrapolated |

**CN-2.** The product MUST feel fast at M and stay usable at L. `benchmarks/` is git-ignored
and generated locally.

## Performance

**CN-3 · Budgets at M** *(budget — spike replica numbers with 3–10× allowed for a real engine)*.

| Operation | Budget |
|---|---|
| Open, from inflated bytes to indexed replica | ≤ 3 s |
| Cold open — no cached snapshot; fetch + inflate + open on the CN-4 setup | ≤ 3 s · ≤ 6 s at L |
| Table over M's 112k-row scope, capped at 50,000 rows: build + sort + every cell | ≤ 3 s |
| 10,000 Python script cells | ≤ 3 s, prewarmed (image and spares ready); first use after open reported, not gated |
| Engine heap, steady state (Pyodide excluded) | ≤ 400 MB |
| Engine chunk between yields — evaluation and background work (system.md rule 4) | ≤ 16 ms |
| One transition — stage, unstage, rebase, delta apply — of up to 1,000 ops, order repair included (AD-23) | ≤ 100 ms |

**CN-4 · Measured baseline** — headless Chromium 148, Ryzen 9 3900X under WSL2, Pyodide
314.0.7 (CPython 3.14.2), model M, median of 3, all engines in one pass. JS and Rust are
minimal replicas (bare loops), not engines. Raw data: `spikes/client_engine/`.

| | Python core in Pyodide | JS replica | Rust/wasm replica |
|---|---|---|---|
| Runtime boot before first open | 5.5 s | none | ≈ 0 |
| Open, from inflated bytes | 6.5 s | 1.09 s | 0.90 s |
| Cold open, wall clock | 12.1 s | ≈ 1.5 s | ≈ 1.4 s |
| Memory | 454 MB wasm high-water | 85 MB heap after GC (peak unmeasured) | 100 MB live · 201 MB high-water |
| 112k-row table, build + sort | 2.5 s | 0.09 s | 0.08 s |
| 112k-row table, all 336,600 cells | 11.4 s | 0.23 s | 0.09 s |
| Name scan over 170k elements | 105 ms | 51 ms | 32 ms |
| 10,000 Python script cells | 1.7 s (in-process) | 2.7 s (JSON bridge) | 2.7 s (JSON bridge) |
| Same computations, engine-native | — | 11 ms | 2.9 ms |
| Full six-validator sweep | 11.0 s | not ported | not ported |

The replica rows parse with native `JSON.parse`, which cannot tell `1` from `1.0`; exact
parsing costs more (AD-11 carries the measurement).

Script cells across workers, measured 2026-09-30 (`pixi run engine-bench-browser`, Chromium
148.0.7778.96 headless shell, Ryzen 9 3900X under WSL2, load 1.4, model M, median of 3 passes):
10,000 cells (ten scripts over 1,000 `Microservice` ids each, `entry: 'value'`, one warm script
worker, through the real frame and client) take **3,276 ms** [4,481 3,276 3,139], over the 2 s
CN-3 then set, in 10,850 bridge trips at 289 µs per trip [397 289 277]. The 2,110 ms boot is paid by the
warm-up call before the timer; the time per trip is `guest.run`'s, so the remainder lies inside
the script worker's run. The same ten scripts in Node's in-process host (`engine/bench/
script-split.ts`, medians of 3): 1,648 ms, of which the dispatcher 375 ms and the Python side
with canned replies 1,150 ms (Python's `json` alone 404 ms); the parts come from separate runs
and leave 123 ms. A timed scratch build in Chromium (one run, 4,080 ms wall, slower than the
row above, so its parts do not add to 3,276) gave, over the 10,850 trips: dispatch 402 ms,
Python `json` 849 ms, post to the engine's handler 885 ms, the rest of the transport 222 ms;
K-100 has the split, what stays unattributed and the Node proxies.

On the pool (one batch per worker, the ten batches concurrent, `pixi run engine-bench-browser`,
same machine and model, load 1.1, 2026-10-01, median of 3 passes): the same 10,000 cells take
**4,888 ms** wall [4,710 4,888 5,016], over the same 2 s (an earlier run of the same build: 4,654 ms
[4,786 4,654 4,597]), against 3,276 ms on the single warm worker above. Measured in that run:
the ten batches' own times (`ms`, from the start of a batch's run on its worker, boot excluded) sum to
5,341 ms [4,759 5,341 5,386], each between 116 and 1,450 ms (median 571); the pool's bridge handling
(dispatch, encode, reply write) was busy 750 ms [700 771 750] in total; 10,850 trips, 492 µs per trip
[439 492 496] (batch time over trips); 4 workers (`hardwareConcurrency` less 2, at most 4); the
first worker boots cold in 2,065 ms [2,008 2,107 2,065], the later ones from the image in 318 ms
[299 332 318]. Nothing was tuned. The run sum is about the wall, so the four workers bought little
overlap, and the per-trip time rose from 289 µs. Why is not measured. Hypotheses: the four
interpreters and the engine worker compete for the machine's cores (WSL2), and the engine worker's
single thread serializes the bridge handling and message delivery in a way the busy figure does
not show. Unaccounted: what bounds the wall (the three boot waves, 4 + 4 + 2 batches, account for
roughly 1 s at 0.3 s each), why a trip costs more with four workers, and the queue and post time
between a worker's request and the pool's handler. The per-trip figure also includes the pool's per-call
messages (`call-start` and `call-end`, about 20,000 for these 10,000 cells besides the 10,850 trips,
each result's text cloned in `call-end` and again in `done`), which plan 1's 289 µs did not; their
cost is not measured (K-100). The pool's interrupt retry
exists because Pyodide's `_Py_CheckEmscriptenSignals_Helper` (`pyodide.asm.mjs`) reads then clears
the interrupt flag non-atomically, so a store between the two is lost: re-check it whenever the
Pyodide pin moves.

Prewarmed (`pixi run engine-bench-browser`, same machine and model, load 1.2, 2026-10-01, median of
3 passes): once the first use after the open (a call that boots cold, 2,102 ms [2,044 2,102 2,125],
reported and not gated) and `scriptWarm` have run, the pool holds the image and four ready spares,
and the same 10,000 cells take **2,284 ms** wall [2,284 2,283 2,360], within CN-3's 3 s, in 10,850
trips at 433 µs [427 433 443]; the ten batches' own times sum to 4,698 ms [4,630 4,698 4,805], the
pool's bridge handling was busy 733 ms [729 733 748], and the later workers boot from the image in
272 ms [272 260 275]. Before the hot spares the same run took 4.8 to 4.9 s: about 2 s of it was a
cold boot inside the timer, because the warm-up call ended before the image existed. K-100 has the
split of a trip, what did not help, and the figure with workers reused across batches.

Script workers boot from a memory image of Pyodide with the guest loaded, through Pyodide's
private snapshot API (`_makeSnapshot`, `makeMemorySnapshot`, `_loadSnapshot`), which is pinned with
the Pyodide version: moving the pin needs `engine/test/script/snapshot.test.ts` green. Measured in
Node 22 on this machine, 2026-10-01: a cold worker boots in ≈ 1.9 s, one from the image in
≈ 0.15-0.26 s; the image is 30 MB and is made once per pool in ≈ 2.5 s by a worker that runs no
script.

The script-cell cost is Python-side JSON plus FFI (≈ 270 µs per bridge call vs ≈ 165 µs
in-process); the store's language is irrelevant. Pyodide for user scripts adds ≈ 5.4 s boot
and ≈ 90 MB whichever engine is used.

**CN-5 · Benchmark hygiene.** Absolute timings on the reference PC drift 1.5–1.9× between
sessions at load ≈ 1. Compare only numbers taken in the same pass; report medians.

## Cost

**CN-6 · Target** *(budget)*: ≈ $130/month on GCP for 20–30 concurrent users, scaling with
budget.

**CN-7 · Thin-server cost per month** *(estimate; on-demand list prices, Tier-1 region, no
committed-use discount, single-zone database, ±15 %; one hot project per 5 concurrent users;
2 snapshot downloads per user per workday; 10 headless runs per user per month)*.

| Concurrent users | S | M | L | Step |
|---|---|---|---|---|
| 20 | $85 | $90 | $90 | Cloud Run 1 vCPU / 1 GiB always-on ($53) + Cloud SQL db-g1-small ($26) |
| 50 | $85 | $110 | $115 | Database → 1 vCPU / 3.75 GB ($49) for M and L |
| 100 | $95 | $125 | $180 | Cloud Run 2 GiB; database → 2 vCPU / 7.5 GB ($99) for L |
| 500 | $260 | $300 | $440 | 2 Cloud Run instances ($116) + Redis ($36) + database $99 / $197; HA database +$100…$230 |

Snapshot storage < $1; egress $1–32; headless runs $0 to us, since they run on the caller (AD-35).

**CN-8 · Cost drivers.** Thin-server cost is nearly flat in model size (size touches database
disk, egress and snapshot CPU only). Engine language moves no line. The server-heavy design needs ≈ 1.4 GB RAM per hot M project *(measured:
0.5 GB model and indexes + 0.9 GB trigram index)*: $135–310 at 20 users and M, $1,200–1,700 at
500 *(estimate)*, and past ≈ 50 users it needs per-project sharding that does not exist.

## Platform (GCP)

**CN-9.** An open WebSocket keeps a Cloud Run instance billed, and Cloud Run closes it after
60 minutes. The `api` service runs always-on; feed clients MUST reconnect and resume through
the tail (CT-2).

**CN-10.** Leases and the feed hub are in-process. The `api` service runs exactly one instance
(min = max = 1) until they move to Redis or Postgres — not needed before ≈ 500 users.

**CN-11.** Snapshots are stored as `application/gzip` and inflated by the reader with
`DecompressionStream`. Never `Content-Encoding: gzip`: GCS transcoding ignores `Range` and
bills the inflated size.

**CN-12.** Signed URLs defeat the HTTP cache. The shell caches snapshot bytes itself, keyed
`(project, rev)`.

**CN-13.** No load balancer and no CDN ($18.25/month fixed; egress is a few dollars).

## Browser

**CN-14.** The app page and the sandbox page MUST be cross-origin isolated (COOP, COEP, CORP,
`allow="cross-origin-isolated"` on the iframe). Every app-origin subresource therefore needs
CORP or CORS.

**CN-15.** `SharedArrayBuffer` never crosses origins. Anything that blocks on shared memory
MUST share an origin with what wakes it.

**CN-16.** No dependency on JSPI or any Chromium-only API (AD-19). Required and baseline:
module workers, `SharedArrayBuffer` under isolation, `Atomics.wait` in workers,
`DecompressionStream`, transferable `ArrayBuffer` and `MessagePort`, IndexedDB.

## Security

**CN-17 · The sandbox has no network and no credentials.** It is served from its own
registrable domain (SameSite cookies are scoped by site, not origin), static files only, with
`default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self';
frame-ancestors <app origin>`. Only the app's own origin may embed it. No `'unsafe-eval'`.

**CN-18.** Pyodide is not a security boundary. In the browser the origin is; in the export CLI
the child process and Node's permission model are, protecting the caller (AD-35).

**CN-19.** The server MUST derive inverse ops and `entity_states` itself and MUST NOT accept
them from a client. Client-reported validation results are advisory records, never inputs to a
server decision.

**CN-20 · Export CLI isolation.** Scripts run in a child process under Node's permission
model: no file writes, no child processes, read access to the engine and Pyodide only, an empty
environment; the parent process never executes user code and holds the API token. Node 22's
permission model does not block the network, so a caller that needs that runs the CLI where the
network is closed (AD-35).

**CN-21.** A script can only propose ops (CT-6). Guest-proposed artifact, view and metamodel
ops are refused, as today.

## Dead ends — do not retry without new evidence

**CN-22.**
- *Python core under Pyodide as the engine.* Passes the old thresholds only when the machine
  is fast (open 6.9 s) and fails when it is slow (open 12.1 s, table 11.4 s); ≈ 850 MB at L.
- *orjson under Pyodide.* Wasm heap 1279 MB; wasm memory never shrinks.
- *Pyodide memory snapshots.* Fail once pydantic is loaded (`Unexpected hiwire entry`).
- *Off-the-shelf sync engines.* AD-6.
