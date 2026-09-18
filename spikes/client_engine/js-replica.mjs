// THROWAWAY SPIKE — a MINIMAL JavaScript replica of the same model, for context
// numbers only. It is not an engine port: it holds the parsed entities plus id,
// type and adjacency indexes, runs like-for-like versions of the table, search
// and script-cell workloads measured against the Python core, and answers the
// bridge ops the Python facade needs (`makeDispatcher`).

// bench_engine.BIG_TYPES expanded to subtypes, as ScopeRows does server-side.
export const BIG_TYPES = [
  "APIEndpoint", "ContainerHost", "DataEntity", "DataSchema", "Database", "EdgeGateway",
  "IoTDevice", "Microservice", "Person", "Server", "Service", "VirtualMachine",
];
// The smart-city metamodel's containment relationship types.
export const CONTAINMENT = ["ExposesEndpoint", "GatewayServes", "HasZone", "Owns", "SystemContainsComponent"];

const ms = (t) => Math.round((performance.now() - t) * 10) / 10;
const EMPTY = [];
const nameOf = (e) => e.properties.name ?? "";
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function replicaFromBytes(bytes) {
  const timings = {};
  let t = performance.now();
  const text = new TextDecoder().decode(bytes);
  timings.utf8_decode_ms = ms(t);
  t = performance.now();
  const raw = JSON.parse(text);
  timings.json_parse_ms = ms(t);
  t = performance.now();
  const elements = new Map();
  const byType = new Map();
  const outgoing = new Map();
  const incoming = new Map();
  for (const e of raw.elements) {
    elements.set(e.id, e);
    let bucket = byType.get(e.type_name);
    if (!bucket) byType.set(e.type_name, (bucket = []));
    bucket.push(e);
  }
  const relationships = new Map();
  for (const r of raw.relationships) {
    relationships.set(r.id, r);
    let o = outgoing.get(r.source_id);
    if (!o) outgoing.set(r.source_id, (o = []));
    o.push(r);
    let i = incoming.get(r.target_id);
    if (!i) incoming.set(r.target_id, (i = []));
    i.push(r);
  }
  timings.build_indexes_ms = ms(t);
  timings.elements = elements.size;
  timings.relationships = relationships.size;
  const containment = new Set(CONTAINMENT);
  return { replica: { elements, relationships, byType, outgoing, incoming, containment }, timings };
}

export async function loadReplica(url) {
  let t = performance.now();
  const gz = await (await fetch(url)).arrayBuffer();
  const fetch_ms = ms(t);
  t = performance.now();
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const gunzip_ms = ms(t);
  const { replica, timings } = replicaFromBytes(bytes);
  const open_total_ms =
    Math.round((gunzip_ms + timings.utf8_decode_ms + timings.json_parse_ms + timings.build_indexes_ms) * 10) / 10;
  return { replica, timings: { fetch_ms, gunzip_ms, ...timings, open_total_ms } };
}

export function bigTable(rep) {
  const wanted = new Set(BIG_TYPES);
  const out = {};
  let t = performance.now();
  const rows = [];
  for (const e of rep.elements.values()) if (wanted.has(e.type_name)) rows.push(e);
  rows.sort(byId);
  out.build_rows_ms = ms(t);
  out.rows = rows.length;
  t = performance.now();
  const ordered = rows
    .map((e) => [nameOf(e), e])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map((p) => p[1]);
  out.sort_ms = ms(t);
  t = performance.now();
  const cells = new Array(ordered.length);
  for (let i = 0; i < ordered.length; i++) {
    const e = ordered[i];
    const seen = new Set();
    const reached = [];
    for (const r of rep.outgoing.get(e.id) ?? EMPTY)
      if (r.type_name === "SystemContainsComponent" && !seen.has(r.target_id)) {
        seen.add(r.target_id);
        reached.push(r.target_id);
      }
    for (const r of rep.incoming.get(e.id) ?? EMPTY)
      if (r.type_name === "SystemContainsComponent" && !seen.has(r.source_id)) {
        seen.add(r.source_id);
        reached.push(r.source_id);
      }
    cells[i] = [
      { element_id: e.id },
      { value: nameOf(e) },
      { elements: reached.slice(0, 20).map((id) => ({ id, name: nameOf(rep.elements.get(id)) })) },
    ];
  }
  out.all_cells_ms = ms(t);
  out.export_total_ms = Math.round((out.build_rows_ms + out.sort_ms + out.all_cells_ms) * 10) / 10;
  out.cells = cells.length * 3;
  return out;
}

export function searchScan(rep, query = "service-12") {
  const t = performance.now();
  let hits = 0;
  for (const e of rep.elements.values()) if (nameOf(e).toLowerCase().includes(query)) hits++;
  return { search_scan_ms: ms(t), hits };
}

export function rowIds(rep, rowCount = 1000) {
  return (rep.byType.get("Microservice") ?? []).map((e) => e.id).sort().slice(0, rowCount);
}

// The same ten "script columns" as bench_engine.SCRIPTS, written as plain JS
// over the replica: the ceiling of what switching the script language could buy.
export function nativeCells(rep, rowCount = 1000) {
  const out = (e) => rep.outgoing.get(e.id) ?? EMPTY;
  const inc = (e) => rep.incoming.get(e.id) ?? EMPTY;
  const dest = (r) => rep.elements.get(r.target_id);
  const contains = (r) => rep.containment.has(r.type_name);
  const scripts = [
    (e) => nameOf(e).toUpperCase(),
    (e) => out(e).length,
    (e) => inc(e).length,
    (e) => {
      const r = inc(e).find(contains);
      return r ? nameOf(rep.elements.get(r.source_id)) : null;
    },
    (e) => out(e).slice(0, 5).map((r) => nameOf(dest(r))),
    (e) => out(e).reduce((n, r) => n + out(dest(r)).length, 0),
    (e) => e.properties.status ?? null,
    (e) => [...(e.properties.tags ?? [])].sort().join(", "),
    (e) => `${e.type_name}:${e.id}`,
    (e) => out(e).filter(contains).length,
  ];
  const rows = rowIds(rep, rowCount).map((id) => rep.elements.get(id));
  const t = performance.now();
  const cells = rows.map((e) => scripts.map((fn) => fn(e)));
  const elapsed = ms(t);
  const total = rows.length * scripts.length;
  return {
    script_cells_ms: elapsed,
    script_cells: total,
    us_per_cell: Math.round((elapsed * 1000 * 10) / Math.max(1, total)) / 10,
    sample_row: cells[0],
  };
}

// Bridge ops with the wire shapes of core/script/bridge.py, JSON in / JSON out,
// so the unmodified Python facade can read this store through one sync call.
const MAX_INLINE_FAR_ENDPOINTS = 2048;

export function makeDispatcher(rep) {
  const elem = (e) => ({ id: e.id, type: e.type_name, name: e.properties.name ?? null, properties: e.properties });
  const rel = (r) => ({
    id: r.id, type: r.type_name, name: r.properties.name ?? null, properties: r.properties,
    source_id: r.source_id, target_id: r.target_id,
  });
  const hop = (rels, farKey) => {
    const sorted = [...rels].sort(byId);
    const unique = [...new Set(sorted.map((r) => r[farKey]))];
    const far = unique.length > MAX_INLINE_FAR_ENDPOINTS ? [] : unique.map((id) => rep.elements.get(id)).filter(Boolean);
    return { relationships: sorted.map(rel), elements: far.map(elem) };
  };
  const ops = {
    element: (e) => ({ element: elem(e) }),
    outgoing: (e) => hop(rep.outgoing.get(e.id) ?? EMPTY, "target_id"),
    incoming: (e) => hop(rep.incoming.get(e.id) ?? EMPTY, "source_id"),
    parent: (e) => {
      const r = (rep.incoming.get(e.id) ?? EMPTY).find((x) => rep.containment.has(x.type_name));
      return { parent_id: r ? r.source_id : null };
    },
    children: (e) => ({
      children: (rep.outgoing.get(e.id) ?? EMPTY)
        .filter((r) => rep.containment.has(r.type_name))
        .map((r) => rep.elements.get(r.target_id))
        .filter(Boolean)
        .sort(byId)
        .map(elem),
    }),
  };
  return (reqJson) => {
    const req = JSON.parse(reqJson);
    if (req.op === "project_roots")
      return JSON.stringify({ id: req.id, elements: req.ids.map((id) => rep.elements.get(id)).filter(Boolean).map(elem) });
    const handler = ops[req.op];
    const e = rep.elements.get(req.element_id);
    if (!handler) return JSON.stringify({ id: req.id, error: `ValueError: unknown op '${req.op}'` });
    if (!e) return JSON.stringify({ id: req.id, error: `KeyError: '${req.element_id}'` });
    return JSON.stringify({ id: req.id, ...handler(e) });
  };
}
