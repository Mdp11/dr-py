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
| 112k-row table, build + sort + every cell | ≤ 3 s |
| 10,000 Python script cells | ≤ 2 s |
| Engine heap, steady state (Pyodide excluded) | ≤ 400 MB |
| Engine chunk between yields (system.md rule 4) | ≤ 16 ms |

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

Snapshot storage < $1; egress $1–32; headless runs $0–5, mostly inside the free tier.

**CN-8 · Cost drivers.** Thin-server cost is nearly flat in model size (size touches database
disk, egress and snapshot CPU only). Engine language moves no line but headless run time
(≤ $5/month). The server-heavy design needs ≈ 1.4 GB RAM per hot M project *(measured:
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
`default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'`.
No `'unsafe-eval'`.

**CN-18.** Pyodide is not a security boundary. In the browser the origin is; in the headless
host the container is.

**CN-19.** The server MUST derive inverse ops and `entity_states` itself and MUST NOT accept
them from a client. Client-reported validation results are advisory records, never inputs to a
server decision.

**CN-20 · Headless isolation.** No outbound network; no database or bucket credentials; a
service account with no roles; callable only by the `api` service; inputs arrive in the
request; concurrency 1; a fresh child process per run; the parent process never executes user
code.

**CN-21.** A script can only propose ops (CT-6). Guest-proposed artifact, view and metamodel
ops are refused, as today.

## Dead ends — do not retry without new evidence

**CN-22.**
- *Python core under Pyodide as the engine.* Passes the old thresholds only when the machine
  is fast (open 6.9 s) and fails when it is slow (open 12.1 s, table 11.4 s); ≈ 850 MB at L.
- *orjson under Pyodide.* Wasm heap 1279 MB; wasm memory never shrinks.
- *Pyodide memory snapshots.* Fail once pydantic is loaded (`Unexpected hiwire entry`).
- *Off-the-shelf sync engines.* AD-6.
