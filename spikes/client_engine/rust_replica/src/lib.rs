//! THROWAWAY SPIKE — a MINIMAL Rust replica of the model, compiled to wasm32.
//!
//! Context numbers only, like `js-replica.mjs`: interned type/property names,
//! compact typed property values, id maps and CSR adjacency, plus like-for-like
//! versions of the table, search and script-cell workloads and the bridge ops
//! the Python facade needs (`dispatch`). Raw C ABI, no wasm-bindgen: the host
//! writes bytes at `alloc`, calls an export, reads the JSON left at `out_ptr`.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::RefCell;
use std::fmt;
use std::sync::atomic::{AtomicUsize, Ordering};

use rustc_hash::{FxHashMap, FxHashSet};
use serde::de::{DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[link(wasm_import_module = "env")]
extern "C" {
    fn now() -> f64;
}

fn clock() -> f64 {
    unsafe { now() }
}

// ---- live-bytes accounting (steady-state memory, next to the wasm high-water mark)
struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        LIVE.fetch_add(layout.size(), Ordering::Relaxed);
        System.alloc(layout)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        System.dealloc(ptr, layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        LIVE.fetch_add(new_size, Ordering::Relaxed);
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        System.realloc(ptr, layout, new_size)
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

// ---- interned names (element/relationship types and property keys)
#[derive(Default)]
struct Interner {
    ids: FxHashMap<Box<str>, u32>,
    names: Vec<Box<str>>,
}

impl Interner {
    fn intern(&mut self, s: &str) -> u32 {
        if let Some(&id) = self.ids.get(s) {
            return id;
        }
        let id = self.names.len() as u32;
        self.names.push(s.into());
        self.ids.insert(s.into(), id);
        id
    }
    fn get(&self, s: &str) -> Option<u32> {
        self.ids.get(s).copied()
    }
    fn name(&self, id: u32) -> &str {
        &self.names[id as usize]
    }
}

thread_local! {
    static LOADING: RefCell<Interner> = RefCell::new(Interner::default());
    static STORE: RefCell<Option<Store>> = const { RefCell::new(None) };
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

struct InternVisitor;
impl Visitor<'_> for InternVisitor {
    type Value = u32;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a string")
    }
    fn visit_str<E>(self, s: &str) -> Result<u32, E> {
        Ok(LOADING.with(|n| n.borrow_mut().intern(s)))
    }
}
struct InternSeed;
impl<'de> DeserializeSeed<'de> for InternSeed {
    type Value = u32;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<u32, D::Error> {
        d.deserialize_str(InternVisitor)
    }
}
fn interned<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    d.deserialize_str(InternVisitor)
}

// ---- property values
enum PropValue {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(Box<str>),
    List(Vec<PropValue>),
    Map(Vec<(Box<str>, PropValue)>),
}

struct PropVisitor;
impl<'de> Visitor<'de> for PropVisitor {
    type Value = PropValue;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_unit<E>(self) -> Result<PropValue, E> {
        Ok(PropValue::Null)
    }
    fn visit_bool<E>(self, v: bool) -> Result<PropValue, E> {
        Ok(PropValue::Bool(v))
    }
    fn visit_i64<E>(self, v: i64) -> Result<PropValue, E> {
        Ok(PropValue::Int(v))
    }
    fn visit_u64<E>(self, v: u64) -> Result<PropValue, E> {
        Ok(i64::try_from(v).map_or(PropValue::Float(v as f64), PropValue::Int))
    }
    fn visit_f64<E>(self, v: f64) -> Result<PropValue, E> {
        Ok(PropValue::Float(v))
    }
    fn visit_str<E>(self, v: &str) -> Result<PropValue, E> {
        Ok(PropValue::Str(v.into()))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<PropValue, A::Error> {
        let mut items = Vec::with_capacity(seq.size_hint().unwrap_or(0));
        while let Some(item) = seq.next_element()? {
            items.push(item);
        }
        Ok(PropValue::List(items))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<PropValue, A::Error> {
        let mut items = Vec::new();
        while let Some(key) = map.next_key::<Box<str>>()? {
            items.push((key, map.next_value()?));
        }
        Ok(PropValue::Map(items))
    }
}
impl<'de> Deserialize<'de> for PropValue {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(PropVisitor)
    }
}
impl Serialize for PropValue {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            PropValue::Null => s.serialize_unit(),
            PropValue::Bool(v) => s.serialize_bool(*v),
            PropValue::Int(v) => s.serialize_i64(*v),
            PropValue::Float(v) => s.serialize_f64(*v),
            PropValue::Str(v) => s.serialize_str(v),
            PropValue::List(items) => {
                let mut seq = s.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            PropValue::Map(items) => {
                let mut map = s.serialize_map(Some(items.len()))?;
                for (k, v) in items {
                    map.serialize_entry(&**k, v)?;
                }
                map.end()
            }
        }
    }
}

/// A property bag: `(interned key, value)` pairs in document order.
#[derive(Default)]
struct Props(Vec<(u32, PropValue)>);

struct PropsVisitor;
impl<'de> Visitor<'de> for PropsVisitor {
    type Value = Props;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a properties object")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Props, A::Error> {
        let mut items = Vec::with_capacity(map.size_hint().unwrap_or(8));
        while let Some(key) = map.next_key_seed(InternSeed)? {
            items.push((key, map.next_value()?));
        }
        items.shrink_to_fit();
        Ok(Props(items))
    }
    fn visit_unit<E>(self) -> Result<Props, E> {
        Ok(Props::default())
    }
}
impl<'de> Deserialize<'de> for Props {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(PropsVisitor)
    }
}
impl Props {
    fn get(&self, key: u32) -> Option<&PropValue> {
        self.0.iter().find(|(k, _)| *k == key).map(|(_, v)| v)
    }
    fn str(&self, key: u32) -> Option<&str> {
        match self.get(key) {
            Some(PropValue::Str(s)) => Some(s),
            _ => None,
        }
    }
}

// ---- entities and the store
#[derive(Deserialize)]
struct Element {
    id: Box<str>,
    #[serde(deserialize_with = "interned")]
    type_name: u32,
    #[serde(default)]
    properties: Props,
    #[serde(default)]
    #[allow(dead_code)]
    rev: u32,
}

#[derive(Deserialize)]
struct RawRelationship {
    id: Box<str>,
    #[serde(deserialize_with = "interned")]
    type_name: u32,
    source_id: Box<str>,
    target_id: Box<str>,
    #[serde(default)]
    properties: Props,
    #[serde(default)]
    rev: u32,
}

struct Relationship {
    id: Box<str>,
    type_name: u32,
    source: u32,
    target: u32,
    properties: Props,
    #[allow(dead_code)]
    rev: u32,
}

#[derive(Deserialize)]
struct RawDoc {
    #[serde(default)]
    elements: Vec<Element>,
    #[serde(default)]
    relationships: Vec<RawRelationship>,
}

const DANGLING: u32 = u32::MAX;

struct Store {
    names: Interner,
    elements: Vec<Element>,
    rels: Vec<Relationship>,
    by_id: FxHashMap<Box<str>, u32>,
    by_type: FxHashMap<u32, Vec<u32>>,
    out_off: Vec<u32>,
    out_rel: Vec<u32>,
    in_off: Vec<u32>,
    in_rel: Vec<u32>,
    name_key: u32,
    containment: FxHashSet<u32>,
}

fn csr(n: usize, rels: &[Relationship], end: impl Fn(&Relationship) -> u32) -> (Vec<u32>, Vec<u32>) {
    let mut off = vec![0u32; n + 1];
    for r in rels {
        let e = end(r);
        if e != DANGLING {
            off[e as usize + 1] += 1;
        }
    }
    for i in 0..n {
        off[i + 1] += off[i];
    }
    let mut cursor = off.clone();
    let mut flat = vec![0u32; off[n] as usize];
    for (i, r) in rels.iter().enumerate() {
        let e = end(r);
        if e != DANGLING {
            flat[cursor[e as usize] as usize] = i as u32;
            cursor[e as usize] += 1;
        }
    }
    (off, flat)
}

impl Store {
    fn name_of(&self, e: u32) -> &str {
        self.elements[e as usize].properties.str(self.name_key).unwrap_or("")
    }
    fn outgoing(&self, e: u32) -> &[u32] {
        &self.out_rel[self.out_off[e as usize] as usize..self.out_off[e as usize + 1] as usize]
    }
    fn incoming(&self, e: u32) -> &[u32] {
        &self.in_rel[self.in_off[e as usize] as usize..self.in_off[e as usize + 1] as usize]
    }
    fn parent(&self, e: u32) -> Option<u32> {
        self.incoming(e)
            .iter()
            .map(|&r| &self.rels[r as usize])
            .find(|r| self.containment.contains(&r.type_name) && r.source != DANGLING)
            .map(|r| r.source)
    }
    fn children(&self, e: u32) -> impl Iterator<Item = u32> + '_ {
        self.outgoing(e)
            .iter()
            .map(|&r| &self.rels[r as usize])
            .filter(|r| self.containment.contains(&r.type_name) && r.target != DANGLING)
            .map(|r| r.target)
    }
}

// ---- host ABI
fn set_out(value: &Value) {
    OUT.with(|o| *o.borrow_mut() = serde_json::to_vec(value).unwrap());
}
fn input<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    unsafe { std::slice::from_raw_parts(ptr, len) }
}
fn with_store<R>(f: impl FnOnce(&Store) -> R) -> R {
    STORE.with(|s| f(s.borrow().as_ref().expect("open first")))
}
fn round1(ms: f64) -> f64 {
    (ms * 10.0).round() / 10.0
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, 0, len)) }
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn out_len() -> usize {
    OUT.with(|o| o.borrow().len())
}

#[no_mangle]
pub extern "C" fn live_bytes() -> usize {
    LIVE.load(Ordering::Relaxed)
}

/// Parse the inflated snapshot and build every index. `containment` is a JSON
/// list of containment relationship type names (the metamodel's knowledge).
#[no_mangle]
pub extern "C" fn open(ptr: *const u8, len: usize, cont_ptr: *const u8, cont_len: usize) {
    let t = clock();
    let doc: RawDoc = serde_json::from_slice(input(ptr, len)).expect("snapshot JSON");
    let parse_ms = clock() - t;

    let t = clock();
    let mut names = LOADING.with(|n| std::mem::take(&mut *n.borrow_mut()));
    let elements = doc.elements;
    let mut by_id = FxHashMap::with_capacity_and_hasher(elements.len(), Default::default());
    let mut by_type: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    for (i, e) in elements.iter().enumerate() {
        by_id.insert(e.id.clone(), i as u32);
        by_type.entry(e.type_name).or_default().push(i as u32);
    }
    let rels: Vec<Relationship> = doc
        .relationships
        .into_iter()
        .map(|r| Relationship {
            source: by_id.get(&r.source_id).copied().unwrap_or(DANGLING),
            target: by_id.get(&r.target_id).copied().unwrap_or(DANGLING),
            id: r.id,
            type_name: r.type_name,
            properties: r.properties,
            rev: r.rev,
        })
        .collect();
    let (out_off, out_rel) = csr(elements.len(), &rels, |r| r.source);
    let (in_off, in_rel) = csr(elements.len(), &rels, |r| r.target);
    let cont_names: Vec<String> = serde_json::from_slice(input(cont_ptr, cont_len)).unwrap();
    let containment = cont_names.iter().map(|n| names.intern(n)).collect();
    let name_key = names.intern("name");
    let build_ms = clock() - t;

    let summary = json!({
        "json_parse_ms": round1(parse_ms),
        "build_indexes_ms": round1(build_ms),
        "elements": elements.len(),
        "relationships": rels.len(),
    });
    STORE.with(|s| {
        *s.borrow_mut() = Some(Store {
            names, elements, rels, by_id, by_type,
            out_off, out_rel, in_off, in_rel, name_key, containment,
        })
    });
    set_out(&summary);
}

struct Cell<'a> {
    _element: u32,
    _name: &'a str,
    _reached: Vec<(u32, &'a str)>,
}

/// `types`: JSON list of element type names (already expanded to subtypes).
#[no_mangle]
pub extern "C" fn big_table(ptr: *const u8, len: usize) {
    let types: Vec<String> = serde_json::from_slice(input(ptr, len)).unwrap();
    with_store(|st| {
        let wanted: FxHashSet<u32> = types.iter().filter_map(|t| st.names.get(t)).collect();
        let t = clock();
        let mut rows: Vec<u32> = (0..st.elements.len() as u32)
            .filter(|&i| wanted.contains(&st.elements[i as usize].type_name))
            .collect();
        rows.sort_by(|&a, &b| st.elements[a as usize].id.cmp(&st.elements[b as usize].id));
        let build_ms = clock() - t;

        let t = clock();
        let mut ordered = rows.clone();
        ordered.sort_by(|&a, &b| st.name_of(a).cmp(st.name_of(b)));
        let sort_ms = clock() - t;

        let t = clock();
        let scc = st.names.get("SystemContainsComponent").unwrap_or(DANGLING);
        let mut seen: FxHashSet<u32> = FxHashSet::default();
        let mut cells: Vec<Cell> = Vec::with_capacity(ordered.len());
        for &e in &ordered {
            seen.clear();
            let mut reached: Vec<u32> = Vec::new();
            for &r in st.outgoing(e) {
                let rel = &st.rels[r as usize];
                if rel.type_name == scc && rel.target != DANGLING && seen.insert(rel.target) {
                    reached.push(rel.target);
                }
            }
            for &r in st.incoming(e) {
                let rel = &st.rels[r as usize];
                if rel.type_name == scc && rel.source != DANGLING && seen.insert(rel.source) {
                    reached.push(rel.source);
                }
            }
            reached.truncate(20);
            cells.push(Cell {
                _element: e,
                _name: st.name_of(e),
                _reached: reached.into_iter().map(|x| (x, st.name_of(x))).collect(),
            });
        }
        let cells_ms = clock() - t;
        set_out(&json!({
            "build_rows_ms": round1(build_ms),
            "rows": rows.len(),
            "sort_ms": round1(sort_ms),
            "all_cells_ms": round1(cells_ms),
            "export_total_ms": round1(build_ms + sort_ms + cells_ms),
            "cells": cells.len() * 3,
        }));
    });
}

#[no_mangle]
pub extern "C" fn search(ptr: *const u8, len: usize) {
    let query = String::from_utf8_lossy(input(ptr, len)).to_lowercase();
    with_store(|st| {
        let t = clock();
        let hits = (0..st.elements.len() as u32)
            .filter(|&e| st.name_of(e).to_lowercase().contains(&query))
            .count();
        set_out(&json!({ "search_scan_ms": round1(clock() - t), "hits": hits }));
    });
}

#[allow(dead_code)]
enum Native<'a> {
    Text(String),
    Ref(Option<&'a str>),
    Count(usize),
    Names(Vec<&'a str>),
}

/// The same ten "script columns" as `bench_engine.SCRIPTS`, as native code.
#[no_mangle]
pub extern "C" fn native_cells(row_count: usize) {
    with_store(|st| {
        let micro = st.names.get("Microservice").unwrap_or(DANGLING);
        let status = st.names.get("status").unwrap_or(DANGLING);
        let tags = st.names.get("tags").unwrap_or(DANGLING);
        let rows: Vec<u32> = st.by_type.get(&micro).map_or(vec![], |v| v.iter().take(row_count).copied().collect());
        let t = clock();
        let mut cells: Vec<[Native; 10]> = Vec::with_capacity(rows.len());
        for &e in &rows {
            let el = &st.elements[e as usize];
            let dest = |r: &u32| st.rels[*r as usize].target;
            let mut tag_list: Vec<&str> = match el.properties.get(tags) {
                Some(PropValue::List(items)) => items
                    .iter()
                    .filter_map(|v| if let PropValue::Str(s) = v { Some(&**s) } else { None })
                    .collect(),
                _ => vec![],
            };
            tag_list.sort_unstable();
            cells.push([
                Native::Text(st.name_of(e).to_uppercase()),
                Native::Count(st.outgoing(e).len()),
                Native::Count(st.incoming(e).len()),
                Native::Ref(st.parent(e).map(|p| st.name_of(p))),
                Native::Names(st.outgoing(e).iter().take(5).map(|r| st.name_of(dest(r))).collect()),
                Native::Count(st.outgoing(e).iter().map(|r| st.outgoing(dest(r)).len()).sum()),
                Native::Ref(el.properties.str(status)),
                Native::Text(tag_list.join(", ")),
                Native::Text(format!("{}:{}", st.names.name(el.type_name), el.id)),
                Native::Count(st.children(e).count()),
            ]);
        }
        let elapsed = clock() - t;
        let total = rows.len() * 10;
        set_out(&json!({
            "script_cells_ms": round1(elapsed),
            "script_cells": total,
            "us_per_cell": round1(elapsed * 1000.0 / total.max(1) as f64),
        }));
    });
}

#[no_mangle]
pub extern "C" fn row_ids(row_count: usize) {
    with_store(|st| {
        let micro = st.names.get("Microservice").unwrap_or(DANGLING);
        let mut ids: Vec<&str> = st.by_type.get(&micro).map_or(vec![], |v| v.iter().map(|&e| &*st.elements[e as usize].id).collect());
        ids.sort_unstable();
        ids.truncate(row_count);
        set_out(&json!(ids));
    });
}

// ---- bridge ops for the Python facade (same wire shapes as core/script/bridge.py)
struct PropsSer<'a>(&'a Props, &'a Interner);
impl Serialize for PropsSer<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(self.0 .0.len()))?;
        for (k, v) in &self.0 .0 {
            map.serialize_entry(self.1.name(*k), v)?;
        }
        map.end()
    }
}

#[derive(Serialize)]
struct ElemProj<'a> {
    id: &'a str,
    #[serde(rename = "type")]
    ty: &'a str,
    name: Option<&'a str>,
    properties: PropsSer<'a>,
}

#[derive(Serialize)]
struct RelProj<'a> {
    id: &'a str,
    #[serde(rename = "type")]
    ty: &'a str,
    name: Option<&'a PropValue>,
    properties: PropsSer<'a>,
    source_id: &'a str,
    target_id: &'a str,
}

#[derive(Serialize, Default)]
struct Resp<'a> {
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    element: Option<ElemProj<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    relationships: Option<Vec<RelProj<'a>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    elements: Option<Vec<ElemProj<'a>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_id: Option<Option<&'a str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<ElemProj<'a>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Deserialize)]
struct Req {
    #[serde(default)]
    id: Value,
    op: String,
    #[serde(default)]
    element_id: Option<String>,
    #[serde(default)]
    ids: Vec<String>,
}

const MAX_INLINE_FAR_ENDPOINTS: usize = 2048;

impl Store {
    fn elem(&self, e: u32) -> ElemProj<'_> {
        let el = &self.elements[e as usize];
        ElemProj {
            id: &el.id,
            ty: self.names.name(el.type_name),
            name: el.properties.str(self.name_key),
            properties: PropsSer(&el.properties, &self.names),
        }
    }
    fn end_id(&self, e: u32) -> &str {
        if e == DANGLING { "" } else { &self.elements[e as usize].id }
    }
    fn hop(&self, rel_ids: &[u32], far: impl Fn(&Relationship) -> u32) -> (Vec<RelProj<'_>>, Vec<ElemProj<'_>>) {
        let mut sorted: Vec<u32> = rel_ids.to_vec();
        sorted.sort_by(|&a, &b| self.rels[a as usize].id.cmp(&self.rels[b as usize].id));
        let mut seen = FxHashSet::default();
        let mut unique = Vec::new();
        let mut rels = Vec::with_capacity(sorted.len());
        for &r in &sorted {
            let rel = &self.rels[r as usize];
            rels.push(RelProj {
                id: &rel.id,
                ty: self.names.name(rel.type_name),
                name: rel.properties.get(self.name_key),
                properties: PropsSer(&rel.properties, &self.names),
                source_id: self.end_id(rel.source),
                target_id: self.end_id(rel.target),
            });
            let f = far(rel);
            if f != DANGLING && seen.insert(f) {
                unique.push(f);
            }
        }
        let elements = if unique.len() > MAX_INLINE_FAR_ENDPOINTS {
            vec![]
        } else {
            unique.into_iter().map(|e| self.elem(e)).collect()
        };
        (rels, elements)
    }
}

#[no_mangle]
pub extern "C" fn dispatch(ptr: *const u8, len: usize) {
    let bytes = with_store(|st| {
        let req: Req = match serde_json::from_slice(input(ptr, len)) {
            Ok(r) => r,
            Err(e) => return serde_json::to_vec(&json!({ "id": null, "error": format!("ValueError: {e}") })).unwrap(),
        };
        let mut resp = Resp { id: req.id, ..Default::default() };
        if req.op == "project_roots" {
            resp.elements = Some(req.ids.iter().filter_map(|id| st.by_id.get(&**id)).map(|&e| st.elem(e)).collect());
            return serde_json::to_vec(&resp).unwrap();
        }
        let key = req.element_id.unwrap_or_default();
        match st.by_id.get(&*key).copied() {
            None => resp.error = Some(format!("KeyError: '{key}'")),
            Some(e) => match req.op.as_str() {
                "element" => resp.element = Some(st.elem(e)),
                "outgoing" => {
                    let (rels, far) = st.hop(st.outgoing(e), |r| r.target);
                    (resp.relationships, resp.elements) = (Some(rels), Some(far));
                }
                "incoming" => {
                    let (rels, far) = st.hop(st.incoming(e), |r| r.source);
                    (resp.relationships, resp.elements) = (Some(rels), Some(far));
                }
                "parent" => resp.parent_id = Some(st.parent(e).map(|p| &*st.elements[p as usize].id)),
                "children" => {
                    let mut kids: Vec<u32> = st.children(e).collect();
                    kids.sort_by(|&a, &b| st.elements[a as usize].id.cmp(&st.elements[b as usize].id));
                    resp.children = Some(kids.into_iter().map(|c| st.elem(c)).collect());
                }
                other => resp.error = Some(format!("ValueError: unknown op '{other}'")),
            },
        }
        serde_json::to_vec(&resp).unwrap()
    });
    OUT.with(|o| *o.borrow_mut() = bytes);
}
