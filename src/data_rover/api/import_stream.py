"""Stream a model document into the head tables.

``ingest_model`` reads the save-file JSON incrementally, so the document is never
held whole and no ``Model`` is built. Each entity is checked on its own (type,
abstractness, declared properties, shape), written as a row with its element
references, and folded into the state digest. Whatever needs the whole file is
checked afterwards in SQL, over the rows just written: ids shared by an element
and a relationship, relationship ends, dangling references, containment. Any
refusal is a 422 that names the check, and the caller's transaction, which holds
every row, rolls back.

The parser is ijson's pure-Python backend on purpose. The C backend (yajl) fails
on an integer past 2**63 that ``json.loads`` keeps exact. Neither backend reads
a bare ``NaN``/``Infinity``/``-Infinity``, which ``parse_model_json`` reads as the
strings ``"NaN"``/``"Infinity"``/``"-Infinity"``; ``_NonFiniteFilter`` rewrites
those literals to exactly those strings before the parser sees them.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any, BinaryIO

import ijson  # type: ignore[import-untyped]  # no stubs
from fastapi import HTTPException
from ijson.common import ObjectBuilder  # type: ignore[import-untyped]
from sqlalchemy import exists, func, insert, select, text
from sqlalchemy.orm import Session as DbSession

from data_rover.core.metamodel.schema import Metamodel

from . import content, head
from .db_models import ElementRow, RelationshipRow
from .rebind_check import (
    LIMIT,
    containment_types,
    containment_violations,
    dangling_references,
)
from .routes._snapshot import _reject_reserved_id
from .state_digest import entity_hash, format_digest

_parser = ijson.get_backend("python")

#: top-level keys whose arrays hold entities
_SECTIONS = ("elements", "relationships")
_OPEN = ("start_map", "start_array")
_CLOSE = ("end_map", "end_array")
#: ``rev`` is a 32-bit column on Postgres
_REV_LIMIT = 2**31
#: bytes read from the source per call when the parser asks for no particular size
_READ_SIZE = 64 * 1024

# --- bare non-finite literals ------------------------------------------------

_STRING_BODY = rb'[^"\\]*(?:\\.[^"\\]*)*'
#: a whole string, a string the end of the buffer cuts (``bs``: after a lone
#: backslash), or a literal
_TOKEN = re.compile(
    rb'(?P<str>"' + _STRING_BODY + rb'")'
    rb'|(?P<open>"' + _STRING_BODY + rb"(?P<bs>\\)?\Z)"
    rb"|(?P<lit>-?Infinity|NaN)",
    re.DOTALL,
)
#: the rest of a string a previous buffer left open
_STRING_REST = re.compile(_STRING_BODY + rb'(?:(?P<end>")|(?P<bs>\\)?\Z)', re.DOTALL)
_SPACE = re.compile(rb"[ \t\r\n]*")
_LITERALS = (b"NaN", b"Infinity", b"-Infinity")
_LITERAL_PREFIXES = frozenset(lit[:i] for lit in _LITERALS for i in range(1, len(lit)))
_LONGEST_PREFIX = max(map(len, _LITERALS)) - 1


class _NonFiniteFilter:
    """A read-only file that rewrites each bare ``NaN``, ``Infinity`` and
    ``-Infinity`` outside a string to the JSON string of the same text.

    That is what ``serialize.parse_model_json`` yields for them, so the value
    the parser then hands over is identical. A literal in a key position (one
    followed by ``:``) is left alone and the parser refuses the document, as
    ``json.loads`` does. What the end of a read may cut, a literal, what a
    literal starts with or a backslash, is held back for the next read, and a
    string left open is remembered as such, so the result does not depend on
    where the reads fall and a long string is scanned once."""

    def __init__(self, source: BinaryIO) -> None:
        self._source = source
        self._carry = b""
        self._in_string = False

    def read(self, size: int = -1) -> bytes:
        if size == 0:  # the parser probes with read(0) for the kind of file
            return b""
        while True:
            chunk = self._source.read(size if size > 0 else _READ_SIZE)
            eof = not chunk
            out, self._carry, self._in_string = _rewrite(
                self._carry + chunk, self._in_string, eof=eof
            )
            if out or eof:
                return out


def _rewrite(buf: bytes, in_string: bool, *, eof: bool) -> tuple[bytes, bytes, bool]:
    """``buf`` with its literals rewritten, up to the first bytes the end of the
    buffer may cut; those bytes (all of them at ``eof``); and whether the
    buffer ends inside a string. ``in_string`` says it starts inside one."""
    pos = 0
    if in_string:
        rest = _STRING_REST.match(buf)
        assert rest is not None
        if rest.group("end") is None:
            if eof:
                return buf, b"", False
            if rest.group("bs"):
                return buf[:-1], buf[-1:], True
            return buf, b"", True
        pos = rest.end()
    parts: list[bytes] = []
    copied = 0
    cut = len(buf)
    scanned = pos
    opened = False
    for m in _TOKEN.finditer(buf, pos):
        kind = m.lastgroup
        if kind == "open":
            if eof:
                continue
            if m.group("bs"):
                cut = len(buf) - 1
            opened = True
            break
        scanned = m.end()
        if kind == "str":
            continue
        space = _SPACE.match(buf, m.end())
        assert space is not None
        after = space.end()
        if after == len(buf) and not eof:
            cut = m.start()
            break
        if buf.startswith(b":", after):
            continue
        parts.append(buf[copied : m.start()])
        parts.append(b'"' + m.group() + b'"')
        copied = m.end()
    else:
        if not eof:
            tail = buf[scanned:]
            for k in range(min(_LONGEST_PREFIX, len(tail)), 0, -1):
                if tail[-k:] in _LITERAL_PREFIXES:
                    cut = len(buf) - k
                    break
    parts.append(buf[copied:cut])
    return b"".join(parts), buf[cut:], opened


# --- the stream of entities --------------------------------------------------


def _refuse(detail: str) -> HTTPException:
    return HTTPException(status_code=422, detail=detail)


def _entities(source: BinaryIO) -> Iterator[tuple[str, int, Any]]:
    """Each item of the top-level ``elements`` and ``relationships`` arrays, as
    ``(section, index, parsed value)``, in file order, wherever the two arrays
    sit in the file. Other top-level keys are skipped."""
    events = _parser.basic_parse(_NonFiniteFilter(source), use_float=True)
    if next(events, None) != ("start_map", None):
        raise _refuse("Model payload must be a JSON object")
    depth = 1
    section = ""
    index = 0
    seen: set[str] = set()
    builder: ObjectBuilder | None = None
    built_depth = 0
    for event, value in events:
        if builder is not None:
            builder.event(event, value)
            built_depth += (event in _OPEN) - (event in _CLOSE)
            if built_depth == 0:
                yield section, index, builder.value
                index += 1
                builder = None
            continue
        in_array = depth == 2 and section in _SECTIONS
        if event == "map_key":
            if depth == 1:
                section = value
                if section in _SECTIONS:
                    if section in seen:
                        raise _refuse(f"Model payload repeats field {section!r}")
                    seen.add(section)
                    index = 0
        elif event in _OPEN:
            if depth == 1 and section in _SECTIONS and event != "start_array":
                raise _refuse(f"Model payload field {section!r} must be a list")
            if in_array:
                builder = ObjectBuilder()
                builder.event(event, value)
                built_depth = 1
            else:
                depth += 1
        elif event in _CLOSE:
            depth -= 1
        elif depth == 1 and section in _SECTIONS:
            raise _refuse(f"Model payload field {section!r} must be a list")
        elif in_array:
            yield section, index, value
            index += 1


# --- per-entity checks and the rows ------------------------------------------


@dataclass
class _Failures:
    """The entities the per-entity checks refuse, by check: how many, and the
    first ``LIMIT`` ids."""

    by_check: dict[str, tuple[int, list[str]]] = field(default_factory=dict)

    def add(self, check: str, entity_id: str) -> None:
        count, ids = self.by_check.get(check, (0, []))
        if len(ids) < LIMIT:
            ids.append(entity_id)
        self.by_check[check] = (count + 1, ids)

    def __bool__(self) -> bool:
        return bool(self.by_check)

    def detail(self) -> str:
        return "; ".join(
            f"{check}: {count} {'entity' if count == 1 else 'entities'}, "
            f"first {', '.join(ids)}"
            for check, (count, ids) in self.by_check.items()
        )


@dataclass
class ImportReport:
    elements: int
    relationships: int


class _Ingest:
    def __init__(self, db: DbSession, project_id: str, metamodel: Metamodel) -> None:
        self.db = db
        self.project_id = project_id
        self.metamodel = metamodel
        self.ref_props = head.ref_props(metamodel)
        self.failures = _Failures()
        self.elements: list[dict[str, Any]] = []
        self.relationships: list[dict[str, Any]] = []
        self.refs: list[tuple[str, str]] = []
        self.element_count = 0
        self.relationship_count = 0
        self.digest = 0
        #: the ids written so far, per label
        self._seen: dict[str, set[str]] = {"element": set(), "relationship": set()}

    def run(self, source: BinaryIO) -> None:
        try:
            for section, index, value in _entities(source):
                if section == "elements":
                    self._element(index, value)
                else:
                    self._relationship(index, value)
        except (ijson.JSONError, ValueError) as exc:
            raise _refuse(f"invalid JSON: {exc}") from exc
        self._flush()
        if self.failures:
            raise _refuse(self.failures.detail())

    def _shape(
        self, where: str, section: str, value: Any, *keys: str
    ) -> tuple[str, dict[str, Any], dict[str, Any], int] | None:
        """The id, the properties and the rev of an entity of the right shape,
        or ``None`` after recording the refusal."""
        if not isinstance(value, dict):
            self.failures.add("invalid entity", where)
            return None
        entity_id = value.get("id")
        label = entity_id if isinstance(entity_id, str) else where
        props = value.get("properties")
        rev = value.get("rev", 0)
        if (
            not isinstance(entity_id, str)
            or not all(isinstance(value.get(k), str) for k in keys)
            or not (props is None or isinstance(props, dict))
            or isinstance(rev, bool)
            or not isinstance(rev, int)
            or not -_REV_LIMIT < rev < _REV_LIMIT
        ):
            self.failures.add("invalid entity", label)
            return None
        try:
            _reject_reserved_id(entity_id, element=section == "elements")
        except HTTPException:
            self.failures.add("reserved id", entity_id)
            return None
        return entity_id, value, props if props is not None else {}, rev

    def _element(self, index: int, value: Any) -> None:
        shaped = self._shape(f"elements[{index}]", "elements", value, "type_name")
        if shaped is None:
            return
        entity_id, entity, props, rev = shaped
        type_name = entity["type_name"]
        et = self.metamodel.element_type(type_name)
        if et is None:
            self.failures.add("unknown element type", entity_id)
            return
        if et.abstract:
            self.failures.add("abstract element type", entity_id)
            return
        declared = self.metamodel.effective_element_property_names(type_name)
        text = self._encoded(entity_id, props, declared)
        if text is None:
            return
        self.digest ^= entity_hash(entity_id, rev)
        self.elements.append(
            {
                "project_id": self.project_id,
                "id": entity_id,
                "type_name": type_name,
                "properties": text,
                "rev": rev,
                "seq": self.element_count,
            }
        )
        self.element_count += 1
        names = self.ref_props.element.get(type_name, ())
        if names:
            self.refs.extend((entity_id, t) for t in head.refs_of(props, names))
        if len(self.elements) >= head.CHUNK:
            self._flush()

    def _relationship(self, index: int, value: Any) -> None:
        shaped = self._shape(
            f"relationships[{index}]",
            "relationships",
            value,
            "type_name",
            "source_id",
            "target_id",
        )
        if shaped is None:
            return
        entity_id, entity, props, rev = shaped
        type_name = entity["type_name"]
        if self.metamodel.relationship_type(type_name) is None:
            self.failures.add("unknown relationship type", entity_id)
            return
        declared = self.metamodel.effective_relationship_property_names(type_name)
        text = self._encoded(entity_id, props, declared)
        if text is None:
            return
        self.digest ^= entity_hash(entity_id, rev)
        self.relationships.append(
            {
                "project_id": self.project_id,
                "id": entity_id,
                "type_name": type_name,
                "source_id": entity["source_id"],
                "target_id": entity["target_id"],
                "properties": text,
                "rev": rev,
                "seq": self.relationship_count,
            }
        )
        self.relationship_count += 1
        names = self.ref_props.relationship.get(type_name, ())
        if names:
            self.refs.extend((entity_id, t) for t in head.refs_of(props, names))
        if len(self.relationships) >= head.CHUNK:
            self._flush()

    def _encoded(
        self, entity_id: str, props: dict[str, Any], declared: Any
    ) -> str | None:
        if not props.keys() <= declared:
            self.failures.add("undeclared property", entity_id)
            return None
        try:
            return head.encode_properties(props)
        except ValueError:
            # a float past the double range (1e999); no writer here can emit it
            self.failures.add("non-finite number", entity_id)
            return None

    def _flush(self) -> None:
        """Write the buffered rows, unless an entity was refused already: the
        import is going to fail, and the parse only counts what is left."""
        for table, rows, label in (
            (ElementRow, self.elements, "element"),
            (RelationshipRow, self.relationships, "relationship"),
        ):
            if rows and not self.failures:
                self._insert(table, rows, label)
            rows.clear()
        if self.refs and not self.failures:
            head.insert_refs(self.db, self.project_id, self.refs)
        self.refs.clear()

    def _insert(
        self, table: type[ElementRow] | type[RelationshipRow], rows: list, label: str
    ) -> None:
        ids = [r["id"] for r in rows]
        # The project's rows are this import's alone (``ingest_model`` clears
        # them first), so an earlier batch is the only other place a duplicate
        # can be. A database probe per batch is planned, for rows the planner
        # has no statistics on, as a scan of the project's whole range.
        seen = self._seen[label]
        taken = {i for i, n in Counter(ids).items() if n > 1}
        taken.update(seen.intersection(ids))
        seen.update(ids)
        if taken:
            for entity_id in dict.fromkeys(ids):
                if entity_id in taken:
                    self.failures.add(f"duplicate {label} id", entity_id)
            return
        self.db.execute(insert(table), rows)


# --- the checks over the rows ------------------------------------------------


def _shared_ids(db: DbSession, project_id: str) -> list[str]:
    return list(
        db.execute(
            select(ElementRow.id)
            .join(
                RelationshipRow,
                (RelationshipRow.project_id == ElementRow.project_id)
                & (RelationshipRow.id == ElementRow.id),
            )
            .where(ElementRow.project_id == project_id)
            .order_by(ElementRow.id)
            .limit(LIMIT)
        ).scalars()
    )


def _loose_relationships(db: DbSession, project_id: str) -> list[str]:
    def missing(end: Any) -> Any:
        return ~exists().where(
            ElementRow.project_id == RelationshipRow.project_id, ElementRow.id == end
        )

    return list(
        db.execute(
            select(RelationshipRow.id)
            .where(
                RelationshipRow.project_id == project_id,
                missing(RelationshipRow.source_id) | missing(RelationshipRow.target_id),
            )
            .order_by(RelationshipRow.seq)
            .limit(LIMIT)
        ).scalars()
    )


def _containment_check(
    db: DbSession, project_id: str, types: list[str], ids: list[str]
) -> str:
    """Which of the two refusals ``containment_violations`` made: it answers
    elements with two parents first, and a cycle only when there are none."""
    parents = db.execute(
        select(func.count()).where(
            RelationshipRow.project_id == project_id,
            RelationshipRow.type_name.in_(types),
            RelationshipRow.target_id == ids[0],
        )
    ).scalar_one()
    return (
        "element with two containment parents" if parents > 1 else "containment cycle"
    )


def check_rows(db: DbSession, project_id: str, metamodel: Metamodel) -> None:
    """Refuse (422, naming the check and the first ids) a head the rows of the
    project cannot be: an id on an element and a relationship, a relationship
    end that is no element, a reference to no element, an element with two
    containment parents or on a containment cycle."""
    types = containment_types(metamodel)
    for check, ids in (
        ("id shared by an element and a relationship", _shared_ids(db, project_id)),
        ("relationship end is not an element", _loose_relationships(db, project_id)),
        ("dangling reference", dangling_references(db, project_id)),
    ):
        if ids:
            raise _refuse(f"{check}: {', '.join(ids)}")
    ids = containment_violations(db, project_id, types)
    if ids:
        check = _containment_check(db, project_id, types, ids)
        raise _refuse(f"{check}: {', '.join(ids)}")


def ingest_model(
    db: DbSession, project_id: str, metamodel: Metamodel, source: BinaryIO
) -> ImportReport:
    """Replace the project's rows with the model document in ``source``.

    Writes in the caller's transaction and never commits: every refusal is a
    422 (``HTTPException``) after which the caller rolls back. The project needs
    its ``ModelRow``, which gets the digest, the counts and ``next_seq`` (each
    table is numbered from 0 in file order, as ``head.write_baseline`` does)."""
    row = content.get_model_row(db, project_id)
    if row is None:
        raise LookupError(f"project {project_id!r} has no model row")
    db.flush()
    head.clear_rows(db, project_id)
    ingest = _Ingest(db, project_id, metamodel)
    ingest.run(source)
    db.flush()
    if db.get_bind().dialect.name == "postgresql":
        # The rows are uncommitted, so autovacuum has not seen them and the
        # planner knows nothing of the project: it plans the checks' joins as
        # nested loops over the whole project. ANALYZE samples the
        # transaction's own rows.
        db.execute(text("ANALYZE elements, relationships, entity_refs"))
    check_rows(db, project_id, metamodel)
    row.element_count = ingest.element_count
    row.relationship_count = ingest.relationship_count
    row.state_digest = format_digest(ingest.digest)
    row.next_seq = max(ingest.element_count, ingest.relationship_count)
    return ImportReport(ingest.element_count, ingest.relationship_count)
