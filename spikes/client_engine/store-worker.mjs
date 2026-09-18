// THROWAWAY SPIKE — options 1 and 3 in one worker: a JavaScript store and a
// Rust/WASM store, each benchmarked natively and then read by UNMODIFIED Python
// user scripts (Pyodide + the real facade) through one sync JSON call per bridge op.
import { loadPyodide } from "/pyodide/pyodide.mjs";
import {
  BIG_TYPES, CONTAINMENT, bigTable, makeDispatcher, nativeCells, replicaFromBytes, rowIds, searchScan,
} from "/js-replica.mjs";

const boot = {};
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ms = (t) => Math.round((performance.now() - t) * 10) / 10;
let py, host, rust, jsReplica;

async function loadRust() {
  const { instance } = await WebAssembly.instantiateStreaming(fetch("/rust_replica.wasm"), {
    env: { now: () => performance.now() },
  });
  const x = instance.exports;
  // Re-read `x.memory.buffer` after every alloc: growth detaches the old buffer.
  const put = (u8) => {
    const ptr = x.alloc(u8.length);
    new Uint8Array(x.memory.buffer, ptr, u8.length).set(u8);
    return ptr;
  };
  const out = () => decoder.decode(new Uint8Array(x.memory.buffer, x.out_ptr(), x.out_len()));
  const callText = (fn, text) => {
    const u8 = encoder.encode(text);
    const ptr = put(u8);
    fn(ptr, u8.length);
    x.dealloc(ptr, u8.length);
    return out();
  };
  return {
    open(bytes) {
      const timings = {};
      let t = performance.now();
      const ptr = put(bytes);
      timings.copy_into_wasm_ms = ms(t);
      const cont = encoder.encode(JSON.stringify(CONTAINMENT));
      const contPtr = put(cont);
      t = performance.now();
      x.open(ptr, bytes.length, contPtr, cont.length);
      timings.open_call_ms = ms(t);
      Object.assign(timings, JSON.parse(out()));
      x.dealloc(ptr, bytes.length);
      x.dealloc(contPtr, cont.length);
      return { ...timings, ...this.memory() };
    },
    memory: () => ({
      wasm_memory_mb: Math.round(x.memory.buffer.byteLength / 1048576),
      live_mb: Math.round(x.live_bytes() / 1048576),
    }),
    bigTable: () => JSON.parse(callText(x.big_table, JSON.stringify(BIG_TYPES))),
    search: (q = "service-12") => JSON.parse(callText(x.search, q)),
    nativeCells: (rows = 1000) => (x.native_cells(rows), JSON.parse(out())),
    rowIds: (rows = 1000) => (x.row_ids(rows), JSON.parse(out())),
    dispatch: (reqJson) => callText(x.dispatch, reqJson),
  };
}

async function start() {
  const t0 = performance.now();
  [py, rust] = await Promise.all([loadPyodide({ indexURL: "/pyodide/" }), loadRust()]);
  await py.loadPackage(["pydantic", "pyyaml", "sortedcontainers"], { messageCallback() {} });
  py.unpackArchive(await (await fetch("/core_src.tar.gz")).arrayBuffer(), "gztar", { extractDir: "/app" });
  py.runPython(`import sys\nsys.path.insert(0, "/app")\nimport script_host`);
  host = py.globals.get("script_host");
  boot.boot_total_ms = Math.round(performance.now() - t0);
  boot.cross_origin_isolated = self.crossOriginIsolated;
  postMessage({ type: "engine-ready", boot });
}

const stores = {
  js: {
    bench: () => ({
      big_table: bigTable(jsReplica),
      search: searchScan(jsReplica),
      native_cells: nativeCells(jsReplica),
    }),
    dispatch: () => makeDispatcher(jsReplica),
    ids: () => rowIds(jsReplica),
  },
  rust: {
    bench: () => ({
      big_table: rust.bigTable(),
      search: rust.search(),
      native_cells: rust.nativeCells(),
      memory: rust.memory(),
    }),
    dispatch: () => rust.dispatch,
    ids: () => rust.rowIds(),
  },
};

const commands = {
  open({ bytes }) {
    const u8 = new Uint8Array(bytes);
    const js = replicaFromBytes(u8);
    jsReplica = js.replica;
    return { js: js.timings, rust: rust.open(u8) };
  },
  bench: ({ store }) => stores[store].bench(),
  script_calls({ store }) {
    host.bind(stores[store].dispatch());
    return JSON.parse(host.run_calls_json(JSON.stringify(stores[store].ids())));
  },
};

self.onmessage = async (ev) => {
  const { id, cmd } = ev.data;
  try {
    const result = await commands[cmd](ev.data);
    postMessage({ id, ok: true, result, heap_mb: Math.round(py._module.HEAPU8.length / 1048576) });
  } catch (err) {
    postMessage({ id, ok: false, error: String(err).slice(0, 2000), heap_mb: 0 });
  }
};

start().catch((err) => postMessage({ type: "engine-failed", error: String(err).slice(0, 2000) }));
