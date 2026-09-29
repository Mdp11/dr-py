"""What ``POST /model/compare`` and ``POST /model/apply-cr`` answer, over a
small model of the smart-city metamodel built by ops on a seeded recorder.

Compare: every shape refusal of the model file in its order and text, the
order between refusals, the inputs it tolerates, Python ``==`` deciding
what is modified (``1.0``, ``true`` and a reordered dict against what the
model holds are not; a float next to a bigint is), a rev-only difference, a
retype and a rewire, added and modified in the file's order and deleted in
the model's, ``1e999`` written as ``null`` and a bare ``NaN`` read as a
string. Files the engine hands to the server unread are marked ``fallback``:
invalid JSON, a raw control character, invalid UTF-8 and UTF-16 (which the
server reads); a UTF-8 BOM is read by both. One compare runs over staged ops.

Apply-CR: CRs applied in sequence, the later seeing the earlier; conflicts in
all six buckets, several in one CR, the first conflicting CR not the first;
an id deleted by one CR and re-added by a later one moving to the end, or
vanishing when re-added as it was; rewires; patches that drop a key or come
out empty; created relationships on created elements; every gate error and
the retype; a CR listing an id twice among its deletes, adds or modifies,
and one that modifies and deletes an id. Requests the engine hands to the
server unread are marked ``fallback``. Two proposals run over a staged
rename, one with a ``before`` that matches it and one that matches the
committed state."""

from __future__ import annotations

import base64
import copy
import json
import re
from collections.abc import Callable
from typing import Any

from data_rover.core.metamodel.loader import load_metamodel_str

from ..driver import ROOT, scenario
from ..model_steps import apply_cr_step, batch, compare_step, run_steps

_METAMODEL_FILE = ROOT / "examples" / "smart-city.metamodel.yaml"

Entity = dict[str, Any]
Doc = dict[str, Any]

#: the committed model, each ``rev`` the one its ops leave: ``t1`` gains its
#: ``location`` in a batch of its own, which makes ``model_rev`` 1
_ELEMENTS: list[Entity] = [
    {"id": "org", "type_name": "Organization", "properties": {"name": "Org", "country": "DE"}, "rev": 2},
    {"id": "t1", "type_name": "Team", "properties": {"name": "T1", "size": 1, "location": "here"}, "rev": 3},
    {"id": "t2", "type_name": "Team", "properties": {"name": "T2", "description": {"a": 2, "b": 1}}, "rev": 2},
    {"id": "t3", "type_name": "Team", "properties": {"name": "T3", "size": 2**53 + 1}, "rev": 2},
    {"id": "t4", "type_name": "Team", "properties": {"name": "T4", "size": 0, "tags": [1, 2]}, "rev": 3},
    {"id": "p1", "type_name": "Person", "properties": {"name": "P1", "first_name": "A", "last_name": "One"}, "rev": 3},
    {"id": "p2", "type_name": "Person", "properties": {"name": "P2", "first_name": "B", "last_name": "Two"}, "rev": 3},
    {"id": "sys", "type_name": "SoftwareSystem", "properties": {"name": "Sys"}, "rev": 1},
]  # fmt: skip

#: ``t1`` has two incoming relationships and an outgoing one, whose ids sort
#: by code point unlike their insertion order
_RELATIONSHIPS: list[Entity] = [
    {"id": "r-z-own", "type_name": "Owns", "source_id": "org", "target_id": "t1", "properties": {}, "rev": 0},
    {"id": "r-y-resp", "type_name": "Responsible", "source_id": "t1", "target_id": "sys", "properties": {"role": "lead"}, "rev": 1},
    {"id": "r-a-mem", "type_name": "MemberOf", "source_id": "p1", "target_id": "t1", "properties": {"is_lead": True}, "rev": 1},
    {"id": "r-m2", "type_name": "MemberOf", "source_id": "p2", "target_id": "t2", "properties": {"since": "2024-01-01"}, "rev": 1},
]  # fmt: skip


def _committed() -> Doc:
    """The committed model as a model file, fresh on every call."""
    return copy.deepcopy({"elements": _ELEMENTS, "relationships": _RELATIONSHIPS})


def _find(entities: list[Entity], entity_id: str) -> Entity:
    (found,) = [e for e in entities if e["id"] == entity_id]
    return found


def _el(entity_id: str, **props: Any) -> Entity:
    """A committed element, its properties updated by ``props``."""
    entity = _find(_committed()["elements"], entity_id)
    entity["properties"].update(props)
    return entity


def _rel(rel_id: str, **fields: Any) -> Entity:
    """A committed relationship with ``fields`` replaced."""
    entity = _find(_committed()["relationships"], rel_id)
    entity.update(fields)
    return entity


def _new(entity_id: str, type_name: str, **props: Any) -> Entity:
    return {"id": entity_id, "type_name": type_name, "properties": props, "rev": 0}


def _new_rel(rel_id: str, type_name: str, source: str, target: str) -> Entity:
    return {
        "id": rel_id,
        "type_name": type_name,
        "source_id": source,
        "target_id": target,
        "properties": {},
        "rev": 0,
    }


def _retyped(entity: Entity, type_name: str) -> Entity:
    return {**entity, "type_name": type_name}


# ---------------------------------------------------------------------------
# Model files
# ---------------------------------------------------------------------------

#: string markers the file text writes as a JSON number or a bare constant
_LITERALS = {"__1e999__": "1e999", "__-1e999__": "-1e999", "__NaN__": "NaN"}


def _text(doc: Any) -> str:
    text = json.dumps(doc, ensure_ascii=False)
    for marker, literal in _LITERALS.items():
        text = text.replace(json.dumps(marker), literal)
    return text


def _edited(edit: Callable[[Doc], Any]) -> str:
    """The committed model's file with ``edit`` applied to it."""
    doc = _committed()
    edit(doc)
    return _text(doc)


def _set(entity_id: str, **props: Any) -> Callable[[Doc], None]:
    def edit(doc: Doc) -> None:
        _find(doc["elements"], entity_id)["properties"].update(props)

    return edit


def _b64(blob: bytes) -> str:
    return base64.b64encode(blob).decode("ascii")


_T = '{"id": "t", "type_name": "Team"}'
_P = '{"id": "p", "type_name": "Person"}'
_RESERVED = "uses the reserved 'tmp_' prefix"


def _rels(*rels: str) -> str:
    return f'{{"elements": [{_T}, {_P}], "relationships": [{", ".join(rels)}]}}'


def _mem(
    rel_id: str = "r", source: str = "p", target: str = "t", extra: str = ""
) -> str:
    return (
        f'{{"id": "{rel_id}", "type_name": "MemberOf", '
        f'"source_id": "{source}", "target_id": "{target}"{extra}}}'
    )


#: each file and the start of the refusal it meets first
_REFUSED: list[tuple[str, str]] = [
    ("[]", "Model payload must be a JSON object"),
    ('{"elements": null}', "Model payload field 'elements' must be a list"),
    ('{"elements": [], "relationships": 5}', "Model payload field 'relationships' must be a list"),
    ('{"elements": [5]}', "elements[0]: must be an object"),
    ('{"elements": [{"type_name": "Team"}]}', "elements[0]: field 'id' must be a string"),
    ('{"elements": [{"id": "x", "type_name": 5}]}', "elements[0]: field 'type_name' must be a string"),
    ('{"elements": [{"id": "tmp_x", "type_name": "Team"}]}', f"Element id 'tmp_x' {_RESERVED}"),
    ('{"elements": [{"id": "x", "type_name": "NamedElement"}]}', "Element type 'NamedElement' is abstract"),
    ('{"elements": [{"id": "x", "type_name": "Team"}, {"id": "x", "type_name": "Team"}]}', "Duplicate element id 'x'"),
    ('{"elements": [{"id": "x", "type_name": "Team", "properties": []}]}', "elements[0]: field 'properties' must be an object"),
    ('{"elements": [{"id": "x", "type_name": "Team", "rev": true}]}', "elements[0]: field 'rev' must be an integer"),
    ('{"elements": [{"id": "x", "type_name": "Team", "rev": 1.5}]}', "elements[0]: field 'rev' must be an integer"),
    (_rels('{"id": "r", "type_name": "MemberOf", "source_id": "p"}'), "relationships[0]: field 'target_id' must be a string"),
    (_rels(_mem("tmp_r")), f"Relationship id 'tmp_r' {_RESERVED}"),
    (_rels(_mem(source="ghost")), "Relationship 'r' references unknown source 'ghost'"),
    (_rels(_mem(target="ghost")), "Relationship 'r' references unknown target 'ghost'"),
    (_rels(_mem(), _mem()), "Duplicate relationship id 'r'"),
    (_rels(_mem(extra=', "rev": "1"')), "relationships[0]: field 'rev' must be an integer"),
    # the order between checks
    ('{"elements": [{"id": "x", "type_name": "Team"}, {"id": "x", "type_name": "Team", "properties": []}]}', "Duplicate element id 'x'"),
    (f'{{"elements": [{_T}, {{"id": 1}}], "relationships": [5]}}', "elements[1]: field 'id' must be a string"),
    ('{"elements": [5], "relationships": 5}', "Model payload field 'relationships' must be a list"),
    ('{"elements": [{"type_name": 5}]}', "elements[0]: field 'id' must be a string"),
    ('{"elements": [{"id": "tmp_x", "type_name": "NamedElement"}]}', f"Element id 'tmp_x' {_RESERVED}"),
    ('{"elements": [{"id": "x", "type_name": "Team"}, {"id": "x", "type_name": "NamedElement"}]}', "Element type 'NamedElement' is abstract"),
    ('{"elements": [{"id": "x", "type_name": "Team", "properties": [], "rev": true}]}', "elements[0]: field 'properties' must be an object"),
    (_rels(_mem("tmp_r", source="ghost")), f"Relationship id 'tmp_r' {_RESERVED}"),
    (_rels(_mem(source="ghost", target="ghost")), "Relationship 'r' references unknown source 'ghost'"),
    (_rels(_mem(), _mem(target="ghost")), "Relationship 'r' references unknown target 'ghost'"),
    (_rels(_mem(extra=', "properties": 5, "rev": "1"')), "relationships[0]: field 'properties' must be an object"),
]  # fmt: skip


def _tolerated() -> dict[str, str]:
    def unknown_types(doc: Doc) -> None:
        doc["elements"].append(_new("u1", "Nope"))
        doc["relationships"].append(_new_rel("ru", "NopeRel", "org", "u1"))

    def extra_keys(doc: Doc) -> None:
        doc["meta"] = {"x": 1}
        doc["rev"] = 5
        _find(doc["elements"], "t1")["extra"] = [1]
        _find(doc["relationships"], "r-m2")["note"] = "x"

    def shared_id(doc: Doc) -> None:
        doc["elements"].append(_new("shared", "Team", name="S"))
        doc["relationships"].append(_new_rel("shared", "MemberOf", "p1", "shared"))

    def loose_entities(doc: Doc) -> None:
        doc["elements"] += [
            {"id": "n-null", "type_name": "Team", "properties": None, "rev": 0},
            {"id": "n-bare", "type_name": "Team"},
            {"id": "n-big", "type_name": "Team", "properties": {}, "rev": 2**64},
            {"id": "n-index", "type_name": "Team", "properties": {"0": 1, "a": 2}},
        ]
        _find(doc["elements"], "t2")["rev"] = 2**64

    def no_relationships(doc: Doc) -> None:
        del doc["relationships"]

    return {
        "unknown types": _edited(unknown_types),
        "extra keys": _edited(extra_keys),
        "shared id": _edited(shared_id),
        "loose entities": _edited(loose_entities),
        "no relationships": _edited(no_relationships),
    }


def _equality() -> dict[str, str]:
    def rev_only(doc: Doc) -> None:
        for entity in (*doc["elements"], *doc["relationships"]):
            entity["rev"] = 7

    def retype_rewire(doc: Doc) -> None:
        _find(doc["elements"], "t4")["type_name"] = "Organization"
        _find(doc["relationships"], "r-m2")["target_id"] = "t1"
        _find(doc["relationships"], "r-z-own")["type_name"] = "MemberOf"

    def reordered(doc: Doc) -> None:
        # the file lists everything backwards, modifies two of each kind,
        # adds two of each between them and leaves two of each out
        elements = [e for e in doc["elements"] if e["id"] not in ("t2", "t4")]
        _find(elements, "p1")["properties"]["name"] = "P1b"
        _find(elements, "org")["properties"]["name"] = "Org b"
        elements.insert(2, _new("n2", "Team", name="N2"))
        elements.insert(5, _new("n1", "Team", name="N1"))
        doc["elements"] = elements[::-1]
        rels = [r for r in doc["relationships"] if r["id"] not in ("r-m2", "r-z-own")]
        _find(rels, "r-y-resp")["properties"] = {"role": "owner"}
        _find(rels, "r-a-mem")["properties"] = {}
        rels.insert(1, _new_rel("n-r2", "MemberOf", "p1", "n2"))
        rels.insert(0, _new_rel("n-r1", "MemberOf", "p2", "n1"))
        doc["relationships"] = rels[::-1]

    return {
        "int as float": _edited(_set("t1", size=1.0)),
        "int as bool": _edited(_set("t1", size=True)),
        "dict reordered": _edited(_set("t2", description={"b": 1, "a": 2})),
        "bigint as float": _edited(_set("t3", size=float(2**53))),
        "zero as -0.0": _edited(_set("t4", size=-0.0, tags=[1.0, 2])),
        "zero as false": _edited(_set("t4", size=False, tags=[True, "2"])),
        "rev only": _edited(rev_only),
        "retype and rewire": _edited(retype_rewire),
        "file order": _edited(reordered),
        "1e999": _edited(_set("t1", size="__1e999__", location="__-1e999__")),
        "bare NaN": _edited(_set("t1", location="__NaN__")),
    }


#: what each equality file modifies, elements then relationships; nothing
#: else changes except in ``file order``
_MODIFIED = {
    "int as float": ([], []),
    "int as bool": ([], []),
    "dict reordered": ([], []),
    "bigint as float": (["t3"], []),
    "zero as -0.0": ([], []),
    "zero as false": (["t4"], []),
    "rev only": ([], []),
    "retype and rewire": (["t4"], ["r-z-own", "r-m2"]),
    "file order": (["p1", "org"], ["r-a-mem", "r-y-resp"]),
    "1e999": (["t1"], []),
    "bare NaN": (["t1"], []),
}


def _unreadable() -> dict[str, tuple[str | None, str | None]]:
    """``(file, file_b64)`` the engine hands to the server."""
    changed = _edited(_set("t1", name="T1 utf-16"))
    return {
        "invalid JSON": ('{"elements": [', None),
        "control character": ('{"elements": [], "note": "a\x01b"}', None),
        "invalid UTF-8": (None, _b64(b'{"elements": [], "note": "\xff"}')),
        "UTF-16": (None, _b64(changed.encode("utf-16"))),
    }


# ---------------------------------------------------------------------------
# Change requests
# ---------------------------------------------------------------------------


def _cr(
    *,
    e_added: list[Entity] | None = None,
    e_modified: list[Entity] | None = None,
    e_deleted: list[Entity] | None = None,
    r_added: list[Entity] | None = None,
    r_modified: list[Entity] | None = None,
    r_deleted: list[Entity] | None = None,
) -> dict[str, Any]:
    return {
        "format": "datarover.cr/v1",
        "createdAt": "2026-09-01T00:00:00.000Z",
        "baseline": {
            "filename": "base.json",
            "elementCount": 8,
            "relationshipCount": 4,
        },
        "ops": {
            "elements": {
                "added": e_added or [],
                "modified": e_modified or [],
                "deleted": e_deleted or [],
            },
            "relationships": {
                "added": r_added or [],
                "modified": r_modified or [],
                "deleted": r_deleted or [],
            },
        },
    }


def _mod(before: Entity, after: Entity) -> Entity:
    return {"id": before["id"], "before": before, "after": after}


def _proposals() -> dict[str, list[dict[str, Any]]]:
    t1 = _el("t1")
    return {
        "sequential": [
            _cr(e_added=[_new("n1", "Team", name="N1")]),
            _cr(e_modified=[_mod(_new("n1", "Team", name="N1"), _new("n1", "Team", name="N1b", size=3))]),
        ],
        # CR 1 conflicts in every bucket, n1 only through CR 0; t4's before
        # matches by Python ==; CR 2 would conflict too
        "conflicts": [
            _cr(e_added=[_new("n1", "Team", name="N1")]),
            _cr(
                e_added=[_new("n1", "Team", name="again"), _new("n2", "Team"), _new("org", "Team")],
                e_modified=[
                    _mod(_new("ghost", "Team"), _new("ghost", "Team", name="G")),
                    _mod(_el("t4", size=False, tags=[True, 2]), _el("t4", name="T4b")),
                    _mod(_el("t1", name="WRONG"), _el("t1", name="T1b")),
                ],
                e_deleted=[_new("ghost2", "Team"), _retyped(_el("t2"), "Organization"), _el("t3")],
                r_added=[_rel("r-m2"), _new_rel("n-r", "MemberOf", "p1", "t2")],
                r_modified=[
                    _mod(_new_rel("r-ghost", "MemberOf", "p1", "t1"), _new_rel("r-ghost", "MemberOf", "p1", "t2")),
                    _mod(_rel("r-a-mem", target_id="t2"), _rel("r-a-mem", target_id="t3")),
                ],
                r_deleted=[_new_rel("r-ghost2", "Owns", "org", "t2"), _rel("r-y-resp", properties={"role": "x"})],
            ),
            _cr(e_added=[_new("org", "Team")]),
        ],
        # a CR never sees its own effects: t4 is still there for its add, n9
        # not yet there for its modify
        "same CR": [
            _cr(
                e_added=[_el("t4"), _new("n9", "Team")],
                e_modified=[_mod(_new("n9", "Team"), _new("n9", "Team", name="N9"))],
                e_deleted=[_el("t4")],
            )
        ],
        "moves last": [
            _cr(
                e_added=[_new("n1", "Team", name="N1")],
                e_modified=[_mod(_el("t1"), _el("t1", name="T1b")), _mod(_el("t4"), _el("t4", size=5))],
                e_deleted=[_el("t3")],
                r_added=[_new_rel("n-rel", "MemberOf", "p1", "n1")],
                r_modified=[_mod(_rel("r-a-mem"), _rel("r-a-mem", target_id="t2"))],
                r_deleted=[_rel("r-m2")],
            ),
            _cr(e_added=[_new("t3", "Team", name="T3 again")], r_added=[_rel("r-m2", target_id="t1")]),
        ],
        "vanishes": [
            _cr(e_deleted=[_el("t4")], r_deleted=[_rel("r-y-resp")]),
            _cr(
                e_added=[_el("t4")],
                e_modified=[_mod(_el("t2"), _el("t2", description={"a": 3}))],
                r_added=[_rel("r-y-resp")],
            ),
        ],
        "rewires": [
            _cr(
                r_modified=[
                    _mod(_rel("r-y-resp"), _rel("r-y-resp", properties={"role": "owner"})),
                    _mod(_rel("r-a-mem"), _rel("r-a-mem", target_id="t2")),
                    _mod(_rel("r-m2"), _rel("r-m2", type_name="Owns")),
                ]
            )
        ],
        # t1 drops a key, its patch in after's order; t4's before and after
        # hold false where it holds 0; t2 changes and changes back
        "patches": [
            _cr(
                e_modified=[
                    _mod(t1, {**t1, "properties": {"size": 2, "name": "T1b"}}),
                    _mod(_el("t2"), _el("t2", name="X")),
                    _mod(
                        {**_el("t4"), "properties": {"tags": [1, 2], "size": False, "name": "T4"}},
                        _el("t4", size=False, name="T4b"),
                    ),
                ],
                r_modified=[_mod(_rel("r-a-mem"), _rel("r-a-mem", properties={}))],
            ),
            _cr(e_modified=[_mod(_el("t2", name="X"), _el("t2"))]),
        ],
        "created ends": [
            _cr(
                e_added=[_new("n1", "Team", name="N1"), _new("n2", "Person", name="N2")],
                r_added=[_new_rel("n-mem", "MemberOf", "n2", "n1"), _new_rel("n-own", "Owns", "org", "n1")],
            )
        ],
        "gate unknown type": [_cr(e_added=[_new("n1", "Nope")])],
        "gate abstract": [_cr(e_added=[_new("n1", "Stakeholder")])],
        "gate added before modified": [
            _cr(e_added=[_new("n1", "Nope2")], e_modified=[_mod(_el("t4"), _retyped(_el("t4"), "Stakeholder"))])
        ],
        "gate before retype": [_cr(e_modified=[_mod(_el("t4"), _retyped(_el("t4"), "Nope"))])],
        "gate relationship type": [_cr(r_added=[_new_rel("n-r", "NopeRel", "p1", "t2")])],
        "gate source": [_cr(r_added=[_new_rel("n-r", "MemberOf", "ghost", "t2")])],
        "gate target": [_cr(r_added=[_new_rel("n-r", "MemberOf", "p1", "ghost")])],
        "gate source before target": [_cr(r_added=[_new_rel("n-r", "MemberOf", "ghost", "ghost")])],
        "gate modified target": [_cr(r_modified=[_mod(_rel("r-m2"), _rel("r-m2", target_id="ghost"))])],
        "gate incident": [_cr(e_deleted=[_el("p2")])],
        "gate code point order": [_cr(e_deleted=[_el("t1")])],
        "gate both ends deleted": [_cr(e_deleted=[_el("p2"), _el("t2")])],
        "retype": [_cr(e_modified=[_mod(_el("t4"), _retyped(_el("t4"), "Organization"))])],
        "duplicate deletes": [_cr(e_deleted=[_el("t3"), _el("t3")], r_deleted=[_rel("r-m2"), _rel("r-m2")])],
        "duplicate adds and modifies": [
            _cr(
                e_added=[_new("n1", "Team", name="first"), _new("n2", "Team"), _new("n1", "Team", name="second")],
                e_modified=[_mod(_el("t1"), _el("t1", name="A")), _mod(_el("t1"), _el("t1", name="B"))],
                r_added=[_new_rel("n-r", "MemberOf", "p1", "n2"), _new_rel("n-r", "MemberOf", "p2", "n2")],
                r_modified=[
                    _mod(_rel("r-y-resp"), _rel("r-y-resp", properties={"role": "a"})),
                    _mod(_rel("r-y-resp"), _rel("r-y-resp", properties={"role": "b"})),
                ],
            )
        ],
        "modify and delete": [
            _cr(
                e_modified=[_mod(_el("t3"), _el("t3", name="T3b"))],
                e_deleted=[_el("t3")],
                r_modified=[_mod(_rel("r-m2"), _rel("r-m2", properties={}))],
                r_deleted=[_rel("r-m2")],
            )
        ],
    }  # fmt: skip


def _unread_proposals() -> dict[str, Any]:
    """Request bodies' ``crs`` the engine hands to the server."""
    added = _cr(e_added=[_new("n1", "Team", name="N1")])
    rev_text = copy.deepcopy(added)
    rev_text["ops"]["elements"]["added"][0]["rev"] = "3"
    null_props = copy.deepcopy(added)
    null_props["ops"]["elements"]["added"][0]["properties"] = None
    return {
        "no CRs": [],
        "21 CRs": [_cr() for _ in range(21)],
        "wrong format": [{**added, "format": "datarover.cr/v2"}],
        "rev as text": [rev_text],
        "null properties": [null_props],
    }


# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------


def _create(entity: Entity) -> dict[str, Any]:
    op: dict[str, Any] = {
        "kind": "create_relationship" if "source_id" in entity else "create_element",
        "temp_id": f"tmp_{entity['id']}",
        "type_name": entity["type_name"],
        "id": entity["id"],
        "properties": {
            k: v for k, v in entity["properties"].items() if k != "location"
        },
    }
    if "source_id" in entity:
        op |= {"source_id": entity["source_id"], "target_id": entity["target_id"]}
    return op


_BUILD = [_create(e) for e in (*_ELEMENTS, *_RELATIONSHIPS)]
_LOCATE = [
    {"kind": "update_element", "id": "t1", "properties_patch": {"location": "here"}}
]

#: a rename, a delete that takes a relationship with it, and a create
_STAGE = [
    {"kind": "update_element", "id": "t1", "properties_patch": {"name": "T1 staged"}},
    {"kind": "delete_element", "id": "p2"},
    {"kind": "create_element", "temp_id": "tmp_s", "type_name": "Team", "id": "staged-x", "properties": {"name": "X"}},
]  # fmt: skip
_RENAME = [_STAGE[0]]

_GATE_TEXTS = {
    "unknown element type": r"^Unknown element type 'Nope'$",
    "abstract": r"^Element type 'Stakeholder' is abstract and cannot be instantiated$",
    "unknown relationship type": r"^Unknown relationship type 'NopeRel'$",
    "unknown source": r"^Relationship '[^']+' references unknown source '[^']+'$",
    "unknown target": r"^Relationship '[^']+' references unknown target '[^']+'$",
    "retype": r"^Element 't4' changes type \('Team' -> 'Organization'\); element type changes are not supported — delete and re-create it in the CR$",
}  # fmt: skip


def _ids(bucket: list[Entity]) -> list[str]:
    return [entity["id"] for entity in bucket]


def _changes(step: dict[str, Any]) -> dict[str, dict[str, list[str]]]:
    """The ids of each bucket of an answered CR."""
    ops = step["result"]["cr"]["ops"]
    return {kind: {name: _ids(ops[kind][name]) for name in ops[kind]} for kind in ops}


def _checked(run: dict[str, Any], labels: list[str]) -> None:
    """Holds the run to the cases it is meant to record."""
    steps = run["steps"]
    by = dict(zip(labels, steps, strict=True))
    assert steps[2]["state"] == [
        json.dumps(e, separators=(",", ":"), ensure_ascii=False)
        for e in (*_ELEMENTS, *_RELATIONSHIPS)
    ], "the model files start from the committed state"
    for text, start in _REFUSED:
        error = by[f"refused {text}"]["error"]
        assert error["status"] == 422 and error["detail"].startswith(start), error
    for name in [*_tolerated(), *_equality(), "BOM", "staged"]:
        assert by[name]["error"] is None, by[name]
    assert _changes(by["extra keys"]) == _changes(by["rev only"])
    assert _changes(by["no relationships"])["relationships"]["deleted"] == _ids(
        _RELATIONSHIPS
    )
    for name, (elements, relationships) in _MODIFIED.items():
        changes = _changes(by[name])
        assert changes["elements"]["modified"] == elements, (name, changes)
        assert changes["relationships"]["modified"] == relationships, (name, changes)
    assert _changes(by["file order"])["elements"]["added"] == ["n1", "n2"]
    assert _changes(by["file order"])["elements"]["deleted"] == ["t2", "t4"]
    (inf,) = by["1e999"]["result"]["cr"]["ops"]["elements"]["modified"]
    assert inf["after"]["properties"] == {"name": "T1", "size": None, "location": None}
    (nan,) = by["bare NaN"]["result"]["cr"]["ops"]["elements"]["modified"]
    assert nan["after"]["properties"]["location"] == "NaN"
    assert [by[name]["error"] is None for name in _unreadable()] == [False] * 3 + [True]
    assert _changes(by["staged"])["elements"] == {
        "added": ["p2"],
        "modified": ["t1"],
        "deleted": ["staged-x"],
    }

    conflicts = [
        c
        for step in steps
        if step["do"] == "apply_cr"
        and step["result"] is not None
        and "status" in step["result"]
        for c in step["result"]["body"]["conflicts"]
    ]
    assert {(c["entity"], c["kind"]) for c in conflicts} == {
        (entity, kind)
        for entity in ("element", "relationship")
        for kind in ("id_exists", "missing", "before_mismatch")
    }
    assert by["conflicts"]["result"]["body"]["cr_index"] == 1
    details = [
        step["error"]["detail"]
        for step in steps
        if step["do"] == "apply_cr"
        and step["error"] is not None
        and isinstance(step["error"]["detail"], str)
    ]
    for name, pattern in _GATE_TEXTS.items():
        assert any(re.search(pattern, d) for d in details), f"no {name} gate text"
    assert by["gate code point order"]["error"]["detail"] == (
        "Relationship 'r-a-mem' references unknown target 't1'"
    )
    moved = _changes(by["moves last"])
    assert moved["elements"]["modified"] == ["t1", "t4", "t3"]
    assert moved["relationships"]["modified"] == ["r-a-mem", "r-m2"]
    assert by["moves last"]["result"]["ops"][-1]["temp_id"] == "tmp_4"
    assert _changes(by["vanishes"])["elements"]["modified"] == ["t2"]
    assert _changes(by["vanishes"])["relationships"]["added"] == []
    assert "t2" not in _changes(by["patches"])["elements"]["modified"]
    assert [
        (op["kind"], op["id"]) for op in by["duplicate deletes"]["result"]["ops"]
    ] == [
        ("delete_relationship", "r-m2"),
        ("delete_element", "t3"),
    ]
    assert by["staged proposal"]["result"]["ops"] == [
        {"kind": "update_element", "id": "t1", "properties_patch": {"name": "T1 final"}}
    ]
    assert by["staged proposal, committed before"]["result"]["status"] == 409


@scenario("change_request")
def change_request() -> Any:
    metamodel = load_metamodel_str(_METAMODEL_FILE.read_text(encoding="utf-8"))
    moments = (
        f"2026-09-29T10:{n // 60:02d}:{n % 60:02d}.{n:03d}Z" for n in range(1000)
    )
    bom = b"\xef\xbb\xbf" + _edited(_set("t1", name="T1 bom")).encode("utf-8")
    staged_t1 = _el("t1", name="T1 staged")
    cases: list[tuple[str, dict[str, Any]]] = [
        ("build", batch(_BUILD)),
        ("seed", {"do": "seed"}),
        ("locate", batch(_LOCATE)),
        *(
            (f"refused {text}", compare_step(text, next(moments)))
            for text, _ in _REFUSED
        ),
        *(
            (name, compare_step(text, next(moments)))
            for name, text in _tolerated().items()
        ),
        *(
            (name, compare_step(text, next(moments)))
            for name, text in _equality().items()
        ),
        *(
            (name, compare_step(text, next(moments), file_b64=blob, fallback=True))
            for name, (text, blob) in _unreadable().items()
        ),
        ("BOM", compare_step(None, next(moments), file_b64=_b64(bom))),
        ("staged", compare_step(_text(_committed()), next(moments), _STAGE)),
        *(
            (name, apply_cr_step(crs, next(moments)))
            for name, crs in _proposals().items()
        ),
        *(
            (name, apply_cr_step(crs, next(moments), fallback=True))
            for name, crs in _unread_proposals().items()
        ),
        (
            "staged proposal",
            apply_cr_step(
                [_cr(e_modified=[_mod(staged_t1, _el("t1", name="T1 final"))])],
                next(moments),
                _RENAME,
            ),
        ),
        (
            "staged proposal, committed before",
            apply_cr_step(
                [_cr(e_modified=[_mod(_el("t1"), _el("t1", name="T1 final"))])],
                next(moments),
                _RENAME,
            ),
        ),
    ]
    labels = [label for label, _ in cases]
    assert len(set(labels)) == len(labels), "every case has its own label"
    run = run_steps(metamodel, [step for _, step in cases])
    _checked(run, labels)
    return run
