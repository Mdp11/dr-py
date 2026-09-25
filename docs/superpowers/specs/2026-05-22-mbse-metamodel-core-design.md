# MBSE Metamodel Core — Design

**Date:** 2026-05-22
**Status:** Approved for planning
**Scope:** The mutable data-model core of an MBSE modelling tool. This is sub-project #1 of a larger product (which will eventually include a web frontend, persistent storage, and multi-user collaboration). This spec covers **only** the metamodel/model/validation core.

---

## 1. Purpose

Build a reflective, data-driven core that lets users:

1. Author a **metamodel** (a YAML file) describing the element types, relationship types, properties, and constraints their domain allows.
2. Create and edit **models** — concrete instances that conform to a loaded metamodel.
3. **Validate** a model against its metamodel.

The defining property: the data model is **mutable**. The set of allowed elements/relationships is not hard-coded — it is loaded at runtime from a metamodel file. Behavior is driven by *data*, not by compiled types.

The whole core is designed so that a future concurrent-user web app and a database backend are *extensions*, not rewrites (see §8).

---

## 2. Architecture: three layers

| Layer | Name | Mutable? | Defined by | Representation |
|---|---|---|---|---|
| M2 | **Meta-metamodel** | Fixed (we own it) | Us, in code | pydantic schema |
| M1 | **Metamodel** | Mutable | User | YAML file |
| M0 | **Model** | Mutable | User (later: the frontend) | Generic in-memory objects; persisted via a Repository |

- The **meta-metamodel** defines what a valid metamodel file may contain.
- A **metamodel** defines what a valid model may contain.
- A **model** is the user's actual system data.

This is the EMF/Ecore / OMG-MOF approach: a stable foundation we control, with a user-mutable metamodel above it.

---

## 3. The meta-metamodel (what a metamodel YAML may declare)

A metamodel file is a declarative YAML document. It may declare:

### 3.1 Datatypes
- **Built-in primitives:** `string`, `integer`, `float`, `boolean`, `date`.
- **User-defined enums:** a named, ordered list of allowed string values (e.g. `Status: [Draft, Reviewed, Approved]`).

### 3.2 Property definitions
A property (used by both element types and relationship types) has:
- `name`
- `datatype` — a primitive or a declared enum
- **multiplicity** — `required` (≥1) vs optional; `single` vs `many`; optional `min`/`max` count for `many`
- **facets** — datatype-specific constraints:
  - numeric: `min`, `max`
  - string: `pattern` (regex), `maxLength`
  - (facet set is extensible)

Property *values* are scalars or lists of scalars. Cross-element links are **not** modelled as properties — they are relationships (§3.4).

### 3.3 Element types
- `name`
- `abstract: true|false` — abstract types cannot be instantiated, only subtyped
- `extends` — optional single parent type (single inheritance)
- `properties` — list of property definitions

Inheritance: a type inherits its parent's properties and constraints. A type is **substitutable** wherever an ancestor is allowed (endpoint typing and validation walk the parent chain). No multiple inheritance.

### 3.4 Relationship types
First-class types with their own identity and properties.
- `name`, `abstract`, `extends` (same inheritance semantics as elements)
- `containment: true|false` — see §3.5
- `source` — the allowed source element type (subtypes accepted)
- `target` — the allowed target element type (subtypes accepted)
- multiplicity at each end (cardinality, e.g. source `0..*`, target `1..1`)
- `properties` — same property model as elements

Relationships are **directed** (source → target).

### 3.5 Containment flag
`containment` is a flag on a relationship type. When `true`, the relationship means the source **owns** the target, and the engine enforces extra rules (see §5):
- single-parent (a contained element has exactly one container)
- acyclic (containment forms a tree/forest)
- cascade-delete (deleting a container deletes contained children recursively)

When `false`, the relationship is a plain reference: independent lifetimes, many-to-many allowed, no cascade.

Multiple containment relationship *types* may exist (e.g. `PackageContains`, `BlockHasPart`), each with its own endpoint typing and properties. The containment relationships of a model collectively form the **model tree**.

---

## 4. The model layer (reflective objects)

No code generation. The runtime uses generic objects driven by the loaded metamodel.

- **`Element`** — fields: `id` (UUID, core-assigned), `type` (reference to its element-type definition), `properties` (map name → value/list), `rev` (revision counter, see §8).
- **`Relationship`** — fields: `id` (UUID), `type`, `source` (element id), `target` (element id), `properties`, `rev`.
- **`Model`** — a collection of elements and relationships conforming to one loaded metamodel. Containment relationships define the model tree.

### 4.1 Identity semantics
- Every element and relationship has an intrinsic, unique **UUID**, assigned by the **core at the moment of creation** (inside the mutation operations), never by the repository or database. A client/session can mint a valid id locally with no round-trip and no central sequence — the basis of the concurrency story (§8).
- Scheme: **UUIDv7** (time-ordered: coordination-free, collision-safe, sorts by creation time for good future DB index locality), with `uuid4` as fallback on older Pythons. Generation goes behind an injectable **`IdGenerator`** port (default = UUIDv7) so tests can inject deterministic ids and the strategy stays swappable.
- Identity is **by entity, not by value.** The id is assigned per creation event and is **not** content-derived (not a hash of properties). Two structurally identical elements (same type, same properties, same relationships) are distinct individuals with **different ids** — correct for MBSE, where genuinely distinct things (two identical bolts, two identical sensors) coexist with separate identities and lifetimes.
- "Same element?" is answered by **id comparison** (`a.id == b.id`), never by comparing properties.
- Forbidding accidental duplicates is a **separate concern** — a uniqueness constraint (validation level B, deferred) that the metamodel author opts into, not part of identity. Absent such a rule, identical elements are legal.

### 4.2 Mutation boundary
All model changes go through a **single, explicit set of operations** — this is the *only* way to mutate a model:
- `create_element(type) -> Element`
- `delete_element(id)` (honors containment cascade)
- `set(element_or_rel, property, value)`
- `connect(rel_type, source_id, target_id) -> Relationship`
- `disconnect(rel_id)`

This boundary is the seam that later carries transactions, optimistic-lock checks, change events, and undo (§8). No ad-hoc in-place mutation elsewhere.

### 4.3 No global state
The engine operates on an explicitly passed `Model` and an injected `Repository`. No module-level singletons or hidden caches. The core is reentrant, so a future web server can serve concurrent sessions without redesign.

---

## 5. Validation pipeline

Validation is a **pipeline of independent validators**, each implementing a common interface and producing `Issue`s.

- **`Issue`** — `severity` (`error` | `warning`), `message`, and the offending element/relationship `id`(s).
- **Validator interface** — takes the `Model`, its metamodel, and a **change scope** (a set of affected ids; the first cut passes "all", but the parameter exists so incremental/scoped validation drops in later — see §8).

### 5.1 First-cut validators (structural)
1. **Type conformance** — property values match declared datatypes / enum membership.
2. **Multiplicity** — property counts; relationship-end cardinalities.
3. **Property facets** — numeric range, string pattern/length, required.
4. **Endpoint typing** — relationship source/target are allowed types, respecting inheritance.
5. **Containment rules** — single parent, acyclic, cascade-delete on removal.

### 5.2 Extensibility (deferred, but the pipeline supports it)
- **Level B** — declarative cross-element rule templates (e.g. `unique(prop within type)`, "every Requirement has ≥1 incoming Satisfies"): additional validators registered in the pipeline.
- **Level C** — an OCL-like expression-language evaluator for arbitrary invariants: another validator.

Adding B or C is registering more validators — no rewrite.

---

## 6. Repository / store port

A `Repository` interface abstracts persistence of metamodels and models. The metamodel, model, and validation code depend **only** on this interface — never on a concrete store.

- **First-cut implementations:** in-memory store + YAML/JSON file load/save.
- **Interface shape:** transactional save (a unit-of-work that can be committed atomically) and able to accept an "expected revision" for optimistic concurrency (§8). The first cut implements the shape; conflict logic is deferred.
- **Future adapters:** Postgres-JSONB, document store, or graph DB — each implements the same interface with no upstream changes. The model is a typed property graph, which maps cleanly onto all three.

---

## 7. Technology & module structure

- **pydantic** — parse and validate the metamodel file against the fixed meta-metamodel schema (precise errors on malformed metamodels).
- **Plain Python** — the reflective model layer (generic objects; values are dynamic, so not pydantic).
- **Proposed module layout:**
  - `metamodel/` — meta-metamodel schema + metamodel loader/validator
  - `model/` — `Element`, `Relationship`, `Model`, mutation operations
  - `validation/` — pipeline, validator interface, first-cut validators, `Issue`
  - `repository/` — `Repository` port + in-memory and file adapters

---

## 8. Concurrency affordances (seams now, machinery later)

No concurrency *infrastructure* is built at this stage. The following cheap design affordances are baked in so the eventual concurrent-user web app extends rather than rewrites the core:

1. **Core-assigned stable UUIDs** (§4.1) — clients/sessions mint ids with no central sequence contention.
2. **No global mutable state** (§4.3) — reentrant core, safe for concurrent sessions.
3. **Single explicit mutation boundary** (§4.2) — the seam for transactions, optimistic-lock checks, change events, and undo.
4. **Revision field + transaction-shaped repository** (§4, §6) — `rev` counter on entities; repository accepts "expected revision". Field and interface shape implemented now; conflict resolution deferred.
5. **Scope-aware validators** (§5) — validator signature includes a change scope; whole-model now, incremental later.

---

## 9. Explicitly deferred (YAGNI)

Frontend; database adapters; locking/leasing; real-time sync (CRDT/OT/event broadcast); authentication / sessions / authorization; undo/redo; reference-valued & nested-structured properties; multiple inheritance / mixins; cross-element rule templates (validation level B); expression language (validation level C); relationships connecting relationships; metamodel versioning/migration.

---

## 10. Illustrative example

A tiny metamodel (illustrative — exact YAML keys to be finalized in the implementation plan):

```yaml
enums:
  Status: [Draft, Reviewed, Approved]

elements:
  NamedElement:
    abstract: true
    properties:
      - { name: name, datatype: string, required: true }
  Requirement:
    extends: NamedElement
    properties:
      - { name: status, datatype: Status, required: true }
      - { name: priority, datatype: integer, min: 1, max: 5 }
  Block:
    extends: NamedElement
    properties:
      - { name: mass, datatype: float, min: 0 }

relationships:
  BlockHasPart:
    containment: true
    source: Block
    target: Block
    sourceMultiplicity: "0..1"   # a part has at most one owning block
    targetMultiplicity: "0..*"
  Satisfies:
    containment: false
    source: Block
    target: Requirement
    sourceMultiplicity: "0..*"
    targetMultiplicity: "1..*"
```
