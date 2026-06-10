import json
from pathlib import Path

import yaml

from data_rover.migration.legacy import migrate_files

SAMPLES = Path(__file__).resolve().parents[2] / "migration"


def test_migrate_sample_files(tmp_path):
    out_mm = tmp_path / "new.metamodel.yaml"
    out_model = tmp_path / "new.model.json"
    report = migrate_files(
        SAMPLES / "old_metamodel_sample.json",
        SAMPLES / "old_model_sample.json",
        out_mm,
        out_model,
    )

    # both output files are written
    assert out_mm.exists() and out_model.exists()

    # metamodel YAML structure
    mm_doc = yaml.safe_load(out_mm.read_text())
    some = next(e for e in mm_doc["elements"] if e["name"] == "SomeStereotype")
    assert some["key"] == ["id_prop1", "id_prop2", "id_prop3"]

    # model JSON structure
    model = json.loads(out_model.read_text())
    assert model["rev"] == 1
    assert {e["id"] for e in model["elements"]} == {"some_uuidv5"}
    assert any(r["type_name"] == "SomeRelationship" for r in model["relationships"])

    # owner/element_type constraints are empty in the sample -> links skipped
    assert not [
        r for r in model["relationships"] if r["type_name"] in ("Owns", "TypedBy")
    ]
    assert report.result.warnings

    # the sample metamodel is referentially incomplete (SomeRelationship maps
    # endpoints that are not declared element types) -> reported, not raised
    assert any("SourceStereotype" in e for e in report.metamodel_errors)
