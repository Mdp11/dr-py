from data_rover.api.feed import rebind_event
from data_rover.api.schemas import MetamodelDiffResponse, RebindResponse


def test_rebind_event_shape() -> None:
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
    d = MetamodelDiffResponse(
        now_failing=[], now_passing=[], unchanged_count=2,
        current_error_count=2, candidate_error_count=2,
    )
    assert d.unchanged_count == 2
    r = RebindResponse(
        model_rev=5, metamodel_id="new", validation_error_count=0,
        issue_counts={}, issues=[],
    )
    assert r.metamodel_id == "new"
