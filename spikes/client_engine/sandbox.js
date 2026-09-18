// THROWAWAY SPIKE — the sandbox page: a dumb relay between the app shell and
// the engine worker. It accepts messages from the app origin only.
const APP_ORIGIN = "http://localhost:8801";
const WORKERS = { engine: "/engine-worker.mjs", store: "/store-worker.mjs" };
const workerKind = new URLSearchParams(location.search).get("worker") ?? "engine";
const worker = new Worker(WORKERS[workerKind] ?? WORKERS.engine, { type: "module" });
let interruptBuffer;

worker.onmessage = (ev) => {
  const { interruptBuffer: buf, ...data } = ev.data;
  if (buf) interruptBuffer = buf;
  parent.postMessage(data, APP_ORIGIN);
};
worker.onerror = (ev) =>
  parent.postMessage({ type: "engine-failed", error: `worker error: ${ev.message}` }, APP_ORIGIN);

window.addEventListener("message", (ev) => {
  if (ev.origin !== APP_ORIGIN) return;
  if (ev.data.cmd === "runaway" && interruptBuffer) {
    // The worker thread is stuck in Python; only another thread can raise SIGINT.
    setTimeout(() => (interruptBuffer[0] = 2), ev.data.interruptAfterMs ?? 1500);
  }
  worker.postMessage(ev.data, ev.data.bytes ? [ev.data.bytes] : []);
});

document.addEventListener("securitypolicyviolation", (ev) =>
  parent.postMessage(
    { type: "csp-violation", directive: ev.violatedDirective, blocked: ev.blockedURI },
    APP_ORIGIN,
  ),
);

parent.postMessage({ type: "iframe-ready", crossOriginIsolated: self.crossOriginIsolated }, APP_ORIGIN);
