// THROWAWAY SPIKE — the engine worker: real data_rover.core under Pyodide.
// Runs on the SANDBOX origin, so everything here (engine AND user scripts) is
// outside the app origin's cookies and can only fetch its own static files.
import { loadPyodide } from "/pyodide/pyodide.mjs";

const boot = {};
let py, api, interruptBuffer, gzBytes;

const heapMb = () => Math.round(py._module.HEAPU8.length / 1048576);

async function timed(bucket, key, fn) {
  const t = performance.now();
  const value = await fn();
  bucket[key] = Math.round(performance.now() - t);
  return value;
}

async function start() {
  const t0 = performance.now();
  py = await timed(boot, "load_pyodide_ms", () => loadPyodide({ indexURL: "/pyodide/" }));
  await timed(boot, "load_packages_ms", () =>
    py.loadPackage(["pydantic", "pyyaml", "sortedcontainers", "orjson"], { messageCallback() {} }),
  );
  let metamodel;
  await timed(boot, "fetch_unpack_core_ms", async () => {
    const [tar, mm] = await Promise.all([
      fetch("/core_src.tar.gz").then((r) => r.arrayBuffer()),
      fetch("/metamodel.yaml").then((r) => r.text()),
    ]);
    py.unpackArchive(tar, "gztar", { extractDir: "/app" });
    metamodel = mm;
  });
  await timed(boot, "import_core_ms", () =>
    py.runPython(`
import sys
sys.path.insert(0, "/app")
import bench_engine

def _open(buf, mm, gzipped, fast):
    return bench_engine.open_snapshot(buf.to_bytes(), mm, gzipped, fast)
`),
  );
  api = py.globals.get("bench_engine");
  boot.metamodel = metamodel;
  boot.cross_origin_isolated = self.crossOriginIsolated;
  if (self.crossOriginIsolated) {
    interruptBuffer = new Uint8Array(new SharedArrayBuffer(1));
    py.setInterruptBuffer(interruptBuffer);
  }
  boot.boot_total_ms = Math.round(performance.now() - t0);
  boot.heap_mb = heapMb();
  const { metamodel: _omit, ...report } = boot;
  postMessage({ type: "engine-ready", boot: report, interruptBuffer });
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const commands = {
  async open({ bytes, fast = "", inflated = false }) {
    const out = {};
    gzBytes = new Uint8Array(bytes);
    // `inflated`: the shell already gunzipped while this worker was booting.
    const raw = inflated ? gzBytes : await timed(out, "js_gunzip_ms", () => gunzip(gzBytes));
    const open = py.globals.get("_open");
    const t = performance.now();
    Object.assign(out, JSON.parse(open(raw, boot.metamodel, false, fast)));
    out.python_open_total_ms = Math.round(performance.now() - t);
    return out;
  },
  validate: () => JSON.parse(api.validate_all()),
  big_table: () => JSON.parse(api.big_table()),
  script_table: () => JSON.parse(api.script_table()),
  script_calls: () => JSON.parse(api.script_calls()),
  search: () => JSON.parse(api.search_scan()),
  model_alive: () => JSON.parse(api.model_alive()),
  runaway() {
    // The sandbox page flips the shared byte to SIGINT while this call is stuck.
    const t = performance.now();
    try {
      api.runaway();
      return { interrupted: false };
    } catch (err) {
      const text = String(err);
      return {
        interrupted: text.includes("KeyboardInterrupt"),
        after_ms: Math.round(performance.now() - t),
        error: text.split("\n").slice(-2).join(" ").slice(0, 200),
      };
    } finally {
      if (interruptBuffer) interruptBuffer[0] = 0;
    }
  },
};

self.onmessage = async (ev) => {
  const { id, cmd } = ev.data;
  try {
    const result = await commands[cmd](ev.data);
    postMessage({ id, ok: true, result, heap_mb: heapMb() });
  } catch (err) {
    postMessage({ id, ok: false, error: String(err).slice(0, 2000), heap_mb: py ? heapMb() : 0 });
  }
};

start().catch((err) => postMessage({ type: "engine-failed", error: String(err).slice(0, 2000) }));
