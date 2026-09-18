// THROWAWAY SPIKE — two static origins for the client-engine benchmark.
//
//   APP      http://localhost:8801   trusted shell: fetches the snapshot, hosts the iframe
//   SANDBOX  http://127.0.0.1:8802   engine + user scripts: Pyodide in a worker, locked-down CSP
//
// The two hosts are different sites, so the sandbox never sees the app's cookies
// and its CSP lets it reach nothing but its own static files.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PYODIDE_DIR = process.env.PYODIDE_DIR ?? "/tmp/pyodide-bench/node_modules/pyodide";
const WHEEL_DIR = process.env.WHEEL_DIR ?? "/tmp/pyodide-bench/pkgcache";
const MODEL_JSON = process.env.MODEL_JSON ?? path.join(REPO, "benchmarks/large.model.json");
const GEN_DIR = path.join(REPO, "benchmarks"); // gitignored: generated fixtures live here
export const APP_PORT = 8801;
export const SANDBOX_PORT = 8802;

const SNAPSHOT_GZ = path.join(GEN_DIR, "spike.snapshot.json.gz");
const CORE_TAR = path.join(GEN_DIR, "spike.core_src.tar.gz");

function prepareAssets() {
  if (!fs.existsSync(SNAPSHOT_GZ)) {
    // Same shape as api/snapshot_codec.py: gzip level 3 of the compact document.
    fs.writeFileSync(SNAPSHOT_GZ, zlib.gzipSync(fs.readFileSync(MODEL_JSON), { level: 3 }));
  }
  execFileSync("tar", [
    "-czf", CORE_TAR, "--exclude=__pycache__",
    "-C", path.join(REPO, "src"), "data_rover/__init__.py", "data_rover/core",
    "-C", path.join(REPO, "tests/script"), "trusted_runner.py",
    "-C", HERE, "bench_engine.py", "script_host.py",
  ]);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".yaml": "text/plain; charset=utf-8",
  ".gz": "application/gzip",
};

function send(res, file, headers) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, headers).end("not found");
    return;
  }
  const type = MIME[path.extname(file)] ?? "application/octet-stream";
  res.writeHead(200, { ...headers, "Content-Type": type, "Content-Length": fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
}

const APP_FILES = {
  "/": "app.html",
  "/app.js": "app.js",
  "/js-replica.mjs": "js-replica.mjs",
  "/js-replica-worker.mjs": "js-replica-worker.mjs",
  "/jsmem.html": "jsmem.html",
};
const APP_HEADERS = {
  // Cross-origin isolation, so the sandbox iframe may use SharedArrayBuffer (interrupts).
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cache-Control": "no-store",
};

const SANDBOX_FILES = {
  "/sandbox.html": "sandbox.html",
  "/sandbox.js": "sandbox.js",
  "/engine-worker.mjs": "engine-worker.mjs",
  "/store-worker.mjs": "store-worker.mjs",
  "/js-replica.mjs": "js-replica.mjs",
};
// Built by: cargo build --release --target wasm32-unknown-unknown (see README).
const RUST_WASM =
  process.env.RUST_WASM ??
  path.join(GEN_DIR, "spike-rust-target/wasm32-unknown-unknown/release/rust_replica.wasm");
const SANDBOX_CSP =
  process.env.SANDBOX_CSP ??
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'";
const SANDBOX_HEADERS = {
  "Content-Security-Policy": SANDBOX_CSP,
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

export function startServers() {
  prepareAssets();
  const app = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/snapshot.json.gz") return send(res, SNAPSHOT_GZ, APP_HEADERS);
    const name = APP_FILES[url.pathname];
    send(res, name && path.join(HERE, name), APP_HEADERS);
  });
  const sandbox = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const cached = { ...SANDBOX_HEADERS, "Cache-Control": "public, max-age=3600" };
    if (url.pathname.startsWith("/pyodide/")) {
      const base = path.basename(url.pathname);
      const dir = base.endsWith(".whl") ? WHEEL_DIR : PYODIDE_DIR;
      return send(res, path.join(dir, base), cached);
    }
    if (url.pathname === "/core_src.tar.gz") return send(res, CORE_TAR, SANDBOX_HEADERS);
    if (url.pathname === "/rust_replica.wasm") return send(res, RUST_WASM, SANDBOX_HEADERS);
    if (url.pathname === "/metamodel.yaml")
      return send(res, path.join(REPO, "examples/smart-city.metamodel.yaml"), SANDBOX_HEADERS);
    const name = SANDBOX_FILES[url.pathname];
    send(res, name && path.join(HERE, name), { ...SANDBOX_HEADERS, "Cache-Control": "no-store" });
  });
  app.listen(APP_PORT, "127.0.0.1");
  sandbox.listen(SANDBOX_PORT, "127.0.0.1");
  return { close: () => (app.close(), sandbox.close()) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServers();
  console.log(`app     http://localhost:${APP_PORT}/   (open this one)`);
  console.log(`sandbox http://127.0.0.1:${SANDBOX_PORT}/ (CSP: ${SANDBOX_CSP})`);
}
