# Engine Store: Snapshot v2, Digest, Metamodel and Record Graph — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Python server the `datarover.snapshot/v2` codec and the state digest, and give the TypeScript engine its metamodel, its record-graph store with indexes and its mutation boundary — each proven against the real Python core through golden fixtures.

**Architecture:** Plan 2 of 4 for sub-project A (`architecture/program.md`). Python gains two additive pieces (`api/state_digest.py`, a v2 branch in `api/snapshot_codec.py`); no writer emits v2 yet and nothing under the freeze rule (MR-3) changes. The engine gains `src/metamodel/` (every lookup of the Python `Metamodel`, built up front from the `GET /metamodel` document), `src/model/` (one fixed-shape record per entity with adjacency on the records, `IndexSet`, and `Model` as the single mutation boundary) and `src/debug/`. Model scenarios are step lists: a Python recorder runs them against the oracle and logs every outcome plus a digest and a fingerprint of the whole observable state; a vitest runner replays them through the engine.

**Tech Stack:** Python 3.14 (`hashlib`, `zlib`, pytest, ruff, mypy, pyright); TypeScript 6 (strict, erasable syntax only), vitest 3, eslint 10, prettier 3; pixi for every command.

**Spec:** `docs/superpowers/specs/2026-09-18-engine-foundation-design.md` — §3 Metamodel, §4 Store, the Python half of §7, and the matching scenarios of §8. Read `architecture/README.md`, `architecture/contracts.md` (CT-1, CT-3, CT-7), `architecture/decisions.md` (AD-20, AD-21, AD-22), `architecture/program.md` (MR-3) and `architecture/conventions.md` first. Plan 1 (`docs/superpowers/plans/2026-09-18-engine-value-layer.md`) built what this plan stands on.

**Provenance:** every code block below was built and run before this plan was written, in a scratch copy of the repository against the real Python core and the repository's own pixi environments; the blocks were then generated from those files, not retyped. The tasks were replayed in order in a second clean copy: each failing step failed as stated, each passing step passed, `tsc` (both projects), eslint, prettier, ruff, mypy and pyright were clean at every task boundary, and the final tree was identical to the scratch copy. Task 0's formatter run was observed on a clean copy of `HEAD` (exactly eight files, 67 lines, the Python suite unchanged). End state: 135 engine tests in 25 files, 2,429 Python tests (34 deselected), fixtures current. At model M (170,340 elements / 126,820 relationships, the smart-city metamodel, natively parsed input, one pass): bulk load ≈ 0.45 s, index rebuild ≈ 0.6 s; Python v2 encode 1.7 s against 1.0 s for v1, decode 1.9 s against 1.5 s, blob size equal. If a step's expected result does not appear, suspect the environment before the code.

## What the oracle taught this plan

Each of these refines the spec; the spec file was updated to match. Review them before executing.

1. **On a property-name clash the ancestor wins.** The spec said "child overrides by name". `_effective_props` (`core/metamodel/schema.py`) walks root → leaf and keeps the FIRST definition of a name, so a redeclared property keeps the ancestor's datatype, multiplicity and position; the comment above it says the opposite. `check_metamodel` does not forbid redeclaring. The engine mirrors the code (fixture `metamodel_caches`, type `Mid`). Keys do resolve nearest-first, and `key: []` counts as declared. Logged as `C-20` in Task 8; frozen under MR-3.
2. **The engine never mints ids**, so `createElement(typeName, id)` and `connect(relType, sourceId, targetId, id)` take one and refuse an id in use with `restore_*`'s text. The golden runner mints `id-N` the way `SequentialIdGenerator` does — a failed call consumes no id there, which the fixtures prove.
3. **The bulk loader is stricter than the oracle in two places**, both with their own texts and unit tests: an id shared by an element and a relationship (Python's loader checks each kind alone, though its mutation boundary and the digest treat ids as one namespace — logged as `K-29`), and an array-index property key (`"0"`, `"42"`), refused at ANY depth of the properties, not only at the top. It matches the oracle everywhere else, including a refusal the spec did not list: an abstract element type, even when loading non-strict.
4. **Records carry index-owned fields** beyond the spec's list: `uniq` and `rootName` on `ElementRec`; `outAt` / `inAt` on `RelRec`. The positions make removing an edge O(1) — without them deleting a container of 100k children is quadratic, where Python's sets are linear.
5. **Uniqueness buckets** are `Map<hash, ElementRec | Set<ElementRec>>`: a lone element is stored bare (the common case costs no collection), and queries confirm candidates by exact `pyKey` text. Every step scenario also runs with `hashKey: () => 0`, which forces every key into one bucket.
6. **`verifyConsistent` rebuilds in place.** Adjacency lives on the records, so there is no second index set to build beside the first; it dumps, rebuilds, dumps again and compares, after checking the invariants a dump cannot show. A consistent model is left as it was.
7. **Fixtures stay small by fingerprint.** A full state-plus-index dump after each of 445 steps would be ≈ 1 MB. Each changed step records the digest and a 16-hex SHA-256 fingerprint of the entity lines plus the index-dump text; every fifth step (every fortieth in the random walk) and the last carry both in full, so a failure can be read and not merely seen. The fingerprint makes `pyDumps(dumpIndexes(model))` byte-identical to Python's `json.dumps` of its own dump.
8. **`decode_snapshot` tells v2 by its first bytes** (`{"format":"datarover.snapshot/v2"`): in a compact v1 blob the "first line" is the whole document, so parsing it to sniff would parse everything twice. v2 decodes to the same `{"elements", "relationships"}` document, and a line count that disagrees with the header is a `ValueError`. Every line ends with LF, the last included. Both facts go into CT-1 in Task 2.
9. **`Multiplicity.parse` accepts what Python's `int()` accepts** — a sign, inner underscores (`1_0`), surrounding spaces, `-1`, `3..1` — and the engine follows, with one documented gap: non-ASCII digits, which `int()` reads and the engine refuses.

## Global Constraints

- Everything runs through pixi. There is no global `python` or `node`: use `pixi run <task>`, `pixi run -e core-dev ...`, `pixi run -e frontend ...`. The system `node` is too old for the tooling.
- Work on branch `feat/engine-store`, cut from `engine-migration` (the integration branch that holds plan 1; Task 0 cuts it) and merged back into it when the plan is done. Do not touch `main`.
- **Freeze rule (MR-3):** from this plan on, no behaviour change in `src/data_rover/core/model`, `src/data_rover/core/metamodel` or the model-op applier. This plan changes none of them. If the port exposes an oracle bug, stop and raise it: a fix lands on both sides with a fixture, never on one.
- The Python core is the oracle. When a golden test fails, the engine is wrong — never edit a fixture by hand, never loosen a scenario to make a test pass. Fixtures change only through `pixi run golden-fixtures`.
- The server's snapshot writers keep emitting v1. Do not call `encode_snapshot_v2` from `hydration.py`, `snapshot_job.py` or any route: that switch belongs to sub-project B.
- `engine/src/` uses no DOM API and no Node built-in (`lib: ["ES2023"]`, `types: []`). Tests may import `node:*`.
- TypeScript is erasable syntax only: no parameter properties, no enums, no namespaces. Import specifiers end in `.ts`. No `any` in an exported signature. No `Date.now`, `Math.random`, `Intl` or locale comparison in `src/` — `shuffleAdjacency` takes its randomness as an argument.
- Adjacency arrays and sets have no specified order. Anything observable sorts, by code point (`cmpCodePoint`), never with a bare `.sort()` on text that may hold non-ASCII.
- Read a property with `getProp` / `Object.hasOwn`, never `props[name]` for a name that comes from data: `constructor` and `__proto__` are legal property names.
- Formatting: tabs, single quotes, no trailing commas, width 100 (prettier, run through `pixi run engine-tidy`); Python is ruff-formatted.
- Comments and docstrings are concise and present-tense, only for what the code cannot say. No references to specs, plans, phases or `architecture/` ids in code.
- Code blocks hold unicode escapes (a backslash, `u` and four hex digits, or `U` and eight). Write them as escapes. If your tooling turns them into literal characters the strings are the same, but U+E000, U+FFFF and U+2028 become invisible. Check with `LC_ALL=C grep -rnP '[^[:ascii:]]' tests/golden engine/test`: only `café` in `engine/test/value/serialize.test.ts` may show.
- Commit subjects: one imperative sentence, capitalized, no prefix, no trailing period.

## File Structure

```
src/data_rover/api/state_digest.py        entity_hash, format_digest, model_digest
src/data_rover/api/serialize.py           + iter_entity_lines
src/data_rover/api/snapshot_codec.py      + encode_snapshot_v2, v2 branch of decode_snapshot
tests/api/test_state_digest.py            new
tests/api/test_snapshot_codec.py          + v2 tests

tests/golden/index_dump.py                dump_indexes: the canonical index dump
tests/golden/model_steps.py               Recorder, run_steps, observe, fingerprint, set_property
tests/golden/scenarios/metamodel_caches.py
tests/golden/scenarios/model_mutations.py   every boundary method, every error text
tests/golden/scenarios/model_cascades.py    delete_element through containment
tests/golden/scenarios/model_indexes.py     roots, uniqueness, owners, references, state order
tests/golden/scenarios/model_churn.py       a seeded random walk
tests/golden/scenarios/model_load.py        bulk load: what loads, every refusal text
tests/golden/scenarios/smart_city.py        the example model, loaded
tests/golden/scenarios/snapshot_v2.py       a v2 text and what it holds

engine/src/metamodel/types.ts             the GET /metamodel document's shapes
engine/src/metamodel/multiplicity.ts      Multiplicity
engine/src/metamodel/key.ts               KeyRel, KeySpec, parseKeyEntry, parseKey
engine/src/metamodel/metamodel.ts         Metamodel, EndConstraint
engine/src/model/errors.ts                ModelError, SnapshotError
engine/src/model/records.ts               ElementRec, RelRec, Props, getProp, setProp
engine/src/model/naming.ts                nameOf, displayName
engine/src/model/hash.ts                  hashKey
engine/src/model/root-order.ts            RootOrder
engine/src/model/indexes.ts               IndexSet
engine/src/model/model.ts                 Model, ModelOptions
engine/src/model/lines.ts                 elementLine, relationshipLine, modelLines
engine/src/model/load.ts                  shape checks of the bulk loader
engine/src/debug/dump-indexes.ts          dumpIndexes, IndexDump
engine/src/debug/shuffle-adjacency.ts     shuffleAdjacency
engine/src/debug/verify-consistent.ts     verifyConsistent

engine/test/golden/thrown.ts              thrown(fn)
engine/test/golden/digest.ts              stateDigest on node:crypto
engine/test/golden/model-steps.ts         replaySteps, observe, fingerprint, seededRandom
engine/test/golden/model-load.ts          loadLines
engine/test/metamodel/, engine/test/model/, engine/test/debug/   tests
engine/fixtures/golden/*.json             generated — never edited by hand
```

---

### Task 0: Housekeeping the owner asked for

Two commits that are not this plan's subject but were decided while it was reviewed (owner, 2026-09-18): apply the formatter to the files that drifted, and track the spike that `architecture/constraints.md` cites as its raw evidence. They come first so that `pixi run dr-tidy` is quiet for the rest of the plan.

**Files:**
- Modify (formatter only): `src/data_rover/api/content.py`, `src/data_rover/api/routes/exports.py`, `src/data_rover/api/routes/snippets.py`, `src/data_rover/api/serialize.py`, `src/data_rover/api/table_export_engine.py`, `src/data_rover/core/table/cells.py`, `src/data_rover/core/table/evaluate.py`, `src/data_rover/core/table/virtual_props.py`
- Add (already on disk, untracked): `spikes/client_engine/`

**Interfaces:**
- Produces: nothing a later task consumes. None of the eight files is under the freeze rule, and a formatter run changes no behaviour.

- [ ] **Step 1: Cut the branch**

```bash
git switch engine-migration
git switch -c feat/engine-store
```

- [ ] **Step 2: Apply the formatter**

Run: `pixi run core-format`
Expected: `3 files reformatted, 67 files left unchanged`.

Run: `pixi run backend-format`
Expected: `5 files reformatted, 71 files left unchanged`.

Run: `git status --short`
Expected: exactly the eight files above as ` M`, plus `?? spikes/client_engine/`. `git diff --stat` shows 67 changed lines, all whitespace and line wrapping.

- [ ] **Step 3: Confirm nothing moved, commit**

Run: `pixi run core-test`
Expected: PASS — 2,414 passed, 34 deselected.

```bash
git add src
git commit -m "Apply the formatter to the files that drifted"
```

- [ ] **Step 4: Track the spike**

`spikes/client_engine/` is 24 files, ≈ 200 KB: the replica sources (`js-replica.mjs`, `rust_replica/`), the harness, `FINDINGS.md` and `results/*.json`. It holds no binaries and nothing generated. It stays throwaway (MR-5): nothing in it is imported by the engine.

Run: `git status --short --ignored spikes/client_engine`
Expected: the single line `?? spikes/client_engine/` — nothing inside it is ignored.

```bash
git add spikes/client_engine
git commit -m "Track the client-engine spike behind the measured constraints"
```

---

### Task 1: The state digest

**Files:**
- Create: `src/data_rover/api/state_digest.py`
- Test: `tests/api/test_state_digest.py`

**Interfaces:**
- Produces: `entity_hash(entity_id: str, rev: int) -> int` — the first 8 bytes, big-endian, of SHA-256 over `utf8(id)`, one `0x00` byte, `ascii(decimal rev)`; `format_digest(value: int) -> str` — 16 lower-case hex digits; `model_digest(model: Model) -> str` — the XOR over every element and relationship, formatted. An empty model's digest is `"0000000000000000"`.

- [ ] **Step 1: Write the failing test**

`tests/api/test_state_digest.py`:

```python
"""The state digest: pinned vectors, order independence, O(batch) upkeep."""

from __future__ import annotations

import zlib

from data_rover.api.state_digest import entity_hash, format_digest, model_digest
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.ids import SequentialIdGenerator
from data_rover.core.model.model import Model

MM_YAML = """
elements:
  - name: Node
    properties:
      - {name: name, datatype: string}
relationships:
  - {name: Link, source: Node, target: Node}
"""


def _model() -> Model:
    model = Model(load_metamodel_str(MM_YAML), SequentialIdGenerator())
    a = model.create_element("Node")
    b = model.create_element("Node")
    model.set_property(a, "name", "A")
    model.connect("Link", a.id, b.id)
    return model


def test_entity_hash_vectors() -> None:
    # The engine reproduces these; they pin the byte layout, not just the idea.
    vectors = [
        ("id-1", 0, "b83d885159d11dd4"),
        ("id-1", 1, "14d07545607c068e"),
        ("", 0, "db3426e878068d28"),
        ("caf\u00e9", 12, "c9524fe14dc453b5"),
        ("\U0001f600", 3, "7907ed2f4cfeac90"),
    ]
    for entity_id, rev, expected in vectors:
        assert format_digest(entity_hash(entity_id, rev)) == expected


def test_format_is_sixteen_lower_case_hex_digits() -> None:
    assert format_digest(0) == "0000000000000000"
    assert format_digest(0xAB) == "00000000000000ab"
    assert format_digest(2**64 - 1) == "ffffffffffffffff"


def test_empty_model_digest_is_zero() -> None:
    assert model_digest(Model(load_metamodel_str(MM_YAML))) == "0000000000000000"


def test_model_digest_covers_elements_and_relationships() -> None:
    model = _model()
    # id-1 was written once (rev 1); id-2 and the relationship id-3 never.
    expected = entity_hash("id-1", 1) ^ entity_hash("id-2", 0) ^ entity_hash("id-3", 0)
    assert model_digest(model) == format_digest(expected)


def test_digest_ignores_entity_order() -> None:
    model = _model()
    before = model_digest(model)
    model.elements = dict(reversed(list(model.elements.items())))
    assert model_digest(model) == before


def test_digest_is_maintainable_per_entity() -> None:
    model = _model()
    value = int(model_digest(model), 16)
    element = model.get_element("id-2")
    old_rev = element.rev
    model.set_property(element, "name", "B")
    value ^= entity_hash(element.id, old_rev) ^ entity_hash(element.id, element.rev)
    assert format_digest(value) == model_digest(model)


def test_digest_sees_two_ids_exchanging_revs() -> None:
    swapped = entity_hash("a", 2) ^ entity_hash("b", 10)
    assert entity_hash("a", 10) ^ entity_hash("b", 2) != swapped

    # The reason the per-entity hash is not a CRC: folded with XOR, a linear
    # checksum gives both states the same digest.
    def crc(entity_id: str, rev: int) -> int:
        return zlib.crc32(entity_id.encode() + b"\x00" + str(rev).encode())

    assert crc("a", 1) ^ crc("b", 2) == crc("a", 2) ^ crc("b", 1)
```

- [ ] **Step 2: Run it to see it fail**

Run: `pixi run -e core-dev pytest tests/api/test_state_digest.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'data_rover.api.state_digest'`.

- [ ] **Step 3: Implement**

`src/data_rover/api/state_digest.py`:

```python
"""State digest: an order-independent 64-bit hash over every ``(id, rev)`` pair.

Two replicas of one project hold the same committed state exactly when their
digests match: an entity a replica misses, holds twice over or holds at the
wrong ``rev`` changes the XOR. The per-entity hash has to be non-linear — an
XOR fold of a linear checksum (CRC32) cannot see two same-length ids
exchanging their ``rev``s.
"""

from __future__ import annotations

import hashlib

from data_rover.core.model.model import Model


def entity_hash(entity_id: str, rev: int) -> int:
    """First 8 bytes of SHA-256 over ``utf8(id) ‖ 0x00 ‖ ascii(decimal rev)``.

    Elements and relationships share one id namespace, so one function serves
    both. XOR a pair out and its successor in to maintain a digest in O(batch).
    """
    data = entity_id.encode("utf-8") + b"\x00" + str(rev).encode("ascii")
    return int.from_bytes(hashlib.sha256(data).digest()[:8], "big")


def format_digest(value: int) -> str:
    """The wire form: 16 lower-case hex digits."""
    return f"{value:016x}"


def model_digest(model: Model) -> str:
    """The digest of every element and relationship, by full recomputation."""
    value = 0
    for element in model.elements.values():
        value ^= entity_hash(element.id, element.rev)
    for rel in model.relationships.values():
        value ^= entity_hash(rel.id, rel.rev)
    return format_digest(value)
```

- [ ] **Step 4: Run the test**

Run: `pixi run -e core-dev pytest tests/api/test_state_digest.py -q`
Expected: PASS — 7 passed.

- [ ] **Step 5: Format and commit**

Run: `pixi run -e core-dev ruff format src/data_rover/api/state_digest.py tests/api/test_state_digest.py && pixi run -e core-dev ruff check src/data_rover/api/state_digest.py tests/api/test_state_digest.py`
Expected: `2 files left unchanged`, `All checks passed!`

```bash
git add src/data_rover/api/state_digest.py tests/api/test_state_digest.py
git commit -m "Add the state digest over every entity id and rev"
```

---

### Task 2: The snapshot v2 codec

**Files:**
- Modify: `src/data_rover/api/serialize.py` (insert above `iter_buffered`)
- Modify: `src/data_rover/api/snapshot_codec.py` (whole file)
- Modify: `architecture/contracts.md` (CT-1)
- Test: `tests/api/test_snapshot_codec.py` (the import block; new tests appended)

**Interfaces:**
- Consumes: `model_digest` from Task 1.
- Produces: `serialize.iter_entity_lines(model: Model) -> Iterator[str]` — one compact JSON object per entity, elements then relationships, insertion order, no terminator; each line is byte-identical to that entity's text inside `iter_model_json_compact`. `snapshot_codec.SNAPSHOT_V2_FORMAT = "datarover.snapshot/v2"`. `snapshot_codec.encode_snapshot_v2(model, *, project_id: str, rev: int, metamodel_id: str) -> Iterator[bytes]` — one gzip member: the header line, then every entity line, each ending with LF. `decode_snapshot(blob)` now also reads v2 and returns the same `{"elements": [...], "relationships": [...]}` document as for v1; a v2 blob whose line count disagrees with its header raises `ValueError`.
- Header, keys in this order: `format`, `project_id`, `rev`, `metamodel_id`, `elements`, `relationships`, `state_digest`.

- [ ] **Step 1: Write the failing tests**

In `tests/api/test_snapshot_codec.py`, replace the import block (from `import gzip` down to the `from data_rover.core.model.model import Model` line) with:

```python
import gzip
import json
from pathlib import Path

import pytest

from data_rover.api.routes._snapshot import build_model_from_dicts
from data_rover.api.serialize import (
    iter_entity_lines,
    iter_model_json,
    iter_model_json_compact,
)
from data_rover.api.snapshot_codec import (
    SNAPSHOT_V2_FORMAT,
    decode_snapshot,
    encode_snapshot,
    encode_snapshot_v2,
    is_gzip,
)
from data_rover.api.state_digest import model_digest
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
```

Append to the end of the same file:

```python
# --- v2: a header line, then one line per entity ---------------------------


def _v2_blob(model: Model, rev: int = 7) -> bytes:
    return b"".join(
        encode_snapshot_v2(model, project_id="p1", rev=rev, metamodel_id="mm-1")
    )


def _v2_text(model: Model) -> str:
    return gzip.decompress(_v2_blob(model)).decode("utf-8")


def test_v2_is_a_gzip_member_of_a_header_and_entity_lines() -> None:
    model = _example_model()
    assert is_gzip(_v2_blob(model))
    text = _v2_text(model)
    assert text.endswith("\n")
    header, *lines = text.split("\n")[:-1]
    assert header == (
        '{"format":"datarover.snapshot/v2","project_id":"p1","rev":7,'
        '"metamodel_id":"mm-1","elements":1002,"relationships":746,'
        f'"state_digest":"{model_digest(model)}"}}'
    )
    assert json.loads(header)["format"] == SNAPSHOT_V2_FORMAT
    assert lines == list(iter_entity_lines(model))
    assert len(lines) == 1002 + 746


def test_v2_lines_are_the_compact_documents_entities() -> None:
    model = _example_model()
    lines = list(iter_entity_lines(model))
    n = len(model.elements)
    document = (
        '{"elements":['
        + ",".join(lines[:n])
        + '],"relationships":['
        + ",".join(lines[n:])
        + "]}"
    )
    assert document == "".join(iter_model_json_compact(model))


def test_v2_decodes_to_the_v1_document() -> None:
    model = _example_model()
    assert decode_snapshot(_v2_blob(model)) == _document(model)
    # The decoder sniffs the bytes, so an uncompressed v2 text loads too.
    assert decode_snapshot(gzip.decompress(_v2_blob(model))) == _document(model)


def test_v2_roundtrip_rebuilds_the_same_state() -> None:
    model = _example_model()
    rebuilt = build_model_from_dicts(
        load_metamodel_str(MM_YAML), decode_snapshot(_v2_blob(model)), strict=False
    )
    assert list(iter_entity_lines(rebuilt)) == list(iter_entity_lines(model))
    assert model_digest(rebuilt) == model_digest(model)


def test_v2_empty_model_is_a_lone_header() -> None:
    model = Model(load_metamodel_str(MM_YAML))
    assert _v2_text(model) == (
        '{"format":"datarover.snapshot/v2","project_id":"p1","rev":7,'
        '"metamodel_id":"mm-1","elements":0,"relationships":0,'
        '"state_digest":"0000000000000000"}\n'
    )
    assert decode_snapshot(_v2_blob(model)) == {"elements": [], "relationships": []}


def test_v2_keeps_every_value_exact_and_on_one_line() -> None:
    mm = load_metamodel_str(MM_YAML)
    model = Model(mm)
    et = next(t.name for t in mm.elements if not t.abstract)
    properties = {
        "big": 2**63 + 1,
        "whole_float": 1.0,
        "tiny": 1e-07,
        "infinity_token": "Infinity",
        "text": "line one\nline two\r\ttab \u2028 caf\u00e9 \U0001f600",
        "nested": {"b": [1, 1.0, True, None], "a": {}},
    }
    model.elements["e1"] = Element(id="e1", type_name=et, properties=properties, rev=3)
    model.indexes.rebuild()
    text = _v2_text(model)
    assert text.count("\n") == 2  # the header and one entity: no raw LF inside a line
    decoded = decode_snapshot(_v2_blob(model))
    assert decoded["elements"][0]["properties"] == properties
    assert isinstance(decoded["elements"][0]["properties"]["whole_float"], float)
    assert decoded["elements"][0]["rev"] == 3


def test_v2_decode_rejects_a_truncated_blob() -> None:
    text = _v2_text(_example_model())
    cut = text[: text.rindex("\n", 0, len(text) - 1) + 1]  # drop the last entity
    with pytest.raises(ValueError, match="1747 entity lines"):
        decode_snapshot(cut.encode("utf-8"))


def test_v2_decode_rejects_a_header_without_counts() -> None:
    blob = b'{"format":"datarover.snapshot/v2","elements":"1","relationships":0}\n'
    with pytest.raises(ValueError, match="no valid entity counts"):
        decode_snapshot(blob)
```

- [ ] **Step 2: Run them to see them fail**

Run: `pixi run -e core-dev pytest tests/api/test_snapshot_codec.py -q`
Expected: FAIL — `ImportError: cannot import name 'iter_entity_lines' from 'data_rover.api.serialize'`.

- [ ] **Step 3: Add the line writer**

In `src/data_rover/api/serialize.py`, insert above `def iter_buffered(`:

```python
_LINE_ENCODER = json.JSONEncoder(
    separators=_COMPACT_SEPARATORS, ensure_ascii=False, allow_nan=False
)


def iter_entity_lines(model: Model) -> Iterator[str]:
    """Yield one compact JSON object per entity — every element, then every
    relationship, in insertion order — with no line terminator.

    Each line is byte-identical to that entity's text inside
    ``iter_model_json_compact``. ``json.dumps`` escapes every control
    character, so a line never holds a raw LF. Same point-in-time semantics
    as ``iter_model_json``.
    """
    encode = _LINE_ENCODER.encode
    for entity in _element_dicts(list(model.elements.values())):
        yield encode(entity)
    for entity in _relationship_dicts(list(model.relationships.values())):
        yield encode(entity)
```

- [ ] **Step 4: Add the v2 encoder and the decoder branch**

`src/data_rover/api/snapshot_codec.py` (whole file; `encode_snapshot` keeps its bytes, its body moves into `_gzip_member`):

```python
"""Snapshot blob formats: gzip members of the model, as one document or as lines.

The ONE place that knows what bytes the ``SnapshotStore`` holds. Writers
stream ``encode_snapshot`` into ``store.put``; readers hand whatever
``store.get`` returned to ``decode_snapshot``. The decoder branches on the
bytes (the gzip magic, then the header line) — never on the key — so a row
written before compression (indented JSON under a ``.json`` key) keeps
loading, and a test that puts plain JSON under a ``.json.gz`` key loads too.

Two formats share the gzip framing. v1 is the compact ``{"elements",
"relationships"}`` document and is what every writer emits. v2
(``datarover.snapshot/v2``) is line-delimited — a header line, then one line
per entity in insertion order — so a reader can parse while bytes arrive.
"""

from __future__ import annotations

import gzip
import json
import zlib
from collections.abc import Iterable, Iterator
from typing import Any

from data_rover.core.model.model import Model

from .serialize import (
    iter_buffered,
    iter_entity_lines,
    iter_model_json_compact,
    parse_model_json,
)
from .state_digest import model_digest

#: deflate level. 3 is the knee on the compact document: level 6 doubles the
#: encode time for ~15 % fewer bytes, level 1 saves ~10 % time for ~15 % more.
SNAPSHOT_GZIP_LEVEL = 3
#: the ``format`` value of a v2 header line
SNAPSHOT_V2_FORMAT = "datarover.snapshot/v2"
#: RFC 1952 member header
_GZIP_MAGIC = b"\x1f\x8b"
#: how every v2 blob starts once inflated: the header is written compact with
#: ``format`` as its first key, so the prefix identifies the format without
#: parsing a line that, in a v1 blob, is the whole document
_V2_PREFIX = b'{"format":"' + SNAPSHOT_V2_FORMAT.encode("ascii") + b'"'
#: compact text buffered per ``compress()`` call — one deflate input per
#: ~1 MiB of JSON keeps the call count in the hundreds on a 300 MB model
_COMPRESS_CHUNK_CHARS = 1 << 20
#: 16 + MAX_WBITS = write a gzip member (header + CRC trailer), not raw zlib
_GZIP_WBITS = 16 + zlib.MAX_WBITS


def _gzip_member(chunks: Iterable[str]) -> Iterator[bytes]:
    comp = zlib.compressobj(SNAPSHOT_GZIP_LEVEL, zlib.DEFLATED, _GZIP_WBITS)
    for text in iter_buffered(chunks, _COMPRESS_CHUNK_CHARS):
        out = comp.compress(text.encode("utf-8"))
        if out:
            yield out
    yield comp.flush()


def encode_snapshot(model: Model) -> Iterator[bytes]:
    """Stream the model as one gzip member of its compact JSON document.

    Peak extra memory is one text chunk plus the deflate window; the model
    itself is never materialized as a string.
    """
    return _gzip_member(iter_model_json_compact(model))


def _v2_lines(
    model: Model, project_id: str, rev: int, metamodel_id: str
) -> Iterator[str]:
    header = {
        "format": SNAPSHOT_V2_FORMAT,
        "project_id": project_id,
        "rev": rev,
        "metamodel_id": metamodel_id,
        "elements": len(model.elements),
        "relationships": len(model.relationships),
        "state_digest": model_digest(model),
    }
    yield (
        json.dumps(header, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        + "\n"
    )
    for line in iter_entity_lines(model):
        yield line + "\n"


def encode_snapshot_v2(
    model: Model, *, project_id: str, rev: int, metamodel_id: str
) -> Iterator[bytes]:
    """Stream the model as one gzip member of LF-terminated JSON lines: the
    header, then every element, then every relationship, in insertion order.

    The header's counts and digest are taken when iteration starts; the caller
    holds the model still (the write mutex) for the whole stream, as the
    digest is only meaningful for the entities that follow it.
    """
    return _gzip_member(_v2_lines(model, project_id, rev, metamodel_id))


def is_gzip(blob: bytes) -> bool:
    return blob[:2] == _GZIP_MAGIC


def _decode_v2(blob: bytes) -> dict[str, Any]:
    header_line, _, body = blob.partition(b"\n")
    header = json.loads(header_line)
    elements, relationships = header.get("elements"), header.get("relationships")
    for count in (elements, relationships):
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise ValueError("snapshot v2 header carries no valid entity counts")
    lines = body.split(b"\n")
    if lines[-1] == b"":
        lines.pop()
    if len(lines) != elements + relationships:
        raise ValueError(
            f"snapshot v2 holds {len(lines)} entity lines, its header promises "
            f"{elements} + {relationships}"
        )
    # One parse of the joined lines: a json.loads per line costs several
    # times more on a large model.
    entities = parse_model_json(b"[" + b",".join(lines) + b"]")
    return {
        "elements": entities[:elements],
        "relationships": entities[elements:],
    }


def decode_snapshot(blob: bytes) -> Any:
    """Parse a stored snapshot blob — compressed or plain, v1 or v2 — into the
    ``{"elements", "relationships"}`` document ``build_model_from_dicts`` reads.

    A v2 blob whose line count disagrees with its header (a truncated or
    corrupted object) raises ``ValueError``.
    """
    if is_gzip(blob):
        blob = gzip.decompress(blob)
    if blob.startswith(_V2_PREFIX):
        return _decode_v2(blob)
    return parse_model_json(blob)
```

- [ ] **Step 5: Run the tests, with their neighbours**

Run: `pixi run -e core-dev pytest tests/api/test_snapshot_codec.py tests/api/test_state_digest.py tests/api/test_serialize_compact.py tests/api/test_hydration.py -q`
Expected: PASS — 40 passed (15 of them in `test_snapshot_codec.py`).

- [ ] **Step 6: Record the two format facts in CT-1**

In `architecture/contracts.md`, under `## CT-1`, replace the first two bullets (from `- One gzip member` through the header line's closing `` `{"format":…"state_digest"}`. ``) with:

```markdown
- One gzip member, UTF-8, one compact JSON object per line (`separators=(",", ":")`,
  `ensure_ascii=False`, `allow_nan=False`). Every line, the last included, ends with LF. A
  writer escapes every control character, so LF never occurs inside a line; a reader MUST
  split on LF alone (U+2028 and U+2029 occur raw).
- Line 1 is the header, its keys in this order:
  `{"format":"datarover.snapshot/v2","project_id","rev","metamodel_id","elements":<count>,"relationships":<count>,"state_digest"}`.
  `format` comes first, so the inflated bytes of every v2 snapshot start with
  `{"format":"datarover.snapshot/v2"` — that prefix is how a reader tells v2 from v1, whose
  first line may be the whole document.
```

- [ ] **Step 7: Format, type-check, commit**

Run: `pixi run -e core-dev ruff format src/data_rover/api/serialize.py src/data_rover/api/snapshot_codec.py tests/api/test_snapshot_codec.py`
Expected: `3 files left unchanged`.

Run: `pixi run backend-lint`
Expected: `All checks passed!`, `Success: no issues found in 77 source files`, `0 errors, 0 warnings, 0 informations`.

```bash
git add src/data_rover/api/serialize.py src/data_rover/api/snapshot_codec.py tests/api/test_snapshot_codec.py architecture/contracts.md
git commit -m "Encode and decode line-delimited v2 snapshots"
```

---

### Task 3: The metamodel

**Files:**
- Create: `tests/golden/scenarios/metamodel_caches.py`
- Modify: `tests/golden/scenarios/__init__.py`
- Create (generated): `engine/fixtures/golden/metamodel_caches.json`
- Create: `engine/src/metamodel/types.ts`, `engine/src/metamodel/multiplicity.ts`, `engine/src/metamodel/key.ts`, `engine/src/metamodel/metamodel.ts`
- Modify: `engine/src/index.ts`
- Test: `engine/test/golden/thrown.ts`, `engine/test/metamodel/metamodel.golden.test.ts`

**Interfaces:**
- Consumes: `pyRepr`, `cmpCodePoint`, `loadFixture` from plan 1.
- Produces (types, in the document's own field names): `PropertyDef {name, datatype, multiplicity, min, max, pattern, max_length}`, `Mapping {source, target}`, `ElementType {name, abstract, extends, properties, key}`, `RelationshipType {name, abstract, extends, containment, source, target, mappings, source_multiplicity, target_multiplicity, properties}`, `MetamodelDoc {enums, elements, relationships}`; `KeyRel {relType: string; direction: 'out' | 'in'}`, `KeySpec {properties: string[]; relationships: KeyRel[]}`; `EndConstraint {relTypeName: string; end: 'source' | 'target'; multiplicity: Multiplicity}`.
- Produces: `Metamodel.fromJSON(doc: MetamodelDoc): Metamodel` with fields `enums`, `elements`, `relationships` and the lookups `elementType(name): ElementType | undefined`, `isElementType(name): boolean`, `relationshipType(name): RelationshipType | undefined`, `elementAncestors(name): readonly string[]`, `relationshipAncestors(name)`, `isElementSubtype(sub, sup): boolean`, `isRelationshipSubtype(sub, sup)`, `effectiveElementProperties(name): readonly PropertyDef[]`, `effectiveElementPropertyNames(name): ReadonlySet<string>`, `effectiveElementKey(name): readonly string[] | null`, `effectiveElementKeySpec(name): KeySpec | null`, `effectiveRelationshipProperties(name)`, `effectiveRelationshipPropertyNames(name)`, `isContainment(relTypeName): boolean`, `endConstraints(typeName): readonly EndConstraint[]`, `elementDescendants(name): ReadonlySet<string>`, `relationshipDescendants(name)`, `relationshipTypesFrom(name): readonly string[]`, `relationshipTypesTo(name)`. An unknown name yields the empty answer, never an error. Returned arrays and sets are shared: do not mutate them.
- Produces: `Multiplicity {lower: number; upper: number | null; isSingle; required; countOk(count)}`, `Multiplicity.parse(spec): Multiplicity` (memoized; throws `RangeError('Invalid multiplicity: ' + pyRepr(trimmed spec))`); `parseKeyEntry(entry)`, `parseKey(entries): KeySpec`; test helper `thrown(fn: () => unknown): unknown`.

- [ ] **Step 1: Add the scenario**

`tests/golden/scenarios/metamodel_caches.py`:

```python
"""Every derived lookup of ``Metamodel``, over a metamodel built to hit the
corners: overrides, inherited and empty keys, inherited containment, binding
and non-binding multiplicities, a cycle, an unknown parent, a repeated name."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.multiplicity import Multiplicity
from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario

_METAMODEL = {
    "enums": {"Color": ["red", "green"]},
    "elements": [
        {
            "name": "Base",
            "abstract": True,
            "properties": [
                {"name": "name", "datatype": "string", "multiplicity": "1"},
                {"name": "shade", "datatype": "Color"},
            ],
            "key": ["name"],
        },
        {
            "name": "Mid",
            "extends": "Base",
            "properties": [
                {"name": "size", "datatype": "integer", "min": 0, "max": 10},
                # a redeclared name: the ancestor's definition stays in force
                {"name": "name", "datatype": "integer", "multiplicity": "0..*"},
            ],
        },
        {
            "name": "Leaf",
            "extends": "Mid",
            "properties": [{"name": "buddy", "datatype": "Leaf"}],
            "key": ["size", "out:Links", "in:Holds", "out:"],
        },
        {"name": "Keyless", "properties": [{"name": "note", "datatype": "string"}]},
        {"name": "EmptyKey", "extends": "Base", "key": []},
        {"name": "Orphan", "extends": "Missing"},
        {
            "name": "LoopA",
            "extends": "LoopB",
            "properties": [{"name": "a", "datatype": "string"}],
        },
        {
            "name": "LoopB",
            "extends": "LoopA",
            "properties": [{"name": "b", "datatype": "string"}],
        },
        {"name": "Selfish", "extends": "Selfish"},
        # a repeated name: the first declaration wins every lookup
        {"name": "Keyless", "properties": [{"name": "ignored", "datatype": "string"}]},
    ],
    "relationships": [
        {
            "name": "Holds",
            "containment": True,
            "abstract": True,
            "properties": [{"name": "since", "datatype": "date"}],
        },
        {
            "name": "Owns",
            "extends": "Holds",
            "source": "Base",
            "target": "Mid",
            "source_multiplicity": "0..1",
            "target_multiplicity": "0..*",
        },
        {
            "name": "Links",
            "mappings": [
                {"source": "Leaf", "target": "Keyless"},
                {"source": "Keyless", "target": "Leaf"},
            ],
            "source_multiplicity": "1..*",
            "target_multiplicity": "2",
            "properties": [{"name": "weight", "datatype": "float"}],
        },
        {"name": "Loose", "source": "Base", "target": "Base"},
        {
            "name": "Broken",
            "source": "Mid",
            "target": "Mid",
            "source_multiplicity": "many",
            "target_multiplicity": "1..1",
        },
        {"name": "Unmapped", "source_multiplicity": "1", "target_multiplicity": "1"},
        {"name": "RelLoop", "extends": "RelLoop", "source": "LoopA", "target": "LoopB"},
        # a repeated name still contributes its own mappings and constraints
        {
            "name": "Loose",
            "source": "Keyless",
            "target": "Keyless",
            "target_multiplicity": "0..3",
        },
    ],
}

_MULTIPLICITIES = [
    "1", "0..1", "0..*", "*", "1..*", " 2 .. 5 ", "+1", "1_0", "1..1_000", "-1", "-0", "00",
    "3..1", "* ", " * ", "1 ..*", "0.. *", "", "a", "1..", "..1", "1..2..3", "1.5",
    "0x1", "1__0", "_1", "1_", "many", "'",
]  # fmt: skip


def _props(props: list[Any]) -> list[list[str]]:
    return [[p.name, p.datatype, p.multiplicity] for p in props]


def _multiplicity(spec: str) -> dict[str, Any]:
    try:
        parsed = Multiplicity.parse(spec)
    except ValueError as exc:
        return {"spec": spec, "error": exc.args[0]}
    return {
        "spec": spec,
        "lower": parsed.lower,
        "upper": parsed.upper,
        "is_single": parsed.is_single,
        "required": parsed.required,
        "count_ok": [parsed.count_ok(n) for n in range(4)],
    }


@scenario("metamodel_caches")
def metamodel_caches() -> Any:
    mm = Metamodel.model_validate(_METAMODEL)
    element_names = [t.name for t in mm.elements] + ["Missing"]
    relationship_names = [t.name for t in mm.relationships] + ["Missing"]

    def element(name: str) -> dict[str, Any]:
        found = mm.element_type(name)
        spec = mm.effective_element_key_spec(name)
        return {
            "name": name,
            "is_element_type": mm.is_element_type(name),
            "own_properties": None if found is None else _props(found.properties),
            "ancestors": mm.element_ancestors(name),
            "properties": _props(mm.effective_element_properties(name)),
            "property_names": sorted(mm.effective_element_property_names(name)),
            "key": mm.effective_element_key(name),
            "key_spec": None
            if spec is None
            else {
                "properties": list(spec.properties),
                "relationships": [
                    [r.rel_type, r.direction] for r in spec.relationships
                ],
            },
            "end_constraints": [
                [c.rel_type_name, c.end, c.multiplicity.lower, c.multiplicity.upper]
                for c in mm.end_constraints(name)
            ],
            "descendants": sorted(mm.element_descendants(name)),
            "from": mm.relationship_types_from(name),
            "to": mm.relationship_types_to(name),
            "supertypes": [s for s in element_names if mm.is_element_subtype(name, s)],
        }

    def relationship(name: str) -> dict[str, Any]:
        found = mm.relationship_type(name)
        return {
            "name": name,
            "own_mappings": None
            if found is None
            else [[m.source, m.target] for m in found.mappings],
            "ancestors": mm.relationship_ancestors(name),
            "properties": _props(mm.effective_relationship_properties(name)),
            "property_names": sorted(mm.effective_relationship_property_names(name)),
            "containment": mm.is_containment(name),
            "descendants": sorted(mm.relationship_descendants(name)),
            "supertypes": [
                s for s in relationship_names if mm.is_relationship_subtype(name, s)
            ],
        }

    return {
        "metamodel": mm.model_dump(mode="json"),
        "elements": [element(name) for name in element_names],
        "relationships": [relationship(name) for name in relationship_names],
        "multiplicities": [_multiplicity(spec) for spec in _MULTIPLICITIES],
    }
```

`tests/golden/scenarios/__init__.py` (whole file):

```python
"""Importing this package registers every scenario."""

from . import (  # noqa: F401
    float_repr,
    frozen_groups,
    json_dumps,
    json_parse,
    metamodel_caches,
    py_repr,
    string_order,
)
```

Run: `pixi run golden-fixtures`
Expected: `engine/fixtures/golden/metamodel_caches.json` appears (≈ 24 KB).

- [ ] **Step 2: Write the failing test**

`engine/test/golden/thrown.ts`:

```ts
/** What `fn` throws, or `undefined`: lets a test check the error's class and its exact text. */
export function thrown(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	return undefined;
}
```

`engine/test/metamodel/metamodel.golden.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cmpCodePoint, Metamodel, Multiplicity, type MetamodelDoc } from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { thrown } from '../golden/thrown.ts';

type PropRow = [name: string, datatype: string, multiplicity: string];

type ElementCase = {
	name: string;
	is_element_type: boolean;
	own_properties: PropRow[] | null;
	ancestors: string[];
	properties: PropRow[];
	property_names: string[];
	key: string[] | null;
	key_spec: { properties: string[]; relationships: [string, 'out' | 'in'][] } | null;
	end_constraints: [string, 'source' | 'target', number, number | null][];
	descendants: string[];
	from: string[];
	to: string[];
	supertypes: string[];
};

type RelationshipCase = {
	name: string;
	own_mappings: [string, string][] | null;
	ancestors: string[];
	properties: PropRow[];
	property_names: string[];
	containment: boolean;
	descendants: string[];
	supertypes: string[];
};

type MultiplicityCase =
	| { spec: string; error: string }
	| {
			spec: string;
			lower: number;
			upper: number | null;
			is_single: boolean;
			required: boolean;
			count_ok: boolean[];
	  };

type Fixture = {
	metamodel: MetamodelDoc;
	elements: ElementCase[];
	relationships: RelationshipCase[];
	multiplicities: MultiplicityCase[];
};

const fixture = loadFixture<Fixture>('metamodel_caches');
const mm = Metamodel.fromJSON(fixture.metamodel);
const elementNames = fixture.elements.map((c) => c.name);
const relationshipNames = fixture.relationships.map((c) => c.name);

const rows = (props: readonly { name: string; datatype: string; multiplicity: string }[]) =>
	props.map((p) => [p.name, p.datatype, p.multiplicity]);
const sorted = (names: ReadonlySet<string>) => [...names].sort(cmpCodePoint);

describe('Metamodel lookups match the oracle', () => {
	it.each(fixture.elements)('element type $name', (c) => {
		const found = mm.elementType(c.name);
		expect(mm.isElementType(c.name)).toBe(c.is_element_type);
		expect(found === undefined ? null : rows(found.properties)).toEqual(c.own_properties);
		expect(mm.elementAncestors(c.name)).toEqual(c.ancestors);
		expect(rows(mm.effectiveElementProperties(c.name))).toEqual(c.properties);
		expect(sorted(mm.effectiveElementPropertyNames(c.name))).toEqual(c.property_names);
		expect(mm.effectiveElementKey(c.name)).toEqual(c.key);
		const spec = mm.effectiveElementKeySpec(c.name);
		expect(
			spec === null
				? null
				: {
						properties: spec.properties,
						relationships: spec.relationships.map((r) => [r.relType, r.direction])
					}
		).toEqual(c.key_spec);
		expect(
			mm
				.endConstraints(c.name)
				.map((e) => [e.relTypeName, e.end, e.multiplicity.lower, e.multiplicity.upper])
		).toEqual(c.end_constraints);
		expect(sorted(mm.elementDescendants(c.name))).toEqual(c.descendants);
		expect(mm.relationshipTypesFrom(c.name)).toEqual(c.from);
		expect(mm.relationshipTypesTo(c.name)).toEqual(c.to);
		expect(elementNames.filter((s) => mm.isElementSubtype(c.name, s))).toEqual(c.supertypes);
	});

	it.each(fixture.relationships)('relationship type $name', (c) => {
		const found = mm.relationshipType(c.name);
		expect(found === undefined ? null : found.mappings.map((m) => [m.source, m.target])).toEqual(
			c.own_mappings
		);
		expect(mm.relationshipAncestors(c.name)).toEqual(c.ancestors);
		expect(rows(mm.effectiveRelationshipProperties(c.name))).toEqual(c.properties);
		expect(sorted(mm.effectiveRelationshipPropertyNames(c.name))).toEqual(c.property_names);
		expect(mm.isContainment(c.name)).toBe(c.containment);
		expect(sorted(mm.relationshipDescendants(c.name))).toEqual(c.descendants);
		expect(relationshipNames.filter((s) => mm.isRelationshipSubtype(c.name, s))).toEqual(
			c.supertypes
		);
	});
});

describe('Multiplicity.parse matches the oracle', () => {
	it.each(fixture.multiplicities)('spec "$spec"', (c) => {
		if ('error' in c) {
			const error = thrown(() => Multiplicity.parse(c.spec));
			expect(error).toBeInstanceOf(RangeError);
			expect((error as Error).message).toBe(c.error);
			return;
		}
		const parsed = Multiplicity.parse(c.spec);
		expect([parsed.lower, parsed.upper]).toEqual([c.lower, c.upper]);
		expect(parsed.isSingle).toBe(c.is_single);
		expect(parsed.required).toBe(c.required);
		expect([0, 1, 2, 3].map((n) => parsed.countOk(n))).toEqual(c.count_ok);
		expect(Multiplicity.parse(c.spec)).toBe(parsed);
	});
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pixi run engine-test`
Expected: FAIL — `Test Files  1 failed | 10 passed (11)`; `metamodel.golden.test.ts` dies with `TypeError: Cannot read properties of undefined (reading 'fromJSON')`.

- [ ] **Step 4: Implement**

`engine/src/metamodel/types.ts`:

```ts
/** One declared property, in the field names the server's metamodel document uses. */
export type PropertyDef = {
	name: string;
	datatype: string;
	multiplicity: string;
	min: number | null;
	max: number | null;
	pattern: string | null;
	max_length: number | null;
};

/** An allowed (source, target) element-type pair of a relationship type. */
export type Mapping = { source: string; target: string };

export type ElementType = {
	name: string;
	abstract: boolean;
	extends: string | null;
	properties: PropertyDef[];
	key: string[] | null;
};

export type RelationshipType = {
	name: string;
	abstract: boolean;
	extends: string | null;
	containment: boolean;
	/** Mirrors of `mappings[0]`; `mappings` is the source of truth. */
	source: string | null;
	target: string | null;
	mappings: Mapping[];
	source_multiplicity: string;
	target_multiplicity: string;
	properties: PropertyDef[];
};

/** The metamodel as `GET /metamodel` serves it: validated and normalized. */
export type MetamodelDoc = {
	enums: { [name: string]: string[] };
	elements: ElementType[];
	relationships: RelationshipType[];
};
```

`engine/src/metamodel/multiplicity.ts`:

```ts
import { pyRepr } from '../value/repr.ts';

// Python's `int()` on ASCII text: optional sign, digits, single underscores between digits.
const PY_INT = /^[+-]?\d+(?:_\d+)*$/;

function pyInt(text: string): number {
	const trimmed = text.trim();
	if (!PY_INT.test(trimmed)) throw new RangeError('not an integer');
	// `|| 0` turns the `-0` that `Number('-0')` yields into Python's plain 0.
	return Number(trimmed.replaceAll('_', '')) || 0;
}

const cache = new Map<string, Multiplicity>();

export class Multiplicity {
	readonly lower: number;
	/** `null` is unbounded (`*`). */
	readonly upper: number | null;

	constructor(lower: number, upper: number | null) {
		this.lower = lower;
		this.upper = upper;
	}

	get isSingle(): boolean {
		return this.upper === 1;
	}

	get required(): boolean {
		return this.lower >= 1;
	}

	countOk(count: number): boolean {
		if (count < this.lower) return false;
		return this.upper === null || count <= this.upper;
	}

	/** Parses `n`, `lo..hi` or `*`; throws a `RangeError` with the oracle's message otherwise. */
	static parse(spec: string): Multiplicity {
		const cached = cache.get(spec);
		if (cached !== undefined) return cached;
		const text = spec.trim();
		let parsed: Multiplicity;
		try {
			const dots = text.indexOf('..');
			if (dots >= 0) {
				const hi = text.slice(dots + 2);
				parsed = new Multiplicity(pyInt(text.slice(0, dots)), hi.trim() === '*' ? null : pyInt(hi));
			} else if (text === '*') {
				parsed = new Multiplicity(0, null);
			} else {
				const n = pyInt(text);
				parsed = new Multiplicity(n, n);
			}
		} catch {
			throw new RangeError('Invalid multiplicity: ' + pyRepr(text));
		}
		cache.set(spec, parsed);
		return parsed;
	}
}
```

`engine/src/metamodel/key.ts`:

```ts
/** A relationship named by an element type's key: `out:<RelType>` or `in:<RelType>`. */
export type KeyRel = { relType: string; direction: 'out' | 'in' };

/** An element type's effective key, split into its property and relationship parts. */
export type KeySpec = { properties: string[]; relationships: KeyRel[] };

/** `out:R` and `in:R` are relationship keys; any other entry is a property name. */
export function parseKeyEntry(entry: string): string | KeyRel {
	if (entry.startsWith('out:')) return { relType: entry.slice(4), direction: 'out' };
	if (entry.startsWith('in:')) return { relType: entry.slice(3), direction: 'in' };
	return entry;
}

/** Declaration order is kept within each part. */
export function parseKey(entries: readonly string[]): KeySpec {
	const spec: KeySpec = { properties: [], relationships: [] };
	for (const entry of entries) {
		const parsed = parseKeyEntry(entry);
		if (typeof parsed === 'string') spec.properties.push(parsed);
		else spec.relationships.push(parsed);
	}
	return spec;
}
```

`engine/src/metamodel/metamodel.ts`:

```ts
import { parseKey, type KeySpec } from './key.ts';
import { Multiplicity } from './multiplicity.ts';
import type { ElementType, MetamodelDoc, PropertyDef, RelationshipType } from './types.ts';

/**
 * A relationship-end multiplicity binding an element type. `end: 'target'`:
 * the type is a subtype of a mapping source, and the relationship type's target
 * multiplicity bounds the element's OUTGOING count. `end: 'source'`: the type
 * is a subtype of a mapping target, and the source multiplicity bounds its
 * INCOMING count.
 */
export type EndConstraint = {
	relTypeName: string;
	end: 'source' | 'target';
	multiplicity: Multiplicity;
};

type Typed = { name: string; extends: string | null; properties: PropertyDef[] };

const NO_NAMES: ReadonlySet<string> = new Set();
const NONE: readonly never[] = [];

/** The first type of each name wins, as a linear scan would find it. */
function byName<T extends Typed>(types: readonly T[]): Map<string, T> {
	const out = new Map<string, T>();
	for (const type of types) if (!out.has(type.name)) out.set(type.name, type);
	return out;
}

/** The type itself first, then up its `extends` chain; stops at a cycle or an unknown name. */
function ancestorChain(name: string, types: ReadonlyMap<string, Typed>): string[] {
	const chain: string[] = [];
	const seen = new Set<string>();
	let current: string | null = name;
	while (current && !seen.has(current)) {
		const type = types.get(current);
		if (type === undefined) break;
		chain.push(current);
		seen.add(current);
		current = type.extends;
	}
	return chain;
}

/** Root first; on a name clash the definition nearest the root stays. */
function effectiveProps(
	chain: readonly string[],
	types: ReadonlyMap<string, Typed>
): PropertyDef[] {
	const props: PropertyDef[] = [];
	const seen = new Set<string>();
	for (let i = chain.length - 1; i >= 0; i--) {
		for (const prop of types.get(chain[i]!)!.properties) {
			if (seen.has(prop.name)) continue;
			props.push(prop);
			seen.add(prop.name);
		}
	}
	return props;
}

/** The parsed multiplicity, or `null` when it is invalid or can never be violated. */
function bindingMultiplicity(spec: string): Multiplicity | null {
	let parsed: Multiplicity;
	try {
		parsed = Multiplicity.parse(spec);
	} catch {
		return null;
	}
	return parsed.lower === 0 && parsed.upper === null ? null : parsed;
}

function overlaps(names: ReadonlySet<string>, ancestors: ReadonlySet<string>): boolean {
	for (const name of names) if (ancestors.has(name)) return true;
	return false;
}

function descendantsOf(ancestorSets: ReadonlyMap<string, ReadonlySet<string>>) {
	const out = new Map<string, Set<string>>();
	for (const name of ancestorSets.keys()) out.set(name, new Set());
	for (const [name, ancestors] of ancestorSets) {
		for (const ancestor of ancestors) out.get(ancestor)!.add(name);
	}
	return out;
}

function mapValues<A, B>(source: ReadonlyMap<string, A>, fn: (value: A) => B): Map<string, B> {
	const out = new Map<string, B>();
	for (const [key, value] of source) out.set(key, fn(value));
	return out;
}

/**
 * An immutable metamodel with every derived lookup built up front. The
 * document is trusted: the server validates a metamodel before serving it.
 * Returned arrays and sets are shared — do not mutate them.
 */
export class Metamodel {
	readonly enums: { readonly [name: string]: readonly string[] };
	readonly elements: readonly ElementType[];
	readonly relationships: readonly RelationshipType[];

	private readonly typesByName: Map<string, ElementType>;
	private readonly relTypesByName: Map<string, RelationshipType>;
	private readonly elementChains: Map<string, string[]>;
	private readonly relationshipChains: Map<string, string[]>;
	private readonly elementAncestorSets: Map<string, Set<string>>;
	private readonly relationshipAncestorSets: Map<string, Set<string>>;
	private readonly elementProps: Map<string, PropertyDef[]>;
	private readonly relationshipProps: Map<string, PropertyDef[]>;
	private readonly elementPropNames: Map<string, Set<string>>;
	private readonly relationshipPropNames: Map<string, Set<string>>;
	private readonly elementKeys: Map<string, string[] | null>;
	private readonly elementKeySpecs: Map<string, KeySpec | null>;
	private readonly containment: Map<string, boolean>;
	private readonly constraints: Map<string, EndConstraint[]>;
	private readonly elementDescendantSets: Map<string, Set<string>>;
	private readonly relationshipDescendantSets: Map<string, Set<string>>;
	private readonly relTypesFrom: Map<string, string[]>;
	private readonly relTypesTo: Map<string, string[]>;

	private constructor(doc: MetamodelDoc) {
		this.enums = doc.enums;
		this.elements = doc.elements;
		this.relationships = doc.relationships;

		const types = (this.typesByName = byName(doc.elements));
		const relTypes = (this.relTypesByName = byName(doc.relationships));
		this.elementChains = mapValues(types, (t) => ancestorChain(t.name, types));
		this.relationshipChains = mapValues(relTypes, (t) => ancestorChain(t.name, relTypes));
		this.elementAncestorSets = mapValues(this.elementChains, (chain) => new Set(chain));
		this.relationshipAncestorSets = mapValues(this.relationshipChains, (chain) => new Set(chain));
		this.elementProps = mapValues(this.elementChains, (chain) => effectiveProps(chain, types));
		this.relationshipProps = mapValues(this.relationshipChains, (chain) =>
			effectiveProps(chain, relTypes)
		);
		this.elementPropNames = mapValues(this.elementProps, (ps) => new Set(ps.map((p) => p.name)));
		this.relationshipPropNames = mapValues(
			this.relationshipProps,
			(ps) => new Set(ps.map((p) => p.name))
		);

		// The nearest declared key wins, walking from the type up; `[]` is a declared key.
		this.elementKeys = mapValues(this.elementChains, (chain) => {
			for (const name of chain) {
				const key = types.get(name)!.key;
				if (key !== null) return [...key];
			}
			return null;
		});
		this.elementKeySpecs = mapValues(this.elementKeys, (key) =>
			key === null ? null : parseKey(key)
		);
		this.containment = mapValues(this.relationshipChains, (chain) =>
			chain.some((name) => relTypes.get(name)!.containment)
		);
		this.elementDescendantSets = descendantsOf(this.elementAncestorSets);
		this.relationshipDescendantSets = descendantsOf(this.relationshipAncestorSets);

		// Every declared relationship type counts here, a repeated name included.
		this.constraints = mapValues(types, (): EndConstraint[] => []);
		this.relTypesFrom = mapValues(types, (): string[] => []);
		this.relTypesTo = mapValues(types, (): string[] => []);
		for (const rt of doc.relationships) {
			if (rt.abstract || rt.mappings.length === 0) continue;
			const targetMult = bindingMultiplicity(rt.target_multiplicity);
			const sourceMult = bindingMultiplicity(rt.source_multiplicity);
			const sources = new Set(rt.mappings.map((m) => m.source));
			const targets = new Set(rt.mappings.map((m) => m.target));
			for (const [typeName, ancestors] of this.elementAncestorSets) {
				if (overlaps(sources, ancestors)) {
					this.relTypesFrom.get(typeName)!.push(rt.name);
					if (targetMult !== null) {
						this.constraints
							.get(typeName)!
							.push({ relTypeName: rt.name, end: 'target', multiplicity: targetMult });
					}
				}
				if (overlaps(targets, ancestors)) {
					this.relTypesTo.get(typeName)!.push(rt.name);
					if (sourceMult !== null) {
						this.constraints
							.get(typeName)!
							.push({ relTypeName: rt.name, end: 'source', multiplicity: sourceMult });
					}
				}
			}
		}
	}

	static fromJSON(doc: MetamodelDoc): Metamodel {
		return new Metamodel(doc);
	}

	elementType(name: string): ElementType | undefined {
		return this.typesByName.get(name);
	}

	isElementType(name: string): boolean {
		return this.typesByName.has(name);
	}

	relationshipType(name: string): RelationshipType | undefined {
		return this.relTypesByName.get(name);
	}

	/** The type itself first, then its ancestors; empty for an unknown name. */
	elementAncestors(name: string): readonly string[] {
		return this.elementChains.get(name) ?? NONE;
	}

	relationshipAncestors(name: string): readonly string[] {
		return this.relationshipChains.get(name) ?? NONE;
	}

	isElementSubtype(sub: string, sup: string): boolean {
		return this.elementAncestorSets.get(sub)?.has(sup) ?? false;
	}

	isRelationshipSubtype(sub: string, sup: string): boolean {
		return this.relationshipAncestorSets.get(sub)?.has(sup) ?? false;
	}

	/** Inherited properties first; on a name clash the ancestor's definition stays. */
	effectiveElementProperties(name: string): readonly PropertyDef[] {
		return this.elementProps.get(name) ?? NONE;
	}

	effectiveElementPropertyNames(name: string): ReadonlySet<string> {
		return this.elementPropNames.get(name) ?? NO_NAMES;
	}

	/** The nearest key declared up the `extends` chain, or `null`. */
	effectiveElementKey(name: string): readonly string[] | null {
		return this.elementKeys.get(name) ?? null;
	}

	effectiveElementKeySpec(name: string): KeySpec | null {
		return this.elementKeySpecs.get(name) ?? null;
	}

	effectiveRelationshipProperties(name: string): readonly PropertyDef[] {
		return this.relationshipProps.get(name) ?? NONE;
	}

	effectiveRelationshipPropertyNames(name: string): ReadonlySet<string> {
		return this.relationshipPropNames.get(name) ?? NO_NAMES;
	}

	/** True when the type or any ancestor is flagged `containment`. */
	isContainment(relTypeName: string): boolean {
		return this.containment.get(relTypeName) ?? false;
	}

	/** Constraints that can be violated; a `0..*` end binds nothing and is left out. */
	endConstraints(typeName: string): readonly EndConstraint[] {
		return this.constraints.get(typeName) ?? NONE;
	}

	/** The type plus every transitive subtype; empty for an unknown name. */
	elementDescendants(name: string): ReadonlySet<string> {
		return this.elementDescendantSets.get(name) ?? NO_NAMES;
	}

	relationshipDescendants(name: string): ReadonlySet<string> {
		return this.relationshipDescendantSets.get(name) ?? NO_NAMES;
	}

	/** Non-abstract relationship types accepting the type, or an ancestor, as a mapping source. */
	relationshipTypesFrom(name: string): readonly string[] {
		return this.relTypesFrom.get(name) ?? NONE;
	}

	/** Non-abstract relationship types accepting the type, or an ancestor, as a mapping target. */
	relationshipTypesTo(name: string): readonly string[] {
		return this.relTypesTo.get(name) ?? NONE;
	}
}
```

`engine/src/index.ts` (whole file):

```ts
export { parseKey, parseKeyEntry, type KeyRel, type KeySpec } from './metamodel/key.ts';
export { Metamodel, type EndConstraint } from './metamodel/metamodel.ts';
export { Multiplicity } from './metamodel/multiplicity.ts';
export type {
	ElementType,
	Mapping,
	MetamodelDoc,
	PropertyDef,
	RelationshipType
} from './metamodel/types.ts';
export { cmpCodePoint } from './value/compare.ts';
export { pyFloatRepr } from './value/float-repr.ts';
export { pyKey } from './value/key.ts';
export { needsExactParse, parseExact, parseJson, parseLines } from './value/parse.ts';
export { pyRepr } from './value/repr.ts';
export { pyDumps } from './value/serialize.ts';
export { PyFloat, type Value } from './value/types.ts';
```

- [ ] **Step 5: Run the tests**

Run: `pixi run engine-test`
Expected: PASS — 11 files, 68 tests (49 of them in `metamodel.golden.test.ts`).

- [ ] **Step 6: Tidy and commit**

Run: `pixi run engine-tidy`
Expected: prettier reports the files unchanged, eslint prints nothing, both `tsc` projects are silent.

Run: `pixi run -e core-dev ruff format tests/golden && pixi run -e core-dev ruff check tests/golden && pixi run -e core-dev pytest tests/golden -q`
Expected: nothing reformatted, `All checks passed!`, 1 passed.

```bash
git add tests/golden engine
git commit -m "Port the metamodel lookups to the engine"
```

---

### Task 4: The golden model recorder and its step scenarios

**Files:**
- Create: `tests/golden/index_dump.py`, `tests/golden/model_steps.py`
- Create: `tests/golden/scenarios/model_mutations.py`, `tests/golden/scenarios/model_cascades.py`, `tests/golden/scenarios/model_indexes.py`, `tests/golden/scenarios/model_churn.py`
- Modify: `tests/golden/scenarios/__init__.py`
- Create (generated): `engine/fixtures/golden/model_mutations.json`, `model_cascades.json`, `model_indexes.json`, `model_churn.json`

**Interfaces:**
- Consumes: `iter_entity_lines` (Task 2), `model_digest` (Task 1), `scenario`, `tag` (plan 1).
- Produces: `index_dump.dump_indexes(model) -> dict` with the sections `by_type`, `out`, `in`, `out_count`, `in_count`, `parents`, `refs`, `referencers`, `uniq_groups`, `duplicates`, `roots` — every mapping a list of pairs sorted by key, every set a sorted list, `parents` rows `[child, [parent ids], [relationship ids]]` in relationship order, `roots` rows `[display name, id]` in root order.
- Produces: `model_steps.observe(model) -> {"digest", "fingerprint", "state", "indexes"}` (`state`: the entity lines; `indexes`: the dump as compact JSON text; `fingerprint`: first 16 hex digits of SHA-256 over `"\n".join(state) + "\n" + indexes`, UTF-8); `fingerprint(state, indexes) -> str`; `set_property(entity_id, prop, value, **extra) -> dict`; `Recorder(metamodel, *, full_every=5)` with `.model`, `.run(step) -> result`, `.document()`; `run_steps(metamodel, steps, *, full_every=5) -> dict`.
- A scenario document is `{"metamodel": <GET /metamodel shape>, "steps": [...]}`. A recorded step keeps the input keys (`do`, plus `type` / `id` / `prop` / `source` / `target` / `detached` as the method needs; a property value tagged under `value`) and adds `result` (an id, a sorted id list, or `null`), `error` (`null` or `{"kind": "key" | "value", "message"}`), and either `"unchanged": true` or `digest` + `fingerprint`, with `state` + `indexes` on a checkpoint.
- Step vocabulary (`do`): `create_element`, `restore_element`, `get_element`, `get_relationship`, `set_property`, `delete_property`, `connect`, `restore_relationship`, `disconnect`, `delete_element`, `container_of`, `relationships_from`, `relationships_to`. `"detached": "element" | "relationship"` makes `set_property` / `delete_property` act on a record that is not in the model.

- [ ] **Step 1: Write the index dump and the recorder**

`tests/golden/index_dump.py`:

```python
"""The canonical rendering of a model's indexes.

Everything a set holds is sorted and every mapping is a list of pairs, so the
dump depends on the model's state alone, never on hash order, and a plain
JSON reader keeps its order. The engine renders the same document from its own
indexes (``engine/src/debug/dump-indexes.ts``).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from data_rover.core.model.model import Model


def _pairs(mapping: Mapping[str, Iterable[str]]) -> list[list[Any]]:
    return [[key, sorted(mapping[key])] for key in sorted(mapping)]


def _counts(counter: Mapping[tuple[str, str], int]) -> list[list[Any]]:
    return [[eid, rel_type, n] for (eid, rel_type), n in sorted(counter.items())]


def dump_indexes(model: Model) -> dict[str, Any]:
    ix = model.indexes
    return {
        "by_type": _pairs(ix.elements_by_type),
        "out": _pairs(ix.out_rels),
        "in": _pairs(ix.in_rels),
        "out_count": _counts(ix.out_count),
        "in_count": _counts(ix.in_count),
        # parents and their relationships keep relationship-insertion order
        "parents": [
            [child, list(parents), list(ix._containment_rel_ids[child])]
            for child, parents in sorted(ix.containment_parents.items())
        ],
        "refs": _pairs(ix._refs_of),
        "referencers": _pairs(ix.ref_targets),
        "uniq_groups": sorted(sorted(group) for group in ix.uniq_groups.values()),
        "duplicates": sorted(sorted(ix.uniq_groups[key]) for key in ix.duplicate_keys),
        "roots": [[name, eid] for name, eid in ix.roots_order.as_list()],
    }
```

`tests/golden/model_steps.py`:

```python
"""Runs steps against a real ``Model`` and records what happened.

A step is a JSON-ready dict: ``do`` names a method of the mutation boundary,
the other keys are its arguments (property values tagged, see ``tagged.py``).
After every step the recorder adds the outcome (``result`` or ``error``) and
what the step left behind: the state digest and a fingerprint of the entity
lines plus the index dump. Every ``full_every``-th step, and the last, carries
the lines and the dump themselves, so a mismatch can be read, not just seen. A
step that changed nothing says ``"unchanged": true`` instead. The engine's
golden runner replays the same steps and compares all of it.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from typing import Any

from data_rover.api.serialize import iter_entity_lines
from data_rover.api.state_digest import model_digest
from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.element import Element
from data_rover.core.model.ids import SequentialIdGenerator
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship

from .index_dump import dump_indexes
from .tagged import tag


def fingerprint(state: list[str], indexes: str) -> str:
    """16 hex digits over the entity lines and the index dump text."""
    text = "\n".join(state) + "\n" + indexes
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def observe(model: Model) -> dict[str, Any]:
    """The state, index dump and digest of a model the oracle agrees with.

    The dump travels as compact JSON text: indented, its id lists would take
    a line per id and dwarf everything else in the fixture.
    """
    model.indexes.verify_consistent()
    state = list(iter_entity_lines(model))
    indexes = json.dumps(dump_indexes(model), separators=(",", ":"), ensure_ascii=False)
    return {
        "digest": model_digest(model),
        "fingerprint": fingerprint(state, indexes),
        "state": state,
        "indexes": indexes,
    }


def set_property(entity_id: str, prop: str, value: Any, **extra: Any) -> dict[str, Any]:
    """A ``set_property`` step. The raw value rides along under ``_value``;
    the recorder applies it and writes its tagged form."""
    return {
        "do": "set_property",
        "id": entity_id,
        "prop": prop,
        "_value": value,
        **extra,
    }


class Recorder:
    """One scenario in the making: a model with sequential ids, and its log."""

    def __init__(self, metamodel: Metamodel, *, full_every: int = 5) -> None:
        self.metamodel = metamodel
        self.model = Model(metamodel, SequentialIdGenerator())
        self._full_every = full_every
        self._steps: list[dict[str, Any]] = []
        self._last: dict[str, Any] | None = None

    def _entity(self, step: dict[str, Any]) -> Element | Relationship:
        detached = step.get("detached")
        if detached == "element":
            return Element(id=step["id"], type_name=step["type"])
        if detached == "relationship":
            return Relationship(
                id=step["id"], type_name=step["type"], source_id="", target_id=""
            )
        model = self.model
        entity = model.elements.get(step["id"]) or model.relationships.get(step["id"])
        if entity is None:
            raise AssertionError(f"scenario names an unknown entity {step['id']!r}")
        return entity

    def _apply(self, step: dict[str, Any]) -> Any:
        model = self.model
        match step["do"]:
            case "create_element":
                return model.create_element(step["type"]).id
            case "restore_element":
                return model.restore_element(step["id"], step["type"]).id
            case "get_element":
                return model.get_element(step["id"]).id
            case "get_relationship":
                return model.get_relationship(step["id"]).id
            case "set_property":
                model.set_property(self._entity(step), step["prop"], step["_value"])
                return None
            case "delete_property":
                model.delete_property(self._entity(step), step["prop"])
                return None
            case "connect":
                return model.connect(step["type"], step["source"], step["target"]).id
            case "restore_relationship":
                return model.restore_relationship(
                    step["id"], step["type"], step["source"], step["target"]
                ).id
            case "disconnect":
                model.disconnect(step["id"])
                return None
            case "delete_element":
                model.delete_element(step["id"])
                return None
            case "container_of":
                return model.container_of(step["id"])
            case "relationships_from":
                return sorted(r.id for r in model.relationships_from(step["id"]))
            case "relationships_to":
                return sorted(r.id for r in model.relationships_to(step["id"]))
        raise AssertionError(f"unknown step {step['do']!r}")

    def run(self, step: dict[str, Any]) -> Any:
        """Apply one step, log it, and return its result (``None`` on an error)."""
        entry = {key: item for key, item in step.items() if key != "_value"}
        if "_value" in step:
            entry["value"] = tag(step["_value"])
        try:
            entry["result"] = self._apply(step)
            entry["error"] = None
        except (KeyError, ValueError) as exc:
            entry["result"] = None
            entry["error"] = {
                "kind": "key" if isinstance(exc, KeyError) else "value",
                "message": exc.args[0],
            }
        seen = observe(self.model)
        if seen == self._last:
            entry["unchanged"] = True
        else:
            entry["digest"] = seen["digest"]
            entry["fingerprint"] = seen["fingerprint"]
            if len(self._steps) % self._full_every == 0:
                entry.update(seen)
        self._steps.append(entry)
        self._last = seen
        return entry["result"]

    def document(self) -> dict[str, Any]:
        """The scenario document: the metamodel as ``GET /metamodel`` serves
        it, then every step with its outcome and what it left behind."""
        # The last step that changed anything always carries the full state.
        for entry in reversed(self._steps):
            if "unchanged" not in entry:
                assert self._last is not None
                entry.update(self._last)
                break
        return {
            "metamodel": self.metamodel.model_dump(mode="json"),
            "steps": self._steps,
        }


def run_steps(
    metamodel: Metamodel, steps: Iterable[dict[str, Any]], *, full_every: int = 5
) -> dict[str, Any]:
    recorder = Recorder(metamodel, full_every=full_every)
    for step in steps:
        recorder.run(step)
    return recorder.document()
```

- [ ] **Step 2: Write the four scenarios**

`tests/golden/scenarios/model_mutations.py`:

```python
"""Every method of the mutation boundary, with the text of every error."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import run_steps, set_property

_METAMODEL = {
    "elements": [
        {
            "name": "Thing",
            "abstract": True,
            "properties": [{"name": "name", "datatype": "string"}],
        },
        {
            "name": "City",
            "extends": "Thing",
            "properties": [
                {"name": "population", "datatype": "integer"},
                {"name": "mayor", "datatype": "Person"},
            ],
        },
        {"name": "Person", "extends": "Thing"},
    ],
    "relationships": [
        {"name": "Owns", "containment": True, "source": "City", "target": "Person"},
        {
            "name": "Knows",
            "source": "Person",
            "target": "Person",
            "properties": [{"name": "since", "datatype": "integer"}],
        },
    ],
}

_STEPS: list[dict[str, Any]] = [
    # create_element
    {"do": "create_element", "type": "City"},  # id-1
    {"do": "create_element", "type": "Thing"},
    {"do": "create_element", "type": "Nope"},
    {"do": "create_element", "type": "Person"},  # id-2: a failed create mints no id
    {"do": "create_element", "type": "Person"},  # id-3
    # set_property: every write bumps rev, the same value included
    set_property("id-1", "name", "Rome"),
    set_property("id-1", "name", "Rome"),
    set_property("id-1", "population", 2_800_000),
    set_property("id-1", "nope", 1),
    set_property("ghost", "name", "x", detached="element", type="City"),
    set_property("id-1", "name", "x", detached="element", type="City"),
    # delete_property: an absent key is a no-op, a present one bumps rev
    {"do": "delete_property", "id": "id-2", "prop": "name"},
    {"do": "delete_property", "id": "id-1", "prop": "population"},
    {"do": "delete_property", "id": "id-1", "prop": "nope"},
    {"do": "delete_property", "id": "ghost", "prop": "name", "detached": "element", "type": "City"},
    # connect
    {"do": "connect", "type": "Owns", "source": "id-1", "target": "id-2"},  # id-4
    {"do": "connect", "type": "Knows", "source": "id-2", "target": "id-3"},  # id-5
    {"do": "connect", "type": "Nope", "source": "id-1", "target": "id-2"},
    {"do": "connect", "type": "Knows", "source": "nobody", "target": "id-2"},
    {"do": "connect", "type": "Knows", "source": "id-2", "target": "nobody"},
    set_property("id-5", "since", 2020),
    set_property("id-5", "name", "x"),
    set_property("ghost", "since", 1, detached="relationship", type="Knows"),
    {"do": "delete_property", "id": "id-5", "prop": "since"},
    # queries
    {"do": "get_element", "id": "id-1"},
    {"do": "get_element", "id": "nobody"},
    {"do": "get_element", "id": "it's"},
    {"do": "get_element", "id": "id-4"},
    {"do": "get_relationship", "id": "id-4"},
    {"do": "get_relationship", "id": "id-1"},
    {"do": "container_of", "id": "id-2"},
    {"do": "container_of", "id": "id-1"},
    {"do": "container_of", "id": "nobody"},
    {"do": "relationships_from", "id": "id-2"},
    {"do": "relationships_to", "id": "id-2"},
    {"do": "relationships_from", "id": "nobody"},
    # restore_element: the type guards come before the id guard
    {"do": "restore_element", "id": "id-1", "type": "Nope"},
    {"do": "restore_element", "id": "id-1", "type": "Thing"},
    {"do": "restore_element", "id": "id-1", "type": "City"},
    {"do": "restore_element", "id": "id-4", "type": "City"},
    {"do": "restore_element", "id": "kept", "type": "City"},
    # restore_relationship: type, source, target, then the id
    {"do": "restore_relationship", "id": "id-4", "type": "Nope", "source": "x", "target": "y"},
    {"do": "restore_relationship", "id": "id-4", "type": "Knows", "source": "x", "target": "id-2"},
    {"do": "restore_relationship", "id": "id-4", "type": "Knows", "source": "id-2", "target": "y"},
    {"do": "restore_relationship", "id": "id-4", "type": "Knows", "source": "id-2", "target": "id-3"},
    {"do": "restore_relationship", "id": "id-1", "type": "Knows", "source": "id-2", "target": "id-3"},
    {"do": "restore_relationship", "id": "link", "type": "Knows", "source": "id-3", "target": "id-2"},
    # disconnect, delete_element
    {"do": "disconnect", "id": "nobody"},
    {"do": "disconnect", "id": "id-1"},
    {"do": "disconnect", "id": "id-5"},
    {"do": "delete_element", "id": "nobody"},
    {"do": "delete_element", "id": "id-4"},
    {"do": "delete_element", "id": "id-3"},
    # a deleted id is free again, and a fresh create keeps counting
    {"do": "restore_element", "id": "id-3", "type": "Person"},
    {"do": "create_element", "type": "Person"},  # id-6
]  # fmt: skip


@scenario("model_mutations")
def model_mutations() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS)
```

`tests/golden/scenarios/model_cascades.py`:

```python
"""``delete_element`` cascading through containment: nested, shared, cyclic,
self-contained, parallel and inherited containment, and what it leaves alone."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import run_steps, set_property

_METAMODEL = {
    "elements": [
        {"name": "Node", "properties": [{"name": "name", "datatype": "string"}]}
    ],
    "relationships": [
        {"name": "Contains", "containment": True, "source": "Node", "target": "Node"},
        # containment is inherited from the parent relationship type
        {"name": "Holds", "extends": "Contains", "source": "Node", "target": "Node"},
        {"name": "Refers", "source": "Node", "target": "Node"},
    ],
}


def _nodes(*names: str) -> list[dict[str, Any]]:
    return [{"do": "restore_element", "id": name, "type": "Node"} for name in names]


def _edge(rel_id: str, rel_type: str, source: str, target: str) -> dict[str, Any]:
    return {
        "do": "restore_relationship",
        "id": rel_id,
        "type": rel_type,
        "source": source,
        "target": target,
    }


_STEPS: list[dict[str, Any]] = [
    # nested: a > b > c, with edges to and from an outsider
    *_nodes("a", "b", "c", "out"),
    _edge("a-b", "Contains", "a", "b"),
    _edge("b-c", "Holds", "b", "c"),
    _edge("c-out", "Refers", "c", "out"),
    _edge("out-b", "Refers", "out", "b"),
    set_property("c", "name", "deep"),
    {"do": "delete_element", "id": "a"},
    # shared: x has two containment parents; deleting either takes x along
    *_nodes("p", "q", "x"),
    _edge("p-x", "Contains", "p", "x"),
    _edge("q-x", "Contains", "q", "x"),
    {"do": "container_of", "id": "x"},
    {"do": "disconnect", "id": "p-x"},
    {"do": "container_of", "id": "x"},
    _edge("p-x", "Contains", "p", "x"),
    {"do": "container_of", "id": "x"},
    {"do": "delete_element", "id": "p"},
    # cyclic containment, and an element containing itself
    *_nodes("m", "n", "self"),
    _edge("m-n", "Contains", "m", "n"),
    _edge("n-m", "Contains", "n", "m"),
    _edge("self-self", "Contains", "self", "self"),
    _edge("self-loop", "Refers", "self", "self"),
    {"do": "delete_element", "id": "m"},
    {"do": "delete_element", "id": "self"},
    # parallel containment edges keep relationship order when one goes
    *_nodes("u", "v", "w"),
    _edge("u-w-1", "Contains", "u", "w"),
    _edge("v-w", "Contains", "v", "w"),
    _edge("u-w-2", "Contains", "u", "w"),
    {"do": "disconnect", "id": "u-w-1"},
    {"do": "container_of", "id": "w"},
    {"do": "delete_element", "id": "w"},
    {"do": "delete_element", "id": "u"},
]


@scenario("model_cascades")
def model_cascades() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS)
```

`tests/golden/scenarios/model_indexes.py`:

```python
"""The indexes under churn: root order and display names, uniqueness with and
without a key, owner changes, numeric collisions, references, and where a
restored entity lands in state order."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import run_steps, set_property

_NAME_PROPS = [
    {"name": "name", "datatype": "string", "multiplicity": "0..*"},
    {"name": "Name", "datatype": "string"},
    {"name": "NAME", "datatype": "string"},
]

_METAMODEL = {
    "elements": [
        {"name": "Named", "abstract": True, "properties": _NAME_PROPS},
        {
            "name": "Loose",
            "extends": "Named",
            "properties": [
                {"name": "a", "datatype": "float"},
                {"name": "b", "datatype": "string"},
            ],
        },
        {
            "name": "Keyed",
            "extends": "Named",
            "properties": [{"name": "code", "datatype": "integer"}],
            "key": ["code", "out:Tags", "in:Tags"],
        },
        {
            "name": "Holder",
            "extends": "Named",
            "properties": [
                {"name": "one", "datatype": "Keyed"},
                {"name": "many", "datatype": "Named", "multiplicity": "0..*"},
                {"name": "plain", "datatype": "string"},
            ],
            "key": ["plain"],
        },
    ],
    "relationships": [
        {"name": "Owns", "containment": True, "source": "Named", "target": "Named"},
        {
            "name": "Tags",
            "source": "Keyed",
            "target": "Keyed",
            "properties": [{"name": "via", "datatype": "Loose"}],
        },
        {"name": "SubTags", "extends": "Tags", "source": "Keyed", "target": "Keyed"},
    ],
}


def _create(type_name: str) -> dict[str, Any]:
    return {"do": "create_element", "type": type_name}


def _connect(rel_type: str, source: str, target: str) -> dict[str, Any]:
    return {"do": "connect", "type": rel_type, "source": source, "target": target}


_ROOT_NAMES: list[Any] = [
    "b", "a", "B", "", "\u00e9", "e\u0301", "\ue000", "\uffff", "\U0001f600", "\U00010000",
    "a", ["", "zeta"], [], 5, None,
]  # fmt: skip

_STEPS: list[dict[str, Any]] = [
    # --- root order: names by code point, ties by id, fallbacks to the id ---
    *[_create("Loose") for _ in _ROOT_NAMES],  # id-1 .. id-15
    *[set_property(f"id-{i + 1}", "name", name) for i, name in enumerate(_ROOT_NAMES)],
    # another casing counts only when the exact `name` yields nothing
    set_property("id-4", "NAME", "upper"),
    set_property("id-4", "Name", "title"),
    set_property("id-1", "Name", "ignored"),
    {"do": "delete_property", "id": "id-4", "prop": "NAME"},
    set_property("id-2", "name", "zz"),
    {"do": "delete_property", "id": "id-2", "prop": "name"},
    # a contained element is no root; renaming it moves nothing
    _connect("Owns", "id-1", "id-2"),  # id-16
    set_property("id-2", "name", "inner"),
    _connect("Owns", "id-3", "id-2"),  # id-17
    {"do": "disconnect", "id": "id-16"},
    {"do": "disconnect", "id": "id-17"},
    # --- state order: a restored entity lands last ---
    _connect("Owns", "id-1", "id-2"),  # id-18
    {"do": "delete_element", "id": "id-5"},
    {"do": "restore_element", "id": "id-5", "type": "Loose"},
    {"do": "disconnect", "id": "id-18"},
    {"do": "restore_relationship", "id": "id-18", "type": "Owns", "source": "id-1", "target": "id-2"},
    # --- uniqueness without a key: every property, numbers by value ---
    *[_create("Loose") for _ in range(8)],  # id-19 .. id-26
    set_property("id-19", "a", 1),
    set_property("id-20", "a", 1.0),
    set_property("id-21", "a", True),
    set_property("id-22", "a", 0),
    set_property("id-23", "a", -0.0),
    set_property("id-24", "a", False),
    set_property("id-25", "a", 2**53),
    set_property("id-26", "a", float(2**53)),
    set_property("id-25", "a", 2**53 + 1),
    set_property("id-19", "a", "1"),
    # key order inside a value and property order do not matter; list order does
    set_property("id-19", "a", {"x": 1, "y": [1, 2]}),
    set_property("id-20", "a", {"y": [1.0, 2.0], "x": True}),
    set_property("id-21", "a", {"y": [2, 1], "x": 1}),
    set_property("id-22", "b", "same"),
    set_property("id-22", "a", 7),
    set_property("id-23", "a", 7),
    set_property("id-23", "b", "same"),
    # an explicit null is a property like any other
    set_property("id-24", "a", None),
    {"do": "delete_property", "id": "id-24", "prop": "a"},
    # --- the owner is part of the identity ---
    _connect("Owns", "id-1", "id-22"),  # id-27
    _connect("Owns", "id-3", "id-23"),  # id-28
    {"do": "disconnect", "id": "id-28"},
    _connect("Owns", "id-1", "id-23"),  # id-29
    # only the FIRST containment parent counts
    _connect("Owns", "id-3", "id-23"),  # id-30
    {"do": "disconnect", "id": "id-29"},
    # --- uniqueness with a key: properties, then edges of exactly that type ---
    *[_create("Keyed") for _ in range(4)],  # id-31 .. id-34
    set_property("id-31", "code", 1),
    set_property("id-32", "code", 1.0),
    set_property("id-31", "name", "not part of the key"),
    set_property("id-33", "code", None),
    _connect("Tags", "id-31", "id-33"),  # id-35: out of id-31, in of id-33
    _connect("Tags", "id-32", "id-33"),  # id-36
    _connect("Tags", "id-32", "id-34"),  # id-37
    {"do": "disconnect", "id": "id-37"},
    _connect("SubTags", "id-32", "id-34"),  # id-38: a subtype edge is not in the key
    _connect("Tags", "id-31", "id-33"),  # id-39: a parallel edge counts twice
    {"do": "disconnect", "id": "id-39"},
    {"do": "delete_element", "id": "id-33"},
    # --- references: scalar, list, dangling, on a relationship ---
    *[_create("Holder") for _ in range(2)],  # id-40, id-41
    set_property("id-40", "one", "id-31"),
    set_property("id-40", "many", ["id-31", "id-32", 5, None, "id-31", "nowhere"]),
    set_property("id-41", "many", "id-31"),
    set_property("id-41", "one", 12),
    set_property("id-40", "plain", "id-32"),
    _connect("Tags", "id-31", "id-32"),  # id-42
    set_property("id-42", "via", "id-19"),
    set_property("id-42", "via", ["id-20", "id-40"]),
    set_property("id-40", "many", ["id-32"]),
    {"do": "delete_element", "id": "id-31"},
    {"do": "delete_property", "id": "id-40", "prop": "one"},
    {"do": "restore_element", "id": "nowhere", "type": "Loose"},
    {"do": "delete_element", "id": "id-40"},
]  # fmt: skip


@scenario("model_indexes")
def model_indexes() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS)
```

`tests/golden/scenarios/model_churn.py`:

```python
"""A seeded random walk over the mutation boundary: creates, writes, edges,
cascading deletes and restores, in an order no hand-written scenario would
think of. Values come from small pools so that names tie, keys collide and
references dangle."""

from __future__ import annotations

import random
from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import Recorder, set_property

_SEED = 20260918
_STEPS = 240

_METAMODEL = {
    "elements": [
        {
            "name": "Part",
            "properties": [
                {"name": "name", "datatype": "string"},
                {"name": "size", "datatype": "float"},
                {"name": "peers", "datatype": "Part", "multiplicity": "0..*"},
            ],
        },
        {
            "name": "Slot",
            "properties": [
                {"name": "name", "datatype": "string"},
                {"name": "code", "datatype": "integer"},
                {"name": "holder", "datatype": "Part"},
            ],
            "key": ["code", "out:Feeds", "in:Feeds"],
        },
    ],
    "relationships": [
        {"name": "Owns", "containment": True, "source": "Part", "target": "Part"},
        {"name": "Seats", "extends": "Owns", "source": "Part", "target": "Slot"},
        {
            "name": "Feeds",
            "source": "Slot",
            "target": "Slot",
            "properties": [{"name": "via", "datatype": "Part"}],
        },
    ],
}

_NAMES = ["", "a", "b", "B", "\u00e9", "\U0001f600", "\uffff"]
_NUMBERS = [0, 1, 1.0, True, False, -0.0, 2, 2.5, None]


class _Walk:
    def __init__(self) -> None:
        self.rng = random.Random(_SEED)
        self.recorder = Recorder(Metamodel.model_validate(_METAMODEL), full_every=40)
        self.deleted_elements: list[tuple[str, str]] = []
        self.deleted_relationships: list[tuple[str, str, str, str]] = []

    def pick(self, items: list[Any]) -> Any:
        # rng.random() alone: its stream is stable across Python versions.
        return items[int(self.rng.random() * len(items))]

    def elements(self, type_name: str | None = None) -> list[str]:
        return [
            e.id
            for e in self.recorder.model.elements.values()
            if type_name is None or e.type_name == type_name
        ]

    def some_id(self) -> str:
        return self.pick([*self.elements(), "dangling"])

    def step(self) -> dict[str, Any] | None:
        model = self.recorder.model
        parts, slots = self.elements("Part"), self.elements("Slot")
        rels = list(model.relationships)
        match self.pick(["create"] * 3 + ["write"] * 6 + ["connect"] * 4
                        + ["unset", "disconnect", "delete", "restore", "restore_rel"]):  # fmt: skip
            case "create":
                return {
                    "do": "create_element",
                    "type": self.pick(["Part", "Part", "Slot"]),
                }
            case "write" if parts or slots:
                target = self.pick([*parts, *slots, *rels])
                if target in rels:
                    if model.relationships[target].type_name != "Feeds":
                        return None
                    return set_property(target, "via", self.some_id())
                if target in slots:
                    prop = self.pick(["name", "code", "holder"])
                else:
                    prop = self.pick(["name", "size", "peers"])
                value: Any
                if prop == "name":
                    value = self.pick(_NAMES)
                elif prop == "holder":
                    value = self.some_id()
                elif prop == "peers":
                    value = [self.some_id() for _ in range(int(self.rng.random() * 3))]
                else:
                    value = self.pick(_NUMBERS)
                return set_property(target, prop, value)
            case "unset" if parts or slots:
                target = self.pick([*parts, *slots])
                prop = self.pick(["name", "code" if target in slots else "size"])
                return {"do": "delete_property", "id": target, "prop": prop}
            case "connect" if parts:
                kind = self.pick(["Owns", "Seats", "Feeds"])
                sources, targets = {
                    "Owns": (parts, parts),
                    "Seats": (parts, slots),
                    "Feeds": (slots, slots),
                }[kind]
                if not sources or not targets:
                    return None
                return {
                    "do": "connect",
                    "type": kind,
                    "source": self.pick(sources),
                    "target": self.pick(targets),
                }
            case "disconnect" if rels:
                rel = model.relationships[self.pick(rels)]
                self.deleted_relationships.append(
                    (rel.id, rel.type_name, rel.source_id, rel.target_id)
                )
                return {"do": "disconnect", "id": rel.id}
            case "delete" if parts or slots:
                target = self.pick([*parts, *slots])
                self.deleted_elements.append((target, model.elements[target].type_name))
                return {"do": "delete_element", "id": target}
            case "restore" if self.deleted_elements:
                eid, type_name = self.pick(self.deleted_elements)
                return {"do": "restore_element", "id": eid, "type": type_name}
            case "restore_rel" if self.deleted_relationships:
                rid, type_name, source, target = self.pick(self.deleted_relationships)
                return {
                    "do": "restore_relationship",
                    "id": rid,
                    "type": type_name,
                    "source": source,
                    "target": target,
                }
        return None


@scenario("model_churn")
def model_churn() -> Any:
    walk = _Walk()
    done = 0
    while done < _STEPS:
        step = walk.step()
        if step is not None:
            walk.recorder.run(step)
            done += 1
    return walk.recorder.document()
```

`tests/golden/scenarios/__init__.py` (whole file):

```python
"""Importing this package registers every scenario."""

from . import (  # noqa: F401
    float_repr,
    frozen_groups,
    json_dumps,
    json_parse,
    metamodel_caches,
    model_cascades,
    model_churn,
    model_indexes,
    model_mutations,
    py_repr,
    string_order,
)
```

- [ ] **Step 3: Run the drift guard to see it fail**

Run: `pixi run -e core-dev pytest tests/golden -q`
Expected: FAIL — `model_cascades.json`, `model_churn.json`, `model_indexes.json` and `model_mutations.json` are stale (no fixture exists yet).

- [ ] **Step 4: Generate the fixtures and check what they hold**

Run: `pixi run golden-fixtures`

Run:

```bash
pixi run -e core-dev python -c "
import json, pathlib
for name in ['model_cascades', 'model_churn', 'model_indexes', 'model_mutations']:
    steps = json.loads(pathlib.Path(f'engine/fixtures/golden/{name}.json').read_text())['steps']
    print(name, len(steps), 'steps,', sum(1 for s in steps if s['error']), 'errors,', sum(1 for s in steps if 'state' in s), 'checkpoints')
"
```

Expected:

```
model_cascades 40 steps, 0 errors, 8 checkpoints
model_churn 240 steps, 15 errors, 5 checkpoints
model_indexes 110 steps, 0 errors, 23 checkpoints
model_mutations 55 steps, 29 errors, 6 checkpoints
```

The four files total ≈ 220 KB. The recorder runs the oracle's own `verify_consistent()` after every step, so a fixture exists only if Python's incremental indexes agreed with a rebuild throughout.

- [ ] **Step 5: Run the drift guard again, tidy, commit**

Run: `pixi run -e core-dev pytest tests/golden -q`
Expected: PASS — 1 passed.

Run: `pixi run -e core-dev ruff format tests/golden && pixi run -e core-dev ruff check tests/golden`
Expected: nothing reformatted, `All checks passed!`

```bash
git add tests/golden engine/fixtures
git commit -m "Record model scenarios step by step against the Python core"
```

---

### Task 5: Records, names, root order and the key hash

**Files:**
- Create: `engine/src/model/errors.ts`, `engine/src/model/records.ts`, `engine/src/model/naming.ts`, `engine/src/model/hash.ts`, `engine/src/model/root-order.ts`
- Modify: `engine/src/index.ts`
- Test: `engine/test/model/naming.test.ts`, `engine/test/model/root-order.test.ts`, `engine/test/model/hash.test.ts`

**Interfaces:**
- Consumes: `Value`, `cmpCodePoint` from plan 1.
- Produces: `class ModelError extends Error {kind: 'key' | 'value'}` (constructor `(kind, message)`), `class SnapshotError extends Error`; `type Props = {[key: string]: Value}`; `class ElementRec {readonly id; typeName; props; rev; ord; out: RelRec[]; in: RelRec[]; parents: RelRec[]; uniq: number; rootName: string | null}` with constructor `(id, typeName, props, rev, ord)`; `class RelRec {readonly id; typeName; readonly source: ElementRec; readonly target: ElementRec; props; rev; ord; outAt; inAt}` with constructor `(id, typeName, source, target, props, rev, ord)`; `getProp(props, key): Value | undefined` (own keys only), `setProp(props, key, value): void`; `nameOf(element): string | null`, `displayName(element): string`.
- Produces (internal, imported by path, not exported from `index.ts`): `hashKey(text: string): number` (53-bit, deterministic); `class RootOrder {size; list(): readonly ElementRec[]; add(element, name); remove(element); reset(roots)}` — `add` sets `element.rootName`, `remove` clears it and ignores a non-root.

- [ ] **Step 1: Write the failing tests**

`engine/test/model/naming.test.ts`:

```ts
import { expect, it } from 'vitest';
import { displayName, ElementRec, nameOf, type Props } from '../../src/index.ts';

const named = (props: Props) => new ElementRec('the-id', 'T', props, 0, 0);

it('takes the exact lower-case name first, whatever comes before it', () => {
	expect(nameOf(named({ NAME: 'upper', name: 'exact' }))).toBe('exact');
});

it('falls back to other casings in property order', () => {
	expect(nameOf(named({ name: '', NAME: 'upper', Name: 'title' }))).toBe('upper');
	expect(nameOf(named({ nAmE: '', Name: 'title' }))).toBe('title');
	expect(nameOf(named({ names: 'plural', title: 'other' }))).toBeNull();
});

it('reads the first non-empty string of a list', () => {
	expect(nameOf(named({ name: ['', 5, 'second', 'third'] }))).toBe('second');
	expect(nameOf(named({ name: [], Name: ['title'] }))).toBe('title');
});

it('ignores values that are not names and falls back to the id', () => {
	for (const value of [5, true, null, {}, ['', 7]]) {
		expect(nameOf(named({ name: value }))).toBeNull();
		expect(displayName(named({ name: value }))).toBe('the-id');
	}
	expect(displayName(named({ name: 'shown' }))).toBe('shown');
});

it('never reads a name off the prototype chain', () => {
	expect(nameOf(named(Object.create({ name: 'inherited' }) as Props))).toBeNull();
});
```

`engine/test/model/root-order.test.ts`:

```ts
import { expect, it } from 'vitest';
import { ElementRec } from '../../src/index.ts';
import { RootOrder } from '../../src/model/root-order.ts';

const rec = (id: string) => new ElementRec(id, 'T', {}, 0, 0);
const listed = (order: RootOrder) => order.list().map((e) => [e.rootName, e.id]);

it('keeps roots sorted by name, then id, by code point', () => {
	const order = new RootOrder();
	const names: [string, string][] = [
		['b', 'x1'],
		['\u{1F600}', 'x2'],
		['\uFFFF', 'x3'],
		['a', 'x5'],
		['a', 'x4'],
		['', 'x6']
	];
	for (const [name, id] of names) order.add(rec(id), name);
	expect(listed(order)).toEqual([
		['', 'x6'],
		['a', 'x4'],
		['a', 'x5'],
		['b', 'x1'],
		['\uFFFF', 'x3'],
		['\u{1F600}', 'x2']
	]);
	expect(order.size).toBe(6);
});

it('removes by the name a root is filed under, and ignores a non-root', () => {
	const order = new RootOrder();
	const [a, b, c] = [rec('a'), rec('b'), rec('c')];
	order.add(a, 'same');
	order.add(b, 'same');
	order.remove(c);
	order.remove(a);
	expect(a.rootName).toBeNull();
	expect(listed(order)).toEqual([['same', 'b']]);
	order.remove(a);
	expect(order.size).toBe(1);
});

it('resets from records whose names are already set', () => {
	const order = new RootOrder();
	order.add(rec('old'), 'old');
	const roots = ['n2', 'n1'].map((id) => Object.assign(rec(id), { rootName: 'n' }));
	order.reset(roots);
	expect(listed(order)).toEqual([
		['n', 'n1'],
		['n', 'n2']
	]);
});
```

`engine/test/model/hash.test.ts`:

```ts
import { expect, it } from 'vitest';
import { hashKey } from '../../src/model/hash.ts';

it('hashes a key text to a stable safe integer', () => {
	expect(hashKey('')).toBe(3338908027751811);
	expect(hashKey('a')).toBe(7929297801672961);
	expect(hashKey('["Node",null,[]]')).toBe(hashKey('["Node",null,[]]'));
	expect(hashKey('["Node",null,[]]')).not.toBe(hashKey('["Node",null,[[]]]'));
	for (const text of ['', 'a', '\u{1F600}', 'x'.repeat(1000)]) {
		expect(Number.isSafeInteger(hashKey(text))).toBe(true);
	}
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pixi run engine-test`
Expected: FAIL — `Test Files  3 failed | 11 passed (14)`: `ElementRec is not a constructor` in `naming.test.ts`, and `hash.test.ts` / `root-order.test.ts` cannot load `../../src/model/hash.ts` / `root-order.ts`.

- [ ] **Step 3: Implement**

`engine/src/model/errors.ts`:

```ts
/**
 * A call the mutation boundary refuses. `kind` keeps the oracle's distinction
 * between a `KeyError` (something named does not exist) and a `ValueError`
 * (it exists but cannot be used that way); `message` is the oracle's text.
 */
export class ModelError extends Error {
	readonly kind: 'key' | 'value';

	constructor(kind: 'key' | 'value', message: string) {
		super(message);
		this.name = 'ModelError';
		this.kind = kind;
	}
}

/** A snapshot entity the bulk loader cannot accept. */
export class SnapshotError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SnapshotError';
	}
}
```

`engine/src/model/records.ts`:

```ts
import type { Value } from '../value/types.ts';

/** An entity's properties, in insertion order. */
export type Props = { [key: string]: Value };

/**
 * One element. Fixed shape: every field is set in the constructor, in one
 * order. `out`, `in` and `parents` hold direct record references and are
 * maintained by the index hooks; `out` and `in` have no specified order,
 * `parents` holds the containment relationships targeting this element in
 * relationship order — the first one is the owner.
 */
export class ElementRec {
	readonly id: string;
	typeName: string;
	props: Props;
	rev: number;
	/** Insertion sequence. Sparse after churn; only its order means anything. */
	ord: number;
	out: RelRec[];
	in: RelRec[];
	parents: RelRec[];
	/** Index-owned: the uniqueness bucket this element is filed under. */
	uniq: number;
	/** Index-owned: the display name it is filed under as a root, `null` for a non-root. */
	rootName: string | null;

	constructor(id: string, typeName: string, props: Props, rev: number, ord: number) {
		this.id = id;
		this.typeName = typeName;
		this.props = props;
		this.rev = rev;
		this.ord = ord;
		this.out = [];
		this.in = [];
		this.parents = [];
		this.uniq = 0;
		this.rootName = null;
	}
}

/** One relationship, holding its endpoints by reference. */
export class RelRec {
	readonly id: string;
	typeName: string;
	readonly source: ElementRec;
	readonly target: ElementRec;
	props: Props;
	rev: number;
	ord: number;
	/** Index-owned: where this record sits in `source.out` and in `target.in`. */
	outAt: number;
	inAt: number;

	constructor(
		id: string,
		typeName: string,
		source: ElementRec,
		target: ElementRec,
		props: Props,
		rev: number,
		ord: number
	) {
		this.id = id;
		this.typeName = typeName;
		this.source = source;
		this.target = target;
		this.props = props;
		this.rev = rev;
		this.ord = ord;
		this.outAt = -1;
		this.inAt = -1;
	}
}

// Property bags are plain objects, so a key such as `constructor` or
// `__proto__` must never reach the prototype chain.

export function getProp(props: Props, key: string): Value | undefined {
	return Object.hasOwn(props, key) ? props[key] : undefined;
}

/** Appends a new key; an existing key keeps its place, as in a Python dict. */
export function setProp(props: Props, key: string, value: Value): void {
	if (key === '__proto__') {
		Object.defineProperty(props, key, {
			value,
			writable: true,
			enumerable: true,
			configurable: true
		});
	} else {
		props[key] = value;
	}
}
```

`engine/src/model/naming.ts`:

```ts
import type { Value } from '../value/types.ts';
import { getProp, type ElementRec } from './records.ts';

/** A non-empty string, or the first non-empty string of a list. */
function nameStr(value: Value | undefined): string | null {
	if (typeof value === 'string') return value === '' ? null : value;
	if (Array.isArray(value)) {
		for (const item of value) if (typeof item === 'string' && item !== '') return item;
	}
	return null;
}

/**
 * The element's `name`, or `null`. An exact lower-case `name` wins over any
 * other casing (`Name`, `NAME`), which are tried in property order.
 */
export function nameOf(element: ElementRec): string | null {
	const exact = nameStr(getProp(element.props, 'name'));
	if (exact !== null) return exact;
	for (const key of Object.keys(element.props)) {
		if (key !== 'name' && key.toLowerCase() === 'name') {
			const found = nameStr(element.props[key]);
			if (found !== null) return found;
		}
	}
	return null;
}

/** The element's name, else its id. Root order sorts by this. */
export function displayName(element: ElementRec): string {
	return nameOf(element) ?? element.id;
}
```

`engine/src/model/hash.ts`:

```ts
/**
 * A 53-bit string hash (cyrb53). Uniqueness buckets are keyed by it, so that
 * the index holds one number per element rather than one key text; a
 * collision only costs an exact comparison.
 */
export function hashKey(text: string): number {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const unit = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ unit, 2654435761);
		h2 = Math.imul(h2 ^ unit, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
```

`engine/src/model/root-order.ts`:

```ts
import { cmpCodePoint } from '../value/compare.ts';
import type { ElementRec } from './records.ts';

/**
 * Containment roots sorted by `(display name, id)`, both by code point. Each
 * root carries the name it is filed under (`rootName`): after a rename the
 * old name is gone from its properties, and it is what finds the old slot.
 */
export class RootOrder {
	private recs: ElementRec[] = [];

	get size(): number {
		return this.recs.length;
	}

	/** The roots in order. Live — do not mutate. */
	list(): readonly ElementRec[] {
		return this.recs;
	}

	/** The first slot whose root does not sort before `(name, id)`. */
	private slot(name: string, id: string): number {
		let lo = 0;
		let hi = this.recs.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			const other = this.recs[mid]!;
			const order = cmpCodePoint(other.rootName!, name) || cmpCodePoint(other.id, id);
			if (order < 0) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}

	add(element: ElementRec, name: string): void {
		element.rootName = name;
		this.recs.splice(this.slot(name, element.id), 0, element);
	}

	/** No-op for an element that is not filed as a root. */
	remove(element: ElementRec): void {
		if (element.rootName === null) return;
		const at = this.slot(element.rootName, element.id);
		if (this.recs[at] !== element) throw new Error(`root order lost ${element.id}`);
		this.recs.splice(at, 1);
		element.rootName = null;
	}

	/** Replaces the content with `roots`, whose `rootName`s are already set. */
	reset(roots: ElementRec[]): void {
		this.recs = roots.sort(
			(a, b) => cmpCodePoint(a.rootName!, b.rootName!) || cmpCodePoint(a.id, b.id)
		);
	}
}
```

`engine/src/index.ts` (whole file):

```ts
export { parseKey, parseKeyEntry, type KeyRel, type KeySpec } from './metamodel/key.ts';
export { Metamodel, type EndConstraint } from './metamodel/metamodel.ts';
export { Multiplicity } from './metamodel/multiplicity.ts';
export type {
	ElementType,
	Mapping,
	MetamodelDoc,
	PropertyDef,
	RelationshipType
} from './metamodel/types.ts';
export { ModelError, SnapshotError } from './model/errors.ts';
export { displayName, nameOf } from './model/naming.ts';
export { ElementRec, RelRec, type Props } from './model/records.ts';
export { cmpCodePoint } from './value/compare.ts';
export { pyFloatRepr } from './value/float-repr.ts';
export { pyKey } from './value/key.ts';
export { needsExactParse, parseExact, parseJson, parseLines } from './value/parse.ts';
export { pyRepr } from './value/repr.ts';
export { pyDumps } from './value/serialize.ts';
export { PyFloat, type Value } from './value/types.ts';
```

- [ ] **Step 4: Run the tests**

Run: `pixi run engine-test`
Expected: PASS — 14 files, 77 tests.

- [ ] **Step 5: Tidy and commit**

Run: `pixi run engine-tidy`
Expected: nothing reformatted, no diagnostics.

```bash
git add engine
git commit -m "Add the engine's entity records, display names and root order"
```

---

### Task 6: The store — indexes, mutation boundary, debug helpers

**Files:**
- Create: `engine/src/model/indexes.ts`, `engine/src/model/model.ts`, `engine/src/model/lines.ts`
- Create: `engine/src/debug/dump-indexes.ts`, `engine/src/debug/shuffle-adjacency.ts`, `engine/src/debug/verify-consistent.ts`
- Modify: `engine/src/index.ts`
- Test: `engine/test/golden/digest.ts`, `engine/test/golden/model-steps.ts`, `engine/test/model/fixtures.ts`, `engine/test/model/mutations.golden.test.ts`, `engine/test/model/cascades.golden.test.ts`, `engine/test/model/indexes.golden.test.ts`, `engine/test/model/churn.golden.test.ts`, `engine/test/model/order.test.ts`, `engine/test/model/props.test.ts`, `engine/test/debug/debug.test.ts`

**Interfaces:**
- Consumes: `Metamodel`, `KeySpec`, `KeyRel` (Task 3); the records, `getProp`, `setProp`, `displayName`, `hashKey`, `RootOrder`, `ModelError` (Task 5); `pyKey`, `pyRepr`, `pyDumps`, `cmpCodePoint`, `untag`, `loadFixture` (plan 1); the four step fixtures (Task 4).
- Produces: `type ModelOptions = {hashKey?: (key: string) => number}`; `class Model` — `constructor(metamodel, options?)`, `metamodel`, `indexes: IndexSet`, `elementCount`, `relationshipCount`, `elements(): IterableIterator<ElementRec>` and `relationships(): IterableIterator<RelRec>` (state order), `findElement(id): ElementRec | undefined`, `findRelationship(id)`, `getElement(id)` / `getRelationship(id)` (throw `ModelError`), `relationshipsFrom(elementId): readonly RelRec[]`, `relationshipsTo(elementId)`, `containerOf(elementId): string | null`, `createElement(typeName, id)`, `restoreElement(id, typeName, ord?)`, `deleteElement(elementId)`, `setProperty(target, prop, value)`, `deleteProperty(target, prop)`, `connect(relType, sourceId, targetId, id)`, `restoreRelationship(id, relType, sourceId, targetId, ord?)`, `disconnect(relId)`, `rebuildIndexes()`.
- Produces: `class IndexSet` — `byType: Map<string, Set<ElementRec>>`, `buckets: Map<number, ElementRec | Set<ElementRec>>`, `refsOf: Map<string, ReadonlySet<string>>`, `referencers: Map<string, Set<string>>`, `roots: RootOrder`; queries `countOut(element, relTypeName)`, `countIn`, `referencersOf(elementId)`, `uniqGroupOf(element): ElementRec[]`, `uniqGroups(duplicatesOnly): ElementRec[][]`, `uniqKey(element): string`; hooks `onElementCreated`, `onElementDeleted`, `onRelationshipCreated`, `onRelationshipDeleted`, `onPropertyChanged(entity)`; `rebuild()`. Exported as a type only.
- Produces: `elementLine(element)`, `relationshipLine(rel)`, `modelLines(model): string[]`; `dumpIndexes(model): IndexDump`, `verifyConsistent(model): void` (throws naming the stale sections; rebuilds in place), `shuffleAdjacency(model, random: () => number): void`.
- Produces (test-only): `stateDigest(model): string`; `replaySteps(fixture: StepsFixture, options?: ModelOptions): void`, `observe(model)`, `fingerprint(state, indexes)`, `seededRandom(seed)`, types `Step`, `StepsFixture`, `Observed`; `NODE_DOC`, `nodeMetamodel()`.
- Error texts are the oracle's: `Unknown element type 'T'` (key), `Cannot instantiate abstract type 'T'` (value), `Id 'x' is already in use` (value), `No element with id 'x'` (key), `No relationship with id 'x'` (key), `Entity 'x' is not part of this model` (key), `'T' has no property 'p'` (key), `Unknown relationship type 'T'` (key), `No source element 'x'` (key), `No target element 'x'` (key). Guard order is the oracle's: type, then abstract, then id; for a relationship type, source, target, then id.

- [ ] **Step 1: Write the golden runner**

`engine/test/golden/digest.ts`:

```ts
import { createHash } from 'node:crypto';
import type { Model } from '../../src/index.ts';

function entityHash(id: string, rev: number): bigint {
	const hash = createHash('sha256').update(id, 'utf8').update('\0').update(String(rev));
	return hash.digest().readBigUInt64BE(0);
}

/**
 * The state digest of a model, on Node's SHA-256: the XOR over every entity of
 * the first 8 bytes of SHA-256 over `utf8(id) + 0x00 + ascii(rev)`.
 */
export function stateDigest(model: Model): string {
	let value = 0n;
	for (const element of model.elements()) value ^= entityHash(element.id, element.rev);
	for (const rel of model.relationships()) value ^= entityHash(rel.id, rel.rev);
	return value.toString(16).padStart(16, '0');
}
```

`engine/test/golden/model-steps.ts`:

```ts
import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import {
	cmpCodePoint,
	dumpIndexes,
	ElementRec,
	Metamodel,
	Model,
	ModelError,
	modelLines,
	pyDumps,
	RelRec,
	shuffleAdjacency,
	verifyConsistent,
	type MetamodelDoc,
	type ModelOptions
} from '../../src/index.ts';
import { stateDigest } from './digest.ts';
import { untag, type Tagged } from './load.ts';

/**
 * What `tests/golden/model_steps.py` records of the model after a step: always
 * the digest and a fingerprint of lines plus index dump; at a checkpoint the
 * lines and the dump too.
 */
export type Observed = { digest: string; fingerprint: string; state?: string[]; indexes?: string };

export type Step = Partial<Observed> & {
	do: string;
	id?: string;
	type?: string;
	prop?: string;
	source?: string;
	target?: string;
	value?: Tagged;
	detached?: 'element' | 'relationship';
	result: string | string[] | null;
	error: { kind: 'key' | 'value'; message: string } | null;
	unchanged?: true;
};

export type StepsFixture = { metamodel: MetamodelDoc; steps: Step[] };

/** A small seeded generator (mulberry32): test runs must be repeatable. */
export function seededRandom(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function fingerprint(state: readonly string[], indexes: string): string {
	const text = state.join('\n') + '\n' + indexes;
	return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** The engine's side of `Observed`, the index dump as the oracle's compact JSON text. */
export function observe(model: Model): Required<Observed> {
	const state = modelLines(model);
	const indexes = pyDumps(dumpIndexes(model));
	return { digest: stateDigest(model), fingerprint: fingerprint(state, indexes), state, indexes };
}

const sortedIds = (rels: readonly RelRec[]) => rels.map((rel) => rel.id).sort(cmpCodePoint);

function entityOf(model: Model, step: Step): ElementRec | RelRec {
	if (step.detached === 'element') return new ElementRec(step.id!, step.type!, {}, 0, -1);
	if (step.detached === 'relationship') {
		const nowhere = new ElementRec('', '', {}, 0, -1);
		return new RelRec(step.id!, step.type!, nowhere, nowhere, {}, 0, -1);
	}
	return model.findElement(step.id!) ?? model.getRelationship(step.id!);
}

/** `mint` stands in for the oracle's `SequentialIdGenerator`, which a failed call never advances. */
function apply(model: Model, step: Step, mint: () => string): string | string[] | null {
	switch (step.do) {
		case 'create_element':
			return model.createElement(step.type!, mint()).id;
		case 'restore_element':
			return model.restoreElement(step.id!, step.type!).id;
		case 'get_element':
			return model.getElement(step.id!).id;
		case 'get_relationship':
			return model.getRelationship(step.id!).id;
		case 'set_property':
			model.setProperty(entityOf(model, step), step.prop!, untag(step.value!));
			return null;
		case 'delete_property':
			model.deleteProperty(entityOf(model, step), step.prop!);
			return null;
		case 'connect':
			return model.connect(step.type!, step.source!, step.target!, mint()).id;
		case 'restore_relationship':
			return model.restoreRelationship(step.id!, step.type!, step.source!, step.target!).id;
		case 'disconnect':
			model.disconnect(step.id!);
			return null;
		case 'delete_element':
			model.deleteElement(step.id!);
			return null;
		case 'container_of':
			return model.containerOf(step.id!);
		case 'relationships_from':
			return sortedIds(model.relationshipsFrom(step.id!));
		case 'relationships_to':
			return sortedIds(model.relationshipsTo(step.id!));
	}
	throw new Error(`unknown step ${step.do}`);
}

/**
 * Replays a recorded scenario through the engine, comparing every outcome and
 * the whole observable state after every step. Adjacency is shuffled before
 * each step and the indexes are checked against a rebuild after it.
 */
export function replaySteps(fixture: StepsFixture, options: ModelOptions = {}): void {
	const model = new Model(Metamodel.fromJSON(fixture.metamodel), options);
	const random = seededRandom(20260918);
	let minted = 0;
	let last = observe(model);
	fixture.steps.forEach((step, index) => {
		const label = `step ${index}: ${step.do}`;
		shuffleAdjacency(model, random);
		let result: string | string[] | null = null;
		let error: Step['error'] = null;
		try {
			result = apply(model, step, () => `id-${minted + 1}`);
			if (step.do === 'create_element' || step.do === 'connect') minted += 1;
		} catch (caught) {
			if (!(caught instanceof ModelError)) throw caught;
			error = { kind: caught.kind, message: caught.message };
		}
		expect(error, label).toEqual(step.error);
		expect(result, label).toEqual(step.result);
		const seen = observe(model);
		if (step.unchanged) {
			expect(seen, label).toEqual(last);
		} else {
			if (step.state !== undefined) {
				// A checkpoint: compare what can be read before what can only be seen.
				expect(seen.state, label).toEqual(step.state);
				expect(JSON.parse(seen.indexes), label).toEqual(JSON.parse(step.indexes!));
			}
			expect(seen.digest, label).toBe(step.digest);
			expect(seen.fingerprint, label).toBe(step.fingerprint);
		}
		verifyConsistent(model);
		expect(observe(model), `${label}, after a rebuild`).toEqual(seen);
		last = seen;
	});
}
```

- [ ] **Step 2: Write the tests**

`engine/test/model/mutations.golden.test.ts`:

```ts
import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('the mutation boundary matches the oracle', () => {
	const fixture = loadFixture<StepsFixture>('model_mutations');

	it('step by step: results, error texts, state, indexes, digest', () => {
		replaySteps(fixture);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(fixture, { hashKey: () => 0 });
	});
});
```

`engine/test/model/cascades.golden.test.ts`:

```ts
import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('delete cascades match the oracle', () => {
	const fixture = loadFixture<StepsFixture>('model_cascades');

	it('nested, shared, cyclic, self-contained and parallel containment', () => {
		replaySteps(fixture);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(fixture, { hashKey: () => 0 });
	});
});
```

`engine/test/model/indexes.golden.test.ts`:

```ts
import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('the indexes match the oracle under churn', () => {
	const fixture = loadFixture<StepsFixture>('model_indexes');

	it('root order, uniqueness, owners, references, state order', () => {
		replaySteps(fixture);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(fixture, { hashKey: () => 0 });
	});
});
```

`engine/test/model/churn.golden.test.ts`:

```ts
import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('a seeded random walk over the mutation boundary matches the oracle', () => {
	const fixture = loadFixture<StepsFixture>('model_churn');

	it('step by step', () => {
		replaySteps(fixture);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(fixture, { hashKey: () => 0 });
	});
});
```

`engine/test/model/fixtures.ts`:

```ts
import { Metamodel, type MetamodelDoc } from '../../src/index.ts';

const prop = (name: string, datatype = 'string') => ({
	name,
	datatype,
	multiplicity: '0..1',
	min: null,
	max: null,
	pattern: null,
	max_length: null
});

const relationship = (name: string, containment: boolean) => ({
	name,
	abstract: false,
	extends: null,
	containment,
	source: 'Node',
	target: 'Node',
	mappings: [{ source: 'Node', target: 'Node' }],
	source_multiplicity: '0..*',
	target_multiplicity: '0..*',
	properties: []
});

/** One element type, a containment and a plain relationship type between its instances. */
export const NODE_DOC: MetamodelDoc = {
	enums: {},
	elements: [
		{
			name: 'Node',
			abstract: false,
			extends: null,
			properties: [prop('name'), prop('__proto__'), prop('constructor'), prop('peer', 'Node')],
			key: null
		}
	],
	relationships: [relationship('Contains', true), relationship('Refers', false)]
};

export const nodeMetamodel = () => Metamodel.fromJSON(NODE_DOC);
```

`engine/test/model/order.test.ts` (what the oracle cannot show: a record restored with its old `ord`):

```ts
import { describe, expect, it } from 'vitest';
import { Model, verifyConsistent } from '../../src/index.ts';
import { nodeMetamodel } from './fixtures.ts';

const elementIds = (model: Model) => [...model.elements()].map((e) => e.id);
const relationshipIds = (model: Model) => [...model.relationships()].map((r) => r.id);

function chain(): Model {
	const model = new Model(nodeMetamodel());
	for (const id of ['a', 'b', 'c']) model.createElement('Node', id);
	model.connect('Contains', 'a', 'c', 'a-c');
	model.connect('Contains', 'b', 'c', 'b-c');
	return model;
}

describe('state order', () => {
	it('appends a restored entity when no ord is given, as the oracle does', () => {
		const model = chain();
		model.disconnect('a-c');
		model.deleteElement('a');
		model.restoreElement('a', 'Node');
		model.restoreRelationship('a-c', 'Contains', 'a', 'c');
		expect(elementIds(model)).toEqual(['b', 'c', 'a']);
		expect(relationshipIds(model)).toEqual(['b-c', 'a-c']);
		expect(model.containerOf('c')).toBe('b');
		verifyConsistent(model);
	});

	it('puts an element restored with its old ord back in its place', () => {
		const model = chain();
		const ord = model.getElement('a').ord;
		model.deleteElement('a');
		expect(elementIds(model)).toEqual(['b']);
		model.restoreElement('a', 'Node', ord);
		expect(elementIds(model)).toEqual(['a', 'b']);
		model.createElement('Node', 'd');
		expect(elementIds(model)).toEqual(['a', 'b', 'd']);
		verifyConsistent(model);
	});

	it('puts a relationship restored with its old ord back in its place, owner included', () => {
		const model = chain();
		const ord = model.getRelationship('a-c').ord;
		model.disconnect('a-c');
		expect(model.containerOf('c')).toBe('b');
		model.restoreRelationship('a-c', 'Contains', 'a', 'c', ord);
		expect(relationshipIds(model)).toEqual(['a-c', 'b-c']);
		expect(model.containerOf('c')).toBe('a');
		expect(model.getElement('c').parents.map((rel) => rel.id)).toEqual(['a-c', 'b-c']);
		verifyConsistent(model);
	});

	it('keeps minting ords above a restored one', () => {
		const model = new Model(nodeMetamodel());
		model.restoreElement('late', 'Node', 40);
		model.createElement('Node', 'later');
		expect(model.getElement('later').ord).toBe(41);
		expect(elementIds(model)).toEqual(['late', 'later']);
	});
});

describe('ids', () => {
	it('refuses an id in use by either kind, on create as on restore', () => {
		const model = chain();
		expect(() => model.createElement('Node', 'a')).toThrow("Id 'a' is already in use");
		expect(() => model.createElement('Node', 'a-c')).toThrow("Id 'a-c' is already in use");
		expect(() => model.connect('Refers', 'a', 'b', 'c')).toThrow("Id 'c' is already in use");
	});
});
```

`engine/test/model/props.test.ts`:

```ts
import { expect, it } from 'vitest';
import { elementLine, Model, verifyConsistent } from '../../src/index.ts';
import { nodeMetamodel } from './fixtures.ts';

it('treats property names that live on Object.prototype as plain keys', () => {
	const model = new Model(nodeMetamodel());
	const a = model.createElement('Node', 'a');
	const b = model.createElement('Node', 'b');
	model.setProperty(a, 'name', 'x');
	model.setProperty(a, '__proto__', 'p');
	model.setProperty(a, 'constructor', 'c');
	expect(Object.getPrototypeOf(a.props)).toBe(Object.prototype);
	expect(elementLine(a)).toBe(
		'{"id":"a","type_name":"Node","properties":{"name":"x","__proto__":"p","constructor":"c"},"rev":3}'
	);
	// An unset `constructor` is absent, not the inherited function.
	model.setProperty(b, 'name', 'x');
	expect(model.indexes.uniqGroupOf(a)).toEqual([a]);
	model.deleteProperty(a, '__proto__');
	model.deleteProperty(a, 'constructor');
	expect(model.indexes.uniqGroupOf(a)).toHaveLength(2);
	expect(model.indexes.uniqGroupOf(a)).toContain(b);
	verifyConsistent(model);
});

it('keeps the place of a rewritten key and appends a new one', () => {
	const model = new Model(nodeMetamodel());
	const a = model.createElement('Node', 'a');
	model.setProperty(a, 'name', 'x');
	model.setProperty(a, 'peer', 'b');
	model.setProperty(a, 'name', 'y');
	expect(Object.keys(a.props)).toEqual(['name', 'peer']);
	model.deleteProperty(a, 'name');
	model.setProperty(a, 'name', 'z');
	expect(Object.keys(a.props)).toEqual(['peer', 'name']);
});
```

`engine/test/debug/debug.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { dumpIndexes, Model, shuffleAdjacency, verifyConsistent } from '../../src/index.ts';
import { seededRandom } from '../golden/model-steps.ts';
import { nodeMetamodel } from '../model/fixtures.ts';

function star(): Model {
	const model = new Model(nodeMetamodel());
	model.createElement('Node', 'hub');
	for (let i = 0; i < 8; i++) {
		model.createElement('Node', `n${i}`);
		model.connect(i % 2 ? 'Contains' : 'Refers', 'hub', `n${i}`, `out${i}`);
		model.connect('Refers', `n${i}`, 'hub', `in${i}`);
	}
	return model;
}

describe('shuffleAdjacency', () => {
	it('reorders adjacency without changing anything observable', () => {
		const model = star();
		const before = dumpIndexes(model);
		const order = model.getElement('hub').out.map((rel) => rel.id);
		shuffleAdjacency(model, seededRandom(7));
		expect(model.getElement('hub').out.map((rel) => rel.id)).not.toEqual(order);
		expect(dumpIndexes(model)).toEqual(before);
		verifyConsistent(model);
		// Positions stay right, so removal still finds every edge.
		model.deleteElement('hub');
		expect(model.relationshipCount).toBe(0);
		verifyConsistent(model);
	});
});

describe('verifyConsistent', () => {
	it('accepts a model the boundary maintained', () => {
		expect(() => verifyConsistent(star())).not.toThrow();
	});

	it('names the index a write behind the boundary left stale', () => {
		const model = star();
		model.getElement('n0').props['name'] = 'renamed behind the boundary';
		expect(() => verifyConsistent(model)).toThrow(/differ from a fresh rebuild in: .*roots/);
	});

	it('notices an adjacency array edited by hand', () => {
		const model = star();
		model.getElement('hub').out.reverse();
		expect(() => verifyConsistent(model)).toThrow(/out position of/);
	});
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pixi run engine-test`
Expected: FAIL — `Test Files  7 failed | 14 passed (21)`, `Tests  19 failed | 77 passed (96)`; the failures read `Model is not a constructor`.

- [ ] **Step 4: Implement the indexes**

`engine/src/model/indexes.ts`:

```ts
import type { KeyRel, KeySpec } from '../metamodel/key.ts';
import { cmpCodePoint } from '../value/compare.ts';
import { pyKey } from '../value/key.ts';
import type { Value } from '../value/types.ts';
import type { Model } from './model.ts';
import { displayName } from './naming.ts';
import { ElementRec, getProp, type Props, type RelRec } from './records.ts';
import { RootOrder } from './root-order.ts';

function attach(list: RelRec[], rel: RelRec, at: 'outAt' | 'inAt'): void {
	rel[at] = list.length;
	list.push(rel);
}

/** Swap-remove: the record's stored position makes it O(1) on any degree. */
function detach(list: RelRec[], rel: RelRec, at: 'outAt' | 'inAt'): void {
	const last = list.pop()!;
	if (last !== rel) {
		list[rel[at]] = last;
		last[at] = rel[at];
	}
	rel[at] = -1;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const item of a) if (!b.has(item)) return false;
	return true;
}

const NO_REFS: ReadonlySet<string> = new Set();

/**
 * The global indexes of one model — by exact type, uniqueness, references,
 * root order — and the hooks that keep them, and the adjacency arrays on the
 * records, in step with the mutation boundary. Every structure is sparse: a
 * key whose set becomes empty is removed. Anything a set or an adjacency
 * array holds has no specified order; whatever is observable sorts.
 *
 * Uniqueness mirrors the oracle: two elements are identical when they share
 * the type, the first containment parent (or both have none) and either the
 * type's effective key (property values, then per relationship key the sorted
 * endpoint ids of exact-type edges) or, without a key, every property.
 * Buckets are keyed by a hash of that key's canonical text, so members of one
 * bucket are only candidates: the queries confirm with the exact text.
 */
export class IndexSet {
	/** Exact type name → its elements. */
	readonly byType = new Map<string, Set<ElementRec>>();
	/** Uniqueness hash → the one element filed under it, or a set of two or more. */
	readonly buckets = new Map<number, ElementRec | Set<ElementRec>>();
	/** Entity id → the element ids its reference-typed properties name. */
	readonly refsOf = new Map<string, ReadonlySet<string>>();
	/** Element id → the entities naming it; a dangling target stays indexed. */
	readonly referencers = new Map<string, Set<string>>();
	readonly roots = new RootOrder();

	private readonly model: Model;
	private readonly hashKey: (key: string) => number;
	private readonly elementRefProps = new Map<string, string[]>();
	private readonly relationshipRefProps = new Map<string, string[]>();
	private readonly keySpecs = new Map<string, KeySpec | null>();
	private outKeyRelTypes: Set<string> | null = null;
	private inKeyRelTypes: Set<string> | null = null;

	constructor(model: Model, hashKey: (key: string) => number) {
		this.model = model;
		this.hashKey = hashKey;
	}

	// -- queries -------------------------------------------------------------

	countOut(element: ElementRec, relTypeName: string): number {
		let n = 0;
		for (const rel of element.out) if (rel.typeName === relTypeName) n++;
		return n;
	}

	countIn(element: ElementRec, relTypeName: string): number {
		let n = 0;
		for (const rel of element.in) if (rel.typeName === relTypeName) n++;
		return n;
	}

	/** The ids of the entities whose properties reference this element id. */
	referencersOf(elementId: string): ReadonlySet<string> {
		return this.referencers.get(elementId) ?? NO_REFS;
	}

	/** The elements identical to this one, itself included. */
	uniqGroupOf(element: ElementRec): ElementRec[] {
		const bucket = this.buckets.get(element.uniq);
		if (!(bucket instanceof Set)) return [element];
		const key = this.uniqKey(element);
		return [...bucket].filter((other) => other === element || this.uniqKey(other) === key);
	}

	/** Every group of identical elements; `duplicatesOnly` drops the groups of one. */
	uniqGroups(duplicatesOnly: boolean): ElementRec[][] {
		const groups: ElementRec[][] = [];
		for (const bucket of this.buckets.values()) {
			if (!(bucket instanceof Set)) {
				if (!duplicatesOnly) groups.push([bucket]);
				continue;
			}
			const byKey = new Map<string, ElementRec[]>();
			for (const element of bucket) {
				const key = this.uniqKey(element);
				const group = byKey.get(key);
				if (group === undefined) byKey.set(key, [element]);
				else group.push(element);
			}
			for (const group of byKey.values()) {
				if (!duplicatesOnly || group.length >= 2) groups.push(group);
			}
		}
		return groups;
	}

	// -- hooks, called from the mutation boundary ----------------------------

	onElementCreated(element: ElementRec): void {
		let ofType = this.byType.get(element.typeName);
		if (ofType === undefined) this.byType.set(element.typeName, (ofType = new Set()));
		ofType.add(element);
		this.addToGroup(element);
		this.updateRefs(element.id, this.refsIn(element.props, this.refProps(element.typeName, true)));
		// A fresh element has no containment parent: it is a root.
		this.roots.add(element, displayName(element));
	}

	/** Called once the element's relationships are gone and it has left the model. */
	onElementDeleted(element: ElementRec): void {
		const ofType = this.byType.get(element.typeName);
		if (ofType !== undefined) {
			ofType.delete(element);
			if (ofType.size === 0) this.byType.delete(element.typeName);
		}
		this.removeFromGroup(element);
		this.updateRefs(element.id, NO_REFS);
		this.roots.remove(element);
	}

	onRelationshipCreated(rel: RelRec): void {
		attach(rel.source.out, rel, 'outAt');
		attach(rel.target.in, rel, 'inAt');
		this.updateRefs(rel.id, this.refsIn(rel.props, this.refProps(rel.typeName, false)));
		if (this.model.metamodel.isContainment(rel.typeName)) {
			// Kept in relationship order: a relationship restored with its old
			// sequence number goes back between its neighbours.
			const parents = rel.target.parents;
			let at = parents.length;
			while (at > 0 && parents[at - 1]!.ord > rel.ord) at--;
			parents.splice(at, 0, rel);
			// The first containment parent ends the target's time as a root.
			if (parents.length === 1) this.roots.remove(rel.target);
			this.rekeyIfPresent(rel.target);
		}
		this.rekeyKeyRelEndpoints(rel);
	}

	onRelationshipDeleted(rel: RelRec): void {
		detach(rel.source.out, rel, 'outAt');
		detach(rel.target.in, rel, 'inAt');
		this.updateRefs(rel.id, NO_REFS);
		if (this.model.metamodel.isContainment(rel.typeName)) {
			const parents = rel.target.parents;
			const at = parents.indexOf(rel);
			if (at >= 0) {
				parents.splice(at, 1);
				// The last containment parent gone: the target is a root again.
				if (parents.length === 0 && this.isPresent(rel.target)) {
					this.roots.add(rel.target, displayName(rel.target));
				}
			}
			this.rekeyIfPresent(rel.target);
		}
		this.rekeyKeyRelEndpoints(rel);
	}

	/** Re-derives what one entity's properties drive: references, uniqueness, root position. */
	onPropertyChanged(entity: ElementRec | RelRec): void {
		const isElement = entity instanceof ElementRec;
		this.updateRefs(
			entity.id,
			this.refsIn(entity.props, this.refProps(entity.typeName, isElement))
		);
		if (!isElement) return;
		this.rekey(entity);
		if (entity.rootName === null) return;
		const name = displayName(entity);
		if (name !== entity.rootName) {
			this.roots.remove(entity);
			this.roots.add(entity, name);
		}
	}

	// -- bulk load -----------------------------------------------------------

	/** Recomputes every index, and the adjacency arrays, from the model's entities. */
	rebuild(): void {
		this.byType.clear();
		this.buckets.clear();
		this.refsOf.clear();
		this.referencers.clear();
		for (const element of this.model.elements()) {
			element.out.length = 0;
			element.in.length = 0;
			element.parents.length = 0;
		}
		// Relationships first, in order, so that owners are known before grouping.
		for (const rel of this.model.relationships()) {
			attach(rel.source.out, rel, 'outAt');
			attach(rel.target.in, rel, 'inAt');
			this.updateRefs(rel.id, this.refsIn(rel.props, this.refProps(rel.typeName, false)));
			if (this.model.metamodel.isContainment(rel.typeName)) rel.target.parents.push(rel);
		}
		const roots: ElementRec[] = [];
		for (const element of this.model.elements()) {
			let ofType = this.byType.get(element.typeName);
			if (ofType === undefined) this.byType.set(element.typeName, (ofType = new Set()));
			ofType.add(element);
			this.addToGroup(element);
			this.updateRefs(
				element.id,
				this.refsIn(element.props, this.refProps(element.typeName, true))
			);
			element.rootName = element.parents.length === 0 ? displayName(element) : null;
			if (element.rootName !== null) roots.push(element);
		}
		this.roots.reset(roots);
	}

	// -- uniqueness ----------------------------------------------------------

	/** The canonical text of the element's identity; equal texts mean identical elements. */
	uniqKey(element: ElementRec): string {
		const owner = element.parents.length > 0 ? element.parents[0]!.source.id : null;
		const spec = this.keySpec(element.typeName);
		const signature: Value =
			spec === null
				? element.props
				: [
						spec.properties.map((name) => getProp(element.props, name) ?? null),
						spec.relationships.map((keyRel) => this.relEndpoints(element, keyRel))
					];
		return pyKey([element.typeName, owner, signature]);
	}

	private keySpec(typeName: string): KeySpec | null {
		let spec = this.keySpecs.get(typeName);
		if (spec === undefined) {
			spec = this.model.metamodel.effectiveElementKeySpec(typeName);
			this.keySpecs.set(typeName, spec);
		}
		return spec;
	}

	/** Sorted endpoint ids of the element's edges of exactly this type; subtypes do not count. */
	private relEndpoints(element: ElementRec, keyRel: KeyRel): string[] {
		const ids: string[] = [];
		if (keyRel.direction === 'out') {
			for (const rel of element.out) if (rel.typeName === keyRel.relType) ids.push(rel.target.id);
		} else {
			for (const rel of element.in) if (rel.typeName === keyRel.relType) ids.push(rel.source.id);
		}
		return ids.sort(cmpCodePoint);
	}

	private addToGroup(element: ElementRec): void {
		const hash = this.hashKey(this.uniqKey(element));
		element.uniq = hash;
		const bucket = this.buckets.get(hash);
		if (bucket === undefined) this.buckets.set(hash, element);
		else if (bucket instanceof Set) bucket.add(element);
		else this.buckets.set(hash, new Set([bucket, element]));
	}

	private removeFromGroup(element: ElementRec): void {
		const bucket = this.buckets.get(element.uniq);
		if (bucket === element) {
			this.buckets.delete(element.uniq);
		} else if (bucket instanceof Set && bucket.delete(element) && bucket.size === 1) {
			for (const last of bucket) this.buckets.set(element.uniq, last);
		}
	}

	private rekey(element: ElementRec): void {
		// An unchanged hash is an unchanged bucket, whatever the key texts are.
		if (this.hashKey(this.uniqKey(element)) === element.uniq) return;
		this.removeFromGroup(element);
		this.addToGroup(element);
	}

	private isPresent(element: ElementRec): boolean {
		return this.model.findElement(element.id) === element;
	}

	private rekeyIfPresent(element: ElementRec): void {
		if (this.isPresent(element)) this.rekey(element);
	}

	/**
	 * Rekeys an edge's endpoints when its type takes part in some key. Runs
	 * after adjacency is updated, so the key sees the graph as it now is.
	 */
	private rekeyKeyRelEndpoints(rel: RelRec): void {
		if (this.outKeyRelTypes === null || this.inKeyRelTypes === null) {
			this.outKeyRelTypes = new Set();
			this.inKeyRelTypes = new Set();
			const mm = this.model.metamodel;
			for (const type of mm.elements) {
				for (const keyRel of mm.effectiveElementKeySpec(type.name)?.relationships ?? []) {
					(keyRel.direction === 'out' ? this.outKeyRelTypes : this.inKeyRelTypes).add(
						keyRel.relType
					);
				}
			}
		}
		if (this.outKeyRelTypes.has(rel.typeName)) this.rekeyIfPresent(rel.source);
		if (this.inKeyRelTypes.has(rel.typeName)) this.rekeyIfPresent(rel.target);
	}

	// -- references ----------------------------------------------------------

	/** Names of the type's effective properties whose datatype is an element type. */
	private refProps(typeName: string, ofElement: boolean): string[] {
		const cache = ofElement ? this.elementRefProps : this.relationshipRefProps;
		let names = cache.get(typeName);
		if (names === undefined) {
			const mm = this.model.metamodel;
			const defs = ofElement
				? mm.effectiveElementProperties(typeName)
				: mm.effectiveRelationshipProperties(typeName);
			names = defs.filter((p) => mm.isElementType(p.datatype)).map((p) => p.name);
			cache.set(typeName, names);
		}
		return names;
	}

	/** A scalar or a list; only strings are references. */
	private refsIn(props: Props, refProps: readonly string[]): ReadonlySet<string> {
		if (refProps.length === 0) return NO_REFS;
		const refs = new Set<string>();
		for (const name of refProps) {
			const value = getProp(props, name);
			if (value === undefined || value === null) continue;
			for (const item of Array.isArray(value) ? value : [value]) {
				if (typeof item === 'string') refs.add(item);
			}
		}
		return refs;
	}

	private updateRefs(entityId: string, next: ReadonlySet<string>): void {
		const prev = this.refsOf.get(entityId) ?? NO_REFS;
		if (sameSet(prev, next)) return;
		for (const target of prev) {
			if (next.has(target)) continue;
			const from = this.referencers.get(target);
			if (from !== undefined) {
				from.delete(entityId);
				if (from.size === 0) this.referencers.delete(target);
			}
		}
		for (const target of next) {
			if (prev.has(target)) continue;
			let from = this.referencers.get(target);
			if (from === undefined) this.referencers.set(target, (from = new Set()));
			from.add(entityId);
		}
		if (next.size > 0) this.refsOf.set(entityId, next);
		else this.refsOf.delete(entityId);
	}
}
```

- [ ] **Step 5: Implement the mutation boundary and the entity lines**

`engine/src/model/model.ts`:

```ts
import type { Metamodel } from '../metamodel/metamodel.ts';
import { pyRepr } from '../value/repr.ts';
import type { Value } from '../value/types.ts';
import { ModelError } from './errors.ts';
import { hashKey } from './hash.ts';
import { IndexSet } from './indexes.ts';
import { ElementRec, RelRec, setProp } from './records.ts';

export type ModelOptions = {
	/** Replaces the uniqueness-bucket hash; tests force collisions with it. */
	hashKey?: (key: string) => number;
};

function byOrd<T extends { id: string; ord: number }>(map: Map<string, T>): void {
	const sorted = [...map.values()].sort((a, b) => a.ord - b.ord);
	map.clear();
	for (const rec of sorted) map.set(rec.id, rec);
}

/**
 * The elements and relationships of one project, conforming to one metamodel.
 *
 * Every mutation goes through this object's methods — the mutation boundary —
 * which keep `indexes` and the records' adjacency in step. Whatever adds
 * entities behind it, as the bulk loader does, calls `rebuildIndexes()` after.
 *
 * Entity order is state. It is the order of insertion, held by each record's
 * `ord`; an entity restored with its old `ord` goes back to its old place.
 * Element and relationship ids share one namespace.
 */
export class Model {
	readonly metamodel: Metamodel;
	readonly indexes: IndexSet;

	private readonly elementMap = new Map<string, ElementRec>();
	private readonly relationshipMap = new Map<string, RelRec>();
	private nextOrd = 0;
	// Set when a record came back with an old `ord`: the map is then out of
	// order until the next ordered iteration sorts it, once.
	private elementsShuffled = false;
	private relationshipsShuffled = false;

	constructor(metamodel: Metamodel, options: ModelOptions = {}) {
		this.metamodel = metamodel;
		this.indexes = new IndexSet(this, options.hashKey ?? hashKey);
	}

	// -- reading -------------------------------------------------------------

	get elementCount(): number {
		return this.elementMap.size;
	}

	get relationshipCount(): number {
		return this.relationshipMap.size;
	}

	/** The elements in state order. */
	elements(): IterableIterator<ElementRec> {
		if (this.elementsShuffled) {
			byOrd(this.elementMap);
			this.elementsShuffled = false;
		}
		return this.elementMap.values();
	}

	/** The relationships in state order. */
	relationships(): IterableIterator<RelRec> {
		if (this.relationshipsShuffled) {
			byOrd(this.relationshipMap);
			this.relationshipsShuffled = false;
		}
		return this.relationshipMap.values();
	}

	findElement(id: string): ElementRec | undefined {
		return this.elementMap.get(id);
	}

	findRelationship(id: string): RelRec | undefined {
		return this.relationshipMap.get(id);
	}

	getElement(id: string): ElementRec {
		const element = this.elementMap.get(id);
		if (element === undefined) throw new ModelError('key', `No element with id ${pyRepr(id)}`);
		return element;
	}

	getRelationship(id: string): RelRec {
		const rel = this.relationshipMap.get(id);
		if (rel === undefined) throw new ModelError('key', `No relationship with id ${pyRepr(id)}`);
		return rel;
	}

	/** Outgoing relationships, in no specified order. Live — do not mutate. */
	relationshipsFrom(elementId: string): readonly RelRec[] {
		return this.elementMap.get(elementId)?.out ?? [];
	}

	/** Incoming relationships, in no specified order. Live — do not mutate. */
	relationshipsTo(elementId: string): readonly RelRec[] {
		return this.elementMap.get(elementId)?.in ?? [];
	}

	/** The id of the first containment parent, or `null`. */
	containerOf(elementId: string): string | null {
		return this.elementMap.get(elementId)?.parents[0]?.source.id ?? null;
	}

	// -- mutation boundary: elements -----------------------------------------

	/** The caller supplies the id: the engine never mints one. */
	createElement(typeName: string, id: string): ElementRec {
		return this.restoreElement(id, typeName);
	}

	/** Inserts an element under a fixed id, and at its old place when `ord` is given. */
	restoreElement(id: string, typeName: string, ord?: number): ElementRec {
		const type = this.metamodel.elementType(typeName);
		if (type === undefined) {
			throw new ModelError('key', `Unknown element type ${pyRepr(typeName)}`);
		}
		if (type.abstract) {
			throw new ModelError('value', `Cannot instantiate abstract type ${pyRepr(typeName)}`);
		}
		this.requireFreeId(id);
		if (ord !== undefined && ord < this.nextOrd) this.elementsShuffled = true;
		const element = new ElementRec(id, typeName, {}, 0, this.takeOrd(ord));
		this.elementMap.set(id, element);
		this.indexes.onElementCreated(element);
		return element;
	}

	/** Contained children go first, recursively; then every relationship left; then the element. */
	deleteElement(elementId: string): void {
		this.deleteCascade(this.getElement(elementId), new Set());
	}

	private deleteCascade(element: ElementRec, visiting: Set<ElementRec>): void {
		if (visiting.has(element)) return;
		visiting.add(element);
		const contained = element.out.filter((rel) => this.metamodel.isContainment(rel.typeName));
		for (const rel of contained) {
			if (this.relationshipMap.get(rel.id) === rel) this.disconnect(rel.id);
			if (this.elementMap.get(rel.target.id) === rel.target) {
				this.deleteCascade(rel.target, visiting);
			}
		}
		// A self-loop sits in both arrays; the set names it once.
		for (const rel of new Set([...element.out, ...element.in])) this.disconnect(rel.id);
		this.elementMap.delete(element.id);
		this.indexes.onElementDeleted(element);
	}

	// -- mutation boundary: properties ---------------------------------------

	/**
	 * Every write bumps `rev`, a write of the same value included. Values are
	 * replaced whole, never mutated in place: recorded inverses alias them.
	 */
	setProperty(target: ElementRec | RelRec, prop: string, value: Value): void {
		this.requireDeclared(target, prop);
		setProp(target.props, prop, value);
		target.rev += 1;
		this.indexes.onPropertyChanged(target);
	}

	/** Removing a key that is not set changes nothing, `rev` included. */
	deleteProperty(target: ElementRec | RelRec, prop: string): void {
		this.requireDeclared(target, prop);
		if (!Object.hasOwn(target.props, prop)) return;
		delete target.props[prop];
		target.rev += 1;
		this.indexes.onPropertyChanged(target);
	}

	/** The entity must be this model's own record, and its type must declare the property. */
	private requireDeclared(target: ElementRec | RelRec, prop: string): void {
		const isElement = target instanceof ElementRec;
		const attached = isElement
			? this.elementMap.get(target.id)
			: this.relationshipMap.get(target.id);
		if (attached !== target) {
			throw new ModelError('key', `Entity ${pyRepr(target.id)} is not part of this model`);
		}
		const names = isElement
			? this.metamodel.effectiveElementPropertyNames(target.typeName)
			: this.metamodel.effectiveRelationshipPropertyNames(target.typeName);
		if (!names.has(prop)) {
			throw new ModelError('key', `${pyRepr(target.typeName)} has no property ${pyRepr(prop)}`);
		}
	}

	// -- mutation boundary: relationships ------------------------------------

	connect(relType: string, sourceId: string, targetId: string, id: string): RelRec {
		return this.restoreRelationship(id, relType, sourceId, targetId);
	}

	/** Inserts a relationship under a fixed id, and at its old place when `ord` is given. */
	restoreRelationship(
		id: string,
		relType: string,
		sourceId: string,
		targetId: string,
		ord?: number
	): RelRec {
		if (this.metamodel.relationshipType(relType) === undefined) {
			throw new ModelError('key', `Unknown relationship type ${pyRepr(relType)}`);
		}
		const source = this.elementMap.get(sourceId);
		if (source === undefined) {
			throw new ModelError('key', `No source element ${pyRepr(sourceId)}`);
		}
		const target = this.elementMap.get(targetId);
		if (target === undefined) {
			throw new ModelError('key', `No target element ${pyRepr(targetId)}`);
		}
		this.requireFreeId(id);
		if (ord !== undefined && ord < this.nextOrd) this.relationshipsShuffled = true;
		const rel = new RelRec(id, relType, source, target, {}, 0, this.takeOrd(ord));
		this.relationshipMap.set(id, rel);
		this.indexes.onRelationshipCreated(rel);
		return rel;
	}

	disconnect(relId: string): void {
		const rel = this.getRelationship(relId);
		this.relationshipMap.delete(relId);
		this.indexes.onRelationshipDeleted(rel);
	}

	private requireFreeId(id: string): void {
		if (this.elementMap.has(id) || this.relationshipMap.has(id)) {
			throw new ModelError('value', `Id ${pyRepr(id)} is already in use`);
		}
	}

	private takeOrd(ord: number | undefined): number {
		if (ord === undefined) return this.nextOrd++;
		if (ord >= this.nextOrd) this.nextOrd = ord + 1;
		return ord;
	}

	// -- bulk load -----------------------------------------------------------

	/** Recomputes every index and the records' adjacency from the entities. */
	rebuildIndexes(): void {
		this.indexes.rebuild();
	}
}
```

`engine/src/model/lines.ts`:

```ts
import { pyDumps } from '../value/serialize.ts';
import type { Model } from './model.ts';
import type { ElementRec, RelRec } from './records.ts';

/** The element as one compact JSON line, byte for byte what the server writes. */
export function elementLine(element: ElementRec): string {
	return pyDumps({
		id: element.id,
		type_name: element.typeName,
		properties: element.props,
		rev: element.rev
	});
}

export function relationshipLine(rel: RelRec): string {
	return pyDumps({
		id: rel.id,
		type_name: rel.typeName,
		source_id: rel.source.id,
		target_id: rel.target.id,
		properties: rel.props,
		rev: rel.rev
	});
}

/** Every element, then every relationship, in state order. */
export function modelLines(model: Model): string[] {
	const lines: string[] = [];
	for (const element of model.elements()) lines.push(elementLine(element));
	for (const rel of model.relationships()) lines.push(relationshipLine(rel));
	return lines;
}
```

- [ ] **Step 6: Implement the debug helpers and export everything**

`engine/src/debug/dump-indexes.ts`:

```ts
import type { Model } from '../model/model.ts';
import type { ElementRec, RelRec } from '../model/records.ts';
import { cmpCodePoint } from '../value/compare.ts';

/**
 * The canonical rendering of a model's indexes, as the oracle dumps its own:
 * everything unordered is sorted by code point, every mapping is a list of
 * pairs, and only non-empty entries appear.
 */
export type IndexDump = {
	by_type: [type: string, elementIds: string[]][];
	out: [elementId: string, relationshipIds: string[]][];
	in: [elementId: string, relationshipIds: string[]][];
	out_count: [elementId: string, relType: string, count: number][];
	in_count: [elementId: string, relType: string, count: number][];
	/** Parents, and the relationships holding them, in relationship order. */
	parents: [childId: string, parentIds: string[], relationshipIds: string[]][];
	refs: [entityId: string, targetIds: string[]][];
	referencers: [targetId: string, entityIds: string[]][];
	uniq_groups: string[][];
	duplicates: string[][];
	roots: [displayName: string, elementId: string][];
};

const ids = (recs: Iterable<{ id: string }>) => [...recs].map((rec) => rec.id).sort(cmpCodePoint);

function sortedPairs(map: ReadonlyMap<string, ReadonlySet<string>>): [string, string[]][] {
	return [...map.keys()]
		.sort(cmpCodePoint)
		.map((key) => [key, [...map.get(key)!].sort(cmpCodePoint)]);
}

function counts(element: ElementRec, rels: readonly RelRec[]): [string, string, number][] {
	const byType = new Map<string, number>();
	for (const rel of rels) byType.set(rel.typeName, (byType.get(rel.typeName) ?? 0) + 1);
	return [...byType.keys()].sort(cmpCodePoint).map((type) => [element.id, type, byType.get(type)!]);
}

function groups(found: ElementRec[][]): string[][] {
	return found.map(ids).sort((a, b) => cmpCodePoint(a[0]!, b[0]!));
}

export function dumpIndexes(model: Model): IndexDump {
	const ix = model.indexes;
	const elements = [...model.elements()].sort((a, b) => cmpCodePoint(a.id, b.id));
	return {
		by_type: [...ix.byType.keys()]
			.sort(cmpCodePoint)
			.map((type) => [type, ids(ix.byType.get(type)!)]),
		out: elements.filter((e) => e.out.length > 0).map((e) => [e.id, ids(e.out)]),
		in: elements.filter((e) => e.in.length > 0).map((e) => [e.id, ids(e.in)]),
		out_count: elements.flatMap((e) => counts(e, e.out)),
		in_count: elements.flatMap((e) => counts(e, e.in)),
		parents: elements
			.filter((e) => e.parents.length > 0)
			.map((e) => [e.id, e.parents.map((rel) => rel.source.id), e.parents.map((rel) => rel.id)]),
		refs: sortedPairs(ix.refsOf),
		referencers: sortedPairs(ix.referencers),
		uniq_groups: groups(ix.uniqGroups(false)),
		duplicates: groups(ix.uniqGroups(true)),
		roots: ix.roots.list().map((e) => [e.rootName!, e.id])
	};
}
```

`engine/src/debug/shuffle-adjacency.ts`:

```ts
import type { Model } from '../model/model.ts';
import type { RelRec } from '../model/records.ts';

function shuffle(list: RelRec[], at: 'outAt' | 'inAt', random: () => number): void {
	for (let i = list.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		const swapped = list[i]!;
		list[i] = list[j]!;
		list[j] = swapped;
	}
	list.forEach((rel, i) => (rel[at] = i));
}

/**
 * Reorders every element's `out` and `in` arrays. Their order is unspecified,
 * so nothing observable may change: a test that shuffles between steps exposes
 * code that leans on it. `random` returns a number in [0, 1).
 */
export function shuffleAdjacency(model: Model, random: () => number): void {
	for (const element of model.elements()) {
		shuffle(element.out, 'outAt', random);
		shuffle(element.in, 'inAt', random);
	}
}
```

`engine/src/debug/verify-consistent.ts`:

```ts
import type { Model } from '../model/model.ts';
import { dumpIndexes, type IndexDump } from './dump-indexes.ts';

function structuralFaults(model: Model): string[] {
	const faults: string[] = [];
	let lastOrd = -Infinity;
	for (const element of model.elements()) {
		if (element.ord <= lastOrd) faults.push(`element order at ${element.id}`);
		lastOrd = element.ord;
		element.out.forEach((rel, i) => {
			if (rel.outAt !== i || rel.source !== element) faults.push(`out position of ${rel.id}`);
		});
		element.in.forEach((rel, i) => {
			if (rel.inAt !== i || rel.target !== element) faults.push(`in position of ${rel.id}`);
		});
		if ((element.rootName === null) !== element.parents.length > 0) {
			faults.push(`root flag of ${element.id}`);
		}
		const bucket = model.indexes.buckets.get(element.uniq);
		if (bucket !== element && !(bucket instanceof Set && bucket.has(element))) {
			faults.push(`uniqueness bucket of ${element.id}`);
		}
	}
	lastOrd = -Infinity;
	for (const rel of model.relationships()) {
		if (rel.ord <= lastOrd) faults.push(`relationship order at ${rel.id}`);
		lastOrd = rel.ord;
		if (model.findElement(rel.source.id) !== rel.source) faults.push(`source of ${rel.id}`);
		if (model.findElement(rel.target.id) !== rel.target) faults.push(`target of ${rel.id}`);
	}
	return faults;
}

/**
 * Throws unless the incrementally maintained indexes equal a fresh rebuild.
 * It rebuilds them in place — which leaves a consistent model as it was — so
 * it is a full pass over the model: tests and debugging only.
 */
export function verifyConsistent(model: Model): void {
	const faults = structuralFaults(model);
	const kept = dumpIndexes(model);
	model.rebuildIndexes();
	const fresh = dumpIndexes(model);
	for (const section of Object.keys(kept) as (keyof IndexDump)[]) {
		if (JSON.stringify(kept[section]) !== JSON.stringify(fresh[section])) faults.push(section);
	}
	if (faults.length > 0) {
		throw new Error('indexes differ from a fresh rebuild in: ' + faults.join(', '));
	}
}
```

`engine/src/index.ts` (whole file):

```ts
export { dumpIndexes, type IndexDump } from './debug/dump-indexes.ts';
export { shuffleAdjacency } from './debug/shuffle-adjacency.ts';
export { verifyConsistent } from './debug/verify-consistent.ts';
export { parseKey, parseKeyEntry, type KeyRel, type KeySpec } from './metamodel/key.ts';
export { Metamodel, type EndConstraint } from './metamodel/metamodel.ts';
export { Multiplicity } from './metamodel/multiplicity.ts';
export type {
	ElementType,
	Mapping,
	MetamodelDoc,
	PropertyDef,
	RelationshipType
} from './metamodel/types.ts';
export { ModelError, SnapshotError } from './model/errors.ts';
export type { IndexSet } from './model/indexes.ts';
export { elementLine, modelLines, relationshipLine } from './model/lines.ts';
export { Model, type ModelOptions } from './model/model.ts';
export { displayName, nameOf } from './model/naming.ts';
export { ElementRec, RelRec, type Props } from './model/records.ts';
export { cmpCodePoint } from './value/compare.ts';
export { pyFloatRepr } from './value/float-repr.ts';
export { pyKey } from './value/key.ts';
export { needsExactParse, parseExact, parseJson, parseLines } from './value/parse.ts';
export { pyRepr } from './value/repr.ts';
export { pyDumps } from './value/serialize.ts';
export { PyFloat, type Value } from './value/types.ts';
```

- [ ] **Step 7: Run the tests**

Run: `pixi run engine-test`
Expected: PASS — 21 files, 96 tests. The four golden files replay 445 oracle steps, each twice (the second time with every uniqueness key in one bucket).

- [ ] **Step 8: Prove the fixtures bite**

In `engine/src/model/indexes.ts`, comment out the line `if (parents.length === 1) this.roots.remove(rel.target);`.

Run: `pixi run engine-test`
Expected: FAIL — 13 tests in 6 files. Each golden file names the first step that disagrees with the oracle: `step 15: connect` in `mutations.golden.test.ts` (a checkpoint, so the diff shows the contained element still listed under `roots`), `step 4: restore_relationship`, `step 5: connect` and `step 36: connect` in the others (between checkpoints, so the fingerprints differ). `order.test.ts` and `debug.test.ts` fail inside `verifyConsistent` with `indexes differ from a fresh rebuild in: root flag of c, roots`.

Restore the line, re-run, and expect 21 files, 96 tests passing again.

- [ ] **Step 9: Tidy and commit**

Run: `pixi run engine-tidy`
Expected: nothing reformatted, no diagnostics.

```bash
git add engine
git commit -m "Add the engine's record-graph store with its indexes and mutation boundary"
```

---

### Task 7: Bulk load

**Files:**
- Create: `tests/golden/scenarios/model_load.py`, `tests/golden/scenarios/smart_city.py`, `tests/golden/scenarios/snapshot_v2.py`
- Modify: `tests/golden/scenarios/__init__.py`
- Create (generated): `engine/fixtures/golden/model_load.json`, `smart_city.json`, `snapshot_v2.json`
- Create: `engine/src/model/load.ts`
- Modify: `engine/src/model/model.ts` (two import lines, two methods above `rebuildIndexes`, one function at the end)
- Modify: `architecture/contracts.md` (CT-1, CT-7)
- Test: `engine/test/golden/model-load.ts`, `engine/test/model/load.golden.test.ts`, `engine/test/model/smart-city.golden.test.ts`, `engine/test/model/snapshot-v2.golden.test.ts`, `engine/test/model/load.test.ts`

**Interfaces:**
- Consumes: `observe` (Task 4, Python); `encode_snapshot_v2`, `decode_snapshot` (Task 2); `Model`, `observe`, `verifyConsistent` (Task 6); `parseJson`, `parseLines` (plan 1); `thrown` (Task 3).
- Produces: `Model.loadElement(doc: Value): void`, `Model.loadRelationship(doc: Value): void` — add one snapshot entity, in snapshot order, WITHOUT indexing; every element before the first relationship; the caller finishes with `rebuildIndexes()`. They throw `SnapshotError` with the oracle's text: `elements[3]: must be an object`, `…: field 'id' must be a string`, `…: field 'properties' must be an object`, `…: field 'rev' must be an integer`, `Element id 'tmp_1' uses the reserved 'tmp_' prefix (…)`, `Element type 'T' is abstract and cannot be instantiated`, `Duplicate element id 'x' in snapshot`, `Relationship 'r' references unknown source 'x'` / `target`, `Duplicate relationship id 'r' in snapshot`; and with the engine's own for `Relationship id 'x' is already an element id` and `…: property key '0' is an array index, which cannot keep its place in insertion order`. An unknown type loads. Property bags are adopted, not copied.
- Produces (internal): `load.ts` — `TEMP_ID_PREFIX`, `asEntity(doc, where)`, `requireStr(entity, key, where)`, `readProps(entity, where)`, `readRev(entity, where)`. Test helper `loadLines(metamodel, elements, relationships, options?): Model`.
- Fixture shapes: `model_load` = `{metamodel, accepted: {elements, relationships, digest, fingerprint, state, indexes}, refused: [{name, elements, relationships, error}]}` with entities as JSON text lines; `smart_city` = `{metamodel, model_file, elements, relationships, digest, fingerprint, indexes}`; `snapshot_v2` = `{metamodel, text, digest, fingerprint, state, indexes}`.

- [ ] **Step 1: Add the scenarios**

`tests/golden/scenarios/model_load.py`:

```python
"""The bulk loader, lenient about types and strict about structure: what
``build_model_from_dicts(strict=False)`` accepts, and the text of every refusal.

Entities travel as JSON text lines, as a snapshot holds them, so that the
engine reads them with its own parser (``1.0`` must stay a float to be refused
as a ``rev``)."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from data_rover.api.routes._snapshot import build_model_from_dicts
from data_rover.api.serialize import parse_model_json
from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import observe

_METAMODEL = {
    "elements": [
        {
            "name": "Thing",
            "abstract": True,
            "properties": [{"name": "name", "datatype": "string"}],
        },
        {
            "name": "Box",
            "extends": "Thing",
            "properties": [{"name": "buddy", "datatype": "Box"}],
        },
    ],
    "relationships": [
        {"name": "Holds", "containment": True, "source": "Box", "target": "Box"},
        {"name": "Links", "source": "Box", "target": "Box"},
    ],
}

_GOOD_ELEMENTS = [
    '{"id":"b1","type_name":"Box","properties":{"name":"one","buddy":"b2"},"rev":3}',
    '{"id":"b2","type_name":"Box","properties":{"name":"one"},"rev":0,"extra":true}',
    '{"id":"b3","type_name":"Box"}',
    '{"id":"b4","type_name":"Box","properties":null}',
    '{"id":"b5","type_name":"Gone","properties":{"anything":[1,1.0,2e+30,18446744073709551617]}}',
    '{"id":"b6","type_name":"Box","properties":{"__proto__":"p","constructor":"c","name":"six"},"rev":-2}',
    '{"rev":1,"properties":{"name":"one"},"type_name":"Box","id":"b7"}',
]
_GOOD_RELATIONSHIPS = [
    '{"id":"r1","type_name":"Holds","source_id":"b1","target_id":"b2","properties":{},"rev":1}',
    '{"id":"r2","type_name":"Vanished","source_id":"b2","target_id":"b5"}',
    '{"id":"r3","type_name":"Holds","source_id":"b3","target_id":"b2","properties":{"odd":"kept"}}',
    '{"id":"r4","type_name":"Links","source_id":"b7","target_id":"b7","rev":2}',
]

_BOX = '{"id":"b1","type_name":"Box"}'
_BOX2 = '{"id":"b2","type_name":"Box"}'

# (name, element lines, relationship lines)
_REFUSED: list[tuple[str, list[str], list[str]]] = [
    ("element is a list", ["[]"], []),
    ("element is a string", ['"b1"'], []),
    ("element is null", [_BOX, "null"], []),
    ("element id is a number", ['{"id":1,"type_name":"Box"}'], []),
    ("element id is missing", ['{"type_name":"Box"}'], []),
    ("element type_name is null", ['{"id":"b1","type_name":null}'], []),
    ("element id is reserved", ['{"id":"tmp_1","type_name":"Box"}'], []),
    ("reserved id comes before the abstract type", ['{"id":"tmp_1","type_name":"Thing"}'], []),
    ("element type is abstract", ['{"id":"b1","type_name":"Thing"}'], []),
    ("element id is repeated", [_BOX, _BOX2, _BOX], []),
    ("repeated id comes before bad properties", [_BOX, '{"id":"b1","type_name":"Box","properties":[]}'], []),
    ("properties is a list", ['{"id":"b1","type_name":"Box","properties":[]}'], []),
    ("properties is a string", [_BOX, '{"id":"b2","type_name":"Box","properties":"x"}'], []),
    ("bad properties come before a bad rev", ['{"id":"b1","type_name":"Box","properties":1,"rev":"x"}'], []),
    ("rev is a float", ['{"id":"b1","type_name":"Box","rev":1.0}'], []),
    ("rev is a boolean", ['{"id":"b1","type_name":"Box","rev":true}'], []),
    ("rev is a string", ['{"id":"b1","type_name":"Box","rev":"1"}'], []),
    ("rev is null", ['{"id":"b1","type_name":"Box","rev":null}'], []),
    ("relationship is a number", [_BOX], ["7"]),
    ("relationship id is missing", [_BOX], ['{"type_name":"Links","source_id":"b1","target_id":"b1"}']),
    ("relationship source_id is missing", [_BOX], ['{"id":"r1","type_name":"Links","target_id":"b1"}']),
    ("relationship target_id is a list", [_BOX], ['{"id":"r1","type_name":"Links","source_id":"b1","target_id":[]}']),
    ("relationship id is reserved", [_BOX], ['{"id":"tmp_r","type_name":"Links","source_id":"b1","target_id":"b1"}']),
    ("relationship source is unknown", [_BOX], ['{"id":"r1","type_name":"Links","source_id":"nope","target_id":"b1"}']),
    ("relationship target is unknown", [_BOX], ['{"id":"r1","type_name":"Links","source_id":"b1","target_id":"it\'s"}']),
    ("unknown source comes before a repeated id", [_BOX], [
        '{"id":"r1","type_name":"Links","source_id":"b1","target_id":"b1"}',
        '{"id":"r1","type_name":"Links","source_id":"nope","target_id":"b1"}',
    ]),
    ("relationship id is repeated", [_BOX, _BOX2], [
        '{"id":"r1","type_name":"Links","source_id":"b1","target_id":"b2"}',
        '{"id":"r1","type_name":"Links","source_id":"b2","target_id":"b1"}',
    ]),
    ("relationship rev is a float", [_BOX], ['{"id":"r1","type_name":"Links","source_id":"b1","target_id":"b1","rev":0.0}']),
    ("relationship properties is null then a bad rev", [_BOX], ['{"id":"r1","type_name":"Links","source_id":"b1","target_id":"b1","properties":null,"rev":[]}']),
]  # fmt: skip


def _load(mm: Metamodel, elements: list[str], relationships: list[str]) -> Any:
    raw = {
        "elements": [parse_model_json(line) for line in elements],
        "relationships": [parse_model_json(line) for line in relationships],
    }
    return build_model_from_dicts(mm, raw, strict=False)


@scenario("model_load")
def model_load() -> Any:
    mm = Metamodel.model_validate(_METAMODEL)
    refused = []
    for name, elements, relationships in _REFUSED:
        try:
            _load(mm, elements, relationships)
        except HTTPException as exc:
            refused.append(
                {
                    "name": name,
                    "elements": elements,
                    "relationships": relationships,
                    "error": exc.detail,
                }
            )
        else:
            raise AssertionError(f"the oracle accepted {name!r}")
    accepted = _load(mm, _GOOD_ELEMENTS, _GOOD_RELATIONSHIPS)
    return {
        "metamodel": mm.model_dump(mode="json"),
        "accepted": {
            "elements": _GOOD_ELEMENTS,
            "relationships": _GOOD_RELATIONSHIPS,
            **observe(accepted),
        },
        "refused": refused,
    }
```

`tests/golden/scenarios/smart_city.py`:

```python
"""The smart-city example, bulk-loaded: its indexes, digest and state.

The model file is an input both sides read from ``examples/``; the fixture
holds what the oracle makes of it. The state is 1,748 lines, so it travels as
the fingerprint alone."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from data_rover.api.routes._snapshot import build_model_from_dicts
from data_rover.api.serialize import parse_model_json
from data_rover.core.metamodel.loader import load_metamodel_str

from ..driver import scenario
from ..model_steps import observe

_EXAMPLES = Path(__file__).resolve().parents[3] / "examples"


@scenario("smart_city")
def smart_city() -> Any:
    mm = load_metamodel_str(
        (_EXAMPLES / "smart-city.metamodel.yaml").read_text(encoding="utf-8")
    )
    raw = parse_model_json((_EXAMPLES / "smart-city.model.json").read_bytes())
    model = build_model_from_dicts(mm, raw, strict=False)
    seen = observe(model)
    return {
        "metamodel": mm.model_dump(mode="json"),
        "model_file": "examples/smart-city.model.json",
        "elements": len(model.elements),
        "relationships": len(model.relationships),
        "digest": seen["digest"],
        "fingerprint": seen["fingerprint"],
        "indexes": seen["indexes"],
    }
```

`tests/golden/scenarios/snapshot_v2.py`:

```python
"""A ``datarover.snapshot/v2`` text as the server encodes it (a header line,
then one line per entity) over values a careless reader would lose, with what
the oracle holds after reading it back."""

from __future__ import annotations

import gzip
from typing import Any

from data_rover.api.routes._snapshot import build_model_from_dicts
from data_rover.api.snapshot_codec import decode_snapshot, encode_snapshot_v2
from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship

from ..driver import scenario
from ..model_steps import observe

_METAMODEL = {
    "elements": [
        {
            "name": "Item",
            "properties": [
                {"name": "name", "datatype": "string"},
                {"name": "amount", "datatype": "float"},
                {"name": "peer", "datatype": "Item"},
            ],
        }
    ],
    "relationships": [
        {"name": "Holds", "containment": True, "source": "Item", "target": "Item"},
        {
            "name": "Links",
            "source": "Item",
            "target": "Item",
            "properties": [{"name": "weight", "datatype": "float"}],
        },
    ],
}

_ELEMENTS: list[tuple[str, dict[str, Any], int]] = [
    ("z-last-by-id-first-in-order", {"name": "caf\u00e9 \U0001f600"}, 4),
    ("a", {"amount": 1.0, "name": "whole float"}, 1),
    ("b", {"amount": 1, "name": "whole float"}, 0),
    ("c", {"amount": 2**63 + 1, "peer": "a"}, 12),
    ("d", {"amount": "Infinity", "name": 'line\nbreak \u2028 "quoted" \\ back'}, 2),
    ("e", {"amount": 1e-07, "extra": {"k": [1.5e300, -0.0, None, True]}}, 3),
]
_RELATIONSHIPS: list[tuple[str, str, str, str, dict[str, Any], int]] = [
    ("r2", "Holds", "a", "b", {}, 0),
    ("r1", "Holds", "c", "b", {}, 5),
    ("r3", "Links", "e", "e", {"weight": 0.1}, 1),
]


@scenario("snapshot_v2")
def snapshot_v2() -> Any:
    mm = Metamodel.model_validate(_METAMODEL)
    model = Model(mm)
    for eid, properties, rev in _ELEMENTS:
        model.elements[eid] = Element(eid, "Item", dict(properties), rev)
    for rid, type_name, source, target, properties, rev in _RELATIONSHIPS:
        model.relationships[rid] = Relationship(
            rid, type_name, source, target, dict(properties), rev
        )
    model.indexes.rebuild()
    blob = b"".join(
        encode_snapshot_v2(model, project_id="demo", rev=42, metamodel_id="mm-7")
    )
    reread = build_model_from_dicts(mm, decode_snapshot(blob), strict=False)
    seen = observe(reread)
    assert seen == observe(model), "the oracle's own round trip changed the model"
    return {
        "metamodel": mm.model_dump(mode="json"),
        "text": gzip.decompress(blob).decode("utf-8"),
        **seen,
    }
```

`tests/golden/scenarios/__init__.py` (whole file):

```python
"""Importing this package registers every scenario."""

from . import (  # noqa: F401
    float_repr,
    frozen_groups,
    json_dumps,
    json_parse,
    metamodel_caches,
    model_cascades,
    model_churn,
    model_indexes,
    model_load,
    model_mutations,
    py_repr,
    smart_city,
    snapshot_v2,
    string_order,
)
```

Run: `pixi run golden-fixtures`
Expected: `model_load.json` (≈ 13 KB), `smart_city.json` (≈ 200 KB: the metamodel and the index dump of 1,002 elements and 746 relationships) and `snapshot_v2.json` (≈ 5 KB) appear.

- [ ] **Step 2: Write the failing tests**

`engine/test/golden/model-load.ts`:

```ts
import {
	Metamodel,
	Model,
	parseLines,
	type MetamodelDoc,
	type ModelOptions
} from '../../src/index.ts';

/** Bulk-loads snapshot entity lines the way a snapshot reader does: parse, load in order, index. */
export function loadLines(
	metamodel: MetamodelDoc,
	elements: readonly string[],
	relationships: readonly string[],
	options: ModelOptions = {}
): Model {
	const model = new Model(Metamodel.fromJSON(metamodel), options);
	for (const doc of parseLines(elements)) model.loadElement(doc);
	for (const doc of parseLines(relationships)) model.loadRelationship(doc);
	model.rebuildIndexes();
	return model;
}
```

`engine/test/model/load.golden.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SnapshotError, verifyConsistent, type MetamodelDoc } from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { loadLines } from '../golden/model-load.ts';
import { observe, type Observed } from '../golden/model-steps.ts';
import { thrown } from '../golden/thrown.ts';

type Lines = { elements: string[]; relationships: string[] };

type Fixture = {
	metamodel: MetamodelDoc;
	accepted: Lines & Required<Observed>;
	refused: (Lines & { name: string; error: string })[];
};

const fixture = loadFixture<Fixture>('model_load');

describe('bulk load matches the oracle', () => {
	it('loads unknown types, absent properties and absent revs', () => {
		const { elements, relationships, ...expected } = fixture.accepted;
		const model = loadLines(fixture.metamodel, elements, relationships);
		expect(observe(model)).toEqual(expected);
		verifyConsistent(model);
	});

	it.each(fixture.refused)('refuses: $name', (c) => {
		const error = thrown(() => loadLines(fixture.metamodel, c.elements, c.relationships));
		expect(error).toBeInstanceOf(SnapshotError);
		expect((error as Error).message).toBe(c.error);
	});
});
```

`engine/test/model/smart-city.golden.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
	Metamodel,
	Model,
	parseJson,
	verifyConsistent,
	type MetamodelDoc,
	type Value
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { observe } from '../golden/model-steps.ts';

type Fixture = {
	metamodel: MetamodelDoc;
	model_file: string;
	elements: number;
	relationships: number;
	digest: string;
	fingerprint: string;
	indexes: string;
};

it('loads the smart-city example into the state and indexes the oracle holds', () => {
	const fixture = loadFixture<Fixture>('smart_city');
	const file = new URL(`../../../${fixture.model_file}`, import.meta.url);
	const doc = parseJson(readFileSync(file, 'utf-8')) as { [key: string]: Value[] };

	const model = new Model(Metamodel.fromJSON(fixture.metamodel));
	for (const element of doc['elements']!) model.loadElement(element);
	for (const rel of doc['relationships']!) model.loadRelationship(rel);
	model.rebuildIndexes();

	expect(model.elementCount).toBe(fixture.elements);
	expect(model.relationshipCount).toBe(fixture.relationships);
	const seen = observe(model);
	expect(JSON.parse(seen.indexes)).toEqual(JSON.parse(fixture.indexes));
	expect(seen.digest).toBe(fixture.digest);
	expect(seen.fingerprint).toBe(fixture.fingerprint);
	verifyConsistent(model);
});
```

`engine/test/model/snapshot-v2.golden.test.ts` (the streaming reader is plan 4's; this proves the lines themselves load back to what the server wrote):

```ts
import { expect, it } from 'vitest';
import { verifyConsistent, type MetamodelDoc } from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { loadLines } from '../golden/model-load.ts';
import { observe, type Observed } from '../golden/model-steps.ts';

type Fixture = Required<Observed> & { metamodel: MetamodelDoc; text: string };

type Header = {
	format: string;
	rev: number;
	elements: number;
	relationships: number;
	state_digest: string;
};

it('reads the entity lines of a v2 snapshot back into the state the server wrote', () => {
	const { metamodel, text, ...expected } = loadFixture<Fixture>('snapshot_v2');
	expect(text.endsWith('\n')).toBe(true);
	const [first, ...lines] = text.slice(0, -1).split('\n');
	const header = JSON.parse(first!) as Header;
	expect(header.format).toBe('datarover.snapshot/v2');
	expect(lines).toHaveLength(header.elements + header.relationships);

	const model = loadLines(metamodel, lines.slice(0, header.elements), lines.slice(header.elements));
	const seen = observe(model);
	expect(seen.state).toEqual(lines);
	expect(seen).toEqual(expected);
	expect(seen.digest).toBe(header.state_digest);
	verifyConsistent(model);
});
```

`engine/test/model/load.test.ts` (where the engine is stricter than the oracle, so no fixture can say):

```ts
import { describe, expect, it } from 'vitest';
import { Model, parseJson, SnapshotError } from '../../src/index.ts';
import { nodeMetamodel } from './fixtures.ts';

function loadElement(line: string): Model {
	const model = new Model(nodeMetamodel());
	model.loadElement(parseJson(line));
	return model;
}

describe('bulk load, where the engine is stricter than the oracle', () => {
	it('proves the reason: an object lists array-index keys first', () => {
		expect(Object.keys({ b: 1, 1: 2, a: 3, 0: 4 })).toEqual(['0', '1', 'b', 'a']);
		expect(Object.keys({ b: 1, '4294967295': 2, '01': 3 })).toEqual(['b', '4294967295', '01']);
	});

	it.each([
		['{"id":"a","type_name":"Node","properties":{"name":"x","0":1}}', "'0'"],
		['{"id":"a","type_name":"Node","properties":{"name":{"k":[{"42":1}]}}}', "'42'"],
		['{"id":"a","type_name":"Node","properties":{"4294967294":1}}', "'4294967294'"]
	])('refuses an array-index property key: %s', (line, key) => {
		expect(() => loadElement(line)).toThrow(SnapshotError);
		expect(() => loadElement(line)).toThrow(
			`elements[0]: property key ${key} is an array index, which cannot keep its place in insertion order`
		);
	});

	it('accepts numeric-looking keys that are not array indexes', () => {
		const model = loadElement(
			'{"id":"a","type_name":"Node","properties":{"b":1,"4294967295":2,"01":3,"-1":4,"1.5":5}}'
		);
		expect(Object.keys(model.getElement('a').props)).toEqual([
			'b',
			'4294967295',
			'01',
			'-1',
			'1.5'
		]);
	});

	it('refuses a relationship whose id an element holds', () => {
		const model = loadElement('{"id":"a","type_name":"Node"}');
		const rel = parseJson('{"id":"a","type_name":"Refers","source_id":"a","target_id":"a"}');
		expect(() => model.loadRelationship(rel)).toThrow(
			new SnapshotError("Relationship id 'a' is already an element id")
		);
	});

	it('refuses a rev too large to be a number', () => {
		expect(() => loadElement('{"id":"a","type_name":"Node","rev":9007199254740993}')).toThrow(
			"elements[0]: field 'rev' must be an integer"
		);
	});
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pixi run engine-test`
Expected: FAIL — `Test Files  4 failed | 21 passed (25)`, `Tests  38 failed | 97 passed (135)`; the failures read `model.loadElement is not a function`.

- [ ] **Step 4: Implement the shape checks**

`engine/src/model/load.ts`:

```ts
import { pyRepr } from '../value/repr.ts';
import { PyFloat, type Value } from '../value/types.ts';
import { SnapshotError } from './errors.ts';
import type { Props } from './records.ts';

/** The ops protocol's provisional ids; a stored entity never carries one. */
export const TEMP_ID_PREFIX = 'tmp_';

type Dict = { [key: string]: Value };

function isDict(value: Value | undefined): value is Dict {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof PyFloat)
	);
}

/** One snapshot line as an object; `where` names it in every message (`elements[3]`). */
export function asEntity(doc: Value, where: string): Dict {
	if (!isDict(doc)) throw new SnapshotError(`${where}: must be an object`);
	return doc;
}

export function requireStr(entity: Dict, key: string, where: string): string {
	const value = Object.hasOwn(entity, key) ? entity[key] : undefined;
	if (typeof value !== 'string') {
		throw new SnapshotError(`${where}: field ${pyRepr(key)} must be a string`);
	}
	return value;
}

// A JavaScript object lists its array-index keys first, in numeric order,
// whatever order they were added in, so it cannot hold one in insertion order.
const ARRAY_INDEX = /^(?:0|[1-9]\d{0,9})$/;

function isArrayIndex(key: string): boolean {
	const first = key.charCodeAt(0);
	if (!(first >= 48 && first <= 57)) return false;
	return ARRAY_INDEX.test(key) && Number(key) < 4294967295;
}

function findArrayIndexKey(value: Value): string | null {
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findArrayIndexKey(item);
			if (found !== null) return found;
		}
	} else if (isDict(value)) {
		for (const key of Object.keys(value)) {
			if (isArrayIndex(key)) return key;
			const found = findArrayIndexKey(value[key]!);
			if (found !== null) return found;
		}
	}
	return null;
}

/** The entity's property bag, adopted as it is; an absent or `null` one is empty. */
export function readProps(entity: Dict, where: string): Props {
	const props = Object.hasOwn(entity, 'properties') ? entity['properties'] : null;
	if (props === null || props === undefined) return {};
	if (!isDict(props)) throw new SnapshotError(`${where}: field 'properties' must be an object`);
	const indexKey = findArrayIndexKey(props);
	if (indexKey !== null) {
		throw new SnapshotError(
			`${where}: property key ${pyRepr(indexKey)} is an array index, ` +
				'which cannot keep its place in insertion order'
		);
	}
	return props;
}

/** The entity's `rev`; absent means 0. A float or a boolean is not an integer. */
export function readRev(entity: Dict, where: string): number {
	const rev = Object.hasOwn(entity, 'rev') ? entity['rev'] : 0;
	if (typeof rev !== 'number') {
		throw new SnapshotError(`${where}: field 'rev' must be an integer`);
	}
	return rev;
}
```

- [ ] **Step 5: Add the loader to `Model`**

In `engine/src/model/model.ts`, replace the line `import { ModelError } from './errors.ts';` with:

```ts
import { ModelError, SnapshotError } from './errors.ts';
```

and add, after the `import { IndexSet } from './indexes.ts';` line:

```ts
import { asEntity, readProps, readRev, requireStr, TEMP_ID_PREFIX } from './load.ts';
```

Inside the class, between the `// -- bulk load ---` comment and the `/** Recomputes every index … */` doc comment of `rebuildIndexes`, insert these two methods, followed by a blank line:

```ts
	/**
	 * Adds one element of a snapshot, in snapshot order, unindexed. Lenient
	 * about types — an unknown one loads, and validation reports it — and
	 * strict about structure.
	 */
	loadElement(doc: Value): void {
		const where = `elements[${this.elementMap.size}]`;
		const entity = asEntity(doc, where);
		const id = requireStr(entity, 'id', where);
		const typeName = requireStr(entity, 'type_name', where);
		if (id.startsWith(TEMP_ID_PREFIX)) throw new SnapshotError(reservedId('Element', id));
		if (this.metamodel.elementType(typeName)?.abstract) {
			throw new SnapshotError(
				`Element type ${pyRepr(typeName)} is abstract and cannot be instantiated`
			);
		}
		if (this.elementMap.has(id)) {
			throw new SnapshotError(`Duplicate element id ${pyRepr(id)} in snapshot`);
		}
		const element = new ElementRec(
			id,
			typeName,
			readProps(entity, where),
			readRev(entity, where),
			this.nextOrd++
		);
		this.elementMap.set(id, element);
	}

	/** Adds one relationship of a snapshot; every element must be loaded before the first one. */
	loadRelationship(doc: Value): void {
		const where = `relationships[${this.relationshipMap.size}]`;
		const entity = asEntity(doc, where);
		const id = requireStr(entity, 'id', where);
		const typeName = requireStr(entity, 'type_name', where);
		const sourceId = requireStr(entity, 'source_id', where);
		const targetId = requireStr(entity, 'target_id', where);
		if (id.startsWith(TEMP_ID_PREFIX)) throw new SnapshotError(reservedId('Relationship', id));
		const source = this.elementMap.get(sourceId);
		if (source === undefined) {
			throw new SnapshotError(
				`Relationship ${pyRepr(id)} references unknown source ${pyRepr(sourceId)}`
			);
		}
		const target = this.elementMap.get(targetId);
		if (target === undefined) {
			throw new SnapshotError(
				`Relationship ${pyRepr(id)} references unknown target ${pyRepr(targetId)}`
			);
		}
		if (this.relationshipMap.has(id)) {
			throw new SnapshotError(`Duplicate relationship id ${pyRepr(id)} in snapshot`);
		}
		if (this.elementMap.has(id)) {
			throw new SnapshotError(`Relationship id ${pyRepr(id)} is already an element id`);
		}
		const rel = new RelRec(
			id,
			typeName,
			source,
			target,
			readProps(entity, where),
			readRev(entity, where),
			this.nextOrd++
		);
		this.relationshipMap.set(id, rel);
	}
```

After the class's closing brace, at the end of the file, add a blank line and:

```ts
function reservedId(kind: string, id: string): string {
	return (
		`${kind} id ${pyRepr(id)} uses the reserved ${pyRepr(TEMP_ID_PREFIX)} prefix ` +
		'(client-side temporary ids of the ops protocol); loaded models must not contain such ids'
	);
}
```

- [ ] **Step 6: Run the tests**

Run: `pixi run engine-test`
Expected: PASS — 25 files, 135 tests.

- [ ] **Step 7: Record the two loader rules in the contracts**

In `architecture/contracts.md`, under `## CT-1`, add a bullet after the `**Entity order is state.**` bullet:

```markdown
- An id is unique across elements and relationships (CT-3 folds both into one digest). The
  engine refuses a snapshot that breaks this.
```

In the CT-7 table, replace the `Order` row with:

```markdown
| Order | No `Intl`, no locale comparison, no dependence on hash order. `Map` insertion order stands in for `dict` order. Sorts are stable. A plain object stands in for a property `dict`; it lists a canonical array-index key (`"0"`, `"42"`) first whatever the insertion order, so the engine refuses an entity carrying one at any depth of its properties. |
```

- [ ] **Step 8: Tidy and commit**

Run: `pixi run engine-tidy`
Expected: nothing reformatted, no diagnostics.

Run: `pixi run -e core-dev ruff format tests/golden && pixi run -e core-dev ruff check tests/golden && pixi run -e core-dev pytest tests/golden -q`
Expected: nothing reformatted, `All checks passed!`, 1 passed.

Run: `LC_ALL=C grep -rnP '[^[:ascii:]]' tests/golden engine/test`
Expected: only the `café` line of `engine/test/value/serialize.test.ts`.

```bash
git add tests/golden engine architecture/contracts.md
git commit -m "Bulk-load snapshot entities into the engine's store"
```

---

### Task 8: Run everything, document, update the status

**Files:**
- Modify: `CLAUDE.md`, `BACKLOG.md`, `architecture/program.md`

**Interfaces:**
- Consumes: everything above. Produces no code.

- [ ] **Step 1: Run everything**

Run: `pixi run dr-test`
Expected: core pytest 2,429 passed / 34 deselected; frontend vitest 2,492 passed; engine vitest 135 passed in 25 files.

Run: `pixi run dr-tidy`
Expected: no file changes, no diagnostics; `git status --short` prints nothing.

- [ ] **Step 2: Describe the engine in `CLAUDE.md`**

Under `### Engine package (`engine/`)`, replace the opening paragraph with:

```markdown
The TypeScript engine of the target architecture (`architecture/`), built bottom-up. Today it holds the **value layer, the metamodel and the record-graph store**; nothing in the frontend or the server imports it yet.
```

In the same section, insert these bullets between the `src/value/` bullet and the `Golden fixtures` bullet:

```markdown
- **`src/metamodel/`** — `Metamodel.fromJSON(doc)` takes the `GET /metamodel` document (validated by the server; the engine parses no YAML and runs no `check_metamodel`) and builds every lookup of the Python `Metamodel` up front, under the same names in camelCase. `Multiplicity.parse` mirrors the Python parser, error text included.
- **`src/model/`** is the store: one fixed-shape record per entity (`ElementRec`, `RelRec`), adjacency and containment parents as arrays of record references ON the records, and `Model` as the single mutation boundary, with the Python method set and error texts (`ModelError.kind` is `key` / `value` for `KeyError` / `ValueError`). The engine never mints ids: `createElement(typeName, id)` and `connect(…, id)` take them. Entity order is state: each record has an `ord`, `elements()` / `relationships()` iterate in it, and a record restored WITH its old `ord` goes back to its old place (the Python core always appends). `IndexSet` keeps by-type, uniqueness, references and root order; adjacency order is unspecified, so anything observable sorts by code point. Uniqueness buckets are keyed by a 53-bit hash of the `pyKey` text and confirmed by the exact text at query time. `loadElement` / `loadRelationship` + `rebuildIndexes()` are the bulk path — non-strict like `build_model_from_dicts(strict=False)`, the same refusal texts as `SnapshotError` — and stricter than Python in two places: an id shared by an element and a relationship, and an array-index property key (`"0"`) at any depth, which a JavaScript object cannot keep in insertion order.
- **`src/debug/`** — `dumpIndexes` (the canonical index dump the fixtures compare), `verifyConsistent` (incremental indexes against a rebuild, performed in place) and `shuffleAdjacency` (tests shuffle between steps to expose a dependence on adjacency order).
```

Append to the end of the `Golden fixtures` bullet:

```markdown
 Model scenarios are step lists run by `tests/golden/model_steps.py` (`Recorder`): every step records its result or error text, the state digest and a fingerprint of the entity lines plus `tests/golden/index_dump.py`'s dump, and every n-th step carries both in full; `engine/test/golden/model-steps.ts` replays them, a second time with every uniqueness key forced into one bucket.
```

In `### Core layering`, append to the end of the `metamodel/schema.py` bullet:

```markdown
 On a property-name clash along `extends` the ANCESTOR's definition stays (`_effective_props` keeps the first name it sees walking root → leaf), while `key` resolves nearest-first and `key: []` counts as declared; the engine port mirrors both.
```

In `### Durable persistence`, append to the end of the `snapshot_codec.py` paragraph (after `…stays the `/model/save` + `/model/download` contract.`):

```markdown
 `encode_snapshot_v2` writes the line-delimited `datarover.snapshot/v2` form (CT-1: a header line carrying the entity counts and the `state_digest` of `api/state_digest.py`, then one `serialize.iter_entity_lines` line per entity); NO writer emits it yet, and `decode_snapshot` recognizes it by its first bytes, returns the same `{"elements", "relationships"}` document and raises `ValueError` on a line count that disagrees with the header.
```

- [ ] **Step 3: Update `BACKLOG.md`**

In the `R-3` entry, replace the sentence `A (engine foundation) is built as four plans; the first — package, value layer, golden-fixture pipeline — has landed.` with:

```markdown
A (engine foundation) is built as four plans; the first two — package, value layer and
golden-fixture pipeline; Python snapshot v2 and state digest, metamodel, record-graph store,
indexes and mutation boundary — have landed.
```

In `## 6. Diagnosed issues — backend`, after the `K-28` entry and before the `---` rule, add:

```markdown
### K-29 · The bulk loader accepts a relationship whose id an element already holds · `open` · *2026-09-18*
`routes/_snapshot.py`'s guards keep one `seen_ids` set per kind, so `build_model_from_dicts`
loads an element and a relationship sharing an id, while the mutation boundary
(`restore_element` / `restore_relationship`) refuses exactly that and the state digest (CT-3)
folds both kinds into one namespace — a same-`rev` pair cancels out of it. The engine's
loader refuses such a snapshot (`Relationship id 'x' is already an element id`), so a project
imported with one would open on the server and not in the browser. Fix: check the other
kind's ids in `_guard_relationship`; the file is outside the MR-3 freeze.
```

In the table of `## 7. Cleanups & dead code`, add a row at the end:

```markdown
| C-20 | `core/metamodel/schema.py::_effective_props`' comment says definitions by closer types win; the code keeps the FIRST name seen walking root → leaf, so on a redeclared property the ancestor's definition stays (fixture `metamodel_caches`, type `Mid`). The engine mirrors the code. Decide which was meant; frozen under MR-3 until the metamodel surface defaults to the engine. | 2026-09-18 |
```

- [ ] **Step 4: Update the program status**

In `architecture/program.md`, replace the status row of A with:

```markdown
| A | Engine foundation | in progress — plans 1–2 of 4 landed (value layer, golden pipeline; Python snapshot v2 and digest, metamodel, store, indexes, mutation boundary) |
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md BACKLOG.md architecture/program.md
git commit -m "Document the engine's metamodel and store"
```

---

## After this plan

Plan 3 (op applier and working copy) is written once this one has landed. What it inherits:

- `Recorder` already speaks in steps; an op batch is one more `do`, run through `routes/ops.py::_apply_batch`, and `result` grows the batch fields (`id_map`, changed, deleted, inverse ops). The TypeScript runner's `apply` switch grows the same case.
- A staged delete that is rewound must come back where it was: `restoreElement(id, typeName, ord)` and `restoreRelationship(…, ord)` exist for that, and the applier's before-images must carry `ord`. The oracle has no counterpart (it always appends), so those paths are covered by `order.test.ts` and by plan 3's invariants, not by fixtures.
- Values enter through `setProperty` unchecked. The applier is where a staged value holding an array-index key at some depth must be refused; `findArrayIndexKey` in `model/load.ts` is the check to export.

For plan 4 (snapshot reader, engine digest, benchmarks): `engine/test/golden/digest.ts` is the reference the pure-TypeScript SHA-256 is tested against, the vectors in `tests/api/test_state_digest.py` are its known answers, and `snapshot_v2.json` is the reader's first fixture. The budget is tight: line-routed parse 1.49 s (AD-11) plus ≈ 1.05 s of load and rebuild measured here leaves ≈ 0.4 s of the 3 s of CN-3. The two costs to look at first are the uniqueness keys (≈ 0.23 s: one `pyKey` text per element) and the deep array-index scan inside `readProps`.
