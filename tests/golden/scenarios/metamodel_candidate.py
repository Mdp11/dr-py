"""The smart-city example under candidate metamodels, as ``POST /metamodel/diff``
diffs its model half and ``POST /commits/preview`` previews a rebind.

Both runs start from the example model with one rule set, whose element rule
names a type the fourth candidate removes, and a batch that sets up what the
candidates change: ``Refines`` chains with a fork and a loop, duplicate
requirements one or both of which ``Refines`` targets, three teams whose
sizes are ``1``, ``1.0`` and ``True``, and persons who share a first and last
name or a display name. After ``seed`` the first run diffs six candidates: a
new required property, containment on ``Refines``, Team keyed on its size and
Person's own key dropped, ``NonFunctionalRequirement`` removed, a tightened
pattern, and the live metamodel itself. The second run previews a rebind to the
containment and the removal candidates over a staged create and update,
strict and not, then two rebinds to the removal candidate that the route
refuses: over a patch of a property the candidate no longer gives the type, and
over a create of the type it removes."""

from __future__ import annotations

import copy
from typing import Any

import yaml

from data_rover.core.metamodel.loader import load_metamodel_str

from ..driver import ROOT, scenario
from ..model_steps import batch, rules_step, run_steps

_METAMODEL_FILE = ROOT / "examples" / "smart-city.metamodel.yaml"
_MODEL_FILE = "examples/smart-city.model.json"

#: a relationship rule over teams and an element rule over the type the
#: removal candidate deletes
_RULES = """\
rules:
  - name: team-staffed
    applies_to: Team
    severity: warning
    then:
      relationship: {type: MemberOf, direction: incoming, count: {gte: 2}}
  - name: nfr-target-bounded
    applies_to: NonFunctionalRequirement
    message: target value is too high
    then: {property: target_value, lt: 150}
"""

_VERSIONED = {
    "created_at": "2024-05-01",
    "version": "1.0.0",
    "status": "Active",
}


def _el(entity_id: str, type_name: str, **properties: Any) -> dict[str, Any]:
    return {
        "kind": "create_element",
        "temp_id": f"tmp_{entity_id}",
        "id": entity_id,
        "type_name": type_name,
        "properties": properties,
    }


def _rel(entity_id: str, type_name: str, source: str, target: str) -> dict[str, Any]:
    return {
        "kind": "create_relationship",
        "temp_id": f"tmp_{entity_id}",
        "id": entity_id,
        "type_name": type_name,
        "source_id": source,
        "target_id": target,
        "properties": {},
    }


def _fr(entity_id: str, feature_id: str) -> dict[str, Any]:
    return _el(
        entity_id,
        "FunctionalRequirement",
        name=f"Requirement {feature_id}",
        criticality="High",
        feature_id=feature_id,
        **_VERSIONED,
    )


def _team(entity_id: str, name: str, size: Any) -> dict[str, Any]:
    return _el(entity_id, "Team", name=name, size=size, **_VERSIONED)


def _person(entity_id: str, name: str, first: str, last: str) -> dict[str, Any]:
    return _el(
        entity_id,
        "Person",
        name=name,
        first_name=first,
        last_name=last,
        **_VERSIONED,
    )


_SETUP: list[dict[str, Any]] = [
    # a fork and a loop of refinements
    _fr("fr-a", "FR-9001"),
    _fr("fr-b", "FR-9002"),
    _fr("fr-c", "FR-9003"),
    _fr("fr-d", "FR-9004"),
    _fr("fr-e", "FR-9005"),
    _rel("ref-ab", "Refines", "fr-a", "fr-b"),
    _rel("ref-ac", "Refines", "fr-a", "fr-c"),
    _rel("ref-bc", "Refines", "fr-b", "fr-c"),
    _rel("ref-de", "Refines", "fr-d", "fr-e"),
    _rel("ref-ed", "Refines", "fr-e", "fr-d"),
    # duplicates split once one of them has a parent the other lacks, and
    # stay grouped when both have the same one
    _fr("fr-f", "FR-9006"),
    _fr("fr-g", "FR-9006"),
    _rel("ref-ag", "Refines", "fr-a", "fr-g"),
    _fr("fr-h", "FR-9007"),
    _fr("fr-i", "FR-9007"),
    _rel("ref-ah", "Refines", "fr-a", "fr-h"),
    _rel("ref-ai", "Refines", "fr-a", "fr-i"),
    # uncontained teams whose sizes Python holds equal
    _team("team-int", "Team Int", 1),
    _team("team-float", "Team Float", 1.0),
    _team("team-bool", "Team Bool", True),
    # one first and last name under two names, one name under two people
    _person("pers-1", "Zed Twin", "Zed", "Twin"),
    _person("pers-2", "Zed Twin Junior", "Zed", "Twin"),
    _person("pers-3", "Shared Name", "Ann", "One"),
    _person("pers-4", "Shared Name", "Bea", "Two"),
]

#: staged beside a rebind: a requirement missing its criticality, and a
#: priority past its bound on one of the example's own requirements
_STAGED: list[dict[str, Any]] = [
    _el(
        "fr-s",
        "FunctionalRequirement",
        name="Staged requirement",
        feature_id="FR-9009",
        **_VERSIONED,
    ),
    {"kind": "update_element", "id": "e_000207", "properties_patch": {"priority": 9}},
]


#: staged beside a rebind to the removal candidate, each refused by it: a
#: performance requirement's inherited ``target_value`` removed, which
#: ``Requirement`` does not declare, and a new non-functional requirement
_REFUSED: dict[str, list[dict[str, Any]]] = {
    "removed-patch": [
        {
            "kind": "update_element",
            "id": "e_000246",
            "properties_patch": {"target_value": None},
        }
    ],
    "removed-create": [
        _el(
            "nfr-s",
            "NonFunctionalRequirement",
            name="Staged NFR",
            criticality="High",
            **_VERSIONED,
        )
    ],
}

#: what the route answers each of them, a ``KeyError``'s quotes stripped
_REFUSALS = {
    "removed-patch": {
        "status": 422,
        "detail": "PerformanceRequirement' has no property 'target_value",
    },
    "removed-create": {
        "status": 422,
        "detail": "Unknown element type 'NonFunctionalRequirement",
    },
}


def _named(items: list[dict[str, Any]], name: str) -> dict[str, Any]:
    (item,) = (item for item in items if item["name"] == name)
    return item


def _required(live: dict[str, Any]) -> dict[str, Any]:
    doc = copy.deepcopy(live)
    _named(doc["elements"], "Organization")["properties"].append(
        {"name": "registry_id", "datatype": "string", "multiplicity": "1"}
    )
    return doc


def _containment(live: dict[str, Any]) -> dict[str, Any]:
    doc = copy.deepcopy(live)
    _named(doc["relationships"], "Refines")["containment"] = True
    return doc


def _key(live: dict[str, Any]) -> dict[str, Any]:
    doc = copy.deepcopy(live)
    _named(doc["elements"], "Team")["key"] = ["size"]
    _named(doc["elements"], "Person")["key"] = None
    return doc


def _removed(live: dict[str, Any]) -> dict[str, Any]:
    doc = copy.deepcopy(live)
    doc["elements"].remove(_named(doc["elements"], "NonFunctionalRequirement"))
    _named(doc["elements"], "PerformanceRequirement")["extends"] = "Requirement"
    return doc


def _pattern(live: dict[str, Any]) -> dict[str, Any]:
    doc = copy.deepcopy(live)
    az_code = _named(
        _named(doc["elements"], "AvailabilityZone")["properties"], "az_code"
    )
    az_code["pattern"] = r"^[a-z]{2,5}-[1-4][a-z]$"
    return doc


def _identical(live: dict[str, Any]) -> dict[str, Any]:
    return copy.deepcopy(live)


_CANDIDATES = {
    "required": _required,
    "containment": _containment,
    "key": _key,
    "removed": _removed,
    "pattern": _pattern,
    "identical": _identical,
}


def _checked(doc: dict[str, Any]) -> dict[str, Any]:
    """The document as a valid candidate: loaded from its YAML as a rebind
    blob is, and served as ``GET /metamodel`` would serve it."""
    return load_metamodel_str(yaml.safe_dump(doc)).model_dump(mode="json")


def _head() -> list[dict[str, Any]]:
    return [
        rules_step([("r-city", "City", _RULES)]),
        batch(_SETUP),
        {"do": "seed"},
    ]


@scenario("metamodel_candidate")
def metamodel_candidate() -> Any:
    live = load_metamodel_str(_METAMODEL_FILE.read_text(encoding="utf-8"))
    live_doc = live.model_dump(mode="json")
    docs = {name: _checked(make(live_doc)) for name, make in _CANDIDATES.items()}
    assert docs["identical"] == live_doc
    diffs = run_steps(
        live,
        [
            *_head(),
            *(
                {"do": "candidate", "case": name, "metamodel": doc}
                for name, doc in docs.items()
            ),
        ],
        full_every=None,
        model_file=_MODEL_FILE,
    )
    results = {
        step["case"]: step["result"]
        for step in diffs["steps"]
        if step["do"] == "candidate"
    }
    for name in ("required", "containment", "key", "removed", "pattern"):
        assert results[name]["now_failing"], f"{name} fails nothing new"
    assert any(result["now_passing"] for result in results.values())
    # a candidate parent splits a duplicate group; a shared one keeps it
    split = [i["target_ids"] for i in results["containment"]["now_passing"]]
    assert split == [["fr-g", "fr-f"]], split
    identical = results["identical"]
    assert not identical["now_failing"] and not identical["now_passing"]
    previews = run_steps(
        live,
        [
            *_head(),
            *(
                {
                    "do": "preview_rebind",
                    "case": name,
                    "metamodel": docs[name],
                    "_ops": _STAGED,
                    "strict": strict,
                }
                for name in ("containment", "removed")
                for strict in (True, False)
            ),
            *(
                {
                    "do": "preview_rebind",
                    "case": case,
                    "metamodel": docs["removed"],
                    "_ops": ops,
                    "strict": False,
                }
                for case, ops in _REFUSED.items()
            ),
        ],
        full_every=None,
        model_file=_MODEL_FILE,
    )
    for step in previews["steps"]:
        assert step["error"] == _REFUSALS.get(step.get("case")), step["error"]
    return {"runs": [diffs, previews]}
