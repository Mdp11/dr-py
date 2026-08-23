from data_rover.api.feed import rebind_event
from data_rover.api.schemas import MetamodelDiffResponse


def test_rebind_event_shape() -> None:
    # routes/commits.py broadcasts rebind_event for a commit-flow
    # metamodel.rebind, its only caller.
    ev = rebind_event(
        rev=5, from_metamodel_id="old", to_metamodel_id="new",
        validation_error_count=3,
    )
    assert ev == {
        "type": "rebind",
        "rev": 5,
        "from_metamodel_id": "old",
        "to_metamodel_id": "new",
        "validation_error_count": 3,
    }


def test_response_models_construct() -> None:
    # MetamodelDiffResponse backs POST /metamodel/diff and is worth a
    # construction smoke test.
    d = MetamodelDiffResponse(
        now_failing=[], now_passing=[], unchanged_count=2,
        current_error_count=2, candidate_error_count=2,
    )
    assert d.unchanged_count == 2
