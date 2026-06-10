from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import yaml

from data_rover.core.metamodel.check import check_metamodel
from data_rover.core.metamodel.schema import (
    ElementType,
    Mapping,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship
from data_rover.core.validation.issue import Issue
from data_rover.core.validation.pipeline import default_pipeline

_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

#: Properties stripped from every element during migration.
DROP_PROPS = frozenset({"SourceDatabase", "debug_data"})

#: Deterministic namespace for synthesized relationship ids.
_SYNTH_NS = uuid.uuid5(uuid.NAMESPACE_URL, "data-rover/migration/legacy")


def infer_datatype(values: Iterable[Any]) -> str:
    """Infer a new-metamodel primitive datatype from observed scalar values.

    `None` values are ignored. Booleans are checked before integers (in Python
    ``bool`` is a subclass of ``int``). A mix of int and float reads as float;
    any other mix, or no values at all, falls back to ``string``.
    """
    observed: set[str] = set()
    for v in values:
        if v is None:
            continue
        if isinstance(v, bool):
            observed.add("boolean")
        elif isinstance(v, int):
            observed.add("integer")
        elif isinstance(v, float):
            observed.add("float")
        elif isinstance(v, str):
            observed.add("date" if _ISO_DATE.match(v) else "string")
        else:
            observed.add("string")

    if not observed:
        return "string"
    if observed == {"integer"}:
        return "integer"
    if observed == {"float"} or observed == {"integer", "float"}:
        return "float"
    if observed == {"boolean"}:
        return "boolean"
    if observed == {"date"}:
        return "date"
    return "string"


def _property_to_dict(p: PropertyDef) -> dict[str, Any]:
    d: dict[str, Any] = {"name": p.name, "datatype": p.datatype}
    if p.multiplicity != "0..1":
        d["multiplicity"] = p.multiplicity
    for facet in ("min", "max", "pattern", "max_length"):
        value = getattr(p, facet)
        if value is not None:
            d[facet] = value
    return d


def metamodel_to_yaml_dict(mm: Metamodel) -> dict[str, Any]:
    """Render a `Metamodel` as a plain dict ready for `yaml.safe_dump`.

    Round-trips through `load_metamodel_str`. Defaults and empty fields are
    omitted; relationship endpoints are always written as explicit `mappings`.
    """
    out: dict[str, Any] = {}
    if mm.enums:
        out["enums"] = {k: list(v) for k, v in mm.enums.items()}

    elements: list[dict] = []
    for et in mm.elements:
        e: dict[str, Any] = {"name": et.name}
        if et.abstract:
            e["abstract"] = True
        if et.extends is not None:
            e["extends"] = et.extends
        if et.properties:
            e["properties"] = [_property_to_dict(p) for p in et.properties]
        if et.key is not None:
            e["key"] = list(et.key)
        elements.append(e)
    if elements:
        out["elements"] = elements

    relationships: list[dict] = []
    for rt in mm.relationships:
        r: dict[str, Any] = {"name": rt.name}
        if rt.abstract:
            r["abstract"] = True
        if rt.extends is not None:
            r["extends"] = rt.extends
        if rt.containment:
            r["containment"] = True
        r["mappings"] = [{"source": m.source, "target": m.target} for m in rt.mappings]
        if rt.source_multiplicity != "0..*":
            r["source_multiplicity"] = rt.source_multiplicity
        if rt.target_multiplicity != "0..*":
            r["target_multiplicity"] = rt.target_multiplicity
        if rt.properties:
            r["properties"] = [_property_to_dict(p) for p in rt.properties]
        relationships.append(r)
    if relationships:
        out["relationships"] = relationships

    return out


@dataclass
class MigrationResult:
    metamodel: Metamodel
    model: dict[str, Any]
    warnings: list[str] = field(default_factory=list)


def _synth_id(rel_type: str, source_id: str, target_id: str) -> str:
    """Deterministic id for a synthesized (owner/typed-by) relationship."""
    return str(uuid.uuid5(_SYNTH_NS, f"{rel_type}|{source_id}|{target_id}"))


def _unique_name(base: str, taken: set[str]) -> str:
    if base not in taken:
        return base
    i = 2
    while f"{base}{i}" in taken:
        i += 1
    return f"{base}{i}"


def _dedup(pairs: Iterable[tuple[str, str]]) -> list[tuple[str, str]]:
    seen: set[tuple[str, str]] = set()
    out: list[tuple[str, str]] = []
    for p in pairs:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


def _grouped_property_values(old_model: dict, section: str) -> dict[str, dict]:
    """stereotype -> {prop -> {"values": [...], "is_list": bool}} for a section.

    Dropped properties are excluded; list-valued properties are flattened into
    `values` (for datatype inference) and flagged via `is_list`.
    """
    acc: dict[str, dict] = {}
    for entry in (old_model.get(section) or {}).values():
        st = entry.get("stereotype")
        if st is None:
            continue
        bucket = acc.setdefault(st, {})
        for name, value in (entry.get("properties") or {}).items():
            if name in DROP_PROPS:
                continue
            slot = bucket.setdefault(name, {"values": [], "is_list": False})
            if isinstance(value, list):
                slot["is_list"] = True
                slot["values"].extend(value)
            else:
                slot["values"].append(value)
    return acc


def _property_defs(
    declared: list[str], observed: dict, key_names: set[str]
) -> list[PropertyDef]:
    ordered: list[str] = []
    for name in [*declared, *observed]:
        if name not in ordered and name not in DROP_PROPS:
            ordered.append(name)
    defs: list[PropertyDef] = []
    for name in ordered:
        obs = observed.get(name)
        datatype = infer_datatype(obs["values"]) if obs else "string"
        if name in key_names:
            multiplicity = "1"
        elif obs and obs["is_list"]:
            multiplicity = "0..*"
        else:
            multiplicity = "0..1"
        defs.append(
            PropertyDef(name=name, datatype=datatype, multiplicity=multiplicity)
        )
    return defs


def _build_metamodel(
    old_mm: dict,
    elem_values: dict,
    rel_values: dict,
    owns_name: str,
    typedby_name: str,
) -> Metamodel:
    elements: list[ElementType] = []
    owns_pairs: list[tuple[str, str]] = []
    typedby_pairs: list[tuple[str, str]] = []

    for st, spec in (old_mm.get("elements") or {}).items():
        id_props = list(spec.get("id_properties") or [])
        other_props = list(spec.get("other_properties") or [])
        declared = id_props + [p for p in other_props if p not in id_props]
        props = _property_defs(declared, elem_values.get(st, {}), set(id_props))
        elements.append(ElementType(name=st, properties=props, key=id_props or None))
        for owner_st in spec.get("is_owned_by_one_of") or []:
            owns_pairs.append((owner_st, st))  # container -> contained
        for type_st in spec.get("is_typed_by_one_of") or []:
            typedby_pairs.append((st, type_st))  # instance -> type

    relationships: list[RelationshipType] = []
    for st, spec in (old_mm.get("relationships") or {}).items():
        mappings = [
            Mapping(source=m["source"], target=m["destination"])
            for m in spec.get("mappings") or []
        ]
        props = _property_defs(
            list(spec.get("other_properties") or []), rel_values.get(st, {}), set()
        )
        relationships.append(
            RelationshipType(name=st, mappings=mappings, properties=props)
        )

    if owns_pairs:
        relationships.append(
            RelationshipType(
                name=owns_name,
                containment=True,
                mappings=[Mapping(source=s, target=t) for s, t in _dedup(owns_pairs)],
            )
        )
    if typedby_pairs:
        relationships.append(
            RelationshipType(
                name=typedby_name,
                containment=False,
                mappings=[
                    Mapping(source=s, target=t) for s, t in _dedup(typedby_pairs)
                ],
            )
        )

    return Metamodel(elements=elements, relationships=relationships)


def _pair_allowed(
    rt: RelationshipType | None, source_st: str | None, target_st: str | None
) -> bool:
    if rt is None or source_st is None or target_st is None:
        return False
    return any(m.source == source_st and m.target == target_st for m in rt.mappings)


def _build_model(
    old_model: dict,
    mm: Metamodel,
    owns_name: str,
    typedby_name: str,
    emit_unmapped: bool,
    warnings: list[str],
) -> dict[str, Any]:
    elements_out: list[dict] = []
    stereotype_of: dict[str, str] = {}
    for eid, el in (old_model.get("elements") or {}).items():
        node_id = el.get("id", eid)
        st = el["stereotype"]
        stereotype_of[node_id] = st
        props = {
            k: v for k, v in (el.get("properties") or {}).items() if k not in DROP_PROPS
        }
        elements_out.append(
            {"id": node_id, "type_name": st, "properties": props, "rev": 0}
        )

    relationships_out: list[dict] = []
    for rid, rel in (old_model.get("relationships") or {}).items():
        relationships_out.append(
            {
                "id": rel.get("id", rid),
                "type_name": rel["stereotype"],
                "source_id": rel["source"],
                "target_id": rel["destination"],
                "properties": {
                    k: v
                    for k, v in (rel.get("properties") or {}).items()
                    if k not in DROP_PROPS
                },
                "rev": 0,
            }
        )

    owns_rt = mm.relationship_type(owns_name)
    typedby_rt = mm.relationship_type(typedby_name)

    def _link(
        rt: RelationshipType | None,
        rt_name: str,
        source_id: str,
        target_id: str,
        source_st: str | None,
        target_st: str | None,
        kind: str,
    ) -> None:
        if _pair_allowed(rt, source_st, target_st) or emit_unmapped:
            if not _pair_allowed(rt, source_st, target_st):
                warnings.append(
                    f"Emitted unmapped {kind} link {source_id}->{target_id} "
                    f"({source_st}->{target_st}) not declared in metamodel"
                )
            relationships_out.append(
                {
                    "id": _synth_id(rt_name, source_id, target_id),
                    "type_name": rt_name,
                    "source_id": source_id,
                    "target_id": target_id,
                    "properties": {},
                    "rev": 0,
                }
            )
        else:
            warnings.append(
                f"Skipped {kind} link {source_id}->{target_id} "
                f"({source_st}->{target_st}): no allowed {rt_name} mapping"
            )

    for eid, el in (old_model.get("elements") or {}).items():
        node_id = el.get("id", eid)
        st = el["stereotype"]
        owner = el.get("owner")
        if owner:
            _link(
                owns_rt,
                owns_name,
                owner,
                node_id,
                stereotype_of.get(owner),
                st,
                "owner",
            )
        etype = el.get("element_type")
        if etype:
            _link(
                typedby_rt,
                typedby_name,
                node_id,
                etype,
                st,
                stereotype_of.get(etype),
                "element_type",
            )

    return {"rev": 1, "elements": elements_out, "relationships": relationships_out}


def migrate(
    old_metamodel: dict,
    old_model: dict,
    *,
    emit_unmapped_links: bool = False,
    owns_name: str = "Owns",
    typedby_name: str = "TypedBy",
) -> MigrationResult:
    """Migrate an old-format (metamodel, model) pair to the new format.

    Returns the new `Metamodel`, a new-format model dict, and any warnings
    (e.g. owner/element_type links skipped because no mapping permits them).
    """
    warnings: list[str] = []
    elem_values = _grouped_property_values(old_model, "elements")
    rel_values = _grouped_property_values(old_model, "relationships")

    taken = set(old_metamodel.get("elements") or {}) | set(
        old_metamodel.get("relationships") or {}
    )
    owns_name = _unique_name(owns_name, taken)
    taken.add(owns_name)
    typedby_name = _unique_name(typedby_name, taken)

    mm = _build_metamodel(
        old_metamodel, elem_values, rel_values, owns_name, typedby_name
    )
    model = _build_model(
        old_model, mm, owns_name, typedby_name, emit_unmapped_links, warnings
    )
    return MigrationResult(metamodel=mm, model=model, warnings=warnings)


def _materialize_model(result: MigrationResult) -> Model:
    model = Model(result.metamodel)
    for e in result.model["elements"]:
        model.elements[e["id"]] = Element(
            id=e["id"],
            type_name=e["type_name"],
            properties=dict(e["properties"]),
            rev=e["rev"],
        )
    for r in result.model["relationships"]:
        model.relationships[r["id"]] = Relationship(
            id=r["id"],
            type_name=r["type_name"],
            source_id=r["source_id"],
            target_id=r["target_id"],
            properties=dict(r["properties"]),
            rev=r["rev"],
        )
    return model


def validate_model_issues(result: MigrationResult) -> list[Issue]:
    """Run the default validation pipeline over a migration's model output."""
    return default_pipeline().validate(_materialize_model(result))


@dataclass
class MigrationReport:
    result: MigrationResult
    metamodel_errors: list[str]
    model_issues: list[Issue]


def migrate_files(
    old_metamodel_path: str | Path,
    old_model_path: str | Path,
    out_metamodel_path: str | Path,
    out_model_path: str | Path,
    *,
    emit_unmapped_links: bool = False,
) -> MigrationReport:
    """Migrate a paired old metamodel + model and write the new-format outputs.

    Always writes both output files and returns a report (metamodel check
    errors + model validation issues). It does not raise on an invalid result,
    so referentially-incomplete inputs still produce inspectable output.
    """
    old_mm = json.loads(Path(old_metamodel_path).read_text(encoding="utf-8"))
    old_model = json.loads(Path(old_model_path).read_text(encoding="utf-8"))

    result = migrate(old_mm, old_model, emit_unmapped_links=emit_unmapped_links)

    Path(out_metamodel_path).write_text(
        yaml.safe_dump(metamodel_to_yaml_dict(result.metamodel), sort_keys=False),
        encoding="utf-8",
    )
    Path(out_model_path).write_text(
        json.dumps(result.model, indent=2), encoding="utf-8"
    )

    return MigrationReport(
        result=result,
        metamodel_errors=check_metamodel(result.metamodel),
        model_issues=validate_model_issues(result),
    )
