// THROWAWAY SPIKE — the trusted shell. It fetches the snapshot (standing in for
// the signed GCS URL), boots the cross-origin sandbox in parallel, hands the
// bytes over, then drives the workloads and scores them against the thresholds.
const SANDBOX = "http://127.0.0.1:8802";
const THRESHOLDS = { open_s: 8, script_cells_s: 2, big_table_s: 10, heap_mb: 600 };

const setStatus = (text) => (document.getElementById("status").textContent = text);
const results = { user_agent: navigator.userAgent, thresholds: THRESHOLDS, csp_violations: [] };
const t0 = performance.now();

const pending = new Map();
let nextId = 1;
let engineReady;
const engineReadyP = new Promise((resolve, reject) => (engineReady = { resolve, reject }));

window.addEventListener("message", (ev) => {
  if (ev.origin !== SANDBOX) return;
  const msg = ev.data;
  if (msg.type === "iframe-ready") results.iframe_cross_origin_isolated = msg.crossOriginIsolated;
  else if (msg.type === "csp-violation") results.csp_violations.push(msg);
  else if (msg.type === "engine-ready") engineReady.resolve(msg.boot);
  else if (msg.type === "engine-failed") engineReady.reject(new Error(msg.error));
  else if (pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.ok ? resolve({ ...msg.result, heap_mb: msg.heap_mb }) : reject(new Error(msg.error));
  }
});

const PARAMS = new URLSearchParams(location.search);
const MODE = PARAMS.get("mode") ?? "python"; // "python" (option 2) or "stores" (options 1 and 3)

const iframe = document.createElement("iframe");
iframe.allow = "cross-origin-isolated";
iframe.sandbox = "allow-scripts allow-same-origin";
iframe.src = `${SANDBOX}/sandbox.html${MODE === "stores" ? "?worker=store" : ""}`;
document.body.append(iframe);

function call(cmd, extra = {}, transfer = []) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    iframe.contentWindow.postMessage({ id, cmd, ...extra }, SANDBOX, transfer);
  });
}

const FAST = PARAMS.get("fast") ?? ""; // "", "gc" or "orjson"

async function fetchSnapshot() {
  const t = performance.now();
  let bytes = await (await fetch("/snapshot.json.gz")).arrayBuffer();
  results.snapshot = { fetch_ms: Math.round(performance.now() - t), gz_mb: +(bytes.byteLength / 1048576).toFixed(2) };
  if (FAST || MODE === "stores") {
    // Inflate in the shell while the engine is still booting.
    const t2 = performance.now();
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = await new Response(stream).arrayBuffer();
    results.snapshot.shell_gunzip_ms = Math.round(performance.now() - t2);
  }
  return bytes;
}

function verdicts() {
  const peakHeap = Math.max(
    ...["open", "big_table", "script_table", "validate"].map((k) => results.python[k]?.heap_mb ?? 0),
  );
  results.verdicts = {
    open: { value_s: +(results.python.open_wall_ms / 1000).toFixed(2), limit_s: THRESHOLDS.open_s },
    script_cells: {
      value_s: +(results.python.script_table.script_cells_ms / 1000).toFixed(2),
      limit_s: THRESHOLDS.script_cells_s,
    },
    big_table: {
      value_s: +(results.python.big_table.export_total_ms / 1000).toFixed(2),
      limit_s: THRESHOLDS.big_table_s,
    },
    heap: { value_mb: peakHeap, limit_mb: THRESHOLDS.heap_mb },
  };
  for (const v of Object.values(results.verdicts))
    v.pass = (v.value_s ?? v.value_mb) <= (v.limit_s ?? v.limit_mb);
  document.getElementById("verdicts").innerHTML =
    "<tr><th>threshold</th><th>measured</th><th>limit</th><th></th></tr>" +
    Object.entries(results.verdicts)
      .map(
        ([k, v]) =>
          `<tr><td>${k}</td><td>${v.value_s ?? v.value_mb}</td><td>${v.limit_s ?? v.limit_mb}</td>` +
          `<td class="${v.pass ? "pass" : "fail"}">${v.pass ? "PASS" : "FAIL"}</td></tr>`,
      )
      .join("");
}

async function runPython() {
  const py = (results.python = {});
  setStatus("booting the sandboxed engine and fetching the snapshot in parallel…");
  const [boot, bytes] = await Promise.all([engineReadyP, fetchSnapshot()]);
  py.boot = boot;
  py.boot_and_fetch_wall_ms = Math.round(performance.now() - t0);
  setStatus("opening the model…");
  py.open = await call("open", { bytes, fast: FAST, inflated: Boolean(FAST) }, [bytes]);
  py.open_wall_ms = Math.round(performance.now() - t0);
  for (const cmd of ["big_table", "script_table", "script_calls", "search", "validate"]) {
    setStatus(`running ${cmd}…`);
    py[cmd] = await call(cmd);
  }
  setStatus("interrupting a runaway script…");
  py.runaway = await call("runaway", { interruptAfterMs: 1500 });
  py.model_alive_after_interrupt = await call("model_alive");
}

async function runStores() {
  const out = (results.stores = {});
  setStatus("booting Pyodide + the Rust store and fetching the snapshot in parallel…");
  const [boot, bytes] = await Promise.all([engineReadyP, fetchSnapshot()]);
  out.boot = boot;
  setStatus("opening the JS and Rust stores…");
  out.open = await call("open", { bytes }, [bytes]);
  for (const store of ["js", "rust"]) {
    setStatus(`benchmarking the ${store} store…`);
    out[store] = { bench: await call("bench", { store }) };
    setStatus(`running Python scripts over the ${store} store…`);
    out[store].script_calls = await call("script_calls", { store });
  }
}

function runJsReplica() {
  setStatus("running the JS replica for comparison…");
  return new Promise((resolve) => {
    const worker = new Worker("/js-replica-worker.mjs", { type: "module" });
    worker.onmessage = (ev) => {
      results.js_replica = ev.data.ok ? ev.data.result : { error: ev.data.error };
      worker.terminate();
      resolve();
    };
    worker.postMessage({});
  });
}

try {
  if (MODE === "stores") {
    await runStores();
  } else {
    await runPython();
    verdicts();
    if (!PARAMS.has("python-only")) await runJsReplica();
  }
  setStatus("done");
} catch (err) {
  results.error = String(err);
  setStatus(`failed: ${err}`);
}
document.getElementById("out").textContent = JSON.stringify(results, null, 2);
window.__results = results;
window.__done = true;
