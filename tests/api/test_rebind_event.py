from data_rover.api.feed import rebind_event


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

