"""A relationship type named in a uniqueness key (``out:R`` / ``in:R``)
re-keys its ends when it is connected, disconnected or deleted with a
cascade: the dirty hooks must reach the groups those ends leave and join, or
the issue store keeps a duplicate that is gone, or misses one that appeared.
"""

from __future__ import annotations

from collections.abc import Callable

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model
from data_rover.core.validation.dirty import DirtyCollector
from data_rover.core.validation.pipeline import ValidationPipeline, default_validators
from data_rover.core.validation.scope import Scope
from data_rover.core.validation.state import ValidationState

_MM = Metamodel.model_validate(
    {
        "elements": [
            {
                "name": "Slot",
                "properties": [{"name": "code", "datatype": "integer"}],
                "key": ["code", "out:Feeds", "in:Feeds"],
            },
            {"name": "Box"},
        ],
        "relationships": [
            {"name": "Feeds", "source": "Slot", "target": "Slot"},
            {"name": "Holds", "containment": True, "source": "Box", "target": "Slot"},
        ],
    }
)


def _slot(model: Model, code: int) -> str:
    element = model.create_element("Slot")
    model.set_property(element, "code", code)
    return element.id


def _all_ids(model: Model) -> list[str]:
    return [*model.elements, *model.relationships]


def _issues(issues: object) -> list[tuple[str, ...]]:
    assert isinstance(issues, list)
    return sorted((*i.target_ids, i.message) for i in issues)


def _store_after(
    model: Model, mutate: Callable[[DirtyCollector], None]
) -> tuple[ValidationState, list[str]]:
    """A store swept over ``model``, then spliced over the dirty set of
    ``mutate``, as a session finalizes a batch."""
    pipeline = ValidationPipeline(default_validators())
    state = ValidationState()
    ids = _all_ids(model)
    state.replace(ids, pipeline.validate(model, Scope(ids)))
    collector = DirtyCollector()
    mutate(collector)
    dirty = list(collector.ids)
    state.replace(dirty, pipeline.validate(model, Scope(dirty)))
    return state, dirty


def _fresh(model: Model) -> list[tuple[str, ...]]:
    pipeline = ValidationPipeline(default_validators())
    return _issues(pipeline.validate(model, Scope(_all_ids(model))))


def test_connect_dirties_the_group_its_source_leaves():
    model = Model(_MM)
    s1, s3, s2 = _slot(model, 1), _slot(model, 1), _slot(model, 5)
    connected: list[str] = []

    def connect(d: DirtyCollector) -> None:
        connected.append(d.connect(model, "Feeds", s1, s2).id)

    state, dirty = _store_after(model, connect)
    assert set(dirty) == {s1, s2, s3, connected[0]}
    assert _issues(state.all_issues()) == _fresh(model) == []


def test_disconnect_dirties_the_group_its_source_joins():
    model = Model(_MM)
    s1, s3, s2 = _slot(model, 1), _slot(model, 1), _slot(model, 5)
    rel = model.connect("Feeds", s1, s2)

    state, dirty = _store_after(model, lambda d: d.disconnect(model, rel.id))
    assert s3 in dirty
    fresh = _fresh(model)
    assert [issue[:2] for issue in fresh] == [(s3, s1)]
    assert _issues(state.all_issues()) == fresh


def test_a_cascade_dirties_the_groups_of_the_keyed_ends_it_leaves():
    model = Model(_MM)
    s1, s3 = _slot(model, 1), _slot(model, 1)
    box = model.create_element("Box").id
    s2 = _slot(model, 5)
    model.connect("Holds", box, s2)
    model.connect("Feeds", s1, s2)

    state, dirty = _store_after(model, lambda d: d.delete_element(model, box))
    assert s3 in dirty
    fresh = _fresh(model)
    assert [issue[:2] for issue in fresh] == [(s3, s1)]
    assert _issues(state.all_issues()) == fresh
