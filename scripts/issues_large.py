"""Write the Python oracle's validation sweep of model M, with violations injected.

Loads ``benchmarks/large.model.json`` against its metamodel as
``scripts/snapshot_v2.py`` does, and derives from it, deterministically, one
batch of model ops that breaks every built-in check the metamodel lets an op
break — ``benchmarks/large.violations.ops.json``. The batch lands through the
ops route's own ``_apply_batch``, the server's own sweep
(``start_validation_sweep(sync=True)``) runs over a session holding the
result, and ``benchmarks/large.issues.json`` receives every issue of the store
as the engine's ``issueKey`` — ``[severity, category, check, message,
target_ids]`` as compact JSON — sorted. ``engine/bench/parity-large.ts``
applies the same ops to the snapshot and compares the engine's sweep with it.

Run from the repo root (``pixi run engine-parity-large`` does):

    pixi run -e core-dev python scripts/issues_large.py
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from pydantic import TypeAdapter

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from data_rover.api.routes._snapshot import build_model_from_dicts  # noqa: E402
from data_rover.api.routes.ops import _apply_batch  # noqa: E402
from data_rover.api.schemas import ModelOpIn  # noqa: E402
from data_rover.api.serialize import parse_model_json  # noqa: E402
from data_rover.api.session import Session  # noqa: E402
from data_rover.api.validation_sweep import start_validation_sweep  # noqa: E402
from data_rover.core.metamodel.loader import load_metamodel_file  # noqa: E402
from data_rover.core.validation.issue import Issue  # noqa: E402
from data_rover.core.validation.state import ValidationState  # noqa: E402

BENCHMARKS = REPO_ROOT / "benchmarks"

#: members of the one large duplicate group: copies of one Person, and it
LARGE_GROUP = 3000

Op = dict[str, Any]
Doc = dict[str, Any]


def issue_key(issue: Issue) -> str:
    """The engine's ``issueKey``: ``JSON.stringify`` of the five fields."""
    return json.dumps(
        [
            issue.severity.value,
            issue.category.value,
            issue.check,
            issue.message,
            list(issue.target_ids),
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )


class Violations:
    """One batch of ops over a model document, each breaking a check.

    Entities are taken in document order, every n-th of a type, and each at
    most once: no op undoes another's violation. Every create carries an
    ``id`` hint, so both appliers name it alike.
    """

    def __init__(self, doc: Doc) -> None:
        self.elements: list[Doc] = doc["elements"]
        self.relationships: list[Doc] = doc["relationships"]
        self.by_type: dict[str, list[Doc]] = defaultdict(list)
        for element in self.elements:
            self.by_type[element["type_name"]].append(element)
        self.taken: set[str] = set()
        self.ops: list[Op] = []
        self.created = 0

    def take(self, type_name: str, count: int, keep: bool = True) -> list[Doc]:
        """`count` untaken elements of exactly `type_name`, spread over the document."""
        pool = [e for e in self.by_type[type_name] if e["id"] not in self.taken]
        stride = max(1, len(pool) // count)
        out = pool[::stride][:count]
        if len(out) < count:
            raise SystemExit(f"model M holds too few {type_name} to take {count}")
        if keep:
            self.taken.update(e["id"] for e in out)
        return out

    def update(self, element: Doc, patch: dict[str, Any]) -> None:
        self.ops.append(
            {"kind": "update_element", "id": element["id"], "properties_patch": patch}
        )

    def create(self, type_name: str, properties: dict[str, Any]) -> str:
        self.created += 1
        new = f"v_{self.created:06d}"
        self.ops.append(
            {
                "kind": "create_element",
                "temp_id": f"tmp_{new}",
                "id": new,
                "type_name": type_name,
                "properties": properties,
            }
        )
        return new

    def connect(
        self,
        type_name: str,
        source: str,
        target: str,
        properties: dict[str, Any] | None = None,
    ) -> None:
        self.created += 1
        new = f"v_{self.created:06d}"
        self.ops.append(
            {
                "kind": "create_relationship",
                "temp_id": f"tmp_{new}",
                "id": new,
                "type_name": type_name,
                "source_id": source,
                "target_id": target,
                "properties": properties or {},
            }
        )

    def build(self) -> list[Op]:
        self.type_conformance()
        self.multiplicity()
        self.facets()
        self.endpoint_typing()
        self.containment()
        self.duplicates()
        self.dangling_by_delete()
        return self.ops

    def type_conformance(self) -> None:
        for server in self.take("Server", 300):
            self.update(server, {"cpu_cores": "many"})
        for service in self.take("Service", 300):
            self.update(service, {"protocol": "FTP"})
        for device in self.take("IoTDevice", 200):
            self.update(device, {"battery_powered": "yes"})
        for incident in self.take("Incident", 200):
            self.update(incident, {"opened_at": "2024-13-01"})
        for database in self.take("Database", 200):
            self.update(database, {"storage_gb": "big"})
        teams = self.take("Team", 200, keep=False)
        for risk, team in zip(self.take("Risk", 200), teams, strict=True):
            self.update(risk, {"risk_owner": team["id"]})
        for entity in self.take("DataEntity", 100):
            self.update(entity, {"upstream_entities": [5]})
        for i, use_case in enumerate(self.take("UseCase", 100)):
            self.update(use_case, {"systems_in_scope": [f"ghost-{i}"]})
        deployed = [r for r in self.relationships if r["type_name"] == "DeployedOn"]
        for rel in deployed[:: len(deployed) // 100][:100]:
            self.ops.append(
                {
                    "kind": "update_relationship",
                    "id": rel["id"],
                    "properties_patch": {"environment": "Moon"},
                }
            )

    def multiplicity(self) -> None:
        for service in self.take("Microservice", 300):
            self.update(service, {"language": None})
        for team in self.take("Team", 100):
            self.update(team, {"location": ["Here", "There"]})
        for i in range(100):
            self.create(
                "AvailabilityZone",
                {
                    "name": f"Orphan zone {i}",
                    "created_at": "2024-02-01",
                    "version": "1.0.0",
                    "status": "Active",
                    "provider": "Nowhere",
                    "az_code": "eu-1a",
                },
            )
        defined = Counter(
            r["source_id"] for r in self.relationships if r["type_name"] == "DefinedBy"
        )
        schemas = self.take("DataSchema", 100, keep=False)
        full = [e for e in self.by_type["APIEndpoint"] if defined[e["id"]] == 2]
        for endpoint, schema in zip(
            full[:: len(full) // 100][:100], schemas, strict=True
        ):
            self.taken.add(endpoint["id"])
            self.connect("DefinedBy", endpoint["id"], schema["id"], {"role": "extra"})
        services = self.take("Service", 200, keep=False)
        for source, target in zip(services[::2], services[1::2], strict=True):
            self.connect("ConnectsTo", source["id"], target["id"])

    def facets(self) -> None:
        for use_case in self.take("UseCase", 200):
            self.update(use_case, {"priority": 9})
        for risk in self.take("Risk", 200):
            self.update(risk, {"likelihood": 0})
        for endpoint in self.take("APIEndpoint", 200):
            self.update(endpoint, {"method": "FETCH"})
        for library in self.take("Library", 200):
            self.update(library, {"package_name": "p" * 150})
        for host in self.take("ContainerHost", 200):
            self.update(host, {"hostname": "Bad_Host"})

    def endpoint_typing(self) -> None:
        people = self.take("Person", 200, keep=False)
        for service, person in zip(self.take("Microservice", 200), people, strict=True):
            self.connect("DependsOn", service["id"], person["id"])

    def containment(self) -> None:
        owner = {
            r["target_id"]: r["source_id"]
            for r in self.relationships
            if r["type_name"] == "Owns"
        }
        organizations = self.take("Organization", 140)
        # A second parent: a team owned elsewhere, owned again.
        for team, other in zip(
            self.take("Team", 100), organizations[:100], strict=True
        ):
            if owner.get(team["id"]) != other["id"]:
                self.connect("Owns", other["id"], team["id"])
        # A cycle: an organization owned by one of its teams, the others below it.
        teams_of: dict[str, list[str]] = defaultdict(list)
        for team, org in owner.items():
            teams_of[org].append(team)
        for org in organizations[100:]:
            teams = [t for t in teams_of[org["id"]] if t not in self.taken]
            if len(teams) >= 2:
                self.taken.add(teams[0])
                self.connect("Owns", teams[0], org["id"])

    def duplicates(self) -> None:
        # Small groups: people renamed after another, in pairs and in threes.
        people = self.take("Person", 500)
        for first, second in zip(people[0:400:2], people[1:400:2], strict=True):
            self.update(second, self.person_key(first))
        for i in range(400, 500, 3):
            if i + 2 < 500:
                for other in people[i + 1 : i + 3]:
                    self.update(other, self.person_key(people[i]))
        requirements = self.take("FunctionalRequirement", 200)
        for first, second in zip(requirements[::2], requirements[1::2], strict=True):
            self.update(second, {"feature_id": first["properties"]["feature_id"]})
        # Siblings under one system that share a name.
        children: dict[str, list[str]] = defaultdict(list)
        for rel in self.relationships:
            if rel["type_name"] == "SystemContainsComponent":
                children[rel["source_id"]].append(rel["target_id"])
        named = {e["id"]: e for e in self.elements}
        pairs = 0
        for kids in children.values():
            free = [k for k in kids if k not in self.taken]
            if pairs == 100 or len(free) < 2:
                continue
            first, second = named[free[0]], named[free[1]]
            if first["type_name"] != second["type_name"]:
                continue
            self.taken.update((first["id"], second["id"]))
            self.update(second, {"name": first["properties"]["name"]})
            pairs += 1
        # One large group: copies of one person.
        [like] = self.take("Person", 1)
        for _ in range(LARGE_GROUP):
            self.create("Person", dict(like["properties"]))

    @staticmethod
    def person_key(person: Doc) -> dict[str, Any]:
        props = person["properties"]
        return {"first_name": props["first_name"], "last_name": props["last_name"]}

    def dangling_by_delete(self) -> None:
        owners = [
            e["properties"]["risk_owner"]
            for e in self.by_type["Risk"]
            if e["id"] not in self.taken and "risk_owner" in e["properties"]
        ]
        gone = [o for o in dict.fromkeys(owners) if o not in self.taken][:100]
        for person in gone:
            self.taken.add(person)
            self.ops.append({"kind": "delete_element", "id": person})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", type=Path, default=BENCHMARKS / "large.model.json")
    parser.add_argument(
        "--metamodel",
        type=Path,
        default=REPO_ROOT / "examples" / "smart-city.metamodel.yaml",
    )
    parser.add_argument(
        "--ops", type=Path, default=BENCHMARKS / "large.violations.ops.json"
    )
    parser.add_argument("--out", type=Path, default=BENCHMARKS / "large.issues.json")
    args = parser.parse_args()

    if not args.model.exists():
        raise SystemExit(
            f"{args.model} is missing: examples/generate_large_model.py writes it "
            "(--scale 170 for model M)"
        )
    metamodel = load_metamodel_file(args.metamodel)
    doc = parse_model_json(args.model.read_bytes())
    ops = Violations(doc).build()
    args.ops.write_text(json.dumps(ops, ensure_ascii=False), encoding="utf-8")
    model = build_model_from_dicts(metamodel, doc, strict=False)
    _apply_batch(
        model, TypeAdapter(list[ModelOpIn]).validate_python(ops), restore=False
    )
    state = ValidationState()
    session = Session(metamodel=metamodel, model=model, validation=state)
    start = time.perf_counter()
    progress = start_validation_sweep(session, sync=True)
    seconds = time.perf_counter() - start
    if progress.error or progress.done != progress.total:
        raise SystemExit("the sweep did not run to its end")
    issues = list(state.iter_issues())
    keys = sorted(issue_key(issue) for issue in issues)
    args.out.write_text(json.dumps(keys, ensure_ascii=False), encoding="utf-8")
    checks = Counter(f"{i.check} ({i.category.value})" for i in issues)
    print(
        f"wrote {args.ops}: {len(ops):,} ops; {args.out}: {len(keys):,} issues "
        f"over {progress.total:,} entities, swept in {seconds:.1f} s"
    )
    for check, n in sorted(checks.items()):
        print(f"  {check}: {n:,}")


if __name__ == "__main__":
    main()
