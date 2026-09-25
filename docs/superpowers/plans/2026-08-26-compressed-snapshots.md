# Compressed, Compact Snapshots (K-21) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every full-model snapshot — written on eviction, on every 200th commit and at baseline, read on every hydration and history reconstruction — ~20× smaller on the wire and ~2× cheaper to encode, then take the periodic snapshot off the commit's critical section if the measured cost still justifies it.

**Architecture:** A new compact streaming writer (`serialize.iter_model_json_compact`, one `json.dumps` per batch of 2000 entities — byte-identical to a whole-document dumps) feeds a new codec module (`api/snapshot_codec.py`: `encode_snapshot` = compact JSON → streamed gzip member at level 3; `decode_snapshot` = sniff the gzip magic → `gzip.decompress` → `json.loads`, plain bytes pass straight to `json.loads`). `hydration.write_snapshot` / `_hydrate_session` / `reconstruct_model_at` switch to the codec; `storage.snapshot_key` gains a `.json.gz` suffix that is naming only — the decoder branches on the bytes, so every existing `.json` row keeps loading with no migration, no `encoding` column, no blob rewrite. A measurement task at scale 320 then gates a final task: a `snapshot_job.py` daemon thread (the `validation_sweep`/`search_index_build` precedent, with a `snapshot_sync` test seam) that takes `write_mutex` itself, so the triggering commit returns without paying the encode.

**Tech Stack:** Python 3.14 / FastAPI / SQLAlchemy 2 / stdlib `zlib`+`gzip`; pytest via pixi (`pixi run -e core-dev pytest`). No frontend changes.

**Spec:** `docs/superpowers/specs/2026-08-26-large-model-performance-program.md` (§ "Program" item 3, § "K-21 design"). The BACKLOG entry `K-21` (`BACKLOG.md:1028`) carries the owner's proposal and the 2026-08-26 measurements.

## Global Constraints

- Every command goes through **pixi**: single test file `pixi run -e core-dev pytest tests/path/test_x.py -v`; whole backend suite `pixi run core-test`; frontend unit tests `pixi run frontend-test`; lint/format/typecheck `pixi run dr-tidy` (ruff + mypy + pyright + prettier/eslint — all must pass; pyright covers `tests/` too, so no `# type: ignore` shortcuts). The `[feature.api.activation]` hook prints `[ensure_guest]` lines before every command — ignore them.
- Work on a branch `perf/compressed-snapshots` off `main` (create it via `superpowers:using-git-worktrees` at execution time). In a fresh worktree run `pixi run frontend-install` before `dr-tidy` (it dies at `frontend-format` otherwise). The repo integrates feature branches into `main` with a merge commit (see `git log --oneline -5`), then pushes (`BACKLOG.md:1225`: pushing `main` is standing policy). **`main` can move under you** (a concurrent session commits to it directly): re-check `git log origin/main` immediately before merging and pushing.
- **Worktree harness guard:** inside a worktree the harness refuses "complex" compound Bash commands (loops, `&&`-chains with `cd`, parenthesised groups). Use plain single commands, or put the logic in a script under the session scratchpad and run `bash <script>`.
- Comments/docstrings: concise, present tense, only invariants and non-obvious contracts. No spec/plan references, no history narration.
- Python 3.14 idioms (`X | Y` unions, `collections.abc` imports).
- `docs/` is gitignored — the spec and this plan are never committed; every other step commits.
- **Compatibility rule (the spec's):** existing snapshot rows and keys must keep loading. The read path accepts both the old indented `.json` blob and the new compressed one — the decoder branches on the bytes (gzip magic `1f 8b`), NEVER on the key suffix. No migration, no `encoding` column, no blob rewrite, no backfill.
- **The indented save-file writer is untouched.** `serialize.iter_model_json` is the `/model/save` + `/model/download` contract with the frontend; the compact writer is a sibling, not a replacement.
- **K-20 standing constraint:** never build a search index on a transient model. `reconstruct_model_at` returns `search_ready=False` and that stays correct — no `start_search_index_build` on any reconstruction path.
- **K-6 standing constraint:** `Commit.entity_states` NULL means "not captured — reconstruct"; never backfilled. Not touched by this plan.
- **Three snapshots stay synchronous whatever Task 4 decides:** the rebind-forced `write_snapshot` in `POST /commits` (replay tail must never span a rebind), the evict hook (`session.install_persistent_registry._evict`), and `persist_baseline`. Only the *periodic* trigger (`routes/ops.py::_maybe_periodic_snapshot`, shared by `/commits`, `/commits/revert`, `/model/ops`, `/model/undo`) is a candidate for the background job.
- API tests: `tests/api/conftest.py` pins `DATA_ROVER_SNAPSHOT_STORE=memory`, `DATA_ROVER_VALIDATION_SWEEP_SYNC=true`, `DATA_ROVER_SEARCH_INDEX_SYNC=true`, `DATA_ROVER_IDENTITY_PROVIDER=header`; the in-memory SQLite engine is built with `check_same_thread=False` + `StaticPool`, so a background thread may open `db_session()`.
- Model choices that worked for SDD on K-6: haiku for pure transcription tasks (the plan carries the literal code), sonnet for everything else including per-task reviews, the most capable model for the final whole-branch review only.

---

### Task 1: Compact batched writer — `serialize.iter_model_json_compact`

**Files:**
- Modify: `src/data_rover/api/serialize.py` (append after `iter_model_json`, before `iter_buffered`)
- Test: `tests/api/test_serialize_compact.py` (create)

**Interfaces:**
- Produces: `serialize.SNAPSHOT_BATCH: int = 2000`; `serialize.iter_model_json_compact(model: Model) -> Iterator[str]` — yields the snapshot document `{"elements":[…],"relationships":[…]}` with no whitespace, `ensure_ascii=False`, `allow_nan=False`, same entity order and same per-entity key order as `iter_model_json`. `"".join(iter_model_json_compact(m))` **equals** `json.dumps(doc, separators=(",", ":"), ensure_ascii=False)` byte for byte. Task 2's codec consumes it.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_serialize_compact.py`:

```python
"""The compact snapshot writer: byte-identical to a whole-document compact
``json.dumps`` while streaming one batch of entities at a time."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from data_rover.api.routes._snapshot import build_model_from_dicts
from data_rover.api.serialize import (
    SNAPSHOT_BATCH,
    iter_model_json,
    iter_model_json_compact,
)
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship

MM_YAML = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")
MODEL_JSON = Path("examples/smart-city.model.json").read_text(encoding="utf-8")


def _metamodel() -> Metamodel:
    return load_metamodel_str(MM_YAML)


def _example_model() -> Model:
    return build_model_from_dicts(_metamodel(), json.loads(MODEL_JSON))


def _synthetic_model(n_elements: int, n_relationships: int) -> Model:
    """Populate the dicts directly (the bulk-loader pattern) with unicode and
    nested property values, then rebuild the indexes."""
    mm = _metamodel()
    model = Model(mm)
    et = next(t.name for t in mm.elements if not t.abstract)
    rt = mm.relationships[0].name
    for i in range(n_elements):
        eid = f"e{i}"
        model.elements[eid] = Element(
            id=eid,
            type_name=et,
            properties={"name": f"nöde {i}", "k": i, "tags": ["a", {"b": None}]},
            rev=i % 3,
        )
    for i in range(n_relationships):
        rid = f"r{i}"
        model.relationships[rid] = Relationship(
            id=rid,
            type_name=rt,
            source_id=f"e{i}",
            target_id=f"e{(i + 1) % n_elements}",
            properties={},
            rev=0,
        )
    model.indexes.rebuild()
    return model


def _compact_reference(model: Model) -> str:
    doc = json.loads("".join(iter_model_json(model)))
    return json.dumps(doc, separators=(",", ":"), ensure_ascii=False)


def test_compact_matches_whole_document_dumps_on_the_example() -> None:
    model = _example_model()
    assert "".join(iter_model_json_compact(model)) == _compact_reference(model)


def test_compact_matches_across_batch_boundaries() -> None:
    # 2 full batches + a partial one on each side, so first/subsequent-batch
    # comma handling and the partial tail are all exercised
    model = _synthetic_model(2 * SNAPSHOT_BATCH + 7, SNAPSHOT_BATCH + 3)
    assert "".join(iter_model_json_compact(model)) == _compact_reference(model)


def test_compact_exactly_one_batch() -> None:
    model = _synthetic_model(SNAPSHOT_BATCH, 0)
    assert "".join(iter_model_json_compact(model)) == _compact_reference(model)


def test_compact_empty_model() -> None:
    text = "".join(iter_model_json_compact(Model(_metamodel())))
    assert text == '{"elements":[],"relationships":[]}'


def test_compact_streams_more_than_one_chunk_per_list() -> None:
    model = _synthetic_model(2 * SNAPSHOT_BATCH + 7, 0)
    chunks = list(iter_model_json_compact(model))
    # "{", '"elements":[', 3 batches, "]", ",", '"relationships":[', "]", "}"
    assert len(chunks) == 10


def test_compact_rejects_nan_like_the_indented_writer() -> None:
    model = _synthetic_model(3, 0)
    model.elements["e0"].properties["bad"] = float("nan")
    with pytest.raises(ValueError):
        "".join(iter_model_json_compact(model))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_serialize_compact.py -v`
Expected: FAIL at import — `ImportError: cannot import name 'SNAPSHOT_BATCH' from 'data_rover.api.serialize'`.

- [ ] **Step 3: Implement the compact writer**

In `src/data_rover/api/serialize.py`, insert after `iter_model_json` (before `iter_buffered`):

```python
#: entities per ``json.dumps`` call in the compact writer. One C-encoder call
#: per batch amortizes the per-call overhead that dominates a per-entity dump
#: (measured 2x faster) while a batch of ~500 KB text bounds the peak extra
#: memory; the indented writer keeps its per-entity granularity because its
#: re-indent step is per-entity anyway.
SNAPSHOT_BATCH = 2000
_COMPACT_SEPARATORS = (",", ":")


def _dump_batch(batch: list[dict[str, Any]], first: bool) -> str:
    # Dump the batch as a list and strip its brackets: the items' text is
    # exactly what a whole-document dumps emits for them, so the join stays
    # byte-identical to json.dumps(doc, separators=(",", ":")).
    text = json.dumps(
        batch, separators=_COMPACT_SEPARATORS, ensure_ascii=False, allow_nan=False
    )
    return text[1:-1] if first else "," + text[1:-1]


def _compact_chunks(entities: Iterator[dict[str, Any]], key: str) -> Iterator[str]:
    """Yield ``"<key>":[...]`` compact, ``SNAPSHOT_BATCH`` entities per dumps."""
    yield f'"{key}":['
    batch: list[dict[str, Any]] = []
    first = True
    for entity in entities:
        batch.append(entity)
        if len(batch) >= SNAPSHOT_BATCH:
            yield _dump_batch(batch, first)
            first = False
            batch = []
    if batch:
        yield _dump_batch(batch, first)
    yield "]"


def iter_model_json_compact(model: Model) -> Iterator[str]:
    """Yield the snapshot document with no whitespace, batch by batch.

    Same document, entity order and key order as ``iter_model_json``;
    ``"".join(iter_model_json_compact(m))`` equals
    ``json.dumps(doc, separators=(",", ":"), ensure_ascii=False)``. Same
    point-in-time semantics too: the entity SETS are snapshotted when
    iteration starts, entities are read live (see ``iter_model_json``).
    This is the snapshot-store form; the save/download routes keep the
    indented writer, which is the frontend's save-file contract.
    """
    elements = list(model.elements.values())
    relationships = list(model.relationships.values())
    yield "{"
    yield from _compact_chunks(_element_dicts(elements), "elements")
    yield ","
    yield from _compact_chunks(_relationship_dicts(relationships), "relationships")
    yield "}"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_serialize_compact.py tests/api/test_model_io.py -v`
Expected: all PASS (the `test_model_io.py` save-shape test proves the indented writer is untouched).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/serialize.py tests/api/test_serialize_compact.py
git commit -m "perf(serialize): compact batched snapshot writer, byte-identical to whole-document dumps"
```

---

### Task 2: Codec module — `api/snapshot_codec.py`, `.json.gz` key

**Files:**
- Create: `src/data_rover/api/snapshot_codec.py`
- Modify: `src/data_rover/api/storage.py:22` (`_SNAPSHOT_KEY`), and its module docstring's second paragraph
- Modify: `src/data_rover/api/storage_gcs.py:39-42` (the `put` comment)
- Test: `tests/api/test_snapshot_codec.py` (create), `tests/api/test_storage.py:17` (update)

**Interfaces:**
- Consumes: `serialize.iter_model_json_compact`, `serialize.iter_buffered` (Task 1 / existing).
- Produces: `snapshot_codec.SNAPSHOT_GZIP_LEVEL: int = 3`; `snapshot_codec.encode_snapshot(model: Model) -> Iterator[bytes]` (a standard gzip member, streamed); `snapshot_codec.is_gzip(blob: bytes) -> bool`; `snapshot_codec.decode_snapshot(blob: bytes) -> Any` (the parsed document — what `json.loads` of the plain text returns). `storage.snapshot_key(project_id, rev)` → `"projects/{project_id}/snapshots/{rev}.json.gz"`. Task 3 wires all three into `hydration.py`.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_snapshot_codec.py`:

```python
"""The snapshot blob format: gzip of the compact document on the way out,
bytes-sniffing (never key-sniffing) on the way in."""

from __future__ import annotations

import gzip
import json
from pathlib import Path

from data_rover.api.routes._snapshot import build_model_from_dicts
from data_rover.api.serialize import iter_model_json, iter_model_json_compact
from data_rover.api.snapshot_codec import decode_snapshot, encode_snapshot, is_gzip
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model

MM_YAML = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")
MODEL_JSON = Path("examples/smart-city.model.json").read_text(encoding="utf-8")


def _example_model() -> Model:
    return build_model_from_dicts(load_metamodel_str(MM_YAML), json.loads(MODEL_JSON))


def _document(model: Model) -> dict:
    return json.loads("".join(iter_model_json(model)))


def test_encode_is_a_gzip_member_of_the_compact_document() -> None:
    model = _example_model()
    blob = b"".join(encode_snapshot(model))
    assert is_gzip(blob)
    assert gzip.decompress(blob).decode("utf-8") == "".join(
        iter_model_json_compact(model)
    )


def test_encode_decode_roundtrip() -> None:
    model = _example_model()
    assert decode_snapshot(b"".join(encode_snapshot(model))) == _document(model)


def test_decode_accepts_plain_indented_json_bytes() -> None:
    """Rows written before compression hold the indented save-file text."""
    model = _example_model()
    plain = "".join(iter_model_json(model)).encode("utf-8")
    assert not is_gzip(plain)
    assert decode_snapshot(plain) == _document(model)


def test_decode_accepts_plain_compact_json_bytes() -> None:
    plain = b'{"elements":[],"relationships":[]}'
    assert decode_snapshot(plain) == {"elements": [], "relationships": []}


def test_encode_empty_model() -> None:
    blob = b"".join(encode_snapshot(Model(load_metamodel_str(MM_YAML))))
    assert is_gzip(blob)
    assert decode_snapshot(blob) == {"elements": [], "relationships": []}


def test_encode_streams_a_large_model_in_several_chunks() -> None:
    mm = load_metamodel_str(MM_YAML)
    model = Model(mm)
    et = next(t.name for t in mm.elements if not t.abstract)
    for i in range(30_000):
        model.elements[f"e{i}"] = Element(
            id=f"e{i}", type_name=et, properties={"name": "x" * 60, "i": i}, rev=0
        )
    model.indexes.rebuild()
    chunks = list(encode_snapshot(model))
    assert len(chunks) >= 3  # >2 MiB of text at 1 MiB per compress() call + flush
    assert len(decode_snapshot(b"".join(chunks))["elements"]) == 30_000


def test_is_gzip_on_short_input() -> None:
    assert is_gzip(b"") is False
    assert is_gzip(b"\x1f") is False
    assert is_gzip(b"\x1f\x8b") is True
```

In `tests/api/test_storage.py`, replace `test_snapshot_key_scheme`:

```python
def test_snapshot_key_scheme() -> None:
    assert snapshot_key("p1", 7) == "projects/p1/snapshots/7.json.gz"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_snapshot_codec.py tests/api/test_storage.py -v`
Expected: `test_snapshot_codec.py` fails at import (`ModuleNotFoundError: No module named 'data_rover.api.snapshot_codec'`); `test_snapshot_key_scheme` FAILS (`'projects/p1/snapshots/7.json' != 'projects/p1/snapshots/7.json.gz'`); the other storage tests pass.

- [ ] **Step 3: Create the codec module**

Create `src/data_rover/api/snapshot_codec.py`:

```python
"""Snapshot blob format: a gzip member of the compact model document.

The ONE place that knows what bytes the ``SnapshotStore`` holds. Writers
stream ``encode_snapshot`` into ``store.put``; readers hand whatever
``store.get`` returned to ``decode_snapshot``. The decoder branches on the
bytes (the gzip magic) — never on the key — so a row written before
compression (indented JSON under a ``.json`` key) keeps loading, and a
test that puts plain JSON under a ``.json.gz`` key loads too.
"""

from __future__ import annotations

import gzip
import json
import zlib
from collections.abc import Iterator
from typing import Any

from data_rover.core.model.model import Model

from .serialize import iter_buffered, iter_model_json_compact

#: deflate level. 3 is the knee on the compact document: level 6 doubles the
#: encode time for ~15 % fewer bytes, level 1 saves ~10 % time for ~15 % more.
SNAPSHOT_GZIP_LEVEL = 3
#: RFC 1952 member header
_GZIP_MAGIC = b"\x1f\x8b"
#: compact text buffered per ``compress()`` call — one deflate input per
#: ~1 MiB of JSON keeps the call count in the hundreds on a 300 MB model
_COMPRESS_CHUNK_CHARS = 1 << 20
#: 16 + MAX_WBITS = write a gzip member (header + CRC trailer), not raw zlib
_GZIP_WBITS = 16 + zlib.MAX_WBITS


def encode_snapshot(model: Model) -> Iterator[bytes]:
    """Stream the model as one gzip member of its compact JSON document.

    Peak extra memory is one text chunk plus the deflate window; the model
    itself is never materialized as a string.
    """
    comp = zlib.compressobj(SNAPSHOT_GZIP_LEVEL, zlib.DEFLATED, _GZIP_WBITS)
    for text in iter_buffered(iter_model_json_compact(model), _COMPRESS_CHUNK_CHARS):
        out = comp.compress(text.encode("utf-8"))
        if out:
            yield out
    yield comp.flush()


def is_gzip(blob: bytes) -> bool:
    return blob[:2] == _GZIP_MAGIC


def decode_snapshot(blob: bytes) -> Any:
    """Parse a stored snapshot blob, compressed or plain, into the document."""
    if is_gzip(blob):
        blob = gzip.decompress(blob)
    return json.loads(blob)
```

- [ ] **Step 4: Rename the key and fix the two comments**

In `src/data_rover/api/storage.py`, change the key template:

```python
#: blob key for one project's snapshot at a given rev. The suffix documents
#: the format written today; readers never branch on it (snapshot_codec
#: sniffs the bytes), so rows under the older ``.json`` suffix keep loading.
_SNAPSHOT_KEY = "projects/{project_id}/snapshots/{rev}.json.gz"
```

and replace the module docstring's second paragraph (`The model is ~80 MB, so writes stream ...`) with:

```python
Writes stream (``put`` takes an iterable of byte chunks straight from
``snapshot_codec.encode_snapshot``) and reads buffer the whole blob (``get``
returns bytes; hydration then ``decode_snapshot`` + ``build_model_from_dicts``).
The blob is a gzip member of the compact model document — ~5 % of the
indented save-file size.
```

In `src/data_rover/api/storage_gcs.py`, replace the comment inside `put`:

```python
        # buffer the chunks then upload: the google client's resumable upload
        # wants a seekable file-like; the buffer is the COMPRESSED blob (~10 MiB
        # for a 300k-element model), so this is far below the model's own RSS.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_snapshot_codec.py tests/api/test_storage.py tests/api/test_storage_gcs.py -v`
Expected: all PASS (the emulator integration test is skipped unless fake-gcs-server is up — that is normal).

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/snapshot_codec.py src/data_rover/api/storage.py src/data_rover/api/storage_gcs.py tests/api/test_snapshot_codec.py tests/api/test_storage.py
git commit -m "feat(storage): gzip snapshot codec with bytes-sniffing reader; .json.gz keys"
```

---

### Task 3: Wire the codec into hydration (write, hydrate, reconstruct) + bench line

**Files:**
- Modify: `src/data_rover/api/hydration.py:17` (imports), `:75-82` (`write_snapshot`), `:171-173` (`reconstruct_model_at`'s read), `:243-247` (`_hydrate_session`'s download/parse)
- Modify: `scripts/bench.py:186-204` (`bench_serialize`) and its import block
- Test: `tests/api/test_hydration.py` (append)

**Interfaces:**
- Consumes: `snapshot_codec.encode_snapshot`, `snapshot_codec.decode_snapshot`, `storage.snapshot_key` (Task 2).
- Produces: nothing new — `write_snapshot(project_id, session, rev)` keeps its signature; the blob it stores is now gzip. `HydrationProgress.phase` vocabulary (`download | parse | build | replay`) is unchanged: `parse` covers decompress + `json.loads`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_hydration.py` (add `import gzip` and `import json` to the module's imports, plus `from data_rover.api.storage import get_snapshot_store, snapshot_key` — extend the existing `storage` import line):

```python
def test_snapshot_blob_is_gzip_under_the_gz_key() -> None:
    _seed_baseline()
    key = snapshot_key("p1", 0)
    assert key.endswith(".json.gz")
    blob = get_snapshot_store().get(key)
    assert blob[:2] == b"\x1f\x8b"
    assert gzip.decompress(blob) == b'{"elements":[],"relationships":[]}'
    with db.db_session() as s:
        snap = content.latest_snapshot(s, "p1")
        assert snap is not None and snap.key == key


def test_persist_then_hydrate_roundtrip_nonempty_model() -> None:
    from data_rover.core.model.element import Element

    sess = _seed_baseline()
    assert sess.model is not None
    et = _first_concrete_element_type(sess)
    for i in range(3):
        sess.model.elements[f"x{i}"] = Element(
            id=f"x{i}", type_name=et, properties={"name": f"türbine {i}", "n": i}
        )
    sess.model.indexes.rebuild()
    hydration.persist_baseline("p1", sess, author_id=None)
    h = hydration.hydrate_session("p1")
    assert h.model is not None
    assert sorted(h.model.elements) == ["x0", "x1", "x2"]
    assert h.model.elements["x2"].properties == {"name": "türbine 2", "n": 2}


def test_hydrate_loads_a_legacy_plain_json_snapshot_row() -> None:
    """A row written before compression: indented JSON under a ``.json`` key.
    Neither the key nor the bytes are migrated — the reader sniffs."""
    mm = load_metamodel_str(MM_YAML)
    et = next(t.name for t in mm.elements if not t.abstract)
    legacy_key = "projects/p1/snapshots/0.json"
    doc = {
        "elements": [{"id": "old1", "type_name": et, "properties": {"name": "v"}, "rev": 0}],
        "relationships": [],
    }
    get_snapshot_store().put(
        legacy_key, [json.dumps(doc, indent=2, ensure_ascii=False).encode("utf-8")]
    )
    with db.db_session() as s:
        mmrow = content.create_metamodel(s, name="smart-city", version=1, blob=MM_YAML)
        content.upsert_model_row(s, "p1", metamodel_id=mmrow.id)
        content.record_snapshot(s, "p1", rev=0, key=legacy_key)
    h = hydration.hydrate_session("p1")
    assert h.model is not None
    assert h.model.elements["old1"].properties == {"name": "v"}
    assert h.model.indexes.search_ready is True  # sync pin: index built after load


def test_reconstruct_model_at_reads_the_compressed_snapshot() -> None:
    from data_rover.core.model.element import Element

    sess = _seed_baseline()
    assert sess.model is not None
    et = _first_concrete_element_type(sess)
    sess.model.elements["base"] = Element(id="base", type_name=et, properties={})
    sess.model.indexes.rebuild()
    hydration.persist_baseline("p1", sess, author_id=None)
    create = {"kind": "create_element", "temp_id": "e1", "type_name": et, "properties": {}}
    with db.db_session() as s:
        content.append_commit(
            s, "p1", rev=1, commit_id="c1", author_id=None,
            ops=[create], inverse_ops=[], id_map={},
        )
        content.set_model_rev(s, "p1", 1)
    at0 = hydration.reconstruct_model_at("p1", 0)
    at1 = hydration.reconstruct_model_at("p1", 1)
    assert at0 is not None and sorted(at0.elements) == ["base"]
    assert at1 is not None and sorted(at1.elements) == ["base", "e1"]
    assert at1.indexes.search_ready is False  # transient model: no search index
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_hydration.py -v`
Expected: `test_snapshot_blob_is_gzip_under_the_gz_key` FAILS (`blob[:2] == b'{\n'`, not the gzip magic); the other three new tests PASS already (plain JSON under any key loads through `json.loads` today) — they are regression pins for Step 3. Existing tests pass.

- [ ] **Step 3: Switch `hydration.py` to the codec**

In `src/data_rover/api/hydration.py`:

1. Imports: delete `import json`; replace `from .serialize import iter_model_json` with `from .snapshot_codec import decode_snapshot, encode_snapshot`.
2. `write_snapshot` — replace the `store.put(...)` line:

```python
def write_snapshot(project_id: str, session: Session, rev: int) -> None:
    """Stream the session model to the blob store (gzip of the compact
    document) and record the snapshot row."""
    assert session.model is not None
    store = get_snapshot_store()
    key = snapshot_key(project_id, rev)
    store.put(key, encode_snapshot(session.model))
    with db_session() as s:
        content.record_snapshot(s, project_id, rev=rev, key=key)
```

3. `reconstruct_model_at` — replace `raw = json.loads(get_snapshot_store().get(snap_key))` with:

```python
        raw = decode_snapshot(get_snapshot_store().get(snap_key))
```

4. `_hydrate_session` — replace `raw = json.loads(blob)` with:

```python
        raw = decode_snapshot(blob)  # "parse" covers decompress + loads
```

Also update the module docstring's `Persist = write the model snapshot via the streaming serializer + record the row;` to `Persist = stream the model through the snapshot codec + record the row;`.

- [ ] **Step 4: Run the hydration + persistence suites**

Run: `pixi run -e core-dev pytest tests/api/test_hydration.py tests/api/test_strict_mode.py tests/api/test_ops_persistence.py tests/api/test_commits_route.py tests/api/test_commit_model_at.py tests/api/test_commit_diff.py tests/api/test_importer.py -v`
Expected: all PASS. (`test_strict_mode.py::test_hydrate_session_loads_strict_mode` puts PLAIN JSON under `snapshot_key("p1", 0)` — now a `.json.gz` key — and must keep passing untouched: that is the bytes-not-key rule at work.)

- [ ] **Step 5: Add the codec line to the committed bench**

In `scripts/bench.py`, add to the import block (after the `iter_model_json` import, same `# noqa: E402` style):

```python
from data_rover.api.snapshot_codec import encode_snapshot  # noqa: E402
```

and append to `bench_serialize` (after the `(5)` report):

```python
    t0 = time.perf_counter()
    blob_bytes = sum(len(chunk) for chunk in encode_snapshot(model))
    elapsed = time.perf_counter() - t0
    _report("(5b) snapshot codec: compact JSON + gzip (no file)", elapsed,
            f"{blob_bytes / 1_048_576:.1f} MiB")
```

Run: `pixi run -e core-dev python scripts/bench.py --model examples/smart-city.model.json --metamodel examples/smart-city.metamodel.yaml`
Expected: the `(5b)` line prints with a MiB figure well below `(5)`'s.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/hydration.py scripts/bench.py tests/api/test_hydration.py
git commit -m "perf(hydration): snapshots stream through the gzip codec; legacy .json rows still load"
```

---

### Task 4: Measure at scale 320 and decide the critical-section gate

**Files:** none in the repo (the script lives in the session scratchpad). Output: numbers for Task 6's BACKLOG entry and the merge commit, plus a **go / no-go for Task 5**.

**Interfaces:**
- Consumes: everything Tasks 1–3 produced, through the real app (`import_project`, `hydrate_session`, `write_snapshot`).
- Produces: `T_write` (seconds, in-process `write_snapshot` on the memory store at scale 320), `T_write_old` (same, old path), blob sizes, hydrate time. **Gate: Task 5 runs iff `T_write > 1.0 s`.**

- [ ] **Step 1: Generate the production-scale fixture (once, ~1 min)**

```bash
export SCRATCH=<the session scratchpad directory from the system prompt>
pixi run -e core-dev python examples/generate_large_model.py --scale 320 --out "$SCRATCH/prod.model.json"
```

- [ ] **Step 2: Time the write path, old vs new, and the read path**

Write `$SCRATCH/measure_k21.py` (single file so the worktree harness accepts a plain `pixi run -e core-dev python $SCRATCH/measure_k21.py`):

```python
import os, resource, sys, time
os.environ.update({
    "DATA_ROVER_DATABASE_URL": "sqlite://", "DATA_ROVER_DEV_SEED": "false",
    "DATA_ROVER_SNAPSHOT_STORE": "memory", "DATA_ROVER_IDLE_EVICT_SECONDS": "0",
    "DATA_ROVER_LOCK_SWEEP_SECONDS": "0", "DATA_ROVER_VALIDATION_SWEEP_SYNC": "true",
    "DATA_ROVER_SEARCH_INDEX_SYNC": "true", "DATA_ROVER_IDENTITY_PROVIDER": "header",
    "DATA_ROVER_BOOTSTRAP_ADMIN_EMAIL": "", "DATA_ROVER_BOOTSTRAP_ADMIN_PASSWORD": "",
})
sys.path.insert(0, "src")
SCRATCH = os.environ["SCRATCH"]
from data_rover.api import db, db_models  # noqa: F401
from data_rover.api import hydration
from data_rover.api.importer import import_project
from data_rover.api.lock_mirror import MemoryLeaseMirror, set_lease_mirror
from data_rover.api.serialize import iter_model_json
from data_rover.api.session import install_persistent_registry
from data_rover.api.snapshot_codec import decode_snapshot
from data_rover.api.storage import MemorySnapshotStore, get_snapshot_store, set_snapshot_store, snapshot_key

def rss() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024

db.init_engine("sqlite://"); db.create_all()
set_snapshot_store(MemorySnapshotStore()); set_lease_mirror(MemoryLeaseMirror())
install_persistent_registry()
t0 = time.perf_counter()
import_project(project_id="big", name="big", owner_id="u1",
               metamodel_yaml=open("examples/smart-city.metamodel.yaml").read(),
               model_json=open(f"{SCRATCH}/prod.model.json").read())
print(f"import (build + baseline snapshot): {time.perf_counter()-t0:.1f}s  maxrss {rss():.0f} MB")
store = get_snapshot_store()
new_blob = store.get(snapshot_key("big", 0))
print(f"snapshot blob (gzip): {len(new_blob)/2**20:.1f} MiB")

t0 = time.perf_counter(); sess = hydration.hydrate_session("big"); t_hyd = time.perf_counter() - t0
print(f"hydrate (download+parse+build+replay, sync sweeps): {t_hyd:.1f}s  maxrss {rss():.0f} MB")
t0 = time.perf_counter(); decode_snapshot(new_blob); print(f"decode_snapshot alone: {time.perf_counter()-t0:.2f}s")

assert sess.model is not None
r0 = rss()
t0 = time.perf_counter(); hydration.write_snapshot("big", sess, 0); t_write = time.perf_counter() - t0
print(f"T_write  (new: compact+gzip, memory store): {t_write:.2f}s  maxrss +{rss()-r0:.0f} MB")

r0 = rss()
t0 = time.perf_counter()
store.put("old", (c.encode("utf-8") for c in iter_model_json(sess.model)))
t_old = time.perf_counter() - t0
print(f"T_write_old (indented, memory store): {t_old:.2f}s  {len(store.get('old'))/2**20:.1f} MiB  maxrss +{rss()-r0:.0f} MB")
print(f"GATE: Task 5 {'RUNS' if t_write > 1.0 else 'is SKIPPED'} (T_write={t_write:.2f}s)")
```

Run: `pixi run -e core-dev python "$SCRATCH/measure_k21.py"`
Expected (projection from the scale-170 spike): blob ~11 MiB (vs 212 MiB), `T_write` ≈ 2 s (vs ≈ 3.8 s), `decode_snapshot` ≈ 2.3 s (0.3 s gunzip + 2.0 s loads, vs 2.9 s), hydrate dominated by `build_model_from_dicts` + the sync sweeps. `maxrss` growth on the new write should be tens of MB, on the old write hundreds.

- [ ] **Step 3: Record the decision**

Write the five numbers and the gate verdict into `$SCRATCH/k21-numbers.md` (Task 6 copies them into the BACKLOG, Task 7 into the merge commit). If `T_write ≤ 1.0 s`, Task 5 is skipped in full and Task 6's BACKLOG text uses its "NOT done (measured)" variant. No commit in this task.

---

### Task 5 (gated by Task 4: only if `T_write > 1.0 s`): Periodic snapshot as a background job

**Files:**
- Create: `src/data_rover/api/snapshot_job.py`
- Modify: `src/data_rover/api/session.py:24-27` (TYPE_CHECKING imports), `:126-131` (add the `snapshot_job` field after `search_index_build`)
- Modify: `src/data_rover/api/settings.py:130-135` (add `snapshot_sync` after `search_index_sync`)
- Modify: `src/data_rover/api/routes/ops.py:92` (import), `:685-693` (`_maybe_periodic_snapshot`)
- Modify: `tests/api/conftest.py:18-19` (pin `DATA_ROVER_SNAPSHOT_SYNC=true`)
- Test: `tests/api/test_snapshot_job.py` (create), `tests/api/test_settings.py:40-58` (extend both tests)

**Interfaces:**
- Consumes: `hydration.write_snapshot` (Task 3), `session.get_registry().peek`, `Session.write_mutex` (an `RLock` — re-entrant, so the sync path may run while the caller already holds it).
- Produces: `snapshot_job.SnapshotJob` (dataclass: `running: bool = True`, `written_rev: int | None = None`, `done: threading.Event`); `snapshot_job.schedule_periodic_snapshot(project_id: str, session: Session, *, sync: bool | None = None) -> SnapshotJob | None` (`None` = a job is already running for this session); `Session.snapshot_job: SnapshotJob | None`; `Settings.snapshot_sync: bool = False` (`DATA_ROVER_SNAPSHOT_SYNC`). `_maybe_periodic_snapshot` keeps its `(db, project_id, session, rev)` signature (`routes/commits.py:140` imports it) and now schedules instead of writing.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_snapshot_job.py`:

```python
"""The periodic snapshot runs off the commit's critical section: a daemon
thread takes write_mutex itself, snapshots the CURRENT rev, skips sessions
the registry no longer holds, and logs-and-drops failures. The conftest pins
DATA_ROVER_SNAPSHOT_SYNC=true so every other test sees the inline write."""

from __future__ import annotations

import logging
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID, Session, get_registry
from data_rover.api.snapshot_job import SnapshotJob, schedule_periodic_snapshot
from tests.api.conftest import AUTH_HEADERS, papi, seed_default_project

MM = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")


def _client() -> TestClient:
    """Live session + durable model row via the upload routes (the
    test_ops_persistence.py harness), so commits are actually journaled."""
    seed_default_project()
    c = TestClient(create_app())
    r = c.post(papi("/metamodel"), content=MM, headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    r = c.post(
        papi("/model/upload"),
        content=b'{"elements":[],"relationships":[]}',
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text
    return c


def _concrete_type(c: TestClient) -> str:
    mm = c.get(papi("/metamodel"), headers=AUTH_HEADERS).json()
    for et in mm["elements"]:
        if not et.get("abstract"):
            return et["name"]
    raise AssertionError("no concrete element type")


def _create_one(c: TestClient) -> int:
    base = c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]
    r = c.post(
        papi("/model/ops"),
        json={"base_rev": base, "ops": [
            {"kind": "create_element", "temp_id": "tmp_1",
             "type_name": _concrete_type(c), "properties": {}}]},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text
    return r.json()["model_rev"]


def _live_session() -> Session:
    session = get_registry().peek(DEFAULT_PROJECT_ID)
    assert session is not None
    return session


def _latest_snapshot_rev() -> int | None:
    with db.db_session() as s:
        snap = content.latest_snapshot(s, DEFAULT_PROJECT_ID)
        return None if snap is None else snap.rev


def test_async_job_writes_the_snapshot_row(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_SYNC", "false")
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_EVERY", "1")
    c = _client()
    rev = _create_one(c)
    job = _live_session().snapshot_job
    assert job is not None
    assert job.done.wait(10.0), "snapshot job did not finish"
    assert job.running is False
    assert job.written_rev == rev
    assert _latest_snapshot_rev() == rev


def test_sync_job_writes_inline_under_the_conftest_pin() -> None:
    c = _client()
    session = _live_session()
    rev = _create_one(c)  # default snapshot_every=200: no trigger at rev 1
    assert _latest_snapshot_rev() == 0  # the upload's baseline
    job = schedule_periodic_snapshot(DEFAULT_PROJECT_ID, session)  # sync via the pin
    assert job is not None and job.running is False and job.written_rev == rev
    assert _latest_snapshot_rev() == rev


def test_job_snapshots_the_current_rev_not_the_trigger() -> None:
    """Any rev at or past the trigger bounds the replay tail equally."""
    c = _client()
    session = _live_session()
    _create_one(c)
    rev2 = _create_one(c)
    job = schedule_periodic_snapshot(DEFAULT_PROJECT_ID, session, sync=True)
    assert job is not None and job.written_rev == rev2


def test_job_skips_a_session_the_registry_no_longer_holds() -> None:
    c = _client()
    session = _live_session()
    _create_one(c)
    get_registry().discard(DEFAULT_PROJECT_ID)
    job = schedule_periodic_snapshot(DEFAULT_PROJECT_ID, session, sync=True)
    assert job is not None and job.running is False and job.written_rev is None
    assert _latest_snapshot_rev() == 0  # nothing past the baseline


def test_second_trigger_while_a_job_runs_is_dropped() -> None:
    _client()
    session = _live_session()
    session.snapshot_job = SnapshotJob()  # running=True by construction
    assert schedule_periodic_snapshot(DEFAULT_PROJECT_ID, session, sync=True) is None
    session.snapshot_job.running = False
    job = schedule_periodic_snapshot(DEFAULT_PROJECT_ID, session, sync=True)
    assert job is not None and job.written_rev == 0


def test_job_failure_is_logged_not_raised(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    _client()
    session = _live_session()

    def _boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("snapshot store down")

    monkeypatch.setattr("data_rover.api.snapshot_job.write_snapshot", _boom)
    with caplog.at_level(logging.WARNING, logger="data_rover.api.snapshot_job"):
        job = schedule_periodic_snapshot(DEFAULT_PROJECT_ID, session, sync=True)
    assert job is not None and job.running is False and job.written_rev is None
    assert job.done.is_set()
    assert "periodic snapshot failed" in caplog.text


def test_ops_route_survives_a_failing_periodic_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The commit is durable before the snapshot; a store outage must not
    turn a landed batch into a 500."""
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_EVERY", "1")
    c = _client()

    def _boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("snapshot store down")

    monkeypatch.setattr("data_rover.api.snapshot_job.write_snapshot", _boom)
    rev = _create_one(c)  # asserts 200 inside
    assert rev == 1
    assert _latest_snapshot_rev() == 0
```

In `tests/api/test_settings.py`, add to `test_phase3_storage_defaults` (after the `idle_evict_seconds` assert):

```python
    assert s.snapshot_sync is False
```

and to `test_phase3_storage_env_override` (a `setenv` line beside the others and an assert after them):

```python
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_SYNC", "true")
```
```python
    assert s.snapshot_sync is True
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_snapshot_job.py tests/api/test_settings.py -v`
Expected: `test_snapshot_job.py` fails at import (`ModuleNotFoundError: No module named 'data_rover.api.snapshot_job'`); the two settings tests FAIL on `snapshot_sync` (`AttributeError` / the override assert).

- [ ] **Step 3: Setting + conftest pin + session field**

In `src/data_rover/api/settings.py`, after the `search_index_sync` field:

```python
    #: Run the periodic full-model snapshot inline on the committing request
    #: (synchronously, inside its write_mutex section) instead of on a daemon
    #: thread. False in production; the API test conftest pins it true so a
    #: test can assert the snapshot row right after the commit returns.
    snapshot_sync: bool = False
```

In `tests/api/conftest.py`, after the `DATA_ROVER_SEARCH_INDEX_SYNC` line:

```python
os.environ.setdefault("DATA_ROVER_SNAPSHOT_SYNC", "true")
```

In `src/data_rover/api/session.py`, extend the `TYPE_CHECKING` block:

```python
if TYPE_CHECKING:
    from .schemas import OpIn
    from .search_index_build import SearchIndexProgress
    from .snapshot_job import SnapshotJob
    from .validation_sweep import SweepProgress
```

and add the field right after `search_index_build`:

```python
    #: the in-flight (or last) periodic snapshot job
    #: (snapshot_job.schedule_periodic_snapshot); a trigger that finds one
    #: still running is dropped. Never blocks eviction: the job checks the
    #: registry under write_mutex and writes nothing for a dropped session.
    snapshot_job: SnapshotJob | None = field(default=None, repr=False)
```

- [ ] **Step 4: Create the job module**

Create `src/data_rover/api/snapshot_job.py`:

```python
"""Periodic full-model snapshot, off the commit's critical section.

The journal writers trigger a snapshot every ``settings.snapshot_every``
commits. Encoding a large model takes seconds, so the trigger schedules
this job instead of writing inline: a daemon thread takes
``session.write_mutex`` itself and snapshots the model at whatever rev it
finds there — any rev at or past the trigger bounds the replay tail
equally. Under the mutex it also re-checks that the registry still holds
this exact session: an evicted session was already snapshotted by the
evict hook, and a discarded one belongs to a deleted project whose row
would violate the FK. One job per session at a time; a trigger that finds
one running is dropped (the next multiple re-triggers). Failure is logged
and dropped — the commit is durable, and hydration rebuilds the snapshot
on the next cache-miss.

The snapshots that are correctness rather than bounding — rebind-forced,
evict, baseline — stay synchronous in their callers and never come here.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field

from .hydration import write_snapshot
from .session import Session, get_registry
from .settings import get_settings

logger = logging.getLogger(__name__)


@dataclass
class SnapshotJob:
    """Handle of one scheduled periodic snapshot (tests join ``done``)."""

    running: bool = True
    #: rev actually written, or None when the job wrote nothing
    written_rev: int | None = None
    done: threading.Event = field(default_factory=threading.Event)


def schedule_periodic_snapshot(
    project_id: str, session: Session, *, sync: bool | None = None
) -> SnapshotJob | None:
    """Schedule (or, in sync mode, run inline) a snapshot of ``session``.

    ``sync=None`` reads ``settings.snapshot_sync``. Returns ``None`` when a
    job is already running for the session.
    """
    current = session.snapshot_job
    if current is not None and current.running:
        return None
    job = SnapshotJob()
    session.snapshot_job = job
    if sync if sync is not None else get_settings().snapshot_sync:
        _run(project_id, session, job)
    else:
        threading.Thread(
            target=_run,
            args=(project_id, session, job),
            name="snapshot-job",
            daemon=True,
        ).start()
    return job


def _run(project_id: str, session: Session, job: SnapshotJob) -> None:
    try:
        with session.write_mutex:
            if get_registry().peek(project_id) is not session or session.model is None:
                return
            rev = session.model_rev
            write_snapshot(project_id, session, rev)
            job.written_rev = rev
    except Exception:
        logger.warning(
            "periodic snapshot failed for project %s; commit is durable, "
            "hydration will rebuild",
            project_id,
            exc_info=True,
        )
    finally:
        job.running = False
        job.done.set()
```

- [ ] **Step 5: Make the trigger schedule instead of write**

In `src/data_rover/api/routes/ops.py`: change the hydration import line to `from ..hydration import serialize_ops` and add `from ..snapshot_job import schedule_periodic_snapshot` (keep imports sorted — ruff enforces it). Replace `_maybe_periodic_snapshot`:

```python
def _maybe_periodic_snapshot(
    db: DbSession, project_id: str, session: Session, rev: int
) -> None:
    """Schedule a full-model snapshot every settings.snapshot_every commits so
    the hydration replay tail stays bounded for a hot, never-evicted session
    (on-evict + baseline snapshots otherwise leave it unbounded). The write
    happens on the snapshot job's thread, off this request's critical
    section; ``snapshot_sync`` (tests) runs it inline instead."""
    every = get_settings().snapshot_every
    if every > 0 and rev % every == 0:
        schedule_periodic_snapshot(project_id, session)
```

`write_snapshot` is still imported in `routes/commits.py` for the rebind-forced snapshot — leave that file alone. If ruff reports `write_snapshot` unused in `ops.py` after the change, that is the expected import removal above.

- [ ] **Step 6: Run the job tests and the periodic-snapshot regressions**

Run: `pixi run -e core-dev pytest tests/api/test_snapshot_job.py tests/api/test_settings.py tests/api/test_ops_persistence.py tests/api/test_commits_route.py tests/api/test_commits_revert.py tests/api/test_session_registry.py -v`
Expected: all PASS. In particular `test_ops_persistence.py::test_periodic_snapshot_written_when_snapshot_every_1` and `test_commits_route.py::test_commit_writes_periodic_snapshot_when_snapshot_every_1` pass unchanged under the sync pin, and `test_commit_survives_post_commit_snapshot_failure` still passes (it patches the wrapper, upstream of the job).

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/api/snapshot_job.py src/data_rover/api/session.py src/data_rover/api/settings.py src/data_rover/api/routes/ops.py tests/api/conftest.py tests/api/test_snapshot_job.py tests/api/test_settings.py
git commit -m "perf(commits): periodic snapshot runs on a background job off the commit's critical section"
```

---

### Task 6: Docs and backlog

**Files:**
- Modify: `CLAUDE.md` (the "Durable persistence" section, the `storage.py / storage_gcs.py` bullet at `:100-106`, and the `POST /model/ops` bullet at `:113-118`)
- Modify: `BACKLOG.md:1028-1035` (`### K-21`), and the header paragraph ending at `:59`

**Interfaces:** none — prose only. Fill every `<…>` placeholder from `$SCRATCH/k21-numbers.md` (Task 4).

- [ ] **Step 1: CLAUDE.md**

In the "Durable persistence" section, append this sentence to the `storage.py` / `storage_gcs.py` bullet (after `... while prod never calls \`storage.buckets.create\`.`):

```markdown
  **`snapshot_codec.py`** is the ONE place that knows the blob format — `encode_snapshot`
  streams a gzip member (level 3) of the COMPACT document (`serialize.iter_model_json_compact`,
  one `json.dumps` per `SNAPSHOT_BATCH` = 2000 entities, byte-identical to a whole-document
  dumps; ~5 % of the indented save-file size), and `decode_snapshot` sniffs the gzip magic and
  falls through to plain `json.loads`, so every row written before compression (indented JSON
  under a `.json` key) still loads: the `.json.gz` key suffix is naming only, readers NEVER
  branch on it, and there is no migration, `encoding` column or backfill. The indented
  `iter_model_json` stays the `/model/save` + `/model/download` contract.
```

Then, only if Task 5 ran, append to the `POST /model/ops` bullet (after `... (journal stays append-only; \`model_rev\` moves forward).`):

```markdown
  The every-`snapshot_every` **periodic snapshot** (`routes/ops.py::_maybe_periodic_snapshot`,
  shared by `/commits`, `/commits/revert`, `/model/ops`, `/model/undo`) is scheduled on a
  daemon thread (`api/snapshot_job.py`) that takes `write_mutex` itself, snapshots whatever
  rev it finds (any rev at or past the trigger bounds the replay tail equally), writes nothing
  for a session the registry no longer holds, and logs-and-drops failures; one job per session
  at a time. `DATA_ROVER_SNAPSHOT_SYNC=true` (the test conftest) runs it inline. The
  rebind-forced, evict and baseline snapshots stay synchronous — they are correctness, not
  bounding.
```

- [ ] **Step 2: BACKLOG.md**

Replace the `### K-21` heading and paragraph with (choose ONE of the two final sentences per Task 4's verdict):

```markdown
### K-21 · Snapshots are stored indented and uncompressed · `done` (2026-08-26, perf/compressed-snapshots) · perf · *2026-08-26*
Snapshots are now a gzip member (level 3) of the COMPACT document, encoded in batches of
2000 entities per `json.dumps` (`serialize.iter_model_json_compact`, `api/snapshot_codec.py`);
the reader sniffs the gzip magic, so pre-existing `.json` rows load untouched (no migration,
no `encoding` column). Measured at scale 320 (320k elements / 239k relationships) through the
real app on the memory store: snapshot blob **212 MiB → <blob> MiB**; in-process
`write_snapshot` **<T_write_old> s → <T_write> s**; `decode_snapshot` <decode> s (was 2.9 s
`json.loads` of the indented text); hydrate end-to-end <hydrate> s with sync sweeps.
Spike numbers behind the two knobs (scale 170): batching the encoder 1.58 → 0.82 s; gzip
1/3/6/9 = 0.26/0.29/0.62/2.37 s for 6.7/5.8/4.9/4.5 MiB.
The periodic snapshot (`_maybe_periodic_snapshot`) now runs on a background job
(`api/snapshot_job.py`) that takes `write_mutex` itself, so the 200th commit no longer pays
the encode; rebind-forced, evict and baseline snapshots stay synchronous.
```

If Task 5 was skipped, replace the last sentence with:

```markdown
NOT done (measured): moving the periodic snapshot off the commit's critical section —
in-process `write_snapshot` came in at <T_write> s at scale 320, under the 1 s bar set for it.
```

Then, in the header paragraph, append after `... K-21 → K-25 as the large-model performance program (see K-6, now first in that program).`:

```markdown
The 2026-08-26 pass on `perf/compressed-snapshots` closes K-21 (gzip'd compact snapshots,
bytes-sniffing reader; see its entry for the numbers).
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md BACKLOG.md
git commit -m "docs: compressed snapshots — CLAUDE.md persistence notes, backlog (K-21 done)"
```

---

### Task 7: Full verification and integration

**Files:** none new.

- [ ] **Step 1: Lint/format/typecheck**

Run: `pixi run dr-tidy`
Expected: ruff, mypy, pyright, prettier and eslint all pass. Typical fixes: import ordering in `routes/ops.py` / `hydration.py`; a dropped `json` import in `hydration.py`; ruff reformatting of the long test literals. Amend into the relevant commit or add a `chore:` commit.

- [ ] **Step 2: Whole suites**

Run: `pixi run core-test`
Expected: PASS, count ≥ 2176 + the new tests (Task 1: 6, Task 2: 7, Task 3: 4, Task 5: 7 if it ran), zero new skips (the fake-gcs integration test's skip is pre-existing).

Run: `pixi run frontend-test`
Expected: PASS (no frontend files changed; this proves it).

- [ ] **Step 3: Re-run the Task 4 measurement on the final tree**

Run: `pixi run -e core-dev python "$SCRATCH/measure_k21.py"`
Expected: numbers within noise of Task 4's; if Task 5 ran, additionally confirm through the app that a commit at a snapshot boundary returns before the row lands — append to the script and run once:

```python
from fastapi.testclient import TestClient
from data_rover.api.main import create_app
os.environ["DATA_ROVER_SNAPSHOT_SYNC"] = "false"; os.environ["DATA_ROVER_SNAPSHOT_EVERY"] = "1"
c = TestClient(create_app()); c.headers.update({"x-user-id": "u1", "x-user-email": "u1@example.com"})
P = "/api/v1/projects/big"
rev = c.get(f"{P}/model/summary").json()["model_rev"]
el = c.get(f"{P}/model/elements", params={"limit": 1}).json()["items"][0]
key = next(iter(el["properties"]))
tok = c.post(f"{P}/locks", json={"targets": [{"resource_id": el["id"], "mode": "exclusive", "type": "element"}], "intent": "edit"}).json()["token"]
t0 = time.perf_counter()
r = c.post(f"{P}/commits", json={"base_rev": rev, "ops": [{"kind": "update_element", "id": el["id"], "properties_patch": {key: "bench"}}], "lock_tokens": [tok]})
t_commit = time.perf_counter() - t0
assert r.status_code == 200, r.text
from data_rover.api.session import get_registry
job = get_registry().peek("big").snapshot_job
t0 = time.perf_counter(); job.done.wait(60); t_job = time.perf_counter() - t0
print(f"commit at a snapshot boundary: {t_commit*1000:.0f} ms; background snapshot finished {t_job:.2f}s later (rev {job.written_rev})")
```

(`get_settings()` builds a fresh `Settings` per call, so the env override takes effect immediately.) Expected: the commit returns in tens of milliseconds; the job finishes ≈ `T_write` later.

- [ ] **Step 4: Integrate**

Use `superpowers:finishing-a-development-branch`: re-check `git log --oneline origin/main -3` first (a concurrent session may have moved `main`), merge `perf/compressed-snapshots` into `main` with a merge commit whose body carries the Task 4 numbers, run `pixi run core-test` on the merged result, push `main`, remove the worktree. Leave `.claude/worktrees/feat-metamodel-diagram-editor` alone — it belongs to someone else.

---

### Task 8: Hand off to the next plan (K-22 — uniqueness `position` map)

**Files:** none in the repo (the handoff lives in `~/.claude/handoffs/`).

- [ ] **Step 1: Reconstruct state**

Run: `git status --short && git branch --show-current && git log --oneline -5 && pixi run core-test -q | tail -3` (as separate plain commands if the harness refuses the chain).

- [ ] **Step 2: Invoke the handoff skill**

Invoke `handoff` (the `Skill` tool, name `handoff`). Fill its sections with these facts (pointers, not payload):

- **Mission:** the large-model performance program from `docs/superpowers/specs/2026-08-26-large-model-performance-program.md` (§ "Program"); K-20, K-6 and K-21 are merged; the next session writes and executes the plan for **K-22** (`validators/uniqueness.py:56` builds a whole-model `{eid: i}` position map — 96 ms at 320k — per scoped run that touches a duplicate group, under `write_mutex`, up to 350× per background sweep: maintain an insertion-position index in `IndexSet`, or hoist the map onto the validator for a sweep's lifetime), then hands off to K-23, and so on — every plan's last task is this same handoff step.
- **Orient First:** the spec above (§ "Program" item 4); `BACKLOG.md` K-22 → K-25 (with measurements); `src/data_rover/core/validation/validators/uniqueness.py` (the position map at `:56` and how it is consumed); `src/data_rover/core/model/indexes.py` (`IndexSet` — `roots_order` is the precedent for a maintained order index at the mutation boundary; `rebuild()` and the mutation hooks); `src/data_rover/api/validation_sweep.py` (the 350-chunk sweep that pays the map per chunk; `CHUNK_SIZE`); `src/data_rover/core/validation/pipeline.py` (`MetamodelMemo`, per-run validator memo caches — the natural home for a per-sweep hoist); `tests/validation/test_uniqueness*.py`; this plan (`docs/superpowers/plans/2026-08-26-compressed-snapshots.md`) as the shape to match.
- **Standing Constraints:** K-20 (no search index on transient models; `keep_search=True` only at the four rebind sites); K-6 (`Commit.entity_states` NULL = reconstruct, never backfilled); K-21 (the snapshot reader branches on bytes, never on the key — never add a key-suffix branch or a migration; `iter_model_json` stays the save-file contract; rebind/evict/baseline snapshots stay synchronous); per-entity validator hooks must be O(entity) — the uniqueness fix must not move the O(model) cost somewhere else (e.g. a per-mutation reindex); `docs/` gitignored; pixi for everything; merge-commit integration; `pixi run frontend-install` before `dr-tidy` in a fresh worktree; the worktree harness guard (plain single commands or a scratchpad script); a concurrent session commits directly to `main` — re-check before merge/push.
- **Known Issues, Not Yet Fixed:** K-22 → K-25 as listed in the BACKLOG; `ENTITY_STATES_MAX` is an entity-count cap, not a byte cap (`api/commit_states.py:36`; the K-6 final review's forward-looking note — record, do not build, unless a planned task owns it); snapshot blob GC (orphans from `clear_history` and the old `.json` blob a baseline reset no longer overwrites — recorded out of scope in `content.py`); `scripts/bench.py:208` pyright note (pre-existing, invisible to `dr-tidy`).
- **Deferred — Do Not Do:** zstd for snapshots (`compression.zstd` is in this build; ~0.4 s per write at scale 320, a second magic branch — recorded in the spec's K-21 non-goals); shallow-copy-then-serialize-outside-the-mutex (the upgrade path if the job's mutex hold contends); an `encoding` column on `Snapshot`; the items already deferred by K-20/K-6 (posting-set shrinking, entity_states backfill, `GET /commits/{rev}/model` journal-based).
- **Plan:** 1. `superpowers:writing-plans` for K-22 (`docs/superpowers/plans/<date>-uniqueness-position-index.md`), argued from the spec's § "Program" item 4 and matching this plan's shape. 2. Execute with `superpowers:subagent-driven-development` on `perf/uniqueness-position-index`. 3. Pre-flight conflict scan: check each task's *test preconditions* against what earlier tasks install. 4. Verify + measure (the sweep at scale 320: per-chunk time before/after) + merge commit + push, then hand off to K-23.
- **Open Questions:** none blocking. Record: whether Task 4's measurement put `decode_snapshot` (gunzip + loads) or `build_model_from_dicts` as the dominant hydration phase now — if build dominates by >3×, the program's next candidate after K-25 is a build-side change, not more I/O work.

- [ ] **Step 3: Deliver**

Reply exactly as the handoff skill prescribes: the file path, the one-line paste command, and the full handoff in one fenced block.
