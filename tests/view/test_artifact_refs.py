"""Folder.artifacts: additive artifact references ({id, kind}) alongside
element ids. Old view documents without the key parse unchanged; validation
does NOT check artifact existence (artifacts live in the DB, invisible to
core; renderers skip unknown ids)."""

from data_rover.core.view.schema import ArtifactRef, View


def test_old_documents_parse_without_artifacts() -> None:
    view = View.model_validate(
        {"name": "v", "folders": [{"name": "f", "folders": [], "elements": ["e1"]}]}
    )
    assert view.folders[0].artifacts == []


def test_artifact_refs_round_trip() -> None:
    view = View.model_validate(
        {"name": "v", "folders": [{
            "name": "f",
            "artifacts": [{"id": "a1", "kind": "navigation"}],
        }]}
    )
    ref = view.folders[0].artifacts[0]
    assert ref == ArtifactRef(id="a1", kind="navigation")
    dumped = view.model_dump()
    assert dumped["folders"][0]["artifacts"] == [{"id": "a1", "kind": "navigation"}]


def test_view_carries_root_artifacts() -> None:
    view = View.model_validate(
        {
            "name": "v",
            "folders": [],
            "artifacts": [{"id": "tbl1", "kind": "table"}],
        }
    )
    assert view.artifacts == [ArtifactRef(id="tbl1", kind="table")]


def test_old_view_without_artifacts_still_valid() -> None:
    view = View.model_validate({"name": "v", "folders": []})
    assert view.artifacts == []
