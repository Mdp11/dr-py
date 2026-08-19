"""Pure-function tests for `api/export_manifest.py` (Task 7)."""

import json

from data_rover.api.export_manifest import ManifestEntry, build_manifest


def _entry(**kw: object) -> ManifestEntry:
    base: dict = dict(
        name="e", table_ref="t1", table_name="T", format="xlsx",
        truncated=False, degraded=False, files=["e.xlsx"],
    )
    base.update(kw)
    return ManifestEntry(**base)


def test_manifest_shape_and_aggregates():
    blob = build_manifest(
        project_id="p", artifact_id="a", artifact_name="Exp", model_rev=7,
        entries=[_entry(), _entry(name="f", degraded=True, files=["g/f.json"], format="json")],
    )
    doc = json.loads(blob)
    assert doc["manifest_version"] == 1
    assert doc["model_rev"] == 7
    assert doc["truncated"] is False and doc["degraded"] is True
    assert doc["entries"][1]["files"] == ["g/f.json"]
    assert doc["entries"][0]["transform"] is None
    assert "generated_at" not in doc  # determinism: no wall clock, by spec


def test_manifest_is_deterministic():
    kw: dict = dict(
        project_id="p", artifact_id=None, artifact_name="E", model_rev=1, entries=[_entry()]
    )
    assert build_manifest(**kw) == build_manifest(**kw)
