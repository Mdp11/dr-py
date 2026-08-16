from data_rover.api.feed import rebind_event
from data_rover.api.schemas import MetamodelDiffResponse


def test_rebind_event_shape() -> None:
    # rebind_event is still live: routes/commits.py broadcasts it for a
    # commit-flow metamodel.rebind (Task 6), replacing the standalone
    # POST /metamodel/rebind route (retired, Task 9) as its only caller.
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
    # RebindResponse (the standalone route's response schema) is gone with
    # the route (Task 9); MetamodelDiffResponse backs the surviving
    # POST /metamodel/diff and is still worth a construction smoke test.
    d = MetamodelDiffResponse(
        now_failing=[], now_passing=[], unchanged_count=2,
        current_error_count=2, candidate_error_count=2,
    )
    assert d.unchanged_count == 2
