"""Deterministic `manifest.json` for an exporter run's zip.

The manifest records what an export produced — which entry rendered to
which table, under which format, and which final archive member paths it
landed at — plus the run's aggregate `truncated`/`degraded` flags so a
consumer can tell at a glance whether anything in the zip is incomplete or
error-marked without opening every file.

Deliberately NO wall-clock field. `model_rev` is the run's reproducible
identity: the same model revision, the same entries, the same overrides
produce the same manifest bytes every time. A `generated_at` timestamp would
break that — and would in turn break `build_zip`'s own determinism stance
(`ZIP_DATE_TIME` pins every member's timestamp so identical content zips
byte-identically; see `table_export_engine.py`). A consumer that wants a
download time already has one, off the HTTP `Date` response header — this
file is not the place for it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

#: The manifest's reserved root-level member name. Seeded into the assembly
#: loop's `taken` set (routes/exports.py) so a user entry that happens to
#: render to the stem "manifest" dedupes against it rather than colliding.
MANIFEST_NAME = "manifest.json"

#: Bumped only on a wire-incompatible change to the document shape below.
MANIFEST_VERSION = 1


@dataclass(frozen=True)
class ManifestEntry:
    """One exporter entry's record in the manifest, built from its resolved
    `ExportFiles` (`.truncated`/`.degraded`) and the FINAL, post-dedupe,
    post-prefix archive member paths it produced."""

    name: str  # rendered entry name
    table_ref: str
    table_name: str
    format: str
    truncated: bool
    degraded: bool
    files: list[str]  # final member paths
    #: The entry's `transform` snippet artifact id, or `None` when the entry
    #: has no transform.
    transform: str | None = None


def build_manifest(
    *,
    project_id: str,
    artifact_id: str | None,
    artifact_name: str,
    model_rev: int,
    entries: list[ManifestEntry],
) -> bytes:
    """Serialize the run's manifest document. Field order is fixed by this
    function (not sorted), so `json.dumps` with a stable `entries` order
    (the caller's entry order) is what makes two runs at the same rev
    byte-identical."""
    doc = {
        "manifest_version": MANIFEST_VERSION,
        "project_id": project_id,
        "artifact_id": artifact_id,
        "artifact_name": artifact_name,
        "model_rev": model_rev,
        "truncated": any(e.truncated for e in entries),
        "degraded": any(e.degraded for e in entries),
        "entries": [
            {
                "name": e.name,
                "table_ref": e.table_ref,
                "table_name": e.table_name,
                "format": e.format,
                "truncated": e.truncated,
                "degraded": e.degraded,
                "files": e.files,
                "transform": e.transform,
            }
            for e in entries
        ],
    }
    return json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8")
