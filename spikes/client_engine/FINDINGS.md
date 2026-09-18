# Client-engine spike — findings

Setup: headless Chromium 148 (Playwright) on WSL2 (Ryzen 9 3900X), Pyodide 314.0.7
(CPython 3.14.2), `benchmarks/large.model.json` = **170,340 elements / 126,820
relationships**, 77 MB compact JSON, 5.83 MB as a gzip-3 snapshot. Everything runs in
a module worker inside a **cross-origin iframe** (`127.0.0.1:8802` embedded by
`localhost:8801`) under
`default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'`.
Raw data: `results/`.

Three candidate client engines:

1. **Python** — the real `data_rover.core`, unmodified, under Pyodide; user scripts
   run in-process through the trusted session.
2. **JavaScript** — a minimal replica (`js-replica.mjs`, 200 lines): parsed entities
   plus id/type/adjacency maps and bare loops. Not an engine port.
3. **Rust → wasm32** — a minimal replica (`rust_replica/`, 288 KB wasm, 97 KB gzipped):
   interned names, typed property values, CSR adjacency. Not an engine port either.

For 2 and 3, *Python user scripts* still run in Pyodide with the unmodified facade;
the bridge ops are answered by the JS/Rust store through one synchronous JSON call.
All three stores return identical script results for the 10,000 cells.

## Three-way comparison (session 2: median of 3 runs, all engines in the same pass)

| | Python (Pyodide) | JavaScript | Rust/WASM |
|---|---|---|---|
| Runtime to boot before the first open | 5.5 s | none | ~0 (288 KB module) |
| Open: parse + build + index, from inflated bytes | 6.5 s | 1.09 s | **0.90 s** |
| Cold open, wall clock (boot ∥ fetch + inflate, then open) | 12.1 s | ≈ 1.5 s | ≈ 1.4 s |
| Memory | 454 MB wasm high-water | **85 MB** JS heap after GC (peak not measured) | 100 MB live, 201 MB wasm high-water |
| 112k-row table: build + sort | 2.5 s | 0.09 s | **0.08 s** |
| 112k-row table: every cell (336,600 cells) | 11.4 s | 0.23 s | **0.09 s** |
| Name search scan over 170k elements | 105 ms | 51 ms | **32 ms** |
| 10,000 script cells, **Python user scripts** | **1.7 s** (in-process store) | 2.7 s (JSON bridge to the JS store) | 2.7 s (JSON bridge to the Rust store) |
| The same ten computations as engine-native code | — | 11 ms | **2.9 ms** |
| Full six-validator sweep | 11.0 s | not ported | not ported |
| Pyodide still needed for user scripts | is the engine | yes: +5.4 s boot before the first script, +~90 MB | yes: same |

Replica numbers are bare loops; a real engine (generic evaluator, row keys, memo,
read-sets, validation) would be several times slower than columns 2 and 3.

## Thresholds for the Python engine

| Threshold | Limit | Session 1, plain | Session 1, tuned | Session 2, tuned (median of 3) |
|---|---|---|---|---|
| Open the project, cold | ≤ 8 s | 8.4–8.9 s ✗ | 6.9 s ✓ | **12.1 s ✗** |
| 10,000 script cells | ≤ 2 s | 1.2 s ✓ | 1.0 s ✓ | 1.6 s ✓ |
| 112k-row table, every cell | ≤ 10 s | 7.4–7.6 s ✓ | 7.8 s ✓ | **11.4 s ✗** |
| Engine wasm heap, peak | ≤ 600 MB | 453 MB ✓ | 454 MB ✓ | 454 MB ✓ |

Same PC, same code, a few minutes apart. Between the sessions the machine got slower
for reasons outside the benchmark (load average stayed ≈ 1): the native CPython
baseline slowed 1.2–1.3× (open 3.8 → 4.9 s, table 3.8 → 4.5 s, validation 3.3 → 4.0 s)
and everything in the browser about 1.5–1.9× (Python open 3.4 → 6.5 s, table
7.8 → 11.4 s; JS open 0.73 → 1.34 s incl. inflate). **The Python engine clears the thresholds only
in the fast state; it has no headroom.** The JS and Rust replicas clear them by an
order of magnitude in both.

"Tuned" = `gc.disable()` while the ~3M objects are allocated then `gc.freeze()`, and
the shell inflating the snapshot while the interpreter boots. orjson is a dead end:
its intermediate document pushes the wasm heap to 1279 MB, and wasm memory never shrinks.

Python engine, where the tuned cold open goes (session 1 / session 2): interpreter
boot 3.4 / 5.5 s (prewarmable on the login page), `json.loads` 1.3 / 1.8 s, building
entities 0.5 / 1.1 s, `indexes.rebuild()` 1.4 / 3.4 s.

## Sandbox: what is proven

- Pyodide, the JS store and the Rust module all boot under the strict CSP with **zero
  violations**; no `'unsafe-eval'`. The sandbox origin can fetch only its own static files.
- The iframe and its worker are `crossOriginIsolated`, so `SharedArrayBuffer` works
  inside the sandbox.
- A runaway `while True: pass` script column is stopped by `setInterruptBuffer` 1.5 s
  after the sandbox page flips the shared byte, and **the loaded model survives**.

## Reading

1. **Engine work**: against Python-in-the-browser, JS and Rust are both ≈ 6× faster to
   open, 25–125× faster on table work, 2–3× on the search scan, and 4.5–5× lighter.
   Rust beats JS by 1.2× on open, 2.5× on full-table cells, 1.6× on
   search, 3.8× on native computations — small next to either one's gap to Python, and
   invisible at this model size (0.09 s vs 0.23 s).
2. **Python user scripts are fastest with the Python engine.** Over a JS or Rust store
   every bridge op pays `json.dumps` → FFI → parse → stringify → FFI → `json.loads`:
   ≈ 270 µs per call vs ≈ 165 µs in-process. The store's language does not matter
   (2.74 s vs 2.73 s): the cost is on the Python side. A smarter bridge (batched
   reads, no JSON) would narrow this; only JS-language scripts would erase it (11 ms).
3. The Python engine's threshold pass depends on the machine's state. Extrapolated
   ×1.88 to the 320k-element stress size it is ≈ 10–20 s to open and ≈ 850 MB.
4. Memory: the JS heap figure is steady state after GC; its parse peak is unmeasured.
   The Rust replica is the naive layout (one allocation per string); an arena would
   roughly halve its 100 MB.
5. Rust costs that the numbers do not show: a third language and toolchain, a wasm
   boundary that every UI read must serialize across, and no sharing of memory with
   the Pyodide module (two separate wasm instances talk through JS either way).

Not measured: desktop Chrome on Windows, Firefox/Safari, several project tabs at once,
a script worker pool separate from the engine, incremental re-evaluation after a
staged edit, real engines (rather than replicas) in JS or Rust.
