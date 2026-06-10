"""Generate `smart-city.model.json` conforming to `smart-city.metamodel.yaml`.

Deterministic builder (no RNG seed needed). `build_model(scale)` produces
roughly ``scale * 1000`` elements and ``scale * 746`` relationships and is
designed to pass every validator in `data_rover.core.validation` against the
smart-city metamodel at any scale. Running this file as a script writes the
scale-1 reference model.

Run from the repo root:

    PYTHONPATH=src pixi run -e core-dev python examples/generate_smart_city_model.py

For large benchmark fixtures see `examples/generate_large_model.py`, which
reuses `build_model` with a higher scale.
"""

from __future__ import annotations

import datetime as _dt
import itertools
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
METAMODEL_PATH = REPO_ROOT / "examples" / "smart-city.metamodel.yaml"
MODEL_PATH = REPO_ROOT / "examples" / "smart-city.model.json"


# ---------------------------------------------------------------- low-level


def _iso(date: _dt.date) -> str:
    return date.isoformat()


BASE_DATE = _dt.date(2024, 1, 1)


def _date(offset_days: int) -> str:
    return _iso(BASE_DATE + _dt.timedelta(days=offset_days))


@dataclass
class Element:
    id: str
    type_name: str
    properties: dict[str, Any] = field(default_factory=dict)
    rev: int = 0


@dataclass
class Relationship:
    id: str
    type_name: str
    source_id: str
    target_id: str
    properties: dict[str, Any] = field(default_factory=dict)
    rev: int = 0


# ---------------------------------------------------------------- helpers

STATUSES = ["Draft", "Proposed", "Approved", "Active", "Deprecated"]
CRITICALITIES = ["Low", "Medium", "High", "Critical"]
LIFECYCLE = ["Inception", "Development", "Operation", "Maintenance"]
PROTOCOLS = ["HTTP", "HTTPS", "MQTT", "AMQP", "TCP", "UDP", "gRPC", "WebSocket"]
ENVS = ["Development", "Testing", "Staging", "Production"]
DATA_CLASS = ["Public", "Internal", "Confidential", "Restricted"]
REGIONS = ["NA_East", "NA_West", "EU_Central", "EU_North", "APAC", "SA", "AF", "ME"]
OPSYS = ["Linux", "Windows", "MacOS", "RTOS"]
DEVICE_CAT = ["Sensor", "Actuator", "Gateway", "Edge", "Controller"]
COMPLIANCE = ["GDPR", "HIPAA", "SOC2", "ISO27001", "PCI_DSS", "NIST"]

FIRST_NAMES = [
    "Ada", "Bo", "Cai", "Devi", "Eli", "Fen", "Gia", "Hiro", "Ines", "Jia",
    "Kai", "Lia", "Mio", "Nia", "Ola", "Pia", "Quin", "Ravi", "Sora", "Tia",
    "Uma", "Vik", "Wen", "Xia", "Yara", "Zhi", "Ari", "Bex", "Cleo", "Dax",
]
LAST_NAMES = [
    "Akiyama", "Bauer", "Costa", "Dubois", "Esposito", "Fischer", "García",
    "Hassan", "Ibarra", "Jensen", "Kowalski", "Lefebvre", "Müller", "Nakamura",
    "Oliveira", "Pavlov", "Quintero", "Rossi", "Suzuki", "Takeda", "Ueno",
    "Vargas", "Watanabe", "Xu", "Yamamoto", "Zhang",
]

HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"]


def base_versioned(idx: int, kind: str) -> dict[str, Any]:
    return {
        "name": f"{kind}-{idx:04d}",
        "description": f"{kind} entity #{idx} in the smart-city reference model.",
        "tags": [kind.lower(), f"batch-{idx // 50:02d}"],
        "created_at": _date(idx % 365),
        "updated_at": _date((idx + 17) % 365),
        "version": f"v{1 + idx % 4}.{idx % 12}.{idx % 10}",
        "status": STATUSES[idx % len(STATUSES)],
    }


def base_owned(idx: int, kind: str) -> dict[str, Any]:
    p = base_versioned(idx, kind)
    p["priority"] = 1 + idx % 5
    return p


# ---------------------------------------------------------------- builder


def build_model(scale: int = 1) -> dict[str, Any]:
    """Build a validator-clean smart-city model payload.

    `scale` linearly multiplies every entity count: scale 1 yields ~1000
    elements / ~746 relationships, scale 170 yields ~170k / ~127k. The output
    is fully deterministic for a given scale.
    """
    if scale < 1:
        raise ValueError("scale must be >= 1")

    eid_seq = itertools.count(1)
    rid_seq = itertools.count(1)
    elements: list[Element] = []
    relationships: list[Relationship] = []

    def mk(type_name: str, **props: Any) -> Element:
        e = Element(id=f"e_{next(eid_seq):06d}", type_name=type_name, properties=props)
        elements.append(e)
        return e

    def rel(type_name: str, src: Element, tgt: Element, **props: Any) -> Relationship:
        r = Relationship(
            id=f"r_{next(rid_seq):06d}",
            type_name=type_name,
            source_id=src.id,
            target_id=tgt.id,
            properties=props,
        )
        relationships.append(r)
        return r

    # ------------------------------------------------------------ stakeholders

    organizations = [
        mk(
            "Organization",
            **{
                **base_versioned(i, "Org"),
                "name": f"Organization-{i:03d}",
                "email": f"contact{i}@org{i}.example",
                "country": ["US", "DE", "FR", "JP", "BR"][i % 5],
                "industry": ["Public Sector", "Telecom", "Energy", "Mobility", "Health"][i % 5],
            },
        )
        for i in range(1, 5 * scale + 1)
    ]

    teams: list[Element] = []
    for i in range(1, 25 * scale + 1):
        teams.append(
            mk(
                "Team",
                **{
                    **base_versioned(i, "Team"),
                    "name": f"Team-{i:03d}",
                    "email": f"team{i}@org.example",
                    "size": 3 + i % 25,
                    "location": ["Berlin", "Paris", "Tokyo", "São Paulo", "Austin"][i % 5],
                },
            )
        )

    # Persons are keyed on (first_name, last_name); the 30x26 name grid yields
    # 780 unique combos, so later "cycles" get a numeric last-name suffix.
    persons: list[Element] = []
    name_grid = len(FIRST_NAMES) * len(LAST_NAMES)
    for p in range(160 * scale):
        cycle_no = p // name_grid
        first = FIRST_NAMES[(p % name_grid) // len(LAST_NAMES)]
        last = LAST_NAMES[p % len(LAST_NAMES)]
        if cycle_no:
            last = f"{last}{cycle_no + 1}"
        person_counter = p + 1
        persons.append(
            mk(
                "Person",
                **{
                    **base_versioned(person_counter, "Person"),
                    "name": f"{first} {last}",
                    "email": f"{first.lower()}.{last.lower().replace('ü','u').replace('ç','c').replace('ã','a').replace('í','i').replace('á','a').replace('é','e').replace('ö','o')}@example.com",
                    "first_name": first,
                    "last_name": last,
                    "role": [
                        "Architect", "Engineer", "Manager", "Analyst", "Researcher",
                        "Operator", "Designer", "Lead",
                    ][person_counter % 8],
                },
            )
        )

    # ------------------------------------------------------------ requirements / use cases

    use_cases: list[Element] = []
    for i in range(1, 15 * scale + 1):
        use_cases.append(
            mk(
                "UseCase",
                **{
                    **base_owned(i, "UC"),
                    "name": f"UseCase-{i:03d}",
                    "primary_actor": ["Citizen", "Operator", "Administrator", "Maintainer"][i % 4],
                    "preconditions": [f"precondition-{i}-a", f"precondition-{i}-b"],
                    "postconditions": [f"postcondition-{i}-a"],
                    "approval_level": ["Individual", "TeamLead", "Department", "Executive", "Board"][i % 5],
                },
            )
        )

    # feature_id must match ^FR-\d{4}$ and is the uniqueness key, so the
    # FunctionalRequirement population is capped at 9999.
    functional_reqs: list[Element] = []
    for i in range(1, min(25 * scale, 9999) + 1):
        functional_reqs.append(
            mk(
                "FunctionalRequirement",
                **{
                    **base_owned(i, "FR"),
                    "name": f"FR-{i:04d}-name",
                    "criticality": CRITICALITIES[i % 4],
                    "rationale": f"Captures functional behaviour #{i}.",
                    "feature_id": f"FR-{i:04d}",
                },
            )
        )

    nonfunc_reqs: list[Element] = []
    for i in range(1, 15 * scale + 1):
        nonfunc_reqs.append(
            mk(
                "NonFunctionalRequirement",
                **{
                    **base_owned(i, "NFR"),
                    "name": f"NFR-{i:04d}",
                    "criticality": CRITICALITIES[(i + 1) % 4],
                    "metric": ["availability", "throughput", "MTTR", "MTBF"][i % 4],
                    "target_value": float(100 + i * 7),
                    "unit": ["percent", "rps", "minutes", "hours"][i % 4],
                },
            )
        )

    perf_reqs: list[Element] = []
    for i in range(1, 15 * scale + 1):
        perf_reqs.append(
            mk(
                "PerformanceRequirement",
                **{
                    **base_owned(i, "PERF"),
                    "name": f"PERF-{i:04d}",
                    "criticality": CRITICALITIES[i % 4],
                    "metric": "latency_p99",
                    "target_value": float(50 + (i % 100000) * 5),
                    "unit": "ms",
                    "latency_p99_ms": float(50 + (i % 100000) * 5),
                    "throughput_rps": float(100 + i * 20),
                },
            )
        )

    compl_reqs: list[Element] = []
    for i in range(1, 12 * scale + 1):
        compl_reqs.append(
            mk(
                "ComplianceRequirement",
                **{
                    **base_owned(i, "CR"),
                    "name": f"CR-{i:04d}",
                    "criticality": CRITICALITIES[i % 4],
                    "standard": COMPLIANCE[i % len(COMPLIANCE)],
                    "clause": f"§{i}.{i + 1}",
                },
            )
        )

    sec_reqs: list[Element] = []
    for i in range(1, 12 * scale + 1):
        sec_reqs.append(
            mk(
                "SecurityRequirement",
                **{
                    **base_owned(i, "SR"),
                    "name": f"SR-{i:04d}",
                    "criticality": CRITICALITIES[(i + 2) % 4],
                    "threat": ["spoofing", "tampering", "repudiation", "info-disclosure", "DoS", "EoP"][i % 6],
                    "mitigation": f"Mitigation strategy for SR-{i:04d}.",
                },
            )
        )

    all_reqs = functional_reqs + nonfunc_reqs + perf_reqs + compl_reqs + sec_reqs

    # ------------------------------------------------------------ systems

    software_systems: list[Element] = []
    for i in range(1, 12 * scale + 1):
        software_systems.append(
            mk(
                "SoftwareSystem",
                **{
                    **base_owned(i, "SWSys"),
                    "name": f"SoftwareSystem-{i:03d}",
                    "criticality": CRITICALITIES[i % 4],
                    "lifecycle_phase": LIFECYCLE[i % 4],
                    "repository_url": f"https://git.example.org/smart-city/swsys-{i:03d}",
                },
            )
        )

    physical_systems: list[Element] = []
    for i in range(1, 10 * scale + 1):
        physical_systems.append(
            mk(
                "PhysicalSystem",
                **{
                    **base_owned(i, "PhySys"),
                    "name": f"PhysicalSystem-{i:03d}",
                    "criticality": CRITICALITIES[i % 4],
                    "lifecycle_phase": LIFECYCLE[(i + 1) % 4],
                    "site_code": f"SITE-{i % 1000:03d}",
                },
            )
        )

    subsystems: list[Element] = []
    for i in range(1, 10 * scale + 1):
        subsystems.append(
            mk(
                "Subsystem",
                **{
                    **base_owned(i, "SubSys"),
                    "name": f"Subsystem-{i:03d}",
                    "criticality": CRITICALITIES[(i + 2) % 4],
                    "lifecycle_phase": LIFECYCLE[i % 4],
                    "discriminator": ["analytics", "control", "ingestion"][i % 3],
                },
            )
        )

    all_systems = software_systems + physical_systems + subsystems

    # ------------------------------------------------------------ components

    services: list[Element] = []
    for i in range(1, 40 * scale + 1):
        services.append(
            mk(
                "Service",
                **{
                    **base_owned(i, "Svc"),
                    "name": f"Service-{i:03d}",
                    "api_version": f"v{1 + i % 3}",
                    "protocol": PROTOCOLS[i % len(PROTOCOLS)],
                    "port": 1024 + i % 60000,
                    "sla_uptime": 0.99 + (i % 9) * 0.001,
                },
            )
        )

    microservices: list[Element] = []
    for i in range(1, 80 * scale + 1):
        microservices.append(
            mk(
                "Microservice",
                **{
                    **base_owned(i, "MSvc"),
                    "name": f"Microservice-{i:03d}",
                    "api_version": f"v{1 + i % 4}",
                    "protocol": ["HTTP", "HTTPS", "gRPC"][i % 3],
                    "port": 8000 + i % 50000,
                    "sla_uptime": 0.995 + (i % 5) * 0.0008,
                    "language": ["python", "go", "rust", "java", "typescript"][i % 5],
                    "framework": ["fastapi", "gin", "actix", "spring", "nestjs"][i % 5],
                    "replica_count": 1 + i % 12,
                },
            )
        )

    databases: list[Element] = []
    for i in range(1, 30 * scale + 1):
        databases.append(
            mk(
                "Database",
                **{
                    **base_owned(i, "DB"),
                    "name": f"Database-{i:03d}",
                    "api_version": f"v{1 + i % 3}",
                    "engine": ["postgres", "mysql", "mongodb", "cassandra", "clickhouse"][i % 5],
                    "storage_gb": float(50 + (i % 40000) * 25),
                    "schema_version": f"{1 + i % 4}.{i % 8}",
                },
            )
        )

    brokers: list[Element] = []
    for i in range(1, 20 * scale + 1):
        brokers.append(
            mk(
                "MessageBroker",
                **{
                    **base_owned(i, "MQ"),
                    "name": f"Broker-{i:03d}",
                    "broker_protocol": ["MQTT", "AMQP", "TCP"][i % 3],
                    "partition_count": 4 + (i % 16),
                },
            )
        )

    caches: list[Element] = []
    for i in range(1, 15 * scale + 1):
        caches.append(
            mk(
                "Cache",
                **{
                    **base_owned(i, "Cache"),
                    "name": f"Cache-{i:03d}",
                    "eviction_policy": ["LRU", "LFU", "FIFO"][i % 3],
                    "memory_gb": float(1 + i % 32),
                },
            )
        )

    uis: list[Element] = []
    for i in range(1, 20 * scale + 1):
        uis.append(
            mk(
                "UI",
                **{
                    **base_owned(i, "UI"),
                    "name": f"UI-{i:03d}",
                    "ui_framework": ["react", "vue", "svelte", "solid"][i % 4],
                    "locales": [["en"], ["en", "de"], ["en", "ja", "pt"]][i % 3],
                },
            )
        )

    libraries: list[Element] = []
    for i in range(1, 15 * scale + 1):
        libraries.append(
            mk(
                "Library",
                **{
                    **base_owned(i, "Lib"),
                    "name": f"Library-{i:03d}",
                    "package_name": f"@smart-city/lib-{i:03d}",
                    "license": ["Apache-2.0", "MIT", "BSD-3-Clause"][i % 3],
                },
            )
        )

    all_components = services + microservices + databases + brokers + caches + uis + libraries

    # ------------------------------------------------------------ infrastructure

    servers: list[Element] = []
    for i in range(1, 40 * scale + 1):
        servers.append(
            mk(
                "Server",
                **{
                    **base_owned(i, "Srv"),
                    "name": f"Server-{i:04d}",
                    "hostname": f"srv-{i:04d}",
                    "ip_address": f"10.0.{(i // 256) % 256}.{i % 256}",
                    "cpu_cores": [4, 8, 16, 32, 64][i % 5],
                    "ram_gb": float([16, 32, 64, 128, 256][i % 5]),
                    "os": OPSYS[i % len(OPSYS)],
                },
            )
        )

    container_hosts: list[Element] = []
    for i in range(1, 30 * scale + 1):
        container_hosts.append(
            mk(
                "ContainerHost",
                **{
                    **base_owned(i, "CHost"),
                    "name": f"ContainerHost-{i:04d}",
                    "hostname": f"chost-{i:04d}",
                    "ip_address": f"10.1.{(i // 256) % 256}.{i % 256}",
                    "cpu_cores": [8, 16, 32, 64][i % 4],
                    "ram_gb": float([32, 64, 128, 256][i % 4]),
                    "os": "Linux",
                    "container_runtime": ["docker", "containerd", "podman"][i % 3],
                },
            )
        )

    vms: list[Element] = []
    for i in range(1, 20 * scale + 1):
        vms.append(
            mk(
                "VirtualMachine",
                **{
                    **base_owned(i, "VM"),
                    "name": f"VirtualMachine-{i:04d}",
                    "hostname": f"vm-{i:04d}",
                    "ip_address": f"10.2.{(i // 256) % 256}.{i % 256}",
                    "cpu_cores": [2, 4, 8, 16][i % 4],
                    "ram_gb": float([8, 16, 32, 64][i % 4]),
                    "os": OPSYS[i % len(OPSYS)],
                    "hypervisor": ["kvm", "vmware", "hyper-v"][i % 3],
                },
            )
        )

    iot_devices: list[Element] = []
    for i in range(1, 50 * scale + 1):
        iot_devices.append(
            mk(
                "IoTDevice",
                **{
                    **base_owned(i, "IoT"),
                    "name": f"IoTDevice-{i:04d}",
                    "hostname": f"iot-{i:04d}",
                    "ip_address": f"192.168.{(i // 256) % 256}.{i % 256}",
                    "device_category": DEVICE_CAT[i % len(DEVICE_CAT)],
                    "firmware_version": f"{1 + i % 4}.{i % 12}.{i % 10}",
                    "battery_powered": bool(i % 2),
                },
            )
        )

    gateways: list[Element] = []
    for i in range(1, 10 * scale + 1):
        gateways.append(
            mk(
                "EdgeGateway",
                **{
                    **base_owned(i, "Gw"),
                    "name": f"EdgeGateway-{i:03d}",
                    "hostname": f"gw-{i:03d}",
                    "ip_address": f"172.16.{(i // 256) % 256}.{i % 256}",
                    "device_category": "Gateway",
                    "firmware_version": f"2.{i % 10}.0",
                    "battery_powered": False,
                    "max_connected_devices": 100 * (1 + i % 8),
                },
            )
        )

    all_nodes = servers + container_hosts + vms + iot_devices + gateways

    # ------------------------------------------------------------ clouds

    cloud_regions: list[Element] = []
    for i in range(1, 5 * scale + 1):
        cloud_regions.append(
            mk(
                "CloudRegion",
                **{
                    **base_owned(i, "Region"),
                    "name": f"CloudRegion-{i:02d}",
                    "provider": ["aws", "azure", "gcp", "oci", "ovh"][i % 5],
                    "region_code": REGIONS[i % len(REGIONS)],
                },
            )
        )

    # AZs distributed across regions (containment satisfied below).
    zones: list[Element] = []
    for i in range(1, 8 * scale + 1):
        zones.append(
            mk(
                "AvailabilityZone",
                **{
                    **base_owned(i, "AZ"),
                    "name": f"AvailabilityZone-{i:02d}",
                    "provider": cloud_regions[i % len(cloud_regions)].properties["provider"],
                    "az_code": f"zone-{i % 10}a",
                },
            )
        )

    # ------------------------------------------------------------ data & APIs

    data_entities: list[Element] = []
    for i in range(1, 100 * scale + 1):
        data_entities.append(
            mk(
                "DataEntity",
                **{
                    **base_versioned(i, "DE"),
                    "name": f"DataEntity-{i:04d}",
                    "classification": DATA_CLASS[i % len(DATA_CLASS)],
                    "retention_days": 30 * (1 + i % 24),
                },
            )
        )

    data_schemas: list[Element] = []
    for i in range(1, 40 * scale + 1):
        data_schemas.append(
            mk(
                "DataSchema",
                **{
                    **base_versioned(i, "DS"),
                    "name": f"DataSchema-{i:04d}",
                    "format": ["json", "avro", "protobuf", "yaml"][i % 4],
                    "schema_text": f"# schema #{i}\n",
                },
            )
        )

    api_endpoints: list[Element] = []
    for i in range(1, 60 * scale + 1):
        api_endpoints.append(
            mk(
                "APIEndpoint",
                **{
                    "name": f"Endpoint-{i:04d}",
                    "path": f"/api/v{1 + i % 3}/resource-{i:04d}",
                    "method": HTTP_METHODS[i % len(HTTP_METHODS)],
                    "endpoint_protocol": ["HTTP", "HTTPS", "gRPC"][i % 3],
                    "deprecated": bool(i % 7 == 0),
                },
            )
        )

    # ------------------------------------------------------------ operations

    processes: list[Element] = []
    for i in range(1, 25 * scale + 1):
        processes.append(
            mk(
                "Process",
                **{
                    **base_versioned(i, "Proc"),
                    "name": f"Process-{i:03d}",
                    "sla_minutes": 60 * (1 + i % 24),
                },
            )
        )

    slas: list[Element] = []
    for i in range(1, 10 * scale + 1):
        slas.append(
            mk(
                "SLA",
                **{
                    **base_versioned(i, "SLA"),
                    "name": f"SLA-{i:03d}",
                    "availability_target": 0.95 + (i % 5) * 0.01,
                    "response_time_ms": 100 * (1 + i % 10),
                },
            )
        )

    documents: list[Element] = []
    for i in range(1, 20 * scale + 1):
        documents.append(
            mk(
                "Document",
                **{
                    **base_versioned(i, "Doc"),
                    "name": f"Document-{i:03d}",
                    "url": f"https://docs.example.org/smart-city/doc-{i:03d}",
                    "content_type": ["text/markdown", "application/pdf", "text/html"][i % 3],
                },
            )
        )

    projects: list[Element] = []
    for i in range(1, 8 * scale + 1):
        projects.append(
            mk(
                "Project",
                **{
                    **base_owned(i, "Proj"),
                    "name": f"Project-{i:03d}",
                    "start_date": _date(i * 7 % 365),
                    "end_date": _date((i * 7 % 365) + 365),
                    "budget_usd": float(100000 * (1 + i)),
                },
            )
        )

    incidents: list[Element] = []
    for i in range(1, 15 * scale + 1):
        incidents.append(
            mk(
                "Incident",
                **{
                    "name": f"Incident-{i:04d}",
                    "description": f"Incident {i} observed during operation.",
                    "tags": ["operational", "post-mortem"],
                    "severity": CRITICALITIES[i % 4],
                    "opened_at": _date(i * 9 % 365),
                    "resolved": bool(i % 3 != 0),
                },
            )
        )

    risks: list[Element] = []
    for i in range(1, 25 * scale + 1):
        risks.append(
            mk(
                "Risk",
                **{
                    "name": f"Risk-{i:04d}",
                    "description": f"Risk register entry #{i}.",
                    "tags": ["risk", f"q{1 + i % 4}"],
                    "likelihood": 1 + i % 5,
                    "impact": 1 + (i * 2) % 5,
                },
            )
        )

    # ------------------------------------------------------------ now wire up references in properties

    # FunctionalRequirement.related_use_cases (multi-valued element-typed prop)
    for i, fr in enumerate(functional_reqs):
        fr.properties["related_use_cases"] = [
            use_cases[i % len(use_cases)].id,
            use_cases[(i + 1) % len(use_cases)].id,
        ]

    # UseCase.systems_in_scope
    for i, uc in enumerate(use_cases):
        uc.properties["systems_in_scope"] = [
            all_systems[i % len(all_systems)].id,
            all_systems[(i + 3) % len(all_systems)].id,
        ]

    # DataEntity.upstream_entities (chain a few)
    for i in range(5, len(data_entities)):
        data_entities[i].properties["upstream_entities"] = [data_entities[i - 5].id]

    # Risk.risk_owner
    for i, r in enumerate(risks):
        r.properties["risk_owner"] = persons[i % len(persons)].id

    # ------------------------------------------------------------ relationships

    # Trace specializations: Refines, DerivedFrom (only between concrete Requirements)
    for i in range(8 * scale):
        rel(
            "Refines",
            functional_reqs[i % len(functional_reqs)],
            functional_reqs[(i + 1) % len(functional_reqs)],
        )
    for i in range(6 * scale):
        rel("DerivedFrom", nonfunc_reqs[i], functional_reqs[i % len(functional_reqs)])

    # Satisfies: Components -> Requirements
    for i in range(40 * scale):
        rel("Satisfies", all_components[i % len(all_components)], all_reqs[i % len(all_reqs)])

    # Verifies: UseCases -> Requirements
    for i in range(15 * scale):
        rel("Verifies", use_cases[i % len(use_cases)], all_reqs[(i * 3) % len(all_reqs)])

    # Owns (containment): Org -> Team; each Team contained at most once.
    for i, t in enumerate(teams[: 20 * scale]):
        rel("Owns", organizations[i % len(organizations)], t)

    # MemberOf: Person -> Team, with relationship properties
    for i in range(40 * scale):
        rel(
            "MemberOf",
            persons[i % len(persons)],
            teams[i % len(teams)],
            since=_date((i * 11) % 365),
            is_lead=(i % 7 == 0),
        )

    # Responsible: Stakeholder -> System (with role + since)
    for i in range(20 * scale):
        src = persons[i % len(persons)] if i % 2 else teams[i % len(teams)]
        rel(
            "Responsible",
            src,
            all_systems[i % len(all_systems)],
            role=["product-owner", "sponsor", "tech-lead", "ops"][i % 4],
            since=_date((i * 13) % 365),
        )

    # SystemContainsComponent (containment) — each component contained at most once.
    # Distribute most components across systems.
    for i, comp in enumerate(all_components):
        if i >= 180 * scale:
            break  # leave a few uncontained
        sys_el = all_systems[i % len(all_systems)]
        rel("SystemContainsComponent", sys_el, comp)

    # DependsOn: between components (avoid self loops)
    for i in range(30 * scale):
        src = all_components[i]
        tgt = all_components[(i + 7) % len(all_components)]
        if src.id == tgt.id:
            continue
        rel(
            "DependsOn",
            src,
            tgt,
            critical=(i % 4 == 0),
            version_constraint=f">=1.{i % 10}.0",
        )

    # UsesDatabase (extends DependsOn): Microservice -> Database
    for i in range(15 * scale):
        rel(
            "UsesDatabase",
            microservices[i % len(microservices)],
            databases[i % len(databases)],
            critical=(i % 3 == 0),
            version_constraint=f">={1 + i % 9}.0",
        )

    # ConnectsTo: Service <-> Service (incl. Microservices)
    all_svc = services + microservices
    for i in range(20 * scale):
        src = all_svc[i]
        tgt = all_svc[(i + 5) % len(all_svc)]
        if src.id == tgt.id:
            continue
        rel(
            "ConnectsTo",
            src,
            tgt,
            transport_protocol=PROTOCOLS[i % len(PROTOCOLS)],
            latency_ms_avg=float(5 + i % 50),
        )

    # CachedBy: Microservice -> Cache
    for i in range(10 * scale):
        rel(
            "CachedBy",
            microservices[i],
            caches[i % len(caches)],
            ttl_seconds=60 * (1 + i % 60),
        )

    # PublishesTo / SubscribesTo: Microservice -> MessageBroker
    for i in range(12 * scale):
        rel(
            "PublishesTo",
            microservices[i],
            brokers[i % len(brokers)],
            topic=f"events.{i:03d}",
        )
    for i in range(12 * scale):
        rel(
            "SubscribesTo",
            microservices[(i + 5) % len(microservices)],
            brokers[(i + 1) % len(brokers)],
            topic=f"events.{i:03d}",
            queue_group=f"consumers-{i % 4}",
        )

    # DeployedOn: Component -> Node (env + since)
    for i in range(40 * scale):
        rel(
            "DeployedOn",
            all_components[i % len(all_components)],
            all_nodes[i % len(all_nodes)],
            environment=ENVS[i % len(ENVS)],
            since=_date((i * 5) % 365),
        )

    # HostedIn: Node -> Cloud
    clouds = cloud_regions + zones
    for i in range(25 * scale):
        rel(
            "HostedIn",
            all_nodes[i % len(all_nodes)],
            clouds[i % len(clouds)],
            region_code=REGIONS[i % len(REGIONS)],
        )

    # HasZone (containment, source_multiplicity=1 -> each AZ has exactly 1 parent)
    for i, z in enumerate(zones):
        rel("HasZone", cloud_regions[i % len(cloud_regions)], z)

    # GatewayServes (containment): EdgeGateway -> IoTDevice; each IoT contained at most once
    for i, dev in enumerate(iot_devices[: 30 * scale]):
        rel("GatewayServes", gateways[i % len(gateways)], dev)

    # ExposesEndpoint (containment): Service -> APIEndpoint; each endpoint contained at most once
    for i, ep in enumerate(api_endpoints[: 45 * scale]):
        rel("ExposesEndpoint", all_svc[i % len(all_svc)], ep)

    # DefinedBy: APIEndpoint -> DataSchema with role; target_multiplicity 0..2.
    # Give some endpoints a request schema, and some also a response schema.
    for i, ep in enumerate(api_endpoints[: 40 * scale]):
        rel(
            "DefinedBy",
            ep,
            data_schemas[i % len(data_schemas)],
            role="request",
        )
        if i % 2 == 0:
            rel(
                "DefinedBy",
                ep,
                data_schemas[(i + 7) % len(data_schemas)],
                role="response",
            )

    # PersistsData: Database -> DataEntity
    for i in range(20 * scale):
        rel("PersistsData", databases[i % len(databases)], data_entities[i % len(data_entities)])

    # GovernedBySchema: DataEntity -> DataSchema (target_multiplicity 0..1); each entity once
    for i in range(15 * scale):
        rel("GovernedBySchema", data_entities[i], data_schemas[i % len(data_schemas)])

    # AffectsProcess: Incident -> Process
    for i in range(8 * scale):
        rel(
            "AffectsProcess",
            incidents[i % len(incidents)],
            processes[i % len(processes)],
            downtime_minutes=15 * (1 + i % 20),
        )

    # Mitigates: SecurityRequirement -> Risk
    for i in range(8 * scale):
        rel("Mitigates", sec_reqs[i % len(sec_reqs)], risks[i % len(risks)])

    # AssignedTo: Risk -> Person (target_multiplicity 0..1); each risk at most once
    for i in range(10 * scale):
        rel("AssignedTo", risks[i], persons[i % len(persons)])

    # MustComplyWith: System -> ComplianceRequirement
    for i in range(12 * scale):
        rel("MustComplyWith", all_systems[i % len(all_systems)], compl_reqs[i % len(compl_reqs)])

    # AppliesUseCase: UseCase -> System
    for i in range(12 * scale):
        rel("AppliesUseCase", use_cases[i % len(use_cases)], all_systems[i % len(all_systems)])

    # DocumentedBy: VersionedElement -> Document (use a mix of source types)
    documentable = (
        software_systems
        + all_components[: 20 * scale]
        + processes[: 5 * scale]
        + data_entities[: 5 * scale]
    )
    for i in range(15 * scale):
        rel("DocumentedBy", documentable[i % len(documentable)], documents[i % len(documents)])

    # PartOfProject: System -> Project
    for i in range(10 * scale):
        rel("PartOfProject", all_systems[i % len(all_systems)], projects[i % len(projects)])

    # ------------------------------------------------------------ payload

    return {
        "rev": 1,
        "elements": [
            {"id": e.id, "type_name": e.type_name, "properties": e.properties, "rev": e.rev}
            for e in elements
        ],
        "relationships": [
            {
                "id": r.id,
                "type_name": r.type_name,
                "source_id": r.source_id,
                "target_id": r.target_id,
                "properties": r.properties,
                "rev": r.rev,
            }
            for r in relationships
        ],
    }


# ---------------------------------------------------------------- write JSON

if __name__ == "__main__":
    data = build_model(scale=1)
    MODEL_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(
        f"wrote {MODEL_PATH.relative_to(REPO_ROOT)}: "
        f"{len(data['elements'])} elements, {len(data['relationships'])} relationships"
    )
