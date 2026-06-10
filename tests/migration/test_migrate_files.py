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


def test_remove_inconsistencies_on_samples(tmp_path):
    out_mm = tmp_path / "m.yaml"
    out_model = tmp_path / "m.json"
    report = migrate_files(
        SAMPLES / "old_metamodel_sample.json",
        SAMPLES / "old_model_sample.json",
        out_mm,
        out_model,
        remove_inconsistencies=True,
    )

    # the sample relationship dangles (target another_uuidv5 is not an element)
    model = json.loads(out_model.read_text())
    assert model["relationships"] == []
    assert any(r.id == "some_rel_uuidv5" for r in report.removed)

    # the removed entities are written to a sibling review file
    removed_path = Path(report.removed_report_path)
    assert removed_path.exists()
    assert removed_path.name == "m.removed.txt"
    text = removed_path.read_text()
    assert "some_rel_uuidv5" in text
    assert "another_uuidv5" in text  # the dangling target is captured for review

    # cleaned model now loads without endpoint validation errors
    assert report.model_issues == []


def test_progress_messages_emitted(tmp_path):
    msgs: list[str] = []
    migrate_files(
        SAMPLES / "old_metamodel_sample.json",
        SAMPLES / "old_model_sample.json",
        tmp_path / "m.yaml",
        tmp_path / "m.json",
        progress=msgs.append,
    )
    assert any("Reading old metamodel" in m for m in msgs)
    assert any("Building the new metamodel" in m for m in msgs)
    assert any("Converting" in m for m in msgs)
    assert any("Validating output" in m for m in msgs)
    # the pipeline announces its validator roster up-front
    assert any("validator: MultiplicityValidator" in m for m in msgs)
    assert msgs[-1] == "Done."
