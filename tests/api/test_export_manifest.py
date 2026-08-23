"""Pure-function tests for `api/export_manifest.py`."""

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
        entries=[
            _entry(truncated=True),
            _entry(name="f", degraded=True, files=["g/f.json"], format="json"),
        ],
    )
    doc = json.loads(blob)
    assert doc["manifest_version"] == 1
    assert doc["model_rev"] == 7
    # Both aggregates pinned true: `truncated`/`degraded` are each set on a
    # DIFFERENT entry (never both, so a builder that OR'd the wrong field
    # together could not accidentally pass), and a hardcoded `False` for
    # either aggregate would fail this exact assertion — see FIX 6.
    assert doc["truncated"] is True and doc["degraded"] is True
    assert doc["entries"][1]["files"] == ["g/f.json"]
    assert doc["entries"][0]["transform"] is None
    assert "generated_at" not in doc  # determinism: no wall clock, by spec


def test_manifest_is_deterministic():
    kw: dict = dict(
        project_id="p", artifact_id=None, artifact_name="E", model_rev=1, entries=[_entry()]
    )
    assert build_manifest(**kw) == build_manifest(**kw)
